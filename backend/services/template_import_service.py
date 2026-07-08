"""Phase 1.25h — Markdown template import.

Parses a populated NarrativeNode story template (see
`docs/import-template-format.md` for the full grammar) into an
intermediate representation, then applies the IR to a Story in
`new` or `merge` mode.

The IR is name-keyed throughout. UUIDs are minted at apply time. This
keeps the parser independent of any project state — a parse pass can
run server-side OR in a future client-side preview without dragging
the rest of the model in. It also makes the "future JSON template
variant" listed in the spec a parser-front-end change only; the IR +
applier are reused.

Parser shape:
- Two passes (structural, then resolution).
- Errors carry `{line, expected, found, hint}` so the import dialog
  can render line-by-line guidance.
- Strict on section/heading order and key names; tolerant on blank
  lines and surrounding whitespace.

Applier shape:
- New: wipes the active project, rebuilds from the IR, returns
  the rebuilt Story.
- Merge: name-suffix-dedups any collision against the live project
  and appends; never modifies existing data.
- Both auto-wire POV path (sequential through scene order) and
  per-entity narrative-flow connections (chip presence in scene N
  wires from the entity's previous appearance, or its origin).
"""

from __future__ import annotations

import html
import re
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional

from models.entity import (
    Alias,
    Attribute,
    AliasOverrideChange,
    CustomCategory,
    DescriptionChange,
    Entity,
    ExistenceChange,
    HierarchyChange,
    HierarchyConfig,
    HierarchyNode,
    NameChange,
    ParticipantChange,
    ParticipantRole,
    PerceptionChange,
    PresetList,
    Relationship,
    RoleChange,
)
from models.knowledge import (
    Knowledge,
    KnowledgeColourChange,
    KnowledgeDescriptionChange,
    KnowledgeExistenceChange,
    KnowledgeNameChange,
)
from models.entity import AwarenessHistoryEntry, AwarenessWrapper
from models.node import (
    AliasChange,
    AttributeChange as NodeAttributeChange,
    Circumstance,
    Duration,
    EntityNode,
    EntityRef,
    EntityTemporaryCM,
    KnowledgeOriginNode,
    PovOriginNode,
    Position,
    RelationshipOriginNode,
    SceneNode,
    TimeDelta,
)
from models.story import Act, Chapter, Story
from models.connection import Connection

# Engine-owned IR shape. Lifted in Phase 3.7b.
from services.import_engine import ImportIR




# ── Public types ────────────────────────────────────────────────────────────


@dataclass
class ParseError:
    """A parse-time diagnostic. `severity` is `'error'` (blocks the
    apply) or `'warning'` (parser auto-corrected or skipped the line;
    apply proceeds and the dialog surfaces the warning so the writer
    can review). Default `'error'` for back-compat with callers that
    constructed bare ParseError instances.

    `suggestions` is an optional list of plausible replacement values
    for the offending `found` substring — the dialog renders them as
    clickable quick-fix chips so the writer can apply a correction
    without having to retype the whole line.
    """
    line: int
    expected: str
    found: str
    hint: str = ""
    severity: str = "error"   # 'error' | 'warning'
    suggestions: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "line": self.line,
            "expected": self.expected,
            "found": self.found,
            "hint": self.hint,
            "severity": self.severity,
            "suggestions": list(self.suggestions),
        }




# ── Section / entry headings ────────────────────────────────────────────────

SECTION_ORDER = [
    "Story",
    "Preset Lists",
    "Custom Categories",
    "Chapters",
    "Acts",
    "Characters",
    "Locations",
    "Items",
    "Factions",
    "Customs",
    "Relationships",
    "Knowledge",
    "Scenes",
]

ENTRY_PREFIX = {
    "Preset Lists": "List:",
    "Custom Categories": "Category:",
    "Chapters": "Chapter:",
    "Acts": "Act:",
    "Characters": "Character:",
    "Locations": "Location:",
    "Items": "Item:",
    "Factions": "Faction:",
    "Customs": "Custom:",
    "Relationships": "Relationship:",
    "Knowledge": "Knowledge:",
    "Scenes": "Scene:",
}


# ── Public entry point ──────────────────────────────────────────────────────


def parse_template(text: str) -> tuple[ImportIR, list[ParseError]]:
    """Parse a populated story template. Returns (ir, errors). If errors
    is non-empty the IR may be partial; callers should not apply it."""
    raw_lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    lines = _strip_comments(raw_lines)
    parser = _Parser(lines)
    parser.run()
    parser.resolve_pass()
    return parser.ir, parser.errors


# ── Internals ───────────────────────────────────────────────────────────────


_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)


def _strip_comments(lines: list[str]) -> list[str]:
    """Remove single-line and short multi-line HTML-style comments. Each
    line index is preserved so error reporting still points at the
    original line numbers."""
    text = "\n".join(lines)
    text = _COMMENT_RE.sub(lambda m: "\n" * m.group(0).count("\n"), text)
    return text.split("\n")


def _is_blank(line: str) -> bool:
    return line.strip() == ""


def _section_heading(line: str) -> Optional[str]:
    if line.startswith("## ") and not line.startswith("### "):
        return line[3:].strip()
    return None


def _entry_heading(line: str) -> Optional[str]:
    if line.startswith("### ") and not line.startswith("#### "):
        return line[4:].strip()
    return None


def _sub_heading(line: str) -> Optional[str]:
    if line.startswith("#### "):
        return line[5:].strip()
    return None


_KEY_RE = re.compile(r"^\s*([a-z][a-z0-9_]*)\s*:\s*(.*)$")


def _key_value(line: str) -> Optional[tuple[str, str]]:
    m = _KEY_RE.match(line)
    if not m:
        return None
    return m.group(1), m.group(2).rstrip()


def _is_bullet(line: str) -> bool:
    return line.lstrip().startswith("- ")


def _bullet_payload(line: str) -> str:
    s = line.lstrip()
    return s[2:]  # drop "- "


def _strip_quotes(s: str) -> str:
    s = s.strip()
    if len(s) >= 2 and s[0] == '"' and s[-1] == '"':
        return s[1:-1].encode().decode("unicode_escape")
    return s


def _parse_value(raw: str) -> Optional[str]:
    """Coerce a key:value RHS into a string-or-None. `none` and empty
    string become None."""
    s = raw.strip()
    if s == "" or s.lower() == "none":
        return None
    return _strip_quotes(s)


def _parse_comma_list(raw: str) -> list[str]:
    """Split a comma-separated list, respecting quoted items."""
    s = raw.strip()
    if s == "" or s.lower() == "none":
        return []
    out: list[str] = []
    cur = ""
    in_quote = False
    i = 0
    while i < len(s):
        c = s[i]
        if c == '"':
            in_quote = not in_quote
            cur += c
        elif c == "," and not in_quote:
            out.append(_strip_quotes(cur))
            cur = ""
        else:
            cur += c
        i += 1
    if cur.strip():
        out.append(_strip_quotes(cur))
    return [x for x in out if x]


def _parse_hex_colour(raw: str) -> Optional[str]:
    s = raw.strip()
    if not s or s.lower() == "none":
        return None
    if re.match(r"^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$", s):
        return s.lower() if len(s) == 7 else s
    return s  # let downstream complain; we don't fail-hard on colour text


def _parse_bool(raw: str) -> Optional[bool]:
    s = raw.strip().lower()
    if s in ("true", "yes", "on"):
        return True
    if s in ("false", "no", "off"):
        return False
    if s == "" or s == "none":
        return None
    return None


def _parse_int(raw: str) -> Optional[int]:
    s = raw.strip()
    try:
        return int(s)
    except ValueError:
        return None


def _parse_float(raw: str) -> Optional[float]:
    s = raw.strip()
    try:
        return float(s)
    except ValueError:
        return None


def _clamp_intensity(v: int) -> int:
    """Clamp an LLM-supplied intensity into the 0..4 range. Out-of-range
    values are common when an LLM thinks of intensity as 1..5 or 1..10
    instead of the 0..4 ladder."""
    if v < 0: return 0
    if v > 4: return 4
    return v


# Descriptive words that map onto the 0..4 intensity ladder. Words are
# the canonical form exposed in the template; integers continue to work
# as input but the writer-facing surface uses words exclusively so the
# LLM doesn't have to memorise a numeric-to-meaning mapping.
_INTENSITY_WORDS: dict[str, int] = {
    "faint":    0,
    "mild":     1,
    "moderate": 2,
    "strong":   3,
    "intense":  4,
}


def _parse_intensity_token(token: str) -> Optional[int]:
    """Accept a descriptive intensity word (`faint`/`mild`/`moderate`/
    `strong`/`intense`) OR a digit (0..4); return the mapped integer,
    or None if the token is unrecognised. Word matching is case-
    insensitive."""
    if token is None:
        return None
    s = token.strip().lower()
    if not s:
        return None
    if s in _INTENSITY_WORDS:
        return _INTENSITY_WORDS[s]
    try:
        n = int(s)
        if 0 <= n <= 4:
            return n
        return _clamp_intensity(n)
    except ValueError:
        return None


# Awareness level words. Same set the writer-facing template advertises.
# `knows-self` is a synonym for `aware` reserved for cases where the
# observer IS the subject of the knowledge.
_AWARENESS_WORDS_TO_LEVEL: dict[str, int] = {
    "unaware":    0,
    "name-only":  1,
    "partial":    2,
    "aware":      3,
    "knows-self": 3,
}


