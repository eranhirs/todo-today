"""E2E integration tests for command proxy → Claude CLI round-trip.

Unlike test_command_proxy.py which covers dispatch logic and API flag-setting,
these tests verify that the full pipeline actually invokes the Claude CLI binary
with correct arguments and that output flows back to todo state.

Uses a fake `claude` shell script on PATH that logs invocation args + stdin
and emits valid stream-json output.
"""

from __future__ import annotations

import json
import os
import stat
import textwrap

import pytest

from backend.storage import StorageContext


# ── Fake CLI fixture ─────────────────────────────────────────────


@pytest.fixture
def fake_claude_cli(tmp_path, monkeypatch):
    """Install a fake `claude` script on PATH that logs args/stdin and emits stream-json.

    Returns a dict with:
      - log_file: Path to the file where args + stdin are logged
      - assistant_text: The text the fake CLI will emit as assistant output
    """
    log_file = tmp_path / "claude_invocation.log"
    assistant_text = "Done! I committed the changes."

    # Build the stream-json output the fake script will emit
    assistant_msg = json.dumps({
        "type": "assistant",
        "message": {
            "content": [{"type": "text", "text": assistant_text}],
        },
    })
    result_msg = json.dumps({
        "type": "result",
        "result": assistant_text,
        "is_error": False,
        "session_id": "fake-session",
    })

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    script = bin_dir / "claude"
    script.write_text(textwrap.dedent(f"""\
        #!/usr/bin/env bash
        # Log arguments and stdin for test assertions
        echo "ARGS: $@" > "{log_file}"
        echo "STDIN: $(cat)" >> "{log_file}"
        # Emit valid stream-json
        echo '{assistant_msg}'
        echo '{result_msg}'
    """))
    script.chmod(script.stat().st_mode | stat.S_IEXEC)

    # Prepend our bin dir to PATH so subprocess.Popen finds the fake claude
    monkeypatch.setenv("PATH", f"{bin_dir}:{os.environ.get('PATH', '')}")

    return {"log_file": log_file, "assistant_text": assistant_text}


@pytest.fixture
def fake_claude_cli_fail(tmp_path, monkeypatch):
    """Install a fake `claude` script that exits with code 1."""
    log_file = tmp_path / "claude_invocation.log"

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    script = bin_dir / "claude"
    script.write_text(textwrap.dedent(f"""\
        #!/usr/bin/env bash
        echo "ARGS: $@" > "{log_file}"
        echo "STDIN: $(cat)" >> "{log_file}"
        echo '{{"type":"assistant","message":{{"content":[{{"type":"text","text":"error occurred"}}]}}}}' >&1
        exit 1
    """))
    script.chmod(script.stat().st_mode | stat.S_IEXEC)

    monkeypatch.setenv("PATH", f"{bin_dir}:{os.environ.get('PATH', '')}")
    return {"log_file": log_file}


# ── Helpers ──────────────────────────────────────────────────────


def _seed_todo(tmp_path, todo_id: str, text: str, project_id: str = "proj_e2e"):
    """Seed storage with a project and a single todo ready to run."""
    from backend.models import Metadata, Project, Todo, TodoStore, _now
    from backend.storage import save_metadata, save_store

    project = Project(id=project_id, name="E2E Test", source_path=str(tmp_path))
    todo = Todo(
        id=todo_id,
        project_id=project_id,
        text=text,
        status="in_progress",
        source="user",
        run_status="running",
    )
    save_store(TodoStore(projects=[project], todos=[todo]))
    save_metadata(Metadata())


def _read_todo(todo_id: str):
    """Read a todo from storage by ID."""
    with StorageContext(read_only=True) as ctx:
        for t in ctx.store.todos:
            if t.id == todo_id:
                return t
    return None


# ── E2E Tests ────────────────────────────────────────────────────


