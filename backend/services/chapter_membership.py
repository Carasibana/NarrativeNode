"""
Chapter membership utility — backend port of the frontend
`frontend/src/utils/chapterMembership.js` logic.

Needed by the export pipeline: given a plot-point node's position and the
story's chapters list, return the id of the chapter whose column contains
the node's centre-point x. Match the frontend's 50/50-defaults-left rule
exactly so the export's chapter assignment lines up with what the user
sees on the canvas.

Pure, no store reads, mirrors the JS version byte-for-byte semantics.
"""

from __future__ import annotations

from typing import Optional

from models.node import SceneNode
from models.story import Chapter


# Default node width fallback — same as frontend (a scene defaults to 220 px
# when neither `measured` nor `data.width` is set). Scene nodes saved without
# an explicit width get 220 applied at export time so the centre-x calculation
# lands in the right chapter.
_DEFAULT_SCENE_WIDTH = 220.0


def _node_width(node: SceneNode) -> float:
    """Match the frontend fallback order: prefer explicit `node.width`, else
    fall back to the default scene width. SceneNode doesn't carry a
    `measured` field (that's a React Flow runtime thing), so this is the
    simplest form of the frontend's fallback chain."""
    if node.width is not None and node.width > 0:
        return float(node.width)
    return _DEFAULT_SCENE_WIDTH


def get_chapter_id_for_node(
    node: SceneNode,
    chapters: list[Chapter],
    x_offset: float = 10.0,
) -> Optional[str]:
    """Return the id of the chapter containing the node's centre-point x,
    or None if the centre falls before the first column or past the right
    edge of the last column.

    A centre exactly on an internal divider belongs to the LEFT chapter
    (50/50 defaults left — matches the frontend rule). A centre exactly
    on the far-right edge of the last chapter belongs to that last
    chapter (consistent with left-wins-tie at every internal boundary).

    `x_offset` is the flow-space x where the first chapter's LEFT edge
    sits — mirrors `story.chapter_x_offset`.
    """
    if not chapters:
        return None
    if node is None:
        return None
    x = node.position.x if node.position else 0.0
    width = _node_width(node)
    centre_x = x + width / 2.0
    if centre_x < x_offset:
        return None
    cumulative = x_offset
    for chapter in chapters:
        right = cumulative + (chapter.width or 0)
        # `centre_x <= right` gives left-wins-on-tie at every boundary,
        # matching the frontend rule.
        if centre_x <= right:
            return chapter.id
        cumulative = right
    return None  # past the right edge of the last column
