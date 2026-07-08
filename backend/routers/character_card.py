"""SillyTavern character-card import endpoints (Phase 7.2).

Parsing and the card -> entity mapping live in `services.character_card`;
these endpoints expose them to the frontend, which owns entity creation. A
second endpoint turns the dropped card image into a standard profile image.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, File, Response, UploadFile
from pydantic import BaseModel

from services import character_card, file_service, profile_image_processor

router = APIRouter(prefix="/character-card", tags=["character-card"])


@router.post("/parse")
async def parse_card(file: UploadFile = File(...)):
    """Parse an uploaded file as a SillyTavern character card. Returns
    {is_card, draft}. Never errors on a non-card (just is_card=false), so the
    drag-drop gate can fall through to normal image handling."""
    data = await file.read()
    card = character_card.read_card(data)
    if card is None:
        return {"is_card": False, "draft": None}
    return {"is_card": True, "draft": character_card.card_to_entity_draft(card)}


@router.post("/profile-image")
async def card_profile_image(file: UploadFile = File(...)):
    """Process a card image into a standard profile image (256x256 JPEG) and
    store it as a project asset. Returns {file_ref} (null if undecodable)."""
    raw = await file.read()
    try:
        processed = profile_image_processor.preprocess_profile_image_bytes(raw, vertical_anchor="top")
    except Exception:
        return {"file_ref": None}
    return {"file_ref": file_service.store_asset_bytes(processed, "profile_card.jpg")}


class ExportCardRequest(BaseModel):
    """Composed card data (frontend-assembled from the entity's effective
    state at the chosen anchor) plus the entity's profile-image ref."""
    card_data: dict
    profile_image_ref: Optional[str] = None


@router.post("/export")
async def export_card(body: ExportCardRequest):
    """Write a SillyTavern-importable card PNG from composed card data plus the
    entity's profile image (loaded from project assets by ref; a named
    placeholder is generated when absent). Returns the PNG as a download."""
    image_bytes = None
    if body.profile_image_ref:
        try:
            path = file_service.get_assets_dir() / Path(body.profile_image_ref).name
            if path.exists():
                image_bytes = path.read_bytes()
        except Exception:
            image_bytes = None
    png = character_card.write_card(body.card_data, image_bytes)
    name = (body.card_data.get("name") or "character").strip() or "character"
    safe = re.sub(r"[^\w\-. ]+", "_", name).strip() or "character"
    return Response(
        content=png,
        media_type="image/png",
        headers={"Content-Disposition": f'attachment; filename="{safe}.png"'},
    )
