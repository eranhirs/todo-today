"""Reader for hook-based session state from data/hook_states.json."""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)

_DATA_DIR = Path(os.environ.get("TODO_DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
_STATE_FILE = _DATA_DIR / "hook_states.json"


def load_hook_states() -> dict:
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


def get_hook_state(session_key: str) -> Optional[dict]:
    """Look up a single session's hook state. Returns None if not found."""
    states = load_hook_states()
    return states.get(session_key)


def get_actionable_sessions(exclude_session_ids: set = None) -> dict:
    """Return all sessions in a notifiable state (waiting or recently ended).

    Sessions whose session_id is in exclude_session_ids are filtered out
    (used to skip analysis/run subprocess sessions).
    """
    states = load_hook_states()
    result = {}
    for key, entry in states.items():
        if entry.get("state") not in ("waiting_for_user", "waiting_for_tool_approval", "ended"):
            continue
        # key is "project_dir/session_id" — extract the session_id part
        if exclude_session_ids:
            session_id = key.split("/", 1)[-1] if "/" in key else key
            if session_id in exclude_session_ids:
                continue
        result[key] = entry
    return result
