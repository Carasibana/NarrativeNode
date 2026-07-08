"""Shared SillyTavern character-card (de)serializer (Phase 7.2).

One module owns reading and writing SillyTavern character cards, used by
both the import and export directions. A card is a PNG with the character
JSON embedded in a `tEXt` chunk (base64-encoded UTF-8), or a standalone
`.json` with the same envelope.

Read tolerance (never throws on junk; returns None for "not a card"):
  - PNG `tEXt` keyword precedence `ccv3` (V3) then `chara` (V2).
  - Standalone JSON with the same envelope.
  - V2 / V3 enveloped ({spec, spec_version, data:{...}}) and flat V1
    (plus a few Pygmalion field aliases) all normalise to one canonical
    shape.

Write:
  - Encodes the canonical card data + an image into a PNG carrying BOTH
    a `chara` (V2) and a `ccv3` (V3) `tEXt` chunk, matching SillyTavern's
    own writer so the output imports cleanly there.

Implementation note: PNG chunk read / write is done by hand rather than
via Pillow's text API, because SillyTavern places the card chunk AFTER
the image data (just before IEND), which Pillow's lazy text reader can
miss. Pillow is used only to normalise the embedded image to PNG. The
manual parser reads chunks wherever they sit.

The canonical card-data dict (the interchange shape between this module
and the import / export mapping layers):

    {
      name, description, personality, scenario, first_mes, mes_example,
      system_prompt, post_history_instructions, creator_notes,
      alternate_greetings: [str], character_book: dict|None, tags: [str],
      creator, character_version, extensions: dict, _spec: "v1"|"v2"|"v3"
    }
"""
from __future__ import annotations

import base64
import io
import json
import re
import zlib
from typing import Optional

from PIL import Image, ImageDraw, ImageFont, ImageOps


_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

# ── Macro policy (shared config; the mapping layers apply these) ────────────
# Cards lace `{{char}}` (the character) and `{{user}}` (the human roleplay
# partner) through their text. `{{char}}` maps to the entity name both
# directions. `{{user}}` has no analog in a plot planner, so on import it is
# replaced with a neutral default term (configurable); on export it is never
# emitted. See the Phase 7.2 planning doc, Decision 2.
DEFAULT_USER_TERM = "you"


def apply_macros_inbound(text: str, char_name: str, user_term: str = DEFAULT_USER_TERM) -> str:
    """Substitute card macros when importing into NarrativeNode.

    `{{char}}` -> the imported character name; `{{user}}` -> the neutral
    `user_term`. Case-insensitive (cards use `{{Char}}` / `{{user}}` etc.).
    """
    if not isinstance(text, str) or not text:
        return text
    text = re.sub(r"\{\{\s*char\s*\}\}", char_name or "", text, flags=re.IGNORECASE)
    text = re.sub(r"\{\{\s*user\s*\}\}", user_term, text, flags=re.IGNORECASE)
    return text


def apply_macros_outbound(text: str, char_name: str) -> str:
    """Substitute the entity's literal name with `{{char}}` when exporting,
    so the card survives a rename inside SillyTavern. Whole-word, case
    sensitive. `{{user}}` is never emitted by us."""
    if not isinstance(text, str) or not text or not char_name:
        return text
    return re.sub(r"\b" + re.escape(char_name) + r"\b", "{{char}}", text)


# ── Read ────────────────────────────────────────────────────────────────────

def read_card(data) -> Optional[dict]:
    """Parse a character card from PNG bytes or a JSON string / bytes.

    Returns the canonical card-data dict, or None if `data` carries no
    recognisable card (no embedded chunk, unparseable, or not card-shaped).
    Never raises on malformed input.
    """
    raw = _extract_raw_json(data)
    if not _looks_like_card(raw):
        return None
    try:
        return _normalize_card(raw)
    except Exception:
        return None


def is_card(data) -> bool:
    """Cheap predicate: does `data` carry a recognisable character card?
    Used by the drag-drop metadata gate."""
    return read_card(data) is not None


def _extract_raw_json(data) -> Optional[dict]:
    if isinstance(data, str):
        data = data.encode("utf-8")
    if not isinstance(data, (bytes, bytearray)):
        return None
    data = bytes(data)
    if data[:8] == _PNG_MAGIC:
        chunks = _extract_text_chunks(data)
        for kw in ("ccv3", "chara"):
            if kw in chunks:
                try:
                    return json.loads(base64.b64decode(chunks[kw]).decode("utf-8"))
                except Exception:
                    continue
        return None
    # Standalone JSON.
    try:
        obj = json.loads(data.decode("utf-8"))
        return obj if isinstance(obj, dict) else None
    except Exception:
        return None


