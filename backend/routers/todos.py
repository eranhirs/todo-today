from __future__ import annotations

import json
import logging
import os
import threading
import subprocess
import time
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..models import Todo, TodoCreate, TodoUpdate, _now
from ..storage import DATA_DIR, StorageContext

_DEMO_MODE = os.environ.get("TODO_DEMO", "").lower() in ("1", "true", "yes")

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/todos", tags=["todos"])

# Track running background processes
_running_tasks: dict[str, threading.Thread] = {}

# Directory for run output files
_RUNS_DIR = DATA_DIR / "runs"
_RUNS_DIR.mkdir(parents=True, exist_ok=True)


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
    output_file: Path,
    resume: bool = False,
) -> tuple[Optional[dict], list[dict], int]:
    """Run a single claude -p invocation with a detached subprocess writing to output_file.

    Returns (final_result, stream_objects, returncode).
    """
    cmd = [
        "claude", "-p", "--output-format", "stream-json", "--verbose",
        "--dangerously-skip-permissions",
        "--disallowedTools", "AskUserQuestion",
        "--model", model,
    ]
    if resume:
        cmd.extend(["--resume", session_id])
    else:
        cmd.extend(["--session-id", session_id])

    # Open file in append mode so multiple invocations accumulate output
    fout = open(output_file, "a")

    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=fout,
        stderr=subprocess.PIPE,
        text=True,
        cwd=source_path,
        env=env,
        start_new_session=True,  # detach from server's process group
    )
    proc.stdin.write(prompt)
    proc.stdin.close()
    fout.close()  # subprocess owns the fd now

    # Store PID on the todo so we can reconnect after restart
    with StorageContext() as ctx:
        for t in ctx.store.todos:
            if t.id == todo_id:
                t.run_pid = proc.pid
                t.run_output_file = str(output_file)
                break

    # Tail the output file while the process runs
    final_result, stream_objects = _tail_output_file(
        todo_id, proc.pid, output_file, accumulated, session_header,
    )

    proc.wait(timeout=60)
    if proc.returncode != 0:
        stderr_out = proc.stderr.read() if proc.stderr else ""
        if stderr_out:
            log.error("Claude stderr for todo %s: %s", todo_id, stderr_out[:2000])
            accumulated.append(f"\nstderr: {stderr_out[:2000]}")
    return final_result, stream_objects, proc.returncode


def _tail_output_file(
    todo_id: str,
    pid: int,
    output_file: Path,
    accumulated: list[str],
    session_header: str,
    start_pos: int = 0,
) -> tuple[Optional[dict], list[dict]]:
    """Tail a stream-json output file while the process is alive.

    Returns (final_result, stream_objects).
    """
    last_flush = time.monotonic()
    final_result = None
    stream_objects: list[dict] = []
    file_pos = start_pos

    while True:
        # Check if process is still alive
        alive = _pid_alive(pid)

        # Read any new data from the file
        try:
            with open(output_file, "r") as f:
                f.seek(file_pos)
                new_data = f.read()
                file_pos = f.tell()
        except FileNotFoundError:
            new_data = ""

        for line in new_data.splitlines():
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

        if not alive:
            break

        time.sleep(0.5)

    # Final flush
    if accumulated:
        _flush_progress(todo_id, session_header + "\n".join(accumulated))

    return final_result, stream_objects


def _pid_alive(pid: int) -> bool:
    """Check if a process with the given PID is alive (not a zombie)."""
    try:
        os.kill(pid, 0)
    except (OSError, ProcessLookupError):
        return False
    # Check for zombie on Linux — zombies respond to kill(0) but are defunct
    try:
        with open(f"/proc/{pid}/status") as f:
            for line in f:
                if line.startswith("State:"):
                    return "Z" not in line  # Z = zombie
    except (FileNotFoundError, PermissionError):
        pass
    return True


