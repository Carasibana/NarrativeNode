"""REST endpoints for system-prompt categories — Phase 2.10a items 2 + 3.

Categories are plain-named subfolders under `system_prompts/`; the
folder name IS the category identity. See
`backend/services/categories_service.py` for the storage shape +
`categories.json` colour map.

Item 2 shipped the read-only listing. Item 3 (this commit) adds
create / rename / delete folder operations + colour set/clear,
consumed by the Settings tab category management section.
"""
from typing import List, Optional

from fastapi import APIRouter, Body, HTTPException

from services import categories_service as svc


router = APIRouter(prefix="/system-prompt-categories", tags=["system-prompts"])


@router.get("", response_model=List[svc.CategoryEntry])
async def list_system_prompt_categories() -> List[svc.CategoryEntry]:
    """Return every category subfolder under `system_prompts/`, joined
    with the colour map from `categories.json`. Hand-created folders
    appear here automatically (no registration step). Orphan
    `categories.json` keys (folder doesn't exist) are silently dropped.
    Sorted by name (case-insensitive) for stable picker rendering.
    """
    return svc.list_categories()


@router.post("", response_model=svc.CategoryEntry, status_code=201)
async def create_system_prompt_category(
    name: str = Body(..., embed=True),
    colour: Optional[str] = Body(None, embed=True),
) -> svc.CategoryEntry:
    """Create a new category folder. Validates the name (rejects
    filesystem-illegal characters, empty/whitespace-only names, and
    case-insensitive collisions). If `colour` is provided, writes it
    to `categories.json` as part of the same operation. Returns the
    canonical `CategoryEntry`.
    """
    try:
        return svc.create_category(name, colour)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except FileExistsError as e:
        raise HTTPException(status_code=409, detail=str(e))


@router.put("/{name}", response_model=svc.CategoryEntry)
async def rename_system_prompt_category(
    name: str,
    new_name: str = Body(..., embed=True),
) -> svc.CategoryEntry:
    """Rename a category folder. Validates the new name the same way
    create does. Also moves the matching `categories.json` key if any,
    so the colour binding survives the rename. Returns the canonical
    `CategoryEntry` post-rename.
    """
    try:
        return svc.rename_category(name, new_name)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/{name}")
async def delete_system_prompt_category(
    name: str,
    move_prompts_to_root: bool = True,
) -> dict:
    """Remove a category folder. `move_prompts_to_root=True` (default)
    relocates every prompt in the folder up to the `system_prompts/`
    root before deleting the folder. `move_prompts_to_root=false`
    deletes the folder AND every prompt inside — used when the writer
    explicitly chose "delete with category" in the confirmation UI.
    The matching `categories.json` entry is also removed.
    """
    try:
        svc.delete_category(name, move_prompts_to_root=move_prompts_to_root)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"deleted": name, "moved_prompts_to_root": move_prompts_to_root}


@router.put("/{name}/colour")
async def set_system_prompt_category_colour(
    name: str,
    colour: Optional[str] = Body(None, embed=True),
) -> dict:
    """Set or clear the custom colour for a category. `colour=null`
    (or omitted) removes the entry, reverting the folder to the
    default colour. Does NOT verify the folder exists — orphan entries
    are tolerated at read time, and setting a colour as part of a
    create flow is legitimate.
    """
    svc.set_colour(name, colour)
    return {"name": name, "colour": colour}
