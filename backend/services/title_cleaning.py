"""Phase 5.9 — clean leading "Chapter N" / "Act N" style prefixes from imported
chapter and act titles.

The single public entry point is :func:`clean_chapter_act_title`. It strips one
leading numbering prefix (a Chapter/Act keyword immediately followed by a number)
and returns the remaining title. It is deliberately conservative: when nothing
confident matches, or when stripping would leave the title empty, it returns the
original title unchanged. It never strips a bare number that has no keyword
("12 Angry Men", "1. The Title" pass through untouched), and it strips at most
one prefix ("Chapter 1: Chapter One" -> "Chapter One").

Scope (decided in Phase 5.9): keywords are Chapter, Ch, Chap and Act only
(case-insensitive, with an optional trailing dot). The number may be Arabic
(1, 42, 712), Roman (IV, xii), or spelled-out, including large forms with
hundreds / thousands and an optional "and" (One, Twenty-One, First, Seven
Hundred and Twelve). The number may be wrapped in parentheses ("Ch. (712):").
The separator between the number and the title may be a run of punctuation
(":", " :: ", " - ", ".", ")", "|"), plain whitespace, or nothing. A keyword is
only a prefix when a number follows it; "Act of God" and "Chapter and Verse"
are left intact.
"""
from __future__ import annotations

import re

# ── Spelled-out number forms ───────────────────────────────────────────────

_UNITS = "one two three four five six seven eight nine".split()
_TEENS = ("ten eleven twelve thirteen fourteen fifteen sixteen seventeen "
          "eighteen nineteen").split()
_TENS = "twenty thirty forty fifty sixty seventy eighty ninety".split()
_ORD_UNITS = "first second third fourth fifth sixth seventh eighth ninth".split()
_ORD_TEENS = ("tenth eleventh twelfth thirteenth fourteenth fifteenth sixteenth "
              "seventeenth eighteenth nineteenth").split()
_ORD_TENS = ("twentieth thirtieth fortieth fiftieth sixtieth seventieth "
             "eightieth ninetieth").split()


def _alt(words: list[str]) -> str:
    """Regex alternation of literal words, longest first so the longer word
    wins (e.g. 'tenth' before 'ten')."""
    return "|".join(re.escape(w) for w in sorted(set(words), key=len, reverse=True))


# A tens word, optionally hyphen/space joined to a unit or ordinal-unit:
# "twenty", "twenty-one", "twenty-first".
_TENS_BLOCK = rf"(?:{_alt(_TENS)})(?:[-\s](?:{_alt(_UNITS + _ORD_UNITS)}))?"
# 1-99: cardinal or two-digit ordinal.
_TWO_DIGIT = rf"(?:{_TENS_BLOCK}|{_alt(_TEENS + _ORD_TEENS + _ORD_TENS + _UNITS + _ORD_UNITS)})"
# 1-999: "<one..nine> hundred" then an optional "(and) <1-99>".
_HUNDREDS = rf"(?:{_alt(_UNITS)})[-\s]+hundred(?:[-\s]+(?:(?:and|&)[-\s]+)?{_TWO_DIGIT})?"
_THREE_DIGIT = rf"(?:{_HUNDREDS}|{_TWO_DIGIT})"
# 1000+: "<1-999> thousand" then an optional "(and) <1-999>".
_THOUSANDS = rf"(?:{_THREE_DIGIT})[-\s]+thousand(?:[-\s]+(?:(?:and|&)[-\s]+)?{_THREE_DIGIT})?"
# Longest first so a compound number wins over its leading fragment.
_WORDS = rf"(?:{_THOUSANDS}|{_HUNDREDS}|{_TWO_DIGIT})"

# Arabic: plain, dotted sub-numbering (1.102), or comma-grouped thousands (1,000).
_ARABIC = r"(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)*)"
# Strict Roman numeral (so plain words are not mistaken for numerals); the
# lookahead forces at least one numeral character.
_ROMAN = r"(?=[mdclxvi])m{0,4}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})"

_NUMBER = rf"(?:{_ARABIC}|{_ROMAN}|{_WORDS})"

# Separator after the number: a RUN of punctuation (with optional surrounding
# spaces — so "::" and " - " collapse fully), OR one-or-more spaces, OR end.
_SEP_PUNCT = r":.,)|–—\-"
_SEP = rf"[ \t]*[{_SEP_PUNCT}]+[ \t]*|[ \t]+|$"

