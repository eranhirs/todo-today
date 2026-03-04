"""Discover Claude Code sessions from ~/.claude/projects/ and analyze them."""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .models import (
    AnalysisEntry,
    ClaudeAnalysisResult,
    ClaudeNewTodo,
    ClaudeTodoUpdate,
    Insight,
    Project,
    Todo,
    _now,
)
from .storage import StorageContext

log = logging.getLogger(__name__)

CLAUDE_DIR = Path.home() / ".claude" / "projects"
# How far back to look for active sessions
SESSION_MAX_AGE = timedelta(hours=24)
# Max messages to extract per session for the prompt
MAX_MESSAGES_PER_SESSION = 20
# Track session files created by our own `claude -p` invocations so we can
# exclude them (but not the user's interactive sessions in the same project).
_SELF_PROJECT_DIRNAME = str(Path.cwd()).replace("/", "-")
_self_session_files: set[str] = set()


def _snapshot_self_sessions() -> set[str]:
    """Return current set of session filenames in our own project dir."""
    self_dir = CLAUDE_DIR / _SELF_PROJECT_DIRNAME
    if not self_dir.is_dir():
        return set()
    return {f.name for f in self_dir.glob("*.jsonl")}


def _is_self_session(proj_dirname: str, filename: str) -> bool:
    """Check if a session file was created by our analysis subprocess."""
    return proj_dirname == _SELF_PROJECT_DIRNAME and filename in _self_session_files


# ── Session discovery ──────────────────────────────────────────


def _decode_project_dir(dirname: str) -> str:
    """Convert e.g. '-Users-jane-git-myproject' back to '/Users/jane/git/myproject'."""
    # The encoding replaces '/' with '-', so the leading '-' is the root '/'
    return "/" + dirname[1:].replace("-", "/")


def _extract_project_name(source_path: str) -> str:
    return Path(source_path).name


def _latest_session_mtime() -> float:
    """Return the latest modification time (epoch) across all recent session files."""
    if not CLAUDE_DIR.is_dir():
        return 0.0
    cutoff = datetime.now(timezone.utc) - SESSION_MAX_AGE
    latest = 0.0
    for proj_dir in CLAUDE_DIR.iterdir():
        if not proj_dir.is_dir():
            continue
        for jsonl_file in proj_dir.glob("*.jsonl"):
            if _is_self_session(proj_dir.name, jsonl_file.name):
                continue
            mtime = jsonl_file.stat().st_mtime
            if datetime.fromtimestamp(mtime, tz=timezone.utc) >= cutoff:
                latest = max(latest, mtime)
    return latest


def discover_sessions() -> list[dict]:
    """Return a list of recent sessions with their messages.

    Each entry: {"project_dir": str, "source_path": str, "session_id": str, "messages": [...]}
    """
    if not CLAUDE_DIR.is_dir():
        log.warning("Claude projects dir not found: %s", CLAUDE_DIR)
        return []

    cutoff = datetime.now(timezone.utc) - SESSION_MAX_AGE
    sessions = []

    for proj_dir in CLAUDE_DIR.iterdir():
        if not proj_dir.is_dir():
            continue
        source_path = _decode_project_dir(proj_dir.name)

        for jsonl_file in proj_dir.glob("*.jsonl"):
            if _is_self_session(proj_dir.name, jsonl_file.name):
                continue
            # Check modification time
            mtime = datetime.fromtimestamp(jsonl_file.stat().st_mtime, tz=timezone.utc)
            if mtime < cutoff:
                continue

            messages = _parse_session_messages(jsonl_file)
            if messages:
                sessions.append({
                    "project_dir": proj_dir.name,
                    "source_path": source_path,
                    "session_id": jsonl_file.stem,
                    "messages": messages,
                })

    log.info("Discovered %d active sessions across %d project dirs", len(sessions), len({s["project_dir"] for s in sessions}))
    return sessions


def _parse_session_messages(path: Path) -> list[dict]:
    """Extract the last N user/assistant messages from a session JSONL file."""
    messages = []
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue

                entry_type = entry.get("type")
                if entry_type not in ("user", "assistant"):
                    continue

                msg = entry.get("message", {})
                role = msg.get("role")
                content = msg.get("content")
                if not role or not content:
                    continue

                # Flatten content to text
                if isinstance(content, list):
                    text_parts = []
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "text":
                            text_parts.append(block["text"])
                        elif isinstance(block, str):
                            text_parts.append(block)
                    text = "\n".join(text_parts)
                elif isinstance(content, str):
                    text = content
                else:
                    continue

                if not text.strip():
                    continue

                messages.append({
                    "role": role,
                    "text": text[:2000],  # truncate long messages
                    "timestamp": entry.get("timestamp", ""),
                })
    except Exception:
        log.exception("Error parsing session file: %s", path)

    # Return last N messages
    return messages[-MAX_MESSAGES_PER_SESSION:]


