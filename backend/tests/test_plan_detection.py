"""Tests for plan file detection, suppress_error logic, and follow-up plan_only preservation."""

from __future__ import annotations

import os
import tempfile
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from backend.models import Metadata, Project, Todo, TodoStore, _now
from backend.run_manager import _detect_plan_file, _detect_plan_mode, _finalize_run
from backend.storage import save_metadata, save_store


def _seed(todos: list[Todo] | None = None, projects: list[Project] | None = None):
    proj = Project(id="proj_plan", name="PlanTest", source_path="/tmp/plantest")
    save_store(TodoStore(projects=projects or [proj], todos=todos or []))
    save_metadata(Metadata())


@pytest.fixture(autouse=True)
def _clear_running_tasks():
    from backend.run_manager import process_manager
    original = process_manager._running_tasks.copy()
    process_manager._running_tasks.clear()
    yield
    process_manager._running_tasks.clear()
    process_manager._running_tasks.update(original)


# ── Helper: build stream objects ──────────────────────────────────

def _write_tool_use(file_path: str) -> dict:
    """Build a stream object with a Write tool_use targeting file_path."""
    return {
        "type": "assistant",
        "message": {
            "content": [
                {
                    "type": "tool_use",
                    "name": "Write",
                    "input": {"file_path": file_path},
                }
            ]
        },
    }


def _tool_use(name: str) -> dict:
    """Build a stream object with a generic tool_use."""
    return {
        "type": "assistant",
        "message": {
            "content": [
                {
                    "type": "tool_use",
                    "name": name,
                    "input": {},
                }
            ]
        },
    }


# ═══════════════════════════════════════════════════════════════════
# 1. _detect_plan_file — stream-object detection + filesystem fallback
# ═══════════════════════════════════════════════════════════════════

class TestDetectPlanFileStream:
    """Primary detection: scan stream objects for Write to plans/."""

    def test_detects_plan_write(self):
        objs = [_write_tool_use("/home/user/proj/plans/my-plan.md")]
        result = _detect_plan_file(objs)
        assert result == "/home/user/proj/plans/my-plan.md"

    def test_returns_none_when_no_plan(self):
        objs = [_write_tool_use("/home/user/proj/src/main.py")]
        assert _detect_plan_file(objs) is None

    def test_empty_stream(self):
        assert _detect_plan_file([]) is None

    def test_ignores_non_assistant_types(self):
        obj = {
            "type": "tool_result",
            "message": {
                "content": [
                    {"type": "tool_use", "name": "Write", "input": {"file_path": "/x/plans/p.md"}}
                ]
            },
        }
        assert _detect_plan_file([obj]) is None

    def test_first_plan_wins(self):
        objs = [
            _write_tool_use("/proj/plans/first.md"),
            _write_tool_use("/proj/plans/second.md"),
        ]
        assert _detect_plan_file(objs) == "/proj/plans/first.md"