def _extract_text_chunks(png: bytes) -> dict:
    """Return {keyword: text} for every tEXt chunk, wherever it sits in the
    file (before or after IDAT)."""
    out: dict = {}
    i = 8
    n = len(png)
    while i + 8 <= n:
        length = int.from_bytes(png[i:i + 4], "big")
        ctype = png[i + 4:i + 8]
        body = png[i + 8:i + 8 + length]
        if ctype == b"tEXt":
            keyword, _, text = body.partition(b"\x00")
            try:
                out[keyword.decode("latin-1")] = text.decode("latin-1")
            except Exception:
                pass
        i += 12 + length
        if ctype == b"IEND":
            break
    return out


def _looks_like_card(raw) -> bool:
    if not isinstance(raw, dict):
        return False
    if raw.get("spec") in ("chara_card_v2", "chara_card_v3") and isinstance(raw.get("data"), dict):
        return True
    # Flat V1: a name plus at least one card-ish text field.
    if isinstance(raw.get("name"), str) and any(
        isinstance(raw.get(k), str) and raw.get(k)
        for k in ("description", "first_mes", "personality", "scenario", "mes_example")
    ):
        return True
    # Pygmalion / Gradio flat shape.
    if isinstance(raw.get("char_name"), str) and raw.get("char_name"):
        return True
    return False


def _normalize_card(raw: dict) -> dict:
    spec = raw.get("spec")
    if isinstance(raw.get("data"), dict) and spec in ("chara_card_v2", "chara_card_v3"):
        d = raw["data"]
        detected = "v3" if spec == "chara_card_v3" else "v2"
    else:
        d = raw
        detected = "v1"

    def s(*keys) -> str:
        for k in keys:
            v = d.get(k)
            if isinstance(v, str) and v:
                return v
        return ""

    def strs(*keys) -> list:
        for k in keys:
            v = d.get(k)
            if isinstance(v, list):
                return [x for x in v if isinstance(x, str)]
        return []

    cv = d.get("character_version")
    book = d.get("character_book")
    ext = d.get("extensions")
    return {
        "name": s("name", "char_name"),
        "description": s("description", "char_persona", "persona"),
        "personality": s("personality"),
        "scenario": s("scenario", "world_scenario"),
        "first_mes": s("first_mes", "char_greeting", "greeting"),
        "mes_example": s("mes_example", "example_dialogue"),
        "system_prompt": s("system_prompt"),
        "post_history_instructions": s("post_history_instructions"),
        "creator_notes": s("creator_notes", "creatorcomment"),
        "alternate_greetings": strs("alternate_greetings"),
        "character_book": book if isinstance(book, dict) else None,
        "tags": strs("tags"),
        "creator": s("creator"),
        "character_version": str(cv) if cv not in (None, "") else "",
        "extensions": ext if isinstance(ext, dict) else {},
        "_spec": detected,
    }


# ── Write ────────────────────────────────────────────────────────────────────

def write_card(card_data: dict, image_bytes: Optional[bytes] = None) -> bytes:
    """Encode canonical card data + an image into a SillyTavern-importable
    PNG carrying both a `chara` (V2) and a `ccv3` (V3) tEXt chunk.

    `image_bytes` is normalised to PNG; when absent or undecodable a plain
    placeholder is generated so the card is always a valid image.
    """
    png = _ensure_png(image_bytes, card_data.get("name", "") or "")
    v2 = _build_envelope(card_data, "chara_card_v2", "2.0")
    v3 = _build_envelope(card_data, "chara_card_v3", "3.0")
    chara_b64 = base64.b64encode(json.dumps(v2, ensure_ascii=False).encode("utf-8")).decode("ascii")
    ccv3_b64 = base64.b64encode(json.dumps(v3, ensure_ascii=False).encode("utf-8")).decode("ascii")
    return _inject_card_chunks(png, chara_b64, ccv3_b64)


