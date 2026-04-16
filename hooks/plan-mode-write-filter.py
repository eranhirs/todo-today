#!/usr/bin/env python3
"""Plan-mode Write filter hook.

PreToolUse hook that blocks Write tool calls unless the target path is
under .claude/plans/. Injected via --settings only for plan-only runs:
Claude can write the plan file, but cannot write/implement code.

Reads hook event JSON from stdin. Exits 0 to allow, exits 2 with stderr
message to block (Claude Code convention).
"""
from __future__ import annotations

import json
import sys


def main() -> int:
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError:
        return 0
    if data.get("tool_name") != "Write":
        return 0
    file_path = data.get("tool_input", {}).get("file_path", "")
    if ".claude/plans/" in file_path:
        return 0
    print(
        f"Plan-only run: Write to {file_path!r} blocked. "
        f"This run is plan-only — Write is allowed only for files under "
        f".claude/plans/. Save your plan file there instead of implementing code.",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    sys.exit(main())
