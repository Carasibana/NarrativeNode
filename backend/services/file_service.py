"""Pack and unpack .nnz project files (ZIP archives)."""
import io
import json
import shutil
import tempfile
import uuid
import zipfile
from pathlib import Path
from typing import Callable

from main import PROGRAM_VERSION
from models import ENTITY_BUCKETS
from models.story import Story
from models.seeds import SeedsFile
from services import seeds_service


# ──────────────────────────────────────────────────────────────────────────
# Save format versioning
#
# NarrativeNode has exactly one writer — itself — so we reuse the program
# version as the save format identifier rather than maintaining a separate
# abstract format version. On disk, narrative.json carries:
#
#   save_format_version — the PROGRAM_VERSION of the build that wrote the
#     file. Churns naturally on every tagged release commit; serves as
#     forensic data ("which build produced this file?") and as the key
#     the migration dispatch walks forward from.
#
#   min_reader_versions — a dict of per-capability compat floors. Each
#     key is a reader capability (currently "load" and "import"); each
#     value is the minimum PROGRAM_VERSION of a build that understands
#     what that capability needs from this file. Different capabilities
#     care about different parts of the schema, so their floors can
#     diverge over time. A loader rejects a file whose "load" floor is
#     higher than the running program; an importer rejects a file whose
#     "import" floor is higher than the running program.
#
# At load time we compare the file's `min_reader_versions.load` against
# this running program's `PROGRAM_VERSION`. If the file requires a newer
# loader we raise `IncompatibleSaveError(capability="load", ...)`.
# Otherwise we walk the `MIGRATIONS` chain forward from the file's
# `save_format_version` up to the current `MIN_READER_EPOCHS["load"]` to
# upgrade the dict in place. The import path does the analogous thing
# against `min_reader_versions.import` / `MIN_READER_EPOCHS["import"]`.
#
# Versions use the 4-part scheme `0.{stage}.{phase}.{revision}` that the
# project's git tags already use — `_parse_version` enforces it.
# Comparisons are lexicographic on the integer tuple, so for any two
# tags reachable in this repo, "later tag" always compares greater.
#
# Additive changes (new optional fields, new optional containers) DO NOT
# require anything in this file to change. Pydantic's `extra='allow'`
# preserves unknown fields on round-trip, and its field defaults fill in
# missing values when a newer reader opens an older file. You only touch
# this file when a change is structurally incompatible — see the
# MAINTAINER CHECKLIST below for the full decision tree.
#
# ──── MAINTAINER CHECKLIST — read before touching save / load ────────────
# Any change that affects what lands in `narrative.json` on save or how
# it is interpreted on load MUST consider the following, together, in the
# same commit. For the complete user-facing guide see:
#
#   docs/save-format-versioning.md
#
#   1. Does the change ADD a NEW OPTIONAL FIELD to any save-structure
#      model (and nothing else)?
#      → Do nothing here. Pydantic's default value + extra='allow' handle
#        both directions (old reader opens new file → unknown field is
#        preserved round-trip; new reader opens old file → default value
#        fills in). MIN_READER_EPOCHS stays where it is.
#
#   2. Does the change REMOVE, RENAME, or STRUCTURALLY RESHAPE an
#      existing field? (Any transformation a reader cannot recover from
#      its defaults.) For EACH capability in MIN_READER_EPOCHS, ask:
#      does THIS capability's reader code actually look at the field
#      being changed?
#      → If YES → bump that capability's epoch in MIN_READER_EPOCHS to
#        the PROGRAM_VERSION this change is landing in.
#      → If NO → leave that capability alone. Its epoch stays where it
#        was; files written by the new build continue to be importable
#        by older importers.
#      In both cases, add a new entry to MIGRATIONS keyed on the old
#      save_format_version value whose target is the new one, with a
#      migration function that takes old-shape data to new-shape data.
#      The migration MUST be additive / idempotent: if the target
#      field is already present (because it round-tripped from a newer
#      writer), leave it alone. Never clobber foreign content.
#
#   3. Are you changing the error shapes or error classes
#      (IncompatibleSaveError, CorruptSaveError)? Update
#      backend/routers/project.py (`_unpack_or_raise`, load endpoints)
#      AND backend/routers/entity_import.py (import_preview endpoint)
#      AND frontend/src/store/projectStore.js
#      (`handleSaveFormatLoadError`) in the SAME commit so the dialog
#      stays in sync across every path that can raise.
#
#   4. Are you bumping any entry in MIN_READER_EPOCHS? Add a CHANGELOG
#      entry describing the breaking change, which capability it
#      affected, and the migration. Bump PROGRAM_VERSION in
#      backend/main.py alongside — every tagged release commit touches
#      both files, and a breaking change is always a tagged release.
# ──────────────────────────────────────────────────────────────────────────

# Per-capability compat floors. Each key is a reader capability; each
# value is the minimum PROGRAM_VERSION of a build that understands that
# capability's requirements from the current save format. Files written
# by this program stamp `min_reader_versions` from this dict, and the
# corresponding load-time checks reject any file whose floor exceeds the
# running program's PROGRAM_VERSION.
#
# Capabilities:
#   "load"   — reads the full story (nodes, connections, chapter layout,
#              story settings, etc.) for the normal open-project flow.
#              Bumps whenever ANY breaking change to the save format
#              lands.
#   "import" — reads only what the entity-import flow walks: entities,
#              entity chains, and the scenes / modifier nodes that feed
#              chain traversal. Bumps only when a breaking change
#              affects one of those pieces. A change that only touches
#              e.g. plot point positions or chapter tint colour does NOT
#              bump "import" — the import path never looks at those,
#              so an older importer can still handle the newer file.
#
# BUMP ON BREAKING CHANGES ONLY. Additive changes do not touch this.
# See the MAINTAINER CHECKLIST above for how to decide which capability
# to bump when.
MIN_READER_EPOCHS: dict[str, str] = {
    # Bumped for Phase 1.22 (v0.1.22.0): `attribute_type` Literal grew
    # three new values — `'circumstance'`, `'motivator'`, `'number'`.
    # Pre-1.22 readers will reject saves that contain attributes of
    # those types (the Pydantic Literal validator throws on unknown
    # values). Schema also adds `Attribute.description` /
    # `Attribute.intensity` / `Attribute.number_value`, the new
    # top-level `Circumstance` class, `SceneNode.circumstances`, and
    # the `AttributeChange.new_description` / `new_intensity` /
    # `new_number_value` per-field modify payloads — all additive,
    # but the new `attribute_type` literal values are the breaking
    # piece that gates the load + import capability epochs.
    # Bumped for the awareness-history hoist: `EntityRef.awareness_changes[]`
    # and per-attribute `attribute_changes` with
    # `action='awareness_set' / 'awareness_source_*'` are now hoisted
    # to canonical `host.awareness.history[]` (`AwarenessHistoryEntry`)
    # on every load and stripped from the raw dict. The "import" floor
    # stays at 0.1.22.41 — the entity-import walker doesn't touch
    # awareness chain data.
    # Bumped 2026-05-17 for the aliases chain-event refactor: the new
    # `EntityRef.alias_changes: list[AliasChange]` field replaces the
    # old `aliases_change` snapshot. Pre-v0.2.1.76 builds have
    # `extra='ignore'` configured on EntityRef so they would silently
    # drop the new field and lose every scene-anchored alias change.
    # Bumping the load floor forces those builds to refuse the save
    # cleanly rather than corrupt it.
    # Bumped 2026-06-01 for Phase 2.13 (v0.2.13.0): the `attribute_type`
    # Literal grew a new value — `'perspective'`. Pre-2.13 readers
    # will reject saves that contain attributes of that type (the
    # Pydantic Literal validator throws on unknown values). Schema
    # also adds `Attribute.perspective_target_kind` /
    # `Attribute.perspective_target_id` (both Optional, default None
    # on every existing attribute — additive), but the new Literal
    # value is the breaking piece that gates the load capability
    # epoch. Import floor stays put — the entity-import walker
    # treats perspective attributes the same as any other attribute
    # row.
    "load": "0.2.13.0",
    "import": "0.1.22.41",
}


def _assert_master_flavoured_floors() -> None:
    """Module-import-time guard rail that prevents a flavour-tagged
    string from ever sneaking into MIN_READER_EPOCHS via a future
    maintainer typo / paste from a retired branch tag. Off-master
    flavour tags don't map onto the master version line and would
    silently corrupt every save written by this build.

    Raises ValueError if any value in the dict carries an alphabetic
    component (`_is_branch_flavour_version` definition). Called once
    at module import below."""
    for cap, val in MIN_READER_EPOCHS.items():
        if not isinstance(val, str):
            raise ValueError(
                f"MIN_READER_EPOCHS[{cap!r}] must be a string, got "
                f"{type(val).__name__}"
            )
        if _is_branch_flavour_version(val):
            raise ValueError(
                f"MIN_READER_EPOCHS[{cap!r}] cannot be a flavour-tagged "
                f"version: {val!r}. Off-master flavour tags must never "
                f"be used as save-format floors — write the "
                f"master-branch equivalent (where the breaking change "
                f"actually shipped on master) instead."
            )


def _assert_master_flavoured_program_version() -> None:
    """Companion guard rail for `PROGRAM_VERSION` — that string is
    written into every save's `save_format_version` field, so the
    same flavour-tag prohibition applies. A flavour-tagged
    PROGRAM_VERSION would silently leak retired-branch metadata into
    every fresh save."""
    if _is_branch_flavour_version(PROGRAM_VERSION):
        raise ValueError(
            f"PROGRAM_VERSION cannot be a flavour-tagged version: "
            f"{PROGRAM_VERSION!r}. Master builds must stamp a plain "
            f"`0.{{stage}}.{{phase}}.{{revision}}` version string."
        )

# Hard save-format cliff introduced in v0.1.18. Files saved by builds
# before this version used an incompatible binary pair-relationship model
# (entity_a_id / entity_b_id). No migration was written; users must
# recreate projects in v0.1.18 or later.
RELATIONSHIP_CLIFF_VERSION = "0.1.18.0"

# "legacy" is the sentinel used to identify a pre-tracker file — one
# written before `save_format_version` / `min_reader_versions` existed
# as fields at all. Pre-tracker files are pre-cliff by definition;
# `_check_pre_cliff` rejects them before the migration chain runs.
# The constant survives only as the comparison value for that cliff
# check.
_LEGACY = "legacy"


class IncompatibleSaveError(Exception):
    """Raised when a save file declares a per-capability floor in
    `min_reader_versions` that is greater than this program's
    `PROGRAM_VERSION` — the file was written by a newer build of
    NarrativeNode and this one cannot handle the requested capability
    safely.

    `capability` is one of the keys in `MIN_READER_EPOCHS` ("load" or
    "import") — it tells the caller / frontend which operation was
    being attempted so the dialog can phrase itself correctly."""

    def __init__(
        self,
        *,
        capability: str,
        file_version: str,
        min_required: str,
    ) -> None:
        super().__init__(
            f"Save written by {file_version} requires {capability!r} "
            f"capability to be at least NarrativeNode {min_required}; "
            f"this program is NarrativeNode {PROGRAM_VERSION}."
        )
        self.capability = capability
        self.file_version = file_version
        self.min_required = min_required


class CorruptSaveError(Exception):
    """Raised when a save file's version metadata is present but malformed
    (wrong type, unparseable, wrong shape). Pre-tracker files with no
    version fields at all are NOT corrupt — they're handled as legacy."""

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


