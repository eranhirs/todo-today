"""FastAPI application for Claude Todos."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .models import FullState
from .routers import claude, projects, todos
from .scheduler import start_scheduler, stop_scheduler
from .storage import StorageContext

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")


def _cleanup_stale_runs() -> None:
    """Reset any todos stuck in run_status='running' from a previous server lifetime."""
    with StorageContext() as ctx:
        for t in ctx.store.todos:
            if t.run_status == "running":
                t.run_status = "error"
                t.run_output = (t.run_output or "") + "\n[Server restarted — run was interrupted]"
                if t.status == "in_progress":
                    t.status = "next"
                logging.getLogger(__name__).info("Reset stale running todo %s", t.id)


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
        )


# Serve frontend static files (built Vite output)
STATIC_DIR = Path(__file__).resolve().parent / "static"
if STATIC_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
