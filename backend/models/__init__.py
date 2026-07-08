from .entity import (
    Alias, Attribute, PresetList, CustomCategory, Entity,
    ParticipantRole, HierarchyConfig, Relationship,
    RelationshipHistory,
    ExistenceChange, ParticipantChange, PerceptionChange,
    AliasOverrideChange, RoleChange, HierarchyChange,
    NameChange,
    AwarenessRef,
    AwarenessWrapper, RelationshipSource, AttributeSource,
)
from .node import Position, AttributeChange, AwarenessChange, EntityRef, EntityNode, SceneNode
from .knowledge import (
    Knowledge, KnowledgeHistory,
    KnowledgeNameChange,
    KnowledgeDescriptionChange, KnowledgeColourChange,
    SourceEventRef,
)
from .connection import Connection
from .story import Entities, Story

# Single source-of-truth tuple of bucket (plural) attribute names on
# `Entities` and on `SceneNode`. Every consumer that iterates all
# entity buckets imports this instead of hardcoding the tuple, so adding
# a new bucket is a single-line change here.
#
# Phase 1.21c: `"knowledges"` removed from the tuple. Knowledge is now a
# first-class type on `Story.knowledges` (not an Entity subtype in any
# bucket). Consumers that previously iterated knowledges as an entity
# bucket either stop touching them entirely, or iterate `Story.knowledges`
# explicitly at a dedicated call site.
ENTITY_BUCKETS: tuple[str, ...] = ("characters", "locations", "items", "factions", "customs")

__all__ = [
    "Alias", "Attribute", "PresetList", "CustomCategory", "Entity",
    "ParticipantRole", "HierarchyConfig", "Relationship",
    "RelationshipHistory",
    "ExistenceChange", "ParticipantChange", "PerceptionChange",
    "AliasOverrideChange", "RoleChange", "HierarchyChange",
    "NameChange",
    "AwarenessRef",
    "AwarenessWrapper", "RelationshipSource", "AttributeSource",
    "Position", "AttributeChange", "AwarenessChange", "EntityRef", "EntityNode", "SceneNode",
    "Knowledge", "KnowledgeHistory",
    "KnowledgeNameChange",
    "KnowledgeDescriptionChange", "KnowledgeColourChange",
    "SourceEventRef",
    "Connection",
    "Entities", "Story",
    "ENTITY_BUCKETS",
]