class TestCommandProxyE2E:
    """Verify the full command proxy → Claude CLI → output parsing round-trip."""

    def test_proxy_command_invokes_cli_with_correct_prompt(self, tmp_path, fake_claude_cli):
        """A /command todo sends the proxy prompt to `claude -p` and completes."""
        from backend.run_manager import _run_claude_for_todo

        todo_id = "todo_e2e_proxy"
        _seed_todo(tmp_path, todo_id, "/commit Fix deploy")

        # Run synchronously (this is normally the thread target)
        _run_claude_for_todo(todo_id, "/commit Fix deploy", str(tmp_path), model="sonnet")

        # Verify CLI was invoked with correct arguments
        log_content = fake_claude_cli["log_file"].read_text()
        assert "ARGS:" in log_content
        assert "-p" in log_content
        assert "--output-format" in log_content
        assert "stream-json" in log_content
        assert "--model" in log_content
        assert "sonnet" in log_content

        # Verify the proxy prompt was sent via stdin (not the raw todo text)
        assert "STDIN: /commit Fix deploy" in log_content

        # Verify todo state was updated
        todo = _read_todo(todo_id)
        assert todo is not None
        assert todo.run_status == "done"
        assert todo.status == "completed"
        assert fake_claude_cli["assistant_text"] in todo.run_output

    def test_default_todo_gets_implement_prompt(self, tmp_path, fake_claude_cli):
        """A plain todo (no slash command) sends the 'Implement this task' wrapper prompt."""
        from backend.run_manager import _run_claude_for_todo

        todo_id = "todo_e2e_default"
        todo_text = "Add unit tests for auth module"
        _seed_todo(tmp_path, todo_id, todo_text)

        _run_claude_for_todo(todo_id, todo_text, str(tmp_path), model="sonnet")

        log_content = fake_claude_cli["log_file"].read_text()
        # Should get the "Implement this task fully" wrapper, not raw text
        assert "STDIN: Implement this task fully" in log_content
        assert todo_text in log_content

        todo = _read_todo(todo_id)
        assert todo.run_status == "done"
        assert todo.status == "completed"

    def test_cli_failure_sets_error_status(self, tmp_path, fake_claude_cli_fail):
        """When the CLI exits non-zero, the todo should be marked as error."""
        from backend.run_manager import _run_claude_for_todo

        todo_id = "todo_e2e_fail"
        _seed_todo(tmp_path, todo_id, "/commit broken thing")

        _run_claude_for_todo(todo_id, "/commit broken thing", str(tmp_path), model="sonnet")

        todo = _read_todo(todo_id)
        assert todo is not None
        assert todo.run_status == "error"

    def test_proxy_strips_command_from_remaining_text(self, tmp_path, fake_claude_cli):
        """Proxy prompt should be '/command remaining_text', not the raw todo text."""
        from backend.run_manager import _run_claude_for_todo

        todo_id = "todo_e2e_strip"
        todo_text = "Please review this /review-pr carefully"
        _seed_todo(tmp_path, todo_id, todo_text)

        _run_claude_for_todo(todo_id, todo_text, str(tmp_path), model="sonnet")

        log_content = fake_claude_cli["log_file"].read_text()
        # resolve_execution("Please review this /review-pr carefully")
        # → ("proxy", "/review-pr Please review this carefully")
        assert "STDIN: /review-pr Please review this carefully" in log_content

    def test_session_id_passed_to_cli(self, tmp_path, fake_claude_cli):
        """Verify --session-id is passed so runs are resumable."""
        from backend.run_manager import _run_claude_for_todo

        todo_id = "todo_e2e_session"
        _seed_todo(tmp_path, todo_id, "/commit stuff")

        _run_claude_for_todo(todo_id, "/commit stuff", str(tmp_path), model="sonnet")

        log_content = fake_claude_cli["log_file"].read_text()
        assert "--session-id" in log_content

    def test_disallowed_tools_passed_to_cli(self, tmp_path, fake_claude_cli):
        """Verify --disallowedTools is passed (at minimum AskUserQuestion)."""
        from backend.run_manager import _run_claude_for_todo

        todo_id = "todo_e2e_disallowed"
        _seed_todo(tmp_path, todo_id, "/commit stuff")

        _run_claude_for_todo(todo_id, "/commit stuff", str(tmp_path), model="sonnet")

        log_content = fake_claude_cli["log_file"].read_text()
        assert "--disallowedTools" in log_content
        assert "AskUserQuestion" in log_content
