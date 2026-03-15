"""Detect "coping" phrases in Claude run output.

Inspired by https://x.com/honnibal/status/2033141305384095848 — certain
phrases are strong signals that Claude is making bad choices: adding
overlapping mechanisms, silently swallowing errors, or over-engineering
instead of writing clean, minimal code.

Each pattern returns a short label (the red flag) when matched.
"""

from __future__ import annotations

import re

# Each entry: (compiled regex, red-flag label, explanation)
_PATTERNS: list[tuple[re.Pattern, str, str]] = [
    (
        re.compile(r"belt[- ]and[- ]suspenders", re.IGNORECASE),
        "Belt-and-suspenders",
        "Two overlapping mechanisms for the same thing — pick one.",
    ),
    (
        re.compile(r"\bdefensive(?:ly)?\b(?!.*programming)", re.IGNORECASE),
        "\"Defensive\" code",
        "Usually means silently continuing through errors instead of "
        "failing explicitly.",
    ),
    (
        re.compile(r"\bjust (?:in case|to be safe)\b", re.IGNORECASE),
        "Just-in-case code",
        "Adding code without a concrete failure scenario — likely unnecessary.",
    ),
    (
        re.compile(r"\bfor good measure\b", re.IGNORECASE),
        "For good measure",
        "No clear reason for the addition — remove it or justify it.",
    ),
    (
        re.compile(r"\bextra layer of (?:protection|safety)\b", re.IGNORECASE),
        "Extra layer of protection",
        "Redundant safeguard — one correct mechanism is better than two.",
    ),
    (
        re.compile(r"\bgracefully (?:handle|degrade|fail|recover)", re.IGNORECASE),
        "\"Gracefully handle\"",
        "Often means silently swallowing errors instead of surfacing them.",
    ),
    (
        re.compile(r"\brobust(?:ness)?\b", re.IGNORECASE),
        "\"Robust\"",
        "Vague justification for added complexity — what failure does it prevent?",
    ),
    (
        re.compile(r"\bfuture[- ]proof", re.IGNORECASE),
        "Future-proofing",
        "Building for hypothetical requirements instead of the current task.",
    ),
    (
        re.compile(r"\berr on the side of caution\b", re.IGNORECASE),
        "Erring on the side of caution",
        "Hedging instead of making a clear decision — pick the right approach.",
    ),
    (
        re.compile(r"\bsafe(?:r)? (?:side|bet|approach)\b", re.IGNORECASE),
        "\"Safer\" approach",
        "Adding complexity out of uncertainty rather than understanding the problem.",
    ),
    (
        re.compile(r"\bworkaround\b", re.IGNORECASE),
        "Workaround",
        "A workaround signals the root cause wasn't addressed.",
    ),
]


class RedFlag:
    """A single detected coping phrase."""

    __slots__ = ("label", "explanation", "excerpt")

    def __init__(self, label: str, explanation: str, excerpt: str) -> None:
        self.label = label
        self.explanation = explanation
        self.excerpt = excerpt

    def to_dict(self) -> dict:
        return {
            "label": self.label,
            "explanation": self.explanation,
            "excerpt": self.excerpt,
        }


def _is_prose_line(line: str) -> bool:
    """Return True if *line* looks like natural prose rather than structured content.

    Rejects table rows, markdown headers, code-fence markers, and lines that
    are too short to be meaningful prose (likely labels or list-item headings).
    """
    stripped = line.strip()
    if not stripped:
        return False
    # Markdown table row (contains pipe delimiters)
    if stripped.startswith("|") or stripped.endswith("|"):
        return False
    # Table separator line (e.g. | --- | --- |)
    if re.match(r"^[\s|:-]+$", stripped):
        return False
    # Code fence
    if stripped.startswith("```"):
        return False
    # Markdown header — typically a label, not prose justification
    if stripped.startswith("#"):
        return False
    # Very short lines are usually labels, list headings, or column values
    # Require at least 40 chars — enough for a short sentence with context
    if len(stripped) < 40:
        return False
    return True


def _extract_prose(output: str) -> str:
    """Return only the prose portions of *output*, filtering out structured content.

    Strips fenced code blocks entirely, then filters remaining lines through
    ``_is_prose_line``.  Preserves original character offsets by replacing
    rejected content with spaces (so excerpt extraction still works on the
    original string).
    """
    # First pass: blank out fenced code blocks (``` ... ```)
    result = list(output)
    for m in re.finditer(r"```[^\n]*\n.*?```", output, re.DOTALL):
        for i in range(m.start(), m.end()):
            result[i] = " "

    # Second pass: blank out non-prose lines
    pos = 0
    for line in output.splitlines(keepends=True):
        line_end = pos + len(line)
        if not _is_prose_line(line):
            for i in range(pos, line_end):
                if i < len(result):
                    result[i] = " "
        pos = line_end

    return "".join(result)


def detect_coping_phrases(output: str) -> list[dict]:
    """Scan *output* for coping phrases and return a list of red-flag dicts.

    Each dict has: label, explanation, excerpt (the surrounding context).
    Deduplicates by label — only the first occurrence of each pattern is reported.

    Only matches in prose lines are considered — table rows, code blocks,
    markdown headers, and short label-like lines are skipped to avoid false
    positives from structured/documentation content.
    """
    if not output:
        return []

    prose = _extract_prose(output)

    seen_labels: set[str] = set()
    flags: list[dict] = []

    for pattern, label, explanation in _PATTERNS:
        if label in seen_labels:
            continue
        m = pattern.search(prose)
        if m:
            seen_labels.add(label)
            # Extract ~80 chars of surrounding context from the *original* output
            start = max(0, m.start() - 40)
            end = min(len(output), m.end() + 40)
            excerpt = output[start:end].replace("\n", " ").strip()
            if start > 0:
                excerpt = "…" + excerpt
            if end < len(output):
                excerpt = excerpt + "…"
            flags.append(RedFlag(label, explanation, excerpt).to_dict())

    return flags
