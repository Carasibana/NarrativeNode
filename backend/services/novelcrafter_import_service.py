"""Novelcrafter import service — Phase 3.2 (codex entity-typed targets).

Sibling to `entity_import_service.py`. Parses a Novelcrafter export
bundle (`.zip` containing `novel.md` / `novel.html` / `novel.docx` at
root plus `codex.html` and the eight standard codex folders) and
produces an `ImportPreview` that the frontend dialog renders. A
subsequent commit call materialises the import into a fresh
NarrativeNode project.

**Phase 3.2 scope** is the four entity-typed codex folders —
`characters/`, `locations/`, `objects/`, `other/` — mapped to NN
Character / Location / Item / Custom entities. ID mapping
infrastructure built here threads through every later sub-phase
(3.3 lore/subplots, 3.4 tag-Relationships, 3.5 prose, 3.6 snippets,
3.7 chats).

The preview-session cache mirrors the `entity_import_service` pattern:
the preview endpoint stashes the raw upload bytes + parsed codex +
ID map keyed by a fresh session_id, and a later commit endpoint
resolves that session to commit without re-uploading or re-parsing.
"""

from __future__ import annotations

import base64
import io
import json
import re
import uuid
import zipfile
from dataclasses import dataclass, field
from typing import Literal, Optional

from models.tag import Tag
from services.profile_image_processor import preprocess_profile_image_bytes


# ── ID mapping infrastructure ───────────────────────────────────────────


class NovelcrafterIdMap:
    """Maps NC nano-IDs (the base62-ish strings NC uses internally like
    `3C87kb8Az0DvWuqqy8W61mxp9Qb`) to freshly-minted NN UUIDv4s.

    Built during the codex parse pass and consumed by every downstream
    sub-phase that needs to resolve cross-references — `nestedEntries`,
    perspective targets, tag-Relationship participants, chat
    transcript codex-mentions, etc. Re-registering a known NC ID is
    idempotent (returns the previously-minted UUID), so callers don't
    need to pre-check.
    """

    def __init__(self) -> None:
        self._map: dict[str, str] = {}

    def register(self, nc_id: str) -> str:
        """Return the NN UUID for `nc_id`, minting a fresh one on first
        sight. Idempotent."""
        if nc_id in self._map:
            return self._map[nc_id]
        nn_uuid = str(uuid.uuid4())
        self._map[nc_id] = nn_uuid
        return nn_uuid

    def lookup(self, nc_id: str) -> Optional[str]:
        """Return the NN UUID for `nc_id`, or None if it was never
        registered. Used by passes that must NOT mint new UUIDs on
        miss (e.g. resolving a `nestedEntries` reference — a miss
        means the target entry wasn't in the bundle and the reference
        is stale)."""
        return self._map.get(nc_id)

    def __len__(self) -> int:
        return len(self._map)


# ── Named-colour mapping (NC → NN hex) ──────────────────────────────────


# NC names colours via a Tailwind-style palette in its UI (`pink`,
# `green`, etc.). NN uses raw hex. This table maps the NC labels
# observed in test bundles plus the obvious siblings to NN hex values.
# Unknown / null / "black" all fall back to NN's default `#888888`.
# Hex values track Tailwind's `*-500` shade for vibrancy, lightly
# tuned for legibility on NN's dark canvas background.
NC_NAMED_COLOURS: dict[str, str] = {
    "red":      "#ef4444",
    "orange":   "#f97316",
    "amber":    "#f59e0b",
    "yellow":   "#eab308",
    "lime":     "#84cc16",
    "green":    "#22c55e",
    "emerald":  "#10b981",
    "teal":     "#14b8a6",
    "cyan":     "#06b6d4",
    "sky":      "#0ea5e9",
    "blue":     "#3b82f6",
    "indigo":   "#6366f1",
    "violet":   "#8b5cf6",
    "purple":   "#a855f7",
    "fuchsia":  "#d946ef",
    "pink":     "#ec4899",
    "rose":     "#f43f5e",
    "stone":    "#a8a29e",
    "neutral":  "#a3a3a3",
    "zinc":     "#a1a1aa",
    "gray":     "#9ca3af",
    "grey":     "#9ca3af",
    "slate":    "#94a3b8",
}

NN_DEFAULT_COLOUR = "#888888"


def resolve_nc_colour(nc_colour: Optional[str]) -> str:
    """Map an NC named colour (or `null` / unknown) to an NN hex value.
    `null`, `"black"`, and any unknown name all resolve to the NN
    default `#888888`. Already-hex inputs pass through unchanged.
    """
    if not nc_colour:
        return NN_DEFAULT_COLOUR
    s = str(nc_colour).strip().lower()
    if not s or s == "black":
        return NN_DEFAULT_COLOUR
    if s.startswith("#") and len(s) in (4, 7):
        return s
    return NC_NAMED_COLOURS.get(s, NN_DEFAULT_COLOUR)


# ── NC → NN type mapping (entity-typed folders — Phase 3.2 scope) ──


# Maps NC codex folder name → NN entity-type identifier. The four
# entity-typed folders in Phase 3.2 scope. Lore / subplots land in
# Phase 3.3 via the auto-promotion logic below. Snippets / chats are
# Phases 3.6 / 3.7 with their own parsers.
ENTITY_TYPE_MAP: dict[str, str] = {
    "characters": "character",
    "locations":  "location",
    "objects":    "item",      # NC's "objects" → NN's "item"
    "other":      "custom",    # NC's "other" catch-all → NN custom
}


# ── Lore / subplot destination types (Phase 3.5 — no auto-promotion) ────


# Lore always lands as Knowledge; subplots always land as Reference
# Node. The Phase 3.3 auto-promotion-to-Custom rule was retired in
# Phase 3.5 once first-class Project Tags (Phase 3.4) gave Knowledge
# and Reference Node native tag membership — the dominant enrichment
# trigger in the surveyed bundles. The remaining unmappable NC fields
# (`aliases`, populated `fields`, `nestedEntries`, and — for subplots
# only — `thumbnail.jpg`) drop on import with summary instead. See
# `docs/planning/Stage 3 - Novelcrafter Integration.md` mapping table
# rows for `lore/` and `subplots/`.

LORE_DEFAULT_TYPE = "knowledge"
SUBPLOT_DEFAULT_TYPE = "reference_node"


# ── Parsed-entry dataclasses ────────────────────────────────────────────


@dataclass
class ParsedCodexEntry:
    """A single codex entry parsed from `{folder}/{name-id}/`. Holds
    everything Phase 3.2 needs to materialise the corresponding NN
    Entity, plus the raw NC data that Phase 3.3 (custom-fields →
    attributes) and Phase 3.4 (`nestedEntries`, tags → Relationships)
    will consume in their own passes.
    """

    nc_id: str
    nn_uuid: str
    nc_type: str               # "character" / "location" / "object" / "other" / "lore" / "subplot"
    nn_type: str               # NN destination — "character" / "location" / "item" / "custom" / "knowledge" / "reference_node"
    folder: str                # NC source folder — "characters" / "locations" / "objects" / "other" / "lore" / "subplots"
    entry_dir: str             # full path inside the zip, e.g. "characters/amy-3C87..."
    name: str
    colour_hex: str            # resolved via resolve_nc_colour()
    raw_colour: Optional[str]  # raw NC value for debugging / round-trip
    description: str           # body text from entry.md (after frontmatter)
    aliases: list[str]
    tags: list[str]            # consumed by Phase 3.4 tag-Relationship pass
    fields: dict[str, object]  # raw key → value-or-list dict; Phase 3.2 converts to attributes
    nested_entry_nc_ids: list[str]  # raw NC IDs from metadata.json; resolved in Phase 3.4
    ai_flags: dict[str, bool]  # alwaysIncludeInContext / doNotTrack / noAutoInclude
    thumbnail_zip_path: Optional[str]  # e.g. "characters/amy-3C87.../thumbnail.jpg" — None if absent
    thumbnail_data_uri: Optional[str]  # base64 data URI for preview render; None if no thumbnail
    # Phase 3.3 once carried `promoted` / `promoted_category` fields
    # for the lore/subplot auto-promotion bookkeeping. Phase 3.5
    # retired auto-promotion entirely (lore always Knowledge, subplots
    # always Reference Node), so the fields are gone — any downstream
    # code that wants to surface "this entry had drops" computes it
    # from the parsed data (`aliases`, populated `fields`,
    # `nested_entry_nc_ids`, `thumbnail_zip_path` for subplots).


# ── Public preview dataclass ────────────────────────────────────────────


