/**
 * Centralised POV colour tokens.
 *
 * The primary POV colour is user-configurable via Story Settings (story.pov_color).
 * Components should use `usePovColor()` in render or `getPovColor()` in handlers.
 * Derived colours (bright, bg tint, subtle border, glow) are computed from the primary.
 */
import { useProjectStore } from '../store/projectStore'

// ── Defaults ──────────────────────────────────────────────────────────────────

export const DEFAULT_POV_COLOR = '#eab308'
export const DEFAULT_ACCENT_COLOR = '#7c3aed'

// ── Getters (for use in event handlers, non-React code) ──────────────────────

/** Read the current POV colour from the store, falling back to default. */
export function getPovColor() {
  return useProjectStore.getState().story?.pov_color || DEFAULT_POV_COLOR
}

/** Read the current accent colour from the store, falling back to default. */
export function getAccentColor() {
  return useProjectStore.getState().story?.accent_color || DEFAULT_ACCENT_COLOR
}

// ── React hook (for use in component render) ─────────────────────────────────

/** Subscribe to the current POV colour — re-renders when it changes. */
export function usePovColor() {
  return useProjectStore((s) => s.story?.pov_color) || DEFAULT_POV_COLOR
}

/** Subscribe to the current accent colour — re-renders when it changes. */
export function useAccentColor() {
  return useProjectStore((s) => s.story?.accent_color) || DEFAULT_ACCENT_COLOR
}

// ── Derived colour helpers ───────────────────────────────────────────────────

// ── Accent colour palette generation ─────────────────────────────────────────

/**
 * Generate a full shade palette (50–950) from a single base colour.
 * The base colour is treated as the 700 shade (the primary).
 */
export function generateAccentPalette(base) {
  // Shade levels mapped to lightness multipliers relative to the base (700)
  return {
    50:  lighten(base, 0.92),
    100: lighten(base, 0.84),
    200: lighten(base, 0.72),
    300: lighten(base, 0.56),
    400: lighten(base, 0.38),
    500: lighten(base, 0.2),
    600: lighten(base, 0.08),
    700: base,
    800: darken(base, 0.2),
    900: darken(base, 0.4),
    950: darken(base, 0.6),
  }
}

/**
 * Apply an accent colour palette to the document's CSS custom properties.
 * This updates the Tailwind `accent-*` utilities in real time.
 */
export function applyAccentPalette(base) {
  const palette = generateAccentPalette(base)
  const root = document.documentElement
  for (const [shade, color] of Object.entries(palette)) {
    root.style.setProperty(`--color-accent-${shade}`, color)
  }
}

/** Lighten a hex colour by blending toward white. amount 0–1. */
export function lighten(hex, amount) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const lr = Math.round(r + (255 - r) * amount)
  const lg = Math.round(g + (255 - g) * amount)
  const lb = Math.round(b + (255 - b) * amount)
  return `#${lr.toString(16).padStart(2, '0')}${lg.toString(16).padStart(2, '0')}${lb.toString(16).padStart(2, '0')}`
}

/** Darken a hex colour by blending toward black. amount 0–1. */
export function darken(hex, amount) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const dr = Math.round(r * (1 - amount))
  const dg = Math.round(g * (1 - amount))
  const db = Math.round(b * (1 - amount))
  return `#${dr.toString(16).padStart(2, '0')}${dg.toString(16).padStart(2, '0')}${db.toString(16).padStart(2, '0')}`
}

/** Get derived POV colours from a base colour. */
export function getPovDerived(base) {
  return {
    color: base,
    bright: lighten(base, 0.3),
    bg: base + '15',
    borderSubtle: base + '44',
    glow: base + '44',
  }
}

// ── Legacy static exports (for gradual migration — prefer hook/getter above) ─

export const POV_COLOR = DEFAULT_POV_COLOR
export const POV_COLOR_BRIGHT = lighten(DEFAULT_POV_COLOR, 0.3)
export const POV_COLOR_BG = DEFAULT_POV_COLOR + '15'
export const POV_COLOR_BORDER_SUBTLE = DEFAULT_POV_COLOR + '44'
export const POV_COLOR_GLOW = DEFAULT_POV_COLOR + '44'
export const POV_MINIMAP_COLOR = DEFAULT_POV_COLOR
