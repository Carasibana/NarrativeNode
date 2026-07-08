"""Seeds file (`seeds.json`) read / write / validate / migrate.

Seeds are persisted as a sibling file to `narrative.json` inside a
project's `.nnz` ZIP. See `backend/models/seeds.py` for the schema and
`backend/services/file_service.py` for the pack / unpack integration.

The file is entirely optional — projects without seeds don't write
`seeds.json`, and legacy `.nnz` files pre-dating this feature load
cleanly as empty seeds (the unpack path treats a missing entry as
equivalent to an empty `SeedsFile`).

If you are landing a breaking change to the seeds schema:

1. Bump the current `SeedsFile.version` default (tracks `PROGRAM_VERSION`
   at the time of the change).
2. Add a migration entry to `_MIGRATIONS` keyed on the version that
   wrote the old shape; the function takes a dict at that version and
   returns a dict at the next known version. Chains until the dict
   version matches the current default.
3. Unknown fields are already preserved via Pydantic's
   `extra='allow'`, so purely additive bumps don't need a migration.
"""
from __future__ import annotations

import io
import json
import sys
import zipfile
from typing import TYPE_CHECKING, Callable

from models.entity import Attribute, PresetList
from models.seeds import BundledPresetList, SeedsFile

if TYPE_CHECKING:
    from models.entity import Entity
    from models.story import Story


# Per-type stub bucket names on `SeedsFile.seeds`. Defined once here so
# every helper that iterates the buckets stays in sync when the entity-
# type set changes.
#
# Phase 1.21c: "knowledge" removed from the iteration list — Knowledge
# is no longer an Entity subtype, so knowledge-typed seed templates
# can't spawn knowledge entities via the seeds-apply flow anymore.
# `SeedsByType.knowledge: list[SeedStub]` stays on the model for round-
# trip compatibility (existing saves with knowledge-seed templates still
# load and save back, just never get applied). Re-routing knowledge
# seeds to `Knowledge` object creation is out of scope for 1.21c Step 2
# — revisit as a follow-up (possibly under Phase 1.25 Export/Import
# review).
_BUCKET_NAMES = ("character", "location", "item", "faction", "custom")


# Version-keyed migrations. Keys are the `version` string written by
# an older build; each value is a callable that takes the parsed dict
# at that version and returns a dict at the next known version. Empty
# today — the first seeds schema is the baseline.
_MIGRATIONS: dict[str, Callable[[dict], dict]] = {}


def _migrate_to_current(raw: dict) -> dict:
    """Walk the `_MIGRATIONS` chain from the file's written version up
    to the current default. No-op when the dict is already current or
    when no migrations are registered."""
    seen = set()
    while True:
        version = raw.get("version", "")
        if version in seen:
            # Defensive: a migration that doesn't advance version would
            # loop forever otherwise. Treat as a bug in the caller and
            # bail with the half-migrated dict — validation will fail
            # loudly and the load path surfaces the error.
            break
        seen.add(version)
        step = _MIGRATIONS.get(version)
        if step is None:
            break
        raw = step(raw)
    return raw


def parse_seeds(raw_json: str) -> SeedsFile:
    """Parse raw seeds.json text into a validated `SeedsFile`.

    Applies any applicable migrations before validation. Unknown
    fields are preserved via Pydantic's `extra='allow'` so newer-
    version seeds files round-trip cleanly through older readers.

    Raises `ValueError` on invalid JSON or schema mismatch; the
    calling load path catches this and falls back to empty seeds
    with a logged warning (seeds must never block a project load).
    """
    raw = json.loads(raw_json)
    migrated = _migrate_to_current(raw)
    return SeedsFile.model_validate(migrated)


def serialize_seeds(seeds: SeedsFile) -> str:
    """Serialise a `SeedsFile` to pretty-printed JSON text.

    Indented for human readability — seeds files are user-editable by
    hand per the spec, and a diff of two projects' seeds should be
    intelligible without a JSON formatter.
    """
    return seeds.model_dump_json(indent=2)


