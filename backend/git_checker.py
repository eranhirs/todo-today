"""Periodic git update checker.

Fetches from origin and checks if the local main branch is behind.
If new commits are available, creates a manual todo to pull and restart.
Matches the project by directory name (not ID) so it works across machines.
"""

from __future__ import annotations

import logging
import subprocess
from pathlib import Path

from .models import Todo, _now
from .storage import StorageContext

log = logging.getLogger(__name__)

# The repo root is one level up from backend/
REPO_DIR = Path(__file__).resolve().parent.parent
REPO_DIR_NAME = REPO_DIR.name  # e.g. "claude-todos"

# Deduplicate: don't create a new todo if one with this prefix already exists and is active
_TODO_PREFIX = "Pull latest changes from main"

# Backoff: consecutive fetch failures increase the delay before retrying
_consecutive_failures = 0
_MAX_BACKOFF_MULTIPLIER = 20  # cap at 20x the base interval (30s * 20 = 10 min)


def skips_remaining() -> int:
    """Return how many scheduler ticks to skip based on backoff.

    After N consecutive failures, skip min(N, _MAX_BACKOFF_MULTIPLIER) - 1 ticks,
    effectively multiplying the check interval.
    """
    if _consecutive_failures <= 1:
        return 0
    return min(_consecutive_failures, _MAX_BACKOFF_MULTIPLIER) - 1


def _find_project_id() -> str | None:
    """Find the project whose source_path matches this repo's directory name."""
    with StorageContext(read_only=True) as ctx:
        for p in ctx.store.projects:
            if p.source_path and Path(p.source_path).name == REPO_DIR_NAME:
                return p.id
    return None


def _has_active_pull_todo(project_id: str) -> bool:
    """Check if there's already an active (non-completed/rejected) pull todo."""
    with StorageContext(read_only=True) as ctx:
        for t in ctx.store.todos:
            if (
                t.project_id == project_id
                and t.text.startswith(_TODO_PREFIX)
                and t.status not in ("completed", "rejected", "stale")
            ):
                return True
    return False


def _git(*args: str) -> subprocess.CompletedProcess[str]:
    """Run a git command in the repo directory."""
    return subprocess.run(
        ["git", *args],
        cwd=REPO_DIR,
        capture_output=True,
        text=True,
        timeout=30,
    )


def check_for_updates() -> None:
    """Fetch from origin and create a todo if there are commits to pull.

    Uses exponential backoff on consecutive failures to avoid spamming
    logs and wasting resources when the network or remote is down.
    """
    global _consecutive_failures

    # Fetch latest from origin
    result = _git("fetch", "origin", "main")
    if result.returncode != 0:
        _consecutive_failures += 1
        if _consecutive_failures <= 3 or _consecutive_failures % 10 == 0:
            log.warning("git fetch failed (attempt %d): %s", _consecutive_failures, result.stderr.strip())
        return

    # Fetch succeeded — reset failure counter
    if _consecutive_failures > 0:
        log.info("git fetch recovered after %d consecutive failure(s)", _consecutive_failures)
        _consecutive_failures = 0

    # Count commits we're behind
    result = _git("rev-list", "--count", "HEAD..origin/main")
    if result.returncode != 0:
        log.warning("git rev-list failed: %s", result.stderr.strip())
        return

    count = int(result.stdout.strip())
    if count == 0:
        return

    log.info("Found %d new commit(s) on origin/main", count)

    project_id = _find_project_id()
    if not project_id:
        log.warning("No project found matching directory '%s' — skipping todo creation", REPO_DIR_NAME)
        return

    if _has_active_pull_todo(project_id):
        log.info("Active pull todo already exists — skipping")
        return

    # Get short summary of incoming commits
    result = _git("log", "--oneline", "HEAD..origin/main", "--reverse")
    commit_summary = result.stdout.strip() if result.returncode == 0 else ""
    summary_lines = commit_summary.split("\n")
    if len(summary_lines) > 5:
        shown = "\n".join(summary_lines[:5])
        commit_summary = f"{shown}\n... and {len(summary_lines) - 5} more"

    todo_text = f"{_TODO_PREFIX} ({count} commit{'s' if count != 1 else ''})"
    if commit_summary:
        todo_text += f":\n{commit_summary}"
    todo_text += "\n\nPull the latest changes and rebuild/restart the server."

    with StorageContext() as ctx:
        todo = Todo(
            project_id=project_id,
            text=todo_text,
            status="next",
            source="claude",
            manual=True,
            emoji="🔄",
            created_at=_now(),
        )
        ctx.store.todos.append(todo)
    log.info("Created pull todo: %s", todo.id)
