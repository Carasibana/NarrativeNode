from __future__ import annotations
from typing import Literal, Optional
from pydantic import BaseModel, ConfigDict, Field

# Same drop-unknowns rule as every other persisted model: any JSON key
# not declared on the current schema is dropped at validation time, so
# saves only ever contain the current shape. Future legacy handlers, if
# the shape ever changes post-release, declare a `mode='before'`
# validator that converts the old fields into the new shape.
_foreign_content_ok = ConfigDict(extra="ignore")


# Phase 1.25g (Bug 6) — restrict `SeedStub.attribute_type` to the
# allow-list the entity-attribute model itself accepts. A hand-edited
# `default_seeds.json` with an invalid type used to crash entity
# creation downstream; with the Literal here, Pydantic catches it
# at load time with a clear validation message.
SeedAttributeType = Literal[
    "text", "file", "preset", "entity_list", "text_list",
    "circumstance", "motivator", "number",
]


class SeedStub(BaseModel):
    """A single attribute stub in the seeds file. When a new entity of
    the parent's type is created, every stub produces one fresh
    Attribute on that entity: a new UUID, `name` and `attribute_type`
    copied from the stub, value initialised from `default_value`.

    For `attribute_type == "preset"`, `preset_list_name` names a
    preset list in the project's `story.preset_lists`. Name-based
    reference (not UUID) so the seeds file is portable across
    projects — on import, bundled preset lists are matched / merged by
    name into the target's `story.preset_lists` before stubs are
    applied.
    """
    model_config = _foreign_content_ok
    name: str
    attribute_type: SeedAttributeType
    default_value: Optional[str] = None
    preset_list_name: Optional[str] = None


class SeedsByType(BaseModel):
    """Per-entity-type stub lists. Key names match the codebase's
    existing singular-lowercase entity-type convention.

    `knowledge` is **vestigial** — preserved only for save-format
    compatibility with pre-Phase-1.21c saves. Pre-1.21c, Knowledge was
    an Entity subtype (a regular `Entity` with `type='knowledge'`)
    that carried user-defined attributes like every other entity, so
    seeding it made sense. Phase 1.21c split Knowledge into a first-
    class object with a fixed schema (name / description / colour /
    profile_image / notes / awareness / source_event / history) — no
    attributes — and moved it off `Story.entities.knowledges` onto
    `Story.knowledges`. The field stays here so any v0.1.25.0+ save
    that carries an empty `knowledge: []` round-trips cleanly; no
    UI exposes it, no apply path consumes it.
    """
    model_config = _foreign_content_ok
    character: list[SeedStub] = Field(default_factory=list)
    location: list[SeedStub] = Field(default_factory=list)
    item: list[SeedStub] = Field(default_factory=list)
    faction: list[SeedStub] = Field(default_factory=list)
    custom: list[SeedStub] = Field(default_factory=list)
    knowledge: list[SeedStub] = Field(default_factory=list)  # vestigial — see class docstring


class BundledPresetList(BaseModel):
    """A preset list bundled inside an exported seeds file. No ID —
    fresh UUIDs are minted when the seeds file is applied to a target
    project. Stubs reference bundled preset lists by name so no UUID
    remapping is needed.
    """
    model_config = _foreign_content_ok
    name: str
    values: list[str] = Field(default_factory=list)


class SeedsFile(BaseModel):
    """Top-level container for the `seeds.json` file.

    Stored at the root of a `.nnz` archive alongside `narrative.json`.
    Also the serialisation format for standalone exported seeds files.
    The file is entirely optional — projects without seeds don't
    write it, and legacy `.nnz` files pre-dating the feature load as
    empty seeds.

    When stored inside a project's own `.nnz`, `preset_lists` is
    typically empty and stubs reference the project's own
    `story.preset_lists` by name. When exported or read from another
    project's `.nnz`, `preset_lists` can carry bundled preset lists to
    be merged into the target project on import.
    """
    model_config = _foreign_content_ok
    version: str = "0.1.14.0"
    seeds: SeedsByType = Field(default_factory=SeedsByType)
    preset_lists: list[BundledPresetList] = Field(default_factory=list)
    # Phase 1.25g (Bug 7) — per-capability reader floor. Mirrors the
    # project file's `min_reader_versions` design: a future breaking
    # seeds change records the minimum reader version for the
    # capability that broke, so older builds can fail-fast at load
    # time with a structured message instead of misinterpreting the
    # new shape. Empty dict on legacy files = "any reader can load
    # me", consistent with the v0.1.14.0 schema. Keys are capability
    # names (e.g. `seeds_v2`, `bundled_preset_lists_v2`); values are
    # the minimum NarrativeNode version that can correctly load that
    # capability. See `docs/save-format-versioning.md` for the full
    # semantics on the project-file side.
    min_reader_versions: dict[str, str] = Field(default_factory=dict)

    def is_empty(self) -> bool:
        """True iff this seeds file has no stubs AND no bundled preset
        lists. `pack_project` skips writing `seeds.json` when empty so
        projects that never touch seeds have zero-byte overhead in
        their save file.
        """
        s = self.seeds
        if s.character or s.location or s.item or s.faction or s.custom or s.knowledge:
            return False
        if self.preset_lists:
            return False
        return True
