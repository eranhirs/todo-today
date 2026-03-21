"""FastAPI application for Claude Todos."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.responses import StreamingResponse

from .event_bus import bus
from .models import ErrorResponse, FullState, _now
from .routers import claude, projects, todos
from .run_manager import (
    _process_queue,
    autopilot_continue,
    cap_output,
    parse_output_file_result,
    process_manager,
    reconnect_todo_run,
)
from .scheduler import (
    get_missed_hook_sessions,
    is_analysis_locked,
    is_autopilot_running,
    queue_hook_analysis,
    start_scheduler,
    stop_scheduler,
)
from .storage import StorageContext, run_in_thread

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

_REQUEST_TIMEOUT = 30  # seconds — safety net for any blocked request


def _cleanup_stale_runs() -> None:
    """Smart cleanup: reconnect to surviving processes, parse finished ones, reset the rest."""
    # First pass: collect info (don't hold lock while spawning threads)
    stale: list[tuple[str, int | None, str | None]] = []
    with StorageContext(read_only=True) as ctx:
        for t in ctx.store.todos:
            if t.run_status == "running":
                stale.append((t.id, t.run_pid, t.run_output_file))

    for todo_id, run_pid, run_output_file in stale:
        if run_pid and process_manager.pid_alive(run_pid):
            # Process survived the restart — reconnect
            log.info("Reconnecting to surviving claude process for todo %s (pid %d)", todo_id, run_pid)
            reconnect_todo_run(todo_id, run_pid, run_output_file or "")
        elif run_pid and run_output_file:
            # Process finished while server was down — parse output file
            log.info("Parsing completed output file for todo %s", todo_id)
            final_result, accumulated = parse_output_file_result(run_output_file)
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
                        # Preserve existing output (from before restart) and append recovery info
                        existing = t.run_output or ""
                        recovery_header = existing + "\n\n[Recovered after server restart]\n\n" if existing else "[Recovered after server restart]\n\n"
                        t.run_output = cap_output(recovery_header + output_text) if output_text else t.run_output
                        t.run_pid = None
                        t.run_output_file = None
                        if had_errors or not final_result:
                            t.run_status = "error"
                            if not final_result:
                                t.run_output = (t.run_output or "") + "\n[Process exited without result]"
                            if t.status == "in_progress":
                                t.status = "next"
                        else:
                            t.run_status = "done"
                            t.status = "completed"
                            t.completed_at = _now()
                            t.completed_by_run = True
                        break
            process_manager.cleanup_output_file(Path(run_output_file))
        else:
            # Legacy: no PID info — mark as error
            log.info("Reset stale running todo %s (no PID info)", todo_id)
            with StorageContext() as ctx:
                for t in ctx.store.todos:
                    if t.id == todo_id:
                        t.run_status = "error"
                        t.run_output = (t.run_output or "") + "\n[Server restarted — run was interrupted]"
                        t.run_pid = None
                        t.run_output_file = None
                        if t.status == "in_progress":
                            t.status = "next"
                        break

    # Clear orphaned pending_followups on todos that are no longer running/queued.
    # These can linger if the server died while a run was active with a queued followup.
    with StorageContext() as ctx:
        for t in ctx.store.todos:
            if t.pending_followup and t.run_status not in ("running", "queued"):
                log.info("Clearing orphaned pending_followup on todo %s (run_status=%s)", t.id, t.run_status)
                t.pending_followup = None
                t.pending_followup_images = []

    # Drain the queue for any project that has queued items (they may have been
    # orphaned if the previously-running todo finished while the server was down).
    with StorageContext(read_only=True) as ctx:
        queued_project_ids = list({
            t.project_id for t in ctx.store.todos
            if t.run_status == "queued" and t.project_id
        })
        autopilot_project_ids = [p.id for p in ctx.store.projects if p.auto_run_quota > 0]
    for pid in queued_project_ids:
        _process_queue(pid)
    # After cleanup, try autopilot continuation for all projects with quota
    for pid in autopilot_project_ids:
        autopilot_continue(pid)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Increase the default anyio thread pool so storage-lock contention
    # under moderate concurrency doesn't exhaust the pool.
    try:
        from anyio import to_thread
        to_thread.current_default_thread_limiter().total_tokens = 100
    except Exception:
        pass  # best-effort; pool size will stay at default 40

    # Run startup cleanup in a thread so it doesn't block the event loop
    await run_in_thread(_cleanup_stale_runs)
    start_scheduler()
    # Catch up on hook events that fired while the server was down
    missed = get_missed_hook_sessions()
    if missed:
        log.info("Catching up %d missed hook sessions from server downtime", len(missed))
        for key in missed:
            await queue_hook_analysis(key)
    yield
    stop_scheduler()


app = FastAPI(title="Claude Todos", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def request_timeout_middleware(request: Request, call_next):
    """Cancel any request that takes longer than _REQUEST_TIMEOUT seconds."""
    try:
        return await asyncio.wait_for(call_next(request), timeout=_REQUEST_TIMEOUT)
    except asyncio.TimeoutError:
        log.warning("Request timed out after %ds: %s %s", _REQUEST_TIMEOUT, request.method, request.url.path)
        return JSONResponse(
            status_code=504,
            content={"detail": f"Request timed out after {_REQUEST_TIMEOUT}s"},
        )


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    log.warning("HTTP %d on %s %s: %s", exc.status_code, request.method, request.url.path, exc.detail)
    body = ErrorResponse(detail=str(exc.detail))
    return JSONResponse(status_code=exc.status_code, content=body.model_dump())


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    detail = "; ".join(
        f"{'.'.join(str(loc) for loc in e['loc'])}: {e['msg']}" for e in exc.errors()
    )
    log.warning("Validation error on %s %s: %s", request.method, request.url.path, detail)
    body = ErrorResponse(detail=detail, error_code="VALIDATION_ERROR")
    return JSONResponse(status_code=422, content=body.model_dump())


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    log.exception("Unhandled error on %s %s", request.method, request.url.path)
    body = ErrorResponse(detail="Internal server error", error_code="INTERNAL_ERROR")
    return JSONResponse(status_code=500, content=body.model_dump())


app.include_router(projects.router)
app.include_router(todos.router)
app.include_router(claude.router)


COMPLETED_PAGE_SIZE = 50  # Number of completed todos to load per page


@app.get("/api/state")
async def full_state() -> FullState:
    def _do():
        with StorageContext(read_only=True) as ctx:
            all_todos = ctx.store.todos
            # Split: keep all non-completed, cap completed to first page
            non_completed = [t for t in all_todos if t.status != "completed"]
            completed = sorted(
                [t for t in all_todos if t.status == "completed"],
                key=lambda t: t.completed_at or "",
                reverse=True,
            )
            completed_total = len(completed)
            completed_by_project: dict[str, int] = {}
            for t in completed:
                completed_by_project[t.project_id] = completed_by_project.get(t.project_id, 0) + 1
            capped_completed = completed[:COMPLETED_PAGE_SIZE]
            # Compute unread counts from ALL todos (not just the paginated subset)
            unread_counts: dict[str, int] = {"_total": 0}
            for t in all_todos:
                if t.completed_by_run and not t.is_read:
                    unread_counts["_total"] += 1
                    unread_counts[t.project_id] = unread_counts.get(t.project_id, 0) + 1
            return FullState(
                projects=ctx.store.projects,
                todos=non_completed + capped_completed,
                metadata=ctx.metadata,
                settings=ctx.metadata.get_settings(),
                analysis_locked=is_analysis_locked(),
                autopilot_running=is_autopilot_running(),
                completed_total=completed_total,
                has_more_completed=completed_total > COMPLETED_PAGE_SIZE,
                completed_by_project=completed_by_project,
                unread_counts=unread_counts,
            )
    return await run_in_thread(_do)


@app.get("/api/events")
async def event_stream() -> StreamingResponse:
    """SSE endpoint — streams real-time events from the event bus."""
    return StreamingResponse(
        bus.sse_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/events/recent")
async def recent_events(limit: int = 50) -> list[dict]:
    """Return recent events from the bus ring buffer (for debugging)."""
    return bus.recent_events(limit=min(limit, 200))


@app.get("/api/events/status")
async def event_bus_status() -> dict:
    """Return event bus status (subscriber count, recent event count)."""
    return {
        "subscribers": bus.subscriber_count,
        "recent_events": len(bus._recent),
    }


# Serve frontend static files (built Vite output)
STATIC_DIR = Path(__file__).resolve().parent / "static"
if STATIC_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