def _parse_awareness_level_token(token: str) -> Optional[int]:
    """Accept an awareness level word (`unaware`/`name-only`/`partial`/
    `aware`/`knows-self`) OR a digit (0..3); return the mapped integer
    or None if unrecognised. Case-insensitive."""
    if token is None:
        return None
    s = token.strip().lower()
    if not s:
        return None
    if s in _AWARENESS_WORDS_TO_LEVEL:
        return _AWARENESS_WORDS_TO_LEVEL[s]
    try:
        n = int(s)
        if 0 <= n <= 3:
            return n
    except ValueError:
        pass
    return None


WEEKDAY_NAMES = {
    "sunday": 0, "monday": 1, "tuesday": 2, "wednesday": 3,
    "thursday": 4, "friday": 5, "saturday": 6,
}

MONTH_NAMES = {
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6,
    "july": 7, "august": 8, "september": 9, "october": 10, "november": 11, "december": 12,
}

SEASON_NAMES = {"spring": 0, "summer": 1, "fall": 2, "autumn": 2, "winter": 3}

LABELLED_TIMES = {
    "dawn", "early morning", "morning", "late morning", "noon",
    "early afternoon", "afternoon", "late afternoon", "evening",
    "night", "late night", "midnight",
}


class _Parser:
    def __init__(self, lines: list[str]):
        self.lines = lines
        self.i = 0
        self.ir = ImportIR()
        self.errors: list[ParseError] = []
        # Resolution-pass index of names → IR entries.
        self._entity_index: dict[str, dict] = {}  # name -> entity dict (any of 5 types)
        self._name_collisions: dict[str, int] = {}

    # ── line helpers ───────────────────────────────────────────────────

    def line_no(self, idx: Optional[int] = None) -> int:
        return (self.i if idx is None else idx) + 1

    def err(self, expected: str, found: str, hint: str = "", line: Optional[int] = None,
            suggestions: Optional[list[str]] = None) -> None:
        self.errors.append(ParseError(
            line=line or self.line_no(),
            expected=expected,
            found=found,
            hint=hint,
            suggestions=list(suggestions or []),
        ))

    def _close_matches(self, target: str, candidates, n: int = 3) -> list[str]:
        """Fuzzy-match `target` against `candidates` (any iterable of
        names) and return up to `n` closest hits. Used to power the
        suggestion chips on missing-reference errors."""
        import difflib
        return difflib.get_close_matches(target or "", list(candidates), n=n, cutoff=0.4)

    def peek(self) -> Optional[str]:
        if self.i >= len(self.lines):
            return None
        return self.lines[self.i]

    def advance(self) -> str:
        line = self.lines[self.i]
        self.i += 1
        return line

    def skip_blank(self) -> None:
        while self.i < len(self.lines) and _is_blank(self.lines[self.i]):
            self.i += 1

    # ── top-level driver ───────────────────────────────────────────────

    def run(self) -> None:
        # Skip preamble (anything before the first ## section heading).
        while self.i < len(self.lines):
            line = self.lines[self.i]
            if _section_heading(line) is not None:
                break
            self.i += 1

        seen_sections: list[str] = []
        while self.i < len(self.lines):
            self.skip_blank()
            if self.i >= len(self.lines):
                break
            line = self.lines[self.i]
            heading = _section_heading(line)
            if heading is None:
                self.err(
                    expected="a `## Section` heading",
                    found=line.strip() or "(blank)",
                    hint="Top-level sections start with two hashes followed by a space.",
                )
                self.i += 1
                continue
            self.i += 1  # consume heading
            if heading not in SECTION_ORDER:
                self.err(
                    expected=f"one of {', '.join(SECTION_ORDER)}",
                    found=f"`## {heading}`",
                    hint="Unknown section name. Section headings are fixed.",
                    line=self.line_no() - 1,
                )
                # Skip to next section
                self._skip_to_next_section()
                continue
            if heading in seen_sections:
                self.err(
                    expected=f"each section to appear once",
                    found=f"duplicate `## {heading}`",
                    line=self.line_no() - 1,
                )
                self._skip_to_next_section()
                continue
            expected_pos = len(seen_sections)
            actual_pos = SECTION_ORDER.index(heading)
            if actual_pos < expected_pos:
                self.err(
                    expected=f"section `## {SECTION_ORDER[expected_pos]}` next (sections must appear in fixed order)",
                    found=f"`## {heading}` (out of order)",
                    line=self.line_no() - 1,
                )
            seen_sections.append(heading)
            self._parse_section(heading)

    def _skip_to_next_section(self) -> None:
        while self.i < len(self.lines):
            if _section_heading(self.lines[self.i]) is not None:
                return
            self.i += 1

    def _parse_section(self, heading: str) -> None:
        if heading == "Story":
            self._parse_story()
        elif heading == "Preset Lists":
            self._parse_preset_lists()
        elif heading == "Custom Categories":
            self._parse_custom_categories()
        elif heading == "Chapters":
            self._parse_chapters()
        elif heading == "Acts":
            self._parse_acts()
        elif heading == "Characters":
            self._parse_entities("character")
        elif heading == "Locations":
            self._parse_entities("location")
        elif heading == "Items":
            self._parse_entities("item")
        elif heading == "Factions":
            self._parse_entities("faction")
        elif heading == "Customs":
            self._parse_entities("custom")
        elif heading == "Relationships":
            self._parse_relationships()
        elif heading == "Knowledge":
            self._parse_knowledges()
        elif heading == "Scenes":
            self._parse_scenes()

    # ── Section parsers ────────────────────────────────────────────────

    def _consume_kv_block(self, allowed_keys: set[str]) -> dict:
        """Consume contiguous key:value lines into a dict. Stops at blank
        line, sub-heading, entry heading, section heading, or bullet."""
        out: dict[str, str] = {}
        while self.i < len(self.lines):
            line = self.lines[self.i]
            if _is_blank(line):
                break
            if _section_heading(line) is not None or _entry_heading(line) is not None or _sub_heading(line) is not None:
                break
            if _is_bullet(line):
                break
            kv = _key_value(line)
            if kv is None:
                self.err(
                    expected="a `key: value` line",
                    found=line.strip(),
                    hint="Keys are lowercase letters, digits, and underscores; followed by a colon.",
                )
                self.i += 1
                continue
            key, val = kv
            if allowed_keys and key not in allowed_keys:
                # Unknown keys are non-fatal: stored in the dict but
                # never read by the applier. Demoted to a warning so a
                # template authored against an older grammar (or a
                # future grammar with additive keys) still parses.
                self.errors.append(ParseError(
                    line=self.line_no(), severity="warning",
                    expected=f"one of: {', '.join(sorted(allowed_keys))}",
                    found=f"key `{key}`",
                    hint="Unknown key — ignored.",
                ))
            out[key] = val
            self.i += 1
        return out

    def _parse_story(self) -> None:
        self.skip_blank()
        allowed = {
            "title", "author", "genre", "tense", "pov_default", "language", "tags",
            "accent_colour", "accent_color", "pov_colour", "pov_color",
            "chapter_label", "act_label", "time_tracking", "time_format",
            "week_start", "allow_negative_time",
        }
        kv = self._consume_kv_block(allowed)
        if "title" not in kv:
            self.err(
                expected="`title:` key in Story section",
                found="missing title",
                hint="Add a `title: ...` line in the Story section.",
            )
        self.ir.story = kv

    def _parse_preset_lists(self) -> None:
        for name, body_start, body_end in self._iter_entries("Preset Lists"):
            values = []
            for j in range(body_start, body_end):
                line = self.lines[j]
                if _is_blank(line):
                    continue
                if _is_bullet(line):
                    values.append(_strip_quotes(_bullet_payload(line)))
                else:
                    self.err(
                        expected="a `- value` bullet",
                        found=line.strip(),
                        line=j + 1,
                    )
            self.ir.preset_lists.append({"name": name, "values": values})

    def _parse_custom_categories(self) -> None:
        for name, body_start, body_end in self._iter_entries("Custom Categories"):
            kv = self._kv_in_range(body_start, body_end, allowed={"description", "colour", "color"})
            self.ir.custom_categories.append({
                "name": name,
                "description": kv.get("description", ""),
                "colour": kv.get("colour", kv.get("color", "#888888")),
            })

    def _parse_chapters(self) -> None:
        for name, body_start, body_end in self._iter_entries("Chapters"):
            kv = self._kv_in_range(body_start, body_end, allowed={"colour", "color", "width"})
            chapter = {"title": name}
            colour = kv.get("colour") or kv.get("color")
            if colour:
                chapter["colour"] = _parse_hex_colour(colour)
            if "width" in kv:
                w = _parse_float(kv["width"])
                if w is not None:
                    chapter["width"] = w
            self.ir.chapters.append(chapter)

    def _parse_acts(self) -> None:
        for name, body_start, body_end in self._iter_entries("Acts"):
            kv = self._kv_in_range(body_start, body_end, allowed={"chapters", "colour", "color"})
            chapters = _parse_comma_list(kv.get("chapters", ""))
            act = {"title": name, "chapters": chapters}
            colour = kv.get("colour") or kv.get("color")
            if colour:
                act["colour"] = _parse_hex_colour(colour)
            self.ir.acts.append(act)

    def _parse_entities(self, etype: str) -> None:
        section_label = {
            "character": "Characters", "location": "Locations", "item": "Items",
            "faction": "Factions", "custom": "Customs",
        }[etype]
        for name, body_start, body_end in self._iter_entries(section_label):
            entity = self._parse_entity_body(name, etype, body_start, body_end)
            target = {
                "character": self.ir.characters,
                "location": self.ir.locations,
                "item": self.ir.items,
                "faction": self.ir.factions,
                "custom": self.ir.customs,
            }[etype]
            target.append(entity)

    def _parse_entity_body(self, name: str, etype: str, body_start: int, body_end: int) -> dict:
        # Walk body. Top is a key:value block; then optional `#### Attributes`.
        kv = {}
        attributes: list[dict] = []
        j = body_start
        while j < body_end:
            line = self.lines[j]
            if _is_blank(line):
                j += 1
                continue
            sub = _sub_heading(line)
            if sub is not None:
                if sub.lower() == "attributes":
                    j += 1
                    j, attributes = self._parse_attribute_bullets(j, body_end)
                    continue
                self.err(
                    expected="`#### Attributes` (only sub-heading allowed in entity body)",
                    found=f"`#### {sub}`",
                    line=j + 1,
                )
                j += 1
                continue
            kvp = _key_value(line)
            if kvp is None:
                self.err(
                    expected="a `key: value` line or `#### Attributes`",
                    found=line.strip(),
                    line=j + 1,
                )
                j += 1
                continue
            kv[kvp[0]] = kvp[1]
            j += 1

        entity = {
            "name": name,
            "type": etype,
            "colour": _parse_hex_colour(kv.get("colour") or kv.get("color") or "#888888"),
            "description": kv.get("description", ""),
            "aliases": _parse_comma_list(kv.get("aliases", "")),
            "notes": kv.get("notes", ""),
            "awareness_scale": kv.get("awareness_scale", "binary").strip() or "binary",
            "name_awareness_scale": kv.get("name_awareness_scale", "full").strip() or "full",
            "attributes": attributes,
        }
        if etype == "custom":
            entity["category"] = kv.get("category", "").strip()
            entity["label"] = kv.get("label", "").strip() or None
        if etype == "location":
            entity["parent"] = kv.get("parent", "").strip() or None
        return entity

    def _parse_attribute_bullets(self, j: int, body_end: int) -> tuple[int, list[dict]]:
        attrs: list[dict] = []
        while j < body_end:
            line = self.lines[j]
            if _is_blank(line):
                j += 1
                continue
            if _sub_heading(line) is not None:
                break
            if not _is_bullet(line):
                self.err(
                    expected="a `- type: ...` attribute bullet",
                    found=line.strip(),
                    line=j + 1,
                )
                j += 1
                continue
            payload = _bullet_payload(line).strip()
            attr = self._parse_attribute_payload(payload, j + 1)
            if attr is not None:
                attrs.append(attr)
            j += 1
        return j, attrs

    def _parse_attribute_payload(self, payload: str, lineno: int) -> Optional[dict]:
        # type: rest
        m = re.match(r"^([a-z_]+)\s*:\s*(.*)$", payload)
        if not m:
            self.err(
                expected="a `<type>: ...` attribute bullet (e.g. `text: Mood = \"Curious\"`)",
                found=payload,
                line=lineno,
            )
            return None
        atype, rest = m.group(1), m.group(2).strip()
        if atype not in {"text", "preset", "text_list", "entity_list", "number", "circumstance", "motivator", "file"}:
            self.err(
                expected="one of: text, preset, text_list, entity_list, number, circumstance, motivator, file",
                found=atype,
                line=lineno,
            )
            return None
        if atype in ("circumstance", "motivator"):
            return self._parse_circumstance_motivator_payload(atype, rest, lineno)
        # `file:` attributes carry only a name — no `= <value>` is
        # accepted because binary assets can't be bundled in the
        # template (see import-template-format.md §"file"). Handle
        # this branch BEFORE the `<name> = <value>` requirement check
        # so a bare `file: Reference Photo` doesn't get rejected as
        # malformed.
        if atype == "file":
            nm = _strip_quotes(rest)
            if not nm:
                self.err(
                    expected="a `file: <name>` bullet",
                    found=rest,
                    line=lineno,
                )
                return None
            return {"name": nm, "type": "file", "value": ""}
        # `<name> = <value>`
        eq = rest.find("=")
        if eq < 0:
            self.err(
                expected="`<name> = <value>` format",
                found=rest,
                line=lineno,
            )
            return None
        nm = rest[:eq].strip()
        nm = _strip_quotes(nm)
        rhs = rest[eq + 1:].strip()
        attr = {"name": nm, "type": atype}
        if atype == "text":
            attr["value"] = _strip_quotes(rhs)
        elif atype == "preset":
            mm = re.match(r'^(.*?)\s*\(from\s+"(.+?)"\s*\)\s*$', rhs)
            if not mm:
                self.err(
                    expected='`<value> (from "<list name>")`',
                    found=rhs,
                    line=lineno,
                )
                return None
            attr["value"] = _strip_quotes(mm.group(1))
            attr["preset_list_name"] = mm.group(2)
        elif atype == "number":
            v = _parse_float(rhs)
            if v is None:
                self.err(
                    expected="a numeric value",
                    found=rhs,
                    line=lineno,
                )
                return None
            attr["number_value"] = v
        elif atype in ("text_list", "entity_list"):
            items = self._parse_bracket_list(rhs, lineno)
            attr["items"] = items
        elif atype == "file":
            attr["value"] = ""
        return attr

    def _parse_bracket_list(self, raw: str, lineno: int) -> list[str]:
        s = raw.strip()
        if not (s.startswith("[") and s.endswith("]")):
            self.err(
                expected="a bracketed list `[item, item, ...]`",
                found=s,
                line=lineno,
            )
            return []
        inner = s[1:-1]
        return _parse_comma_list(inner)

    # Captures: name (quoted | bare), intensity token (word or digit), description.
    _CM_RE = re.compile(
        r'^(?:"([^"]*)"|([^\[:]*?))\s*(?:\[([A-Za-z]+|\d+)\])?\s*(?::\s*(.*))?$'
    )

    def _parse_circumstance_motivator_payload(self, atype: str, rest: str, lineno: int) -> Optional[dict]:
        m = self._CM_RE.match(rest)
        if not m:
            self.err(
                expected=f'`{atype}: "<name>" [<intensity>] : "<description>"`',
                found=rest,
                line=lineno,
            )
            return None
        name = (m.group(1) if m.group(1) is not None else m.group(2) or "").strip()
        raw_intensity = m.group(3)
        desc = _strip_quotes((m.group(4) or "").strip())
        attr: dict = {"name": name, "type": atype}
        if raw_intensity is not None:
            mapped = _parse_intensity_token(raw_intensity)
            if mapped is None:
                self.errors.append(ParseError(
                    line=lineno, severity="warning",
                    expected="intensity word (faint, mild, moderate, strong, intense)",
                    found=raw_intensity,
                    hint="Unrecognised — intensity left unset.",
                ))
            else:
                attr["intensity"] = mapped
        attr["description"] = desc
        if not (name or desc):
            self.err(
                expected=f"a name or description for the {atype}",
                found="both empty",
                line=lineno,
            )
        return attr

    def _parse_relationships(self) -> None:
        for name, body_start, body_end in self._iter_entries("Relationships"):
            kv = {}
            participants: list[dict] = []
            hierarchy: Optional[dict] = None
            j = body_start
            in_participants = False
            in_hierarchy = False
            in_hierarchy_tree = False  # set by `tree:` key under hierarchy
            hierarchy_data: dict = {}
            while j < body_end:
                line = self.lines[j]
                if _is_blank(line):
                    j += 1
                    in_participants = False
                    in_hierarchy = False
                    in_hierarchy_tree = False
                    continue
                if _is_bullet(line):
                    if in_participants:
                        p = self._parse_participant_bullet(_bullet_payload(line), j + 1)
                        if p:
                            participants.append(p)
                        j += 1
                        continue
                    elif in_hierarchy_tree or in_hierarchy:
                        # Nested-bullet tree under `hierarchy:` (with or
                        # without an explicit `tree:` key). Parse from this
                        # bullet through to the first non-bullet / blank
                        # line, building a list of {name, children} nodes.
                        tree, j = self._parse_hierarchy_bullet_tree(j, body_end)
                        if tree:
                            hierarchy_data["tree"] = tree
                        in_hierarchy_tree = True
                        in_hierarchy = True
                        continue
                    else:
                        self.err(
                            expected="`participants:` heading before participant bullets",
                            found=line.strip(),
                            line=j + 1,
                        )
                        j += 1
                        continue
                kvp = _key_value(line)
                if kvp is None:
                    self.err(expected="a `key: value` line", found=line.strip(), line=j + 1)
                    j += 1
                    continue
                k, v = kvp
                in_participants = False
                in_hierarchy_tree = False
                if k == "participants":
                    in_hierarchy = False
                    in_participants = True
                elif k == "hierarchy":
                    in_hierarchy = True
                elif in_hierarchy or k in ("root", "order", "mode", "tree"):
                    # bare root: / order: / mode: / tree: lines treated as hierarchy continuation
                    in_hierarchy = True
                    if k == "root":
                        hierarchy_data["root"] = v.strip()
                    elif k == "order":
                        hierarchy_data["order"] = _parse_comma_list(v)
                    elif k == "mode":
                        hierarchy_data["mode"] = v.strip()
                    elif k == "tree":
                        # `tree:` with no value on the same line just opens
                        # the nested-bullet sub-block; the bullets follow.
                        in_hierarchy_tree = True
                    else:
                        # an indented hierarchy.* style; tolerate
                        hierarchy_data[k] = v.strip()
                else:
                    in_hierarchy = False
                    kv[k] = v
                j += 1
            if hierarchy_data:
                hierarchy = hierarchy_data
            self.ir.relationships.append({
                "name": name,
                "description": kv.get("description", ""),
                "participants": participants,
                "hierarchy": hierarchy,
                "awareness_scale": kv.get("awareness_scale", "binary").strip() or "binary",
                "membership_of": (kv.get("membership_of") or "").strip() or None,
            })

    _PARTICIPANT_RE = re.compile(
        r'^(?P<name>[^:]+?)\s*:\s*'
        r'(?:perception\s+"(?P<perception>[^"]*)")?'
        r'\s*;?\s*'
        r'(?:role\s+"(?P<role>[^"]*)")?\s*$'
    )

    def _parse_hierarchy_bullet_tree(self, j_start: int, body_end: int) -> tuple[list[dict], int]:
        """Parse nested-bullet hierarchy tree starting at line j_start.

        Reads consecutive bullet lines, using leading-whitespace indentation
        to determine parent-child nesting. Stops on the first non-bullet
        line, blank line, or end of body. Returns (tree, j_after) where
        `tree` is a list of `{name: str, children: [...]}` dicts and
        `j_after` is the index of the first non-tree line (caller resumes
        parsing from there).

        Names are stripped of trailing `:` (so writers can use either
        `- Alice:` then nested children or just `- Alice` with the
        children determined purely by indentation).
        """
        tree: list[dict] = []
        # Stack entries: (children-list-to-append-into, indent-level).
        # Sentinel root has indent -1 so the first real bullet always
        # nests under it.
        stack: list[tuple[list[dict], int]] = [(tree, -1)]
        j = j_start
        while j < body_end:
            line = self.lines[j]
            if _is_blank(line):
                return tree, j
            if not _is_bullet(line):
                return tree, j
            indent = len(line) - len(line.lstrip(' '))
            payload = _bullet_payload(line).strip()
            # Strip a trailing ':' so `- Alice:` and `- Alice` are equivalent
            # name forms.
            if payload.endswith(':'):
                payload = payload[:-1].rstrip()
            # Pop the stack while the top's indent is >= our indent;
            # the remaining top is our parent's children list.
            while len(stack) > 1 and stack[-1][1] >= indent:
                stack.pop()
            node: dict = {"name": payload, "children": []}
            stack[-1][0].append(node)
            stack.append((node["children"], indent))
            j += 1
        return tree, j

    def _parse_participant_bullet(self, payload: str, lineno: int) -> Optional[dict]:
        s = payload.strip()
        # Allow either order of perception/role; allow either alone.
        m = re.match(r'^([^:]+?)\s*:\s*(.*)$', s)
        if not m:
            self.err(
                expected='`<entity name>: perception "..."; role "..."`',
                found=s,
                line=lineno,
            )
            return None
        name = m.group(1).strip()
        rest = m.group(2).strip()
        perception = ""
        role = ""
        # extract perception "..."
        pm = re.search(r'perception\s+"((?:[^"\\]|\\.)*)"', rest)
        if pm:
            perception = pm.group(1).encode().decode("unicode_escape")
        rm = re.search(r'role\s+"((?:[^"\\]|\\.)*)"', rest)
        if rm:
            role = rm.group(1).encode().decode("unicode_escape")
        return {"name": name, "perception": perception, "role": role}

    def _parse_knowledges(self) -> None:
        for name, body_start, body_end in self._iter_entries("Knowledge"):
            kv = {}
            awareness: list[dict] = []
            j = body_start
            in_awareness = False
            while j < body_end:
                line = self.lines[j]
                if _is_blank(line):
                    j += 1
                    in_awareness = False
                    continue
                if _is_bullet(line):
                    if in_awareness:
                        a = self._parse_awareness_bullet(_bullet_payload(line), j + 1)
                        if a:
                            awareness.append(a)
                    else:
                        self.err(
                            expected="`awareness:` heading before awareness bullets",
                            found=line.strip(),
                            line=j + 1,
                        )
                    j += 1
                    continue
                kvp = _key_value(line)
                if kvp is None:
                    self.err(expected="a `key: value` line", found=line.strip(), line=j + 1)
                    j += 1
                    continue
                k, v = kvp
                if k == "awareness":
                    in_awareness = True
                else:
                    in_awareness = False
                    kv[k] = v
                j += 1
            self.ir.knowledges.append({
                "name": name,
                "colour": _parse_hex_colour(kv.get("colour") or kv.get("color") or "#888888"),
                "description": kv.get("description", ""),
                "notes": kv.get("notes", ""),
                "awareness_scale": kv.get("awareness_scale", "full").strip() or "full",
                "awareness": awareness,
            })

    _AWARENESS_LEVEL_WORDS = {
        "unaware": 0, "name-only": 1, "partial": 2, "aware": 3, "knows-self": 3,
    }

    def _parse_awareness_bullet(self, payload: str, lineno: int) -> Optional[dict]:
        s = payload.strip()
        # `<entity name>: <word> (<num>)`  OR `<entity>: <word>` OR `<entity>: (<num>)`
        m = re.match(r'^([^:]+?)\s*:\s*(.*)$', s)
        if not m:
            self.err(
                expected='`<entity name>: <level word> (<numeric level>)`',
                found=s,
                line=lineno,
            )
            return None
        observer = m.group(1).strip()
        rest = m.group(2).strip()
        word_match = re.match(r'^([a-z\-]+)\s*(?:\((\d+)\))?\s*$', rest)
        num_only = re.match(r'^\((\d+)\)\s*$', rest)
        if word_match:
            word = word_match.group(1)
            num = int(word_match.group(2)) if word_match.group(2) else None
            if word not in self._AWARENESS_LEVEL_WORDS:
                self.err(
                    expected="one of: unaware, name-only, partial, aware, knows-self",
                    found=word,
                    line=lineno,
                )
                return None
            word_num = self._AWARENESS_LEVEL_WORDS[word]
            if num is not None and num != word_num:
                # Word and numeric disagree. Trust the numeric since
                # it's more specific and writers / LLMs commonly write
                # `aware (1)` to mean level-1 awareness rather than
                # carefully matching the word. Surface as a warning so
                # the writer can review.
                self.errors.append(ParseError(
                    line=lineno, severity="warning",
                    expected=f"numeric level {word_num} to match `{word}`",
                    found=f"{word} ({num})",
                    hint=f"Took numeric level {num} (more specific); ignored word mismatch.",
                ))
                level = num
            else:
                level = word_num
        elif num_only:
            level = int(num_only.group(1))
        else:
            self.err(
                expected='`<level word> (<numeric>)` (e.g. `aware (3)`)',
                found=rest,
                line=lineno,
            )
            return None
        if level not in (0, 1, 2, 3):
            self.err(
                expected="level in 0..3",
                found=str(level),
                line=lineno,
            )
            return None
        return {"observer": observer, "level": level}

    def _parse_scenes(self) -> None:
        for name, body_start, body_end in self._iter_entries("Scenes"):
            scene = self._parse_scene_body(name, body_start, body_end)
            scene["_line"] = body_start  # 1-indexed heading line for diagnostics
            self.ir.scenes.append(scene)

    def _parse_scene_body(self, title: str, body_start: int, body_end: int) -> dict:
        kv = {}
        circumstances: list[dict] = []
        changes: list[dict] = []
        content = ""
        j = body_start
        while j < body_end:
            line = self.lines[j]
            if _is_blank(line):
                j += 1
                continue
            sub = _sub_heading(line)
            if sub is not None:
                if sub.lower() == "circumstances":
                    j += 1
                    j, circumstances = self._parse_circumstance_bullets(j, body_end)
                    continue
                if sub.lower() in ("changes at this scene", "changes"):
                    j += 1
                    j, changes = self._parse_change_bullets(j, body_end)
                    continue
                self.err(
                    expected="`#### Circumstances` or `#### Changes at this scene`",
                    found=f"`#### {sub}`",
                    line=j + 1,
                )
                j += 1
                continue
            kvp = _key_value(line)
            if kvp is None:
                self.err(
                    expected="a `key: value` line, `#### Circumstances`, or `#### Changes at this scene`",
                    found=line.strip(),
                    line=j + 1,
                )
                j += 1
                continue
            k, v = kvp
            if k == "content" and v.strip() == "":
                # fenced block follows
                j += 1
                content, j = self._consume_fenced_block(j, body_end)
                continue
            kv[k] = v
            j += 1
        return {
            "title": title,
            "chapter": kv.get("chapter"),
            "description": kv.get("description", ""),
            "pov": (kv.get("pov") or "").strip() or None,
            "characters": _parse_comma_list(kv.get("characters", "")),
            "locations": _parse_comma_list(kv.get("locations", "")),
            "items": _parse_comma_list(kv.get("items", "")),
            "factions": _parse_comma_list(kv.get("factions", "")),
            "customs": _parse_comma_list(kv.get("customs", "")),
            "time_of_day": kv.get("time_of_day"),
            "weekday": kv.get("weekday"),
            "season": kv.get("season"),
            "date": kv.get("date"),
            "duration": kv.get("duration"),
            "gap": kv.get("gap"),
            # Flashback child scene — references the parent scene by
            # title. When set, the resulting scene becomes a flashback
            # (`is_flashback=true`), its chip lists are forced empty
            # because chips are inherited live from the parent at
            # render time, and a parent-link wire is created in the
            # _wire_flashback_parents post-pass. Parent must resolve
            # to a regular (non-flashback) scene declared elsewhere in
            # the template; flashback-of-flashback is rejected.
            "flashback_of": (kv.get("flashback_of") or "").strip() or None,
            "content": content,
            "circumstances": circumstances,
            "changes": changes,
        }

    def _consume_fenced_block(self, j: int, body_end: int) -> tuple[str, int]:
        if j >= body_end or not self.lines[j].lstrip().startswith("```"):
            self.err(
                expected="a fenced block ``` ... ``` after `content:`",
                found=self.lines[j].strip() if j < body_end else "(end of section)",
                line=j + 1,
            )
            return "", j
        j += 1  # skip opening fence
        body_lines = []
        while j < body_end:
            line = self.lines[j]
            if line.lstrip().startswith("```"):
                j += 1
                return "\n".join(body_lines), j
            body_lines.append(line)
            j += 1
        self.err(
            expected="closing ``` for fenced content block",
            found="end of section",
            line=j,
        )
        return "\n".join(body_lines), j

    def _parse_circumstance_bullets(self, j: int, body_end: int) -> tuple[int, list[dict]]:
        out: list[dict] = []
        while j < body_end:
            line = self.lines[j]
            if _is_blank(line):
                j += 1
                continue
            if _sub_heading(line) is not None:
                break
            if not _is_bullet(line):
                # likely a key: line for the next scene field; stop
                break
            payload = _bullet_payload(line).strip()
            c = self._parse_circumstance_motivator_payload("circumstance", payload, j + 1)
            if c:
                out.append({
                    "name": c.get("name", ""),
                    "description": c.get("description", ""),
                    "intensity": c.get("intensity"),
                })
            j += 1
        return j, out

    def _parse_change_bullets(self, j: int, body_end: int) -> tuple[int, list[dict]]:
        out: list[dict] = []
        while j < body_end:
            line = self.lines[j]
            if _is_blank(line):
                j += 1
                continue
            if _sub_heading(line) is not None:
                break
            if not _is_bullet(line):
                break
            payload = _bullet_payload(line).strip()
            change = _parse_change_bullet(payload, j + 1, self.errors)
            if change:
                # Stamp the bullet's source line so the resolution
                # pass can cite the right line in diagnostics.
                change["_line"] = j + 1
                out.append(change)
            j += 1
        return j, out

    # ── Generic helpers for entry iteration ────────────────────────────

    def _iter_entries(self, section_label: str):
        """Yield (entry_name, body_start_idx, body_end_idx) for each level-3
        entry in the current section, advancing `self.i` past the entire
        section. body slice is [body_start, body_end)."""
        prefix = ENTRY_PREFIX[section_label]
        # Loop over entries within this section.
        while self.i < len(self.lines):
            self.skip_blank()
            if self.i >= len(self.lines):
                return
            line = self.lines[self.i]
            if _section_heading(line) is not None:
                return
            entry = _entry_heading(line)
            if entry is None:
                self.err(
                    expected=f"`### {prefix} <name>`",
                    found=line.strip(),
                    hint=f"Entries in `{section_label}` start with `### {prefix}`.",
                )
                self.i += 1
                continue
            if not entry.startswith(prefix):
                self.err(
                    expected=f"`### {prefix} <name>`",
                    found=f"`### {entry}`",
                    hint=f"Entry headings in `{section_label}` must start with `{prefix}`.",
                )
                # treat the entry as the right kind anyway, to make parsing best-effort
                name = entry
            else:
                name = entry[len(prefix):].strip()
            self.i += 1  # consume entry heading
            body_start = self.i
            while self.i < len(self.lines):
                if _section_heading(self.lines[self.i]) is not None:
                    break
                if _entry_heading(self.lines[self.i]) is not None:
                    break
                self.i += 1
            body_end = self.i
            yield name, body_start, body_end

    def _kv_in_range(self, body_start: int, body_end: int, allowed: set[str]) -> dict:
        out = {}
        for j in range(body_start, body_end):
            line = self.lines[j]
            if _is_blank(line):
                continue
            if _is_bullet(line) or _sub_heading(line):
                continue
            kvp = _key_value(line)
            if kvp is None:
                self.err(expected="a `key: value` line", found=line.strip(), line=j + 1)
                continue
            k, v = kvp
            if allowed and k not in allowed:
                self.err(
                    expected=f"one of: {', '.join(sorted(allowed))}",
                    found=f"key `{k}`",
                    line=j + 1,
                )
            out[k] = v
        return out

    # ── Pass 2: cross-reference resolution ─────────────────────────────

    def resolve_pass(self) -> None:
        # Build entity name index
        for bucket in (self.ir.characters, self.ir.locations, self.ir.items,
                       self.ir.factions, self.ir.customs):
            for e in bucket:
                if e["name"] in self._entity_index:
                    self.err(
                        expected="unique entity names across all entity types",
                        found=f"duplicate name `{e['name']}`",
                    )
                self._entity_index[e["name"]] = e

        # Build other indices
        rel_names = {r["name"] for r in self.ir.relationships}
        kn_names = {k["name"] for k in self.ir.knowledges}
        chapter_names = [c["title"] for c in self.ir.chapters]
        preset_names = {p["name"] for p in self.ir.preset_lists}
        cat_names = {c["name"] for c in self.ir.custom_categories}

        # Validate Custom entity categories
        for c in self.ir.customs:
            if c.get("category") and c["category"] not in cat_names:
                self.err(
                    expected=f"a declared Custom Category named `{c['category']}`",
                    found=c["category"],
                    hint=f"Custom entity `{c['name']}` references an unknown category.",
                    suggestions=self._close_matches(c["category"], cat_names),
                )

        # Validate Location parents
        location_names = [loc["name"] for loc in self.ir.locations]
        for loc in self.ir.locations:
            if loc.get("parent") and loc["parent"] not in self._entity_index:
                self.err(
                    expected=f"a declared Location named `{loc['parent']}`",
                    found=loc["parent"],
                    hint=f"Location `{loc['name']}` has unknown parent.",
                    suggestions=self._close_matches(loc["parent"], location_names),
                )

        # Validate preset references
        for ent in self._entity_index.values():
            for attr in ent.get("attributes", []):
                if attr["type"] == "preset":
                    pn = attr.get("preset_list_name")
                    if pn and pn not in preset_names:
                        self.err(
                            expected=f"a declared Preset List named `{pn}`",
                            found=pn,
                            hint=f"Attribute `{ent['name']}.{attr['name']}` references unknown preset list.",
                            suggestions=self._close_matches(pn, preset_names),
                        )

        # Validate entity_list references
        for ent in self._entity_index.values():
            for attr in ent.get("attributes", []):
                if attr["type"] == "entity_list":
                    for nm in attr.get("items", []):
                        if nm not in self._entity_index:
                            self.err(
                                expected=f"a declared entity named `{nm}`",
                                found=nm,
                                hint=f"`{ent['name']}.{attr['name']}` references unknown entity.",
                                suggestions=self._close_matches(nm, self._entity_index.keys()),
                            )

        # Validate Acts span declared chapters contiguously
        for act in self.ir.acts:
            indices = []
            for ch in act["chapters"]:
                if ch not in chapter_names:
                    self.err(
                        expected=f"a declared Chapter named `{ch}`",
                        found=ch,
                        hint=f"Act `{act['title']}` references unknown chapter.",
                        suggestions=self._close_matches(ch, chapter_names),
                    )
                else:
                    indices.append(chapter_names.index(ch))
            if indices and indices != list(range(min(indices), max(indices) + 1)):
                self.err(
                    expected="contiguous chapters in Act",
                    found=f"chapters {act['chapters']}",
                    hint="Acts must span a contiguous run of chapters in declaration order.",
                )

        # Validate Relationship participants
        for rel in self.ir.relationships:
            for p in rel["participants"]:
                if p["name"] not in self._entity_index:
                    self.err(
                        expected=f"a declared entity named `{p['name']}`",
                        found=p["name"],
                        hint=f"Relationship `{rel['name']}` references unknown participant.",
                        suggestions=self._close_matches(p["name"], self._entity_index.keys()),
                    )
            h = rel.get("hierarchy")
            if h:
                if h.get("root") and h["root"] not in self._entity_index:
                    self.err(
                        expected=f"a declared entity named `{h['root']}`",
                        found=h["root"],
                        suggestions=self._close_matches(h["root"], self._entity_index.keys()),
                    )
                for nm in h.get("order", []):
                    if nm not in self._entity_index:
                        self.err(
                            expected=f"a declared entity named `{nm}`",
                            found=nm,
                            suggestions=self._close_matches(nm, self._entity_index.keys()),
                        )

        # Validate Knowledge awareness observers
        for kn in self.ir.knowledges:
            for a in kn.get("awareness", []):
                if a["observer"] not in self._entity_index:
                    self.err(
                        expected=f"a declared entity named `{a['observer']}`",
                        found=a["observer"],
                        hint=f"Knowledge `{kn['name']}` awareness references unknown entity.",
                        suggestions=self._close_matches(a["observer"], self._entity_index.keys()),
                    )

        # Validate Scenes
        for scene in self.ir.scenes:
            scene_line = scene.get("_line")
            if scene.get("chapter") and scene["chapter"] not in chapter_names:
                self.err(
                    expected=f"a declared Chapter named `{scene['chapter']}`",
                    found=scene["chapter"],
                    hint=f"Scene `{scene['title']}`.",
                    line=scene_line,
                    suggestions=self._close_matches(scene["chapter"], chapter_names),
                )
            for k in ("characters", "locations", "items", "factions", "customs"):
                for nm in scene.get(k, []):
                    if nm not in self._entity_index:
                        self.err(
                            expected=f"a declared entity named `{nm}`",
                            found=nm,
                            hint=f"Scene `{scene['title']}` chip list `{k}`.",
                            line=scene_line,
                            suggestions=self._close_matches(nm, self._entity_index.keys()),
                        )
            if scene.get("pov") and scene["pov"] not in scene.get("characters", []):
                self.err(
                    expected=f"POV character to be in scene's characters list",
                    found=f"`{scene['pov']}`",
                    line=scene_line,
                    suggestions=list(scene.get("characters", [])),
                    hint=f"Scene `{scene['title']}`.",
                )
            for change in scene.get("changes", []):
                self._validate_change(change, scene, rel_names, kn_names)

    def _validate_change(self, change: dict, scene: dict, rel_names: set, kn_names: set) -> None:
        # Best-effort cross-ref validation. Subjects are entity / rel / knowledge.
        # `_line` is the change-bullet's source line (stamped in
        # `_parse_change_bullets`); `found` is the OFFENDING SUBJECT
        # NAME, not a paraphrase, so the dialog can highlight it in
        # the line preview and substitute it via suggestion chips.
        kind = change.get("kind")
        subject = change.get("subject")
        change_line = change.get("_line") or scene.get("_line")
        if kind in ("entity_rename", "entity_change_description", "entity_change_colour",
                    "entity_add_alias", "entity_replace_aliases", "entity_attribute",
                    "entity_awareness", "entity_temporary_cm"):
            if subject not in self._entity_index:
                self.err(
                    expected=f"a declared entity named `{subject}`",
                    found=subject,
                    hint=f"Scene `{scene['title']}`.",
                    line=change_line,
                    suggestions=self._close_matches(subject, self._entity_index.keys()),
                )
        elif kind and kind.startswith("relationship_"):
            if subject not in rel_names:
                self.err(
                    expected=f"a declared Relationship named `{subject}`",
                    found=subject,
                    hint=f"Scene `{scene['title']}`.",
                    line=change_line,
                    suggestions=self._close_matches(subject, rel_names),
                )
        elif kind and kind.startswith("knowledge_"):
            if subject not in kn_names:
                self.err(
                    expected=f"a declared Knowledge named `{subject}`",
                    found=subject,
                    hint=f"Scene `{scene['title']}`.",
                    line=change_line,
                    suggestions=self._close_matches(subject, kn_names),
                )


