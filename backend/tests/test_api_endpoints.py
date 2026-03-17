"""Tests for API endpoints (projects, todos, state)."""

from __future__ import annotations

from unittest.mock import patch

import pytest


# ── Projects API ──────────────────────────────────────────────


class TestProjectsAPI:
    def test_list_projects(self, client):
        resp = client.get("/api/projects")
        assert resp.status_code == 200
        projects = resp.json()
        assert len(projects) == 1
        assert projects[0]["id"] == "proj_aaa"

    def test_create_project(self, client):
        resp = client.post("/api/projects", json={"name": "New Proj", "source_path": "/tmp/new"})
        assert resp.status_code == 201
        data = resp.json()
        assert data["name"] == "New Proj"
        assert data["source_path"] == "/tmp/new"
        assert data["id"].startswith("proj_")

    def test_get_project(self, client):
        resp = client.get("/api/projects/proj_aaa")
        assert resp.status_code == 200
        assert resp.json()["name"] == "My Project"

    def test_get_project_not_found(self, client):
        resp = client.get("/api/projects/proj_nonexistent")
        assert resp.status_code == 404

    def test_update_project(self, client):
        resp = client.put("/api/projects/proj_aaa", json={"name": "Renamed"})
        assert resp.status_code == 200
        assert resp.json()["name"] == "Renamed"

    def test_update_project_auto_run_quota_clamped(self, client):
        resp = client.put("/api/projects/proj_aaa", json={"auto_run_quota": 99})
        assert resp.status_code == 200
        assert resp.json()["auto_run_quota"] == 50  # clamped to max

    def test_delete_project(self, client):
        resp = client.delete("/api/projects/proj_aaa")
        assert resp.status_code == 204

        # Verify deleted
        resp = client.get("/api/projects/proj_aaa")
        assert resp.status_code == 404

        # Todos for that project should also be deleted
        resp = client.get("/api/todos")
        assert resp.status_code == 200
        assert resp.json() == []

    def test_delete_project_not_found(self, client):
        resp = client.delete("/api/projects/proj_nonexistent")
        assert resp.status_code == 404


# ── Todos API ─────────────────────────────────────────────────


class TestTodosAPI:
    def test_list_todos(self, client):
        resp = client.get("/api/todos")
        assert resp.status_code == 200
        assert len(resp.json()) == 3

    def test_list_todos_filter_by_project(self, client):
        resp = client.get("/api/todos?project_id=proj_aaa")
        assert resp.status_code == 200
        assert len(resp.json()) == 3

        resp = client.get("/api/todos?project_id=proj_nonexistent")
        assert resp.status_code == 200
        assert resp.json() == []

    def test_create_todo(self, client):
        resp = client.post("/api/todos", json={"project_id": "proj_aaa", "text": "New todo"})
        assert resp.status_code == 201
        data = resp.json()
        assert data["text"] == "New todo"
        assert data["source"] == "user"
        assert data["status"] == "next"

    def test_create_todo_invalid_project(self, client):
        resp = client.post("/api/todos", json={"project_id": "proj_bad", "text": "X"})
        assert resp.status_code == 404

    def test_create_todo_with_completed_status(self, client):
        resp = client.post("/api/todos", json={"project_id": "proj_aaa", "text": "Done", "status": "completed"})
        assert resp.status_code == 201
        data = resp.json()
        assert data["status"] == "completed"
        assert data["completed_at"] is not None

    def test_get_todo(self, client):
        resp = client.get("/api/todos/todo_1")
        assert resp.status_code == 200
        assert resp.json()["text"] == "Fix bug"

    def test_get_todo_not_found(self, client):
        resp = client.get("/api/todos/todo_nonexistent")
        assert resp.status_code == 404

    def test_update_todo_text(self, client):
        resp = client.put("/api/todos/todo_1", json={"text": "Updated text"})
        assert resp.status_code == 200
        assert resp.json()["text"] == "Updated text"

    def test_update_todo_status_to_completed(self, client):
        resp = client.put("/api/todos/todo_1", json={"status": "completed"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "completed"
        assert data["completed_at"] is not None

    def test_update_todo_uncomplete(self, client):
        # First complete
        client.put("/api/todos/todo_1", json={"status": "completed"})
        # Then uncomplete
        resp = client.put("/api/todos/todo_1", json={"status": "next"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "next"
        assert data["completed_at"] is None

    def test_update_todo_reject(self, client):
        resp = client.put("/api/todos/todo_1", json={"status": "rejected"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "rejected"
        assert data["rejected_at"] is not None

    def test_update_todo_not_found(self, client):
        resp = client.put("/api/todos/todo_nonexistent", json={"text": "X"})
        assert resp.status_code == 404

    def test_delete_todo(self, client):
        resp = client.delete("/api/todos/todo_1")
        assert resp.status_code == 204

        resp = client.get("/api/todos/todo_1")
        assert resp.status_code == 404

    def test_delete_todo_not_found(self, client):
        resp = client.delete("/api/todos/todo_nonexistent")
        assert resp.status_code == 404

    def test_reorder_todos(self, client):
        resp = client.put(
            "/api/todos/reorder",
            json={"todo_ids": ["todo_3", "todo_1", "todo_2"], "moved_id": "todo_3"},
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"

        # Verify sort_order
        resp = client.get("/api/todos/todo_3")
        assert resp.json()["sort_order"] == 0
        assert resp.json()["user_ordered"] is True

        resp = client.get("/api/todos/todo_1")
        assert resp.json()["sort_order"] == 1

    def test_reorder_without_moved_id(self, client):
        resp = client.put(
            "/api/todos/reorder",
            json={"todo_ids": ["todo_2", "todo_1"]},
        )
        assert resp.status_code == 200


# ── Todo Run endpoints ────────────────────────────────────────


class TestTodoRunAPI:
    @patch("backend.run_manager._run_claude_for_todo")
    def test_run_todo(self, mock_run, client):
        resp = client.post("/api/todos/todo_1/run")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "started" or data["status"] == "queued"

    def test_run_todo_not_found(self, client):
        resp = client.post("/api/todos/todo_nonexistent/run")
        assert resp.status_code == 404

    def test_stop_todo_not_running(self, client):
        resp = client.post("/api/todos/todo_1/stop")
        assert resp.status_code == 409

    def test_stop_todo_not_found(self, client):
        resp = client.post("/api/todos/todo_nonexistent/stop")
        assert resp.status_code == 404

    def test_dequeue_not_queued(self, client):
        resp = client.post("/api/todos/todo_1/dequeue")
        assert resp.status_code == 409


# ── Full state endpoint ───────────────────────────────────────


class TestFullStateAPI:
    def test_full_state(self, client):
        resp = client.get("/api/state")
        assert resp.status_code == 200
        data = resp.json()
        assert "projects" in data
        assert "todos" in data
        assert "metadata" in data
        assert "analysis_locked" in data
        assert "autopilot_running" in data
        assert len(data["projects"]) == 1
        assert len(data["todos"]) == 3


# ── Todo followup endpoint ────────────────────────────────────


class TestTodoFollowupAPI:
    def test_followup_not_found(self, client):
        resp = client.post("/api/todos/todo_nonexistent/followup", json={"message": "hi"})
        assert resp.status_code == 404
