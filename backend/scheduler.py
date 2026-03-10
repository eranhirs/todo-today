"""APScheduler setup for periodic Claude analysis.

IMPORTANT: asyncio.wait_for + asyncio.to_thread has a gotcha — on timeout,
the asyncio Task is cancelled but the underlying thread keeps running.
If the lock is held via `async with`, it never releases and everything
deadlocks. We use a helper (_run_with_lock) that always releases the lock
on timeout, even though the orphaned thread may still be running.
"""

from __future__ import annotations

import asyncio
import logging
import os

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from .claude_analyzer import run_analysis
from .models import _now
from .routers.todos import is_todo_running, start_todo_run
from .storage import StorageContext

log = logging.getLogger(__name__)

DEMO_MODE = os.environ.get("TODO_DEMO", "").lower() in ("1", "true", "yes")

scheduler = AsyncIOScheduler()
_analysis_lock = asyncio.Lock()
# Per-project timeout is 120s in _invoke_claude; allow headroom for multi-project runs
_ANALYSIS_TIMEOUT = 300  # seconds
# Queued session keys from hooks — analyzed when the lock is free
_pending_hook_sessions: set[str] = set()
# Guard against concurrent autopilot runs
_autopilot_running = False


async def _run_with_lock(coro, timeout: float = _ANALYSIS_TIMEOUT):
    """Acquire lock, run coro with timeout, and ALWAYS release — even on timeout.

    asyncio.wait_for cancels the Task but can't kill the underlying thread,
    so `async with _analysis_lock` would never exit. This helper guarantees
    the lock is released so subsequent jobs aren't permanently blocked.
    """
    await _analysis_lock.acquire()
    try:
        return await asyncio.wait_for(coro, timeout=timeout)
    except asyncio.TimeoutError:
        log.error("Analysis timed out after %ds — releasing lock (orphaned thread may still run)", timeout)
        raise
    finally:
        _analysis_lock.release()


async def _auto_run_todos() -> None:
    """Pick eligible 'next' todos and run them with Claude, respecting per-project autopilot quota."""
    global _autopilot_running
    if _autopilot_running:
        log.info("Autopilot: already running, skipping this cycle")
        return
    _autopilot_running = True
    try:
        await _auto_run_todos_inner()
    finally:
        _autopilot_running = False


async def _auto_run_todos_inner() -> None:
    """Inner implementation of autopilot — always called via _auto_run_todos guard."""
    with StorageContext(read_only=True) as ctx:
        todos = list(ctx.store.todos)
        projects = {p.id: p for p in ctx.store.projects}

    # Group eligible todos by project
    by_project: dict[str, list] = {}
    has_running: set[str] = set()
    for t in todos:
        if t.run_status == "running" or is_todo_running(t.id):
            has_running.add(t.project_id)
        if t.status == "next":
            by_project.setdefault(t.project_id, []).append(t)

    for project_id, candidates in by_project.items():
        proj = projects.get(project_id)
        if not proj or not proj.source_path:
            continue
        # Re-read quota fresh from storage (it decrements)
        with StorageContext(read_only=True) as ctx:
            for p in ctx.store.projects:
                if p.id == project_id:
                    remaining_quota = p.auto_run_quota
                    break
            else:
                continue
        if remaining_quota <= 0:
            continue
        if project_id in has_running:
            log.info("Autopilot: skipping project %s — already has a running todo", project_id)
            continue

        # Sort by created_at (oldest first) and pick up to remaining quota
        candidates.sort(key=lambda t: t.created_at)
        to_run = candidates[:remaining_quota]

        for todo in to_run:
            log.info("Autopilot: starting todo %s (%s) [quota remaining: %d]", todo.id, todo.text[:60], remaining_quota)
            err = start_todo_run(todo.id, autopilot=True)
            if err:
                log.warning("Autopilot: failed to start todo %s: %s", todo.id, err)
                continue
            # Decrement quota immediately
            with StorageContext() as ctx:
                for p in ctx.store.projects:
                    if p.id == project_id:
                        p.auto_run_quota = max(0, p.auto_run_quota - 1)
                        remaining_quota = p.auto_run_quota
                        log.info("Autopilot: decremented quota for %s, remaining: %d", project_id, remaining_quota)
                        break
            # Wait for completion before starting next in same project
            await _wait_for_todo(todo.id)


async def _wait_for_todo(todo_id: str, poll_interval: float = 5.0, timeout: float = 600.0) -> None:
    """Poll until a todo's background thread finishes."""
    import time
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not is_todo_running(todo_id):
            return
        await asyncio.sleep(poll_interval)
    log.warning("Autopilot: timed out waiting for todo %s after %ds", todo_id, timeout)


