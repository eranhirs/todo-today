from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..event_bus import EventType, bus
from ..models import Todo, TodoCreate, TodoReorder, TodoUpdate, _now
from ..tags import collect_all_tags
from ..run_manager import (
    _followup_claude_for_todo,
    _process_queue,
    dequeue_todo_run,
    is_project_busy,
    is_todo_running,
    process_manager,
    start_todo_run,
)
from ..storage import StorageContext

_DEMO_MODE = os.environ.get("TODO_DEMO", "").lower() in ("1", "true", "yes")

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/todos", tags=["todos"])


@router.get("/tags")
def list_tags() -> list[str]:
    """Return all unique tags found across all todo texts."""
    with StorageContext(read_only=True) as ctx:
        return collect_all_tags([t.text for t in ctx.store.todos])


@router.get("")
def list_todos(project_id: Optional[str] = None) -> list[Todo]:
    with StorageContext(read_only=True) as ctx:
        todos = ctx.store.todos
        if project_id:
            todos = [t for t in todos if t.project_id == project_id]
        return todos


@router.post("", status_code=201)
def create_todo(body: TodoCreate) -> Todo:
    todo = Todo(project_id=body.project_id, text=body.text, status=body.status, source="user", plan_only=body.plan_only)
    if todo.status == "completed":
        todo.completed_at = _now()
    with StorageContext() as ctx:
        if not any(p.id == body.project_id for p in ctx.store.projects):
            raise HTTPException(status_code=404, detail="Project not found")
        # Auto-assign sort_order: min existing - 1 so new todos appear at top
        min_order = min((t.sort_order for t in ctx.store.todos if t.project_id == body.project_id), default=1)
        todo.sort_order = min_order - 1
        ctx.store.todos.append(todo)
    bus.emit_event_sync(EventType.TODO_CREATED, todo_id=todo.id, project_id=todo.project_id, text=todo.text)
    return todo


@router.put("/reorder")
def reorder_todos(body: TodoReorder) -> dict:
    """Update sort_order for a list of todo IDs (in desired order)."""
    with StorageContext() as ctx:
        id_to_todo = {t.id: t for t in ctx.store.todos}
        for idx, todo_id in enumerate(body.todo_ids):
            if todo_id in id_to_todo:
                id_to_todo[todo_id].sort_order = idx
        # Only mark the actually-moved item as user_ordered
        if body.moved_id and body.moved_id in id_to_todo:
            id_to_todo[body.moved_id].user_ordered = True
    return {"status": "ok"}


@router.get("/{todo_id}")
def get_todo(todo_id: str) -> Todo:
    with StorageContext(read_only=True) as ctx:
        for t in ctx.store.todos:
            if t.id == todo_id:
                return t
    raise HTTPException(status_code=404, detail="Todo not found")


@router.put("/{todo_id}")
def update_todo(todo_id: str, body: TodoUpdate) -> Todo:
    with StorageContext() as ctx:
        for t in ctx.store.todos:
            if t.id == todo_id:
                if body.text is not None:
                    t.text = body.text
                if body.project_id is not None:
                    t.project_id = body.project_id
                if body.status is not None:
                    was_completed = t.status == "completed"
                    was_rejected = t.status == "rejected"
                    t.status = body.status
                    if body.status == "completed" and not was_completed:
                        t.completed_at = _now()
                    elif body.status != "completed" and was_completed:
                        t.completed_at = None
                    if body.status == "rejected" and not was_rejected:
                        t.rejected_at = _now()
                    elif body.status != "rejected" and was_rejected:
                        t.rejected_at = None
                if body.source is not None:
                    t.source = body.source
                if body.stale_reason is not None:
                    t.stale_reason = body.stale_reason
                if body.is_read is not None:
                    t.is_read = body.is_read
                if body.user_ordered is not None:
                    t.user_ordered = body.user_ordered
                    # When unpinning, recalculate sort_order for unpinned siblings by created_at
                    if not body.user_ordered:
                        siblings = [
                            s for s in ctx.store.todos
                            if s.project_id == t.project_id
                        ]
                        # Pinned items keep their sort_order; unpinned get re-slotted by created_at
                        pinned = sorted(
                            [s for s in siblings if s.user_ordered],
                            key=lambda s: s.sort_order,
                        )
                        unpinned = sorted(
                            [s for s in siblings if not s.user_ordered],
                            key=lambda s: s.created_at,
                        )
                        # Merge: pinned occupy their slots, unpinned fill remaining slots
                        pinned_slots = {s.sort_order for s in pinned}
                        slot = 0
                        for s in unpinned:
                            while slot in pinned_slots:
                                slot += 1
                            s.sort_order = slot
                            slot += 1
                # Clear stale_reason when moving away from stale
                if body.status is not None and body.status != "stale":
                    t.stale_reason = None
                bus.emit_event_sync(EventType.TODO_UPDATED, todo_id=t.id, status=t.status)
                return t
    raise HTTPException(status_code=404, detail="Todo not found")


@router.delete("/{todo_id}", status_code=204)
def delete_todo(todo_id: str) -> None:
    with StorageContext() as ctx:
        before = len(ctx.store.todos)
        ctx.store.todos = [t for t in ctx.store.todos if t.id != todo_id]
        if len(ctx.store.todos) == before:
            raise HTTPException(status_code=404, detail="Todo not found")
    bus.emit_event_sync(EventType.TODO_DELETED, todo_id=todo_id)


