"""Sync CLI-resumed session output back to todo run_output.

When a user clicks "Resume in CLI" and continues a todo's session interactively,
new messages are appended to the session JSONL file. This module detects those
new messages and reimports them into the todo's run_output so they appear in the UI.

Instead of incrementally appending new messages (which can get out of sync),
we reimport the FULL CLI portion from the session JSONL each time a change is
detected. The run_output_base field (set when the app-managed run ends) provides
the stable base; all messages after session_last_synced_ts (the timestamp baseline
from run-end) are formatted and appended to that base, replacing any prior
CLI-synced content. Timestamps are ISO-8601 and sort lexicographically.
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
      \\n\\n--- Resumed in CLI ---\\n**You:** {user_text}\\n<<END_USER_MSG>>\\n{assistant_text}

    This matches the follow-up separator format that the frontend parses.
    """
    blocks: list[str] = []
    current_user: str | None = None
    current_assistant_parts: list[str] = []

    def flush():
        nonlocal current_user, current_assistant_parts
        if current_user is not None:
            assistant_text = "\n\n".join(current_assistant_parts)
            block = f"\n\n--- Resumed in CLI ---\n**You:** {current_user}\n<<END_USER_MSG>>\n"
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


# In-memory cache: tracks the last-seen latest timestamp per todo so we
# only reimport when the JSONL actually changed.  Lost on restart, which is
# fine — a redundant reimport is harmless since it replaces, not appends.
_last_sync_ts: dict[str, str] = {}


def sync_cli_sessions() -> int:
    """Detect CLI-resumed messages and reimport the full CLI portion into run_output.

    Uses timestamp-based filtering: all messages with timestamp > session_last_synced_ts
    (the baseline set when the app-managed run ended) are treated as CLI-resumed content
    and reimported in full each cycle, replacing the CLI portion entirely.

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
                "session_last_synced_ts": t.session_last_synced_ts,
                "run_output_base": t.run_output_base,
                "run_output": t.run_output or "",
            })

    if not todos_to_check:
        return 0

    for info in todos_to_check:
        encoded = info["source_path"].replace("/", "-").replace(".", "-")
        jsonl_path = _CLAUDE_PROJECTS / encoded / f"{info['session_id']}.jsonl"
        if not jsonl_path.is_file():
            continue

        last_synced_ts = info["session_last_synced_ts"]
        if last_synced_ts is None:
            # No baseline — run never finished tracking timestamps. Skip.
            continue

        messages = _read_session_messages(jsonl_path)

        # Filter: all messages with timestamp strictly after the baseline
        cli_messages = [m for m in messages if m["timestamp"] and m["timestamp"] > last_synced_ts]
        if not cli_messages:
            continue

        # Skip if nothing changed since last sync (idempotent check)
        todo_id = info["id"]
        latest_ts = cli_messages[-1]["timestamp"]
        if _last_sync_ts.get(todo_id) == latest_ts:
            continue

        # Reimport: format ALL CLI messages
        formatted = _format_new_messages(cli_messages)
        if not formatted.strip():
            _last_sync_ts[todo_id] = latest_ts
            continue

        # Use run_output_base as the stable foundation.
        # Fall back to current run_output for legacy todos created before
        # run_output_base was introduced (those won't have CLI content yet
        # since this is their first sync).
        base = info["run_output_base"]
        if base is None:
            base = info["run_output"]

        new_output = cap_output(base + formatted)

        # Only write + emit if the output actually changed
        if new_output == info["run_output"]:
            _last_sync_ts[todo_id] = latest_ts
            continue

        with StorageContext() as ctx:
            for t in ctx.store.todos:
                if t.id == todo_id:
                    t.run_output = new_output
                    t.is_read = False
                    # Note: session_last_synced_ts is NOT updated — it stays as
                    # the run-end baseline so we can always reimport the full CLI
                    # portion from that point forward.
                    break

        _last_sync_ts[todo_id] = latest_ts
        bus.emit_event_sync(EventType.TODO_UPDATED, todo_id=todo_id)
        updated += 1
        log.info("CLI sync: reimported %d CLI messages for todo %s", len(cli_messages), todo_id)

    return updated
