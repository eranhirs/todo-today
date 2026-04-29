#!/usr/bin/env python3
"""Plan-mode filesystem filter hook.

PreToolUse hook injected via --settings only for plan-only runs:
- Write/Edit to the project's plans/ directory are ALLOWED.
- Write/Edit anywhere else are BLOCKED with a reason sent back to Claude.

Reads hook event JSON from stdin. Emits a PreToolUse hookSpecificOutput
JSON with an explicit permissionDecision.
"""
from __future__ import annotations

import json
import logging
import sys
from pathlib import Path

_LOG_PATH = Path(__file__).resolve().parent.parent / "data" / "plan-hook.log"
_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
logging.basicConfig(
    filename=str(_LOG_PATH),
    level=logging.INFO,
    format="%(asctime)s %(message)s",
)
log = logging.getLogger("plan-hook")


def _emit(decision: str, reason: str) -> None:
    payload = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
            "permissionDecisionReason": reason,
        }
    }
    sys.stdout.write(json.dumps(payload))
    log.info("decision=%s reason=%s", decision, reason)


def _is_plan_path(file_path: str, cwd: str) -> bool:
    if not file_path:
        return False
    if cwd:
        prefix = str(Path(cwd).resolve()) + "/plans/"
        try:
            resolved = str(Path(file_path).resolve())
        except OSError:
            resolved = file_path
        if resolved.startswith(prefix):
            return True
    return file_path.startswith("plans/") or file_path.startswith("./plans/")


def main() -> int:
    raw = sys.stdin.read()
    log.info("fired, stdin=%r", raw[:500])
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        log.info("json decode failed")
        return 0
    tool_name = data.get("tool_name")
    if tool_name not in ("Write", "Edit"):
        return 0
    file_path = data.get("tool_input", {}).get("file_path", "")
    cwd = data.get("cwd", "")
    if _is_plan_path(file_path, cwd):
        _emit("allow", f"Plan-only run: {tool_name} to plans/ is permitted")
        return 0
    _emit(
        "deny",
        f"Plan-only run: {tool_name} to {file_path!r} blocked — {tool_name} is "
        f"allowed only for files under the project's plans/ directory. Edit "
        f"your plan file there instead of implementing code.",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
