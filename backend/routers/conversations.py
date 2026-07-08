"""Conversation persistence REST endpoints — Phase 2.4b.

Frontend talks to this router for everything thread-related:
listing the index, loading a thread on demand, creating /
renaming / deleting threads, and message append / edit / delete.
File CRUD lives in `services.conversations_service`; this file is
thin HTTP wiring.
"""
from typing import List, Literal, Optional

from fastapi import APIRouter, Body, HTTPException
from pydantic import BaseModel

from models.conversation import (
    CharacterChatMeta,
    Conversation,
    ConversationIndexEntry,
    ConversationMessage,
    TwoCharacterChatMeta,
)
from services import conversations_service as svc
import state


router = APIRouter(prefix="/conversations", tags=["conversations"])


# ── Index + load ─────────────────────────────────────────────────


@router.get("", response_model=List[ConversationIndexEntry])
async def list_conversations() -> List[ConversationIndexEntry]:
    """Cheap metadata-only listing for the thread browser. Never
    loads full messages — see GET /{thread_id} for the heavy
    fetch."""
    return svc.list_index()


@router.get("/categories-map")
async def get_categories_map() -> dict:
    """Return the persisted `story_id → display_name` map from the
    cached `conversations/index.json`. The thread browser tab strip
    (Phase 2.6e) uses this to label per-story tabs without walking
    the per-folder `category.json` sidecars on disk.

    Declared BEFORE the `/{thread_id}` route below — FastAPI matches
    in order and `/conversations/categories-map` would otherwise be
    interpreted as a thread id with the value `categories-map`."""
    return svc.list_categories_map()


class SyncStoryFolderRequest(BaseModel):
    """Body for `POST /api/conversations/sync-story-folder`. Wraps
    the (story_id, story_title) pair the frontend sends on project
    load + on every title commit so the conversations subsystem can
    keep its disk layout + persisted index in agreement with the
    loaded story's current name."""
    story_id: str
    story_title: Optional[str] = None


@router.post("/sync-story-folder")
async def sync_story_folder(req: SyncStoryFolderRequest) -> dict:
    """Phase 2.6g — project-load + story-rename hook.

    Two effects in one endpoint:
      1. Rename-existing-only on the per-story folder (per
         `services.conversations_service.rename_story_folder`):
         if a folder already exists for `story_id`, rename it to
         the new slug + update the sidecar; if no folder exists,
         no-op (lazy creation rule — folder gets made at the new
         slug whenever the first thread for that story is saved).
      2. Ensure `index.categories[story_id]` reflects the current
         title, regardless of whether the folder exists yet. Stale
         tab labels are the visible failure mode of skipping this.

    Both effects are idempotent + best-effort; the response carries
    a `folder_renamed` flag so the frontend can log if it cares,
    but no error is raised if the rename was a no-op (the rename
    branch IS expected to no-op on a fresh project that's never
    chatted in)."""
    story_title = req.story_title or ""
    renamed = svc.rename_story_folder(req.story_id, story_title)
    # `_set_index_category` is the safety net for the "no folder
    # exists yet" case — `rename_story_folder` only updates the
    # categories map when a folder exists, so call this explicitly
    # to make sure the persisted index always reflects the current
    # name. Internal use of the module-private function is the
    # cleanest path here; surfacing a public wrapper would just
    # forward to the same place.
    svc._set_index_category(req.story_id, story_title)
    return {
        "story_id": req.story_id,
        "story_title": story_title,
        "folder_renamed": renamed is not None,
    }


@router.post("/rebuild-index")
async def rebuild_thread_index() -> dict:
    """Force a full rebuild of `conversations/index.json` from the
    on-disk thread files + per-folder `category.json` sidecars.
    Cheap insurance against any drift the writer notices — the
    rebuild walks every thread file once, regenerates the
    in-memory cache, and atomically replaces the persisted index.

    Wired to a "Rebuild thread index" button in the settings panel
    by the Phase 2.6e frontend work. Returns the new entry + category
    counts so the frontend can render a confirmation toast."""
    rebuilt = svc.rebuild_index()
    return {
        "entries": len(rebuilt.entries),
        "categories": len(rebuilt.categories),
    }


@router.get("/search")
async def search_conversations(q: str = "", category_id: Optional[str] = None) -> List[dict]:
    """Substring search across every thread's message content.
    Returns `[{ id, match_count, updated_at }, ...]` — only threads
    with at least one match are included. The frontend merges this
    with the index entries to surface a per-row match count badge
    in the thread browser. Empty query returns an empty list so
    short-circuiting the request from the client is optional.

    `category_id` narrows the scan to threads whose `category_id`
    matches — the chat browser passes the active tab's category so
    the server can skip the body scan for threads outside it.
    Omit (or pass null) to search every thread regardless of
    category, matching the behaviour from the "All" tab.

    Declared BEFORE the `/{thread_id}` route below because FastAPI
    matches in order — `/conversations/search` would otherwise be
    interpreted as a thread id with the value `search`."""
    return svc.search_threads(q, category_id=category_id)


