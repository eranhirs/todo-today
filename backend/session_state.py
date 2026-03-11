"""Session state detection for Claude Code sessions."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path

from .hook_state import get_hook_state

log = logging.getLogger(__name__)


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


def _detect_session_state(path: Path, session_key: str = None) -> dict:
    """Classify the current state of a session by inspecting the last few JSONL entries.

    If hook state exists for this session, it takes priority over JSONL heuristics.

    Returns {"state": str, "last_assistant_text": str | None, "state_source": str}.
    States: "ended", "waiting_for_user", "waiting_for_tool_approval",
            "tool_running", "waiting_for_response", "unknown".
    """
    # Check hook state first (strictly more accurate than JSONL heuristics)
    if session_key:
        hook = get_hook_state(session_key)
        if hook and "state" in hook:
            hook_state = hook["state"]
            # For waiting states, verify the session hasn't progressed past the hook
            if hook_state in ("waiting_for_user", "waiting_for_tool_approval"):
                from .hook_state import _is_waiting_state_stale
                if _is_waiting_state_stale(session_key, hook):
                    pass  # stale — fall through to JSONL heuristic
                else:
                    result = {
                        "state": hook_state,
                        "last_assistant_text": None,
                        "state_source": "hook",
                    }
                    if hook.get("tool_name"):
                        result["detail"] = f"Claude wants to use {hook['tool_name']}"
                    return result
            else:
                return {
                    "state": hook_state,
                    "last_assistant_text": None,
                    "state_source": "hook",
                }

    # Fall through to JSONL heuristic
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
        return {"state": "unknown", "last_assistant_text": None, "state_source": "jsonl"}

    if not tail_entries:
        return {"state": "unknown", "last_assistant_text": None, "state_source": "jsonl"}

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
                return {"state": "tool_running", "last_assistant_text": last_assistant_text, "detail": detail, "state_source": "jsonl"}

            # For tools that *could* need approval, use timestamp as confirmation.
            # If >60s old with no result, it's stuck waiting for the user.
            entry_ts = last.get("timestamp", "")
            age_seconds = None
            if entry_ts:
                try:
                    ts = datetime.fromisoformat(entry_ts.replace("Z", "+00:00"))
                    age_seconds = (datetime.now(timezone.utc) - ts).total_seconds()
                except (ValueError, TypeError):
                    pass

            if age_seconds is not None and age_seconds > 60:
                return {"state": "waiting_for_tool_approval", "last_assistant_text": last_assistant_text, "detail": detail, "state_source": "jsonl"}
            else:
                return {"state": "tool_running", "last_assistant_text": last_assistant_text, "detail": detail, "state_source": "jsonl"}
        if stop_reason == "end_turn":
            # Check if the last text ends with a question mark
            if last_assistant_text and last_assistant_text.rstrip().endswith("?"):
                return {"state": "waiting_for_user", "last_assistant_text": last_assistant_text, "state_source": "jsonl"}
            return {"state": "ended", "last_assistant_text": last_assistant_text, "state_source": "jsonl"}

    if last_type == "user":
        # Check if this is a tool_result (tool ran, Claude hasn't responded yet)
        if isinstance(content, list):
            has_tool_result = any(
                isinstance(block, dict) and block.get("type") == "tool_result"
                for block in content
            )
            if has_tool_result:
                return {"state": "waiting_for_response", "last_assistant_text": last_assistant_text, "state_source": "jsonl"}

    return {"state": "unknown", "last_assistant_text": last_assistant_text, "state_source": "jsonl"}


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
