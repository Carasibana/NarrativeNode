import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import EntityColorPicker from '../ui/EntityColorPicker'
import { useEntitiesStore } from '../../store/entitiesStore'
import { useProgramTagsStore } from '../../store/programTagsStore'
import { useProjectStore } from '../../store/projectStore'
import { useUiStore } from '../../store/uiStore'
import { useContextCuesStore } from '../../store/contextCuesStore'
import { useConversationsStore } from '../../store/conversationsStore'
import { collectHostsForProgramTag } from '../../utils/globalSearch'
import {
  computeEffectiveState,
  computeKnowledgeEffectiveState,
  computeRelationshipEffectiveState,
  getKnowledgeNodeOrder,
  getRelationshipNodeOrder,
} from '../../utils/narrativeChain'
import {
  resolveEntitySubtype,
  LIBRARY_HOST_ORDER,
  LIBRARY_HOST_LABELS,
} from '../../utils/tagHostNavigation'
import { useTagHostIndex } from '../../hooks/useTagHostIndex'
import { useStoryOrder } from '../../hooks/useStoryOrder'
import { TYPE_ICONS, ENTITY_BUCKETS } from '../../utils/entityHelpers'
import {
  EntityLabelChip,
  KnowledgeLabelChip,
  RelationshipLabelChip,
} from '../ui/IdentityBadges'
import TagBadge from './TagBadge'

/**
 * Phase 3.4e — Tag popover (renamed from `EditTagModal` in 3.4f Item 7
 * once the read-only mode landed; the component now has two purposes,
 * not just edit).
 *
 * Edit mode (default — used by the Tags & Lists library tab):
 *
 *   [colour chip] [name input] [✓ save] [✕ cancel]
 *   [optional error / propagation hint]
 *   [tagged-objects browser, grouped by host kind]
 *
 * Read-only mode (`readOnly=true` — used by host-side TagBadge chip
 * clicks on Entity / Knowledge / Relationship detail panels and on
 * the Reference Node canvas body):
 *
 *   [TagBadge header]
 *   [tagged-objects browser, grouped by host kind]
 *
 * The identity-edit row and the propagation hint are hidden in
 * read-only mode; the popover becomes a pure "see who else carries
 * this tag" surface.
 *
 * The tagged-objects browser lists every host carrying this tag
 * grouped by library-tab order. Project tag mode walks Entity /
 * Knowledge / Relationship / Reference Node / Preset List pools;
 * program tag mode walks Context Cues + Conversations. Click a
 * badge to navigate to that host. For chain-trackable hosts
 * (Entity / Knowledge / Relationship) the click lands on the
 * earliest scene anchor where the tag is present on that host —
 * origin if the tag is in baseline, otherwise the first `add` event
 * along its chain.
 *
 * Three states:
 *   - **Create**: `tag` is null. Save mints a new pool entry. The
 *                 tagged-objects browser is hidden (no host list
 *                 yet).
 *   - **Edit**:   `tag` is the existing pool entry.
 *
 * Anchored directly above the badge the writer clicked (`anchor`
 * prop = the badge's `getBoundingClientRect()`), so the popover
 * sits just above the badge with its bottom edge 4px clear of the
 * badge's top edge. Click-outside dismiss + Escape dismiss + Enter
 * submit. The popover height grows downward to fit the host list
 * but the anchor pins to the bottom edge so the badge always sits
 * just below.
 *
 * Props:
 *   - `isOpen`     — parent controls visibility
 *   - `onClose()`  — notify parent to flip `isOpen` back
 *   - `mode`       — 'project' | 'program'
 *   - `tag`        — null (create) or the existing pool entry
 *   - `count`      — usage count for the propagation note. The tag
 *                    object's own `count` field is used when `count`
 *                    prop is undefined.
 *   - `anchor`     — the badge's `getBoundingClientRect()` (or any
 *                    object exposing `left` + `top`). The popover's
 *                    bottom-left corner anchors just above
 *                    `(anchor.left, anchor.top - 4)`.
 *   - `readOnly`   — when true, hides the identity-edit row + the
 *                    propagation hint. Header becomes a single
 *                    `TagBadge` display; the host browser remains.
 *                    Used by chip clicks on host surfaces.
 */

