from fastapi import APIRouter, HTTPException
from models.connection import Connection
import state

router = APIRouter(prefix="/connections", tags=["connections"])


@router.get("/", response_model=list[Connection])
def list_connections():
    return state.get_story().connections


@router.post("/", response_model=Connection, status_code=201)
def create_connection(connection: Connection):
    story = state.get_story()
    story.connections.append(connection)
    return connection


@router.put("/{connection_id}", response_model=Connection)
def update_connection(connection_id: str, updated: Connection):
    story = state.get_story()
    for i, c in enumerate(story.connections):
        if c.id == connection_id:
            story.connections[i] = updated
            return updated
    raise HTTPException(status_code=404, detail="Connection not found")


@router.delete("/{connection_id}", status_code=204)
def delete_connection(connection_id: str):
    story = state.get_story()
    for i, c in enumerate(story.connections):
        if c.id == connection_id:
            story.connections.pop(i)
            return
    raise HTTPException(status_code=404, detail="Connection not found")
