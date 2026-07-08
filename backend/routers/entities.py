import sys

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from models import ENTITY_BUCKETS
from models.entity import Entity
from models.node import EntityNode
from services import seeds_service
import state

router = APIRouter(prefix="/entities", tags=["entities"])

# Local alias kept to avoid a large rename across this module. ENTITY_BUCKETS
# is the single source of truth in `backend/models/__init__.py`.
BUCKETS = ENTITY_BUCKETS


class EntityCreatedResponse(BaseModel):
    entity: Entity
    entity_node: EntityNode


def _bucket_name(entity_type: str) -> str:
    return entity_type + "s"


def _find_entity(story, entity_id: str):
    for bucket_name in BUCKETS:
        for entity in getattr(story.entities, bucket_name):
            if entity.id == entity_id:
                return entity, bucket_name
    return None, None


@router.get("/", response_model=dict)
def list_entities():
    """Return all entities grouped by type."""
    story = state.get_story()
    return story.entities.model_dump()


@router.post("/", response_model=EntityCreatedResponse, status_code=201)
def create_entity(entity: Entity):
    """Add a new entity and place its entity origin node on the canvas.

    If the project has seed stubs configured for this entity's type
    (see `backend/services/seeds_service.py` + `models/seeds.py`),
    they are appended to the entity's `attributes[]` before it is
    stored. Any attributes the caller already sent are preserved in
    their original order; seeds are purely additive. The response
    returns the fully seeded entity so the frontend stores match the
    backend immediately.
    """
    story = state.get_story()
    seeds = state.get_seeds()
    try:
        seeds_service.apply_seeds_to_entity(entity, seeds, story)
    except Exception as exc:  # noqa: BLE001
        # Seed application must never block entity creation. Per-stub failures
        # are already caught inside apply_seeds_to_entity; this guards the
        # outer setup (preset-lookup build, bucket access) so the entity is
        # still created if the seeds mechanism fails wholesale, instead of
        # returning a 500 for the whole create.
        print(
            f"[entities] seed application failed for {entity.type} "
            f"{entity.name!r}: {exc!r}; creating the entity without seeds.",
            file=sys.stderr, flush=True,
        )
    bucket = getattr(story.entities, _bucket_name(entity.type))
    bucket.append(entity)
    entity_node = EntityNode(entity_id=entity.id)
    story.entity_nodes.append(entity_node)
    return EntityCreatedResponse(entity=entity, entity_node=entity_node)


@router.get("/{entity_id}", response_model=Entity)
def get_entity(entity_id: str):
    story = state.get_story()
    entity, _ = _find_entity(story, entity_id)
    if entity is None:
        raise HTTPException(status_code=404, detail="Entity not found")
    return entity


@router.put("/{entity_id}", response_model=Entity)
def update_entity(entity_id: str, updated: Entity):
    """Replace an entity by ID."""
    story = state.get_story()
    for bucket_name in BUCKETS:
        bucket = getattr(story.entities, bucket_name)
        for i, entity in enumerate(bucket):
            if entity.id == entity_id:
                bucket[i] = updated
                return updated
    raise HTTPException(status_code=404, detail="Entity not found")


@router.delete("/{entity_id}", status_code=204)
def delete_entity(entity_id: str):
    story = state.get_story()
    for bucket_name in BUCKETS:
        bucket = getattr(story.entities, bucket_name)
        for i, entity in enumerate(bucket):
            if entity.id == entity_id:
                bucket.pop(i)
                # Remove associated EntityNode
                story.entity_nodes = [n for n in story.entity_nodes if n.entity_id != entity_id]
                # Remove top-level relationships where this entity participates or is the membership_of anchor.
                # With the history-only model, participation is derived from `history.participant_changes`:
                # an entity participates iff it ever appears as a join or leave event subject.
                story.relationships = [
                    r for r in story.relationships
                    if not any(ch.entity_id == entity_id for ch in r.history.participant_changes)
                    and r.membership_of != entity_id
                ]
                return
    raise HTTPException(status_code=404, detail="Entity not found")
