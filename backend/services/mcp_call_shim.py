"""
Tolerance shim for in-app MCP tool calls (Phase 7.5).

A model driving the tool surface reaches for intuitive tool names and
argument shapes that don't literally match the served catalogue: it calls
`set_scene_pov` (the tool is `set_pov`), `add_scene_participant` (it's
`add_entity_to_scene`), sends `pov_entity` where the arg is `pov_character`,
attaches `attributes` to `update_entity` (attributes go through
`add_attributes`), or stringifies a JSON array. Each of those is a clear,
recoverable intent, but a bare rejection teaches the model nothing and it
loops.

`normalize_call(name, args)` maps those intuitive calls onto the real
tool(s) and canonical argument shape, WITHOUT adding any alias to the served
catalogue (so the token cost of the catalogue is unchanged). It returns an
ordered list of concrete `(tool, args)` calls to execute plus a short human
`note` naming what was remapped; the executor runs the calls and hands the
note back so a capable model converges on the real names and the catalogue
stays the source of truth.

This module is PURE (no I/O, no tool execution) so it is trivially unit
testable. The actual execution + error enrichment lives in
`mcp_tool_bridge.invoke_mcp_tool`. The mapping set is derived from observed
failures (see the Phase 7.5 planning note), not speculation.
"""

from __future__ import annotations

import copy
import json
import re
from typing import Any, Callable, Optional

# Arg names that are meant to carry a JSON array/object. A model sometimes
# passes these as a stringified JSON blob; parse it back so downstream tools
# receive real structures. Scoped to these keys so an ordinary string value
# that merely happens to start with '[' or '{' elsewhere is never touched.
_STRUCTURED_ARGS = {
    "participants", "participant_ids", "attributes", "motivators", "entities",
    "circumstances", "updates", "roles", "aliases", "clear_pins",
    "date", "duration", "gap",
    # awareness + perspective array args (canonical names and the common
    # `observers` alias) so a stringified payload is parsed before element
    # aliasing runs.
    "entries", "observers", "awareness", "sources", "perspectives",
}


def _as_list(val: Any) -> list:
    if isinstance(val, list):
        return val
    if val is None:
        return []
    return [val]


def _flatten_entities(val: Any) -> list:
    """A participants payload may arrive as a flat list, a scalar, or a
    by-type dict (`{"characters": [...], "locations": [...]}`); flatten any of
    those to a single list of entity references."""
    if isinstance(val, dict):
        out: list = []
        for v in val.values():
            if isinstance(v, list):
                out.extend(v)
            elif v is not None:
                out.append(v)
        return out
    return _as_list(val)


def _extract_entity_refs(val: Any) -> list:
    """Pull entity references out of a participants-style payload: a list of
    bare strings and/or `{entity|ref|id|name: X}` objects (the shape the model
    reaches for), or a scalar. Returns a flat list of refs."""
    out: list = []
    for item in _as_list(val):
        if isinstance(item, dict):
            ref = item.get("entity") or item.get("ref") or item.get("id") or item.get("name")
            if ref is not None:
                out.append(ref)
        elif item is not None:
            out.append(item)
    return out


def _coerce_structured(args: dict, notes: list) -> dict:
    """Parse stringified-JSON values for known array/object arg names."""
    for k, v in list(args.items()):
        if k in _STRUCTURED_ARGS and isinstance(v, str):
            s = v.strip()
            if s and s[0] in "[{":
                try:
                    args[k] = json.loads(s)
                    notes.append(f"parsed JSON-string arg '{k}'")
                except Exception:
                    pass
    return args


_GAP_UNIT_ALIASES = {
    "minute": "minutes", "minutes": "minutes", "min": "minutes", "mins": "minutes",
    "hour": "hours", "hours": "hours", "hr": "hours", "hrs": "hours",
    "day": "days", "days": "days",
    "week": "weeks", "weeks": "weeks", "wk": "weeks", "wks": "weeks",
}


def _parse_nl_gap(s: str) -> Optional[dict]:
    """'1 day' / '8 hours' / '15 mins' -> {unit, value}; None when the string
    isn't a single integer + time unit (so prose is left untouched)."""
    m = re.match(r"^\s*(\d+)\s*([a-zA-Z]+)\s*$", s)
    if not m:
        return None
    unit = _GAP_UNIT_ALIASES.get(m.group(2).lower())
    if unit is None:
        return None
    return {"unit": unit, "value": int(m.group(1))}