def empty_seeds() -> SeedsFile:
    """Return a fresh empty `SeedsFile` at the current schema version.

    Used by the load path when a `.nnz` has no `seeds.json` entry
    (legacy files and projects that never configured seeds) and by
    `newProject()`-equivalent flows that need a blank slate.
    """
    return SeedsFile()


# Path to the user-level default-seeds template. Duplicated from the
# default_seeds router (which also knows this path) so consumers at
# this service layer don't have to import from the router module.
# Kept in sync by convention — if one changes, update the other.
from pathlib import Path  # noqa: E402 — late import keeps the top of this file focused on the common case
_DEFAULT_SEEDS_PATH = (
    Path(__file__).resolve().parent.parent.parent
    / "preferences" / "default_seeds.json"
)


def read_default_seeds_file() -> SeedsFile:
    """Read `preferences/default_seeds.json` — the user-level default
    seeds template that gets copied into new projects at creation
    time. Returns an empty `SeedsFile` for any "no usable seeds"
    condition (missing file, zero-byte, whitespace-only, malformed)
    — mirroring the fallback shape of the default_seeds router so
    the two read paths can't diverge. Malformed content logs a
    stderr warning; all other no-usable-seeds conditions fall
    through silently.
    """
    try:
        raw = _DEFAULT_SEEDS_PATH.read_text(encoding="utf-8")
    except FileNotFoundError:
        return empty_seeds()
    except OSError as exc:
        print(
            f"[seeds_service] could not read {_DEFAULT_SEEDS_PATH!s}: {exc!r}. "
            f"Treating as no default seeds configured.",
            file=sys.stderr, flush=True,
        )
        return empty_seeds()
    if not raw.strip():
        return empty_seeds()
    try:
        return parse_seeds(raw)
    except Exception as exc:
        print(
            f"[seeds_service] malformed {_DEFAULT_SEEDS_PATH!s}: {exc!r}. "
            f"Treating as no default seeds configured.",
            file=sys.stderr, flush=True,
        )
        return empty_seeds()


def apply_seeds_to_entity(
    entity: "Entity", seeds: SeedsFile, story: "Story"
) -> "Entity":
    """Append the project's seed stubs for `entity.type` to the entity's
    `attributes[]` as fresh `Attribute` objects. Mutates and returns
    the same entity.

    Each stub produces one `Attribute`:
    - Fresh UUID (the stub carries no ID).
    - `name` and `attribute_type` copied from the stub.
    - `value` set to `stub.default_value` when non-null, otherwise "".

    For preset-type stubs, `preset_list_name` is resolved against
    `story.preset_lists` by name. The resolved preset list's UUID
    lands on `attribute.preset_list_id`; the stub's name also lands
    on `attribute.preset_list_name` so orphaned attributes (where the
    referenced preset list is later deleted or renamed) can be re-
    linked by name. If the preset list is missing at creation time,
    the attribute is still created with `preset_list_id = None` and a
    warning is logged — the user can resolve it later by creating the
    matching preset list in the project.

    Seeds are appended AFTER any attributes the caller already set, so
    explicit attributes on the incoming entity are preserved in their
    original order and seeds are purely additive.

    When the caller-provided attributes already include an attribute
    whose name (case-insensitive) matches a seed's name, that seed is
    SKIPPED — the caller clearly didn't forget the attribute (which is
    the only reason auto-attach exists), so attaching an empty duplicate
    would leave the entity with two same-named attributes and break
    every subsequent reference-by-name lookup with an ambiguous-match
    error. Bug surfaced 2026-05-17b in the blind-agent rom-com test
    (a `Gender` seed double-fired when the MCP `create_entity` call
    passed `attributes=[{name: 'Gender', value: 'Male', ...}]`).

    Creation-time only — this function is called from the entity-
    creation path. Existing entities are not back-filled by it.
    """
    bucket = getattr(seeds.seeds, entity.type, None)
    if not bucket:
        return entity

    preset_lookup: dict[str, str] = {pl.name: pl.id for pl in story.preset_lists}

    # Snapshot caller-provided attribute names (case-insensitive) so
    # any seed whose name collides is skipped below. Snapshot taken
    # BEFORE the loop so seeds applied earlier in the loop don't shadow
    # later seeds — only caller-explicit attributes block seed auto-
    # attach.
    existing_attr_names: set[str] = {
        (attr.name or "").strip().lower() for attr in entity.attributes
    }

    for stub in bucket:
        try:
            stub_name_key = (stub.name or "").strip().lower()
            if stub_name_key and stub_name_key in existing_attr_names:
                # Caller already provided this attribute — seed would
                # double-attach an empty duplicate. Skip.
                continue
            value = stub.default_value if stub.default_value is not None else ""
            kwargs: dict = {
                "name": stub.name,
                "attribute_type": stub.attribute_type,
                "value": value,
            }
            if stub.attribute_type == "preset":
                kwargs["preset_list_name"] = stub.preset_list_name
                if stub.preset_list_name:
                    resolved = preset_lookup.get(stub.preset_list_name)
                    kwargs["preset_list_id"] = resolved
                    if resolved is None:
                        print(
                            f"[seeds] stub '{stub.name}' references preset list "
                            f"'{stub.preset_list_name}' which does not exist in "
                            f"the project; attribute created with preset_list_id"
                            f"=null.",
                            file=sys.stderr,
                            flush=True,
                        )
            entity.attributes.append(Attribute(**kwargs))
        except Exception as exc:  # noqa: BLE001
            # A malformed or unsatisfiable seed stub must NEVER block entity
            # creation. Seeds are purely additive (same principle as "seeds
            # must never block a project load"): a stub that fails to build a
            # valid Attribute — e.g. a 'number' stub with no default value, or
            # any future stub shape the Attribute validators reject — is
            # logged and skipped so the entity (and the remaining seeds) still
            # land, instead of 500-ing the whole create. Fixes the character-
            # create failure seen when a character's seed couldn't be applied.
            print(
                f"[seeds] could not apply seed stub "
                f"{getattr(stub, 'name', '?')!r} "
                f"({getattr(stub, 'attribute_type', '?')}) to "
                f"{entity.type} {entity.name!r}: {exc!r}; skipping this seed.",
                file=sys.stderr,
                flush=True,
            )
            continue

    return entity


