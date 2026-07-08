"""
POV sequence computation — single source of truth for the POV chain (backend).

Mirrors the logic in frontend/src/utils/povSequence.js.
"""

from models.story import Story


def compute_pov_sequence(story: Story) -> list[dict]:
    """
    Walk the POV wire chain from the POV Origin Node through scene nodes.

    Returns an ordered list of dicts:
        [{ "node_id": str, "pov_entity_id": str|None, "index": int }, ...]

    Index is 1-based. The POV Origin Node itself is index 0 (not included in the result).
    """
    if not story.pov_origin_node:
        return []

    # Build adjacency: source_node_id → connection for POV wires only
    pov_edges = {}
    for conn in story.connections:
        if conn.is_pov_path:
            pov_edges[conn.source_node_id] = conn

    # Build node lookup for scene nodes
    pp_nodes = {n.id: n for n in story.scenes}

    # Walk forward from origin
    sequence = []
    current = story.pov_origin_node.id
    idx = 0
    visited = set()

    while current:
        if current in visited:
            break  # safety: prevent infinite loop
        visited.add(current)

        edge = pov_edges.get(current)
        if not edge:
            break

        current = edge.target_node_id
        idx += 1

        # Only scene nodes get sequence entries
        if current in pp_nodes:
            node = pp_nodes[current]
            # Read pov_entity_id directly from the node (persisted since v0.1.9.85);
            # fall back to scanning characters for has_pov for legacy saves.
            pov_entity_id = node.pov_entity_id
            if pov_entity_id is None:
                for char in node.characters:
                    if char.has_pov:
                        pov_entity_id = char.entity_id
                        break

            sequence.append({
                "node_id": current,
                "pov_entity_id": pov_entity_id,
                "title": node.title or node.description or "Untitled Scene",
                "index": idx,
            })

    return sequence