def _run_claude_for_todo(todo_id: str, todo_text: str, source_path: str, model: str = "opus") -> None:
    """Background thread: run claude -p, auto-accepting plan mode if needed."""
    output_file = _RUNS_DIR / f"{todo_id}.jsonl"
    try:
        env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}
        session_id = str(uuid.uuid4())
        prompt = (
            f"Implement this task fully — write all the code, make all the changes, "
            f"do not stop to ask for feedback or approval: {todo_text}"
        )
        session_header = f"Session: {session_id}\n\n"
        accumulated: list[str] = []

        # Store output file path and session_id on todo
        with StorageContext() as ctx:
            for t in ctx.store.todos:
                if t.id == todo_id:
                    t.run_output_file = str(output_file)
                    t.session_id = session_id
                    break

        # Ensure clean output file
        output_file.write_text("")

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
                accumulated, session_header, output_file, resume=is_resume,
            )

            if returncode != 0:
                break

            # If Claude exited plan mode, auto-accept and continue
            if _detect_exit_plan_mode(stream_objects) and attempt < _MAX_PLAN_RETRIES:
                continue

            # Otherwise we're done
            break

        _finalize_run(todo_id, final_result, returncode, accumulated, session_header, output_file)

    except Exception as e:
        log.exception("Claude run error for todo %s", todo_id)
        with StorageContext() as ctx:
            for t in ctx.store.todos:
                if t.id == todo_id:
                    t.run_status = "error"
                    t.run_output = str(e)
                    t.run_pid = None
                    t.run_output_file = None
                    break
        _cleanup_output_file(output_file)
    finally:
        _running_tasks.pop(todo_id, None)


def _finalize_run(
    todo_id: str,
    final_result: Optional[dict],
    returncode: int,
    accumulated: list[str],
    session_header: str,
    output_file: Path,
) -> None:
    """Apply the final result of a claude run to the todo and clean up."""
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
                    t.run_pid = None
                    t.run_output_file = None
                    break
        _cleanup_output_file(output_file)
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
                t.run_pid = None
                t.run_output_file = None
                if had_errors:
                    t.run_status = "error"
                else:
                    t.run_status = "done"
                    t.status = "completed"
                    t.completed_at = _now()
                break

    _cleanup_output_file(output_file)


def _cleanup_output_file(output_file: Path) -> None:
    """Remove output file if it exists."""
    try:
        output_file.unlink(missing_ok=True)
    except Exception:
        log.debug("Could not remove output file %s", output_file)


def reconnect_todo_run(todo_id: str, pid: int, output_file_str: str) -> None:
    """Reconnect to a still-running detached claude subprocess after server restart.

    Spawns a watcher thread that tails the output file and waits for the process to finish.
    No plan-mode retry on reconnect — the current invocation just completes.
    """
    if todo_id in _running_tasks and _running_tasks[todo_id].is_alive():
        return  # already being watched

    output_file = Path(output_file_str)

    # Capture existing output and file position BEFORE starting watcher thread
    existing_output = ""
    with StorageContext(read_only=True) as ctx:
        for t in ctx.store.todos:
            if t.id == todo_id:
                existing_output = t.run_output or ""
                break

    # Get current file size so we only tail NEW content
    try:
        file_start_pos = output_file.stat().st_size
    except (OSError, FileNotFoundError):
        file_start_pos = 0

    def _watcher():
        try:
            log.info("Reconnecting to claude run for todo %s (pid %d)", todo_id, pid)
            accumulated: list[str] = []
            # Preserve existing output, then append reconnect marker
            session_header = existing_output + "\n\n[Reconnected after server restart]\n\n" if existing_output else "[Reconnected after server restart]\n\n"

            final_result, stream_objects = _tail_output_file(
                todo_id, pid, output_file, accumulated, session_header,
                start_pos=file_start_pos,
            )

            # Wait for the process to fully exit and get return code
            try:
                _, returncode_raw = os.waitpid(pid, 0)
                returncode = os.WEXITSTATUS(returncode_raw) if os.WIFEXITED(returncode_raw) else 1
            except ChildProcessError:
                # Not our child process (detached), infer from result
                returncode = 0 if final_result and not final_result.get("is_error") else 0

            _finalize_run(todo_id, final_result, returncode, accumulated, session_header, output_file)

        except Exception as e:
            log.exception("Reconnect error for todo %s", todo_id)
            with StorageContext() as ctx:
                for t in ctx.store.todos:
                    if t.id == todo_id:
                        t.run_status = "error"
                        t.run_output = f"[Reconnect failed: {e}]"
                        t.run_pid = None
                        t.run_output_file = None
                        break
            _cleanup_output_file(output_file)
        finally:
            _running_tasks.pop(todo_id, None)

    thread = threading.Thread(target=_watcher, daemon=True)
    thread.start()
    _running_tasks[todo_id] = thread


def parse_output_file_result(output_file_str: str) -> tuple[Optional[dict], list[str]]:
    """Parse a completed output file to extract final result and accumulated text.

    Used when the subprocess finished while the server was down.
    Returns (final_result, accumulated_texts).
    """
    output_file = Path(output_file_str)
    final_result = None
    accumulated: list[str] = []

    if not output_file.exists():
        return None, []

    try:
        with open(output_file, "r") as f:
            for line in f:
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
    except Exception:
        log.debug("Could not parse output file %s", output_file)

    return final_result, accumulated