# ── Import / export helpers ─────────────────────────────────────────────
# Used by `backend/routers/seeds.py` for the `/project/seeds/import` and
# `/project/seeds/export` endpoints. The round-trip contract is that an
# exported seeds file should be losslessly importable into a fresh
# project (all referenced preset lists are self-contained in the bundle).


def parse_source_seeds(data: bytes, filename: str) -> SeedsFile:
    """Parse seeds from an uploaded file — either a `.nnz` archive (we
    extract its `seeds.json` entry) or a standalone `seeds.json` file.

    The filename extension decides the branch: `.nnz` / `.nnplot` go
    through the ZIP reader, `.json` goes through the direct parser.
    Raises `ValueError` if the file is neither, or if a `.nnz` has no
    `seeds.json` entry (source project has no seeds configured, nothing
    to import).
    """
    lower = filename.lower()
    if lower.endswith(".nnz") or lower.endswith(".nnplot"):
        try:
            zf = zipfile.ZipFile(io.BytesIO(data))
        except zipfile.BadZipFile as exc:
            raise ValueError(f"Not a valid .nnz archive: {exc}") from exc
        with zf:
            if "seeds.json" not in zf.namelist():
                raise ValueError(
                    "Source .nnz archive has no seeds.json — the source "
                    "project has no seeds configured, nothing to import."
                )
            seeds_json = zf.read("seeds.json").decode("utf-8")
        return parse_seeds(seeds_json)
    if lower.endswith(".json"):
        return parse_seeds(data.decode("utf-8"))
    raise ValueError(
        f"Unsupported extension for seeds import: {filename!r}. "
        f"Expected .nnz, .nnplot, or .json."
    )


