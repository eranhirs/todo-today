"""Tests for _apply_result logic in result_applier.py."""

from __future__ import annotations

from backend.result_applier import _Counters, _apply_result
from backend.models import (
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
)
from backend.storage import StorageContext


def _make_ctx(store: TodoStore, metadata: Metadata | None = None) -> StorageContext:
    """Build a StorageContext with pre-populated data (bypassing disk)."""
    ctx = StorageContext.__new__(StorageContext)
    ctx.store = store
    ctx.metadata = metadata or Metadata()
    ctx._read_only = True
    return ctx


def _base_store() -> tuple[TodoStore, str]:
    proj = Project(id="proj_aaa", name="TestProj", source_path="/tmp/tp")
    todos = [
        Todo(id="todo_1", project_id=proj.id, text="Fix bug", status="next", source="claude"),
        Todo(id="todo_2", project_id=proj.id, text="Write docs", status="next", source="user"),
        Todo(id="todo_3", project_id=proj.id, text="Refactor", status="completed", source="claude"),
        Todo(id="todo_4", project_id=proj.id, text="Rejected task", status="rejected", source="claude"),
    ]
    return TodoStore(projects=[proj], todos=todos), proj.id


# ── completed_todo_ids ────────────────────────────────────────


class TestCompletedTodoIds:
    def test_marks_claude_todo_completed(self):
        store, pid = _base_store()
        ctx = _make_ctx(store)
        c = _Counters()
        result = ClaudeAnalysisResult(completed_todo_ids=["todo_1"])
        _apply_result(ctx, result, pid, c)

        assert ctx.store.todos[0].status == "completed"
        assert ctx.store.todos[0].completed_at is not None
        assert c.todos_completed == 1
        assert "todo_1" in c.completed_todo_ids

    def test_skips_user_todo(self):
        store, pid = _base_store()
        ctx = _make_ctx(store)
        c = _Counters()
        result = ClaudeAnalysisResult(completed_todo_ids=["todo_2"])
        _apply_result(ctx, result, pid, c)

        assert ctx.store.todos[1].status == "next"  # unchanged
        assert c.todos_completed == 0

    def test_skips_rejected_todo(self):
        store, pid = _base_store()
        ctx = _make_ctx(store)
        c = _Counters()
        result = ClaudeAnalysisResult(completed_todo_ids=["todo_4"])
        _apply_result(ctx, result, pid, c)

        assert ctx.store.todos[3].status == "rejected"
        assert c.todos_completed == 0

    def test_skips_already_completed(self):
        store, pid = _base_store()
        ctx = _make_ctx(store)
        c = _Counters()
        result = ClaudeAnalysisResult(completed_todo_ids=["todo_3"])
        _apply_result(ctx, result, pid, c)

        assert c.todos_completed == 0  # no double-count

    def test_skips_unknown_todo(self):
        store, pid = _base_store()
        ctx = _make_ctx(store)
        c = _Counters()
        result = ClaudeAnalysisResult(completed_todo_ids=["todo_nonexistent"])
        _apply_result(ctx, result, pid, c)

        assert c.todos_completed == 0


# ── status_updates ────────────────────────────────────────────


