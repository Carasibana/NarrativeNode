import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { useUiStore } from '../../store/uiStore'
import { useProjectStore } from '../../store/projectStore'
import { useEntitiesStore } from '../../store/entitiesStore'
import { confirm } from '../../store/dialogStore'
import { computeRelationshipEffectiveState, getRelationshipChangesAtNode, getEntityNarrativeChain, getRelationshipNodeOrder, computeEffectiveState, getRelationshipCreationNodeId } from '../../utils/narrativeChain'
import { useStoryOrder } from '../../hooks/useStoryOrder'
import { computePovChain } from '../../utils/povSequence'
import { usePovColor } from '../../utils/povConstants'
import PovNavToggleButton from '../ui/PovNavToggleButton'
import { TYPE_ICONS, participantsFallbackLabel } from '../../utils/entityHelpers'
import {
  ParticipantsFallbackLabel, RelationshipLabelChip, EntityAvatarName, NodeBadge,
  RelationshipLabelStack, RelationshipIcon, RelationshipArrow,
} from '../ui/IdentityBadges'
import {
  buildDeleteRelationshipMessage, buildEndRelationshipMessage, buildRemoveLastParticipantMessage,
} from '../ui/popupMessages'
import { RelChangeChip } from '../nodes/RelationshipChip'
import ImageHoverPreview from '../ui/ImageHoverPreview'
import DetailPanelNavBar from '../ui/DetailPanelNavBar'
import DetailPanelIdentityHeader from '../ui/DetailPanelIdentityHeader'
import AttachToChatButton from '../chat/AttachToChatButton'
import DetailPanelShell from '../ui/DetailPanelShell'
import DraftSaveBar from '../ui/DraftSaveBar'
import { useDetailPanelDraft } from '../../hooks/useDetailPanelDraft'
import DescriptionEditor from '../ui/DescriptionEditor'
import ProjectTagPicker from '../tags/ProjectTagPicker'
import TagPopover from '../tags/TagPopover'
import { useTagBrowsePopover } from '../tags/useTagBrowsePopover'
import ShowInTocButton from '../ui/ShowInTocButton'
import DetailPanelSubTabs from '../ui/DetailPanelSubTabs'
import RelationshipHierarchyTree from './RelationshipHierarchyTree'
import { reparentNode, autoIncludeMissing, autoPruneMissing, cloneRoots, participantsToRoles, rolesToParticipants, removeNode } from '../../utils/relationshipHierarchy'
import PresetListPicker from '../ui/PresetListPicker'
import RelationshipKnownBySection from '../ui/RelationshipKnownBySection'
import AwareOfSection, { makeSourceMatcher } from '../ui/AwareOfSection'
import { resolveChapterIdForNode } from '../../utils/chapterMembership'
import { useChapterMemberOpts } from '../../hooks/useChapterMemberOpts'

const EMPTY_CHAPTERS = []

const REL_COLOUR = '#a78bfa'

// ── Participant avatar (header, 24 px) ────────────────────────────────────────

