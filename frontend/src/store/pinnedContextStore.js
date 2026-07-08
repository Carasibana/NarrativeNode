import { create } from 'zustand'

/**
 * Unified pinned-context store — Phase 2.10b bug 1 refactor.
 *
 * Single source of truth for every surface's pinned context items
 * (previously split between `uiStore.chatPinnedContextItems` for chat
 * and `sectionPromptBlocksStore.blocks[id].pinnedContextItems` for
 * PBH / IPB / Scene Description PBH).
 *
 *   ─── Surface keys ─────────────────────────────────────────────
 *
 * Each surface's pin list is keyed by a string of the form:
 *   - `'chat:<threadId>'`   — chat composer, one bucket per conversation
 *   - `'block:<sectionId>'` — PBH / IPB / Scene Description PBH, one
 *                              bucket per block instance
 *
 * Per-thread chat keying replaces the previous flat-bucket-per-program
 * behaviour, so switching conversations no longer carries pins across.
 *
 *   ─── Session-scoped only ──────────────────────────────────────
 *
 * Pinned context items live in session state only. They are NEVER
 * serialized to `.nnz` / `narrative.json` / `conversations/*.json`
 * (see Bug 2 / Bug 5). Cleared explicitly on program close (via
 * `clearAllSurfaces`), on conversation deletion (chat surface), and
 * on block destruction (block surface). No orphaned data.
 *
 *   ─── Dedup rule (unified from both legacy stores) ─────────────
 *
 * `addPin(surfaceKey, item)` enforces:
 *   - dynamic pills (`pin_kind: 'dynamic'`) dedupe by canonical
 *     `markerKey(marker)` — sorted-key JSON of the marker shape
 *   - `kind: 'freetext'` pins dedupe by text content
 *   - all other kinds dedupe by `(kind, id, anchor identity)` where
 *     anchor identity is:
 *       - `range:<startId>:<endId>` for `anchor_range` pins
 *       - `single:<nodeId>` for `anchor_node_id` pins
 *       - `'dynamic'` (sentinel) for anchor-less pins
 *
 * The same `(kind, id)` can have multiple anchored variants alongside
 * one anchor-less variant — they are semantically distinct. PBH / IPB
 * surfaces never create anchored pins, so the dedup reduces to one
 * pin per `(kind, id)` for those surfaces (matching the legacy
 * sectionPromptBlocksStore behaviour exactly).
 *
 *   ─── Performance ─────────────────────────────────────────────
 *
 * Subscribers select `state.surfaces[surfaceKey]` directly. Returns
 * `undefined` for absent surfaces — callers use `|| EMPTY` with a
 * module-level constant to avoid creating a new array per render.
 * Add / remove / update operations are O(N) over the target surface's
 * list only; unrelated surfaces are untouched.
 */

// Stable identity for a pin's anchor shape — see header for the rule.
function _pinAnchorIdentityKey(item) {
  if (!item) return 'dynamic'
  if (item.anchor_range) {
    const s = item.anchor_range.start_node_id || ''
    const e = item.anchor_range.end_node_id || ''
    return `range:${s}:${e}`
  }
  if (item.anchor_node_id) return `single:${item.anchor_node_id}`
  return 'dynamic'
}

// Canonical marker dedup key. Mirror of `markerKey` in
// `utils/dynamicMarkers.js`. Inlined to keep the store module's
// dependency graph light; the two must stay in sync.
function _markerKey(marker) {
  if (!marker || typeof marker !== 'object') return ''
  const sorted = {}
  for (const key of Object.keys(marker).sort()) {
    sorted[key] = marker[key]
  }
  return JSON.stringify(sorted)
}