async def _analysis_job() -> None:
    if DEMO_MODE:
        return
    if _analysis_lock.locked():
        log.info("Analysis already running, skipping scheduled tick")
        return

    with StorageContext(read_only=True) as ctx:
        if not ctx.metadata.heartbeat_enabled:
            log.info("Heartbeat disabled, skipping scheduled tick")
            return

    with StorageContext() as ctx:
        ctx.metadata.heartbeat = _now()
    log.info("Starting scheduled analysis")
    try:
        entry = await _run_with_lock(asyncio.to_thread(run_analysis, trigger="scheduled"))
    except asyncio.TimeoutError:
        return
    if entry is None:
        log.info("Analysis skipped — no session changes")
    else:
        log.info("Analysis complete: %s", entry.summary)

    # Auto-run eligible todos after analysis (outside the lock)
    try:
        await _auto_run_todos()
    except Exception:
        log.exception("Autopilot failed after scheduled analysis")


async def trigger_analysis(
    model: str | None = None,
    force: bool = False,
    session_keys: list[str] | None = None,
) -> dict:
    """Manual wake-up trigger. Returns the analysis entry.

    If model is provided, it overrides the persisted analysis_model for this run.
    Force skips the staleness check (model override also implies force).
    If session_keys is provided, only those sessions are analyzed.
    """
    if DEMO_MODE:
        return {"status": "demo", "message": "Analysis disabled in demo mode"}
    if _analysis_lock.locked():
        return {"status": "busy", "message": "Analysis already in progress"}

    # Model override also implies force
    if not force and session_keys is None:
        with StorageContext(read_only=True) as ctx:
            persisted_model = ctx.metadata.analysis_model
        if model is not None and model != persisted_model:
            force = True

    try:
        entry = await _run_with_lock(
            asyncio.to_thread(
                run_analysis, force=force, model=model, session_keys=session_keys, trigger="manual",
            ),
        )
    except asyncio.TimeoutError:
        return {"status": "error", "message": f"Analysis timed out after {_ANALYSIS_TIMEOUT}s"}
    if entry is None:
        return {"status": "skipped", "message": "No session changes since last analysis"}
    return {"status": "ok", "entry": entry.model_dump()}


async def queue_hook_analysis(session_key: str) -> dict:
    """Queue a session for analysis triggered by a hook event.

    If analysis is idle, runs immediately. If busy, the session is queued
    and will be picked up when the current analysis finishes.
    """
    if DEMO_MODE:
        return {"status": "demo", "message": "Analysis disabled in demo mode"}
    with StorageContext(read_only=True) as ctx:
        if not ctx.metadata.hook_analysis_enabled:
            return {"status": "disabled", "message": "Hook-triggered analysis is paused"}

    _pending_hook_sessions.add(session_key)
    log.info("Hook analysis queued for session: %s", session_key)

    if _analysis_lock.locked():
        return {"status": "queued", "message": "Analysis busy — session queued for next run"}

    # Drain the queue now
    asyncio.ensure_future(_drain_hook_queue())
    return {"status": "started", "message": "Analysis started for hook session"}


async def _drain_hook_queue() -> None:
    """Run analysis for all pending hook sessions."""
    if _analysis_lock.locked():
        return
    while _pending_hook_sessions:
        keys = list(_pending_hook_sessions)
        _pending_hook_sessions.clear()
        log.info("Draining hook analysis queue: %d sessions", len(keys))
        try:
            entry = await _run_with_lock(
                asyncio.to_thread(run_analysis, session_keys=keys, trigger="hook"),
            )
            if entry:
                log.info("Hook analysis complete: %s", entry.summary)
            else:
                log.info("Hook analysis: no changes for queued sessions")
        except asyncio.TimeoutError:
            return

    # Autopilot only runs after scheduled (heartbeat) analysis, not hooks


def start_scheduler() -> None:
    with StorageContext() as ctx:
        minutes = ctx.metadata.analysis_interval_minutes
    scheduler.add_job(
        _analysis_job,
        "interval",
        minutes=minutes,
        id="claude_analysis",
        max_instances=1,
        replace_existing=True,
    )
    scheduler.start()
    log.info("Scheduler started (interval=%dm)", minutes)


def set_interval(minutes: int) -> None:
    """Update the analysis interval and reschedule the job."""
    with StorageContext() as ctx:
        ctx.metadata.analysis_interval_minutes = minutes
    scheduler.reschedule_job("claude_analysis", trigger="interval", minutes=minutes)
    log.info("Analysis interval changed to %dm", minutes)


def is_analysis_locked() -> bool:
    """Return whether the analysis lock is currently held."""
    return _analysis_lock.locked()


def stop_scheduler() -> None:
    scheduler.shutdown(wait=False)
    log.info("Scheduler stopped")