function ParticipantAvatar({ entity, displayName, displayColour, displayImageRef, size = 24 }) {
  if (!entity) return null
  // Display fields are pre-resolved by the caller via the chain walker
  // at the panel's `currentNodeId` so colour / profile image / title
  // name reflect any upstream modifiers, not the library baseline.
  // `entity.type` stays read direct — type is invariant per entity.
  const colour    = displayColour || '#888888'
  const assetName = displayImageRef ? displayImageRef.replace(/^assets\//, '') : null
  const src       = assetName ? `/api/project/assets/${assetName}` : null
  const inner = src ? (
    <img src={src} alt="" className="rounded object-cover flex-shrink-0"
      style={{ width: size, height: size, border: `1.5px solid ${colour}` }} title={displayName} />
  ) : (
    <span className="rounded flex items-center justify-center flex-shrink-0"
      style={{ width: size, height: size, backgroundColor: colour + '22', border: `1.5px solid ${colour}`, fontSize: Math.floor(size * 0.45), lineHeight: 1 }}
      title={displayName}>
      {TYPE_ICONS[entity.type] || '★'}
    </span>
  )
  if (src) return <ImageHoverPreview src={src} borderColour={colour} size={80}>{inner}</ImageHoverPreview>
  return inner
}

// ── Participant detail row (Details tab, accordion + draft/save) ──────────────

function ParticipantRow({ participant, role, entity, displayName, displayColour, displayImageRef, displayAliases, isExpanded, onToggle, draft, isDirty, onDraftChange, onSave, onCancel, fieldOverrides, onRevert, onRemove, onNavigate }) {
  const [hovered, setHovered] = useState(false)
  const [rolePickerOpen, setRolePickerOpen] = useState(false)
  // Callback-ref pattern: state, not useRef. The picker needs the
  // anchor button's DOM node to position itself; reading
  // `someRef.current` during render is brittle (the ref may still hold
  // a stale or null value on the first render after the anchor is
  // mounted) AND violates `react-hooks/refs`. Storing the element in
  // state and passing `setRolePresetAnchorEl` as the JSX `ref={...}`
  // callback prop gives the picker a reactive anchor — it re-renders
  // when the anchor element mounts or unmounts.
  const [rolePresetAnchorEl, setRolePresetAnchorEl] = useState(null)
  const presetLists = useEntitiesStore((s) => s.presetLists || [])
  if (!entity) return null
  // Display fields are pre-resolved by the caller via the chain walker
  // at the panel's `currentNodeId` so name / colour / profile image /
  // aliases reflect any upstream modifiers, not the library baseline.
  // `entity.type` stays read direct — type is invariant per entity, not
  // a chain-tracked field.
  const colour    = displayColour || '#888888'
  const assetName = displayImageRef ? displayImageRef.replace(/^assets\//, '') : null
  const src       = assetName ? `/api/project/assets/${assetName}` : null
  const avatar    = src ? (
    <img src={src} alt="" className="rounded object-cover flex-shrink-0"
      style={{ width: 22, height: 22, border: `1.5px solid ${colour}` }} />
  ) : (
    <span className="rounded flex items-center justify-center flex-shrink-0 text-[10px]"
      style={{ width: 22, height: 22, backgroundColor: colour + '22', border: `1.5px solid ${colour}` }}>
      {TYPE_ICONS[entity.type] || '★'}
    </span>
  )

  const entityAliases = (displayAliases || [])
    .map((a) => (typeof a === 'string' ? a : a.value))
    .filter(Boolean)

  return (
    <div
      data-help-region="detail-relationship:details_participant_row"
      className="relative flex flex-col border-b border-zinc-700/50 border-l-2 last:border-b-0"
      style={{ borderLeftColor: colour }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* ── Header (always visible, click to toggle) ── */}
      <div
        className="flex items-center gap-1.5 pl-1.5 pr-5 py-1.5 cursor-pointer hover:bg-zinc-800/30 select-none"
        onClick={onToggle}
      >
        <button
          type="button"
          className="flex-shrink-0 p-0 bg-transparent border-0 inline-flex hover:opacity-75 focus:outline-none transition-opacity"
          onClick={(e) => { e.stopPropagation(); onNavigate?.() }}
          title={onNavigate ? `View ${displayName}'s relationships` : undefined}
        >
          {src ? <ImageHoverPreview src={src} borderColour={colour} size={80}>{avatar}</ImageHoverPreview> : avatar}
        </button>
        <div className="flex items-baseline gap-1 flex-1 min-w-0">
          <span className="text-xs text-zinc-200 font-medium truncate min-w-0">{displayName}</span>
          {!isExpanded && participant.alias_override && (
            <span className="text-[10px] text-zinc-500 italic flex-shrink-0">as {participant.alias_override}</span>
          )}
        </div>
        {isDirty && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0 mr-0.5" title="Unsaved changes" />}
        <span className="text-[8px] text-zinc-600 flex-shrink-0">{isExpanded ? '▲' : '▼'}</span>
      </div>

      {/* ── Collapsed summary (role + perception only; alias is in the header) ── */}
      {!isExpanded && (role?.value || participant.perception) && (
        <div className="pl-7 pr-2 pb-1.5">
          <div className="flex items-baseline gap-2 min-w-0">
            {role?.value && <span className="text-[10px] text-zinc-500 flex-shrink-0">{role.value}</span>}
            {participant.perception && (
              <span className="text-[10px] text-zinc-600 italic truncate min-w-0">{participant.perception}</span>
            )}
          </div>
        </div>
      )}

      {/* ── Expanded draft editor ── */}
      {isExpanded && draft && (
        <div className="pl-7 pr-1 pb-2 flex flex-col gap-1.5">
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1">
              <span className="text-[9px] text-zinc-600 uppercase tracking-wider">View</span>
              {fieldOverrides?.perception && (
                <>
                  <span className="text-[9px] text-amber-400 font-semibold leading-none">✱</span>
                  <button className="text-[10px] font-bold text-zinc-500 hover:text-red-400 leading-none" onClick={() => onRevert('perception')} title="Revert this change">−</button>
                </>
              )}
            </div>
            <textarea
              className="text-[10px] bg-zinc-800 border border-zinc-600 focus:border-violet-400 rounded px-1 py-0.5 resize-none focus:outline-none text-zinc-200 w-full"
              rows={2}
              value={draft.perception}
              onChange={(e) => onDraftChange('perception', e.target.value)}
              placeholder="How this participant sees the relationship…"
            />
          </div>
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1">
              <span className="text-[9px] text-zinc-600 uppercase tracking-wider">Alias</span>
              {fieldOverrides?.alias && (
                <>
                  <span className="text-[9px] text-amber-400 font-semibold leading-none">✱</span>
                  <button className="text-[10px] font-bold text-zinc-500 hover:text-red-400 leading-none" onClick={() => onRevert('alias')} title="Revert this change">−</button>
                </>
              )}
            </div>
            {entityAliases.length === 0 ? (
              <span className="text-[10px] text-zinc-700 italic px-0.5 py-0.5">No aliases defined</span>
            ) : (
              <select
                className="text-[10px] bg-zinc-800 border border-zinc-600 focus:border-violet-400 rounded px-1 py-0.5 focus:outline-none text-zinc-200"
                value={draft.alias || ''}
                onChange={(e) => onDraftChange('alias', e.target.value)}
              >
                <option value="">None</option>
                {entityAliases.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            )}
          </div>
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1">
              <span className="text-[9px] text-zinc-600 uppercase tracking-wider">Role</span>
              {fieldOverrides?.role && (
                <>
                  <span className="text-[9px] text-amber-400 font-semibold leading-none">✱</span>
                  <button className="text-[10px] font-bold text-zinc-500 hover:text-red-400 leading-none" onClick={() => onRevert('role')} title="Revert this change">−</button>
                </>
              )}
              {draft.role?.preset_list_id ? (
                <button
                  className="ml-auto text-[8px] text-zinc-600 hover:text-zinc-400 leading-none"
                  onClick={() => onDraftChange('role', { value: draft.role?.value || '', preset_list_id: null })}
                  title="Switch to free-form text"
                >free-form</button>
              ) : (
                <button
                  ref={setRolePresetAnchorEl}
                  className="ml-auto text-[8px] text-zinc-600 hover:text-zinc-400 leading-none"
                  onClick={() => setRolePickerOpen(true)}
                  title="Choose a preset list"
                >preset</button>
              )}
            </div>
            {draft.role?.preset_list_id ? (
              <>
                <button
                  ref={setRolePresetAnchorEl}
                  onClick={() => setRolePickerOpen(true)}
                  className="text-[10px] bg-zinc-800 border border-zinc-600 hover:border-zinc-400 rounded px-1 py-0.5 text-left w-full focus:outline-none"
                  title="Change preset list"
                >
                  {(() => {
                    const list = presetLists.find((l) => l.id === draft.role.preset_list_id)
                    return list
                      ? <span className="text-zinc-400 italic">{list.name}</span>
                      : <span className="text-zinc-500 italic">list not found</span>
                  })()}
                </button>
                {(() => {
                  const list = presetLists.find((l) => l.id === draft.role.preset_list_id)
                  if (!list) return null
                  return (
                    <select
                      className="text-[10px] bg-zinc-800 border border-zinc-600 focus:border-violet-400 rounded px-1 py-0.5 focus:outline-none text-zinc-200"
                      value={draft.role?.value || ''}
                      onChange={(e) => onDraftChange('role', { ...draft.role, value: e.target.value })}
                    >
                      <option value="">— select value —</option>
                      {(list.values || []).map((v) => <option key={v} value={v}>{v}</option>)}
                    </select>
                  )
                })()}
              </>
            ) : (
              <input
                className="text-[10px] bg-zinc-800 border border-zinc-600 focus:border-violet-400 rounded px-1 py-0.5 focus:outline-none text-zinc-200 w-full"
                value={draft.role?.value || ''}
                onChange={(e) => onDraftChange('role', { value: e.target.value, preset_list_id: null })}
                placeholder="Role in this relationship…"
                onKeyDown={(e) => { if (e.key === 'Enter') onSave(); if (e.key === 'Escape') onCancel() }}
              />
            )}
            <PresetListPicker
              value={draft.role?.preset_list_id || null}
              onChange={(listId) => onDraftChange('role', { value: '', preset_list_id: listId })}
              anchorEl={rolePresetAnchorEl}
              isOpen={rolePickerOpen}
              onClose={() => setRolePickerOpen(false)}
            />
          </div>
          <div className="flex items-center justify-end gap-1.5 mt-0.5">
            <button
              className="text-[9px] text-zinc-500 hover:text-zinc-300 px-1.5 py-0.5 rounded"
              onClick={onCancel}
            >Cancel</button>
            <button
              className="text-[9px] px-2 py-0.5 rounded flex items-center gap-1 transition-colors bg-accent-500 hover:bg-accent-400 text-zinc-900 font-medium"
              onClick={onSave}
            >
              {isDirty && <span className="w-1 h-1 rounded-full bg-amber-500 flex-shrink-0" />}
              Save
            </button>
          </div>
        </div>
      )}

      {/* ── Remove button (hover, both states) ── */}
      {onRemove && hovered && (
        <button
          className="absolute top-1.5 right-0 w-4 h-4 flex items-center justify-center text-[10px] text-zinc-600 hover:text-red-400 hover:bg-red-900/20 rounded transition-colors nodrag"
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          title="Remove participant"
        >✕</button>
      )}
    </div>
  )
}

// ── Main panel ────────────────────────────────────────────────────────────────

export default function RelationshipDetailView() {
  const activeSelection              = useUiStore((s) => s.activeSelection)
  const setActiveSelection           = useUiStore((s) => s.setActiveSelection)
  const setDetailPanel               = useUiStore((s) => s.setDetailPanel)
  const focusNode                    = useUiStore((s) => s._focusNode)
  const openEntityAtRelationshipsTab = useUiStore((s) => s.openEntityAtRelationshipsTab)

  const relationships              = useProjectStore((s) => s.relationships)
  const storeNodes                 = useProjectStore((s) => s.nodes)
  const storeEdges                 = useProjectStore((s) => s.edges)
  const storyChapters              = useProjectStore((s) => s.story?.chapters || EMPTY_CHAPTERS)
  const chapterMemberOpts          = useChapterMemberOpts()
  const deleteObject               = useProjectStore((s) => s.deleteObject)
  const recordRelationshipChange   = useProjectStore((s) => s.recordRelationshipChange)
  const removeRelationshipChange   = useProjectStore((s) => s.removeRelationshipChange)
  const setRelationshipName        = useProjectStore((s) => s.setRelationshipName)
  const setRelationshipDescription = useProjectStore((s) => s.setRelationshipDescription)
  const recordRelationshipTagChange = useProjectStore((s) => s.recordRelationshipTagChange)
  const setRelationshipHierarchy   = useProjectStore((s) => s.setRelationshipHierarchy)
  const addParticipantAction       = useProjectStore((s) => s.addParticipant)
  const removeParticipantAction    = useProjectStore((s) => s.removeParticipant)
  const setParticipantPerception   = useProjectStore((s) => s.setParticipantPerception)
  const setParticipantAlias        = useProjectStore((s) => s.setParticipantAlias)
  const setParticipantRole         = useProjectStore((s) => s.setParticipantRole)

  const allCharacters = useEntitiesStore((s) => s.characters)
  const allLocations  = useEntitiesStore((s) => s.locations)
  const allItems      = useEntitiesStore((s) => s.items)
  const allFactions   = useEntitiesStore((s) => s.factions)
  const allCustoms    = useEntitiesStore((s) => s.customs)
  const allKnowledges = useProjectStore((s) => s.knowledges || [])

  const getEntity = useCallback((id) => {
    for (const bucket of [allCharacters, allLocations, allItems, allFactions, allCustoms, allKnowledges]) {
      const found = bucket.find((e) => e.id === id)
      if (found) return found
    }
    return null
  }, [allCharacters, allLocations, allItems, allFactions, allCustoms, allKnowledges])

  const relId      = activeSelection?.id
  const atNodeHint = activeSelection?.atNodeId || null

  const relationship = relationships.find((r) => r.id === relId)

  // Graph-walk narrative order for this relationship's chain. Canvas
  // x-position is NEVER used for chain ordering (see v0.1.18.121+ audit).
  // Filter over the global story order so manual-anchor scenes land at
  // their deterministic global position (Phase 1.19).
  const storyOrder = useStoryOrder()
  const nodeOrder = useMemo(
    () => getRelationshipNodeOrder(relationship, storeNodes, storeEdges, storyOrder),
    [relationship, storeNodes, storeEdges, storyOrder]
  )

  // Sparse chain: nodes that have at least one history entry (any change type,
  // INCLUDING manual_anchors pinned by the user via library-to-scene drag),
  // PLUS scenes where the relationship is ambient (active AND all current
  // participants present). Dynamic iteration over `history` keys so any future
  // history field is auto-covered without re-listing.
  // Phase 1.26 — POV-only nav toggle. When ON, filter sparseChain to:
  // creation anchor (relationship origin) + sceneNode entries that lie
  // on the POV chain. When OFF, full sparseChain as before.
  const povNavOnly    = useUiStore((s) => s.povNavOnly)
  const setPovNavOnly = useUiStore((s) => s.setPovNavOnly)
  const povColor      = usePovColor()

  const { sparseChain, hasAnyPov } = useMemo(() => {
    if (!relationship) return { sparseChain: [], hasAnyPov: false }
    const hist = relationship.history || {}
    const seen = new Set()
    for (const arr of Object.values(hist)) {
      if (!Array.isArray(arr)) continue
      for (const entry of arr) {
        if (entry?.node_id) seen.add(entry.node_id)
      }
    }
    for (const node of storeNodes) {
      if (node.type !== 'sceneNode') continue
      if (seen.has(node.id)) continue
      const effective = computeRelationshipEffectiveState(relationship, nodeOrder, node.id)
      if (!effective || !effective.is_active) continue
      const participants = effective.participants || []
      if (participants.length === 0) continue
      const sceneIds = new Set()
      for (const bucket of ['characters', 'locations', 'items', 'factions', 'customs']) {
        for (const ref of (node.data?.[bucket] || [])) {
          if (ref.entity_id) sceneIds.add(ref.entity_id)
        }
      }
      if (participants.every((p) => sceneIds.has(p.entity_id))) {
        seen.add(node.id)
      }
    }
    const fullSparse = nodeOrder.filter((id) => seen.has(id))

    const povChain = computePovChain(storeNodes, storeEdges)
    const povSet = new Set(povChain.sequence.map((s) => s.nodeId))
    const havePov = povSet.size > 0

    if (!povNavOnly || !havePov) return { sparseChain: fullSparse, hasAnyPov: havePov }

    // Filter when ON: keep relationship origin (creation anchor) +
    // sceneNode entries that are on the POV chain.
    const originId = getRelationshipCreationNodeId(relationship, storeNodes, null)
    const filtered = fullSparse.filter((id) => {
      if (id === originId) return true
      const node = storeNodes.find((n) => n.id === id)
      if (node?.type !== 'sceneNode') return false
      return povSet.has(id)
    })
    return { sparseChain: filtered, hasAnyPov: true }
  }, [relationship, nodeOrder, storeNodes, storeEdges, povNavOnly])

  const nodeOrderMap = useMemo(
    () => new Map(nodeOrder.map((id, i) => [id, i])),
    [nodeOrder]
  )

  // Chain index — initialized using sparseChain (already computed above since
  // useMemo runs before the useState lazy initializer on the same render)
  const [chainIdx, setChainIdx] = useState(() => {
    if (sparseChain.length === 0) return -1
    if (!atNodeHint) return sparseChain.length - 1
    const exact = sparseChain.indexOf(atNodeHint)
    if (exact >= 0) return exact
    return sparseChain.length - 1
  })

  // overrideNodeId: set when the panel is opened at a node NOT yet in the sparse chain
  // (no history entries there yet). Allows editing at any scene the relationship is active
  // at, not just scenes where changes already exist. Cleared when the user navigates via arrows.
  const [overrideNodeId, setOverrideNodeId] = useState(() => {
    if (!atNodeHint) return null
    if (sparseChain.includes(atNodeHint)) return null
    return atNodeHint
  })

  const clampedIdx    = sparseChain.length === 0 ? -1 : Math.max(0, Math.min(chainIdx, sparseChain.length - 1))
  const currentNodeId = overrideNodeId || (clampedIdx >= 0 ? sparseChain[clampedIdx] : null)
  const currentNode   = currentNodeId ? storeNodes.find((n) => n.id === currentNodeId) : null

  // Chapter label for the nav bar subtitle: resolved from the current chain
  // position's scene node. Null when no chain position / no chapters / the
  // node's x-position falls outside all chapter columns.
  const chapterLabel = useMemo(() => {
    if (!storyChapters || storyChapters.length === 0) return null
    if (!currentNode) return null
    const chapterId = resolveChapterIdForNode(currentNode, storyChapters, chapterMemberOpts)
    if (!chapterId) return null
    const idx = storyChapters.findIndex((c) => c.id === chapterId)
    if (idx < 0) return null
    const c = storyChapters[idx]
    return c.title || `Chapter ${idx + 1}`
  }, [currentNode, storyChapters, chapterMemberOpts])

  const overrideOrdinal = overrideNodeId ? (nodeOrderMap.get(overrideNodeId) ?? Infinity) : null
  const canBack    = overrideNodeId
    ? sparseChain.some((id) => (nodeOrderMap.get(id) ?? Infinity) < overrideOrdinal)
    : clampedIdx > 0
  const canForward = overrideNodeId
    ? sparseChain.some((id) => (nodeOrderMap.get(id) ?? Infinity) > overrideOrdinal)
    : clampedIdx >= 0 && clampedIdx < sparseChain.length - 1

  const effectiveState = useMemo(
    () => relationship ? computeRelationshipEffectiveState(relationship, nodeOrder, currentNodeId) : null,
    [relationship, nodeOrder, currentNodeId]
  )

  const changesAtNode = useMemo(
    () => (relationship && currentNodeId) ? getRelationshipChangesAtNode(relationship, currentNodeId, undefined, nodeOrder) : [],
    [relationship, currentNodeId, nodeOrder]
  )

  // Stable refs for the chain-resolved participants / roles. Without the
  // useMemo wrappers, the `|| []` / `|| {}` fallbacks allocated a fresh
  // empty literal on every render, which invalidated every downstream
  // memo that listed `participants` or `participantRoles` as a dep
  // (notably `participantIds`, the system-prompt builders, and several
  // other panels) on every keystroke / state change. The memos hold
  // until the underlying chain-resolved field actually changes.
  const participants = useMemo(
    () => effectiveState?.participants || [],
    [effectiveState?.participants]
  )
  const participantRoles = useMemo(
    () => effectiveState?.participant_roles || relationship?.participant_roles || {},
    [effectiveState?.participant_roles, relationship?.participant_roles]
  )

  // Participant chain-resolved state resolver. Returns the entity's
  // effective name / colour / profile-image-ref / aliases at the panel's
  // `currentNodeId`, falling back to the baseline values when no chain
  // modifier has been recorded yet. Without this, the participant rows,
  // header avatars, and hierarchy labels would all read baseline values
  // and miss any upstream `name_change` / `colour_change` /
  // `profile_image_change` / `aliases_change`.
  //
  // `name`/`colour` always have a non-empty string fallback; `profile_image_ref`
  // and `aliases` may be null / [] respectively. `entity` is the raw
  // library object so callers needing un-chain-tracked attributes
  // (notably `type` for the icon fallback) still have access.
  const resolveParticipantEffective = useCallback((entityId) => {
    const ent = getEntity(entityId)
    if (!ent) return null
    const s = computeEffectiveState(ent, storeNodes, storeEdges, currentNodeId)
    return {
      entity:            ent,
      name:              s?.name              || ent.name              || '',
      colour:            s?.colour            || ent.colour            || '#888888',
      profile_image_ref: s?.profile_image_ref ?? ent.profile_image_ref ?? null,
      aliases:           s?.aliases           || ent.aliases           || [],
    }
  }, [getEntity, storeNodes, storeEdges, currentNodeId])

  // Backwards-compatible name-only resolver (still used by the fallback-
  // label helpers and confirm-dialog message builders).
  const resolveParticipantName = useCallback((entityId) => {
    return resolveParticipantEffective(entityId)?.name || null
  }, [resolveParticipantEffective])

  // All entities flat list for participant picker
  const allEntitiesList = useMemo(
    () => [...allCharacters, ...allLocations, ...allItems, ...allFactions, ...allCustoms, ...allKnowledges],
    [allCharacters, allLocations, allItems, allFactions, allCustoms, allKnowledges]
  )

  // Sub-tabs
  const [subTab, setSubTab] = useState('details')
  const [knownByExpanded, setKnownByExpanded] = useState(true)

  // ── Panel-level draft (shared shell-draft hook) ─────────────────────────────
  // Name + description are panel-level scalar fields. They route through
  // the shared `useDetailPanelDraft` hook instead of committing on blur,
  // matching the entity-view pattern. Participant-row drafts are out of
  // scope and keep their inline per-row Save / Cancel UX. Hierarchy
  // reorder is a discrete drag-drop action that commits immediately
  // (also out of scope for the panel-level draft).
  const _effectiveName = effectiveState?.name ?? relationship?.name ?? ''
  const effectiveDescription = effectiveState?.description ?? relationship?.description ?? ''
  // Walker-resolved tag membership at this anchor. Draft holds the
  // prospective effective set; save diffs against this and emits a
  // chain-aware `recordRelationshipTagChange` per diff entry.
  const _effectiveTagIds = effectiveState?.tag_ids || []
  function _initRelDraft() {
    return {
      name:        _effectiveName,
      description: effectiveDescription,
      tag_ids:     [..._effectiveTagIds],
    }
  }
  function _handleRelSave() {
    if (!_panelDraft || !relationship) return
    if ((_panelDraft.name?.trim() || '') !== _effectiveName) {
      setRelationshipName(relId, _panelDraft.name?.trim() || null, currentNodeId)
    }
    if ((_panelDraft.description || '') !== (effectiveDescription || '')) {
      setRelationshipDescription(relId, _panelDraft.description || '', currentNodeId)
    }
    // Tags — diff draft set vs saved effective set, route each diff
    // entry through `recordRelationshipTagChange`. The store action's
    // internal split (creation-anchor check) handles baseline-at-
    // origin vs chain-event-at-anchor; pair-cancel + duplicate-drop
    // invariants apply on the chain path. Passing `currentNodeId`
    // unconditionally matches the relationship-store convention used
    // by `setRelationshipName` / `setRelationshipDescription`.
    const draftTagSet = new Set(_panelDraft.tag_ids || [])
    const effectiveSet = new Set(_effectiveTagIds)
    for (const tagId of draftTagSet) {
      if (!effectiveSet.has(tagId)) {
        recordRelationshipTagChange(relId, 'add', tagId, currentNodeId)
      }
    }
    for (const tagId of effectiveSet) {
      if (!draftTagSet.has(tagId)) {
        recordRelationshipTagChange(relId, 'remove', tagId, currentNodeId)
      }
    }
  }
  function _handleRelDiscard() {
    setEditingName(false)
  }
  const _relDraftKey = relId ? `relationship:${relId}:${currentNodeId ?? 'origin'}` : null
  const _relDraftHandle = useDetailPanelDraft({
    draftKey: _relDraftKey,
    save: () => _handleRelSave(),
    discard: () => _handleRelDiscard(),
  })
  const _panelDraft = _relDraftHandle.draft
  const setPanelDraft = _relDraftHandle.setDraft
  const isPanelDirty  = _relDraftHandle.isDirty

  // Name field: input value reads from draft when dirty, effective state
  // otherwise. Click puts the name into edit mode (input visible);
  // blur / Enter exits edit mode but does NOT commit — commit happens
  // when the user clicks Save in the panel-level save bar.
  const nameInputRef = useRef(null)
  const [editingName, setEditingName] = useState(false)
  const nameVal = (isPanelDirty && _panelDraft?.name != null) ? _panelDraft.name : _effectiveName

  function startEditName() {
    setEditingName(true)
  }
  function setNameVal(val) {
    setPanelDraft((d) => ({ ..._initRelDraft(), ...(d || {}), name: val }))
  }
  function commitNameEdit() {
    setEditingName(false)
  }

  // Description field — multi-line. Same pattern as name.
  const descVal = (isPanelDirty && _panelDraft?.description != null) ? _panelDraft.description : effectiveDescription
  function setDescVal(val) {
    setPanelDraft((d) => ({ ..._initRelDraft(), ...(d || {}), description: val }))
  }
  function commitDescEdit() {
    // No-op: blur no longer commits. The panel-level Save bar commits.
  }

  // Tag membership — draft holds the prospective effective tag set
  // at this anchor. Picker writes go through these helpers so adds
  // / removes stay in the draft until Save (or get rolled back on
  // Discard). The save handler above diffs draft vs `_effectiveTagIds`
  // and emits per-diff `recordRelationshipTagChange` calls.
  const draftTagIds = (isPanelDirty && Array.isArray(_panelDraft?.tag_ids)) ? _panelDraft.tag_ids : _effectiveTagIds
  function addDraftTagId(tagId) {
    setPanelDraft((d) => {
      const base = { ..._initRelDraft(), ...(d || {}) }
      const list = Array.isArray(base.tag_ids) ? base.tag_ids : []
      if (list.includes(tagId)) return base
      return { ...base, tag_ids: [...list, tagId] }
    })
  }
  function removeDraftTagId(tagId) {
    setPanelDraft((d) => {
      const base = { ..._initRelDraft(), ...(d || {}) }
      const list = Array.isArray(base.tag_ids) ? base.tag_ids : []
      return { ...base, tag_ids: list.filter((id) => id !== tagId) }
    })
  }
  // Is the active anchor THIS relationship's creation node? Used by
  // the picker's `baselineTagIds` to apply the dashed-border draft-
  // state fix: at origin while dirty, the prospective baseline IS
  // `draft.tag_ids`, so freshly-added chips render solid (not dashed)
  // even before save lands. Elsewhere baselineTagIds stays at the
  // saved `relationship.tag_ids` so chain-added chips render dashed.
  const _creationAnchorNodeId = relationship
    ? getRelationshipCreationNodeId(relationship, storeNodes, currentNodeId)
    : null
  const isAtRelOrigin = !currentNodeId || _creationAnchorNodeId === currentNodeId

  // Participant accordion + per-participant draft state
  const [expandedParticipantId, setExpandedParticipantId] = useState(null)
  const [participantDrafts, setParticipantDrafts] = useState({}) // { [entityId]: { perception, alias, role } }

  function toggleParticipant(entityId) {
    setExpandedParticipantId((prev) => {
      if (prev === entityId) {
        // collapse -- discard draft
        setParticipantDrafts((d) => { const n = { ...d }; delete n[entityId]; return n })
        return null
      }
      // expand -- initialise draft from current effective state
      const p = participants.find((x) => x.entity_id === entityId)
      const r = participantRoles[entityId]
      setParticipantDrafts((d) => ({
        ...d,
        [entityId]: {
          perception: p?.perception || '',
          alias:      p?.alias_override || '',
          role:       r ? { value: r.value || '', preset_list_id: r.preset_list_id || null } : { value: '', preset_list_id: null },
        },
      }))
      return entityId
    })
  }

  function updateParticipantDraft(entityId, field, value) {
    setParticipantDrafts((d) => ({ ...d, [entityId]: { ...d[entityId], [field]: value } }))
  }

  function participantDraftIsDirty(entityId) {
    const d = participantDrafts[entityId]
    if (!d) return false
    const p = participants.find((x) => x.entity_id === entityId)
    const r = participantRoles[entityId]
    return d.perception         !== (p?.perception || '')
        || d.alias              !== (p?.alias_override || '')
        || d.role?.value        !== (r?.value || '')
        || d.role?.preset_list_id !== (r?.preset_list_id || null)
  }

  function commitParticipantSingleField(entityId, field, val) {
    if (currentNodeId && !isCreationNode) {
      if (field === 'perception') {
        recordRelationshipChange(relId, { type: 'perception', data: { node_id: currentNodeId, entity_id: entityId, new_perception: val } })
      } else if (field === 'alias') {
        recordRelationshipChange(relId, { type: 'alias', data: { node_id: currentNodeId, entity_id: entityId, new_alias_override: val || null } })
      } else if (field === 'role') {
        // Phase 1.21h Fix #2 — setParticipantRole is now anchor-aware
        // and branches internally. Pass currentNodeId unconditionally;
        // the action routes baseline vs chain entry per its own
        // creation-node check.
        setParticipantRole(relId, entityId, val, currentNodeId)
      }
    } else {
      const rel = relationships.find((r) => r.id === relId)
      if (!rel) return
      // Creation-node context: perception/alias edits update the
      // `initial_perception` / `initial_alias_override` on that entity's
      // `join` event(s); role mutates `participant_roles` (a separate
      // dict). All three route through canonical store actions →
      // domain helpers (3-layer convention — no inline history
      // mutation here).
      if (field === 'perception') {
        setParticipantPerception(relId, entityId, val)
      } else if (field === 'alias') {
        setParticipantAlias(relId, entityId, val)
      } else if (field === 'role') {
        setParticipantRole(relId, entityId, val, currentNodeId)
      }
    }
  }

  function saveParticipantDraft(entityId) {
    const d = participantDrafts[entityId]
    if (d) {
      const p = participants.find((x) => x.entity_id === entityId)
      const r = participantRoles[entityId]
      if (d.perception !== (p?.perception || '')) commitParticipantSingleField(entityId, 'perception', d.perception)
      if (d.alias      !== (p?.alias_override || '')) commitParticipantSingleField(entityId, 'alias', d.alias)
      if (d.role?.value !== (r?.value || '') || d.role?.preset_list_id !== (r?.preset_list_id || null))
        commitParticipantSingleField(entityId, 'role', d.role)
    }
    setExpandedParticipantId(null)
    setParticipantDrafts((prev) => { const n = { ...prev }; delete n[entityId]; return n })
  }

  function cancelParticipantDraft(entityId) {
    setExpandedParticipantId(null)
    setParticipantDrafts((prev) => { const n = { ...prev }; delete n[entityId]; return n })
  }

  function getParticipantFieldOverrides(entityId) {
    if (!currentNodeId || !relationship) return {}
    const h = relationship.history || {}
    return {
      perception: (h.perception_changes || []).some((c) => c.node_id === currentNodeId && c.entity_id === entityId),
      alias:      (h.alias_changes      || []).some((c) => c.node_id === currentNodeId && c.entity_id === entityId),
      role:       (h.role_changes       || []).some((c) => c.node_id === currentNodeId && c.entity_id === entityId),
    }
  }

  function handleRevertField(entityId, field) {
    removeRelationshipChange(relId, { type: field, entity_id: entityId }, currentNodeId)
    cancelParticipantDraft(entityId)
  }

  // Participant picker state
  const [showAddParticipant, setShowAddParticipant] = useState(false)
  const [addSearch, setAddSearch] = useState('')
  const [addSelectedIds, setAddSelectedIds] = useState([])

  const participantIds = useMemo(() => new Set(participants.map((p) => p.entity_id)), [participants])

  const filteredForPicker = useMemo(() => {
    const selectedSet = new Set(addSelectedIds)
    const available = allEntitiesList.filter((e) => !participantIds.has(e.id) && !selectedSet.has(e.id))
    if (!addSearch.trim()) return available.slice(0, 20)
    const q = addSearch.toLowerCase()
    return available.filter((e) => e.name?.toLowerCase().includes(q)).slice(0, 20)
  }, [allEntitiesList, participantIds, addSearch, addSelectedIds])

  async function handleRemoveParticipant(entityId) {
    // Unified removeParticipant handles all branches (pair-cancel at join@N,
    // additive leave, etc.). Caller just passes the current chain position
    // and the helper picks the right semantic.
    if (!currentNodeId) return
    // If removing this participant would cascade-delete the relationship
    // (i.e. this is the last potential participant — the only entity with
    // any remaining join event in history), gate behind a confirmation
    // dialog that explains WHY the deletion is happening. Matches the
    // safeguard used by the explicit Delete button.
    const joinEntityIds = new Set(
      (relationship.history?.participant_changes || [])
        .filter((c) => c.action === 'join')
        .map((c) => c.entity_id)
    )
    const isLastParticipant = joinEntityIds.size <= 1 && joinEntityIds.has(entityId)
    if (isLastParticipant) {
      const ok = await confirm({
        title: 'Remove last participant?',
        message: buildRemoveLastParticipantMessage({
          entity: getEntity(entityId),
          rel: relationship,
          getEntity,
        }),
        buttons: [
          { label: 'Remove and delete relationship', value: 'remove', style: 'danger' },
          { label: 'Cancel', value: 'cancel', style: 'default' },
        ],
      })
      if (ok !== 'remove') return
    }
    removeParticipantAction(relId, entityId, currentNodeId)
  }

  function stageAddParticipant(entityId) {
    setAddSelectedIds((ids) => ids.includes(entityId) ? ids : [...ids, entityId])
    setAddSearch('')
  }

  function unstageAddParticipant(entityId) {
    setAddSelectedIds((ids) => ids.filter((id) => id !== entityId))
  }

  function closeAddParticipantPicker() {
    setShowAddParticipant(false)
    setAddSearch('')
    setAddSelectedIds([])
  }

  async function confirmAddParticipants() {
    if (addSelectedIds.length === 0) {
      closeAddParticipantPicker()
      return
    }
    if (currentNodeId) {
      for (const entityId of addSelectedIds) {
        await addParticipantAction(relId, entityId, currentNodeId)
      }
    } else {
      // History-only: no base mirror. If there's no current chain position
      // we can't synthesize join events without a node target, so this branch
      // is effectively unreachable in the history-only model. Leave it as a
      // safe no-op; the currentNodeId branch above is the canonical path.
    }
    closeAddParticipantPicker()
  }

  // Navigation helpers — update both local chainIdx and canvas chip highlight together
  const sparseChainRef   = useRef(sparseChain)
  sparseChainRef.current = sparseChain
  const nodeOrderRef     = useRef(nodeOrder)
  nodeOrderRef.current   = nodeOrder
  // Flag prevents the atNodeId useEffect from fighting back when we drive the change
  const ownNavRef = useRef(false)

  function goTo(newIdx) {
    setOverrideNodeId(null)
    const clamped = Math.max(0, Math.min(newIdx, sparseChain.length - 1))
    setChainIdx(clamped)
    const newNodeId = sparseChain[clamped]
    if (newNodeId) {
      ownNavRef.current = true
      setActiveSelection({ kind: 'relationship', id: relId, atNodeId: newNodeId })
    }
  }

  const canUp = !!currentNodeId
  function goBack() {
    if (overrideNodeId) {
      const no = nodeOrderRef.current
      const nom = new Map(no.map((id, i) => [id, i]))
      const ovOrd = nom.get(overrideNodeId) ?? Infinity
      const sc = sparseChainRef.current
      for (let i = sc.length - 1; i >= 0; i--) {
        if ((nom.get(sc[i]) ?? Infinity) < ovOrd) { goTo(i); return }
      }
    } else if (canBack) { goTo(clampedIdx - 1) }
  }
  function goForward() {
    if (overrideNodeId) {
      const no = nodeOrderRef.current
      const nom = new Map(no.map((id, i) => [id, i]))
      const ovOrd = nom.get(overrideNodeId) ?? Infinity
      const sc = sparseChainRef.current
      for (let i = 0; i < sc.length; i++) {
        if ((nom.get(sc[i]) ?? Infinity) > ovOrd) { goTo(i); return }
      }
    } else if (canForward) { goTo(clampedIdx + 1) }
  }
  function goFirst()   { if (canBack)    goTo(0) }
  function goLast()    { if (canForward) goTo(sparseChain.length - 1) }
  function goUp()      { if (currentNodeId) setDetailPanel('scene', currentNodeId) }

  // When user clicks a different scene's chip on the canvas, sync to it.
  // If the clicked node is not in the sparse chain, set as override instead of snapping.
  const atNodeId_store = activeSelection?.atNodeId
  useEffect(() => {
    if (ownNavRef.current) { ownNavRef.current = false; return }
    if (!atNodeId_store) return
    const sc = sparseChainRef.current
    const exact = sc.indexOf(atNodeId_store)
    if (exact >= 0) { setOverrideNodeId(null); setChainIdx(exact); return }
    setOverrideNodeId(atNodeId_store)
  }, [atNodeId_store])

  // Keyboard navigation — same stale-closure ref pattern as EntityDetailPanel
  const _navRef = useRef(null)
  _navRef.current = { canBack, canForward, canUp, goBack, goForward, goUp }
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp') return
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      // Bail when the keypress originates inside the Timeline Navigator
      // grid (dots and headers carry `data-dot-key`). That surface has its
      // own arrow-key navigation which can't stop this document-level
      // listener via React synthetic preventDefault, so we opt out here
      // to prevent double-handling on ArrowUp (which would fire goUp()
      // and overwrite the navigator's targeted detail panel state).
      if (e.target?.closest?.('[data-dot-key]')) return
      const nav = _navRef.current
      if (e.key === 'ArrowLeft'  && nav.canBack)    { e.preventDefault(); nav.goBack() }
      if (e.key === 'ArrowRight' && nav.canForward) { e.preventDefault(); nav.goForward() }
      if (e.key === 'ArrowUp'    && nav.canUp)      { e.preventDefault(); nav.goUp() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  // Measured avatar row width for dynamic layout computation
  const avatarRowRef = useRef(null)
  const [avatarRowWidth, setAvatarRowWidth] = useState(200)
  useEffect(() => {
    if (!avatarRowRef.current) return
    const observer = new ResizeObserver((entries) => {
      setAvatarRowWidth(Math.floor(entries[0].contentRect.width))
    })
    observer.observe(avatarRowRef.current)
    return () => observer.disconnect()
  }, [])

  // Phase 1.21h Fix #3 — chain-position-aware delete gate. Routes
  // through the shared `getRelationshipCreationNodeId` helper which
  // reads `relationship.creation_anchor_node_id` (1.21h+) or falls
  // back to the legacy heuristic for older saves. Plus the existing
  // phantom-joins escape hatch: when every join's node has been
  // deleted, treat the current node as creation-equivalent so the
  // user can clean up the orphan.
  const isCreationNode = useMemo(() => {
    if (!relationship) return true
    if (!currentNodeId) return true
    const joins = (relationship.history?.participant_changes || []).filter((c) => c.action === 'join')
    if (joins.length === 0) return true
    const allJoinNodeIds = new Set(joins.map((c) => c.node_id))
    const allJoinsPhantom = [...allJoinNodeIds].every((nid) => !storeNodes.some((x) => x.id === nid))
    if (allJoinsPhantom) return true
    return getRelationshipCreationNodeId(relationship, storeNodes, currentNodeId) === currentNodeId
  }, [relationship, currentNodeId, storeNodes])

  // True when the current scene already carries a `deactivate` existence
  // change, i.e. the user previously ended the relationship at this scene.
  // Drives the footer button's label/action toggle: "End relationship here"
  // becomes "Revert end relationship" at the already-ended scene so the
  // user can undo it without a redundant confirm prompt.
  const isDeactivatedAtCurrentNode = useMemo(() => {
    if (!relationship || !currentNodeId) return false
    return (relationship.history?.existence_changes || [])
      .some((c) => c.node_id === currentNodeId && c.action === 'deactivate')
  }, [relationship, currentNodeId])

  async function handleDelete() {
    if (!relationship) return
    if (isCreationNode) {
      const ok = await confirm({
        title: 'Delete relationship',
        message: buildDeleteRelationshipMessage({ rel: relationship, getEntity, resolveName: resolveParticipantName }),
        buttons: [
          { label: 'Delete from story', value: 'delete', style: 'danger' },
          { label: 'Cancel', value: 'cancel', style: 'default' },
        ],
      })
      if (ok === 'delete') deleteObject('relationship', relId)
    } else if (isDeactivatedAtCurrentNode) {
      // Revert: write an `activate` event at this scene. The chain
      // layer's pair-cancel rule (v0.2.1.64) detects the existing
      // deactivate at this node and strips both events, leaving no
      // existence event here — same end state as the previous explicit
      // `removeRelationshipChange` call, but routed through the single
      // canonical write path the End-relationship branch below uses so
      // the UI doesn't need to know about the per-event removal API.
      // Attached-Knowledge cleanup still happens (the pair-cancel path
      // calls `_runEventRemovalCascade` with the stripped event id).
      // No confirm dialog — action is self-evident and reversible.
      recordRelationshipChange(relId, {
        type: 'existence',
        data: { action: 'activate', node_id: currentNodeId },
      })
    } else {
      const ok = await confirm({
        title: 'End relationship',
        message: buildEndRelationshipMessage({
          rel: relationship,
          getEntity,
          endNodeId: currentNodeId,
          nodes: storeNodes,
          entityMap: new Map([
            ...allCharacters, ...allLocations, ...allItems,
            ...allFactions, ...allCustoms, ...allKnowledges,
          ].map((e) => [e.id, e])),
          resolveName: resolveParticipantName,
        }),
        buttons: [
          { label: 'End here', value: 'end', style: 'danger' },
          { label: 'Cancel', value: 'cancel', style: 'default' },
        ],
      })
      if (ok === 'end') {
        recordRelationshipChange(relId, {
          type: 'existence',
          data: { action: 'deactivate', node_id: currentNodeId },
        })
      }
    }
  }

  // Built before the `!relationship` early-return so the hook count is
  // stable across renders. When the user deletes the relationship the
  // panel is briefly mounted with `relationship === undefined` before
  // the parent swaps the active selection — keeping every hook above
  // the early-return is what prevents the "rendered fewer hooks than
  // expected" crash in React 18.
  const entityMap = useMemo(() => {
    const m = new Map()
    for (const bucket of [allCharacters, allLocations, allItems, allFactions, allCustoms]) {
      for (const e of bucket) m.set(e.id, e)
    }
    return m
  }, [allCharacters, allLocations, allItems, allFactions, allCustoms])

  // Phase 3.4f Item 7 — host-side TagBadge click-through to the
  // read-only TagPopover host browser. Pure UI state; never reads or
  // writes any chain-tracked value. Declared BEFORE the `!relationship`
  // early return so deleting the relationship (which re-renders this
  // view with no relationship) cannot skip a hook and trip React's
  // "rendered fewer hooks than expected" teardown (black screen).
  const {
    target: _tagPopoverTarget,
    open: _openTagPopover,
    close: _closeTagPopover,
  } = useTagBrowsePopover()

  if (!relationship) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 p-4 text-zinc-600 text-xs italic">
        Relationship not found.
      </div>
    )
  }

  const isAtOriginNode = currentNode?.type === 'relationshipOriginNode'
  const isAtEntityNode = currentNode?.type === 'entityNode'
  // Faction-membership rels are anchored to the faction's origin
  // EntityNode (no separate `relationshipOriginNode`). The previous
  // two-branch render fell through to the SCENE branch and produced
  // "SCENE : SCENE" because EntityNode has no `data.title`. The
  // third branch below uses the shared `<NodeBadge>` so the rendered
  // pill matches the canonical entity-origin treatment ("NEW : FACTION
  // [name]") elsewhere in the app.
  const sceneContextBadge = currentNodeId ? (
    isAtEntityNode ? (
      <NodeBadge
        nodeId={currentNodeId}
        nodes={storeNodes}
        entityMap={entityMap}
        onClick={(nid) => focusNode?.(nid)}
      />
    ) : (
      <button
        onClick={() => focusNode?.(currentNodeId)}
        className="flex items-center min-w-0 text-left hover:opacity-80"
        title={isAtOriginNode ? "Centre canvas on the relationship origin node" : "Centre canvas on this scene"}
      >
        {isAtOriginNode ? (
          <span className="flex items-center gap-1 bg-violet-900/30 px-1.5 py-0.5 rounded min-w-0">
            <span className="text-[9px] text-violet-400 uppercase tracking-widest font-semibold flex-shrink-0">NEW</span>
            <span className="text-[9px] text-zinc-100 uppercase tracking-widest font-semibold truncate">: RELATIONSHIP</span>
          </span>
        ) : (
          <span className="flex items-center gap-1 bg-purple-900/30 px-1.5 py-0.5 rounded min-w-0">
            <span className="text-[9px] text-purple-400 uppercase tracking-widest font-semibold flex-shrink-0">SCENE</span>
            <span className="text-[9px] text-zinc-100 uppercase tracking-widest font-semibold truncate">: {currentNode?.data?.title || 'Scene'}</span>
          </span>
        )}
      </button>
    )
  ) : (
    <span className="text-[9px] text-violet-400 uppercase tracking-widest font-semibold bg-violet-900/30 px-1.5 py-0.5 rounded">
      RELATIONSHIP
    </span>
  )

  return (
    <>
    <DetailPanelShell
      navBar={(
      <DetailPanelNavBar
        contextBadge={sceneContextBadge}
        chapterLabel={chapterLabel}
        canUp={canUp}
        onUp={goUp}
        upTitle="Go to parent scene"
        canBack={canBack}
        onBack={goBack}
        onFirst={goFirst}
        canForward={canForward}
        onForward={goForward}
        onLast={goLast}
        position={overrideNodeId ? (currentNode?.data?.title || 'Scene') : clampedIdx >= 0 ? `${clampedIdx + 1} / ${sparseChain.length}` : '—'}
        onFocus={currentNodeId ? () => focusNode?.(currentNodeId) : null}
        leftSlot={(
          <PovNavToggleButton
            hasAnyPov={hasAnyPov}
            povNavOnly={povNavOnly}
            onToggle={() => {
              // If toggling ON and current node will not survive the
              // filter, jump to the relationship's creation anchor first
              // (always allowed when toggle is on). Avoids the auto-flip-
              // off effect from immediately reverting the toggle.
              if (!povNavOnly && hasAnyPov) {
                const inSet = sparseChain.includes(currentNodeId)
                if (!inSet) {
                  const originId = getRelationshipCreationNodeId(relationship, storeNodes, null)
                  if (originId) {
                    const idx = sparseChain.indexOf(originId)
                    if (idx >= 0) { setOverrideNodeId(null); setChainIdx(idx) }
                    else { setOverrideNodeId(originId) }
                  }
                }
              }
              setPovNavOnly(!povNavOnly)
            }}
            povColor={povColor}
          />
        )}
        cornerSlot={relationship ? (
          <ShowInTocButton
            type="relationship"
            id={relationship.id}
            accentColour={relationship.colour || '#a78bfa'}
            typeLabel="relationship"
            size="sm"
          />
        ) : null}
      />
      )}
      header={(() => {
        // Use `nameVal` (draft-aware) so the header reflects an
        // in-progress name edit even after the input loses focus —
        // exiting edit mode just hides the <input> and falls back to
        // the read-only <button>; the value stays in `_panelDraft`
        // until the panel-level Save bar commits it. Pre-fix the
        // button read baseline `effectiveState.name`, which made the
        // draft look lost between blur and Save.
        const relName       = nameVal || ''
        const fallbackLabel = participantsFallbackLabel(participants, getEntity, Infinity, relationship, resolveParticipantName)
        const relNameLen    = (relName || fallbackLabel).length
        const useIcon       = relNameLen > 16
        const squash        = !useIcon && relNameLen > 10
        const compactIcon = <RelationshipIcon size={12} />
        const nameSlot = editingName ? (
          <input
            ref={nameInputRef}
            autoFocus
            className="text-sm font-medium leading-tight w-36 bg-transparent border-b border-zinc-600 focus:outline-none focus:border-violet-400 text-zinc-200"
            value={nameVal}
            onChange={(e) => setNameVal(e.target.value)}
            onBlur={commitNameEdit}
            onKeyDown={(e) => { if (e.key === 'Enter') commitNameEdit(); if (e.key === 'Escape') setEditingName(false) }}
            placeholder="name…"
          />
        ) : (
          <button
            onClick={startEditName}
            className="text-sm font-medium leading-tight text-left min-w-0 text-zinc-300 hover:text-zinc-100 cursor-text truncate"
            title={relName || fallbackLabel || 'click to name…'}
          >
            {relName ? (
              <span className="text-sm truncate">{relName}</span>
            ) : fallbackLabel ? (
              <span className="text-sm truncate text-zinc-400 italic font-normal">
                <ParticipantsFallbackLabel
                  participants={participants}
                  getEntity={getEntity}
                  rel={relationship}
                  resolveName={resolveParticipantName}
                />
              </span>
            ) : (
              <span className="text-sm truncate text-zinc-600 italic font-normal">click to name…</span>
            )}
          </button>
        )
        // Row 1.5 subtitle: only when a custom name is set (without a name,
        // Row 1 IS the participant synthesis — a duplicate would be redundant).
        const subtitleSlot = relName ? (
          <span className="truncate text-zinc-500 italic max-w-full" style={{ fontSize: 9 }}>
            <ParticipantsFallbackLabel
              participants={participants}
              getEntity={getEntity}
              rel={relationship}
              resolveName={resolveParticipantName}
            />
          </span>
        ) : null
        const row2Slot = (() => {
          const n = participants.length
          const W = avatarRowWidth
          const H = 48
          const G = 4
          const MAX_SIZE = 48
          const MIN_SIZE = 8

          // hSize(R): max image size so that R rows fit in height H
          const hSize = (R) => Math.floor((H - (R - 1) * G) / R)
          // wSize(R): image size so that all N images fit in width W across R rows
          const wSize = (R) => {
            if (n <= 1) return MAX_SIZE
            const perRow = Math.ceil(n / R)
            return Math.floor((W - (perRow - 1) * G) / perRow)
          }

          // Cascade: stay in R rows, shrinking, until size drops to hSize(R+1).
          // Only then add the next row. Image size never jumps up.
          let rows = 1, avatarSize = MAX_SIZE
          if (n > 0) {
            for (let R = 1; ; R++) {
              const sz = Math.min(hSize(R), wSize(R), MAX_SIZE)
              const nextThreshold = hSize(R + 1)
              if (sz > nextThreshold || nextThreshold < MIN_SIZE) {
                rows = R
                avatarSize = Math.max(MIN_SIZE, sz)
                break
              }
              // size has reached the next-row threshold — add a row and continue
            }
          }

          return (
            <div
              ref={avatarRowRef}
              className={`flex w-full justify-center ${rows > 1 ? 'flex-wrap content-center' : 'items-center'}`}
              style={{ gap: G, height: H }}
            >
              {n === 0 ? (
                <span
                  className="rounded flex items-center justify-center flex-shrink-0 text-base text-zinc-600"
                  style={{ width: MAX_SIZE, height: MAX_SIZE, border: `1.5px solid ${REL_COLOUR}44`, backgroundColor: REL_COLOUR + '11' }}
                >
                  <RelationshipArrow size="55%" strokeWidth={1.6} />
                </span>
              ) : (
                participants.map((p) => {
                  const eff = resolveParticipantEffective(p.entity_id)
                  return (
                  <button
                    key={p.entity_id}
                    type="button"
                    onClick={() => {
                      const { nodes: allNodes, edges: allEdges } = useProjectStore.getState()
                      const targetChain = getEntityNarrativeChain(p.entity_id, allNodes, allEdges)
                      const idx = targetChain.findIndex((n) => n.id === currentNodeId)
                      openEntityAtRelationshipsTab(p.entity_id, currentNodeId, idx)
                    }}
                    className="p-0 bg-transparent border-0 inline-flex hover:opacity-75 focus:outline-none transition-opacity"
                    title={`View ${eff?.name || 'entity'}'s relationships`}
                  >
                    <ParticipantAvatar
                      entity={eff?.entity}
                      displayName={eff?.name || ''}
                      displayColour={eff?.colour}
                      displayImageRef={eff?.profile_image_ref}
                      size={avatarSize}
                    />
                  </button>
                  )
                })
              )}
            </div>
          )
        })()
        // Phase 2.7a/b — "Add as context" affordance. The current chain
        // node id IS the anchor regardless of position: index 0 (origin)
        // is the relationship's establishment node id, downstream
        // positions are the chain stop ids. Same walker, same routing.
        const atRelOrigin = clampedIdx === 0
        return (
          <DetailPanelIdentityHeader
            typeLabel="relationship"
            typeColourClass="text-violet-400"
            typeIcon={compactIcon}
            useCompactIcon={useIcon}
            letterSpacing={squash ? '-0.03em' : '0.25em'}
            nameSlot={nameSlot}
            subtitleSlot={subtitleSlot}
            row2Slot={row2Slot}
            cornerAction={
              <AttachToChatButton
                kind="relationship"
                id={relationship.id}
                anchorNodeId={currentNodeId}
                title={atRelOrigin
                  ? 'Add this relationship at its origin as context to the open conversation'
                  : 'Add this relationship at this scene as context to the open conversation'}
              />
            }
          />
        )
      })()}
      subTabs={(
        <div data-help-region="detail-relationship:subtabs" className="contents">
          <DetailPanelSubTabs
            tabs={['details', 'hierarchy', 'awareness']}
            active={subTab}
            onChange={setSubTab}
          />
        </div>
      )}
      bodyPadding="px-2 py-2"
      body={(<>

        {subTab === 'details' && (
          <div className="space-y-2" data-help-region="detail-relationship:details_body">
            <div data-help-region="detail-relationship:details_description" className="contents">
              <DescriptionEditor
                value={descVal}
                onChange={(val) => setDescVal(val)}
                onBlur={commitDescEdit}
                placeholder="Describe this relationship…"
                rows={3}
              />
            </div>

            {/* Phase 3.4f Item 4 — Relationship Project Tag picker.
                Routes through the panel draft (same Save / Discard
                bar as name + description) so tag changes can be
                rolled back by Discard. Save handler diffs the draft
                tag set against `_effectiveTagIds` and emits per-diff
                `recordRelationshipTagChange` calls; the store
                action's `getRelationshipCreationNodeId` check
                handles baseline-at-origin vs chain-event-at-anchor.
                `baselineTagIds` follows the dashed-border draft-
                state rule: at the relationship's creation anchor
                while dirty, the prospective baseline IS
                `draft.tag_ids`; elsewhere it's the saved
                `relationship.tag_ids`. */}
            <div data-help-region="detail-relationship:details_tags">
              <label className="text-[10px] text-zinc-500 uppercase tracking-wider block mb-1">Tags</label>
              <ProjectTagPicker
                currentTagIds={draftTagIds}
                baselineTagIds={
                  isAtRelOrigin
                    ? (isPanelDirty && Array.isArray(_panelDraft?.tag_ids)
                        ? _panelDraft.tag_ids
                        : (relationship?.tag_ids || []))
                    : (relationship?.tag_ids || [])
                }
                onAdd={(tagId) => addDraftTagId(tagId)}
                onRemove={(tagId) => removeDraftTagId(tagId)}
                onTagClick={_openTagPopover}
              />
            </div>

            <div data-help-region="detail-relationship:details_participants">
              <div className="text-[9px] text-zinc-600 uppercase tracking-wider mb-1">
                Participants ({participants.length})
              </div>
              {participants.length === 0 && !showAddParticipant && (
                <p className="text-xs text-zinc-600 italic mb-1">No participants yet.</p>
              )}
              {participants.map((p) => {
                const eff = resolveParticipantEffective(p.entity_id)
                return (
                <ParticipantRow
                  key={p.entity_id}
                  participant={p}
                  role={participantRoles[p.entity_id]}
                  entity={eff?.entity || getEntity(p.entity_id)}
                  displayName={eff?.name || ''}
                  displayColour={eff?.colour}
                  displayImageRef={eff?.profile_image_ref}
                  displayAliases={eff?.aliases || []}
                  isExpanded={expandedParticipantId === p.entity_id}
                  onToggle={() => toggleParticipant(p.entity_id)}
                  draft={participantDrafts[p.entity_id] || null}
                  isDirty={participantDraftIsDirty(p.entity_id)}
                  onDraftChange={(field, val) => updateParticipantDraft(p.entity_id, field, val)}
                  onSave={() => saveParticipantDraft(p.entity_id)}
                  onCancel={() => cancelParticipantDraft(p.entity_id)}
                  fieldOverrides={getParticipantFieldOverrides(p.entity_id)}
                  onRevert={(field) => handleRevertField(p.entity_id, field)}
                  onRemove={() => handleRemoveParticipant(p.entity_id)}
                  onNavigate={() => {
                    const { nodes: allNodes, edges: allEdges } = useProjectStore.getState()
                    const targetChain = getEntityNarrativeChain(p.entity_id, allNodes, allEdges)
                    const idx = targetChain.findIndex((n) => n.id === currentNodeId)
                    openEntityAtRelationshipsTab(p.entity_id, currentNodeId, idx)
                  }}
                />
                )
              })}

              {/* Add participant picker */}
              <div className="mt-1">
                {!showAddParticipant ? (
                  <button
                    data-help-region="detail-relationship:details_add_participant"
                    className="w-full text-[9px] text-accent-400/70 hover:text-accent-300 py-1 border border-dashed border-zinc-700 hover:border-zinc-500 rounded transition-colors"
                    onClick={() => setShowAddParticipant(true)}
                  >
                    + Add Participant
                  </button>
                ) : (
                  <div className="border border-zinc-700 rounded p-1.5 space-y-1">
                    <input
                      autoFocus
                      value={addSearch}
                      onChange={(e) => setAddSearch(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') closeAddParticipantPicker()
                        if (e.key === 'Enter') confirmAddParticipants()
                      }}
                      placeholder="Search entities…"
                      className="w-full bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-[10px] text-zinc-200 focus:outline-none focus:border-zinc-500"
                    />
                    {addSelectedIds.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {addSelectedIds.map((id) => {
                          const sel = getEntity(id)
                          if (!sel) return null
                          const colour = sel.colour || '#888'
                          return (
                            <span
                              key={id}
                              className="inline-flex items-center gap-1 px-1.5 py-0 rounded text-[10px] bg-zinc-800"
                              style={{ border: `1px solid ${colour}` }}
                            >
                              <span className="text-zinc-200">{sel.name}</span>
                              <button
                                className="text-zinc-500 hover:text-red-400"
                                onClick={() => unstageAddParticipant(id)}
                                title="Remove from selection"
                              >×</button>
                            </span>
                          )
                        })}
                      </div>
                    )}
                    {filteredForPicker.length > 0 ? (
                      <div className="max-h-28 overflow-y-auto space-y-0.5">
                        {filteredForPicker.map((e) => (
                          <button
                            key={e.id}
                            onClick={() => stageAddParticipant(e.id)}
                            className="w-full flex items-center gap-1.5 px-1 py-0.5 rounded hover:bg-zinc-700 text-left"
                          >
                            <span className="rounded flex-shrink-0 flex items-center justify-center text-[8px]"
                              style={{ width: 12, height: 12, backgroundColor: (e.colour || '#888') + '22', border: `1px solid ${e.colour || '#888'}` }}>
                              {TYPE_ICONS[e.type] || '★'}
                            </span>
                            <span className="text-[10px] text-zinc-300 truncate">{e.name}</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="text-[9px] text-zinc-600 italic px-1">No matching entities</p>
                    )}
                    <div className="flex items-center justify-end gap-1.5 pt-0.5">
                      <button
                        className="text-[10px] px-2 py-0.5 rounded border border-zinc-600 bg-zinc-800 text-zinc-300 hover:border-zinc-400 hover:bg-zinc-700 transition-colors"
                        onClick={closeAddParticipantPicker}
                      >Cancel</button>
                      <button
                        disabled={addSelectedIds.length === 0}
                        className="text-[10px] px-2 py-0.5 rounded border bg-accent-700 hover:bg-accent-600 text-white border-accent-600 transition-colors disabled:bg-zinc-800 disabled:text-zinc-600 disabled:border-zinc-700 disabled:cursor-not-allowed"
                        onClick={confirmAddParticipants}
                      >Confirm ({addSelectedIds.length})</button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {changesAtNode.length > 0 && (
              <div>
                <div className="text-[9px] text-zinc-600 uppercase tracking-wider mb-1">
                  {currentNode?.type === 'relationshipOriginNode' ? 'Additions at this point' : 'Changes at this scene'}
                </div>
                <div className="flex flex-col gap-0.5">
                  {changesAtNode.map((ch, i) => (
                    <RelChangeChip key={i} change={ch} getEntity={getEntity} onDismiss={() => removeRelationshipChange(relId, ch, currentNodeId)} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {subTab === 'hierarchy' && (() => {
          // Phase 1.26a Stage 2 — three-state toggle (Disabled / By participant
          // / By role) + roles-mode rendering (read-only). In-tree role
          // reassignment ships in Stage 3.
          const effectiveHierarchy = effectiveState?.hierarchy ?? relationship?.hierarchy ?? null
          const isEnabled = !!(effectiveHierarchy?.enabled)
          const currentMode = effectiveHierarchy?.mode === 'roles' ? 'roles' : 'participants'
          const rawRoots = effectiveHierarchy?.roots || []
          const participantIds = participants.map((p) => p.entity_id)
          const participantRoles = effectiveState?.participant_roles || relationship?.participant_roles || {}

          // ── Derived view roots — depends on current mode ─────────────────
          let displayRoots
          let unassignedIds = []
          if (currentMode === 'roles') {
            // Roles-mode tree contains role-value strings. Auto-include any
            // role-value present in participant_roles but not yet in the
            // tree; auto-prune any role-value no longer assigned to any
            // participant.
            const allRoleValues = new Set()
            for (const eid of participantIds) {
              const v = participantRoles[eid]?.value
              if (v) allRoleValues.add(v)
            }
            displayRoots = autoPruneMissing(cloneRoots(rawRoots), allRoleValues)
            displayRoots = autoIncludeMissing(displayRoots, [...allRoleValues])
            // Unassigned pool: participants with no role.
            unassignedIds = participantIds.filter((eid) => !participantRoles[eid]?.value)
          } else {
            // Participants-mode tree contains entity_ids.
            displayRoots = autoPruneMissing(cloneRoots(rawRoots), participantIds)
            displayRoots = autoIncludeMissing(displayRoots, participantIds)
          }

          function applyHierarchy(newConfig) {
            setRelationshipHierarchy(relId, newConfig, currentNodeId)
          }
          function handleSetMode(nextMode) {
            // nextMode is 'disabled' | 'participants' | 'roles'.
            if (nextMode === 'disabled') {
              // Hide-but-preserve: keep current roots/mode, just disable.
              applyHierarchy({ enabled: false, mode: currentMode, roots: rawRoots })
              return
            }
            // Switching from disabled → enabled, or between modes.
            if (!isEnabled) {
              applyHierarchy({ enabled: true, mode: nextMode, roots: displayRoots })
              return
            }
            if (nextMode === currentMode) return
            // Convert tree between modes.
            let convertedRoots
            if (nextMode === 'roles') {
              // participants → roles
              convertedRoots = participantsToRoles(displayRoots, participantRoles)
            } else {
              // roles → participants
              convertedRoots = rolesToParticipants(displayRoots, participantRoles)
            }
            applyHierarchy({ enabled: true, mode: nextMode, roots: convertedRoots })
          }
          function handleReparent(nodeId, newParentId) {
            const nextRoots = reparentNode(displayRoots, nodeId, newParentId)
            applyHierarchy({ enabled: true, mode: currentMode, roots: nextRoots })
          }

          // Three-state segmented control selector.
          const selectedState = !isEnabled ? 'disabled' : (currentMode === 'roles' ? 'roles' : 'participants')

          return (
            <div className="space-y-3" data-help-region="detail-relationship:hierarchy_body">
              {/* Mode segmented control */}
              <div data-help-region="detail-relationship:hierarchy_mode">
                <div className="text-[10px] text-zinc-300 font-medium mb-0.5">Hierarchy</div>
                <div className="text-[9px] text-zinc-600 mb-1.5 leading-snug">
                  Marks this as a structural parent/child relationship. By participant arranges entities directly; by role arranges role values, with each role's members listed inline.
                </div>
                <div className="grid grid-cols-3 gap-0.5 bg-zinc-800 border border-zinc-700 rounded p-0.5">
                  {[
                    { key: 'disabled', label: 'Disabled' },
                    { key: 'participants', label: 'By Participant' },
                    { key: 'roles', label: 'By Role' },
                  ].map((opt) => {
                    const isSel = selectedState === opt.key
                    return (
                      <button
                        key={opt.key}
                        type="button"
                        onClick={() => handleSetMode(opt.key)}
                        className={`text-[10px] py-1 rounded transition-colors ${
                          isSel
                            ? 'bg-accent-500 text-white'
                            : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50'
                        }`}
                      >
                        {opt.label}
                      </button>
                    )
                  })}
                </div>
              </div>

              {isEnabled && participants.length === 0 && (
                <p className="text-[10px] text-zinc-600 italic">Add participants in the Details tab first.</p>
              )}

              {isEnabled && participants.length > 0 && currentMode === 'participants' && (
                <RelationshipHierarchyTree
                  roots={displayRoots}
                  mode="participants"
                  getLabel={(id) => resolveParticipantEffective(id)?.name || id}
                  getColour={(id) => resolveParticipantEffective(id)?.colour || '#888888'}
                  getTypeIconKey={(id) => getEntity(id)?.type || null}
                  onReparent={handleReparent}
                />
              )}

              {isEnabled && participants.length > 0 && currentMode === 'roles' && (() => {
                // Chain-aware entity-pill renderer. Reads each participant's
                // effective state at currentNodeId (so profile_image, colour,
                // and name reflect any chain modifiers applied between the
                // entity's origin and this anchor — NOT the entity's
                // baseline). Pills are draggable so the writer can move a
                // participant between roles or in/out of Unassigned via the
                // tree's drop targets.
                const renderEntityPill = (eid, sizeClass = 'text-[9px]') => {
                  const ent = getEntity(eid)
                  if (!ent) {
                    return (
                      <span key={eid} className={`inline-flex items-center gap-1 px-1 py-0.5 rounded ${sizeClass}`}>
                        <span className="text-zinc-500">{eid}</span>
                      </span>
                    )
                  }
                  const eff = computeEffectiveState(ent, storeNodes, storeEdges, currentNodeId) || {}
                  const colour = eff.colour || ent.colour || '#888888'
                  const name = eff.name || ent.name || eid
                  const imgRef = eff.profile_image_ref ?? ent.profile_image_ref ?? null
                  const assetName = imgRef && imgRef !== '' ? imgRef.replace(/^assets\//, '') : null
                  return (
                    <span
                      key={eid}
                      className={`inline-flex items-center gap-1 px-1 py-0.5 rounded cursor-grab active:cursor-grabbing ${sizeClass}`}
                      style={{ backgroundColor: colour + '22', border: `1px solid ${colour}` }}
                      draggable
                      title="Click to view in Details. Drag to reassign role."
                      onDragStart={(e) => {
                        e.dataTransfer.setData('application/nnz-rel-pill-entityid', eid)
                        e.dataTransfer.effectAllowed = 'move'
                        e.stopPropagation()
                      }}
                      onClick={(e) => {
                        // Click (not drag) opens this participant's section
                        // in the Details tab, expanded. Route through
                        // `toggleParticipant` so the per-participant draft
                        // state gets initialised (otherwise the expanded
                        // section's inputs render with no draft to read,
                        // appearing empty). Skip the toggle if the same
                        // participant is already expanded — clicking the
                        // pill twice shouldn't accidentally collapse.
                        // Chain anchor (currentNodeId) is unchanged.
                        e.stopPropagation()
                        setSubTab('details')
                        if (expandedParticipantId !== eid) {
                          toggleParticipant(eid)
                        }
                      }}
                    >
                      {assetName ? (
                        <img
                          src={`/api/project/assets/${assetName}`}
                          alt=""
                          className="w-3.5 h-3.5 rounded-sm object-cover flex-shrink-0 pointer-events-none"
                          style={{ border: `1px solid ${colour}` }}
                        />
                      ) : (
                        <span className="inline-flex items-center justify-center text-[7px] pointer-events-none">
                          {TYPE_ICONS[ent.type] || '★'}
                        </span>
                      )}
                      <span className="text-zinc-200 truncate max-w-[80px] pointer-events-none">{name}</span>
                    </span>
                  )
                }

                // Drop a pill on a role-tree node → reassign the entity's
                // role to that role-value. Routes through `setParticipantRole`
                // which is anchor-aware (writes baseline at the rel's
                // creation anchor; appends a `role_changes` history entry
                // at any other chain anchor).
                const handleMemberDrop = (entityId, targetRoleValue) => {
                  if (!entityId || !targetRoleValue) return
                  const currentRole = participantRoles[entityId]?.value || null
                  if (currentRole === targetRoleValue) return  // no-op
                  // setParticipantRole expects a ParticipantRole object
                  // ({value, preset_list_id?}), not a bare string. A bare
                  // string would silently route to the role-clear branch
                  // (its `.value` is undefined) and dump the entity into
                  // Unassigned instead of reassigning.
                  setParticipantRole(relId, entityId, { value: targetRoleValue }, currentNodeId)
                }

                // Drop a pill on the Unassigned pool → clear the entity's role.
                const handleUnassignedDrop = (e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  const entityId = e.dataTransfer.getData('application/nnz-rel-pill-entityid')
                  if (!entityId) return
                  const currentRole = participantRoles[entityId]?.value || null
                  if (!currentRole) return  // already unassigned
                  setParticipantRole(relId, entityId, null, currentNodeId)
                }

                // Delete a role node from the hierarchy. Confirms if the
                // role has members; on confirm, clears each member's role
                // (sends them back to Unassigned) and removes the role
                // node from the tree. Each setParticipantRole + final
                // setRelationshipHierarchy is a separate snapshot (so
                // multiple undo steps); single-undo bundling is a polish
                // follow-up if needed.
                const handleDeleteRoleNode = async (roleValue) => {
                  const memberIds = participantIds.filter((eid) => participantRoles[eid]?.value === roleValue)
                  if (memberIds.length > 0) {
                    const ok = await confirm({
                      title: 'Remove role from hierarchy',
                      message: `"${roleValue}" has ${memberIds.length} member${memberIds.length === 1 ? '' : 's'}. Removing the role from the hierarchy will send ${memberIds.length === 1 ? 'them' : 'them all'} to the Unassigned pool. Continue?`,
                      buttons: [
                        { label: 'Remove role', value: 'remove', style: 'danger' },
                        { label: 'Cancel', value: 'cancel', style: 'default' },
                      ],
                    })
                    if (ok !== 'remove') return
                  }
                  // Clear each member's role — chain-aware writes via setParticipantRole.
                  for (const eid of memberIds) {
                    await setParticipantRole(relId, eid, null, currentNodeId)
                  }
                  // Remove the role node from the tree.
                  const nextRoots = removeNode(displayRoots, roleValue)
                  applyHierarchy({ enabled: true, mode: 'roles', roots: nextRoots })
                }

                return (
                  <>
                    {/* Unassigned pool — participants with no role. Pinned
                        to top, NOT a hierarchy node. Also a drop target:
                        dragging a member pill into it clears that
                        entity's role. */}
                    <div>
                      <div className="text-[9px] text-zinc-600 uppercase tracking-wider mb-1">Unassigned</div>
                      <div
                        className="flex flex-wrap gap-1 p-1.5 bg-zinc-800/40 border border-zinc-700/40 rounded min-h-[28px]"
                        onDragOver={(e) => {
                          const types = e.dataTransfer.types
                          const isPillDrag = types.includes ? types.includes('application/nnz-rel-pill-entityid') : Array.from(types).includes('application/nnz-rel-pill-entityid')
                          if (isPillDrag) {
                            e.preventDefault()
                            e.stopPropagation()
                          }
                        }}
                        onDrop={handleUnassignedDrop}
                      >
                        {unassignedIds.length > 0
                          ? unassignedIds.map((eid) => renderEntityPill(eid, 'text-[10px]'))
                          : <span className="text-[9px] text-zinc-600 italic">Drop a member here to clear its role</span>
                        }
                      </div>
                    </div>

                    {/* Roles tree — each node is a role-value, with member
                        chips listed inside each role's visual block. */}
                    <RelationshipHierarchyTree
                      roots={displayRoots}
                      mode="roles"
                      getLabel={(roleValue) => roleValue}
                      getColour={() => '#a78bfa'  /* violet for role nodes */}
                      getTypeIconKey={() => null}
                      renderInlineMembers={(roleValue) => {
                        const memberIds = participantIds.filter((eid) => participantRoles[eid]?.value === roleValue)
                        if (memberIds.length === 0) {
                          return <span className="text-[9px] text-zinc-600 italic">No members — drag a participant here</span>
                        }
                        return (
                          <div className="flex flex-wrap gap-1">
                            {memberIds.map((eid) => renderEntityPill(eid))}
                          </div>
                        )
                      }}
                      onReparent={handleReparent}
                      onMemberDrop={handleMemberDrop}
                      onDeleteNode={handleDeleteRoleNode}
                    />
                  </>
                )
              })()}
            </div>
          )
        })()}

        {subTab === 'awareness' && (
          <div className="space-y-2" data-help-region="detail-relationship:awareness_body">
            {/* Known By — mirrors the entity Awareness tab pattern.
                Owns its own collapsible header (label + tracking
                toggle + chevron + Precision row in body). */}
            <div data-help-region="detail-relationship:awareness_known_by" className="contents">
              <RelationshipKnownBySection
                relationship={relationship}
                anchorNodeId={currentNodeId}
                isExpanded={knownByExpanded}
                onToggleExpand={() => setKnownByExpanded(!knownByExpanded)}
              />
            </div>
            {/* Aware Of — same component as the entity panel; the
                relationship just supplies a source-matcher so the
                iteration finds surfaces where THIS relationship is
                registered as an awareness source instead of the
                default observer-as-entries-key match. */}
            <div className="border-t border-zinc-700/50 mt-3 pt-3" data-help-region="detail-relationship:awareness_aware_of">
              <AwareOfSection
                nodeId={currentNodeId}
                matcher={makeSourceMatcher('relationship', relId)}
                subjectLabel={relationship?.name?.trim() || 'this relationship'}
                skipRelationshipId={relId}
              />
            </div>
          </div>
        )}

      </>)}
      footer={(<>
        {/* Chain-position-aware delete (always rendered above the save
            bar). Hidden for membership relationships — their lifecycle
            is owned by the faction entity itself and they cannot be
            deleted directly. */}
        {!relationship?.membership_of && (
          <div className="border-t border-zinc-700 p-2 flex-shrink-0">
            <button
              data-help-region="detail-relationship:existence_toggle"
              className="w-full px-2 py-1.5 text-xs rounded border border-red-900/40 text-red-400/70 hover:bg-red-900/20 hover:text-red-400 transition-colors"
              onClick={handleDelete}
            >
              {isCreationNode
                ? 'Delete relationship'
                : isDeactivatedAtCurrentNode
                  ? 'Revert end relationship'
                  : 'End relationship here'}
            </button>
          </div>
        )}
        {/* Panel-level draft Save / Discard bar (shared shell-draft hook).
            Renders BELOW the bottom-most footer button — matching the
            Entity panel's footer order so the save bar is always in the
            same place regardless of which detail panel is showing. */}
        <DraftSaveBar isDirty={isPanelDirty} onSave={_relDraftHandle.save} onDiscard={_relDraftHandle.discard} />
      </>)}
    />
    <TagPopover
      key={_tagPopoverTarget?.tag?.id || 'closed'}
      isOpen={!!_tagPopoverTarget}
      onClose={_closeTagPopover}
      mode="project"
      tag={_tagPopoverTarget?.tag}
      anchor={_tagPopoverTarget?.anchor}
      anchorEl={_tagPopoverTarget?.anchorEl}
      readOnly
    />
    </>
  )
}
