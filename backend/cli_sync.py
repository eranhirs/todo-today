"""Sync CLI-resumed session output back to todo run_output.

When a user clicks "Resume in CLI" and continues a todo's session interactively,
new messages are appended to the session JSONL file. This module detects those
new messages and appends them to the todo's run_output so they appear in the UI.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from .event_bus import EventType, bus
from .run_manager import cap_output
from .storage import StorageContext

log = logging.getLogger(__name__)

_CLAUDE_PROJECTS = Path.home() / ".claude" / "projects"


def _read_session_messages(jsonl_path: Path) -> list[dict]:
    """Read all user/assistant entries from a session JSONL file.

    Returns a list of dicts with keys: role, content_blocks, timestamp.
    content_blocks is the raw content list from the JSONL entry.
    """
    messages: list[dict] = []
    try:
        with open(jsonl_path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if entry.get("type") not in ("user", "assistant"):
                    continue
                msg = entry.get("message", {})
                role = msg.get("role")
                content = msg.get("content")
                if not role or not content:
                    continue
                messages.append({
                    "role": role,
                    "content": content,
                    "timestamp": entry.get("timestamp", ""),
                })
    except Exception:
        log.debug("Could not read session JSONL: %s", jsonl_path, exc_info=True)
    return messages


def _format_content_blocks(content) -> str:
    """Format JSONL content blocks into readable text.

    Handles text blocks, tool_use blocks (commands, edits, reads), and strings.
    """
    if isinstance(content, str):
        return content

    if not isinstance(content, list):
        return ""

    parts: list[str] = []
    for block in content:
        if isinstance(block, str):
            parts.append(block)
        elif isinstance(block, dict):
            btype = block.get("type", "")
            if btype == "text":
                parts.append(block.get("text", ""))
            elif btype == "tool_use":
                name = block.get("name", "")
                inp = block.get("input", {})
                if name == "Bash" or name == "bash":
                    cmd = inp.get("command", "")
                    parts.append(f"$ {cmd}")
                elif name == "Edit" or name == "edit":
                    fp = inp.get("file_path", "")
                    parts.append(f"[Edit: {fp}]")
                elif name == "Read" or name == "read":
                    fp = inp.get("file_path", "")
                    parts.append(f"[Read: {fp}]")
                elif name == "Write" or name == "write":
                    fp = inp.get("file_path", "")
                    parts.append(f"[Write: {fp}]")
                elif name == "Grep" or name == "grep":
                    pat = inp.get("pattern", "")
                    parts.append(f"[Grep: {pat}]")
                elif name == "Glob" or name == "glob":
                    pat = inp.get("pattern", "")
                    parts.append(f"[Glob: {pat}]")
                else:
                    parts.append(f"[{name}]")
            elif btype == "tool_result":
                pass  # skip tool results — too verbose
    return "\n".join(parts)


def _format_new_messages(messages: list[dict]) -> str:
    """Format new messages as follow-up-style blocks.

    Groups messages into (user, assistant+) pairs, each rendered as:
      \\n\\n--- Resumed in CLI ---\\n**You:** {user_text}\\n\\n{assistant_text}

    This matches the follow-up separator format that the frontend parses.
    """
    blocks: list[str] = []
    current_user: str | None = None
    current_assistant_parts: list[str] = []

    def flush():
        nonlocal current_user, current_assistant_parts
        if current_user is not None:
            assistant_text = "\n\n".join(current_assistant_parts)
            block = f"\n\n--- Resumed in CLI ---\n**You:** {current_user}\n\n"
            if assistant_text:
                block += assistant_text
            blocks.append(block)
        current_user = None
        current_assistant_parts = []

    for msg in messages:
        role = msg["role"]
        text = _format_content_blocks(msg["content"])
        if not text.strip():
            continue
        if role == "user":
            flush()
            current_user = text.strip()
        else:
            current_assistant_parts.append(text)

    flush()
    return "".join(blocks)


def sync_cli_sessions() -> int:
    """Detect new messages in session JSONL files and append to todo run_output.

    Returns the number of todos that were updated.
    """
    updated = 0

    with StorageContext(read_only=True) as ctx:
        todos_to_check = []
        projects = {p.id: p for p in ctx.store.projects}
        for t in ctx.store.todos:
            if not t.session_id:
                continue
            if t.run_status in ("running", "queued"):
                continue
            proj = projects.get(t.project_id)
            if not proj or not proj.source_path:
                continue
            todos_to_check.append({
                "id": t.id,
                "session_id": t.session_id,
                "source_path": proj.source_path,
                "session_msg_count": t.session_msg_count,
                "run_output": t.run_output or "",
            })

    if not todos_to_check:
        return 0

    for info in todos_to_check:
        encoded = info["source_path"].replace("/", "-").replace(".", "-")
        jsonl_path = _CLAUDE_PROJECTS / encoded / f"{info['session_id']}.jsonl"
        if not jsonl_path.is_file():
            continue

        messages = _read_session_messages(jsonl_path)
        total_count = len(messages)
        prev_count = info["session_msg_count"]

        if prev_count is None:
            # First sync — no baseline. Skip unless there are clearly new messages
            # beyond what's already in run_output (heuristic: if count matches, skip).
            continue

        if total_count <= prev_count:
            continue

        # Extract only new messages
        new_messages = messages[prev_count:]
        formatted = _format_new_messages(new_messages)
        if not formatted.strip():
            continue

        appended_text = formatted

        with StorageContext() as ctx:
            for t in ctx.store.todos:
                if t.id == info["id"]:
                    t.run_output = cap_output((t.run_output or "") + appended_text)
                    t.session_msg_count = total_count
                    t.is_read = False
                    break

        bus.emit_event_sync(EventType.TODO_UPDATED, todo_id=info["id"])
        updated += 1
        log.info("CLI sync: appended %d new messages to todo %s", len(new_messages), info["id"])

    return updated
