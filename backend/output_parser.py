"""Stream-JSON output parsing and detection helpers.

Pure functions for extracting text from Claude CLI stream objects,
detecting plan mode transitions, and parsing output files.
Extracted from run_manager.py.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)


def extract_assistant_text(line_json: dict) -> Optional[str]:
    """Extract text content from a stream-json assistant message."""
    if line_json.get("type") != "assistant":
        return None
    msg = line_json.get("message", {})
    content = msg.get("content", [])
    parts = []
    for block in content:
        if isinstance(block, dict):
            if block.get("type") == "text":
                parts.append(block["text"])
            elif block.get("type") == "tool_use":
                name = block.get("name", "tool")
                inp = block.get("input", {})
                # Show tool calls concisely
                if name == "Bash":
                    parts.append(f"$ {inp.get('command', '')}")
                elif name in ("Edit", "Write"):
                    parts.append(f"[{name}: {inp.get('file_path', '')}]")
                elif name == "Read":
                    parts.append(f"[Read: {inp.get('file_path', '')}]")
                else:
                    parts.append(f"[{name}]")
    return "\n".join(parts) if parts else None


def detect_plan_file(
    stream_objects: list[dict],
    source_path: str = "",
    run_started_at: str | None = None,
) -> Optional[str]:
    """Scan stream objects for a Write tool_use targeting .claude/plans/.

    Falls back to scanning the filesystem at ``{source_path}/.claude/plans/``
    for files modified after *run_started_at* when the stream-object scan
    returns nothing (e.g. reconnect picked up only a tail of output).

    Returns the file path if found, else None.
    """
    # Primary: stream-object detection
    for obj in stream_objects:
        if obj.get("type") != "assistant":
            continue
        for block in obj.get("message", {}).get("content", []):
            if isinstance(block, dict) and block.get("type") == "tool_use":
                if block.get("name") == "Write":
                    file_path = block.get("input", {}).get("file_path", "")
                    if ".claude/plans/" in file_path:
                        return file_path

    # Fallback: filesystem scan
    if source_path and run_started_at:
        plans_dir = Path(source_path) / ".claude" / "plans"
        if plans_dir.is_dir():
            try:
                cutoff = datetime.fromisoformat(run_started_at)
            except (ValueError, TypeError):
                return None
            best: tuple[datetime, str] | None = None
            try:
                for entry in plans_dir.iterdir():
                    if not entry.is_file():
                        continue
                    mtime = datetime.fromtimestamp(entry.stat().st_mtime)
                    if mtime >= cutoff:
                        if best is None or mtime > best[0]:
                            best = (mtime, str(entry))
            except OSError:
                pass
            if best is not None:
                log.info("Detected plan file via filesystem fallback: %s", best[1])
                return best[1]

    return None


def detect_exit_plan_mode(stream_lines: list[dict]) -> bool:
    """Check if any assistant message called ExitPlanMode.

    Previously only checked the last assistant message, but after Claude calls
    ExitPlanMode the CLI returns a tool_result (is_error) and Claude often
    writes another assistant message responding to it — burying the
    ExitPlanMode call in an earlier turn.
    """
    for obj in stream_lines:
        if obj.get("type") != "assistant":
            continue
        for block in obj.get("message", {}).get("content", []):
            if isinstance(block, dict) and block.get("type") == "tool_use":
                if block.get("name") == "ExitPlanMode":
                    return True
    return False


def detect_plan_mode(stream_lines: list[dict]) -> bool:
    """Check if any assistant message called EnterPlanMode.

    Serves as a fallback signal: if Claude entered plan mode but never called
    ExitPlanMode (e.g. the CLI exited before it could), we still know a plan
    was written and should auto-accept.
    """
    for obj in stream_lines:
        if obj.get("type") != "assistant":
            continue
        for block in obj.get("message", {}).get("content", []):
            if isinstance(block, dict) and block.get("type") == "tool_use":
                if block.get("name") == "EnterPlanMode":
                    return True
    return False


def parse_output_file(output_file_str: str) -> tuple[Optional[dict], list[str], list[dict]]:
    """Parse a completed output file to extract final result, accumulated text, and stream objects.

    Used when the subprocess finished while the server was down, or to
    recover full stream context after a server restart.
    Returns (final_result, accumulated_texts, stream_objects).
    """
    output_file = Path(output_file_str)
    final_result = None
    accumulated: list[str] = []
    stream_objects: list[dict] = []

    if not output_file.exists():
        return None, [], []

    try:
        with open(output_file, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue

                stream_objects.append(obj)

                if obj.get("type") == "result":
                    final_result = obj
                    continue

                text = extract_assistant_text(obj)
                if text:
                    accumulated.append(text)
    except Exception:
        log.debug("Could not parse output file %s", output_file)

    return final_result, accumulated, stream_objects


def extract_run_costs(stream_objects: list[dict]) -> dict:
    """Extract cost/token usage from all result events (summed across plan retries).

    Returns a dict with keys: cost, input_tokens, output_tokens, cache_read_tokens, duration_ms.
    """
    cost = 0.0
    input_tokens = 0
    output_tokens = 0
    cache_read_tokens = 0
    duration_ms = 0
    for obj in stream_objects:
        if obj.get("type") == "result":
            cost += obj.get("total_cost_usd", obj.get("cost_usd", 0.0)) or 0.0
            usage = obj.get("usage", {})
            input_tokens += usage.get("input_tokens", 0)
            output_tokens += usage.get("output_tokens", 0)
            cache_read_tokens += usage.get("cache_read_input_tokens", 0)
            duration_ms += obj.get("duration_ms", 0) or 0
    return {
        "cost": cost,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cache_read_tokens": cache_read_tokens,
        "duration_ms": duration_ms,
    }
