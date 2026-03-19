"""Tests for run_manager queue logic."""

from __future__ import annotations

import threading
from unittest.mock import MagicMock, patch

import pytest

from backend.models import Metadata, Project, Todo, TodoStore, _now
from backend.storage import save_metadata, save_store


# We test the public functions: start_todo_run, _process_queue, dequeue_todo_run, is_todo_running


def _seed(todos: list[Todo] | None = None, projects: list[Project] | None = None):
    """Write a store to disk for the queue functions to load."""
    proj = Project(id="proj_q", name="QueueTest", source_path="/tmp/qtest")
    store = TodoStore(
        projects=projects or [proj],
        todos=todos or [],
    )
    save_store(store)
    save_metadata(Metadata())


@pytest.fixture(autouse=True)
def _clear_running_tasks():
    """Reset the ProcessManager's _running_tasks dict between tests."""
    from backend.run_manager import process_manager
    original = process_manager._running_tasks.copy()
    process_manager._running_tasks.clear()
    yield
    process_manager._running_tasks.clear()
    process_manager._running_tasks.update(original)


class TestIsTodoRunning:
    def test_not_running_when_empty(self):
        from backend.run_manager import is_todo_running
        assert is_todo_running("todo_x") is False

    def test_running_when_alive_thread(self):
        from backend.run_manager import is_todo_running, process_manager
        t = threading.Thread(target=lambda: None)
        t.start()
        t.join()  # dead thread
        process_manager._running_tasks["todo_dead"] = t
        assert is_todo_running("todo_dead") is False

        # Alive thread
        event = threading.Event()
        t2 = threading.Thread(target=lambda: event.wait(5), daemon=True)
        t2.start()
        process_manager._running_tasks["todo_alive"] = t2
        assert is_todo_running("todo_alive") is True
        event.set()
        t2.join(timeout=2)


class TestStartTodoRun:
    @patch("backend.run_manager._run_claude_for_todo")
    def test_starts_run(self, mock_run):
        from backend.run_manager import process_manager, start_todo_run
        todo = Todo(id="todo_r1", project_id="proj_q", text="Run me", status="next")
        _seed(todos=[todo])

        result = start_todo_run("todo_r1")
        assert result is None  # success

        # Thread should be tracked
        assert "todo_r1" in process_manager._running_tasks
        process_manager._running_tasks["todo_r1"].join(timeout=5)

    def test_todo_not_found(self):
        from backend.run_manager import start_todo_run
        _seed(todos=[])
        result = start_todo_run("nonexistent")
        assert result == "todo not found"

    def test_no_source_path(self):
        from backend.run_manager import start_todo_run
        proj = Project(id="proj_nosrc", name="NoSrc", source_path="")
        todo = Todo(id="todo_nosrc", project_id="proj_nosrc", text="X")
        _seed(todos=[todo], projects=[proj])
        result = start_todo_run("todo_nosrc")
        assert result == "no source_path"

    @patch("backend.run_manager._run_claude_for_todo")
    def test_queues_when_project_busy(self, mock_run):
        from backend.run_manager import process_manager, start_todo_run

        todo1 = Todo(id="todo_busy1", project_id="proj_q", text="First", status="in_progress", run_status="running")
        todo2 = Todo(id="todo_busy2", project_id="proj_q", text="Second", status="next")
        _seed(todos=[todo1, todo2])

        # Simulate todo1 having an alive thread
        ev = threading.Event()
        fake_thread = threading.Thread(target=lambda: ev.wait(10), daemon=True)
        fake_thread.start()
        process_manager._running_tasks["todo_busy1"] = fake_thread

        result = start_todo_run("todo_busy2")
        assert result == "queued"

        ev.set()
        fake_thread.join(timeout=2)

    @patch("backend.run_manager._run_claude_for_todo")
    def test_already_running(self, mock_run):
        from backend.run_manager import process_manager, start_todo_run

        todo = Todo(id="todo_ar", project_id="proj_q", text="Running", status="in_progress", run_status="running")
        _seed(todos=[todo])

        ev = threading.Event()
        fake_thread = threading.Thread(target=lambda: ev.wait(10), daemon=True)
        fake_thread.start()
        process_manager._running_tasks["todo_ar"] = fake_thread

        result = start_todo_run("todo_ar")
        assert result == "already running"

        ev.set()
        fake_thread.join(timeout=2)

    @patch("backend.run_manager._run_claude_for_todo")
    def test_already_queued(self, mock_run):
        from backend.run_manager import start_todo_run

        todo = Todo(id="todo_aq", project_id="proj_q", text="Queued", status="next", run_status="queued")
        _seed(todos=[todo])

        result = start_todo_run("todo_aq")
        assert result == "already queued"

    @patch("backend.run_manager._run_claude_for_todo")
    def test_autopilot_sets_trigger(self, mock_run):
        from backend.run_manager import process_manager, start_todo_run
        from backend.storage import StorageContext

        todo = Todo(id="todo_ap", project_id="proj_q", text="Auto", status="next")
        _seed(todos=[todo])

        result = start_todo_run("todo_ap", autopilot=True)
        assert result is None

        process_manager._running_tasks["todo_ap"].join(timeout=5)

        # Check the stored trigger
        from backend.storage import load_store
        store = load_store()
        t = next(t for t in store.todos if t.id == "todo_ap")
        assert t.run_trigger == "autopilot"