@router.get("/{thread_id}", response_model=Conversation)
async def get_conversation(thread_id: str) -> Conversation:
    thread = svc.get_conversation(thread_id)
    if thread is None:
        raise HTTPException(status_code=404, detail=f"Conversation '{thread_id}' not found")
    return thread


# ── Create / rename / delete ─────────────────────────────────────


class CreateConversationRequest(BaseModel):
    """Caller supplies the id (UUID generated client-side) so the
    frontend can optimistically render a new thread instantly. The
    backend rejects collisions. `category_id` lets the thread
    browser seed a new conversation with the active tab's category
    (Phase 2.4f) — null leaves the thread uncategorised.

    `character_chat` (Phase 2.11b) lets a character-chat entry point
    seed the new thread with its `CharacterChatMeta` block at create
    time. Null leaves it as a regular conversation.

    `two_character_chat` (Phase 2.12) lets the two-character entry
    point seed the new thread with a `TwoCharacterChatMeta` block at
    create time. Mutually exclusive with `character_chat` — only one
    of the two should be non-null per request (the frontend
    guarantees this; the model doesn't enforce it at the type level).
    Null leaves it as a regular / single-character conversation."""
    id: str
    name: str = "New conversation"
    profile_id: Optional[str] = None
    model: Optional[str] = None
    system_prompt_id: Optional[str] = None
    category_id: Optional[str] = None
    character_chat: Optional[CharacterChatMeta] = None
    two_character_chat: Optional[TwoCharacterChatMeta] = None


@router.post("", response_model=Conversation)
async def create_conversation(req: CreateConversationRequest) -> Conversation:
    if svc.get_conversation(req.id) is not None:
        raise HTTPException(status_code=409, detail=f"Conversation '{req.id}' already exists")
    from services.conversations_service import _utcnow_iso  # local import — re-uses the helper
    now = _utcnow_iso()
    # Phase 2.6 — stamp `story_id` from the currently-loaded story
    # (if any) so the thread routes into that story's folder. The
    # field is immutable from creation per the planning doc: story
    # renames don't touch it, and the program never rewrites it.
    # When no project is loaded `story_id` stays None and the thread
    # lands in the shared `untitled/` bucket.
    loaded_story = None
    try:
        loaded_story = state.get_story()
    except Exception:
        pass
    story_id = getattr(loaded_story, "id", None) if loaded_story is not None else None
    story_title = getattr(loaded_story, "title", None) if loaded_story is not None else None
    thread = Conversation(
        id=req.id,
        name=req.name,
        created_at=now,
        updated_at=now,
        profile_id=req.profile_id,
        model=req.model,
        system_prompt_id=req.system_prompt_id,
        story_id=story_id,
        tags=[],
        messages=[],
        character_chat=req.character_chat,
        two_character_chat=req.two_character_chat,
    )
    return svc.save_conversation(thread, story_title=story_title)


class UpdateConversationRequest(BaseModel):
    """Patchable thread metadata. Fields set to None are ignored
    so the frontend can rename without resending unrelated state.

    `system_prompt_id` and `render_mode` accept the string
    `"__clear__"` as a sentinel to explicitly set the field back to
    None (since None in the patch body means "leave this field
    alone"). Used by the Chat Settings popover when the writer picks
    "No system prompt" — that needs to ride through the wire as an
    explicit clear, not as "do nothing".

    Phase 2.6 — `category_id` replaced by `tags`. The tags field
    accepts the whole new list per patch (not per-tag add/remove);
    the front-end's `addTagToThread` / `removeTagFromThread` actions
    diff locally then send the resulting array."""
    name: Optional[str] = None
    profile_id: Optional[str] = None
    model: Optional[str] = None
    system_prompt_id: Optional[str] = None
    render_mode: Optional[Literal["rendered", "raw", "__clear__"]] = None
    pinned_in_browser: Optional[bool] = None
    tags: Optional[List[str]] = None
    # Phase 2.8 — writer-chosen row tint. `"__clear__"` resets the
    # field back to None (so the row falls back to the default
    # zinc/accent chrome); a bare hex string sets it; null means
    # "leave alone" like every other field here.
    colour: Optional[str] = None
    # Phase 2.11b re-anchor + Phase 2.12 turn-pointer persistence.
    # Whole-shape replace per patch — the frontend always sends the
    # complete new meta (re-anchor: new pins; turn toggle: new
    # `next_turn_index` on the existing TwoCharacterChatMeta). None
    # means "leave alone" like every other field here.
    character_chat: Optional[CharacterChatMeta] = None
    two_character_chat: Optional[TwoCharacterChatMeta] = None