# ── Change-bullet grammar ───────────────────────────────────────────────────


# ── Verb-level synonyms ─────────────────────────────────────────────────────
#
# An LLM (or a writer) may reach for a synonym instead of the canonical
# verb listed in the spec ("becomes called" vs `rename to`, "establishes"
# vs `activate`, "drop attribute" vs `remove attribute`, etc.). We
# accept these silently with a warning so the parse succeeds and the
# writer can review what was substituted, instead of blocking the
# import. Synonyms are NOT advertised in the spec or template — the
# canonical forms remain the documented contract; this is purely a
# resilience layer on the import side.
#
# Order matters: longer / more-specific synonyms must come BEFORE
# shorter / more-general ones so prefix matches don't get eaten by a
# shorter synonym.
_VERB_SYNONYMS: list[tuple[str, list[str]]] = [
    # Multi-word leading verbs.
    ("add temporary circumstance", ["add temp circumstance", "add scene circumstance"]),
    ("add temporary motivator", ["add temp motivator", "add scene motivator"]),
    ("replace aliases with", ["set aliases to", "swap aliases with"]),
    ("change description to", ["set description to", "update description to", "describes as"]),
    ("change colour to", ["set colour to", "change color to", "set color to"]),
    ("rename attribute", ["relabel attribute"]),
    ("remove attribute", ["drop attribute", "delete attribute"]),
    ("append to attribute", ["add to attribute", "push to attribute"]),
    ("drop from attribute", ["remove from attribute", "pop from attribute"]),
    ("modify attribute", ["update attribute", "change attribute"]),
    ("add attribute", ["gains attribute", "gain attribute", "now has attribute", "has new attribute"]),
    ("add alias", ["gains alias", "gain alias", "adds alias"]),
    ("rename to", ["becomes called", "is renamed to", "is now called", "now called", "now named"]),
    ("gains awareness of", ["becomes aware of", "learns of", "learns about", "discovers", "now aware of", "now knows about"]),
    ("loses awareness of", ["forgets about", "loses knowledge of", "no longer aware of"]),
    ("clear hierarchy", ["remove hierarchy", "drop hierarchy"]),
    ("set hierarchy root to", ["promote to hierarchy root"]),
    ("tracking on", ["enable tracking", "begin tracking", "start tracking"]),
    ("tracking off", ["disable tracking", "stop tracking", "end tracking"]),
    # Stand-alone awareness verbs (knowledge-level, after `<Observer>`).
    # Knowledge-context phrasings often refer to the knowledge implicitly
    # via "it" / nothing — synonyms here cover both shapes.
    ("gains awareness", ["becomes aware", "now aware", "learns it", "knows it", "discovers it", "is aware"]),
    ("loses awareness", ["no longer aware", "forgets it"]),
    # Participant verbs (after a relationship subject).
    ("joins as", ["enters as"]),
    # Single-word verbs — checked LAST so they don't snag pieces of
    # multi-word synonyms above.
    ("joins", ["enters"]),
    ("leaves", ["exits", "departs"]),
    ("activate", ["establish", "establishes", "begin", "begins", "form", "forms", "is formed", "is established"]),
    ("deactivate", ["dissolve", "dissolves", "is dissolved", "is ended"]),
]


