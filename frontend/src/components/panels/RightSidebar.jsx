import { useCallback, useRef, useEffect, useState, useMemo } from 'react'
import { useUiStore } from '../../store/uiStore'
import { useProjectStore } from '../../store/projectStore'
import { useEntitiesStore } from '../../store/entitiesStore'
import { useContextCuesStore } from '../../store/contextCuesStore'
import { useMcpControlStore } from '../../store/mcpControlStore'
import { getEntityNarrativeChain } from '../../utils/narrativeChain'
import { computePovChain } from '../../utils/povSequence'
import { buildSceneAnchoredNameTargets, buildStoryWideNameTargets } from '../ui/EntityHighlightPlugin'
import RichTextEditor from '../ui/RichTextEditor'
import { SceneDescriptionToggle, SceneDescriptionBody } from './SceneDescriptionSection'
import { NodeBadge, CueLabelChip } from '../ui/IdentityBadges'
import { EditorSurfaceProvider } from '../ui/EditorSurfaceContext'
import { ROW_HEIGHT_PX } from '../canvas/ChapterColumnsOverlay'

const MIN_WIDTH = 280
// Dynamic max — leave enough room on the canvas for the top-left toolbar
// (undo / redo / "+" + tidy-wires dot) plus a usable canvas viewport, so
// growing the sidebar can't push those buttons out of reach. Recomputed
// against the current viewport on every drag tick so resize windows track
// the cap automatically.
const MIN_CANVAS_WIDTH = 320
function getMaxWidth() {
  return Math.max(MIN_WIDTH, window.innerWidth - MIN_CANVAS_WIDTH)
}

// ── Resize handle (left edge) ───────────────────────────────────────────────

