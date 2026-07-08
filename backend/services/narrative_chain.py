"""Backend port of the entity narrative chain walker.

⚠ PARITY REQUIREMENT — KEEP IN LOCKSTEP WITH FRONTEND ⚠
This module is a parallel Python implementation of the JavaScript function
`frontend/src/utils/narrativeChain.js#getEntityNarrativeChain`. The two
are NOT a shared module — they are SEPARATE codebases (JS in the browser,
Python in FastAPI). They MUST produce identical chain ordering for the
same `(entity, story)` pair, because backend walkers (entity import,
export, etc.) rely on producing the same effective state the frontend's
`computeEffectiveState` shows the user.

There is no automation enforcing parity. If you change the chain-walk
rules in either file (edge-priority preference, scene/modifier inclusion
criteria, cycle handling, etc.) you MUST update the other in the SAME
commit. Drift between the two is a chain-of-history correctness bug —
silent data divergence between what the user sees in the UI and what the
backend exports / imports.

Single source of truth FOR THE BACKEND for "what is the ordered list of
nodes that make up an entity's own narrative chain" — replaces the
previously-duplicated POV-iteration walkers that lived inside
entity_import_service.py and export_service.py.

Why this exists:
  The entity's narrative chain is NOT the POV chain. POV chain is the
  export order across the WHOLE story; the entity chain is per-entity,
  walking from the entity's origin EntityNode forward through whichever
  connections this entity's chip output handle wires into. An entity can
  appear in scenes that aren't on the POV chain at all; conversely a POV
  scene may have no chip for this entity. Walkers that iterate the POV
  sequence (which is how the original backend import + export walkers
  were written) silently lose every change made to the entity at an
  off-POV scene — confirmed by the v0.2.1.86 alias-drop report.

What "narrative chain" means here:
  chain[0] is always the entity's origin EntityNode (the one with
  `node_type='entity'`, `entity_id == this`, `is_modifier=False`).
  Each subsequent entry is either:
    - a SceneNode where this entity has an EntityRef, OR
    - a modifier EntityNode for this entity (`is_modifier=True`,
      `entity_id == this`).
  The walk follows `Connection` edges from each node:
    - From an EntityNode: prefer narrative-flow edges (`is_relationship=False`);
      fall back to a relationship edge only if no flow edge exists (mirrors
      the frontend's "entity introduced into narrative solely via a Case 2
      wire" fallback).
    - From a SceneNode: only follow narrative-flow edges whose
      `source_entity_id` matches this entity (the entity's own chip
      output handle). Relationship edges (`is_relationship=True`) are
      never chain links.
  The walk stops at the first node with no eligible outgoing edge, or
  on the first revisit (cycle guard).
"""

from __future__ import annotations

from typing import Union

from models.entity import Entity
from models.node import SceneNode, EntityNode
from models.story import Story


# Bucket names that may carry EntityRefs on a SceneNode. Matches the
# frontend's `ENTITY_BUCKETS` constant.
_ENTITY_BUCKETS = ("characters", "locations", "items", "factions", "customs")


ChainNode = Union[EntityNode, SceneNode]


def get_entity_narrative_chain(entity_id: str, story: Story) -> list[ChainNode]:
    """Return the ordered list of nodes in this entity's narrative chain.

    Direct port of the frontend's `getEntityNarrativeChain` so backend
    state walks produce identical ordering to frontend reads.

    Args:
      entity_id: the entity whose chain to build.
      story:     the Story to walk. Reads `story.entity_nodes`,
                 `story.scenes`, and `story.connections`.

    Returns:
      Ordered list of node objects. Empty if the entity has no origin
      EntityNode in this story. `chain[0]` is always the origin
      EntityNode when non-empty.
    """
    # Find the entity's origin EntityNode (non-modifier).
    origin_node: EntityNode | None = next(
        (
            n for n in (story.entity_nodes or [])
            if getattr(n, "entity_id", None) == entity_id
            and not getattr(n, "is_modifier", False)
        ),
        None,
    )
    if origin_node is None:
        return []

    # Index nodes by id for O(1) lookups during the walk.
    entity_nodes_by_id: dict[str, EntityNode] = {n.id: n for n in (story.entity_nodes or [])}
    scenes_by_id: dict[str, SceneNode] = {s.id: s for s in (story.scenes or [])}

    # Index connections by source for O(1) lookup of outgoing edges.
    out_edges_by_source: dict[str, list] = {}
    for c in (story.connections or []):
        out_edges_by_source.setdefault(c.source_node_id, []).append(c)

    chain: list[ChainNode] = [origin_node]
    visited: set[str] = set()
    current_id: str = origin_node.id

    while current_id:
        if current_id in visited:
            break  # cycle guard
        visited.add(current_id)

        cur_edges = out_edges_by_source.get(current_id, [])
        is_entity_node = current_id in entity_nodes_by_id

        next_edge = None
        if is_entity_node:
            # From an entity node: prefer narrative-flow edges; fall back
            # to a relationship edge only if no flow edge exists.
            next_edge = next(
                (e for e in cur_edges if not getattr(e, "is_relationship", False)),
                None,
            )
            if next_edge is None:
                next_edge = next(
                    (e for e in cur_edges if getattr(e, "is_relationship", False)),
                    None,
                )
        else:
            # From a scene node: only follow narrative-flow edges from
            # THIS entity's chip output handle. Relationship wires are
            # never chain links.
            next_edge = next(
                (
                    e for e in cur_edges
                    if getattr(e, "source_entity_id", None) == entity_id
                    and not getattr(e, "is_relationship", False)
                ),
                None,
            )

        if next_edge is None:
            break

        next_id = next_edge.target_node_id
        next_scene = scenes_by_id.get(next_id)
        next_entity_node = entity_nodes_by_id.get(next_id)

        if next_scene is not None:
            # Add the scene to the chain only if the entity has a ref
            # in any bucket on it. Otherwise the wire passes through
            # without contributing a chain stop (matches frontend).
            has_ref = any(
                any(getattr(r, "entity_id", None) == entity_id for r in (getattr(next_scene, b, None) or []))
                for b in _ENTITY_BUCKETS
            )
            if has_ref:
                chain.append(next_scene)
            current_id = next_scene.id
        elif next_entity_node is not None and next_entity_node.entity_id == entity_id:
            # Modifier EntityNode for this entity — always a chain stop.
            chain.append(next_entity_node)
            current_id = next_entity_node.id
        else:
            # Wire lands on a node we don't recognise as part of this
            # entity's chain (e.g. another entity's modifier node).
            break

    return chain


def find_origin_entity_node(entity_id: str, story: Story) -> EntityNode | None:
    """Helper: return the entity's origin EntityNode, or None if absent.
    Provided so callers don't have to re-implement the (entity_id +
    not is_modifier) filter."""
    return next(
        (
            n for n in (story.entity_nodes or [])
            if getattr(n, "entity_id", None) == entity_id
            and not getattr(n, "is_modifier", False)
        ),
        None,
    )
