"""Apply Claude analysis results to the todo store."""

from __future__ import annotations

import logging
import re
from pathlib import Path

from .models import (
    ClaudeAnalysisResult,
    Insight,
    Todo,
    _now,
)
from .storage import StorageContext
from .tags import filter_unknown_tags, parse_tags, parse_priority, strip_tags_from_text

log = logging.getLogger(__name__)

# Regex to detect a leading emoji (covers most common emoji ranges)
_LEADING_EMOJI_RE = re.compile(
    r"^([\U0001F300-\U0001FAFF\U00002702-\U000027B0\U0000FE00-\U0000FE0F"
    r"\U0000200D\U000020E3\U00003297\U00003299\U00002600-\U000026FF"
    r"\U00002B50-\U00002B55]+)\s*",
)


def _extract_emoji(text: str) -> tuple[str | None, str]:
    """Extract a leading emoji from text. Returns (emoji, remaining_text)."""
    m = _LEADING_EMOJI_RE.match(text)
    if m:
        return m.group(1).strip(), text[m.end():].strip()
    return None, text



def _resolve_project_id(pid: str, projects: list) -> str | None:
    """Resolve a possibly-wrong project identifier to a valid project ID.

    Claude sometimes returns project names or directory names instead of the
    actual ``proj_*`` IDs.  This helper builds lookup maps and attempts a
    case-insensitive match by:
      1. Exact ``proj_*`` ID
      2. Project name (case-insensitive)
      3. Last path component of ``source_path`` (case-insensitive)

    Returns the resolved project ID, or ``None`` if unresolvable.
    """
    by_id: dict[str, str] = {}
    by_name: dict[str, str] = {}
    by_dir: dict[str, str] = {}

    for p in projects:
        by_id[p.id] = p.id
        by_name[p.name.lower()] = p.id
        if p.source_path:
            by_dir[Path(p.source_path).name.lower()] = p.id

    # 1. Already a valid project ID
    if pid in by_id:
        return pid

    # 2. Match by project name (case-insensitive)
    low = pid.lower()
    if low in by_name:
        return by_name[low]

    # 3. Match by directory name (case-insensitive)
    if low in by_dir:
        return by_dir[low]

    return None


class _Counters:
    """Mutable accumulator for per-project apply stats."""

    def __init__(self) -> None:
        self.todos_added = 0
        self.todos_completed = 0
        self.todos_modified = 0
        self.added_active_texts: list[str] = []
        self.added_completed_texts: list[str] = []
        self.completed_todo_ids: list[str] = []
        self.completed_todo_texts: list[str] = []
        self.modified_todo_texts: list[str] = []
        self.new_project_names: list[str] = []
        self.insight_texts: list[str] = []