class TestStatusUpdates:
    def test_updates_claude_todo_status(self):
        store, pid = _base_store()
        ctx = _make_ctx(store)
        c = _Counters()
        result = ClaudeAnalysisResult(
            status_updates=[ClaudeTodoStatusUpdate(id="todo_1", status="in_progress")]
        )
        _apply_result(ctx, result, pid, c)

        assert ctx.store.todos[0].status == "in_progress"
        assert c.todos_modified == 1

    def test_refuses_rejected_status_from_analyzer(self):
        store, pid = _base_store()
        ctx = _make_ctx(store)
        c = _Counters()
        result = ClaudeAnalysisResult(
            status_updates=[ClaudeTodoStatusUpdate(id="todo_1", status="rejected")]
        )
        _apply_result(ctx, result, pid, c)

        assert ctx.store.todos[0].status == "next"  # unchanged

    def test_user_todo_allows_stale(self):
        store, pid = _base_store()
        ctx = _make_ctx(store)
        c = _Counters()
        result = ClaudeAnalysisResult(
            status_updates=[ClaudeTodoStatusUpdate(id="todo_2", status="stale", reason="outdated")]
        )
        _apply_result(ctx, result, pid, c)

        assert ctx.store.todos[1].status == "stale"
        assert ctx.store.todos[1].stale_reason == "outdated"

    def test_user_todo_rejects_non_stale_status(self):
        store, pid = _base_store()
        ctx = _make_ctx(store)
        c = _Counters()
        result = ClaudeAnalysisResult(
            status_updates=[ClaudeTodoStatusUpdate(id="todo_2", status="in_progress")]
        )
        _apply_result(ctx, result, pid, c)

        assert ctx.store.todos[1].status == "next"  # unchanged

    def test_refuses_completed_to_stale(self):
        store, pid = _base_store()
        ctx = _make_ctx(store)
        c = _Counters()
        result = ClaudeAnalysisResult(
            status_updates=[ClaudeTodoStatusUpdate(id="todo_3", status="stale")]
        )
        _apply_result(ctx, result, pid, c)

        assert ctx.store.todos[2].status == "completed"  # unchanged

    def test_refuses_to_modify_rejected(self):
        store, pid = _base_store()
        ctx = _make_ctx(store)
        c = _Counters()
        result = ClaudeAnalysisResult(
            status_updates=[ClaudeTodoStatusUpdate(id="todo_4", status="next")]
        )
        _apply_result(ctx, result, pid, c)

        assert ctx.store.todos[3].status == "rejected"  # unchanged

    def test_stale_non_user_todo_auto_removed(self):
        store, pid = _base_store()
        ctx = _make_ctx(store)
        c = _Counters()
        result = ClaudeAnalysisResult(
            status_updates=[ClaudeTodoStatusUpdate(id="todo_1", status="stale")]
        )
        _apply_result(ctx, result, pid, c)

        # Non-user todo marked stale should be removed
        remaining_ids = [t.id for t in ctx.store.todos]
        assert "todo_1" not in remaining_ids

    def test_status_to_completed_sets_completed_at(self):
        store, pid = _base_store()
        ctx = _make_ctx(store)
        c = _Counters()
        result = ClaudeAnalysisResult(
            status_updates=[ClaudeTodoStatusUpdate(id="todo_1", status="completed")]
        )
        _apply_result(ctx, result, pid, c)

        assert ctx.store.todos[0].completed_at is not None
        assert c.todos_completed == 1


# ── new_todos ─────────────────────────────────────────────────