@dataclass
class NovelcrafterImportPreview:
    """Shape returned by `POST /api/novelcrafter/preview`. The frontend
    dialog renders against this. Phase 3.2 fills in entity counts and
    a per-entity preview list; lore / subplots / snippets / chats /
    scenes remain zero until their parsers ship in later sub-phases.
    """

    session_id: str
    source_filename: str
    novelcrafter_title: Optional[str]
    novelcrafter_author: Optional[str]
    format: Literal["markdown", "html", "docx"]
    counts: dict[str, object] = field(default_factory=dict)
    # Per-entity preview list, grouped by NN type. Each entry holds
    # everything the dialog needs to render a one-line preview row:
    # name, colour swatch, alias chips, tag chips, fields summary,
    # thumbnail data URI (when present). Keyed by NN type strings
    # ("character" / "location" / "item" / "custom") so the dialog
    # can render the existing TYPE_ICONS mapping unchanged.
    entity_preview: dict[str, list[dict[str, object]]] = field(default_factory=dict)
    # Phase 3.9 — per-item lists for the import-dialog selection
    # popover. Empty lists when the bundle ships no snippets/chats
    # folder OR contains no .md files in them. Each entry: `nc_id`
    # (selection key sent back in the commit form's `snippet_ids` /
    # `chat_ids` filter), `label` (display string the picker shows
    # the writer — NC title verbatim when present, `"Untitled - …"`
    # fallback otherwise), `date` (YYYY-MM-DD from filename, used
    # by the picker for orientation when titles are empty).
    snippets_preview: list[dict[str, str]] = field(default_factory=list)
    chats_preview: list[dict[str, str]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


# ── In-memory preview session cache ──────────────────────────────────────


@dataclass
class _NovelcrafterPreviewSession:
    """Stashed state for a single preview that the user has not yet
    committed. Holds the raw upload bytes + the detected format + the
    parsed codex so the commit endpoint doesn't need to re-receive
    or re-parse the bundle. Later sub-phases will add their own
    parsed-tree fields (prose AST, snippets, chats) alongside the
    codex_entries dict.

    Phase 3.10 Layer 5 — `staged_story` is populated by a `dry_run`
    commit (the build runs but the result is NOT projected to
    `state.story`). The scene-refinement modal then operates on the
    staged story; the final `/commit_staged` call applies the
    writer-confirmed refinement diff and projects the result.
    """

    raw_bytes: bytes
    source_filename: str
    format: Literal["markdown", "html", "docx"]
    id_map: NovelcrafterIdMap
    codex_entries: list[ParsedCodexEntry]
    staged_story: Optional[object] = None  # Story; typed as object to
    # avoid the model.py → service circular import.


_SESSIONS: dict[str, _NovelcrafterPreviewSession] = {}


def get_preview_session(session_id: str) -> Optional[_NovelcrafterPreviewSession]:
    """Read-only accessor; returns None when the session_id is unknown
    (expired, server restarted, never created)."""
    return _SESSIONS.get(session_id)


def clear_preview_session(session_id: str) -> None:
    """Remove a session from the cache. Called on commit (success or
    failure), on dialog cancel, or by a future eviction sweep."""
    _SESSIONS.pop(session_id, None)


# ── Phase 3.10 — commit-progress slot ──────────────────────────────────
#
# Server-side progress state keyed by the same session_id the preview
# / commit endpoints already use. The commit handler updates the slot
# at phase boundaries; the frontend polls `GET /commit_progress` while
# the modal is open. The slot also records created cue + conversation
# IDs so a Cancel POST can full-clean-slate revert them (cancel deletes
# any side-effect artifacts written to disk before the cancel arrived,
# paired with the frontend's Zustand snapshot revert for the in-memory
# project state).
#
# In-process dict — cleared on server restart, which is fine: an
# in-flight import dies with the server anyway, and the modal will
# fail-soft when its next poll returns 404. No persistence.

@dataclass
class _NovelcrafterCommitProgress:
    """Progress + cancel state for one commit run. Lives only as long
    as the commit handler is running plus a brief grace window for
    the final poll. Fields:
      * `phase` / `phase_index` / `phase_total` — display.
      * `unit_done` / `unit_total` — within-phase counter; 0 total
        means indeterminate bar.
      * `cancelled` — set by the cancel endpoint; checked by the
        commit handler at every phase boundary.
      * `done` — set after the commit handler returns (success,
        cancel, or terminal error). The modal stops polling when
        this flips true.
      * `result` — the dict the commit endpoint normally returns,
        stashed here so the modal can read it on the same poll that
        sees `done=True` (no separate fetch needed).
      * `created_cue_ids` / `created_conversation_ids` — what the
        cancel handler must delete on a clean-slate cancel.
    """
    session_id: str
    phase: str
    phase_index: int
    phase_total: int
    unit_done: int = 0
    unit_total: int = 0
    cancelled: bool = False
    done: bool = False
    result: Optional[dict] = None
    created_cue_ids: list[str] = field(default_factory=list)
    created_conversation_ids: list[str] = field(default_factory=list)


_PROGRESS: dict[str, _NovelcrafterCommitProgress] = {}


def init_commit_progress(
    session_id: str, *, phase_total: int,
) -> _NovelcrafterCommitProgress:
    """Initialise the progress slot for a commit run. Phase total is
    set up-front based on opt-ins so the UI's "Phase X of Y" reads
    correctly from the first poll."""
    prog = _NovelcrafterCommitProgress(
        session_id=session_id,
        phase="Starting import",
        phase_index=0,
        phase_total=phase_total,
    )
    _PROGRESS[session_id] = prog
    return prog


def get_commit_progress(session_id: str) -> Optional[_NovelcrafterCommitProgress]:
    return _PROGRESS.get(session_id)


def update_commit_phase(
    session_id: str, phase: str, phase_index: int, *, unit_total: int = 0,
) -> None:
    """Advance to a new phase. Resets unit_done to 0 and sets
    unit_total (0 = indeterminate)."""
    prog = _PROGRESS.get(session_id)
    if prog is None:
        return
    prog.phase = phase
    prog.phase_index = phase_index
    prog.unit_done = 0
    prog.unit_total = unit_total


def update_commit_unit(session_id: str, unit_done: int) -> None:
    """Bump the within-phase counter for the determinate bar."""
    prog = _PROGRESS.get(session_id)
    if prog is None:
        return
    prog.unit_done = unit_done


def update_commit_subphase(
    session_id: str, label: str, unit_done: int, unit_total: int,
) -> None:
    """Replace the visible phase label AND advance the within-phase
    counter atomically, WITHOUT touching `phase_index` / `phase_total`.
    Used by the engine's progress callback so the modal can surface
    the current engine sub-step name (e.g. "Entities", "Scenes")
    inside the "Applying import to project" parent phase."""
    prog = _PROGRESS.get(session_id)
    if prog is None:
        return
    prog.phase = label
    prog.unit_done = unit_done
    prog.unit_total = unit_total


def is_commit_cancelled(session_id: str) -> bool:
    """Boundary check — the commit handler calls this at every phase
    boundary so cancel takes effect at the next safe stop."""
    prog = _PROGRESS.get(session_id)
    return bool(prog and prog.cancelled)


def mark_commit_cancelled(session_id: str) -> bool:
    """Set the cancelled flag from the cancel endpoint. Returns True
    if the slot exists; False if the cancel arrived after `done` or
    for an unknown session."""
    prog = _PROGRESS.get(session_id)
    if prog is None or prog.done:
        return False
    prog.cancelled = True
    return True


def mark_commit_done(session_id: str, result: Optional[dict]) -> None:
    """Stamp the slot as done and stash the final result for the
    modal's last poll. Caller is responsible for `clear_commit_progress`
    after a grace window."""
    prog = _PROGRESS.get(session_id)
    if prog is None:
        return
    prog.done = True
    prog.result = result


def track_created_cue(session_id: str, cue_id: str) -> None:
    prog = _PROGRESS.get(session_id)
    if prog is None:
        return
    prog.created_cue_ids.append(cue_id)


def track_created_conversation(session_id: str, conversation_id: str) -> None:
    prog = _PROGRESS.get(session_id)
    if prog is None:
        return
    prog.created_conversation_ids.append(conversation_id)


def clear_commit_progress(session_id: str) -> None:
    _PROGRESS.pop(session_id, None)




def rollback_commit_artifacts(session_id: str) -> tuple[int, int]:
    """Delete every cue + conversation tracked for this session.
    Used by the cancel path on the commit endpoint to give the
    writer a full clean-slate revert when paired with the frontend's
    Zustand snapshot revert for the in-memory project state.
    Returns `(cues_deleted, conversations_deleted)`. Failures are
    swallowed silently — a half-cleaned filesystem is still a better
    user experience than a 500-cancel."""
    prog = _PROGRESS.get(session_id)
    if prog is None:
        return (0, 0)
    cues_deleted = 0
    convs_deleted = 0
    # Lazy imports per the same convention used by `_create_imported_*`
    # — avoid pulling these services + their disk init into module-load
    # time for callers that don't use NC import / cancel.
    from services import context_cues_service, conversations_service
    for cue_id in prog.created_cue_ids:
        try:
            context_cues_service.delete_cue(cue_id)
            cues_deleted += 1
        except Exception:  # noqa: BLE001
            pass
    for conv_id in prog.created_conversation_ids:
        try:
            conversations_service.delete_conversation(conv_id)
            convs_deleted += 1
        except Exception:  # noqa: BLE001
            pass
    return (cues_deleted, convs_deleted)


# ── Format detection ────────────────────────────────────────────────────


def _detect_bundle_format(zf: zipfile.ZipFile) -> Literal["markdown", "html", "docx"]:
    """Look for `novel.md` first, then `novel.html`, then `novel.docx`.
    Raises `ValueError` when none of the three is present (i.e. the
    upload isn't a Novelcrafter export bundle).

    Mutual exclusivity: a given NC bundle carries exactly one of the
    three prose files — whichever format the user picked at NC's
    export dialog is the only one in the archive.
    """
    names = set(zf.namelist())
    if "novel.md" in names:
        return "markdown"
    if "novel.html" in names:
        return "html"
    if "novel.docx" in names:
        return "docx"
    raise ValueError(
        "Uploaded zip does not look like a Novelcrafter export bundle: "
        "none of `novel.md`, `novel.html`, or `novel.docx` was present "
        "at the root. Re-export the project from Novelcrafter as a full "
        "bundle and try again."
    )


# ── entry.md parsing (minimal, NC-subset only) ───────────────────────────


# NC's entry.md frontmatter is YAML but uses only a narrow subset:
#   - top-level scalars (`type: character`)
#   - top-level empty arrays (`aliases: []`, `tags: []`)
#   - top-level booleans (`alwaysIncludeInContext: false`)
#   - top-level `fields:` block whose values are either:
#       * inline scalar:  `Hair Colour: Blonde`
#       * inline empty:   `Hair Colour: ""`
#       * block sequence: `Gender:\n    - Female\n    - …`
# The metadata.json sibling file duplicates the structured top-level
# values, so we only NEED the YAML parser to extract (a) the body
# text after the closing `---` and (b) the `fields:` block contents.
# Everything else flows from metadata.json which is real JSON.


_FRONTMATTER_RE = re.compile(
    r"\A---\s*\r?\n(.*?\r?\n)---\s*\r?\n?(.*)\Z", re.DOTALL
)


def _split_frontmatter_and_body(content: str) -> tuple[str, str]:
    """Split an `entry.md` document into (frontmatter, body) strings.
    If the leading `---` block is missing, the entire content is
    treated as body and frontmatter is empty.
    """
    m = _FRONTMATTER_RE.match(content)
    if not m:
        return "", content
    return m.group(1), m.group(2)


def _parse_fields_block(frontmatter: str) -> dict[str, object]:
    """Pull the `fields:` block out of the YAML frontmatter and return
    `{ field-name: value }` where each value is either a plain string
    (NC's inline scalar shape) or a list of strings (NC's block
    sequence shape).

    Returns `{}` when there is no `fields:` block or the block is
    empty (`fields: {}` shape).
    """
    out: dict[str, object] = {}
    lines = frontmatter.splitlines()

    # Locate the `fields:` line.
    fields_idx = None
    for i, line in enumerate(lines):
        stripped = line.lstrip()
        if stripped.startswith("fields:") and (line[:len(line) - len(stripped)] == ""):
            fields_idx = i
            break
    if fields_idx is None:
        return out

    # Inline empty form: `fields: {}` or `fields:`
    rest_on_same = lines[fields_idx].split(":", 1)[1].strip()
    if rest_on_same in ("{}", ""):
        # `fields: {}` → empty. `fields:` (no value) → keep walking
        # into indented block below. The bare `fields:` shape opens
        # the block; only `fields: {}` ends inline.
        if rest_on_same == "{}":
            return out

    # Walk subsequent indented lines as field entries.
    current_key: Optional[str] = None
    current_list: Optional[list[str]] = None
    # YAML block-scalar accumulator. When a `key: >-` (folded) or
    # `key: |` (literal) or any of the chomping variants (`>+` `|-`
    # etc.) opens, every following line indented DEEPER than the
    # field-key indent belongs to the block scalar — even if those
    # lines contain `:` characters. Without this, mid-scalar lines
    # like `Companion Bond with Bob:` get mistaken for new field
    # keys and the parent scalar gets truncated to just the marker
    # token (`>-` was landing as the whole value of `Unique abilities`).
    block_scalar_key: Optional[str] = None
    block_scalar_lines: list[str] = []
    block_scalar_chomp: str = ""   # "", "-", "+"
    block_scalar_style: str = ""   # ">" (folded), "|" (literal)
    block_scalar_indent: int = 0    # indent depth required to belong to the scalar
    block_key_indent: int = 0       # indent of the field-key line itself

    def _resolve_block_scalar() -> str:
        """Apply the minimal subset of YAML block-scalar rules we
        need to render NC's emitter output back into a single string
        for NN's `text`-type attribute storage. Folded (`>`) joins
        same-paragraph lines with a space; blank lines become
        newlines. Literal (`|`) preserves every line. Chomping (`-`)
        strips trailing newlines."""
        if block_scalar_style == "|":
            content = "\n".join(block_scalar_lines)
        else:
            # Folded: collapse runs of non-blank lines into single
            # space-joined paragraphs; blank lines stay as paragraph
            # breaks.
            paragraphs: list[list[str]] = [[]]
            for ln in block_scalar_lines:
                if ln.strip() == "":
                    if paragraphs[-1]:
                        paragraphs.append([])
                else:
                    paragraphs[-1].append(ln.rstrip())
            content = "\n\n".join(" ".join(p).strip() for p in paragraphs if p)
        if block_scalar_chomp == "-":
            content = content.rstrip("\n")
        elif block_scalar_chomp != "+":
            # Default ("clip"): single trailing newline retained at
            # most; we collapse to a clean trim for storage.
            content = content.rstrip("\n")
        return content

    def _flush() -> None:
        nonlocal current_key, current_list
        nonlocal block_scalar_key, block_scalar_lines, block_scalar_chomp
        nonlocal block_scalar_style, block_scalar_indent
        if block_scalar_key is not None:
            out[block_scalar_key] = _resolve_block_scalar()
            block_scalar_key = None
            block_scalar_lines = []
            block_scalar_chomp = ""
            block_scalar_style = ""
            block_scalar_indent = 0
        if current_key is not None and current_list is not None:
            out[current_key] = current_list
        current_key = None
        current_list = None

    def _line_indent(s: str) -> int:
        n = 0
        for ch in s:
            if ch == " ":
                n += 1
            elif ch == "\t":
                n += 4
            else:
                break
        return n

    _BLOCK_SCALAR_RE = re.compile(r"^([>|])([-+]?)\s*$")

    for line in lines[fields_idx + 1:]:
        # End of the `fields:` block: a non-indented line (back to
        # top-level YAML) or end of frontmatter.
        if line and not line.startswith((" ", "\t")):
            _flush()
            break

        # Inside a block scalar: collect every line at the scalar's
        # indent or deeper (or blank). Skip the per-line stripping
        # logic that fires for normal field-block lines.
        if block_scalar_key is not None:
            if not line.strip():
                block_scalar_lines.append("")
                continue
            this_indent = _line_indent(line)
            if this_indent >= block_scalar_indent:
                # Belongs to the block scalar — strip the leading
                # indent (just up to block_scalar_indent so deeper
                # indents within the scalar are preserved).
                block_scalar_lines.append(line[block_scalar_indent:])
                continue
            # Indent dropped — the scalar ended. Flush it, then
            # re-process this line normally.
            out[block_scalar_key] = _resolve_block_scalar()
            block_scalar_key = None
            block_scalar_lines = []
            block_scalar_chomp = ""
            block_scalar_style = ""
            block_scalar_indent = 0

        stripped = line.strip()
        if not stripped:
            continue

        # Determine indent depth. Field entries live at indent 1
        # (typically 2 spaces); list items live at indent 2 (4 spaces).
        # We don't enforce exact indent levels — NC's emitter uses
        # 2-space indenting, but we treat any deeper-than-`fields:`
        # indent as inside the block.
        if stripped.startswith("- "):
            # Block-sequence item belongs to the most recent field key
            # whose value was indicated as a block.
            if current_list is None and current_key is not None:
                # First list entry; transition the key into a list.
                current_list = []
                out.pop(current_key, None)
            if current_list is not None:
                current_list.append(_unquote_yaml_scalar(stripped[2:].strip()))
            continue

        # Otherwise: `key: value` or `key:` form. Flush prior list.
        _flush()

        if ":" not in stripped:
            continue
        key, _, val = stripped.partition(":")
        key = key.strip()
        val = val.strip()
        if not key:
            continue

        # YAML block-scalar opener: `key: >-`, `key: |`, etc.
        m_bs = _BLOCK_SCALAR_RE.match(val)
        if m_bs:
            block_scalar_key = key
            block_scalar_style = m_bs.group(1)   # ">" or "|"
            block_scalar_chomp = m_bs.group(2)   # "", "-", or "+"
            block_scalar_lines = []
            # Determine scalar content indent: NC's emitter uses
            # field-key indent + 2 spaces. We measure by reading the
            # first non-blank content line in the next iteration if
            # needed; for now, take "deeper than the key line's
            # indent + 1" as a permissive lower bound that catches
            # the typical 2-space stride.
            block_key_indent = _line_indent(line)
            block_scalar_indent = block_key_indent + 2
            continue

        if val == "" or val == "[]":
            # Bare `key:` opens a block sequence; the next `- item`
            # lines fill it. We pre-set as empty list so a `[]` end
            # marker resolves cleanly.
            current_key = key
            out[key] = []          # placeholder; replaced if block items follow
            if val == "[]":
                # Inline empty array — close immediately, no block.
                current_key = None
        elif val == "{}":
            out[key] = {}
        else:
            out[key] = _unquote_yaml_scalar(val)

    _flush()
    return out


def _unquote_yaml_scalar(s: str) -> str:
    """Strip surrounding single or double quotes from a YAML scalar,
    leaving inner content untouched. NC's emitter quotes scalars
    inconsistently; this is the minimal unwrap.
    """
    if len(s) >= 2 and s[0] == s[-1] and s[0] in ("'", '"'):
        return s[1:-1]
    return s


# ── Codex parsing ────────────────────────────────────────────────────────


def _iter_entry_dirs(zf: zipfile.ZipFile, folder: str) -> list[str]:
    """Return a list of `folder/{name-id}/` prefixes found in the zip.
    Each prefix points at a single codex entry directory. Skips
    nested-deeper paths and stray top-level files.
    """
    prefix = f"{folder}/"
    seen: set[str] = set()
    for name in zf.namelist():
        if not name.startswith(prefix):
            continue
        rest = name[len(prefix):]
        if not rest:
            continue
        # First path segment after the folder.
        head = rest.split("/", 1)[0]
        if head:
            seen.add(f"{prefix}{head}/")
    return sorted(seen)


def _read_thumbnail_data_uri(zf: zipfile.ZipFile, entry_dir: str) -> tuple[Optional[str], Optional[str]]:
    """Look for `thumbnail.jpg` (or `.png`) under `entry_dir/`. Returns
    `(zip_path, data_uri)` when present, `(None, None)` otherwise.
    The data URI encodes the bytes inline for the preview pane;
    commit-time thumbnail extraction copies the same bytes into the
    NN project's `assets/` folder.
    """
    for ext, mime in (("jpg", "image/jpeg"), ("jpeg", "image/jpeg"), ("png", "image/png")):
        candidate = f"{entry_dir}thumbnail.{ext}"
        try:
            data = zf.read(candidate)
        except KeyError:
            continue
        b64 = base64.b64encode(data).decode("ascii")
        return candidate, f"data:{mime};base64,{b64}"
    return None, None


def _parse_codex_entry(
    zf: zipfile.ZipFile,
    folder: str,
    entry_dir: str,
    id_map: NovelcrafterIdMap,
) -> Optional[ParsedCodexEntry]:
    """Parse one `folder/{name-id}/` entry. Returns None when the entry
    is malformed (missing metadata.json or unparseable) — caller
    surfaces a warning and skips. metadata.json drives the structured
    fields; entry.md provides the body text and the `fields:` block.
    """
    try:
        meta_raw = zf.read(f"{entry_dir}metadata.json").decode("utf-8")
    except KeyError:
        return None
    try:
        meta = json.loads(meta_raw)
    except json.JSONDecodeError:
        return None

    nc_id = str(meta.get("id") or "").strip()
    if not nc_id:
        return None

    attrs = meta.get("attributes") or {}
    nc_type = str(attrs.get("type") or "").strip().lower()
    name = str(attrs.get("name") or "").strip()
    raw_colour = attrs.get("color")
    aliases = list(attrs.get("aliases") or [])
    tags = list(attrs.get("tags") or [])
    ai_flags = {
        "alwaysIncludeInContext": bool(attrs.get("alwaysIncludeInContext")),
        "doNotTrack": bool(attrs.get("doNotTrack")),
        "noAutoInclude": bool(attrs.get("noAutoInclude")),
    }
    rels = meta.get("relationships") or {}
    nested = list(rels.get("nestedEntries") or [])

    # entry.md provides body + custom fields.
    description = ""
    fields: dict[str, object] = {}
    try:
        entry_raw = zf.read(f"{entry_dir}entry.md").decode("utf-8")
    except KeyError:
        entry_raw = ""
    if entry_raw:
        frontmatter, body = _split_frontmatter_and_body(entry_raw)
        description = body.strip()
        fields = _parse_fields_block(frontmatter)

    nn_uuid = id_map.register(nc_id)
    colour_hex = resolve_nc_colour(raw_colour)
    thumb_path, thumb_data_uri = _read_thumbnail_data_uri(zf, entry_dir)

    aliases_clean = [str(a) for a in aliases if a]
    tags_clean = [str(t) for t in tags if t]
    nested_clean = [str(n) for n in nested if n]

    # Destination-type decision. Entity-typed folders map directly via
    # ENTITY_TYPE_MAP. Lore / subplots have fixed destinations as of
    # Phase 3.5 — auto-promotion to Custom is retired. Any folder we
    # don't recognise falls through to Custom as a defensive default.
    if folder in ENTITY_TYPE_MAP:
        nn_type = ENTITY_TYPE_MAP[folder]
    elif folder == "lore":
        nn_type = LORE_DEFAULT_TYPE
    elif folder == "subplots":
        nn_type = SUBPLOT_DEFAULT_TYPE
    else:
        nn_type = "custom"  # safe fallback for any future folder name

    return ParsedCodexEntry(
        nc_id=nc_id,
        nn_uuid=nn_uuid,
        nc_type=nc_type,
        nn_type=nn_type,
        folder=folder,
        entry_dir=entry_dir,
        name=name,
        colour_hex=colour_hex,
        raw_colour=str(raw_colour) if raw_colour is not None else None,
        description=description,
        aliases=aliases_clean,
        tags=tags_clean,
        fields=fields,
        nested_entry_nc_ids=nested_clean,
        ai_flags=ai_flags,
        thumbnail_zip_path=thumb_path,
        thumbnail_data_uri=thumb_data_uri,
    )


def _parse_codex_folders(
    zf: zipfile.ZipFile,
    id_map: NovelcrafterIdMap,
    folders: list[str],
) -> tuple[list[ParsedCodexEntry], list[str]]:
    """Walk a list of codex folders and return all parsed entries plus
    a list of warnings for any malformed entries that had to be
    skipped. Same shape regardless of folder type — the destination-
    type decision lives inside `_parse_codex_entry` and routes based
    on the folder name (entity-typed direct via ENTITY_TYPE_MAP,
    lore / subplots via the auto-promotion rule).
    """
    entries: list[ParsedCodexEntry] = []
    warnings: list[str] = []
    for folder in folders:
        for entry_dir in _iter_entry_dirs(zf, folder):
            parsed = _parse_codex_entry(zf, folder, entry_dir, id_map)
            if parsed is None:
                warnings.append(
                    f"Skipped malformed codex entry at `{entry_dir}` — "
                    f"missing or unreadable `metadata.json`."
                )
                continue
            if not parsed.name:
                warnings.append(
                    f"Skipped codex entry at `{entry_dir}` — empty `name` field."
                )
                continue
            entries.append(parsed)
    return entries, warnings


# Folders Phase 3.2 + 3.3 cover. Phases 3.6 / 3.7 add snippets / chats
# via separate walkers (their on-disk shape is different — single
# `.md` files at the top level of each folder, not `{name-id}/`
# subdirectories).
CODEX_FOLDERS_3_2 = list(ENTITY_TYPE_MAP.keys())  # characters / locations / objects / other
CODEX_FOLDERS_3_3 = ["lore", "subplots"]
CODEX_FOLDERS_ALL = CODEX_FOLDERS_3_2 + CODEX_FOLDERS_3_3


# ── Tag aggregation pass (Phase 3.5 item 1) ─────────────────────────────
#
# Pure transformation: takes a list of `ParsedCodexEntry` from any
# bundle and produces the distinct-value set + per-host mapping that
# pool population (item 2) consumes. No side effects, no store reads,
# no bundle-specific assumptions baked in — every behaviour is driven
# by the entries the caller hands in.
#
# The reference bundles in `.References/` informed the normalisation
# rule set; the rules themselves are general:
#
#   1. Trim leading + trailing whitespace.
#   2. Strip exactly one leading `#` if present (observed in the wild
#      in the reference project's `#Demisophonts` tag); trim again to handle a
#      space after the hash.
#   3. Drop the value if empty after normalisation.
#   4. Case-insensitive merge — `Shop` and `shop` collapse to ONE
#      pool entry. First-encountered casing wins for the display
#      name; lowercased form is the merge key. Phase 3.4's pool
#      semantics already match case-insensitively, so the importer
#      mirrors that contract on input.
#   5. NO fuzzy / typo merging — `Demisophant` / `Demisophont` /
#      `Demisophonts` are three distinct entries. Writer cleanup
#      happens post-import via NN's tag rename UI.


def normalize_tag_value(raw: object) -> Optional[str]:
    """Apply the Phase 3.5 single-value normalisation pipeline.

    Returns the normalised display string, or `None` when the input
    is empty / whitespace-only / non-string / collapses to empty
    after the leading-`#` strip.

    Pure function — same input always yields the same output, no
    state involved.
    """
    if not isinstance(raw, str):
        return None
    cleaned = raw.strip()
    if cleaned.startswith("#"):
        cleaned = cleaned[1:].strip()
    if not cleaned:
        return None
    return cleaned


@dataclass
class TagAggregationResult:
    """Output of the Phase 3.5 aggregation pass — pure data for the
    next pass (pool population) to consume.

    Fields:
      - `distinct_display_names`: every unique tag value in the
        bundle, in encounter order (first time a tag was seen during
        the host walk). Casing is the first-encountered form.
      - `host_tags`: nn_uuid → list of display names that host carries,
        in the host's own NC tag order, deduplicated (a host listing
        the same tag twice — say `["Magic", "magic"]` — collapses to
        one entry, the first occurrence's normalised display form).
      - `host_drops`: nn_uuid → list of (raw, reason) tuples for tag
        values that were dropped during normalisation (empty after
        trim, non-string, etc.). Surfaced in the import-result
        summary for transparency. Empty list when no drops on a host.
    """

    distinct_display_names: list[str] = field(default_factory=list)
    host_tags: dict[str, list[str]] = field(default_factory=dict)
    host_drops: dict[str, list[tuple[object, str]]] = field(default_factory=dict)


def aggregate_distinct_tags(entries: list[ParsedCodexEntry]) -> TagAggregationResult:
    """Walk every parsed codex entry and produce the distinct tag set
    + per-host mapping.

    Pure function. No side effects, no store writes, no NN model
    construction here — this pass only produces the data the
    subsequent pool-population pass needs. Safe to call multiple
    times against the same input; safe to call against an empty list
    (returns an empty `TagAggregationResult`).

    Normalisation rules and contract documented above; see also
    `normalize_tag_value`.
    """
    canonical_display: dict[str, str] = {}      # match_key (lower) → first-seen display
    encounter_order: list[str] = []             # match_keys in order of first sighting
    host_tags: dict[str, list[str]] = {}        # nn_uuid → list of display names
    host_drops: dict[str, list[tuple[object, str]]] = {}

    for entry in entries:
        host_seen_keys: set[str] = set()
        host_tags.setdefault(entry.nn_uuid, [])
        for raw in entry.tags:
            normalized = normalize_tag_value(raw)
            if normalized is None:
                host_drops.setdefault(entry.nn_uuid, []).append(
                    (raw, "empty-after-normalize" if isinstance(raw, str) else "non-string")
                )
                continue
            key = normalized.lower()
            if key not in canonical_display:
                canonical_display[key] = normalized
                encounter_order.append(key)
            if key not in host_seen_keys:
                host_seen_keys.add(key)
                host_tags[entry.nn_uuid].append(canonical_display[key])

    distinct_display_names = [canonical_display[k] for k in encounter_order]

    return TagAggregationResult(
        distinct_display_names=distinct_display_names,
        host_tags=host_tags,
        host_drops=host_drops,
    )


# ── Project Tags pool population (Phase 3.5 item 2) ─────────────────────
#
# Pure transformation over the aggregation result: mints one fresh
# `Tag` per distinct display name and produces the per-host id lookup
# the commit pipeline reads when writing each host's baseline
# `tag_ids`.
#
# Pool entries are project-level (live on `Story.project_tags`) and
# are NOT chain-tracked — same shape as PresetList / CustomCategory
# definitions per the Tag model docstring. Host `tag_ids` writes land
# at the host's origin (every imported host is freshly created in
# this pass — origin is the only anchor that exists), so they're
# baseline writes, which is the chain-correct destination at origin.
#
# Default colour `#888888` per the Tag model default. The writer can
# recolour any pool entry post-import via the Tags & Lists library
# tab.


@dataclass
class ProjectTagsPoolPopulation:
    """Output of the Phase 3.5 pool population pass — pure data the
    eventual commit pipeline materialises into the new Story.

    Fields:
      - `pool`: list of `Tag` instances. Each entry has a fresh UUID
        + the display name from the aggregation result + the default
        colour. Lands in `Story.project_tags` at commit time.
      - `host_tag_ids`: nn_uuid → list of `Tag.id` values that host
        should reference. The commit pipeline reads this when
        building each host's baseline `tag_ids` field. Order matches
        the aggregation result's per-host order (host's own NC tag
        order, deduped).
    """

    pool: list[Tag] = field(default_factory=list)
    host_tag_ids: dict[str, list[str]] = field(default_factory=dict)


def populate_project_tags_pool(
    aggregation: TagAggregationResult,
) -> ProjectTagsPoolPopulation:
    """Mint a fresh Project Tag pool entry per distinct tag from the
    aggregation result + build the per-host id lookup.

    Pure transformation. Fresh UUIDs are minted, so successive calls
    against the same aggregation produce structurally-equivalent
    outputs with different ids — the input shape is deterministic,
    the id values are not. Commit-time callers run this once per
    import; preview-time callers may call it for a count without
    keeping the result (the minted ids are throwaway).

    Empty aggregation -> empty pool + empty host map. Hosts that
    carry no tags in the aggregation map to an empty list in
    `host_tag_ids` (preserving the host_uuid -> list invariant the
    commit pipeline can index without a presence check).
    """
    pool: list[Tag] = []
    display_to_id: dict[str, str] = {}
    for display_name in aggregation.distinct_display_names:
        tag = Tag(name=display_name)
        pool.append(tag)
        display_to_id[display_name] = tag.id

    host_tag_ids: dict[str, list[str]] = {}
    for nn_uuid, displays in aggregation.host_tags.items():
        host_tag_ids[nn_uuid] = [display_to_id[d] for d in displays]

    return ProjectTagsPoolPopulation(pool=pool, host_tag_ids=host_tag_ids)


# ── Prose structural walker — Markdown (Phase 3.6) ──────────────────────
#
# Walks `novel.md` content and produces a uniform Act → Chapter → Scene
# tree the commit pipeline materialises into NN Act/Chapter groups +
# Scene Nodes. Pure transformation: takes the file content as a string
# and returns nested dataclasses. No I/O, no store reads.
#
# The walker is shape-driven by NC's observed export conventions
# (documented in `docs/planning/Stage 3 - Novelcrafter Integration.md`):
#
#   - `# Title` (H1) — the novel title; consumed as a header field, not
#     a structural node.
#   - `by Author` paragraph — captured as the author line.
#   - `## Act N` (H2) — opens an Act. Heading text IS the name verbatim;
#     default `Act N` patterns flagged via `is_default_name`.
#   - `### Chapter N` or `### Chapter N: Title` (H3) — opens a Chapter
#     inside the current Act. The `Chapter N` prefix is always present;
#     `: Title` is optional.
#   - `####` / `#####` / `######` (H4-H6) — scene-heading marker within
#     the current Chapter. Heading text becomes the scene's name when
#     present, even if empty (`####` alone = unnamed scene marker).
#   - `---` on its own line — the summary → prose-body transition for
#     the CURRENT scene.
#   - `* * *` on its own line — explicit scene break within a chapter.
#     Closes the current scene's body; subsequent content opens a NEW
#     scene whose pre-`---` content is again summary.
#
# Implicit-scene rule: a chapter that has body content but no `####`
# heading or `* * *` separator still produces one Scene Node; the
# walker opens an implicit scene when entering the chapter so prose
# always has a home. Scenes with neither title nor summary nor body
# are dropped at the end (artefacts of trailing whitespace etc.).


@dataclass
class ParsedProseScene:
    """One Scene Node's worth of content as parsed from the prose
    file. `summary_md` / `body_md` are raw Markdown strings — the
    commit pipeline routes them through the frontend's
    `markdownToTiptapHtml` → `sanitizeHtmlForTiptap` chain before
    writing into `SceneNode.description` (plain-text coerced) and
    `SceneNode.main_content` (TipTap HTML).
    """

    title: Optional[str]      # H4-H6 text when present; `None` for separator-only scenes
    is_default_name: bool     # True when title matches the literal `Scene N` pattern
    summary_md: str           # raw Markdown content of the pre-`---` block, trimmed
    body_md: str              # raw Markdown content of the prose body, trimmed


@dataclass
class ParsedProseChapter:
    """One Chapter group's worth of content as parsed from the prose
    file. Holds the recovered chapter number + optional user title +
    the list of scenes belonging to it.
    """

    number: Optional[int]     # parsed from the `Chapter N` prefix; `None` if the regex didn't match
    title: Optional[str]      # the `: Title` part when present, `None` otherwise
    raw_heading: str          # full heading text for diagnostic / fall-back display
    scenes: list[ParsedProseScene] = field(default_factory=list)


@dataclass
class ParsedProseAct:
    """One Act group's worth of content. Heading-text-IS-the-name
    convention means `title` carries the H2 verbatim; the
    `is_default_name` flag marks NC's `Act N` default pattern so the
    commit pipeline can choose whether to preserve the placeholder or
    omit it (deferred decision)."""

    title: str
    is_default_name: bool
    chapters: list[ParsedProseChapter] = field(default_factory=list)


@dataclass
class ParsedProse:
    """Top-level container for the structural walker's output. Title
    and author are extracted from the leading `# Title` / `by Author`
    lines (markdown branch). `warnings` collects soft-failure notes
    the commit pipeline surfaces in the import-result summary
    (orphan prose before the first Act, malformed chapter heading,
    etc.).
    """

    title: Optional[str] = None
    author: Optional[str] = None
    acts: list[ParsedProseAct] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


# Pre-compiled regexes used by the walker. Module-level so they're
# compiled once.
_PROSE_H1_RE       = re.compile(r"^#\s+(.+?)\s*$")
_PROSE_BY_RE       = re.compile(r"^by\s+(.+?)\s*$")
_PROSE_ACT_RE      = re.compile(r"^##\s+(.+?)\s*$")
_PROSE_CHAPTER_RE  = re.compile(r"^###\s+(.+?)\s*$")
_PROSE_SCENE_RE    = re.compile(r"^#{4,6}\s*(.*?)\s*$")
_PROSE_SEP_DASH_RE = re.compile(r"^---+\s*$")
_PROSE_SEP_STAR_RE = re.compile(r"^\*\s*\*\s*\*\s*$")

# Chapter-heading inner pattern: `Chapter N` or `Chapter N: Title`.
# Number is decimal; title is optional and trimmed.
_PROSE_CHAPTER_INNER_RE = re.compile(r"^Chapter\s+(\d+)(?::\s*(.+?))?\s*$")
# Default-Act / default-Scene patterns. NC emits `Act N` / `Scene N`
# when the writer hasn't renamed; matching against these lets the
# commit pipeline decide whether to keep the placeholder string or
# omit the title entirely.
_PROSE_DEFAULT_ACT_RE   = re.compile(r"^Act\s+\d+\s*$")
_PROSE_DEFAULT_SCENE_RE = re.compile(r"^Scene\s+\d+\s*$")


def _finalize_scene_to_chapter(
    scene: Optional[ParsedProseScene],
    chapter: Optional[ParsedProseChapter],
) -> None:
    """Append `scene` to `chapter.scenes` IFF the scene carries at
    least one of (title, summary, body). Drops empty placeholder
    scenes that arise from trailing whitespace or repeated separators.
    """
    if scene is None or chapter is None:
        return
    has_content = bool(scene.title) or bool(scene.summary_md.strip()) or bool(scene.body_md.strip())
    if has_content:
        chapter.scenes.append(scene)


def _finalize_chapter_to_act(
    chapter: Optional[ParsedProseChapter],
    act: Optional[ParsedProseAct],
) -> None:
    """Append `chapter` to `act.chapters` IFF it has at least one
    scene OR a recovered number/title. Dropped otherwise."""
    if chapter is None or act is None:
        return
    has_content = bool(chapter.scenes) or chapter.number is not None or bool(chapter.title)
    if has_content:
        act.chapters.append(chapter)


def _finalize_act_to_root(
    act: Optional[ParsedProseAct],
    root: ParsedProse,
) -> None:
    """Append `act` to `root.acts` IFF it has at least one chapter
    OR a non-default title (preserve user-named empty acts)."""
    if act is None:
        return
    has_content = bool(act.chapters) or not act.is_default_name
    if has_content:
        root.acts.append(act)


def parse_prose_markdown(content: str) -> ParsedProse:
    """Walk `novel.md` content into a uniform Act → Chapter → Scene
    tree.

    Pure function: same input always yields the same output. Empty
    or whitespace-only input returns an empty `ParsedProse`. The
    walker tolerates leading non-structural lines (`# Title` /
    `by Author`) before the first `## Act` heading; anything between
    those and the first Act is recorded as a soft warning.
    """
    root = ParsedProse()
    if not content or not isinstance(content, str):
        return root

    lines = content.splitlines()
    current_act: Optional[ParsedProseAct] = None
    current_chapter: Optional[ParsedProseChapter] = None
    current_scene: Optional[ParsedProseScene] = None
    mode: str = "summary"  # "summary" or "body" — applies to current_scene
    saw_first_act = False
    saw_first_chapter = False

    for raw_line in lines:
        line = raw_line.rstrip()  # preserve interior whitespace, trim trailing

        # H1 title (only consumed before the first Act).
        if not saw_first_act:
            m = _PROSE_H1_RE.match(line)
            if m and root.title is None:
                root.title = m.group(1).strip()
                continue
            m = _PROSE_BY_RE.match(line)
            if m and root.author is None:
                root.author = m.group(1).strip()
                continue

        # Act heading — finalize everything below, open new act.
        m = _PROSE_ACT_RE.match(line)
        if m:
            _finalize_scene_to_chapter(current_scene, current_chapter)
            _finalize_chapter_to_act(current_chapter, current_act)
            _finalize_act_to_root(current_act, root)
            heading = m.group(1).strip()
            current_act = ParsedProseAct(
                title=heading,
                is_default_name=bool(_PROSE_DEFAULT_ACT_RE.match(heading)),
            )
            current_chapter = None
            current_scene = None
            mode = "summary"
            saw_first_act = True
            continue

        # Chapter heading — finalize scene + chapter; open new chapter
        # and an implicit first scene.
        m = _PROSE_CHAPTER_RE.match(line)
        if m:
            if current_act is None:
                # No Act opened yet — synthesize a default-named Act 1
                # holder so chapters never orphan. Soft warning.
                root.warnings.append(
                    "Chapter heading encountered before any Act heading; opened a synthetic `Act 1` to hold it."
                )
                current_act = ParsedProseAct(title="Act 1", is_default_name=True)
                saw_first_act = True
            _finalize_scene_to_chapter(current_scene, current_chapter)
            _finalize_chapter_to_act(current_chapter, current_act)
            heading = m.group(1).strip()
            inner = _PROSE_CHAPTER_INNER_RE.match(heading)
            if inner:
                number = int(inner.group(1))
                title = inner.group(2).strip() if inner.group(2) else None
            else:
                number = None
                title = None
                root.warnings.append(
                    f"Chapter heading `{heading}` did not match `Chapter N[: Title]` — preserved as raw heading; number not recovered."
                )
            current_chapter = ParsedProseChapter(
                number=number,
                title=title,
                raw_heading=heading,
            )
            # Implicit first scene — opens in summary mode so the
            # pre-`---` block lands in `summary_md`.
            current_scene = ParsedProseScene(
                title=None,
                is_default_name=False,
                summary_md="",
                body_md="",
            )
            mode = "summary"
            saw_first_chapter = True
            continue

        # Scene-heading-style line (`####` / `#####` / `######` —
        # the H4-H6 levels NC uses for in-prose section dividers AND
        # for scene titles, indistinguishable by markup alone).
        # v0.3.7.10 parity with the DOCX walker fix: position
        # disambiguates intent.
        #   - In summary mode (after chapter heading or `* * *`
        #     break, before any body content) → SCENE TITLE for the
        #     current scene; flip to body mode.
        #   - In body mode (after body content has started) → an
        #     in-prose SECTION DIVIDER (titled `#### <title>` or
        #     bare `####`). Fold into body_md as inline `##` heading
        #     / `---` horizontal rule. Do NOT start a new scene —
        #     NC's writer convention demarcates scenes via `* * *`
        #     in DOCX/MD/HTML; mid-body H4-H6 are sub-section
        #     formatting within a single scene.
        m = _PROSE_SCENE_RE.match(line)
        if m:
            if current_chapter is None:
                # Out-of-order content. Soft warning + drop.
                root.warnings.append(
                    "Scene heading encountered outside any chapter; dropping the heading."
                )
                continue
            heading = m.group(1).strip()
            title = heading if heading else None
            is_default = bool(title and _PROSE_DEFAULT_SCENE_RE.match(title))
            in_summary_mode = (
                current_scene is None
                or not current_scene.body_md.strip()
            ) and not (current_scene and current_scene.title)
            if in_summary_mode:
                # Scene-title path. Keep mode = summary because the
                # MD-walker convention is: H4-title → summary block
                # → `---` separator → body block. The `_PROSE_SEP_DASH_RE`
                # branch flips mode to body when it fires. Premature
                # mode = body here would shunt the summary block
                # into body_md.
                _finalize_scene_to_chapter(current_scene, current_chapter)
                current_scene = ParsedProseScene(
                    title=title,
                    is_default_name=is_default,
                    summary_md="",
                    body_md="",
                )
                mode = "summary"
                continue
            # In-body section divider path.
            if title:
                section_md = f"\n\n## {title}\n"
            else:
                section_md = "\n\n---\n\n"
            current_scene.body_md = (
                current_scene.body_md.rstrip() + section_md
                if current_scene.body_md
                else section_md.lstrip("\n")
            )
            mode = "body"
            continue

        # Summary → body transition.
        if _PROSE_SEP_DASH_RE.match(line):
            if current_scene is not None:
                mode = "body"
            continue

        # Scene break inside a chapter (no explicit H4-H6 heading).
        if _PROSE_SEP_STAR_RE.match(line):
            if current_chapter is not None:
                _finalize_scene_to_chapter(current_scene, current_chapter)
                current_scene = ParsedProseScene(
                    title=None,
                    is_default_name=False,
                    summary_md="",
                    body_md="",
                )
                mode = "summary"
            continue

        # Default: accumulate into the appropriate bucket of the
        # current scene. Lines before any chapter (after the leading
        # `# Title` / `by Author`) are dropped with a warning the
        # first time it happens.
        if current_scene is None:
            if saw_first_act and not saw_first_chapter and line.strip():
                root.warnings.append(
                    "Prose content found between Act heading and first Chapter heading; dropping."
                )
                # Mark so we don't repeat the warning per line.
                saw_first_chapter = True  # squelch repeated warnings
            continue
        if mode == "summary":
            current_scene.summary_md = (
                current_scene.summary_md + "\n" + raw_line
                if current_scene.summary_md
                else raw_line
            )
        else:
            current_scene.body_md = (
                current_scene.body_md + "\n" + raw_line
                if current_scene.body_md
                else raw_line
            )

    # Drain trailing state.
    _finalize_scene_to_chapter(current_scene, current_chapter)
    _finalize_chapter_to_act(current_chapter, current_act)
    _finalize_act_to_root(current_act, root)

    # Normalise: trim trailing whitespace from summary / body blocks.
    for act in root.acts:
        for chapter in act.chapters:
            for scene in chapter.scenes:
                scene.summary_md = scene.summary_md.strip()
                scene.body_md = scene.body_md.strip()

    return root


# ── HTML → MD line-stream lowering, then defer to parse_prose_markdown ──


# Inline tags that reconstruct as MD wrappers when emitting paragraph
# text. Order matters only for symmetry; the parser stacks them.
_INLINE_TAG_WRAPPERS = {
    "strong": "**",
    "b":      "**",
    "em":     "*",
    "i":      "*",
    "u":      "<u>",   # Markdown has no native underline; preserve as HTML
    "s":      "~~",
    "del":    "~~",
    "code":   "`",
    "mark":   "==",
}

# Closing wrappers for asymmetric inline tags (u uses </u>).
_INLINE_TAG_CLOSERS = {
    **{k: v for k, v in _INLINE_TAG_WRAPPERS.items() if v != "<u>"},
    "u": "</u>",
}


def _html_to_md_lines(html: str) -> list[str]:
    """Lower an NC `novel.html` body into the same line stream
    `parse_prose_markdown` consumes. Block elements emit MD-equivalent
    lines (`# `, `## `, `### `, `#### ` … , `---`, blank-line paragraph
    separators). Inline marks reconstruct as MD wrappers so the body /
    summary blocks downstream still carry the writer's formatting when
    marked.parse renders them into TipTap HTML.

    Hand-rolled on `html.parser` (stdlib) — no new dependency. Only
    handles the block / inline tags NC actually emits in its prose
    export; unknown tags pass through as transparent text containers.
    """
    from html.parser import HTMLParser

    BLOCK_OPENERS = {
        "h1": "# ",
        "h2": "## ",
        "h3": "### ",
        "h4": "#### ",
        "h5": "##### ",
        "h6": "###### ",
        "p":  "",
        "li": "- ",
    }

    class _Lowerer(HTMLParser):
        def __init__(self) -> None:
            super().__init__(convert_charrefs=True)
            self.lines: list[str] = []
            self._buf: list[str] = []
            self._inline_stack: list[str] = []
            self._current_prefix: Optional[str] = None
            self._in_list_ordered = False
            self._list_index = 0

        # — block helpers —
        def _flush(self) -> None:
            text = "".join(self._buf).strip()
            if self._current_prefix is not None:
                self.lines.append(self._current_prefix + text)
                self.lines.append("")  # paragraph break
            elif text:
                self.lines.append(text)
                self.lines.append("")
            self._buf.clear()
            self._current_prefix = None

        # — HTMLParser overrides —
        def handle_starttag(self, tag: str, attrs: list) -> None:
            t = tag.lower()
            if t == "br":
                self._buf.append("  \n")
                return
            if t == "hr":
                self._flush()
                self.lines.append("---")
                self.lines.append("")
                return
            if t in BLOCK_OPENERS:
                # Closing previous open block (NC's exports usually
                # close cleanly but be defensive).
                if self._current_prefix is not None or self._buf:
                    self._flush()
                if t == "li" and self._in_list_ordered:
                    self._list_index += 1
                    self._current_prefix = f"{self._list_index}. "
                else:
                    self._current_prefix = BLOCK_OPENERS[t]
                return
            if t == "ul":
                self._in_list_ordered = False
                return
            if t == "ol":
                self._in_list_ordered = True
                self._list_index = 0
                return
            if t in _INLINE_TAG_WRAPPERS:
                self._inline_stack.append(t)
                self._buf.append(_INLINE_TAG_WRAPPERS[t])
                return
            # Unknown / transparent tags (span, div, a, etc.) — pass
            # through their text content without wrapping. `a` href
            # is discarded for now; NC prose links are rare and the
            # text content survives.

        def handle_endtag(self, tag: str) -> None:
            t = tag.lower()
            if t in BLOCK_OPENERS:
                self._flush()
                return
            if t in ("ul", "ol"):
                # Lists need a trailing blank to separate from the
                # next block.
                if self.lines and self.lines[-1] != "":
                    self.lines.append("")
                return
            if t in _INLINE_TAG_CLOSERS:
                # Pop the matching inline if it's on the stack
                # (defensive against mis-nested HTML).
                if t in self._inline_stack:
                    # Pop everything above it as well so the wrappers
                    # close in stack order.
                    while self._inline_stack:
                        popped = self._inline_stack.pop()
                        self._buf.append(_INLINE_TAG_CLOSERS[popped])
                        if popped == t:
                            break
                return

        def handle_data(self, data: str) -> None:
            if data and (self._current_prefix is not None or self._buf or data.strip()):
                self._buf.append(data)

        def close_safely(self) -> None:
            self.close()
            if self._current_prefix is not None or self._buf:
                self._flush()

    parser = _Lowerer()
    parser.feed(html or "")
    parser.close_safely()

    # NC's HTML scene-break paragraph contains literal `* * *` text.
    # The `parse_prose_markdown` walker already matches `* * *` on its
    # own line, so this works naturally — no special-casing needed.

    return parser.lines


def parse_prose_html(content: Optional[str]) -> "ParsedProse":
    """Parse NC `novel.html` into the same `ParsedProse` tree the
    Markdown walker produces. Two-stage: HTML → MD-equivalent line
    stream → `parse_prose_markdown`. Keeps a single state machine
    rather than maintaining two parallel walkers.
    """
    if not content or not content.strip():
        return ParsedProse()
    md_lines = _html_to_md_lines(content)
    md_text = "\n".join(md_lines)
    return parse_prose_markdown(md_text)


# ── DOCX walker (paragraph-style based) ──────────────────────────────────


# NC's `novel.docx` uses Word's built-in style names. The export
# was inspected against real bundles before mapping was locked
# (2026-06-05):
#   * `Title`     → root.title (one per document, occurring before any
#                   Heading 1 / Heading 2). Subsequent `Title` runs
#                   are ignored.
#   * `Heading 1` → Act break.
#   * `Heading 2` → Chapter break.
#   * `Heading 3` / `Heading 4` / `Heading 5` / `Heading 6`
#                 → Scene heading (any of these — NC seems to use 3
#                   for top-level scene titles and 5 for sub-section
#                   titles inside long summaries; both map to "scene"
#                   in our model since there's no separate sub-scene
#                   concept in NN).
#   * `Normal` paragraph whose text is exactly `* * *` (any whitespace
#                 between the stars) → scene separator. Stripped from
#                 the prose; finalises the current scene and starts a
#                 fresh one in summary mode.
#   * `Normal` paragraph (any other text) → prose line for the current
#                 scene; mode-routed (summary vs body).
#   * `Quote` paragraph → emitted as a blockquote line (`> {text}`)
#                 inside the current scene's prose. Preserves NC's
#                 inline dialogue blocks; downstream marked.parse
#                 will render them as `<blockquote>`.
#   * `<no style>` empty paragraph → "structural blank". DOCX has no
#                 `---` equivalent; NC drops the separator on export.
#                 We use a `<no style>` empty paragraph (i.e. an
#                 unstyled `<w:p/>` with no text) as a best-effort
#                 summary→body transition signal: if mode is summary
#                 and the next non-blank paragraph is `Normal` (not
#                 a heading or `* * *`), the blank flips mode to body.
#                 This is a heuristic — chapters without an explicit
#                 scene heading or unstyled blank will land entirely
#                 in summary_md; the import-result summary surfaces
#                 this lossy path.

_DOCX_TITLE_STYLE         = "Title"
_DOCX_ACT_STYLE           = "Heading 1"
_DOCX_CHAPTER_STYLE       = "Heading 2"
_DOCX_SCENE_HEADING_STYLES = frozenset({"Heading 3", "Heading 4", "Heading 5", "Heading 6"})
_DOCX_QUOTE_STYLE         = "Quote"
_DOCX_NORMAL_STYLE        = "Normal"
_DOCX_STAR_SEPARATOR_RE   = re.compile(r"^\s*\*\s*\*\s*\*\s*$")


def _docx_paragraph_to_md(paragraph) -> str:
    """Render a python-docx Paragraph to Markdown-equivalent text,
    reconstructing inline marks from runs so the writer's bold /
    italic / underline survive into the downstream `markdownToTiptapHtml`
    conversion.

    Handles `paragraph.runs`; falls back to `paragraph.text` if the
    paragraph has no runs (e.g. fully empty paragraph).
    """
    if not paragraph.runs:
        return paragraph.text or ""
    out_parts: list[str] = []
    for run in paragraph.runs:
        text = run.text or ""
        if not text:
            continue
        # Reconstruct in symmetric order so wrappers nest cleanly.
        if run.bold:
            text = f"**{text}**"
        if run.italic:
            text = f"*{text}*"
        if run.underline:
            text = f"<u>{text}</u>"
        out_parts.append(text)
    return "".join(out_parts)


def parse_prose_docx(content: Optional[bytes]) -> "ParsedProse":
    """Parse an NC `novel.docx` byte stream into the uniform
    `ParsedProse` tree produced by the MD and HTML walkers.

    Direct paragraph walker (no MD-line-stream defer) because docx's
    paragraph-style model doesn't translate cleanly to a token stream
    — paragraph-level decisions (mode transitions, structural blanks)
    are easier to make against the python-docx object model directly.
    Shares the `_finalize_*` helpers with the MD walker.

    Returns an empty `ParsedProse` on `None` / empty bytes. Raises
    `ValueError` if the content is not a valid docx (caller should
    wrap with a friendly error).
    """
    if not content:
        return ParsedProse()

    # python-docx is already a dependency (used by the export
    # renderers). Lazy import keeps cold start fast for callers that
    # only need the MD/HTML walkers.
    try:
        from docx import Document  # type: ignore[import-not-found]
    except ImportError:  # pragma: no cover — handled by the requirements pin
        raise

    doc = Document(io.BytesIO(content))

    root = ParsedProse()
    current_act: Optional[ParsedProseAct] = None
    current_chapter: Optional[ParsedProseChapter] = None
    current_scene: Optional[ParsedProseScene] = None
    mode: Literal["summary", "body"] = "summary"
    saw_first_chapter = False

    def open_new_scene() -> ParsedProseScene:
        return ParsedProseScene(
            title=None,
            is_default_name=False,
            summary_md="",
            body_md="",
        )

    for paragraph in doc.paragraphs:
        style_name = paragraph.style.name if paragraph.style else ""
        text = paragraph.text or ""
        stripped = text.strip()

        # Title: only honoured before any Act/Chapter.
        if style_name == _DOCX_TITLE_STYLE:
            if root.title is None and not root.acts and current_act is None:
                root.title = stripped or None
            continue

        # Act heading.
        if style_name == _DOCX_ACT_STYLE:
            _finalize_scene_to_chapter(current_scene, current_chapter)
            _finalize_chapter_to_act(current_chapter, current_act)
            _finalize_act_to_root(current_act, root)
            heading = stripped or "Act 1"
            current_act = ParsedProseAct(
                title=heading,
                is_default_name=bool(_PROSE_DEFAULT_ACT_RE.match(heading)),
            )
            current_chapter = None
            current_scene = None
            saw_first_chapter = False
            continue

        # Chapter heading.
        if style_name == _DOCX_CHAPTER_STYLE:
            _finalize_scene_to_chapter(current_scene, current_chapter)
            _finalize_chapter_to_act(current_chapter, current_act)
            if current_act is None:
                root.warnings.append(
                    "Chapter heading encountered before any Act; synthesised Act 1."
                )
                current_act = ParsedProseAct(
                    title="Act 1",
                    is_default_name=True,
                )
            heading = stripped
            number: Optional[int] = None
            title: Optional[str] = None
            inner = _PROSE_CHAPTER_INNER_RE.match(heading) if heading else None
            if inner:
                try:
                    number = int(inner.group(1))
                except ValueError:
                    number = None
                title = inner.group(2)
            else:
                if heading:
                    root.warnings.append(
                        f"Chapter heading {heading!r} did not match `Chapter N[: Title]` "
                        f"-> preserved as raw heading; number not recovered."
                    )
            current_chapter = ParsedProseChapter(
                number=number,
                title=title,
                raw_heading=heading or "Chapter",
            )
            # Implicit first scene on chapter entry.
            current_scene = open_new_scene()
            mode = "summary"
            saw_first_chapter = True
            continue

        # Scene heading.
        if style_name in _DOCX_SCENE_HEADING_STYLES:
            # Phase 3.7N follow-up fix (v0.3.7.9): empty scene-level
            # heading (heading-styled paragraph with no actual text)
            # is treated as a blank paragraph, not a scene boundary.
            # Surfaced in the reference project DOCX where the writer had stray
            # empty Heading-3 paragraphs that the walker was reading
            # as scene breaks, inflating chapter scene counts and
            # stranding summaries.
            #
            # v0.3.7.10 refinement: an empty heading-styled paragraph
            # INSIDE a scene's body is NC's representation of an
            # untitled section divider (bare `####` in MD; `<h4>`
            # with no text in HTML). Preserve as a horizontal rule
            # (`---`) in body_md so the downstream Markdown →
            # TipTap converter renders it as a visible divider in
            # the scene's prose — matches writer intent of "break
            # the prose here". Outside of body mode (no current
            # scene, or summary-only), drop silently.
            if not stripped:
                if (
                    current_scene is not None
                    and current_scene.body_md.strip()
                ):
                    current_scene.body_md = (
                        current_scene.body_md.rstrip() + "\n\n---\n\n"
                    )
                continue
            if current_chapter is None:
                # Heading-3+ without a chapter: log and ignore (can't
                # attach an orphan scene to nothing).
                root.warnings.append(
                    f"Scene-level heading {stripped!r} encountered before any Chapter; dropping."
                )
                continue
            # Phase 3.7N follow-up (v0.3.7.10): NC uses H3-H6 for
            # TWO different things in DOCX, indistinguishable by
            # style alone — only by position in the stream:
            #
            #   - **Scene title**: appears in `summary` mode (after a
            #     chapter heading or `* * *` break, before any body
            #     content). NC's writer convention is to put the
            #     scene's title H3 between the summary block and the
            #     prose body. Walker behaviour: attach the heading
            #     text as the current scene's `title`, flip mode to
            #     body. Empty title → leave scene title None.
            #
            #   - **Mid-body section divider**: appears AFTER body
            #     content has already started. NC writers use H3-H6
            #     mid-prose for sub-section breaks (titled or empty)
            #     within a single scene. Verified against the
            #     the reference project DOCX bundle where mid-body `Heading 3`
            #     paragraphs are visible — they correspond to MD's
            #     bare `####` / titled `#### <title>` and to HTML's
            #     `<h4>` tags. SCENE boundaries in NC's DOCX are
            #     marked by `* * *` (the next branch below); mid-body
            #     H3-H6 do NOT start new scenes. Walker behaviour:
            #     fold the section divider into body_md as an inline
            #     `## <title>` Markdown heading so the downstream
            #     markdown → TipTap converter renders it visibly in
            #     the scene's prose; drop empty dividers silently.
            #
            # Phase 3.7N earlier fixes preserved:
            #   - `body_md.strip()` so whitespace-only body content
            #     (`\xa0` non-breaking spaces, blank Normal paragraphs)
            #     doesn't fool the "is the body empty?" check.
            #   - Empty stripped-text scene-level heading already
            #     short-circuited at the `if not stripped` guard at
            #     the top of this branch (treated as blank paragraph).
            in_summary_mode = (
                current_scene is None
                or not current_scene.body_md.strip()
            ) and not (current_scene and current_scene.title)
            if in_summary_mode:
                # Scene-title path.
                if current_scene is None:
                    current_scene = open_new_scene()
                title_text = stripped or None
                current_scene.title = title_text
                current_scene.is_default_name = bool(
                    title_text and _PROSE_DEFAULT_SCENE_RE.match(title_text)
                )
                mode = "body"
                continue
            # Mid-body section-divider path.
            section_md = f"\n\n## {stripped}\n"
            current_scene.body_md = (
                current_scene.body_md + section_md
                if current_scene.body_md
                else section_md
            )
            mode = "body"
            continue

        # Scene separator `* * *`.
        if stripped and _DOCX_STAR_SEPARATOR_RE.match(stripped):
            if current_scene is None or current_chapter is None:
                continue
            _finalize_scene_to_chapter(current_scene, current_chapter)
            current_scene = open_new_scene()
            mode = "summary"
            continue

        # Structural blank — best-effort summary->body transition when
        # docx has no scene heading. NC's real exports use a fully
        # un-styled paragraph (`p.style is None`) for this; python-docx
        # may also surface paragraphs as `Normal`-style with empty
        # text when a writer's tool emitted them without a pStyle.
        # Both forms count as structural-blank candidates.
        if not stripped and (not style_name or style_name == _DOCX_NORMAL_STYLE):
            if current_scene is not None and mode == "summary" and current_scene.summary_md:
                mode = "body"
                continue
            # In body mode, fall through so the join below preserves
            # the blank line for downstream paragraph rendering.
            if not style_name:
                continue

        # Otherwise this is prose content for the current scene.
        if current_scene is None:
            # Content before any chapter. Drop silently after the
            # first warning.
            if saw_first_chapter is False and current_act is not None and stripped:
                root.warnings.append(
                    "Prose content found between Act heading and first Chapter heading; dropping."
                )
                saw_first_chapter = True
            continue

        # Render this paragraph to Markdown text. Quote style emits a
        # blockquote line.
        rendered = _docx_paragraph_to_md(paragraph)
        if style_name == _DOCX_QUOTE_STYLE and rendered:
            rendered = f"> {rendered}"
        target = "summary_md" if mode == "summary" else "body_md"
        prior = getattr(current_scene, target)
        new_value = (prior + "\n" + rendered) if prior else rendered
        setattr(current_scene, target, new_value)

    # Drain trailing state.
    _finalize_scene_to_chapter(current_scene, current_chapter)
    _finalize_chapter_to_act(current_chapter, current_act)
    _finalize_act_to_root(current_act, root)

    # Normalise: trim trailing whitespace from summary / body blocks.
    for act in root.acts:
        for chapter in act.chapters:
            for scene in chapter.scenes:
                scene.summary_md = scene.summary_md.strip()
                scene.body_md = scene.body_md.strip()

    return root


# ── Preview construction ─────────────────────────────────────────────────


def _build_entity_preview_dict(
    entries: list[ParsedCodexEntry],
) -> dict[str, list[dict[str, object]]]:
    """Group parsed entries by NN type and produce the per-entity
    preview dicts the frontend dialog renders. One row per entry.
    """
    preview: dict[str, list[dict[str, object]]] = {
        "character":      [],
        "location":       [],
        "item":           [],
        "custom":         [],
        "knowledge":      [],
        "reference_node": [],
    }
    for e in entries:
        preview.setdefault(e.nn_type, []).append({
            "nn_uuid": e.nn_uuid,
            "name": e.name,
            "colour": e.colour_hex,
            "type": e.nn_type,
            "source_folder": e.folder,
            "aliases": e.aliases,
            "tags": e.tags,
            "fields_count": len(e.fields),
            "nested_count": len(e.nested_entry_nc_ids),
            "has_thumbnail": e.thumbnail_data_uri is not None,
            "profile_image_data_uri": e.thumbnail_data_uri,
            "description_preview": (e.description[:140] + "…") if len(e.description) > 140 else e.description,
        })
    # Sort each list alphabetically by name so the preview pane is stable.
    for k in preview:
        preview[k].sort(key=lambda r: (r.get("name") or "").lower())
    return preview


# ── Public entry point: build preview ────────────────────────────────────


def build_novelcrafter_preview(
    data: bytes,
    source_filename: Optional[str],
) -> NovelcrafterImportPreview:
    """Validate the upload is a Novelcrafter bundle, detect its format,
    parse the entity-typed codex (Phase 3.2 scope), stash a preview
    session, return the preview shape.

    Phase 3.2 fills in character / location / item / custom counts +
    the per-entity preview list. Lore / subplots / snippets / chats /
    scenes remain zero until their parsers ship in later sub-phases.
    """
    if not data:
        raise ValueError("Uploaded file is empty.")
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise ValueError(f"Uploaded file is not a valid zip archive: {exc}") from exc

    try:
        fmt = _detect_bundle_format(zf)
        id_map = NovelcrafterIdMap()
        codex_entries, codex_warnings = _parse_codex_folders(zf, id_map, CODEX_FOLDERS_ALL)
    finally:
        zf.close()

    session_id = str(uuid.uuid4())
    _SESSIONS[session_id] = _NovelcrafterPreviewSession(
        raw_bytes=data,
        source_filename=source_filename or "",
        format=fmt,
        id_map=id_map,
        codex_entries=codex_entries,
    )

    # Phase 3.5 — lore always lands as Knowledge, subplots always land
    # as Reference Node, NC `other/` always lands as Custom. There's
    # no auto-promotion any more, so the counts collapse to a single
    # tally per destination type.
    counts_by_type: dict[str, int] = {
        "character": 0, "location": 0, "item": 0,
        "custom_from_other": 0,
        "knowledge": 0,
        "reference_node": 0,
    }
    for e in codex_entries:
        if e.folder == "lore":
            counts_by_type["knowledge"] += 1
        elif e.folder == "subplots":
            counts_by_type["reference_node"] += 1
        elif e.folder == "other":
            counts_by_type["custom_from_other"] += 1
        else:
            key = e.nn_type
            counts_by_type[key] = counts_by_type.get(key, 0) + 1

    # Phase 3.10 — walk the prose at preview time so the dialog
    # surfaces real act / chapter / scene counts instead of
    # hardcoded zeros. The walker also runs at commit time inside
    # `nc_bundle_to_ir`; the result IS recomputed there rather than
    # carried forward via the session (the prose tree is large +
    # the walk is fast enough that re-running it on commit isn't
    # worth the extra session field). Defensive: if the prose root
    # is missing or the walker raises, fall back to zeros + a
    # warning rather than failing the whole preview.
    _preview_session = _SESSIONS[session_id]
    act_count = 0
    chapter_count = 0
    scene_count = 0
    try:
        prose_tree = _parsed_prose_for_session(_preview_session)
        act_count = len(prose_tree.acts)
        chapter_count = sum(len(a.chapters) for a in prose_tree.acts)
        scene_count = sum(
            len(ch.scenes) for a in prose_tree.acts for ch in a.chapters
        )
    except Exception as exc:  # noqa: BLE001
        codex_warnings.append(
            f"Could not walk prose for preview counts: {type(exc).__name__}: {exc}"
        )

    # Phase 3.9 — surface per-item picker lists for the import
    # dialog's snippet + chat selection popovers. Labels use the
    # SAME name-resolution helpers the cue / conversation creation
    # paths use, so what the writer sees in the picker is exactly
    # what lands in the library when the import commits. Lists are
    # empty when the bundle has no `snippets/` or `chats/` folder.
    snippets_preview: list[dict[str, str]] = [
        {
            "nc_id":  s["nc_id"],
            "label":  _cue_name_for_snippet(s["title"], s["body"]),
            "date":   s.get("date", ""),
        }
        for s in _parse_snippets(_preview_session)
    ]
    chats_preview: list[dict[str, str]] = []
    for c in _parse_chats(_preview_session):
        first_user = next(
            (content for role, content in c["turns"] if role == "user"),
            "",
        )
        chats_preview.append({
            "nc_id":  c["nc_id"],
            "label":  _conversation_name_for_chat(c["title"], first_user),
            "date":   c.get("date", ""),
        })

    return NovelcrafterImportPreview(
        session_id=session_id,
        source_filename=source_filename or "",
        # Phase 3.6 (prose import) will fill these from the first
        # `# Title` / `by Author` lines of `novel.md` / `novel.html`.
        novelcrafter_title=None,
        novelcrafter_author=None,
        format=fmt,
        counts={
            "characters": counts_by_type["character"],
            "locations":  counts_by_type["location"],
            "items":      counts_by_type["item"],
            "other":      counts_by_type["custom_from_other"],
            "lore":     {"knowledge":       counts_by_type["knowledge"]},
            "subplots": {"reference_nodes": counts_by_type["reference_node"]},
            "acts":     act_count,
            "chapters": chapter_count,
            "scenes":   scene_count,
            "snippets": len(snippets_preview),
            "chats":    len(chats_preview),
        },
        entity_preview=_build_entity_preview_dict(codex_entries),
        snippets_preview=snippets_preview,
        chats_preview=chats_preview,
        warnings=codex_warnings,
    )


# ── Phase 3.7N — IR preprocessor (NC bundle → ImportIR) ─────────────────


@dataclass
class NovelcrafterIrResult:
    """Output of `nc_bundle_to_ir`: the materialised `ImportIR` plus
    the lossy-paths summary the import-result dialog (Phase 3.10
    polish) will render.
    """

    ir: object   # avoids a top-level import_engine import here;
                 # the value is an `ImportIR` instance
    warnings: list[str] = field(default_factory=list)
    counts: dict[str, int] = field(default_factory=dict)


_NC_FIELDS_AS_ATTRIBUTES_PROMOTED = "promoted to NN attribute (type=text)"

# Phase 3.7N v0.3.7.8 — default CustomCategory all imported NC
# `other`-folder entries land into. NC has no Custom-category concept
# so without this every Custom would land with category_id=null and
# trip the `uncategorized_custom` alert (one per Custom entity). The
# writer can rename / split this category in NN after import.
NC_DEFAULT_CUSTOM_CATEGORY_NAME = "Imported from Novelcrafter"
NC_DEFAULT_CUSTOM_CATEGORY_DESCRIPTION = (
    "Default category for Custom entities imported from a Novelcrafter bundle. "
    "Novelcrafter has no Custom-category concept; rename or re-bucket from here."
)
NC_DEFAULT_CUSTOM_CATEGORY_COLOUR = "#9ca3af"


def _extract_nc_thumbnails(
    session: "_NovelcrafterPreviewSession",
    warnings: list[str],
) -> dict[str, str]:
    """Phase 3.7N follow-up — extract every codex thumbnail's bytes
    from the bundle ZIP, write them into NN's assets dir, return a
    map from the codex entry's `nn_uuid` to the rewritten
    `assets/<filename>` ref the IR should use as `profile_image_ref`.

    Without this pass, the IR `profile_image_ref` values pointed at
    paths INSIDE the source bundle (e.g. `characters/amy-XXX/thumbnail.jpg`)
    which don't exist in NN's asset namespace — so images didn't
    render AND the save chain blew up with `MissingAssetsError`
    (file_service.py:262-291) because every reference failed
    validation.

    Mirrors the entity-import pattern at
    `entity_import_service._write_imported_assets_to_disk` but keys
    by the codex entry's `nn_uuid` (unique per entry) rather than
    by bare filename — NC bundles have one `thumbnail.jpg` per
    entity folder, so a filename-keyed dedupe would collapse every
    thumbnail to one shared bytes blob.

    Collision-safe target filenames: if the target assets dir
    already has a file with the same basename, append a short UUID
    suffix to the stem (same convention as
    `_ensure_asset_in_rewrite_map`).
    """
    from services import file_service

    profile_ref_map: dict[str, str] = {}
    target_dir = file_service.get_or_create_assets_dir()

    with zipfile.ZipFile(io.BytesIO(session.raw_bytes)) as zf:
        zip_namelist = set(zf.namelist())
        for entry in session.codex_entries:
            zip_path = entry.thumbnail_zip_path
            if not zip_path:
                continue
            if zip_path not in zip_namelist:
                warnings.append(
                    f"Thumbnail for `{entry.name}` not found in bundle at "
                    f"`{zip_path}` — profile image will be missing."
                )
                continue
            try:
                raw = zf.read(zip_path)
            except (KeyError, RuntimeError) as exc:
                warnings.append(
                    f"Could not read thumbnail for `{entry.name}`: {exc}"
                )
                continue

            # Phase 3.10 item #282 — normalise EVERY NC thumbnail
            # through the canonical profile-image pipeline (256×256
            # JPEG q90, EXIF stripped, RGBA flattened, centred-square
            # cropped on non-square sources). Output matches the
            # exact shape writer-uploaded profile images take, so an
            # NC-imported character's image is indistinguishable from
            # one the writer uploaded by hand. Corpus check (all 37
            # reference bundles): only ever `.jpg` files at avg 23 KB
            # / max 31 KB, so the normaliser's job is mostly format-
            # canonicalisation, not size-cap.
            try:
                normalised = preprocess_profile_image_bytes(raw)
            except ValueError as exc:
                warnings.append(
                    f"Thumbnail for `{entry.name}` could not be processed "
                    f"({exc}); profile image will be missing."
                )
                continue

            # Output is always JPEG. Collision-safe target filename
            # built off the entry's nn_uuid (deterministic per entry —
            # re-importing into the same project produces the same
            # filename).
            suffix = entry.nn_uuid.replace("-", "")[:8]
            candidate = f"thumbnail_{suffix}.jpg"
            attempt = 0
            while (target_dir / candidate).exists() and attempt < 5:
                attempt += 1
                candidate = f"thumbnail_{suffix}_{attempt}.jpg"

            try:
                (target_dir / candidate).write_bytes(normalised)
            except OSError as exc:
                warnings.append(
                    f"Failed to write thumbnail for `{entry.name}`: {exc}"
                )
                continue

            profile_ref_map[entry.nn_uuid] = f"assets/{candidate}"

    return profile_ref_map


def _codex_entry_to_ir_entity_dict(
    entry: ParsedCodexEntry,
    host_tag_ids: dict[str, list[str]],
    tag_id_to_name: dict[str, str],
    profile_ref_map: dict[str, str],
) -> dict:
    """Convert a `ParsedCodexEntry` (Phase 3.2/3.3 codex entry) into an
    IR entity dict (the shape `_create_entity` consumes). Tag IDs
    (the NN UUIDs minted by Phase 3.5's `populate_project_tags_pool`)
    are translated back to tag NAMES so the IR stays name-keyed and
    the engine's `_apply_project_tags` pass can resolve them against
    the IR's `project_tags` pool in the usual way.

    Custom NC fields land as `text`-type attributes. NC's field-types
    don't map 1:1 to NN's typed-attribute system; landing every field
    as plain text is the v1 fallback. The Stage 3 mapping table
    documents this as a lossy path (NC `fields` → NN attributes:
    typed shape lost, content preserved).
    """
    tag_uuids = host_tag_ids.get(entry.nn_uuid, [])
    tag_names = [tag_id_to_name[u] for u in tag_uuids if u in tag_id_to_name]

    attributes: list[dict] = []
    for name, value in (entry.fields or {}).items():
        if value is None:
            continue
        # v0.3.7.11: name-based motivator detection. If the writer
        # used 'Motivation' / 'Motivator' / 'Motivations' / 'Motivators'
        # as the field name in NC's codex, emit a motivator-type
        # attribute instead of a plain text. Matches the NC-side
        # convention some writers use to track character motivators
        # without NC having a typed-motivator field.
        cf_name = name.strip().lower()
        is_motivator = cf_name in ("motivation", "motivations", "motivator", "motivators")
        if isinstance(value, list):
            if is_motivator:
                # One motivator attribute per list item.
                for item in value:
                    if item is None:
                        continue
                    attributes.append({
                        "name": name,
                        "type": "motivator",
                        "description": str(item),
                    })
            else:
                attributes.append({
                    "name": name,
                    "type": "text_list",
                    "items": [str(v) for v in value if v is not None],
                })
        else:
            if is_motivator:
                attributes.append({
                    "name": name,
                    "type": "motivator",
                    "description": str(value),
                })
            else:
                attributes.append({
                    "name": name,
                    "type": "text",
                    "value": str(value),
                })

    out: dict[str, object] = {
        "name": entry.name,
        "colour": entry.colour_hex,
        "description": entry.description,
        "aliases": list(entry.aliases),
        "tag_names": tag_names,
        "profile_image_ref": profile_ref_map.get(entry.nn_uuid),
        "attributes": attributes,
    }
    # Phase 3.7N bug fix (v0.3.7.8): if this is a Custom entity,
    # bucket it into the default "Imported from Novelcrafter"
    # CustomCategory so it doesn't trip the `uncategorized_custom`
    # alert. NC has no Custom-category concept, so without this every
    # NC custom would land with category_id=null and fire one alert
    # each.
    if entry.nn_type == "custom":
        out["category"] = NC_DEFAULT_CUSTOM_CATEGORY_NAME
    return out


def _codex_entry_to_ir_knowledge_dict(
    entry: ParsedCodexEntry,
    host_tag_ids: dict[str, list[str]],
    tag_id_to_name: dict[str, str],
    profile_ref_map: dict[str, str],
) -> dict:
    """Lore → Knowledge mapping. Knowledge has no aliases / no
    attributes / no nestedEntries on the model — those NC fields drop
    with summary per the Stage 3 mapping table."""
    tag_uuids = host_tag_ids.get(entry.nn_uuid, [])
    tag_names = [tag_id_to_name[u] for u in tag_uuids if u in tag_id_to_name]
    return {
        "name": entry.name,
        "colour": entry.colour_hex,
        "description": entry.description,
        "tag_names": tag_names,
        "profile_image_ref": profile_ref_map.get(entry.nn_uuid),
    }


def _codex_entry_to_ir_reference_node_dict(
    entry: ParsedCodexEntry,
    host_tag_ids: dict[str, list[str]],
    tag_id_to_name: dict[str, str],
) -> dict:
    """Subplot → Reference Node mapping. Reference Node has no
    profile_image_ref on the model (only `file_ref` for the 'media'
    sub-type which subplots don't trigger); the thumbnail drops with
    summary per Stage 3. Description lands as plain content; future
    work may route the description through Markdown -> TipTap
    conversion at the engine layer."""
    tag_uuids = host_tag_ids.get(entry.nn_uuid, [])
    tag_names = [tag_id_to_name[u] for u in tag_uuids if u in tag_id_to_name]
    return {
        "title": entry.name,
        "colour": entry.colour_hex,
        "content": entry.description,
        "is_rich_text": False,
        "sub_type": "note",
        "tag_names": tag_names,
    }


def _parsed_prose_for_session(session: "_NovelcrafterPreviewSession") -> ParsedProse:
    """Dispatch the right walker based on the detected bundle format
    and return the prose tree. Called from `nc_bundle_to_ir` at
    commit time — preview sessions don't carry the tree yet because
    only the entity-preview half needs it for the dialog."""
    with zipfile.ZipFile(io.BytesIO(session.raw_bytes)) as zf:
        if session.format == "markdown":
            content = zf.read("novel.md").decode("utf-8", errors="replace")
            return parse_prose_markdown(content)
        if session.format == "html":
            content = zf.read("novel.html").decode("utf-8", errors="replace")
            return parse_prose_html(content)
        if session.format == "docx":
            return parse_prose_docx(zf.read("novel.docx"))
    return ParsedProse()


def _apply_entity_placement_by_regex(
    ir_scenes: list[dict],
    characters: list[dict],
    locations: list[dict],
    items: list[dict],
    customs: list[dict],
    *,
    items_customs_threshold: int,
    default_pov_name: str | None,
) -> dict[str, int]:
    """Phase 3.7N Layer 3 of the scene-population pipeline.

    Scan each scene's `description` + `content` plaintext for
    whole-word case-sensitive matches against each entity's name +
    aliases. Place a chip in the appropriate scene bucket per
    type-specific threshold:

        Characters:  >=1 match
        Locations:   >=1 match
        Items:       >= items_customs_threshold (default 1)
        Customs:     >= items_customs_threshold (default 1)

    Knowledges deliberately excluded: they don't appear as scene
    chips; they live in the Knowledges origin column and propagate
    via awareness chains.

    `default_pov_name` (when set by Layer 2) is already on every
    scene; the regex pass skips re-adding it so the Layer 2
    placement stays the source of truth.

    Each chip lands in the scene's IR `characters` / `locations` /
    `items` / `customs` list as the entity's canonical name. The
    engine's existing `_apply_scenes` pass then creates the
    corresponding `EntityRef` at the scene anchor — a chain write
    at the scene origin, not a baseline mutation on the entity.

    Returns a counts dict for the import-result summary:
        {
          'characters_placed': N,
          'locations_placed':  M,
          'items_placed':      P,
          'customs_placed':    Q,
        }
    """
    counts = {
        "characters_placed": 0,
        "locations_placed":  0,
        "items_placed":      0,
        "customs_placed":    0,
    }

    def build_pattern(entity: dict) -> "re.Pattern | None":
        # Match the entity's name OR any of its aliases as whole words,
        # case-sensitive. Longer-first ordering ensures multi-word
        # aliases (e.g. "Dave the Bold") win over their substring
        # counterparts (e.g. "Dave") inside the alternation.
        names = [entity.get("name", "")] + list(entity.get("aliases") or [])
        names = [n.strip() for n in names if n and n.strip()]
        if not names:
            return None
        names.sort(key=len, reverse=True)
        escaped = [re.escape(n) for n in names]
        return re.compile(r"\b(?:" + "|".join(escaped) + r")\b")

    char_patterns = [(c["name"], build_pattern(c)) for c in characters]
    loc_patterns  = [(c["name"], build_pattern(c)) for c in locations]
    item_patterns = [(c["name"], build_pattern(c)) for c in items]
    cust_patterns = [(c["name"], build_pattern(c)) for c in customs]

    for sc in ir_scenes:
        text = (sc.get("description") or "") + "\n" + (sc.get("content") or "")
        if not text.strip():
            continue

        existing_chars = set(sc.get("characters") or [])
        existing_locs  = set(sc.get("locations") or [])
        existing_items = set(sc.get("items") or [])
        existing_cust  = set(sc.get("customs") or [])

        def add_matches(patterns, existing, threshold, bucket_key, counter_key):
            for name, pat in patterns:
                if not pat or name in existing:
                    continue
                if len(pat.findall(text)) >= threshold:
                    sc.setdefault(bucket_key, []).append(name)
                    existing.add(name)
                    counts[counter_key] += 1

        add_matches(char_patterns, existing_chars, 1, "characters", "characters_placed")
        add_matches(loc_patterns,  existing_locs,  1, "locations",  "locations_placed")
        add_matches(item_patterns, existing_items, items_customs_threshold, "items", "items_placed")
        add_matches(cust_patterns, existing_cust,  items_customs_threshold, "customs", "customs_placed")

    return counts


# ── Phase 3.8 — Snippets import → Context Cue Library ──────────────────────


def _strip_markdown_for_excerpt(text: str) -> str:
    """Turn a markdown body into a single flat string suitable for
    use as a cue-name fallback. Strips heading / list markers, common
    inline markup (`**bold**`, `*italic*`, `_italic_`, `` `code` ``,
    `# `), collapses all whitespace to single spaces."""
    s = text.strip()
    # Drop heading markers and list markers at line starts. Repeated
    # heading hashes (## ### etc.) all match the leading-`#` rule.
    s = re.sub(r"(?m)^\s*#{1,6}\s+", "", s)
    s = re.sub(r"(?m)^\s*[-*+]\s+", "", s)
    s = re.sub(r"(?m)^\s*\d+\.\s+", "", s)
    # Strip common inline markdown without consuming the inner text.
    s = re.sub(r"\*\*([^*]+)\*\*", r"\1", s)
    s = re.sub(r"\*([^*\n]+)\*", r"\1", s)
    s = re.sub(r"__([^_]+)__", r"\1", s)
    s = re.sub(r"_([^_\n]+)_", r"\1", s)
    s = re.sub(r"`([^`\n]+)`", r"\1", s)
    # Collapse whitespace (including newlines) to single spaces.
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _cue_name_for_snippet(title: str, body: str) -> str:
    """Resolve the Context Cue's `name` field for an imported snippet.

    Q1 design decision (recorded in v0.3.8 implementation discussion):
    when NC's `title` field has a value, use it as-is — the writer's
    intent. When `title` is empty (23 % of snippets in the reference
    corpus), fall back to `"Untitled Cue - "` + the first ~60 chars
    of the markdown-stripped body, with "…" appended when truncated.
    The `Untitled Cue` prefix accurately describes what makes THIS
    cue's name a fallback (the snippet had no title in NC); the
    `Imported` tag on every cue separately marks the origin. Using
    `Imported Cue` as the prefix would be misleading since all the
    imported cues are "imported" but only the prefixed ones are
    untitled. The trailing `…` makes obviously-truncated names
    visually distinct so the writer knows the cue needs a rename.
    """
    if title and title.strip():
        return title.strip()
    excerpt = _strip_markdown_for_excerpt(body)
    if not excerpt:
        return "Untitled Cue - (empty body)"
    limit = 60
    if len(excerpt) <= limit:
        return f"Untitled Cue - {excerpt}"
    return f"Untitled Cue - {excerpt[:limit].rstrip()}…"


# Filename shape: `{YYYY-MM-DD} {slug} - {NC_id}.md`
# OR (when title is empty): `{YYYY-MM-DD} {NC_id}.md`
_SNIPPET_FILENAME_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}\s+(?:.*-\s*)?([A-Za-z0-9]+)\.md$"
)