def build_import_preview(
    source: SeedsFile,
    existing_preset_lists,
) -> dict:
    """Build a structured preview of an import without mutating anything.

    The UI uses this to render the granular-selection checkbox list:
    every stub and bundled preset list is enumerated with a stable
    `index` (its position within its bucket / list). Each bundled
    preset list carries a `match_type` against the supplied
    `existing_preset_lists` (any list of objects with `.name` and
    `.values` attributes — project `PresetList` for a project-scope
    import, or `BundledPresetList` for a default-seeds-scope import):

    - `"new"` — target has no preset list with this name.
    - `"identical"` — target has one with the same name AND the same
      ordered values list.
    - `"conflict"` — target has one with the same name but different
      values. `existing_values` is included so the UI can show both.

    Stubs are not compared to the target's current seeds — the user's
    chosen import `mode` (replace or append) decides stub behaviour at
    apply-time and the preview doesn't need to predict it.
    """
    existing_by_name = {pl.name: pl for pl in existing_preset_lists}

    preset_lists_preview: list[dict] = []
    for idx, bundled in enumerate(source.preset_lists):
        existing = existing_by_name.get(bundled.name)
        if existing is None:
            match_type = "new"
            existing_values = None
        elif list(existing.values) == list(bundled.values):
            match_type = "identical"
            existing_values = None
        else:
            match_type = "conflict"
            existing_values = list(existing.values)
        preset_lists_preview.append({
            "index": idx,
            "name": bundled.name,
            "values": list(bundled.values),
            "match_type": match_type,
            "existing_values": existing_values,
        })

    stubs_preview: dict[str, list[dict]] = {}
    for bucket_name in _BUCKET_NAMES:
        bucket = getattr(source.seeds, bucket_name)
        stubs_preview[bucket_name] = [
            {
                "index": i,
                "name": s.name,
                "attribute_type": s.attribute_type,
                "default_value": s.default_value,
                "preset_list_name": s.preset_list_name,
            }
            for i, s in enumerate(bucket)
        ]

    return {
        "version": source.version,
        "stubs": stubs_preview,
        "preset_lists": preset_lists_preview,
    }


def _apply_selection_filter(source: SeedsFile, selection: dict | None) -> SeedsFile:
    """Return a shallow-filtered SeedsFile restricted to the indices
    listed in `selection`. When `selection` is None, returns `source`
    unchanged. The caller is expected to treat the result as the
    effective source for the import.

    Shape of `selection`:
        {
          "stubs": {"character": [0, 2], "location": [], ...},
          "preset_lists": [0, 3]
        }

    A missing bucket key in `selection["stubs"]` means "include
    nothing from that bucket" (explicit opt-in semantics) — the UI
    passes all five keys every time. An omitted or null
    `preset_lists` means the same — only indices listed are included.
    """
    if selection is None:
        return source
    stub_sel = selection.get("stubs") or {}
    pl_sel = selection.get("preset_lists")

    filtered = source.model_copy(deep=True)
    for bucket_name in _BUCKET_NAMES:
        indices = set(stub_sel.get(bucket_name) or [])
        current_bucket = getattr(filtered.seeds, bucket_name)
        setattr(
            filtered.seeds,
            bucket_name,
            [s for i, s in enumerate(current_bucket) if i in indices]
            if stub_sel else current_bucket,
        )
    if pl_sel is not None:
        keep = set(pl_sel)
        filtered.preset_lists = [
            pl for i, pl in enumerate(filtered.preset_lists) if i in keep
        ]
    return filtered


