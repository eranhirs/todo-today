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

INTERVAL_MINUTES = 5


async def _analysis_job() -> None:
    if _analysis_lock.locked():
        log.info("Analysis already running, skipping scheduled tick")
        return
    async with _analysis_lock:
        with StorageContext() as ctx:
            ctx.metadata.heartbeat = _now()
        log.info("Starting scheduled analysis")
        entry = await asyncio.to_thread(run_analysis)
        log.info("Analysis complete: %s", entry.summary)


async def trigger_analysis() -> dict:
    """Manual wake-up trigger. Returns the analysis entry."""
    if _analysis_lock.locked():
        return {"status": "busy", "message": "Analysis already in progress"}
    async with _analysis_lock:
        entry = await asyncio.to_thread(run_analysis)
        return {"status": "ok", "entry": entry.model_dump()}


def start_scheduler() -> None:
    scheduler.add_job(
        _analysis_job,
        "interval",
        minutes=INTERVAL_MINUTES,
        id="claude_analysis",
        max_instances=1,
        replace_existing=True,
    )
    scheduler.start()
    log.info("Scheduler started (interval=%dm)", INTERVAL_MINUTES)


def stop_scheduler() -> None:
    scheduler.shutdown(wait=False)
    log.info("Scheduler stopped")