const POPOVER_WIDTH = 360
const ANCHOR_GAP = 4

export default function TagPopover({ isOpen, onClose, mode, tag = null, count, anchor, anchorEl, readOnly = false }) {
  const isCreate = !tag
  const initialName = tag?.name || ''
  const initialColor = tag?.color || '#888888'
  const effectiveCount = count ?? tag?.count ?? 0

  const [name, setName] = useState(initialName)
  const [color, setColor] = useState(initialColor)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')

  const [colorChipEl, setColorChipEl] = useState(null)
  const nameInputRef = useRef(null)
  const popoverRef = useRef(null)

  // Auto-focus the name input on mount. The parent re-keys the
  // popover per target, so each open is a fresh mount and useState
  // initializers already carry the right initial name + colour —
  // no separate state-sync step needed. Skipped in read-only mode
  // since there's no input to focus.
  useEffect(() => {
    if (!isOpen || readOnly) return undefined
    const t = setTimeout(() => {
      nameInputRef.current?.focus()
      nameInputRef.current?.select()
    }, 0)
    return () => clearTimeout(t)
  }, [isOpen, readOnly])

  // Position the popover directly to the right of the badge. `left`
  // sits ANCHOR_GAP past the badge's right edge; `top` aligns with
  // the badge's top edge so the popover and badge share a top
  // baseline. `position: fixed` so the popover ignores any ancestor
  // scroll containers.
  const anchorRight = anchor?.right ?? anchor?.left ?? 0
  const anchorTop = anchor?.top ?? 0

  // Escape close + click-outside close. The colour picker portals
  // outside the popover, so we whitelist its DOM ancestor by class
  // when checking click-outside.
  useEffect(() => {
    if (!isOpen) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
    }
    const onDown = (e) => {
      if (popoverRef.current?.contains(e.target)) return
      // Skip clicks on the anchoring badge / button so its own
      // onClick handler can toggle the popover closed. Without this,
      // mousedown fires first and closes the popover, then the click
      // event reopens it — visually a bounce, and breaks the
      // single-click toggle.
      if (anchorEl && anchorEl.contains(e.target)) return
      // Colour picker is portalled; let its own click-outside handle it.
      // It calls back via onClose so we shouldn't close on its clicks.
      if (pickerOpen) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown, true)
    }
  }, [isOpen, onClose, pickerOpen, anchorEl])

  const createProjectTag = useEntitiesStore((s) => s.createProjectTag)
  const updateProjectTag = useEntitiesStore((s) => s.updateProjectTag)
  const programCreate = useProgramTagsStore((s) => s.create)
  const programRename = useProgramTagsStore((s) => s.rename)
  const programSetColor = useProgramTagsStore((s) => s.setColor)

  const handleSave = useCallback(async () => {
    const trimmed = name.trim().replace(/^#+/, '').trim()
    if (!trimmed) {
      setErrorMsg('Tag name cannot be empty.')
      return
    }
    setBusy(true)
    setErrorMsg('')
    try {
      if (mode === 'project') {
        if (isCreate) {
          await createProjectTag({ name: trimmed, color })
        } else {
          const patch = {}
          if (trimmed !== initialName) patch.name = trimmed
          if (color !== initialColor) patch.color = color
          if (Object.keys(patch).length > 0) {
            await updateProjectTag(tag.id, patch)
          }
        }
      } else if (mode === 'program') {
        if (isCreate) {
          await programCreate(trimmed, color)
        } else {
          if (trimmed !== initialName) await programRename(initialName, trimmed)
          if (color !== initialColor) await programSetColor(trimmed, color)
        }
      }
      onClose()
    } catch (err) {
      const detail = err?.response?.data?.detail || err?.message || 'Failed to save tag.'
      setErrorMsg(typeof detail === 'string' ? detail : 'Failed to save tag.')
      setBusy(false)
    }
  }, [name, mode, isCreate, color, initialName, initialColor, tag, createProjectTag, updateProjectTag, programCreate, programRename, programSetColor, onClose])

  if (!isOpen) return null

  // Rename-only warning. Recolour propagates implicitly (one source
  // of truth — every badge re-renders with the new colour) and
  // doesn't warrant a warning. Rename is the only edit where the
  // writer should be aware of the cross-host impact.
  const propagationMessage = (() => {
    if (isCreate || effectiveCount === 0) return null
    const willRename = name.trim().replace(/^#+/, '').trim() !== initialName
    if (!willRename) return null
    const noun = effectiveCount === 1 ? 'object' : 'objects'
    return `Renaming this tag will update its label on ${effectiveCount} ${noun}.`
  })()

  return createPortal(
    <div
      ref={popoverRef}
      data-help-region="tag-picker:edit_popover"
      className="fixed z-50 bg-zinc-900 border border-zinc-700 rounded shadow-xl p-2"
      style={{
        left: anchorRight + ANCHOR_GAP,
        top: anchorTop,
        width: POPOVER_WIDTH,
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {readOnly ? (
        <div className="flex items-center">
          <TagBadge name={initialName} color={initialColor} size="md" />
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <button
            ref={setColorChipEl}
            type="button"
            onClick={() => setPickerOpen((v) => !v)}
            className="w-7 h-7 rounded border border-zinc-600 hover:border-zinc-400 transition-colors shrink-0"
            style={{ backgroundColor: color }}
            title="Edit colour"
            disabled={busy}
          />
          <input
            ref={nameInputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); handleSave() }
            }}
            placeholder="tag name"
            className="flex-1 min-w-0 px-2 py-1 text-xs bg-zinc-800 border border-zinc-700 rounded text-zinc-200 focus:outline-none focus:border-accent-500"
            disabled={busy}
          />
          {/* Icon-only Save / Cancel. Tooltips on hover. */}
          <button
            type="button"
            onClick={handleSave}
            className="w-7 h-7 inline-flex items-center justify-center rounded border border-accent-600 bg-accent-700/40 text-accent-200 hover:bg-accent-700/60 transition-colors shrink-0 disabled:opacity-50"
            disabled={busy}
            title={busy ? 'Saving…' : 'Save'}
          >
            <span style={{ display: 'block', lineHeight: 1, transform: 'translateY(-1px)' }}>✓</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 inline-flex items-center justify-center rounded border border-zinc-700 bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 transition-colors shrink-0 disabled:opacity-50"
            disabled={busy}
            title="Cancel"
          >
            <span style={{ display: 'block', lineHeight: 1, transform: 'translateY(-1px)' }}>✕</span>
          </button>
        </div>
      )}

      {!readOnly && (errorMsg || propagationMessage) && (
        <div className="mt-1.5 text-[10px]">
          {errorMsg ? (
            <span className="text-red-300">{errorMsg}</span>
          ) : (
            <span className="text-amber-300/80 italic">{propagationMessage}</span>
          )}
        </div>
      )}

      {!isCreate && (
        <TaggedObjectsSection
          tag={tag}
          mode={mode}
          onNavigate={onClose}
        />
      )}

      <EntityColorPicker
        value={color}
        onChange={(hex) => setColor(hex)}
        anchorEl={colorChipEl}
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
      />
    </div>,
    document.body,
  )
}

