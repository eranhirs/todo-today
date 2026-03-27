"""Subprocess lifecycle management for Claude todo runs.

Handles spawning, output tailing, recovery after server restart, and
per-project queue logic.
"""

from __future__ import annotations

import json
import logging
import os
import re
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
from .output_parser import (
    detect_exit_plan_mode,
    detect_plan_file,
    detect_plan_mode,
    extract_assistant_text,
    extract_run_costs,
    parse_output_file,
)
from .storage import DATA_DIR, StorageContext

log = logging.getLogger(__name__)

# Directory for run output files
_RUNS_DIR = DATA_DIR / "runs"
_RUNS_DIR.mkdir(parents=True, exist_ok=True)

_FLUSH_INTERVAL = 5  # seconds between progress flushes

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
        """Check if a process with the given PID is a live claude process (not a zombie).

        Verifies the process is actually a claude/ccd-cli process, not an
        unrelated process that reused the same PID after the original exited.
        """
        try:
            os.kill(pid, 0)
        except (OSError, ProcessLookupError):
            return False
        # Check for zombie on Linux — zombies respond to kill(0) but are defunct
        try:
            with open(f"/proc/{pid}/status") as f:
                for line in f:
                    if line.startswith("State:"):
                        if "Z" in line:
                            return False
                        break
        except (FileNotFoundError, PermissionError, OSError):
            pass
        # Verify the PID actually belongs to a claude process — if the original
        # claude process exited and the OS recycled the PID, we must not
        # reconnect to the unrelated process that now holds it.
        try:
            with open(f"/proc/{pid}/cmdline") as f:
                cmdline = f.read()
            # cmdline uses \0 as separator; check for claude or ccd-cli binaries
            if "claude" not in cmdline and "ccd-cli" not in cmdline:
                return False
        except (FileNotFoundError, PermissionError, OSError):
            # /proc not available (non-Linux) — fall back to trusting kill(0)
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
        except (ChildProcessError, OSError):
            # Not our child process (detached) or already reaped — cannot get real exit code
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


def _accumulate_costs_on_todo(t, costs: dict) -> None:
    """Add run cost/token usage to a todo (accumulates for follow-ups)."""
    t.run_cost_usd = (t.run_cost_usd or 0.0) + costs["cost"]
    t.run_input_tokens = (t.run_input_tokens or 0) + costs["input_tokens"]
    t.run_output_tokens = (t.run_output_tokens or 0) + costs["output_tokens"]
    t.run_cache_read_tokens = (t.run_cache_read_tokens or 0) + costs["cache_read_tokens"]
    t.run_duration_ms = (t.run_duration_ms or 0) + costs["duration_ms"]


def _accumulate_costs_on_metadata(metadata, costs: dict) -> None:
    """Add run costs to global metadata totals."""
    if costs["cost"] > 0 or costs["input_tokens"] > 0 or costs["output_tokens"] > 0:
        metadata.total_run_cost_usd += costs["cost"]
        metadata.total_run_input_tokens += costs["input_tokens"]
        metadata.total_run_output_tokens += costs["output_tokens"]


def _flush_progress(todo_id: str, output: str, flush_lines: int | None = None) -> None:
    """Write current accumulated output to the store."""
    with StorageContext() as ctx:
        t = ctx.get_todo(todo_id)
        if t is not None:
            t.run_output = cap_output(output)
            if flush_lines is not None:
                t.run_flush_lines = flush_lines
    bus.emit_event_sync(EventType.RUN_PROGRESS, todo_id=todo_id)


# Backward-compatible alias — callers that imported _extract_assistant_text
# from run_manager continue to work.
_extract_assistant_text = extract_assistant_text


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
    _update_session_msg_count(todo_id)
    with StorageContext() as ctx:
        t = ctx.get_todo(todo_id)
        if t is not None:
            t.status = "next"
            t.run_status = None
            t.run_output = f"[Quota/rate-limit error — will retry on next heartbeat]\n\n{error_output[:2000]}"
            t.run_pid = None
            t.run_output_file = None
    process_manager.cleanup_output_file(output_file)


# Backward-compatible aliases for detection functions (now in output_parser)
_detect_plan_file = detect_plan_file
_detect_exit_plan_mode = detect_exit_plan_mode
_detect_plan_mode = detect_plan_mode


