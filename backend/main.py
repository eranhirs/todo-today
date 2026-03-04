"""FastAPI application for Todo Today."""

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


@asynccontextmanager
async def lifespan(app: FastAPI):
    start_scheduler()
    yield
    stop_scheduler()


app = FastAPI(title="Todo Today", lifespan=lifespan)

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
    with StorageContext() as ctx:
        return FullState(
            projects=ctx.store.projects,
            todos=ctx.store.todos,
            metadata=ctx.metadata,
        )


# Serve frontend static files (built Vite output)
STATIC_DIR = Path(__file__).resolve().parent / "static"
if STATIC_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