def _date_from_nc_filename(name: str) -> str:
    """Extract the YYYY-MM-DD date prefix from an NC `snippets/` or
    `chats/` filename. Returns the empty string when the filename
    doesn't start with a date (defensive — every NC reference bundle
    follows the pattern, but this guards against future NC naming
    changes without breaking the preview list)."""
    base = name.rsplit("/", 1)[-1]
    if len(base) >= 10 and base[4] == "-" and base[7] == "-":
        return base[:10]
    return ""


def _parse_snippets(
    session: "_NovelcrafterPreviewSession",
    *,
    accept_ids: Optional[set[str]] = None,
) -> list[dict]:
    """Phase 3.8 — read every `snippets/*.md` file from the NC bundle
    and return a list of parsed dicts.

    Each dict carries:
      * `nc_id`        — the NC short id extracted from the filename
                          (preserved as a tag so the writer can trace
                          a library cue back to its NC origin)
      * `title`        — value of the YAML `title:` field (string,
                          may be empty)
      * `favourite`    — value of the YAML `favourite:` field (bool,
                          defaults to False)
      * `body`         — everything after the closing `---` marker,
                          stripped of leading / trailing blank lines

    Frontmatter shape verified against the 135 snippets in the 28
    NC reference bundles that ship snippets — only ever the two keys
    `title` and `favourite`, both always present.

    Returns an empty list when the bundle has no `snippets/` folder.
    The caller is responsible for the opt-in gate; this function does
    NOT consult the writer's checkbox.
    """
    out: list[dict] = []
    with zipfile.ZipFile(io.BytesIO(session.raw_bytes)) as zf:
        for name in zf.namelist():
            if not name.startswith("snippets/") or not name.endswith(".md"):
                continue
            # Extract NC id from filename FIRST so we can early-skip
            # entries the writer deselected via the picker.
            base = name.rsplit("/", 1)[-1]
            m = _SNIPPET_FILENAME_RE.match(base)
            nc_id = m.group(1) if m else base[:-3]  # strip `.md`
            if accept_ids is not None and nc_id not in accept_ids:
                continue
            raw = zf.read(name).decode("utf-8", errors="replace")
            frontmatter, body = _split_frontmatter_and_body(raw)
            # NC snippet frontmatter is flat `key: value` lines at the
            # top level (NOT inside a `fields:` block — that shape is
            # codex-only). The 135-file corpus survey verified the
            # only keys are `title` (string) and `favourite` (bool).
            title_val = ""
            fav_val = False
            for line in (frontmatter or "").splitlines():
                if ":" not in line:
                    continue
                key, _, value = line.partition(":")
                key = key.strip().lower()
                value = _unquote_yaml_scalar(value.strip())
                if key == "title":
                    title_val = value
                elif key == "favourite":
                    fav_val = value.strip().lower() == "true"
            out.append({
                "nc_id": nc_id,
                "title": title_val,
                "favourite": fav_val,
                "body": body.strip(),
                "date": _date_from_nc_filename(name),
            })
    return out