def _normalize_verb_synonyms(text: str) -> tuple[str, list[tuple[str, str]]]:
    """Apply verb-level synonym substitutions to the unquoted portions
    of `text`. Quoted segments (`"..."`) are preserved verbatim so
    names / descriptions / preset values aren't corrupted by an
    accidental keyword match.

    Returns `(normalized_text, applied)` where each applied entry is
    `(synonym_seen, canonical_form)`. Empty `applied` means no
    substitution happened and `text` is unchanged.
    """
    parts = re.split(r'("[^"]*")', text)
    applied: list[tuple[str, str]] = []
    for i, part in enumerate(parts):
        if i % 2 == 1:
            continue  # quoted segment — leave alone
        new_part = part
        for canon, syns in _VERB_SYNONYMS:
            for syn in syns:
                pattern = re.compile(r'(?i)(?<![A-Za-z])' + re.escape(syn) + r'(?![A-Za-z])')
                m = pattern.search(new_part)
                if m:
                    new_part = new_part[:m.start()] + canon + new_part[m.end():]
                    applied.append((syn, canon))
                    break  # one substitution per canonical group
        parts[i] = new_part
    return "".join(parts), applied


def _parse_change_bullet(payload: str, lineno: int, errors: list[ParseError]) -> Optional[dict]:
    """Map one Changes-block bullet to a structured `change` dict.

    The returned dict has a `kind` discriminator and the carrier-specific
    fields needed by the applier. `raw` is preserved for diagnostics.
    """
    s = payload.strip()
    # Apply verb-level synonym normalization. We capture the result and
    # the substitution list, but only emit warnings if the parse actually
    # succeeds against the normalized text — if the synonym swap didn't
    # help, we don't want to add noise to the diagnostics.
    s_normalized, syn_applied = _normalize_verb_synonyms(s)
    if syn_applied:
        s = s_normalized

    def _emit_synonym_warnings():
        # Surface each substitution as its own warning so the writer
        # can see exactly which synonym was rewritten to which canonical
        # form. Only called on a successful parse path.
        for syn, canon in syn_applied:
            errors.append(ParseError(
                line=lineno, severity="warning",
                expected=f"`{canon}` (canonical verb)",
                found=syn,
                hint=f'Recognised "{syn}" as "{canon}".',
            ))

    # Detect a malformed "double-subject" pattern that LLMs commonly
    # produce when generating template files:
    #     `<Entity>: relationship "<Rel>": <verb>`
    #     `<Entity>: knowledge "<Knowledge>": <verb>`
    # The leading `<Entity>:` is redundant — `relationship "..."` /
    # `knowledge "..."` lines already identify their carrier by name and
    # carry the participating entity inside the verb (`<entity> joins as
    # "..."`). Strip the redundant prefix and emit a single clear
    # warning so the import proceeds with the correct interpretation
    # rather than failing through three fallback paths into a confusing
    # blocking error + duplicate warning combo.
    m_double = re.match(
        r'^([^:]+?)\s*:\s*((relationship|knowledge)\s+"[^"]+"\s*:\s*.*)$',
        s,
    )
    if m_double:
        leading = m_double.group(1).strip()
        inner = m_double.group(2).strip()
        carrier = m_double.group(3)
        errors.append(ParseError(
            line=lineno, severity="warning",
            expected=f'`{carrier} "...": <verb>` (no leading entity prefix)',
            found=s,
            hint=(
                f'Removed redundant leading `{leading}:`. '
                f'{carrier.capitalize()} lines identify the {carrier} by name '
                f'and the participating entity inside the verb '
                f'(e.g. `... {leading} joins as "..."`).'
            ),
        ))
        s = inner

    # Subject discriminator: `relationship "..."` / `knowledge "..."` / entity name
    m_rel = re.match(r'^relationship\s+"([^"]+)"\s*:\s*(.*)$', s)
    m_kn = re.match(r'^knowledge\s+"([^"]+)"\s*:\s*(.*)$', s)
    if m_rel:
        result = _parse_relationship_change(m_rel.group(1), m_rel.group(2).strip(), s, lineno, errors)
        if result is not None:
            _emit_synonym_warnings()
        return result
    if m_kn:
        result = _parse_knowledge_change(m_kn.group(1), m_kn.group(2).strip(), s, lineno, errors)
        if result is not None:
            _emit_synonym_warnings()
        return result
    # Entity-subject — `<Entity>: <verb-phrase>`
    m_ent = re.match(r'^([^:]+?)\s*:\s*(.*)$', s)
    if not m_ent:
        errors.append(ParseError(line=lineno, expected="a Changes-block bullet", found=s))
        return None
    subject = m_ent.group(1).strip()
    verb = m_ent.group(2).strip()
    # Try entity verbs first; if none match, fall back to interpreting
    # the bullet as if the writer omitted the `relationship "..."`
    # or `knowledge "..."` prefix. Common LLM error: writes
    # `Lena Vale: activate` when they meant `relationship "Lena Vale": activate`.
    # Resolution-pass cross-reference will demote subjects that don't
    # actually exist as entities to warnings.
    silent_errors: list[ParseError] = []
    result = _parse_entity_change(subject, verb, s, lineno, silent_errors)
    if result is not None:
        _emit_synonym_warnings()
        return result
    # Entity verbs didn't match. Try relationship verbs.
    rel_silent: list[ParseError] = []
    rel_result = _parse_relationship_change(subject, verb, s, lineno, rel_silent)
    if rel_result is not None:
        errors.append(ParseError(
            line=lineno, severity="warning",
            expected=f'`relationship "{subject}": ...` (with the relationship prefix)',
            found=s,
            hint="Interpreted as a relationship change.",
        ))
        _emit_synonym_warnings()
        return rel_result
    # Try knowledge verbs.
    kn_silent: list[ParseError] = []
    kn_result = _parse_knowledge_change(subject, verb, s, lineno, kn_silent)
    if kn_result is not None:
        errors.append(ParseError(
            line=lineno, severity="warning",
            expected=f'`knowledge "{subject}": ...` (with the knowledge prefix)',
            found=s,
            hint="Interpreted as a knowledge change.",
        ))
        _emit_synonym_warnings()
        return kn_result
    # All three failed. Surface the original entity-verb error as a
    # WARNING — the line is skipped at apply time, but the import
    # proceeds for everything else. Writer can review the warning list
    # and fix manually if needed. Synonym substitutions don't get
    # surfaced here because they didn't actually help.
    if silent_errors:
        first = silent_errors[0]
        errors.append(ParseError(
            line=first.line, severity="warning",
            expected=first.expected, found=first.found,
            hint=(first.hint + " Line skipped.").strip(),
        ))
    return None


