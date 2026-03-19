"""
Command registry + generic proxy dispatch.

Only commands with special behavior (e.g. /manual = noop) need to be registered.
Any other /slash-command is automatically proxied to Claude CLI as-is.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal, Optional

Strategy = Literal["noop"]


@dataclass(frozen=True)
class CommandDef:
    name: str
    description: str
    strategy: Strategy


# ── The Registry ──────────────────────────────────────────────
# Only register commands that need special behavior (noop, etc.).
# All other /commands are proxied to Claude CLI automatically.

COMMAND_REGISTRY: list[CommandDef] = [
    CommandDef(
        name="manual",
        strategy="noop",
        description="Human-only task — cannot be run by Claude",
    ),
]

_REGISTRY_BY_NAME: dict[str, CommandDef] = {c.name: c for c in COMMAND_REGISTRY}

_COMMAND_TOKEN_RE = re.compile(r"(?:^|\s)/([A-Za-z][A-Za-z0-9_-]*)(?=\s|$)")


def get_command(name: str) -> Optional[CommandDef]:
    """Look up a command by name (case-insensitive)."""
    return _REGISTRY_BY_NAME.get(name.lower())


def get_all_registry_commands() -> list[dict]:
    """Return registry commands in the same shape as _discover_commands() entries."""
    return [
        {"name": c.name, "description": c.description, "type": "command"}
        for c in COMMAND_REGISTRY
    ]


def has_slash_command(text: str) -> bool:
    """Return True if text contains any /command token."""
    return bool(_COMMAND_TOKEN_RE.search(text))


def resolve_execution(todo_text: str) -> tuple[str, str]:
    """Determine execution strategy for a todo based on its slash commands.

    Returns (strategy, prompt):
      - ("proxy", "/<command> remaining text") — forward slash command to Claude CLI
      - ("noop", "")                           — command blocks execution (e.g. /manual)
      - ("default", "")                        — no slash command; use normal run flow
    """
    for m in _COMMAND_TOKEN_RE.finditer(todo_text):
        cmd_name = m.group(1).lower()

        # Check for registered special-behavior commands first
        registered = get_command(cmd_name)
        if registered and registered.strategy == "noop":
            return ("noop", "")

        # Generic proxy: forward any /command to Claude CLI as-is
        rest = (todo_text[: m.start()] + todo_text[m.end() :]).strip()
        prompt = f"/{cmd_name} {rest}".strip() if rest else f"/{cmd_name}"
        return ("proxy", prompt)

    return ("default", "")
