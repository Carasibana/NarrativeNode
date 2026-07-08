"""Shared display-label resolver for Relationship objects.

Used wherever a relationship needs a human-readable name: routers, exporters,
renderers, and any future consumers. Three-tier fallback:

  1. Effective chain name (latest non-None `history.name_changes` entry up to
     and including the active anchor) when present, else `relationship.name`
     if set by the user.
  2. If membership_of is set:
       - With hierarchy element  -> "[parent name] Contents"
       - Without hierarchy element -> "[parent name] Members"
  3. Generic synthesis from participant names:
       - 2 participants  -> "Alice + Bob"
       - 3 to 4          -> "Alice + Bob + Carol"
       - 5+              -> "Alice + Bob + 3 more"
"""

from typing import Optional

from models.entity import Relationship


def resolve_relationship_label(
    relationship: Relationship,
    entity_name_map: dict[str, str],
    *,
    anchor_chain_index: Optional[int] = None,
    chain_index_by_node: Optional[dict[str, int]] = None,
) -> str:
    """Return the display label for `relationship`.

    `entity_name_map` maps entity_id -> current display name; used for tiers
    2 and 3. Callers should build this from the chain-effective names at the
    relevant narrative position, or from base entity names when chain context
    is unavailable.

    Phase 1.25c — `anchor_chain_index` + `chain_index_by_node` together let
    callers scope the chain-tracked `history.name_changes` lookup to events
    at-or-before a specific chain position (e.g. the export scope boundary,
    or the scene currently being rendered). When either is missing, the
    resolver applies the latest non-None name_change in the array (best-
    effort, treats array order as chain order) so the chain rename still
    propagates through to most callers without them having to plumb an
    anchor through.
    """
    # Tier 1: chain-tracked name override (history.name_changes filtered to
    # the anchor) wins; fall back to baseline `relationship.name`.
    chain_name = _effective_chain_name(
        relationship,
        anchor_chain_index=anchor_chain_index,
        chain_index_by_node=chain_index_by_node,
    )
    if chain_name:
        return chain_name
    if relationship.name:
        return relationship.name

    # Tier 2: membership_of provenance
    if relationship.membership_of:
        parent_name = entity_name_map.get(relationship.membership_of, "Unknown")
        if relationship.hierarchy is not None:
            return f"{parent_name} Contents"
        return f"{parent_name} Members"

    # Tier 3: participant synthesis — derive unique joiners from history
    # (preserving first-join order). After the history-only refactor there is
    # no base `participants` mirror; we compute the participant set from the
    # `join` events in `history.participant_changes`.
    seen: set[str] = set()
    participant_ids: list[str] = []
    for ch in relationship.history.participant_changes:
        if ch.action == "join" and ch.entity_id not in seen:
            seen.add(ch.entity_id)
            participant_ids.append(ch.entity_id)
    names = [entity_name_map.get(eid, "Unknown") for eid in participant_ids]

    if len(names) == 0:
        return "Unnamed Relationship"
    if len(names) <= 4:
        return " + ".join(names)
    overflow = len(names) - 2
    return f"{names[0]} + {names[1]} + {overflow} more"


def _effective_chain_name(
    relationship: Relationship,
    *,
    anchor_chain_index: Optional[int],
    chain_index_by_node: Optional[dict[str, int]],
) -> Optional[str]:
    """Return the latest non-None `new_name` from `history.name_changes`
    that's at-or-before the given anchor, or None when no chain rename
    is in effect.

    When both `anchor_chain_index` and `chain_index_by_node` are
    provided, only entries whose node's chain index is ≤ the anchor
    are considered. When either is missing, every entry counts and
    the resolver picks the latest in array order — best-effort,
    treats array order as chain order.
    """
    changes = list(getattr(relationship.history, "name_changes", None) or [])
    if not changes:
        return None
    if anchor_chain_index is not None and chain_index_by_node is not None:
        eligible = []
        for ch in changes:
            idx = chain_index_by_node.get(getattr(ch, "node_id", ""))
            if idx is None:
                continue
            if idx <= anchor_chain_index:
                eligible.append((idx, ch))
        if not eligible:
            return None
        eligible.sort(key=lambda pair: pair[0])
        last = eligible[-1][1]
        new_name = getattr(last, "new_name", None)
        return new_name or None
    # No anchor — take last non-None new_name in array order.
    last_name: Optional[str] = None
    for ch in changes:
        nn = getattr(ch, "new_name", None)
        if nn is not None:
            last_name = nn
    return last_name or None