def _create_imported_cues(
    snippets: list[dict],
    story_title: Optional[str],
    warnings: list[str],
    *,
    session_id: Optional[str] = None,
    progress_callback=None,
) -> int:
    """Phase 3.8 — create one Context Cue per parsed snippet.

    Q2 design decision (recorded in v0.3.8 implementation discussion):
    each imported cue is tagged with TWO strings: the story's title
    (from the NC prose walker — so the writer can filter "cues that
    came from THIS project") + the literal `"Imported"` (so the
    writer can find / bulk-manage everything that landed via NC
    import across projects).

    NC's `favourite: true` maps directly to `ContextCue.pinned` per
    the Phase 2.8 model field semantics (verified via audit).

    Returns the count of successfully-created cues. Surfaces per-cue
    failures into the `warnings` list so the writer sees them in the
    import-result summary.
    """
    if not snippets:
        return 0
    # Lazy import to avoid pulling the context-cues service / its
    # filesystem setup into module-load time for callers that don't
    # use snippet import.
    from services import context_cues_service
    from models.context_cue import ContextCue

    tags = []
    if story_title and story_title.strip():
        tags.append(story_title.strip())
    tags.append("Imported")

    created = 0
    for s in snippets:
        # Phase 3.10 — boundary cancel check. The cancel endpoint
        # flips the flag asynchronously; we break out at the next
        # per-cue iteration so the rollback path sees a consistent
        # set of created IDs.
        if session_id and is_commit_cancelled(session_id):
            break
        try:
            cue = ContextCue(
                id=str(uuid.uuid4()),
                name=_cue_name_for_snippet(s["title"], s["body"]),
                body=s["body"],
                tags=list(tags),
                pinned=bool(s["favourite"]),
                colour=None,
                updated_at=None,  # service stamps it
            )
            context_cues_service.create_cue(cue)
            created += 1
            if session_id:
                track_created_cue(session_id, cue.id)
            if progress_callback:
                # Phase 3.10 — single per-item event drives the
                # unified global counter (router increments + writes
                # to the progress slot). Label shows the writer the
                # cue's display name as it lands.
                progress_callback(f"Cue: {cue.name}")
        except Exception as exc:  # noqa: BLE001 — broad on purpose
            warnings.append(
                f"Failed to import snippet `{s.get('nc_id', '?')}` to "
                f"Context Cue Library: {exc!r}"
            )
    return created