class MissingAssetsError(Exception):
    """Raised when `pack_project` discovers that the story references
    asset filenames that exist neither in the in-process `_assets_dir`
    nor in the recovery source (typically the currently-active project
    file on disk). Saving in that state would write a ZIP whose
    narrative.json points at assets that never get written into the
    `assets/` entry, producing a silently-corrupt save.

    Now that packing is reference-filtered and no longer prunes the
    working assets dir mid-session (see `pack_project`), the common
    cause of this error is gone: a freshly-uploaded image held in an
    uncommitted UI draft is no longer deleted by an autosave that fires
    during the edit. What can still trigger it is the backend losing
    its in-memory `_assets_dir` (a process restart / crash relaunch, or
    a dev-mode `uvicorn --reload`) AFTER a reference was committed but
    BEFORE any save persisted the bytes to disk, while the frontend
    survives to re-supply the reference on the next save.

    The save endpoint surfaces this as an HTTP 500. The detail message
    lists each missing asset filename together with the entity /
    knowledge / scene that references it, so the user can re-upload the
    image or file to the named object and save again."""

    def __init__(self, missing: set[str], owners: "dict[str, list[str]] | None" = None) -> None:
        self.missing = sorted(missing)
        # owners maps a missing filename to human-readable description(s)
        # of the object(s) that reference it. Optional so historical /
        # test callers that construct with just the filename set still
        # work; absent owners degrade to the bare filename.
        self.owners = owners or {}
        # Distinct owner labels across all missing files. Front-loaded
        # into the lead sentence so the affected item stays visible even
        # where the UI truncates the message to one line (the save-error
        # banner uses `truncate` + a hover tooltip for the full text).
        affected = []
        for fname in self.missing:
            for who in self.owners.get(fname, []):
                if who not in affected:
                    affected.append(who)
        if affected:
            shown = affected[:3]
            more = len(affected) - len(shown)
            summary = "; ".join(shown) + (f"; and {more} more" if more > 0 else "")
            lead = f"Save blocked: missing image or file for {summary}."
        else:
            lead = (f"Save blocked: {len(self.missing)} image or file "
                    f"reference(s) are missing their files.")
        item_lines = []
        for fname in self.missing:
            who = self.owners.get(fname)
            if who:
                item_lines.append(f"  - {fname} (used by {'; '.join(who)})")
            else:
                item_lines.append(f"  - {fname}")
        detail = (
            lead
            + "\n\nMissing files:\n"
            + "\n".join(item_lines)
            + "\n\nTo fix, open each affected item, re-upload its image or "
            "file, then save again. If you have an earlier saved copy of "
            "this project that still has the image, opening that copy will "
            "also restore it."
        )
        super().__init__(detail)
        self.detail = detail


def build_incompatible_detail(exc: "IncompatibleSaveError") -> dict:
    """Build the structured HTTP error payload for an `IncompatibleSaveError`.

    Shared between `routers/project.py` (load endpoints) and
    `routers/entity_import.py` (import preview endpoint) so both paths
    surface the same shape to the frontend and `handleSaveFormatLoadError`
    can handle either caller without branching. The frontend reads this
    payload to render the "this project needs a newer NarrativeNode"
    dialog via the `confirm()` system.
    """
    return {
        "error": "incompatible_save",
        "capability": exc.capability,
        "file_version": exc.file_version,
        "min_required": exc.min_required,
        "program_version": PROGRAM_VERSION,
    }


def build_corrupt_detail(exc: "CorruptSaveError") -> dict:
    """Shared structured HTTP error payload for a `CorruptSaveError`.
    See `build_incompatible_detail` for the sharing rationale."""
    return {
        "error": "corrupt_save",
        "detail": exc.detail,
    }


def _is_branch_flavour_version(v: str) -> bool:
    """Return True iff a 4-part `0.{stage}.{phase}.{revision}` version
    string carries an alphabetic flavour suffix on any component (e.g.
    a third component spelled `2a` instead of plain `2`).

    Branch-flavour suffixes mark off-master tags whose work was later
    squash-merged to master under a master-flavoured version. Their
    numeric components do not map cleanly onto the master version
    line, so they should not gate save-format comparisons against the
    current (always master-flavoured) `PROGRAM_VERSION`. Callers use
    this check to short-circuit floor enforcement when the file
    declares a branch-flavoured floor.

    Returns False for plain 4-part numeric versions, malformed inputs,
    and the legacy sentinel. Pure predicate; raises nothing.
    """
    if not isinstance(v, str):
        return False
    parts = v.split(".")
    if len(parts) != 4:
        return False
    for p in parts:
        if not p:
            return False
        # A part that is fully numeric is master-flavoured; anything
        # else (digits + letters, all letters, etc.) carries a flavour
        # suffix and is therefore off-master.
        if not p.isdigit():
            return True
    return False


def _parse_version(v: str) -> tuple[int, int, int, int]:
    """Parse a 4-part `0.{stage}.{phase}.{revision}` version string to an
    integer tuple for comparison. This is the same scheme the project's
    git tags use.

    Branch-tag flavour suffixes are tolerated: a trailing alphabetic run
    on any component (e.g. `"2a"` in `0.2a.1.2`) is stripped before the
    integer cast, so `0.2a.1.2` parses to `(0, 2, 1, 2)` — identical to
    `0.2.1.2`. Flavour suffixes are a human-readable label only and
    carry no version-comparison weight.

    Raises ValueError on anything that isn't four dot-separated parts
    whose digit content is a non-negative integer — the caller turns
    that into a CorruptSaveError with context.
    """
    parts = v.split(".")
    if len(parts) != 4:
        raise ValueError(
            f"expected 4-part '0.stage.phase.revision', got {v!r}"
        )
    # Strip a trailing alphabetic flavour suffix (e.g. `2a` -> `2`)
    # before the integer cast. Empty / non-digit-prefixed parts still
    # fail the .isdigit() check below.
    stripped: list[str] = []
    for p in parts:
        i = 0
        while i < len(p) and p[i].isdigit():
            i += 1
        stripped.append(p[:i])
    if not all(s and s.isdigit() for s in stripped):
        raise ValueError(
            f"version components must start with a non-negative integer, got {v!r}"
        )
    return tuple(int(s) for s in stripped)  # type: ignore[return-value]


# Import-time guard rails. Fire immediately so any flavour-tagged
# string sneaking into MIN_READER_EPOCHS or PROGRAM_VERSION trips a
# failed startup, not a silently-corrupted save weeks later. Both
# helpers are defined alongside MIN_READER_EPOCHS; we can only invoke
# them here because `_is_branch_flavour_version` (used by both) is
# defined just above this line.
_assert_master_flavoured_floors()
_assert_master_flavoured_program_version()


# Temp directory for assets of the currently loaded project
_assets_dir: Path | None = None

# Phase 5.2a — the active project's cover image. The cover is NOT an
# asset: it lives at the .nnz ROOT as a fixed `cover.jpg` (sibling to
# narrative.json), never under `assets/`, and is never touched by the
# asset pruner. Its working copy lives in its own temp dir so the two
# stores stay cleanly separate. Presence of the file IS the cover;
# absence = no cover (a derived `has_cover`, never a stored field).
_cover_dir: Path | None = None
_COVER_NAME = "cover.jpg"


def _normalise_scene_terminology(data: dict) -> dict:
    """Permanent load-side compatibility shim for the v0.1.21.x rename of
    `plot_point` / `PlotPointNode` / `plot_point_nodes` → `scene` /
    `SceneNode` / `scenes`.

    The save format previously serialised the bucket of scene nodes as
    `plot_point_nodes` and stamped each node with `node_type: "plot_point"`.
    Files written by builds before that rename are still loaded by reading
    the legacy keys and rewriting them in-place to the new names. The
    save side only ever writes the new names, so a load → re-save cycle
    auto-upgrades any legacy file to the new shape transparently. The
    shim is intentionally permanent rather than versioned: there is no
    cost to it, and keeping it in place forever lets older files load
    gracefully across any number of future migrations.

    See `docs/save-format-versioning.md` for the documentation of this
    rename and the compatibility contract.
    """
    if not isinstance(data, dict):
        return data

    # Container field rename. Only copy if the new key is absent so a
    # re-saved file (which already carries `scenes`) is left alone.
    if "plot_point_nodes" in data and "scenes" not in data:
        data["scenes"] = data.pop("plot_point_nodes")
    elif "plot_point_nodes" in data and "scenes" in data:
        # Pathological case — both keys present. Prefer `scenes` (the
        # newer one) and drop the legacy bucket so nothing iterates it
        # by accident downstream.
        data.pop("plot_point_nodes", None)

    # Per-node `node_type: "plot_point"` discriminator rename. Pydantic's
    # Literal validator rejects the old string, so rewrite each one.
    scenes = data.get("scenes")
    if isinstance(scenes, list):
        for node in scenes:
            if isinstance(node, dict) and node.get("node_type") == "plot_point":
                node["node_type"] = "scene"

    return data


def _normalise_faction_self_join_strip(data: dict) -> dict:
    """Permanent load-side correction shim: factions never join their own
    membership relationship.

    Earlier builds (pre-v0.1.26.51) auto-emitted a `participant_changes`
    `join` event for the faction itself when the faction's membership
    relationship was created — a leftover from a pre-Phase-1.18 approach
    to faction membership that no longer makes sense. The faction is
    not a "member of itself"; the membership rel exists to track who
    belongs to the faction, and the rel is always rendered on the
    faction origin node via `Relationship.membership_of`, not via the
    participant list.

    For every relationship with `membership_of` set, this shim strips
    any `participant_changes` entry whose `entity_id == membership_of`
    AND whose `action` is `join` or `leave`. Idempotent: re-running on
    an already-clean save is a no-op. Permanent rather than versioned
    so any save written by a buggy build (regardless of version stamp)
    auto-corrects on load and re-saves clean.

    No data is lost: the auto-emitted self-join was never a writer-
    intended membership claim, and removing it does not affect the
    faction origin node's rendering of its membership rel chip (the
    chip is anchored on `membership_of`, not participants — see
    `relationshipsByScene` in `frontend/src/store/projectStore.js`).
    """
    if not isinstance(data, dict):
        return data
    rels = data.get("relationships")
    if not isinstance(rels, list):
        return data
    for rel in rels:
        if not isinstance(rel, dict):
            continue
        membership_of = rel.get("membership_of")
        if not membership_of:
            continue
        history = rel.get("history")
        if not isinstance(history, dict):
            continue
        pcs = history.get("participant_changes")
        if not isinstance(pcs, list):
            continue
        history["participant_changes"] = [
            pc for pc in pcs
            if not (
                isinstance(pc, dict)
                and pc.get("entity_id") == membership_of
                and pc.get("action") in ("join", "leave")
            )
        ]
    return data


