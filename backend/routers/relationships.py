from fastapi import APIRouter, HTTPException
from models.entity import Relationship
import state

router = APIRouter(prefix="/relationships", tags=["relationships"])


def _find_relationship(story, rel_id: str) -> tuple[Relationship | None, int]:
    for i, r in enumerate(story.relationships):
        if r.id == rel_id:
            return r, i
    return None, -1


@router.get("/", response_model=list[Relationship])
def list_relationships():
    return state.get_story().relationships


@router.get("/by-entity/{entity_id}", response_model=list[Relationship])
def get_relationships_by_entity(entity_id: str):
    """Return all relationships where the given entity is a participant.

    With the history-only model, participation is derived from
    `history.participant_changes`: an entity participates iff it appears as
    the subject of any join event."""
    return [
        r for r in state.get_story().relationships
        if any(ch.action == "join" and ch.entity_id == entity_id
               for ch in r.history.participant_changes)
    ]


@router.get("/{rel_id}", response_model=Relationship)
def get_relationship(rel_id: str):
    story = state.get_story()
    rel, _ = _find_relationship(story, rel_id)
    if rel is None:
        raise HTTPException(status_code=404, detail="Relationship not found")
    return rel


@router.post("/", response_model=Relationship, status_code=201)
def create_relationship(relationship: Relationship):
    story = state.get_story()
    story.relationships.append(relationship)
    return relationship


@router.put("/{rel_id}", response_model=Relationship)
def update_relationship(rel_id: str, updated: Relationship):
    story = state.get_story()
    rel, idx = _find_relationship(story, rel_id)
    if rel is None:
        raise HTTPException(status_code=404, detail="Relationship not found")
    story.relationships[idx] = updated
    return updated


@router.delete("/{rel_id}", status_code=204)
def delete_relationship(rel_id: str):
    story = state.get_story()
    rel, idx = _find_relationship(story, rel_id)
    if rel is None:
        raise HTTPException(status_code=404, detail="Relationship not found")
    story.relationships.pop(idx)
