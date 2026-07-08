from fastapi import APIRouter, HTTPException
from models.node import EntityNode, SceneNode
import state

router = APIRouter(prefix="/nodes", tags=["nodes"])


# --- Entity nodes ---

@router.get("/entity", response_model=list[EntityNode])
def list_entity_nodes():
    return state.get_story().entity_nodes


@router.post("/entity", response_model=EntityNode, status_code=201)
def create_entity_node(node: EntityNode):
    story = state.get_story()
    story.entity_nodes.append(node)
    return node


@router.put("/entity/{node_id}", response_model=EntityNode)
def update_entity_node(node_id: str, updated: EntityNode):
    story = state.get_story()
    for i, n in enumerate(story.entity_nodes):
        if n.id == node_id:
            story.entity_nodes[i] = updated
            return updated
    raise HTTPException(status_code=404, detail="Entity node not found")


@router.delete("/entity/{node_id}", status_code=204)
def delete_entity_node(node_id: str):
    story = state.get_story()
    for i, n in enumerate(story.entity_nodes):
        if n.id == node_id:
            story.entity_nodes.pop(i)
            return
    raise HTTPException(status_code=404, detail="Entity node not found")


# --- Scene nodes ---

@router.get("/scenes", response_model=list[SceneNode])
def list_scene_nodes():
    return state.get_story().scenes


@router.post("/scenes", response_model=SceneNode, status_code=201)
def create_scene_node(node: SceneNode):
    story = state.get_story()
    story.scenes.append(node)
    return node


@router.put("/scenes/{node_id}", response_model=SceneNode)
def update_scene_node(node_id: str, updated: SceneNode):
    story = state.get_story()
    for i, n in enumerate(story.scenes):
        if n.id == node_id:
            story.scenes[i] = updated
            return updated
    raise HTTPException(status_code=404, detail="Scene node not found")


@router.delete("/scenes/{node_id}", status_code=204)
def delete_scene_node(node_id: str):
    story = state.get_story()
    for i, n in enumerate(story.scenes):
        if n.id == node_id:
            story.scenes.pop(i)
            return
    raise HTTPException(status_code=404, detail="Scene node not found")