# Version-keyed migration dispatch. Keys are PROGRAM_VERSION strings;
# each entry maps a source version to (target_version, migration_fn).
# On load we start at the file's declared `save_format_version` and walk
# forward through the chain, applying each fn in turn, until we reach
# the current target (derived below). Pre-tracker / pre-cliff saves
# never reach this dispatch — `_check_pre_cliff` rejects them before
# migrations run, so the chain only handles `save_format_version >=
# RELATIONSHIP_CLIFF_VERSION`.
#
# WHEN ADDING A NEW ENTRY: read the MAINTAINER CHECKLIST at the top of
# this file first, then see docs/save-format-versioning.md for the full
# step-by-step. The key of the new entry must be the PROGRAM_VERSION of
# the commit BEFORE the breaking change; the target is the PROGRAM_VERSION
# of the commit INTRODUCING the breaking change. Migrations must be
# additive / idempotent — never clobber a field that's already present
# in the dict (it may have round-tripped from a newer writer).
def _migrate_knowledge_refactor(data: dict) -> dict:
    """Phase 1.21c Knowledge Refactor migration — reshape pre-refactor
    saves from the Entity-subtype Knowledge model into the first-class
    `Story.knowledges` list of `Knowledge` objects. Applied to any file
    stamped with `save_format_version` in the range [0.1.18.0, 0.1.21.15).

    Transformations:
      - Move every old knowledge-typed Entity from `entities.knowledges`
        (and any stray knowledge-typed Entity in other buckets — defensive)
        to a new top-level `knowledges` list. Preserve id / name /
        description / colour / profile_image_ref / awareness. Drop
        attributes / aliases / relationships list / parent_id /
        category_id / label / type.
      - Remove knowledge-entity ids from relationship participant lists
        and relationship history entries keyed on entity_id.
      - Drop `SceneNode.knowledges` entirely (field removed from the
        model). Strip knowledge-entity ids from `chip_order`.
      - On every remaining `EntityRef` in surviving scene buckets:
        strip `awareness_changes` entries whose `entity_id` points at a
        former knowledge, and strip `attribute_changes` entries of kind
        `list_add` / `list_remove` / `awareness_set` whose `list_item`
        points at a former knowledge.
      - Drop any `entity_nodes` (setup/modifier) whose `entity_id`
        pointed at a former knowledge.
      - Filter `library_layout.knowledges` ordering to ids that
        actually survived the move.
      - Stamp a `_migration_summary` ephemeral key on the result with
        the number of knowledges migrated and a list of dropped-field
        counts for the load-response consumer to surface.

    Additive / idempotent per MAINTAINER CHECKLIST: if a file has
    already been migrated (no `entities.knowledges` content and a
    populated top-level `knowledges` list), this fn is effectively a
    no-op on the migration-relevant fields.
    """
    import sys

    # Collect all old knowledge-typed Entity dicts into one list, and
    # build the set of ids that used to belong to knowledge entities.
    entities = data.get("entities") or {}
    old_knowledges_bucket = entities.get("knowledges", []) if isinstance(entities, dict) else []
    if not isinstance(old_knowledges_bucket, list):
        old_knowledges_bucket = []

    old_knowledge_entities: list[dict] = []
    for ent in old_knowledges_bucket:
        if isinstance(ent, dict):
            old_knowledge_entities.append(ent)

    # Defensive: an Entity with type="knowledge" might have ended up in
    # a different bucket due to prior bug / manual edit. Sweep all other
    # buckets too; move any hits and remove them from the source bucket.
    if isinstance(entities, dict):
        for bucket_key in ("characters", "locations", "items", "factions", "customs"):
            bucket = entities.get(bucket_key, [])
            if not isinstance(bucket, list):
                continue
            keepers: list = []
            for ent in bucket:
                if isinstance(ent, dict) and ent.get("type") == "knowledge":
                    old_knowledge_entities.append(ent)
                else:
                    keepers.append(ent)
            entities[bucket_key] = keepers
        # Scrub the legacy `entities.knowledges` bucket field — removed
        # from the `Entities` model in Phase 1.21c. `pop` (rather than
        # set-to-[]) so the empty list does not ride forward as
        # `extra="allow"` foreign content into freshly saved files.
        entities.pop("knowledges", None)

    # Scrub legacy `Relationship.participants` field from every
    # relationship dict. The field was removed from the `Relationship`
    # model in v0.1.18.114; participants are now derived from
    # `history.participant_changes`. Saves written between v0.1.18.0
    # and v0.1.18.113 carry the field as foreign content via
    # `extra="allow"`. Pop unconditionally so freshly saved files stop
    # carrying the stale field forward.
    for rel in data.get("relationships", []) or []:
        if isinstance(rel, dict):
            rel.pop("participants", None)

    # Scrub legacy `SceneNode.intra_relationships` field from every
    # scene dict. The field was removed from the `SceneNode` model in
    # v0.2a.2.13; it had no surviving frontend render consumer and was
    # only being maintained by strip arms during entity/relationship
    # delete cascades. `extra="ignore"` on SceneNode already drops
    # unknown keys on load, but the explicit pop here is symmetric
    # with the participants scrubber and surfaces intent.
    for scene in data.get("scenes", []) or []:
        if isinstance(scene, dict):
            scene.pop("intra_relationships", None)

    knowledge_ids: set[str] = {
        e.get("id") for e in old_knowledge_entities if isinstance(e, dict) and e.get("id")
    }

    # Migration summary for load-response surfacing.
    summary = {
        "knowledges_migrated": 0,
        "attributes_dropped": 0,
        "aliases_dropped": 0,
        "scene_chips_dropped": 0,
        "entity_nodes_dropped": 0,
        # Phase 1.21c Step 16 — count of pre-1.21c knowledge-entity origin
        # nodes that successfully converted to KnowledgeOriginNodes,
        # preserving canvas geometry across the refactor.
        "origin_nodes_preserved": 0,
    }

    # Only run full migration when there's something to migrate. If no
    # knowledge-typed entities exist, leave everything else alone
    # (idempotency — already-migrated saves pass through).
    if old_knowledge_entities:
        # Build new top-level knowledges list. Preserve id/name/description/
        # colour/profile_image_ref/awareness. Drop the rest.
        new_knowledges_list = data.setdefault("knowledges", [])
        if not isinstance(new_knowledges_list, list):
            new_knowledges_list = []
            data["knowledges"] = new_knowledges_list

        # Avoid duplicates if the file somehow already has a knowledges
        # entry with a migrated id.
        existing_top_ids = {
            k.get("id") for k in new_knowledges_list if isinstance(k, dict)
        }

        for ent in old_knowledge_entities:
            if not isinstance(ent, dict):
                continue
            eid = ent.get("id")
            if not eid or eid in existing_top_ids:
                continue

            # Count dropped fields for summary
            if ent.get("attributes"):
                summary["attributes_dropped"] += len(ent["attributes"])
            if ent.get("aliases"):
                summary["aliases_dropped"] += len(ent["aliases"])

            new_knowledges_list.append({
                "id": eid,
                "name": ent.get("name", ""),
                "description": ent.get("description", ""),
                "colour": ent.get("colour", "#888888"),
                "profile_image_ref": ent.get("profile_image_ref"),
                "awareness": ent.get("awareness"),
                "source_event": None,
                "history": {
                    "name_changes": [],
                    "description_changes": [],
                    "colour_changes": [],
                },
            })
            summary["knowledges_migrated"] += 1

    # Strip knowledge-entity references from the rest of the model,
    # regardless of whether any migration happened (defensive cleanup).
    if knowledge_ids:
        # Relationships: history entries keyed on entity_id. (The
        # legacy `participants` field has already been popped above
        # for ALL relationships — independent of whether any
        # knowledges existed in the save.)
        for rel in data.get("relationships", []) or []:
            if not isinstance(rel, dict):
                continue
            hist = rel.get("history")
            if isinstance(hist, dict):
                for key, entries in list(hist.items()):
                    if not isinstance(entries, list):
                        continue
                    hist[key] = [
                        e for e in entries
                        if not (isinstance(e, dict) and e.get("entity_id") in knowledge_ids)
                    ]

        # Scene nodes: drop knowledges bucket; strip chip_order;
        # strip awareness_changes / attribute_changes referencing knowledges.
        for node in data.get("scenes", []) or []:
            if not isinstance(node, dict):
                continue
            if "knowledges" in node:
                kn = node.get("knowledges")
                if isinstance(kn, list):
                    summary["scene_chips_dropped"] += len(kn)
                node.pop("knowledges", None)
            co = node.get("chip_order")
            if isinstance(co, list):
                node["chip_order"] = [eid for eid in co if eid not in knowledge_ids]
            for bucket_key in ("characters", "locations", "items", "factions", "customs"):
                for ref in node.get(bucket_key, []) or []:
                    if not isinstance(ref, dict):
                        continue
                    aw_changes = ref.get("awareness_changes")
                    if isinstance(aw_changes, list):
                        ref["awareness_changes"] = [
                            c for c in aw_changes
                            if not (isinstance(c, dict) and c.get("entity_id") in knowledge_ids)
                        ]
                    attr_changes = ref.get("attribute_changes")
                    if isinstance(attr_changes, list):
                        ref["attribute_changes"] = [
                            c for c in attr_changes
                            if not (
                                isinstance(c, dict)
                                and c.get("list_item") in knowledge_ids
                                and c.get("action") in ("list_add", "list_remove", "awareness_set")
                            )
                        ]

        # Entity nodes (setup + modifier): drop ones pointing at former
        # knowledges, BUT preserve canvas geometry by converting setup-type
        # entity nodes (the originals; not modifiers) into the new
        # KnowledgeOriginNode shape at the same canvas position. One
        # KnowledgeOriginNode per Knowledge (the Step 14 invariant) — if a
        # knowledge ended up with multiple setup nodes pre-refactor (rare
        # / defensive), keep the first and drop the rest.
        en_list = data.get("entity_nodes")
        if isinstance(en_list, list):
            new_origin_nodes_list = data.setdefault("knowledge_origin_nodes", [])
            if not isinstance(new_origin_nodes_list, list):
                new_origin_nodes_list = []
                data["knowledge_origin_nodes"] = new_origin_nodes_list
            existing_origin_for_kid = {
                n.get("knowledge_id") for n in new_origin_nodes_list
                if isinstance(n, dict)
            }
            seen_kids: set[str] = set()
            keepers: list[dict] = []
            for n in en_list:
                if not isinstance(n, dict):
                    keepers.append(n)
                    continue
                eid = n.get("entity_id")
                if eid not in knowledge_ids:
                    keepers.append(n)
                    continue
                # This entityNode pointed at a former knowledge — drop it.
                # Convert ONLY setup-type (non-modifier) nodes; skip
                # modifiers and any second-or-later setup for the same
                # knowledge id.
                if n.get("is_modifier") is True:
                    continue
                if eid in seen_kids or eid in existing_origin_for_kid:
                    continue
                pos = n.get("position") or {}
                if not isinstance(pos, dict):
                    pos = {}
                origin_node: dict = {
                    "id": str(uuid.uuid4()),
                    "node_type": "knowledge_origin",
                    "knowledge_id": eid,
                    "position": {
                        "x": pos.get("x", 0),
                        "y": pos.get("y", 0),
                    },
                }
                if isinstance(n.get("width"), (int, float)):
                    origin_node["width"] = n["width"]
                if isinstance(n.get("height"), (int, float)):
                    origin_node["height"] = n["height"]
                new_origin_nodes_list.append(origin_node)
                seen_kids.add(eid)
                summary["origin_nodes_preserved"] += 1
            before = len(en_list)
            data["entity_nodes"] = keepers
            summary["entity_nodes_dropped"] += before - len(keepers)

        # Library layout: filter knowledges ordering to surviving ids.
        lib = data.get("library_layout")
        if isinstance(lib, dict) and isinstance(lib.get("knowledges"), list):
            surviving = {
                k.get("id") for k in data.get("knowledges", []) or []
                if isinstance(k, dict)
            }
            lib["knowledges"] = [
                eid for eid in lib["knowledges"] if eid in surviving
            ]

    # Log a summary to stderr for dev visibility. The frontend can pick
    # it up from the ephemeral `_migration_summary` key if we wire that
    # into the load response later; for now this is a developer-visible
    # signal that migration happened.
    if summary["knowledges_migrated"] > 0:
        print(
            f"[migration 1.21c] migrated {summary['knowledges_migrated']} knowledge-typed "
            f"entities to first-class Knowledge objects. "
            f"Preserved {summary['origin_nodes_preserved']} canvas origin "
            f"node(s) as KnowledgeOriginNodes. "
            f"Dropped {summary['attributes_dropped']} attributes, "
            f"{summary['aliases_dropped']} aliases, "
            f"{summary['scene_chips_dropped']} scene chips, "
            f"{summary['entity_nodes_dropped']} setup/modifier nodes.",
            file=sys.stderr,
            flush=True,
        )

    # Summary is logged to stderr above for dev visibility only —
    # NOT persisted on the data dict. `extra="allow"` would carry the
    # ephemeral key forward into every save indefinitely, which is the
    # exact "ghost extra" pattern the legacy-save-normalisation rule
    # forbids. If a future user-facing migration dialog ever needs
    # this, plumb it as an explicit return value through the load
    # handler rather than attaching to the saved shape.

    return data