def _parse_entity_change(subject: str, verb: str, raw: str, lineno: int, errors: list[ParseError]) -> Optional[dict]:
    # awareness verbs
    m = re.match(r'^(gains|loses)\s+awareness\s+of\s+(.*)$', verb, re.IGNORECASE)
    if m:
        action = m.group(1).lower()
        target_str = m.group(2).strip()
        target = _parse_awareness_target(target_str, lineno, errors)
        if target is None:
            return None
        # optional `(level N)` suffix on target_str was consumed inside _parse_awareness_target
        return {
            "kind": "entity_awareness",
            "subject": subject,  # observer
            "action": action,
            "target": target,
            "raw": raw,
        }

    # rename to "..."
    m = re.match(r'^rename\s+to\s+"([^"]*)"\s*$', verb, re.IGNORECASE)
    if m:
        return {"kind": "entity_rename", "subject": subject, "new_name": m.group(1), "raw": raw}

    # change description to "..."
    m = re.match(r'^change\s+description\s+to\s+"([^"]*)"\s*$', verb, re.IGNORECASE)
    if m:
        return {"kind": "entity_change_description", "subject": subject, "new_description": m.group(1), "raw": raw}

    # change colour to #hex
    m = re.match(r'^change\s+colou?r\s+to\s+(\#[0-9a-fA-F]{3,6})\s*$', verb, re.IGNORECASE)
    if m:
        return {"kind": "entity_change_colour", "subject": subject, "new_colour": m.group(1).lower(), "raw": raw}

    # add alias "..."
    m = re.match(r'^add\s+alias\s+"([^"]*)"\s*$', verb, re.IGNORECASE)
    if m:
        return {"kind": "entity_add_alias", "subject": subject, "alias_value": m.group(1), "raw": raw}

    # replace aliases with "...", "..."
    m = re.match(r'^replace\s+aliases\s+with\s+(.*)$', verb, re.IGNORECASE)
    if m:
        items = _parse_comma_list(m.group(1))
        return {"kind": "entity_replace_aliases", "subject": subject, "aliases": items, "raw": raw}

    # add temporary circumstance / motivator (scene-scoped, not chain-tracked)
    m = re.match(r'^add\s+temporary\s+(circumstance|motivator)\s+(.*)$', verb, re.IGNORECASE)
    if m:
        atype = m.group(1).lower()
        rest = m.group(2).strip()
        # Reuse the C/M payload parser to extract name / intensity / description.
        m2 = re.match(r'^(?:"([^"]*)"|([^\[:]*?))\s*(?:\[([A-Za-z]+|\d+)\])?\s*(?::\s*(.*))?$', rest)
        if not m2:
            errors.append(ParseError(line=lineno, expected=f"`{atype}` payload", found=rest))
            return None
        name = (m2.group(1) if m2.group(1) is not None else m2.group(2) or "").strip()
        raw_intensity = m2.group(3)
        intensity: Optional[int] = None
        if raw_intensity is not None:
            mapped = _parse_intensity_token(raw_intensity)
            if mapped is None:
                errors.append(ParseError(
                    line=lineno, severity="warning",
                    expected="intensity word (faint, mild, moderate, strong, intense)",
                    found=raw_intensity,
                    hint="Unrecognised — intensity left unset.",
                ))
            else:
                intensity = mapped
        desc = _strip_quotes((m2.group(4) or "").strip())
        if not (name or desc):
            errors.append(ParseError(line=lineno, expected=f"a name or description for the temporary {atype}", found="both empty"))
            return None
        return {
            "kind": "entity_temporary_cm",
            "subject": subject,
            "attribute_type": atype,
            "name": name,
            "description": desc,
            "intensity": intensity,
            "raw": raw,
        }

    # add attribute (<type>) <name> = <value...>
    m = re.match(r'^add\s+attribute\s+\(([a-z_]+)\)\s+(.*)$', verb, re.IGNORECASE)
    if m:
        atype = m.group(1).lower()
        rest = m.group(2).strip()
        return _parse_change_attribute_add(subject, atype, rest, raw, lineno, errors)

    # modify attribute "X" value to "..."
    m = re.match(r'^modify\s+attribute\s+"([^"]+)"\s+(value|intensity|description|number)\s+to\s+(.*)$', verb, re.IGNORECASE)
    if m:
        attr_name, field_name, rhs = m.group(1), m.group(2).lower(), m.group(3).strip()
        change = {"kind": "entity_attribute", "subject": subject, "op": "modify",
                  "attribute_name": attr_name, "field": field_name, "raw": raw}
        if field_name == "value":
            change["new_value"] = _strip_quotes(rhs)
        elif field_name == "intensity":
            if rhs.lower() == "none":
                change["new_intensity"] = None
            else:
                v = _parse_intensity_token(rhs)
                if v is None:
                    errors.append(ParseError(
                        line=lineno,
                        expected="intensity word (faint, mild, moderate, strong, intense) or none",
                        found=rhs,
                    ))
                    return None
                change["new_intensity"] = v
        elif field_name == "description":
            change["new_description"] = _strip_quotes(rhs)
        elif field_name == "number":
            v = _parse_float(rhs)
            if v is None:
                errors.append(ParseError(line=lineno, expected="numeric value", found=rhs))
                return None
            change["new_number_value"] = v
        return change

    # rename attribute "old" to "new"
    m = re.match(r'^rename\s+attribute\s+"([^"]+)"\s+to\s+"([^"]*)"\s*$', verb, re.IGNORECASE)
    if m:
        return {"kind": "entity_attribute", "subject": subject, "op": "rename",
                "attribute_name": m.group(1), "new_name": m.group(2), "raw": raw}

    # remove attribute "..."
    m = re.match(r'^remove\s+attribute\s+"([^"]+)"\s*$', verb, re.IGNORECASE)
    if m:
        return {"kind": "entity_attribute", "subject": subject, "op": "remove",
                "attribute_name": m.group(1), "raw": raw}

    # append to attribute "X": "<item>"
    m = re.match(r'^append\s+to\s+attribute\s+"([^"]+)"\s*:\s*"([^"]*)"\s*$', verb, re.IGNORECASE)
    if m:
        return {"kind": "entity_attribute", "subject": subject, "op": "list_add",
                "attribute_name": m.group(1), "list_item": m.group(2), "raw": raw}

    # drop from attribute "X": "<item>"
    m = re.match(r'^drop\s+from\s+attribute\s+"([^"]+)"\s*:\s*"([^"]*)"\s*$', verb, re.IGNORECASE)
    if m:
        return {"kind": "entity_attribute", "subject": subject, "op": "list_remove",
                "attribute_name": m.group(1), "list_item": m.group(2), "raw": raw}

    errors.append(ParseError(
        line=lineno,
        expected="a recognised change verb (rename, change description / colour, add / modify / remove attribute, gains / loses awareness, ...)",
        found=verb,
        hint=f"Subject `{subject}`. See docs/import-template-format.md for the full verb list.",
    ))
    return None


