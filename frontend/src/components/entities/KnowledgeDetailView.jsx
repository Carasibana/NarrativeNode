import { useMemo, useState, useRef, useEffect, useCallback } from 'react'
import { useUiStore } from '../../store/uiStore'
import { useProjectStore } from '../../store/projectStore'
import { useEntitiesStore } from '../../store/entitiesStore'
import { useStoryOrder } from '../../hooks/useStoryOrder'
import {
  computeKnowledgeEffectiveState,
  getKnowledgeNodeOrder,
} from '../../utils/narrativeChain'
import { resolveChapterIdForNode } from '../../utils/chapterMembership'
import { useChapterMemberOpts } from '../../hooks/useChapterMemberOpts'
import { computePovChain } from '../../utils/povSequence'
import { usePovColor } from '../../utils/povConstants'
import PovNavToggleButton from '../ui/PovNavToggleButton'
import DetailPanelNavBar from '../ui/DetailPanelNavBar'
import DetailPanelIdentityHeader from '../ui/DetailPanelIdentityHeader'
import AttachToChatButton from '../chat/AttachToChatButton'
import DetailPanelShell from '../ui/DetailPanelShell'
import DraftSaveBar from '../ui/DraftSaveBar'
import { useDetailPanelDraft } from '../../hooks/useDetailPanelDraft'
import DescriptionEditor from '../ui/DescriptionEditor'
import ShowInTocButton from '../ui/ShowInTocButton'
import DetailPanelSubTabs from '../ui/DetailPanelSubTabs'
import NotesFooterButton from '../ui/NotesFooterButton'
import { KnowledgeIcon, KNOWLEDGE_COLOUR, EventBadge } from '../ui/IdentityBadges'
import { resolveEventBadgePropsFromSourceEvent, resolveKnowledgeSourceEventAt } from '../../utils/sourceEventBuilder'
import ProfileImageUpload from './ProfileImageUpload'
import { useProfileImageDropTarget } from '../../hooks/useProfileImageDropTarget'
import EntityColorPicker from '../ui/EntityColorPicker'
import AwarenessPicker from './AwarenessPicker'
import { SCALE_ALIAS, SCALE_BINARY, AwarenessBadge } from '../ui/AwarenessBadges'
import ChangeSubChip from '../ui/change-subchips/ChangeSubChip'
import ProjectTagPicker from '../tags/ProjectTagPicker'
import TagPopover from '../tags/TagPopover'
import { useTagBrowsePopover } from '../tags/useTagBrowsePopover'
import AwarenessSubChip from '../ui/change-subchips/AwarenessSubChip'
import { knowledgeContentChangeToSubChip } from '../ui/change-subchips/knowledgeChangeAdapter'
import { ChangeBadge } from './SharedEntityComponents'
import ChangesAtThisPointSection from '../ui/ChangesAtThisPointSection'

// Lookup of (field, store key) so fields and their history arrays stay in sync.
const CONTENT_FIELD_TO_LIST_KEY = {
  name: 'name_changes',
  description: 'description_changes',
  colour: 'colour_changes',
}

function isHistoryEntryAt(history, listKey, nodeId) {
  if (!history || !nodeId) return false
  return (history[listKey] || []).some((c) => c.node_id === nodeId)
}

/** "Changes at this point" wrapper for the Knowledge view.
 *
 *  Knowledge-specific data builder around the Layer-2
 *  `<ChangesAtThisPointSection>` primitive. Only rendered when chain
 *  nav is at a non-origin position. Walks `Knowledge.history.*_changes`
 *  for entries at the current chain anchor and hands the pre-rendered
 *  rows (Content + Awareness groups) to the layout primitive. */
function KnowledgeChangesAtPointSection({ knowledge, atNodeId, priorEffective, displayColour }) {
  const characters = useEntitiesStore((s) => s.characters)
  const locations  = useEntitiesStore((s) => s.locations)
  const items      = useEntitiesStore((s) => s.items)
  const factions   = useEntitiesStore((s) => s.factions)
  const customs    = useEntitiesStore((s) => s.customs)

  const removeKnowledgeContentChangeAtNode   = useProjectStore((s) => s.removeKnowledgeContentChangeAtNode)

  const allEntities = useMemo(
    () => [...characters, ...locations, ...items, ...factions, ...customs],
    [characters, locations, items, factions, customs],
  )
  const getEntity = useCallback(
    (eid) => allEntities.find((e) => e.id === eid) || null,
    [allEntities],
  )

  const buckets = useMemo(() => {
    const h = knowledge?.history
    if (!h || !atNodeId) return null
    // Awareness chain entries live on the canonical
    // `knowledge.awareness.history` wrapper (post v0.2a.2.0 migration),
    // NOT on `KnowledgeHistory.awareness_changes` (which the v0.2a.2.2
    // migration deleted from the model). Filter to per-observer entries
    // anchored at this scene; tracking on/off events and source-projection
    // mutations are not surfaced as per-observer rows here.
    const awarenessHistory = (knowledge?.awareness && Array.isArray(knowledge.awareness.history))
      ? knowledge.awareness.history
      : []
    const awareAtNode = awarenessHistory.filter((c) => (
      c?.node_id === atNodeId
      && !c?.tracking_action
      && !c?.source_action
      && c?.observer_id
    ))
    return {
      name:    (h.name_changes || []).filter((c) => c.node_id === atNodeId),
      desc:    (h.description_changes || []).filter((c) => c.node_id === atNodeId),
      colour:  (h.colour_changes || []).filter((c) => c.node_id === atNodeId),
      image:   (h.profile_image_changes || []).filter((c) => c.node_id === atNodeId),
      aware:   awareAtNode,
    }
  }, [knowledge, atNodeId])

  if (!buckets) return null
  const knowledgeId = knowledge.id

  function renderContentRow(field, entry) {
    const chipDescriptor = knowledgeContentChangeToSubChip(field, entry, priorEffective)
    if (!chipDescriptor) return null
    return (
      <ChangeSubChip
        key={entry.id || `${field}-${atNodeId}`}
        chip={chipDescriptor}
        entityColour={displayColour}
        onDismiss={() => removeKnowledgeContentChangeAtNode(knowledgeId, field, atNodeId)}
      />
    )
  }

  const contentRows = [
    ...buckets.name.map((c) => renderContentRow('name', c)),
    ...buckets.desc.map((c) => renderContentRow('description', c)),
    ...buckets.colour.map((c) => renderContentRow('colour', c)),
    ...buckets.image.map((c) => renderContentRow('profile_image', c)),
  ]

  const awareRows = buckets.aware.map((c) => (
    <AwarenessSubChip
      key={c.id}
      record={{
        kind: 'entity_existence',
        changeId: c.id,
        targetEntityId: c.observer_id,
        level: c.level,
      }}
      observerName={getEntity?.(c.observer_id)?.name}
      getEntity={getEntity}
    />
  ))

  return (
    <ChangesAtThisPointSection
      groups={[
        { key: 'content', title: 'Content',   rows: contentRows },
        { key: 'aware',   title: 'Awareness', rows: awareRows },
      ]}
    />
  )
}