def _migrate_knowledge_awareness_chain_hoist(data: dict) -> dict:
    """Hoist legacy `Knowledge.history.awareness_changes[]` entries into
    canonical `Knowledge.awareness.history[]` (`AwarenessHistoryEntry`),
    then strip the legacy list from the raw dict.

    Applies to saves stamped with `save_format_version` in the range
    [0.1.22.41, 0.2a.2.0). The pre-2a.2.0 model carried per-Knowledge
    awareness mutations on a `Knowledge.history.awareness_changes` list
    keyed by (`action`, `entity_id`, `level`, `awareness_scale`); this
    migration converts every such entry to the canonical
    `AwarenessHistoryEntry` shape used on every other awareness host
    (Entity / Attribute / Alias / Relationship) and lands it on
    `Knowledge.awareness.history` instead.

    Field map per legacy entry:
      legacy.id            -> canonical.id                 (preserved)
      legacy.node_id       -> canonical.node_id            (preserved)
      legacy.action='add'  -> canonical.tracking_action='on'
                              canonical.awareness_scale=legacy.awareness_scale
      legacy.action='remove' -> canonical.tracking_action='off'
                                (awareness_scale dropped per legacy semantics)
      legacy.action=None   -> canonical observer-set entry:
                              canonical.observer_id=legacy.entity_id
                              canonical.level=legacy.level
      legacy.source_event  -> canonical.source_event       (preserved)
      legacy.review_flag   -> canonical.review_flag        (preserved)

    Awareness baseline shape coercion: the canonical `Knowledge.awareness`
    is either null, a flat observer dict, or the wrapper
    `{entries?, sources?, history?}`. If the existing baseline is null
    or a flat dict, this migration coerces it to the wrapper form so
    the hoisted history has a home; baseline `entries` / `sources` are
    preserved. Idempotent: re-running on an already-migrated dict is a
    no-op because the legacy list will already be absent.
    """
    knowledges = data.get("knowledges")
    if not isinstance(knowledges, list):
        return data

    hoisted_total = 0
    for k in knowledges:
        if not isinstance(k, dict):
            continue
        history = k.get("history")
        if not isinstance(history, dict):
            continue
        legacy = history.get("awareness_changes")
        if not isinstance(legacy, list) or not legacy:
            # Strip an empty legacy list so it does not ride forward as
            # foreign content under `extra="allow"` semantics.
            if "awareness_changes" in history:
                history.pop("awareness_changes", None)
            continue

        # Convert each legacy entry to a canonical AwarenessHistoryEntry.
        hoisted: list[dict] = []
        for entry in legacy:
            if not isinstance(entry, dict):
                continue
            action = entry.get("action")
            base = {
                "id": entry.get("id") or str(uuid.uuid4()),
                "node_id": entry.get("node_id", ""),
                "observer_id": "",
                "level": None,
                "source_action": None,
                "source": None,
                "tracking_action": None,
                "awareness_scale": None,
                "source_event": entry.get("source_event"),
                "review_flag": entry.get("review_flag"),
            }
            if action == "add":
                base["tracking_action"] = "on"
                base["awareness_scale"] = entry.get("awareness_scale")
            elif action == "remove":
                base["tracking_action"] = "off"
            else:
                # Per-observer set (or strip when level is null).
                base["observer_id"] = entry.get("entity_id", "") or ""
                base["level"] = entry.get("level")
            hoisted.append(base)

        # Coerce baseline awareness to the wrapper form so the hoisted
        # history has a home. Three input shapes per the model docs:
        #   null              -> wrap as {history: hoisted}
        #   flat dict         -> wrap as {entries: <dict>, history: hoisted}
        #   wrapper dict      -> merge: existing.history + hoisted (preserve
        #                       entries / sources untouched)
        existing = k.get("awareness")
        if existing is None:
            k["awareness"] = {"history": hoisted}
        elif isinstance(existing, dict):
            # Treat as wrapper when any wrapper key is present; otherwise
            # treat as a flat observer dict.
            wrapper_keys = {"entries", "sources", "history"}
            if any(key in existing for key in wrapper_keys):
                merged_history = list(existing.get("history") or []) + hoisted
                existing["history"] = merged_history
                k["awareness"] = existing
            else:
                # Flat observer dict — coerce to wrapper preserving the
                # observer entries as the baseline.
                k["awareness"] = {"entries": existing, "history": hoisted}
        else:
            # Unrecognised baseline shape (e.g. legacy AwarenessRef
            # placeholder). Leave the baseline untouched; the canonical
            # walker handles AwarenessRef separately. Drop hoisted on
            # the floor only if there's literally nowhere safe to land
            # them — but since AwarenessRef baselines preclude history,
            # this is the documented loss-of-history path. Log via
            # _migration_summary so the loader can surface it.
            summary = data.setdefault("_migration_summary", {})
            summary.setdefault("knowledge_awareness_ref_blocked_history", 0)
            summary["knowledge_awareness_ref_blocked_history"] += len(hoisted)
            history.pop("awareness_changes", None)
            continue

        # Strip the legacy list so the new shape is canonical-only on
        # the next save.
        history.pop("awareness_changes", None)
        hoisted_total += len(hoisted)

    if hoisted_total > 0:
        summary = data.setdefault("_migration_summary", {})
        summary["knowledge_awareness_entries_hoisted"] = hoisted_total

    return data


def _migrate_awareness_changes_hoist(data: dict) -> dict:
    """Hoist legacy `EntityRef.awareness_changes[]` entries and legacy
    per-attribute `attribute_changes` entries with
    `action='awareness_set'/'awareness_source_*'` into the canonical
    `host.awareness.history[]` (`AwarenessHistoryEntry`) shape on the
    appropriate host (Entity / Entity.name_awareness / Alias /
    Relationship / Attribute). Strips the legacy entries from the raw
    dict.

    Applies to saves stamped with `save_format_version` in the range
    [0.2a.2.0, 0.2a.2.5). The pre-2a.2.5 model carried awareness
    mutations on each SceneNode's entity-bucket EntityRef:
      - `EntityRef.awareness_changes[]` for entity / entity_name /
        relationship / alias targets, and
      - `EntityRef.attribute_changes[]` (with `action='awareness_set'`
        or `action='awareness_source_*'`) for per-attribute awareness.
    The chain-anchor (`node_id`) came from the carrier SceneNode; the
    chip (`EntityRef.entity_id`) provided the host entity for
    entity / entity_name / alias / per-attribute targets; the
    `relationship_id` field provided the host for relationship target.

    Field map per `AwarenessChange` entry (EntityRef.awareness_changes):
      legacy.id              -> canonical.id                  (preserved)
      carrier scene id       -> canonical.node_id
      legacy.target          -> routes entry to host's awareness wrapper:
                                  'entity'       -> Entity.awareness.history
                                  'entity_name'  -> Entity.name_awareness.history
                                  'relationship' -> Relationship.awareness.history
                                  'alias'        -> Entity.aliases[i].awareness.history
                                                   (matched by alias_value)
      legacy.entity_id       -> canonical.observer_id         (RENAME)
      legacy.level           -> canonical.level               (preserved)
      legacy.source_action   -> canonical.source_action       (preserved)
      legacy.source          -> canonical.source              (preserved)
      legacy.knowledge_id    -> canonical.knowledge_id        (preserved
                                  forward pointer — matches the canonical
                                  forward-pointer pattern on every other
                                  change-record class). ALSO triggers
                                  construction of canonical.source_event
                                  (SourceEventRef with event_type='awareness_change',
                                  change_id=legacy.id, node_id=carrier scene)
                                  for back-pointer cleanup parity.

    Field map per `AttributeChange` entry with awareness action:
      legacy.id                          -> canonical.id      (preserved)
      carrier scene id                   -> canonical.node_id
      legacy.attribute_id                -> routes to attribute on chip entity
      action='awareness_set'             -> observer-set entry; observer_id
                                            = legacy.list_item;
                                            level = legacy.level (or parsed
                                            legacy.new_value as int fallback
                                            for pre-1.21h shape)
      action='awareness_source_add'      -> source_action='add'
      action='awareness_source_remove'   -> source_action='remove'
      action='awareness_source_set_level'-> source_action='set_level'
      legacy.source                      -> canonical.source
      legacy.knowledge_id                -> canonical.source_event (constructed)

    Routing failures (missing host entity / relationship / alias /
    attribute) drop the entry into the migration summary's
    `awareness_hoist_dropped` counter rather than the canonical history;
    no save data is silently lost.

    Idempotent: re-running on an already-migrated dict is a no-op
    because the legacy lists will already be absent.
    """
    # Build lookups against the raw dict
    entities_root = data.get('entities') or {}
    entity_lookup: dict[str, dict] = {}
    if isinstance(entities_root, dict):
        for bucket_key in ('characters', 'locations', 'items', 'factions', 'customs'):
            bucket = entities_root.get(bucket_key)
            if not isinstance(bucket, list):
                continue
            for ent in bucket:
                if isinstance(ent, dict) and ent.get('id'):
                    entity_lookup[ent['id']] = ent

    rel_lookup: dict[str, dict] = {}
    for rel in (data.get('relationships') or []):
        if isinstance(rel, dict) and rel.get('id'):
            rel_lookup[rel['id']] = rel

    def ensure_wrapper(host: dict, field_name: str) -> dict:
        """Ensure host[field_name] is a wrapper-shape awareness with a
        history list, preserving any baseline entries / sources."""
        aware = host.get(field_name)
        if aware is None:
            wrapper = {'history': []}
        elif isinstance(aware, dict):
            if 'entries' in aware or 'sources' in aware or 'history' in aware:
                wrapper = dict(aware)
                if not isinstance(wrapper.get('history'), list):
                    wrapper['history'] = []
            elif 'relationship_id' in aware and 'level' in aware:
                # Legacy AwarenessRef baseline — preserve as a single source
                wrapper = {
                    'sources': [{
                        'kind': 'relationship',
                        'relationship_id': aware['relationship_id'],
                        'level': aware['level'],
                    }],
                    'history': [],
                }
            else:
                # Flat-dict baseline — promote to wrapper.entries
                wrapper = {'entries': dict(aware), 'history': []}
        else:
            wrapper = {'history': []}
        host[field_name] = wrapper
        return wrapper

    def convert_awareness_change(legacy: dict, node_id: str) -> dict:
        entry = {
            'id': legacy.get('id') or str(uuid.uuid4()),
            'node_id': node_id,
            'observer_id': legacy.get('entity_id') or '',
            'level': legacy.get('level'),
            'source_action': legacy.get('source_action'),
            'source': legacy.get('source'),
            'tracking_action': None,
            'awareness_scale': None,
            'source_event': None,
            'review_flag': None,
            'knowledge_id': legacy.get('knowledge_id'),
        }
        kid = legacy.get('knowledge_id')
        if kid:
            entry['source_event'] = {
                'event_type': 'awareness_change',
                'change_id': legacy.get('id') or '',
                'node_id': node_id,
            }
        return entry

    def convert_attr_awareness(legacy: dict, node_id: str) -> dict | None:
        action = legacy.get('action')
        if action == 'awareness_set':
            observer_id = legacy.get('list_item') or ''
            level = legacy.get('level')
            if level is None and legacy.get('new_value') is not None:
                try:
                    level = int(legacy.get('new_value'))
                except (ValueError, TypeError):
                    level = None
            entry = {
                'id': legacy.get('id') or str(uuid.uuid4()),
                'node_id': node_id,
                'observer_id': observer_id,
                'level': level,
                'source_action': None,
                'source': None,
                'tracking_action': None,
                'awareness_scale': None,
                'source_event': None,
                'review_flag': None,
                'knowledge_id': legacy.get('knowledge_id'),
            }
        elif action in ('awareness_source_add', 'awareness_source_remove', 'awareness_source_set_level'):
            source_action_map = {
                'awareness_source_add': 'add',
                'awareness_source_remove': 'remove',
                'awareness_source_set_level': 'set_level',
            }
            entry = {
                'id': legacy.get('id') or str(uuid.uuid4()),
                'node_id': node_id,
                'observer_id': '',
                'level': None,
                'source_action': source_action_map[action],
                'source': legacy.get('source'),
                'tracking_action': None,
                'awareness_scale': None,
                'source_event': None,
                'review_flag': None,
                'knowledge_id': legacy.get('knowledge_id'),
            }
        else:
            return None
        kid = legacy.get('knowledge_id')
        if kid:
            entry['source_event'] = {
                'event_type': 'awareness_change',
                'change_id': legacy.get('id') or '',
                'node_id': node_id,
            }
        return entry

    hoisted_total = 0
    dropped_total = 0

    scenes = data.get('scenes') or []
    if not isinstance(scenes, list):
        scenes = []
    for scene in scenes:
        if not isinstance(scene, dict):
            continue
        node_id = scene.get('id')
        if not node_id:
            continue
        for bucket_key in ('characters', 'locations', 'items', 'factions', 'customs'):
            refs = scene.get(bucket_key)
            if not isinstance(refs, list):
                continue
            for ref in refs:
                if not isinstance(ref, dict):
                    continue
                ref_entity_id = ref.get('entity_id')
                # Hoist EntityRef.awareness_changes[]
                aw_changes = ref.get('awareness_changes')
                if isinstance(aw_changes, list) and aw_changes:
                    for legacy in aw_changes:
                        if not isinstance(legacy, dict):
                            dropped_total += 1
                            continue
                        target = legacy.get('target')
                        host = None
                        host_field = None
                        if target == 'entity':
                            host = entity_lookup.get(ref_entity_id) if ref_entity_id else None
                            host_field = 'awareness'
                        elif target == 'entity_name':
                            host = entity_lookup.get(ref_entity_id) if ref_entity_id else None
                            host_field = 'name_awareness'
                        elif target == 'relationship':
                            rel_id = legacy.get('relationship_id')
                            host = rel_lookup.get(rel_id) if rel_id else None
                            host_field = 'awareness'
                        elif target == 'alias':
                            alias_value = legacy.get('alias_value')
                            host_entity = entity_lookup.get(ref_entity_id) if ref_entity_id else None
                            if host_entity and alias_value:
                                aliases = host_entity.get('aliases') or []
                                for alias in aliases:
                                    if isinstance(alias, dict) and alias.get('value') == alias_value:
                                        host = alias
                                        host_field = 'awareness'
                                        break
                        if not host or not host_field:
                            dropped_total += 1
                            continue
                        wrapper = ensure_wrapper(host, host_field)
                        wrapper['history'].append(convert_awareness_change(legacy, node_id))
                        hoisted_total += 1
                    ref.pop('awareness_changes', None)

                # Hoist per-attribute awareness from attribute_changes
                attr_changes = ref.get('attribute_changes')
                if isinstance(attr_changes, list) and attr_changes:
                    surviving = []
                    for legacy in attr_changes:
                        if not isinstance(legacy, dict):
                            surviving.append(legacy)
                            continue
                        action = legacy.get('action')
                        if action not in (
                            'awareness_set',
                            'awareness_source_add',
                            'awareness_source_remove',
                            'awareness_source_set_level',
                        ):
                            surviving.append(legacy)
                            continue
                        attr_id = legacy.get('attribute_id')
                        host_entity = entity_lookup.get(ref_entity_id) if ref_entity_id else None
                        target_attr = None
                        if host_entity and attr_id:
                            for attr in (host_entity.get('attributes') or []):
                                if isinstance(attr, dict) and attr.get('id') == attr_id:
                                    target_attr = attr
                                    break
                        if not target_attr:
                            dropped_total += 1
                            continue
                        converted = convert_attr_awareness(legacy, node_id)
                        if converted is None:
                            dropped_total += 1
                            continue
                        wrapper = ensure_wrapper(target_attr, 'awareness')
                        wrapper['history'].append(converted)
                        hoisted_total += 1
                    if len(surviving) != len(attr_changes):
                        ref['attribute_changes'] = surviving

    if hoisted_total > 0 or dropped_total > 0:
        summary = data.setdefault('_migration_summary', {})
        if hoisted_total > 0:
            summary['awareness_hoist_entries'] = hoisted_total
        if dropped_total > 0:
            summary['awareness_hoist_dropped'] = dropped_total

    return data


