"""REST endpoints for the Persona Preamble — Phase 2.11a item 4.

The Persona Preamble is the program-injected identity declaration that
gets prepended to every Persona system prompt at send time. See
`backend/services/persona_preamble_service.py` for the storage scheme
and rationale.

Three endpoints:
  - GET  /api/persona-preamble        → `{body: str, is_custom: bool}`
                                         body is the effective text
                                         (custom override OR shipped
                                         default); `is_custom` tells
                                         the UI whether the Reset
                                         button should be enabled.
  - PUT  /api/persona-preamble {body} → writes the custom body, returns
                                         the same shape as GET.
  - DELETE /api/persona-preamble      → deletes the custom body file
                                         (resets to shipped default),
                                         returns the same shape as GET.
"""
from fastapi import APIRouter, HTTPException

from services import persona_preamble_service as svc


router = APIRouter(prefix="/persona-preamble", tags=["persona-preamble"])


def _payload() -> dict:
    return {
        "body": svc.get_effective_preamble(),
        "is_custom": svc.has_custom_preamble(),
        # Genuine fallback the assembly pipeline emits inside the
        # `<character_context>` tags whenever no character is selected
        # (e.g. the prompt editor's Preview tab). Exposed here so the
        # editor preview shows the literal string the AI would actually
        # receive in that state, not preview-only fake text.
        "character_context_fallback_no_character": svc.CHARACTER_CONTEXT_FALLBACK_NO_CHARACTER,
    }


@router.get("")
async def get_persona_preamble() -> dict:
    return _payload()


@router.put("")
async def put_persona_preamble(body_in: dict) -> dict:
    body = body_in.get("body") if isinstance(body_in, dict) else None
    if not isinstance(body, str):
        raise HTTPException(status_code=400, detail="`body` must be a string")
    svc.save_preamble(body)
    return _payload()


@router.delete("")
async def delete_persona_preamble() -> dict:
    svc.reset_preamble()
    return _payload()
