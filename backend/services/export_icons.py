"""Phase 1.25c — backend SVG icon registry for NarrativeNode-native exports.

Backend-side SVG generators for the visual icons NarrativeNode uses
in its UI. The frontend's React components are the visual reference;
the backend ports the same geometry into Python string output so
exports can carry the same iconography readers see in the app.

Renderers consume the SVG output differently:
  - HTML inlines the `<svg>` markup directly.
  - PDF (1.25c step 3) and DOCX (1.25c step 2) rasterise via svglib +
    reportlab.graphics.renderPM, then embed the resulting PNG.
  - Markdown / TXT / NovelCrafter variants ignore icons entirely
    (per user direction — non-image renderers stay text).

The intensity badge and type badge icons share the same pentagon
silhouette (deliberately — it's a visual family).

Frontend reference components (keep these in sync if either side
changes):
  - frontend/src/components/ui/IntensityBadge.jsx
  - frontend/src/components/ui/TypeBadges.jsx
"""
from __future__ import annotations

from io import BytesIO
from typing import Optional

# ── Per-tier colours (mirrors INTENSITY_COLOURS in IntensityBadge.jsx) ──
INTENSITY_COLOURS = (
    "#3b82f6",  # 0 — Faint    (cool blue)
    "#22d3ee",  # 1 — Mild     (cyan)
    "#84cc16",  # 2 — Moderate (yellow-green)
    "#f59e0b",  # 3 — Strong   (amber)
    "#f97316",  # 4 — Intense  (warm orange)
)

INTENSITY_LABELS = ("Faint", "Mild", "Moderate", "Strong", "Intense")

CIRCUMSTANCE_COLOUR = "#94a3b8"  # brightened slate (Tailwind slate-400)
MOTIVATOR_COLOUR = "#c89078"     # brightened terracotta-rust

# ── Pentagon geometry (mirrors the React components) ────────────────────
# Pentagon vertices in viewBox-space (centred at 0,0, radius 40).
PENTAGON_PATH = "M 0,-40 L 38.04,-12.36 L 23.51,32.36 L -23.51,32.36 L -38.04,-12.36 Z"

# Perimeter vertices ordered CW starting from lower-right. For level
# N (0..3), the filled wedge polygon is centre + perimeter[0..N+2].
_PERIMETER = (
    (23.51, 32.36),    # 0 — lower-right
    (-23.51, 32.36),   # 1 — lower-left
    (-38.04, -12.36),  # 2 — upper-left
    (0, -40),          # 3 — top
    (38.04, -12.36),   # 4 — upper-right
)


def _combined_fill_path(level: int) -> str:
    """Build the wedge-fill path for level 0..3 — centre + (level+2)
    perimeter vertices, closed. Mirrors `combinedFillPath` in
    IntensityBadge.jsx."""
    verts = _PERIMETER[: level + 2]
    segs = " ".join(f"L {x},{y}" for (x, y) in verts)
    return f"M 0,0 {segs} Z"


def intensity_badge_svg(level: Optional[int], size: int = 16, title: Optional[str] = None) -> str:
    """Return inline SVG markup for the intensity badge at the given level.

    `level` is 0..4 for tiered intensity, or None for the unset
    placeholder (dashed grey pentagon outline). Out-of-range integers
    are clamped to 0..4. Matches the rendering in the frontend's
    `IntensityBadge` component without the `temporary` corner-segment
    variant — exports do not currently need to distinguish temporary
    from ongoing visually (temporary is conveyed by the row's prefix
    text "Temporary Circumstance" / "Temporary Motivator").
    """
    if level is None:
        return _intensity_unset_svg(size=size, title=title or "Intensity unset")
    lv = max(0, min(4, int(round(level))))
    colour = INTENSITY_COLOURS[lv]
    label = title or INTENSITY_LABELS[lv]
    fill_path = PENTAGON_PATH if lv == 4 else _combined_fill_path(lv)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="-50 -50 100 100" '
        f'width="{size}" height="{size}" '
        'style="display:inline-block;vertical-align:middle;flex-shrink:0" '
        f'role="img" aria-label="{_xml_attr_escape(label)}">'
        f'<title>{_xml_text_escape(label)}</title>'
        f'<path d="{fill_path}" fill="{colour}" />'
        f'<path d="{PENTAGON_PATH}" fill="none" stroke="{colour}" '
        'stroke-width="3" stroke-linejoin="round" />'
        '</svg>'
    )