def _build_envelope(card_data: dict, spec: str, spec_version: str) -> dict:
    data = {
        "name": card_data.get("name", "") or "",
        "description": card_data.get("description", "") or "",
        "personality": card_data.get("personality", "") or "",
        "scenario": card_data.get("scenario", "") or "",
        "first_mes": card_data.get("first_mes", "") or "",
        "mes_example": card_data.get("mes_example", "") or "",
        "system_prompt": card_data.get("system_prompt", "") or "",
        "post_history_instructions": card_data.get("post_history_instructions", "") or "",
        "creator_notes": card_data.get("creator_notes", "") or "",
        "alternate_greetings": list(card_data.get("alternate_greetings") or []),
        "tags": list(card_data.get("tags") or []),
        "creator": card_data.get("creator", "") or "",
        "character_version": card_data.get("character_version", "") or "",
        "extensions": dict(card_data.get("extensions") or {}),
    }
    book = card_data.get("character_book")
    if isinstance(book, dict) and book:
        data["character_book"] = book
    env = {"spec": spec, "spec_version": spec_version, "data": data}
    # Mirror the core fields at the root for V1 / V2 readers that look there.
    for k in ("name", "description", "personality", "scenario", "first_mes", "mes_example"):
        env[k] = data[k]
    return env


def _ensure_png(image_bytes: Optional[bytes], name: str = "") -> bytes:
    if image_bytes:
        try:
            img = Image.open(io.BytesIO(image_bytes))
            img = ImageOps.exif_transpose(img)
            if img.mode not in ("RGB", "RGBA"):
                img = img.convert("RGBA")
            out = io.BytesIO()
            img.save(out, format="PNG")
            return out.getvalue()
        except Exception:
            pass
    return _placeholder_png(name)


def _placeholder_png(name: str = "") -> bytes:
    """Generate a plain portrait-card placeholder. When a name is given it
    is overlaid centred, word-wrapped, with the font auto-sized down to fit."""
    w, h = 400, 600
    img = Image.new("RGB", (w, h), (38, 38, 46))
    draw = ImageDraw.Draw(img)
    label = (name or "").strip()
    if label:
        margin = 36
        max_w = w - 2 * margin
        font, lines, line_h = None, [label], 0
        for size in (56, 48, 40, 32, 26, 22):
            font = _placeholder_font(size)
            lines = _wrap_text(draw, label, font, max_w)
            line_h = int(size * 1.28)
            widest = max((draw.textlength(ln, font=font) for ln in lines), default=0)
            if line_h * len(lines) <= h - 2 * margin and widest <= max_w:
                break
        total_h = line_h * len(lines)
        y = (h - total_h) // 2
        for ln in lines:
            lw = draw.textlength(ln, font=font)
            draw.text(((w - lw) / 2, y), ln, font=font, fill=(228, 228, 235))
            y += line_h
    out = io.BytesIO()
    img.save(out, format="PNG")
    return out.getvalue()


def _placeholder_font(size: int):
    """A scalable default font at the requested size (Pillow 10+), with
    graceful fallbacks so a missing font never breaks card export."""
    try:
        return ImageFont.load_default(size=size)
    except Exception:
        try:
            return ImageFont.load_default()
        except Exception:
            return None


def _wrap_text(draw, text: str, font, max_width: float) -> list:
    """Greedy word-wrap to `max_width`, hard-breaking any single word that
    is itself too wide."""
    words = text.split()
    if not words:
        return [text]
    lines = []
    cur = words[0]
    for word in words[1:]:
        if draw.textlength(cur + " " + word, font=font) <= max_width:
            cur = cur + " " + word
        else:
            lines.append(cur)
            cur = word
    lines.append(cur)
    wrapped = []
    for ln in lines:
        if draw.textlength(ln, font=font) <= max_width:
            wrapped.append(ln)
            continue
        piece = ""
        for ch in ln:
            if draw.textlength(piece + ch, font=font) <= max_width:
                piece += ch
            else:
                if piece:
                    wrapped.append(piece)
                piece = ch
        if piece:
            wrapped.append(piece)
    return wrapped


def _png_text_chunk(keyword: str, text: str) -> bytes:
    body = keyword.encode("latin-1") + b"\x00" + text.encode("latin-1")
    crc = zlib.crc32(b"tEXt" + body) & 0xffffffff
    return len(body).to_bytes(4, "big") + b"tEXt" + body + crc.to_bytes(4, "big")


def _inject_card_chunks(png: bytes, chara_b64: str, ccv3_b64: str) -> bytes:
    png = _strip_card_text_chunks(png)
    idx = png.rfind(b"IEND") - 4  # start of the IEND chunk's length field
    return (
        png[:idx]
        + _png_text_chunk("chara", chara_b64)
        + _png_text_chunk("ccv3", ccv3_b64)
        + png[idx:]
    )


