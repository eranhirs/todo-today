"""Concurrent BTW (by-the-way) session management.

Handles forking and resuming side-channel Claude sessions that run
alongside the main todo run. Extracted from run_manager.py.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import threading
import time
from pathlib import Path

from .event_bus import EventType, bus
from .output_parser import extract_assistant_text
from .storage import StorageContext

log = logging.getLogger(__name__)

# Import shared constants and singletons from run_manager at module level.
# These are stable, non-circular dependencies.
_FLUSH_INTERVAL = 5  # seconds between progress flushes

# Track btw threads separately from main run threads
_btw_threads: dict[str, threading.Thread] = {}


def _get_runs_dir() -> Path:
    """Lazy accessor for the runs directory (avoids import-time coupling)."""
    from .run_manager import _RUNS_DIR
    return _RUNS_DIR


def _get_process_manager():
    """Lazy accessor for the process manager singleton."""
    from .run_manager import process_manager
    return process_manager


def cap_output(text: str) -> str:
    """Re-export from run_manager to avoid circular import at module level."""
    from .run_manager import cap_output
    return cap_output(text)


def _flush_btw_progress(todo_id: str, output: str, is_continuation: bool = False, label: str = "BTW") -> None:
    """Write current accumulated btw output to the store."""
    with StorageContext() as ctx:
        t = ctx.get_todo(todo_id)
        if t is not None:
            if is_continuation and t.btw_output:
                # Replace content after the last separator with current progress
                sep = f"\n\n--- {label} ---\n"
                last_sep = t.btw_output.rfind(sep)
                if last_sep >= 0:
                    t.btw_output = cap_output(t.btw_output[:last_sep] + sep + output)
                else:
                    t.btw_output = cap_output(t.btw_output + sep + output)
            else:
                t.btw_output = cap_output(output)
    bus.emit_event_sync(EventType.RUN_PROGRESS, todo_id=todo_id)


def run_btw_for_todo(todo_id: str, message: str, source_path: str, model: str = "opus", main_session_id: str = "", btw_session_id: str | None = None) -> None:
    """Background thread: run a concurrent /btw Claude session alongside the main run.

    First call: forks the main session via --resume --fork-session so Claude has
    the full conversation history. The forked session is persisted and its ID is
    saved as btw_session_id.

    Subsequent calls: resumes the existing btw_session_id so messages stay in the
    same conversational thread rather than opening a new tab.
    """
    pm = _get_process_manager()
    label = "BTW"
    output_file = _get_runs_dir() / f"{todo_id}_btw.jsonl"
    try:
        env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}
        is_continuation = btw_session_id is not None

        prompt = (
            f"The user has a mid-task question. Answer concisely — this is a /btw "
            f"side-channel that won't be added to the main conversation:\n\n"
            f"{message}"
        )
        accumulated: list[str] = []

        # Store btw metadata on todo — append separator for continuations
        with StorageContext() as ctx:
            t = ctx.get_todo(todo_id)
            if t is not None:
                t.btw_output_file = str(output_file)
                t.btw_status = "running"
                if is_continuation and t.btw_output:
                    t.btw_output += f"\n\n--- {label} ---\n**You:** {message}\n<<END_USER_MSG>>\n"
                else:
                    t.btw_output = f"**You:** {message}\n<<END_USER_MSG>>\n"
                t.pending_btw = None
            # Pre-register known btw session ID so hook-triggered analysis skips it
            if btw_session_id and btw_session_id not in ctx.metadata.analysis_session_ids:
                ctx.metadata.analysis_session_ids.append(btw_session_id)

        # Ensure clean output file
        output_file.write_text("")

        if is_continuation:
            # Resume the existing btw session
            cmd = [
                "claude", "-p", "--output-format", "stream-json", "--verbose",
                "--dangerously-skip-permissions",
                "--model", model,
                "--resume", btw_session_id,
            ]
        else:
            # Fork from main session to start a new btw conversation
            cmd = [
                "claude", "-p", "--output-format", "stream-json", "--verbose",
                "--dangerously-skip-permissions",
                "--model", model,
                "--resume", main_session_id,
                "--fork-session",
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
            t = ctx.get_todo(todo_id)
            if t is not None:
                t.btw_pid = proc.pid

        # Tail the output file
        last_flush = time.monotonic()
        file_pos = 0
        result_session_id: str | None = None

        while True:
            alive = pm.pid_alive(proc.pid)

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
                    # Capture session_id from result for future continuation
                    result_session_id = obj.get("session_id")
                    # Eagerly register so hook-triggered analysis skips this session
                    if result_session_id:
                        with StorageContext() as ctx:
                            if result_session_id not in ctx.metadata.analysis_session_ids:
                                ctx.metadata.analysis_session_ids.append(result_session_id)
                    continue
                text = extract_assistant_text(obj)
                if text:
                    accumulated.append(text)

            now = time.monotonic()
            if now - last_flush >= _FLUSH_INTERVAL and accumulated:
                this_msg_output = f"**You:** {message}\n<<END_USER_MSG>>\n" + "\n".join(accumulated)
                _flush_btw_progress(todo_id, this_msg_output, is_continuation=is_continuation, label=label)
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

        this_msg_output = f"**You:** {message}\n<<END_USER_MSG>>\n" + output_text

        with StorageContext() as ctx:
            t = ctx.get_todo(todo_id)
            if t is not None:
                if is_continuation and t.btw_output:
                    # Find the last separator and replace everything after it
                    sep = f"\n\n--- {label} ---\n"
                    last_sep = t.btw_output.rfind(sep)
                    if last_sep >= 0:
                        t.btw_output = cap_output(t.btw_output[:last_sep] + sep + this_msg_output)
                    else:
                        t.btw_output = cap_output(t.btw_output + sep + this_msg_output)
                else:
                    t.btw_output = cap_output(this_msg_output)
                t.btw_status = "error" if returncode != 0 else "done"
                t.btw_pid = None
                t.btw_output_file = None
                # Save session ID for continuation (prefer result, fall back to existing)
                if result_session_id:
                    t.btw_session_id = result_session_id
                    # Register btw session ID so analysis/hooks skip it
                    if result_session_id not in ctx.metadata.analysis_session_ids:
                        ctx.metadata.analysis_session_ids.append(result_session_id)

        bus.emit_event_sync(EventType.RUN_PROGRESS, todo_id=todo_id)

    except Exception as e:
        log.exception("BTW run error for todo %s", todo_id)
        with StorageContext() as ctx:
            t = ctx.get_todo(todo_id)
            if t is not None:
                t.btw_status = "error"
                t.btw_output = (t.btw_output or "") + f"\n\n--- Error ---\n{e}"
                t.btw_pid = None
                t.btw_output_file = None
    finally:
        pm.cleanup_output_file(output_file)
        _btw_threads.pop(todo_id, None)


def is_btw_running(todo_id: str) -> bool:
    """Check if a btw side-channel is active for a todo."""
    return todo_id in _btw_threads and _btw_threads[todo_id].is_alive()


def start_btw(todo_id: str, message: str) -> str | None:
    """Start a concurrent btw session for a running todo. Returns None on success, or error string."""
    if is_btw_running(todo_id):
        return "btw already running"

    with StorageContext(read_only=True) as ctx:
        todo = ctx.get_todo(todo_id)
        if todo is None:
            return "todo not found"
        if todo.run_status != "running":
            return "todo not running"

        project = ctx.get_project(todo.project_id)
        source_path = project.source_path if project else None
        if not source_path:
            return "no source_path"

        main_session_id = todo.session_id
        if not main_session_id:
            return "no session"
        btw_session_id = todo.btw_session_id
        # Resolve model: per-project override > global setting
        run_model = (project.run_model if project and project.run_model else None) or ctx.metadata.run_model

    thread = threading.Thread(
        target=run_btw_for_todo,
        args=(todo_id, message, source_path, run_model, main_session_id, btw_session_id),
        daemon=True,
    )
    thread.start()
    _btw_threads[todo_id] = thread
    return None