def _migrate_awareness_full_hoist(data: dict) -> dict:
    """Combined awareness-hoist migration that brings a v0.1.22.41 save
    straight to the post-hoist data shape that ships on master at
    v0.2.1.6.

    Sequentially applies the two underlying hoist helpers:

      1. `_migrate_knowledge_awareness_chain_hoist` — converts legacy
         `Knowledge.history.awareness_changes[]` entries to canonical
         `AwarenessHistoryEntry` shape on `Knowledge.awareness.history`
         and strips the legacy list.
      2. `_migrate_awareness_changes_hoist` — converts legacy entity /
         entity_name / alias / relationship awareness mutations
         carried on each SceneNode's entity-bucket
         `EntityRef.awareness_changes[]`, plus per-attribute
         awareness mutations carried as `EntityRef.attribute_changes[]`
         entries with `action='awareness_set' / 'awareness_source_*'`,
         to canonical `AwarenessHistoryEntry` shape on the appropriate
         host's `awareness.history`. Preserves id / node_id /
         observer_id / level / source_action / source / knowledge_id
         per the field-by-field migration spec.

    The two hoists shipped together in the master squash-merge that
    landed on v0.2.1.6; the migration chain treats them as a single
    forward step from the prior master floor (`0.1.22.41`) to the
    post-squash master version. Files that ever sat at an intermediate
    state (e.g. partial-hoist saves from retired off-master branch
    builds) are handled via the migration walker's "newer-than-target"
    passthrough — see `_is_branch_flavour_version` + the loop comment
    in `_migrate_story_dict`.
    """
    data = _migrate_knowledge_awareness_chain_hoist(data)
    data = _migrate_awareness_changes_hoist(data)
    return data


def _migrate_aliases_to_chain_events(data: dict) -> dict:
    """2026-05-17 — convert full-list `aliases_change` snapshots into
    per-alias chain events on `alias_changes`.

    Why: the old `EntityRef.aliases_change: Optional[list[Alias]]` field
    stored the entity's FULL intended alias list at each scene. The
    walker applied it via overwrite (`state.aliases = aliases_change`),
    which discarded every upstream addition when a later edit landed at
    a downstream scene. The new per-alias-event model fixes that — each
    event adds or removes a specific alias additively.

    Migration policy (additive):
      - For every `aliases_change` snapshot we encounter, emit one
        `add` event per item in the snapshot. Synthetic event ids are
        fresh UUIDs; each event's payload Alias gets a fresh UUID id
        too (or reuses the snapshot's id if one was somehow present).
      - We do NOT compute the chain-running state to emit `remove`
        events for upstream items missing from the snapshot. That
        would lock in the OLD walker's overwrite semantics in the
        migrated data, defeating the point of the fix. The trade-off:
        a writer who used the old UI to intentionally REMOVE an alias
        at a downstream scene (by editing the snapshot to exclude it)
        won't get a synthetic remove event. Their removal is lost in
        the migration; they can re-apply it with the new UI. This is
        rare in practice — most writers ADDED aliases at scenes; the
        bug fix matters for the additive case.
      - Baseline `entity.aliases` items get UUIDs assigned at the same
        time so per-alias future events can target them.
      - The old `aliases_change` field is cleared after conversion so
        the walker's transitional fallback never fires on migrated
        data.

    Save-format-compat: this migration is the v0.2.1.6 → v0.2.1.76 step
    in the MIGRATIONS chain. Saves written by v0.2.1.6 through
    v0.2.1.75 all carry `aliases_change` snapshots; the chain walks
    each forward to the new shape on load. Pre-v0.2.1.6 saves walk
    through the prior migrations first, then arrive here in the
    v0.2.1.6 shape and get the same treatment.

    Reader-floor: bumping `MIN_READER_EPOCHS["load"]` to v0.2.1.76 so
    pre-fix builds refuse to load post-fix saves (they would silently
    drop the new `alias_changes` field via `extra='ignore'` and lose
    every scene-anchored alias change).
    """
    def _assign_alias_ids(aliases):
        """Walk a list of Alias dicts; assign a fresh UUID to any item
        missing an `id`. Mutates in place; idempotent."""
        if not isinstance(aliases, list):
            return
        for alias in aliases:
            if isinstance(alias, dict) and not alias.get('id'):
                alias['id'] = str(uuid.uuid4())

    def _convert_snapshot(node_dict):
        """If `node_dict` has a non-null `aliases_change` snapshot,
        convert it to a sequence of `add` events on `alias_changes`
        and clear the old field. Mutates in place."""
        snapshot = node_dict.get('aliases_change')
        if not snapshot:
            return
        events = []
        for snap_alias in snapshot:
            if not isinstance(snap_alias, dict):
                continue
            alias_id = snap_alias.get('id') or str(uuid.uuid4())
            events.append({
                'id': str(uuid.uuid4()),
                'action': 'add',
                'alias': {
                    'id': alias_id,
                    'value': snap_alias.get('value', ''),
                    'awareness': snap_alias.get('awareness'),
                },
            })
        existing_events = node_dict.get('alias_changes') or []
        node_dict['alias_changes'] = existing_events + events
        node_dict['aliases_change'] = None

    # 1. Assign UUIDs to baseline aliases on every entity in every type bucket.
    entities = data.get('entities') or {}
    for bucket_name in ('characters', 'locations', 'items', 'factions', 'customs'):
        for entity in (entities.get(bucket_name) or []):
            if isinstance(entity, dict):
                _assign_alias_ids(entity.get('aliases'))

    # 2. Convert per-EntityRef snapshots inside every scene's per-type buckets.
    for scene in (data.get('scenes') or []):
        if not isinstance(scene, dict):
            continue
        for bucket_name in ('characters', 'locations', 'items', 'factions', 'customs'):
            for ref in (scene.get(bucket_name) or []):
                if isinstance(ref, dict):
                    _convert_snapshot(ref)

    # 3. Convert modifier-EntityNode snapshots (canvas modifier nodes
    #    carry their own `aliases_change` per the same shape as
    #    EntityRef). Origin EntityNodes have `is_modifier: false`; only
    #    modifier nodes ever carry an aliases_change snapshot.
    for entity_node in (data.get('entity_nodes') or []):
        if isinstance(entity_node, dict):
            _convert_snapshot(entity_node)

    return data


def _migrate_phase_1_22_no_op(data: dict) -> dict:
    """Phase 1.22 series — no-op migration covering the range from
    0.1.21.15 (last schema-level migration target) up through the
    current MIN_READER_EPOCHS floor.

    Every Phase 1.22 schema change to date is purely additive (new
    optional fields with Pydantic defaults: circumstance / motivator
    attribute types, scene-side `Scene.circumstances`, scene-side
    `Scene.entity_temporary_circumstances`, etc.). Pre-1.22 payloads
    parse cleanly through the current models because each new field
    has a default — no data transformation needed. This migration
    entry exists so the version walker has a forward path that
    stamps the file's `save_format_version` up to the current
    target without ever raising "no migration path".

    If a future Phase 1.22 change is NOT additive (e.g. a field
    rename or shape change that pre-1.22 payloads can't satisfy via
    defaults), split this entry — add a real migration covering
    the breaking version range and shrink this no-op's target down
    to that breaking point.
    """
    return data


def _migrate_phase_2_13_no_op(data: dict) -> dict:
    """Phase 2.13 — no-op migration covering the range from 0.2.1.76
    (last schema-level migration target) up through the current
    MIN_READER_EPOCHS["load"] floor of 0.2.13.0.

    The only schema change shipped in this range so far is Phase 2.13's
    Perspective attribute type:
      - `'perspective'` added to the `Attribute.attribute_type` Literal.
      - Two new Optional fields on `Attribute`:
        `perspective_target_kind` and `perspective_target_id`. Both
        default to `None`.

    Every pre-2.13 payload parses cleanly through the current models
    because the new fields have Optional defaults and no existing field
    changed shape or meaning. The new Literal value is the reason
    MIN_READER_EPOCHS["load"] was bumped (pre-2.13 readers reject
    'perspective' via the Literal validator), but that gate runs BEFORE
    the migration chain in `_check_min_reader_version`; the walker
    itself sees a perfectly clean additive change.

    This entry exists purely so the version walker has a forward path
    that stamps the file's `save_format_version` from any pre-2.13
    value up to 0.2.13.0 without raising "no migration path". It also
    catches anything saved by intermediate Phase 2.x builds between
    0.2.1.76 and 0.2.13.0 (Phase 2.2 .. 2.12), all of which were
    additive-only relative to the schema floor at 0.2.1.76 and so
    require no transformation.

    If a FUTURE change in this range turns out non-additive (a field
    rename, a moved shape, a Literal narrowing), split this entry the
    same way `_migrate_phase_1_22_no_op` is meant to be split — add a
    real migration covering the breaking version range and shrink this
    no-op's target down to that breaking point.
    """
    return data


def _normalise_scenetime_baselines_pre_fix(data: dict) -> dict:
    """v0.2.1.149 — POV-chain time walker fix: date pins no longer
    trigger snap-forward when the chain has no upstream date anchor.

    Pre-this-version walkers treated a downstream `(date_month,
    date_day_of_month)` pin as a snap-forward target even when no
    earlier scene had pinned a date — defaulting `chainOriginDayOfYear`
    to 0 (Jan 1) and computing huge jumps to reach e.g. Oct 17 from
    chain-day 0. Downstream scenes then inherited the jumped floor
    and their weekday pins snapped further forward.

    The walker is now correct (`hasUpstreamDateAnchor` gates date snap
    in `walkOneStep`; the first downstream date pin retroactively
    anchors `chainOriginDayOfYear`), but persisted scene baselines
    (`last_known_floor_minutes`, `last_known_effective_minutes`,
    `last_known_gap`, plus the `time_since_last_scene` review entry
    on `review_fields`) still reflect the old (wrong) calculations on
    pre-fix saves. Loading without clearing them would cause alerts
    to fire on every affected scene on next save — the §3.4.2
    cascade rule then unrolls one alert per save, requiring many
    manual dismisses for no useful writer feedback.

    The normalizer silently clears those four fields on every scene
    of any save written by a pre-fix build (`save_format_version`
    strictly less than `0.2.1.149`). The walker re-seeds them with
    the corrected values via `_commitScenetimeWrites` on the next
    save (cls === 'none' path). Genuine pending alerts the writer
    hadn't actioned are also cleared — acceptable trade-off since
    most such alerts were themselves likely artefacts of the bug;
    the next genuine chain edit will re-surface any real alerts.

    Lives outside the MIGRATIONS chain because `_migration_target()`
    only walks up to `MIN_READER_EPOCHS["load"]` (currently 0.2.1.76)
    — a chain entry past that target wouldn't fire on files already
    stamped beyond the floor. Schema is unchanged so the load floor
    doesn't need bumping; the cleanup runs unconditionally on every
    load, version-gated internally so post-fix saves are untouched.
    Matches the shape of `_normalise_scene_terminology` and
    `_normalise_faction_self_join_strip`.
    """
    raw_ver = data.get("save_format_version")
    if not isinstance(raw_ver, str):
        return data
    try:
        if _parse_version(raw_ver) >= _parse_version("0.2.1.149"):
            return data
    except ValueError:
        return data
    scenes = data.get("scenes")
    if not isinstance(scenes, list):
        return data
    for scene in scenes:
        if not isinstance(scene, dict):
            continue
        for key in (
            "last_known_floor_minutes",
            "last_known_effective_minutes",
            "last_known_gap",
        ):
            if key in scene:
                scene[key] = None
        review = scene.get("review_fields")
        if isinstance(review, list):
            scene["review_fields"] = [
                f for f in review
                if not (
                    isinstance(f, dict)
                    and f.get("field") == "time_since_last_scene"
                )
            ]
    return data