# ── Claude invocation ──────────────────────────────────────────


def _build_prompt(sessions: list[dict], store_snapshot: dict) -> str:
    """Build the analysis prompt for Claude."""
    parts = ["You are analyzing Claude Code sessions to update a todo list.\n"]

    # Current state
    parts.append("## Current Projects and Todos\n")
    parts.append(json.dumps(store_snapshot, indent=2))
    parts.append("\n")

    # Active insights (so Claude can avoid duplicating them)
    insights_data = store_snapshot.get("insights", [])
    if insights_data:
        parts.append("## Active Insights\n")
        parts.append(json.dumps(insights_data, indent=2))
        parts.append("\n")

    # Session summaries
    parts.append("## Recent Session Activity\n")
    for sess in sessions:
        parts.append(f"### Project: {_extract_project_name(sess['source_path'])} ({sess['source_path']})")
        parts.append(f"Session: {sess['session_id']}\n")
        for msg in sess["messages"]:
            parts.append(f"[{msg['role']}]: {msg['text'][:500]}\n")
        parts.append("")

    parts.append("""## Instructions

Based on the session activity above, return a JSON object with:
1. `completed_todo_ids`: IDs of existing todos that the sessions show are completed
2. `new_todos`: concrete actionable tasks. Each has `project_id`, `text`, and `completed` (boolean). For new projects not yet tracked, use project_id "NEW:<source_path>". There are two kinds:
   - **Completed work** (`completed: true`): things the user accomplished in their sessions. These are important for tracking what was done, even though they're already finished. Examples: "Implemented dark mode", "Fixed login timeout bug", "Refactored API routes to use versioning"
   - **Next steps** (`completed: false`): actionable tasks for future work. Prefix with "Next: " or "Consider: "
3. `project_summaries`: a dict mapping project_id to a 1-2 sentence summary of current work
4. `new_projects`: projects discovered in sessions but not yet in the project list. Each has `name` and `source_path`
5. `insights`: meta-level observations about workflow, patterns, or improvements — NOT tasks, but observations worth surfacing. Each has `project_id` (the project it relates to, or "" for general observations) and `text`. These are rare, high-value tips about how the user works with Claude or the project itself. Only include when genuinely useful — most analyses should return an empty list. Max 1-2 items. Examples: {"project_id": "proj_abc123", "text": "You're repeating the same debug cycle — consider adding a test first"}, {"project_id": "", "text": "Consider using consistent branch naming across projects"}
6. `modified_todos`: existing todos whose text or project assignment should change. Each has `id` and optionally `text` and/or `project_id`. Use sparingly — only when a todo is clearly outdated or mis-assigned.

Important:
- Always create completed todos for meaningful work done in sessions — this is how the user tracks accomplishments
- Only mark existing todos as completed (via completed_todo_ids) if the session clearly shows the work is done
- Keep todo text concise and actionable
- Don't duplicate existing todos or existing insights
- `new_todos` are tasks (things to do); `insights` are observations (things to know) — don't mix them

Return ONLY valid JSON, no markdown fences.""")

    return "\n".join(parts)