def _normalize_gap(args: dict, notes: list) -> None:
    """The scene `gap` pin is `{ unit, value }`. Accept `{ amount, unit }`
    (amount -> value) and a natural-language 'N unit' string, so the intuitive
    shapes the model reaches for don't reject."""
    g = args.get("gap")
    if isinstance(g, dict):
        if "amount" in g and "value" not in g:
            g = dict(g)
            g["value"] = g.pop("amount")
            args["gap"] = g
            notes.append("gap: 'amount' -> 'value'")
    elif isinstance(g, str):
        parsed = _parse_nl_gap(g)
        if parsed is not None:
            args["gap"] = parsed
            notes.append(f"gap: parsed '{g.strip()}' -> {{unit, value}}")


# ── Tool-name alias reshapers ────────────────────────────────────────────
# Each returns (canonical_tool_name, canonical_args). Reshaping is needed
# because the intuitive singular tools carry a flat arg set that the real
# plural/batch tools expect wrapped into a one-element array.

_ATTR_NAME_KEYS = ("attribute", "attribute_name", "name")
_POV_CHAR_KEYS = (
    "character", "pov_character", "pov_entity", "pov_character_id",
    "pov_entity_id", "entity", "character_id",
)


def _reshape_set_pov(a: dict) -> tuple[str, dict]:
    a = dict(a)
    char = None
    for k in _POV_CHAR_KEYS:
        if k in a:
            char = a[k]
            break
    out: dict = {"scene": a.get("scene")}
    if char is not None:
        out["character"] = char
    return "set_pov", out


def _reshape_add_entity_to_scene(a: dict) -> dict:
    a = dict(a)
    # The model reaches for either a singular `entity` or a relationship-style
    # `participants` list (`[{entity: X}, ...]`); normalise both to `entities`.
    if "entities" not in a:
        if "participants" in a:
            a["entities"] = _extract_entity_refs(a.get("participants"))
        elif "entity" in a:
            a["entities"] = _as_list(a.get("entity"))
    a.pop("participants", None)
    a.pop("entity", None)
    return a  # `as_pov`, if present, is handled by the cross-tool step


def _resolve_add_participant(a: dict) -> tuple[str, dict]:
    # Ambiguous name: relationship context -> add_participants; scene
    # context -> add_entity_to_scene. Disambiguate by which anchor is present.
    if "relationship" in a and "scene" not in a:
        a = dict(a)
        if "entity" in a and "participants" not in a:
            a["participants"] = _as_list(a.pop("entity"))
        return "add_participants", a
    return "add_entity_to_scene", _reshape_add_entity_to_scene(a)


def _reshape_circumstances(a: dict) -> tuple[str, dict]:
    a = dict(a)
    target = a.pop("target", None) or a.pop("entity", None)
    at = a.pop("at", None)
    passthrough = {k: a.pop(k) for k in ("is_temporary", "track_as_knowledge") if k in a}
    a.pop("scene", None)
    out: dict = {"target": target, "circumstances": [a]}  # remaining keys form one element
    if at is not None:
        out["at"] = at
    out.update(passthrough)
    return "add_circumstances", out


def _reshape_motivators(a: dict) -> tuple[str, dict]:
    a = dict(a)
    entity = a.pop("entity", None) or a.pop("target", None)
    at = a.pop("at", None)
    passthrough = {k: a.pop(k) for k in ("is_temporary", "track_as_knowledge") if k in a}
    out: dict = {"entity": entity, "motivators": [a]}
    if at is not None:
        out["at"] = at
    out.update(passthrough)
    return "add_motivators", out


def _reshape_attributes(a: dict) -> tuple[str, dict]:
    a = dict(a)
    entity = a.pop("entity", None)
    at = a.pop("at", None)
    tak = a.pop("track_as_knowledge", None)
    name = None
    for k in _ATTR_NAME_KEYS:
        if k in a:
            name = a.pop(k)
            break
    if name is not None:
        a["name"] = name
    out: dict = {"entity": entity, "attributes": [a]}  # remaining keys = element fields
    if at is not None:
        out["at"] = at
    if tak is not None:
        out["track_as_knowledge"] = tak
    return "add_attributes", out


def _reshape_add_aliases(a: dict) -> tuple[str, dict]:
    a = dict(a)
    if "aliases" not in a and "alias" in a:
        a["aliases"] = _as_list(a.get("alias"))
    a.pop("alias", None)
    return "add_aliases", a


def _resolve_add_participants(a: dict) -> tuple[str, dict]:
    # add_participants is the RELATIONSHIP participant tool. The model also
    # calls it with a `scene` for scene participants — route those to
    # add_entity_to_scene; otherwise pass through unchanged.
    if "scene" in a and "relationship" not in a:
        return "add_entity_to_scene", _reshape_add_entity_to_scene(a)
    return "add_participants", dict(a)