def _apply_result(
    ctx: "StorageContext",
    result: "ClaudeAnalysisResult",
    project_id: str,
    counters: _Counters,
    sessions: list[dict] | None = None,
) -> None:
    """Apply a per-project Claude result to the store, scoped to *project_id*."""

    # Build set of session IDs that need user action
    _actionable_sessions: set[str] = set()
    if sessions:
        for s in sessions:
            if s.get("state") in ("waiting_for_user", "waiting_for_tool_approval"):
                _actionable_sessions.add(s["session_id"])

    project_todo_ids = {t.id for t in ctx.store.todos if t.project_id == project_id}
    stale_remove_ids: set[str] = set()  # non-user todos to auto-delete when marked stale

    # Mark completed (backward compat: completed_todo_ids → status="completed")
    for tid in result.completed_todo_ids:
        if tid not in project_todo_ids:
            log.warning("completed_todo_ids: todo %s not in project %s, skipping", tid, project_id)
            continue
        for t in ctx.store.todos:
            if t.id == tid and t.status != "completed":
                if t.status == "rejected":
                    log.warning("completed_todo_ids: skipping rejected todo %s", tid)
                    continue
                if t.source == "user":
                    log.warning("completed_todo_ids: skipping user todo %s", tid)
                    continue
                t.status = "completed"
                t.completed_at = _now()
                counters.todos_completed += 1
                counters.completed_todo_ids.append(tid)
                counters.completed_todo_texts.append(t.text)

    # Apply status_updates
    todo_by_id = {t.id: t for t in ctx.store.todos}
    for su in result.status_updates:
        if su.id not in project_todo_ids:
            log.warning("status_updates: todo %s not in project %s, skipping", su.id, project_id)
            continue
        t = todo_by_id.get(su.id)
        if t is None:
            log.warning("status_updates: unknown todo id=%s, skipping", su.id)
            continue
        if su.status == "rejected":
            log.warning("status_updates: only users can reject todos, skipping %s", su.id)
            continue
        if t.source == "user" and su.status != "stale":
            log.warning("status_updates: skipping non-stale status %r for user todo %s", su.status, su.id)
            continue
        # Never allow completed todos to be moved back to stale — completed work is permanent history
        if t.status == "completed" and su.status == "stale":
            log.warning("status_updates: refusing to mark completed todo %s as stale", su.id)
            continue
        # Never allow rejected todos to be modified by the analyzer — user decision is final
        if t.status == "rejected":
            log.warning("status_updates: refusing to modify rejected todo %s", su.id)
            continue
        if t.status == su.status:
            continue
        was_completed = t.status == "completed"
        t.status = su.status
        if su.status == "stale" and su.reason:
            t.stale_reason = su.reason
        elif su.status != "stale":
            t.stale_reason = None
        # Dequeue if the todo was queued to run
        if su.status == "stale" and t.run_status == "queued":
            log.info("Dequeuing stale todo %s", su.id)
            t.run_status = "done" if t.session_id else None
            t.run_trigger = None
            t.queued_at = None
            t.pending_followup = None
            t.pending_followup_plan_only = False
        if su.status == "completed" and not was_completed:
            t.completed_at = _now()
            counters.todos_completed += 1
            counters.completed_todo_ids.append(su.id)
            counters.completed_todo_texts.append(t.text)
        elif su.status != "completed" and was_completed:
            t.completed_at = None
        counters.todos_modified += 1
        counters.modified_todo_texts.append(t.text)
        # Auto-remove non-user todos marked stale
        if su.status == "stale" and t.source != "user":
            stale_remove_ids.add(su.id)

    # Add new todos — project_id is set automatically
    existing_texts = {(t.project_id, t.text.lower()) for t in ctx.store.todos}
    # Collect known tags so Claude can reuse existing ones but not create new ones
    known_tags = set()
    for t in ctx.store.todos:
        known_tags.update(parse_tags(t.text))

    for nt in result.new_todos:
        # Strip leftover "Next:"/"Consider:" prefixes defensively
        text = re.sub(r"^(Next|Consider|Waiting|Stale):\s*", "", nt.text, flags=re.IGNORECASE)

        # Extract leading emoji from text
        emoji, text = _extract_emoji(text)

        # Strip tags that don't already exist — Claude can use existing tags but not create new ones
        text = filter_unknown_tags(text, known_tags)

        # Drop waiting todos for sessions that don't need user action
        if nt.status == "waiting" and nt.session_id and nt.session_id not in _actionable_sessions:
            log.info("Dropping waiting todo for non-actionable session %s: %s", nt.session_id, text)
            continue

        if (project_id, text.lower()) in existing_texts:
            continue

        todo = Todo(project_id=project_id, text=text, status=nt.status, source="claude", session_id=nt.session_id, source_session_id=nt.session_id, emoji=emoji, priority=parse_priority(text))
        if nt.status == "completed":
            todo.completed_at = _now()
        ctx.store.todos.append(todo)
        existing_texts.add((project_id, text.lower()))
        counters.todos_added += 1
        if nt.status == "completed":
            counters.added_completed_texts.append(text)
        else:
            counters.added_active_texts.append(text)

    # Modify existing todos
    for mod in result.modified_todos:
        if mod.id not in project_todo_ids:
            log.warning("modified_todos: todo %s not in project %s, skipping", mod.id, project_id)
            continue
        t = todo_by_id.get(mod.id)
        if t is None:
            log.warning("modified_todos: unknown todo id=%s, skipping", mod.id)
            continue
        if t.source == "user":
            log.warning("modified_todos: skipping user todo %s", mod.id)
            continue
        if t.status == "rejected":
            log.warning("modified_todos: skipping rejected todo %s", mod.id)
            continue
        changed = False
        if mod.text is not None and mod.text != t.text:
            emoji, clean_text = _extract_emoji(mod.text)
            # Strip unknown tags — Claude can use existing tags but not create new ones
            clean_text = filter_unknown_tags(clean_text, known_tags)
            # Preserve original text so users can see what they typed before the rename
            if t.original_text is None:
                t.original_text = t.text
            t.text = clean_text
            t.priority = parse_priority(clean_text)
            if emoji:
                t.emoji = emoji
            changed = True
        if mod.project_id is not None and mod.project_id != t.project_id:
            resolved = _resolve_project_id(mod.project_id, ctx.store.projects)
            if resolved:
                t.project_id = resolved
                changed = True
            else:
                log.warning("modified_todos: unresolvable project_id=%r for todo %s", mod.project_id, mod.id)
        if mod.status is not None and mod.status != t.status:
            # Never allow completed todos to be moved back to stale
            if t.status == "completed" and mod.status == "stale":
                log.warning("modified_todos: refusing to mark completed todo %s as stale", mod.id)
            else:
                was_completed = t.status == "completed"
                t.status = mod.status
                if mod.status == "completed" and not was_completed:
                    t.completed_at = _now()
                elif mod.status != "completed" and was_completed:
                    t.completed_at = None
                changed = True
        # Dequeue if the todo was queued to run
        if t.status == "stale" and t.run_status == "queued":
            log.info("Dequeuing stale todo %s", mod.id)
            t.run_status = "done" if t.session_id else None
            t.run_trigger = None
            t.queued_at = None
            t.pending_followup = None
            t.pending_followup_plan_only = False
            changed = True
        if changed:
            counters.todos_modified += 1
            counters.modified_todo_texts.append(t.text)
        # Auto-remove non-user todos marked stale (only if the status was actually changed)
        if t.status == "stale" and t.source != "user":
            stale_remove_ids.add(mod.id)

    # Update summaries
    for pid, summary in result.project_summaries.items():
        # Resolve in case Claude used project name instead of ID
        resolved = _resolve_project_id(pid, ctx.store.projects)
        ctx.metadata.project_summaries[resolved or pid] = summary

    # Auto-remove non-user todos that were marked stale
    if stale_remove_ids:
        before = len(ctx.store.todos)
        ctx.store.todos = [t for t in ctx.store.todos if t.id not in stale_remove_ids]
        removed = before - len(ctx.store.todos)
        if removed:
            log.info("Auto-removed %d stale non-user todo(s)", removed)

    # Apply AI-raised red flags to todos
    for rf in result.red_flags:
        t = todo_by_id.get(rf.todo_id)
        if t is None:
            log.warning("red_flags: unknown todo id=%s, skipping", rf.todo_id)
            continue
        if t.project_id != project_id:
            log.warning("red_flags: todo %s not in project %s, skipping", rf.todo_id, project_id)
            continue
        # Avoid duplicate flags with the same label
        existing_labels = {f.get("label") for f in t.red_flags}
        if rf.label in existing_labels:
            continue
        t.red_flags.append({
            "label": rf.label,
            "explanation": rf.explanation,
            "excerpt": "",
            "resolved": False,
            "source": "ai",
        })

    # Dismiss stale insights
    if result.dismiss_insight_ids:
        dismiss_set = set(result.dismiss_insight_ids)
        for i in ctx.metadata.insights:
            if i.id in dismiss_set and not i.dismissed:
                i.dismissed = True
                log.info("Auto-dismissed insight %s: %s", i.id, i.text[:80])

    # Persist new insights (dedup by project_id + text)
    existing_keys = {(i.project_id, i.text.lower()) for i in ctx.metadata.insights}
    for ci in result.insights:
        # Per-project prompt doesn't ask for project_id in insights, so we set it
        pid = project_id
        if (pid, ci.text.lower()) not in existing_keys:
            ctx.metadata.insights.append(
                Insight(project_id=pid, text=ci.text, source_analysis_timestamp=_now())
            )
            existing_keys.add((pid, ci.text.lower()))
            counters.insight_texts.append(ci.text)