# ── BTW (by-the-way) sessions — delegated to btw_manager ────────
from .btw_manager import is_btw_running, run_btw_for_todo, start_btw  # noqa: E402, F401


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
        t = ctx.get_todo(todo_id)
        if t is not None:
            t.run_pid = proc.pid
            t.run_output_file = str(output_file)

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
            _flush_progress(todo_id, session_header + "\n".join(accumulated), flush_lines=len(accumulated))
            last_flush = now

        if not alive:
            break

        time.sleep(0.5)

    # Final flush
    if accumulated:
        _flush_progress(todo_id, session_header + "\n".join(accumulated), flush_lines=len(accumulated))

    return final_result, stream_objects


# ── Run orchestration ────────────────────────────────────────────


def _start_pending_followup(todo_id: str, source_path: str, model: str, project_id: str) -> bool:
    """Check for a pending follow-up on a todo and start it if present.

    Returns True if a follow-up was started, False otherwise.
    Called from the finally blocks of run threads after the main run finishes.
    """
    followup_msg = None
    followup_images: list[str] = []
    followup_plan_only = False
    session_id = None
    with StorageContext() as ctx:
        t = ctx.get_todo(todo_id)
        if t is not None and t.pending_followup:
            followup_msg = t.pending_followup
            followup_images = list(t.pending_followup_images)
            followup_plan_only = t.pending_followup_plan_only
            session_id = t.session_id
            t.pending_followup = None
            t.pending_followup_images = []
            t.pending_followup_plan_only = False
            t.run_status = "running"
            t.status = "in_progress"
            t.completed_at = None
            # Append the follow-up message to output now that it's actually starting
            n_imgs = len(followup_images)
            img_suffix = f" [+{n_imgs} image{'s' if n_imgs != 1 else ''}]" if n_imgs else ""
            t.run_output = (t.run_output or "") + f"\n\n--- Follow-up ---\n**You:** {followup_msg}{img_suffix}\n\n"

    if followup_msg and session_id:
        process_manager.spawn_thread(
            todo_id, _followup_claude_for_todo,
            (todo_id, followup_msg, session_id, source_path, model, project_id, followup_images, followup_plan_only),
        )
        return True
    return False


def _resolve_todo_references(todo_text: str) -> str:
    """Resolve @[title](id) references in todo text, injecting context from referenced todos.

    Returns the prompt text with context blocks prepended and inline mentions
    replaced with plain @title for readability in the prompt.
    """
    mention_re = re.compile(r'@\[([^\]]+)\]\(([^)]+)\)')
    matches = list(mention_re.finditer(todo_text))
    if not matches:
        return todo_text

    context_blocks: list[str] = []
    result_text = todo_text

    with StorageContext(read_only=True) as ctx:
        for m in matches:
            ref_title = m.group(1)
            ref_id = m.group(2)
            ref_todo = ctx.get_todo(ref_id)
            if ref_todo and ref_todo.run_output:
                # Extract the last Claude response (after the last follow-up separator)
                sep_re = re.compile(
                    r'\n\n--- (?:Follow-up(?: \(queued\))?|BTW) ---\n\*\*You:\*\* .+?\n\n',
                    re.DOTALL,
                )
                last_sep_end = 0
                for sep_m in sep_re.finditer(ref_todo.run_output):
                    last_sep_end = sep_m.end()
                last_section = ref_todo.run_output[last_sep_end:].strip()
                if last_section:
                    max_len = 2000
                    if len(last_section) > max_len:
                        last_section = last_section[-max_len:] + "\n[...truncated]"
                    context_blocks.append(
                        f'--- Referenced todo: "{ref_title}" ---\n{last_section}\n--- End reference ---'
                    )
            # Replace @[title](id) with plain @title in the prompt text
            result_text = result_text.replace(m.group(0), f'@{ref_title}')

    if context_blocks:
        return '\n\n'.join(context_blocks) + '\n\n' + result_text
    return result_text