# ── Phase 3.9 — Chats import → Conversation threads ───────────────────────


def _conversation_name_for_chat(title: str, first_user_message: str) -> str:
    """Resolve the Conversation's `name` field for an imported chat.

    Mirrors Phase 3.8's `_cue_name_for_snippet` shape: when NC's
    `title` field has a value, use it as-is (writer's intent). When
    `title` is empty — which is the case for 97.5 % of the chats in
    the corpus survey (1,484 of 1,522) — fall back to
    `"Untitled Chat - "` + the first ~60 chars of the markdown-
    stripped FIRST User message + `…` when truncated.

    The `Untitled Chat` prefix accurately describes what makes the
    name a fallback (the chat had no NC title); the per-thread
    `Imported` tag separately marks the origin. Earlier `Imported`
    prefix shapes were misleading because all imported threads are
    "imported" but only the prefixed ones are untitled.
    """
    if title and title.strip():
        return title.strip()
    excerpt = _strip_markdown_for_excerpt(first_user_message or "")
    if not excerpt:
        return "Untitled Chat - (empty)"
    limit = 60
    if len(excerpt) <= limit:
        return f"Untitled Chat - {excerpt}"
    return f"Untitled Chat - {excerpt[:limit].rstrip()}…"


# Filename shape: `{YYYY-MM-DD} {slug?} - {NC_id}.md`
# (slug + ` - ` optional; some chats have just date + id with no slug.)
_CHAT_FILENAME_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}\s+(?:.*-\s*)?([A-Za-z0-9]+)\.md$"
)

