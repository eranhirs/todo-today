"""Detect "coping" phrases in Claude run output.

Inspired by https://x.com/honnibal/status/2033141305384095848 — certain
phrases are strong signals that Claude is making bad choices: adding
overlapping mechanisms, silently swallowing errors, or over-engineering
instead of writing clean, minimal code.

Also detects deflection phrases — ways Claude avoids doing the actual work
by blaming pre-existing issues or declaring the task too large.

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
        re.compile(r"\bblast radius\b", re.IGNORECASE),
        "\"Blast radius\"",
        "Framing a change as dangerous to justify avoiding or circumventing it.",
    ),
    (
        re.compile(r"\bworkaround\b", re.IGNORECASE),
        "Workaround",
        "A workaround signals the root cause wasn't addressed.",
    ),
    # ── Deflection: avoiding the task ────────────────────────────
    (
        re.compile(r"\bpre-?existing (?:issue|problem|bug|error|failure)", re.IGNORECASE),
        "\"Pre-existing issue\"",
        "Blaming something else instead of fixing the problem at hand.",
    ),
    (
        re.compile(r"\b(?:major|significant|large[- ]scale) refactor", re.IGNORECASE),
        "\"Major refactor\"",
        "Declaring the task too large is a way to avoid doing it.",
    ),
    (
        re.compile(r"\bout(?:side| of) (?:the )?scope\b", re.IGNORECASE),
        "\"Out of scope\"",
        "Scope-dodging — the user asked for it, so it's in scope.",
    ),
    (
        re.compile(r"\bbeyond (?:the scope|what)", re.IGNORECASE),
        "\"Beyond the scope\"",
        "Another way to decline work the user requested.",
    ),
    (
        re.compile(r"\bseparate (?:task|effort|ticket|PR|pull request)\b", re.IGNORECASE),
        "\"Separate task\"",
        "Deferring work to an imaginary future task instead of doing it now.",
    ),
    (
        re.compile(r"\bnot (?:directly )?related to\b", re.IGNORECASE),
        "\"Not related to\"",
        "Dismissing relevant work as unrelated to avoid addressing it.",
    ),
    (
        re.compile(r"\bminimal(?:ly)? (?:invasive|impactful|disruptive)\b", re.IGNORECASE),
        "\"Minimally invasive\"",
        "Often a justification for a shallow fix instead of a proper one.",
    ),
    (
        re.compile(r"\bleave (?:that|this|it) (?:for|to|as) (?:a )?(?:later|future|another|the user)", re.IGNORECASE),
        "\"Leave for later\"",
        "Punting work to an undefined future instead of completing it now.",
    ),
    # ── Unilateral action: fixing without discussing ──────────────
    (
        re.compile(r"\bthe fix:", re.IGNORECASE),
        "\"The fix:\"",
        "Jumped straight to a fix without discussing it — acting on its own.",
    ),
    # ── Unilateral acceptance: deciding a limitation is okay ─────
    (
        re.compile(r"\b(?:is|are|seems?|that'?s|this is) acceptable\b", re.IGNORECASE),
        "Unilateral acceptance",
        "Model decided a limitation or trade-off is acceptable — that's the user's call.",
    ),
    (
        re.compile(r"\bacceptable (?:trade-?off|loss|gap|compromise|risk|cost|price)\b", re.IGNORECASE),
        "Unilateral acceptance",
        "Model decided a limitation or trade-off is acceptable — that's the user's call.",
    ),
    (
        re.compile(r"\b(?:gap|loss|limitation|trade-?off|compromise|risk|downside|drawback|issue|latency|delay) accepted\b", re.IGNORECASE),
        "Unilateral acceptance",
        "Model decided a limitation or trade-off is acceptable — that's the user's call.",
    ),
    (
        re.compile(r"\bgood enough\b", re.IGNORECASE),
        "\"Good enough\"",
        "Model decided the result meets the bar — the user should set the bar.",
    ),
    (
        re.compile(r"\b(?:we |I )?can live with\b", re.IGNORECASE),
        "\"Can live with\"",
        "Model accepted a compromise on the user's behalf.",
    ),
    (
        re.compile(r"\bnot worth (?:the effort|fixing|addressing|worrying|changing|it)\b", re.IGNORECASE),
        "\"Not worth it\"",
        "Model decided something isn't worth fixing — the user should make that call.",
    ),
    (
        re.compile(r"\bnegligible\b", re.IGNORECASE),
        "\"Negligible\"",
        "Model dismissed something as negligible — let the user decide what matters.",
    ),
    # ── Silent substitution: doing something we didn't agree on ─
    (
        re.compile(r"\bfall[- ]?back", re.IGNORECASE),
        "Fallback",
        "Model is silently substituting something — we didn't agree on a fallback.",
    ),
    # ── Dead code / deferred cleanup ──────────────────────────────
    (
        re.compile(r"\bdead code\b", re.IGNORECASE),
        "Dead code",
        "Mentions dead code — should be removed, not left behind.",
    ),
    # ── Complexity warning ────────────────────────────────────────
    (
        re.compile(r"\btricky (?:part|bit|thing|aspect|detail|edge|case|piece)\b", re.IGNORECASE),
        "\"Tricky part\"",
        "Model flagged something as tricky — review closely for correctness.",
    ),
    # ── Attention grab: Note: ─────────────────────────────────────
    (
        re.compile(r"(?:^|\n)\s*\**Note:?\**\s", re.IGNORECASE),
        "\"Note:\"",
        "Model is calling your attention to something — read it.",
    ),
    # ── Surprise: unexpected outcome ─────────────────────────────
    (
        re.compile(r"[A-Za-z][^.!?\n]{15,}!"),
        "Exclamation!",
        "Sentence ends with '!' — Claude sounds surprised. Check what happened.",
    ),
    # ── Strategy change: mid-course correction ───────────────────
    (
        re.compile(r"(?:^|\n)\s*Wait\b", re.IGNORECASE),
        "\"Wait\"",
        "Claude changed strategy mid-way — review why the original approach failed.",
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
            "resolved": False,
            "source": "pattern",
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