def _run_claude_for_todo(todo_id: str, todo_text: str, source_path: str, model: str = "opus", project_id: str = "", plan_only: bool = False, images: list[str] | None = None) -> None:
    """Background thread: run claude -p, auto-accepting plan mode if needed."""
    output_file = _RUNS_DIR / f"{todo_id}.jsonl"
    try:
        env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}
        session_id = str(uuid.uuid4())
        # Strategy-based dispatch: registered commands get special prompts
        from .command_registry import resolve_execution
        strategy, cmd_prompt = resolve_execution(todo_text)

        if strategy == "noop":
            # Should not reach here (/manual blocked upstream), but safety
            return

        if strategy == "proxy":
            # Proxy the slash command directly to Claude CLI
            prompt = cmd_prompt
        else:
            # Resolve @[title](id) references → inject context from referenced todos
            resolved_text = _resolve_todo_references(todo_text)
            if plan_only:
                prompt = (
                    f"Plan this task — explore the codebase, understand the requirements, "
                    f"and create a detailed step-by-step implementation plan. "
                    f"Do NOT write any code or make any changes. Only plan: {resolved_text}"
                )
            else:
                prompt = (
                    f"Implement this task fully — write all the code, make all the changes, "
                    f"do not stop to ask for feedback or approval: {resolved_text}"
                )
        # Append image references so Claude can read them
        if images:
            from .routers.todos import _get_image_dir
            img_dir = _get_image_dir()
            prompt += "\n\nThis task has attached images. Read each one to see the visual context:"
            for img in images:
                prompt += f"\n- {img_dir / img}"
        session_header = f"Session: {session_id}\n\n"
        accumulated: list[str] = []

        # Store output file path and session_id on todo; capture run_started_at
        run_started_at: str | None = None
        with StorageContext() as ctx:
            t = ctx.get_todo(todo_id)
            if t is not None:
                t.run_output_file = str(output_file)
                t.session_id = session_id
                run_started_at = t.run_started_at

        bus.emit_event_sync(EventType.RUN_STARTED, todo_id=todo_id, todo_text=todo_text, project_id=project_id)

        # Ensure clean output file
        output_file.write_text("")

        final_result = None
        returncode = 0
        all_stream_objects: list[dict] = []  # accumulate across retries for plan detection

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
            all_stream_objects.extend(stream_objects)

            # Check for plan mode BEFORE checking returncode — the CLI may
            # exit non-zero when ExitPlanMode is called (tool_result is_error),
            # but this is expected and should trigger auto-accept, not an error.
            # Also detect EnterPlanMode as a fallback: if Claude entered plan
            # mode but never explicitly exited, we still auto-accept.
            entered_plan = detect_exit_plan_mode(stream_objects) or detect_plan_mode(stream_objects)
            if not plan_only and entered_plan and attempt < max_retries:
                continue

            if returncode != 0:
                break

            # Otherwise we're done
            break

        # Check for quota/rate-limit errors before finalizing
        all_output = "\n".join(accumulated)
        if returncode != 0 and _is_quota_error(all_output):
            _handle_quota_error(todo_id, all_output, output_file)
        else:
            _finalize_run(todo_id, final_result, returncode, accumulated, session_header, output_file, plan_only=plan_only, stream_objects=all_stream_objects, source_path=source_path, run_started_at=run_started_at)

    except Exception as e:
        log.exception("Claude run error for todo %s", todo_id)
        err_str = str(e)
        _update_session_msg_count(todo_id)
        if _is_already_stopped(todo_id):
            log.info("Ignoring exception for todo %s — already stopped/paused by user", todo_id)
            process_manager.cleanup_output_file(output_file)
        elif _is_quota_error(err_str):
            _handle_quota_error(todo_id, err_str, output_file)
        else:
            with StorageContext() as ctx:
                t = ctx.get_todo(todo_id)
                if t is not None:
                    t.run_status = "error"
                    t.run_output = err_str
                    t.run_pid = None
                    t.run_output_file = None
                    t.is_read = False
            process_manager.cleanup_output_file(output_file)
    finally:
        # Trigger analysis directly — don't rely solely on hook curl
        try:
            from .scheduler import queue_run_session_analysis
            project_dir = source_path.replace("/", "-").replace(".", "-")
            run_session_key = f"{project_dir}/{session_id}"
            queue_run_session_analysis(run_session_key)
        except Exception:
            log.debug("Could not queue run session analysis", exc_info=True)

        process_manager.unregister_thread(todo_id)
        # Auto-start any pending follow-up queued while this run was active
        if not _start_pending_followup(todo_id, source_path, model, project_id):
            if project_id:
                _process_queue(project_id)
                autopilot_continue(project_id)


