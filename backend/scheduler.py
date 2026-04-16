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
from datetime import datetime

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from .claude_analyzer import run_analysis
from .cli_sync import sync_cli_sessions
from .event_bus import EventType, bus
from .git_checker import check_for_updates, skips_remaining as git_skips_remaining
from .models import _now
from .run_manager import _is_session_autopilot_eligible, is_todo_running, start_todo_run
from .storage import StorageContext

log = logging.getLogger(__name__)

DEMO_MODE = os.environ.get("TODO_DEMO", "").lower() in ("1", "true", "yes")

scheduler = AsyncIOScheduler()
_analysis_lock = asyncio.Lock()
# Per-project timeout is 120s in _invoke_claude; allow headroom for multi-project runs
_ANALYSIS_TIMEOUT = 300  # seconds
# Queued session keys from hooks — analyzed when the lock is free
_pending_hook_sessions: set[str] = set()
# Guard against concurrent autopilot runs; queued flag ensures at most one pending cycle
_autopilot_running = False
_autopilot_queued = False
# Event loop reference for thread-safe scheduling from background threads
_event_loop: asyncio.AbstractEventLoop | None = None


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


async def _auto_run_todos() -> bool:
    """Pick eligible 'next' todos and run them with Claude, respecting per-project autopilot quota.

    If autopilot is already running, queues one cycle instead of dropping it.
    Returns True if any todos were started (across all cycles including queued re-runs).
    """
    global _autopilot_running, _autopilot_queued
    if _autopilot_running:
        _autopilot_queued = True
        log.info("Autopilot: already running, queued for next cycle")
        return False
    _autopilot_running = True
    started_any = False
    # Activate any time-based scheduled autopilot quotas before running
    _activate_scheduled_autopilot()
    await bus.emit_event(EventType.AUTOPILOT_STARTED)
    try:
        started_any = await _auto_run_todos_inner()
        # Drain the queue: if another cycle was requested while we ran, run once more
        while _autopilot_queued:
            _autopilot_queued = False
            log.info("Autopilot: running queued cycle")
            if await _auto_run_todos_inner():
                started_any = True
    finally:
        _autopilot_running = False
        _autopilot_queued = False
        await bus.emit_event(EventType.AUTOPILOT_COMPLETED, started_any=started_any)
    return started_any


