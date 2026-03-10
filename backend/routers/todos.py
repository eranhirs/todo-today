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

_DEMO_MODE = os.environ.get("TODO_DEMO", "").lower() in ("1", "true", "yes")

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


_MAX_PLAN_RETRIES = 3  # max times we'll auto-accept a plan and continue


def _detect_exit_plan_mode(stream_lines: list[dict]) -> bool:
    """Check if the session ended by calling ExitPlanMode."""
    for obj in reversed(stream_lines):
        if obj.get("type") != "assistant":
            continue
        for block in obj.get("message", {}).get("content", []):
            if isinstance(block, dict) and block.get("type") == "tool_use":
                if block.get("name") == "ExitPlanMode":
                    return True
        # Only check the last assistant message
        break
    return False


def _invoke_claude(
    todo_id: str,
    prompt: str,
    session_id: str,
    source_path: str,
    model: str,
    env: dict,
    accumulated: list[str],
    session_header: str,
    resume: bool = False,
) -> tuple[Optional[dict], list[dict], int]:
    """Run a single claude -p invocation. Returns (final_result, stream_objects, returncode)."""
    cmd = [
        "claude", "-p", "--output-format", "stream-json", "--verbose",
        "--dangerously-skip-permissions",
        "--disallowedTools", "AskUserQuestion",
        "--model", model,
        "--session-id", session_id,
    ]
    if resume:
        cmd.append("--resume")

    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd=source_path,
        env=env,
    )
    proc.stdin.write(prompt)
    proc.stdin.close()

    last_flush = time.monotonic()
    final_result = None
    stream_objects: list[dict] = []

    try:
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue

            stream_objects.append(obj)

            if obj.get("type") == "result":
                final_result = obj
                continue

            text = _extract_assistant_text(obj)
            if text:
                accumulated.append(text)

            now = time.monotonic()
            if now - last_flush >= _FLUSH_INTERVAL and accumulated:
                _flush_progress(todo_id, session_header + "\n".join(accumulated))
                last_flush = now

        proc.wait(timeout=30)
    except Exception:
        if proc.poll() is None:
            proc.kill()
        raise

    return final_result, stream_objects, proc.returncode


def _run_claude_for_todo(todo_id: str, todo_text: str, source_path: str, model: str = "opus") -> None:
    """Background thread: run claude -p, auto-accepting plan mode if needed."""
    try:
        env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}
        session_id = str(uuid.uuid4())
        prompt = (
            f"Implement this task fully — write all the code, make all the changes, "
            f"do not stop to ask for feedback or approval: {todo_text}"
        )
        session_header = f"Session: {session_id}\n\n"
        accumulated: list[str] = []

        final_result = None
        returncode = 0

        for attempt in range(_MAX_PLAN_RETRIES + 1):
            is_resume = attempt > 0
            if is_resume:
                prompt = "Plan accepted. Now implement it fully."
                log.info("Auto-accepting plan for todo %s (attempt %d)", todo_id, attempt + 1)
                accumulated.append("\n--- Plan accepted, continuing ---\n")

            final_result, stream_objects, returncode = _invoke_claude(
                todo_id, prompt, session_id, source_path, model, env,
                accumulated, session_header, resume=is_resume,
            )

            if returncode != 0:
                break

            # If Claude exited plan mode, auto-accept and continue
            if _detect_exit_plan_mode(stream_objects) and attempt < _MAX_PLAN_RETRIES:
                continue

            # Otherwise we're done
            break

        if returncode != 0:
            stderr_msg = f"Exit code {returncode}"
            log.error("Claude run failed for todo %s: %s", todo_id, stderr_msg)
            output_so_far = "\n".join(accumulated)
            if output_so_far:
                stderr_msg = output_so_far + "\n\n--- ERROR ---\n" + stderr_msg
            with StorageContext() as ctx:
                for t in ctx.store.todos:
                    if t.id == todo_id:
                        t.run_status = "error"
                        t.run_output = (session_header + stderr_msg)[:50000]
                        break
            return

        output_text = "\n".join(accumulated)
        had_errors = False
        if final_result:
            result_text = final_result.get("result")
            if result_text:
                output_text = result_text
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
        _running_tasks.pop(todo_id, None)


def start_todo_run(todo_id: str) -> str | None:
    """Start a Claude run for a todo. Returns None on success, or an error string.

    Used by the /run endpoint and by the scheduler for auto-run.
    """
    if todo_id in _running_tasks and _running_tasks[todo_id].is_alive():
        return "already running"

    with StorageContext() as ctx:
        todo = None
        source_path = None
        for t in ctx.store.todos:
            if t.id == todo_id:
                todo = t
                break
        if todo is None:
            return "todo not found"

        for p in ctx.store.projects:
            if p.id == todo.project_id:
                source_path = p.source_path
                break
        if not source_path:
            return "no source_path"

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
    return None


def is_todo_running(todo_id: str) -> bool:
    """Check if a todo has an active background thread."""
    return todo_id in _running_tasks and _running_tasks[todo_id].is_alive()


@router.post("/{todo_id}/run")
def run_todo(todo_id: str) -> dict:
    """Kick off a Claude Code session to complete a todo."""
    if _DEMO_MODE:
        raise HTTPException(403, "Disabled in demo mode")

    err = start_todo_run(todo_id)
    if err == "already running":
        raise HTTPException(409, "This todo is already running")
    if err == "todo not found":
        raise HTTPException(404, "Todo not found")
    if err == "no source_path":
        raise HTTPException(400, "Project has no source_path configured")
    if err:
        raise HTTPException(500, err)

    return {"status": "started"}