def _intensity_unset_svg(size: int, title: str) -> str:
    """Dashed grey pentagon outline — mirrors the unset branch in
    IntensityBadge.jsx."""
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="-50 -50 100 100" '
        f'width="{size}" height="{size}" '
        'style="display:inline-block;vertical-align:middle;flex-shrink:0" '
        f'role="img" aria-label="{_xml_attr_escape(title)}">'
        f'<title>{_xml_text_escape(title)}</title>'
        f'<path d="{PENTAGON_PATH}" fill="none" stroke="#71717a" '
        'stroke-width="3" stroke-linejoin="round" '
        'stroke-dasharray="6 5" opacity="0.7" />'
        '</svg>'
    )


def cm_type_badge_svg(attribute_type: str, size: int = 16, title: Optional[str] = None) -> str:
    """Return inline SVG markup for the circumstance / motivator type
    badge. `attribute_type` is `'circumstance'` or `'motivator'`; any
    other value returns an empty string (no badge — caller falls
    through to text label). Mirrors `CircumstanceTypeBadge` /
    `MotivatorTypeBadge` in TypeBadges.jsx.
    """
    if attribute_type == "circumstance":
        return _pentagon_letter_badge_svg("C", CIRCUMSTANCE_COLOUR, size, title or "Circumstance")
    if attribute_type == "motivator":
        return _pentagon_letter_badge_svg("M", MOTIVATOR_COLOUR, size, title or "Motivator")
    return ""


def _pentagon_letter_badge_svg(letter: str, colour: str, size: int, title: str) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="-50 -50 100 100" '
        f'width="{size}" height="{size}" '
        'style="display:inline-block;vertical-align:middle;flex-shrink:0" '
        f'role="img" aria-label="{_xml_attr_escape(title)}">'
        f'<title>{_xml_text_escape(title)}</title>'
        f'<path d="{PENTAGON_PATH}" fill="none" stroke="{colour}" '
        'stroke-width="3" stroke-linejoin="round" />'
        f'<text x="0" y="17" fill="{colour}" font-size="50" font-weight="700" '
        'text-anchor="middle" '
        'font-family="-apple-system, BlinkMacSystemFont, sans-serif">'
        f'{_xml_text_escape(letter)}</text>'
        '</svg>'
    )


# ── XML escaping helpers ─────────────────────────────────────────────
# Lightweight inline escapes — the values flowing through here are
# fully under our control (level labels, type names, single letters)
# but escaping defensively keeps the SVG output safe to drop into any
# HTML / DOCX / PDF context without surprises.

