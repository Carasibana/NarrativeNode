"""Phase 2.5e — Inline-image shape scanner.

Single helper used by every chat-streaming adapter to detect image
data in upstream response chunks. The detection is shape-driven, not
model-driven: we scan each chunk for any of the known image-bearing
fields and yield a normalised receipt per image. The design
principle: if any chunk contains image-shaped data, recognise it —
don't gate by model.

The scanner is read-only and side-effect-free. Network fetches for
hosted URLs happen in `download_remote_image_to_data_url`, called
from the stream pump after the scanner has surfaced a receipt.
"""
from __future__ import annotations

import base64
import re
from dataclasses import dataclass
from typing import Iterable, List, Optional

import httpx


_DATA_URL_PREFIX_RE = re.compile(r"^data:([^;,]+)(?:;[^,]*)?,", re.IGNORECASE)
_FETCH_TIMEOUT_SECONDS = 30.0


@dataclass
class ImageReceipt:
    """One image extracted from a streaming chunk.

    `display_url` is always a `data:image/...;base64,...` string —
    when the upstream emitted a hosted URL the stream pump must
    download it via `download_remote_image_to_data_url` and replace
    the receipt's `display_url` with the resulting data URL BEFORE
    yielding the normalised event.

    `wire_url` is the original URL string the upstream gave us. It
    gets persisted on the assistant message and re-forwarded
    verbatim on subsequent turns. Could be either a `data:` URL
    (no transformation needed) or a hosted `https://` URL (we keep
    the original even though we also downloaded the bytes — the
    re-forward path uses this string, not the download).

    `mime_type` is sniffed from the data URL prefix when the
    `display_url` is a data URL; otherwise None until the download
    fills it from the Content-Type response header.

    `from_shape` is the detector that matched. Diagnostic only;
    callers can log which shape an upstream is using if a bug
    report includes it.
    """
    display_url: str
    wire_url: str
    mime_type: Optional[str]
    from_shape: str


def extract_inline_images_from_chunk(payload: dict) -> List[ImageReceipt]:
    """Scan a streaming SSE chunk payload for any image-bearing
    fields. Returns one receipt per image found.

    Recognised shapes (numbered to match the planning doc):
      1. `delta.images: [{type:"image_url", image_url:{url:"..."}}]`
         (OpenRouter Gemini path — confirmed live 2026-05-21)
      2. `delta.images` with hosted URLs instead of data URLs (same
         shape, different URL flavour)
      3. `delta.content` as an ARRAY of content parts including
         `{type:"image_url", image_url:{url:"..."}}` parts (OpenAI
         spec for multimodal assistant output — documented; not yet
         observed live)
      4. `message.content` ARRAY on the choice (non-streaming /
         stream-end consolidated form)
      6. `delta.content` (or `message.content`) array with
         `{type:"image", source:{type:"base64", media_type:"...",
         data:"..."}}` parts (Anthropic shape — future)

    Shape 5 (tool-call returns) and 7 (URLs in prose text) are
    handled elsewhere and not surfaced by this scanner.

    The scanner walks the chunk's choices defensively; missing
    fields are treated as no-image, never raise.
    """
    receipts: List[ImageReceipt] = []
    if not isinstance(payload, dict):
        return receipts
    choices = payload.get("choices")
    if not isinstance(choices, list):
        return receipts
    for choice in choices:
        if not isinstance(choice, dict):
            continue
        delta = choice.get("delta")
        if isinstance(delta, dict):
            _scan_images_field(delta.get("images"), "delta.images", receipts)
            _scan_content_array(delta.get("content"), "delta.content", receipts)
        message = choice.get("message")
        if isinstance(message, dict):
            _scan_images_field(message.get("images"), "message.images", receipts)
            _scan_content_array(message.get("content"), "message.content", receipts)
    return receipts


def _scan_images_field(images: object, from_shape: str, out: List[ImageReceipt]) -> None:
    """Shape 1 / 2: `delta.images` (or `message.images`) array."""
    if not isinstance(images, list):
        return
    for item in images:
        if not isinstance(item, dict):
            continue
        # Sub-shape: { type: "image_url", image_url: { url: "..." } }
        image_url = item.get("image_url")
        if isinstance(image_url, dict):
            url = image_url.get("url")
            if isinstance(url, str) and url:
                out.append(_receipt_from_url(url, from_shape))
                continue
        # Sub-shape (Anthropic-style on message.images, hypothetical):
        # { type: "image", source: { type: "base64", media_type, data } }
        source = item.get("source")
        if isinstance(source, dict):
            r = _receipt_from_anthropic_source(source, from_shape)
            if r is not None:
                out.append(r)


