import { create } from 'zustand'
import { acquireMediaElement } from '../utils/mediaElementPool'

/**
 * Media Preview Panel store — Phase 1.10 Track B.
 *
 * Single-expanded + single-tray state machine for the floating Media Preview system.
 * Enforces the locked-in rules from the Phase 1.10 planning doc:
 *
 *   • Hard cap of 1 expanded panel + 1 collapsed tray chip at any time.
 *   • Duplicate-open = focus existing (match by fileRef).
 *   • Opening a new source auto-collapses the current expanded panel.
 *   • Images dismiss on collapse (no persistent image tray chip).
 *   • Audio/video not playing dismiss on collapse; playing media goes to the tray.
 *   • Pause holds the tray slot — paused chips stay until explicit dismiss or displacement.
 *   • Starting playback on a new source stops and dismisses whatever is in the tray slot
 *     (invariant: at most one currently-playing media at a time across expanded + tray).
 *
 * Source shapes:
 *   { type: 'attribute', entityId, attributeId, atNodeId, fileRef,
 *     attributeName, entityName, entityColour, profileImageRef }
 *
 *     `atNodeId` is the id of the canvas node from which the attribute was accessed
 *     (origin entity_node, modifier entity_node, or plot-point scene node). The badge
 *     uses it to compute the entity's **effective state at that chain position** so
 *     the displayed name / colour / profile image reflect any mid-chain edits. All the
 *     other attribute-source fields (`attributeName`, `entityName`, `entityColour`,
 *     `profileImageRef`) are snapshot fallbacks used if the entity or node has been
 *     deleted from the canvas while the preview is still open.
 *
 *   { type: 'reference_node', nodeId, fileRef, title, colour }
 *
 *     The badge subscribes to the live node data for colour and title; the snapshot
 *     fields are used as fallbacks if the node was deleted.
 */

/** Image / audio / video / null based on a file_ref's extension. */
export function getMediaKind(fileRef) {
  if (!fileRef || typeof fileRef !== 'string') return null
  const dot = fileRef.lastIndexOf('.')
  if (dot === -1) return null
  const ext = fileRef.slice(dot + 1).toLowerCase()
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif'].includes(ext)) return 'image'
  if (['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'].includes(ext)) return 'audio'
  if (['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v'].includes(ext)) return 'video'
  return null
}

/** True when two sources refer to the same logical file (for duplicate-focus detection).
 *  A source is identified by either a project `fileRef` (assets/-relative path)
 *  OR a direct `url` (e.g. a blob URL for a transient picked file the chat
 *  panel attaches in 2.5e). Compare on whichever the source carries. */
function sameSource(a, b) {
  if (!a || !b) return false
  const aId = a.fileRef || a.url
  const bId = b.fileRef || b.url
  if (!aId || !bId) return false
  return aId === bId
}

/** Default starting "position" for a freshly opened panel in anchored mode.
 *
 * When `anchored: true`, the panel's CSS uses `right: position.x` and
 * `top: <measured-header-height> + ANCHOR_TOP_GAP` instead of `left: position.x
 * / top: y`. `position.x` is interpreted as the RIGHT-edge offset from the
 * viewport edge (default 8px to match the top gap below the header) and
 * `position.y` is ignored — the actual top offset is measured from the
 * `<header>` element at mount time by MediaPreviewPanel.
 *
 * As soon as the user drags or resizes the panel, the store's
 * `setPanelPosition` clears `anchored: false` and switches to absolute
 * left/top positioning. `position.x` then becomes the absolute left in px.
 */
function defaultPanelPosition() {
  return { x: 8, y: 0 }
}

let _nextId = 1
const newInstanceId = () => `preview-${_nextId++}`

/** Build a fresh instance record from a source. The source's `kind` is
 *  honoured directly when provided (used by chat-attachment image previews
 *  whose source has a blob `url` instead of a `fileRef` with an extension
 *  the kind helper could read); otherwise derived from the fileRef's
 *  extension. */
function makeInstance(source, position = null) {
  return {
    id: newInstanceId(),
    source,
    kind: source.kind || getMediaKind(source.fileRef),
    position: position || defaultPanelPosition(),
    // When true, `position.x` is the RIGHT-edge offset in CSS pixels; the
    // panel is pinned to the canvas area's top-right corner. When false
    // (after the first drag or resize), `position.x/y` are absolute left/top.
    anchored: true,
    size: null,  // null = content-adaptive; set via setPanelSize when the user resizes
    playing: false,
    paused: false,
    currentTime: 0,
    volume: 1.0,
  }
}

