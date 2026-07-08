"""
Renderer registry — Phase 1.12a modular export pipeline.

Each export format lives in its own module under
`backend/services/renderers/` and self-registers a `RendererSpec` at
import time. The router imports the `renderers` package, which in
turn imports every renderer module, triggering their registration
side-effects. From that point on, `get_renderer(format_id)` returns
the spec for any known format, and `all_renderers()` enumerates
every format that's currently installed.

See `docs/export-renderer-guide.md` for a step-by-step guide to
adding a new renderer.

Interface contract for renderer modules
---------------------------------------
Every renderer module must expose:

  SPEC: RendererSpec
      Dataclass with format_id / label / extension / mime_type / render.

  render(model: ExportModel, options: ExportOptions) -> bytes
      The function referenced by SPEC.render. Must return raw bytes,
      not str — text formats like HTML / Markdown / TXT encode to
      UTF-8 at the renderer boundary so every format has a uniform
      signature, and the router can stream output through
      `fastapi.Response` without per-format special-casing.

And must call:

  register(SPEC)
      At module import time, so the registry is populated before the
      first request hits the router.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, FrozenSet, List, Mapping, Optional

from services.export_service import ExportModel, ExportOptions


RenderFunc = Callable[[ExportModel, ExportOptions], bytes]


# ── Capability tags ────────────────────────────────────────────────────
#
# A renderer declares the set of capability tags it supports on its
# `RendererSpec.capabilities`. The frontend Export dialog consults this
# set (via the `GET /api/project/export/formats` endpoint) to decide
# which toggles are meaningful for the currently-selected format and
# to hide the ones that aren't.
#
# Capability tags are deliberately coarse — one tag per "family of
# toggles" rather than one per option field. That keeps the declaration
# short and the gating logic in the frontend simple.
#
# The full catalogue of supported capability tags lives in
# `docs/export-renderer-guide.md` (section "Capabilities") with a
# description of each one, the `ExportOptions` fields it gates, and
# the `ExportModel` fields the renderer is expected to consume when
# it declares the capability. Keep this set and that doc in sync.

KNOWN_CAPABILITIES: FrozenSet[str] = frozenset({
    "pagination",
    "embedded_assets",
    "embedded_media",
    "entity_colours",
    "entity_links",
})


@dataclass(frozen=True)
class RendererSpec:
    format_id: str     # URL slug used in POST /api/project/export/{format_id}
    label: str         # human-readable format name shown in UI, e.g. "HTML"
    extension: str     # file extension WITHOUT the leading dot, e.g. "html"
    mime_type: str     # full Content-Type header value
    render: RenderFunc
    capabilities: FrozenSet[str] = field(default_factory=frozenset)
    # Variant metadata. When `variant_of` is set, this renderer is a
    # sub-variant of another renderer and is hidden from the Format
    # picker at the top of the Export dialog. It shows up instead
    # under a "Layout" sub-picker beneath the Format section, labelled
    # with `variant_label`. Purely a presentation hint — variants are
    # otherwise ordinary renderers with their own SPEC, their own
    # `render(model, options) -> bytes` function, and their own
    # registration. See `docs/export-renderer-guide.md` section
    # "Variants" for the full contract.
    #
    # `variant_of` is the format_id of the parent format (e.g. "markdown"
    # for a markdown variant). The base format itself sets this to None.
    # `variant_label` is the short label rendered in the Layout radio
    # group, e.g. "NovelCrafter". Base formats should either set this
    # to None (interpreted as "Standard") or leave it alone.
    variant_of: Optional[str] = None
    variant_label: Optional[str] = None
    # Options this renderer requires to be in a specific state
    # regardless of what the caller sent in the POST body. The router
    # applies these overrides to the user's `ExportOptions` BEFORE
    # calling `build_export_model`, so the walker produces a model
    # shape the renderer can actually consume. Use sparingly —
    # normally renderers honour whatever the user toggled; this
    # field exists for renderers whose output is structurally
    # impossible without certain data being present.
    #
    # Example: the `markdown-novelcrafter` variant always needs
    # entity reference sheets to be populated (its entity codex
    # file is built from them), so it declares
    # `required_options={"include_entity_sheets": True}`. Without
    # that, a user who had `include_entity_sheets=False` in their
    # Customise toggles would get a NovelCrafter zip with an empty
    # entities.md file.
    #
    # Keys must match real `ExportOptions` field names. Values are
    # applied via `setattr(options, key, value)` — no type checking.
    required_options: Optional[Mapping[str, Any]] = None
    # When True, this renderer is hidden from the Format picker
    # endpoint (`GET /api/project/export/formats`) but still
    # callable directly via POST /api/project/export/{format_id}.
    # Used for download-variant slugs that the dialog dispatches to
    # via buttons rather than as a user-pickable format. Example:
    # NovelCrafter's three-button download (story / codex / bundle)
    # is wired so the dialog shows the umbrella format only and the
    # three buttons each POST to a different hidden variant slug.
    hidden_from_picker: bool = False


_REGISTRY: Dict[str, RendererSpec] = {}


def register(spec: RendererSpec) -> None:
    if spec.format_id in _REGISTRY:
        raise ValueError(f"Renderer already registered: {spec.format_id!r}")
    _REGISTRY[spec.format_id] = spec


def get_renderer(format_id: str) -> RendererSpec:
    try:
        return _REGISTRY[format_id]
    except KeyError as e:
        raise KeyError(f"Unknown export format: {format_id!r}") from e


def all_renderers() -> List[RendererSpec]:
    return list(_REGISTRY.values())