def _make_flat_awareness_resolver(
    canonical: str, entity_is_observer: bool = False
) -> Callable[[dict], tuple[str, dict]]:
    # The awareness setters take `entries=[{observer, level, at?}]`; the model
    # sometimes passes a single `observer` / `level` (+ top-level `at`) flat.
    # Wrap those into a one-element entries list. When `entity_is_observer`
    # (knowledge / relationship setters, whose TARGET is the knowledge /
    # relationship — NOT an entity), a top-level `entity` is the observer too.
    def _resolve(a: dict) -> tuple[str, dict]:
        a = dict(a)
        has_flat = "observer" in a or "level" in a or (entity_is_observer and "entity" in a)
        if "entries" not in a and has_flat:
            entry: dict = {}
            observer = a.pop("observer", None)
            if observer is None and entity_is_observer and "entity" in a:
                observer = a.pop("entity")
            if observer is not None:
                entry["observer"] = observer
            if "level" in a:
                entry["level"] = a.pop("level")
            at = a.pop("at", None)
            if at is not None:
                entry["at"] = at
            a["entries"] = [entry]
        return canonical, a
    return _resolve


def _reshape_update_attribute(a: dict) -> tuple[str, dict]:
    # Singular update: flat {entity, attribute|name|id, value, at?} -> the
    # batch update_attributes shape {entity, updates:[{attribute, ...}], at?}.
    a = dict(a)
    entity = a.pop("entity", None) or a.pop("target", None)
    at = a.pop("at", None)
    attr = None
    for k in _ATTR_NAME_KEYS + ("id",):
        if k in a:
            attr = a.pop(k)
            break
    item: dict = dict(a)  # remaining keys = the fields to change (value, etc.)
    if attr is not None:
        item["attribute"] = attr
    out: dict = {"entity": entity, "updates": [item]}
    if at is not None:
        out["at"] = at
    return "update_attributes", out


def _reshape_update_name(a: dict) -> tuple[str, dict]:
    a = dict(a)
    if "new_name" in a and "name" not in a:
        a["name"] = a.pop("new_name")
    return "update_entity", a


def _make_create_entity(entity_type: str) -> Callable[[dict], tuple[str, dict]]:
    def _reshape(a: dict) -> tuple[str, dict]:
        a = dict(a)
        a.setdefault("type", entity_type)
        return "create_entity", a
    return _reshape


# alias name -> resolver(args) -> (canonical_name, canonical_args)
_TOOL_ALIASES: dict[str, Callable[[dict], tuple[str, dict]]] = {
    "set_scene_pov": _reshape_set_pov,
    "update_name": _reshape_update_name,
    "create_character": _make_create_entity("character"),
    "create_location": _make_create_entity("location"),
    "create_item": _make_create_entity("item"),
    "create_faction": _make_create_entity("faction"),
    "create_custom": _make_create_entity("custom"),
    "add_scene_participant": lambda a: ("add_entity_to_scene", _reshape_add_entity_to_scene(a)),
    "add_scene_participants": lambda a: ("add_entity_to_scene", _reshape_add_entity_to_scene(a)),
    "add_participant": _resolve_add_participant,
    "add_participants": _resolve_add_participants,
    "add_relationship_participants": lambda a: ("add_participants", dict(a)),
    "add_alias": _reshape_add_aliases,
    "add_circumstance": _reshape_circumstances,
    "add_motivator": _reshape_motivators,
    "set_attribute": _reshape_attributes,
    "create_attribute": _reshape_attributes,
    "add_entity_attribute": _reshape_attributes,
    "update_attribute": _reshape_update_attribute,
    "add_entity_circumstance": _reshape_circumstances,
    "add_entity_motivator": _reshape_motivators,
}