export const usePreviewStore = create((set, get) => ({
  expanded: null,   // single expanded panel, or null
  trayChip: null,   // single collapsed playback chip, or null

  // ── Cross-player playback coordination ────────────────────────────────────
  // Identifies whichever player last fired `play`. Every media-playing
  // component (MediaPreviewPanel, MediaPreviewTrayChip, ReferenceNode's inline
  // player, and the shared element pool) subscribes to this value and pauses
  // its own element if the active id isn't theirs. Enforces the "at most one
  // media playing at a time across the whole app" rule the user requested.
  //
  // Id format is `<scope>:<identifier>`, e.g.
  //   `preview:<instance id>` for an expanded-panel or tray-chip element
  //   `reference:<node id>`   for a reference node's inline player
  activePlayerId: null,

  /** Claim exclusive playback. All other players that see this change should pause. */
  setActivePlayer: (id) => set({ activePlayerId: id }),

  /** Release the active-player slot if the caller currently holds it. */
  clearActivePlayer: (id) => set((s) => s.activePlayerId === id ? { activePlayerId: null } : {}),

  /**
   * Open a media file in the preview system.
   *
   * Duplicate-open rules:
   *   - If the expanded panel already shows this source → no-op (focus existing).
   *   - If the tray chip is this source → expand it (tray becomes null, state transfers).
   *
   * Otherwise: auto-collapse the current expanded panel (which may dismiss the previous
   * or move it to the tray per the image/playback rules), then set the new source as
   * the expanded panel.
   *
   * `initialState` is an optional handoff from an external media player (e.g. the
   * inline audio/video element inside a media reference node). If provided, the new
   * expanded instance inherits `currentTime` / `playing` / `paused` / `volume` from
   * it, and MediaPreviewPanel's useEffect will seek + auto-play on mount. Callers
   * should pause the external player before calling openPreview so playback only
   * continues in one place.
   */
  openPreview: (source, initialState = null) => {
    if (!source || (!source.fileRef && !source.url)) return
    const { expanded, trayChip } = get()

    if (expanded && sameSource(expanded.source, source)) {
      // Duplicate-focus: the panel is already showing this source. If the
      // caller provided a playback handoff (e.g. the reference node's inline
      // player was playing at a different position and the user clicked
      // "Open in Preview" again), apply the new state directly to the pooled
      // element so it seeks and resumes without re-running the mount effect.
      if (initialState) {
        const el = acquireMediaElement(source.fileRef)
        if (el) {
          if (initialState.currentTime != null && Math.abs(el.currentTime - initialState.currentTime) > 0.05) {
            try { el.currentTime = initialState.currentTime } catch { /* noop */ }
          }
          if (initialState.volume != null) el.volume = initialState.volume
          if (initialState.playing && el.paused) {
            const p = el.play()
            if (p && typeof p.catch === 'function') p.catch(() => {})
          } else if (initialState.playing === false && !el.paused) {
            try { el.pause() } catch { /* noop */ }
          }
        }
        // Mirror the applied state into the store so the equalizer, play
        // button, and other UI bits reflect reality. The element's own
        // play/pause event listeners will also fire setExpandedPlayback,
        // but updating here first keeps the store consistent immediately.
        set((s) => s.expanded ? {
          expanded: {
            ...s.expanded,
            currentTime: initialState.currentTime ?? s.expanded.currentTime,
            volume: initialState.volume ?? s.expanded.volume,
            playing: initialState.playing ?? s.expanded.playing,
            paused: initialState.paused ?? s.expanded.paused,
          },
        } : {})
      }
      return
    }

    if (trayChip && sameSource(trayChip.source, source)) {
      // Expanding from tray: transfer the chip's playback state into the new
      // expanded panel. If the caller passed a new playback handoff (e.g. the
      // reference node clicked "Open in Preview" with fresh inline position),
      // merge it on top of the tray's captured state. Re-anchor to the canvas
      // top-right since the panel is being re-opened fresh.
      set({
        expanded: {
          ...trayChip,
          position: defaultPanelPosition(),
          anchored: true,
          ...(initialState ? {
            currentTime: initialState.currentTime ?? trayChip.currentTime,
            volume: initialState.volume ?? trayChip.volume,
            playing: initialState.playing ?? trayChip.playing,
            paused: initialState.paused ?? trayChip.paused,
          } : {}),
        },
        trayChip: null,
      })
      return
    }

    // Auto-collapse the current expanded panel before opening the new source.
    // collapsePreview() handles the image-dismiss / playing-to-tray rules.
    if (expanded) {
      get().collapsePreview()
    }

    const instance = makeInstance(source)
    if (initialState) {
      if (initialState.currentTime != null) instance.currentTime = initialState.currentTime
      if (initialState.volume != null)      instance.volume      = initialState.volume
      if (initialState.playing != null)     instance.playing     = initialState.playing
      if (initialState.paused != null)      instance.paused      = initialState.paused
    }
    set({ expanded: instance })
  },

  /**
   * Open a media source directly as a tray chip, bypassing the expanded panel.
   * Used by the canvas auto-migration flow when a playing reference node exits
   * the viewport — we want the tray chip (least-disruptive surface), not the
   * expanded panel flashing into view and then collapsing.
   *
   * Duplicate guards:
   *   - If the tray already holds this source → no-op (already migrated).
   *   - If the expanded panel already holds this source → no-op; the user
   *     opened it deliberately, leave it where they put it.
   *
   * Otherwise: write directly to the `trayChip` slot, carrying playback state
   * from `initialState` so the tray chip's own mount effect seeks and resumes
   * on the pooled element. The expanded panel is left untouched (it can only
   * hold a non-playing source per the "one playing source" invariant, so it
   * is never a conflict here).
   */
  openAsTrayChip: (source, initialState = null) => {
    if (!source || (!source.fileRef && !source.url)) return
    const { expanded, trayChip } = get()
    if (trayChip && sameSource(trayChip.source, source)) return
    if (expanded && sameSource(expanded.source, source)) return
    const instance = makeInstance(source)
    instance.position = null  // tray position managed by the tray renderer
    if (initialState) {
      if (initialState.currentTime != null) instance.currentTime = initialState.currentTime
      if (initialState.volume != null)      instance.volume      = initialState.volume
      if (initialState.playing != null)     instance.playing     = initialState.playing
      if (initialState.paused != null)      instance.paused      = initialState.paused
    }
    set({ trayChip: instance })
  },

  /**
   * Collapse the currently expanded panel. Behaviour depends on media kind and state:
   *
   *   - Image → dismissed entirely (no persistent image tray chip)
   *   - Audio/video not playing → dismissed entirely
   *   - Audio/video playing or paused → moved into the tray slot
   *
   * The tray slot is single-occupancy; if it is already occupied when this is called,
   * that is a legal state only if the existing tray chip was placed there earlier and
   * the caller has already handled displacement. See the state-machine invariants in
   * the Phase 1.10 planning doc.
   */
  collapsePreview: () => {
    const { expanded } = get()
    if (!expanded) return
    if (expanded.kind === 'image') {
      set({ expanded: null })
      return
    }
    if (!expanded.playing && !expanded.paused) {
      set({ expanded: null })
      return
    }
    // Playing or paused audio/video → move to tray.
    set({
      expanded: null,
      trayChip: { ...expanded, position: null },  // tray position is managed by the tray renderer
    })
  },

  /** Bring the tray chip back into the expanded panel, preserving playback state. */
  expandTrayChip: () => {
    const { trayChip } = get()
    if (!trayChip) return
    // If there's already an expanded panel, auto-collapse it first.
    if (get().expanded) get().collapsePreview()
    set({
      expanded: { ...trayChip, position: defaultPanelPosition() },
      trayChip: null,
    })
  },

  /**
   * Toggle-open a media source. If the panel (expanded OR tray) already holds
   * this same `fileRef`, dismiss whichever slot contains it. Otherwise route
   * through the normal `openPreview` flow.
   *
   * Used by the eye-icon buttons in the sidebar and on reference nodes so that
   * a second click on the same eye acts as "close the preview" rather than a
   * no-op focus. Duplicate-focus semantics are preserved for `openPreview` when
   * called with `initialState` (e.g. the reference-node handoff flow).
   */
  togglePreview: (source, initialState = null) => {
    if (!source || (!source.fileRef && !source.url)) return
    const { expanded, trayChip } = get()
    if (expanded && sameSource(expanded.source, source)) {
      set({ expanded: null })
      return
    }
    if (trayChip && sameSource(trayChip.source, source)) {
      set({ trayChip: null })
      return
    }
    get().openPreview(source, initialState)
  },

  /** Close the expanded panel entirely (does not go to tray). Used by the header ✕ button. */
  dismissPreview: () => set({ expanded: null }),

  /** Stop playback and remove the tray chip. Used by the collapsed chip's dismiss ✕ button. */
  dismissTrayChip: () => set({ trayChip: null }),

  /** Reset every preview state slot — expanded panel, tray chip, and the
   * cross-player playback claim — when a new project is loaded.
   * Without this, opening a new story while the panel was open keeps the
   * old project's file ref staring at the writer (and worse, the asset
   * URL may resolve to a different file on the new project's backend
   * since asset names aren't globally unique).
   * Called from `projectStore`'s load actions alongside the
   * `loadGeneration` bump. */
  resetForProjectLoad: () => set({ expanded: null, trayChip: null, activePlayerId: null }),

  /**
   * Swap the expanded panel's source in place without routing through
   * openPreview / collapsePreview. Used by the "Replace File" flow when the
   * user uploads a new media file for the reference node currently being
   * previewed — the panel stays open at its current position/size, but the
   * fileRef (and therefore the pool element) becomes the new one. Playback
   * state is reset (new file = fresh playback, not-playing). Position, size,
   * AND the anchored flag are preserved so the panel stays exactly where it
   * was (anchored-to-corner panels stay anchored, dragged panels stay at
   * their user-chosen location).
   */
  replaceExpandedSource: (newSource) => {
    if (!newSource || !newSource.fileRef) return
    set((s) => {
      if (!s.expanded) return {}
      const fresh = makeInstance(newSource)
      return {
        expanded: {
          ...fresh,
          position: s.expanded.position,
          anchored: s.expanded.anchored,
          size: s.expanded.size,
        },
      }
    })
  },

  /** Drag-to-move the expanded panel. Also exits anchored mode: once the
   * user moves the panel, it switches to absolute left/top positioning so
   * subsequent renders and the window-resize clamp behave normally. */
  setPanelPosition: (position) => set((s) => s.expanded
    ? { expanded: { ...s.expanded, position, anchored: false } }
    : {}),

  /** User-resize the expanded panel. Pass null to reset to content-adaptive sizing. */
  setPanelSize: (size) => set((s) => s.expanded
    ? { expanded: { ...s.expanded, size } }
    : {}),

  /**
   * Report playback state from the media element inside the expanded panel or tray chip.
   * Enforces the displacement invariant: starting playback on a source stops and dismisses
   * any OTHER currently-playing media (preserving "at most one playing source at a time"
   * across expanded + tray combined).
   */
  setExpandedPlayback: (patch) => {
    const { expanded, trayChip } = get()
    if (!expanded) return
    const nextExpanded = { ...expanded, ...patch }
    // Displacement: if we're starting playback on the expanded panel AND the tray has
    // a DIFFERENT source, dismiss the tray chip.
    const startedPlaying = patch.playing === true && !expanded.playing
    if (startedPlaying && trayChip && !sameSource(trayChip.source, expanded.source)) {
      set({ expanded: nextExpanded, trayChip: null })
      return
    }
    set({ expanded: nextExpanded })
  },

  /** Report playback state from the tray chip's inline media element. Same displacement rules. */
  setTrayPlayback: (patch) => {
    const { expanded, trayChip } = get()
    if (!trayChip) return
    const nextTray = { ...trayChip, ...patch }
    const startedPlaying = patch.playing === true && !trayChip.playing
    if (startedPlaying && expanded && expanded.playing && !sameSource(expanded.source, trayChip.source)) {
      // Pausing the expanded one is sufficient — we don't dismiss it because the user
      // might still want to see it visually. Only the tray slot is hard-capped.
      set({ trayChip: nextTray, expanded: { ...expanded, playing: false, paused: true } })
      return
    }
    set({ trayChip: nextTray })
  },
}))
