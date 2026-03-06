import json
import logging
import os
import threading
import subprocess
from typing import Optional

from fastapi import APIRouter, HTTPException

from ..models import Todo, TodoCreate, TodoUpdate, _now
from ..storage import StorageContext

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/todos", tags=["todos"])

# Track running background processes
_running_tasks: dict[str, threading.Thread] = {}


@router.get("")
def list_todos(project_id: Optional[str] = None) -> list[Todo]:
    with StorageContext() as ctx:
        todos = ctx.store.todos
        if project_id:
            todos = [t for t in todos if t.project_id == project_id]
        return todos


@router.post("", status_code=201)
def create_todo(body: TodoCreate) -> Todo:
    todo = Todo(project_id=body.project_id, text=body.text, status=body.status, source="user")
    if todo.status == "completed":
        todo.completed_at = _now()
    with StorageContext() as ctx:
        if not any(p.id == body.project_id for p in ctx.store.projects):
            raise HTTPException(404, "Project not found")
        ctx.store.todos.append(todo)
    return todo


@router.get("/{todo_id}")
def get_todo(todo_id: str) -> Todo:
    with StorageContext() as ctx:
        for t in ctx.store.todos:
            if t.id == todo_id:
                return t
    raise HTTPException(404, "Todo not found")


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
                    t.status = body.status
                    if body.status == "completed" and not was_completed:
                        t.completed_at = _now()
                    elif body.status != "completed" and was_completed:
                        t.completed_at = None
                if body.source is not None:
                    t.source = body.source
                return t
    raise HTTPException(404, "Todo not found")


@router.delete("/{todo_id}", status_code=204)
def delete_todo(todo_id: str) -> None:
    with StorageContext() as ctx:
        before = len(ctx.store.todos)
        ctx.store.todos = [t for t in ctx.store.todos if t.id != todo_id]
        if len(ctx.store.todos) == before:
            raise HTTPException(404, "Todo not found")


def _run_claude_for_todo(todo_id: str, todo_text: str, source_path: str) -> None:
    """Background thread: run claude -p for a todo and update the store on completion."""
    try:
        env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}
        prompt = f"Complete this task: {todo_text}"
        result = subprocess.run(
            ["claude", "-p", "--output-format", "json"],
            input=prompt,
            capture_output=True,
            text=True,
            timeout=600,
            cwd=source_path,
            env=env,
        )

        if result.returncode != 0:
            error_msg = result.stderr[:2000] if result.stderr else f"Exit code {result.returncode}"
            log.error("Claude run failed for todo %s: %s", todo_id, error_msg)
            with StorageContext() as ctx:
                for t in ctx.store.todos:
                    if t.id == todo_id:
                        t.run_status = "error"
                        t.run_output = error_msg
                        break
            return

        # Parse output
        output_text = result.stdout
        try:
            wrapper = json.loads(output_text)
            output_text = wrapper.get("result", output_text)
        except json.JSONDecodeError:
            pass

        with StorageContext() as ctx:
            for t in ctx.store.todos:
                if t.id == todo_id:
                    t.run_status = "done"
                    t.run_output = output_text[:50000]  # cap stored output
                    t.status = "completed"
                    t.completed_at = _now()
                    break

    except subprocess.TimeoutExpired:
        log.error("Claude run timed out for todo %s", todo_id)
        with StorageContext() as ctx:
            for t in ctx.store.todos:
                if t.id == todo_id:
                    t.run_status = "error"
                    t.run_output = "Claude timed out after 10 minutes"
                    break
    except Exception as e:
        log.exception("Claude run error for todo %s", todo_id)
        with StorageContext() as ctx:
            for t in ctx.store.todos:
                if t.id == todo_id:
                    t.run_status = "error"
                    t.run_output = str(e)
                    break
    finally:
        _running_tasks.pop(todo_id, None)


@router.post("/{todo_id}/run")
def run_todo(todo_id: str) -> dict:
    """Kick off a Claude Code session to complete a todo."""
    if todo_id in _running_tasks and _running_tasks[todo_id].is_alive():
        raise HTTPException(409, "This todo is already running")

    with StorageContext() as ctx:
        todo = None
        source_path = None
        for t in ctx.store.todos:
            if t.id == todo_id:
                todo = t
                break
        if todo is None:
            raise HTTPException(404, "Todo not found")

        # Find the project's source_path
        for p in ctx.store.projects:
            if p.id == todo.project_id:
                source_path = p.source_path
                break
        if not source_path:
            raise HTTPException(400, "Project has no source_path configured")

        todo.status = "in_progress"
        todo.run_status = "running"
        todo.run_output = None
        todo_text = todo.text

    thread = threading.Thread(
        target=_run_claude_for_todo,
        args=(todo_id, todo_text, source_path),
        daemon=True,
    )
    thread.start()
    _running_tasks[todo_id] = thread

    return {"status": "started"}
