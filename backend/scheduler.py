"""APScheduler setup for periodic Claude analysis."""

from __future__ import annotations

import asyncio
import logging

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from .claude_analyzer import run_analysis
from .models import _now
from .storage import StorageContext

log = logging.getLogger(__name__)

scheduler = AsyncIOScheduler()
_analysis_lock = asyncio.Lock()


async def _analysis_job() -> None:
    if _analysis_lock.locked():
        log.info("Analysis already running, skipping scheduled tick")
        return
    async with _analysis_lock:
        with StorageContext() as ctx:
            ctx.metadata.heartbeat = _now()
        log.info("Starting scheduled analysis")
        entry = await asyncio.to_thread(run_analysis)
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
    if _analysis_lock.locked():
        return {"status": "busy", "message": "Analysis already in progress"}

    # Model override also implies force
    if not force and session_keys is None:
        with StorageContext(read_only=True) as ctx:
            persisted_model = ctx.metadata.analysis_model
        if model is not None and model != persisted_model:
            force = True

    async with _analysis_lock:
        entry = await asyncio.to_thread(
            run_analysis, force=force, model=model, session_keys=session_keys,
        )
        if entry is None:
            return {"status": "skipped", "message": "No session changes since last analysis"}
        return {"status": "ok", "entry": entry.model_dump()}


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
