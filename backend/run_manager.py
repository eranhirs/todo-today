"""Subprocess lifecycle management for Claude todo runs.

Handles spawning, output tailing, recovery after server restart, and
per-project queue logic. Extracted from routers/todos.py.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import threading
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

from .coping_detector import detect_coping_phrases
from .event_bus import EventType, bus
from .models import _now
from .storage import DATA_DIR, StorageContext

log = logging.getLogger(__name__)

# Directory for run output files
_RUNS_DIR = DATA_DIR / "runs"
_RUNS_DIR.mkdir(parents=True, exist_ok=True)

_FLUSH_INTERVAL = 3  # seconds between progress flushes

_MAX_PLAN_RETRIES = 3  # max times we'll auto-accept a plan and continue

OUTPUT_MAX_CHARS = 500_000  # single constant for the output size cap

_TRUNCATION_NOTICE = (
    "\n\n--- Output truncated ---\n"
    f"Output exceeded the {OUTPUT_MAX_CHARS:,} character limit and was truncated. "
    "Earlier content has been removed. Send a follow-up to continue."
)


def cap_output(text: str) -> str:
    """Enforce the output character limit, appending a notice if truncated."""
    if len(text) <= OUTPUT_MAX_CHARS:
        return text
    # Truncate from the beginning (keep most recent output) and add notice
    budget = OUTPUT_MAX_CHARS - len(_TRUNCATION_NOTICE)
    return _TRUNCATION_NOTICE + text[-budget:]

# Patterns that indicate Claude API quota/rate-limit exhaustion.
# When detected during an autopilot run, the todo is reset to "next" so the
# next heartbeat can retry instead of marking it as permanently failed.
_QUOTA_ERROR_PATTERNS = [
    "rate limit",
    "rate_limit",
    "quota",
    "overloaded",
    "over capacity",
    "too many requests",
    "429",
    "billing",
    "credit",
    "insufficient_quota",
    "resource_exhausted",
]


# ── Process Manager ──────────────────────────────────────────────


class ProcessManager:
    """Centralized process lifecycle management.

    Owns all PID checking, subprocess spawning/killing, zombie detection,
    thread tracking, process reaping, and output file cleanup.
    """

    def __init__(self) -> None:
        self._running_tasks: dict[str, threading.Thread] = {}

    # ── PID & zombie detection ───────────────────────────────────

    def pid_alive(self, pid: int) -> bool:
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

    # ── Process killing ──────────────────────────────────────────

    def kill_process(self, pid: int) -> None:
        """Kill a process and its process group (SIGKILL).

        Tries killpg first (entire process group), falls back to kill
        on a single PID if the group lookup fails.
        """
        try:
            os.killpg(os.getpgid(pid), 9)
        except (OSError, ProcessLookupError):
            try:
                os.kill(pid, 9)
            except (OSError, ProcessLookupError):
                pass

    # ── Process reaping ──────────────────────────────────────────

    def reap_process(self, pid: int) -> int:
        """Wait for a detached process to exit and return its exit code.

        Returns 0 if the process is not our child (detached via start_new_session).
        """
        try:
            _, returncode_raw = os.waitpid(pid, 0)
            return os.WEXITSTATUS(returncode_raw) if os.WIFEXITED(returncode_raw) else 1
        except ChildProcessError:
            # Not our child process (detached) — cannot get real exit code
            return 0

    # ── Output file cleanup ──────────────────────────────────────

    def cleanup_output_file(self, output_file: Path) -> None:
        """Remove output file if it exists."""
        try:
            output_file.unlink(missing_ok=True)
        except Exception:
            log.debug("Could not remove output file %s", output_file)

    # ── Thread tracking ──────────────────────────────────────────

    def register_thread(self, todo_id: str, thread: threading.Thread) -> None:
        """Register a background thread for a todo."""
        self._running_tasks[todo_id] = thread

    def unregister_thread(self, todo_id: str) -> None:
        """Remove a thread from tracking."""
        self._running_tasks.pop(todo_id, None)

    def is_todo_running(self, todo_id: str) -> bool:
        """Check if a todo has an active background thread."""
        return todo_id in self._running_tasks and self._running_tasks[todo_id].is_alive()

    def is_project_busy(self, project_id: str) -> bool:
        """Check if any todo in the project has an active run (thread or persisted status)."""
        with StorageContext(read_only=True) as ctx:
            for t in ctx.store.todos:
                if t.project_id == project_id and (self.is_todo_running(t.id) or t.run_status == "running"):
                    return True
        return False

    # ── Thread spawning ──────────────────────────────────────────

    def spawn_thread(self, todo_id: str, target, args: tuple = ()) -> threading.Thread:
        """Create, start, and register a daemon thread for a todo run."""
        thread = threading.Thread(target=target, args=args, daemon=True)
        thread.start()
        self._running_tasks[todo_id] = thread
        return thread


# Module-level singleton
process_manager = ProcessManager()

# Backward-compatible aliases for existing imports
_running_tasks = process_manager._running_tasks
_pid_alive = process_manager.pid_alive
_cleanup_output_file = process_manager.cleanup_output_file
is_todo_running = process_manager.is_todo_running
is_project_busy = process_manager.is_project_busy


# ── Run quota helpers ─────────────────────────────────────────────


def _runs_in_window(project_id: str, todos: list, hours: int = 24) -> int:
    """Count distinct todos with run_started_at within the last *hours* hours."""
    cutoff = (datetime.utcnow() - timedelta(hours=hours)).isoformat(timespec="seconds") + "Z"
    return sum(
        1 for t in todos
        if t.project_id == project_id and t.run_started_at and t.run_started_at >= cutoff
    )


# ── Helpers ──────────────────────────────────────────────────────


def _flush_progress(todo_id: str, output: str) -> None:
    """Write current accumulated output to the store."""
    with StorageContext() as ctx:
        for t in ctx.store.todos:
            if t.id == todo_id:
                t.run_output = cap_output(output)
                break
    bus.emit_event_sync(EventType.RUN_PROGRESS, todo_id=todo_id)


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


def _is_quota_error(output: str) -> bool:
    """Return True if the output indicates a Claude API quota/rate-limit error."""
    lower = output.lower()
    return any(pattern in lower for pattern in _QUOTA_ERROR_PATTERNS)


def _handle_quota_error(todo_id: str, error_output: str, output_file: Path) -> None:
    """Reset a todo back to 'next' status so autopilot retries on the next heartbeat.

    Called when a quota or rate-limit error is detected. Instead of marking the
    todo as permanently failed, we put it back to 'next' so the next scheduled
    heartbeat can pick it up again.
    """
    log.warning(
        "Quota/rate-limit error for todo %s — resetting to 'next' for retry on next heartbeat",
        todo_id,
    )
    with StorageContext() as ctx:
        for t in ctx.store.todos:
            if t.id == todo_id:
                t.status = "next"
                t.run_status = None
                t.run_output = f"[Quota/rate-limit error — will retry on next heartbeat]\n\n{error_output[:2000]}"
                t.run_pid = None
                t.run_output_file = None
                break
    process_manager.cleanup_output_file(output_file)


def _detect_plan_file(stream_objects: list[dict]) -> Optional[str]:
    """Scan stream objects for a Write tool_use targeting .claude/plans/.

    Returns the file path if found, else None.
    """
    for obj in stream_objects:
        if obj.get("type") != "assistant":
            continue
        for block in obj.get("message", {}).get("content", []):
            if isinstance(block, dict) and block.get("type") == "tool_use":
                if block.get("name") == "Write":
                    file_path = block.get("input", {}).get("file_path", "")
                    if ".claude/plans/" in file_path:
                        return file_path
    return None


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


# ── Concurrent BTW runner ────────────────────────────────────────


def _flush_btw_progress(todo_id: str, output: str) -> None:
    """Write current accumulated btw output to the store."""
    with StorageContext() as ctx:
        for t in ctx.store.todos:
            if t.id == todo_id:
                t.btw_output = cap_output(output)
                break
    bus.emit_event_sync(EventType.RUN_PROGRESS, todo_id=todo_id)


def run_btw_for_todo(todo_id: str, message: str, source_path: str, model: str = "opus", main_session_id: str = "") -> None:
    """Background thread: run a concurrent /btw Claude session alongside the main run.

    Forks the main run's session via --resume --fork-session --no-session-persistence
    so Claude has the full native conversation history (tool calls, results, system
    prompts) without modifying the original session. Output is stored separately in
    btw_output/btw_status fields.
    """
    output_file = _RUNS_DIR / f"{todo_id}_btw.jsonl"
    try:
        env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}

        prompt = (
            f"The user has a mid-task question. Answer concisely — this is a /btw "
            f"side-channel that won't be added to the main conversation:\n\n"
            f"{message}"
        )
        accumulated: list[str] = []

        # Store btw metadata on todo
        with StorageContext() as ctx:
            for t in ctx.store.todos:
                if t.id == todo_id:
                    t.btw_output_file = str(output_file)
                    t.btw_status = "running"
                    t.btw_output = f"**You:** {message}\n"
                    t.pending_btw = None
                    break

        # Ensure clean output file
        output_file.write_text("")

        cmd = [
            "claude", "-p", "--output-format", "stream-json", "--verbose",
            "--dangerously-skip-permissions",
            "--model", model,
            "--resume", main_session_id,
            "--fork-session",
            "--no-session-persistence",
        ]

        fout = open(output_file, "a")
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=fout,
            stderr=subprocess.PIPE,
            text=True,
            cwd=source_path,
            env=env,
            start_new_session=True,
        )
        proc.stdin.write(prompt)
        proc.stdin.close()
        fout.close()

        # Store PID
        with StorageContext() as ctx:
            for t in ctx.store.todos:
                if t.id == todo_id:
                    t.btw_pid = proc.pid
                    break

        # Tail the output file
        last_flush = time.monotonic()
        file_pos = 0

        while True:
            alive = _pid_alive(proc.pid)

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
                if obj.get("type") == "result":
                    continue
                text = _extract_assistant_text(obj)
                if text:
                    accumulated.append(text)

            now = time.monotonic()
            if now - last_flush >= _FLUSH_INTERVAL and accumulated:
                _flush_btw_progress(todo_id, f"**You:** {message}\n\n" + "\n".join(accumulated))
                last_flush = now

            if not alive:
                break
            time.sleep(0.5)

        # Final flush
        output_text = "\n".join(accumulated)
        proc.wait(timeout=60)
        returncode = proc.returncode

        if returncode != 0:
            stderr_out = proc.stderr.read() if proc.stderr else ""
            if stderr_out:
                log.error("BTW Claude stderr for todo %s: %s", todo_id, stderr_out[:2000])
                output_text += f"\n\nstderr: {stderr_out[:2000]}"

        with StorageContext() as ctx:
            for t in ctx.store.todos:
                if t.id == todo_id:
                    t.btw_output = cap_output(f"**You:** {message}\n\n" + output_text)
                    t.btw_status = "error" if returncode != 0 else "done"
                    t.btw_pid = None
                    t.btw_output_file = None
                    break

        bus.emit_event_sync(EventType.RUN_PROGRESS, todo_id=todo_id)

    except Exception as e:
        log.exception("BTW run error for todo %s", todo_id)
        with StorageContext() as ctx:
            for t in ctx.store.todos:
                if t.id == todo_id:
                    t.btw_status = "error"
                    t.btw_output = (t.btw_output or "") + f"\n\n--- Error ---\n{e}"
                    t.btw_pid = None
                    t.btw_output_file = None
                    break
    finally:
        process_manager.cleanup_output_file(output_file)
        _btw_threads.pop(todo_id, None)


# Track btw threads separately from main run threads
_btw_threads: dict[str, threading.Thread] = {}


def is_btw_running(todo_id: str) -> bool:
    """Check if a btw side-channel is active for a todo."""
    return todo_id in _btw_threads and _btw_threads[todo_id].is_alive()


def start_btw(todo_id: str, message: str) -> str | None:
    """Start a concurrent btw session for a running todo. Returns None on success, or error string."""
    if is_btw_running(todo_id):
        return "btw already running"

    with StorageContext(read_only=True) as ctx:
        todo = None
        source_path = None
        for t in ctx.store.todos:
            if t.id == todo_id:
                todo = t
                break
        if todo is None:
            return "todo not found"
        if todo.run_status != "running":
            return "todo not running"

        for p in ctx.store.projects:
            if p.id == todo.project_id:
                source_path = p.source_path
                break
        if not source_path:
            return "no source_path"

        main_session_id = todo.session_id
        if not main_session_id:
            return "no session"
        run_model = ctx.metadata.run_model

    thread = threading.Thread(
        target=run_btw_for_todo,
        args=(todo_id, message, source_path, run_model, main_session_id),
        daemon=True,
    )
    thread.start()
    _btw_threads[todo_id] = thread
    return None


# ── Subprocess invocation & tailing ──────────────────────────────


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
    plan_only: bool = False,
) -> tuple[Optional[dict], list[dict], int]:
    """Run a single claude -p invocation with a detached subprocess writing to output_file.

    Returns (final_result, stream_objects, returncode).
    """
    disallowed = ["AskUserQuestion"]
    if plan_only:
        disallowed.extend(["Edit", "Bash", "NotebookEdit"])
    cmd = [
        "claude", "-p", "--output-format", "stream-json", "--verbose",
        "--dangerously-skip-permissions",
        "--disallowedTools", ",".join(disallowed),
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


# ── Run orchestration ────────────────────────────────────────────


def _run_claude_for_todo(todo_id: str, todo_text: str, source_path: str, model: str = "opus", project_id: str = "", plan_only: bool = False, images: list[str] | None = None) -> None:
    """Background thread: run claude -p, auto-accepting plan mode if needed."""
    output_file = _RUNS_DIR / f"{todo_id}.jsonl"
    try:
        env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}
        session_id = str(uuid.uuid4())
        if plan_only:
            prompt = (
                f"Plan this task — explore the codebase, understand the requirements, "
                f"and create a detailed step-by-step implementation plan. "
                f"Do NOT write any code or make any changes. Only plan: {todo_text}"
            )
        else:
            prompt = (
                f"Implement this task fully — write all the code, make all the changes, "
                f"do not stop to ask for feedback or approval: {todo_text}"
            )
        # Append image references so Claude can read them
        if images:
            prompt += "\n\nThis task has attached images. Read each one to see the visual context:"
            for img in images:
                prompt += f"\n- /tmp/claude-todos-images/{img}"
        session_header = f"Session: {session_id}\n\n"
        accumulated: list[str] = []

        # Store output file path and session_id on todo
        with StorageContext() as ctx:
            for t in ctx.store.todos:
                if t.id == todo_id:
                    t.run_output_file = str(output_file)
                    t.session_id = session_id
                    break

        bus.emit_event_sync(EventType.RUN_STARTED, todo_id=todo_id, todo_text=todo_text, project_id=project_id)

        # Ensure clean output file
        output_file.write_text("")

        final_result = None
        returncode = 0

        max_retries = 0 if plan_only else _MAX_PLAN_RETRIES
        for attempt in range(max_retries + 1):
            is_resume = attempt > 0
            if is_resume:
                prompt = "Plan accepted. Now implement it fully."
                log.info("Auto-accepting plan for todo %s (attempt %d)", todo_id, attempt + 1)
                accumulated.append("\n--- Plan accepted, continuing ---\n")

            final_result, stream_objects, returncode = _invoke_claude(
                todo_id, prompt, session_id, source_path, model, env,
                accumulated, session_header, output_file, resume=is_resume,
                plan_only=plan_only,
            )

            if returncode != 0:
                break

            # If Claude exited plan mode, auto-accept and continue (unless plan_only)
            if not plan_only and _detect_exit_plan_mode(stream_objects) and attempt < max_retries:
                continue

            # Otherwise we're done
            break

        # Check for quota/rate-limit errors before finalizing
        all_output = "\n".join(accumulated)
        if returncode != 0 and _is_quota_error(all_output):
            _handle_quota_error(todo_id, all_output, output_file)
        else:
            _finalize_run(todo_id, final_result, returncode, accumulated, session_header, output_file, plan_only=plan_only, stream_objects=stream_objects)

    except Exception as e:
        log.exception("Claude run error for todo %s", todo_id)
        err_str = str(e)
        if _is_quota_error(err_str):
            _handle_quota_error(todo_id, err_str, output_file)
        else:
            with StorageContext() as ctx:
                for t in ctx.store.todos:
                    if t.id == todo_id:
                        t.run_status = "error"
                        t.run_output = err_str
                        t.run_pid = None
                        t.run_output_file = None
                        t.is_read = False
                        break
            process_manager.cleanup_output_file(output_file)
    finally:
        # Trigger analysis directly — don't rely solely on hook curl
        try:
            from .scheduler import queue_run_session_analysis
            project_dir = source_path.replace("/", "-")
            run_session_key = f"{project_dir}/{session_id}"
            queue_run_session_analysis(run_session_key)
        except Exception:
            log.debug("Could not queue run session analysis", exc_info=True)

        process_manager.unregister_thread(todo_id)
        if project_id:
            _process_queue(project_id)
            autopilot_continue(project_id)


def _followup_claude_for_todo(todo_id: str, message: str, session_id: str, source_path: str, model: str = "opus", project_id: str = "", images: list[str] | None = None) -> None:
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

        # Append image references so Claude can read them
        prompt = message
        if images:
            prompt += "\n\nThis follow-up has attached images. Read each one to see the visual context:"
            for img in images:
                prompt += f"\n- /tmp/claude-todos-images/{img}"

        session_header = existing_output
        accumulated: list[str] = []

        # Ensure clean output file
        output_file.write_text("")

        final_result, stream_objects, returncode = _invoke_claude(
            todo_id, prompt, session_id, source_path, model, env,
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
        process_manager.cleanup_output_file(output_file)
    finally:
        process_manager.unregister_thread(todo_id)
        if project_id:
            _process_queue(project_id)
            autopilot_continue(project_id)


def _finalize_run(
    todo_id: str,
    final_result: Optional[dict],
    returncode: int,
    accumulated: list[str],
    session_header: str,
    output_file: Path,
    plan_only: bool = False,
    stream_objects: Optional[list[dict]] = None,
) -> None:
    """Apply the final result of a claude run to the todo and clean up."""
    # Detect plan file written during the run
    plan_file = _detect_plan_file(stream_objects or []) if plan_only else None

    # For plan_only runs that successfully wrote a plan file, suppress errors —
    # Claude may exit non-zero after writing the plan (e.g. permission denials
    # for tools it tried after writing), but the plan itself is valid.
    suppress_error = plan_only and plan_file is not None

    if returncode != 0 and not suppress_error:
        stderr_msg = f"Exit code {returncode}"
        log.error("Claude run failed for todo %s: %s", todo_id, stderr_msg)
        output_so_far = "\n".join(accumulated)
        if output_so_far:
            stderr_msg = output_so_far + "\n\n--- ERROR ---\n" + stderr_msg
        with StorageContext() as ctx:
            for t in ctx.store.todos:
                if t.id == todo_id:
                    t.run_status = "error"
                    t.run_output = cap_output(session_header + stderr_msg)
                    t.run_pid = None
                    t.run_output_file = None
                    break
        bus.emit_event_sync(EventType.RUN_FAILED, todo_id=todo_id, exit_code=returncode)
        process_manager.cleanup_output_file(output_file)
        return

    output_text = "\n".join(accumulated)
    had_errors = False
    if final_result and not suppress_error:
        if final_result.get("is_error"):
            had_errors = True
        if final_result.get("permission_denials"):
            had_errors = True

    # Scan output for coping phrases
    red_flags = detect_coping_phrases(output_text)

    with StorageContext() as ctx:
        for t in ctx.store.todos:
            if t.id == todo_id:
                t.run_output = cap_output(session_header + output_text)
                t.run_pid = None
                t.run_output_file = None
                t.is_read = False
                t.red_flags = red_flags
                if plan_file:
                    t.plan_file = plan_file
                if had_errors:
                    t.run_status = "error"
                    bus.emit_event_sync(EventType.RUN_FAILED, todo_id=todo_id)
                elif plan_only:
                    # Plan-only runs produce a plan but don't complete the todo
                    t.run_status = "done"
                    t.status = "next"
                    bus.emit_event_sync(EventType.RUN_COMPLETED, todo_id=todo_id)
                else:
                    t.run_status = "done"
                    t.status = "completed"
                    t.completed_at = _now()
                    t.completed_by_run = True
                    bus.emit_event_sync(EventType.RUN_COMPLETED, todo_id=todo_id)
                break

    process_manager.cleanup_output_file(output_file)


# ── Recovery ─────────────────────────────────────────────────────


def reconnect_todo_run(todo_id: str, pid: int, output_file_str: str) -> None:
    """Reconnect to a still-running detached claude subprocess after server restart.

    Spawns a watcher thread that tails the output file and waits for the process to finish.
    No plan-mode retry on reconnect — the current invocation just completes.
    """
    if process_manager.is_todo_running(todo_id):
        return  # already being watched

    output_file = Path(output_file_str)

    # Capture existing output and file position BEFORE starting watcher thread
    existing_output = ""
    proj_id = ""
    with StorageContext(read_only=True) as ctx:
        for t in ctx.store.todos:
            if t.id == todo_id:
                existing_output = t.run_output or ""
                proj_id = t.project_id
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
            returncode = process_manager.reap_process(pid)

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
            process_manager.cleanup_output_file(output_file)
        finally:
            process_manager.unregister_thread(todo_id)
            if proj_id:
                _process_queue(proj_id)
                autopilot_continue(proj_id)

    process_manager.spawn_thread(todo_id, _watcher)


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


# ── Queue & status ───────────────────────────────────────────────


def start_todo_run(todo_id: str, autopilot: bool = False) -> str | None:
    """Start or queue a Claude run for a todo. Returns None on success, or an error string.

    Used by the /run endpoint and by the scheduler for auto-run.
    When autopilot=True, sets run_trigger to 'autopilot' so the UI can distinguish.
    If another todo in the same project is already running, the todo is queued
    and will auto-start when the project becomes free. Returns "queued" in that case.
    """
    if process_manager.is_todo_running(todo_id):
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

        if todo.manual:
            return "manual task"
        if todo.run_status == "queued":
            return "already queued"
        if todo.run_status == "running":
            return "already running"

        for p in ctx.store.projects:
            if p.id == todo.project_id:
                source_path = p.source_path
                break
        if not source_path:
            return "no source_path"

        # Check if another todo in the same project is running
        # Check both in-memory threads AND persisted run_status (survives server restarts)
        project_busy = False
        for t in ctx.store.todos:
            if t.project_id == todo.project_id and t.id != todo_id and (is_todo_running(t.id) or t.run_status == "running"):
                project_busy = True
                break

        # Enforce daily run quota for fresh runs (not follow-ups on already-run todos)
        todo_quota = 0
        for p in ctx.store.projects:
            if p.id == todo.project_id:
                todo_quota = p.todo_quota
                break
        if todo_quota > 0 and todo.run_started_at is None:
            if _runs_in_window(todo.project_id, ctx.store.todos) >= todo_quota:
                return "run_quota_exceeded"

        trigger = "autopilot" if autopilot else "manual"

        if project_busy:
            if autopilot:
                # Don't queue autopilot runs — they'll be picked up on completion
                return "busy"
            # Queue manual runs
            todo.run_status = "queued"
            todo.run_trigger = trigger
            todo.queued_at = _now()
            bus.emit_event_sync(EventType.RUN_QUEUED, todo_id=todo_id, project_id=todo.project_id)
            return "queued"

        todo.status = "in_progress"
        todo.run_status = "running"
        todo.run_output = None
        todo.run_trigger = trigger
        todo.queued_at = None
        if todo.run_started_at is None:
            todo.run_started_at = _now()
        todo_text = todo.text
        proj_id = todo.project_id
        run_model = ctx.metadata.run_model
        is_plan_only = todo.plan_only
        todo_images = [img.filename for img in todo.images] if todo.images else None

    process_manager.spawn_thread(todo_id, _run_claude_for_todo, (todo_id, todo_text, source_path, run_model, proj_id, is_plan_only, todo_images))
    return None


def _process_queue(project_id: str) -> None:
    """Start the next queued todo for a project, if any.

    Called after a run finishes or is stopped to drain the queue.
    """
    with StorageContext() as ctx:
        # Find queued todos for this project, ordered by queued_at
        queued = [
            t for t in ctx.store.todos
            if t.project_id == project_id and t.run_status == "queued"
        ]
        if not queued:
            return
        queued.sort(key=lambda t: t.queued_at or "")

        # Check project is actually free now (thread OR persisted status)
        for t in ctx.store.todos:
            if t.project_id == project_id and (is_todo_running(t.id) or t.run_status == "running"):
                return  # still busy

        # Pick next candidate and transition to running
        candidate = queued[0]
        source_path = None
        todo_quota = 0
        for p in ctx.store.projects:
            if p.id == project_id:
                source_path = p.source_path
                todo_quota = p.todo_quota
                break
        if not source_path:
            # Can't run — clear all queued items for this project
            for t in queued:
                t.run_status = None
                t.run_trigger = None
                t.queued_at = None
            return

        # NOTE: No quota check here — items already in the queue were approved
        # at insertion time. Quota changes only block new insertions, not
        # already-queued items.

        candidate.status = "in_progress"
        candidate.run_status = "running"
        candidate.queued_at = None
        if candidate.run_started_at is None:
            candidate.run_started_at = _now()
        todo_id = candidate.id
        todo_text = candidate.text
        run_model = ctx.metadata.run_model
        is_plan_only = candidate.plan_only
        todo_images = [img.filename for img in candidate.images] if candidate.images else None

        # Check if this is a queued follow-up (has pending_followup and session_id)
        followup_msg = candidate.pending_followup
        followup_session = candidate.session_id if followup_msg else None
        followup_images = list(candidate.pending_followup_images) if followup_msg else None
        if followup_msg:
            candidate.pending_followup = None
            candidate.pending_followup_images = []
        else:
            candidate.run_output = None

    bus.emit_event_sync(EventType.QUEUE_DRAIN_STARTED, queue_type="project_run", project_id=project_id, todo_id=todo_id)
    if followup_session and followup_msg:
        process_manager.spawn_thread(
            todo_id, _followup_claude_for_todo,
            (todo_id, followup_msg, followup_session, source_path, run_model, project_id, followup_images),
        )
    else:
        process_manager.spawn_thread(
            todo_id, _run_claude_for_todo,
            (todo_id, todo_text, source_path, run_model, project_id, is_plan_only, todo_images),
        )
    log.info("Queue: auto-started todo %s for project %s", todo_id, project_id)


def autopilot_continue(project_id: str) -> None:
    """Start the next autopilot todo for a project if quota remains.

    Called after a run finishes (and after _process_queue drains manual queues).
    Checks if the project still has auto_run_quota > 0, finds the next eligible
    "next" todo, starts it, and decrements the quota.
    """
    with StorageContext(read_only=True) as ctx:
        # Check if project is free (no running or queued-then-started todos)
        for t in ctx.store.todos:
            if t.project_id == project_id and (is_todo_running(t.id) or t.run_status == "running"):
                return  # still busy (manual queue drained into a run)

        # Check autopilot quota
        quota = 0
        todo_quota = 0
        for p in ctx.store.projects:
            if p.id == project_id:
                quota = p.auto_run_quota
                todo_quota = p.todo_quota
                break
        if quota <= 0:
            return

        # Enforce daily run quota
        if todo_quota > 0 and _runs_in_window(project_id, ctx.store.todos) >= todo_quota:
            log.info("Autopilot continue: run quota %d reached for project %s, stopping", todo_quota, project_id)
            return

        # Find eligible candidates (exclude manual tasks — those are for humans)
        candidates = [
            t for t in ctx.store.todos
            if t.project_id == project_id and t.status == "next" and t.run_status not in ("queued", "running") and not t.manual
        ]
        if not candidates:
            return

    # Sort same as autopilot: sort_order ascending, created_at descending
    candidates.sort(key=lambda t: t.created_at, reverse=True)
    candidates.sort(key=lambda t: t.sort_order)
    todo = candidates[0]

    log.info("Autopilot continue: starting todo %s (%s) [quota: %d]", todo.id, todo.text[:60], quota)
    err = start_todo_run(todo.id, autopilot=True)
    if err:
        log.info("Autopilot continue: could not start todo %s: %s", todo.id, err)
        return

    # Decrement quota
    with StorageContext() as ctx:
        for p in ctx.store.projects:
            if p.id == project_id:
                p.auto_run_quota = max(0, p.auto_run_quota - 1)
                log.info("Autopilot continue: decremented quota for %s, remaining: %d", project_id, p.auto_run_quota)
                break


def dequeue_todo_run(todo_id: str) -> str | None:
    """Remove a todo from the run queue. Returns None on success, or an error string."""
    with StorageContext() as ctx:
        for t in ctx.store.todos:
            if t.id == todo_id:
                if t.run_status != "queued":
                    return "not queued"
                t.run_status = None
                t.run_trigger = None
                t.queued_at = None
                t.pending_followup = None
                return None
    return "todo not found"