def _parse_change_attribute_add(subject: str, atype: str, rest: str, raw: str,
                                 lineno: int, errors: list[ParseError]) -> Optional[dict]:
    if atype in ("circumstance", "motivator"):
        # `"<name>" [<intensity word or digit>] : "<desc>"`
        m = re.match(r'^(?:"([^"]*)"|([^\[:]*?))\s*(?:\[([A-Za-z]+|\d+)\])?\s*(?::\s*(.*))?$', rest)
        if not m:
            errors.append(ParseError(line=lineno, expected=f"`{atype}` attribute payload", found=rest))
            return None
        name = (m.group(1) if m.group(1) is not None else m.group(2) or "").strip()
        raw_intensity = m.group(3)
        intensity: Optional[int] = None
        if raw_intensity is not None:
            mapped = _parse_intensity_token(raw_intensity)
            if mapped is None:
                errors.append(ParseError(
                    line=lineno, severity="warning",
                    expected="intensity word (faint, mild, moderate, strong, intense)",
                    found=raw_intensity,
                    hint="Unrecognised — intensity left unset.",
                ))
            else:
                intensity = mapped
        desc = _strip_quotes((m.group(4) or "").strip())
        return {
            "kind": "entity_attribute", "subject": subject, "op": "add", "raw": raw,
            "attribute": {
                "type": atype, "name": name, "description": desc,
                "intensity": intensity, "value": "",
            },
        }
    # `<name> = <value>`
    eq = rest.find("=")
    if eq < 0:
        errors.append(ParseError(line=lineno, expected="`<name> = <value>`", found=rest))
        return None
    nm = _strip_quotes(rest[:eq].strip())
    rhs = rest[eq + 1:].strip()
    attr: dict = {"type": atype, "name": nm}
    if atype == "text":
        attr["value"] = _strip_quotes(rhs)
    elif atype == "preset":
        mm = re.match(r'^(.*?)\s*\(from\s+"([^"]+)"\s*\)\s*$', rhs)
        if not mm:
            errors.append(ParseError(line=lineno, expected='`<value> (from "<list>")`', found=rhs))
            return None
        attr["value"] = _strip_quotes(mm.group(1))
        attr["preset_list_name"] = mm.group(2)
    elif atype == "number":
        v = _parse_float(rhs)
        if v is None:
            errors.append(ParseError(line=lineno, expected="numeric value", found=rhs))
            return None
        attr["number_value"] = v
    elif atype in ("text_list", "entity_list"):
        s = rhs.strip()
        if not (s.startswith("[") and s.endswith("]")):
            errors.append(ParseError(line=lineno, expected="bracketed list", found=s))
            return None
        attr["items"] = _parse_comma_list(s[1:-1])
    else:
        errors.append(ParseError(line=lineno, expected="known attribute type", found=atype))
        return None
    return {"kind": "entity_attribute", "subject": subject, "op": "add",
            "attribute": attr, "raw": raw}