def _invoke_claude(prompt: str, model: str = "haiku") -> tuple["ClaudeAnalysisResult | None", dict]:
    """Call Claude CLI in print mode and parse the JSON response.

    Returns (result, usage_info) where usage_info contains cost/token data.
    """
    usage_info: dict = {}
    try:
        env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}
        result = subprocess.run(
            ["claude", "-p", "--output-format", "json", "--model", model],
            input=prompt,
            capture_output=True,
            text=True,
            timeout=120,
            env=env,
        )
        if result.returncode != 0:
            err = result.stderr[:500]
            log.error("Claude CLI failed (rc=%d): %s", result.returncode, err)
            return None, {"error": f"CLI failed (rc={result.returncode}): {err}"}

        # The output-format json wraps the response; extract the text content
        try:
            wrapper = json.loads(result.stdout)
            # claude --output-format json returns {"type":"result","result":"...","cost_usd":...,"usage":...}
            text = wrapper.get("result", result.stdout)
            # Extract usage metadata from the wrapper
            usage_info["cost_usd"] = wrapper.get("total_cost_usd", wrapper.get("cost_usd", 0.0))
            usage = wrapper.get("usage", {})
            usage_info["input_tokens"] = usage.get("input_tokens", 0)
            usage_info["output_tokens"] = usage.get("output_tokens", 0)
            usage_info["cache_read_tokens"] = usage.get("cache_read_input_tokens", 0)
            usage_info["duration_ms"] = wrapper.get("duration_ms", 0)
        except json.JSONDecodeError:
            text = result.stdout

        # Try to parse the actual analysis JSON from Claude's response
        # Strip markdown fences if present
        text = text.strip()
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)

        data = json.loads(text)
        return ClaudeAnalysisResult.model_validate(data), usage_info

    except subprocess.TimeoutExpired:
        log.error("Claude CLI timed out")
        return None, {"error": "Claude CLI timed out"}
    except (json.JSONDecodeError, Exception) as e:
        log.exception("Failed to parse Claude response: %s", e)
        return None, {"error": str(e)}


# ── Project ID resolution ─────────────────────────────────────


def _resolve_project_id(pid: str, projects: list["Project"]) -> str | None:
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


# ── Apply results ──────────────────────────────────────────────


