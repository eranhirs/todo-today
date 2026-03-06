"""Discover Claude Code sessions from ~/.claude/projects/ and analyze them."""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import time
import uuid as _uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .models import (
    AnalysisEntry,
    ClaudeAnalysisResult,
    ClaudeNewTodo,
    ClaudeTodoStatusUpdate,
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


def _load_analysis_session_ids() -> set[str]:
    """Load persisted analysis session IDs from metadata."""
    with StorageContext() as ctx:
        return set(ctx.metadata.analysis_session_ids)


def _is_analysis_session(session_id: str, analysis_ids: set[str]) -> bool:
    """Check if a session was created by our analysis subprocess."""
    return session_id in analysis_ids


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
    analysis_ids = _load_analysis_session_ids()
    cutoff = datetime.now(timezone.utc) - SESSION_MAX_AGE
    latest = 0.0
    for proj_dir in CLAUDE_DIR.iterdir():
        if not proj_dir.is_dir():
            continue
        for jsonl_file in proj_dir.glob("*.jsonl"):
            if _is_analysis_session(jsonl_file.stem, analysis_ids):
                continue
            mtime = jsonl_file.stat().st_mtime
            if datetime.fromtimestamp(mtime, tz=timezone.utc) >= cutoff:
                latest = max(latest, mtime)
    return latest


def discover_sessions(max_age: timedelta | None = SESSION_MAX_AGE) -> list[dict]:
    """Return a list of recent sessions with their messages.

    Each entry: {"project_dir": str, "source_path": str, "session_id": str,
                 "mtime": float, "messages": [...]}

    When max_age is None, no age cutoff is applied (discover all sessions).
    """
    if not CLAUDE_DIR.is_dir():
        log.warning("Claude projects dir not found: %s", CLAUDE_DIR)
        return []

    analysis_ids = _load_analysis_session_ids()
    cutoff = datetime.now(timezone.utc) - max_age if max_age is not None else None
    sessions = []

    for proj_dir in CLAUDE_DIR.iterdir():
        if not proj_dir.is_dir():
            continue
        source_path = _decode_project_dir(proj_dir.name)

        for jsonl_file in proj_dir.glob("*.jsonl"):
            if _is_analysis_session(jsonl_file.stem, analysis_ids):
                continue
            stat_mtime = jsonl_file.stat().st_mtime
            # Check modification time
            if cutoff is not None:
                mtime_dt = datetime.fromtimestamp(stat_mtime, tz=timezone.utc)
                if mtime_dt < cutoff:
                    continue

            messages = _parse_session_messages(jsonl_file)
            if messages:
                state_info = _detect_session_state(jsonl_file)
                sessions.append({
                    "project_dir": proj_dir.name,
                    "source_path": source_path,
                    "session_id": jsonl_file.stem,
                    "mtime": stat_mtime,
                    "messages": messages,
                    "state": state_info["state"],
                    "state_info": state_info,
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


def _tool_needs_approval(tool_name: str | None, permission_mode: str) -> bool:
    """Determine if a tool likely needs user approval given the permission mode.

    Based on empirical analysis of session data:
    - Read-only tools (Read, Glob, Grep) always auto-approve
    - Edit/Write always auto-approve (even in 'acceptEdits' — that's what the mode means)
    - Task tools always auto-approve
    - Bash: auto-approves in bypassPermissions, needs approval in default/acceptEdits
    - ExitPlanMode/AskUserQuestion: always need user action
    """
    if tool_name is None:
        return True  # Unknown tool — assume it needs approval

    if tool_name in _AUTO_APPROVE_TOOLS:
        return False

    if tool_name in _ALWAYS_APPROVAL_TOOLS:
        return True

    # Bash (and any other unrecognized tool): depends on permission mode
    if permission_mode == "bypassPermissions":
        return False

    return True  # default/acceptEdits/plan — Bash and unknowns likely need approval


# Tools that never require user approval regardless of permission mode.
_AUTO_APPROVE_TOOLS = frozenset({
    "Read", "Glob", "Grep", "Edit", "Write",
    "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskStop",
    "EnterPlanMode", "NotebookEdit", "TodoRead", "TodoWrite",
})

# Tools that always require user action.
_ALWAYS_APPROVAL_TOOLS = frozenset({
    "ExitPlanMode", "AskUserQuestion",
})


def _detect_session_state(path: Path) -> dict:
    """Classify the current state of a session by inspecting the last few JSONL entries.

    Returns {"state": str, "last_assistant_text": str | None}.
    States: "ended", "waiting_for_user", "waiting_for_tool_approval",
            "tool_running", "waiting_for_response", "unknown".
    """
    # Read last ~10 entries (all types) to get permissionMode + user/assistant context
    tail_entries: list[dict] = []
    last_permission_mode: str = "default"
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
                # Track the most recent permissionMode from any user entry
                pm = entry.get("permissionMode")
                if pm:
                    last_permission_mode = pm
                if entry.get("type") in ("user", "assistant"):
                    tail_entries.append(entry)
                    if len(tail_entries) > 10:
                        tail_entries.pop(0)
    except Exception:
        log.exception("Error reading session file for state detection: %s", path)
        return {"state": "unknown", "last_assistant_text": None}

    if not tail_entries:
        return {"state": "unknown", "last_assistant_text": None}

    last = tail_entries[-1]
    last_type = last.get("type")
    msg = last.get("message", {})
    content = msg.get("content", [])
    stop_reason = msg.get("stop_reason")

    # Extract last text block from last assistant message (for context)
    last_assistant_text = None
    for entry in reversed(tail_entries):
        if entry.get("type") == "assistant":
            c = entry.get("message", {}).get("content", [])
            if isinstance(c, list):
                for block in reversed(c):
                    if isinstance(block, dict) and block.get("type") == "text" and block.get("text", "").strip():
                        last_assistant_text = block["text"].strip()[-200:]
                        break
            elif isinstance(c, str) and c.strip():
                last_assistant_text = c.strip()[-200:]
            if last_assistant_text:
                break

    if last_type == "assistant":
        if stop_reason == "tool_use":
            tool_name = None
            if isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "tool_use":
                        tool_name = block.get("name", "a tool")
            detail = f"Claude wants to use {tool_name}" if tool_name else "Claude requested a tool"

            # Determine if this tool needs approval based on tool name + permission mode
            needs_approval = _tool_needs_approval(tool_name, last_permission_mode)

            if not needs_approval:
                # This tool auto-approves — it's running, not waiting for user
                return {"state": "tool_running", "last_assistant_text": last_assistant_text, "detail": detail}

            # For tools that *could* need approval, use timestamp as confirmation.
            # If >60s old with no result, it's stuck waiting for the user.
            entry_ts = last.get("timestamp", "")
            age_seconds = None
            if entry_ts:
                try:
                    from datetime import datetime, timezone
                    ts = datetime.fromisoformat(entry_ts.replace("Z", "+00:00"))
                    age_seconds = (datetime.now(timezone.utc) - ts).total_seconds()
                except (ValueError, TypeError):
                    pass

            if age_seconds is not None and age_seconds > 60:
                return {"state": "waiting_for_tool_approval", "last_assistant_text": last_assistant_text, "detail": detail}
            else:
                return {"state": "tool_running", "last_assistant_text": last_assistant_text, "detail": detail}
        if stop_reason == "end_turn":
            # Check if the last text ends with a question mark
            if last_assistant_text and last_assistant_text.rstrip().endswith("?"):
                return {"state": "waiting_for_user", "last_assistant_text": last_assistant_text}
            return {"state": "ended", "last_assistant_text": last_assistant_text}

    if last_type == "user":
        # Check if this is a tool_result (tool ran, Claude hasn't responded yet)
        if isinstance(content, list):
            has_tool_result = any(
                isinstance(block, dict) and block.get("type") == "tool_result"
                for block in content
            )
            if has_tool_result:
                return {"state": "waiting_for_response", "last_assistant_text": last_assistant_text}

    return {"state": "unknown", "last_assistant_text": last_assistant_text}


def _format_session_state_line(state_info: dict) -> str:
    """Format a session state dict into a line for the prompt."""
    state = state_info["state"]
    text = state_info.get("last_assistant_text")
    detail = state_info.get("detail")

    if state == "ended":
        return "[Session state: ended]"
    elif state == "waiting_for_user":
        snippet = text[:100] if text else "?"
        return f'[Session state: waiting_for_user — last assistant message: "{snippet}"]'
    elif state == "waiting_for_tool_approval":
        ctx = detail or "Claude wants to use a tool"
        return f"[Session state: waiting_for_tool_approval — {ctx}. User must approve/deny to continue]"
    elif state == "tool_running":
        ctx = detail or "Claude is running a tool"
        return f"[Session state: active — {ctx}. Tool is currently executing, NO user action needed]"
    elif state == "waiting_for_response":
        return "[Session state: active — a tool ran, Claude is continuing. NO user action needed]"
    else:
        return "[Session state: unknown]"


def _session_key(sess: dict) -> str:
    """Return a unique key for a session: 'project_dir/session_id'."""
    return f"{sess['project_dir']}/{sess['session_id']}"


def filter_changed_sessions(
    sessions: list[dict], last_mtimes: dict[str, float]
) -> list[dict]:
    """Keep only sessions whose file mtime exceeds the last-analyzed mtime."""
    changed = []
    for s in sessions:
        key = _session_key(s)
        stored = last_mtimes.get(key)
        if stored is None or s["mtime"] > stored:
            changed.append(s)
    return changed


def list_all_sessions() -> list[dict]:
    """Return lightweight metadata for all sessions (no age cutoff, no messages)."""
    if not CLAUDE_DIR.is_dir():
        return []

    analysis_ids = _load_analysis_session_ids()
    sessions = []
    for proj_dir in CLAUDE_DIR.iterdir():
        if not proj_dir.is_dir():
            continue
        source_path = _decode_project_dir(proj_dir.name)
        project_name = _extract_project_name(source_path)

        for jsonl_file in proj_dir.glob("*.jsonl"):
            if _is_analysis_session(jsonl_file.stem, analysis_ids):
                continue
            stat_mtime = jsonl_file.stat().st_mtime
            # Count messages (lightweight — just count qualifying lines)
            msg_count = 0
            try:
                with open(jsonl_file) as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            entry = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        if entry.get("type") in ("user", "assistant"):
                            msg_count += 1
            except Exception:
                pass

            state_info = _detect_session_state(jsonl_file)
            sessions.append({
                "key": f"{proj_dir.name}/{jsonl_file.stem}",
                "project_dir": proj_dir.name,
                "source_path": source_path,
                "project_name": project_name,
                "session_id": jsonl_file.stem,
                "mtime": stat_mtime,
                "message_count": msg_count,
                "state": state_info["state"],
            })

    sessions.sort(key=lambda s: s["mtime"], reverse=True)
    return sessions


# ── Session → Project matching ─────────────────────────────────


def _match_sessions_to_projects(
    sessions: list[dict], ctx: "StorageContext"
) -> dict[str, list[dict]]:
    """Map sessions to project IDs by matching source_path.

    Sessions whose source_path doesn't match any existing project cause a new
    project to be auto-created.  Returns ``{project_id: [sessions...]}``.
    """
    # Build lookup: source_path → project_id
    path_to_pid: dict[str, str] = {}
    for p in ctx.store.projects:
        if p.source_path:
            path_to_pid[p.source_path] = p.id

    result: dict[str, list[dict]] = {}
    for sess in sessions:
        sp = sess["source_path"]
        pid = path_to_pid.get(sp)
        if pid is None:
            # Auto-create project
            proj = Project(name=_extract_project_name(sp), source_path=sp)
            ctx.store.projects.append(proj)
            path_to_pid[sp] = proj.id
            pid = proj.id
            log.info("Auto-created project %s (%s) for unmatched session", proj.name, proj.id)
        result.setdefault(pid, []).append(sess)
    return result


# ── Per-project prompt ─────────────────────────────────────────


def _build_project_prompt(
    project: "Project",
    todos: list[dict],
    insights: list[dict],
    sessions: list[dict],
) -> str:
    """Build an analysis prompt scoped to a single project."""
    parts = ["You are analyzing Claude Code sessions to update a todo list.\n"]

    parts.append(f"## Project\n")
    parts.append(f"ID: {project.id}")
    parts.append(f"Name: {project.name}")
    parts.append(f"Source: {project.source_path}\n")

    if todos:
        parts.append("## Current Todos for This Project\n")
        parts.append(json.dumps(todos, indent=2))
        parts.append("")

    if insights:
        parts.append("## Active Insights\n")
        parts.append(json.dumps(insights, indent=2))
        parts.append("")

    parts.append("## Recent Session Activity\n")
    for sess in sessions:
        parts.append(f"### Session: {sess['session_id']}\n")
        for msg in sess["messages"]:
            parts.append(f"[{msg['role']}]: {msg['text'][:500]}\n")
        state_info = sess.get("state_info")
        if state_info:
            parts.append(_format_session_state_line(state_info))
        parts.append("")

    parts.append(f"""## Instructions

You are analyzing sessions for project "{project.name}" (ID: {project.id}).

Based on the session activity above, return a JSON object with:
1. `completed_todo_ids`: IDs of existing todos that the sessions show are completed (backward compat shortcut — these get status set to "completed")
2. `status_updates`: change the status of existing todos. Each has `id` and `status`. Valid statuses: "next", "in_progress", "completed", "consider", "waiting", "stale". Use this for any status transition (e.g. marking something in_progress, stale, etc.)
3. `new_todos`: concrete actionable tasks. Each has `text`, `status` (one of: "next", "in_progress", "completed", "consider", "waiting", "stale"), and an optional `session_id` (the session ID that prompted this todo — include it for "waiting" todos so we can link back to the source session). All todos will be assigned to project {project.id} automatically — do NOT include a `project_id` field. There are two kinds:
   - **Completed work** (`status: "completed"`): things the user accomplished in their sessions. These are important for tracking what was done, even though they're already finished. Examples: "Implemented dark mode", "Fixed login timeout bug", "Refactored API routes to use versioning"
   - **Next steps** (`status: "next"`): actionable tasks for future work
   - **Ideas** (`status: "consider"`): things worth evaluating but not yet committed to
   - Do NOT prefix todo text with "Next:", "Consider:", etc. — the `status` field handles this
4. `project_summaries`: a dict with a single entry: `{{"{project.id}": "1-2 sentence summary of current work"}}`
5. `insights`: critical observations that could change how the user works — NOT praise, NOT descriptions of what was done, NOT "nice pattern" commentary. Only flag problems, risks, or missed opportunities. Each has `text` only. Return an empty list unless you spot something genuinely wrong or risky. Max 1 item.
6. `modified_todos`: existing todos whose text or status should change. Each has `id` and optionally `text` and/or `status`. Use sparingly — only when a todo is clearly outdated.

Important:
- Always create completed todos for meaningful work done in sessions — this is how the user tracks accomplishments
- Only mark existing todos as completed (via completed_todo_ids or status_updates) if the session clearly shows the work is done
- Keep todo text concise and actionable — no "Next:" or "Consider:" prefixes
- Only create a `"waiting"` todo when a session needs user action: `waiting_for_user` (Claude asked a question) or `waiting_for_tool_approval` (Claude wants to run a tool and needs approval). Use the format "Respond to Claude: <brief description of what it's asking or wants to do>". Do NOT create waiting todos for `active` sessions (a tool ran and Claude is continuing) — those don't need user action.
- Don't duplicate existing todos or existing insights
- `new_todos` are tasks (things to do); `insights` are observations (things to know) — don't mix them
- **User-created todos (source="user") are protected.** The ONLY action you may take on them is setting their status to "stale" via `status_updates`. You CANNOT change their text or any other status. Do NOT include user-created todo IDs in `completed_todo_ids` or `modified_todos`.

First, write a brief analysis of what you observe in the sessions (2-4 sentences). Then output the JSON inside a ```json fenced code block.""")

    return "\n".join(parts)


# ── Claude invocation ──────────────────────────────────────────



def _invoke_claude(prompt: str, model: str = "haiku") -> tuple["ClaudeAnalysisResult | None", dict]:
    """Call Claude CLI in print mode and parse the JSON response.

    Returns (result, usage_info) where usage_info contains cost/token data.
    The session ID is included in usage_info["session_id"] for exclusion tracking.
    """
    usage_info: dict = {}
    session_id = _uuid.uuid4().hex
    usage_info["session_id"] = session_id
    try:
        env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}
        result = subprocess.run(
            ["claude", "-p", "--output-format", "json", "--model", model,
             "--session-id", session_id],
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

        # Split reasoning from JSON.  The prompt asks Claude to write a brief
        # analysis first, then output JSON in a ```json fenced block.
        text = text.strip()
        fence_match = re.search(r"```(?:json)?\s*\n(.*?)\n\s*```", text, re.DOTALL)
        if fence_match:
            reasoning = text[: fence_match.start()].strip()
            json_text = fence_match.group(1).strip()
        else:
            # Fallback: no fenced block, try to parse the whole thing as JSON
            reasoning = ""
            json_text = text
            json_text = re.sub(r"^```(?:json)?\s*", "", json_text)
            json_text = re.sub(r"\s*```$", "", json_text)

        usage_info["claude_response"] = text
        usage_info["claude_reasoning"] = reasoning
        data = json.loads(json_text)
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


# ── Apply results (per-project) ────────────────────────────────


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

    # Mark completed (backward compat: completed_todo_ids → status="completed")
    for tid in result.completed_todo_ids:
        if tid not in project_todo_ids:
            log.warning("completed_todo_ids: todo %s not in project %s, skipping", tid, project_id)
            continue
        for t in ctx.store.todos:
            if t.id == tid and t.status != "completed":
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
        if t.source == "user" and su.status != "stale":
            log.warning("status_updates: skipping non-stale status %r for user todo %s", su.status, su.id)
            continue
        if t.status == su.status:
            continue
        was_completed = t.status == "completed"
        t.status = su.status
        if su.status == "completed" and not was_completed:
            t.completed_at = _now()
            counters.todos_completed += 1
            counters.completed_todo_ids.append(su.id)
            counters.completed_todo_texts.append(t.text)
        elif su.status != "completed" and was_completed:
            t.completed_at = None
        counters.todos_modified += 1
        counters.modified_todo_texts.append(t.text)

    # Add new todos — project_id is set automatically
    existing_texts = {(t.project_id, t.text.lower()) for t in ctx.store.todos}
    for nt in result.new_todos:
        # Strip leftover "Next:"/"Consider:" prefixes defensively
        text = re.sub(r"^(Next|Consider|Waiting|Stale):\s*", "", nt.text, flags=re.IGNORECASE)

        # Drop waiting todos for sessions that don't need user action
        if nt.status == "waiting" and nt.session_id and nt.session_id not in _actionable_sessions:
            log.info("Dropping waiting todo for non-actionable session %s: %s", nt.session_id, text)
            continue

        if (project_id, text.lower()) in existing_texts:
            continue

        todo = Todo(project_id=project_id, text=text, status=nt.status, source="claude", session_id=nt.session_id)
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
        if mod.status is not None and mod.status != t.status:
            was_completed = t.status == "completed"
            t.status = mod.status
            if mod.status == "completed" and not was_completed:
                t.completed_at = _now()
            elif mod.status != "completed" and was_completed:
                t.completed_at = None
            changed = True
        if changed:
            counters.todos_modified += 1
            counters.modified_todo_texts.append(t.text)

    # Update summaries
    for pid, summary in result.project_summaries.items():
        # Resolve in case Claude used project name instead of ID
        resolved = _resolve_project_id(pid, ctx.store.projects)
        ctx.metadata.project_summaries[resolved or pid] = summary

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


# ── Main analysis loop ─────────────────────────────────────────


def run_analysis(
    force: bool = False,
    model: str | None = None,
    session_keys: list[str] | None = None,
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
        with StorageContext() as ctx:
            model = ctx.metadata.analysis_model

    # When specific sessions are requested, discover all and filter to those keys
    if session_keys is not None:
        sessions = discover_sessions(max_age=None)
        key_set = set(session_keys)
        sessions = [s for s in sessions if _session_key(s) in key_set]
    else:
        # Check if anything changed since last analysis (coarse check)
        if not force:
            latest_mtime = _latest_session_mtime()
            with StorageContext() as ctx:
                if latest_mtime > 0 and latest_mtime <= ctx.metadata.last_session_mtime:
                    log.info("No session changes since last analysis, skipping")
                    return None

        sessions = discover_sessions()

        # Per-session mtime filter: skip unchanged sessions (unless force)
        if not force and sessions:
            with StorageContext() as ctx:
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
                {"text": i.text}
                for i in ctx.metadata.insights
                if not i.dismissed and (i.project_id == pid or i.project_id == "")
            ]
            proj_snapshots[pid] = (project, proj_todos, proj_insights, proj_sess)

    # ── Phase 2: call Claude (no lock held) ──
    new_analysis_session_ids: list[str] = []
    invoke_results: list[tuple[str, object, dict, str]] = []
    for pid, (project, proj_todos, proj_insights, proj_sess) in proj_snapshots.items():
        prompt = _build_project_prompt(project, proj_todos, proj_insights, proj_sess)
        all_prompts.append(f"--- Project: {project.name} ({pid}) ---\n{prompt}")

        result, usage_info = _invoke_claude(prompt, model=model)
        if usage_info.get("session_id"):
            new_analysis_session_ids.append(usage_info["session_id"])

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

    # Persist per-session mtimes and analysis session IDs
    with StorageContext() as ctx:
        for s in sessions:
            ctx.metadata.session_mtimes[_session_key(s)] = s["mtime"]
        if new_analysis_session_ids:
            ctx.metadata.analysis_session_ids.extend(new_analysis_session_ids)

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
