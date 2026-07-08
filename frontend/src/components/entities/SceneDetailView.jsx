import { useState, useMemo, useEffect, useRef } from 'react'
import { useUiStore } from '../../store/uiStore'
import { useProjectStore } from '../../store/projectStore'
import { useEntitiesStore } from '../../store/entitiesStore'
import { confirm } from '../../store/dialogStore'
import { ENTITY_BUCKETS, getKnowledgeNodeOrder, computeEffectiveState, getEntityNarrativeChain } from '../../utils/narrativeChain'
import { TYPE_ICONS, participantsFallbackLabel } from '../../utils/entityHelpers'
import { createEmptyRelationshipHistory } from '../../utils/relationshipHistory'
import { useEntityById } from '../../hooks/useEntityById'
import ImageHoverPreview from '../ui/ImageHoverPreview'
import DetailPanelNavBar from '../ui/DetailPanelNavBar'
import DetailPanelIdentityHeader from '../ui/DetailPanelIdentityHeader'
import AttachToChatButton from '../chat/AttachToChatButton'
import DetailPanelShell from '../ui/DetailPanelShell'
import DetailPanelSubTabs from '../ui/DetailPanelSubTabs'
import SceneChangesView from './SceneChangesView'
import { usePovColor } from '../../utils/povConstants'
import { computePovChain } from '../../utils/povSequence'
import PovNavToggleButton from '../ui/PovNavToggleButton'
import SceneCircumstancesView from './SceneCircumstancesView'
import DraftSaveBar from '../ui/DraftSaveBar'
import { useDetailPanelDraft } from '../../hooks/useDetailPanelDraft'
import DescriptionEditor from '../ui/DescriptionEditor'
import SceneTimeRow from '../nodes/SceneTimeRow'
import { resolveChapterIdForNode } from '../../utils/chapterMembership'
import { useChapterMemberOpts } from '../../hooks/useChapterMemberOpts'
import { useStoryOrder, storyOrderNodesEqual, storyOrderEdgesEqual } from '../../hooks/useStoryOrder'
import KnowledgePickerPopover from './KnowledgePickerPopover'
import { KNOWLEDGE_COLOUR, RelationshipLabelStack, RelationshipIcon } from '../ui/IdentityBadges'
import { buildDeleteRelationshipMessage } from '../ui/popupMessages'

const EMPTY_CHAPTERS = []

const SCENE_BUCKET_LABELS = {
  characters: 'Characters',
  locations: 'Locations',
  items: 'Items',
  factions: 'Factions',
  customs: 'Custom',
}

// ── EntityAvatar — small profile image or type icon ───────────────────────────

function EntityAvatar({ entity, profileRef, colour, size = 'md' }) {
  const assetName = profileRef ? profileRef.replace(/^assets\//, '') : null
  const c = colour || entity?.colour || '#888888'
  const sz = size === 'sm' ? 'w-6 h-6 text-sm' : 'w-8 h-8 text-lg'
  const borderWidth = size === 'sm' ? '1.5px' : '2px'
  return (
    <ImageHoverPreview src={assetName ? `/api/project/assets/${assetName}` : null} borderColour={c}>
      <div
        className={`${sz} rounded flex items-center justify-center flex-shrink-0`}
        style={{ backgroundColor: assetName ? 'transparent' : c + '22', border: `${borderWidth} solid ${c}` }}
      >
        {assetName
          ? <img src={`/api/project/assets/${assetName}`} alt="" className={`${sz} rounded object-cover`} />
          : <span>{TYPE_ICONS[entity?.type] || '?'}</span>
        }
      </div>
    </ImageHoverPreview>
  )
}

// ── Chip row (inside plot-point view, clickable) ──────────────────────────────

function ChipRow({ entityRef, nodeId, nodes, edges, onClick }) {
  const entity = useEntityById(entityRef.entity_id)
  const effectiveState  = useMemo(
    () => entity ? computeEffectiveState(entity, nodes, edges, nodeId) : null,
    [entity, nodes, edges, nodeId]
  )
  const effectiveColour = effectiveState?.colour            ?? '#888888'
  const effectiveName   = effectiveState?.name              ?? '—'
  const profileRef      = effectiveState?.profile_image_ref ?? null

  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-zinc-700/50 text-left group"
    >
      <EntityAvatar entity={entity} profileRef={profileRef} colour={effectiveColour} size="sm" />
      <span className="text-xs text-zinc-200 flex-1 truncate" style={{ color: effectiveColour }}>{effectiveName}</span>
      <span className="text-zinc-600 group-hover:text-zinc-400 text-[10px]">›</span>
    </button>
  )
}

// ── Scene Detail View ─────────────────────────────────────────────────────────

// Scene-only sub-tabs. The detailPanelActiveSubTab store slot is shared
// with the entity / relationship / knowledge views — when navigating from
// one of those to a scene the slot may carry a tab key the scene doesn't
// recognise (e.g. 'attributes'); we coerce to 'details' in that case so
// the scene panel always lands on a valid tab.
const SCENE_SUB_TABS = ['details', 'circumstances', 'changes']