def run_analysis(force: bool = False, model: str | None = None) -> AnalysisEntry | None:
    """Full analysis cycle: discover sessions, invoke Claude, apply results.

    Returns None if skipped (no changes since last run).
    Pass force=True to skip the staleness check (e.g. manual wake).
    If model is None, reads from metadata.analysis_model.
    """
    start = time.time()

    # Check if anything changed since last analysis
    if not force:
        latest_mtime = _latest_session_mtime()
        with StorageContext() as ctx:
            if latest_mtime > 0 and latest_mtime <= ctx.metadata.last_session_mtime:
                log.info("No session changes since last analysis, skipping")
                return None

    # Resolve model
    if model is None:
        with StorageContext() as ctx:
            model = ctx.metadata.analysis_model

    sessions = discover_sessions()
    if not sessions:
        entry = AnalysisEntry(
            duration_seconds=round(time.time() - start, 1),
            sessions_analyzed=0,
            summary="No active sessions found",
            model=model,
        )
        _record_entry(entry)
        return entry

    # Snapshot current state for the prompt
    with StorageContext() as ctx:
        store_snapshot = {
            "projects": [p.model_dump() for p in ctx.store.projects],
            "todos": [t.model_dump() for t in ctx.store.todos],
            "insights": [
                {"project_id": i.project_id, "text": i.text}
                for i in ctx.metadata.insights if not i.dismissed
            ],
        }

    prompt = _build_prompt(sessions, store_snapshot)
    # Track session files before/after so we can exclude the one claude -p creates
    before = _snapshot_self_sessions()
    result, usage_info = _invoke_claude(prompt, model=model)
    after = _snapshot_self_sessions()
    _self_session_files.update(after - before)

    if result is None:
        error_msg = usage_info.get("error", "Claude analysis failed — see logs")
        entry = AnalysisEntry(
            duration_seconds=round(time.time() - start, 1),
            sessions_analyzed=len(sessions),
            summary="Claude analysis failed — see logs",
            model=model,
            error=error_msg,
            prompt_length=len(prompt),
            cost_usd=usage_info.get("cost_usd", 0.0),
            input_tokens=usage_info.get("input_tokens", 0),
            output_tokens=usage_info.get("output_tokens", 0),
            cache_read_tokens=usage_info.get("cache_read_tokens", 0),
        )
        _record_entry(entry)
        return entry

    # Apply results
    todos_added = 0
    todos_completed = 0
    todos_modified = 0
    added_todo_texts: list[str] = []
    completed_todo_ids: list[str] = []
    modified_todo_texts: list[str] = []
    new_project_names: list[str] = []

    with StorageContext() as ctx:
        # Create new projects
        new_proj_map: dict[str, str] = {}  # source_path -> project_id
        for np in result.new_projects:
            # Check if already exists
            existing = next((p for p in ctx.store.projects if p.source_path == np.source_path), None)
            if existing:
                new_proj_map[np.source_path] = existing.id
            else:
                proj = Project(name=np.name, source_path=np.source_path)
                ctx.store.projects.append(proj)
                new_proj_map[np.source_path] = proj.id
                new_project_names.append(np.name)

        # Mark completed
        for tid in result.completed_todo_ids:
            for t in ctx.store.todos:
                if t.id == tid and not t.completed:
                    t.completed = True
                    t.completed_at = _now()
                    todos_completed += 1
                    completed_todo_ids.append(tid)

        # Repair orphaned todos (invalid project_id from prior analyses)
        valid_ids = {p.id for p in ctx.store.projects}
        for t in ctx.store.todos:
            if t.project_id not in valid_ids:
                resolved = _resolve_project_id(t.project_id, ctx.store.projects)
                if resolved:
                    log.warning("Repaired orphaned todo %s: %r -> %s", t.id, t.project_id, resolved)
                    t.project_id = resolved
                else:
                    log.warning("Cannot resolve orphaned todo %s project_id=%r", t.id, t.project_id)

        # Add new todos
        existing_texts = {(t.project_id, t.text.lower()) for t in ctx.store.todos}
        for nt in result.new_todos:
            pid = nt.project_id
            # Resolve "NEW:<path>" references
            if pid.startswith("NEW:"):
                path = pid[4:]
                pid = new_proj_map.get(path, "")
                if not pid:
                    continue

            # Resolve non-ID values (e.g. project names returned by Claude)
            if not pid.startswith("proj_"):
                resolved = _resolve_project_id(pid, ctx.store.projects)
                if resolved:
                    log.warning("Resolved project ref %r -> %s for new todo", pid, resolved)
                    pid = resolved
                else:
                    log.warning("Skipping new todo with unresolvable project_id=%r: %s", pid, nt.text)
                    continue

            if (pid, nt.text.lower()) in existing_texts:
                continue

            todo = Todo(project_id=pid, text=nt.text, source="claude")
            if nt.completed:
                todo.completed = True
                todo.completed_at = _now()
            ctx.store.todos.append(todo)
            todos_added += 1
            added_todo_texts.append(nt.text)

        # Modify existing todos
        todo_by_id = {t.id: t for t in ctx.store.todos}
        for mod in result.modified_todos:
            t = todo_by_id.get(mod.id)
            if t is None:
                log.warning("modified_todos: unknown todo id=%s, skipping", mod.id)
                continue
            changed = False
            if mod.text is not None and mod.text != t.text:
                t.text = mod.text
                changed = True
            if mod.project_id is not None and mod.project_id != t.project_id:
                resolved = _resolve_project_id(mod.project_id, ctx.store.projects)
                if resolved:
                    t.project_id = resolved
                    changed = True
                else:
                    log.warning("modified_todos: unresolvable project_id=%r for todo %s", mod.project_id, mod.id)
            if changed:
                todos_modified += 1
                modified_todo_texts.append(t.text)

        # Update summaries
        for pid, summary in result.project_summaries.items():
            ctx.metadata.project_summaries[pid] = summary

        # Persist new insights (dedup by project_id + text)
        existing_keys = {(i.project_id, i.text.lower()) for i in ctx.metadata.insights}
        for ci in result.insights:
            pid = ci.project_id
            if pid and not pid.startswith("proj_"):
                resolved = _resolve_project_id(pid, ctx.store.projects)
                if resolved:
                    pid = resolved
                else:
                    pid = ""
            if (pid, ci.text.lower()) not in existing_keys:
                ctx.metadata.insights.append(
                    Insight(project_id=pid, text=ci.text, source_analysis_timestamp=_now())
                )
                existing_keys.add((pid, ci.text.lower()))

    entry = AnalysisEntry(
        duration_seconds=round(time.time() - start, 1),
        sessions_analyzed=len(sessions),
        todos_added=todos_added,
        todos_completed=todos_completed,
        todos_modified=todos_modified,
        summary=f"Analyzed {len(sessions)} sessions: +{todos_added} todos, {todos_completed} completed, {todos_modified} modified",
        model=model,
        cost_usd=usage_info.get("cost_usd", 0.0),
        input_tokens=usage_info.get("input_tokens", 0),
        output_tokens=usage_info.get("output_tokens", 0),
        cache_read_tokens=usage_info.get("cache_read_tokens", 0),
        completed_todo_ids=completed_todo_ids,
        added_todos=added_todo_texts,
        modified_todos=modified_todo_texts,
        new_project_names=new_project_names,
        insights=[ci.text for ci in result.insights],
        prompt_length=len(prompt),
    )
    _record_entry(entry)
    return entry


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
