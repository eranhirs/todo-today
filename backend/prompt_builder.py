"""Build analysis prompts and invoke Claude CLI."""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import uuid as _uuid

from .models import ClaudeAnalysisResult, Project
from .session_state import _format_session_state_line
from .storage import StorageContext
from .tags import parse_tags

log = logging.getLogger(__name__)


_TODO_FIELDS_TO_STRIP = {
    "run_output", "run_pid", "run_output_file", "btw_output", "btw_pid",
    "btw_output_file", "btw_session_id", "pending_followup", "pending_followup_images",
    "pending_followup_plan_only", "pending_btw", "run_flush_lines", "images",
    "red_flags", "plan_file", "session_msg_count",
}


def _slim_todo(t: dict) -> dict:
    """Strip large/internal fields from a todo dict before including in prompt."""
    return {k: v for k, v in t.items() if k not in _TODO_FIELDS_TO_STRIP and v is not None}


# Static instructions placed at the beginning of every prompt for cache-friendliness.
# The Claude API caches matching prefixes, so keeping this identical across calls
# means only the dynamic data (todos, sessions) costs fresh input tokens.
_STATIC_INSTRUCTIONS = """You analyze Claude Code sessions to update a todo list. Return a JSON object with these fields:

1. `completed_todo_ids`: IDs of todos the sessions show are done.
2. `status_updates`: [{id, status, reason?}]. Statuses: "next","in_progress","completed","consider","waiting","stale". Never use "rejected". Include `reason` when setting "stale".
3. `new_todos`: [{text, status, session_id?}]. Auto-assigned to the project. Types: "completed" (only if NO existing todo covers this work), "next" (actionable), "consider" (ideas). No "Next:"/"Consider:" prefixes.
4. `project_summaries`: {project_id: "1-2 sentence summary"}.
5. `insights`: problems/risks/missed opportunities only (not praise). [{text}]. Max 1. Empty list if nothing wrong.
6. `modified_todos`: [{id, text?, status?}]. Use actively — update existing todos rather than creating new ones with different wording.
7. `dismiss_insight_ids`: IDs of stale insights to dismiss.
8. `red_flags`: [{todo_id, label, explanation}]. Label = generic anti-pattern name (e.g. "Over-engineering", "Scope creep", "Silent failure"). Only flag genuine problems.

## Rules (ranked by importance)

1. **NEVER duplicate.** Before creating any new_todo, scan ALL existing todos. If one covers the same work (even approximately), use modified_todos or status_updates instead. This is the most important rule.
2. **Rejected todos are off-limits.** Never re-suggest them or include their IDs in any action.
3. **User-created todos (source="user") are protected.** Only action allowed: set status to "stale" via status_updates. Cannot change text or mark completed.
4. **Completed todos are permanent.** Never mark completed todos as "stale".
5. **Don't rename to past tense.** "Add dark mode" stays "Add dark mode" when completed.
6. **Prefix todo text with a relevant emoji** (🐛 bug, ✨ feature, ♻️ refactor, 🧪 test, 📝 docs, etc.).
7. **Use existing hashtags only.** Append relevant ones from the Existing Hashtags list. Don't invent new ones. Preserve existing hashtags when modifying text.
8. **Add emoji/hashtags to existing todos** via modified_todos when they lack them.
9. **"waiting" todos** only for sessions needing user action (waiting_for_user or waiting_for_tool_approval). Format: "Respond to Claude: <description>". Clean up stale waiting todos.
10. **Extract suggestions individually** as separate "consider" todos, not as a single "review suggestions" item.
11. **Todos vs insights**: new_todos = tasks to do; insights = things to know. Don't mix.

Write a brief analysis (2-4 sentences), then output JSON in a ```json fenced code block."""


def _build_project_prompt(
    project: "Project",
    todos: list[dict],
    insights: list[dict],
    sessions: list[dict],
) -> str:
    """Build an analysis prompt scoped to a single project.

    Structure: static instructions first (cache-friendly prefix), then dynamic data.
    """
    parts = [_STATIC_INSTRUCTIONS, ""]

    parts.append(f"## Project: {project.name} (ID: {project.id})\nSource: {project.source_path}\n")

    # Only show todos relevant to the sessions being analyzed (or unlinked todos).
    active_session_ids = {s["session_id"] for s in sessions}
    relevant_todos = [
        _slim_todo(t) for t in todos
        if t.get("status") != "rejected" and (not t.get("session_id") or t["session_id"] in active_session_ids)
    ]

    rejected_todos = [t for t in todos if t.get("status") == "rejected"]

    if relevant_todos:
        parts.append("## Current Todos\n")
        parts.append(json.dumps(relevant_todos, indent=2))
        parts.append("")

    if rejected_todos:
        parts.append("## Rejected Todos (DO NOT re-suggest)\n")
        parts.append(json.dumps([{"id": t["id"], "text": t["text"]} for t in rejected_todos], indent=2))
        parts.append("")

    all_tags: set[str] = set()
    for t in todos:
        all_tags.update(parse_tags(t.get("text", "")))
    if all_tags:
        parts.append("## Existing Hashtags\n")
        parts.append(" ".join(f"#{tag}" for tag in sorted(all_tags)))
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

    return "\n".join(parts)


def _invoke_claude(prompt: str, model: str = "haiku") -> tuple["ClaudeAnalysisResult | None", dict]:
    """Call Claude CLI in print mode and parse the JSON response.

    Returns (result, usage_info) where usage_info contains cost/token data.
    The session ID is included in usage_info["session_id"] for exclusion tracking.
    """
    usage_info: dict = {}
    session_id = str(_uuid.uuid4())
    usage_info["session_id"] = session_id
    # Persist the session ID BEFORE spawning claude, so hook events from this
    # subprocess are filtered immediately (avoids race with SessionEnd hook).
    with StorageContext() as ctx:
        ctx.metadata.analysis_session_ids.append(session_id)
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