MIGRATIONS: dict[str, tuple[str, Callable[[dict], dict]]] = {
    # Phase 1.21c Knowledge Refactor (v0.1.21.15). Key is the lower end
    # of the source-version range; the walker treats each MIGRATIONS
    # entry with source K and target T as applicable to any
    # save_format_version in [K, T). So one entry covers the whole
    # 0.1.18.0 .. 0.1.21.14 range without needing per-version no-op
    # entries.
    "0.1.18.0": ("0.1.21.15", _migrate_knowledge_refactor),
    # Phase 1.22 series no-op (covers the whole 0.1.21.15 .. 0.1.22.41
    # range). All Phase 1.22 schema changes are additive with field
    # defaults; no data transformation needed. See the helper
    # docstring for details and split-instructions when a future
    # 1.22 change becomes non-additive.
    "0.1.21.15": ("0.1.22.41", _migrate_phase_1_22_no_op),
    # v0.2.1.6 — Combined awareness-history hoist. Pre-this-version
    # saves carried chain-time awareness mutations in two legacy
    # locations:
    #   (1) Knowledge.history.awareness_changes[] (per-Knowledge),
    #   (2) Per-EntityRef inside each SceneNode bucket — both
    #       EntityRef.awareness_changes[] (entity / entity_name /
    #       alias / relationship mutations) AND EntityRef.attribute_
    #       changes[] entries with action='awareness_set' /
    #       'awareness_source_*' (per-attribute mutations).
    # This migration routes every legacy entry to the canonical
    # AwarenessHistoryEntry shape on the appropriate host's
    # awareness.history (Entity / Entity.name_awareness / Alias /
    # Relationship / Attribute / Knowledge) and strips the legacy
    # carriers. Preserves id / node_id / observer_id / level /
    # source_action / source / knowledge_id per the field-by-field
    # migration spec. See `_migrate_awareness_full_hoist` for the two
    # underlying helpers it composes.
    "0.1.22.41": ("0.2.1.6", _migrate_awareness_full_hoist),
    # v0.2.1.76 — Aliases chain-event refactor. Pre-this-version saves
    # carried per-scene alias edits as full-list snapshots in
    # `EntityRef.aliases_change: Optional[list[Alias]]` (and the same
    # field on modifier `EntityNode`). The walker applied them via
    # overwrite, which discarded every upstream addition when a later
    # edit landed at a downstream scene. This migration converts each
    # snapshot to a sequence of `add` events on the new
    # `alias_changes: list[AliasChange]` field (mirroring how
    # `attribute_changes[]` works), and clears the old field. Baseline
    # `entity.aliases` items also get UUID `id` assignment for future
    # per-alias chain-event targeting. See the function docstring for
    # the additive-only migration policy and its trade-off.
    "0.2.1.6": ("0.2.1.76", _migrate_aliases_to_chain_events),
    # Phase 2.13 series no-op (covers 0.2.1.76 .. 0.2.13.0). Every
    # schema change in this range is additive — the new
    # `'perspective'` Literal value on `Attribute.attribute_type`
    # plus the two Optional `perspective_target_*` fields. See
    # `_migrate_phase_2_13_no_op` for the rationale and the
    # split-instructions if a future change in this range turns
    # out non-additive. Bridges every Phase 2.x save (2.2 through
    # 2.12.13 and beyond) forward to 0.2.13.0 so the walker has a
    # path; without this entry, every pre-2.13 save throws
    # "no migration path from save_format_version 'X' to current
    # target '0.2.13.0'".
    "0.2.1.76": ("0.2.13.0", _migrate_phase_2_13_no_op),
}


def _migration_target() -> str:
    """The version the migration chain walks forward to — the highest
    value among `MIN_READER_EPOCHS`. Callers that only care about one
    capability still walk to this target because migrations themselves
    are capability-agnostic — a single migration fn brings the dict
    shape up to a specific PROGRAM_VERSION regardless of which readers
    care about which parts of the result.
    """
    candidates = list(MIN_READER_EPOCHS.values())
    return max(candidates, key=_parse_version)


def _migrate_story_dict(data: dict) -> dict:
    """Upgrade a loaded story dict forward through the MIGRATIONS chain.

    Reads `save_format_version` from the dict and walks the MIGRATIONS
    chain until the dict reaches the current `_migration_target()`. If
    the file is already at or beyond that target (e.g. written by a
    newer program but allowed through because the per-capability compat
    checks passed), it is left untouched — foreign fields come through
    intact thanks to `extra='allow'` on every model, and field defaults
    fill in anything the newer writer doesn't emit.

    Raises CorruptSaveError on malformed / missing version strings or
    when the chain has no forward path from the file's version.
    Pre-tracker / pre-cliff files are caught earlier by
    `_check_pre_cliff` and never reach this function.
    """
    # Pre-migration terminology normalisation. Legacy files use
    # `plot_point_nodes` / `node_type: "plot_point"` and would fail
    # Pydantic validation otherwise. Permanent load-side shim — see
    # `_normalise_scene_terminology` for the rationale.
    data = _normalise_scene_terminology(data)

    # Permanent load-side correction: factions never join their own
    # membership relationship. Auto-strip any pre-existing self-join
    # `participant_changes` entries from any save that has them. See
    # `_normalise_faction_self_join_strip` for the rationale.
    data = _normalise_faction_self_join_strip(data)

    # One-time scenetime baseline cleanup for pre-fix saves (any
    # save_format_version < 0.2.1.149). The POV-chain time walker
    # changed shape at v0.2.1.149 and persisted baselines from the
    # buggy walker would cause spurious alert cascades on next save.
    # The normalizer is version-gated internally — post-fix saves
    # are untouched. See `_normalise_scenetime_baselines_pre_fix`
    # for the rationale; lives outside the MIGRATIONS chain because
    # `_migration_target()` doesn't advance past `MIN_READER_EPOCHS
    # ["load"]` and we don't want to bump the load floor over what
    # is fundamentally a data-cleanup transition.
    data = _normalise_scenetime_baselines_pre_fix(data)

    raw = data.get("save_format_version")
    if raw is None:
        # Defensive: pre-tracker files (no save_format_version field)
        # are pre-cliff and are rejected by `_check_pre_cliff` before
        # this runs. If somehow one reaches here, surface as corrupt.
        raise CorruptSaveError(
            "missing save_format_version (pre-cliff file should have been rejected)"
        )
    if not isinstance(raw, str):
        raise CorruptSaveError(
            f"save_format_version must be a string, got {type(raw).__name__}"
        )
    try:
        _parse_version(raw)
    except ValueError as exc:
        raise CorruptSaveError(f"malformed save_format_version: {exc}") from exc
    current = raw

    target = _parse_version(_migration_target())

    # Walk forward through the version chain. Stop when we've reached
    # the target or overtaken it (file is newer; foreign fields round-
    # trip via extra='allow' and the per-capability compat checks have
    # already verified the file is safe for the current operation).
    #
    # Each MIGRATIONS entry with source K and target T is treated as
    # applicable to any save_format_version in the half-open range
    # [K, T). Multiple consecutive intermediate versions (one per
    # non-breaking release) that share the same schema shape are
    # therefore covered by a single migration entry — no per-version
    # pass-through entries required. Of the eligible entries we pick
    # the one whose source K is highest (i.e. the most recent breaking
    # point that applies), keeping each step monotonically forward.
    steps = 0
    while _parse_version(current) < target:
        cur_parsed = _parse_version(current)
        applicable: tuple[str, str, Callable[[dict], dict]] | None = None
        for key, (next_ver, fn) in MIGRATIONS.items():
            key_parsed = _parse_version(key)
            next_parsed = _parse_version(next_ver)
            # Migration covers current if its source ≤ current < its target.
            if key_parsed <= cur_parsed < next_parsed:
                # Prefer the entry with the highest source (the most
                # specific applicable migration).
                if applicable is None or key_parsed > _parse_version(applicable[0]):
                    applicable = (key, next_ver, fn)
        if applicable is None:
            raise CorruptSaveError(
                f"no migration path from save_format_version {current!r} "
                f"to current target {_migration_target()!r}"
            )
        _, next_version, fn = applicable
        data = fn(data)
        data["save_format_version"] = next_version
        current = next_version
        steps += 1
        if steps > 64:
            raise CorruptSaveError("migration chain exceeded 64 steps — aborting")

    return data


def _check_min_reader_version(data: dict, capability: str) -> None:
    """Reject a save file whose declared floor for the given capability
    is greater than this program's `PROGRAM_VERSION`. Called before
    migrations run so that a file intended for a newer reader is
    rejected cleanly instead of being partially upgraded into a broken
    state.

    `capability` is one of the keys in `MIN_READER_EPOCHS` — currently
    "load" or "import". Each reader path calls this with its own
    capability name. Missing / legacy files pass silently (legacy
    migration covers them); unknown per-capability floors default to
    passing so a newer writer that added a new capability key doesn't
    accidentally lock out older readers that never cared about it.
    """
    if capability not in MIN_READER_EPOCHS:
        raise ValueError(
            f"unknown reader capability {capability!r}; "
            f"expected one of {sorted(MIN_READER_EPOCHS)}"
        )

    floors = data.get("min_reader_versions")
    if floors is None:
        # Pre-tracker file — no floor declared; legacy migration covers it.
        return
    if not isinstance(floors, dict):
        raise CorruptSaveError(
            f"min_reader_versions must be a dict, got {type(floors).__name__}"
        )

    raw = floors.get(capability)
    if raw is None:
        # The file doesn't declare a floor for this capability. Two
        # reasons this can happen:
        #   (1) file was written before this capability existed as a
        #       concept → treat as legacy for this capability, pass.
        #   (2) writer omitted it to signal "no specific floor" → pass.
        # Either way, we let the load / import proceed; migrations and
        # field defaults handle everything else.
        return
    if not isinstance(raw, str):
        raise CorruptSaveError(
            f"min_reader_versions[{capability!r}] must be a string, "
            f"got {type(raw).__name__}"
        )

    # Branch-flavour version strings (any component carrying an
    # alphabetic suffix, e.g. a third component like `2a`) belong to
    # retired off-master branches. By definition they do not exist on
    # master and their numeric components don't map cleanly onto the
    # master-branch version line, so comparing them against the
    # running PROGRAM_VERSION (always master-flavoured) is meaningless
    # — `_parse_version`'s suffix-strip would either match the wrong
    # master version or numerically over-shoot. Treat any
    # flavour-tagged floor as "no floor declared" and let the load
    # proceed; the migration chain handles whatever data shape
    # the file actually contains.
    if _is_branch_flavour_version(raw):
        return

    try:
        required = _parse_version(raw)
    except ValueError as exc:
        raise CorruptSaveError(
            f"malformed min_reader_versions[{capability!r}]: {exc}"
        ) from exc

    program = _parse_version(PROGRAM_VERSION)
    if required > program:
        raise IncompatibleSaveError(
            capability=capability,
            file_version=data.get("save_format_version", "unknown"),
            min_required=raw,
        )


def _check_pre_cliff(data: dict, capability: str) -> None:
    """Reject any file saved before the v0.1.18 relationship-refactor cliff.

    Pre-cliff files used a binary pair-relationship model that is
    structurally incompatible with the N-party relationship model
    introduced in v0.1.18. No migration was written for this change.
    Files from pre-1.18 builds must be recreated.

    This check runs BEFORE migrations so that pre-cliff files never reach
    the migration chain. Both load and import paths call it.
    """
    raw = data.get("save_format_version")

    # Pre-tracker files (no version field or the legacy sentinel) are
    # always pre-cliff.
    if raw is None or raw == _LEGACY:
        raise IncompatibleSaveError(
            capability=capability,
            file_version="pre-0.1.18 (legacy)",
            min_required=RELATIONSHIP_CLIFF_VERSION,
        )

    if not isinstance(raw, str):
        return  # malformed — let _check_min_reader_version raise CorruptSaveError

    try:
        file_ver = _parse_version(raw)
    except ValueError:
        return  # malformed — let _check_min_reader_version raise CorruptSaveError

    cliff = _parse_version(RELATIONSHIP_CLIFF_VERSION)
    if file_ver < cliff:
        raise IncompatibleSaveError(
            capability=capability,
            file_version=raw,
            min_required=RELATIONSHIP_CLIFF_VERSION,
        )


