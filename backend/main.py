"""FastAPI application for Claude Todos."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

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
    autopilot_continue,
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
from .storage import StorageContext

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)


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
                        t.run_output = (recovery_header + output_text)[:500000] if output_text else t.run_output
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

    # After cleanup, try autopilot continuation for all projects with quota
    with StorageContext(read_only=True) as ctx:
        project_ids = [p.id for p in ctx.store.projects if p.auto_run_quota > 0]
    for pid in project_ids:
        autopilot_continue(pid)


@asynccontextmanager
async def lifespan(app: FastAPI):
    _cleanup_stale_runs()
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


@app.get("/api/state")
def full_state() -> FullState:
    with StorageContext(read_only=True) as ctx:
        return FullState(
            projects=ctx.store.projects,
            todos=ctx.store.todos,
            metadata=ctx.metadata,
            settings=ctx.metadata.get_settings(),
            analysis_locked=is_analysis_locked(),
            autopilot_running=is_autopilot_running(),
        )


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
def recent_events(limit: int = 50) -> list[dict]:
    """Return recent events from the bus ring buffer (for debugging)."""
    return bus.recent_events(limit=min(limit, 200))


@app.get("/api/events/status")
def event_bus_status() -> dict:
    """Return event bus status (subscriber count, recent event count)."""
    return {
        "subscribers": bus.subscriber_count,
        "recent_events": len(bus._recent),
    }


# Serve frontend static files (built Vite output)
STATIC_DIR = Path(__file__).resolve().parent / "static"
if STATIC_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
