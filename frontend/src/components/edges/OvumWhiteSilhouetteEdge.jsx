// Shhh! 🥚
// ovum_white — custom edge that renders the silhouette playback as
// SVG between the source/target nodes.
//
// Geometry: two wires share a stem out of the source handle, split
// 90° at (x0, sourceY) into top + bottom legs that climb to the
// rectangle corners, run across the top + bottom edges, drop / climb
// back to (x1, targetY), and merge to the target handle.
//
// Deviation strategy: SVG masking. The silhouette body (the filled
// outlines from potrace) becomes a "cutout" in a mask applied to
// the boundary wires. Wherever the silhouette covers the boundary,
// the boundary line is hidden. The same silhouette paths are then
// drawn on top as stroke-only outlines. Net effect: the boundary
// wire visually appears to deviate down/up to trace the silhouette
// outline at the points where they meet, then continues along the
// edge. Uses the original CLEAN potrace path strings — no polyline
// sampling, no per-frame parsing.

import { useMemo, useId } from 'react'

const ENCODED_W = 320
const ENCODED_H = 240
const STEM_LEN = 30           // shared horizontal stem length out of each handle
// The encoded silhouette frames have padding around the figure (the
// black-background portion of the source video). If we draw the
// rectangle border at the outer bounds of the encoded area, the body
// rarely reaches it and the mask cuts almost nothing. Insetting the
// border pulls it inside the silhouette display area where the body
// actually exists, so body-fill cutouts can punch the wire.
const BORDER_INSET = 6
const DONUT_OUTER_EXTEND = 20   // donut outer edge sits this far OUTSIDE the inner border
const CORNER_RADIUS = 12        // inner-border corner radius (slightly bigger than canvas-node corner radius)

// ── SVG path helpers ─────────────────────────────────────────────────
// A hidden DOM-mounted path element used for getBBox so the mask can
// resolve each silhouette's x-extent reliably across browsers.
let _samplerEl = null
function getSamplerEl() {
  if (_samplerEl) return _samplerEl
  if (typeof document === 'undefined' || !document.body) return null
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('width', '0')
  svg.setAttribute('height', '0')
  svg.style.position = 'absolute'
  svg.style.left = '-9999px'
  svg.style.pointerEvents = 'none'
  svg.style.opacity = '0'
  _samplerEl = document.createElementNS(ns, 'path')
  svg.appendChild(_samplerEl)
  document.body.appendChild(svg)
  return _samplerEl
}

function isPointInPathD(d, x, y) {
  const el = getSamplerEl()
  if (!el || !d) return false
  el.setAttribute('d', d)
  el.setAttribute('fill-rule', 'evenodd')
  try {
    return el.isPointInFill({ x, y })
  } catch { return false }
}

function isPointInAnyPath(pathDs, x, y) {
  for (const d of pathDs) {
    if (isPointInPathD(d, x, y)) return true
  }
  return false
}

