"""Phase 2.8 — Context Cue model.

A Context Cue is a named, reusable chunk of reference content the
writer composes once and pulls into AI conversations on demand
(formatting preferences, recurring event sequences, worldbuilding
notes, style directives, etc.). Cues live program-level (not per
story); the list ships across every project the writer opens.

Storage layout (Phase 2.8 rewrite): one JSON file per cue inside a
top-level ``context_cues/`` folder, with an ``order.json`` sidecar
that persists the writer-chosen list order. Mirrors the
``conversations/`` folder layout — see
``services.context_cues_service``. The previous single-file layout
(``preferences/ai_context_cues.json``) is gone; no compat read.

The folder is gitignored (per-install state) and never written into
the ``.nnz`` archive.
"""

from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field


class ContextCue(BaseModel):
    """A single saved Context Cue. ``body`` is TipTap-edited rich text
    (HTML), converted to markdown at chat-send time via the shared
    ``tiptapHtmlToMarkdown`` helper so the LLM sees paragraph breaks
    / lists / etc. cleanly. ``tags`` is the writer's organisational
    labelling for the library section (Phase 2.8) — same string-list
    convention used by conversation threads, filtered through the
    same `matchesTagFilter` predicate and rendered via the same
    `TagChip` / `TagPicker` / `TagCloud` / `TagFilterRow` components
    from `frontend/src/components/tags/`. ``pinned`` floats the cue
    to the top of the library list (mirrors the conversation
    browser's pinning UX). ``colour`` is an optional hex string
    (``#rrggbb``) the writer can attach to tint the cue's library
    row; null means "use the default zinc chrome". Treated as a
    presentation field — toggling it does NOT bump ``updated_at``. ``updated_at`` is a Unix-ms timestamp
    that the backend stamps whenever the cue's content (name / body /
    tags) actually changes — drives the "Recent" sort order in the
    library."""

    model_config = ConfigDict(extra="ignore")

    id: str
    name: str
    body: str = ""
    tags: List[str] = Field(default_factory=list)
    pinned: bool = False
    colour: Optional[str] = None
    updated_at: Optional[int] = None


class ContextCueIndexEntry(BaseModel):
    """Phase 3.4c — per-cue index entry mirrored into
    ``context_cues/index.json`` so the cue library can render the list
    view without loading every cue file. Mirrors the
    ``ConversationIndexEntry`` shape on conversations: cheap-to-load
    metadata only; the full ``body`` lives in the per-cue file and is
    fetched lazily via the cue-detail endpoint.

    ``preview`` is the first ~140 chars of the body (matches the
    conversations index preview length), used by the library row to
    show context without loading the full body. Updated on every body
    edit via the service's mutation hooks.
    """

    model_config = ConfigDict(extra="ignore")

    id: str
    name: str
    tags: List[str] = Field(default_factory=list)
    favourite: bool = False  # alias for `pinned` on the source cue; mirrored at write-time
    preview: str = ""
    updated_at: Optional[int] = None
    created_at: Optional[int] = None
    colour: Optional[str] = None