class TestNewTodos:
    def test_adds_new_todo(self):
        store, pid = _base_store()
        ctx = _make_ctx(store)
        c = _Counters()
        result = ClaudeAnalysisResult(
            new_todos=[ClaudeNewTodo(text="New task", status="next")]
        )
        _apply_result(ctx, result, pid, c)

        assert c.todos_added == 1
        added = [t for t in ctx.store.todos if t.text == "New task"]
        assert len(added) == 1
        assert added[0].source == "claude"
        assert added[0].project_id == pid

    def test_deduplicates_existing_text(self):
        store, pid = _base_store()
        ctx = _make_ctx(store)
        c = _Counters()
        result = ClaudeAnalysisResult(
            new_todos=[ClaudeNewTodo(text="Fix bug", status="next")]
        )
        _apply_result(ctx, result, pid, c)

        assert c.todos_added == 0

    def test_dedup_case_insensitive(self):
        store, pid = _base_store()
        ctx = _make_ctx(store)
        c = _Counters()
        result = ClaudeAnalysisResult(
            new_todos=[ClaudeNewTodo(text="FIX BUG", status="next")]
        )
        _apply_result(ctx, result, pid, c)

        assert c.todos_added == 0

    def test_strips_status_prefix(self):
        store, pid = _base_store()
        ctx = _make_ctx(store)
        c = _Counters()
        result = ClaudeAnalysisResult(
            new_todos=[ClaudeNewTodo(text="Next: Do something", status="next")]
        )
        _apply_result(ctx, result, pid, c)

        added = [t for t in ctx.store.todos if "Do something" in t.text]
        assert len(added) == 1
        assert not added[0].text.startswith("Next:")

    def test_extracts_emoji(self):
        store, pid = _base_store()
        ctx = _make_ctx(store)
        c = _Counters()
        result = ClaudeAnalysisResult(
            new_todos=[ClaudeNewTodo(text="\U0001F41B Debug issue", status="next")]
        )
        _apply_result(ctx, result, pid, c)

        added = [t for t in ctx.store.todos if "Debug issue" in t.text]
        assert len(added) == 1
        assert added[0].emoji == "\U0001F41B"

    def test_drops_waiting_for_non_actionable_session(self):
        store, pid = _base_store()
        ctx = _make_ctx(store)
        c = _Counters()
        result = ClaudeAnalysisResult(
            new_todos=[ClaudeNewTodo(text="Waiting thing", status="waiting", session_id="sess_xyz")]
        )
        # No sessions passed → nothing actionable
        _apply_result(ctx, result, pid, c, sessions=None)

        assert c.todos_added == 0

    def test_keeps_waiting_for_actionable_session(self):
        store, pid = _base_store()
        ctx = _make_ctx(store)
        c = _Counters()
        result = ClaudeAnalysisResult(
            new_todos=[ClaudeNewTodo(text="Waiting thing", status="waiting", session_id="sess_xyz")]
        )
        sessions = [{"session_id": "sess_xyz", "state": "waiting_for_user"}]
        _apply_result(ctx, result, pid, c, sessions=sessions)

        assert c.todos_added == 1

    def test_new_todo_does_not_inherit_parent_session_id(self):
        store, pid = _base_store()
        ctx = _make_ctx(store)
        c = _Counters()
        result = ClaudeAnalysisResult(
            new_todos=[ClaudeNewTodo(text="Child task", status="next", session_id="sess_parent")]
        )
        _apply_result(ctx, result, pid, c)

        added = [t for t in ctx.store.todos if t.text == "Child task"]
        assert len(added) == 1
        # source_session_id links to the parent for ancestry
        assert added[0].source_session_id == "sess_parent"
        # session_id must stay unset — it's this todo's own run session
        assert added[0].session_id is None

    def test_waiting_new_todo_keeps_session_id(self):
        store, pid = _base_store()
        ctx = _make_ctx(store)
        c = _Counters()
        result = ClaudeAnalysisResult(
            new_todos=[ClaudeNewTodo(text="Respond to Claude", status="waiting", session_id="sess_xyz")]
        )
        sessions = [{"session_id": "sess_xyz", "state": "waiting_for_user"}]
        _apply_result(ctx, result, pid, c, sessions=sessions)

        added = [t for t in ctx.store.todos if t.text == "Respond to Claude"]
        assert len(added) == 1
        # Waiting todos must carry session_id so follow-ups resume that session
        assert added[0].session_id == "sess_xyz"
        assert added[0].source_session_id == "sess_xyz"

    def test_completed_new_todo_gets_completed_at(self):
        store, pid = _base_store()
        ctx = _make_ctx(store)
        c = _Counters()
        result = ClaudeAnalysisResult(
            new_todos=[ClaudeNewTodo(text="Already done", status="completed")]
        )
        _apply_result(ctx, result, pid, c)

        added = [t for t in ctx.store.todos if t.text == "Already done"]
        assert len(added) == 1
        assert added[0].completed_at is not None
        assert "Already done" in c.added_completed_texts


# ── modified_todos ────────────────────────────────────────────