# `lp` captures an optional opening paren around the number; the conditional
# `(?(lp)\))` requires a closing paren only when one was opened (so a trailing
# ")" used purely as a separator, e.g. "Act V) The Finale", is left for _SEP).
_PREFIX_RE = re.compile(
    rf"^(?:chapter|chap|ch|act)\.?[ \t]*(?P<lead>[{_SEP_PUNCT}]+[ \t]*)?"
    rf"(?P<lp>\()?[ \t]*(?>(?P<num>{_NUMBER}))[ \t]*(?(lp)\))"
    rf"(?P<sep>{_SEP})",
    re.IGNORECASE,
)

# A leftover multiplier word right after a whitespace-only separator means a
# larger number was under-parsed; keep the original rather than partial-strip.
_MULTIPLIER_RE = re.compile(r"^(?:hundred|thousand|million|billion)\b", re.IGNORECASE)
_SEP_PUNCT_RE = re.compile(rf"[{_SEP_PUNCT}]")

# Whole-string matching pairs of wrapping quotes to peel after stripping.
_QUOTE_PAIRS = (('"', '"'), ("'", "'"), ("“", "”"), ("‘", "’"))


def _strip_wrapping_quotes(text: str) -> str:
    """If the whole string is wrapped in one matching pair of quotes, drop them."""
    for open_q, close_q in _QUOTE_PAIRS:
        if len(text) >= 2 and text.startswith(open_q) and text.endswith(close_q):
            inner = text[len(open_q):len(text) - len(close_q)]
            if open_q not in inner or open_q != close_q:
                return inner.strip()
    return text


def _strip_prefix(text: str) -> tuple[bool, str]:
    """Core matcher. Returns ``(has_prefix, result)``:

    - ``has_prefix`` — a recognized leading Chapter/Act numbering prefix is
      present, EVEN when stripping it would empty the title (a bare
      "Chapter 26" has a prefix). This is the signal for "is numbering the
      convention here?".
    - ``result`` — `text` with that prefix removed, or the original `text`
      when there is no prefix OR removing it would leave nothing.

    `text` is expected already stripped of surrounding whitespace.
    """
    match = _PREFIX_RE.match(text)
    if not match:
        return (False, text)
    sep = match.group("sep") or ""
    sep_has_punct = bool(_SEP_PUNCT_RE.search(sep))
    # A separator BETWEEN the keyword and the number ("Chap:1...") only counts
    # when the number is ALSO closed by a punctuation separator (a bracketed
    # number), so a bare "Chapter: One More Thing" label is left intact.
    if match.group("lead") and not sep_has_punct:
        return (False, text)
    rest = text[match.end():]
    # Under-parse guard: a whitespace-only separator landing on a leftover
    # number-multiplier word ("Seven Million" -> matched "Seven", rest
    # "Million ...") means we clipped a larger number mid-word.
    if not sep_has_punct and _MULTIPLIER_RE.match(rest.lstrip()):
        return (False, text)
    rest = _strip_wrapping_quotes(rest.strip()).strip()
    if not rest:
        # Prefix present, but stripping would empty the title — keep original.
        return (True, text)
    return (True, rest)


def clean_chapter_act_title(title: str | None, blank_pure_prefix: bool = False) -> str:
    """Strip a single leading Chapter/Act numbering prefix from `title`.

    Returns the cleaned title, or the original (trimmed) title when no
    confident prefix is found. When stripping would empty the title (a pure
    numbering label like "Chapter 26"): returns the original by default, or an
    empty string when `blank_pure_prefix` is set. Import passes
    `blank_pure_prefix=True` so a bare "Chapter 26" becomes an UNNAMED chapter
    (auto-numbered by position) rather than a stored name that goes stale when
    chapters are reordered.
    """
    if not title:
        return title or ""
    stripped = title.strip()
    has_prefix, result = _strip_prefix(stripped)
    if blank_pure_prefix and has_prefix and result == stripped:
        return ""
    return result


def has_numbering_prefix(title: str | None) -> bool:
    """True when `title` begins with a recognized Chapter/Act numbering prefix,
    including a bare "Chapter 26" with no descriptive part. Used to decide
    whether prefix-numbering is the convention across a group of titles."""
    if not title or not title.strip():
        return False
    return _strip_prefix(title.strip())[0]
