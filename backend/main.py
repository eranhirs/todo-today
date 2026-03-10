"""FastAPI application for Claude Todos."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .models import FullState, _now
from .routers import claude, projects, todos
from .routers.todos import (
    _cleanup_output_file,
    _pid_alive,
    parse_output_file_result,
    reconnect_todo_run,
)
from .scheduler import is_analysis_locked, start_scheduler, stop_scheduler
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
        if run_pid and _pid_alive(run_pid):
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
                        t.run_output = (recovery_header + output_text)[:50000] if output_text else t.run_output
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
                        break
            _cleanup_output_file(Path(run_output_file))
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    _cleanup_stale_runs()
    start_scheduler()
    yield
    stop_scheduler()


app = FastAPI(title="Claude Todos", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

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
            analysis_locked=is_analysis_locked(),
        )


# Serve frontend static files (built Vite output)
STATIC_DIR = Path(__file__).resolve().parent / "static"
if STATIC_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