def _parse_awareness_target(s: str, lineno: int, errors: list[ParseError]) -> Optional[dict]:
    """Parse the `<target>` half of `<observer>: gains awareness of <target>`."""
    # Strip optional trailing `(level <word-or-number>)` or just
    # `(<word-or-number>)`. Word forms (unaware / name-only / partial /
    # aware / knows-self) map to integers via _parse_awareness_level_token.
    level = None
    m = re.search(r'\((?:level\s+)?([A-Za-z\-]+|\d+)\)\s*$', s)
    if m:
        token = m.group(1)
        mapped = _parse_awareness_level_token(token)
        if mapped is not None:
            level = mapped
        else:
            errors.append(ParseError(
                line=lineno, severity="warning",
                expected="awareness level word (unaware, name-only, partial, aware, knows-self)",
                found=token,
                hint="Unrecognised level — defaulted to `aware`.",
            ))
            level = 3
        s = s[:m.start()].strip()

    # `<Entity>'s name`
    m = re.match(r'^(.+?)\'s\s+name\s*$', s, re.IGNORECASE)
    if m:
        return {"kind": "entity_name", "entity": m.group(1).strip(), "level": level}
    # `<Entity>'s alias "..."`
    m = re.match(r'^(.+?)\'s\s+alias\s+"([^"]+)"\s*$', s, re.IGNORECASE)
    if m:
        return {"kind": "alias", "entity": m.group(1).strip(), "alias_value": m.group(2), "level": level}
    # `attribute "owner.name"`
    m = re.match(r'^attribute\s+"([^."]+)\.([^"]+)"\s*$', s, re.IGNORECASE)
    if m:
        return {"kind": "attribute", "entity": m.group(1).strip(), "attribute_name": m.group(2).strip(), "level": level}
    # `relationship "..."`
    m = re.match(r'^relationship\s+"([^"]+)"\s*$', s, re.IGNORECASE)
    if m:
        return {"kind": "relationship", "name": m.group(1), "level": level}
    # `knowledge "..."`
    m = re.match(r'^knowledge\s+"([^"]+)"\s*$', s, re.IGNORECASE)
    if m:
        return {"kind": "knowledge", "name": m.group(1), "level": level}
    # bare entity
    return {"kind": "entity", "entity": s.strip(), "level": level}


