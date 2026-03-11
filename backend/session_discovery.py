"""Discover Claude Code sessions from ~/.claude/projects/ and analyze them."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .models import Project
from .session_state import _detect_session_state
from .storage import StorageContext

log = logging.getLogger(__name__)

CLAUDE_DIR = Path.home() / ".claude" / "projects"
# How far back to look for active sessions
SESSION_MAX_AGE = timedelta(hours=24)
# Max messages to extract per session for the prompt
MAX_MESSAGES_PER_SESSION = 20


def _load_analysis_session_ids() -> set[str]:
    """Load persisted analysis session IDs from metadata."""
    with StorageContext(read_only=True) as ctx:
        return set(ctx.metadata.analysis_session_ids)


def _is_analysis_session(session_id: str, analysis_ids: set[str]) -> bool:
    """Check if a session was created by our analysis subprocess."""
    return session_id in analysis_ids


def _decode_project_dir(dirname: str) -> str:
    """Convert e.g. '-home-user-git-my-project' back to '/home/user/git/my-project'.

    The encoding replaces '/' with '-', making it ambiguous with literal dashes
    in directory names.  We resolve this by trying all possible splits and
    picking the path that actually exists on disk.  Falls back to naive
    replacement if no path exists (e.g. deleted project).
    """
    # Strip leading '-' which represents root '/'
    parts = dirname[1:].split("-")
    if not parts:
        return "/" + dirname[1:]

    # DFS: greedily join segments with '-' when the resulting path exists
    def _resolve(idx: int, prefix: str) -> str | None:
        if idx == len(parts):
            return prefix
        # Try joining progressively more segments with '-' (longer names first)
        for end in range(len(parts), idx, -1):
            segment = "-".join(parts[idx:end])
            candidate = prefix + "/" + segment
            # If this is a full path (end == len(parts)), accept it
            if end == len(parts):
                if Path(candidate).exists():
                    return candidate
            # If this is an intermediate directory, it must exist to continue
            elif Path(candidate).is_dir():
                result = _resolve(end, candidate)
                if result is not None:
                    return result
        return None

    resolved = _resolve(0, "")
    if resolved:
        return resolved
    # Fallback: naive replacement (may be wrong for paths with dashes)
    return "/" + dirname[1:].replace("-", "/")


def _extract_project_name(source_path: str) -> str:
    return Path(source_path).name


def _latest_session_mtime() -> float:
    """Return the latest modification time (epoch) across all recent session files."""
    if not CLAUDE_DIR.is_dir():
        return 0.0
    analysis_ids = _load_analysis_session_ids()
    cutoff = datetime.now(timezone.utc) - SESSION_MAX_AGE
    latest = 0.0
    for proj_dir in CLAUDE_DIR.iterdir():
        if not proj_dir.is_dir():
            continue
        for jsonl_file in proj_dir.glob("*.jsonl"):
            if _is_analysis_session(jsonl_file.stem, analysis_ids):
                continue
            mtime = jsonl_file.stat().st_mtime
            if datetime.fromtimestamp(mtime, tz=timezone.utc) >= cutoff:
                latest = max(latest, mtime)
    return latest


def discover_sessions(max_age: timedelta | None = SESSION_MAX_AGE) -> list[dict]:
    """Return a list of recent sessions with their messages.

    Each entry: {"project_dir": str, "source_path": str, "session_id": str,
                 "mtime": float, "messages": [...]}

    When max_age is None, no age cutoff is applied (discover all sessions).
    """
    if not CLAUDE_DIR.is_dir():
        log.warning("Claude projects dir not found: %s", CLAUDE_DIR)
        return []

    analysis_ids = _load_analysis_session_ids()
    cutoff = datetime.now(timezone.utc) - max_age if max_age is not None else None
    sessions = []

    for proj_dir in CLAUDE_DIR.iterdir():
        if not proj_dir.is_dir():
            continue
        source_path = _decode_project_dir(proj_dir.name)

        for jsonl_file in proj_dir.glob("*.jsonl"):
            if _is_analysis_session(jsonl_file.stem, analysis_ids):
                continue
            stat_mtime = jsonl_file.stat().st_mtime
            # Check modification time
            if cutoff is not None:
                mtime_dt = datetime.fromtimestamp(stat_mtime, tz=timezone.utc)
                if mtime_dt < cutoff:
                    continue

            messages = _parse_session_messages(jsonl_file)
            if messages:
                state_info = _detect_session_state(jsonl_file)
                sessions.append({
                    "project_dir": proj_dir.name,
                    "source_path": source_path,
                    "session_id": jsonl_file.stem,
                    "mtime": stat_mtime,
                    "messages": messages,
                    "state": state_info["state"],
                    "state_info": state_info,
                })

    log.info("Discovered %d active sessions across %d project dirs", len(sessions), len({s["project_dir"] for s in sessions}))
    return sessions


def _parse_session_messages(path: Path) -> list[dict]:
    """Extract the last N user/assistant messages from a session JSONL file."""
    messages = []
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

                entry_type = entry.get("type")
                if entry_type not in ("user", "assistant"):
                    continue

                msg = entry.get("message", {})
                role = msg.get("role")
                content = msg.get("content")
                if not role or not content:
                    continue

                # Flatten content to text
                if isinstance(content, list):
                    text_parts = []
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "text":
                            text_parts.append(block["text"])
                        elif isinstance(block, str):
                            text_parts.append(block)
                    text = "\n".join(text_parts)
                elif isinstance(content, str):
                    text = content
                else:
                    continue

                if not text.strip():
                    continue

                messages.append({
                    "role": role,
                    "text": text[:2000],  # truncate long messages
                    "timestamp": entry.get("timestamp", ""),
                })
    except Exception:
        log.exception("Error parsing session file: %s", path)

    # Return last N messages
    return messages[-MAX_MESSAGES_PER_SESSION:]


def _session_key(sess: dict) -> str:
    """Return a unique key for a session: 'project_dir/session_id'."""
    return f"{sess['project_dir']}/{sess['session_id']}"


def filter_changed_sessions(
    sessions: list[dict], last_mtimes: dict[str, float]
) -> list[dict]:
    """Keep only sessions whose file mtime exceeds the last-analyzed mtime."""
    changed = []
    for s in sessions:
        key = _session_key(s)
        stored = last_mtimes.get(key)
        if stored is None or s["mtime"] > stored:
            changed.append(s)
    return changed


def list_all_sessions() -> list[dict]:
    """Return lightweight metadata for all sessions (no age cutoff, no messages)."""
    if not CLAUDE_DIR.is_dir():
        return []

    analysis_ids = _load_analysis_session_ids()
    sessions = []
    for proj_dir in CLAUDE_DIR.iterdir():
        if not proj_dir.is_dir():
            continue
        source_path = _decode_project_dir(proj_dir.name)
        project_name = _extract_project_name(source_path)

        for jsonl_file in proj_dir.glob("*.jsonl"):
            if _is_analysis_session(jsonl_file.stem, analysis_ids):
                continue
            stat_mtime = jsonl_file.stat().st_mtime
            # Count messages (lightweight — just count qualifying lines)
            msg_count = 0
            try:
                with open(jsonl_file) as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            entry = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        if entry.get("type") in ("user", "assistant"):
                            msg_count += 1
            except Exception:
                pass

            session_key = f"{proj_dir.name}/{jsonl_file.stem}"
            state_info = _detect_session_state(jsonl_file, session_key=session_key)
            sessions.append({
                "key": session_key,
                "project_dir": proj_dir.name,
                "source_path": source_path,
                "project_name": project_name,
                "session_id": jsonl_file.stem,
                "mtime": stat_mtime,
                "message_count": msg_count,
                "state": state_info["state"],
                "state_source": state_info.get("state_source", "jsonl"),
            })

    sessions.sort(key=lambda s: s["mtime"], reverse=True)
    return sessions


def _match_sessions_to_projects(
    sessions: list[dict], ctx: "StorageContext"
) -> dict[str, list[dict]]:
    """Map sessions to project IDs by matching source_path.

    Sessions whose source_path doesn't match any existing project cause a new
    project to be auto-created.  Returns ``{project_id: [sessions...]}``.
    """
    # Build lookup: source_path → project_id
    path_to_pid: dict[str, str] = {}
    for p in ctx.store.projects:
        if p.source_path:
            path_to_pid[p.source_path] = p.id

    result: dict[str, list[dict]] = {}
    for sess in sessions:
        sp = sess["source_path"]
        pid = path_to_pid.get(sp)
        if pid is None:
            # Auto-create project
            proj = Project(name=_extract_project_name(sp), source_path=sp)
            ctx.store.projects.append(proj)
            path_to_pid[sp] = proj.id
            pid = proj.id
            log.info("Auto-created project %s (%s) for unmatched session", proj.name, proj.id)
        result.setdefault(pid, []).append(sess)
    return result