# ── Within-tool argument-name aliases ────────────────────────────────────
_SCENE_POV_ALIASES = {
    "pov_character_id": "pov_character",
    "pov_entity_id": "pov_character",
    "pov_entity": "pov_character",
}
_AWARENESS_SETTERS = (
    "set_entity_awareness", "set_attribute_awareness", "set_alias_awareness",
    "set_relationship_awareness", "set_knowledge_awareness",
)
# The awareness setters also accept a flat single-observer shape (observer /
# level / at at the top level) — wrap it into a one-element entries list.
# `entity` at the top level is the OBSERVER only for setters whose TARGET is
# not an entity (knowledge / relationship); for entity / attribute / alias
# awareness `entity` identifies the target, so it is NOT treated as observer.
_AWARENESS_ENTITY_IS_OBSERVER = ("set_relationship_awareness", "set_knowledge_awareness")
_TOOL_ALIASES.update({
    s: _make_flat_awareness_resolver(s, s in _AWARENESS_ENTITY_IS_OBSERVER)
    for s in _AWARENESS_SETTERS
})
_SCENE_ARG_ALIASES = {
    **_SCENE_POV_ALIASES,
    "summary": "description",
    "position_after": "pov_after",
    "position_before": "pov_before",
}
_ARG_ALIASES: dict[str, dict[str, str]] = {
    "create_scene": dict(_SCENE_ARG_ALIASES),
    "update_scene": dict(_SCENE_ARG_ALIASES),
    "create_entity": {"color": "colour"},
    "update_entity": {"color": "colour"},
    "update_chapter": {"color": "colour"},
    "create_custom_category": {"color": "colour"},
    "update_custom_category": {"color": "colour"},
    "add_circumstances": {"entity": "target"},
    "add_motivators": {"target": "entity"},
    "update_attributes": {"target": "entity", "attributes": "updates"},
    # awareness setters take `entries` (observers) + `sources`; the model
    # reaches for `observers` or `awareness`.
    **{s: {"observers": "entries", "awareness": "entries"} for s in _AWARENESS_SETTERS},
}

# Rename keys INSIDE the elements of a tool's array argument, applied after
# arg-name aliasing so the array is already under its canonical name. The
# model builds an `update_attributes` update element with `name` (the tool
# wants `attribute`, the identifier) and an awareness `entries` element with
# `entity` (the tool wants `observer`).
_ELEMENT_KEY_ALIASES: dict[tuple[str, str], dict[str, str]] = {
    # update_attributes identifies the target attribute by `attribute` (ref);
    # the model reaches for `name` or the attribute's `id`.
    ("update_attributes", "updates"): {"name": "attribute", "id": "attribute"},
    # relationship participant objects reference the entity by `entity`; the
    # model reaches for `entity_id`.
    ("add_participants", "participants"): {"entity_id": "entity"},
    **{(s, "entries"): {"entity": "observer"} for s in _AWARENESS_SETTERS},
}

# Args the model passes as a scalar where the tool wants a one-element list.
# Applies to the canonical tool as well as the alias path.
_SINGULAR_TO_LIST: dict[str, dict[str, str]] = {
    "add_entity_to_scene": {"entity": "entities"},
}

# Args with no home on the tool that are an unambiguous no-op synonym of an
# existing field: dropped with a note rather than left to `extra_forbidden`.
# Kept deliberately narrow and evidence-based (not a blanket "ignore extras").
_DROP_ARGS: dict[str, dict[str, str]] = {
    "create_chapter": {"display_title": "chapters have a single title; use `title`"},
}


# ── Cross-tool argument routing ──────────────────────────────────────────
# An argument attached to a tool that has no home for it, but whose intent
# maps cleanly onto a sibling tool. builder(remaining_args, value) ->
# (tool, args, note) or None to skip.

def _b_scene_participants(rem: dict, val: Any):
    return ("add_entity_to_scene",
            {"scene": rem.get("scene"), "entities": _flatten_entities(val)},
            "participants routed to add_entity_to_scene")


def _b_entity_attributes(rem: dict, val: Any):
    out = {"entity": rem.get("entity"), "attributes": _as_list(val)}
    if "at" in rem:
        out["at"] = rem["at"]
    return ("add_attributes", out, "attributes routed to add_attributes")


def _b_entity_motivators(rem: dict, val: Any):
    out = {"entity": rem.get("entity"), "motivators": _as_list(val)}
    if "at" in rem:
        out["at"] = rem["at"]
    return ("add_motivators", out, "motivators routed to add_motivators")


def _b_chapter_colour(rem: dict, val: Any):
    return ("update_chapter",
            {"chapter": rem.get("title"), "colour": val},
            "colour routed to update_chapter after create")


def _b_scene_as_pov(rem: dict, val: Any):
    if not val or (isinstance(val, str) and val.strip().lower() in ("false", "0", "no", "")):
        return None
    ents = rem.get("entities") or []
    return ("set_pov",
            {"scene": rem.get("scene"), "character": ents[0] if ents else None},
            "as_pov routed to set_pov")