// Phase 4.1g follow-up — structural freeze for the detail panel's
// nodes/edges. The panel reads nodes/edges as chain inputs across
// several memos (effective-state, narrative-chain, knowledge-order
// walks), so a raw `s.nodes`/`s.edges` subscription re-rendered AND
// re-walked the whole panel (~150ms self per the comparative forensics)
// on every array-identity write, including dimension flushes and
// unrelated edits that don't touch the chain. These gates return the
// PRIOR array reference when the structural slice the chain walkers
// consume is unchanged (`storyOrderNodesEqual` / `storyOrderEdgesEqual`
// cover node id/type/data/position + edge id/source/target/handles/
// data), so the panel's subscription stays Object.is-stable and its
// memos don't recompute. Single module cell — one detail panel instance.
let _frozenNodes = null
let _frozenEdges = null
function _freezeNodes(nodes) {
  if (_frozenNodes && storyOrderNodesEqual(_frozenNodes, nodes)) return _frozenNodes
  _frozenNodes = nodes
  return nodes
}
function _freezeEdges(edges) {
  if (_frozenEdges && storyOrderEdgesEqual(_frozenEdges, edges)) return _frozenEdges
  _frozenEdges = edges
  return edges
}

function SceneDetailView() {
  const nodeId              = useUiStore((s) => s.detailPanelNodeId)
  const setDetailPanel      = useUiStore((s) => s.setDetailPanel)
  const storeSubTab         = useUiStore((s) => s.detailPanelActiveSubTab)
  const setStoreSubTab      = useUiStore((s) => s.setDetailPanelActiveSubTab)
  const subTab = SCENE_SUB_TABS.includes(storeSubTab) ? storeSubTab : 'details'
  const focusNode           = useUiStore((s) => s._focusNode)
  const openRightSidebar    = useUiStore((s) => s.openRightSidebar)
  const closeRightSidebar   = useUiStore((s) => s.closeRightSidebar)
  const rightSidebarOpen    = useUiStore((s) => s.rightSidebarOpen && s.rightSidebarNodeId === s.detailPanelNodeId)
  const nodes               = useProjectStore((s) => _freezeNodes(s.nodes))
  const edges               = useProjectStore((s) => _freezeEdges(s.edges))
  // Master Time Tracking toggle — gates the time-row divider so we
  // don't render a stray line when the row itself is hidden.
  const timeTrackingEnabledForDivider = useProjectStore((s) => s.story?.time_tracking_enabled === true)
  const storyChapters       = useProjectStore((s) => s.story?.chapters || EMPTY_CHAPTERS)
  const chapterMemberOpts   = useChapterMemberOpts()
  const updateNodeData      = useProjectStore((s) => s.updateNodeData)
  const allRelationships     = useProjectStore((s) => s.relationships)
  const relationshipsByScene = useProjectStore((s) => s.relationshipsByScene)
  const createRelationship   = useProjectStore((s) => s.createRelationship)
  const deleteObject         = useProjectStore((s) => s.deleteObject)
  const openRelationshipDetail = useUiStore((s) => s.openRelationshipDetail)
  const allKnowledges        = useProjectStore((s) => s.knowledges)
  const addKnowledgeManualAnchor    = useProjectStore((s) => s.addKnowledgeManualAnchor)
  const removeKnowledgeManualAnchor = useProjectStore((s) => s.removeKnowledgeManualAnchor)
  const createKnowledgeAtScene = useProjectStore((s) => s.createKnowledgeAtScene)
  const openKnowledgeDetail  = useUiStore((s) => s.openKnowledgeDetail)
  const entCharsP = useEntitiesStore((s) => s.characters)
  const entLocsP  = useEntitiesStore((s) => s.locations)
  const entItemsP = useEntitiesStore((s) => s.items)
  const entFacsP  = useEntitiesStore((s) => s.factions)
  const entCustsP = useEntitiesStore((s) => s.customs)
  const storyOrder = useStoryOrder()
  const node = nodes.find((n) => n.id === nodeId)

  // Phase 1.26 — POV-only nav toggle. Session-only flag in uiStore. When
  // ON, the back / forward arrows step through ONLY scenes that have at
  // least one character with `has_pov === true`. When OFF (default), they
  // step through every sceneNode in global story order.
  const povNavOnly      = useUiStore((s) => s.povNavOnly)
  const setPovNavOnly   = useUiStore((s) => s.setPovNavOnly)
  const povColor        = usePovColor()

  // Scene chain navigation — scenes don't have their own entity chain, so the
  // nav bar's previous / next walks the global story order filtered to plot-
  // point scenes only. Matches the narrative ordering surfaced by the
  // DevPreview Story Order page and the Timeline Navigator columns.
  const { sceneSeq, sceneIdx, hasAnyPov, currentSceneIsPov, firstPovSceneId } = useMemo(() => {
    const plotIds = new Set()
    for (const n of nodes) {
      if (n.type === 'sceneNode') plotIds.add(n.id)
    }
    // The canonical "is this scene on the POV chain" signal is the
    // POV-wire chain rooted at the POV Origin Node — NOT `has_pov` on
    // character refs (that's an internal chain-walker mechanic, not
    // every project sets it). `computePovChain` walks the wires from
    // the POV origin and returns the ordered list of scene ids.
    const povChain = computePovChain(nodes, edges)
    const povIds = new Set(povChain.sequence.map((s) => s.nodeId))
    const fullSeq = storyOrder?.orderedIds?.filter((id) => plotIds.has(id)) || []
    const filteredSeq = (povNavOnly && povIds.size > 0)
      ? fullSeq.filter((id) => povIds.has(id))
      : fullSeq
    const idx = nodeId ? filteredSeq.indexOf(nodeId) : -1
    const firstPov = fullSeq.find((id) => povIds.has(id)) || null
    if (typeof window !== 'undefined' && window.__NN_DEBUG_POV_NAV__) {
       
      console.log('[POV nav]', {
        povNavOnly,
        scenesTotal: plotIds.size,
        povSceneIds: [...povIds].map((id) => id.slice(0, 8)),
        nodeId: nodeId?.slice(0, 8),
        currentSceneIsPov: nodeId ? povIds.has(nodeId) : false,
        sceneSeqIds: filteredSeq.map((id) => id.slice(0, 8)),
        sceneIdx: idx,
        firstPov: firstPov?.slice(0, 8),
      })
    }
    return {
      sceneSeq: filteredSeq,
      sceneIdx: idx,
      hasAnyPov: povIds.size > 0,
      currentSceneIsPov: nodeId ? povIds.has(nodeId) : false,
      firstPovSceneId: firstPov,
    }
  }, [nodes, edges, storyOrder, nodeId, povNavOnly])

  // Track the previously-rendered nodeId so the auto-flip-off useEffect
  // below can fire ONLY on actual navigation (the writer clicked a non-POV
  // scene on the canvas while the toggle was on). It must NOT fire on the
  // same render as a fresh toggle-on click — clicking the toggle from a
  // non-POV scene is handled by `handleTogglePovNavOnly` below, which
  // jumps to the first POV scene before flipping the toggle on, so by the
  // time the next render lands the current scene IS a POV scene.
  const prevNodeIdRef = useRef(nodeId)
  useEffect(() => {
    const navigatedAway = prevNodeIdRef.current !== nodeId
    prevNodeIdRef.current = nodeId
    if (povNavOnly && navigatedAway && nodeId && hasAnyPov && !currentSceneIsPov) {
      setPovNavOnly(false)
    }
  }, [povNavOnly, nodeId, hasAnyPov, currentSceneIsPov, setPovNavOnly])

  // Toggle handler — wraps the store's togglePovNavOnly with a "jump to
  // first POV scene first" step when turning ON from a non-POV scene.
  // Without the jump the auto-flip-off useEffect would (correctly) flip
  // the toggle right back off, so the toggle would appear to do nothing
  // for writers whose project has off-POV scenes.
  const handleTogglePovNavOnly = () => {
    if (!hasAnyPov) return
    if (!povNavOnly && !currentSceneIsPov && firstPovSceneId) {
      // Turning ON from a non-POV scene → jump to the first POV scene.
      // Both state updates land in the same React batch, so on next
      // render currentSceneIsPov is true and the auto-flip-off effect
      // doesn't fire.
      focusNode?.(firstPovSceneId)
      setDetailPanel('scene', firstPovSceneId)
    }
    setPovNavOnly(!povNavOnly)
  }

  const canBackScene    = sceneIdx > 0
  const canForwardScene = sceneIdx >= 0 && sceneIdx < sceneSeq.length - 1
  const navigateToScene = (targetId) => {
    if (!targetId) return
    focusNode?.(targetId)
    setDetailPanel('scene', targetId)
  }
  const goBackScene    = () => { if (canBackScene) navigateToScene(sceneSeq[sceneIdx - 1]) }
  const goForwardScene = () => { if (canForwardScene) navigateToScene(sceneSeq[sceneIdx + 1]) }
  const goFirstScene   = () => { if (canBackScene) navigateToScene(sceneSeq[0]) }
  const goLastScene    = () => { if (canForwardScene) navigateToScene(sceneSeq[sceneSeq.length - 1]) }
  const positionLabel  = sceneIdx >= 0 ? `${sceneIdx + 1} / ${sceneSeq.length}` : '—'

  // Keyboard navigation — ArrowLeft / ArrowRight step through the filtered
  // scene sequence. Parity with EntityDetailPanel + RelationshipDetailPanel's
  // document-level listeners. Always-current ref so the document listener
  // never captures a stale closure.
  const _sceneNavRef = useRef(null)
  _sceneNavRef.current = { canBackScene, canForwardScene, goBackScene, goForwardScene }
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const el = document.activeElement
      const tag = el?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || el?.isContentEditable) return
      // Bail when the keypress originates inside a surface with its own
      // arrow-key navigation (Timeline Navigator dots / headers). Matches
      // the bail pattern in EntityChipDetailView / RelationshipDetailPanel.
      if (e.target?.closest?.('[data-dot-key]')) return
      const nav = _sceneNavRef.current
      if (e.key === 'ArrowLeft'  && nav.canBackScene)    { e.preventDefault(); nav.goBackScene() }
      if (e.key === 'ArrowRight' && nav.canForwardScene) { e.preventDefault(); nav.goForwardScene() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])  

  // Chapter label for the nav bar subtitle: resolved from this scene's
  // canvas x-position against chapter columns (null when no chapters exist,
  // no node selected, or node centre falls outside all chapter columns).
  const chapterLabel = useMemo(() => {
    if (!storyChapters || storyChapters.length === 0) return null
    if (!node) return null
    const chapterId = resolveChapterIdForNode(node, storyChapters, chapterMemberOpts)
    if (!chapterId) return null
    const idx = storyChapters.findIndex((c) => c.id === chapterId)
    if (idx < 0) return null
    const c = storyChapters[idx]
    return c.title || `Chapter ${idx + 1}`
  }, [node, storyChapters, chapterMemberOpts])

  const nodeTitle = node?.data?.title || ''
  const nodeDescription = node?.data?.description || ''

  // ── Panel-level draft (shared shell-draft hook) ─────────────────────────────
  // Scene title + description are panel-level scalar fields. They route
  // through the shared `useDetailPanelDraft` hook instead of committing
  // on blur via `updateNodeData`. Other scene-shaped affordances
  // (knowledge picker, create-relationship inline form, etc.) remain
  // commit-immediate — they're discrete actions distinct from the
  // panel-level scalar text fields.
  function _initSceneDraft() {
    return { title: nodeTitle, description: nodeDescription }
  }
  function _handleSceneSave() {
    if (!_panelDraft || !node) return
    const titleChanged = (_panelDraft.title ?? '')       !== (node.data.title ?? '')
    const descChanged  = (_panelDraft.description ?? '') !== (node.data.description ?? '')
    if (!titleChanged && !descChanged) return
    // Single snapshot before mutating so title + description edits
    // reverse together as one undo step. updateNodeData itself is
    // snapshot-free (it's also called per-pixel during resize); the
    // caller is responsible for snapshotting around discrete edits.
    useProjectStore.getState()._snapshot()
    if (titleChanged) updateNodeData(nodeId, { title: _panelDraft.title ?? '' })
    if (descChanged)  updateNodeData(nodeId, { description: _panelDraft.description ?? '' })
  }
  function _handleSceneDiscard() {
    setEditingTitle(false)
  }
  const _sceneDraftKey = nodeId ? `scene:${nodeId}` : null
  const _sceneDraftHandle = useDetailPanelDraft({
    draftKey: _sceneDraftKey,
    save: () => _handleSceneSave(),
    discard: () => _handleSceneDiscard(),
  })
  const _panelDraft   = _sceneDraftHandle.draft
  const setPanelDraft = _sceneDraftHandle.setDraft
  const isPanelDirty  = _sceneDraftHandle.isDirty

  // Field accessors — read from draft when dirty, fall back to node data.
  const localTitle       = (isPanelDirty && _panelDraft?.title       != null) ? _panelDraft.title       : nodeTitle
  const localDescription = (isPanelDirty && _panelDraft?.description != null) ? _panelDraft.description : nodeDescription
  function setLocalTitle(val) {
    setPanelDraft((d) => ({ ..._initSceneDraft(), ...(d || {}), title: val }))
  }
  function setLocalDescription(val) {
    setPanelDraft((d) => ({ ..._initSceneDraft(), ...(d || {}), description: val }))
  }
  const [showCreateRel, setShowCreateRel] = useState(false)
  const [newRelName, setNewRelName] = useState('')
  const [knowledgePickerOpen, setKnowledgePickerOpen] = useState(false)
  const [showCreateKnowledge, setShowCreateKnowledge] = useState(false)
  const [newKnowledgeName, setNewKnowledgeName] = useState('')
  const [editingTitle, setEditingTitle] = useState(false)
  const titleInputRef = useRef(null)
  useEffect(() => {
    if (editingTitle && titleInputRef.current) {
      titleInputRef.current.focus()
      titleInputRef.current.select()
    }
  }, [editingTitle])

  // Knowledges whose chain includes this scene — same rule the scene's
  // Knowledge chips use (history entry at this scene OR a manual anchor
  // on it). Phase 1.21c.
  const sceneKnowledges = useMemo(() => {
    if (!nodeId || !allKnowledges) return []
    return allKnowledges.filter((k) => {
      const order = getKnowledgeNodeOrder(k, nodes, edges, storyOrder)
      return order.includes(nodeId)
    })
  }, [nodeId, allKnowledges, nodes, edges, storyOrder])

  const sceneKnowledgeIds = useMemo(
    () => new Set(sceneKnowledges.map((k) => k.id)),
    [sceneKnowledges],
  )

  // Relationships where ALL participants are present in this scene, or a change was recorded here.
  const sceneRelationships = useMemo(() => {
    if (!node) return []
    const entityIds = new Set(
      ENTITY_BUCKETS.flatMap((b) => node.data[b] || []).map((r) => r.entity_id)
    )
    const modifiedHere = relationshipsByScene[nodeId] || new Set()
    return allRelationships.filter((rel) => {
      if (modifiedHere.has(rel.id)) return true
      // History-only: derive participant ids from `join` events in history.
      const joinIds = Array.from(new Set(
        (rel.history?.participant_changes || [])
          .filter((c) => c.action === 'join')
          .map((c) => c.entity_id)
      ))
      if (joinIds.length === 0) return false
      return joinIds.every((eid) => entityIds.has(eid))
    })
  }, [node, nodeId, allRelationships, relationshipsByScene])

  function getPanelEntity(id) {
    for (const bucket of [entCharsP, entLocsP, entItemsP, entFacsP, entCustsP, allKnowledges || []]) {
      const found = bucket.find((e) => e.id === id)
      if (found) return found
    }
    return null
  }
  const DEFAULT_DESC_HEIGHT = 58
  const [descHeight, setDescHeight] = useState(DEFAULT_DESC_HEIGHT)

  // Description-area resize state resets on subject change. The draft
  // slot reset is handled by the `useDetailPanelDraft` hook (via its
  // `draftKey` prop), so the title / description local accessors above
  // automatically pick up the new node's values whenever the user
  // navigates between scenes.
  useEffect(() => {
    setDescHeight(DEFAULT_DESC_HEIGHT)
  }, [nodeId])

  if (!node) return <div className="p-3 text-xs text-zinc-600 italic">No scene selected.</div>

  const allRefs = ENTITY_BUCKETS.flatMap((b) => node.data[b] || [])

  function navigateToChip(ref) {
    const chain = getEntityNarrativeChain(ref.entity_id, nodes, edges)
    const idx   = chain.findIndex((n) => n.id === nodeId)
    setDetailPanel('entityChip', nodeId, ref.entity_id, idx)
  }

  // On-blur commits replaced by the panel-level draft + Save bar.
  // commitTitle / commitDescription kept as no-op shims so the JSX
  // onBlur references don't need to change shape; the actual commit
  // happens via `_handleSceneSave` when the user clicks Save.
  function commitTitle() { /* no-op: commit via panel Save bar */ }
  function commitDescription() { /* no-op: commit via panel Save bar */ }

  return (
    <DetailPanelShell
      navBar={(
      <DetailPanelNavBar
        contextBadge={
          <span className="flex items-center gap-1 bg-purple-900/30 px-1.5 py-0.5 rounded min-w-0">
            <span className="text-[9px] text-purple-400 uppercase tracking-widest font-semibold flex-shrink-0">SCENE</span>
            <span className="text-[9px] text-zinc-100 uppercase tracking-widest font-semibold truncate">: {node?.data?.title || 'Scene'}</span>
          </span>
        }
        chapterLabel={chapterLabel}
        canUp={false}
        onUp={null}
        canBack={canBackScene}
        onBack={goBackScene}
        onFirst={goFirstScene}
        canForward={canForwardScene}
        onForward={goForwardScene}
        onLast={goLastScene}
        position={positionLabel}
        onFocus={focusNode ? () => focusNode(nodeId) : undefined}
        leftSlot={(
          <PovNavToggleButton
            hasAnyPov={hasAnyPov}
            povNavOnly={povNavOnly}
            onToggle={handleTogglePovNavOnly}
            povColor={povColor}
          />
        )}
      />
      )}
      bodyPadding=""
      header={(
        /* Scene header — shared identity-header shell. Scenes have no
           avatar / profile image so Row 2 is omitted; the shell keeps the
           reserved minHeight so the title row lands at the same screen
           position as the name rows in the entity / relationship / knowledge
           panels. Title is click-to-edit: display-div by default; switches
           to a fixed-width input on click, commits on blur / Enter,
           cancels on Escape. Lives in the shell's `header` slot (above
           the sub-tabs) so the SCENE / DETAILS / CHANGES tab strip sits
           below the identity row, matching the layout in every other
           detail panel. */
        <DetailPanelIdentityHeader
          typeLabel="SCENE"
          nameSlot={editingTitle ? (
            <input
              ref={titleInputRef}
              className="text-sm font-medium text-zinc-100 leading-tight w-36 bg-transparent border-b border-accent-500 focus:outline-none"
              value={localTitle}
              placeholder="Untitled"
              onChange={(e) => setLocalTitle(e.target.value)}
              onBlur={(e) => { commitTitle(e.target.value); setEditingTitle(false) }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); e.target.blur() }
                if (e.key === 'Escape') { setLocalTitle(node?.data?.title || ''); setEditingTitle(false) }
              }}
            />
          ) : (
            <div
              className="text-sm font-medium text-zinc-100 leading-tight truncate min-w-0 cursor-text hover:opacity-75"
              onClick={() => setEditingTitle(true)}
              title="Click to edit title"
            >
              {localTitle || <span className="text-zinc-600 italic">Untitled</span>}
            </div>
          )}
          cornerAction={
            <AttachToChatButton
              kind="scene"
              id={nodeId}
              title="Add this scene as context to the open conversation"
            />
          }
        />
      )}
      subTabs={(
        <div data-help-region="detail-scene:subtabs" className="contents">
          <DetailPanelSubTabs
            tabs={SCENE_SUB_TABS}
            active={subTab}
            onChange={setStoreSubTab}
          />
        </div>
      )}
      body={subTab === 'changes' ? (
        <div data-help-region="detail-scene:changes_body" className="contents">
          <SceneChangesView nodeId={nodeId} />
        </div>
      ) : subTab === 'circumstances' ? (
        <SceneCircumstancesView nodeId={nodeId} />
      ) : (<>
        {/* Description field with drag-resizable bottom edge */}
        <div className="px-3 pt-2 pb-0 flex-shrink-0" data-help-region="detail-scene:details_description">
          <DescriptionEditor
            value={localDescription}
            onChange={setLocalDescription}
            onBlur={(e) => commitDescription(e.target.value)}
            placeholder="Scene description..."
            resize="none"
            textareaStyle={{ height: descHeight }}
            containerClassName=""
          />
        </div>
        {/* Drag handle to resize description */}
        <div
          className="h-1.5 cursor-row-resize border-b border-zinc-700 hover:bg-accent-700/30 transition-colors flex-shrink-0"
          onMouseDown={(e) => {
            e.preventDefault()
            const startY = e.clientY
            const startH = descHeight
            function onMove(ev) {
              const newH = Math.max(40, Math.min(300, startH + ev.clientY - startY))
              setDescHeight(newH)
            }
            function onUp() {
              document.removeEventListener('mousemove', onMove)
              document.removeEventListener('mouseup', onUp)
              document.body.style.cursor = ''
              document.body.style.userSelect = ''
            }
            document.body.style.cursor = 'row-resize'
            document.body.style.userSelect = 'none'
            document.addEventListener('mousemove', onMove)
            document.addEventListener('mouseup', onUp)
          }}
        />

        {/* Scene time row — same chip rendered on the canvas card.
            Reuses `SceneTimeRow` so the two surfaces stay
            byte-for-byte identical and the master toggle gating /
            modal-trigger behaviour is shared. Sits between the
            description block and the entity sections. */}
        <div data-help-region="detail-scene:details_time" className="contents">
          <SceneTimeRow sceneId={nodeId} sceneData={node.data} />
        </div>
        {/* Visual divider between the time row and the entities
            section. Hidden when the row itself is gated off (master
            toggle disabled) so we don't leave a dangling line. */}
        {timeTrackingEnabledForDivider && (
          <div className="border-b border-zinc-800" />
        )}

        {/* Entity chip list, grouped by type with subtle section headers */}
        <div className="p-2" data-help-region="detail-scene:details_entities">
          {allRefs.length === 0 ? (
            <div className="text-xs text-zinc-600 italic p-2">No entities in this scene.</div>
          ) : (
            ENTITY_BUCKETS
              .map((bucket) => [bucket, node.data[bucket] || []])
              .filter(([, refs]) => refs.length > 0)
              .map(([bucket, refs], idx) => (
                <div key={bucket} className={idx > 0 ? 'mt-2 pt-2 border-t border-zinc-800' : ''}>
                  <div className="text-[9px] text-zinc-600 uppercase tracking-wider py-1 flex items-center gap-1">
                    <span aria-hidden="true">{TYPE_ICONS[bucket.slice(0, -1)]}</span>
                    <span>{SCENE_BUCKET_LABELS[bucket]}</span>
                  </div>
                  {refs.map((ref) => (
                    <ChipRow key={ref.entity_id} entityRef={ref} nodeId={nodeId} nodes={nodes} edges={edges} onClick={() => navigateToChip(ref)} />
                  ))}
                </div>
              ))
          )}
        </div>

        {/* Relationships section — all relationships whose participants include an entity in this scene */}
        <div className="p-2 border-t border-zinc-800 mt-1" data-help-region="detail-scene:details_relationships">
          <div className="text-[9px] text-zinc-500 uppercase tracking-wider mb-1">Relationships</div>
          {showCreateRel && (
            <div className="mb-2 flex gap-1">
              <input
                className="flex-1 bg-zinc-800 border border-zinc-600 rounded px-2 py-0.5 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-accent-500"
                placeholder="Relationship name (optional)..."
                value={newRelName}
                onChange={(e) => setNewRelName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    createRelationship({ name: newRelName.trim() || null, history: createEmptyRelationshipHistory({ bornAtSceneId: nodeId }) })
                    setNewRelName(''); setShowCreateRel(false)
                  }
                  if (e.key === 'Escape') { setShowCreateRel(false); setNewRelName('') }
                }}
                autoFocus
              />
              <button
                className="px-2 py-0.5 rounded bg-accent-700/30 border border-accent-700/50 text-accent-300 text-xs hover:bg-accent-700/50"
                onClick={() => {
                  createRelationship({ name: newRelName.trim() || null, history: createEmptyRelationshipHistory({ bornAtSceneId: nodeId }) })
                  setNewRelName(''); setShowCreateRel(false)
                }}
              >✓</button>
            </div>
          )}
          {sceneRelationships.length === 0 && !showCreateRel ? (
            <div className="text-xs text-zinc-600 italic">No relationships involve entities in this scene. Wire entity chips together or use + Add Relationship below.</div>
          ) : (
            sceneRelationships.map((rel) => {
              // History-only: derive participants from `join` events.
              const pts = Array.from(new Set(
                (rel.history?.participant_changes || [])
                  .filter((c) => c.action === 'join')
                  .map((c) => c.entity_id)
              )).map((eid) => ({ entity_id: eid }))
              const resolveNameHere = (eid) => {
                const ent = getPanelEntity(eid)
                if (!ent) return null
                const s = computeEffectiveState(ent, nodes, edges, nodeId)
                return s?.name || ent.name || null
              }
              const relLabel = rel.name
                || (pts.length > 0
                  ? participantsFallbackLabel(pts, getPanelEntity, 3, rel, resolveNameHere)
                  : '(no participants)')
              const hasNoParticipants = pts.length === 0
              const modifiedHere = (relationshipsByScene[nodeId] || new Set()).has(rel.id)
              return (
                <div
                  key={rel.id}
                  className="group flex items-center gap-1.5 py-0.5 px-1 rounded text-xs text-zinc-300 hover:bg-zinc-800/60 cursor-pointer"
                  onClick={() => _sceneDraftHandle.tryProceed(() => openRelationshipDetail(rel.id, nodeId))}
                >
                  <RelationshipIcon size={11} />
                  <span className="flex-1 min-w-0 text-[10px]" title={relLabel}>
                    {hasNoParticipants
                      ? (rel.name || '(no participants)')
                      : (
                        <RelationshipLabelStack
                          name={rel.name}
                          participants={pts}
                          getEntity={getPanelEntity}
                          sliceMax={3}
                          rel={rel}
                        />
                      )
                    }
                  </span>
                  {/* Participant badges */}
                  <div className="flex items-center gap-0.5 flex-shrink-0">
                    {pts.slice(0, 4).map((p) => {
                      const ent = getPanelEntity(p.entity_id)
                      if (!ent) return null
                      const colour = ent.colour || '#888'
                      const asset = ent.profile_image_ref ? ent.profile_image_ref.replace(/^assets\//, '') : null
                      const inner = (
                        <span
                          key={p.entity_id}
                          className="inline-flex items-center justify-center flex-shrink-0 rounded-sm"
                          style={{ width: 12, height: 12, backgroundColor: asset ? 'transparent' : colour + '22', border: `1.5px solid ${colour}` }}
                          title={ent.name}
                        >
                          {asset
                            ? <img src={`/api/project/assets/${asset}`} alt="" className="w-full h-full rounded-sm object-cover" />
                            : <span style={{ fontSize: 7, lineHeight: 1 }}>{TYPE_ICONS[ent.type] || '?'}</span>}
                        </span>
                      )
                      return asset
                        ? <ImageHoverPreview key={p.entity_id} src={`/api/project/assets/${asset}`} borderColour={colour} size={64}>{inner}</ImageHoverPreview>
                        : inner
                    })}
                    {pts.length > 4 && <span className="text-[9px] text-zinc-500 pl-0.5">+{pts.length - 4}</span>}
                  </div>
                  {modifiedHere && (
                    <span className="text-[8px] text-amber-400/70 flex-shrink-0" title="Modified at this scene">✱</span>
                  )}
                  {/* Delete button */}
                  <button
                    className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-red-400 text-[10px] flex-shrink-0 transition-opacity nodrag"
                    title="Delete relationship"
                    onClick={async () => {
                      const ok = await confirm({
                        title: 'Delete relationship',
                        message: buildDeleteRelationshipMessage({ rel, getEntity: getPanelEntity, resolveName: resolveNameHere }),
                        buttons: [{ label: 'Delete', value: 'delete', style: 'danger' }, { label: 'Cancel', value: 'cancel', style: 'default' }],
                      })
                      if (ok === 'delete') deleteObject('relationship', rel.id)
                    }}
                  >✕</button>
                </div>
              )
            })
          )}
          {!showCreateRel && (
            <button
              onClick={() => setShowCreateRel(true)}
              className="w-full text-[9px] text-accent-400/70 hover:text-accent-300 py-1 border border-dashed border-zinc-700 hover:border-zinc-500 rounded transition-colors mt-1"
            >
              + Add Relationship
            </button>
          )}
        </div>

        {/* Knowledge section — all knowledges whose chain includes this
            scene. Phase 1.21c. "+ Add Knowledge" opens the picker with
            scene-present knowledges excluded; picking one adds a manual
            anchor at this scene (chip auto-spawns). A "+ Create new
            Knowledge" inline form below that spawns a brand-new
            Knowledge and anchors it here in one action. */}
        <div className="p-2 border-t border-zinc-800 mt-1" data-help-region="detail-scene:details_knowledge">
          <div className="text-[9px] uppercase tracking-wider mb-1" style={{ color: `${KNOWLEDGE_COLOUR}b3` }}>Knowledge</div>

          {sceneKnowledges.length === 0 && !knowledgePickerOpen && !showCreateKnowledge ? (
            <div className="text-xs text-zinc-600 italic">No knowledges anchored to this scene yet. Use + Add Knowledge below.</div>
          ) : (
            sceneKnowledges.map((k) => {
              const colour = k.colour || KNOWLEDGE_COLOUR
              const assetName = k.profile_image_ref ? k.profile_image_ref.replace(/^assets\//, '') : null
              return (
                <div
                  key={k.id}
                  className="group flex items-center gap-1.5 py-0.5 px-1 rounded text-xs text-zinc-300 hover:bg-zinc-800/60 cursor-pointer"
                  onClick={() => openKnowledgeDetail(k.id, nodeId)}
                >
                  <span
                    className="inline-flex items-center justify-center flex-shrink-0 rounded-sm overflow-hidden"
                    style={{ width: 14, height: 14, border: `1.5px solid ${colour}`, backgroundColor: assetName ? 'transparent' : `${colour}22` }}
                  >
                    {assetName ? (
                      <img src={`/api/project/assets/${assetName}`} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <span style={{ fontSize: 9, lineHeight: 1 }}>📜</span>
                    )}
                  </span>
                  <span className="flex-1 min-w-0 text-[10px] truncate" style={{ color: colour }} title={k.name || '(unnamed)'}>
                    {k.name || <em className="text-zinc-600">(unnamed)</em>}
                  </span>
                  <button
                    className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-red-400 text-[12px] font-bold leading-none flex-shrink-0 transition-opacity nodrag"
                    title="Remove from this scene (strips manual anchor)"
                    onClick={(e) => {
                      e.stopPropagation()
                      removeKnowledgeManualAnchor(k.id, nodeId)
                    }}
                  >−</button>
                </div>
              )
            })
          )}

          {knowledgePickerOpen && (
            <div className="mt-1">
              <KnowledgePickerPopover
                allKnowledges={allKnowledges || []}
                excludeIds={sceneKnowledgeIds}
                onPick={(kid) => {
                  addKnowledgeManualAnchor(kid, nodeId)
                  setKnowledgePickerOpen(false)
                }}
                onClose={() => setKnowledgePickerOpen(false)}
              />
            </div>
          )}

          {showCreateKnowledge && (() => {
            // Re-entrancy guard: the create flow is async (POST + local
            // append). Without clearing UI state synchronously before the
            // await, a second Enter / click landing during the in-flight
            // request would fire a second create. Hide the form +
            // input-name FIRST, then kick off the create as fire-and-forget.
            // Combined `createKnowledgeAtScene` action takes a single
            // snapshot so undo reverts the create + anchor in one step.
            const submit = () => {
              const name = newKnowledgeName.trim()
              if (!name) return
              setNewKnowledgeName('')
              setShowCreateKnowledge(false)
              createKnowledgeAtScene({ name }, nodeId)
            }
            return (
              <div className="mt-1 flex gap-1">
                <input
                  className="flex-1 bg-zinc-800 border border-zinc-600 rounded px-2 py-0.5 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none"
                  placeholder="New knowledge name..."
                  value={newKnowledgeName}
                  onChange={(e) => setNewKnowledgeName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); submit() }
                    if (e.key === 'Escape') { setShowCreateKnowledge(false); setNewKnowledgeName('') }
                  }}
                  autoFocus
                  style={{ borderColor: `${KNOWLEDGE_COLOUR}55` }}
                />
                <button
                  className="px-2 py-0.5 rounded text-xs"
                  style={{ backgroundColor: `${KNOWLEDGE_COLOUR}33`, border: `1px solid ${KNOWLEDGE_COLOUR}66`, color: KNOWLEDGE_COLOUR }}
                  onClick={submit}
                >✓</button>
              </div>
            )
          })()}

          {!knowledgePickerOpen && !showCreateKnowledge && (
            <div className="flex gap-1 mt-1">
              <button
                onClick={() => setKnowledgePickerOpen(true)}
                className="flex-1 text-[9px] py-1 border border-dashed rounded transition-colors"
                style={{ color: `${KNOWLEDGE_COLOUR}cc`, borderColor: `${KNOWLEDGE_COLOUR}44` }}
              >
                + Add Knowledge
              </button>
              <button
                onClick={() => setShowCreateKnowledge(true)}
                className="flex-1 text-[9px] py-1 border border-dashed rounded transition-colors"
                style={{ color: `${KNOWLEDGE_COLOUR}cc`, borderColor: `${KNOWLEDGE_COLOUR}44` }}
                title="Create a new Knowledge and anchor it to this scene"
              >
                + New Knowledge
              </button>
            </div>
          )}
        </div>
      </>)}
      footer={(<>
        {/* Pinned footer — Open/Close Scene Content Editor */}
        <div className="border-t border-zinc-700 p-2 flex-shrink-0">
          <button
            onClick={() => rightSidebarOpen ? closeRightSidebar() : openRightSidebar(nodeId)}
            className="w-full px-2 py-1.5 text-xs rounded bg-accent-700/20 border border-accent-700/40 text-accent-300 hover:bg-accent-700/40 hover:text-accent-200 transition-colors"
          >
            ✎ Scene Content
          </button>
        </div>
        {/* Panel-level draft Save / Discard bar (shared shell-draft hook).
            Renders BELOW the bottom-most footer button — matching the
            Entity panel's footer order so the save bar is always in the
            same place regardless of which detail panel is showing. */}
        <DraftSaveBar isDirty={isPanelDirty} onSave={_sceneDraftHandle.save} onDiscard={_sceneDraftHandle.discard} />
      </>)}
    />
  )
}

export default SceneDetailView
