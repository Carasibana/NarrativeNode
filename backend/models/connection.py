from __future__ import annotations
from typing import Literal, Optional
from pydantic import BaseModel, ConfigDict, Field
import uuid


# Unknown JSON keys are dropped at validation. See models/story.py for the rationale.
_foreign_content_ok = ConfigDict(extra="ignore")


class Waypoint(BaseModel):
    model_config = _foreign_content_ok
    t: float                                       # 0–1 position along source→target baseline
    offsetX: float = 0                             # canvas-space X displacement from base point
    offsetY: float = 0                             # canvas-space Y displacement from base point
    type: Literal["curve", "sharp"] = "curve"


class Connection(BaseModel):
    model_config = _foreign_content_ok
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    source_node_id: str
    target_node_id: str
    source_entity_id: Optional[str] = None  # entity chip that originated this connection
    target_entity_id: Optional[str] = None
    transition_text: str = ""
    entity_ids: list[str] = Field(default_factory=list)
    is_pov_path: bool = False
    # Relationship edges (created by entity wiring, not narrative flow)
    is_relationship: bool = False
    relationship_id: Optional[str] = None
    target_handle_id: Optional[str] = None  # chip-in-{id} or rel-in-{id} handle on the target node
    # Phase 8.1 (§8.1.2) , concept wires. `kind="concept"` discriminates a
    # concept-layer association from a narrative connection; `source_handle_id`
    # stores the source-end port (`concept-*`) , a concept wire needs BOTH port
    # handles to re-anchor on load. Additive Optional (old saves default to
    # None = a narrative connection). MUST be declared: the model uses
    # extra="ignore", so an undeclared field is silently stripped on save/load.
    kind: Optional[str] = None
    source_handle_id: Optional[str] = None  # concept-* source port (concept wires)
    is_expanded: bool = False  # transition note editor expanded/collapsed state
    label_offset_x: float = 0  # drag offset for transition note label position
    label_offset_y: float = 0
    # Wire routing waypoints (user-placeable control points)
    waypoints: list[Waypoint] = Field(default_factory=list)
    label_waypoint_type: Literal["curve", "sharp"] = "curve"  # transition note dot type
