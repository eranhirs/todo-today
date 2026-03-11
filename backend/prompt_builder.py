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

log = logging.getLogger(__name__)


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

    # Only show todos relevant to the sessions being analyzed (or unlinked todos).
    # This prevents Claude from seeing todos for *other* sessions and creating
    # duplicates with slightly different wording.
    active_session_ids = {s["session_id"] for s in sessions}
    relevant_todos = [
        t for t in todos
        if t.get("status") != "rejected" and (not t.get("session_id") or t["session_id"] in active_session_ids)
    ]

    # Collect rejected todos separately — these inform Claude what NOT to re-suggest
    rejected_todos = [t for t in todos if t.get("status") == "rejected"]

    if relevant_todos:
        parts.append("## Current Todos for This Project\n")
        parts.append(json.dumps(relevant_todos, indent=2))
        parts.append("")

    if rejected_todos:
        parts.append("## Rejected Todos (DO NOT re-suggest these)\n")
        parts.append("The user explicitly rejected these ideas. Do not suggest them again or create new todos covering the same topics.\n")
        parts.append(json.dumps([{"id": t["id"], "text": t["text"]} for t in rejected_todos], indent=2))
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
2. `status_updates`: change the status of existing todos. Each has `id`, `status`, and an optional `reason`. Valid statuses: "next", "in_progress", "completed", "consider", "waiting", "stale". Do NOT use "rejected" — only the user can reject a todo. Use this for any status transition (e.g. marking something in_progress, stale, etc.). When setting status to "stale", always include a `reason` (a brief explanation of why the todo is no longer relevant, e.g. "Session moved past this", "Superseded by newer implementation", "Work was completed in a different approach").
3. `new_todos`: concrete actionable tasks. Each has `text`, `status` (one of: "next", "in_progress", "completed", "consider", "waiting", "stale"), and an optional `session_id` (the session ID that prompted this todo — include it for "waiting" todos so we can link back to the source session). All todos will be assigned to project {project.id} automatically — do NOT include a `project_id` field. There are several kinds:
   - **Completed work** (`status: "completed"`): ONLY for work accomplished in sessions that has NO corresponding existing todo. If an existing todo covers the same work, mark it completed via `completed_todo_ids` or `status_updates` instead — do NOT create a new todo that rephrases it.
   - **Next steps** (`status: "next"`): actionable tasks for future work
   - **Ideas** (`status: "consider"`): things worth evaluating but not yet committed to
   - Do NOT prefix todo text with "Next:", "Consider:", etc. — the `status` field handles this
4. `project_summaries`: a dict with a single entry: `{{"{project.id}": "1-2 sentence summary of current work"}}`
5. `insights`: critical observations that could change how the user works — NOT praise, NOT descriptions of what was done, NOT "nice pattern" commentary. Only flag problems, risks, or missed opportunities. Each has `text` only. Return an empty list unless you spot something genuinely wrong or risky. Max 1 item.
6. `modified_todos`: existing todos whose text or status should change. Each has `id` and optionally `text` and/or `status`. **Use this actively** — when a session progresses past what an existing todo describes, update or mark it stale rather than creating a new todo with slightly different wording.
7. `dismiss_insight_ids`: IDs of existing insights (from the Active Insights section above) that are no longer relevant — e.g. the issue was resolved, the risk no longer applies, or the insight is outdated given recent session activity. Only dismiss insights you're confident are stale.

Important:
- **NO duplicate completed todos.** When work is done that corresponds to an existing todo, mark that existing todo as completed via `completed_todo_ids` or `status_updates` — do NOT create a new completed todo that rephrases the same work. For example, if an existing todo says "Put the reject option as a status", do NOT create a new completed todo "Removed separate reject button — reject is now managed via status pills". Just mark the original as completed.
- **Only create new completed todos for work that has NO corresponding existing todo.** If a session accomplished something entirely new that isn't covered by any existing todo, then and only then create a new completed todo for it.
- **Do NOT rename todos to past tense.** When marking a todo as completed, leave its text as-is. The status field already indicates completion — rewriting "Add dark mode" to "Added dark mode" is unnecessary.
- **Adding emoji is always welcome.** Use `modified_todos` to add an emoji to any existing todo that lacks one, regardless of its status. This is purely cosmetic and does not count as a status change.
- Only mark existing todos as completed (via completed_todo_ids or status_updates) if the session clearly shows the work is done
- Keep todo text concise and actionable — no "Next:" or "Consider:" prefixes
- **Prefix every todo `text` with a single relevant emoji** that represents the nature of the work (e.g. 🐛 for bug fixes, ✨ for new features, ♻️ for refactoring, 🧪 for tests, 📝 for docs, 🔧 for config, 🎨 for styling, 🚀 for deployment, etc.). The emoji will be parsed out automatically.
- Only create a `"waiting"` todo when a session needs user action: `waiting_for_user` (Claude asked a question) or `waiting_for_tool_approval` (Claude wants to run a tool and needs approval). Use the format "Respond to Claude: <brief description of what it's asking or wants to do>". Do NOT create waiting todos for `active` sessions (a tool ran and Claude is continuing) — those don't need user action.
- Don't duplicate existing todos or existing insights
- **Rejected todos are off-limits.** If a todo appears in the "Rejected Todos" section, the user explicitly said no. Do NOT create new todos that cover the same idea, even with different wording. Do NOT include rejected todo IDs in any action list.
- **Supersession rule**: Before creating a `new_todo`, scan the existing todos list for any todo covering the same work (same session, same topic). If one exists: use `modified_todos` to update its text/status instead of creating a new one. If the old todo is now irrelevant (work completed or moved past it), use `status_updates` to mark it "stale" or "completed". Never leave multiple active todos for the same piece of work.
- **"Waiting" cleanup**: If a session's state has moved past `waiting_for_tool_approval` or `waiting_for_user`, mark any existing "waiting" todo for that session as "stale" via `status_updates`.
- `new_todos` are tasks (things to do); `insights` are observations (things to know) — don't mix them
- **Extract suggestions as todos**: When a session produces a list of concrete suggestions, ideas, or improvement proposals, extract each one as an individual `consider` todo. Don't summarize them as a single "review suggestions" item — the user wants each idea tracked separately so they can act on them independently.
- **Completed todos are permanent history.** NEVER mark a completed todo as "stale" — completed work must remain visible as a record of accomplishments. Do not include completed todo IDs in `status_updates` with status "stale" or in `modified_todos` with status "stale".
- **User-created todos (source="user") are protected.** The ONLY action you may take on them is setting their status to "stale" via `status_updates`. You CANNOT change their text or any other status. Do NOT include user-created todo IDs in `completed_todo_ids` or `modified_todos`.

First, write a brief analysis of what you observe in the sessions (2-4 sentences). Then output the JSON inside a ```json fenced code block.""")

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