def _followup_claude_for_todo(todo_id: str, message: str, session_id: str, source_path: str, model: str = "opus", project_id: str = "", images: list[str] | None = None, plan_only: bool = False) -> None:
    """Background thread: send a follow-up message to an existing Claude session."""
    output_file = _RUNS_DIR / f"{todo_id}.jsonl"
    try:
        env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}

        # Use the already-updated output (includes user message) as the header
        run_started_at: str | None = None
        with StorageContext(read_only=True) as ctx:
            t = ctx.get_todo(todo_id)
            if t is not None:
                existing_output = t.run_output or ""
                run_started_at = t.run_started_at
            else:
                existing_output = ""

        # Append image references so Claude can read them
        prompt = message
        if images:
            from .routers.todos import _get_image_dir
            img_dir = _get_image_dir()
            prompt += "\n\nThis follow-up has attached images. Read each one to see the visual context:"
            for img in images:
                prompt += f"\n- {img_dir / img}"

        session_header = existing_output
        accumulated: list[str] = []

        # Ensure clean output file
        output_file.write_text("")

        final_result, stream_objects, returncode = _invoke_claude(
            todo_id, prompt, session_id, source_path, model, env,
            accumulated, session_header, output_file, resume=True,
            plan_only=plan_only,
        )

        _finalize_run(todo_id, final_result, returncode, accumulated, session_header, output_file, plan_only=plan_only, stream_objects=stream_objects, source_path=source_path, run_started_at=run_started_at)

    except Exception as e:
        log.exception("Claude follow-up error for todo %s", todo_id)
        _update_session_msg_count(todo_id)
        if _is_already_stopped(todo_id):
            log.info("Ignoring follow-up exception for todo %s — already stopped/paused by user", todo_id)
        else:
            with StorageContext() as ctx:
                t = ctx.get_todo(todo_id)
                if t is not None:
                    t.run_status = "error"
                    t.run_output = (t.run_output or "") + f"\n\n--- Follow-up Error ---\n{e}"
                    t.run_pid = None
                    t.run_output_file = None
        process_manager.cleanup_output_file(output_file)
    finally:
        process_manager.unregister_thread(todo_id)
        # Auto-start any pending follow-up queued while this run was active
        if not _start_pending_followup(todo_id, source_path, model, project_id):
            if project_id:
                _process_queue(project_id)
                autopilot_continue(project_id)


def _is_already_stopped(todo_id: str) -> bool:
    """Check if a todo's run was already stopped/paused by the user."""
    with StorageContext(read_only=True) as ctx:
        t = ctx.get_todo(todo_id)
        return t.run_status == "stopped" if t is not None else False


