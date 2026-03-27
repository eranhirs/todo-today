"""Tag parsing utilities for todo text.

Tags are written inline as #tagname (e.g. "Fix login bug #backend #urgent").
They are stored as part of the todo text — no separate model field needed.

Priority keywords (#p1–#p4 and aliases like #critical, #high, #medium, #low)
are parsed as priorities, NOT as regular tags.
"""

from __future__ import annotations

import re
from typing import Optional

# Matches #tag where tag is alphanumeric (plus hyphens/underscores), at least 1 char.
# Must be preceded by whitespace or start-of-string to avoid matching e.g. "C#" or URLs with #fragments.
TAG_RE = re.compile(r"(?:^|(?<=\s))#([A-Za-z][A-Za-z0-9_-]*)")

# Priority keyword mapping: keyword -> priority level (1=critical, 4=low)
PRIORITY_KEYWORDS: dict[str, int] = {
    "p1": 1, "critical": 1,
    "p2": 2, "high": 2,
    "p3": 3, "medium": 3,
    "p4": 4, "low": 4,
}

# Reverse: priority level -> canonical short label
PRIORITY_LABELS: dict[int, str] = {1: "p1", 2: "p2", 3: "p3", 4: "p4"}


def is_priority_keyword(tag: str) -> bool:
    """Check if a tag name (without #) is a priority keyword."""
    return tag.lower() in PRIORITY_KEYWORDS


def parse_priority(text: str) -> Optional[int]:
    """Extract the highest priority level from text (lowest number wins). Returns None if no priority keyword found."""
    best: Optional[int] = None
    for m in TAG_RE.finditer(text):
        tag = m.group(1).lower()
        if tag in PRIORITY_KEYWORDS:
            level = PRIORITY_KEYWORDS[tag]
            if best is None or level < best:
                best = level
    return best


def parse_tags(text: str) -> list[str]:
    """Extract tags from text, returning lowercase deduplicated list. Excludes priority keywords."""
    seen: set[str] = set()
    result: list[str] = []
    for m in TAG_RE.finditer(text):
        tag = m.group(1).lower()
        if tag not in seen and not is_priority_keyword(tag):
            seen.add(tag)
            result.append(tag)
    return result


def strip_tags_from_text(text: str) -> str:
    """Remove #tag tokens from text for display purposes."""
    return TAG_RE.sub("", text).strip()


def strip_priority_from_text(text: str) -> str:
    """Remove priority keyword tokens from text for display purposes."""
    def _replace(m: re.Match) -> str:
        if is_priority_keyword(m.group(1)):
            return ""
        return m.group(0)
    return TAG_RE.sub(_replace, text).strip()


def filter_unknown_tags(text: str, known_tags: set[str]) -> str:
    """Remove tags from text that aren't in the known set. Used for Claude-created todos."""
    def _replace(m: re.Match) -> str:
        tag = m.group(1).lower()
        if tag in known_tags:
            return m.group(0)  # keep it
        return ""  # strip unknown tag
    return TAG_RE.sub(_replace, text).strip()


def rename_tag_in_text(text: str, old_tag: str, new_tag: str) -> str:
    """Replace occurrences of #old_tag with #new_tag in text (case-insensitive match)."""
    def _replace(m: re.Match) -> str:
        if m.group(1).lower() == old_tag.lower():
            return m.group(0)[:len(m.group(0)) - len(m.group(1))] + new_tag
        return m.group(0)
    return TAG_RE.sub(_replace, text)


def collect_all_tags(todo_texts: list[str]) -> list[str]:
    """Collect all unique tags across multiple todo texts, sorted alphabetically."""
    all_tags: set[str] = set()
    for text in todo_texts:
        all_tags.update(parse_tags(text))
    return sorted(all_tags)
