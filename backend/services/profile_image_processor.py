"""Profile-image preprocessing — Phase 2.5e MCP tool support.

Mirrors the UI's profile-image processing pipeline (see
`frontend/src/components/entities/ProfileImageUpload.jsx`,
`getCroppedBlob`) so AI-provided images and writer-uploaded
images converge on identical post-processing: a 256×256 JPEG
encoded at quality 90.

The UI gets its cropped region from the react-easy-crop modal,
where the writer can pan / zoom to choose what part of the image
to use. The MCP path has no UI — the AI just hands over bytes.
The convention we promise the AI is:

  - A SQUARE source image is preferred.
  - A NON-SQUARE source image will be centred-cropped to the
    largest centred square the image contains, then resized.
    The full image stays visible inside the square (we just
    trim equal slices from the long edge); we do NOT crop to
    a small portion of the image.

EXIF metadata strips out as a side-effect of decoding via PIL
and re-encoding to JPEG — same privacy-and-size win the
`attachmentEncoding.js` chat path gets from its canvas round-
trip.
"""
from __future__ import annotations

import io
from typing import Optional

from PIL import Image, ImageOps


PROFILE_IMAGE_PX = 256
PROFILE_JPEG_QUALITY = 90


def preprocess_profile_image_bytes(raw_bytes: bytes, vertical_anchor: str = "center") -> bytes:
    """Run raw image bytes through the canonical profile-image
    pipeline and return the post-processed JPEG bytes.

    Pipeline:
      1. Open via PIL. `ImageOps.exif_transpose` honours the
         source EXIF orientation so a portrait photo doesn't end
         up sideways. EXIF metadata is then discarded by the
         JPEG re-encode at the end.
      2. Convert to RGB if needed (RGBA gets flattened onto a
         white background — JPEG doesn't carry alpha).
      3. Compute the largest centred square. For a W×H image
         where W >= H, that's `H × H` cropped from the centred
         horizontal slice; symmetric for H > W. For W == H,
         no crop happens — the whole image is the square.
      4. Resize to 256×256 with Lanczos resampling.
      5. Encode as JPEG at quality=90.

    Raises:
      ValueError if the bytes don't decode as an image.
    """
    if not raw_bytes:
        raise ValueError("Empty image bytes — nothing to preprocess.")
    try:
        img = Image.open(io.BytesIO(raw_bytes))
    except Exception as e:  # noqa: BLE001 — PIL raises many things
        raise ValueError(f"Could not decode image bytes: {e}") from e

    # Honour EXIF orientation before any geometry math, then drop EXIF.
    img = ImageOps.exif_transpose(img)

    # Flatten alpha onto white so the JPEG output looks right for
    # PNG/WebP sources with transparency. JPEG doesn't support alpha.
    if img.mode in ("RGBA", "LA"):
        background = Image.new("RGB", img.size, (255, 255, 255))
        # Use alpha as the mask so transparent pixels go white.
        alpha = img.split()[-1]
        background.paste(img.convert("RGB"), mask=alpha)
        img = background
    elif img.mode != "RGB":
        img = img.convert("RGB")

    # Crop to the largest square. Default trims the long edge equally
    # (centred). `vertical_anchor="top"` instead keeps the TOP of a PORTRAIT
    # source (where a character's head usually sits) by trimming only the
    # bottom — a centred crop otherwise lops off the top of the head, which
    # is common for character-card portraits. Horizontal centring is unchanged.
    w, h = img.size
    if w != h:
        side = min(w, h)
        left = (w - side) // 2
        if vertical_anchor == "top" and h > w:
            top = 0
        else:
            top = (h - side) // 2
        img = img.crop((left, top, left + side, top + side))

    # Resize the square to the target dimensions.
    if img.size != (PROFILE_IMAGE_PX, PROFILE_IMAGE_PX):
        img = img.resize((PROFILE_IMAGE_PX, PROFILE_IMAGE_PX), Image.Resampling.LANCZOS)

    out = io.BytesIO()
    img.save(out, format="JPEG", quality=PROFILE_JPEG_QUALITY, optimize=True)
    return out.getvalue()


def preprocess_profile_image_from_base64(b64: str) -> bytes:
    """Convenience wrapper — base64-decode then preprocess.

    The MCP tool surface takes base64 over the wire (JSON-safe);
    this strips the optional `data:image/...;base64,` prefix
    (the AI might include one or not) and hands the bytes to
    `preprocess_profile_image_bytes`.
    """
    import base64
    if not isinstance(b64, str) or not b64:
        raise ValueError("image_base64 must be a non-empty string.")
    payload = b64
    if payload.startswith("data:"):
        comma = payload.find(",")
        if comma < 0:
            raise ValueError("image_base64 looks like a data URL but has no comma separator.")
        payload = payload[comma + 1:]
    try:
        raw = base64.b64decode(payload, validate=False)
    except Exception as e:  # noqa: BLE001
        raise ValueError(f"image_base64 is not valid base64: {e}") from e
    return preprocess_profile_image_bytes(raw)