export default function OvumWhiteSilhouetteEdge({
  sourceX, sourceY, targetX, targetY, data,
}) {
  const phase     = data?.phase     || 'IDLE'
  const splitFrac = data?.splitFrac ?? 0
  const dashFrac  = data?.dashFrac  ?? 0
  const frame     = data?.frame     || null
  const accent    = data?.accent    || '#aaaaaa'
  const time      = data?.time      ?? 0

  const reactId = useId()
  const maskId = `ovum-white-mask-${reactId.replace(/:/g, '')}`
  const outlineMaskId = `ovum-white-outline-mask-${reactId.replace(/:/g, '')}`

  const geometry = useMemo(() => {
    const x0 = sourceX + STEM_LEN
    const x1 = targetX - STEM_LEN
    const cy = (sourceY + targetY) / 2
    const w  = Math.max(0, x1 - x0)
    const aspectH = w * (ENCODED_H / ENCODED_W)
    const fullHalfH = aspectH / 2
    const halfH = fullHalfH * splitFrac
    const yTop = cy - halfH
    const yBot = cy + halfH
    const scaleX = w / ENCODED_W
    const scaleY = (yBot - yTop) / ENCODED_H
    return { x0, x1, cy, w, halfH, yTop, yBot, aspectH, scaleX, scaleY }
  }, [sourceX, sourceY, targetX, targetY, splitFrac])

  const { x0, x1, w, yTop, yBot, scaleX, scaleY } = geometry

  // Mask coverage area — must include all parts of both border paths
  // (stems, vertical drops, top+bottom horizontals) so the mask defines
  // visibility everywhere those paths render. White = visible by default,
  // silhouette paths punch black holes (hidden) where they cover.
  // Hoisted above the early return below to keep Hook order stable.
  const maskBounds = useMemo(() => {
    const minX = Math.min(sourceX, targetX, x0, x1) - 20
    const maxX = Math.max(sourceX, targetX, x0, x1) + 20
    const minY = Math.min(sourceY, targetY, yTop, yBot) - 20
    const maxY = Math.max(sourceY, targetY, yTop, yBot) + 20
    return { minX, minY, w: maxX - minX, h: maxY - minY }
  }, [sourceX, sourceY, targetX, targetY, x0, x1, yTop, yBot])

  if (geometry.w <= 0) return null

  // Border-rectangle coords: inset from the silhouette display area so
  // the silhouette body (which has padding around the figure in encoded
  // frames) actually reaches and overlaps the border. The mask transform
  // and outline rendering still use yTop/yBot/x0/x1 unchanged — only the
  // border path coords are shrunk inward.
  const inset = Math.min(BORDER_INSET, w * 0.3, (yBot - yTop) * 0.3)
  const brTop   = yTop + inset
  const brBot   = yBot - inset
  const brLeft  = x0 + inset
  const brRight = x1 - inset

  // Inner-border corner radius. Clamped so the rounded corners always
  // fit (half the smaller of the rectangle's width / height). Donut
  // outer radius = inner radius + DONUT_OUTER_EXTEND so the band stays
  // uniform thickness around all four corners.
  const cornerR = Math.max(0, Math.min(
    CORNER_RADIUS,
    (brRight - brLeft) / 2,
    (brBot - brTop) / 2,
  ))
  const Ri = cornerR
  const Ro = cornerR + DONUT_OUTER_EXTEND

  // Donut outline mask: outer rect = inner border rect extended by
  // DONUT_OUTER_EXTEND in every direction; inner rect = the inner
  // border rect itself. Anywhere a silhouette outline portion overlaps
  // the donut band (between outer and inner), it is hidden. The inner
  // border wire is unaffected since this mask only applies to the
  // silhouette outline group.
  const dnOuterTop   = brTop - DONUT_OUTER_EXTEND
  const dnOuterBot   = brBot + DONUT_OUTER_EXTEND
  const dnOuterLeft  = brLeft - DONUT_OUTER_EXTEND
  const dnOuterRight = brRight + DONUT_OUTER_EXTEND
  const dnInnerTop   = brTop
  const dnInnerBot   = brBot
  const dnInnerLeft  = brLeft
  const dnInnerRight = brRight

  // No fill — everything renders stroke-only. The encoded polarity
  // flag is ignored; both states use the user's accent colour for the
  // strokes. Without any BG rectangle, the canvas background shows
  // through the rectangle interior naturally.
  const inkColour = accent

  const borderOpacity =
    phase === 'PLAYBACK'
      ? 0.85 + 0.15 * (0.5 + 0.5 * Math.sin((time / 1500) * Math.PI * 2))
      : 1

  const showContent = phase === 'PLAYBACK' && frame && splitFrac > 0.5
  // Whether to apply the mask to borders (only when silhouette content
  // is visible, otherwise mask is unused and borders should render
  // un-cut for the bookend phases).
  const maskBorders = showContent && Array.isArray(frame?.paths) && frame.paths.length > 0

  const transform = `translate(${x0}, ${yTop}) scale(${scaleX}, ${scaleY})`
  const paths = (showContent && Array.isArray(frame?.paths)) ? frame.paths : []

  // Per-frame stem-endpoint shift. When the silhouette BODY (not its
  // bbox) actually covers a stem connection point at (brLeft, sourceY) /
  // (brRight, targetY), the rectangle border there is body-fill masked
  // → invisible, and the stem floats in mid-air. We use precise path
  // hit-testing to detect this and walk along the vertical to the
  // nearest exit point that's outside ALL silhouette bodies. Picks
  // whichever exit (up or down) is closer. Stays at default when the
  // connection point isn't actually covered.
  function stemEndpointYFor(stemX, defaultY) {
    if (!paths || paths.length === 0) return defaultY
    const encX = (stemX - x0) / (scaleX || 1)
    const encY = (defaultY - yTop) / (scaleY || 1)
    if (encX < 0 || encX > ENCODED_W) return defaultY
    if (!isPointInAnyPath(paths, encX, encY)) return defaultY
    const STEP = 2  // encoded units; ~2px in user space at scale 1
    let upEncY = encY
    while (upEncY > 0 && isPointInAnyPath(paths, encX, upEncY)) {
      upEncY -= STEP
    }
    let downEncY = encY
    while (downEncY < ENCODED_H && isPointInAnyPath(paths, encX, downEncY)) {
      downEncY += STEP
    }
    const upUserY   = Math.max(upEncY   * scaleY + yTop, brTop)
    const downUserY = Math.min(downEncY * scaleY + yTop, brBot)
    const distUp   = Math.abs(defaultY - upUserY)
    const distDown = Math.abs(downUserY - defaultY)
    return distUp <= distDown ? upUserY : downUserY
  }
  const stemLeftY  = phase === 'PLAYBACK' ? stemEndpointYFor(brLeft,  sourceY) : sourceY
  const stemRightY = phase === 'PLAYBACK' ? stemEndpointYFor(brRight, targetY) : targetY

  // ── Boundary paths (split into 3 per wire) ─────────────────────────
  // Each wire owns one ENTIRE HALF of the rectangle's perimeter (its
  // vertical legs + its horizontal edge), and deviates wherever the
  // silhouette body touches any of those edges. The shared stems
  // connecting both wires to the source/target handles are NEVER
  // masked.
  //
  // Shared stems run from each handle to the inset border-rectangle's
  // left/right edge. The far endpoint may be shifted vertically (via
  // stemLeftY / stemRightY above) so the stem angles to land on a
  // visible portion of the border whenever the body covers the natural
  // connection point.
  const stemLeft  = `M ${sourceX} ${sourceY} L ${brLeft} ${stemLeftY}`
  const stemRight = `M ${brRight} ${stemRightY} L ${targetX} ${targetY}`

  // Top wire's masked middle: U-shape with rounded top-left and
  // top-right corners (sweep=1 since traversed clockwise around the
  // top of the rectangle).
  const topMasked =
    `M ${brLeft} ${stemLeftY} ` +
    `L ${brLeft} ${brTop + Ri} ` +
    `A ${Ri} ${Ri} 0 0 1 ${brLeft + Ri} ${brTop} ` +
    `L ${brRight - Ri} ${brTop} ` +
    `A ${Ri} ${Ri} 0 0 1 ${brRight} ${brTop + Ri} ` +
    `L ${brRight} ${stemRightY}`

  // Bottom wire's masked middle: U-shape with rounded bottom-left and
  // bottom-right corners (sweep=0 since traversed counter-clockwise
  // around the bottom of the rectangle).
  const botMasked =
    `M ${brLeft} ${stemLeftY} ` +
    `L ${brLeft} ${brBot - Ri} ` +
    `A ${Ri} ${Ri} 0 0 0 ${brLeft + Ri} ${brBot} ` +
    `L ${brRight - Ri} ${brBot} ` +
    `A ${Ri} ${Ri} 0 0 0 ${brRight} ${brBot - Ri} ` +
    `L ${brRight} ${stemRightY}`

  // Dash patterns for CONNECT / DISCONNECT bookends.
  const lineLenEst = w + Math.abs(sourceY - yTop) + Math.abs(targetY - yTop) + 2 * STEM_LEN
  const drawn  = dashFrac * lineLenEst
  const hidden = Math.max(0.001, lineLenEst - drawn)
  const dashAttr = `${drawn} ${hidden}`

  return (
    <g className="ovum-white-edge" pointerEvents="none">
      {/* No BG fill — the rectangle interior is just the canvas
          showing through. Strokes do all the visible work. */}

      {/* Mask: white covering everything = visible; silhouette paths
          fill black = hidden. Applied to the boundary wires so they
          appear cut wherever the silhouette body sits. */}
      <defs>
        <mask
          id={maskId}
          maskUnits="userSpaceOnUse"
          maskContentUnits="userSpaceOnUse"
          x={maskBounds.minX}
          y={maskBounds.minY}
          width={maskBounds.w}
          height={maskBounds.h}
        >
          {/* White everywhere = visible, then silhouette paths punch
              black holes for the cutouts. */}
          <rect
            x={maskBounds.minX}
            y={maskBounds.minY}
            width={maskBounds.w}
            height={maskBounds.h}
            fill="white"
          />
          {paths.length > 0 && (
            <g transform={transform}>
              {/* Body-fill cutouts: each silhouette path is filled black,
                  cutting the boundary wire wherever the body actually
                  covers it. Respects overhangs and concavities — the cut
                  follows the silhouette outline exactly. */}
              {paths.map((d, i) => (
                <path key={i} d={d} fill="black" fillRule="evenodd" />
              ))}
            </g>
          )}
        </mask>

        {/* Hollow-rectangle outline mask: hides any portion of the
            silhouette outline that crosses through the rectangle border
            ring. White everywhere visible by default; the ring (between
            outer and inner rectangles, evenodd-filled) is black. */}
        <mask
          id={outlineMaskId}
          maskUnits="userSpaceOnUse"
          maskContentUnits="userSpaceOnUse"
          x={maskBounds.minX}
          y={maskBounds.minY}
          width={maskBounds.w}
          height={maskBounds.h}
        >
          <rect
            x={maskBounds.minX}
            y={maskBounds.minY}
            width={maskBounds.w}
            height={maskBounds.h}
            fill="white"
          />
          <path
            d={
              // Outer rounded rectangle (clockwise, sweep=1).
              `M ${dnOuterLeft + Ro} ${dnOuterTop} ` +
              `L ${dnOuterRight - Ro} ${dnOuterTop} ` +
              `A ${Ro} ${Ro} 0 0 1 ${dnOuterRight} ${dnOuterTop + Ro} ` +
              `L ${dnOuterRight} ${dnOuterBot - Ro} ` +
              `A ${Ro} ${Ro} 0 0 1 ${dnOuterRight - Ro} ${dnOuterBot} ` +
              `L ${dnOuterLeft + Ro} ${dnOuterBot} ` +
              `A ${Ro} ${Ro} 0 0 1 ${dnOuterLeft} ${dnOuterBot - Ro} ` +
              `L ${dnOuterLeft} ${dnOuterTop + Ro} ` +
              `A ${Ro} ${Ro} 0 0 1 ${dnOuterLeft + Ro} ${dnOuterTop} Z ` +
              // Inner rounded rectangle (clockwise, sweep=1) — even-odd
              // fill subtracts this from the outer to leave a uniform
              // donut band around the inner border.
              `M ${dnInnerLeft + Ri} ${dnInnerTop} ` +
              `L ${dnInnerRight - Ri} ${dnInnerTop} ` +
              `A ${Ri} ${Ri} 0 0 1 ${dnInnerRight} ${dnInnerTop + Ri} ` +
              `L ${dnInnerRight} ${dnInnerBot - Ri} ` +
              `A ${Ri} ${Ri} 0 0 1 ${dnInnerRight - Ri} ${dnInnerBot} ` +
              `L ${dnInnerLeft + Ri} ${dnInnerBot} ` +
              `A ${Ri} ${Ri} 0 0 1 ${dnInnerLeft} ${dnInnerBot - Ri} ` +
              `L ${dnInnerLeft} ${dnInnerTop + Ri} ` +
              `A ${Ri} ${Ri} 0 0 1 ${dnInnerLeft + Ri} ${dnInnerTop} Z`
            }
            fill="black"
            fillRule="evenodd"
          />
        </mask>
      </defs>

      {phase === 'PLAYBACK' ? (
        // Four-segment render: shared stems (no mask) + each wire's
        // U-shaped masked middle that owns its half of the rectangle
        // perimeter. The masked middle is cut only where the silhouette
        // body actually intersects it (body-fill mask).
        <>
          <path
            d={stemLeft}
            fill="none"
            stroke={accent}
            strokeWidth={2}
            strokeOpacity={borderOpacity}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d={topMasked}
            fill="none"
            stroke={accent}
            strokeWidth={2}
            strokeOpacity={borderOpacity}
            strokeLinecap="round"
            strokeLinejoin="round"
            mask={maskBorders ? `url(#${maskId})` : undefined}
          />
          <path
            d={botMasked}
            fill="none"
            stroke={accent}
            strokeWidth={2}
            strokeOpacity={borderOpacity}
            strokeLinecap="round"
            strokeLinejoin="round"
            mask={maskBorders ? `url(#${maskId})` : undefined}
          />
          <path
            d={stemRight}
            fill="none"
            stroke={accent}
            strokeWidth={2}
            strokeOpacity={borderOpacity}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : (
        // Bookend phases (CONNECT / SPLIT / CLOSE / DISCONNECT) use a
        // single unified path per wire so the dasharray draw-in / draw-out
        // animation flows continuously source→target.
        <>
          <path
            d={
              `${stemLeft} ` +
              `L ${brLeft} ${brTop + Ri} ` +
              `A ${Ri} ${Ri} 0 0 1 ${brLeft + Ri} ${brTop} ` +
              `L ${brRight - Ri} ${brTop} ` +
              `A ${Ri} ${Ri} 0 0 1 ${brRight} ${brTop + Ri} ` +
              `L ${brRight} ${targetY} L ${targetX} ${targetY}`
            }
            fill="none"
            stroke={accent}
            strokeWidth={2}
            strokeOpacity={borderOpacity}
            strokeDasharray={dashAttr}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d={
              `${stemLeft} ` +
              `L ${brLeft} ${brBot - Ri} ` +
              `A ${Ri} ${Ri} 0 0 0 ${brLeft + Ri} ${brBot} ` +
              `L ${brRight - Ri} ${brBot} ` +
              `A ${Ri} ${Ri} 0 0 0 ${brRight} ${brBot - Ri} ` +
              `L ${brRight} ${targetY} L ${targetX} ${targetY}`
            }
            fill="none"
            stroke={accent}
            strokeWidth={2}
            strokeOpacity={borderOpacity}
            strokeDasharray={dashAttr}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}

      {/* Silhouette outlines — original clean potrace paths, drawn as
          stroke-only wireframes on top. The donut outline mask hides
          any portion that falls in the band outside the inner border.
          Mask is applied to an OUTER (untransformed) group; the encoded
          → user-space transform sits on an INNER group, so the mask's
          userSpaceOnUse coords are interpreted in the same coord system
          as the donut path. */}
      {showContent && paths.length > 0 && (
        <g mask={`url(#${outlineMaskId})`}>
          <g transform={transform}>
            {paths.map((d, i) => (
              <path
                key={i}
                d={d}
                fill="none"
                stroke={inkColour}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </g>
        </g>
      )}
    </g>
  )
}