async def _auto_run_todos_inner() -> bool:
    """Inner implementation of autopilot — always called via _auto_run_todos guard.

    Starts at most one todo per project per cycle. Does NOT queue — if the project
    is busy, it skips. When a run finishes, autopilot_continue() picks up the next
    eligible todo automatically.

    Returns True if any todos were started.
    """
    started_any = False
    with StorageContext(read_only=True) as ctx:
        todos = list(ctx.store.todos)
        projects = {p.id: p for p in ctx.store.projects}

    # Group eligible todos by project
    from .run_manager import _is_run_after_pending
    by_project: dict[str, list] = {}
    for t in todos:
        if t.status == "next" and t.run_status not in ("queued", "running") and not _is_run_after_pending(t):
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

        # Sort matching UI: pinned (user_ordered) first by sort_order,
        # then unpinned by created_at descending (newest first)
        pinned = sorted([t for t in candidates if t.user_ordered], key=lambda t: t.sort_order)
        unpinned = sorted([t for t in candidates if not t.user_ordered], key=lambda t: t.created_at, reverse=True)
        candidates = pinned + unpinned

        # Start only the top candidate — skip if project is busy
        todo = candidates[0]
        log.info("Autopilot: starting todo %s (%s) [quota remaining: %d]", todo.id, todo.text[:60], remaining_quota)
        err = start_todo_run(todo.id, autopilot=True)
        if err == "busy":
            log.info("Autopilot: project %s busy, will continue when run finishes", project_id)
            continue
        if err:
            log.warning("Autopilot: failed to start todo %s: %s", todo.id, err)
            continue
        started_any = True
        # Decrement quota now that the run actually started
        with StorageContext() as ctx:
            for p in ctx.store.projects:
                if p.id == project_id:
                    p.auto_run_quota = max(0, p.auto_run_quota - 1)
                    log.info("Autopilot: started todo, decremented quota for %s, remaining: %d", project_id, p.auto_run_quota)
                    break

    # --- Scheduled-todo pass (run_after expired → start without requiring quota) ---
    # Re-read todos to get fresh state after project-level autopilot may have started some
    with StorageContext(read_only=True) as ctx:
        sched_todos = list(ctx.store.todos)
        sched_projects = {p.id: p for p in ctx.store.projects}

    # Track which projects already have a running todo (skip those)
    busy_projects = {t.project_id for t in sched_todos if t.run_status == "running"}
    for t in sched_todos:
        if not t.run_after or _is_run_after_pending(t):
            continue  # Not scheduled or not yet due
        if t.status != "next" or t.run_status in ("queued", "running") or t.manual:
            continue
        if t.project_id in busy_projects:
            continue
        proj = sched_projects.get(t.project_id)
        if not proj or not proj.source_path:
            continue
        log.info("Scheduled todo ready: %s (%s) — starting run", t.id, t.text[:60])
        err = start_todo_run(t.id, autopilot=True)
        if err:
            log.warning("Scheduled todo start failed %s: %s", t.id, err)
            continue
        started_any = True
        busy_projects.add(t.project_id)
        # Clear the schedule now that it's been triggered
        with StorageContext() as ctx:
            for todo in ctx.store.todos:
                if todo.id == t.id:
                    todo.run_after = None
                    break

    # --- Session-scoped autopilot pass ---
    with StorageContext(read_only=True) as ctx:
        session_ap = dict(ctx.metadata.session_autopilot)
        all_todos = list(ctx.store.todos)
        projects = {p.id: p for p in ctx.store.projects}

    if session_ap:
        for t in all_todos:
            if t.status != "next" or t.run_status in ("queued", "running") or t.manual or _is_run_after_pending(t):
                continue
            if not t.source_session_id:
                continue
            ap_session = _is_session_autopilot_eligible(t, all_todos, session_ap)
            if not ap_session:
                continue
            proj = projects.get(t.project_id)
            if not proj or not proj.source_path:
                continue
            # Check project not already busy
            if any(x.project_id == t.project_id and x.run_status == "running" for x in all_todos):
                continue

            err = start_todo_run(t.id, autopilot=True)
            if err:
                continue
            started_any = True
            with StorageContext() as ctx:
                remaining = ctx.metadata.session_autopilot.get(ap_session, 0)
                if remaining > 1:
                    ctx.metadata.session_autopilot[ap_session] = remaining - 1
                else:
                    ctx.metadata.session_autopilot.pop(ap_session, None)
            break  # One per cycle

    return started_any


_git_check_skip_counter = 0


async def _git_update_check_job() -> None:
    """Periodic job: check if there are new commits to pull from origin/main.

    Respects backoff from consecutive failures — skips ticks rather than
    hammering a broken remote every 5 minutes.
    """
    global _git_check_skip_counter
    if DEMO_MODE:
        return
    # Backoff: skip ticks when previous fetches have been failing
    skips = git_skips_remaining()
    if _git_check_skip_counter < skips:
        _git_check_skip_counter += 1
        return
    _git_check_skip_counter = 0
    try:
        await asyncio.to_thread(check_for_updates)
    except Exception:
        log.exception("Git update check failed")


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
    await bus.emit_event(EventType.ANALYSIS_STARTED, trigger="scheduled")
    try:
        entry = await _run_with_lock(asyncio.to_thread(run_analysis, trigger="scheduled"))
    except asyncio.TimeoutError:
        return
    if entry is None:
        log.info("Analysis skipped — no session changes")
        await bus.emit_event(EventType.ANALYSIS_SKIPPED, trigger="scheduled")
    else:
        log.info("Analysis complete: %s", entry.summary)
        await bus.emit_event(
            EventType.ANALYSIS_COMPLETED,
            trigger="scheduled",
            summary=entry.summary,
            todos_added=entry.todos_added,
            todos_completed=entry.todos_completed,
        )

    # Sync CLI-resumed sessions
    try:
        await asyncio.to_thread(sync_cli_sessions)
    except Exception:
        log.debug("CLI session sync failed after scheduled analysis", exc_info=True)

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

    await bus.emit_event(EventType.ANALYSIS_STARTED, trigger="manual")
    try:
        entry = await _run_with_lock(
            asyncio.to_thread(
                run_analysis, force=force, model=model, session_keys=session_keys, trigger="manual",
            ),
        )
    except asyncio.TimeoutError:
        return {"status": "error", "message": f"Analysis timed out after {_ANALYSIS_TIMEOUT}s"}
    # Run autopilot regardless of whether analysis found new sessions
    autopilot_ran = False
    try:
        autopilot_ran = await _auto_run_todos()
    except Exception:
        log.exception("Autopilot failed after manual wake-up")

    if entry is None:
        await bus.emit_event(EventType.ANALYSIS_SKIPPED, trigger="manual")
        if autopilot_ran:
            return {"status": "ok", "message": "No session changes, but autopilot tasks started"}
        return {"status": "skipped", "message": "No session changes since last analysis"}
    await bus.emit_event(
        EventType.ANALYSIS_COMPLETED,
        trigger="manual",
        summary=entry.summary,
        todos_added=entry.todos_added,
        todos_completed=entry.todos_completed,
    )
    return {"status": "ok", "entry": entry.model_dump()}