class TestDetectPlanFileFilesystemFallback:
    """Fallback: scan filesystem when stream-object detection finds nothing."""

    def test_finds_recently_modified_plan(self, tmp_path):
        plans_dir = tmp_path / "plans"
        plans_dir.mkdir(parents=True)

        plan_file = plans_dir / "new-plan.md"
        plan_file.write_text("# Plan")

        # Use a cutoff before the file was created
        cutoff = (datetime.now() - timedelta(seconds=10)).isoformat()

        result = _detect_plan_file([], source_path=str(tmp_path), run_started_at=cutoff)
        assert result == str(plan_file)

    def test_picks_most_recent_file(self, tmp_path):
        plans_dir = tmp_path / "plans"
        plans_dir.mkdir(parents=True)

        old = plans_dir / "old.md"
        old.write_text("old")
        # Set mtime to 60s ago
        old_time = time.time() - 60
        os.utime(old, (old_time, old_time))

        new = plans_dir / "new.md"
        new.write_text("new")

        cutoff = (datetime.now() - timedelta(seconds=120)).isoformat()
        result = _detect_plan_file([], source_path=str(tmp_path), run_started_at=cutoff)
        assert result == str(new)

    def test_ignores_files_before_cutoff(self, tmp_path):
        plans_dir = tmp_path / "plans"
        plans_dir.mkdir(parents=True)

        old = plans_dir / "old.md"
        old.write_text("old")
        old_time = time.time() - 3600
        os.utime(old, (old_time, old_time))

        # Cutoff is 10s ago — the file is from an hour ago
        cutoff = (datetime.now() - timedelta(seconds=10)).isoformat()
        result = _detect_plan_file([], source_path=str(tmp_path), run_started_at=cutoff)
        assert result is None

    def test_no_plans_dir(self, tmp_path):
        cutoff = datetime.now().isoformat()
        result = _detect_plan_file([], source_path=str(tmp_path), run_started_at=cutoff)
        assert result is None

    def test_no_source_path_skips_fallback(self, tmp_path):
        # Even if plans exist, no source_path means no fallback
        plans_dir = tmp_path / "plans"
        plans_dir.mkdir(parents=True)
        (plans_dir / "plan.md").write_text("plan")

        result = _detect_plan_file([], source_path="", run_started_at=datetime.now().isoformat())
        assert result is None

    def test_no_run_started_at_skips_fallback(self, tmp_path):
        plans_dir = tmp_path / "plans"
        plans_dir.mkdir(parents=True)
        (plans_dir / "plan.md").write_text("plan")

        result = _detect_plan_file([], source_path=str(tmp_path), run_started_at=None)
        assert result is None

    def test_invalid_run_started_at(self, tmp_path):
        plans_dir = tmp_path / "plans"
        plans_dir.mkdir(parents=True)
        (plans_dir / "plan.md").write_text("plan")

        result = _detect_plan_file([], source_path=str(tmp_path), run_started_at="not-a-date")
        assert result is None

    def test_stream_detection_takes_priority(self, tmp_path):
        """If stream objects contain a plan Write, filesystem fallback is skipped."""
        plans_dir = tmp_path / "plans"
        plans_dir.mkdir(parents=True)
        (plans_dir / "fs-plan.md").write_text("filesystem plan")

        stream_path = str(tmp_path / "plans" / "stream-plan.md")
        objs = [_write_tool_use(stream_path)]
        cutoff = (datetime.now() - timedelta(seconds=60)).isoformat()

        result = _detect_plan_file(objs, source_path=str(tmp_path), run_started_at=cutoff)
        assert result == stream_path

    def test_ignores_subdirectories(self, tmp_path):
        plans_dir = tmp_path / "plans"
        plans_dir.mkdir(parents=True)
        subdir = plans_dir / "subdir"
        subdir.mkdir()

        cutoff = (datetime.now() - timedelta(seconds=10)).isoformat()
        result = _detect_plan_file([], source_path=str(tmp_path), run_started_at=cutoff)
        assert result is None


# ═══════════════════════════════════════════════════════════════════
# 2. plan_only suppress_error when EnterPlanMode detected
# ═══════════════════════════════════════════════════════════════════

class TestDetectPlanMode:
    def test_detects_enter_plan_mode(self):
        objs = [_tool_use("EnterPlanMode")]
        assert _detect_plan_mode(objs) is True

    def test_no_plan_mode(self):
        objs = [_tool_use("Write"), _tool_use("Bash")]
        assert _detect_plan_mode(objs) is False

    def test_empty_stream(self):
        assert _detect_plan_mode([]) is False