export default function KnowledgeDetailView() {
  const activeSelection  = useUiStore((s) => s.activeSelection)
  const openKnowledgeDetail = useUiStore((s) => s.openKnowledgeDetail)
  const focusNode        = useUiStore((s) => s._focusNode)

  const knowledges   = useProjectStore((s) => s.knowledges)
  const nodes        = useProjectStore((s) => s.nodes)
  const edges        = useProjectStore((s) => s.edges)
  // Entity buckets (used by the Attached event section's owner lookup
  // when rendering the Knowledge's source_event back-pointer badge).
  const _characters = useEntitiesStore((s) => s.characters)
  const _locations  = useEntitiesStore((s) => s.locations)
  const _items      = useEntitiesStore((s) => s.items)
  const _factions   = useEntitiesStore((s) => s.factions)
  const _customs    = useEntitiesStore((s) => s.customs)
  const allEntitiesForBadge = useMemo(
    () => [..._characters, ..._locations, ..._items, ..._factions, ..._customs],
    [_characters, _locations, _items, _factions, _customs],
  )
  const entityMapForBadge = useMemo(() => {
    const m = new Map()
    for (const e of allEntitiesForBadge) m.set(e.id, e)
    return m
  }, [allEntitiesForBadge])

  // Phase 3.4f Item 7 — host-side TagBadge click-through to the
  // read-only TagPopover host browser. Pure UI state; never reads
  // or writes any chain-tracked value.
  const {
    target: _tagPopoverTarget,
    open: _openTagPopover,
    close: _closeTagPopover,
  } = useTagBrowsePopover()
  const storyChapters = useProjectStore((s) => s.story?.chapters || null)
  const chapterMemberOpts = useChapterMemberOpts()
  const updateKnowledge = useProjectStore((s) => s.updateKnowledge)
  const commitAwarenessAtAnchor        = useProjectStore((s) => s.commitAwarenessAtAnchor)
  const setKnowledgeContentChangeAtNode    = useProjectStore((s) => s.setKnowledgeContentChangeAtNode)
  const removeKnowledgeContentChangeAtNode = useProjectStore((s) => s.removeKnowledgeContentChangeAtNode)
  const recordKnowledgeTagChange           = useProjectStore((s) => s.recordKnowledgeTagChange)

  const storyOrder = useStoryOrder()

  const knowledgeId = activeSelection?.kind === 'knowledge' ? activeSelection.id : null
  const knowledge = useMemo(
    () => (knowledges || []).find((k) => k.id === knowledgeId) || null,
    [knowledges, knowledgeId],
  )

  // Chain navigation: position 0 = origin; positions 1..N = each scene
  // (sceneNode) in story order. Unlike relationships, a Knowledge isn't
  // a canvas citizen with a setup node — the chain is the whole story order
  // so the user can drop a chain-time override at any scene, not only ones
  // where this Knowledge already has history.
  // Sparse chain — only nodes where this Knowledge has at least one
  // history entry of any kind, in story order. Mirrors the entity /
  // relationship Detail Panel pattern: chain nav steps through that
  // object's OWN narrative-flow points, not every scene in the story.
  // Creating new history entries at fresh scenes happens via the
  // origin-node output wire (Step 14 follow-up) and the future
  // canvas-side knowledge-chip surfaces, not via this panel's nav.
  const historyNodeIds = useMemo(
    () => getKnowledgeNodeOrder(knowledge, nodes, edges, storyOrder),
    [knowledge, nodes, edges, storyOrder],
  )

  // Resolve chain position 0's node id. Three cases:
  //   - Origin node on canvas → that node's id.
  //   - Scene-born (earliest `existence_changes: activate` event) → that
  //     scene's id; the birth scene IS chain position 0, so subsequent
  //     positions skip it (it's not duplicated as both "origin" and a
  //     history step).
  //   - Neither → null (pre-story baseline).
  const knowledgeOriginNodeId = useMemo(() => {
    if (!knowledge) return null
    const n = (nodes || []).find(
      (nn) => nn.type === 'knowledgeOriginNode' && nn.data?.knowledge_id === knowledge.id,
    )
    return n?.id || null
  }, [knowledge, nodes])

  // Phase 1.26 — POV-only nav toggle. When ON, filter the knowledge
  // chain to: origin (chain[0]) + sceneNode entries that lie on the
  // POV chain. Modifier-style intermediate stops are dropped.
  const povNavOnly    = useUiStore((s) => s.povNavOnly)
  const setPovNavOnly = useUiStore((s) => s.setPovNavOnly)
  const povColor      = usePovColor()

  const { chainNodeIds, hasAnyPov } = useMemo(() => {
    let fullChain
    if (knowledgeOriginNodeId) {
      fullChain = [knowledgeOriginNodeId, ...historyNodeIds]
    } else {
      const hasBirthEvent = (knowledge?.history?.existence_changes || []).some(
        (c) => c?.action === 'activate',
      )
      fullChain = (hasBirthEvent && historyNodeIds.length > 0) ? historyNodeIds : [null]
    }
    const povChain = computePovChain(nodes, edges)
    const povSet = new Set(povChain.sequence.map((s) => s.nodeId))
    const havePov = povSet.size > 0
    if (!povNavOnly || !havePov) return { chainNodeIds: fullChain, hasAnyPov: havePov }
    // Filter when ON: keep chain[0] (origin) + sceneNode entries in POV.
    const filtered = fullChain.filter((id, i) => {
      if (i === 0) return true
      if (!id) return false
      const n = nodes.find((nn) => nn.id === id)
      if (n?.type !== 'sceneNode') return false
      return povSet.has(id)
    })
    return { chainNodeIds: filtered, hasAnyPov: true }
  }, [knowledgeOriginNodeId, knowledge, historyNodeIds, nodes, edges, povNavOnly])

  const chainLength = chainNodeIds.length
  const [chainIdx, setChainIdx] = useState(0)

  // Sync chainIdx to the incoming `activeSelection.atNodeId` whenever the
  // panel is opened or re-targeted. Falls back to chainIdx 0 (origin)
  // when no atNodeId is supplied or when the supplied atNodeId isn't on
  // this Knowledge's chain. Without this sync, clicking a Knowledge chip
  // on Scene S would `openKnowledgeDetail(K, S)` but the panel would
  // ignore S and render at origin — making chain-time mutations at S
  // look "missing" from the panel even though the data is correctly
  // stored.
  const requestedAtNodeId = activeSelection?.kind === 'knowledge' ? (activeSelection.atNodeId ?? null) : null
  useEffect(() => {
    if (!requestedAtNodeId) {
      setChainIdx(0)
      return
    }
    const idx = chainNodeIds.indexOf(requestedAtNodeId)
    setChainIdx(idx >= 0 ? idx : 0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [knowledgeId, requestedAtNodeId])

  const clampedIdx = Math.max(0, Math.min(chainIdx, chainLength - 1))
  const atOrigin = clampedIdx === 0
  const atNodeId = chainNodeIds[clampedIdx] ?? null
  const atNode = atNodeId ? nodes.find((n) => n.id === atNodeId) : null

  // Phase 2.5g — drag-and-drop drop target on the knowledge avatar.
  // Anchor is the current chain position; the store action routes
  // to the baseline write at origin or a `profile_image_changes`
  // chain entry otherwise.
  const avatarDrop = useProfileImageDropTarget({
    kind: 'knowledge',
    id: knowledgeId,
    anchorNodeId: atNodeId,
  })

  const effectiveState = useMemo(
    () => computeKnowledgeEffectiveState(knowledge, historyNodeIds, atNodeId, { nodes, ctx: { storyOrder } }),
    [knowledge, historyNodeIds, atNodeId, nodes, storyOrder],
  )
  const notYetExists = !!effectiveState?.notYetExists

  // Effective state at the chain position IMMEDIATELY BEFORE atNodeId.
  // The Knowledge → entity-shaped chip adapter uses this to populate the
  // `oldValue` / `oldImageRef` half of each diff in the "Changes at this
  // point" section. When there's no prior chain step (origin or first
  // chain entry), fall back to the Knowledge's base values.
  const priorEffective = useMemo(() => {
    if (!atNodeId || !knowledge) return null
    const idx = (historyNodeIds || []).indexOf(atNodeId)
    if (idx <= 0) {
      return {
        name: knowledge.name,
        description: knowledge.description,
        colour: knowledge.colour,
        profile_image_ref: knowledge.profile_image_ref ?? null,
      }
    }
    return computeKnowledgeEffectiveState(knowledge, historyNodeIds, historyNodeIds[idx - 1], { nodes, ctx: { storyOrder } })
  }, [knowledge, historyNodeIds, atNodeId, nodes, storyOrder])

  // Per-field "modified at this scene" flags, false at origin by definition.
  const descriptionModHere  = !atOrigin && isHistoryEntryAt(knowledge?.history, 'description_changes', atNodeId)
  const profileImageModHere = !atOrigin && isHistoryEntryAt(knowledge?.history, 'profile_image_changes', atNodeId)

  // Chapter label for the nav bar when at a chain node.
  const chapterLabel = useMemo(() => {
    if (!atNode || !storyChapters || storyChapters.length === 0) return null
    const chapId = resolveChapterIdForNode(atNode, storyChapters, chapterMemberOpts)
    if (!chapId) return null
    const idx = storyChapters.findIndex((c) => c.id === chapId)
    if (idx < 0) return null
    return storyChapters[idx]?.title || `Chapter ${idx + 1}`
  }, [atNode, storyChapters, chapterMemberOpts])

  // ── Panel-level draft (shared shell-draft hook) ─────────────────────────────
  // Name + description + colour are panel-level scalar fields. They route
  // through the shared `useDetailPanelDraft` hook instead of committing on
  // blur / on-change. Profile-image picks and awareness writes remain
  // discrete actions (commit immediately) — out of scope for the panel
  // draft.
  const _effectiveName        = effectiveState?.name || ''
  const _effectiveDescription = effectiveState?.description || ''
  const _effectiveColour      = effectiveState?.colour || '#c9a876'
  // Tag membership at this anchor — walker-resolved set. Draft stores
  // the prospective effective set; save diffs against this and emits
  // a chain-aware `recordKnowledgeTagChange` call per diff entry.
  const _effectiveTagIds      = effectiveState?.tag_ids || []
  function _initKnowledgeDraft() {
    return {
      name:        _effectiveName,
      description: _effectiveDescription,
      colour:      _effectiveColour,
      tag_ids:     [..._effectiveTagIds],
    }
  }
  function _handleKnowledgeSave() {
    if (!_panelDraft || !knowledge || notYetExists) return
    if ((_panelDraft.name?.trim() || '') !== _effectiveName) {
      commitContent('name', _panelDraft.name?.trim() || '', _effectiveName)
    }
    if ((_panelDraft.description || '') !== _effectiveDescription) {
      commitContent('description', _panelDraft.description || '', _effectiveDescription)
    }
    if ((_panelDraft.colour || '') !== _effectiveColour) {
      commitContent('colour', _panelDraft.colour, _effectiveColour)
    }
    // Tags — diff draft set vs saved effective set, route each diff
    // entry through `recordKnowledgeTagChange`. The store action's
    // internal split handles baseline-at-origin vs chain-event-at-
    // anchor; pair-cancel + duplicate-drop invariants apply on the
    // chain path so e.g. removing a baseline tag at a chain anchor
    // strips it cleanly. `atOrigin ? null : atNodeId` matches the
    // anchor-routing shape `commitContent` uses for scalar fields.
    const draftTagSet = new Set(_panelDraft.tag_ids || [])
    const effectiveSet = new Set(_effectiveTagIds)
    const anchor = atOrigin ? null : atNodeId
    for (const tagId of draftTagSet) {
      if (!effectiveSet.has(tagId)) {
        recordKnowledgeTagChange(knowledge.id, 'add', tagId, anchor)
      }
    }
    for (const tagId of effectiveSet) {
      if (!draftTagSet.has(tagId)) {
        recordKnowledgeTagChange(knowledge.id, 'remove', tagId, anchor)
      }
    }
  }
  function _handleKnowledgeDiscard() {
    setEditingName(false)
  }
  const _knowledgeDraftKey = knowledge?.id ? `knowledge:${knowledge.id}:${atNodeId ?? 'origin'}` : null
  const _knowledgeDraftHandle = useDetailPanelDraft({
    draftKey: _knowledgeDraftKey,
    save: () => _handleKnowledgeSave(),
    discard: () => _handleKnowledgeDiscard(),
  })
  const _panelDraft   = _knowledgeDraftHandle.draft
  const setPanelDraft = _knowledgeDraftHandle.setDraft
  const isPanelDirty  = _knowledgeDraftHandle.isDirty

  // Field accessors — read from draft when dirty, fall back to effective
  // state otherwise. Setters write to the draft.
  const draftName        = (isPanelDirty && _panelDraft?.name        != null) ? _panelDraft.name        : _effectiveName
  const draftDescription = (isPanelDirty && _panelDraft?.description != null) ? _panelDraft.description : _effectiveDescription
  const draftColour      = (isPanelDirty && _panelDraft?.colour      != null) ? _panelDraft.colour      : _effectiveColour
  const draftTagIds      = (isPanelDirty && Array.isArray(_panelDraft?.tag_ids)) ? _panelDraft.tag_ids   : _effectiveTagIds
  function setDraftName(val)        { setPanelDraft((d) => ({ ..._initKnowledgeDraft(), ...(d || {}), name:        val })) }
  function setDraftDescription(val) { setPanelDraft((d) => ({ ..._initKnowledgeDraft(), ...(d || {}), description: val })) }
  function setDraftColour(val)      { setPanelDraft((d) => ({ ..._initKnowledgeDraft(), ...(d || {}), colour:      val })) }
  function addDraftTagId(tagId)     {
    setPanelDraft((d) => {
      const base = { ..._initKnowledgeDraft(), ...(d || {}) }
      const list = Array.isArray(base.tag_ids) ? base.tag_ids : []
      if (list.includes(tagId)) return base
      return { ...base, tag_ids: [...list, tagId] }
    })
  }
  function removeDraftTagId(tagId)  {
    setPanelDraft((d) => {
      const base = { ..._initKnowledgeDraft(), ...(d || {}) }
      const list = Array.isArray(base.tag_ids) ? base.tag_ids : []
      return { ...base, tag_ids: list.filter((id) => id !== tagId) }
    })
  }

  const [editingName, setEditingName] = useState(false)
  const nameInputRef = useRef(null)
  const colourAnchorRef = useRef(null)
  const [colourPickerOpen, setColourPickerOpen] = useState(false)
  const [subTab, setSubTab] = useState('details')

  useEffect(() => {
    if (editingName && nameInputRef.current) nameInputRef.current.select()
  }, [editingName])

  // ── Save handlers — route to origin action or chain-time action ─────────
  const commitContent = useCallback((field, newValue, currentEffective) => {
    if (!knowledge || notYetExists) return
    if (atOrigin) {
      if (newValue === (knowledge[field] || '')) return
      updateKnowledge(knowledge.id, { ...knowledge, [field]: newValue })
    } else {
      if (newValue === (currentEffective || '')) return
      setKnowledgeContentChangeAtNode(knowledge.id, field, atNodeId, newValue)
    }
  }, [knowledge, notYetExists, atOrigin, atNodeId, updateKnowledge, setKnowledgeContentChangeAtNode])

  // On-blur / on-change commits replaced by the panel-level draft + Save
  // bar (see `_handleKnowledgeSave` above). These handlers no longer
  // commit to the store; they just exit transient view UI states.
  const handleSaveName = useCallback(() => {
    setEditingName(false)
  }, [])

  const handleSaveDescription = useCallback(() => {
    // No-op: blur no longer commits. The panel-level Save bar commits.
  }, [])

  const handleSaveColour = useCallback((nextColour) => {
    setDraftColour(nextColour)
  }, [setDraftColour])

  const handleRevertContent = useCallback((field) => {
    if (!knowledge || atOrigin || !atNodeId) return
    removeKnowledgeContentChangeAtNode(knowledge.id, field, atNodeId)
  }, [knowledge, atOrigin, atNodeId, removeKnowledgeContentChangeAtNode])

  const handleProfileImageChange = useCallback(async (nextRef) => {
    if (!knowledge || notYetExists) return
    if (atOrigin) {
      if (nextRef === (knowledge.profile_image_ref ?? null)) return
      await updateKnowledge(knowledge.id, { ...knowledge, profile_image_ref: nextRef })
    } else if (atNodeId) {
      // Chain-time profile-image change. Skip the no-op write when the new
      // value already matches the inherited (pre-this-node) effective value.
      if (nextRef === (effectiveState?.profile_image_ref ?? null)) return
      setKnowledgeContentChangeAtNode(knowledge.id, 'profile_image', atNodeId, nextRef)
    }
  }, [knowledge, notYetExists, atOrigin, atNodeId, effectiveState?.profile_image_ref, updateKnowledge, setKnowledgeContentChangeAtNode])

  const handleScaleChange = useCallback(async (nextScale) => {
    if (!knowledge || !atOrigin) return
    if ((knowledge.awareness_scale || 'full') === nextScale) return
    await updateKnowledge(knowledge.id, { ...knowledge, awareness_scale: nextScale })
  }, [knowledge, atOrigin, updateKnowledge])

  // Awareness — route the picker's emitted draft through the universal
  // anchor-aware setter. This gets the chain-tracked tracking on/off
  // model (tracking_action history events), per-observer diffing, and
  // source-mutation handling for free, matching how entity (KnownBy)
  // and relationship (RelationshipKnownBy) tabs commit.
  const handleAwarenessChange = useCallback((next) => {
    if (!knowledge || notYetExists) return
    commitAwarenessAtAnchor({
      target: { kind: 'knowledge', knowledgeId: knowledge.id },
      anchor: { kind: atOrigin ? 'origin' : 'chain', nodeId: atOrigin ? null : atNodeId },
      draft: next,
    })
  }, [knowledge, notYetExists, atOrigin, atNodeId, commitAwarenessAtAnchor])

  // Keyboard chain navigation — mirrors the Entity / Relationship detail
  // panels so ← / → step through chain positions. `_navRef` sidesteps the
  // stale-closure problem a one-time document listener would otherwise
  // hit; we mutate the ref on every render and the listener reads live
  // state from it.
  //
  // CRITICAL: this hook block lives ABOVE the `if (!knowledge) return`
  // early-return below so React's hooks-count is stable when the
  // Knowledge becomes null mid-session (e.g. user loads a different
  // project file while the panel is open). Moving this below the early
  // return triggers "Rendered fewer hooks than expected" on the next
  // render after Knowledge is dropped.
  const canBack = clampedIdx > 0
  const canForward = clampedIdx < chainLength - 1
  const _navRef = useRef(null)
  _navRef.current = {
    canBack, canForward,
    goBack: () => openKnowledgeDetail(knowledge.id, chainNodeIds[Math.max(0, clampedIdx - 1)] ?? null),
    goForward: () => openKnowledgeDetail(knowledge.id, chainNodeIds[Math.min(chainLength - 1, clampedIdx + 1)] ?? null),
  }
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      if (e.target?.closest?.('[data-dot-key]')) return
      const nav = _navRef.current
      if (!nav) return
      if (e.key === 'ArrowLeft'  && nav.canBack)    { e.preventDefault(); nav.goBack() }
      if (e.key === 'ArrowRight' && nav.canForward) { e.preventDefault(); nav.goForward() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  if (!knowledge) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 p-4 text-zinc-600 text-xs italic">
        Knowledge not found.
      </div>
    )
  }

  const displayedName        = draftName
  const displayedColour      = draftColour
  const displayedDescription = draftDescription

  const nameLen = 9 + displayedName.length  // 'knowledge' = 9 chars
  const useCompactIcon = nameLen > 33
  const squash = !useCompactIcon && nameLen > 22

  // Nav bar context badge — three cases:
  //   - Origin-node-anchored or pre-story-baseline at chainIdx 0:
  //     parchment "NEW : KNOWLEDGE" badge (mirrors entity panel's
  //     "NEW : CHARACTER" / "NEW : LOCATION" etc. green badge at origin).
  //   - Scene-anchored chain position (origin or downstream): purple
  //     "SCENE : <title>" badge with click-to-focus on the scene.
  // Detection: scene-anchored = `atNode?.type === 'sceneNode'`. Any
  // other atNode type (or null atNodeId) is the Knowledge's own origin
  // surface and gets the parchment NEW badge.
  const contextBadge = atNode?.type === 'sceneNode' ? (
    <button
      onClick={() => focusNode?.(atNodeId)}
      className="flex items-center min-w-0 text-left hover:opacity-80"
      title="Centre canvas on this scene"
    >
      <span className="flex items-center gap-1 bg-purple-900/30 px-1.5 py-0.5 rounded min-w-0">
        <span className="text-[9px] text-purple-400 uppercase tracking-widest font-semibold flex-shrink-0">SCENE</span>
        <span className="text-[9px] text-zinc-100 uppercase tracking-widest font-semibold truncate">
          : {atNode?.data?.title || 'Scene'}
        </span>
      </span>
    </button>
  ) : (
    <span
      className="text-[9px] uppercase tracking-widest font-semibold px-1.5 py-0.5 rounded"
      style={{ color: KNOWLEDGE_COLOUR, backgroundColor: `${KNOWLEDGE_COLOUR}22` }}
    >
      NEW : KNOWLEDGE
    </span>
  )

  const nameSlot = editingName ? (
    <input
      ref={nameInputRef}
      className="text-sm font-medium leading-tight w-36 bg-transparent border-b focus:outline-none"
      style={{ color: displayedColour, borderColor: displayedColour }}
      value={draftName}
      onChange={(e) => setDraftName(e.target.value)}
      onBlur={handleSaveName}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); handleSaveName() }
        if (e.key === 'Escape') { setDraftName(effectiveState?.name || ''); setEditingName(false) }
      }}
    />
  ) : (
    <div
      className="text-sm font-medium leading-tight truncate min-w-0 cursor-text hover:opacity-75"
      style={{ color: displayedColour }}
      onClick={() => setEditingName(true)}
      title={atOrigin ? 'Click to edit name (origin)' : 'Click to edit name at this scene'}
    >
      {displayedName || <span className="text-zinc-600 italic">Unnamed</span>}
    </div>
  )

  const displayedAvatarRef = atOrigin
    ? (knowledge.profile_image_ref ?? null)
    : (effectiveState?.profile_image_ref ?? null)

  // Avatar slot — keeps the image horizontally centred regardless of
  // chain position. Hover-revealed `×` (top-right) clears the image at
  // the current chain position (mirrors the EntityChipDetailView pattern).
  // When a profile-image override exists at this non-origin chain node,
  // a subtle amber `✱` dot (top-left) reverts the override.
  const row2Slot = (
    <div className="flex justify-center">
      <div
        className="relative flex-shrink-0 group w-fit"
        {...avatarDrop.dropHandlers}
        style={avatarDrop.isDragOver ? {
          outline: '2px dashed #a855f7',
          outlineOffset: 2,
          borderRadius: 4,
        } : undefined}
        title={avatarDrop.isDragOver ? 'Drop to apply as avatar at this anchor' : undefined}
      >
        <ProfileImageUpload
          fileRef={displayedAvatarRef}
          entityType="knowledge"
          entityColour={displayedColour}
          size={48}
          compact
          onChange={handleProfileImageChange}
        />
        {displayedAvatarRef && (
          <button
            type="button"
            title="Remove profile image"
            onClick={() => handleProfileImageChange(null)}
            className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-zinc-700 text-zinc-400 hover:bg-red-700 hover:text-white hidden group-hover:flex items-center justify-center text-[10px] font-bold leading-none"
          >−</button>
        )}
        {profileImageModHere && (
          <button
            type="button"
            title="Modified at this scene. Click to revert to the upstream inherited value."
            onClick={() => handleRevertContent('profile_image')}
            className="absolute -top-1 -left-1 w-4 h-4 rounded-full bg-amber-900/40 text-amber-400 hover:bg-red-900/40 hover:text-red-300 flex items-center justify-center text-[9px] leading-none border border-amber-500/40"
          >✱</button>
        )}
      </div>
    </div>
  )

  return (
    <>
    <DetailPanelShell
      outerKey={knowledge.id}
      navBar={(
      <DetailPanelNavBar
        contextBadge={contextBadge}
        chapterLabel={chapterLabel}
        canUp={false}
        canBack={canBack}
        onBack={() => openKnowledgeDetail(knowledge.id, chainNodeIds[Math.max(0, clampedIdx - 1)] ?? null)}
        onFirst={() => openKnowledgeDetail(knowledge.id, chainNodeIds[0] ?? null)}
        canForward={canForward}
        onForward={() => openKnowledgeDetail(knowledge.id, chainNodeIds[Math.min(chainLength - 1, clampedIdx + 1)] ?? null)}
        onLast={() => openKnowledgeDetail(knowledge.id, chainNodeIds[chainLength - 1] ?? null)}
        position={`${clampedIdx + 1} / ${chainLength}`}
        onFocus={atNodeId ? () => focusNode?.(atNodeId) : null}
        leftSlot={(
          <PovNavToggleButton
            hasAnyPov={hasAnyPov}
            povNavOnly={povNavOnly}
            onToggle={() => {
              // Turning ON. setChainIdx(0) sends the panel to the
              // knowledge's origin (always allowed when toggle is on).
              // The chainNodeIds useMemo recomputes with the filtered
              // list, so on next render clampedIdx maps to the (now
              // filtered) origin position. Saves the auto-flip-off
              // effect from immediately reverting.
              if (!povNavOnly && hasAnyPov) {
                setChainIdx(0)
              }
              setPovNavOnly(!povNavOnly)
            }}
            povColor={povColor}
          />
        )}
        cornerSlot={knowledge ? (
          <ShowInTocButton
            type="knowledge"
            id={knowledge.id}
            accentColour={knowledge.colour || '#888888'}
            typeLabel="knowledge"
            size="sm"
          />
        ) : null}
      />
      )}
      header={(
      <DetailPanelIdentityHeader
        typeLabel="knowledge"
        typeColour={KNOWLEDGE_COLOUR}
        typeIcon={<KnowledgeIcon size={14} />}
        useCompactIcon={useCompactIcon}
        letterSpacing={squash ? '-0.03em' : '0.25em'}
        nameSlot={nameSlot}
        row2Slot={row2Slot}
        cornerAction={
          <AttachToChatButton
            kind="knowledge"
            id={knowledge.id}
            anchorNodeId={atNodeId}
            title={atOrigin
              ? 'Add this knowledge at its origin as context to the open conversation'
              : 'Add this knowledge at this scene as context to the open conversation'}
            className="w-5 h-5"
          />
        }
        cornerActionLeft={
          <>
            <button
              type="button"
              ref={colourAnchorRef}
              onClick={() => setColourPickerOpen((o) => !o)}
              className="w-6 h-6 rounded border border-zinc-600 hover:border-zinc-400 cursor-pointer flex-shrink-0 transition-colors"
              style={{ background: displayedColour }}
              aria-label={`Colour: ${displayedColour}. Click to edit.`}
              title="Edit colour"
            />
            <EntityColorPicker
              value={displayedColour}
              onChange={handleSaveColour}
              anchorEl={colourAnchorRef.current}
              isOpen={colourPickerOpen}
              onClose={() => setColourPickerOpen(false)}
            />
          </>
        }
      />
      )}
      subTabs={(
        <div data-help-region="detail-knowledge:subtabs" className="contents">
          <DetailPanelSubTabs
            tabs={['details', 'awareness']}
            active={subTab}
            onChange={setSubTab}
          />
        </div>
      )}
      body={(<>
        {subTab === 'details' && (
          <div className="space-y-3" data-help-region="detail-knowledge:details_body">
            {notYetExists && (
              <div className="text-[10px] text-amber-300 italic px-2 py-1 bg-amber-900/20 border border-amber-700/40 rounded">
                This Knowledge doesn&apos;t exist yet at this chain position.
                It first comes into existence at its origin node further along
                the story. Editing is disabled; navigate forward to its
                creation point or beyond to make changes.
              </div>
            )}
            <div data-help-region="detail-knowledge:details_description" className="contents">
            <DescriptionEditor
              value={displayedDescription}
              onChange={setDraftDescription}
              onBlur={handleSaveDescription}
              placeholder="Brief description..."
              labelExtra={descriptionModHere ? (
                <span className="flex items-center gap-1">
                  <ChangeBadge action="modify" />
                  <button
                    type="button"
                    onClick={() => handleRevertContent('description')}
                    className="text-[11px] font-bold text-zinc-600 hover:text-red-400 leading-none"
                    title="Modified at this scene. Click to revert to the upstream inherited value."
                  >−</button>
                </span>
              ) : null}
            />
            </div>

            {/* Phase 3.4f Item 3 — Project Tag picker. Knowledge has
                no aliases, so tags take the position aliases occupy
                on the Entity detail panel. Chain-aware routing:
                  - currentTagIds → walker-resolved set at this
                    anchor (chain-aware read).
                  - baselineTagIds → knowledge.tag_ids (host's raw
                    baseline) so the picker's per-chip solid-vs-
                    dashed rule can fire: solid when in baseline,
                    dashed when only present via a chain event.
                  - onAdd / onRemove → `recordKnowledgeTagChange`
                    with `atOrigin ? null : atNodeId`; the action's
                    internal split handles baseline-at-origin vs
                    chain-event-at-anchor with the same same-node
                    opposite-pair cancellation invariant the Entity
                    mount established.
                When `notYetExists` is true (panel anchor sits
                before the Knowledge's source event), writes are
                gated to match the rest of the panel's editors. */}
            <div data-help-region="detail-knowledge:details_tags">
              <label className="text-[10px] text-zinc-500 uppercase tracking-wider block mb-1">Tags</label>
              {/* Phase 3.4f Item 3 — Knowledge tag picker. Routes
                  through the panel draft (same Save / Discard bar as
                  the scalar fields above) so tag changes can be
                  rolled back by Discard. Save handler diffs the
                  draft tag set against `_effectiveTagIds` and emits
                  per-diff `recordKnowledgeTagChange` calls; the
                  store action's internal split handles baseline-at-
                  origin vs chain-event-at-anchor.

                  `baselineTagIds` follows the same draft-state rule
                  the Entity panel uses: at origin while dirty, the
                  prospective baseline IS `draft.tag_ids` (a chip
                  freshly added at origin should render solid, not
                  dashed). Elsewhere it's the saved knowledge
                  baseline — adds at chain anchors land in
                  `tag_changes` events, never in baseline, so chain-
                  added chips correctly render dashed. */}
              <ProjectTagPicker
                currentTagIds={draftTagIds}
                baselineTagIds={
                  atOrigin
                    ? (isPanelDirty && Array.isArray(_panelDraft?.tag_ids)
                        ? _panelDraft.tag_ids
                        : (knowledge?.tag_ids || []))
                    : (knowledge?.tag_ids || [])
                }
                onTagClick={_openTagPopover}
                onAdd={(tagId) => {
                  if (!knowledge || notYetExists) return
                  addDraftTagId(tagId)
                }}
                onRemove={(tagId) => {
                  if (!knowledge || notYetExists) return
                  removeDraftTagId(tagId)
                }}
              />
            </div>

            {/* Phase 3.4h — Colour control relocated to the identity
                header's bottom-left corner (`cornerActionLeft`). The
                chip + EntityColorPicker live in the header above;
                routing is identical (`handleSaveColour` flushes via
                the existing panel-draft commit flow that
                `commitContent('colour', ...)` already handles for
                origin baseline AND chain-anchor paths). Inline
                modify-badge + revert button + hex input dropped to
                unify with EntityDetailView's behaviour — the modified
                state surfaces via the chain-history surface, not on
                the colour control itself. */}

            {/* Attached event — read-only EventBadge surfacing the
                Knowledge's `source_event` back-pointer. Hidden when no
                source_event is set (standalone Knowledges). Chain-tracked
                rebinding via `source_event_changes` lands in a
                follow-up commit; this baseline view is the v1 vertical
                slice. */}
            {(() => {
              // Chain-resolved source_event at the current chain anchor:
              // walks `knowledge.history.source_event_changes` and picks
              // the most recent rebinding with node_id ≤ atNodeId, else
              // falls back to baseline. Returns null when the Knowledge
              // is currently decoupled (no baseline, no rebindings, or
              // the most recent rebinding cleared the pointer).
              const effectiveSourceEvent = resolveKnowledgeSourceEventAt(knowledge, atNodeId, storyOrder)
              const props = resolveEventBadgePropsFromSourceEvent(effectiveSourceEvent, allEntitiesForBadge, nodes, edges)
              if (!props) return null
              return (
                <div data-help-region="detail-knowledge:details_attached_event">
                  <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Attached event</div>
                  <EventBadge
                    entity={props.entity}
                    nodeId={props.nodeId}
                    nodes={nodes}
                    entityMap={entityMapForBadge}
                    fieldLabel={props.fieldLabel}
                    action={props.action}
                    oldValue={props.oldValue}
                    newValue={props.newValue}
                  />
                </div>
              )
            })()}

            {!atOrigin && (
              <KnowledgeChangesAtPointSection
                knowledge={knowledge}
                atNodeId={atNodeId}
                priorEffective={priorEffective}
                displayColour={displayedColour}
              />
            )}
          </div>
        )}

        {subTab === 'awareness' && (
          <div className="space-y-3" data-help-region="detail-knowledge:awareness_body">
            {notYetExists && (
              <div className="text-[10px] text-amber-300 italic px-2 py-1 bg-amber-900/20 border border-amber-700/40 rounded">
                This Knowledge doesn&apos;t exist yet at this chain position —
                no awareness can be tracked yet. Navigate to its origin
                node or beyond to edit awareness.
              </div>
            )}
            {(() => {
              // Precision toggle — sits below the picker's "Track who knows
              // this" toggle via the `extraTrackingRow` slot, so it's only
              // visible while tracking is on (Phase 1.21h: precision is
              // meaningless when tracking is disabled). Origin-only edit;
              // disabled at non-origin chain anchors (precision changes
              // post-establishment go through Fix #4's view filter, not
              // this toggle).
              const precisionRow = (
                <div className="flex items-center gap-2" data-help-region="detail-knowledge:awareness_precision">
                  <label className="text-[10px] text-zinc-500 uppercase tracking-wider flex-shrink-0">Precision</label>
                  <div className="inline-flex rounded border border-zinc-700 overflow-hidden">
                    {[
                      { key: 'binary', levels: [0, 3] },
                      { key: 'full',   levels: [0, 1, 2, 3] },
                    ].map((opt) => {
                      const active = (knowledge.awareness_scale || 'full') === opt.key
                      return (
                        <button
                          key={opt.key}
                          type="button"
                          disabled={!atOrigin}
                          onClick={() => handleScaleChange(opt.key)}
                          title={opt.key === 'binary' ? 'Binary: known / not known' : 'Graduated: four awareness levels'}
                          className={`inline-flex items-center gap-0.5 px-1.5 py-1 transition-colors disabled:cursor-default ${
                            active
                              ? 'bg-zinc-700 ring-2 ring-inset ring-accent-500'
                              : 'bg-zinc-900 opacity-50 hover:opacity-80 hover:bg-zinc-800'
                          }`}
                        >
                          {opt.levels.map((lvl) => (
                            <AwarenessBadge key={lvl} level={lvl} size={12} />
                          ))}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
              // Origin picker value: extract the baseline-only view from
              // the awareness shape. Tracking is established at origin
              // iff the host has a baseline — for a wrapper this means
              // the `entries` KEY is present (even with value `{}` —
              // that's the wrapped form of the flat-dict `{}` that
              // origin toggle-ON produces with no observers yet) OR the
              // `sources` array is non-empty. A wrapper that exists
              // ONLY as a container for chain `history` (no `entries`
              // key, no `sources`) means tracking-off at origin —
              // established later on the chain. Reading the raw
              // wrapper unconditionally would make the picker show ON
              // at origin (isTracking = value != null) for the
              // history-only case. The non-origin branch goes through
              // `effectiveState.awareness` which is already a flat
              // resolved dict from the chain walker; only the origin
              // branch reads the raw shape so this normalisation lives
              // here.
              const originBaselineAwareness = (() => {
                const a = knowledge.awareness
                if (a == null) return null
                if (typeof a !== 'object' || Array.isArray(a)) return null
                const isWrapper = Object.prototype.hasOwnProperty.call(a, 'entries')
                  || Object.prototype.hasOwnProperty.call(a, 'sources')
                  || Object.prototype.hasOwnProperty.call(a, 'history')
                if (!isWrapper) return a  // flat dict baseline — tracking on
                const hasEntriesKey = Object.prototype.hasOwnProperty.call(a, 'entries') && a.entries != null
                const hasSources = Array.isArray(a.sources) && a.sources.length > 0
                if (!hasEntriesKey && !hasSources) return null  // history-only wrapper → tracking off at origin
                // Baseline-only wrapper view (omit history) for the picker.
                return {
                  ...(hasEntriesKey ? { entries: { ...a.entries } } : {}),
                  ...(hasSources ? { sources: a.sources.slice() } : {}),
                }
              })()
              return (
                <AwarenessPicker
                  value={atOrigin ? originBaselineAwareness : (effectiveState?.awareness_raw ?? null)}
                  onChange={handleAwarenessChange}
                  surface="knowledge"
                  mode="groups"
                  scale={(knowledge.awareness_scale || 'full') === 'binary' ? SCALE_BINARY : SCALE_ALIAS}
                  parentEntityId={null}
                  context={{ parentName: displayedName || 'this knowledge' }}
                  disabled={notYetExists}
                  extraTrackingRow={precisionRow}
                  trackToggleLabel={`Track who knows ${displayedName || 'this knowledge'}`}
                />
              )
            })()}
          </div>
        )}
      </>)}
      footer={(<>
        {/* Full-width Notes button. Style + behaviour mirror the entity
            panel's author-notes affordance. Knowledge deletion lives on
            the library row's hover-× and on the canvas KnowledgeOriginNode
            hover-×; duplicating it here was redundant + accident-prone. */}
        <NotesFooterButton surface="knowledge" id={knowledge.id} />
        {/* Panel-level draft Save / Discard bar (shared shell-draft hook).
            Renders BELOW the bottom-most footer button — matching the
            Entity panel's footer order so the save bar is always in the
            same place regardless of which detail panel is showing. */}
        <DraftSaveBar isDirty={isPanelDirty} onSave={_knowledgeDraftHandle.save} onDiscard={_knowledgeDraftHandle.discard} />
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