def _activate_scheduled_autopilot() -> bool:
    """Transfer scheduled_auto_run_quota → auto_run_quota for projects whose autopilot_starts_at has passed.

    Called before autopilot runs. Checks each project's scheduled start time
    against the current time and activates if due. Returns True if any were activated.
    """
    now = datetime.utcnow()
    activated = False
    with StorageContext() as ctx:
        for p in ctx.store.projects:
            if p.scheduled_auto_run_quota > 0 and p.autopilot_starts_at:
                try:
                    starts_at = datetime.fromisoformat(p.autopilot_starts_at.replace("Z", "+00:00").replace("+00:00", ""))
                except ValueError:
                    log.warning("Invalid autopilot_starts_at for project %s: %s", p.id, p.autopilot_starts_at)
                    continue
                if now >= starts_at:
                    p.auto_run_quota = p.scheduled_auto_run_quota
                    log.info(
                        "Autopilot scheduled quota activated for project %s: %d (was scheduled for %s)",
                        p.id, p.auto_run_quota, p.autopilot_starts_at,
                    )
                    p.scheduled_auto_run_quota = 0
                    p.autopilot_starts_at = None
                    activated = True
    return activated


def _has_ready_scheduled_todos() -> bool:
    """Check if any todos have run_after set and the time has passed."""
    from .run_manager import _is_run_after_pending
    with StorageContext(read_only=True) as ctx:
        for t in ctx.store.todos:
            if t.run_after and not _is_run_after_pending(t) and t.status == "next" and t.run_status not in ("queued", "running") and not t.manual:
                return True
    return False


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
    await bus.emit_event(EventType.ANALYSIS_QUEUED, trigger="hook", session_key=session_key)

    if _analysis_lock.locked():
        return {"status": "queued", "message": "Analysis busy — session queued for next run"}

    # Drain the queue now
    asyncio.ensure_future(_drain_hook_queue())
    return {"status": "started", "message": "Analysis started for hook session"}


async def _drain_hook_queue() -> None:
    """Run analysis for all pending hook sessions."""
    if _analysis_lock.locked():
        return
    await bus.emit_event(EventType.QUEUE_DRAIN_STARTED, queue_type="hook_analysis")
    while _pending_hook_sessions:
        keys = list(_pending_hook_sessions)
        _pending_hook_sessions.clear()
        log.info("Draining hook analysis queue: %d sessions", len(keys))
        await bus.emit_event(EventType.ANALYSIS_STARTED, trigger="hook", session_count=len(keys))
        try:
            entry = await _run_with_lock(
                asyncio.to_thread(run_analysis, session_keys=keys, trigger="hook"),
            )
            if entry:
                log.info("Hook analysis complete: %s", entry.summary)
                await bus.emit_event(
                    EventType.ANALYSIS_COMPLETED,
                    trigger="hook",
                    summary=entry.summary,
                    todos_added=entry.todos_added,
                    todos_completed=entry.todos_completed,
                )
            else:
                log.info("Hook analysis: no changes for queued sessions")
                await bus.emit_event(EventType.ANALYSIS_SKIPPED, trigger="hook")
        except asyncio.TimeoutError:
            await bus.emit_event(EventType.QUEUE_DRAIN_COMPLETED, queue_type="hook_analysis")
            return

    await bus.emit_event(EventType.QUEUE_DRAIN_COMPLETED, queue_type="hook_analysis")

    # Sync CLI-resumed sessions
    try:
        await asyncio.to_thread(sync_cli_sessions)
    except Exception:
        log.debug("CLI session sync failed after hook analysis", exc_info=True)

    # Run autopilot after hook analysis — hooks replace the heartbeat, so
    # autopilot must trigger here too (picks up manually-created "next" todos).
    try:
        await _auto_run_todos()
    except Exception:
        log.exception("Autopilot failed after hook analysis")