def check_load_compat(data: dict) -> None:
    """Verify a save file is compatible with the current loader.

    Rejects pre-cliff files (before v0.1.18 relationship refactor) and
    files that declare a min_reader_versions floor above the running
    program. Called by `unpack_project` before migrations run.
    """
    _check_pre_cliff(data, capability="load")
    _check_min_reader_version(data, capability="load")


def check_import_compat(data: dict) -> None:
    """Verify a save file is compatible with the entity-import path.

    Same cliff and floor checks as `check_load_compat` but for the import
    capability. Called by `entity_import_service._read_source_nnz` before
    migrations run.
    """
    _check_pre_cliff(data, capability="import")
    _check_min_reader_version(data, capability="import")


def upgrade_nnplot_to_nnz(path: Path) -> Path:
    """Rename a `.nnplot` file on disk to `.nnz` and return the new path.
    No-ops (returns the input unchanged) if the path doesn't end in
    `.nnplot`, if a `.nnz` at the same stem already exists, or if the
    rename fails for any other reason (permission denied, read-only
    filesystem, etc.) — the caller has already successfully loaded the
    file, so a failed rename is a cosmetic miss, not a blocker.

    Must be called AFTER a successful load, never before, so a corrupt
    legacy file doesn't get silently renamed and confuse a later retry.

    Used by both the HTTP load endpoints in `routers/project.py` and
    the `NN_LOAD_FILE` startup handler in `main.py`, so any load path
    that consumes a filesystem file can share the same legacy-compat
    behaviour.
    """
    if path.suffix.lower() != ".nnplot":
        return path
    target = path.with_suffix(".nnz")
    if target.exists():
        return path
    try:
        path.rename(target)
        return target
    except OSError:
        return path


def get_assets_dir() -> Path | None:
    return _assets_dir


def get_or_create_assets_dir() -> Path:
    """Return the assets directory, creating a temp dir if none exists."""
    global _assets_dir
    if not _assets_dir or not _assets_dir.exists():
        _assets_dir = Path(tempfile.mkdtemp(prefix="nnz_assets_"))
    return _assets_dir


# ── Phase 5.2a — project cover (top-level cover.jpg in the .nnz) ────────

def _get_cover_dir() -> Path:
    """Return the cover working dir, creating a temp dir if none exists."""
    global _cover_dir
    if not _cover_dir or not _cover_dir.exists():
        _cover_dir = Path(tempfile.mkdtemp(prefix="nnz_cover_"))
    return _cover_dir


def get_cover_path() -> Path | None:
    """Return the working-dir cover.jpg path if a cover is set, else None."""
    if _cover_dir:
        p = _cover_dir / _COVER_NAME
        if p.is_file():
            return p
    return None


def has_cover() -> bool:
    """Derived: does the active project currently have a cover image?
    Computed from working-dir presence, never a stored field."""
    return get_cover_path() is not None


def set_cover_bytes(content: bytes) -> None:
    """Replace the active project's cover image. The bytes are written
    as the working `cover.jpg`; `pack_project` then writes it to the
    .nnz root on the next save. Caller is responsible for ensuring the
    payload is JPEG (the Story Settings crop flow outputs JPG)."""
    if not isinstance(content, (bytes, bytearray)) or len(content) == 0:
        raise ValueError("set_cover_bytes requires non-empty bytes content.")
    (_get_cover_dir() / _COVER_NAME).write_bytes(bytes(content))


def clear_cover() -> None:
    """Remove the active project's cover so the next save writes no
    cover.jpg. No-op when there is no cover."""
    if _cover_dir:
        (_cover_dir / _COVER_NAME).unlink(missing_ok=True)


def store_asset_bytes(content: bytes, filename: str) -> str:
    """Write a byte payload to the project's assets directory under
    a unique, filesystem-safe filename and return the `file_ref`
    string (e.g. `"assets/profile_abc.jpg"`) for use in entity /
    attribute / message fields.

    Deduplicates by SHA-256: if an existing asset has the same
    hash, returns that asset's file_ref without writing a new
    file. This is the same dedup the `POST /assets/upload`
    endpoint provides — both that endpoint and any in-process
    caller (e.g. the MCP profile-image tool) should go through
    this helper so the invariant holds across both write paths.

    `filename` may be a user-supplied or generated name with an
    extension. Unsafe characters are stripped (only alphanumerics
    plus `._-` survive); if the cleaned name already exists in
    the assets directory, a `_<n>` counter is appended to the
    stem until a free name is found.
    """
    import hashlib

    if not isinstance(content, (bytes, bytearray)) or len(content) == 0:
        raise ValueError("store_asset_bytes requires non-empty bytes content.")

    assets_dir = get_or_create_assets_dir()
    new_hash = hashlib.sha256(content).hexdigest()
    for existing in assets_dir.iterdir():
        if existing.is_file():
            try:
                if hashlib.sha256(existing.read_bytes()).hexdigest() == new_hash:
                    return f"assets/{existing.name}"
            except OSError:
                pass

    safe_name = "".join(c for c in (filename or "asset") if c.isalnum() or c in "._-") or "asset"
    stem, ext = (safe_name.rsplit(".", 1) if "." in safe_name else (safe_name, ""))
    ext = f".{ext}" if ext else ""
    asset_path = assets_dir / safe_name
    counter = 1
    while asset_path.exists():
        asset_path = assets_dir / f"{stem}_{counter}{ext}"
        counter += 1
    asset_path.write_bytes(bytes(content))
    return f"assets/{asset_path.name}"


def _collect_referenced_filenames(story: Story) -> set[str]:
    """Return the set of asset basenames (no 'assets/' prefix) referenced anywhere in the story.

    The sweep is global on purpose: a file is kept if ANY reference to it exists anywhere in the
    save, and pruned only if no reference remains. This respects the SHA-256 dedup invariant in
    `POST /assets/upload` (two entities pointing at the same file share one stored asset; pruning
    on per-attribute deletion would break the other entity's reference). Phase 1.10: extended to
    walk `attribute_changes[]` for file_ref values introduced by mid-chain media edits.
    """
    filenames: set[str] = set()

    def _add(ref: str | None) -> None:
        if ref:
            filenames.add(Path(ref).name)

    def _walk_attribute_changes(changes) -> None:
        """Collect file_ref values from every action that can carry one.
        - `add` carries an embedded Attribute whose file_ref (if media type) must be kept.
        - `modify` carries `file_ref_change` — the new file_ref at this chain position. The
          empty-string sentinel "" means "cleared", contributes nothing.
        - `remove` / `list_add` / `list_remove` carry no file refs, so they're skipped.

        Phase 2.13 note: perspective-type attributes do NOT use `file_ref`
        (body lives in `description`; target lives in
        `perspective_target_kind` + `perspective_target_id`). An `add`
        action carrying a perspective Attribute will have `file_ref=None`
        and the `_add(None)` call is a no-op — no special-case needed.
        A `modify` action against a perspective attribute will never set
        `file_ref_change` (the perspective editor doesn't drive that
        field). Future readers: do NOT add a `perspective_target_id`
        sweep here — that's a reference-integrity concern, not an asset
        retention concern, and it's handled by the deletion-cascade
        walkers (`_stripReferencesToEntity` /
        `_stripReferencesToKnowledge` /
        `_stripReferencesToRelationship`), not the asset GC.
        """
        for ac in (changes or []):
            if ac.action == "add" and ac.attribute is not None:
                _add(ac.attribute.file_ref)
            elif ac.action == "modify":
                # Empty string is the "clear" sentinel — treat as no file referenced.
                if ac.file_ref_change:
                    _add(ac.file_ref_change)

    # Entity initial state: profile images + file-type attribute refs
    for bucket in [
        story.entities.characters,
        story.entities.locations,
        story.entities.items,
        story.entities.factions,
        story.entities.customs,
    ]:
        for entity in bucket:
            _add(entity.profile_image_ref)
            for attr in entity.attributes:
                _add(attr.file_ref)

    # Entity node modifier-mode overrides
    for node in story.entity_nodes:
        _add(node.profile_image_change)
        _walk_attribute_changes(node.attribute_changes)

    # SceneNode EntityRef overrides
    for node in story.scenes:
        for bucket_name in ENTITY_BUCKETS:
            for entity_ref in (getattr(node, bucket_name, None) or []):
                _add(entity_ref.profile_image_change)
                _walk_attribute_changes(entity_ref.attribute_changes)

    # Reference node media assets
    for node in story.reference_nodes:
        _add(node.file_ref)

    # Phase 1.21c — Knowledge profile images (origin + chain-time
    # overrides). Without this sweep the cleanup pruner deletes any
    # Knowledge avatar on save because no other reference site keeps it
    # alive, leaving a 404 on next load.
    for knowledge in (getattr(story, "knowledges", None) or []):
        _add(getattr(knowledge, "profile_image_ref", None))
        history = getattr(knowledge, "history", None)
        if history is not None:
            for ch in (getattr(history, "profile_image_changes", None) or []):
                _add(getattr(ch, "new_profile_image_ref", None))

    return filenames


def _describe_asset_owners(story: Story) -> dict[str, list[str]]:
    """Map each referenced asset basename to human-readable description(s)
    of the story object(s) that reference it.

    Used to enrich a `MissingAssetsError` so the user is told WHICH
    entity / knowledge / scene owns a missing image or file, not just
    the opaque asset filename. The walk mirrors `_collect_referenced_
    filenames` site-for-site (enumerate every reference, baseline and
    chain change alike) so the labels stay in lockstep with what the
    save actually packs. This is a global enumeration for retention /
    diagnostics, NOT a chain-resolved read of an effective value at an
    anchor.

    Best-effort: labels degrade gracefully to a generic phrase when a
    name can't be resolved (e.g. a chain change referencing an entity
    no longer in the library). One filename can map to several owners
    (SHA-256 dedup lets multiple objects share a single stored asset).
    """
    owners: dict[str, list[str]] = {}

    def _note(ref, label: str) -> None:
        if not ref:
            return
        name = Path(ref).name
        bucket = owners.setdefault(name, [])
        if label not in bucket:
            bucket.append(label)

    # entity_id -> entity, for labelling chain-change owners and
    # resolving a modify change's target attribute name.
    entity_by_id = {}
    for bucket_name in ENTITY_BUCKETS:
        for entity in (getattr(story.entities, bucket_name, None) or []):
            entity_by_id[entity.id] = entity

    def _entity_label(entity_id) -> str:
        ent = entity_by_id.get(entity_id) if entity_id else None
        return f"{ent.name} ({ent.type})" if ent is not None else "an entity"

    def _attr_name(entity_id, attribute_id):
        ent = entity_by_id.get(entity_id) if entity_id else None
        if ent is None or not attribute_id:
            return None
        for attr in ent.attributes:
            if attr.id == attribute_id:
                return attr.name
        return None

    def _describe_attr_changes(changes, entity_id, prefix: str) -> None:
        for ac in (changes or []):
            if ac.action == "add" and ac.attribute is not None:
                _note(ac.attribute.file_ref, f"{prefix}: attribute '{ac.attribute.name}'")
            elif ac.action == "modify" and ac.file_ref_change:
                nm = _attr_name(entity_id, ac.attribute_id)
                attr_label = f"attribute '{nm}'" if nm else "an attribute"
                _note(ac.file_ref_change, f"{prefix}: {attr_label}")

    # Entity initial state: profile images + file-type attribute refs.
    for entity in entity_by_id.values():
        _note(entity.profile_image_ref, f"{entity.name} ({entity.type}): profile image")
        for attr in entity.attributes:
            _note(attr.file_ref, f"{entity.name} ({entity.type}): attribute '{attr.name}'")

    # Entity node modifier-mode overrides.
    for node in (getattr(story, "entity_nodes", None) or []):
        eid = getattr(node, "entity_id", None)
        subj = _entity_label(eid)
        _note(node.profile_image_change, f"{subj}: profile image change")
        _describe_attr_changes(node.attribute_changes, eid, subj)

    # Scene node EntityRef overrides.
    for node in (getattr(story, "scenes", None) or []):
        scene_label = (getattr(node, "title", "") or "").strip() or "an untitled scene"
        for bucket_name in ENTITY_BUCKETS:
            for ref in (getattr(node, bucket_name, None) or []):
                eid = getattr(ref, "entity_id", None)
                ctx = f"{_entity_label(eid)} in scene '{scene_label}'"
                _note(ref.profile_image_change, f"{ctx}: profile image change")
                _describe_attr_changes(ref.attribute_changes, eid, ctx)

    # Reference nodes.
    for node in (getattr(story, "reference_nodes", None) or []):
        title = (getattr(node, "title", "") or "").strip()
        _note(getattr(node, "file_ref", None),
              f"reference node '{title}'" if title else "a reference node")

    # Knowledges (origin + chain-time profile image overrides).
    for knowledge in (getattr(story, "knowledges", None) or []):
        kname = getattr(knowledge, "name", None) or "untitled"
        _note(getattr(knowledge, "profile_image_ref", None), f"Knowledge '{kname}': profile image")
        history = getattr(knowledge, "history", None)
        if history is not None:
            for ch in (getattr(history, "profile_image_changes", None) or []):
                _note(getattr(ch, "new_profile_image_ref", None),
                      f"Knowledge '{kname}': profile image change")

    return owners