// ── Tagged-objects section ──────────────────────────────────────────────────
//
// Lists every host carrying this tag, grouped by library-tab order.
// Project mode walks entity / knowledge / relationship / reference
// node / preset list pools; program mode walks context cues +
// conversations. Click a badge to navigate to the host's surface;
// for chain-trackable hosts the click lands on the earliest tagged
// anchor (origin if in baseline, otherwise the first chain `add`
// event for this tag).

const _HOST_GLYPHS = {
  character:     TYPE_ICONS.character,
  location:      TYPE_ICONS.location,
  item:          TYPE_ICONS.item,
  faction:       TYPE_ICONS.faction,
  custom:        TYPE_ICONS.custom,
  knowledge:     TYPE_ICONS.knowledge,
  relationship:  '🔗',
  cue:           '🧩',
  referenceNode: '📌',
  presetList:    '📋',
  conversation:  '💬',
}

function TaggedObjectsSection({ tag, mode, onNavigate }) {
  // Subscribe to the stores that hold each host kind. Selector
  // shapes mirror what `collectHosts*` expects (project = nodes /
  // knowledges / relationships; entities = bucketed map; cues +
  // conversation index for program mode).
  const nodes         = useProjectStore((s) => s.nodes)
  const edges         = useProjectStore((s) => s.edges)
  const knowledges    = useProjectStore((s) => s.knowledges)
  const relationships = useProjectStore((s) => s.relationships)
  const characters    = useEntitiesStore((s) => s.characters)
  const locations     = useEntitiesStore((s) => s.locations)
  const items         = useEntitiesStore((s) => s.items)
  const factions      = useEntitiesStore((s) => s.factions)
  const customs       = useEntitiesStore((s) => s.customs)
  const presetLists   = useEntitiesStore((s) => s.presetLists)
  const cues          = useContextCuesStore((s) => s.cues)
  const conversationsIndex = useConversationsStore((s) => s.index)

  // UI navigation actions, fetched via the store getter inside the
  // click handler so we don't pull every action into the subscribed
  // selector graph here.

  const project = useMemo(() => ({ nodes, edges, knowledges, relationships }),
    [nodes, edges, knowledges, relationships])
  const entities = useMemo(() => ({ characters, locations, items, factions, customs, presetLists }),
    [characters, locations, items, factions, customs, presetLists])

  // Phase 3.7N perf — module-cached project-level index. Replaces the
  // per-popover-open per-host `findEarliestProjectTagAnchor` walks
  // that walked the canvas graph N times. `membershipIndex.get(tagId)`
  // is O(1); `anchorIndex.get(tagId).get(hostKey)` is O(1).
  const { membershipIndex, anchorIndex } = useTagHostIndex()
  // Story order from the shared cache (same memo other consumers use)
  // so the knowledge / relationship chain walkers below don't pay a
  // recompute when the popover mounts.
  const storyOrder = useStoryOrder()

  // Compute the host list for this tag, then bucket each hit into
  // the right group per library order. Memoised to avoid re-walking
  // every typing keystroke (the name input above lives in the
  // parent and re-renders this section on each change).
  const grouped = useMemo(() => {
    // Project hosts come from the cached membership index now —
    // O(1) Map lookup, replacing the per-popover-open canvas walk.
    const projectHostKeys = (mode === 'project' && tag?.id)
      ? (membershipIndex.get(tag.id) || new Set())
      : new Set()
    const programHostKeys = (tag?.name)
      ? collectHostsForProgramTag(tag.name.toLowerCase(), cues, conversationsIndex)
      : new Set()
    const allKeys = new Set([...projectHostKeys, ...programHostKeys])

    // Per-tag anchor map from the cached anchor index. One Map.get
    // per popover open instead of one chain walk per host.
    const tagAnchors = (tag?.id && anchorIndex.get(tag.id)) || null

    const groups = {}
    for (const key of LIBRARY_HOST_ORDER) groups[key] = []

    const entityById = new Map()
    for (const bk of ENTITY_BUCKETS) {
      for (const e of (entities?.[bk] || [])) entityById.set(e.id, e)
    }
    const knowledgeById    = new Map(knowledges.map((k) => [k.id, k]))
    const relationshipById = new Map(relationships.map((r) => [r.id, r]))
    const presetListById   = new Map(presetLists.map((p) => [p.id, p]))
    const cueById          = new Map(cues.map((c) => [c.id, c]))
    const conversationById = new Map(conversationsIndex.map((c) => [c.id, c]))
    const refNodeById      = new Map(
      nodes.filter((n) => n.type === 'referenceNode').map((n) => [n.id, n]),
    )

    for (const key of allKeys) {
      const colonIdx = key.indexOf(':')
      if (colonIdx < 0) continue
      const kind = key.slice(0, colonIdx)
      const id = key.slice(colonIdx + 1)

      if (kind === 'entity') {
        const e = entityById.get(id)
        if (!e) continue
        const subtype = resolveEntitySubtype(id, entities) || e.type
        const bucket = groups[subtype]
        if (!bucket) continue
        // Resolve the entity's chain state at the earliest tagged
        // anchor so the chip's name, colour and avatar reflect what
        // the entity looked like at that point — not its origin
        // baseline. When the tag is in baseline the anchor is the
        // entity's origin node, and `computeEffectiveState` naturally
        // returns baseline state there. For downstream-only tags
        // (added via a chain event), the chip picks up any chain-
        // tracked name / colour / profile-image changes that landed
        // before or at the same anchor.
        //
        // Anchor lookup is now an O(1) Map.get against the project-
        // level cached anchor index; the chain-aware computeEffective
        // State walk still runs per visible host (chain-of-history is
        // the program's core — we do NOT shortcut to baseline display
        // here even if it would be faster).
        const anchorId = tagAnchors ? (tagAnchors.get(`entity:${id}`) ?? null) : null
        let displayEntity = e
        if (anchorId) {
          const eff = computeEffectiveState(e, project.nodes, project.edges, anchorId)
          if (eff) {
            displayEntity = {
              ...e,
              name:              eff.name              ?? e.name,
              colour:            eff.colour            ?? e.colour,
              description:       eff.description       ?? e.description,
              profile_image_ref: eff.profile_image_ref ?? e.profile_image_ref,
            }
          }
        }
        bucket.push({
          kind: subtype,
          id,
          name: displayEntity.name || '(unnamed)',
          entity: displayEntity,
          anchorId,
        })
      } else if (kind === 'knowledge') {
        const k = knowledgeById.get(id)
        if (!k) continue
        // Same chain-resolved-at-earliest-tagged-anchor pattern the
        // entity branch uses, via the knowledge-specific walker.
        const anchorId = tagAnchors ? (tagAnchors.get(`knowledge:${id}`) ?? null) : null
        let displayName = k.name
        if (anchorId) {
          const nodeOrder = getKnowledgeNodeOrder(k, nodes, edges, storyOrder)
          const eff = computeKnowledgeEffectiveState(k, nodeOrder, anchorId, { nodes, ctx: { storyOrder } })
          if (eff?.name) displayName = eff.name
        }
        groups.knowledge.push({
          kind: 'knowledge',
          id,
          name: displayName || '(unnamed)',
          anchorId,
        })
      } else if (kind === 'relationship') {
        const r = relationshipById.get(id)
        if (!r) continue
        const anchorId = tagAnchors ? (tagAnchors.get(`relationship:${id}`) ?? null) : null
        let displayName = r.name
        if (anchorId) {
          const nodeOrder = getRelationshipNodeOrder(r, nodes, edges, storyOrder)
          const eff = computeRelationshipEffectiveState(r, nodeOrder, anchorId)
          if (eff?.name) displayName = eff.name
        }
        groups.relationship.push({
          kind: 'relationship',
          id,
          name: displayName || '(unnamed relationship)',
          anchorId,
        })
      } else if (kind === 'referenceNode') {
        const n = refNodeById.get(id)
        if (!n) continue
        groups.referenceNode.push({ kind: 'referenceNode', id, name: n.data?.title || '(untitled note)' })
      } else if (kind === 'presetList') {
        const p = presetListById.get(id)
        if (!p) continue
        groups.presetList.push({ kind: 'presetList', id, name: p.name || '(unnamed list)' })
      } else if (kind === 'cue') {
        const c = cueById.get(id)
        if (!c) continue
        groups.cue.push({ kind: 'cue', id, name: c.name || '(unnamed cue)' })
      } else if (kind === 'conversation') {
        const c = conversationById.get(id)
        if (!c) continue
        groups.conversation.push({ kind: 'conversation', id, name: c.name || c.title || '(unnamed thread)' })
      }
    }

    for (const key of LIBRARY_HOST_ORDER) {
      groups[key].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
    }
    return groups
  }, [mode, tag, project, entities, cues, conversationsIndex, knowledges, relationships, presetLists, nodes, edges, membershipIndex, anchorIndex, storyOrder])

  const totalHits = useMemo(
    () => LIBRARY_HOST_ORDER.reduce((sum, k) => sum + grouped[k].length, 0),
    [grouped],
  )

  const handleClick = useCallback((host) => {
    const ui = useUiStore.getState()
    const focusFn = ui._focusNode

    if (['character', 'location', 'item', 'faction', 'custom'].includes(host.kind)) {
      // Entity hosts already cache `anchorId` on the host record
      // (computed alongside the chain-resolved display entity in the
      // grouped memo). Knowledge / Relationship don't yet — those
      // need their own walker plumbing — so they recompute here.
      const anchorId = host.anchorId ?? null
      if (anchorId && typeof focusFn === 'function') focusFn(anchorId)
      const anchorNode = anchorId ? nodes.find((n) => n.id === anchorId) : null
      // Origin entity-node → entityNode mode; scene chip or modifier
      // → entityChip mode (matches existing detail-panel routing).
      const detailMode = anchorNode
        && anchorNode.type === 'entityNode'
        && !anchorNode.data?.is_modifier
          ? 'entityNode'
          : 'entityChip'
      ui.setDetailPanel(detailMode, anchorId || null, host.id, -1)
    } else if (host.kind === 'knowledge') {
      ui.openKnowledgeDetail(host.id, host.anchorId ?? null)
    } else if (host.kind === 'relationship') {
      ui.openRelationshipDetail(host.id, host.anchorId ?? null)
    } else if (host.kind === 'referenceNode') {
      // Reference Nodes have no detail view; centre canvas on the node.
      if (typeof focusFn === 'function') focusFn(host.id)
    } else if (host.kind === 'presetList') {
      // Preset Lists live in the Tags & Lists library tab (we're
      // probably already there, but this is the canonical target).
      ui.setEntityLibraryTab?.('tags_and_lists')
    } else if (host.kind === 'cue') {
      ui.openContextCueEditor?.(host.id)
    } else if (host.kind === 'conversation') {
      useConversationsStore.getState().setActiveThreadId?.(host.id)
      ui.openChatPanel?.()
    }
    // Close the popover after navigating so it doesn't linger over
    // the panel the writer just opened.
    onNavigate?.()
  }, [mode, tag, project, entities, nodes, onNavigate])

  if (totalHits === 0) {
    return (
      <div className="mt-2 pt-2 border-t border-zinc-800">
        <div className="text-xs italic text-zinc-600">No objects carry this tag yet.</div>
      </div>
    )
  }

  return (
    <div className="mt-2 pt-2 border-t border-zinc-800 max-h-[40vh] overflow-y-auto" data-help-region="tag-picker:tagged_objects">
      {LIBRARY_HOST_ORDER.map((key) => {
        const group = grouped[key]
        if (!group || group.length === 0) return null
        return (
          <div key={key} className="mb-2 last:mb-0">
            <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1">{LIBRARY_HOST_LABELS[key] || key}</div>
            <div className="flex flex-wrap gap-1">
              {group.map((host) => {
                const k = host.kind
                // Entity hosts (character / location / item / faction /
                // custom) get the canonical `EntityLabelChip` — avatar
                // + entity-colour-tinted border. Knowledge gets the
                // canonical `KnowledgeLabelChip`; relationship gets
                // the canonical `RelationshipLabelChip`. The remaining
                // kinds (cue / referenceNode / presetList /
                // conversation) don't have a canonical inline chip in
                // `IdentityBadges`, so they use a lightweight neutral
                // button matching the canonical chips' visual weight.
                if (k === 'character' || k === 'location' || k === 'item' || k === 'faction' || k === 'custom') {
                  return (
                    <EntityLabelChip
                      key={`${k}:${host.id}`}
                      entity={host.entity}
                      onClick={() => handleClick(host)}
                      size="lg"
                    />
                  )
                }
                if (k === 'knowledge') {
                  return (
                    <KnowledgeLabelChip
                      key={`${k}:${host.id}`}
                      name={host.name}
                      onClick={() => handleClick(host)}
                      size="lg"
                    />
                  )
                }
                if (k === 'relationship') {
                  return (
                    <RelationshipLabelChip
                      key={`${k}:${host.id}`}
                      name={host.name}
                      onClick={() => handleClick(host)}
                      size="lg"
                    />
                  )
                }
                return (
                  <button
                    key={`${k}:${host.id}`}
                    type="button"
                    onClick={() => handleClick(host)}
                    className="inline-flex items-center gap-1 px-1.5 py-0 rounded border bg-zinc-800/60 text-xs text-zinc-300 hover:brightness-125 transition-colors max-w-[16rem]"
                    title={host.name}
                    style={{ borderColor: '#52525b66' }}
                  >
                    <span className="leading-none">{_HOST_GLYPHS[k] || '•'}</span>
                    <span className="truncate">{host.name}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
