"""Main analysis orchestrator — coordinates session discovery, prompt building, and result application."""

from __future__ import annotations

import logging
import time

from .models import AnalysisEntry, _now
from .prompt_builder import _build_project_prompt, _invoke_claude
from .result_applier import _Counters, _apply_result, _resolve_project_id
from .session_discovery import (
    _latest_session_mtime,
    _match_sessions_to_projects,
    _session_key,
    discover_sessions,
    filter_changed_sessions,
    list_all_sessions,
)
from .storage import StorageContext

log = logging.getLogger(__name__)


def run_analysis(
    force: bool = False,
    model: str | None = None,
    session_keys: list[str] | None = None,
    trigger: str = "",
) -> AnalysisEntry | None:
    """Full analysis cycle: discover sessions, invoke Claude per-project, apply results.

    Returns None if skipped (no changes since last run).
    Pass force=True to skip the staleness check (e.g. manual wake).
    If model is None, reads from metadata.analysis_model.
    If session_keys is provided, only those sessions are analyzed (implies force, no age cutoff).
    """
    start = time.time()

    # Resolve model
    if model is None:
        with StorageContext(read_only=True) as ctx:
            model = ctx.metadata.analysis_model

    # When specific sessions are requested, discover all and filter to those keys
    if session_keys is not None:
        all_sessions = discover_sessions(max_age=None)
        key_set = set(session_keys)
        sessions = [s for s in all_sessions if _session_key(s) in key_set]
        if not sessions:
            # Likely our own analysis/run subprocess — silently skip
            log.debug(
                "Hook session keys not found after filtering: requested=%s, "
                "discovered=%d sessions total",
                key_set, len(all_sessions),
            )
            return None
    else:
        # Check if anything changed since last analysis (coarse check)
        if not force:
            latest_mtime = _latest_session_mtime()
            with StorageContext(read_only=True) as ctx:
                if latest_mtime > 0 and latest_mtime <= ctx.metadata.last_session_mtime:
                    log.info("No session changes since last analysis, skipping")
                    return None

        sessions = discover_sessions()

        # Per-session mtime filter: skip unchanged sessions (unless force)
        if not force and sessions:
            with StorageContext(read_only=True) as ctx:
                sessions = filter_changed_sessions(sessions, ctx.metadata.session_mtimes)
            if not sessions:
                log.info("All sessions unchanged since last analysis, skipping")
                return None
    if not sessions:
        entry = AnalysisEntry(
            duration_seconds=round(time.time() - start, 1),
            sessions_analyzed=0,
            summary="No active sessions found",
            model=model,
            trigger=trigger,
        )
        _record_entry(entry)
        return entry

    # ── Per-project analysis loop ──
    counters = _Counters()
    all_prompts: list[str] = []
    all_responses: list[str] = []
    all_reasoning: list[str] = []
    total_cost = 0.0
    total_input = 0
    total_output = 0
    total_cache_read = 0
    errors: list[str] = []
    projects_analyzed = 0

    # ── Phase 1: read state (short lock) ──
    with StorageContext() as ctx:
        # Match sessions to projects (auto-creates missing projects)
        proj_sessions = _match_sessions_to_projects(sessions, ctx)

        # Repair orphaned todos before analysis
        valid_ids = {p.id for p in ctx.store.projects}
        for t in ctx.store.todos:
            if t.project_id not in valid_ids:
                resolved = _resolve_project_id(t.project_id, ctx.store.projects)
                if resolved:
                    log.warning("Repaired orphaned todo %s: %r -> %s", t.id, t.project_id, resolved)
                    t.project_id = resolved
                else:
                    log.warning("Cannot resolve orphaned todo %s project_id=%r", t.id, t.project_id)

        # Build project lookup and per-project snapshots
        proj_by_id = {p.id: p for p in ctx.store.projects}
        proj_snapshots: dict[str, tuple] = {}
        for pid, proj_sess in proj_sessions.items():
            project = proj_by_id.get(pid)
            if project is None:
                log.warning("Project %s disappeared, skipping", pid)
                continue
            proj_todos = [
                t.model_dump() for t in ctx.store.todos if t.project_id == pid
            ]
            proj_insights = [
                {"id": i.id, "text": i.text, "created_at": i.created_at}
                for i in ctx.metadata.insights
                if not i.dismissed and (i.project_id == pid or i.project_id == "")
            ]
            proj_snapshots[pid] = (project, proj_todos, proj_insights, proj_sess)

    # ── Phase 2: call Claude (no lock held) ──
    invoke_results: list[tuple[str, object, dict, str]] = []
    for pid, (project, proj_todos, proj_insights, proj_sess) in proj_snapshots.items():
        prompt = _build_project_prompt(project, proj_todos, proj_insights, proj_sess)
        all_prompts.append(f"--- Project: {project.name} ({pid}) ---\n{prompt}")

        result, usage_info = _invoke_claude(prompt, model=model)

        total_cost += usage_info.get("cost_usd", 0.0)
        total_input += usage_info.get("input_tokens", 0)
        total_output += usage_info.get("output_tokens", 0)
        total_cache_read += usage_info.get("cache_read_tokens", 0)

        resp_text = usage_info.get("claude_response", "")
        reasoning_text = usage_info.get("claude_reasoning", "")
        all_responses.append(f"--- Project: {project.name} ({pid}) ---\n{resp_text}")
        if reasoning_text:
            all_reasoning.append(f"--- Project: {project.name} ({pid}) ---\n{reasoning_text}")

        if result is None:
            errors.append(f"{project.name}: {usage_info.get('error', 'unknown error')}")
            log.error("Analysis failed for project %s: %s", project.name, usage_info.get("error"))
            continue

        invoke_results.append((pid, result, proj_sess, project.name))

    # ── Phase 3: apply results (short lock) ──
    with StorageContext() as ctx:
        for pid, result, proj_sess, proj_name in invoke_results:
            _apply_result(ctx, result, pid, counters, sessions=proj_sess)
            projects_analyzed += 1
            log.info(
                "Project %s: +%d todos, %d completed",
                proj_name,
                counters.todos_added,
                counters.todos_completed,
            )

    # Persist per-session mtimes (session IDs already persisted before each invoke)
    with StorageContext() as ctx:
        for s in sessions:
            ctx.metadata.session_mtimes[_session_key(s)] = s["mtime"]

    # Dispatch autopilot follow-ups: for each todo with autopilot=True that
    # received a suggested_followup, send it to keep the session alive.
    _dispatch_autopilot_followups()

    combined_prompt = "\n\n".join(all_prompts)
    combined_response = "\n\n".join(all_responses)
    combined_reasoning = "\n\n".join(all_reasoning)

    summary_parts = [f"Analyzed {len(sessions)} sessions across {projects_analyzed} projects"]
    summary_parts.append(f"+{counters.todos_added} todos, {counters.todos_completed} completed, {counters.todos_modified} modified")
    if errors:
        summary_parts.append(f"({len(errors)} project(s) failed)")
    summary = ": ".join(summary_parts)

    entry = AnalysisEntry(
        duration_seconds=round(time.time() - start, 1),
        sessions_analyzed=len(sessions),
        todos_added=counters.todos_added,
        todos_completed=counters.todos_completed,
        todos_modified=counters.todos_modified,
        summary=summary,
        model=model,
        trigger=trigger,
        error="; ".join(errors) if errors else None,
        cost_usd=total_cost,
        input_tokens=total_input,
        output_tokens=total_output,
        cache_read_tokens=total_cache_read,
        completed_todo_ids=counters.completed_todo_ids,
        completed_todo_texts=counters.completed_todo_texts,
        added_todos_active=counters.added_active_texts,
        added_todos_completed=counters.added_completed_texts,
        modified_todos=counters.modified_todo_texts,
        new_project_names=counters.new_project_names,
        insights=counters.insight_texts,
        prompt_length=len(combined_prompt),
        prompt_text=combined_prompt,
        claude_response=combined_response,
        claude_reasoning=combined_reasoning,
    )
    _record_entry(entry)
    return entry