@router.post("/{todo_id}/stop")
def stop_todo(todo_id: str) -> dict:
    """Stop a running Claude Code session for a todo."""
    if _DEMO_MODE:
        raise HTTPException(status_code=403, detail="Disabled in demo mode")

    with StorageContext() as ctx:
        todo = None
        for t in ctx.store.todos:
            if t.id == todo_id:
                todo = t
                break
        if todo is None:
            raise HTTPException(status_code=404, detail="Todo not found")
        if todo.run_status != "running":
            raise HTTPException(status_code=409, detail="Todo is not running")

        pid = todo.run_pid
        output_file_str = todo.run_output_file
        proj_id = todo.project_id

        # Update todo state — treat stop as a pause,
        # preserving session_id and run_output so follow-up can continue.
        todo.run_status = "stopped"
        todo.status = "waiting"
        todo.run_pid = None
        todo.run_output_file = None
        # Append interruption marker to output
        if todo.run_output:
            todo.run_output = (todo.run_output + "\n\n--- Paused ---")[:50000]

    # Kill the subprocess (and its process group) outside the lock
    if pid:
        process_manager.kill_process(pid)

    # Clean up the thread tracker
    process_manager.unregister_thread(todo_id)

    # Clean up output file
    if output_file_str:
        process_manager.cleanup_output_file(Path(output_file_str))

    bus.emit_event_sync(EventType.RUN_STOPPED, todo_id=todo_id)
    log.info("Stopped (interrupted) claude run for todo %s (pid %s)", todo_id, pid)

    # Process queue — start next queued todo for this project
    _process_queue(proj_id)

    return {"status": "stopped"}


@router.post("/{todo_id}/run")
def run_todo(todo_id: str) -> dict:
    """Kick off a Claude Code session to complete a todo, or queue it if the project is busy."""
    if _DEMO_MODE:
        raise HTTPException(status_code=403, detail="Disabled in demo mode")

    err = start_todo_run(todo_id)
    if err == "already running":
        raise HTTPException(status_code=409, detail="This todo is already running")
    if err == "already queued":
        raise HTTPException(status_code=409, detail="This todo is already queued — it will run when the current task finishes")
    if err == "queued":
        return {"status": "queued"}
    if err == "todo not found":
        raise HTTPException(status_code=404, detail="Todo not found")
    if err == "no source_path":
        raise HTTPException(status_code=400, detail="Project has no source_path configured")
    if err:
        raise HTTPException(status_code=500, detail=err)

    return {"status": "started"}


@router.post("/{todo_id}/dequeue")
def dequeue_todo(todo_id: str) -> dict:
    """Remove a todo from the run queue."""
    if _DEMO_MODE:
        raise HTTPException(status_code=403, detail="Disabled in demo mode")

    err = dequeue_todo_run(todo_id)
    if err == "not queued":
        raise HTTPException(status_code=409, detail="This todo is not queued")
    if err == "todo not found":
        raise HTTPException(status_code=404, detail="Todo not found")
    if err:
        raise HTTPException(status_code=500, detail=err)

    return {"status": "dequeued"}


class FollowupRequest(BaseModel):
    message: str


@router.post("/{todo_id}/followup")
def followup_todo(todo_id: str, body: FollowupRequest) -> dict:
    """Send a follow-up message to a completed Claude session.

    If another todo in the same project is currently running, the follow-up
    is queued and will auto-start when the project becomes free.
    """
    if _DEMO_MODE:
        raise HTTPException(status_code=403, detail="Disabled in demo mode")

    if process_manager.is_todo_running(todo_id):
        raise HTTPException(status_code=409, detail="This todo is already running")

    with StorageContext() as ctx:
        todo = None
        source_path = None
        for t in ctx.store.todos:
            if t.id == todo_id:
                todo = t
                break
        if todo is None:
            raise HTTPException(status_code=404, detail="Todo not found")
        if not todo.session_id:
            raise HTTPException(status_code=400, detail="No session to follow up on — run the todo first")
        if todo.run_status == "running":
            raise HTTPException(status_code=409, detail="Todo is currently running")

        session_id = todo.session_id

        for p in ctx.store.projects:
            if p.id == todo.project_id:
                source_path = p.source_path
                break
        if not source_path:
            raise HTTPException(status_code=400, detail="Project has no source_path configured")

        # Check if another todo in the same project is running
        project_busy = False
        for t in ctx.store.todos:
            if t.project_id == todo.project_id and t.id != todo_id and (is_todo_running(t.id) or t.run_status == "running"):
                project_busy = True
                break

        # Follow-up always moves the todo back to an active state
        todo.completed_at = None

        if project_busy:
            # Queue the follow-up; store the pending message so _process_queue can use it
            todo.status = "next"
            todo.run_status = "queued"
            todo.queued_at = _now()
            todo.pending_followup = body.message
            # Immediately show the user's follow-up message in the output
            todo.run_output = (todo.run_output or "") + f"\n\n--- Follow-up (queued) ---\n**You:** {body.message}\n"
            return {"status": "queued"}

        todo.run_status = "running"
        todo.status = "in_progress"
        # Immediately show the user's follow-up message in the output
        todo.run_output = (todo.run_output or "") + f"\n\n--- Follow-up ---\n**You:** {body.message}\n"
        proj_id = todo.project_id
        run_model = ctx.metadata.run_model

    process_manager.spawn_thread(
        todo_id, _followup_claude_for_todo,
        (todo_id, body.message, session_id, source_path, run_model, proj_id),
    )
    return {"status": "started"}
