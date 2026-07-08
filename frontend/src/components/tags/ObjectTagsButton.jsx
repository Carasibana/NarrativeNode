/**
 * Phase 3.4i — Per-row tag glance button.
 *
 * Small tag-icon button mounted next to existing per-row action
 * buttons (delete, center-canvas-on, etc.) on every library row that
 * points to a tag-carrying object. Click → opens an anchored
 * `ObjectTagsPopover` listing every tag the host carries (baseline
 * tags solid, chain-added tags dashed).
 *
 * ## Interaction model — hover-preview + click-to-pin
 *
 * Hover-preview tracks the BUTTON only. The popover itself is a passive
 * surface; moving the cursor over it does not keep it alive. This is
 * the whole point of click-to-pin: if the writer wants the popover to
 * survive the cursor leaving the button, they click to pin it.
 *
 * | Trigger                              | State after            | Popover                                                                                                   |
 * |--------------------------------------|------------------------|-----------------------------------------------------------------------------------------------------------|
 * | Mouse enters button                  | `sticky=false` preview | Opens on a short intent delay (~120 ms) so a quick cursor pass doesn't flash it.                          |
 * | Mouse leaves button                  | `sticky=false`         | Closes immediately. Hovering over the popover does NOT keep it alive — pin via click instead.             |
 * | Click button                         | `sticky=true` pinned   | Popover sticks open regardless of cursor position. Hover-leave logic is suppressed while pinned. `✕` appears in the popover header. |
 * | Click pinned button                  | `sticky=false` closed  | Toggles closed.                                                                                           |
 * | Click `✕` in pinned popover          | `sticky=false` closed  | Same as un-pinning.                                                                                       |
 * | Click outside popover AND not button | `sticky=false` closed  | Standard click-outside dismissal.                                                                         |
 * | Press Escape while open              | `sticky=false` closed  | Same as click-outside.                                                                                    |
 *
 * ## Pool / host resolution
 *
 * - `pool='project'` → resolves `host` against the live `projectTags`
 *   pool. Tag ids walked via `splitTagIdsByOrigin(host, hostKind, nodes)`
 *   so baseline + chain-added are correctly split per the chain-of-
 *   history model. Entity hosts need `nodes` (the canvas nodes array)
 *   so the walker can scan EntityRef + modifier-node tag_changes.
 *   Knowledge / Relationship hosts walk `host.history.tag_changes`
 *   directly. Reference Node / Preset List hosts are baseline-only.
 *
 * - `pool='program'` → host carries a plain `tags: string[]` list
 *   (Context Cues / Conversations). All program tags render as baseline
 *   (no chain semantics on the program side). The button accepts an
 *   explicit `tagNames` prop in this mode.
 *
 * ## Empty-state behaviour
 *
 * When the host has zero tags the button still renders but with a
 * muted appearance and a tooltip "No tags attached". Hover / click
 * still opens the (empty-state) popover so the affordance is
 * consistently discoverable.
 *
 * ## Chain-of-history note
 *
 * This component is READ-ONLY. It reads via the chain-aware
 * `splitTagIdsByOrigin` walker (which already encodes baseline-vs-
 * chain-added semantics for every chain-trackable host kind) and
 * never writes. No baseline mutation, no `EntityRef.tag_changes`
 * append, no `host.history.tag_changes` append. The popover is a
 * pure glance affordance.
 *
 * Props:
 *   - `pool`:        `'project' | 'program'`
 *   - `hostHeader?`: optional React node rendered to the left of the
 *                    `Tags` label in the popover header. Typically
 *                    the host's identity chip (EntityLabelChip,
 *                    KnowledgeLabelChip, RelationshipLabelChip, …)
 *                    so the writer knows WHICH object's tags they're
 *                    looking at without having to remember which row
 *                    they hovered. Caller-provided since the chip
 *                    shape varies per host kind.
 *   - `host?`:       host object (`pool='project'`). Shape per kind:
 *                     - entity / character / location / item / faction /
 *                       custom → the entity row (`{ id, tag_ids, ... }`)
 *                     - knowledge / relationship → the row
 *                       (`{ id, tag_ids, history: { tag_changes: [] } }`)
 *                     - referenceNode → the canvas node (`{ data: { tag_ids } }`)
 *                     - presetList → the row (`{ id, tag_ids }`)
 *   - `hostKind?`:   one of the kinds above (`pool='project'`)
 *   - `nodes?`:      canvas nodes array. Required when `hostKind` is
 *                     an entity kind so the walker can scan
 *                     EntityRef + modifier-node tag_changes.
 *   - `tagNames?`:   `string[]` (`pool='program'`). Case-insensitive.
 *   - `size?`:       `'xs' | 'sm' | 'md'`. Defaults `'sm'`.
 *   - `hoverOpenDelayMs?`:  defaults 120
 *   - `hoverCloseDelayMs?`: defaults 150
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useEntitiesStore } from '../../store/entitiesStore'
import { useProgramTagsStore } from '../../store/programTagsStore'
import { splitTagIdsByOrigin } from '../../utils/tagFilter'
import ObjectTagsPopover from './ObjectTagsPopover'

const POPOVER_WIDTH = 240
const ANCHOR_GAP = 4

// Inline tag-icon SVG so the per-row glyph scales cleanly and matches
// the visual weight of neighbour buttons (delete `×`, center-canvas `👁`,
// etc.). NOT the 🏷️ emoji — the emoji's intrinsic size + colour are
// system-controlled and clash with the row's monochrome action cluster.
function TagIconGlyph({ size = 12 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <path d="M2 2h6l6 6-6 6-6-6V2z" />
      <circle cx="5" cy="5" r="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

export default function ObjectTagsButton({
  pool,
  hostHeader = null,
  host,
  hostKind,
  nodes = null,
  tagNames,
  size = 'sm',
  hoverOpenDelayMs = 120,
}) {
  if (pool !== 'project' && pool !== 'program') {
    throw new Error(`ObjectTagsButton: \`pool\` prop must be 'project' or 'program', got "${pool}"`)
  }

  const triggerRef = useRef(null)
  const popoverRef = useRef(null)
  const openTimerRef = useRef(null)

  const [isOpen, setIsOpen] = useState(false)
  const [sticky, setSticky] = useState(false)

  // ── Pool data subscriptions ───────────────────────────────────────
  // Project pool: resolve tag ids to `{ id, name, color }`.
  // Program pool: resolve tag NAMES (case-insensitive) to `{ name, color }`.
  const projectTagsPool = useEntitiesStore((s) => s.projectTags)
  const programTagsPool = useProgramTagsStore((s) => s.pool)

  // Project pool id → row.
  const projectTagById = useMemo(() => {
    const m = new Map()
    for (const t of (projectTagsPool || [])) m.set(t.id, t)
    return m
  }, [projectTagsPool])

  // Program pool lower-case name → row. Program tags identify by
  // case-insensitive name; the pool entry carries the canonical casing.
  const programTagByLowerName = useMemo(() => {
    const m = new Map()
    for (const t of (programTagsPool || [])) m.set((t.name || '').toLowerCase(), t)
    return m
  }, [programTagsPool])

  // ── Tag resolution (chain-aware on project side) ──────────────────
  // The split is purely a read of the chain history; never writes
  // anywhere. `splitTagIdsByOrigin` is the canonical chain-aware
  // walker — handles baseline-vs-chain-added for every chain-trackable
  // host kind, AND treats baseline-only hosts (referenceNode /
  // presetList) correctly (everything renders as baseline).
  const { baselineTags, chainAddedTags, totalCount } = useMemo(() => {
    if (pool === 'program') {
      const seen = new Set()
      const baseline = []
      for (const raw of (tagNames || [])) {
        if (typeof raw !== 'string') continue
        const trimmed = raw.trim()
        if (!trimmed) continue
        const lower = trimmed.toLowerCase()
        if (seen.has(lower)) continue
        seen.add(lower)
        const poolRow = programTagByLowerName.get(lower)
        baseline.push({
          id: lower,
          name: poolRow?.name || trimmed,
          color: poolRow?.color || '#888888',
        })
      }
      baseline.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      return { baselineTags: baseline, chainAddedTags: [], totalCount: baseline.length }
    }

    if (!host || !hostKind) {
      return { baselineTags: [], chainAddedTags: [], totalCount: 0 }
    }

    const { baseline, chainAdded } = splitTagIdsByOrigin(host, hostKind, nodes)

    const resolveIds = (ids) => {
      const out = []
      for (const id of ids) {
        const row = projectTagById.get(id)
        // Defensive: drop dangling ids (tag deleted from the pool).
        // The chain history can reference a tag that was cleaned up
        // via the >0→0 auto-cleanup; we tolerate that here rather
        // than rendering an empty badge.
        if (!row) continue
        out.push({
          id: row.id,
          name: row.name || '',
          color: row.color || '#888888',
        })
      }
      out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      return out
    }

    const baselineResolved = resolveIds(baseline)
    const chainAddedResolved = resolveIds(chainAdded)
    return {
      baselineTags: baselineResolved,
      chainAddedTags: chainAddedResolved,
      totalCount: baselineResolved.length + chainAddedResolved.length,
    }
  }, [pool, host, hostKind, nodes, tagNames, projectTagById, programTagByLowerName])

  const isEmpty = totalCount === 0

  // ── Timer helpers ─────────────────────────────────────────────────
  // The hover-preview model tracks the BUTTON only. The popover is a
  // passive surface — hovering it does NOT keep the popover alive.
  // The writer pins via click if they want the popover to survive
  // cursor-leaves-button.
  const cancelOpenTimer = useCallback(() => {
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }
  }, [])

  const onButtonMouseEnter = useCallback(() => {
    // No popover when the host has zero tags — opening an empty
    // popover gives the writer nothing to read. The button still
    // renders (muted) so the affordance is consistently discoverable
    // across rows.
    if (isEmpty) return
    if (isOpen) return
    if (openTimerRef.current) return
    openTimerRef.current = setTimeout(() => {
      openTimerRef.current = null
      setIsOpen(true)
    }, hoverOpenDelayMs)
  }, [isEmpty, isOpen, hoverOpenDelayMs])

  const onButtonMouseLeave = useCallback(() => {
    // Pinned popovers don't respond to hover-leave — only click-out /
    // Escape / the `✕` button can dismiss.
    if (sticky) return
    // Hover left before the intent delay fired — drop the pending open.
    cancelOpenTimer()
    // Close immediately. The popover is a passive surface; we never
    // wait for cursor-might-be-travelling-to-popover because the
    // popover doesn't accept hover for its own survival.
    setIsOpen(false)
  }, [sticky, cancelOpenTimer])

  // ── Click toggle (pin / un-pin) ───────────────────────────────────
  const onClickTrigger = useCallback((e) => {
    e.stopPropagation()
    cancelOpenTimer()
    // Empty hosts: clicking does nothing. The button still renders
    // (muted) so it doesn't create a ragged action-cluster gap, but
    // there's nothing to pin.
    if (isEmpty) return
    if (isOpen && sticky) {
      // Pinned → un-pin and close.
      setSticky(false)
      setIsOpen(false)
      return
    }
    // Open + pin (whether currently hover-previewing or fully closed).
    setSticky(true)
    setIsOpen(true)
  }, [isEmpty, isOpen, sticky, cancelOpenTimer])

  // ── Dismiss handlers ──────────────────────────────────────────────
  const closeAll = useCallback(() => {
    cancelOpenTimer()
    setSticky(false)
    setIsOpen(false)
  }, [cancelOpenTimer])

  useEffect(() => {
    if (!isOpen) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeAll() }
    }
    const onDown = (e) => {
      if (popoverRef.current?.contains(e.target)) return
      if (triggerRef.current?.contains(e.target)) return
      closeAll()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown, true)
    }
  }, [isOpen, closeAll])

  // Cleanup any pending timer on unmount so the component doesn't
  // try to flip state on an unmounted node.
  useEffect(() => () => cancelOpenTimer(), [cancelOpenTimer])

  // ── Anchor + viewport-aware placement (same shape as TagFilterBar) ─
  const anchorRect = triggerRef.current?.getBoundingClientRect()
  const popoverPlacement = useMemo(() => {
    if (!anchorRect) return null
    const viewportH = typeof window !== 'undefined' ? window.innerHeight : 800
    const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1280
    const margin = 8
    // The popover content is short — header (~24px) + a single
    // flex-wrap row of badges (most hosts carry 1-6 tags). Typical
    // total height is 60-100px; 150px is a generous ceiling.
    const estPopoverH = Math.min(150, viewportH - margin * 2)
    const spaceBelow = viewportH - anchorRect.bottom - margin
    const spaceAbove = anchorRect.top - margin
    // Default placement: ABOVE the button and offset to the RIGHT
    // (popover's bottom-left corner sits just above + right of the
    // button). Reads as a callout floating up-and-right from the
    // row's action cluster. Flip to below only when there's
    // genuinely no room above.
    const flipBelow = spaceAbove < estPopoverH && spaceBelow > spaceAbove
    // Horizontal anchor: popover's LEFT edge aligns with the
    // button's LEFT edge (popover extends rightward from there).
    // Clamp to viewport so it never spills off the right side on
    // narrow panels — slides back left as needed.
    const desiredLeft = anchorRect.left
    const left = Math.max(margin, Math.min(desiredLeft, viewportW - POPOVER_WIDTH - margin))
    if (!flipBelow) {
      return {
        style: {
          left,
          bottom: viewportH - anchorRect.top + ANCHOR_GAP,
          width: POPOVER_WIDTH,
          maxHeight: Math.max(spaceAbove - ANCHOR_GAP, 0),
          zIndex: 10000,
        },
        placement: 'above-right',
      }
    }
    return {
      style: {
        left,
        top: anchorRect.bottom + ANCHOR_GAP,
        width: POPOVER_WIDTH,
        maxHeight: Math.max(spaceBelow - ANCHOR_GAP, 0),
        zIndex: 10000,
      },
      placement: 'below-right',
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, anchorRect?.left, anchorRect?.top, anchorRect?.bottom, anchorRect?.right])

  // ── Render ────────────────────────────────────────────────────────
  // Match the existing per-row action-button style: w-5 h-5, fade in on
  // row hover via `group-hover/item:opacity-100`, monochrome icon, hover
  // colour shift. Empty state stays mounted (per spec) but renders
  // muted so writers can still discover the affordance.
  const tooltip = isEmpty
    ? 'No tags attached'
    : `${totalCount} tag${totalCount === 1 ? '' : 's'}${sticky ? ' (pinned)' : ''}`

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-help-region="tag-picker:object_tags_button"
        onClick={onClickTrigger}
        onMouseEnter={onButtonMouseEnter}
        onMouseLeave={onButtonMouseLeave}
        onFocus={onButtonMouseEnter}
        onBlur={onButtonMouseLeave}
        title={tooltip}
        aria-label={tooltip}
        aria-haspopup="true"
        aria-expanded={isOpen}
        className={`w-5 h-5 inline-flex items-center justify-center rounded transition-colors flex-shrink-0 ${
          isOpen
            ? 'text-accent-300 bg-zinc-700'
            : isEmpty
              // Empty hosts are effectively inactive — no hover
              // highlight, default cursor. Button still renders as a
              // muted glyph so the action-cluster layout stays even
              // across rows.
              ? 'text-zinc-600 cursor-default'
              : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700'
        }`}
      >
        <TagIconGlyph size={12} />
      </button>

      {isOpen && popoverPlacement && createPortal(
        <div
          ref={popoverRef}
          className="fixed bg-zinc-900 border border-zinc-700 rounded shadow-xl p-2 overflow-y-auto"
          style={popoverPlacement.style}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* The popover is a passive surface in hover-preview mode —
              hovering it does NOT keep it alive (the button's
              `onMouseLeave` closes it the moment the cursor leaves the
              button). The `✕` close button only appears in the popover
              header when the writer has explicitly clicked to pin
              (`sticky=true`). In preview mode the popover is
              dismissed by leaving the button; there's nothing to
              close manually so no `✕` is rendered. */}
          <ObjectTagsPopover
            hostHeader={hostHeader}
            baseline={baselineTags}
            chainAdded={chainAddedTags}
            onClose={sticky ? closeAll : null}
            size={size}
          />
        </div>,
        document.body,
      )}
    </>
  )
}