class TestProcessQueue:
    @patch("backend.run_manager._run_claude_for_todo")
    def test_starts_next_queued(self, mock_run):
        from backend.run_manager import _process_queue, process_manager

        todo1 = Todo(id="todo_pq1", project_id="proj_q", text="Done", status="completed", run_status="done")
        todo2 = Todo(id="todo_pq2", project_id="proj_q", text="Queued", status="next", run_status="queued", queued_at=_now())
        _seed(todos=[todo1, todo2])

        _process_queue("proj_q")

        assert "todo_pq2" in process_manager._running_tasks
        process_manager._running_tasks["todo_pq2"].join(timeout=5)

    @patch("backend.run_manager._run_claude_for_todo")
    def test_fifo_ordering(self, mock_run):
        from backend.run_manager import _process_queue, process_manager

        todo1 = Todo(id="todo_f1", project_id="proj_q", text="First", run_status="queued", queued_at="2024-01-01T00:00:00Z")
        todo2 = Todo(id="todo_f2", project_id="proj_q", text="Second", run_status="queued", queued_at="2024-01-01T00:01:00Z")
        _seed(todos=[todo1, todo2])

        _process_queue("proj_q")

        # First queued should start
        assert "todo_f1" in process_manager._running_tasks
        process_manager._running_tasks["todo_f1"].join(timeout=5)

    @patch("backend.run_manager._run_claude_for_todo")
    def test_no_start_if_busy(self, mock_run):
        from backend.run_manager import _process_queue, process_manager

        running = Todo(id="todo_running", project_id="proj_q", text="Running", run_status="running")
        queued = Todo(id="todo_wait", project_id="proj_q", text="Wait", run_status="queued", queued_at=_now())
        _seed(todos=[running, queued])

        # Simulate running thread
        ev = threading.Event()
        fake = threading.Thread(target=lambda: ev.wait(10), daemon=True)
        fake.start()
        process_manager._running_tasks["todo_running"] = fake

        _process_queue("proj_q")

        # Queued todo should NOT have started
        assert "todo_wait" not in process_manager._running_tasks

        ev.set()
        fake.join(timeout=2)

    def test_no_queued_is_noop(self):
        from backend.run_manager import _process_queue

        todo = Todo(id="todo_nq", project_id="proj_q", text="Done", run_status="done")
        _seed(todos=[todo])

        _process_queue("proj_q")  # should not raise

    @patch("backend.run_manager._followup_claude_for_todo")
    def test_queued_followup(self, mock_followup):
        from backend.run_manager import _process_queue, process_manager

        todo = Todo(
            id="todo_fu",
            project_id="proj_q",
            text="Follow up",
            run_status="queued",
            queued_at=_now(),
            pending_followup="continue please",
            session_id="sess_abc",
        )
        _seed(todos=[todo])

        _process_queue("proj_q")

        assert "todo_fu" in process_manager._running_tasks
        process_manager._running_tasks["todo_fu"].join(timeout=5)

        # Should have called _followup_claude_for_todo
        mock_followup.assert_called_once()
        args = mock_followup.call_args[0]
        assert args[0] == "todo_fu"
        assert args[1] == "continue please"
        assert args[2] == "sess_abc"


class TestCommandProxyDispatch:
    """Verify that command todos pass the correct prompt to _run_claude_for_todo."""

    @patch("backend.run_manager._run_claude_for_todo")
    def test_proxy_command_passes_slash_prompt(self, mock_run):
        """A /checkpoint todo should invoke _run_claude_for_todo with the slash command as the text."""
        from backend.run_manager import process_manager, start_todo_run

        todo = Todo(id="todo_cmd1", project_id="proj_q", text="/checkpoint", status="next")
        _seed(todos=[todo])

        result = start_todo_run("todo_cmd1")
        assert result is None

        process_manager._running_tasks["todo_cmd1"].join(timeout=5)
        mock_run.assert_called_once()
        # The second positional arg is todo_text — it should be the raw text
        args = mock_run.call_args[0]
        assert args[0] == "todo_cmd1"
        assert args[1] == "/checkpoint"  # todo_text passed through

    @patch("backend.run_manager._run_claude_for_todo")
    def test_proxy_unknown_command_still_starts(self, mock_run):
        """An unknown /whatever command should still start a run (generic proxy)."""
        from backend.run_manager import process_manager, start_todo_run

        todo = Todo(id="todo_cmd2", project_id="proj_q", text="Do it /some-new-feature", status="next")
        _seed(todos=[todo])

        result = start_todo_run("todo_cmd2")
        assert result is None

        process_manager._running_tasks["todo_cmd2"].join(timeout=5)
        mock_run.assert_called_once()

    @patch("backend.run_manager._run_claude_for_todo")
    def test_manual_command_blocked(self, mock_run):
        """A /manual todo should not start a run."""
        from backend.run_manager import start_todo_run

        todo = Todo(id="todo_man", project_id="proj_q", text="Human task /manual", status="next", manual=True)
        _seed(todos=[todo])

        result = start_todo_run("todo_man")
        assert result == "manual task"
        mock_run.assert_not_called()


class TestDequeueTodoRun:
    def test_dequeues_successfully(self):
        from backend.run_manager import dequeue_todo_run

        todo = Todo(id="todo_dq", project_id="proj_q", text="Queued", run_status="queued", queued_at=_now(), pending_followup="msg")
        _seed(todos=[todo])

        result = dequeue_todo_run("todo_dq")
        assert result is None

        from backend.storage import load_store
        store = load_store()
        t = next(t for t in store.todos if t.id == "todo_dq")
        assert t.run_status is None
        assert t.run_trigger is None
        assert t.queued_at is None
        assert t.pending_followup is None

    def test_not_queued_error(self):
        from backend.run_manager import dequeue_todo_run

        todo = Todo(id="todo_nq2", project_id="proj_q", text="Running", run_status="running")
        _seed(todos=[todo])

        result = dequeue_todo_run("todo_nq2")
        assert result == "not queued"

    def test_not_found(self):
        from backend.run_manager import dequeue_todo_run
        _seed(todos=[])

        result = dequeue_todo_run("nonexistent")
        assert result == "todo not found"
