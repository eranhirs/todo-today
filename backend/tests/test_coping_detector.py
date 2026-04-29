"""Tests for backend.coping_detector — focuses on exclamation false positives."""

from __future__ import annotations

from backend.coping_detector import detect_coping_phrases


def _labels(output: str) -> list[str]:
    return [f["label"] for f in detect_coping_phrases(output)]


# ── True positives: prose exclamations should be flagged ──────────────


def test_exclamation_in_prose_is_flagged():
    output = (
        "I dug into the failing test and discovered that the schema migration "
        "had silently been dropped — that's actually a much bigger deal than I expected!"
    )
    assert "Exclamation!" in _labels(output)


def test_exclamation_followed_by_quote_is_flagged():
    output = (
        "After running the suite I checked the report and the answer is clear: "
        '"every single integration test passed on the very first attempt!"'
    )
    assert "Exclamation!" in _labels(output)


# ── False positives: code-context exclamations should NOT be flagged ──


def test_inline_code_with_exclamation_not_flagged():
    output = (
        "I updated the Swift code so that the helper now reads "
        "`array[i]!.computedDescription()` directly inside the closure body."
    )
    assert "Exclamation!" not in _labels(output)


def test_inline_code_console_log_not_flagged():
    output = (
        "I sprinkled in a quick instrumentation line that calls "
        "`console.log(\"Hello world from the new debug path!\")` for diagnostics."
    )
    assert "Exclamation!" not in _labels(output)


def test_fenced_code_block_with_exclamation_not_flagged():
    output = (
        "Here is the helper I added to the script for diagnostics — it just "
        "prints a friendly banner so we know the build started:\n"
        "```python\n"
        "def banner():\n"
        "    print(\"Hello world from the build pipeline kickoff!\")\n"
        "```\n"
        "That's the only change I made to that file."
    )
    assert "Exclamation!" not in _labels(output)


def test_bash_tool_summary_not_flagged():
    output = (
        "Started the migration by running the helper command directly:\n"
        "$ echo \"running migration on the production replica right now!\"\n"
        "and then proceeded to verify the schema diff against staging."
    )
    assert "Exclamation!" not in _labels(output)


def test_tool_use_summary_not_flagged():
    output = (
        "I traced the failure end-to-end and surfaced the relevant file:\n"
        "[Read: /very/long/path/to/file/that/does/not/contain/an/exclamation]\n"
        "Then I made the targeted edit to fix the broken assertion path."
    )
    assert "Exclamation!" not in _labels(output)


def test_swift_force_unwrap_in_prose_without_backticks_not_flagged():
    # Char before `!` is `]`, sentence-end boundary required by new regex,
    # so the literal Swift force-unwrap pattern shouldn't match even without
    # backticks.
    output = (
        "The Swift compiler refused to accept array[index]!.value as written "
        "in the body of the function on the second branch of the conditional."
    )
    assert "Exclamation!" not in _labels(output)


def test_obj_dot_method_after_force_unwrap_not_flagged():
    # `someReallyLongObject!.foo()` — letter before `!`, but `.` after fails
    # the sentence-end boundary lookahead.
    output = (
        "The crash happened because someReallyLongObjectName!.foo() was being "
        "called before the underlying handle was actually initialized."
    )
    assert "Exclamation!" not in _labels(output)


# ── Other patterns still work ─────────────────────────────────────────


def test_other_patterns_still_detected():
    output = (
        "I added an extra layer of protection around the parser to handle "
        "edge cases that might come up in the future."
    )
    assert "Extra layer of protection" in _labels(output)
