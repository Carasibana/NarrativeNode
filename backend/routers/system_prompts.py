"""REST endpoints for system-prompt CRUD — Phase 2.3e.

Backed by `{slug}__{id}.json` files in the top-level `system_prompts/`
folder (Phase 2.10a moved this out of `preferences/`); see
`backend/services/system_prompts_service.py` for the storage layout.

The `default_system_prompt_id` pointer lives separately on
`UserPreferences` and is managed via the existing `/settings`
endpoints — this router only owns the list itself.
"""
from typing import List

from fastapi import APIRouter, HTTPException

from models.user_preferences import SystemPrompt
from services import system_prompts_service as svc


router = APIRouter(prefix="/system-prompts", tags=["system-prompts"])


@router.get("", response_model=List[SystemPrompt])
async def list_system_prompts() -> List[SystemPrompt]:
    return svc.list_prompts()


@router.get("/{prompt_id}", response_model=SystemPrompt)
async def get_system_prompt(prompt_id: str) -> SystemPrompt:
    p = svc.get_prompt(prompt_id)
    if p is None:
        raise HTTPException(status_code=404, detail=f"System prompt '{prompt_id}' not found")
    return p


@router.post("", response_model=SystemPrompt)
async def create_system_prompt(prompt: SystemPrompt) -> SystemPrompt:
    # Caller supplies the id (UUID generated client-side); collision
    # is treated as an error so the writer doesn't silently overwrite
    # an existing prompt. Use PUT to update.
    if svc.get_prompt(prompt.id) is not None:
        raise HTTPException(status_code=409, detail=f"System prompt '{prompt.id}' already exists")
    return svc.save_prompt(prompt)


@router.put("/{prompt_id}", response_model=SystemPrompt)
async def update_system_prompt(prompt_id: str, prompt: SystemPrompt) -> SystemPrompt:
    if prompt.id != prompt_id:
        raise HTTPException(status_code=400, detail="Path id must match body id")
    return svc.save_prompt(prompt)


@router.delete("/{prompt_id}")
async def delete_system_prompt(prompt_id: str) -> dict:
    if not svc.delete_prompt(prompt_id):
        raise HTTPException(status_code=404, detail=f"System prompt '{prompt_id}' not found")
    return {"deleted": prompt_id}


@router.put("/{prompt_id}/category", response_model=SystemPrompt)
async def move_system_prompt(prompt_id: str, body: dict) -> SystemPrompt:
    """Phase 2.10a item 5 — move a prompt between categories. Body:
    `{"category": "Writing" | null}`. `null` means move to root
    (uncategorized). Returns the persisted prompt with `category`
    populated from the new on-disk location.
    """
    target = body.get("category") if isinstance(body, dict) else None
    if target is not None and not isinstance(target, str):
        raise HTTPException(status_code=400, detail="`category` must be a string or null")
    try:
        moved = svc.move_prompt(prompt_id, target)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    if moved is None:
        raise HTTPException(status_code=404, detail=f"System prompt '{prompt_id}' not found")
    return moved
