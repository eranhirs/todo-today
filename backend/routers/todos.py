from __future__ import annotations

import json
import logging
import os
import threading
import subprocess
import time
import uuid
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
    with StorageContext(read_only=True) as ctx:
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
    with StorageContext(read_only=True) as ctx:
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


_FLUSH_INTERVAL = 3  # seconds between progress flushes


def _flush_progress(todo_id: str, output: str) -> None:
    """Write current accumulated output to the store."""
    with StorageContext() as ctx:
        for t in ctx.store.todos:
            if t.id == todo_id:
                t.run_output = output[:50000]
                break


def _extract_assistant_text(line_json: dict) -> Optional[str]:
    """Extract text content from a stream-json assistant message."""
    if line_json.get("type") != "assistant":
        return None
    msg = line_json.get("message", {})
    content = msg.get("content", [])
    parts = []
    for block in content:
        if isinstance(block, dict):
            if block.get("type") == "text":
                parts.append(block["text"])
            elif block.get("type") == "tool_use":
                name = block.get("name", "tool")
                inp = block.get("input", {})
                # Show tool calls concisely
                if name == "Bash":
                    parts.append(f"$ {inp.get('command', '')}")
                elif name in ("Edit", "Write"):
                    parts.append(f"[{name}: {inp.get('file_path', '')}]")
                elif name == "Read":
                    parts.append(f"[Read: {inp.get('file_path', '')}]")
                else:
                    parts.append(f"[{name}]")
    return "\n".join(parts) if parts else None


def _run_claude_for_todo(todo_id: str, todo_text: str, source_path: str, model: str = "opus") -> None:
    """Background thread: stream claude -p output and flush progress to the store."""
    proc = None
    try:
        env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}
        session_id = str(uuid.uuid4())
        prompt = (
            f"Implement this task fully — write all the code, make all the changes, "
            f"do not stop to ask for feedback or approval: {todo_text}"
        )
        proc = subprocess.Popen(
            ["claude", "-p", "--output-format", "stream-json", "--verbose",
             "--dangerously-skip-permissions",
             "--disallowedTools", "AskUserQuestion",
             "--model", model,
             "--session-id", session_id],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=source_path,
            env=env,
        )
        proc.stdin.write(prompt)
        proc.stdin.close()

        session_header = f"Session: {session_id}\n\n"
        accumulated: list[str] = []
        last_flush = time.monotonic()
        final_result = None

        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue

            if obj.get("type") == "result":
                final_result = obj
                continue

            text = _extract_assistant_text(obj)
            if text:
                accumulated.append(text)

            # Flush to store periodically
            now = time.monotonic()
            if now - last_flush >= _FLUSH_INTERVAL and accumulated:
                _flush_progress(todo_id, session_header + "\n".join(accumulated))
                last_flush = now

        proc.wait(timeout=30)

        if proc.returncode != 0:
            stderr = proc.stderr.read()[:2000] if proc.stderr else ""
            error_msg = stderr or f"Exit code {proc.returncode}"
            log.error("Claude run failed for todo %s: %s", todo_id, error_msg)
            output_so_far = "\n".join(accumulated)
            if output_so_far:
                error_msg = output_so_far + "\n\n--- ERROR ---\n" + error_msg
            with StorageContext() as ctx:
                for t in ctx.store.todos:
                    if t.id == todo_id:
                        t.run_status = "error"
                        t.run_output = (session_header + error_msg)[:50000]
                        break
            return

        # Use final result text if available, else accumulated stream
        output_text = "\n".join(accumulated)
        had_errors = False
        if final_result:
            result_text = final_result.get("result")
            if result_text:
                output_text = result_text
            # Check if there were permission denials or errors
            if final_result.get("is_error"):
                had_errors = True
            if final_result.get("permission_denials"):
                had_errors = True

        with StorageContext() as ctx:
            for t in ctx.store.todos:
                if t.id == todo_id:
                    t.run_output = (session_header + output_text)[:50000]
                    if had_errors:
                        t.run_status = "error"
                    else:
                        t.run_status = "done"
                        t.status = "completed"
                        t.completed_at = _now()
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
        if proc and proc.poll() is None:
            proc.kill()
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
        run_model = ctx.metadata.run_model

    thread = threading.Thread(
        target=_run_claude_for_todo,
        args=(todo_id, todo_text, source_path, run_model),
        daemon=True,
    )
    thread.start()
    _running_tasks[todo_id] = thread

    return {"status": "started"}