# Phase 3.9 — NC's chat editor renders 5-space-indented sub-list
# items as nested lists, which is lenient compared to CommonMark
# (the spec says any line with 4+ leading spaces becomes a code
# block). 41 of 124 chats in the reference NC bundle (33 % of the
# project; 4,129 affected lines total across the project) hit this:
# AI answers wrap sub-bullets at 5-space indents under top-level
# numbered items. Without normalization the writer's chat panel
# shows those sub-bullets as code-block-styled grey monospaced
# rectangles instead of indented list items.
#
# Normalization rule: collapse any 4+ leading spaces on a line that
# starts with a list marker (`-`, `*`, `+`, or `\d+.`) down to
# exactly 3 spaces. Real code blocks (indented but NOT list-marker
# lines) are preserved verbatim — we only touch what we can prove
# was meant as a sub-list. 3 spaces is the CommonMark minimum
# sub-list depth under a top-level `1. ` parent, so it's safe for
# the dominant case. Bullet-list parents accept 2-space sub-lists
# but also accept 3-space; numbered-list parents require ≥ 3 so we
# pick the higher floor.
_INDENT_LIST_LINE_RE = re.compile(r"^ {4,}([-*+]|\d+\.)(\s)(.*)$")


def _normalize_nc_markdown_indent(body: str) -> str:
    """Apply the 4+ space → 3 space normalization documented at
    `_INDENT_LIST_LINE_RE`. Pure transformation: returns a new
    string. Caller decides when to use it (Phase 3.9 chat-import
    path applies it per-turn before constructing
    `ConversationMessage` objects).

    Code-block safety:
      * Indented (4+ space) code blocks with NO list marker on the
        line aren't touched — the regex anchor requires a list
        marker right after the indent run.
      * Triple-backtick / triple-tilde FENCED code blocks are
        tracked here so lines INSIDE a fence whose content happens
        to start with `- ` or `1. ` aren't rewritten. Fence
        openers are recognised as lines whose stripped content
        starts with ``` or ~~~ (with optional language tag
        following). Toggle on each opener; lines while
        `in_fence == True` pass through verbatim.
      * Inline backtick code (`like this`) doesn't span lines so
        it's irrelevant here.
    """
    out: list[str] = []
    in_fence = False
    for line in body.split("\n"):
        stripped = line.lstrip()
        # Toggle fence on lines starting with ``` or ~~~ (any
        # language tag after the marker is allowed). Always emit
        # the fence line verbatim.
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_fence = not in_fence
            out.append(line)
            continue
        if in_fence:
            out.append(line)
            continue
        m = _INDENT_LIST_LINE_RE.match(line)
        if m:
            out.append("   " + m.group(1) + m.group(2) + m.group(3))
        else:
            out.append(line)
    return "\n".join(out)