def _dispatch_autopilot_followups() -> None:
    """Auto-send analyzer-suggested follow-ups for todos with autopilot=True.

    Reads all todos, finds those with `autopilot=True`, a pending
    `suggested_followup`, and a completed run that's safe to resume. Sends
    the follow-up and marks it as sent so it isn't re-dispatched.
    """
    from .run_manager import start_followup

    candidates: list[tuple[str, str]] = []
    with StorageContext(read_only=True) as ctx:
        for t in ctx.store.todos:
            if not t.autopilot:
                continue
            if not t.suggested_followup or t.suggested_followup_sent:
                continue
            if t.run_status != "done":
                continue
            if not t.session_id:
                continue
            if t.status in ("completed", "rejected", "stale"):
                continue
            candidates.append((t.id, t.suggested_followup))

    for todo_id, message in candidates:
        err = start_followup(todo_id, message)
        if err:
            log.info("Autopilot follow-up skipped for %s: %s", todo_id, err)
        else:
            log.info("Autopilot follow-up sent for %s: %s", todo_id, message[:80])


def _record_entry(entry: AnalysisEntry) -> None:
    with StorageContext() as ctx:
        ctx.metadata.last_analysis = entry
        ctx.metadata.history.insert(0, entry)
        ctx.metadata.history = ctx.metadata.history[:50]
        ctx.metadata.heartbeat = _now()
        ctx.metadata.last_session_mtime = _latest_session_mtime()
        # Increment cumulative totals
        ctx.metadata.total_analyses += 1
        ctx.metadata.total_cost_usd += entry.cost_usd
        ctx.metadata.total_input_tokens += entry.input_tokens
        ctx.metadata.total_output_tokens += entry.output_tokens