class TestFinalizeRunSuppressError:
    """_finalize_run should suppress errors for plan_only runs when plan file or EnterPlanMode detected."""

    def _make_todo(self, todo_id: str = "todo_fin", plan_only: bool = False) -> Todo:
        todo = Todo(
            id=todo_id, project_id="proj_plan", text="Plan task",
            status="in_progress", run_status="running", plan_only=plan_only,
        )
        _seed(todos=[todo])
        return todo

    @patch("backend.run_manager.process_manager")
    @patch("backend.run_manager.bus")
    def test_plan_only_with_plan_file_suppresses_error(self, mock_bus, mock_pm):
        """plan_only=True + plan file detected → non-zero exit treated as success."""
        self._make_todo(plan_only=True)
        stream_objs = [_write_tool_use("/proj/plans/plan.md")]

        _finalize_run(
            "todo_fin", final_result=None, returncode=1,
            accumulated=["some output"], session_header="",
            output_file=Path("/tmp/fake_output"),
            plan_only=True, stream_objects=stream_objs,
        )

        from backend.storage import load_store
        store = load_store()
        t = next(t for t in store.todos if t.id == "todo_fin")
        # Should be completed, not error
        assert t.run_status == "done"
        assert t.status == "completed"
        assert t.plan_file == "/proj/plans/plan.md"

    @patch("backend.run_manager.process_manager")
    @patch("backend.run_manager.bus")
    def test_plan_only_with_enter_plan_mode_suppresses_error(self, mock_bus, mock_pm):
        """plan_only=True + EnterPlanMode detected → non-zero exit treated as success."""
        self._make_todo(plan_only=True)
        stream_objs = [_tool_use("EnterPlanMode")]

        _finalize_run(
            "todo_fin", final_result=None, returncode=1,
            accumulated=["plan output"], session_header="",
            output_file=Path("/tmp/fake_output"),
            plan_only=True, stream_objects=stream_objs,
        )

        from backend.storage import load_store
        store = load_store()
        t = next(t for t in store.todos if t.id == "todo_fin")
        assert t.run_status == "done"
        assert t.status == "completed"

    @patch("backend.run_manager.process_manager")
    @patch("backend.run_manager.bus")
    def test_plan_only_without_plan_signal_does_not_suppress(self, mock_bus, mock_pm):
        """plan_only=True but no plan file or EnterPlanMode → error is NOT suppressed."""
        self._make_todo(plan_only=True)

        _finalize_run(
            "todo_fin", final_result=None, returncode=1,
            accumulated=["failed output"], session_header="",
            output_file=Path("/tmp/fake_output"),
            plan_only=True, stream_objects=[],
        )

        from backend.storage import load_store
        store = load_store()
        t = next(t for t in store.todos if t.id == "todo_fin")
        assert t.run_status == "error"

    @patch("backend.run_manager.process_manager")
    @patch("backend.run_manager.bus")
    def test_non_plan_only_with_plan_file_does_not_suppress(self, mock_bus, mock_pm):
        """plan_only=False + plan file → error is NOT suppressed (suppress requires plan_only)."""
        self._make_todo(plan_only=False)
        stream_objs = [_write_tool_use("/proj/plans/plan.md")]

        _finalize_run(
            "todo_fin", final_result=None, returncode=1,
            accumulated=["output"], session_header="",
            output_file=Path("/tmp/fake_output"),
            plan_only=False, stream_objects=stream_objs,
        )

        from backend.storage import load_store
        store = load_store()
        t = next(t for t in store.todos if t.id == "todo_fin")
        assert t.run_status == "error"
        # Plan file should still be saved even on error
        assert t.plan_file == "/proj/plans/plan.md"

    @patch("backend.run_manager.process_manager")
    @patch("backend.run_manager.bus")
    def test_plan_only_success_still_completes(self, mock_bus, mock_pm):
        """plan_only=True + returncode=0 → completes normally."""
        self._make_todo(plan_only=True)

        _finalize_run(
            "todo_fin", final_result=None, returncode=0,
            accumulated=["plan done"], session_header="",
            output_file=Path("/tmp/fake_output"),
            plan_only=True, stream_objects=[],
        )

        from backend.storage import load_store
        store = load_store()
        t = next(t for t in store.todos if t.id == "todo_fin")
        assert t.run_status == "done"
        assert t.status == "completed"
        assert t.completed_by_run is True

    @patch("backend.run_manager.process_manager")
    @patch("backend.run_manager.bus")
    def test_suppress_error_also_skips_is_error_check(self, mock_bus, mock_pm):
        """When suppress_error is True, final_result.is_error is also ignored."""
        self._make_todo(plan_only=True)
        stream_objs = [_write_tool_use("/proj/plans/plan.md")]

        _finalize_run(
            "todo_fin",
            final_result={"is_error": True, "result": "permission denied"},
            returncode=0,
            accumulated=["output"], session_header="",
            output_file=Path("/tmp/fake_output"),
            plan_only=True, stream_objects=stream_objs,
        )

        from backend.storage import load_store
        store = load_store()
        t = next(t for t in store.todos if t.id == "todo_fin")
        # suppress_error skips the is_error/permission_denials block too
        assert t.run_status == "done"
        assert t.status == "completed"


# ═══════════════════════════════════════════════════════════════════
# 3. Follow-up plan_only preservation
# ═══════════════════════════════════════════════════════════════════

