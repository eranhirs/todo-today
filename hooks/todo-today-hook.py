#!/usr/bin/env python3
"""Claude Code hook script for real-time session state detection.

Reads hook event JSON from stdin, writes state to data/hook_states.json.
Install via the Todo Today UI or manually in ~/.claude/settings.json.
"""

from __future__ import annotations

import fcntl
import json
import os
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from typing import Optional

# data/ is a sibling of hooks/
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(os.path.dirname(SCRIPT_DIR), "data")
STATE_FILE = os.path.join(DATA_DIR, "hook_states.json")
EVENT_LOG = os.path.join(DATA_DIR, "hook_events.log")
EVENT_LOG_MAX_SIZE = 512 * 1024  # rotate at 512KB
EXPIRY_SECONDS = 86400  # 24 hours
API_BASE = "http://localhost:5152"


def _session_key_from_transcript(transcript_path: str) -> Optional[str]:
    """Derive session key from transcript_path.

    transcript_path looks like: ~/.claude/projects/{encoded-dir}/{session-id}.jsonl
    We want: {encoded-dir}/{session-id}
    """
    parts = transcript_path.replace("\\", "/").split("/")
    # Find 'projects' in the path and take the next two segments
    try:
        idx = parts.index("projects")
    except ValueError:
        return None
    if idx + 2 >= len(parts):
        return None
    project_dir = parts[idx + 1]
    session_file = parts[idx + 2]
    session_id = session_file.replace(".jsonl", "")
    return f"{project_dir}/{session_id}"


def _map_event_to_state(event: dict) -> Optional[dict]:
    """Map a hook event to a state entry."""
    hook_event = event.get("hook_event_name", "")
    now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")

    cwd = event.get("cwd", "")
    project_name = os.path.basename(cwd) if cwd else ""

    if hook_event == "PermissionRequest":
        tool_name = event.get("tool_name", "")
        tool_input = event.get("tool_input", {})
        # Extract a short description of what the tool is doing
        detail = ""
        if tool_name == "Bash" and isinstance(tool_input, dict):
            cmd = tool_input.get("command", "")
            detail = cmd[:120] if cmd else ""
        elif tool_name in ("Edit", "Write") and isinstance(tool_input, dict):
            detail = tool_input.get("file_path", "")
        elif tool_name == "Read" and isinstance(tool_input, dict):
            detail = tool_input.get("file_path", "")
        return {
            "state": "waiting_for_tool_approval",
            "tool_name": tool_name,
            "detail": detail,
            "project_name": project_name,
            "cwd": cwd,
            "timestamp": now,
            "hook_event": hook_event,
        }
    elif hook_event == "Stop":
        last_msg = event.get("last_assistant_message", "")
        if isinstance(last_msg, str) and last_msg.rstrip().endswith("?"):
            state = "waiting_for_user"
        else:
            state = "ended"
        # Grab last ~120 chars of the message for context
        snippet = ""
        if isinstance(last_msg, str) and last_msg.strip():
            snippet = last_msg.strip()[-120:]
        return {
            "state": state,
            "detail": snippet,
            "project_name": project_name,
            "cwd": cwd,
            "timestamp": now,
            "hook_event": hook_event,
        }
    elif hook_event == "SessionStart":
        # Clear stale state — return a marker to delete the key
        return None
    elif hook_event == "SessionEnd":
        return {
            "state": "ended",
            "project_name": project_name,
            "cwd": cwd,
            "timestamp": now,
            "hook_event": hook_event,
        }
    return None


def _expire_old_entries(states: dict) -> dict:
    """Remove entries older than EXPIRY_SECONDS."""
    now = time.time()
    to_remove = []
    for key, entry in states.items():
        ts_str = entry.get("timestamp", "")
        try:
            ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
            age = now - ts.timestamp()
            if age > EXPIRY_SECONDS:
                to_remove.append(key)
        except (ValueError, TypeError):
            to_remove.append(key)
    for key in to_remove:
        del states[key]
    return states


def _append_event_log(session_key: str, hook_event: str, state_entry: Optional[dict]) -> None:
    """Append a line to the event log for debugging."""
    try:
        now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        entry = {
            "ts": now,
            "session_key": session_key,
            "hook_event": hook_event,
            "state": state_entry.get("state") if state_entry else None,
            "project_name": state_entry.get("project_name") if state_entry else None,
            "detail": (state_entry.get("detail") or "")[:80] if state_entry else None,
        }
        # Rotate if too large
        try:
            if os.path.exists(EVENT_LOG) and os.path.getsize(EVENT_LOG) > EVENT_LOG_MAX_SIZE:
                rotated = EVENT_LOG + ".1"
                if os.path.exists(rotated):
                    os.unlink(rotated)
                os.rename(EVENT_LOG, rotated)
        except OSError:
            pass
        with open(EVENT_LOG, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass  # best-effort — never block the hook


def _trigger_analysis(session_key: str) -> None:
    """Fire-and-forget: ask the backend to analyze this session."""
    try:
        subprocess.Popen(
            ["curl", "-s", "-X", "POST",
             "-H", "Content-Type: application/json",
             "-d", json.dumps({"session_key": session_key}),
             f"{API_BASE}/api/claude/hooks/analyze"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        pass  # best-effort — don't block the hook


def main() -> None:
    raw = sys.stdin.read()
    if not raw.strip():
        return

    try:
        event = json.loads(raw)
    except json.JSONDecodeError:
        return

    transcript_path = event.get("transcript_path", "")
    session_key = _session_key_from_transcript(transcript_path)
    if not session_key:
        return

    hook_event = event.get("hook_event_name", "")
    new_state = _map_event_to_state(event)

    os.makedirs(DATA_DIR, exist_ok=True)

    # Always log the event for debugging
    _append_event_log(session_key, hook_event, new_state)

    # Atomic read-modify-write with flock
    lock_path = STATE_FILE + ".lock"
    with open(lock_path, "w") as lock_fd:
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        try:
            # Read existing states
            states = {}
            if os.path.exists(STATE_FILE):
                try:
                    with open(STATE_FILE) as f:
                        states = json.load(f)
                except (json.JSONDecodeError, OSError):
                    states = {}

            # Update
            if hook_event == "SessionStart":
                states.pop(session_key, None)
            elif new_state is not None:
                states[session_key] = new_state

            # Expire old entries
            states = _expire_old_entries(states)

            # Atomic write
            fd, tmp_path = tempfile.mkstemp(dir=DATA_DIR, suffix=".tmp")
            try:
                with os.fdopen(fd, "w") as tmp:
                    json.dump(states, tmp, indent=2)
                os.rename(tmp_path, STATE_FILE)
            except Exception:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
                raise
        finally:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)

    # Trigger analysis for sessions that just ended
    if hook_event in ("Stop", "SessionEnd"):
        _trigger_analysis(session_key)


if __name__ == "__main__":
    main()
