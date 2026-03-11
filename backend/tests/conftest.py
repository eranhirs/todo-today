"""Shared fixtures for backend tests."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

# Point storage at a temporary directory before importing anything that touches storage
_tmp = tempfile.mkdtemp(prefix="claude_todos_test_")
os.environ["TODO_DATA_DIR"] = _tmp


from backend.models import (  # noqa: E402
    ClaudeAnalysisResult,
    ClaudeInsight,
    ClaudeNewTodo,
    ClaudeTodoStatusUpdate,
    ClaudeTodoUpdate,
    Insight,
    Metadata,
    Project,
    Todo,
    TodoStore,
    _now,
)
from backend.storage import DATA_DIR, StorageContext, _lock, save_metadata, save_store  # noqa: E402


@pytest.fixture(autouse=True)
def _clean_storage(tmp_path, monkeypatch):
    """Redirect storage to a fresh tmp_path for every test and reset the lock."""
    import backend.storage as storage_mod

    monkeypatch.setattr(storage_mod, "DATA_DIR", tmp_path)
    # Ensure lock is released if a prior test left it held
    if _lock.locked():
        _lock.release()
    yield


@pytest.fixture
def sample_project():
    return Project(id="proj_aaa", name="My Project", source_path="/tmp/myproj")


@pytest.fixture
def sample_todos(sample_project):
    return [
        Todo(id="todo_1", project_id=sample_project.id, text="Fix bug", status="next", source="claude"),
        Todo(id="todo_2", project_id=sample_project.id, text="Add tests", status="in_progress", source="user"),
        Todo(id="todo_3", project_id=sample_project.id, text="Old task", status="next", source="claude"),
    ]


@pytest.fixture
def populated_store(sample_project, sample_todos):
    """Return a TodoStore pre-populated with one project and three todos."""
    return TodoStore(projects=[sample_project], todos=list(sample_todos))


@pytest.fixture
def seed_store(populated_store):
    """Write a populated store to disk so StorageContext can load it."""
    save_store(populated_store)
    save_metadata(Metadata())


@pytest.fixture
def client(seed_store):
    """FastAPI TestClient with a minimal app (projects + todos routers only).

    Avoids importing backend.main which pulls in the scheduler and claude
    router that may have Python 3.8 runtime annotation issues.
    """
    from fastapi import FastAPI

    from backend.routers import projects, todos

    app = FastAPI()
    app.include_router(projects.router)
    app.include_router(todos.router)

    # Add /api/state for the FullState test
    from backend.models import FullState
    from backend.storage import StorageContext as SC

    @app.get("/api/state", response_model=None)
    def full_state():
        with SC(read_only=True) as ctx:
            return FullState(
                projects=ctx.store.projects,
                todos=ctx.store.todos,
                metadata=ctx.metadata,
                settings=ctx.metadata.get_settings(),
            ).model_dump()

    with TestClient(app) as c:
        yield c