@router.put("/{thread_id}", response_model=Conversation)
async def update_conversation(thread_id: str, req: UpdateConversationRequest) -> Conversation:
    thread = svc.get_conversation(thread_id)
    if thread is None:
        raise HTTPException(status_code=404, detail=f"Conversation '{thread_id}' not found")
    update: dict = {}
    if req.name is not None:
        update["name"] = req.name
    if req.profile_id is not None:
        update["profile_id"] = req.profile_id
    if req.model is not None:
        update["model"] = req.model
    if req.system_prompt_id is not None:
        # `__clear__` is the explicit-clear sentinel; the bare absence
        # of the field means "leave alone", so we need a distinct
        # signal for "this thread now uses no system prompt".
        update["system_prompt_id"] = None if req.system_prompt_id == "__clear__" else req.system_prompt_id
    if req.render_mode is not None:
        update["render_mode"] = None if req.render_mode == "__clear__" else req.render_mode
    if req.pinned_in_browser is not None:
        update["pinned_in_browser"] = bool(req.pinned_in_browser)
    if req.tags is not None:
        # Whole-list replace per the planning doc — the front-end
        # builds the next-state array via add/remove diffs and sends
        # it intact. Strings only; non-string entries get dropped
        # quietly.
        update["tags"] = [str(t) for t in req.tags if isinstance(t, str)]
    if req.colour is not None:
        # `__clear__` resets the row tint to None; any other string
        # is stored as-is (front-end always sends a normalised
        # `#rrggbb` from the colour picker).
        update["colour"] = None if req.colour == "__clear__" else str(req.colour)
    if req.character_chat is not None:
        # Phase 2.11b re-anchor flow uses this to persist a new
        # CharacterChatMeta after the writer reopens the Setup modal
        # mid-conversation. Whole-shape replace per patch.
        update["character_chat"] = req.character_chat
    if req.two_character_chat is not None:
        # Phase 2.12 turn-pointer + re-anchor persistence. The send
        # path PUTs a fresh TwoCharacterChatMeta after each completed
        # turn so the toggled `next_turn_index` survives reload; the
        # two-character re-anchor flow does the same after the writer
        # edits one of the two characters' anchors.
        update["two_character_chat"] = req.two_character_chat
    if update:
        thread = thread.model_copy(update=update)
    # Pass `story_title` through to the service so the index's
    # categories map reflects the current loaded title (cheap to
    # resolve here from state; saves the service from re-reading).
    story_title = None
    try:
        loaded_story = state.get_story()
        if loaded_story is not None and getattr(loaded_story, "id", None) == thread.story_id:
            story_title = getattr(loaded_story, "title", None)
    except Exception:
        pass
    return svc.save_conversation(thread, story_title=story_title)


@router.delete("/{thread_id}")
async def delete_conversation(thread_id: str) -> dict:
    if not svc.delete_conversation(thread_id):
        raise HTTPException(status_code=404, detail=f"Conversation '{thread_id}' not found")
    return {"deleted": thread_id}


# ── Message append / edit / delete ──────────────────────────────


@router.post("/{thread_id}/messages", response_model=Conversation)
async def append_message(thread_id: str, message: ConversationMessage) -> Conversation:
    thread = svc.append_message(thread_id, message)
    if thread is None:
        raise HTTPException(status_code=404, detail=f"Conversation '{thread_id}' not found")
    return thread


class UpdateMessageRequest(BaseModel):
    """Patch for a single message. `render_mode` accepts
    `"__clear__"` to reset the per-message override back to None
    (= inherit from conversation)."""
    content: Optional[str] = None
    pinned: Optional[bool] = None
    context_sticky: Optional[bool] = None
    collapsed: Optional[bool] = None
    render_mode: Optional[Literal["rendered", "raw", "__clear__"]] = None
    # Phase 2.5 follow-up — edit timestamp. ISO 8601 UTC. Sent by
    # the frontend whenever a content edit lands so the bubble
    # header can annotate "<Edited DTS>" beside the role label.
    edited_at: Optional[str] = None


@router.put("/{thread_id}/messages/{message_id}", response_model=Conversation)
async def update_message(thread_id: str, message_id: str, req: UpdateMessageRequest) -> Conversation:
    patch: dict = {}
    if req.content is not None:
        patch["content"] = req.content
    if req.pinned is not None:
        patch["pinned"] = req.pinned
    if req.context_sticky is not None:
        patch["context_sticky"] = req.context_sticky
    if req.collapsed is not None:
        patch["collapsed"] = req.collapsed
    if req.render_mode is not None:
        patch["render_mode"] = None if req.render_mode == "__clear__" else req.render_mode
    if req.edited_at is not None:
        patch["edited_at"] = req.edited_at
    if not patch:
        # No-op patch; just return current state.
        thread = svc.get_conversation(thread_id)
        if thread is None:
            raise HTTPException(status_code=404, detail=f"Conversation '{thread_id}' not found")
        return thread
    thread = svc.update_message(thread_id, message_id, patch)
    if thread is None:
        raise HTTPException(status_code=404, detail=f"Message '{message_id}' not found in conversation '{thread_id}'")
    return thread


@router.delete("/{thread_id}/messages/{message_id}", response_model=Conversation)
async def delete_message(thread_id: str, message_id: str) -> Conversation:
    thread = svc.delete_message(thread_id, message_id)
    if thread is None:
        raise HTTPException(status_code=404, detail=f"Message '{message_id}' not found in conversation '{thread_id}'")
    return thread