def start_todo_run(todo_id: str, autopilot: bool = False) -> str | None:
    """Start a Claude run for a todo. Returns None on success, or an error string.

    Used by the /run endpoint and by the scheduler for auto-run.
    When autopilot=True, sets run_trigger to 'autopilot' so the UI can distinguish.
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
        todo.run_trigger = "autopilot" if autopilot else "manual"
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


@router.post("/{todo_id}/stop")
def stop_todo(todo_id: str) -> dict:
    """Stop a running Claude Code session for a todo."""
    if _DEMO_MODE:
        raise HTTPException(403, "Disabled in demo mode")

    with StorageContext() as ctx:
        todo = None
        for t in ctx.store.todos:
            if t.id == todo_id:
                todo = t
                break
        if todo is None:
            raise HTTPException(404, "Todo not found")
        if todo.run_status != "running":
            raise HTTPException(409, "Todo is not running")

        pid = todo.run_pid
        output_file_str = todo.run_output_file

        # Update todo state
        todo.run_status = "stopped"
        todo.status = "next"
        todo.run_pid = None
        todo.run_output_file = None

    # Kill the subprocess (and its process group) outside the lock
    if pid:
        try:
            os.killpg(os.getpgid(pid), 9)
        except (OSError, ProcessLookupError):
            # Process already exited
            try:
                os.kill(pid, 9)
            except (OSError, ProcessLookupError):
                pass

    # Clean up the thread tracker
    _running_tasks.pop(todo_id, None)

    # Clean up output file
    if output_file_str:
        _cleanup_output_file(Path(output_file_str))

    log.info("Stopped claude run for todo %s (pid %s)", todo_id, pid)
    return {"status": "stopped"}


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


class FollowupRequest(BaseModel):
    message: str


def _followup_claude_for_todo(todo_id: str, message: str, session_id: str, source_path: str, model: str = "opus") -> None:
    """Background thread: send a follow-up message to an existing Claude session."""
    output_file = _RUNS_DIR / f"{todo_id}.jsonl"
    try:
        env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}

        # Use the already-updated output (includes user message) as the header
        with StorageContext(read_only=True) as ctx:
            for t in ctx.store.todos:
                if t.id == todo_id:
                    existing_output = t.run_output or ""
                    break
            else:
                existing_output = ""

        session_header = existing_output
        accumulated: list[str] = []

        # Ensure clean output file
        output_file.write_text("")

        final_result, stream_objects, returncode = _invoke_claude(
            todo_id, message, session_id, source_path, model, env,
            accumulated, session_header, output_file, resume=True,
        )

        _finalize_run(todo_id, final_result, returncode, accumulated, session_header, output_file)

    except Exception as e:
        log.exception("Claude follow-up error for todo %s", todo_id)
        with StorageContext() as ctx:
            for t in ctx.store.todos:
                if t.id == todo_id:
                    t.run_status = "error"
                    t.run_output = (t.run_output or "") + f"\n\n--- Follow-up Error ---\n{e}"
                    t.run_pid = None
                    t.run_output_file = None
                    break
        _cleanup_output_file(output_file)
    finally:
        _running_tasks.pop(todo_id, None)


@router.post("/{todo_id}/followup")
def followup_todo(todo_id: str, body: FollowupRequest) -> dict:
    """Send a follow-up message to a completed Claude session."""
    if _DEMO_MODE:
        raise HTTPException(403, "Disabled in demo mode")

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
        if not todo.session_id:
            raise HTTPException(400, "No session to follow up on — run the todo first")
        if todo.run_status == "running":
            raise HTTPException(409, "Todo is currently running")

        session_id = todo.session_id

        for p in ctx.store.projects:
            if p.id == todo.project_id:
                source_path = p.source_path
                break
        if not source_path:
            raise HTTPException(400, "Project has no source_path configured")

        todo.run_status = "running"
        # Immediately show the user's follow-up message in the output
        todo.run_output = (todo.run_output or "") + f"\n\n--- Follow-up ---\n**You:** {body.message}\n"
        run_model = ctx.metadata.run_model

    thread = threading.Thread(
        target=_followup_claude_for_todo,
        args=(todo_id, body.message, session_id, source_path, run_model),
        daemon=True,
    )
    thread.start()
    _running_tasks[todo_id] = thread
    return {"status": "started"}
