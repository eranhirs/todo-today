"""Tests for the generic command proxy system.

Verifies that:
- Any /command is proxied to Claude CLI (not just registered ones)
- /manual remains noop (special behavior)
- is_command flag is set correctly on todos via the API
- resolve_execution returns correct strategies
"""

from __future__ import annotations

import pytest

from backend.command_registry import (
    get_command,
    has_slash_command,
    resolve_execution,
)


# ── resolve_execution unit tests ─────────────────────────────


class TestResolveExecution:
    def test_manual_returns_noop(self):
        strategy, prompt = resolve_execution("Do this /manual")
        assert strategy == "noop"
        assert prompt == ""

    def test_known_command_proxied(self):
        """Previously hard-coded commands like /commit still work via generic proxy."""
        strategy, prompt = resolve_execution("Fix deploy /commit")
        assert strategy == "proxy"
        assert prompt == "/commit Fix deploy"

    def test_checkpoint_proxied(self):
        strategy, prompt = resolve_execution("/checkpoint")
        assert strategy == "proxy"
        assert prompt == "/checkpoint"

    def test_unknown_command_proxied(self):
        """Any /word should be proxied, even if never registered."""
        strategy, prompt = resolve_execution("Do something /some-future-command")
        assert strategy == "proxy"
        assert prompt == "/some-future-command Do something"

    def test_unknown_command_no_extra_text(self):
        strategy, prompt = resolve_execution("/brand-new-feature")
        assert strategy == "proxy"
        assert prompt == "/brand-new-feature"

    def test_no_command_returns_default(self):
        strategy, prompt = resolve_execution("Just a plain todo")
        assert strategy == "default"
        assert prompt == ""

    def test_first_command_wins(self):
        """When multiple commands are present, the first one is used."""
        strategy, prompt = resolve_execution("/commit /checkpoint")
        assert strategy == "proxy"
        # /commit is first, rest is "/checkpoint"
        assert prompt == "/commit /checkpoint"

    def test_command_with_surrounding_text(self):
        strategy, prompt = resolve_execution("Before /review-pr after stuff")
        assert strategy == "proxy"
        assert prompt == "/review-pr Before after stuff"

    def test_manual_takes_precedence_when_first(self):
        """If /manual appears first, it's noop regardless of other commands."""
        strategy, prompt = resolve_execution("/manual /commit fix")
        assert strategy == "noop"

    def test_slash_in_url_not_treated_as_command(self):
        """Slash in URLs or paths should not be treated as commands."""
        # The regex requires whitespace before / (or start of string)
        strategy, prompt = resolve_execution("Check https://example.com/path")
        assert strategy == "default"

    def test_empty_text(self):
        strategy, prompt = resolve_execution("")
        assert strategy == "default"
        assert prompt == ""


# ── has_slash_command unit tests ─────────────────────────────


class TestHasSlashCommand:
    def test_has_command(self):
        assert has_slash_command("/commit fix things") is True

    def test_no_command(self):
        assert has_slash_command("just plain text") is False

    def test_command_mid_text(self):
        assert has_slash_command("do this /checkpoint now") is True

    def test_empty(self):
        assert has_slash_command("") is False


# ── get_command unit tests ───────────────────────────────────


class TestGetCommand:
    def test_manual_registered(self):
        cmd = get_command("manual")
        assert cmd is not None
        assert cmd.strategy == "noop"

    def test_unregistered_returns_none(self):
        """Unregistered commands return None (they're handled by generic proxy)."""
        assert get_command("commit") is None
        assert get_command("checkpoint") is None
        assert get_command("whatever") is None


# ── API integration tests ────────────────────────────────────


class TestCommandProxyAPI:
    def test_create_todo_with_known_command_sets_is_command(self, client):
        resp = client.post("/api/todos", json={
            "project_id": "proj_aaa",
            "text": "Fix deploy /commit",
        })
        assert resp.status_code == 201
        assert resp.json()["is_command"] is True

    def test_create_todo_with_unknown_command_sets_is_command(self, client):
        """Any /word should mark the todo as a command — generic proxy."""
        resp = client.post("/api/todos", json={
            "project_id": "proj_aaa",
            "text": "Do something /future-claude-feature",
        })
        assert resp.status_code == 201
        assert resp.json()["is_command"] is True

    def test_create_todo_with_manual_not_command(self, client):
        """/manual is noop, so is_command should be False."""
        resp = client.post("/api/todos", json={
            "project_id": "proj_aaa",
            "text": "Human task /manual",
        })
        assert resp.status_code == 201
        data = resp.json()
        assert data["is_command"] is False
        assert data["manual"] is True

    def test_create_plain_todo_not_command(self, client):
        resp = client.post("/api/todos", json={
            "project_id": "proj_aaa",
            "text": "Just a regular todo",
        })
        assert resp.status_code == 201
        assert resp.json()["is_command"] is False

    def test_update_todo_text_to_command_sets_flag(self, client):
        """Editing a todo to include a /command should update is_command."""
        resp = client.put("/api/todos/todo_1", json={
            "text": "Now with /checkpoint",
        })
        assert resp.status_code == 200
        assert resp.json()["is_command"] is True

    def test_update_todo_text_remove_command_clears_flag(self, client):
        # First add a command
        client.put("/api/todos/todo_1", json={"text": "/commit fix"})
        # Then remove it
        resp = client.put("/api/todos/todo_1", json={"text": "No command now"})
        assert resp.status_code == 200
        assert resp.json()["is_command"] is False