def merge_import_into_project(
    source: SeedsFile,
    story: "Story",
    current: SeedsFile,
    mode: str,
    selection: dict | None = None,
) -> dict:
    """Apply a source `SeedsFile` to the target project. Mutates `story`
    (its `preset_lists` may gain new entries) and `current` (its seeds
    get replaced or appended). Returns a summary dict suitable for the
    HTTP response body.

    Preset lists — matched by name against `story.preset_lists`:
    - `identical` → silently reused (no action).
    - `new` → appended to `story.preset_lists` with a fresh UUID.
    - `conflict` → skipped with a stderr warning; name is recorded in
      the response's `preset_lists_skipped_conflict`. The UI's granular
      preview should catch these before apply so the user can choose
      rename / overwrite / skip — the granular-selection round-trip
      will land in a later commit and supersede this blanket skip.

    Stubs — behaviour depends on `mode`:
    - `mode="replace"` — `current.seeds` is replaced with a deep copy
      of `source.seeds`. Existing stubs are dropped.
    - `mode="append"` — every stub from `source.seeds` is appended to
      the matching bucket in `current.seeds`. No deduplication — if
      the user imports the same file twice they get duplicates. The
      granular-selection UI is responsible for deduplication at apply
      time.

    Raises `ValueError` for an unsupported mode.
    """
    if mode not in ("replace", "append"):
        raise ValueError(f"Unsupported import mode: {mode!r}")

    source = _apply_selection_filter(source, selection)
    existing_by_name: dict[str, PresetList] = {pl.name: pl for pl in story.preset_lists}
    preset_lists_created: list[dict] = []
    preset_lists_reused: list[str] = []
    preset_lists_skipped_conflict: list[str] = []

    for bundled in source.preset_lists:
        existing = existing_by_name.get(bundled.name)
        if existing is None:
            new_pl = PresetList(name=bundled.name, values=list(bundled.values))
            story.preset_lists.append(new_pl)
            existing_by_name[new_pl.name] = new_pl
            preset_lists_created.append({"name": bundled.name, "id": new_pl.id})
        elif list(existing.values) == list(bundled.values):
            preset_lists_reused.append(bundled.name)
        else:
            preset_lists_skipped_conflict.append(bundled.name)
            print(
                f"[seeds] import skipped preset list {bundled.name!r}: "
                f"a preset list with this name exists in the target "
                f"project with different values.",
                file=sys.stderr,
                flush=True,
            )

    # Also update the SEEDS FILE's bundled preset_lists. Without
    # this the Story Seeds tab (which renders `seeds.preset_lists`,
    # not `story.preset_lists`) wouldn't show the imported lists,
    # and preset-type stubs that reference them by name would
    # resolve as "(not found)" in the editor picker even though
    # `story.preset_lists` has the promoted entry. Same risk on the
    # default-seeds side — the editor only reads the bundled list
    # there too.
    # Conflicts are skipped: the user can resolve them manually
    # after import by renaming the existing list, then re-importing.
    skipped = set(preset_lists_skipped_conflict)
    non_conflict_sources = [
        BundledPresetList(name=pl.name, values=list(pl.values))
        for pl in source.preset_lists
        if pl.name not in skipped
    ]

    stubs_replaced = 0
    stubs_appended = 0
    if mode == "replace":
        current.seeds = source.seeds.model_copy(deep=True)
        stubs_replaced = sum(
            len(getattr(current.seeds, b)) for b in _BUCKET_NAMES
        )
        # Replace mode resets bundled preset lists to match the
        # imported set — user expects "replace" to make the seeds
        # file reflect the imported file's state.
        current.preset_lists = non_conflict_sources
    else:  # append
        for bucket_name in _BUCKET_NAMES:
            target_bucket = getattr(current.seeds, bucket_name)
            for stub in getattr(source.seeds, bucket_name):
                target_bucket.append(stub.model_copy(deep=True))
                stubs_appended += 1
        # Append mode: merge bundled preset lists, dedup by name so
        # a re-import of the same file doesn't stack duplicates.
        bundled_names = {pl.name for pl in current.preset_lists}
        for pl in non_conflict_sources:
            if pl.name not in bundled_names:
                current.preset_lists.append(pl)
                bundled_names.add(pl.name)

    return {
        "mode": mode,
        "preset_lists_created": preset_lists_created,
        "preset_lists_reused": preset_lists_reused,
        "preset_lists_skipped_conflict": preset_lists_skipped_conflict,
        "stubs_replaced": stubs_replaced,
        "stubs_appended": stubs_appended,
    }