def _restore_missing_referenced_assets(
    story: Story,
    recovery_source_path: Path | None,
) -> set[str]:
    """For each asset filename the story references but that is not
    present on disk in `_assets_dir`, try to extract it from
    `recovery_source_path` (the project's currently-active `.nnz` file
    on disk). Returns the set of filenames that are STILL missing
    afterwards — either because no recovery source was provided, the
    source couldn't be opened, or the source didn't contain that
    filename either.

    Called by `pack_project` as a safety net against the dev-mode
    `uvicorn --reload` scenario where the in-process `_assets_dir`
    gets reset to a fresh empty temp dir while the story itself still
    holds file_ref values from the previously-loaded project.
    Without this step, save would silently produce a ZIP whose
    narrative.json points at files that never get packed.
    """
    referenced = _collect_referenced_filenames(story)
    if not referenced:
        return set()

    on_disk: set[str] = set()
    if _assets_dir and _assets_dir.is_dir():
        for f in _assets_dir.iterdir():
            if f.is_file():
                on_disk.add(f.name)

    missing = referenced - on_disk
    if not missing:
        return set()

    # Attempt recovery from the active file on disk. Silent no-op if
    # the source doesn't exist or can't be opened — we return the
    # missing set and let the caller decide how loudly to complain.
    if recovery_source_path and recovery_source_path.exists():
        try:
            dest_dir = get_or_create_assets_dir()
            with zipfile.ZipFile(recovery_source_path) as zf:
                zip_names = {Path(n).name: n for n in zf.namelist()
                             if n.startswith("assets/") and not n.endswith("/")}
                for filename in list(missing):
                    zip_entry = zip_names.get(filename)
                    if zip_entry is None:
                        continue
                    (dest_dir / filename).write_bytes(zf.read(zip_entry))
                    missing.discard(filename)
        except (zipfile.BadZipFile, OSError):
            # Treat an unreadable recovery source as "no recovery
            # possible"; whatever we managed to extract before the
            # error stays. The caller raises on the still-missing set.
            pass

    return missing


def pack_project(
    story: Story,
    seeds: SeedsFile | None = None,
    *,
    recovery_source_path: Path | None = None,
) -> bytes:
    """Serialise story + assets (+ optional seeds) into an in-memory
    .nnz ZIP and return the bytes. Unused assets are removed from the
    assets directory before packing.

    The `seeds` argument is optional. When it is non-None and
    `seeds.is_empty()` is False, a `seeds.json` entry is written next
    to `narrative.json`. An empty or missing seeds value writes no
    `seeds.json` at all — so projects that never configure seeds have
    zero-byte overhead in their save file, and legacy `.nnz` files
    round-trip unchanged through a save that doesn't pass seeds in.

    Save format versioning:
    - `save_format_version` is ALWAYS stamped with PROGRAM_VERSION — the
      version of the build doing the writing. This is forensic data, not
      a compat gate, and naturally churns on every tagged release.
    - For each capability in MIN_READER_EPOCHS, the file's per-capability
      floor in `min_reader_versions` is bumped UP to the current epoch
      if the story's current value for that capability is lower (e.g. a
      brand-new story, or one whose file version predates the most
      recent breaking change affecting that capability). If it's
      already equal or higher (e.g. round-tripped from a future build
      that introduced its own breaking change and stamped a higher
      floor), the existing value is preserved so a subsequent reload
      by that future build doesn't lose its version gate.
    - Floors for capabilities this program doesn't know about are left
      intact — they belong to some future reader and must survive
      round-trip untouched.

    If you are changing what gets written to narrative.json, read the
    MAINTAINER CHECKLIST near MIN_READER_EPOCHS at the top of this file
    before committing — any breaking schema change requires a
    coordinated MIN_READER_EPOCHS bump (on the capabilities that
    actually care), a migration entry, and a CHANGELOG update.
    See docs/save-format-versioning.md for the step-by-step.

    `recovery_source_path` is an optional path to the project's
    currently-active `.nnz` file on disk. When set, any referenced
    asset filename missing from the in-memory `_assets_dir` is
    restored from that file before packing. This protects against
    dev-mode `uvicorn --reload` wiping the in-process assets cache
    (module globals reset on reload; previously-extracted temp-dir
    state is lost). If recovery can't restore every missing
    reference, raises `MissingAssetsError` rather than silently
    packing a ZIP whose narrative.json points at absent files.
    """
    still_missing = _restore_missing_referenced_assets(story, recovery_source_path)
    if still_missing:
        raise MissingAssetsError(still_missing, _describe_asset_owners(story))

    # NOTE: we deliberately do NOT prune unreferenced files from the
    # in-memory `_assets_dir` here. Packing is reference-filtered below
    # (only assets the story references are written into the ZIP), so the
    # saved file stays clean without deleting anything from the working
    # dir. Mid-session deletion used to orphan a freshly-uploaded image
    # still held in an uncommitted UI draft: an autosave firing during
    # the edit deleted the bytes before the draft committed, leaving a
    # reference with no asset on the next save. The working dir is wiped
    # wholesale on the next project load, so abandoned / superseded
    # uploads never accumulate beyond the session.
    story.save_format_version = PROGRAM_VERSION

    # Normalise existing floors into a plain dict we can mutate. The
    # Pydantic model already declares this as `dict[str, str]`, but a
    # foreign-content round-trip from a future writer could have
    # smuggled in non-string values — tolerate those by overwriting
    # anything this program understands and preserving the rest.
    existing = story.min_reader_versions
    if not isinstance(existing, dict):
        existing = {}
    floors: dict[str, str] = dict(existing)

    for capability, epoch in MIN_READER_EPOCHS.items():
        current = floors.get(capability)
        bumped = False
        if not isinstance(current, str):
            bumped = True
        elif _is_branch_flavour_version(current):
            # Existing floor is a retired off-master flavour tag. Its
            # numeric tuple is meaningless against the current master
            # version line, so always overwrite with the current
            # master-flavoured epoch — this is how saves originally
            # stamped with the retired tag get scrubbed clean on
            # their first re-save under a build that knows better.
            bumped = True
        else:
            try:
                if _parse_version(current) < _parse_version(epoch):
                    bumped = True
            except ValueError:
                bumped = True
        if bumped:
            floors[capability] = epoch

    # Final defensive scrub right before we write to disk. The bump
    # loop above already replaces a stale flavour-tagged floor for
    # every capability listed in MIN_READER_EPOCHS, but a foreign
    # capability key (one this build doesn't know about, smuggled in
    # by a future writer via `extra='allow'`) could still ride
    # through with a flavour-tagged value untouched. Drop any such
    # entry rather than write it to disk — we'd rather lose an
    # unknown floor than ship a retired off-master tag back out into
    # the wild.
    for cap in list(floors.keys()):
        val = floors.get(cap)
        if isinstance(val, str) and _is_branch_flavour_version(val):
            if cap in MIN_READER_EPOCHS:
                floors[cap] = MIN_READER_EPOCHS[cap]
            else:
                floors.pop(cap, None)

    story.min_reader_versions = floors

    # Mirror scrub for `save_format_version`. `PROGRAM_VERSION` is
    # asserted master-flavoured at module import, so the line above
    # that stamps `story.save_format_version = PROGRAM_VERSION` is
    # already safe. This is a belt-and-suspenders re-check covering
    # any code path that might mutate the field between that stamp
    # and the JSON write below.
    if _is_branch_flavour_version(story.save_format_version):
        story.save_format_version = PROGRAM_VERSION

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("narrative.json", story.model_dump_json(indent=2))
        if seeds is not None and not seeds.is_empty():
            zf.writestr("seeds.json", seeds_service.serialize_seeds(seeds))
        if _assets_dir and _assets_dir.is_dir():
            # Reference-filtered packing: only assets the story actually
            # references are written into the ZIP. This keeps the saved
            # file clean (abandoned / superseded uploads left in the
            # working dir are simply not packed) WITHOUT deleting them
            # from the working dir, so an image still held in an
            # uncommitted UI draft survives until it is either committed
            # (and packed) or discarded (and swept on the next load).
            # See the note in `pack_project` above.
            referenced = _collect_referenced_filenames(story)
            for asset in sorted(_assets_dir.iterdir()):
                if asset.is_file() and asset.name in referenced:
                    zf.write(asset, f"assets/{asset.name}")
        # Phase 5.2a — the cover image rides at the archive ROOT as a
        # fixed `cover.jpg` (NOT under assets/). Absent working cover =
        # no cover.jpg written = a cover-less project.
        cover = get_cover_path()
        if cover is not None:
            zf.write(cover, _COVER_NAME)
    return buf.getvalue()


def unpack_project(data: bytes) -> tuple[dict, SeedsFile]:
    """Extract a .nnz ZIP, restore assets to a temp dir, return a
    `(story_dict, seeds)` tuple.

    `story_dict` is the migrated + compat-checked narrative dict,
    ready to hand to `Story.model_validate`. `seeds` is a `SeedsFile`
    instance: populated from `seeds.json` if the ZIP had one, empty
    otherwise. Legacy `.nnz` files pre-dating the seeds feature, and
    current projects that never configured seeds, both return an
    empty `SeedsFile` — seeds are entirely optional and a missing
    entry is the normal case, not an error.

    A malformed `seeds.json` is logged (the project load continues
    with empty seeds) rather than aborting the load — seeds are
    user-editable by hand per the spec, and a typo must not prevent
    the user from opening their project. The seeds system re-writes
    on the next save, so a round-trip heals the malformed file.

    Runs the load-time compat check (rejects files written by newer
    readers) before applying any migrations, so a too-new file never
    ends up partially upgraded.

    If you are changing how narrative.json is interpreted on load,
    read the MAINTAINER CHECKLIST near MIN_READER_EPOCH at the top of
    this file (and docs/save-format-versioning.md for the step-by-
    step). Any breaking schema change requires a coordinated
    MIN_READER_EPOCH bump, migration entry, CHANGELOG entry, and
    PROGRAM_VERSION bump, and any change to the error surface
    (IncompatibleSaveError, CorruptSaveError) must be mirrored in the
    project router's `_unpack_or_raise` and the frontend's
    `handleSaveFormatLoadError` helper.
    """
    global _assets_dir, _cover_dir

    # Clean up previous temp dirs (assets + cover). A fresh cover dir is
    # created lazily only if this archive actually carries a cover.jpg —
    # a cover-less project leaves `_cover_dir` empty so `has_cover()` is
    # False (Phase 5.2a).
    if _assets_dir and _assets_dir.exists():
        shutil.rmtree(_assets_dir, ignore_errors=True)
    _assets_dir = Path(tempfile.mkdtemp(prefix="nnz_assets_"))
    if _cover_dir and _cover_dir.exists():
        shutil.rmtree(_cover_dir, ignore_errors=True)
    _cover_dir = None

    seeds_json: str | None = None
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        names = zf.namelist()
        if "narrative.json" not in names:
            raise ValueError("Missing narrative.json — not a valid .nnz file")
        story_json = zf.read("narrative.json").decode("utf-8")
        if "seeds.json" in names:
            seeds_json = zf.read("seeds.json").decode("utf-8")
        if _COVER_NAME in names:
            (_get_cover_dir() / _COVER_NAME).write_bytes(zf.read(_COVER_NAME))
        for name in names:
            if name.startswith("assets/") and not name.endswith("/"):
                filename = Path(name).name
                (_assets_dir / filename).write_bytes(zf.read(name))

    story_payload = json.loads(story_json)
    check_load_compat(story_payload)
    migrated_story = _migrate_story_dict(story_payload)

    if seeds_json is None:
        seeds = seeds_service.empty_seeds()
    else:
        try:
            seeds = seeds_service.parse_seeds(seeds_json)
        except (ValueError, json.JSONDecodeError) as exc:
            # Don't block the load — seeds heal on next save. Logging
            # goes via print to stderr to match other load-path fallbacks
            # (main.py's NN_LOAD_FILE error handling, etc.) rather than
            # introducing a new logging framework just for this.
            import sys
            print(
                f"[seeds] malformed seeds.json ({exc!r}); loading with empty seeds.",
                file=sys.stderr,
                flush=True,
            )
            seeds = seeds_service.empty_seeds()

    return migrated_story, seeds