def get_missed_hook_sessions() -> list[str]:
    """Return hook session keys that fired Stop/SessionEnd but were never analyzed.

    Scans the event log (not just current hook_states.json) because a session's
    state gets cleared from hook_states when it's resumed (SessionStart). This
    catches sessions whose hook curl failed because the server was down.
    """
    from .hook_state import load_event_log

    with StorageContext(read_only=True) as ctx:
        analyzed = set(ctx.metadata.session_mtimes.keys())
        analysis_ids = set(ctx.metadata.analysis_session_ids)

    # Scan event log for Stop/SessionEnd events with unanalyzed session keys
    events = load_event_log(limit=500)
    missed_keys: set[str] = set()
    for entry in events:
        hook_event = entry.get("hook_event")
        if hook_event not in ("Stop", "SessionEnd"):
            continue
        key = entry.get("session_key", "")
        if not key:
            continue
        # Skip analysis subprocess sessions
        session_id = key.split("/", 1)[-1] if "/" in key else key
        if session_id in analysis_ids:
            continue
        # Only catch up sessions not yet analyzed
        if key not in analyzed:
            missed_keys.add(key)
    return list(missed_keys)


def queue_run_session_analysis(session_key: str) -> None:
    """Thread-safe: queue a completed Run with Claude session for analysis.

    Called from background threads (todo run workers) after a claude -p
    subprocess finishes. Adds the session to the pending queue and schedules
    drain on the main event loop.
    """
    if DEMO_MODE:
        return
    _pending_hook_sessions.add(session_key)
    log.info("Run session analysis queued (direct): %s", session_key)
    if _event_loop is not None and _event_loop.is_running():
        _event_loop.call_soon_threadsafe(
            lambda: asyncio.ensure_future(_drain_hook_queue())
        )


async def _autopilot_activation_job() -> None:
    """Lightweight 1-minute job: activate scheduled autopilot quotas and run scheduled todos.

    This ensures scheduled autopilot fires even when heartbeat_enabled is False,
    since _analysis_job skips entirely in that case and would never call
    _activate_scheduled_autopilot. Also detects todos with expired run_after
    and starts them.
    """
    if DEMO_MODE:
        return
    # Don't interfere if analysis is already running (it handles activation itself)
    if _analysis_lock.locked():
        return
    activated = _activate_scheduled_autopilot()
    has_ready_scheduled = _has_ready_scheduled_todos()
    if activated or has_ready_scheduled:
        log.info(
            "Autopilot activation job:%s%s — starting autopilot",
            " scheduled quota activated" if activated else "",
            " scheduled todos ready" if has_ready_scheduled else "",
        )
        try:
            await _auto_run_todos()
        except Exception:
            log.exception("Autopilot failed after activation job")


def start_scheduler() -> None:
    global _event_loop
    _event_loop = asyncio.get_event_loop()
    bus.set_event_loop(_event_loop)
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
    scheduler.add_job(
        _git_update_check_job,
        "interval",
        minutes=5,
        id="git_update_check",
        max_instances=1,
        replace_existing=True,
    )
    scheduler.add_job(
        _autopilot_activation_job,
        "interval",
        minutes=1,
        id="autopilot_activation",
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


def is_autopilot_running() -> bool:
    """Return whether the autopilot loop is currently active."""
    return _autopilot_running


def stop_scheduler() -> None:
    scheduler.shutdown(wait=False)
    log.info("Scheduler stopped")
