"""Tag parsing utilities for todo text.

Tags are written inline as #tagname (e.g. "Fix login bug #backend #urgent").
They are stored as part of the todo text — no separate model field needed.
"""

from __future__ import annotations

import re

# Matches #tag where tag is alphanumeric (plus hyphens/underscores), at least 1 char.
# Must be preceded by whitespace or start-of-string to avoid matching e.g. "C#" or URLs with #fragments.
TAG_RE = re.compile(r"(?:^|(?<=\s))#([A-Za-z][A-Za-z0-9_-]*)")


def parse_tags(text: str) -> list[str]:
    """Extract tags from text, returning lowercase deduplicated list."""
    seen: set[str] = set()
    result: list[str] = []
    for m in TAG_RE.finditer(text):
        tag = m.group(1).lower()
        if tag not in seen:
            seen.add(tag)
            result.append(tag)
    return result


def strip_tags_from_text(text: str) -> str:
    """Remove #tag tokens from text for display purposes."""
    return TAG_RE.sub("", text).strip()


def filter_unknown_tags(text: str, known_tags: set[str]) -> str:
    """Remove tags from text that aren't in the known set. Used for Claude-created todos."""
    def _replace(m: re.Match) -> str:
        tag = m.group(1).lower()
        if tag in known_tags:
            return m.group(0)  # keep it
        return ""  # strip unknown tag
    return TAG_RE.sub(_replace, text).strip()


def collect_all_tags(todo_texts: list[str]) -> list[str]:
    """Collect all unique tags across multiple todo texts, sorted alphabetically."""
    all_tags: set[str] = set()
    for text in todo_texts:
        all_tags.update(parse_tags(text))
    return sorted(all_tags)