def _strip_card_text_chunks(png: bytes) -> bytes:
    """Drop any existing `chara` / `ccv3` tEXt chunks so a re-encode doesn't
    accumulate stale copies."""
    out = bytearray(png[:8])
    i = 8
    n = len(png)
    while i + 8 <= n:
        length = int.from_bytes(png[i:i + 4], "big")
        ctype = png[i + 4:i + 8]
        chunk = png[i:i + 12 + length]
        keep = True
        if ctype == b"tEXt":
            keyword = png[i + 8:i + 8 + length].partition(b"\x00")[0].decode("latin-1", "replace")
            if keyword in ("chara", "ccv3"):
                keep = False
        if keep:
            out += chunk
        i += 12 + length
        if ctype == b"IEND":
            break
    return bytes(out)


# ── Import mapping (canonical card -> new-entity draft) ──────────────────────
# Turns parsed card data into a draft for a new NarrativeNode character entity
# (baseline / origin values), applying the Phase 7.2 import decisions:
#   - secondary fields become labelled text attributes (Decision 1)
#   - {{char}} / {{user}} macros are substituted (Decision 2)
#   - each lorebook entry becomes its own "Lore: <key>" text attribute;
#     provenance goes to notes (Decision 3)
#   - tags pass through as names for the caller to find-or-create (Decision 7)
# The caller (frontend) turns this draft into the Entity: find-or-create the
# tag names, upload the card image as the profile image, then createEntity.

_SECONDARY_FIELDS = [
    ("personality", "Personality"),
    ("scenario", "Scenario"),
    ("first_mes", "First Message"),
    ("mes_example", "Example Dialogue"),
    ("system_prompt", "System Prompt"),
    ("post_history_instructions", "Post-History Instructions"),
]


def card_to_entity_draft(card_data: dict, user_term: str = DEFAULT_USER_TERM) -> dict:
    """Map canonical card data to a new-character-entity draft. Returns a
    plain dict: {name, description, attributes:[{name,value}], tag_names:[str],
    notes, colour}."""
    name = (card_data.get("name") or "").strip() or "Imported Character"

    def m(text: str) -> str:
        return apply_macros_inbound(text or "", name, user_term)

    # Description = just the card description; the lorebook becomes attributes
    # below, consistent with the other preserved secondary content.
    description = m(card_data["description"]) if (card_data.get("description") or "").strip() else ""

    # Secondary fields -> labelled text attributes (non-empty only).
    attributes = []
    for key, label in _SECONDARY_FIELDS:
        val = card_data.get(key)
        if isinstance(val, str) and val.strip():
            attributes.append({"name": label, "value": m(val)})
    alts = [a for a in (card_data.get("alternate_greetings") or []) if isinstance(a, str) and a.strip()]
    if alts:
        attributes.append({"name": "Alternate Greetings", "value": "\n\n---\n\n".join(m(a) for a in alts)})
    # Lorebook entries -> one "Lore: <key>" attribute each (Decision 3).
    attributes.extend(_lorebook_attributes(card_data.get("character_book"), m))

    # Notes = creator_notes + provenance (meta, not character content).
    note_parts = []
    if (card_data.get("creator_notes") or "").strip():
        note_parts.append(m(card_data["creator_notes"]))
    prov = []
    if (card_data.get("creator") or "").strip():
        prov.append(f"Creator: {card_data['creator'].strip()}")
    if (card_data.get("character_version") or "").strip():
        prov.append(f"Card version: {card_data['character_version'].strip()}")
    prov.append("Imported from a SillyTavern character card.")
    note_parts.append(" | ".join(prov))
    notes = "\n\n".join(note_parts)

    return {
        "name": name,
        "description": description,
        "attributes": attributes,
        "tag_names": [t.strip() for t in (card_data.get("tags") or []) if isinstance(t, str) and t.strip()],
        "notes": notes,
        "colour": "#888888",
    }


def _lorebook_attributes(book, m) -> list:
    """Turn a card's lorebook (character_book) into one text attribute per
    entry, named "Lore: <comment-or-keys>". `m` applies inbound macros to the
    entry content. Each entry stays individually visible and prunable."""
    if not isinstance(book, dict):
        return []
    entries = book.get("entries")
    if not isinstance(entries, list):
        return []
    out = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        content = (entry.get("content") or "").strip()
        if not content:
            continue
        keys = [k for k in (entry.get("keys") or []) if isinstance(k, str)]
        label = (entry.get("comment") or "").strip() or (", ".join(keys) if keys else "Entry")
        out.append({"name": f"Lore: {label}", "value": m(content)})
    return out