def merge_import_into_default_seeds(
    source: SeedsFile,
    current: SeedsFile,
    mode: str,
    selection: dict | None = None,
) -> dict:
    """Apply a source `SeedsFile` to the standalone default-seeds
    `current`. Parallels `merge_import_into_project` but without the
    story context: new preset lists are appended to `current.preset_lists`
    directly (there is no `story.preset_lists` at the default-seeds
    layer). Mutates `current` in place. Returns a summary dict.

    Preset-list matching is by name against `current.preset_lists`
    with the same three-way `new` / `identical` / `conflict` logic as
    the project-scope merge. Conflicts are skipped with a stderr
    warning — the granular-selection UI can surface them for user
    resolution before apply, just like on the project side.

    Stubs follow the same `replace` / `append` semantics as
    `merge_import_into_project`.
    """
    if mode not in ("replace", "append"):
        raise ValueError(f"Unsupported import mode: {mode!r}")

    source = _apply_selection_filter(source, selection)
    existing_by_name = {pl.name: pl for pl in current.preset_lists}
    preset_lists_created: list[dict] = []
    preset_lists_reused: list[str] = []
    preset_lists_skipped_conflict: list[str] = []

    for bundled in source.preset_lists:
        existing = existing_by_name.get(bundled.name)
        if existing is None:
            new_pl = bundled.model_copy(deep=True)
            current.preset_lists.append(new_pl)
            existing_by_name[new_pl.name] = new_pl
            preset_lists_created.append({"name": bundled.name})
        elif list(existing.values) == list(bundled.values):
            preset_lists_reused.append(bundled.name)
        else:
            preset_lists_skipped_conflict.append(bundled.name)
            print(
                f"[seeds] default-seeds import skipped preset list "
                f"{bundled.name!r}: name exists with different values.",
                file=sys.stderr,
                flush=True,
            )

    # Also update the SEEDS FILE's bundled preset_lists. Without
    # this the Story Seeds tab (which renders `seeds.preset_lists`,
    # not `story.preset_lists`) wouldn't show the imported lists,
    # and preset-type stubs that reference them by name would
    # resolve as "(not found)" in the editor picker even though
    # `story.preset_lists` has the promoted entry. Same risk on the
    # default-seeds side — the editor only reads the bundled list
    # there too.
    # Conflicts are skipped: the user can resolve them manually
    # after import by renaming the existing list, then re-importing.
    skipped = set(preset_lists_skipped_conflict)
    non_conflict_sources = [
        BundledPresetList(name=pl.name, values=list(pl.values))
        for pl in source.preset_lists
        if pl.name not in skipped
    ]

    stubs_replaced = 0
    stubs_appended = 0
    if mode == "replace":
        current.seeds = source.seeds.model_copy(deep=True)
        stubs_replaced = sum(
            len(getattr(current.seeds, b)) for b in _BUCKET_NAMES
        )
        # Replace mode resets bundled preset lists to match the
        # imported set — user expects "replace" to make the seeds
        # file reflect the imported file's state.
        current.preset_lists = non_conflict_sources
    else:  # append
        for bucket_name in _BUCKET_NAMES:
            target_bucket = getattr(current.seeds, bucket_name)
            for stub in getattr(source.seeds, bucket_name):
                target_bucket.append(stub.model_copy(deep=True))
                stubs_appended += 1
        # Append mode: merge bundled preset lists, dedup by name so
        # a re-import of the same file doesn't stack duplicates.
        bundled_names = {pl.name for pl in current.preset_lists}
        for pl in non_conflict_sources:
            if pl.name not in bundled_names:
                current.preset_lists.append(pl)
                bundled_names.add(pl.name)

    return {
        "mode": mode,
        "preset_lists_created": preset_lists_created,
        "preset_lists_reused": preset_lists_reused,
        "preset_lists_skipped_conflict": preset_lists_skipped_conflict,
        "stubs_replaced": stubs_replaced,
        "stubs_appended": stubs_appended,
    }


def sync_bundled_preset_lists_to_project(
    seeds: SeedsFile, story: "Story"
) -> None:
    """Sync the seeds' bundled preset lists INTO the project's
    `story.preset_lists` by name. Mutates `story.preset_lists` in
    place. Used by `PUT /project/seeds` — the Story Seeds tab treats
    the bundled section as a direct editor of project preset lists, so
    edits here must flow through to the project pool.

    Per-name semantics:
    - If a preset list with the bundled's name already exists in the
      project, its `values` are OVERWRITTEN with the bundled values.
      This is mutation-by-name; the user's edits in the Story Seeds
      tab are the authoritative source for that preset list's values
      at save time.
    - If no project list has the bundled name, a new `PresetList` is
      created (fresh UUID) and appended to `story.preset_lists`.
    - Project preset lists NOT mentioned in `seeds.preset_lists` are
      left entirely alone — removing from bundled doesn't delete from
      the project (users manage deletions via Entity Library).

    This is a DIFFERENT semantic from `merge_import_into_project`,
    which is conservative ("skip on conflict") because imports come
    from a foreign source and shouldn't silently overwrite local
    values. The save path is not foreign: the user is actively editing
    the seeds, so overwrite-by-name is what they mean.
    """
    lists_by_name = {pl.name: pl for pl in story.preset_lists}
    for bundled in seeds.preset_lists:
        if not bundled.name:
            continue
        existing = lists_by_name.get(bundled.name)
        if existing is None:
            new_pl = PresetList(name=bundled.name, values=list(bundled.values))
            story.preset_lists.append(new_pl)
            lists_by_name[new_pl.name] = new_pl
        else:
            existing.values = list(bundled.values)