def _count_session_messages(session_id: str, source_path: str) -> int | None:
    """Count user/assistant messages in a session JSONL file.

    Returns the count, or None if the file doesn't exist or can't be read.
    """
    encoded = source_path.replace("/", "-").replace(".", "-")
    jsonl_path = Path.home() / ".claude" / "projects" / encoded / f"{session_id}.jsonl"
    if not jsonl_path.is_file():
        return None
    count = 0
    try:
        with open(jsonl_path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if entry.get("type") in ("user", "assistant"):
                    count += 1
    except Exception:
        log.debug("Could not count session messages: %s", jsonl_path, exc_info=True)
        return None
    return count


def _update_session_msg_count(todo_id: str) -> None:
    """Update session_msg_count on a todo to match the current JSONL file.

    Called from all run-exit paths (success, error, stopped, exception, quota)
    to prevent sync_cli_sessions from misidentifying app-generated messages
    as 'Resumed in CLI'.
    """
    with StorageContext() as ctx:
        t = ctx.get_todo(todo_id)
        if t is not None and t.session_id:
            p = ctx.get_project(t.project_id)
            source = p.source_path if p else ""
            if source:
                count = _count_session_messages(t.session_id, source)
                if count is not None:
                    t.session_msg_count = count


def _finalize_run(
    todo_id: str,
    final_result: Optional[dict],
    returncode: int,
    accumulated: list[str],
    session_header: str,
    output_file: Path,
    plan_only: bool = False,
    stream_objects: Optional[list[dict]] = None,
    source_path: str = "",
    run_started_at: str | None = None,
) -> None:
    """Apply the final result of a claude run to the todo and clean up."""
    # If the user already paused/stopped this run, don't overwrite the status
    if _is_already_stopped(todo_id):
        log.info("Skipping finalize for todo %s — already stopped/paused by user", todo_id)
        _update_session_msg_count(todo_id)
        process_manager.cleanup_output_file(output_file)
        return
    # Detect plan file written during the run
    plan_file = detect_plan_file(stream_objects or [], source_path=source_path, run_started_at=run_started_at)

    # For plan_only runs that wrote a plan file or entered plan mode, suppress
    # errors — Claude may exit non-zero after writing the plan (e.g. permission
    # denials for tools it tried after writing), but the plan itself is valid.
    entered_plan = detect_plan_mode(stream_objects or [])
    suppress_error = plan_only and (plan_file is not None or entered_plan)

    # Extract cost/token usage from all result events (summed across plan retries)
    costs = extract_run_costs(stream_objects or [])
    run_cost = costs["cost"]
    run_input_tokens = costs["input_tokens"]
    run_output_tokens = costs["output_tokens"]
    run_cache_read_tokens = costs["cache_read_tokens"]
    run_duration_ms = costs["duration_ms"]

    if returncode != 0 and not suppress_error:
        stderr_msg = f"Exit code {returncode}"
        log.error("Claude run failed for todo %s: %s", todo_id, stderr_msg)
        output_so_far = "\n".join(accumulated)
        if output_so_far:
            stderr_msg = output_so_far + "\n\n--- ERROR ---\n" + stderr_msg
        with StorageContext() as ctx:
            t = ctx.get_todo(todo_id)
            if t is not None:
                t.run_status = "error"
                t.run_output = cap_output(session_header + stderr_msg)
                t.run_pid = None
                t.run_output_file = None
                # Still save plan_file even on error — the plan may be valid
                if plan_file:
                    t.plan_file = plan_file
                # Store run cost even on error — tokens were consumed
                _accumulate_costs_on_todo(t, costs)
            # Accumulate into metadata
            _accumulate_costs_on_metadata(ctx.metadata, costs)
        _update_session_msg_count(todo_id)
        bus.emit_event_sync(EventType.RUN_FAILED, todo_id=todo_id, exit_code=returncode)
        process_manager.cleanup_output_file(output_file)
        return

    output_text = "\n".join(accumulated)

    # If no assistant text was produced but the result has a text payload,
    # use it (e.g. slash commands that return immediately like "Unknown skill: X").
    if not output_text and final_result and final_result.get("result"):
        output_text = final_result["result"]

    # Tools that produce permission_denials as normal behavior, not real errors
    _BENIGN_DENIAL_TOOLS = {"ExitPlanMode", "EnterPlanMode"}

    had_errors = False
    error_details: list[str] = []
    if final_result and not suppress_error:
        if final_result.get("is_error"):
            had_errors = True
            result_text = final_result.get("result", "")
            error_details.append(f"is_error: {result_text[:500]}" if result_text else "is_error: true (no details)")
        if final_result.get("permission_denials"):
            denials = final_result["permission_denials"]
            if isinstance(denials, list):
                real_denials = [
                    d for d in denials
                    if not (isinstance(d, dict) and d.get("tool_name") in _BENIGN_DENIAL_TOOLS)
                ]
            else:
                real_denials = denials  # unexpected format, treat as real
            if real_denials:
                had_errors = True
                # Build human-readable summaries instead of raw dicts
                summaries = []
                for d in (real_denials if isinstance(real_denials, list) else [real_denials]):
                    if isinstance(d, dict):
                        tool = d.get("tool_name", "?")
                        inp = d.get("tool_input", {})
                        file_path = inp.get("file_path", "") if isinstance(inp, dict) else ""
                        if file_path and "/.claude/" in file_path:
                            summaries.append(
                                f"{tool} → {file_path} (Claude CLI blocks Write/Edit "
                                f"to .claude/ paths even with --dangerously-skip-permissions)"
                            )
                        elif file_path:
                            summaries.append(f"{tool} → {file_path}")
                        else:
                            detail = ""
                            if tool == "Bash" and isinstance(inp, dict):
                                detail = f": {inp.get('command', '')[:80]}"
                            summaries.append(f"{tool}{detail}")
                    else:
                        summaries.append(str(d)[:200])
                error_details.append(f"permission_denials: {'; '.join(summaries)}")

    if had_errors:
        error_summary = "; ".join(error_details)
        log.warning("Claude run had errors for todo %s: %s", todo_id, error_summary)
        output_text += f"\n\n--- RUN ERROR ---\n{error_summary}"

    # Scan output for coping phrases
    red_flags = detect_coping_phrases(output_text)

    _update_session_msg_count(todo_id)

    with StorageContext() as ctx:
        t = ctx.get_todo(todo_id)
        if t is not None:
            t.run_output = cap_output(session_header + output_text)
            t.run_pid = None
            t.run_output_file = None
            t.is_read = False
            t.red_flags = red_flags
            if plan_file:
                t.plan_file = plan_file
            _accumulate_costs_on_todo(t, costs)
            if had_errors:
                t.run_status = "error"
                bus.emit_event_sync(EventType.RUN_FAILED, todo_id=todo_id)
            else:
                t.run_status = "done"
                t.status = "completed"
                t.completed_at = _now()
                t.completed_by_run = True
                bus.emit_event_sync(EventType.RUN_COMPLETED, todo_id=todo_id)

        _accumulate_costs_on_metadata(ctx.metadata, costs)

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

    existing_output = ""
    flush_lines: int | None = None
    proj_id = ""
    is_plan_only = False
    source_path = ""
    run_started_at: str | None = None
    with StorageContext(read_only=True) as ctx:
        t = ctx.get_todo(todo_id)
        if t is not None:
            existing_output = t.run_output or ""
            flush_lines = t.run_flush_lines
            proj_id = t.project_id
            is_plan_only = t.plan_only
            run_started_at = t.run_started_at
        # Resolve source_path from the project
        if proj_id:
            p = ctx.get_project(proj_id)
            source_path = p.source_path if p else ""

    # Recover any output written to the file between the last flush and
    # server death.  Re-read the entire file to extract text lines, then
    # compare against the flushed line count to detect a gap.
    try:
        file_start_pos = output_file.stat().st_size
    except (OSError, FileNotFoundError):
        file_start_pos = 0

    gap_text = ""
    if flush_lines is not None:
        file_lines: list[str] = []
        try:
            with open(output_file, "r") as f:
                for raw_line in f:
                    raw_line = raw_line.strip()
                    if not raw_line:
                        continue
                    try:
                        obj = json.loads(raw_line)
                    except json.JSONDecodeError:
                        continue
                    text = _extract_assistant_text(obj)
                    if text:
                        file_lines.append(text)
        except (FileNotFoundError, OSError):
            pass
        missed = file_lines[flush_lines:]
        if missed:
            gap_text = (
                "\n\n[Server restarted — recovered {} line(s) of untracked output]\n\n".format(len(missed))
                + "\n".join(missed)
            )
            log.info("Recovered %d missed lines for todo %s on reconnect", len(missed), todo_id)

    def _watcher():
        try:
            log.info("Reconnecting to claude run for todo %s (pid %d)", todo_id, pid)
            accumulated: list[str] = []
            # Preserve all prior output, appending any recovered gap content.
            session_header = existing_output + gap_text

            final_result, stream_objects = _tail_output_file(
                todo_id, pid, output_file, accumulated, session_header,
                start_pos=file_start_pos,
            )

            # Wait for the process to fully exit and get return code
            returncode = process_manager.reap_process(pid)

            # Re-parse the FULL output file for stream objects so that plan
            # detection (EnterPlanMode, ExitPlanMode, Write to .claude/plans/)
            # works even when the server restarted mid-run and _tail_output_file
            # only captured objects from the restart point onward.
            _, _, all_stream_objects = parse_output_file(str(output_file))

            _finalize_run(todo_id, final_result, returncode, accumulated, session_header, output_file, plan_only=is_plan_only, stream_objects=all_stream_objects, source_path=source_path, run_started_at=run_started_at)

        except Exception as e:
            log.exception("Reconnect error for todo %s", todo_id)
            if _is_already_stopped(todo_id):
                log.info("Ignoring reconnect exception for todo %s — already stopped/paused by user", todo_id)
            else:
                with StorageContext() as ctx:
                    t = ctx.get_todo(todo_id)
                    if t is not None:
                        t.run_status = "error"
                        existing = t.run_output or ""
                        t.run_output = cap_output(existing + f"\n\n[Reconnect failed: {e}]") if existing else f"[Reconnect failed: {e}]"
                        t.run_pid = None
                        t.run_output_file = None
            process_manager.cleanup_output_file(output_file)
        finally:
            process_manager.unregister_thread(todo_id)
            if proj_id:
                _process_queue(proj_id)
                autopilot_continue(proj_id)

    process_manager.spawn_thread(todo_id, _watcher)


# Backward-compatible alias — parse_output_file_result now lives in output_parser
parse_output_file_result = parse_output_file


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
        todo = ctx.get_todo(todo_id)
        if todo is None:
            return "todo not found"

        if todo.manual:
            return "manual task"
        if todo.run_status == "queued":
            return "already queued"
        if todo.run_status == "running":
            return "already running"

        project = ctx.get_project(todo.project_id)
        source_path = project.source_path if project else None
        if not source_path:
            return "no source_path"

        # Check if another todo in the same project is running.
        # Plan-only runs don't count — they can't edit files, so they're safe
        # to run concurrently with other tasks.
        project_busy = False
        for t in ctx.store.todos:
            if t.project_id == todo.project_id and t.id != todo_id and not t.plan_only and (is_todo_running(t.id) or t.run_status == "running"):
                project_busy = True
                break

        # Enforce daily run quota for fresh runs (not follow-ups on already-run todos)
        todo_quota = project.todo_quota if project else 0
        if todo_quota > 0 and todo.run_started_at is None:
            if _runs_in_window(todo.project_id, ctx.store.todos) >= todo_quota:
                return "run_quota_exceeded"

        trigger = "autopilot" if autopilot else "manual"

        if project_busy and not todo.plan_only:
            if autopilot:
                # Don't queue autopilot runs — they'll be picked up on completion
                return "busy"
            # Queue manual runs
            todo.run_status = "queued"
            todo.run_trigger = trigger
            todo.queued_at = _now()
            bus.emit_event_sync(EventType.RUN_QUEUED, todo_id=todo_id, project_id=todo.project_id)
            return "queued"
        # plan_only runs (Add & Plan) skip the queue — they can't edit files,
        # so they're safe to run concurrently. Follow-up messages on plan todos
        # still go through followup_todo() which queues normally.

        todo.status = "in_progress"
        todo.run_status = "running"
        todo.run_output = None
        todo.run_trigger = trigger
        todo.queued_at = None
        if todo.run_started_at is None:
            todo.run_started_at = _now()
        todo_text = todo.text
        proj_id = todo.project_id
        # Resolve model: per-project override > global setting
        run_model = (project.run_model if project and project.run_model else None) or ctx.metadata.run_model
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
        project = ctx.get_project(project_id)
        source_path = project.source_path if project else None
        if not source_path:
            # Can't run — clear all queued items for this project
            for t in queued:
                t.run_status = "done" if t.session_id else None
                t.run_trigger = None
                t.queued_at = None
                t.pending_followup = None
                t.pending_followup_images = []
                t.pending_followup_plan_only = False
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
        # Resolve model: per-project override > global setting
        run_model = (project.run_model if project and project.run_model else None) or ctx.metadata.run_model
        is_plan_only = candidate.plan_only
        todo_images = [img.filename for img in candidate.images] if candidate.images else None

        # Check if this is a queued follow-up (has pending_followup and session_id)
        followup_msg = candidate.pending_followup
        followup_session = candidate.session_id if followup_msg else None
        followup_images = list(candidate.pending_followup_images) if followup_msg else None
        followup_plan_only = candidate.pending_followup_plan_only if followup_msg else False
        if followup_msg and followup_session:
            candidate.pending_followup = None
            candidate.pending_followup_images = []
            candidate.pending_followup_plan_only = False
        else:
            # Clear any orphaned pending_followup (no session to resume into)
            if candidate.pending_followup:
                log.warning("Queue: clearing orphaned pending_followup on todo %s (no session_id)", candidate.id)
                candidate.pending_followup = None
                candidate.pending_followup_images = []
                candidate.pending_followup_plan_only = False
                followup_msg = None
            candidate.run_output = None

    bus.emit_event_sync(EventType.QUEUE_DRAIN_STARTED, queue_type="project_run", project_id=project_id, todo_id=todo_id)
    if followup_session and followup_msg:
        process_manager.spawn_thread(
            todo_id, _followup_claude_for_todo,
            (todo_id, followup_msg, followup_session, source_path, run_model, project_id, followup_images, followup_plan_only),
        )
    else:
        process_manager.spawn_thread(
            todo_id, _run_claude_for_todo,
            (todo_id, todo_text, source_path, run_model, project_id, is_plan_only, todo_images),
        )
    log.info("Queue: auto-started todo %s for project %s", todo_id, project_id)


def _is_session_autopilot_eligible(todo, todos: list, session_autopilot: dict[str, int]) -> str | None:
    """Walk up the source_session_id chain to find an autopilot-enabled ancestor.

    Returns the autopilot session_id if eligible, None otherwise.
    """
    if not session_autopilot:
        return None

    # Build lookup: session_id → todo (for finding parents)
    by_session: dict[str, object] = {}
    for t in todos:
        if t.session_id:
            by_session[t.session_id] = t

    # Walk up the chain
    visited: set[str] = set()
    current_source = todo.source_session_id
    while current_source and current_source not in visited:
        visited.add(current_source)
        # Check if this session is autopilot-enabled
        if current_source in session_autopilot and session_autopilot[current_source] > 0:
            return current_source
        # Find the parent todo whose run session matches
        parent = by_session.get(current_source)
        if parent:
            current_source = parent.source_session_id
        else:
            break

    return None


def autopilot_continue(project_id: str) -> None:
    """Start the next autopilot todo for a project if quota remains.

    Called after a run finishes (and after _process_queue drains manual queues).
    Checks project-level autopilot first, then session-scoped autopilot.
    """
    with StorageContext(read_only=True) as ctx:
        # Check if project is free (no running or queued-then-started todos)
        for t in ctx.store.todos:
            if t.project_id == project_id and (is_todo_running(t.id) or t.run_status == "running"):
                return  # still busy (manual queue drained into a run)

        # Check autopilot quota
        project = ctx.get_project(project_id)
        quota = project.auto_run_quota if project else 0
        todo_quota = project.todo_quota if project else 0

        # Enforce daily run quota (applies to both project and session autopilot)
        if todo_quota > 0 and _runs_in_window(project_id, ctx.store.todos) >= todo_quota:
            log.info("Autopilot continue: run quota %d reached for project %s, stopping", todo_quota, project_id)
            return

        all_todos = list(ctx.store.todos)
        session_ap = dict(ctx.metadata.session_autopilot)

    # --- Project-level autopilot ---
    if quota > 0:
        candidates = [
            t for t in all_todos
            if t.project_id == project_id and t.status == "next" and t.run_status not in ("queued", "running") and not t.manual
        ]
        if candidates:
            candidates.sort(key=lambda t: t.created_at, reverse=True)
            candidates.sort(key=lambda t: t.sort_order)
            todo = candidates[0]

            log.info("Autopilot continue: starting todo %s (%s) [quota: %d]", todo.id, todo.text[:60], quota)
            err = start_todo_run(todo.id, autopilot=True)
            if not err:
                with StorageContext() as ctx:
                    p = ctx.get_project(project_id)
                    if p is not None:
                        p.auto_run_quota = max(0, p.auto_run_quota - 1)
                        log.info("Autopilot continue: decremented quota for %s, remaining: %d", project_id, p.auto_run_quota)
                return
            log.info("Autopilot continue: could not start todo %s: %s", todo.id, err)

    # --- Session-scoped autopilot ---
    if not session_ap:
        return

    candidates_with_session = []
    for t in all_todos:
        if t.project_id != project_id or t.status != "next" or t.run_status in ("queued", "running") or t.manual:
            continue
        if not t.source_session_id:
            continue
        ap_session = _is_session_autopilot_eligible(t, all_todos, session_ap)
        if ap_session:
            candidates_with_session.append((t, ap_session))

    if not candidates_with_session:
        return

    # Sort: pinned first by sort_order, then by created_at descending
    candidates_with_session.sort(key=lambda pair: pair[0].created_at, reverse=True)
    candidates_with_session.sort(key=lambda pair: pair[0].sort_order)
    todo, ap_session = candidates_with_session[0]

    log.info("Session autopilot continue: starting todo %s (%s) [session: %s]", todo.id, todo.text[:60], ap_session)
    err = start_todo_run(todo.id, autopilot=True)
    if err:
        log.info("Session autopilot continue: could not start todo %s: %s", todo.id, err)
        return

    # Decrement session autopilot quota
    with StorageContext() as ctx:
        remaining = ctx.metadata.session_autopilot.get(ap_session, 0)
        if remaining > 1:
            ctx.metadata.session_autopilot[ap_session] = remaining - 1
        else:
            ctx.metadata.session_autopilot.pop(ap_session, None)


def dequeue_todo_run(todo_id: str) -> str | None:
    """Remove a todo from the run queue. Returns None on success, or an error string."""
    with StorageContext() as ctx:
        t = ctx.get_todo(todo_id)
        if t is None:
            return "todo not found"
        if t.run_status != "queued":
            return "not queued"
        t.run_status = "done" if t.session_id else None
        t.run_trigger = None
        t.queued_at = None
        t.pending_followup = None
        t.pending_followup_images = []
        t.pending_followup_plan_only = False
        return None


def cancel_pending_followup(todo_id: str) -> str | None:
    """Cancel a pending/queued follow-up message. Returns None on success, or an error string."""
    with StorageContext() as ctx:
        t = ctx.get_todo(todo_id)
        if t is None:
            return "todo not found"
        if not t.pending_followup:
            return "no pending followup"

        msg = t.pending_followup
        n_imgs = len(t.pending_followup_images)
        img_suffix = f" [+{n_imgs} image{'s' if n_imgs != 1 else ''}]" if n_imgs else ""

        # Remove followup images from todo's image list
        followup_fnames = set(t.pending_followup_images)
        if followup_fnames:
            t.images = [img for img in t.images if not (img.source == "followup" and img.filename in followup_fnames)]

        t.pending_followup = None
        t.pending_followup_images = []
        t.pending_followup_plan_only = False

        # Remove the queued follow-up line from run_output
        if t.run_output:
            queued_line = f"\n\n--- Follow-up (queued) ---\n**You:** {msg}{img_suffix}\n\n"
            t.run_output = t.run_output.replace(queued_line, "")

        # If the todo was only queued for this follow-up, un-queue it
        if t.run_status == "queued":
            t.run_status = "done"
            t.run_trigger = None
            t.queued_at = None

        return None