function ResizeHandle({ onResize }) {
  const dragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  const handleMouseDown = useCallback((e) => {
    e.preventDefault()
    dragging.current = true
    startX.current = e.clientX
    startWidth.current = useUiStore.getState().rightSidebarWidth

    function onMouseMove(ev) {
      if (!dragging.current) return
      // Dragging LEFT increases width (panel is on the right)
      const delta = startX.current - ev.clientX
      const newWidth = Math.min(getMaxWidth(), Math.max(MIN_WIDTH, startWidth.current + delta))
      onResize(newWidth)
    }

    function onMouseUp() {
      dragging.current = false
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [onResize])

  return (
    <div
      onMouseDown={handleMouseDown}
      className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-accent-700/40 transition-colors z-10"
    />
  )
}

// ── Right Sidebar ───────────────────────────────────────────────────────────

/**
 * Editor panel. Despite the legacy "RightSidebar" filename, this component
 * now renders the editor in whichever dock zone its `zone` prop matches.
 * Pass `zone="right"` to render as the right-sidebar editor (the original
 * behaviour); pass `zone="bottom"` to render inside the BottomZone wrapper.
 * The component returns null when the stored `editorZone` doesn't match
 * the prop, so the same component can be rendered in both App.jsx (with
 * `zone="right"`) and BottomZone (with `zone="bottom"`) and only the
 * matching one actually paints. Default `zone` is 'right' for backwards
 * compatibility with callers that don't specify.
 */
export default function RightSidebar({ zone = 'right', share }) {
  const open = useUiStore((s) => s.rightSidebarOpen)
  const storedZone = useUiStore((s) => s.editorZone)
  const nodeId = useUiStore((s) => s.rightSidebarNodeId)
  const entityNotesId = useUiStore((s) => s.rightSidebarEntityNotesId)
  const knowledgeNotesId = useUiStore((s) => s.rightSidebarKnowledgeNotesId)
  const textAttachment = useUiStore((s) => s.rightSidebarTextAttachment)
  // Phase 2.6 — Context Cue body edit mode. The cue's body lives
  // program-level in `contextCuesStore` (preferences, never on the
  // chain); the right-sidebar editor uses the same RichTextEditor
  // surface as scene main_content and writes back via the cues
  // store's `saveCues` whole-list-replace endpoint.
  const contextCueId = useUiStore((s) => s.rightSidebarContextCueId)
  const width = useUiStore((s) => s.rightSidebarWidth)
  const closeRightSidebar = useUiStore((s) => s.closeRightSidebar)
  const setRightSidebarWidth = useUiStore((s) => s.setRightSidebarWidth)
  // MCP session edit-lock — passed down to RichTextEditor as
  // `readOnly` so the user can still OPEN the editor and READ
  // what the AI is writing into a scene's main content (and
  // scroll, select text, switch between scenes via the canvas)
  // without being able to change anything. Declared HERE at the
  // top of the component, BEFORE the `if (!open) return null`
  // early return below — Rules of Hooks: every hook must run
  // unconditionally on every render, regardless of whether the
  // component renders content or returns null. Placing this hook
  // after the early return caused a "Rendered more hooks than
  // during the previous render" crash the moment the user
  // opened the editor (v0.2.1.37 regression, fixed in 0.2.1.38).
  const isMcpEditLocked = useMcpControlStore((s) => s.sessionState === 'active')
  // Phase 1.24c — editor scene-pin
  const editorPinnedSceneId = useUiStore((s) => s.editorPinnedSceneId)
  const toggleEditorPinned = useUiStore((s) => s.toggleEditorPinned)

  const nodes = useProjectStore((s) => s.nodes)
  const edges = useProjectStore((s) => s.edges)
  const updateNodeData = useProjectStore((s) => s.updateNodeData)
  const updateKnowledge = useProjectStore((s) => s.updateKnowledge)
  const knowledges     = useProjectStore((s) => s.knowledges)

  // Find the selected node (scene or reference note mode)
  const node = nodeId ? nodes.find((n) => n.id === nodeId) : null
  const nodeData = node?.data
  const isSceneNode = node?.type === 'sceneNode'
  // Phase 8.1 , 'concept' is note-like (same rich-text editor as a note),
  // so the reference-note editor path covers both note and concept.
  const isReferenceNote = node?.type === 'referenceNode' && (nodeData?.sub_type === 'note' || nodeData?.sub_type === 'concept')

  // Entity notes mode — look up entity by id
  const isEntityNotes = !!entityNotesId
  const notesEntity = useMemo(() => {
    if (!entityNotesId) return null
    const s = useEntitiesStore.getState()
    for (const bucket of [s.characters, s.locations, s.items, s.factions, s.customs, s.knowledges || []]) {
      const found = bucket.find((e) => e.id === entityNotesId)
      if (found) return found
    }
    return null
  }, [entityNotesId])
  // Subscribe to live entity updates so the editor reflects the latest saved notes
  const liveNotes = useEntitiesStore((s) => {
    if (!entityNotesId) return null
    for (const bucket of [s.characters, s.locations, s.items, s.factions, s.customs, s.knowledges || []]) {
      const found = bucket.find((e) => e.id === entityNotesId)
      if (found) return found.notes || ''
    }
    return null
  })

  // Knowledge notes mode — look up Knowledge by id from projectStore
  // (canonical source post-1.21c refactor; entitiesStore.knowledges is
  // legacy and not the source of truth for first-class Knowledge objects).
  const isKnowledgeNotes = !!knowledgeNotesId
  const notesKnowledge = useMemo(() => {
    if (!knowledgeNotesId) return null
    return (knowledges || []).find((k) => k.id === knowledgeNotesId) || null
  }, [knowledgeNotesId, knowledges])
  const liveKnowledgeNotes = notesKnowledge?.notes || ''

  // Phase 2.6 — Context Cue mode. Look up the cue by id from the
  // contextCuesStore; subscribe to the cues array so an external
  // edit (rename / body update from another surface, future MCP
  // tool, etc.) refreshes the editor automatically.
  const isContextCue = !!contextCueId
  const allCues = useContextCuesStore((s) => s.cues)
  const contextCue = useMemo(() => {
    if (!contextCueId) return null
    return allCues.find((c) => c.id === contextCueId) || null
  }, [contextCueId, allCues])
  const liveCueBody = contextCue?.body || ''

  // Entity highlight toggle (Phase 2.9c v0.2.9.39 — lifted out of
  // local `useState` so the PBH prompt textarea — now a TipTap-based
  // `ChatComposerTipTapInput` — can share the same on/off state).
  // localStorage-persisted; default TRUE matches the legacy
  // useState(true) initialiser. Renamed setter helper preserved as a
  // simple inline alias so the existing onToggle call site below
  // continues to read as a toggle rather than a write.
  const highlightEntities = useUiStore((s) => s.editorHighlightEnabled)
  const setHighlightEntities = useUiStore((s) => s.setEditorHighlightEnabled)

  // Phase 2.9a item 7 — Scene Description Section expand/collapse state.
  // Collapsed by default per planning doc §1.4. The toggle button lives
  // in the editor header row (next to close); the body renders below
  // the header. State persists across scene switches so the writer's
  // preference sticks while they work.
  //
  // v0.2.9.71 — lifted from local state into `uiStore.sceneDescriptionExpanded`
  // so off-tree consumers can gate affordances on it (specifically the
  // chat panel's Apply to Editor Section picker, which only offers
  // "Scene Description" as a target when the description is currently
  // expanded — writers shouldn't be writing into a surface they can't
  // see at the moment).
  const descriptionExpanded = useUiStore((s) => s.sceneDescriptionExpanded)
  const setDescriptionExpanded = useUiStore((s) => s.setSceneDescriptionExpanded)

  // Phase 2.9d v0.2.9.42 — when the editor panel is narrow + the
  // scene name is long, the scene-badge can overflow into the
  // Description toggle on the right side of the header. Drop the
  // toggle to a second row below the header when overflow is
  // detected; lift it back inline when the panel has room.
  //
  // Implementation notes (after v0.2.9.42 jitter fix in v0.2.9.43):
  //   - Empty deps array `[]` on the effect so the ResizeObserver
  //     is constructed exactly once on mount. Without it the effect
  //     re-ran on every render, tearing down and recreating the
  //     observer, which itself triggers a callback synchronously on
  //     `.observe()` — combined with state-driven re-renders that
  //     can create an oscillation feedback loop.
  //   - Measurement uses `requestAnimationFrame` to defer until after
  //     the current layout is committed; raw measurements taken
  //     synchronously from inside the observer callback can sample
  //     a half-laid-out tree.
  //   - Threshold uses a real measured `TOGGLE_WIDTH` constant
  //     (~108px close to actual rendered button + close + gap +
  //     margin) plus a generous PAD (24px) so single-pixel reflow
  //     bumps from unrelated UI events (modal open, scrollbar
  //     appearance) don't flip the state.
  //   - The `left.scrollWidth` comparison uses a wider slack (8px)
  //     than the original 1px so layout rounding doesn't trigger
  //     spurious overflow when the badge ACTUALLY fits.
  const headerRef = useRef(null)
  const headerLeftRef = useRef(null)
  const [descToggleBelow, setDescToggleBelow] = useState(false)
  useEffect(() => {
    let rafId = null
    let lastState = descToggleBelow
    function measureNow() {
      const header = headerRef.current
      const left = headerLeftRef.current
      if (!header || !left) return
      const headerWidth = header.clientWidth
      // Real-world width of [description toggle + gap + close + ml-2].
      // Measured empirically: toggle ~80px, gap 4px, close ~16px,
      // ml-2 8px → ~108px. Round up to 120 to absorb font / chrome
      // variation across browsers without re-tuning.
      const TOGGLE_WIDTH = 120
      const PAD = 24
      const OVERFLOW_SLACK = 8
      let next = lastState
      if (lastState) {
        // Currently below. Lift back inline only when the left
        // content's natural width PLUS the toggle's room PLUS pad
        // clearly fits in the header.
        const wouldFitInline = left.scrollWidth + TOGGLE_WIDTH + PAD <= headerWidth
        next = !wouldFitInline
      } else {
        // Currently inline. Drop below when the left content is
        // truly clipped (with a slack so 1-2px rounding doesn't
        // count as overflow).
        const overflow = left.scrollWidth > left.clientWidth + OVERFLOW_SLACK
        next = overflow
      }
      if (next !== lastState) {
        lastState = next
        setDescToggleBelow(next)
      }
    }
    function scheduleMeasure() {
      if (rafId != null) return
      rafId = requestAnimationFrame(() => {
        rafId = null
        measureNow()
      })
    }
    scheduleMeasure()
    const ro = new ResizeObserver(scheduleMeasure)
    if (headerRef.current) ro.observe(headerRef.current)
    if (headerLeftRef.current) ro.observe(headerLeftRef.current)
    return () => {
      ro.disconnect()
      if (rafId != null) cancelAnimationFrame(rafId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Pull all four entity buckets + the cue list so the target
  // builders have full story / program-level coverage. Project
  // knowledges + relationships ride on `useProjectStore` already
  // pulled above.
  const characters = useEntitiesStore((s) => s.characters)
  const locations  = useEntitiesStore((s) => s.locations)
  const items      = useEntitiesStore((s) => s.items)
  const factions   = useEntitiesStore((s) => s.factions)
  const customs    = useEntitiesStore((s) => s.customs)
  const relationships = useProjectStore((s) => s.relationships)
  const cues = useContextCuesStore((s) => s.cues)

  // Build name targets for the editor's highlight system.
  //
  // Branch on what the editor is currently editing:
  //   - Scene node body  → `buildSceneAnchoredNameTargets`. Every
  //     chain-tracked kind (entity / knowledge / relationship)
  //     is resolved to its state AT THIS SCENE; cues (no chain)
  //     emit baseline. Same chain-state-at-scene semantics the
  //     scene editor has always used, just extended to the new
  //     kinds the editor's flyout exposes.
  //   - Anything else (cue body, reference / entity / knowledge
  //     notes) → `buildStoryWideNameTargets`. These bodies aren't
  //     scene-anchored; the writer wants the same "every name an
  //     object has ever been known by" coverage the chat composer
  //     has.
  //
  // `allTypes` passes every kind through; the actual per-type
  // filter (writer's flyout state) lives inside RichTextEditor
  // where it's applied just before `refreshEntityHighlights`.
  const nameTargets = useMemo(() => {
    if (!highlightEntities) return []
    const allTypes = {
      character: true, location: true, item: true, faction: true, custom: true,
      knowledge: true, relationship: true, cue: true,
    }
    const fullState = {
      entities: { characters, locations, items, factions, customs },
      project:  { knowledges, relationships, nodes, edges },
      cues:     { cues },
    }
    if (isSceneNode && nodeId) {
      return buildSceneAnchoredNameTargets(allTypes, fullState, nodeId)
    }
    return buildStoryWideNameTargets(allTypes, fullState)
  }, [
    highlightEntities, isSceneNode, nodeId,
    characters, locations, items, factions, customs,
    knowledges, relationships, nodes, edges, cues,
  ])

  // Debounced update: store the latest content and flush on a timer
  const pendingContent = useRef(null)
  const debounceTimer = useRef(null)

  // Determine which field to update based on node type
  const contentField = isSceneNode ? 'main_content' : 'content'
  const rawContent = isSceneNode ? (nodeData?.main_content || '') : (nodeData?.content || '')
  // For plain text reference notes being opened in the editor for the first time,
  // convert newlines to HTML paragraphs so TipTap renders them as separate blocks
  // Phase 2.5e — read-only text-attachment viewer. When the writer
  // clicks a text-file pill on a chat message bubble, this mode
  // takes precedence over any other open content and renders the
  // file's text as a TipTap code block (monospace + line preserve).
  const isTextAttachment = !!textAttachment

  // Phase 2.9b — the editor's current surface tuple, shared with both
  // the EditorSurfaceProvider (consumed by TipTap NodeViews like the
  // Section's Attach-to-Chat button) and the uiStore slot
  // `currentEditorSurface` (consumed by the chat panel's Apply menu).
  // Text-attachment mode has no host object so the tuple is null and
  // both consumers are gated off in that case.
  const editorSurface = useMemo(() => {
    if (isTextAttachment) return null
    if (isSceneNode && nodeId) return { surface_type: 'scene_main', surface_host_id: nodeId }
    if (isContextCue && contextCueId) return { surface_type: 'cue_body', surface_host_id: contextCueId }
    if (isReferenceNote && nodeId) return { surface_type: 'reference_note', surface_host_id: nodeId }
    if (isEntityNotes && entityNotesId) return { surface_type: 'entity_notes', surface_host_id: entityNotesId }
    if (isKnowledgeNotes && knowledgeNotesId) return { surface_type: 'knowledge_notes', surface_host_id: knowledgeNotesId }
    return null
  }, [
    isTextAttachment,
    isSceneNode, nodeId,
    isContextCue, contextCueId,
    isReferenceNote,
    isEntityNotes, entityNotesId,
    isKnowledgeNotes, knowledgeNotesId,
  ])

  // Publish the current editor surface to uiStore so the chat panel
  // can read it without having a direct ref to this component. Cleared
  // to null on unmount so a chat opened later doesn't see a stale
  // value from a closed editor.
  useEffect(() => {
    useUiStore.getState().setCurrentEditorSurface(editorSurface)
    return () => {
      useUiStore.getState().setCurrentEditorSurface(null)
    }
  }, [editorSurface])

  const currentContent = useMemo(() => {
    if (isTextAttachment) {
      const escaped = _escapeHtmlForTiptap(textAttachment.content || '')
      return `<pre><code>${escaped}</code></pre>`
    }
    if (isContextCue) return liveCueBody || ''
    if (isEntityNotes) return liveNotes || ''
    if (isKnowledgeNotes) return liveKnowledgeNotes || ''
    if (isReferenceNote && !nodeData?.is_rich_text && rawContent && !rawContent.startsWith('{') && !rawContent.startsWith('<')) {
      return rawContent.split('\n').map((line) => `<p>${line || '<br>'}</p>`).join('')
    }
    return rawContent
  }, [isTextAttachment, textAttachment, isContextCue, liveCueBody, isEntityNotes, liveNotes, isKnowledgeNotes, liveKnowledgeNotes, isReferenceNote, nodeData?.is_rich_text, rawContent])

  const flushContent = useCallback(() => {
    if (pendingContent.current === null) return
    if (isContextCue && contextCueId) {
      // Phase 2.6 / 3.4c — Context Cue body write via the per-id
      // endpoint. updateCue reads the latest cue body off the store
      // before sending so concurrent renames / reorders from other
      // surfaces don't get clobbered by a stale closure.
      useContextCuesStore.getState().updateCue(
        contextCueId,
        { body: pendingContent.current },
      ).catch(() => { /* error surfaces in the store's saveError; banner picks it up */ })
      pendingContent.current = null
      return
    }
    if (isEntityNotes && entityNotesId) {
      const s = useEntitiesStore.getState()
      let entity = null
      for (const bucket of [s.characters, s.locations, s.items, s.factions, s.customs, s.knowledges || []]) {
        entity = bucket.find((e) => e.id === entityNotesId) || entity
      }
      if (entity) s.updateEntity(entityNotesId, { ...entity, notes: pendingContent.current })
      pendingContent.current = null
      return
    }
    if (isKnowledgeNotes && knowledgeNotesId) {
      const k = (useProjectStore.getState().knowledges || []).find((kk) => kk.id === knowledgeNotesId)
      if (k) updateKnowledge(knowledgeNotesId, { ...k, notes: pendingContent.current })
      pendingContent.current = null
      return
    }
    if (nodeId) {
      const updates = { [contentField]: pendingContent.current }
      if (!isSceneNode) updates.is_rich_text = true
      updateNodeData(nodeId, updates)
      pendingContent.current = null
    }
  }, [nodeId, entityNotesId, isEntityNotes, knowledgeNotesId, isKnowledgeNotes, contextCueId, isContextCue, updateKnowledge, updateNodeData, contentField, isSceneNode])

  const handleContentUpdate = useCallback((html) => {
    pendingContent.current = html
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    debounceTimer.current = setTimeout(flushContent, 400)
  }, [flushContent])

  // Register the editor's flush callback with uiStore so callers
  // that need the latest text (e.g. opening the global search modal
  // via Ctrl+F) can drain the 400ms debounce buffer before reading
  // store state. Re-registers when `flushContent` re-binds to a new
  // closure (different nodeId / entity / knowledge).
  useEffect(() => {
    return useUiStore.getState().registerPendingEditFlusher(flushContent)
  }, [flushContent])

  // Flush on unmount or when switching nodes / entity / knowledge.
  //
  // CRITICAL: the cleanup closes over the PRIOR render's `nodeId` /
  // `entityNotesId` / `knowledgeNotesId` — which is the destination
  // that `pendingContent.current` was authored against. Reading the
  // CURRENT id from `useUiStore.getState()` here would write the
  // outgoing scene's pending HTML to the INCOMING scene's
  // `main_content` (cross-scene corruption — every Find/Replace
  // auto-advance triggers a node-swap that runs this cleanup, so
  // any not-yet-flushed typing or just-applied replace from scene A
  // would land in scene B). Use the closure-captured ids so the
  // pending edit always lands on the scene it was authored for.
  useEffect(() => {
    const flushNodeId = nodeId
    const flushEntityNotesId = entityNotesId
    const flushKnowledgeNotesId = knowledgeNotesId
    const flushContextCueId = contextCueId
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
      if (pendingContent.current !== null) {
        if (flushContextCueId) {
          // Phase 2.6 / 3.4c — cue body flush on target swap via the
          // per-id endpoint. updateCue reads current store state at
          // call time, so concurrent renames / reorders survive.
          useContextCuesStore.getState().updateCue(
            flushContextCueId,
            { body: pendingContent.current },
          ).catch(() => { /* surfaced via store saveError */ })
          pendingContent.current = null
        } else if (flushEntityNotesId) {
          const s = useEntitiesStore.getState()
          let ent = null
          for (const bucket of [s.characters, s.locations, s.items, s.factions, s.customs, s.knowledges || []]) {
            ent = bucket.find((e) => e.id === flushEntityNotesId) || ent
          }
          if (ent) s.updateEntity(flushEntityNotesId, { ...ent, notes: pendingContent.current })
          pendingContent.current = null
        } else if (flushKnowledgeNotesId) {
          const ps = useProjectStore.getState()
          const k = (ps.knowledges || []).find((kk) => kk.id === flushKnowledgeNotesId)
          if (k) ps.updateKnowledge(flushKnowledgeNotesId, { ...k, notes: pendingContent.current })
          pendingContent.current = null
        } else if (flushNodeId) {
          const currNode = useProjectStore.getState().nodes.find((n) => n.id === flushNodeId)
          const field = currNode?.type === 'sceneNode' ? 'main_content' : 'content'
          const updates = { [field]: pendingContent.current }
          if (currNode?.type === 'referenceNode') updates.is_rich_text = true
          useProjectStore.getState().updateNodeData(flushNodeId, updates)
          pendingContent.current = null
        }
      }
    }
  }, [nodeId, entityNotesId, knowledgeNotesId, contextCueId])

  // Handle click on highlighted entity name → open detail panel
  // in left sidebar. Anchor-resolution falls through three tiers:
  //   1. Current scene — if the entity has a chip here, anchor
  //      on this scene (the at-scene state the writer was just
  //      looking at).
  //   2. POV chain backtrack — otherwise walk the POV sequence
  //      backwards from this scene's POV position and use the
  //      most-recent earlier POV scene that DOES have a chip
  //      for this entity. Lets the writer click a name that
  //      isn't pinned to this scene and land on the most-recent
  //      narratively-relevant view of the entity.
  //   3. Origin — ultimate fallback when no POV-chain scene
  //      contains the entity: open the panel at the entity's
  //      origin EntityNode (chain[0]) via `mode='entityNode'`.
  const handleEntityClick = useCallback((entityId) => {
    if (!nodeId) return
    const { nodes: allNodes, edges: allEdges } = useProjectStore.getState()
    const ENTITY_BUCKETS = ['characters', 'locations', 'items', 'factions', 'customs']
    function sceneHasEntity(sceneId) {
      const scene = allNodes.find((n) => n.id === sceneId)
      if (!scene || scene.type !== 'sceneNode') return false
      return ENTITY_BUCKETS.some((b) => (scene.data?.[b] || []).some((r) => r.entity_id === entityId))
    }
    const chain = getEntityNarrativeChain(entityId, allNodes, allEdges)
    // Tier 1 — current scene.
    if (sceneHasEntity(nodeId)) {
      const idx = chain.findIndex((n) => n.id === nodeId)
      useUiStore.getState().setDetailPanel('entityChip', nodeId, entityId, idx)
      return
    }
    // Tier 2 — POV chain backtrack.
    const pov = computePovChain(allNodes, allEdges)
    const currentPovIdx = pov.sequence.findIndex((s) => s.nodeId === nodeId)
    const startIdx = currentPovIdx >= 0 ? currentPovIdx - 1 : pov.sequence.length - 1
    for (let i = startIdx; i >= 0; i--) {
      const candidateId = pov.sequence[i].nodeId
      if (sceneHasEntity(candidateId)) {
        const idx = chain.findIndex((n) => n.id === candidateId)
        useUiStore.getState().setDetailPanel('entityChip', candidateId, entityId, idx)
        return
      }
    }
    // Tier 3 — origin fallback.
    const originNode = chain[0]
    if (originNode) {
      useUiStore.getState().setDetailPanel('entityNode', originNode.id, entityId, 0)
    }
  }, [nodeId])

  if (!open || storedZone !== zone) return null

  // Header label
  const headerLabel = isTextAttachment
    ? (textAttachment.name || 'Attached file')
    : isContextCue
      ? (contextCue?.name || 'Context Cue')
      : isEntityNotes
        ? (notesEntity?.name || 'Entity')
        : isKnowledgeNotes
          ? (notesKnowledge?.name || 'Knowledge')
          : isSceneNode
            ? (nodeData?.title || 'Untitled Scene')
            : isReferenceNote
              ? (nodeData?.title || 'Untitled Note')
              : 'No content to edit'

  const placeholder = isTextAttachment
    ? ''
    : isContextCue
      ? 'Write the cue body here. Sent verbatim to the AI as part of the system prompt when this cue is pinned to a chat session.'
      : (isEntityNotes || isKnowledgeNotes)
        ? 'Write your author notes here...'
        : isSceneNode
          ? 'Write your scene content here...'
          : 'Write your reference note here...'

  const hasContent = isTextAttachment
    ? true
    : isContextCue
      ? !!contextCue
      : isEntityNotes
        ? !!notesEntity
      : isKnowledgeNotes
        ? !!notesKnowledge
        : !!(isSceneNode || isReferenceNote) && !!nodeData

  // Inner content (header + body). Shared between the right-zone and
  // bottom-zone renderings — only the outer container differs by zone.
  const innerContent = (
    <>
      {/* Header. Height locked to ROW_HEIGHT_PX (= the chapters bar row
          height) so the bar stays a consistent thickness regardless of
          whether the scene badge / pin button are showing. Without this
          the header grew taller whenever a scene was selected because the
          oversized scene badge inflated the content height. */}
      <div
        ref={headerRef}
        data-help-region="editor-panel:header"
        className={`flex items-center justify-between px-3 flex-shrink-0 overflow-hidden ${
          (hasContent && isSceneNode && descToggleBelow)
            ? ''  // border-b moves to the second row below when the toggle wraps
            : 'border-b border-zinc-700'
        }`}
        style={{ height: ROW_HEIGHT_PX }}
      >
        <div ref={headerLeftRef} className="flex items-center gap-2 min-w-0">
          <span className="text-[9px] text-accent-400 uppercase tracking-widest font-semibold bg-accent-900/30 px-1.5 py-0.5 rounded flex-shrink-0">
            {(isEntityNotes || isKnowledgeNotes) ? 'Notes' : 'Editor'}
          </span>
          {hasContent && isSceneNode && (
            // Phase 1.24c — pin button sits flush to the LEFT of the
            // scene badge so the writer reads "pin -> scene". Inactive:
            // outline-only in the scene-badge purple, transparent fill.
            // Active: vibrant filled purple so the engaged state is
            // unmistakable at a glance.
            <span className="inline-flex items-center gap-0">
              {(() => {
                const isPinned = editorPinnedSceneId === nodeId
                return (
                  <button
                    type="button"
                    onClick={toggleEditorPinned}
                    aria-pressed={isPinned}
                    data-help-region="editor-panel:pin_scene"
                    title={isPinned
                      ? 'Editor pinned to this scene. Canvas selection won\'t auto-switch the editor. Click to unpin.'
                      : 'Pin the editor to this scene so canvas selection won\'t auto-switch it.'}
                    style={{ width: 18, height: 18, padding: 0, fontSize: 11 }}
                    className={`inline-flex items-center justify-center flex-shrink-0 leading-none rounded transition-colors border ${
                      isPinned
                        ? 'bg-purple-500 border-purple-400 text-white hover:bg-purple-400'
                        : 'bg-transparent border-purple-400 text-purple-400 hover:bg-purple-900/30'
                    }`}
                  >
                    {'📍︎'}
                  </button>
                )
              })()}
              {/* Bump scene badge to ~2x its default font size by overriding
                  the badge's inner text-[10px] via a Tailwind arbitrary
                  descendant selector. Forces both the type label
                  ("SCENE") and the title text up to 20px. */}
              <span className="inline-flex items-center [&>span]:!text-[14px] [&>span]:py-0.5 [&>span]:px-1.5">
                <NodeBadge nodeId={nodeId} nodes={nodes} entityMap={undefined} />
              </span>
            </span>
          )}
          {hasContent && !isSceneNode && isContextCue && (
            // Phase 2.8 — render the cue's identity chip in the editor
            // header, matching the bumped scene-badge treatment (text
            // forced to 14px via Tailwind arbitrary descendant
            // selector) so cue/scene editor headers feel consistent.
            <span className="inline-flex items-center [&>span]:!text-[14px] [&>span]:py-0.5 [&>span]:px-1.5">
              <CueLabelChip name={headerLabel} />
            </span>
          )}
          {hasContent && !isSceneNode && !isContextCue && (
            <span className="text-sm text-zinc-300 truncate" title={headerLabel}>
              {headerLabel}
            </span>
          )}
        </div>
        <div className="inline-flex items-center gap-1 flex-shrink-0 ml-2">
          {/* Phase 2.9a item 7 — Scene Description toggle. Visible
              only on a scene. Toggles the SceneDescriptionBody
              below the header (tinted-accent background area
              between header and TipTap main_content editor).
              v0.2.9.42 — when the editor panel is narrow + the
              scene name is long, the badge can overflow into this
              toggle; in that case `descToggleBelow` is true and
              the toggle gets relocated to a second header row
              below (rendered as a sibling div under this one). */}
          {hasContent && isSceneNode && !descToggleBelow && (
            <span data-help-region="editor-panel:scene_description_toggle">
              <SceneDescriptionToggle
                expanded={descriptionExpanded}
                onToggle={() => setDescriptionExpanded((v) => !v)}
              />
            </span>
          )}
          <button
            onClick={closeRightSidebar}
            data-help-region="editor-panel:close"
            className="text-zinc-500 hover:text-zinc-200 text-sm leading-none flex-shrink-0"
            title="Close editor panel"
          >
            ✕
          </button>
        </div>
      </div>
      {/* Description-toggle overflow row. Rendered only when the
          ResizeObserver above has decided the inline toggle would
          collide with the scene badge. Hysteresis (TOGGLE_WIDTH
          buffer) prevents oscillation around the threshold. Lives
          as a sibling under the fixed-height main header row so
          the main row's height stays consistent (writers expect
          the editor's content area to start at the same offset
          when the scene name fits). */}
      {hasContent && isSceneNode && descToggleBelow && (
        // Border-b lives on this row only when the toggle has wrapped
        // down here. The main header row's border-b is removed in
        // that case (see conditional above) so the visible separator
        // sits at the bottom of the two-row stack, not between the
        // rows.
        <div className="flex justify-end items-center px-3 py-1 flex-shrink-0 border-b border-zinc-700">
          <SceneDescriptionToggle
            expanded={descriptionExpanded}
            onToggle={() => setDescriptionExpanded((v) => !v)}
          />
        </div>
      )}

      {/* Phase 2.9a item 7 — Scene Description Section body.
          Tinted-accent background area for the writer to read / edit
          `scene.description` in place. Visible only when the toggle
          above is active. Plain-text-only. See planning doc §1.4. */}
      {hasContent && isSceneNode && (
        <div data-help-region="editor-panel:scene_description">
          <SceneDescriptionBody
            expanded={descriptionExpanded}
            description={nodeData?.description || ''}
            onChange={(value) => nodeId && updateNodeData(nodeId, { description: value })}
            sceneId={nodeId}
          />
        </div>
      )}

      {/* Content. Phase 2.9b — wrap the editor in an
          EditorSurfaceProvider carrying { surface_type,
          surface_host_id } so the SectionView NodeView can dispatch
          surface-aware actions (Attach to Chat etc.) without
          prop-drilling through TipTap's NodeView boundary. The
          surface tuple is derived from whichever mode the editor is
          currently in (scene main_content / cue body / reference
          note / entity notes / knowledge notes). Text-attachment
          mode has no host object — the provider value is null and
          surface-aware actions in the NodeView bail. */}
      {hasContent ? (
        <EditorSurfaceProvider
          value={editorSurface}
        >
          <RichTextEditor
            content={currentContent}
            onUpdate={isTextAttachment ? undefined : handleContentUpdate}
            placeholder={placeholder}
            entityHighlight
            entityHighlightEnabled={highlightEntities}
            onToggleEntityHighlight={() => setHighlightEntities(!highlightEntities)}
            nameTargets={nameTargets}
            nodeId={nodeId}
            onEntityClick={handleEntityClick}
            outputJson={isReferenceNote}
            /* MCP session edit-lock OR text-attachment viewer →
               read-only. Text-attachment mode renders a TipTap code
               block from a transient chat file and must never write
               back. Toolbar hides automatically when readOnly. */
            readOnly={isMcpEditLocked || isTextAttachment}
          />
        </EditorSurfaceProvider>
      ) : (
        <div
          data-help-region="editor-panel:empty_state"
          className="flex-1 flex items-center justify-center text-zinc-600 text-sm px-4 text-center"
        >
          Select a scene node to edit its content
        </div>
      )}
    </>
  )

  if (zone === 'right') {
    // Shared-zone variant: when a `share` value is passed, the parent
    // `RightZone` provides the container's shared width, borders, and
    // outer resize handle. This panel just contributes as a flex child
    // with its share controlling main-axis distribution (width when the
    // parent is flex-row, height when flex-col). Skip own width style,
    // border-left, and resize handle.
    if (share != null) {
      return (
        <div
          className="relative min-w-0 min-h-0 bg-zinc-900 flex flex-col overflow-hidden"
          style={{ flex: share }}
        >
          {innerContent}
        </div>
      )
    }
    // Solo variant: this panel is the only one in the right zone, so it
    // owns its width, border, and left-edge resize handle.
    return (
      <div
        className="relative flex-shrink-0 bg-zinc-900 border-l border-zinc-700 flex flex-col h-full"
        style={{ width }}
        data-help-region="editor-panel:panel"
      >
        <ResizeHandle onResize={setRightSidebarWidth} />
        {innerContent}
      </div>
    )
  }

  // zone === 'bottom' — fills its share of the BottomZone container.
  // Width / height are governed by the BottomZone wrapper (flex item);
  // this outer just becomes a flex column with overflow control. `share`
  // controls the flex-grow ratio against the chat panel's complementary
  // share, so the divider between them can resize their split.
  return (
    <div
      className="relative min-w-0 min-h-0 bg-zinc-900 flex flex-col overflow-hidden"
      style={{ flex: share != null ? share : '1 1 0%' }}
    >
      {innerContent}
    </div>
  )
}


// Escape a plain-text string so it can be embedded in a TipTap
// HTML <pre><code>...</code></pre> block without TipTap trying to
// parse the contents as HTML. The 1568-px image cap helper-pattern
// guarantee doesn't apply here — this is a tiny utility used only
// by the text-attachment viewer.
function _escapeHtmlForTiptap(text) {
  if (typeof text !== 'string' || text.length === 0) return ''
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
