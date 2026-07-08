from fastapi import APIRouter, HTTPException
from models.entity import PresetList
import state

router = APIRouter(prefix="/preset-lists", tags=["preset-lists"])


@router.get("/", response_model=list[PresetList])
def list_preset_lists():
    return state.get_story().preset_lists


@router.post("/", response_model=PresetList, status_code=201)
def create_preset_list(preset_list: PresetList):
    story = state.get_story()
    story.preset_lists.append(preset_list)
    return preset_list


@router.get("/{list_id}", response_model=PresetList)
def get_preset_list(list_id: str):
    for pl in state.get_story().preset_lists:
        if pl.id == list_id:
            return pl
    raise HTTPException(status_code=404, detail="PresetList not found")


@router.put("/{list_id}", response_model=PresetList)
def update_preset_list(list_id: str, updated: PresetList):
    story = state.get_story()
    for i, pl in enumerate(story.preset_lists):
        if pl.id == list_id:
            story.preset_lists[i] = updated
            return updated
    raise HTTPException(status_code=404, detail="PresetList not found")


@router.delete("/{list_id}", status_code=204)
def delete_preset_list(list_id: str):
    story = state.get_story()
    for i, pl in enumerate(story.preset_lists):
        if pl.id == list_id:
            story.preset_lists.pop(i)
            return
    raise HTTPException(status_code=404, detail="PresetList not found")