class TestFollowupPlanOnlyPreservation:
    """Verify that plan_only is preserved through follow-up queuing and execution."""

    def test_pending_followup_plan_only_stored(self):
        """When a follow-up is queued on a running plan_only todo, plan_only is preserved."""
        todo = Todo(
            id="todo_fpo", project_id="proj_plan", text="Plan task",
            status="in_progress", run_status="running",
            plan_only=True, session_id="sess_1",
            pending_followup="continue",
            pending_followup_plan_only=True,
        )
        _seed(todos=[todo])

        from backend.storage import load_store
        store = load_store()
        t = next(t for t in store.todos if t.id == "todo_fpo")
        assert t.pending_followup_plan_only is True

    @patch("backend.run_manager._followup_claude_for_todo")
    def test_start_pending_followup_passes_plan_only(self, mock_followup):
        """_start_pending_followup extracts and passes plan_only to _followup_claude_for_todo."""
        from backend.run_manager import _start_pending_followup

        todo = Todo(
            id="todo_spf", project_id="proj_plan", text="Plan task",
            status="in_progress", run_status="done",
            plan_only=True, session_id="sess_abc",
            pending_followup="please continue the plan",
            pending_followup_plan_only=True,
        )
        _seed(todos=[todo])

        result = _start_pending_followup("todo_spf", "/tmp/plantest", "opus", "proj_plan")
        assert result is True

        from backend.run_manager import process_manager
        # Wait for the spawned thread
        if "todo_spf" in process_manager._running_tasks:
            process_manager._running_tasks["todo_spf"].join(timeout=5)

        mock_followup.assert_called_once()
        args = mock_followup.call_args[0]
        # _followup_claude_for_todo(todo_id, message, session_id, source_path, model, project_id, images, plan_only)
        assert args[0] == "todo_spf"
        assert args[1] == "please continue the plan"
        assert args[2] == "sess_abc"
        assert args[7] is True  # plan_only

    @patch("backend.run_manager._followup_claude_for_todo")
    def test_start_pending_followup_false_plan_only(self, mock_followup):
        """When pending_followup_plan_only is False, it passes False."""
        from backend.run_manager import _start_pending_followup

        todo = Todo(
            id="todo_spf2", project_id="proj_plan", text="Impl task",
            status="in_progress", run_status="done",
            plan_only=False, session_id="sess_def",
            pending_followup="now implement it",
            pending_followup_plan_only=False,
        )
        _seed(todos=[todo])

        result = _start_pending_followup("todo_spf2", "/tmp/plantest", "opus", "proj_plan")
        assert result is True

        from backend.run_manager import process_manager
        if "todo_spf2" in process_manager._running_tasks:
            process_manager._running_tasks["todo_spf2"].join(timeout=5)

        mock_followup.assert_called_once()
        args = mock_followup.call_args[0]
        assert args[7] is False  # plan_only

    @patch("backend.run_manager._followup_claude_for_todo")
    def test_start_pending_followup_clears_pending_fields(self, mock_followup):
        """After starting, pending_followup fields are cleared in storage."""
        from backend.run_manager import _start_pending_followup

        todo = Todo(
            id="todo_clr", project_id="proj_plan", text="Plan",
            status="in_progress", run_status="done",
            plan_only=True, session_id="sess_clr",
            pending_followup="msg",
            pending_followup_plan_only=True,
            pending_followup_images=["img.png"],
        )
        _seed(todos=[todo])

        _start_pending_followup("todo_clr", "/tmp/plantest", "opus", "proj_plan")

        from backend.run_manager import process_manager
        if "todo_clr" in process_manager._running_tasks:
            process_manager._running_tasks["todo_clr"].join(timeout=5)

        from backend.storage import load_store
        store = load_store()
        t = next(t for t in store.todos if t.id == "todo_clr")
        assert t.pending_followup is None
        assert t.pending_followup_plan_only is False
        assert t.pending_followup_images == []

    def test_start_pending_followup_no_pending(self):
        """Returns False when no pending follow-up exists."""
        from backend.run_manager import _start_pending_followup

        todo = Todo(
            id="todo_nop", project_id="proj_plan", text="Done",
            status="completed", run_status="done",
            session_id="sess_nop",
        )
        _seed(todos=[todo])

        result = _start_pending_followup("todo_nop", "/tmp/plantest", "opus", "proj_plan")
        assert result is False

    @patch("backend.run_manager._followup_claude_for_todo")
    def test_process_queue_preserves_followup_plan_only(self, mock_followup):
        """_process_queue passes plan_only from pending_followup_plan_only."""
        from backend.run_manager import _process_queue, process_manager

        todo = Todo(
            id="todo_qpo", project_id="proj_plan", text="Queued plan followup",
            run_status="queued", queued_at=_now(),
            pending_followup="continue plan",
            pending_followup_plan_only=True,
            session_id="sess_qpo",
        )
        _seed(todos=[todo])

        _process_queue("proj_plan")

        assert "todo_qpo" in process_manager._running_tasks
        process_manager._running_tasks["todo_qpo"].join(timeout=5)

        mock_followup.assert_called_once()
        args = mock_followup.call_args[0]
        assert args[0] == "todo_qpo"
        assert args[1] == "continue plan"
        assert args[7] is True  # plan_only preserved
