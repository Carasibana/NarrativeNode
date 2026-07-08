from fastapi import APIRouter, HTTPException
from models.entity import CustomCategory
import state

router = APIRouter(prefix="/custom-categories", tags=["custom-categories"])


@router.get("/", response_model=list[CustomCategory])
def list_custom_categories():
    return state.get_story().custom_categories


@router.post("/", response_model=CustomCategory, status_code=201)
def create_custom_category(category: CustomCategory):
    story = state.get_story()
    story.custom_categories.append(category)
    return category


@router.get("/{category_id}", response_model=CustomCategory)
def get_custom_category(category_id: str):
    for cat in state.get_story().custom_categories:
        if cat.id == category_id:
            return cat
    raise HTTPException(status_code=404, detail="CustomCategory not found")


@router.put("/{category_id}", response_model=CustomCategory)
def update_custom_category(category_id: str, updated: CustomCategory):
    story = state.get_story()
    for i, cat in enumerate(story.custom_categories):
        if cat.id == category_id:
            story.custom_categories[i] = updated
            return updated
    raise HTTPException(status_code=404, detail="CustomCategory not found")


@router.delete("/{category_id}", status_code=204)
def delete_custom_category(category_id: str):
    story = state.get_story()
    for i, cat in enumerate(story.custom_categories):
        if cat.id == category_id:
            story.custom_categories.pop(i)
            return
    raise HTTPException(status_code=404, detail="CustomCategory not found")