def _parse_relationship_change(name: str, verb: str, raw: str, lineno: int, errors: list[ParseError]) -> Optional[dict]:
    base = {"subject": name, "raw": raw}
    if re.match(r'^activate\s*$', verb, re.IGNORECASE):
        return {"kind": "relationship_activate", **base}
    if re.match(r'^deactivate\s*$', verb, re.IGNORECASE):
        return {"kind": "relationship_deactivate", **base}
    m = re.match(r'^(.+?)\s+joins(?:\s+as\s+"([^"]+)")?\s*$', verb, re.IGNORECASE)
    if m:
        return {"kind": "relationship_join", "entity": m.group(1).strip(), "role": m.group(2) or "", **base}
    m = re.match(r'^(.+?)\s+leaves\s*$', verb, re.IGNORECASE)
    if m:
        return {"kind": "relationship_leave", "entity": m.group(1).strip(), **base}
    m = re.match(r'^(.+?)\'s\s+perception\s+of\s+(.+?)\s*:\s*"([^"]*)"\s*$', verb, re.IGNORECASE)
    if m:
        return {"kind": "relationship_perception",
                "observer": m.group(1).strip(), "target": m.group(2).strip(),
                "new_perception": m.group(3), **base}
    m = re.match(r'^(.+?)\'s\s+alias\s+here\s+is\s+(none|"([^"]*)")\s*$', verb, re.IGNORECASE)
    if m:
        new_alias = None if m.group(2).lower() == "none" else m.group(3)
        return {"kind": "relationship_alias_override", "entity": m.group(1).strip(),
                "new_alias": new_alias, **base}
    m = re.match(r'^(.+?)\'s\s+role\s+becomes\s+(none|"([^"]*)")\s*$', verb, re.IGNORECASE)
    if m:
        new_role = None if m.group(2).lower() == "none" else m.group(3)
        return {"kind": "relationship_role", "entity": m.group(1).strip(),
                "new_role": new_role, **base}
    m = re.match(r'^rename\s+to\s+"([^"]*)"\s*$', verb, re.IGNORECASE)
    if m:
        return {"kind": "relationship_rename", "new_name": m.group(1), **base}
    m = re.match(r'^change\s+description\s+to\s+"([^"]*)"\s*$', verb, re.IGNORECASE)
    if m:
        return {"kind": "relationship_change_description", "new_description": m.group(1), **base}
    m = re.match(r'^set\s+hierarchy\s+root\s+to\s+(.+?),\s+order:\s+(.+)$', verb, re.IGNORECASE)
    if m:
        return {"kind": "relationship_set_hierarchy", "root": m.group(1).strip(),
                "order": _parse_comma_list(m.group(2)), **base}
    if re.match(r'^clear\s+hierarchy\s*$', verb, re.IGNORECASE):
        return {"kind": "relationship_clear_hierarchy", **base}
    errors.append(ParseError(line=lineno, expected="a relationship change verb",
                             found=verb, hint=f"Relationship `{name}`."))
    return None


def _parse_knowledge_change(name: str, verb: str, raw: str, lineno: int, errors: list[ParseError]) -> Optional[dict]:
    base = {"subject": name, "raw": raw}
    if re.match(r'^activate\s*$', verb, re.IGNORECASE):
        return {"kind": "knowledge_activate", **base}
    m = re.match(r'^rename\s+to\s+"([^"]*)"\s*$', verb, re.IGNORECASE)
    if m:
        return {"kind": "knowledge_rename", "new_name": m.group(1), **base}
    m = re.match(r'^change\s+description\s+to\s+"([^"]*)"\s*$', verb, re.IGNORECASE)
    if m:
        return {"kind": "knowledge_change_description", "new_description": m.group(1), **base}
    m = re.match(r'^change\s+colou?r\s+to\s+(\#[0-9a-fA-F]{3,6})\s*$', verb, re.IGNORECASE)
    if m:
        return {"kind": "knowledge_change_colour", "new_colour": m.group(1).lower(), **base}
    # `<observer> gains awareness` — optional trailing
    # `(level <word-or-number>)` or `(<word-or-number>)`. Default
    # level = aware (3) when no qualifier is supplied.
    m = re.match(
        r'^(.+?)\s+gains\s+awareness(?:\s+\((?:level\s+)?([A-Za-z\-]+|\d+)\))?\s*$',
        verb, re.IGNORECASE,
    )
    if m:
        token = m.group(2)
        if token is None:
            level = 3
        else:
            mapped = _parse_awareness_level_token(token)
            if mapped is None:
                errors.append(ParseError(
                    line=lineno, severity="warning",
                    expected="awareness level word (unaware, name-only, partial, aware, knows-self)",
                    found=token,
                    hint="Unrecognised level — defaulted to `aware`.",
                ))
                level = 3
            else:
                level = mapped
        return {"kind": "knowledge_observer_gains", "observer": m.group(1).strip(), "level": level, **base}
    m = re.match(r'^(.+?)\s+loses\s+awareness\s*$', verb, re.IGNORECASE)
    if m:
        return {"kind": "knowledge_observer_loses", "observer": m.group(1).strip(), **base}
    m = re.match(r'^tracking\s+on(?:\s+\((binary|full)\))?\s*$', verb, re.IGNORECASE)
    if m:
        return {"kind": "knowledge_tracking", "action": "on",
                "scale": (m.group(1) or "full").lower(), **base}
    if re.match(r'^tracking\s+off\s*$', verb, re.IGNORECASE):
        return {"kind": "knowledge_tracking", "action": "off", **base}
    errors.append(ParseError(line=lineno, expected="a knowledge change verb",
                             found=verb, hint=f"Knowledge `{name}`."))
    return None


