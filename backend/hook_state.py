"""Reader for hook-based session state from data/hook_states.json."""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Literal, Optional, Set, TypedDict

log = logging.getLogger(__name__)


# -- Type definitions matching hook_states.json and hook_events.log --

SessionState = Literal[
    "waiting_for_tool_approval",
    "waiting_for_user",
    "ended",
]

HookEventName = Literal[
    "PermissionRequest",
    "Stop",
    "SessionStart",
    "SessionEnd",
]


class StateEntry(TypedDict, total=False):
    """A single session entry in hook_states.json."""
    state: SessionState
    tool_name: str
    detail: str
    project_name: str
    cwd: str
    timestamp: str  # ISO 8601 UTC, e.g. "2026-03-07T10:30:00Z"
    hook_event: HookEventName


class EventLogEntry(TypedDict, total=False):
    """A single line in hook_events.log."""
    ts: str
    session_key: str
    hook_event: HookEventName
    state: Optional[SessionState]
    project_name: Optional[str]
    detail: Optional[str]

_DATA_DIR = Path(os.environ.get("TODO_DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
_STATE_FILE = _DATA_DIR / "hook_states.json"
_CLAUDE_PROJECTS = Path.home() / ".claude" / "projects"


def load_hook_states() -> Dict[str, StateEntry]:
    """Read and return all hook states. Returns {} on missing/corrupt file."""
    if not _STATE_FILE.exists():
        return {}
    try:
        with open(_STATE_FILE) as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
        return {}
    except (json.JSONDecodeError, OSError):
        return {}


def get_hook_state(session_key: str) -> Optional[StateEntry]:
    """Look up a single session's hook state. Returns None if not found."""
    states = load_hook_states()
    return states.get(session_key)


def load_event_log(limit: int = 100) -> list[EventLogEntry]:
    """Read the last N entries from the hook event log."""
    log_file = _DATA_DIR / "hook_events.log"
    if not log_file.exists():
        return []
    try:
        lines = log_file.read_text().strip().splitlines()
        # Return most recent first
        entries = []
        for line in reversed(lines[-limit:]):
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return entries
    except OSError:
        return []


def _is_waiting_state_stale(key: str, entry: StateEntry) -> bool:
    """Check if a waiting state is stale by comparing JSONL mtime to hook timestamp.

    Claude Code has no 'PermissionGranted' hook event, so waiting states linger
    after the user approves. If the session's JSONL file has been modified after
    the hook timestamp, the session has moved on and the state is stale.
    """
    ts_str = entry.get("timestamp", "")
    if not ts_str:
        return False
    try:
        hook_ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return False
    # key is "project_dir/session_id" — resolve to JSONL path
    parts = key.split("/", 1)
    if len(parts) != 2:
        return False
    jsonl_path = _CLAUDE_PROJECTS / parts[0] / f"{parts[1]}.jsonl"
    try:
        mtime = jsonl_path.stat().st_mtime
        return mtime > hook_ts + 2  # 2s grace for filesystem timestamp granularity
    except OSError:
        return False


def get_actionable_sessions(exclude_session_ids: Optional[Set[str]] = None) -> Dict[str, StateEntry]:
    """Return all sessions in a notifiable state (waiting or recently ended).

    Sessions whose session_id is in exclude_session_ids are filtered out
    (used to skip analysis/run subprocess sessions).
    Waiting states are dropped if the session's JSONL has been modified since
    the hook fired (meaning the user already responded).
    """
    states = load_hook_states()
    result = {}
    for key, entry in states.items():
        state = entry.get("state")
        if state not in ("waiting_for_user", "waiting_for_tool_approval", "ended"):
            continue
        # key is "project_dir/session_id" — extract the session_id part
        if exclude_session_ids:
            session_id = key.split("/", 1)[-1] if "/" in key else key
            if session_id in exclude_session_ids:
                continue
        # Drop stale waiting states where the session has already progressed
        if state in ("waiting_for_user", "waiting_for_tool_approval"):
            if _is_waiting_state_stale(key, entry):
                continue
        result[key] = entry
    return result
