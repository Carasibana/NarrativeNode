"""Phase 1.21c — /api/knowledges router.

Parallels /api/relationships. Standard CRUD. Knowledge lives on
`Story.knowledges` at the top level (not under `Story.entities`).
"""

from fastapi import APIRouter, HTTPException
from models.knowledge import Knowledge
import state

router = APIRouter(prefix="/knowledges", tags=["knowledges"])


def _find_knowledge(story, knowledge_id: str) -> tuple[Knowledge | None, int]:
    for i, k in enumerate(story.knowledges):
        if k.id == knowledge_id:
            return k, i
    return None, -1


@router.get("/", response_model=list[Knowledge])
def list_knowledges():
    return state.get_story().knowledges


@router.get("/{knowledge_id}", response_model=Knowledge)
def get_knowledge(knowledge_id: str):
    story = state.get_story()
    k, _ = _find_knowledge(story, knowledge_id)
    if k is None:
        raise HTTPException(status_code=404, detail="Knowledge not found")
    return k


@router.post("/", response_model=Knowledge, status_code=201)
def create_knowledge(knowledge: Knowledge):
    story = state.get_story()
    story.knowledges.append(knowledge)
    return knowledge


@router.put("/{knowledge_id}", response_model=Knowledge)
def update_knowledge(knowledge_id: str, updated: Knowledge):
    story = state.get_story()
    k, idx = _find_knowledge(story, knowledge_id)
    if k is None:
        raise HTTPException(status_code=404, detail="Knowledge not found")
    story.knowledges[idx] = updated
    return updated


@router.delete("/{knowledge_id}", status_code=204)
def delete_knowledge(knowledge_id: str):
    story = state.get_story()
    k, idx = _find_knowledge(story, knowledge_id)
    if k is None:
        raise HTTPException(status_code=404, detail="Knowledge not found")
    story.knowledges.pop(idx)