def _xml_attr_escape(s: str) -> str:
    return (
        s.replace("&", "&amp;")
        .replace('"', "&quot;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def _xml_text_escape(s: str) -> str:
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


# ── PNG rasterisation for raster-only renderers (PDF / DOCX) ─────────
# Paragraphs in ReportLab and runs in python-docx can carry inline
# images but not inline SVG. We render the same pentagon geometry into
# a small RGBA PNG via Pillow so the iconography matches the HTML
# version pixel-for-pixel.
#
# Each unique (kind, params, size) tuple is rendered once per process
# and cached. The cache lives in-memory, keyed by the tuple, value is
# a BytesIO holding the PNG bytes ready for embedding.

_PNG_CACHE: dict[tuple, bytes] = {}


def _scale_perimeter(size: int) -> tuple[tuple[float, float], ...]:
    """Map the viewBox-space perimeter (radius 40) to PNG pixel space
    (centred at size/2, radius = size/2 * 0.92 — a hair of margin so
    the stroke doesn't clip)."""
    cx = size / 2.0
    cy = size / 2.0
    r = (size / 2.0) * 0.92
    s = r / 40.0  # scale factor from viewBox units to pixels
    return tuple((cx + x * s, cy + y * s) for (x, y) in (
        (0, -40),
        (38.04, -12.36),
        (23.51, 32.36),
        (-23.51, 32.36),
        (-38.04, -12.36),
    ))


def intensity_badge_png(level: Optional[int], size: int = 24) -> bytes:
    """Return PNG bytes for an intensity badge at the given level.
    Cached per (level, size). `level` is 0..4 for tiered intensity
    (Faint/Mild/Moderate/Strong/Intense), or None for the unset
    placeholder (dashed grey outline)."""
    key = ("intensity", level, size)
    cached = _PNG_CACHE.get(key)
    if cached is not None:
        return cached

    from PIL import Image as PILImage, ImageDraw  # transitive via reportlab

    img = PILImage.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    perimeter = _scale_perimeter(size)
    pentagon = list(perimeter)
    cx = size / 2.0
    cy = size / 2.0

    if level is None:
        # Unset — dashed grey outline only.
        # Pillow doesn't draw dashed polygon natively; approximate by
        # short line segments along each edge.
        grey = (113, 113, 122, int(0.7 * 255))  # zinc-500 @ 70%
        stroke_w = max(1, size // 12)
        _draw_dashed_polygon(draw, pentagon, grey, stroke_w, dash_len=size * 0.075, gap_len=size * 0.06)
    else:
        lv = max(0, min(4, int(round(level))))
        colour = _hex_to_rgb(INTENSITY_COLOURS[lv])
        # Wedge fill: centre + perimeter[0..lv+2] (matches
        # _combined_fill_path in the SVG version). For lv=4 the wedge
        # IS the full pentagon — fill the whole shape.
        if lv == 4:
            draw.polygon(pentagon, fill=colour)
        else:
            wedge = [(cx, cy)] + list(perimeter[: lv + 2])
            draw.polygon(wedge, fill=colour)
        # Pentagon outline on top of the fill.
        stroke_w = max(1, size // 12)
        draw.line(pentagon + [pentagon[0]], fill=colour, width=stroke_w, joint="curve")

    out = BytesIO()
    img.save(out, format="PNG")
    data = out.getvalue()
    _PNG_CACHE[key] = data
    return data


def cm_type_badge_png(attribute_type: str, size: int = 24) -> Optional[bytes]:
    """Return PNG bytes for a circumstance / motivator type badge.
    `attribute_type` is `'circumstance'` or `'motivator'`; any other
    value returns None (caller falls through to text-only). Cached
    per (kind, size)."""
    if attribute_type == "circumstance":
        letter = "C"
        colour = CIRCUMSTANCE_COLOUR
    elif attribute_type == "motivator":
        letter = "M"
        colour = MOTIVATOR_COLOUR
    else:
        return None
    key = ("cm_type", attribute_type, size)
    cached = _PNG_CACHE.get(key)
    if cached is not None:
        return cached

    from PIL import Image as PILImage, ImageDraw, ImageFont

    img = PILImage.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    perimeter = _scale_perimeter(size)
    pentagon = list(perimeter)
    rgb = _hex_to_rgb(colour)
    stroke_w = max(1, size // 12)
    draw.line(pentagon + [pentagon[0]], fill=rgb, width=stroke_w, joint="curve")

    # Centred letter — pick a font size relative to badge size.
    font = _load_bold_font(int(size * 0.62))
    bbox = draw.textbbox((0, 0), letter, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    # textbbox includes the font's ascent/descent baseline offset; shift
    # by -bbox[1] so the glyph's top sits at y=0 before centring.
    tx = (size - tw) / 2.0 - bbox[0]
    ty = (size - th) / 2.0 - bbox[1]
    draw.text((tx, ty), letter, fill=rgb, font=font)

    out = BytesIO()
    img.save(out, format="PNG")
    data = out.getvalue()
    _PNG_CACHE[key] = data
    return data


def _hex_to_rgb(hex_str: str) -> tuple[int, int, int]:
    s = hex_str.lstrip("#")
    return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))


def _draw_dashed_polygon(draw, points, colour, width, dash_len, gap_len):
    """Approximate dashed-stroke polygon for the unset-intensity badge."""
    import math
    pts = list(points) + [points[0]]
    for i in range(len(pts) - 1):
        x1, y1 = pts[i]
        x2, y2 = pts[i + 1]
        dx, dy = x2 - x1, y2 - y1
        seg_len = math.hypot(dx, dy)
        if seg_len <= 0:
            continue
        ux, uy = dx / seg_len, dy / seg_len
        pos = 0.0
        on = True
        while pos < seg_len:
            step = dash_len if on else gap_len
            end = min(pos + step, seg_len)
            if on:
                draw.line(
                    [(x1 + ux * pos, y1 + uy * pos), (x1 + ux * end, y1 + uy * end)],
                    fill=colour,
                    width=width,
                )
            pos = end
            on = not on


def svg_to_png_bytes(svg: str, size: int = 32) -> Optional[bytes]:
    """Convert an inline SVG string to PNG bytes via `resvg-py`
    (MIT-licensed Python binding around the Linebender / RazrFalcon
    `resvg` Rust crate, dual MIT/Apache-2.0). Returns None on empty /
    malformed SVG (renderer call sites fall back to text-only).

    Used by the PDF and DOCX renderers to embed scene-time / season /
    time-of-day icons the frontend ships verbatim. Each unique SVG
    string + size combo is cached in `_PNG_CACHE` so a story with 100
    scenes worth of icons only rasterises each unique glyph once."""
    if not svg or not svg.strip():
        return None
    key = ("svg", svg, size)
    cached = _PNG_CACHE.get(key)
    if cached is not None:
        return cached
    try:
        import resvg_py
        raw = resvg_py.svg_to_bytes(
            svg_string=svg,
            width=size,
            height=size,
        )
        # `svg_to_bytes` returns `list[int]` in some builds; coerce.
        data = bytes(raw) if not isinstance(raw, bytes) else raw
        if not data or not data.startswith(b"\x89PNG"):
            return None
        _PNG_CACHE[key] = data
        return data
    except Exception:
        return None


# ── Phase 5.8b — scene-break ornament (dinkus) ──────────────────────────
#
# A centre diamond flanked by fading hairlines, used between consecutive
# scenes of the same chapter in the native export. HTML embeds the SVG
# inline (vector, `currentColor` so it follows the document theme); PDF and
# DOCX rasterise it via resvg; markdown / plain-text fall back to "* * *".
# Natural aspect ratio is 240:28.

SCENE_BREAK_TEXT = "* * *"
_SCENE_BREAK_RATIO = 28 / 240


def scene_break_svg(color: str = "#3a3a3a") -> str:
    """Return the scene-break ornament as an SVG string in the given
    colour. Pass "currentColor" for HTML so it follows the theme."""
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 28" width="240" height="28">'
        '<defs>'
        f'<linearGradient id="sbL" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="{color}" stop-opacity="0"/><stop offset="100%" stop-color="{color}" stop-opacity="0.9"/></linearGradient>'
        f'<linearGradient id="sbR" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="{color}" stop-opacity="0.9"/><stop offset="100%" stop-color="{color}" stop-opacity="0"/></linearGradient>'
        '</defs>'
        '<rect x="36" y="13.4" width="74" height="1.2" fill="url(#sbL)"/>'
        f'<polygon points="120,7 127,14 120,21 113,14" fill="{color}"/>'
        '<rect x="130" y="13.4" width="74" height="1.2" fill="url(#sbR)"/>'
        '</svg>'
    )


def scene_break_png(width: int = 200, color: str = "#3a3a3a") -> Optional[bytes]:
    """Rasterise the scene-break ornament to PNG bytes at `width` px,
    preserving the 240:28 aspect ratio. Cached per (width, colour).
    Returns None if resvg is unavailable or rendering fails."""
    height = max(1, round(width * _SCENE_BREAK_RATIO))
    key = ("scene_break", width, color)
    cached = _PNG_CACHE.get(key)
    if cached is not None:
        return cached
    try:
        import resvg_py
        raw = resvg_py.svg_to_bytes(
            svg_string=scene_break_svg(color),
            width=width,
            height=height,
        )
        data = bytes(raw) if not isinstance(raw, bytes) else raw
        if not data or not data.startswith(b"\x89PNG"):
            return None
        _PNG_CACHE[key] = data
        return data
    except Exception:
        return None


def _load_bold_font(px: int):
    """Return a PIL ImageFont rendering at roughly `px` pixels tall.
    Probes a handful of common system fonts so the glyphs in PDFs
    aren't the awful default bitmap font; falls back gracefully."""
    from PIL import ImageFont
    candidates = (
        "arialbd.ttf",      # Windows
        "Arial Bold.ttf",
        "DejaVuSans-Bold.ttf",  # Linux (commonly bundled)
        "Helvetica-Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",  # macOS
    )
    for path in candidates:
        try:
            return ImageFont.truetype(path, px)
        except (OSError, IOError):
            continue
    # Last resort — bitmap default. Letters will look chunky but
    # will at least be readable.
    return ImageFont.load_default()
