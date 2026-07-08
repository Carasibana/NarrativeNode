"""Phase 1.25a — Export preset registry (server-side stub).

Each export request now carries a `preset_key` field on `ExportOptions`
indicating which preset the writer chose in the dialog (NarrativeNode
native / Shunn manuscript / NovelCrafter format / Customize). In Phase
1.25a, preset SEMANTICS — the per-preset toggle bundles that decide
which Changes blocks / entity sheets / etc. ship in the output — live
on the FRONTEND. The dialog applies the chosen preset's bundle to its
local toggle state before constructing the export request, and the
backend receives the resulting toggles as it always has.

This module is the server-side hook that future phases can grow into
when / if preset enforcement needs to move server-side (e.g. for an
HTTP API client that posts a preset_key without sending matching
toggles, or for tighter consistency between dialog and renderer).
For 1.25a it's a no-op — the function returns the options unchanged.

Why ship the hook anyway: it gives the implementation plan a stable
surface to extend (one function, one module) instead of having to
rediscover the layering decision when 1.25e or later wants to enforce
preset constraints from the server side.
"""
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .export_service import ExportOptions


# Set of preset keys the frontend may send. Kept here (not on
# ExportOptions itself) so future server-side enforcement code in this
# module can iterate the known set without importing the dataclass.
KNOWN_PRESETS = frozenset({"native", "shunn", "novelcrafter", "customize"})


def apply_preset_defaults(opts: "ExportOptions", preset_key: str) -> "ExportOptions":
    """Hook for future server-side preset enforcement. No-op in Phase 1.25a.

    In 1.25a the frontend dialog has already applied the chosen
    preset's toggle bundle to `opts` before the request was POSTed, so
    this function returns its argument unchanged. Future phases that
    need to second-guess the dialog (e.g. a CLI client that doesn't
    know the bundles, or a tightening of preset consistency) can grow
    branches here without touching `export_service.py` or the router.

    Args:
        opts: the populated ExportOptions dataclass.
        preset_key: one of the values in `KNOWN_PRESETS`. Unknown
            keys are accepted silently — the contract is "do nothing
            harmful with unknown input"; the type-level Literal on
            ExportOptions is the actual gate against typos.

    Returns:
        The same ExportOptions instance, unchanged. Returned (rather
        than mutated-in-place-without-return) so callers can chain
        the call cleanly: `opts = apply_preset_defaults(opts, key)`.
    """
    return opts
