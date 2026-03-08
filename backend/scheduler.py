"""APScheduler setup for periodic Claude analysis."""

from __future__ import annotations

import asyncio
import logging
import os

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from .claude_analyzer import run_analysis
from .models import _now
from .storage import StorageContext

log = logging.getLogger(__name__)

DEMO_MODE = os.environ.get("TODO_DEMO", "").lower() in ("1", "true", "yes")

scheduler = AsyncIOScheduler()
_analysis_lock = asyncio.Lock()
# Per-project timeout is 120s in _invoke_claude; allow headroom for multi-project runs
_ANALYSIS_TIMEOUT = 300  # seconds
# Queued session keys from hooks — analyzed when the lock is free
_pending_hook_sessions: set[str] = set()


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

    async with _analysis_lock:
        with StorageContext() as ctx:
            ctx.metadata.heartbeat = _now()
        log.info("Starting scheduled analysis")
        try:
            entry = await asyncio.wait_for(
                asyncio.to_thread(run_analysis), timeout=_ANALYSIS_TIMEOUT,
            )
        except asyncio.TimeoutError:
            log.error("Analysis timed out after %ds", _ANALYSIS_TIMEOUT)
            return
        if entry is None:
            log.info("Analysis skipped — no session changes")
        else:
            log.info("Analysis complete: %s", entry.summary)


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

    async with _analysis_lock:
        try:
            entry = await asyncio.wait_for(
                asyncio.to_thread(
                    run_analysis, force=force, model=model, session_keys=session_keys,
                ),
                timeout=_ANALYSIS_TIMEOUT,
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
    async with _analysis_lock:
        while _pending_hook_sessions:
            keys = list(_pending_hook_sessions)
            _pending_hook_sessions.clear()
            log.info("Draining hook analysis queue: %d sessions", len(keys))
            try:
                entry = await asyncio.wait_for(
                    asyncio.to_thread(run_analysis, session_keys=keys),
                    timeout=_ANALYSIS_TIMEOUT,
                )
                if entry:
                    log.info("Hook analysis complete: %s", entry.summary)
                else:
                    log.info("Hook analysis: no changes for queued sessions")
            except asyncio.TimeoutError:
                log.error("Hook analysis timed out after %ds", _ANALYSIS_TIMEOUT)
                return


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


def stop_scheduler() -> None:
    scheduler.shutdown(wait=False)
    log.info("Scheduler stopped")