def _b_scene_location(rem: dict, val: Any):
    # A scene has no `location` field — the location is added as a scene
    # participant. On create_scene the scene identity is `title`; on
    # update_scene it's `scene`.
    return ("add_entity_to_scene",
            {"scene": rem.get("scene") or rem.get("title"), "entities": _extract_entity_refs(val)},
            "location routed to add_entity_to_scene")


_CROSS_TOOL: dict[str, list[tuple[str, Callable]]] = {
    "create_scene": [("location", _b_scene_location)],
    "update_scene": [("participant_ids", _b_scene_participants),
                     ("participants", _b_scene_participants),
                     ("location", _b_scene_location)],
    "update_entity": [("attributes", _b_entity_attributes),
                      ("motivators", _b_entity_motivators)],
    "create_chapter": [("colour", _b_chapter_colour), ("color", _b_chapter_colour)],
    "add_entity_to_scene": [("as_pov", _b_scene_as_pov)],
}

# When every mutating field has been routed away, the primary call is left
# holding only identity/anchor keys and would be a no-op (or error); drop it.
_IDENTITY_ONLY: dict[str, set] = {
    "update_scene": {"scene"},
    "update_entity": {"entity", "at"},
}


def _is_empty_primary(tool: str, args: dict) -> bool:
    ident = _IDENTITY_ONLY.get(tool)
    return ident is not None and set(args.keys()) <= ident


def normalize_call(name: str, arguments: Optional[dict]) -> dict:
    """Map an intuitive (name, args) call onto canonical tool call(s).

    Returns `{"calls": [(tool, args), ...], "note": str | None}`. `calls` is
    ordered and usually length 1; a cross-tool arg produces a second call.
    `note` names every remap applied (None when nothing changed, i.e. the
    call was already canonical)."""
    args: dict = copy.deepcopy(dict(arguments or {}))  # deep copy: element-key
    notes: list[str] = []                              # renames mutate nested dicts

    # Parse stringified-JSON structured args FIRST, so the tool-name reshapers
    # below (which extract entity refs from a `participants` list, wrap arrays,
    # etc.) operate on real structures rather than a raw JSON string.
    _coerce_structured(args, notes)
    # Normalise the scene `gap` pin shape ({amount->value}, 'N unit' strings)
    # before any tool-name reshaping (gap only rides the scene tools, which
    # are not themselves aliased).
    _normalize_gap(args, notes)

    canonical = name
    if name in _TOOL_ALIASES:
        canonical, args = _TOOL_ALIASES[name](args)
        # Some resolvers are args-conditional (e.g. add_participants,
        # the awareness setters) and may return the same canonical name —
        # only note an actual rename.
        if canonical != name:
            notes.append(f"resolved tool '{name}' -> '{canonical}'")

    for wrong, right in _ARG_ALIASES.get(canonical, {}).items():
        if wrong in args and right not in args:
            args[right] = args.pop(wrong)
            notes.append(f"arg '{wrong}' -> '{right}'")

    for singular, plural in _SINGULAR_TO_LIST.get(canonical, {}).items():
        if singular in args and plural not in args:
            args[plural] = _as_list(args.pop(singular))
            notes.append(f"arg '{singular}' -> '{plural}' (wrapped as list)")

    for arg, reason in _DROP_ARGS.get(canonical, {}).items():
        if arg in args:
            args.pop(arg)
            notes.append(f"ignored unsupported arg '{arg}' ({reason})")

    for (tool, arg), keymap in _ELEMENT_KEY_ALIASES.items():
        if tool != canonical or not isinstance(args.get(arg), list):
            continue
        renamed = False
        for element in args[arg]:
            if isinstance(element, dict):
                for wrong, right in keymap.items():
                    if wrong in element and right not in element:
                        element[right] = element.pop(wrong)
                        renamed = True
        if renamed:
            pairs = ", ".join(f"{w}->{r}" for w, r in keymap.items())
            notes.append(f"renamed element key(s) in '{arg}' ({pairs})")

    extra: list[tuple[str, dict]] = []
    for trigger, builder in _CROSS_TOOL.get(canonical, []):
        if args.get(trigger) is not None:
            built = builder(args, args.pop(trigger))
            if built:
                extra.append((built[0], built[1]))
                notes.append(built[2])
        elif trigger in args:
            args.pop(trigger)  # strip an explicit null so it can't extra_forbid

    calls: list[tuple[str, dict]] = []
    if not _is_empty_primary(canonical, args):
        calls.append((canonical, args))
    calls.extend(extra)
    if not calls:
        calls = [(canonical, args)]

    return {"calls": calls, "note": "; ".join(notes) if notes else None}