def _scan_content_array(content: object, from_shape: str, out: List[ImageReceipt]) -> None:
    """Shape 3 / 4 / 6: `delta.content` or `message.content` as an
    array of content parts. Walks each part looking for image
    content types."""
    if not isinstance(content, list):
        return
    for part in content:
        if not isinstance(part, dict):
            continue
        part_type = part.get("type")
        if part_type == "image_url":
            image_url = part.get("image_url")
            if isinstance(image_url, dict):
                url = image_url.get("url")
                if isinstance(url, str) and url:
                    out.append(_receipt_from_url(url, f"{from_shape}[type=image_url]"))
                    continue
        elif part_type == "image":
            # Anthropic shape (shape #6).
            source = part.get("source")
            if isinstance(source, dict):
                r = _receipt_from_anthropic_source(source, f"{from_shape}[type=image]")
                if r is not None:
                    out.append(r)


def _receipt_from_url(url: str, from_shape: str) -> ImageReceipt:
    """Build a receipt from a string URL. For data URLs we can sniff
    the MIME immediately; for hosted URLs the MIME stays None until
    the download step fills it from the Content-Type header."""
    if url.startswith("data:"):
        mime = _sniff_mime_from_data_url(url)
        return ImageReceipt(
            display_url=url,
            wire_url=url,
            mime_type=mime,
            from_shape=from_shape,
        )
    # Hosted URL — stream pump will download and rewrite display_url.
    return ImageReceipt(
        display_url=url,  # placeholder; overwritten after download
        wire_url=url,
        mime_type=None,
        from_shape=from_shape,
    )


def _receipt_from_anthropic_source(source: dict, from_shape: str) -> Optional[ImageReceipt]:
    """Build a receipt from an Anthropic-shape `source` block:
    `{type:"base64", media_type:"image/...", data:"<b64>"}`."""
    if source.get("type") != "base64":
        return None
    media_type = source.get("media_type")
    data = source.get("data")
    if not isinstance(media_type, str) or not isinstance(data, str) or not data:
        return None
    url = f"data:{media_type};base64,{data}"
    return ImageReceipt(
        display_url=url,
        wire_url=url,
        mime_type=media_type,
        from_shape=from_shape,
    )


def _sniff_mime_from_data_url(url: str) -> Optional[str]:
    """Extract the MIME from a `data:<mime>;...,<payload>` prefix."""
    m = _DATA_URL_PREFIX_RE.match(url)
    if m is None:
        return None
    return m.group(1)


async def download_remote_image_to_data_url(url: str) -> ImageReceipt:
    """Fetch a hosted image URL and return a receipt whose
    `display_url` is a `data:` URL of the downloaded bytes. The
    original URL is preserved as `wire_url` so subsequent-turn
    re-forwarding mirrors what the upstream gave us.

    Raises `httpx.HTTPError` on network failure, `ValueError` on
    non-success status or unrecognised content type. The stream
    pump catches these and yields an error event to the chat panel.
    """
    if url.startswith("data:"):
        # Caller should not have invoked this — already a data URL.
        # Return a receipt anyway for caller convenience.
        return ImageReceipt(
            display_url=url,
            wire_url=url,
            mime_type=_sniff_mime_from_data_url(url),
            from_shape="(already-data-url)",
        )
    async with httpx.AsyncClient(timeout=_FETCH_TIMEOUT_SECONDS) as client:
        resp = await client.get(url)
        if resp.status_code >= 400:
            raise ValueError(
                f"Couldn't download generated image from upstream: HTTP {resp.status_code} for {url[:120]}"
            )
        content_type = (resp.headers.get("content-type") or "").split(";")[0].strip().lower()
        if not content_type.startswith("image/"):
            # The URL might have served HTML / JSON / something
            # else; treat as an error.
            raise ValueError(
                f"Upstream image URL returned non-image content-type {content_type!r} for {url[:120]}"
            )
        data_b64 = base64.b64encode(resp.content).decode("ascii")
        data_url = f"data:{content_type};base64,{data_b64}"
        return ImageReceipt(
            display_url=data_url,
            wire_url=url,
            mime_type=content_type,
            from_shape="(downloaded-from-hosted)",
        )