class TestModifiedTodos:
    def test_modifies_text(self):
        store, pid = _base_store()
        ctx = _make_ctx(store)
        c = _Counters()
        result = ClaudeAnalysisResult(
            modified_todos=[ClaudeTodoUpdate(id="todo_1", text="Fix critical bug")]
        )
        _apply_result(ctx, result, pid, c)

        assert ctx.store.todos[0].text == "Fix critical bug"
        assert c.todos_modified == 1

    def test_skips_user_todo(self):
        store, pid = _base_store()
        ctx = _make_ctx(store)
        c = _Counters()
        result = ClaudeAnalysisResult(
            modified_todos=[ClaudeTodoUpdate(id="todo_2", text="Changed")]
        )
        _apply_result(ctx, result, pid, c)

        assert ctx.store.todos[1].text == "Write docs"  # unchanged

    def test_skips_rejected_todo(self):
        store, pid = _base_store()
        ctx = _make_ctx(store)
        c = _Counters()
        result = ClaudeAnalysisResult(
            modified_todos=[ClaudeTodoUpdate(id="todo_4", text="Changed")]
        )
        _apply_result(ctx, result, pid, c)

        assert ctx.store.todos[3].text == "Rejected task"  # unchanged

    def test_refuses_completed_to_stale(self):
        store, pid = _base_store()
        ctx = _make_ctx(store)
        c = _Counters()
        result = ClaudeAnalysisResult(
            modified_todos=[ClaudeTodoUpdate(id="todo_3", status="stale")]
        )
        _apply_result(ctx, result, pid, c)

        assert ctx.store.todos[2].status == "completed"  # unchanged

    def test_modifies_status_to_completed(self):
        store, pid = _base_store()
        ctx = _make_ctx(store)
        c = _Counters()
        result = ClaudeAnalysisResult(
            modified_todos=[ClaudeTodoUpdate(id="todo_1", status="completed")]
        )
        _apply_result(ctx, result, pid, c)

        assert ctx.store.todos[0].status == "completed"
        assert ctx.store.todos[0].completed_at is not None

    def test_cross_project_todo_skipped(self):
        """modified_todos scoped to project — IDs from other projects are skipped."""
        store, pid = _base_store()
        other_proj = Project(id="proj_bbb", name="Other", source_path="/tmp/other")
        other_todo = Todo(id="todo_other", project_id=other_proj.id, text="Other task", source="claude")
        store.projects.append(other_proj)
        store.todos.append(other_todo)
        ctx = _make_ctx(store)
        c = _Counters()
        result = ClaudeAnalysisResult(
            modified_todos=[ClaudeTodoUpdate(id="todo_other", text="Hacked")]
        )
        _apply_result(ctx, result, pid, c)

        assert other_todo.text == "Other task"  # unchanged


# ── insights & dismiss ────────────────────────────────────────


class TestInsights:
    def test_adds_insight(self):
        store, pid = _base_store()
        ctx = _make_ctx(store)
        c = _Counters()
        result = ClaudeAnalysisResult(
            insights=[ClaudeInsight(text="Consider refactoring X")]
        )
        _apply_result(ctx, result, pid, c)

        assert len(ctx.metadata.insights) == 1
        assert ctx.metadata.insights[0].text == "Consider refactoring X"
        assert ctx.metadata.insights[0].project_id == pid

    def test_deduplicates_insights(self):
        store, pid = _base_store()
        meta = Metadata(insights=[Insight(project_id=pid, text="Consider refactoring X")])
        ctx = _make_ctx(store, meta)
        c = _Counters()
        result = ClaudeAnalysisResult(
            insights=[ClaudeInsight(text="Consider refactoring X")]
        )
        _apply_result(ctx, result, pid, c)

        assert len(ctx.metadata.insights) == 1  # no duplicate

    def test_dismisses_insight(self):
        store, pid = _base_store()
        ins = Insight(id="ins_1", project_id=pid, text="Old insight")
        meta = Metadata(insights=[ins])
        ctx = _make_ctx(store, meta)
        c = _Counters()
        result = ClaudeAnalysisResult(dismiss_insight_ids=["ins_1"])
        _apply_result(ctx, result, pid, c)

        assert ctx.metadata.insights[0].dismissed is True


# ── project_summaries ─────────────────────────────────────────


class TestProjectSummaries:
    def test_updates_summary(self):
        store, pid = _base_store()
        ctx = _make_ctx(store)
        c = _Counters()
        result = ClaudeAnalysisResult(project_summaries={pid: "Project is healthy"})
        _apply_result(ctx, result, pid, c)

        assert ctx.metadata.project_summaries[pid] == "Project is healthy"

    def test_resolves_by_name(self):
        store, pid = _base_store()
        ctx = _make_ctx(store)
        c = _Counters()
        result = ClaudeAnalysisResult(project_summaries={"TestProj": "Summary via name"})
        _apply_result(ctx, result, pid, c)

        assert ctx.metadata.project_summaries[pid] == "Summary via name"