function _newSessionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `pin-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function _isDuplicate(list, candidate) {
  if (!candidate) return true
  // Dynamic (marker-backed) pills
  if (candidate.pin_kind === 'dynamic') {
    if (!candidate.marker) return true
    const ck = _markerKey(candidate.marker)
    return list.some((p) => p && p.pin_kind === 'dynamic' && _markerKey(p.marker) === ck)
  }
  if (!candidate.kind) return true
  // Freetext — dedupe by text content
  if (candidate.kind === 'freetext') {
    return list.some((p) => p && p.kind === 'freetext' && (p.text || '') === (candidate.text || ''))
  }
  if (!candidate.id) return true
  // All other kinds — dedupe by (kind, id, anchor identity)
  const ca = _pinAnchorIdentityKey(candidate)
  return list.some((p) => (
    p && p.kind === candidate.kind && p.id === candidate.id
    && _pinAnchorIdentityKey(p) === ca
  ))
}

export const usePinnedContextStore = create((set, get) => ({
  // Pin lists keyed by surface key. Empty / absent surfaces map to
  // `undefined`; subscribers that want a stable empty array should
  // fall back to a module-level constant.
  surfaces: {},

  /**
   * Read a surface's pin list synchronously. Returns an empty array
   * for absent / never-touched surfaces. Use for one-off reads where
   * a subscription would be wasteful (event handlers, send-time
   * payload assembly, the consequences-analysis path in
   * `pinnedContextMerge.js`).
   */
  getPins: (surfaceKey) => {
    if (!surfaceKey) return []
    const s = get().surfaces[surfaceKey]
    return Array.isArray(s) ? s : []
  },

  /**
   * Add a pin to a surface. Bare item shape — the store fills in
   * `sessionId` (stable React key, fresh per add), `addedAt` (ms
   * epoch), `pin_kind` (defaults `'static'` for legacy callers that
   * don't pass it), and `source` (defaults `'manual'`; auto-attach
   * dispatcher passes `'prompt'` + a `source_prompt_id` explicitly).
   *
   * Validates marker shape on dynamic adds (must have `marker.type`).
   * Validates `kind` on static adds. Dedupe per the header rule;
   * duplicates are silent no-ops.
   */
  addPin: (surfaceKey, item) => set((s) => {
    if (!surfaceKey || !item) return s
    // Validate shape early
    const isDynamic = item.pin_kind === 'dynamic'
    if (isDynamic) {
      if (!item.marker || typeof item.marker.type !== 'string') return s
    } else if (!item.kind) {
      return s
    }
    const list = s.surfaces[surfaceKey] || []
    if (_isDuplicate(list, item)) return s
    const enriched = {
      ...item,
      sessionId: _newSessionId(),
      addedAt: Date.now(),
      pin_kind: isDynamic ? 'dynamic' : (item.pin_kind || 'static'),
      source: item.source || 'manual',
    }
    return {
      surfaces: {
        ...s.surfaces,
        [surfaceKey]: [...list, enriched],
      },
    }
  }),

  /**
   * Remove a pin by sessionId. No-op if the pin doesn't exist on the
   * named surface.
   */
  removePin: (surfaceKey, sessionId) => set((s) => {
    if (!surfaceKey || !sessionId) return s
    const list = s.surfaces[surfaceKey]
    if (!Array.isArray(list)) return s
    const next = list.filter((p) => p && p.sessionId !== sessionId)
    if (next.length === list.length) return s
    return {
      surfaces: {
        ...s.surfaces,
        [surfaceKey]: next,
      },
    }
  }),

  /**
   * Update a dynamic pin's `marker` field in place. Used by
   * `<DynamicPillChip>`'s cycle-detail and slider-N commits so the
   * new config persists on the session-state pin entry. Static pins
   * are left alone — this is dynamic-only.
   */
  updatePinMarker: (surfaceKey, sessionId, marker) => set((s) => {
    if (!surfaceKey || !sessionId) return s
    const list = s.surfaces[surfaceKey]
    if (!Array.isArray(list)) return s
    let changed = false
    const next = list.map((p) => {
      if (p && p.sessionId === sessionId && p.pin_kind === 'dynamic') {
        changed = true
        return { ...p, marker }
      }
      return p
    })
    if (!changed) return s
    return {
      surfaces: {
        ...s.surfaces,
        [surfaceKey]: next,
      },
    }
  }),

  /**
   * Update a static scene pin's `mode` field in place. Used by
   * `<PinnedContextChip>`'s cycle button on scene pins so the
   * writer can cycle the detail level (summary / summary_with_changes
   * / full_content) without removing-and-re-adding the pin. Scene-
   * kind only; other static kinds have no `mode` concept.
   */
  updatePinMode: (surfaceKey, sessionId, mode) => set((s) => {
    if (!surfaceKey || !sessionId) return s
    const list = s.surfaces[surfaceKey]
    if (!Array.isArray(list)) return s
    let changed = false
    const next = list.map((p) => {
      if (p && p.sessionId === sessionId && p.kind === 'scene') {
        changed = true
        return { ...p, mode }
      }
      return p
    })
    if (!changed) return s
    return {
      surfaces: {
        ...s.surfaces,
        [surfaceKey]: next,
      },
    }
  }),

  /**
   * Drop one surface's bucket entirely. Wired on conversation
   * deletion (chat surface) and block destruction (block surface)
   * to avoid orphan accumulation in session state.
   */
  clearPins: (surfaceKey) => set((s) => {
    if (!surfaceKey || !(surfaceKey in s.surfaces)) return s
    const next = { ...s.surfaces }
    delete next[surfaceKey]
    return { surfaces: next }
  }),

  /**
   * Drop every surface's bucket. Used by full-program-reset paths
   * (project switch, story switch — Bug 4 wires this).
   */
  clearAllSurfaces: () => set({ surfaces: {} }),
}))