# Critical: anchor on EXACT `## User` / `## AI` headings only.
# Bare `^##\s` matches mis-segment chats — the corpus survey found
# 639 unique H2 strings (`## **Age`, `## 0.`, etc.) generated by the
# AI inside turn content. The `(?m)` flag makes `^` / `$` match line
# boundaries; the trailing `\s*$` allows trailing whitespace but
# disallows additional content on the heading line.
_CHAT_SECTION_RE = re.compile(r"(?m)^##\s+(User|AI)\s*$")


def _parse_chats(
    session: "_NovelcrafterPreviewSession",
    *,
    accept_ids: Optional[set[str]] = None,
) -> list[dict]:
    """Phase 3.9 — read every `chats/*.md` file from the NC bundle
    and return a list of parsed dicts.

    Each dict carries:
      * `nc_id`        — NC short id extracted from filename, kept
                          for traceability (no NN equivalent field
                          on Conversation; we tag origin separately)
      * `title`        — value of YAML `title:` field (may be empty;
                          97.5 % of corpus chats have empty title)
      * `favourite`    — value of YAML `favourite:` field (bool)
      * `turns`        — list of `(role, content)` tuples where
                          role is `"user"` or `"assistant"` per the
                          `ConversationMessage` Literal vocabulary

    Frontmatter shape verified uniform across the 1,522 reference-
    bundle chats — only `title` and `favourite` keys ever appear.

    Body segmentation: anchored EXCLUSIVELY on exact `## User` /
    `## AI` line matches via `_CHAT_SECTION_RE`. Content H2s
    (`## **Age`, `## 0.`, etc., generated by the AI) survive as
    part of the surrounding turn's content unmolested.

    Returns an empty list when the bundle has no `chats/` folder.
    The caller is responsible for the opt-in gate; this function
    does NOT consult the writer's checkbox.
    """
    out: list[dict] = []
    with zipfile.ZipFile(io.BytesIO(session.raw_bytes)) as zf:
        for name in zf.namelist():
            if not name.startswith("chats/") or not name.endswith(".md"):
                continue
            # Extract NC id from filename FIRST so we can early-skip
            # entries the writer deselected via the picker.
            base = name.rsplit("/", 1)[-1]
            m = _CHAT_FILENAME_RE.match(base)
            nc_id = m.group(1) if m else base[:-3]
            if accept_ids is not None and nc_id not in accept_ids:
                continue
            raw = zf.read(name).decode("utf-8", errors="replace")
            frontmatter, body = _split_frontmatter_and_body(raw)
            # NC chat frontmatter is flat `key: value` lines at the
            # top level — same shape as snippets (NOT inside a
            # `fields:` block).
            title_val = ""
            fav_val = False
            for line in (frontmatter or "").splitlines():
                if ":" not in line:
                    continue
                key, _, value = line.partition(":")
                key = key.strip().lower()
                value = _unquote_yaml_scalar(value.strip())
                if key == "title":
                    title_val = value
                elif key == "favourite":
                    fav_val = value.strip().lower() == "true"

            # Segment body by exact `## User` / `## AI` headings.
            # `_CHAT_SECTION_RE.split` returns interleaved
            # `[before_first_heading, role1, content1, role2, content2, ...]`.
            # The leading element is preamble before any heading (usually
            # empty; if not, we drop it — it's not part of a labelled
            # turn).
            parts = _CHAT_SECTION_RE.split(body)
            turns: list[tuple[str, str]] = []
            # parts[0] is the pre-first-heading remainder; skip it.
            for i in range(1, len(parts) - 1, 2):
                role_raw = parts[i].strip()
                content = parts[i + 1].strip()
                role = "user" if role_raw == "User" else "assistant"
                turns.append((role, content))

            out.append({
                "nc_id": nc_id,
                "title": title_val,
                "favourite": fav_val,
                "turns": turns,
                "date": _date_from_nc_filename(name),
            })
    return out


def _create_imported_conversations(
    chats: list[dict],
    story_id: str,
    story_title: Optional[str],
    warnings: list[str],
    *,
    session_id: Optional[str] = None,
    progress_callback=None,
) -> int:
    """Phase 3.9 — create one `Conversation` per parsed NC chat.

    Each conversation is stamped with:
      * `story_id` — the immutable Phase 2.6 linkage UUID. Without
        this the thread lands in the shared "Untitled" bucket
        instead of THIS project.
      * `story_title` — the Phase 2.11b cross-story-display snapshot.
        Mutable; refreshed on every save. Setting it here gives
        the browser a meaningful name for the thread right after
        import (matches the saved-story title).
      * `tags = [story_title, "Imported"]` — mirrors Phase 3.8's
        Context-Cue tagging scheme. Feeds the program-tag pool
        aggregation so writers can filter by either tag in the
        conversation browser.
      * `pinned_in_browser` — NC `favourite: true` maps directly per
        the audit-verified Phase 2.4f field.
      * `profile_id` / `model` / `system_prompt_id` — left None.
        Surfaced via the import-result summary (Phase 3.9 missing-
        metadata clarity item) so the writer picks them on first
        resume.

    Returns the count of successfully-created conversations.
    Per-thread failures surface into `warnings`; never block the
    project import.
    """
    if not chats:
        return 0
    # Lazy import to avoid pulling the conversations service / its
    # filesystem setup into module-load time for callers that don't
    # use chat import.
    from services import conversations_service
    from models.conversation import Conversation, ConversationMessage

    tags: list[str] = []
    if story_title and story_title.strip():
        tags.append(story_title.strip())
    tags.append("Imported")

    created = 0
    for c in chats:
        # Phase 3.10 — boundary cancel check; see _create_imported_cues.
        if session_id and is_commit_cancelled(session_id):
            break
        try:
            now_iso = conversations_service._utcnow_iso()
            # NC filenames carry only a date (no time) — anchor at noon
            # UTC on that date so the chat bubble's date label reflects
            # when the NC chat actually happened, not when import ran.
            # Fall back to import time if the filename had no date.
            chat_date = c.get("date") or ""
            chat_iso = f"{chat_date}T12:00:00+00:00" if chat_date else now_iso
            messages = []
            for role, content in c["turns"]:
                messages.append(ConversationMessage(
                    id=str(uuid.uuid4()),
                    role=role,
                    content=content,
                    timestamp=chat_iso,
                ))
            # Resolve the display name. _conversation_name_for_chat
            # uses the first User-role message content as the
            # fallback excerpt source.
            first_user = next(
                (m.content for m in messages if m.role == "user"),
                "",
            )
            name = _conversation_name_for_chat(c["title"], first_user)

            convo = Conversation(
                id=str(uuid.uuid4()),
                name=name,
                created_at=chat_iso,
                updated_at=chat_iso,
                profile_id=None,
                model=None,
                system_prompt_id=None,
                pinned_in_browser=bool(c["favourite"]),
                story_id=story_id,
                story_title=(story_title or None),
                tags=list(tags),
                colour=None,
                messages=messages,
            )
            conversations_service.save_conversation(
                convo,
                story_title=story_title,
                preserve_updated_at=True,
            )
            created += 1
            if session_id:
                track_created_conversation(session_id, convo.id)
            if progress_callback:
                # Phase 3.10 — per-chat progress event. Label shows
                # the resolved conversation name so the modal
                # reflects what's being written (NC titles + the
                # "Untitled Chat - <excerpt>…" fallbacks).
                progress_callback(f"Chat: {name}")
        except Exception as exc:  # noqa: BLE001 — broad on purpose
            warnings.append(
                f"Failed to import chat `{c.get('nc_id', '?')}` to "
                f"Conversation threads: {exc!r}"
            )
    return created


