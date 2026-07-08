/**
 * Phase 1.25a — Format + preset → renderer slug helpers (frontend).
 *
 * The backend export endpoint is `POST /api/project/export/{slug}`
 * where `{slug}` is a renderer-id registered with
 * `backend/services/renderers/registry.py`. Today's renderer slugs
 * collapse format and preset into one string:
 *   - `docx`                 — DOCX, NarrativeNode native (or Customize)
 *   - `pdf`                  — PDF, native (or Customize)
 *   - `markdown`             — Markdown, native (or Customize)
 *   - `html`                 — HTML, native (or Customize)
 *   - `txt`                  — TXT, native (or Customize)
 *   - `markdown-novelcrafter`— Markdown, NovelCrafter format
 *   - `docx-novelcrafter`    — DOCX, NovelCrafter format
 *   - `docx-shunn`           — DOCX, Shunn manuscript (lands in 1.25e)
 *   - `pdf-shunn`            — PDF, Shunn manuscript (lands in 1.25e)
 *
 * This module is the single place that knows the slug naming
 * convention. The dialog uses `resolveSlug` to construct the export
 * URL when the writer clicks Export, and `parseSlug` to interpret
 * a legacy persisted slug value (from before 1.25a) and split it
 * back into format + preset for seeding the new selectors.
 *
 * Native and Customize map to the same slug because they invoke the
 * same renderer — the difference between them is in the toggle bundle
 * the dialog applies before POSTing, not in renderer dispatch.
 */

// Preset suffixes that materialise as renderer-slug variants.
// Native + Customize are NOT in this list — they map to the bare
// format slug. The order is "longest first" (irrelevant today since
// the suffixes don't overlap, but defensive against future additions
// like a hypothetical "shunn-courier" variant).
const SLUG_SUFFIXES_BY_PRESET = {
  shunn: 'shunn',
  novelcrafter: 'novelcrafter',
}

/**
 * Map a (format, presetKey) pair to the renderer slug used by
 * `POST /api/project/export/{slug}`.
 *
 * @param {string} format    one of 'docx' | 'pdf' | 'markdown' | 'html' | 'txt'
 * @param {string} presetKey one of 'native' | 'shunn' | 'novelcrafter' | 'customize'
 * @returns {string} the renderer slug
 */
export function resolveSlug(format, presetKey) {
  if (!format || typeof format !== 'string') {
    throw new Error(`resolveSlug: format must be a non-empty string (got ${format})`)
  }
  const suffix = SLUG_SUFFIXES_BY_PRESET[presetKey]
  if (!suffix) {
    // native, customize, unknown preset → bare format slug
    return format
  }
  return `${format}-${suffix}`
}

/**
 * Inverse of `resolveSlug`. Splits a slug into `{ format, presetKey }`.
 * Used at dialog open to interpret legacy persisted slug values
 * (from before 1.25a's separate format/preset persistence) so the
 * new selectors can seed cleanly.
 *
 * Unknown preset suffixes parse as preset='native' with the entire
 * slug as the format — defensive against future unrecognised
 * variants. Real validation against the format whitelist happens
 * at the dialog layer where the formatsList is known.
 *
 * @param {string} slug
 * @returns {{format: string, presetKey: 'native' | 'shunn' | 'novelcrafter'}}
 */
export function parseSlug(slug) {
  if (!slug || typeof slug !== 'string') {
    return { format: 'docx', presetKey: 'native' }
  }
  // Longest-suffix-first scan. SLUG_SUFFIXES_BY_PRESET keys give us
  // the candidates; we sort by length descending so a future
  // hypothetical 'shunn-courier' would beat 'shunn' here.
  const candidates = Object.entries(SLUG_SUFFIXES_BY_PRESET)
    .sort((a, b) => b[1].length - a[1].length)
  for (const [presetKey, suffix] of candidates) {
    const tail = `-${suffix}`
    if (slug.endsWith(tail) && slug.length > tail.length) {
      return { format: slug.slice(0, -tail.length), presetKey }
    }
  }
  // No recognised preset suffix → bare-format slug, preset Native.
  // Customize would also produce a bare-format slug but is the
  // writer's UI choice, not something we can detect from the slug
  // alone. Default to Native.
  return { format: slug, presetKey: 'native' }
}