def auto_bundle_referenced_project_lists(
    seeds: SeedsFile, story: "Story"
) -> None:
    """Auto-add any project preset list referenced by a stub in `seeds`
    to `seeds.preset_lists`, so the saved seeds are self-contained for
    export portability. Mutates `seeds.preset_lists` in place.

    For each `preset_list_name` referenced by a preset-type stub:
    - If the name is already in `seeds.preset_lists` → no-op.
    - Else, if the name exists in `story.preset_lists` → copy the
      project list's name + values into a new `BundledPresetList`.
    - Else (orphan reference — name not found anywhere) → no-op. The
      attribute will be created with `preset_list_id=null` at entity
      creation time and the user can heal by creating the list later.

    Called from `PUT /project/seeds` AFTER
    `sync_bundled_preset_lists_to_project`, so the project pool is
    already up-to-date when we look for referenced names.
    """
    bundled_names = {pl.name for pl in seeds.preset_lists}
    referenced_names: set[str] = set()
    for bucket_name in _BUCKET_NAMES:
        for stub in getattr(seeds.seeds, bucket_name):
            if stub.attribute_type == "preset" and stub.preset_list_name:
                referenced_names.add(stub.preset_list_name)

    project_by_name = {pl.name: pl for pl in story.preset_lists}
    for name in referenced_names:
        if name in bundled_names:
            continue
        project_list = project_by_name.get(name)
        if project_list is None:
            continue
        seeds.preset_lists.append(
            BundledPresetList(name=project_list.name, values=list(project_list.values))
        )
        bundled_names.add(name)


def build_export_bundle(current: SeedsFile, story: "Story") -> SeedsFile:
    """Build a self-contained `SeedsFile` for export.

    Starts from the project's current seeds and adds bundled preset
    lists for every preset list referenced by any preset-type stub.
    The resulting file is round-trip-safe: importing it into a fresh
    project (no pre-existing preset lists) recreates every preset list
    the stubs need, so stub references resolve cleanly on the first
    entity creation after the import.

    Preset lists NOT referenced by any stub are deliberately left out —
    seeds file is about attribute stubs plus their dependencies, not a
    wholesale export of the project's preset-list library. If a user
    wants to ship unreferenced preset lists, a later granular-selection
    UI item will let them opt-in on a per-list basis.
    """
    referenced_names: set[str] = set()
    for bucket_name in _BUCKET_NAMES:
        for stub in getattr(current.seeds, bucket_name):
            if stub.attribute_type == "preset" and stub.preset_list_name:
                referenced_names.add(stub.preset_list_name)

    bundle = current.model_copy(deep=True)
    bundle.preset_lists = []
    story_lists_by_name: dict[str, PresetList] = {
        pl.name: pl for pl in story.preset_lists
    }
    # Iterate stable `story.preset_lists` order rather than the set so
    # the exported file's preset-list order is deterministic.
    for pl in story.preset_lists:
        if pl.name in referenced_names:
            bundle.preset_lists.append(
                BundledPresetList(name=pl.name, values=list(pl.values))
            )
            referenced_names.discard(pl.name)
    # Any names left in `referenced_names` after the loop are stubs
    # pointing at preset lists that don't exist in the project — orphan
    # references. They're not bundled (can't bundle what isn't there);
    # the stubs stay in the export with `preset_list_name` pointing at
    # a name that must be resolved in the target project.

    return bundle