def nc_bundle_to_ir(
    session: "_NovelcrafterPreviewSession",
    story_settings: dict | None = None,
    placement_settings: dict | None = None,
) -> NovelcrafterIrResult:
    """Phase 3.7N — take a preview session (parsed codex + raw bundle
    bytes) and produce a complete `ImportIR` ready for the engine.

    Pipeline:
      1. Parse prose with the format-appropriate walker.
      2. Aggregate tags across codex entries; populate the Project
         Tags pool (Phase 3.5 functions).
      3. Build the `project_tags` IR entries from the pool.
      4. Build entity / knowledge / reference_node IR buckets from
         codex entries, translating per-host tag UUIDs back to names.
      5. Build chapters / acts / scenes IR entries from the prose tree.
      6. Populate `story.title` / `story.author` from the prose
         walker output (author drops on DOCX per Stage 3 design).
      7. Apply optional `story_settings` (Phase 3.7N Layer 2):
           - `default_pov_character` (str | None): when set, becomes
             a chip with `has_pov=True` on every scene. Fills the gap
             left by NC not exporting per-scene POV info.
           - `tense`, `language`, `pov_type` (str | None): land on
             the Story object's matching fields.
      8. Collect lossy-paths warnings.

    Returns a `NovelcrafterIrResult` with the IR plus warnings and
    counts the commit endpoint surfaces to the writer.
    """
    # Lazy import keeps this module loadable in contexts that don't
    # need the engine (e.g. the preview endpoint).
    from services.import_engine import ImportIR

    warnings: list[str] = []
    counts: dict[str, int] = {}

    prose = _parsed_prose_for_session(session)
    warnings.extend(prose.warnings)

    aggregation = aggregate_distinct_tags(session.codex_entries)
    pool = populate_project_tags_pool(aggregation)

    # IR project_tags entries: name + color. Engine mints fresh UUIDs
    # at apply time, so we don't pass through the pool's UUIDs.
    project_tags = [
        {"name": t.name, "color": t.color}
        for t in pool.pool
    ]

    # Lookup from minted-pool UUID back to canonical name so each
    # host's tag_uuids list can translate to tag_names.
    tag_id_to_name = {t.id: t.name for t in pool.pool}

    # Phase 3.7N bug fix (v0.3.7.8): extract thumbnail bytes from the
    # bundle ZIP into NN's assets dir BEFORE building IR entries so
    # `profile_image_ref` values point at real files in NN's asset
    # namespace. Without this every imported entity/knowledge would
    # have a dangling ref (image blank in the UI + save chain blows
    # up with `MissingAssetsError` on the next save attempt).
    profile_ref_map = _extract_nc_thumbnails(session, warnings)

    # Group codex entries by NN destination type.
    by_nn_type: dict[str, list[ParsedCodexEntry]] = {}
    for entry in session.codex_entries:
        by_nn_type.setdefault(entry.nn_type, []).append(entry)

    characters = [
        _codex_entry_to_ir_entity_dict(e, pool.host_tag_ids, tag_id_to_name, profile_ref_map)
        for e in by_nn_type.get("character", [])
    ]
    locations = [
        _codex_entry_to_ir_entity_dict(e, pool.host_tag_ids, tag_id_to_name, profile_ref_map)
        for e in by_nn_type.get("location", [])
    ]
    items = [
        _codex_entry_to_ir_entity_dict(e, pool.host_tag_ids, tag_id_to_name, profile_ref_map)
        for e in by_nn_type.get("item", [])
    ]
    customs = [
        _codex_entry_to_ir_entity_dict(e, pool.host_tag_ids, tag_id_to_name, profile_ref_map)
        for e in by_nn_type.get("custom", [])
    ]
    # Phase 3.7N bug fix (v0.3.7.8): if any custom entities exist,
    # emit a default CustomCategory the engine will materialise
    # before the entities. `_create_entity` looks the category up
    # by name via `self.custom_category_id`, so the category must
    # be in the IR's `custom_categories` list — pre-existing
    # category names from the writer (zero in NC's case) would
    # still be respected, since this is just adding ours.
    custom_categories: list[dict] = []
    if customs:
        custom_categories.append({
            "name": NC_DEFAULT_CUSTOM_CATEGORY_NAME,
            "description": NC_DEFAULT_CUSTOM_CATEGORY_DESCRIPTION,
            "colour": NC_DEFAULT_CUSTOM_CATEGORY_COLOUR,
        })
    knowledges = [
        _codex_entry_to_ir_knowledge_dict(e, pool.host_tag_ids, tag_id_to_name, profile_ref_map)
        for e in by_nn_type.get("knowledge", [])
    ]
    reference_nodes = [
        _codex_entry_to_ir_reference_node_dict(e, pool.host_tag_ids, tag_id_to_name)
        for e in by_nn_type.get("reference_node", [])
    ]

    # Prose → chapters / acts / scenes. The walker output is a tree
    # (acts → chapters → scenes); the IR is flat per-bucket with
    # name-keyed cross-references (act.chapters = list of chapter
    # names; scene.chapter = chapter name).
    ir_chapters: list[dict] = []
    ir_acts: list[dict] = []
    ir_scenes: list[dict] = []

    # Phase 3.7N Layer 2: resolve the writer's optional default POV
    # character pick from the import dialog. NC's bundle has no
    # per-scene POV info, so without this pass every imported scene
    # would fire a `pov_no_character` alert. When supplied, the
    # picked character lands as a chip with `has_pov=True` on every
    # scene; writer manually re-routes per-scene afterward via the
    # POV chip flow.
    settings = story_settings or {}
    default_pov_name_raw = (settings.get("default_pov_character") or "").strip()
    default_pov_name: str | None = None
    # Character name lookup (casefolded → canonical) is used by both
    # the default-POV resolver below and the chapter-title heuristic.
    char_name_lookup: dict[str, str] = {c["name"].casefold(): c["name"] for c in characters}
    if default_pov_name_raw:
        # Match against the character-bucket names case-insensitively
        # so the frontend dropdown's display label resolves cleanly.
        canonical = char_name_lookup.get(default_pov_name_raw.casefold())
        if canonical:
            default_pov_name = canonical
        else:
            warnings.append(
                f"Default POV character `{default_pov_name_raw}` was not "
                f"found among imported characters; POV assignment skipped. "
                f"All scenes will land without a POV character; address "
                f"individual scenes via the POV chip flow after import."
            )

    # Phase 3.7N Layer 2 polish — opportunistic detection of an
    # AUTHOR-WRITTEN POV annotation in the chapter title. This is NOT
    # a Novelcrafter system convention — NC's export format carries
    # no per-chapter POV signal, and an audit of the 37 reference NC
    # bundles in `.References/NovelCrafter export example/` found
    # this pattern in exactly 1 chapter out of 1,759 (Chapter 111 of
    # the reference project: "INTERLUDE - Bob's POV", an annotation
    # the writer typed by hand into the title). So this code path
    # fires rarely, but when an author DOES happen to annotate the
    # POV in the title we'd prefer to honour it over the writer-
    # picked default. Patterns matched case-insensitively with word
    # boundaries:
    #   "{name} POV"             — bare suffix
    #   "{name}'s POV"           — possessive
    #   "from {name}'s POV"      — "from X's POV" phrase
    #   "{name}'s viewpoint"     — possessive viewpoint
    # ASCII apostrophe `'` AND Unicode `’` both accepted. Character
    # names tried in descending length order so multi-word names win
    # over single-word substrings (e.g. "Lord Commander Vorlagh
    # Nyxandr POV" matches the full name, not just "Lord" if it
    # happens to be a character). The lossy-paths warning surfaces
    # any chapter that triggered this code path so the writer can
    # verify it wasn't a false positive on an unrelated chapter
    # title that happened to contain a character name before "POV".
    _pov_marker_re_by_char: dict[str, re.Pattern] = {}
    for casefolded, canonical in sorted(char_name_lookup.items(), key=lambda kv: -len(kv[0])):
        # Combined alternation, all four patterns in one regex per character.
        name_esc = re.escape(casefolded)
        apos = r"['’]"
        pattern_str = (
            r"(?:"
            rf"\bfrom\s+{name_esc}{apos}s\s+pov\b"
            r"|"
            rf"\b{name_esc}{apos}s\s+pov\b"
            r"|"
            rf"\b{name_esc}\s+pov\b"
            r"|"
            rf"\b{name_esc}{apos}s\s+viewpoint\b"
            r")"
        )
        _pov_marker_re_by_char[canonical] = re.compile(pattern_str)
    # Counter exposed to the lossy-paths summary so the writer knows how
    # many chapters used the heuristic.
    _pov_heuristic_chapter_count = 0

    def _pov_from_chapter_title(ch_title_raw: str) -> str | None:
        nonlocal _pov_heuristic_chapter_count
        if not ch_title_raw:
            return None
        low = ch_title_raw.casefold()
        # Sorted-by-length iteration via the dict's insertion order
        # (we populated it in descending length order above).
        for canonical, pattern in _pov_marker_re_by_char.items():
            if pattern.search(low):
                _pov_heuristic_chapter_count += 1
                return canonical
        return None

    for act in prose.acts:
        act_chapter_names: list[str] = []
        for chapter in act.chapters:
            ch_title = chapter.raw_heading if not chapter.title else (
                f"Chapter {chapter.number}: {chapter.title}"
                if chapter.number is not None else chapter.title
            )
            ir_chapters.append({"title": ch_title})
            act_chapter_names.append(ch_title)
            # Layer 2 polish: chapter-title heuristic. Check this
            # chapter's title against the POV markers; if a character
            # is named there, that character takes POV for ALL scenes
            # in THIS chapter (overriding default_pov_name). Empty
            # title → fall through to default.
            chapter_pov_name = _pov_from_chapter_title(ch_title) or default_pov_name
            for scene in chapter.scenes:
                sc_title = scene.title or ""
                scene_dict: dict = {
                    "title": sc_title,
                    "chapter": ch_title,
                    "description": scene.summary_md,
                    "content": scene.body_md,
                }
                # Layer 2: place the resolved POV character as a chip
                # on every scene + set `pov` so the engine's
                # `_apply_scenes` pass flips that chip's
                # `EntityRef.has_pov=True` at scene origin (a chain
                # write at the scene anchor, not a baseline edit on
                # the character).
                if chapter_pov_name:
                    scene_dict["characters"] = [chapter_pov_name]
                    scene_dict["pov"] = chapter_pov_name
                ir_scenes.append(scene_dict)
        ir_acts.append({
            "title": act.title,
            "chapters": act_chapter_names,
        })

    story_block: dict = {}
    if prose.title:
        story_block["title"] = prose.title
    if prose.author:
        story_block["author"] = prose.author
    else:
        # DOCX drops the author line per the Stage 3 mapping table.
        if session.format == "docx":
            warnings.append(
                "DOCX bundles drop the `by Author` line at NC export time; "
                "Story.author left empty. Set it manually in Story settings."
            )

    # Layer 2: story-level settings the writer supplied in the import
    # dialog (tense / language / pov_type). NC doesn't export any of
    # these so the dialog is the only source. Empty values are left
    # unset on the IR; the engine treats absence as "no change".
    for src_key, ir_key in (
        ("tense", "tense"),
        ("language", "language"),
        ("pov_type", "pov_default"),
    ):
        v = (settings.get(src_key) or "").strip()
        if v:
            story_block[ir_key] = v

    # Layer 2 summary message: surface the POV assignment to the
    # import-result summary so the writer knows what landed and
    # what they need to update.
    if default_pov_name:
        warnings.append(
            f"Default POV character `{default_pov_name}` assigned to all "
            f"{len(ir_scenes)} imported scenes. NarrativeNode cannot "
            f"recover per-scene POV from Novelcrafter's export. Update "
            f"individual scenes that should belong to other POVs via the "
            f"scene's POV chip flow."
        )
        if _pov_heuristic_chapter_count:
            warnings.append(
                f"{_pov_heuristic_chapter_count} chapter(s) had an "
                f"author-written POV annotation in the title (a character "
                f"name followed by `POV`, `'s POV`, `from X's POV`, or "
                f"`'s viewpoint`) and used that character instead of the "
                f"default POV for the chapter's scenes. Novelcrafter has "
                f"no system convention for this — it's a free-text habit "
                f"some authors use — so check those chapters and confirm "
                f"the assignment was what you intended."
            )
    elif ir_scenes:
        warnings.append(
            f"No default POV character was picked at import. All "
            f"{len(ir_scenes)} imported scenes land without a POV "
            f"character attached and will surface `pov_no_character` "
            f"alerts until you assign one."
        )

    # Phase 3.7N Layer 3 — regex name + alias placement of other
    # entities into scene chip lists. Scans each scene's description
    # + content prose for whole-word case-sensitive matches of every
    # entity's name and aliases; places a chip per the configured
    # threshold. Knowledges are deliberately excluded.
    placement = placement_settings or {}
    auto_place = placement.get("auto_place_entities", True)
    raw_threshold = placement.get("items_customs_threshold")
    try:
        threshold = max(1, int(raw_threshold)) if raw_threshold is not None else 1
    except (TypeError, ValueError):
        threshold = 1
    if auto_place and ir_scenes:
        placement_counts = _apply_entity_placement_by_regex(
            ir_scenes,
            characters,
            locations,
            items,
            customs,
            items_customs_threshold=threshold,
            default_pov_name=default_pov_name,
        )
        counts.update(placement_counts)
        warnings.append(
            f"Auto-placed entity chips by name + alias match: "
            f"{placement_counts['characters_placed']} characters, "
            f"{placement_counts['locations_placed']} locations, "
            f"{placement_counts['items_placed']} items, "
            f"{placement_counts['customs_placed']} customs (threshold "
            f"{threshold} for items/customs, 1 for characters/locations). "
            f"Pronoun-only mentions weren't detected; some matches may be "
            f"false positives. Review and refine per scene."
        )
    elif ir_scenes:
        warnings.append(
            "Entity auto-placement was disabled at import. Scenes land "
            "with only the default POV character (if picked) attached; "
            "add other entities per scene manually via the canvas."
        )

    ir = ImportIR(
        story=story_block,
        project_tags=project_tags,
        custom_categories=custom_categories,
        characters=characters,
        locations=locations,
        items=items,
        customs=customs,
        knowledges=knowledges,
        reference_nodes=reference_nodes,
        chapters=ir_chapters,
        acts=ir_acts,
        scenes=ir_scenes,
    )

    # Counts for the import-result summary dialog.
    counts.update({
        "characters": len(characters),
        "locations": len(locations),
        "items": len(items),
        "customs": len(customs),
        "knowledges": len(knowledges),
        "reference_nodes": len(reference_nodes),
        "project_tags": len(project_tags),
        "chapters": len(ir_chapters),
        "acts": len(ir_acts),
        "scenes": len(ir_scenes),
    })

    # Lossy-paths surfacing. NC carries data NN deliberately drops
    # per Stage 3 mapping — surface those drops so the writer knows.
    for entry in session.codex_entries:
        if entry.nn_type == "knowledge" and (entry.aliases or entry.fields or entry.nested_entry_nc_ids):
            warnings.append(
                f"Lore entry `{entry.name}` had aliases / fields / nested entries that "
                f"drop on import (Knowledge has no slot for them)."
            )
        elif entry.nn_type == "reference_node" and (
            entry.aliases or entry.fields or entry.nested_entry_nc_ids or entry.thumbnail_zip_path
        ):
            warnings.append(
                f"Subplot `{entry.name}` had aliases / fields / nested entries / thumbnail "
                f"that drop on import (Reference Node has no slot for them)."
            )
        if any(entry.ai_flags.values()):
            warnings.append(
                f"`{entry.name}` had AI context flags (alwaysIncludeInContext / "
                f"doNotTrack / noAutoInclude) — NN has no per-entity context-injection "
                f"system, so these drop on import."
            )

    return NovelcrafterIrResult(ir=ir, warnings=warnings, counts=counts)
