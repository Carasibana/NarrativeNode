import { useEffect, useRef, useState, useSyncExternalStore, lazy, Suspense } from 'react'
import axios from 'axios'
import { useProjectStore } from './store/projectStore'
import { useUiStore } from './store/uiStore'
import { useSettingsStore } from './store/settingsStore'
import { useMcpControlStore } from './store/mcpControlStore'
import { useConversationsStore } from './store/conversationsStore'
import { useProgramTagsStore } from './store/programTagsStore'
import Canvas from './components/canvas/Canvas'
import { migrateWireVisibility } from './components/canvas/WireVisibilityControl'
import EntityLibraryPanel from './components/entities/EntityLibraryPanel'
import RightZone from './components/panels/RightZone'
import BottomZone from './components/panels/BottomZone'
import AlertsPanel from './components/ui/AlertsPanel'
import McpControlButton from './components/ui/McpControlButton'
import McpSessionLockOverlay from './components/ui/McpSessionLockOverlay'
import McpDestructiveApprovalModal from './components/ui/McpDestructiveApprovalModal'
import McpCrossTabLockoutModal from './components/ui/McpCrossTabLockoutModal'
import EntityModal from './components/entities/EntityModal'
import KnowledgeModal from './components/entities/KnowledgeModal'
import AwarenessSurfacePanel from './components/entities/AwarenessSurfacePanel'
import SettingsPanel from './components/panels/SettingsPanel'
import ExportDialog from './components/panels/ExportDialog'
import ImportDialog from './components/entities/ImportDialog'
import ExportCharacterCardModal from './components/panels/ExportCharacterCardModal'
import TemplateImportDialog from './components/TemplateImportDialog'
import NovelcrafterImportDialog from './components/novelcrafter/NovelcrafterImportDialog'
import HierarchyEditorModal from './components/panels/HierarchyEditorModal'
import SceneTimeModal, { sceneNodeToDraft, draftToSceneNodePatch } from './components/panels/SceneTimeModal'
import { useScenetimeWalk, recommendedUnitForGap, sceneDurationMinutes, chainPreContextForScene } from './utils/povChainTimeWalker'
import { usePovChain } from './utils/povSequence'
import { useEntitiesStore } from './store/entitiesStore'
import { useAccentColor } from './utils/povConstants'
import FactionMemberPromptDialog from './components/entities/FactionMemberPromptDialog'
import MediaPreviewPanel from './components/preview/MediaPreviewPanel'
import InlinePromptBlock from './components/ui/InlinePromptBlock'
import MediaPreviewTrayChip from './components/preview/MediaPreviewTrayChip'
import ConfirmDialog from './components/ui/ConfirmDialog'
import AwarenessRolloverModal from './components/ui/AwarenessRolloverModal'
import AddKnowledgeFromChangePopover from './components/ui/AddKnowledgeFromChangePopover'
import ImageCropHost from './components/ui/ImageCropHost'
// F#9: lazy-loaded so its transitive deps (TipTap extensions,
// IdentityBadges, scene-context tooling, chain-walker presentation
// helpers) only download when the writer first opens the panel via
// Ctrl+`. Until then it stays out of the initial JS bundle.
const DevPreviewPanel = lazy(() => import('./components/ui/DevPreviewPanel'))
import { confirm } from './store/dialogStore'
import { connectMcpBridge } from './services/mcpBridge'
import './services/mcpTools'  // side-effect: registers MCP tool handlers
import { applyAccentPalette, DEFAULT_ACCENT_COLOR } from './utils/povConstants'
import AccentLogo from './components/ui/AccentLogo'
import HamburgerMenu from './components/panels/HamburgerMenu'
import HelpPanel from './components/panels/HelpPanel'
import HelpModeController from './components/HelpModeController'
import LibraryView from './components/library/LibraryView'
import GlobalSearchModal from './components/panels/GlobalSearchModal'
import {
  detectAndFireOvumGreen,
  isOvumGreenModalActive,
  getOvumOrangeActive,
  subscribeOvumOrange,
  detectAndFireOvumYellow,
} from './effects/quarterlyForecasts'

// ── Save path modal ──────────────────────────────────────────────────────────

// Phase 1.23 step 8 — global mount for the Scene Time modal. When
// a sceneId is provided, loads the scene's pinned time fields into
// the modal's draft and persists the draft back on Save. When
// sceneId is null (Dev Panel demo path until steps 11+12 ship the
// real triggers), opens with an empty draft and Save is a no-op.
function SceneTimeModalMount() {
  const open    = useUiStore((s) => s.sceneTimeModalOpen)
  const sceneId = useUiStore((s) => s.sceneTimeModalSceneId)
  const close   = useUiStore((s) => s.closeSceneTimeModal)
  const node    = useProjectStore((s) => (sceneId ? s.nodes.find((n) => n.id === sceneId) : null))
  const updateNodeData = useProjectStore((s) => s.updateNodeData)
  const weekStart      = useProjectStore((s) => (s.story?.week_start === 'monday' ? 'monday' : 'sunday'))
  const timeFormat     = useProjectStore((s) => (s.story?.time_format === '24h' ? '24h' : '12h'))
  const allowNegative  = useProjectStore((s) => s.story?.allow_negative_time === true)
  const accentColour   = useAccentColor()
  const walkerOutput = useScenetimeWalk(allowNegative)
  const povChain     = usePovChain()
  const allNodes     = useProjectStore((s) => s.nodes)
  // Entity buckets for the prior-scene NodeBadge, which needs an
  // entity-id → entity map to resolve scene names that come from a
  // POV character. Mirror the buckets DragTooltip pulls.
  const characters = useEntitiesStore((s) => s.characters)
  const locations  = useEntitiesStore((s) => s.locations)
  const items      = useEntitiesStore((s) => s.items)
  const factions   = useEntitiesStore((s) => s.factions)
  const customs    = useEntitiesStore((s) => s.customs)
  if (!open) return null
  const initialState = node ? sceneNodeToDraft(node.data) : null
  const sceneTitle   = node?.data?.title?.trim() || 'Untitled Scene'
  const handleSave = node
    ? (draft) => updateNodeData(sceneId, draftToSceneNodePatch(draft))
    : () => { /* dev-panel demo path — no scene to write to */ }

  const entityMap = new Map(
    [...(characters || []), ...(locations || []), ...(items || []), ...(factions || []), ...(customs || [])]
      .map((e) => [e.id, e])
  )

  const walkerEntry = sceneId ? walkerOutput.get(sceneId) : null
  const isFirstScene = walkerEntry?.isFirstScene === true
  let priorNodeId = null
  let priorSceneData = null
  let priorEffectiveMinutes = null
  let priorDurationMinutes  = null
  let defaultGapUnit = 'hours'
  // Chain-anchor context for the walker. Without these, walkOneStep
  // assumes the chain starts on Jan 1 (chainOriginDayOfYear=0) and any
  // date pin on the current scene that matches the chain's actual start
  // date (e.g. Mar 8) snaps forward by the day-of-year offset (~66
  // days for Mar 8) — surfaces as "two months later" in the modal's
  // headline. Threading the real pre-context anchors the date-snap math
  // to the chain's first scene the same way `walkPovChainTime` does.
  let chainOriginWeekday = 0
  let chainOriginDayOfYear = 0
  let originIsLeap = false
  let prevFeb29ChainDay = null
  if (sceneId && !isFirstScene && povChain.sequence.length > 0) {
    const idx = povChain.sequence.findIndex((s) => s.nodeId === sceneId)
    if (idx > 0) {
      const priorId = povChain.sequence[idx - 1].nodeId
      const priorNode = allNodes.find((n) => n.id === priorId)
      const priorEntry = walkerOutput.get(priorId)
      if (priorNode?.type === 'sceneNode' && priorEntry) {
        priorNodeId = priorId
        priorSceneData = priorNode.data
        priorEffectiveMinutes = priorEntry.effectiveStartMinutes
        priorDurationMinutes  = sceneDurationMinutes(priorNode.data)
        defaultGapUnit = recommendedUnitForGap(Math.max(priorDurationMinutes ?? 60, 60))
      }
      // Pre-context mirrors AlertsPanel's usage — walks the chain up to
      // (not including) the scene being edited and returns the chain
      // anchors needed for correct date-snap math.
      const orderedSceneIds = povChain.sequence.map((s) => s.nodeId)
      const scenesById = new Map(
        allNodes
          .filter((n) => n.type === 'sceneNode')
          .map((n) => [n.id, n.data]),
      )
      const preCtx = chainPreContextForScene({ orderedSceneIds, scenesById, targetSceneId: sceneId })
      chainOriginWeekday = preCtx.chainOriginWeekday
      chainOriginDayOfYear = preCtx.chainOriginDayOfYear
      originIsLeap = preCtx.originIsLeap
      prevFeb29ChainDay = preCtx.prevFeb29ChainDay
    }
  }

  return (
    <SceneTimeModal
      key={`scene-time-modal-${sceneId ?? 'demo'}`}
      open={open}
      onClose={close}
      onSave={handleSave}
      initialState={initialState}
      sceneTitle={sceneTitle}
      sceneId={sceneId}
      weekStart={weekStart}
      timeFormat={timeFormat}
      allowNegative={allowNegative}
      isFirstScene={isFirstScene}
      priorNodeId={priorNodeId}
      priorSceneData={priorSceneData}
      priorEffectiveMinutes={priorEffectiveMinutes}
      priorDurationMinutes={priorDurationMinutes}
      chainOriginWeekday={chainOriginWeekday}
      chainOriginDayOfYear={chainOriginDayOfYear}
      originIsLeap={originIsLeap}
      prevFeb29ChainDay={prevFeb29ChainDay}
      nodes={allNodes}
      entityMap={entityMap}
      accentColour={accentColour}
      defaultGapUnit={defaultGapUnit}
    />
  )
}

function SavePathModal({ onSave, onCancel, initialPath = null }) {
  const [path, setPath] = useState(initialPath || '')
  const [loading, setLoading] = useState(!initialPath)

  useEffect(() => {
    if (initialPath) return   // already have a path — skip the backend default fetch
    // Phase 1.22j — pass the current story title so the suggested
    // path reflects in-progress title edits not yet saved to backend
    // state. See `acquireSavePath` for the parallel native-dialog
    // path; both routes use the same `suggested_title` query param.
    const currentTitle = useProjectStore.getState().story?.title || ''
    axios.get('/api/project/default-save-path', {
      params: { suggested_title: currentTitle },
    })
      .then(({ data }) => setPath(data.default_path))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [initialPath])

  function handleSubmit(e) {
    e.preventDefault()
    if (path.trim()) onSave(path.trim())
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-zinc-800 border border-zinc-600 rounded-lg shadow-2xl w-[480px]">
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700">
          <h2 className="text-sm font-semibold text-zinc-100">Save Project</h2>
          <button onClick={onCancel} className="text-zinc-400 hover:text-zinc-200">✕</button>
        </div>
        <form onSubmit={handleSubmit} className="p-4 space-y-3">
          <p className="text-xs text-zinc-400">
            Choose where to save this project. Future saves will write to this location automatically.
          </p>
          <input
            autoFocus
            value={loading ? 'Loading…' : path}
            onChange={e => setPath(e.target.value)}
            disabled={loading}
            placeholder="e.g. C:\Users\YourName\Documents\MyStory.nnz"
            className="w-full bg-zinc-700 text-sm text-zinc-100 px-3 py-2 rounded border border-zinc-600 focus:outline-none focus:border-accent-500 font-mono disabled:opacity-50"
          />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onCancel} className="px-4 py-1.5 text-sm text-zinc-300 hover:text-zinc-100">
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !path.trim()}
              className="px-4 py-1.5 text-sm bg-accent-700 hover:bg-accent-600 text-white rounded disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Transient alert banner ───────────────────────────────────────────────────
//
// Thin strip across the top of the app, rendered as a sibling above
// the main row (same layout family as the error / backendDisconnected /
// MCP session banners). Subscribes to `uiStore.transientAlert` and
// renders nothing when null. Callers fire via `showTransientAlert`,
// which auto-dismisses after ~6s; the writer can also dismiss early
// via the ✕ button. Red-tinted for `kind: 'error'` (the default);
// the slot accepts `kind: 'info'` for future neutral callers.
function TransientAlertBanner() {
  const alert = useUiStore((s) => s.transientAlert)
  const clear = useUiStore((s) => s.clearTransientAlert)
  if (!alert) return null
  const isError = alert.kind !== 'info'
  return (
    <div
      className={`flex items-center justify-between px-4 py-2 text-xs border-b flex-shrink-0 ${
        isError
          ? 'bg-red-900/80 text-red-100 border-red-700'
          : 'bg-zinc-800/90 text-zinc-100 border-zinc-700'
      }`}
      role="alert"
      aria-live="polite"
    >
      <span className="flex items-start gap-2 min-w-0">
        {isError && (
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-red-300 flex-shrink-0 mt-px">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        )}
        <span className="min-w-0">{alert.message}</span>
      </span>
      <button
        onClick={clear}
        aria-label="Dismiss"
        className={`ml-4 flex-shrink-0 ${isError ? 'text-red-300 hover:text-white' : 'text-zinc-400 hover:text-white'}`}
      >
        ✕
      </button>
    </div>
  )
}


// ── App ──────────────────────────────────────────────────────────────────────

function App() {
  const { story, recentProjects, activePath, hasUnsavedChanges, error, initStory, saveProject, autosaveProject, loadProject, loadProjectNative, loadFromRecent, newProject, exportAsNnz, exportStorySeeds, clearError, _loadingProject, _loadingProjectTitle } = useProjectStore()
  // Phase 1.22j — `toggleEntityLibrary` removed (Entity sidebar has its
  // own collapse button). `toggleRightSidebar` / `rightSidebarOpen`
  // moved into `<EditorToggleCorner>` which subscribes directly.
  const chapterHeaderCollapsed = useUiStore((s) => s.chapterHeaderCollapsed)
  const toggleChapterHeaderCollapsed = useUiStore((s) => s.toggleChapterHeaderCollapsed)
  const chaptersCount = useProjectStore((s) => s.story?.chapters?.length || 0)
  const openExportDialog = useUiStore((s) => s.openExportDialog)
  const openImportDialog = useUiStore((s) => s.openImportDialog)
  const templateImportDialogOpen  = useUiStore((s) => s.templateImportDialogOpen)
  const openTemplateImportDialog  = useUiStore((s) => s.openTemplateImportDialog)
  const closeTemplateImportDialog = useUiStore((s) => s.closeTemplateImportDialog)
  const openNcImportDialog  = useUiStore((s) => s.openNcImportDialog)
  const tocPanelOpen = useUiStore((s) => s.tocPanelOpen)
  const toggleTocPanel = useUiStore((s) => s.toggleTocPanel)
  const timelineNavPanelOpen = useUiStore((s) => s.timelineNavPanelOpen)
  const toggleTimelineNavPanel = useUiStore((s) => s.toggleTimelineNavPanel)
  const updateStorySettings = useProjectStore((s) => s.updateStorySettings)
  const [showSavePath, setShowSavePath] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showCardExport, setShowCardExport] = useState(false)
  // Phase 2.4 — listen for cross-component requests to open the
  // Settings panel to a specific tab (uiStore `pendingSettingsOpen`).
  // Used by the Chat Settings popover's "Open AI Settings" link so
  // nested components don't need to drill an open-settings callback
  // down through every parent.
  const pendingSettingsOpen = useUiStore((s) => s.pendingSettingsOpen)
  const clearPendingSettingsOpen = useUiStore((s) => s.clearPendingSettingsOpen)
  useEffect(() => {
    if (pendingSettingsOpen === null) return
    if (typeof pendingSettingsOpen === 'string') {
      setSettingsInitialTab(pendingSettingsOpen)
    } else {
      setSettingsInitialTab(null)
    }
    setShowSettings(true)
    clearPendingSettingsOpen()
  }, [pendingSettingsOpen, clearPendingSettingsOpen])
  // When a DIFFERENT project is opened or a new one is created, return the
  // chat panel to its thread browser scoped to the newly loaded story,
  // instead of leaving the previous story's open thread (or its browser
  // tab) showing. Deselects the active thread (not deleted, just closed)
  // and points the browser's story tab at the new story. Tracks the last
  // non-null story id so it fires only on a genuine project switch, not on
  // first load or in-place autosaves (those keep the same id). App-root
  // placement means it works even when the chat panel is closed at switch
  // time, so re-opening it shows the right story's browser.
  const prevChatStoryIdRef = useRef(null)
  useEffect(() => {
    const id = story?.id || null
    if (!id) return
    const prev = prevChatStoryIdRef.current
    prevChatStoryIdRef.current = id
    if (prev !== null && id !== prev) {
      useConversationsStore.getState().setActiveThreadId(null)
      useUiStore.getState().setChatBrowserActiveTab(id)
    }
  }, [story?.id])
  // Phase 1.22j — inline-edit state for the centered story title in the
  // top bar. `editingTitle` is the draft input mode; `titleDraft` is the
  // working text. Confirm on Enter / blur, cancel on Escape.
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  // When the toolbar Import/Export menu opens Settings for a
  // specific tab (e.g. "Import Story Seeds…" → Story Seeds tab),
  // this state seeds the SettingsPanel's initial active tab. Reset
  // on close so the next "gear" click goes to the default tab.
  const [settingsInitialTab, setSettingsInitialTab] = useState(null)
  const [savedRecently, setSavedRecently] = useState(false)
  const [autosavedRecently, setAutosavedRecently] = useState(false)
  const [backendDisconnected, setBackendDisconnected] = useState(false)
  // Phase 1.22j — Import / Export now live inside the HamburgerMenu;
  // the legacy `importExportAnchorRef` for the standalone toolbar
  // dropdown was removed when the buttons consolidated.

  // ── Save-path prompt as a promise (Phase 1.13 v0.1.13.1) ───────
  // The `<SavePathModal>` at the bottom of this component is a
  // declarative UI piece (open state stored in `showSavePath`), but
  // the new 3-button unsaved-changes dialog's **Save** button needs
  // to await the user's save-path choice as part of an async flow.
  // This ref holds a `resolve` callback while the save-path modal
  // is open; the submit / cancel handlers resolve it with the saved
  // path (or `null` on cancel / failure). `guardUnsavedChanges`
  // awaits `promptSavePath()` which sets up the ref, flips the
  // modal open, and returns the promise.
  const pendingSaveResolveRef = useRef(null)

  // initStory is the project-bootstrap action; it fetches story state from
  // the backend and populates every store. React's <StrictMode> in dev
  // deliberately double-invokes mount-time effects to surface cleanup
  // bugs — without this guard, initStory would fire twice on refresh,
  // wiping and re-populating the store ~1.4s apart. Each load forces React
  // Flow to discard internal measurements and remeasure from scratch,
  // leaving edges anchored to stale handle positions in the gap between
  // wipe and remeasurement settle (the long-standing "wires shift after
  // load" bug). The ref-guard makes the effect idempotent across
  // StrictMode's double-invocation. In production (no StrictMode) this
  // guard is a no-op.
  const didInitStoryRef = useRef(false)
  useEffect(() => {
    if (didInitStoryRef.current) return
    didInitStoryRef.current = true
    initStory()
  }, [initStory])

  // Phase 5.5c — open the Story Library on launch when enabled. Runs once,
  // after preferences load, over the fresh blank story initStory set up.
  // Off (or the library disabled) leaves you on the blank story, as before.
  const settingsLoaded = useSettingsStore((s) => s.loaded)
  const didLibraryStartupRef = useRef(false)
  useEffect(() => {
    if (!settingsLoaded || didLibraryStartupRef.current) return
    didLibraryStartupRef.current = true
    const prefs = useSettingsStore.getState().preferences
    if (prefs.use_project_library !== false && prefs.show_library_on_startup !== false) {
      useUiStore.getState().openLibrary()
    }
  }, [settingsLoaded])

  // Phase 5.7 — when "Disable AI integrations" turns on, tear down any
  // live AI: end an active MCP session, then stop the MCP server. The
  // AI UI surfaces hide themselves via `useAiDisabled`; this effect
  // handles the running backend pieces. Fires on the transition into
  // disabled and on mount when it is already on (the backend also
  // suppresses MCP auto-start in that case).
  const aiDisabled = useSettingsStore((s) => s.preferences.disable_ai_integrations === true)
  useEffect(() => {
    if (!aiDisabled) return
    ;(async () => {
      const mcp = useMcpControlStore.getState()
      try { await mcp.endActiveSession() } catch { /* best effort teardown */ }
      try { if (useMcpControlStore.getState().serverRunning) await mcp.stopServer() } catch { /* best effort teardown */ }
    })()
  }, [aiDisabled])

  // Phase 2.6g — project-load + story-rename hook for the
  // conversations subsystem. Fires `syncStoryFolder(story.id,
  // story.title)` once per project load AND once per title commit,
  // because the effect's deps are exactly `[story?.id, story?.title]`.
  //
  // Why an observer here instead of hooking each load action: every
  // loadProject / loadProjectNative / loadFromRecent / newProject
  // path eventually settles `story` into the same shape. Watching
  // the resolved story keeps the hook in one place and naturally
  // covers any future load entry point.
  //
  // Why this doesn't fire on keystrokes: the title input in the
  // top bar AND in the Story Settings tab both commit via local
  // draft → `updateStorySettings({ title })` on Enter / blur. The
  // store's `story.title` only updates at commit time, so this
  // effect fires once per real change. Per-keystroke writes would
  // require an additional debounce layer here; the current design
  // doesn't need one.
  const conversationsSyncStoryFolder = useConversationsStore((s) => s.syncStoryFolder)

  // Open the MCP bridge WebSocket on app mount. Reconnects automatically
  // on drop. The bridge runs even when no MCP client is connected; the
  // backend just keeps the socket open so the moment a client tries to
  // invoke a tool, we are already reachable.
  useEffect(() => { connectMcpBridge() }, [])

  // Phase 3.7 perf fix (large-project load perf #5 — confirmed by 2026-06-06
  // perf-review agents as the trigger for the t≈20s second freeze):
  // consolidate the three boot side-effects into a single chained idle
  // callback.
  //
  // BEFORE: three independent `requestIdleCallback` effects fired in
  // PARALLEL at app mount — `syncStoryFolder` (network), conversation +
  // tag preload (3 network calls), and `loadPreferences().then(applyDefaults)`
  // (preference fetch + two cross-store sets). They all triggered when
  // the browser first went idle (~3s after first paint), produced a
  // 1668-updater commit at t≈20s that included the AlertsPanel walk,
  // and gave the writer the perceived "second freeze before the canvas
  // becomes pannable" symptom.
  //
  // AFTER: a single idle-scheduled async function awaits each stage in
  // sequence. Network calls don't pile up at one moment in time; state
  // mutations are spread out so each individual re-render batch is
  // smaller; the snap_to_grid + applyLayoutSnapshot sets fire back-to-
  // back in the same JS tick so React's automatic batching folds them
  // into one render commit instead of two.
  //
  // `conversationsSyncStoryFolder` also still re-runs on story.id /
  // story.title change (writer renames the project) — that's its own
  // useEffect below this one so the chain doesn't re-fire the unrelated
  // preload + preferences flow on every rename.
  useEffect(() => {
    let cancelled = false

    const bootSequence = async () => {
      // Stage 1 — syncStoryFolder (first-boot only; subsequent renames
      // re-fire via the separate useEffect below). The store action
      // returns a promise that resolves when the folder-sync API call
      // completes.
      const id = story?.id
      if (id) {
        try { await conversationsSyncStoryFolder(id, story?.title || '') } catch { /* ignore */ }
        if (cancelled) return
      }

      // Stage 2 — preload conversation index, categories map, and the
      // Program Tag pool. All idempotent; safe to call from each
      // surface's own mount effect afterwards.
      try {
        const cs = useConversationsStore.getState()
        await Promise.all([
          Promise.resolve(cs.loadIndex()),
          Promise.resolve(cs.loadCategoriesMap()),
        ])
        if (cancelled) return
        await Promise.resolve(useProgramTagsStore.getState().loadPool())
        if (cancelled) return
      } catch { /* ignore */ }

      // Stage 3 — load user preferences, apply canvas + UI defaults.
      // The two sets at the end fire back-to-back in the same JS tick
      // so React batches them into one render commit instead of two.
      try {
        await useSettingsStore.getState().loadPreferences()
        if (cancelled) return
        const prefs = useSettingsStore.getState().preferences
        if (prefs.snap_to_grid_default === true) {
          useProjectStore.setState({ snapToGrid: true })
        }
        // Phase 8.2 — seed this session's canvas wire-visibility mode and
        // type filter from the program default (session-only; resets each
        // launch). migrateWireVisibility folds any pre-8.2 default preset into
        // the current mode + type shape.
        {
          const { mode: wvMode, types: wvTypes } = migrateWireVisibility(
            prefs.default_wire_visibility_mode,
            prefs.default_wire_visibility_types,
          )
          const ui = useUiStore.getState()
          ui.setWireVisibilityMode(wvMode)
          ui.setWireVisibilityTypes(wvTypes)
        }
        // Phase 2.3a — apply the writer's saved default panel layout on
        // every boot. Saved snapshot is the canonical layout: mid-
        // session customisations affect the current session only and
        // are overwritten by the saved default on next launch.
        if (prefs.default_panel_layout) {
          useUiStore.getState().applyLayoutSnapshot(prefs.default_panel_layout)
        }
      } catch { /* ignore */ }
    }

    const handle = (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function')
      ? window.requestIdleCallback(() => { bootSequence() }, { timeout: 1500 })
      : setTimeout(bootSequence, 0)

    return () => {
      cancelled = true
      if (typeof window !== 'undefined' && typeof window.cancelIdleCallback === 'function' && typeof handle === 'number') {
        window.cancelIdleCallback(handle)
      } else {
        clearTimeout(handle)
      }
    }
  }, [])

  // Separate effect for writer-triggered story renames mid-session.
  // The bootSequence above dispatches the first-boot sync; this effect
  // covers subsequent title changes via a `_didInitialSync` ref to skip
  // the initial mount fire (so we don't double-sync). Title-rename
  // isn't a perf-sensitive moment so it runs inline (no idle defer).
  const _didInitialSyncStoryFolderRef = useRef(false)
  useEffect(() => {
    const id = story?.id
    if (!id) return
    if (!_didInitialSyncStoryFolderRef.current) {
      // First fire happens at mount; the bootSequence already handles
      // it. Mark and skip.
      _didInitialSyncStoryFolderRef.current = true
      return
    }
    conversationsSyncStoryFolder(id, story?.title || '')
  }, [story?.id, story?.title, conversationsSyncStoryFolder])

  // Dynamic browser tab title
  useEffect(() => {
    const t = story?.title
    document.title = (t && t !== 'Untitled Story') ? t + ' - NarrativeNode' : 'NarrativeNode'
  }, [story?.title])

  // Apply accent colour palette to CSS custom properties
  useEffect(() => {
    applyAccentPalette(story?.accent_color || DEFAULT_ACCENT_COLOR)
  }, [story?.accent_color])

  // Global keyboard shortcuts: Ctrl+S (Save), Ctrl+Shift+S (Save As), Ctrl+` (Dev preview)
  useEffect(() => {
    function onKeyDown(e) {
      if (e.ctrlKey && e.key === 's' && !e.shiftKey) {
        e.preventDefault()
        // Effect detector — fires before the save so the pre-save
        // dirty state is what's measured. Wrapped in try/catch so a
        // bug in the egg can never break saving.
        try { detectAndFireOvumYellow(useProjectStore.getState().hasUnsavedChanges) } catch { /* nothing */ }
        handleSave()
      }
      if (e.ctrlKey && e.key === 'S' && e.shiftKey) {
        e.preventDefault()
        handleSaveAs()
      }
      // Phase 1.24d — Global Search modal. Ctrl+F (Cmd+F on macOS)
      // opens the modal regardless of focus context: writers often
      // want to look up a reference while actively typing in the
      // editor. Pillar 4 (Find/Replace inside the editor) uses Ctrl+H
      // so there is no conflict.
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F') && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        useUiStore.getState().openGlobalSearch()
      }
      // Dev preview panel — hidden reusable space for visual consistency
      // review. Ctrl+` toggles; no menu entry. Not wired to any user-facing
      // affordance.
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault()
        useUiStore.getState().toggleDevPreview()
      }
      // Effect detector — silent on non-matching keys, never preventDefault.
      // Skip when the game modal is active: the modal's own keydown
      // listener (capture phase) is already feeding the Konami buffer
      // for every key. Letting this bubble-phase call run too would
      // double-feed letter keys (B / A) that the modal doesn't
      // stopImmediatePropagation on, breaking the in-game cheat.
      try {
        if (!isOvumGreenModalActive()) detectAndFireOvumGreen(e)
      } catch { /* never break input */ }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  // Auto-save timer — reads interval from story settings; autosaveProject()
  // itself skips when there is no active path or no unsaved changes.
  useEffect(() => {
    if (!story?.autosave_enabled) return undefined
    const minutes = Math.max(1, parseInt(story?.autosave_interval_minutes, 10) || 5)
    const ms = minutes * 60 * 1000
    const id = setInterval(async () => {
      const ok = await autosaveProject()
      if (ok) {
        setAutosavedRecently(true)
        setTimeout(() => setAutosavedRecently(false), 2000)
      }
    }, ms)
    return () => clearInterval(id)
  }, [story?.autosave_enabled, story?.autosave_interval_minutes, autosaveProject])

  // ── Single-instance handoff: periodic pending-load poll ──────────
  // When a second run.py detects this instance is already running and
  // has a file to hand off, it POSTs the path to
  // /api/project/pending-load-request and exits WITHOUT opening a
  // second browser tab (it checks /project/alive first — if a tab is
  // alive, run.py relies on this poll to pick up the file).
  //
  // The poll runs every POLL_INTERVAL_MS regardless of focus state, so
  // any alive tab catches the request whether it's in the foreground
  // or not. The GET also doubles as a liveness heartbeat on the
  // backend, so run.py's /alive probe knows we exist.
  //
  // Reentrancy: `processingRef` blocks overlapping invocations of the
  // handler, otherwise two polls 1.5s apart could both see the same
  // pending request mid-confirm and open two dialogs.
  //
  // Connection banner: two consecutive failures flip the banner on,
  // one success flips it off. Single blips don't flash it.
  //
  // Uses a ref to hold the latest handler so the poll is installed
  // exactly once (empty deps) and never re-registered on renders, but
  // always captures the latest closure values through the ref
  // indirection.
  const pendingLoadCheckRef = useRef(null)
  const processingPendingRef = useRef(false)
  pendingLoadCheckRef.current = async () => {
    // Hold the guard across the whole invocation — including the
    // initial axios.get — so a second tick that fires while we're
    // awaiting the fetch bails out before it even asks the backend.
    // Without this, two ticks could both resolve with the same
    // pending path and both open a confirm dialog.
    if (processingPendingRef.current) return
    processingPendingRef.current = true
    try {
      const { data } = await axios.get('/api/project/pending-load-request')
      if (!data.pending) return
      const filePath = data.pending
      const fileName = filePath.split(/[\\/]/).pop() || filePath
      const dirty = useProjectStore.getState().hasUnsavedChanges

      if (dirty) {
        const result = await confirm({
          title: 'Opening a project from another instance',
          message:
            `Another instance of NarrativeNode wants to open:\n${fileName}\n\n` +
            `You have unsaved changes in the current project.`,
          buttons: [
            { label: 'Save and open',    value: 'save',    style: 'primary' },
            { label: 'Discard and open', value: 'discard', style: 'danger' },
            { label: 'Cancel',           value: 'cancel',  style: 'neutral' },
          ],
        })

        if (result === 'cancel') {
          await axios.delete('/api/project/pending-load-request')
          return
        }

        if (result === 'save') {
          const ok = await useProjectStore.getState().saveProject()
          if (!ok) {
            // No active save path — try to acquire one via the native
            // picker. This reuses the same acquireSavePath machinery the
            // header Save button uses. On user cancel, abort the pending
            // load entirely to avoid data loss.
            const path = await acquireSavePath()
            if (!path) {
              await axios.delete('/api/project/pending-load-request')
              return
            }
            const savedOk = await useProjectStore.getState().saveProject(path)
            if (!savedOk) {
              await axios.delete('/api/project/pending-load-request')
              return
            }
          }
        }
        // 'discard' falls through — load the new file without saving.
      }

      // Backend loads the file. On success, re-sync the frontend via
      // initStory (which does GET /story/ + GET /active-path + builds
      // nodes/edges + syncs entitiesStore + resets history + fires
      // fitView). On failure, the pending request is still cleared so
      // it doesn't re-trigger on the next poll.
      try {
        await axios.post('/api/project/load-path', { path: filePath })
        await initStory()
      } catch {
        // Load failed — clear pending and leave the current project.
      }
      await axios.delete('/api/project/pending-load-request')
    } finally {
      processingPendingRef.current = false
    }
  }

  useEffect(() => {
    const POLL_INTERVAL_MS = 1500
    let failureCount = 0
    let stopped = false
    let healthTimer = null
    let pollId = null

    async function tick() {
      if (stopped) return
      try {
        await pendingLoadCheckRef.current?.()
        failureCount = 0
        setBackendDisconnected((prev) => (prev ? false : prev))
      } catch {
        failureCount += 1
        if (failureCount >= 2) {
          setBackendDisconnected((prev) => (prev ? prev : true))
        }
      }
    }

    // Wait for the backend to respond before starting the poll. On first
    // launch the uvicorn worker takes a moment to start; polling immediately
    // produces proxy errors in the Vite console. The health probe retries
    // every 200ms so the delay is imperceptible once the server is up.
    // Once connected, fire the first tick immediately so a freshly-opened
    // tab (the "no live tab" handoff branch) picks up any queued pending
    // request without waiting a full poll interval.
    async function waitForBackend() {
      if (stopped) return
      try {
        await axios.get('/api/health', { timeout: 500 })
        tick()
        pollId = setInterval(tick, POLL_INTERVAL_MS)
      } catch {
        healthTimer = setTimeout(waitForBackend, 200)
      }
    }

    waitForBackend()
    return () => {
      stopped = true
      clearTimeout(healthTimer)
      clearInterval(pollId)
    }
  }, [])

  // ── Save-path acquisition (Phase 1.13 v0.1.13.2) ───────────────
  //
  // Tries the OS-native save-as dialog first via
  // `GET /api/project/native-save-as`. On success, returns the
  // chosen path (string) or `null` if the user cancelled the native
  // dialog. On backend error (e.g. tkinter isn't available — headless
  // server / docker), falls back to opening the existing typed-path
  // `<SavePathModal>` and awaiting its result. The fallback path
  // uses the same `pendingSaveResolveRef` promise pattern as the
  // 3-button Save flow, so callers always await a single value.
  //
  // `null` return → user cancelled OR an error occurred AND the
  // user cancelled the fallback modal too. Either way, caller
  // should treat it as "abort the downstream action".
  async function acquireSavePath() {
    try {
      // Phase 1.22j — pass the CURRENT story title to the dialog so
      // the suggested filename reflects in-progress title edits that
      // haven't been saved to backend state yet. Backend state only
      // syncs on save/load; without this, a freshly-typed title in
      // the centered top-bar input wouldn't influence the dialog's
      // initialfile until after the first save.
      const currentTitle = useProjectStore.getState().story?.title || ''
      const { data } = await axios.get('/api/project/native-save-as', {
        params: { suggested_title: currentTitle },
      })
      // On success, RETURN the path directly — no fallback needed.
      // `null` here means the user explicitly cancelled the native
      // dialog; don't then re-open the typed-path fallback.
      return data?.path ?? null
    } catch {
      // Native dialog failed (probably tkinter unavailable). Fall
      // through to the typed-path modal as a safety net.
      return new Promise((resolve) => {
        pendingSaveResolveRef.current = resolve
        setShowSavePath(true)
      })
    }
  }

  async function handleSave() {
    if (activePath) {
      const ok = await saveProject()
      if (ok) {
        setSavedRecently(true)
        setTimeout(() => setSavedRecently(false), 2000)
      }
      return
    }
    // No active path — acquire one via the native picker (with
    // typed-path fallback), then save to it.
    const path = await acquireSavePath()
    if (!path) return
    const ok = await saveProject(path)
    if (ok) {
      setSavedRecently(true)
      setTimeout(() => setSavedRecently(false), 2000)
    }
  }

  async function handleSavePathConfirm(path) {
    setShowSavePath(false)
    const ok = await saveProject(path)
    if (ok) {
      setSavedRecently(true)
      setTimeout(() => setSavedRecently(false), 2000)
    }
    // If the save-path modal was opened as a fallback path from
    // `acquireSavePath`, resolve its pending promise so the caller
    // can continue (or bail out if the save failed).
    if (pendingSaveResolveRef.current) {
      pendingSaveResolveRef.current(ok ? path : null)
      pendingSaveResolveRef.current = null
    }
  }

  function handleSavePathCancel() {
    setShowSavePath(false)
    // Pending promise (if any) resolves to null → caller treats it
    // as "user cancelled, don't proceed with the new action".
    if (pendingSaveResolveRef.current) {
      pendingSaveResolveRef.current(null)
      pendingSaveResolveRef.current = null
    }
  }

  async function handleSaveAs() {
    // Save As: always prompts for a new path, regardless of whether
    // an activePath already exists. Uses the same acquire → save
    // sequence as handleSave's "no path yet" branch.
    const path = await acquireSavePath()
    if (!path) return
    const ok = await saveProject(path)
    if (ok) {
      setSavedRecently(true)
      setTimeout(() => setSavedRecently(false), 2000)
    }
  }

  // ── Unsaved-changes guard (Phase 1.13 v0.1.13.1) ───────────────
  // Promise-based wrapper around the 3-button confirm. Returns one
  // of 'proceed' (the caller should run its action) or 'cancel'
  // (user bailed out, do nothing). When the user chooses Save, the
  // wrapper tries an in-place save first and falls back to opening
  // the native save-as picker (via `acquireSavePath`) if no
  // `activePath` is set — the returned promise only resolves to
  // 'proceed' after the save actually succeeds, so a save failure
  // cleanly aborts the downstream action.
  async function guardUnsavedChanges(actionLabel) {
    if (!hasUnsavedChanges) return 'proceed'
    const result = await confirm({
      title: 'Unsaved changes',
      message: `You have unsaved changes. ${actionLabel} will discard them unless you save first.`,
      buttons: [
        { label: 'Save',                      value: 'save',    style: 'primary' },
        { label: 'Continue without saving',   value: 'discard', style: 'danger'  },
        { label: 'Cancel',                    value: 'cancel',  style: 'neutral' },
      ],
    })
    if (result === 'cancel') return 'cancel'
    if (result === 'discard') return 'proceed'
    if (result === 'save') {
      if (activePath) {
        const ok = await saveProject()
        if (ok) {
          setSavedRecently(true)
          setTimeout(() => setSavedRecently(false), 2000)
          return 'proceed'
        }
        return 'cancel'  // save failed — don't proceed
      }
      // No activePath — prompt for one via the native save-as
      // picker (with typed-path modal as a safety-net fallback).
      const savedPath = await acquireSavePath()
      if (!savedPath) return 'cancel'
      const ok = await saveProject(savedPath)
      if (!ok) return 'cancel'
      setSavedRecently(true)
      setTimeout(() => setSavedRecently(false), 2000)
      return 'proceed'
    }
    return 'cancel'
  }

  async function handleNewProject() {
    const guard = await guardUnsavedChanges('Creating a new project')
    if (guard !== 'proceed') return
    await newProject()
  }

  async function handleLoadNative() {
    const guard = await guardUnsavedChanges('Loading this project')
    if (guard !== 'proceed') return
    await loadProjectNative()
  }

  async function handleLoadFromRecent(entry) {
    const guard = await guardUnsavedChanges('Loading this project')
    if (guard !== 'proceed') return
    await loadFromRecent(entry)
  }

  // Phase 5.5b — Open a project from the Story Library. Mirrors the recent
  // load: guard unsaved changes, then load from the resolved path via the
  // same load-path flow (which also re-registers the library entry), then
  // close the library surface. A missing resolved path is a no-op for now
  // (the on-open path picker is a later 5.5b slice).
  // Phase 5.8b — an "Opening…" overlay covers the gap between clicking a
  // library card's Open and the project finishing loading (`loadFromRecent`
  // can take a moment), so the click clearly registers instead of feeling
  // like nothing happened.
  async function handleOpenLibraryProject({ title, path }) {
    if (!path) return
    const guard = await guardUnsavedChanges('Opening this project')
    if (guard !== 'proceed') return
    // Close the library first so the loading overlay (driven by the load
    // action via `_loadingProject`) covers the canvas, not the library.
    useUiStore.getState().closeLibrary()
    await loadFromRecent({ name: title, path })
  }

  // Phase 5.5b — the library landing's New Story / Open action tiles. New
  // mirrors the hamburger New (guard, then a blank project) and closes the
  // library. Open mirrors the hamburger Open (guard, then the native file
  // picker) and closes the library only when a file was actually loaded
  // (loadProjectNative bumps loadGeneration on a real load), so cancelling the
  // picker leaves you in the library.
  async function handleNewStoryFromLibrary() {
    const guard = await guardUnsavedChanges('Creating a new project')
    if (guard !== 'proceed') return
    await newProject()
    useUiStore.getState().closeLibrary()
  }

  async function handleOpenFileFromLibrary() {
    const guard = await guardUnsavedChanges('Loading this project')
    if (guard !== 'proceed') return
    const before = useProjectStore.getState().loadGeneration
    await loadProjectNative()
    if (useProjectStore.getState().loadGeneration !== before) {
      useUiStore.getState().closeLibrary()
    }
  }

  // Phase 5.5b — the library's top-left gear: close the library and open
  // Settings (the same modal the hamburger Settings opens).
  function handleSettingsFromLibrary() {
    useUiStore.getState().closeLibrary()
    setShowSettings(true)
  }

  // Phase 2.5e — a `.nnz` file dropped on the canvas fires
  // `requestOpenDroppedProject(file)` in uiStore; we consume it here
  // so the drop routes through the same guard-unsaved-then-load
  // path the hamburger menu's Open uses. The signal carries its own
  // `id` so a second drop while the prompt is still open displaces
  // the first cleanly (the in-flight effect short-circuits when it
  // notices the id has changed).
  const pendingDroppedProjectFile = useUiStore((s) => s.pendingDroppedProjectFile)
  const clearPendingDroppedProject = useUiStore((s) => s.clearPendingDroppedProject)
  useEffect(() => {
    if (!pendingDroppedProjectFile) return undefined
    const requestId = pendingDroppedProjectFile.id
    const file = pendingDroppedProjectFile.file
    let cancelled = false
    ;(async () => {
      const guard = await guardUnsavedChanges('Loading the dropped project')
      if (cancelled) return
      if (useUiStore.getState().pendingDroppedProjectFile?.id !== requestId) return
      if (guard !== 'proceed') {
        clearPendingDroppedProject()
        return
      }
      try {
        await loadProject(file)
      } finally {
        clearPendingDroppedProject()
      }
    })()
    return () => { cancelled = true }
  }, [pendingDroppedProjectFile, clearPendingDroppedProject, loadProject])

  // Toolbar Import/Export menu → Import Story Seeds. Opens the
  // Settings panel on the Story Seeds tab and sets a one-shot
  // uiStore flag that tells the tab to auto-click its Import
  // button on mount. Keeps all the preview-dialog logic inside the
  // tab itself.
  function handleImportStorySeedsFromToolbar() {
    useUiStore.getState().requestStorySeedsImport()
    setSettingsInitialTab('storySeeds')
    setShowSettings(true)
  }

  // Phase 7.2 — Import a SillyTavern character card via a file picker.
  // Explicit action (metadata-REQUIRED): a non-card file is surfaced as an
  // error, unlike the drag-drop path which falls through to a media node.
  // The new entity's origin node lands at the viewport centre.
  function handleImportCharacterCard() {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.png,.json,image/png,application/json'
    input.onchange = async () => {
      const file = input.files && input.files[0]
      if (!file) return
      try {
        const result = await useEntitiesStore.getState().importCharacterCardFile(file)
        if (!result) {
          useUiStore.getState().showTransientAlert('Chosen file contains no character card data.')
          return
        }
        useProjectStore.getState().addEntityNodeToCanvas(result.entity_node, undefined, { createdEntity: result.entity })
      } catch {
        useUiStore.getState().showTransientAlert('Could not import the character card.')
      }
    }
    input.click()
  }

  // Phase 1.22j — story title inline-edit helpers. The centered title
  // in the top bar is read-only by default; click flips into an input
  // pre-populated with the current title. Enter / blur commits via
  // `updateStorySettings({ title })`; Escape discards.
  function beginEditTitle() {
    setTitleDraft(story?.title || '')
    setEditingTitle(true)
  }
  function commitEditTitle() {
    const next = (titleDraft || '').trim()
    if (next && next !== story?.title) updateStorySettings({ title: next })
    setEditingTitle(false)
  }
  function cancelEditTitle() {
    setEditingTitle(false)
  }

  // Abbreviated path display: show just the filename
  const activeFilename = activePath ? activePath.split(/[\\/]/).pop() : null

  // ovum_orange — wordmark colour treatment when active.
  const orangeActive = useSyncExternalStore(subscribeOvumOrange, getOvumOrangeActive)

  return (
    <div className="flex flex-col h-screen relative">
      <header className="flex items-stretch bg-zinc-900 border-b border-zinc-700 flex-shrink-0 relative">
        {/* Region 1 — Hamburger button. Absolutely positioned at the
            top-left of the header so it doesn't take horizontal flex
            space — that lets Region 2's logo + title centering stay
            true to the actual left-sidebar column position below the
            header (which starts at x=0, not at x=hamburger-width). */}
        <div className="absolute top-0 left-0 h-full flex items-center px-1 z-20">
          <HamburgerMenu
            onNew={handleNewProject}
            onOpen={handleLoadNative}
            recentProjects={recentProjects}
            onLoadFromRecent={handleLoadFromRecent}
            onSave={handleSave}
            onSaveAs={handleSaveAs}
            onFind={() => useUiStore.getState().openGlobalSearch()}
            onLibrary={() => useUiStore.getState().openLibrary()}
            onExportStory={openExportDialog}
            onExportNnz={exportAsNnz}
            onExportStorySeeds={exportStorySeeds}
            onExportCharacterCard={() => setShowCardExport(true)}
            onImportEntities={openImportDialog}
            onImportStorySeeds={handleImportStorySeedsFromToolbar}
            onImportCharacterCard={handleImportCharacterCard}
            onImportTemplate={openTemplateImportDialog}
            onImportNovelcrafter={openNcImportDialog}
            onSettings={() => setShowSettings(true)}
            onHelp={() => useUiStore.getState().openHelpPanel()}
          />
        </div>

        {/* Region 2 — Left-sidebar column slot. Logo + title centered;
            width fixed at the sidebar-open default so geometry stays
            stable across sidebar toggles. The slot's left edge is the
            top bar's left edge — the absolutely-positioned hamburger
            overlays the leftmost ~40px on top of this slot but doesn't
            shift the centered logo + title group. */}
        <div
          className="flex items-center justify-center gap-2 flex-shrink-0 border-r border-zinc-800/50"
          style={{ width: 280 }}
          data-help-region="menu-bar:wordmark"
        >
          <AccentLogo className="w-6 h-6 flex-shrink-0" />
          <h1 className="text-lg font-semibold text-accent-400">
            {orangeActive ? (
              <>
                <span style={{ color: '#ffffff' }}>Narrative</span>
                <span style={{ color: '#000000', backgroundColor: '#ff9000', padding: '0 4px', borderRadius: '2px' }}>Node</span>
              </>
            ) : 'NarrativeNode'}
          </h1>
        </div>

        {/* Region 3 — Canvas-area slot. */}
        <div className="flex items-center flex-1 min-w-0 px-2 py-2 gap-2 relative">
          <button
            data-toc-toggle
            data-help-region="menu-bar:toc"
            onClick={toggleTocPanel}
            title="Table of contents"
            className="w-7 h-7 flex items-center justify-center rounded transition-colors flex-shrink-0"
            style={{
              backgroundColor: tocPanelOpen ? 'rgba(82, 82, 91, 1)' : 'rgba(63, 63, 70, 1)',
              color: tocPanelOpen ? '#fafafa' : '#d4d4d8',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="3" y1="4" x2="13" y2="4" />
              <line x1="5" y1="8" x2="13" y2="8" />
              <line x1="3" y1="12" x2="13" y2="12" />
            </svg>
          </button>
          <button
            data-timeline-toggle
            data-help-region="menu-bar:timeline"
            onClick={toggleTimelineNavPanel}
            title="Timeline Navigator"
            className="w-7 h-7 flex items-center justify-center rounded transition-colors flex-shrink-0"
            style={{
              backgroundColor: timelineNavPanelOpen ? 'rgba(82, 82, 91, 1)' : 'rgba(63, 63, 70, 1)',
              color: timelineNavPanelOpen ? '#fafafa' : '#d4d4d8',
              fontSize: 14,
            }}
          >
            {'⊶'}
          </button>

          {/* Phase 1.24d — Global Search quick-find button. Same
              7×7 sizing and accent treatment as the Save button next
              to it; opens the global search modal via the same
              uiStore flag the Ctrl+F shortcut sets. Tooltip shows
              the platform-appropriate shortcut. */}
          <button
            onClick={() => useUiStore.getState().openGlobalSearch()}
            data-help-region="menu-bar:find"
            className="w-7 h-7 rounded text-white transition-colors flex-shrink-0 flex items-center justify-center bg-accent-700 hover:bg-accent-600"
            title={`Find (${navigator.platform?.toLowerCase().includes('mac') ? 'Cmd' : 'Ctrl'}+F)`}
            aria-label="Find"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="6" cy="6" r="4" />
              <path d="M9 9 L12 12" />
            </svg>
          </button>

          {/* Phase 6.1 / 6.2 — Help button. Enters help mode (click-to-
              inspect): the next click on any element opens the Help panel at
              that element's surface, then exits. Ctrl+H does the same. The
              hamburger menu's Help entry remains the plain browse-from-root
              path. Sits between Find and Save with the same 7×7 accent
              treatment so the action cluster reads as one. */}
          <button
            onClick={() => useUiStore.getState().toggleHelpMode()}
            data-help-region="menu-bar:help"
            className="w-7 h-7 rounded text-white transition-colors flex-shrink-0 flex items-center justify-center bg-accent-700 hover:bg-accent-600"
            title="Help mode — click any element for help (Ctrl+H)"
            aria-label="Help mode"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </button>

          {/* Quick save button — stays visible per user direction.
              Floppy-disk glyph; state is communicated via background
              colour (green when just saved / autosaved, accent
              otherwise) and a small dot overlay when there are
              unsaved changes. */}
          <button
            onClick={handleSave}
            data-help-region="menu-bar:save"
            className={`relative w-7 h-7 rounded text-white transition-colors flex-shrink-0 flex items-center justify-center ${savedRecently || autosavedRecently ? 'bg-green-700 hover:bg-green-600' : 'bg-accent-700 hover:bg-accent-600'}`}
            title={`${savedRecently ? 'Saved ✓' : autosavedRecently ? 'Autosaved ✓' : hasUnsavedChanges ? 'Save (unsaved changes)' : 'Save'} (Ctrl+S)${activePath ? '\n' + activePath : '\nNo save location set'}`}
            aria-label="Save"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
              <polyline points="17 21 17 13 7 13 7 21" />
              <polyline points="7 3 7 8 15 8" />
            </svg>
            {(savedRecently || autosavedRecently) && (
              <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-green-300 border border-green-900" title="Saved" />
            )}
            {!savedRecently && !autosavedRecently && hasUnsavedChanges && (
              <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-amber-400 border border-amber-900" title="Unsaved changes" />
            )}
          </button>

          {/* Active file indicator */}
          {activeFilename && (
            <span className="text-xs text-zinc-500 font-mono truncate max-w-[200px] flex-shrink" title={activePath} data-help-region="menu-bar:active_file">
              {activeFilename}
            </span>
          )}

          {/* Centered story title — absolute-positioned within the
              canvas-area slot. Click → inline edit (Enter / blur
              commits, Escape cancels). Story Settings keeps the field
              for keyboard-driven edits. */}
          <div
            className="absolute left-1/2 top-1/2 pointer-events-none"
            style={{ transform: 'translate(-50%, -50%)' }}
            data-help-region="menu-bar:story_title"
          >
            {editingTitle ? (
              <input
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={commitEditTitle}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); commitEditTitle() }
                  else if (e.key === 'Escape') { e.preventDefault(); cancelEditTitle() }
                }}
                className="bg-zinc-800 border border-accent-500 rounded px-2 py-0.5 text-sm text-zinc-100 focus:outline-none pointer-events-auto"
                style={{ minWidth: 200 }}
              />
            ) : (
              <button
                type="button"
                onClick={beginEditTitle}
                className="text-sm font-semibold text-zinc-200 hover:text-accent-300 truncate max-w-md transition-colors pointer-events-auto"
                title={story?.title ? `${story.title}\n(click to edit)` : 'Click to set the story title'}
              >
                {story?.title && story.title !== 'Untitled Story' ? story.title : 'Untitled Story'}
              </button>
            )}
          </div>

          {/* Spacer pushes remaining items to far right */}
          <div className="flex-1" />

        {/* Re-expand chapter header button — only when the overlay is fully
            collapsed and the story still has zero chapters. Lives to the left
            of the media tray slot / alerts button so it's always findable. */}
          {chapterHeaderCollapsed && chaptersCount === 0 && (
            <button
              onClick={toggleChapterHeaderCollapsed}
              className="w-6 h-6 flex items-center justify-center rounded transition-colors text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 flex-shrink-0 opacity-70 hover:opacity-100"
              title="Show chapter header"
              style={{ fontSize: 11, lineHeight: 1 }}
            >
              {'\u25BC'}
            </button>
          )}

          <MediaPreviewTrayChip />
          <McpControlButton />
          <AlertsPanel />
        </div>
      </header>

      {/* Error banner. When an error is showing we also expose a link
          to the verbose error.log file the backend writes to
          ~/.narrativenode/error.log. Save / autosave / export catch
          blocks each append a timestamped entry there with the full
          Python traceback, so the writer can download the file from
          this banner and send it to support when something goes
          wrong. The link is `<a download>` rather than a fetch so the
          browser handles the file save dialog — no extra plumbing
          needed. */}
      {error && (
        <div className="flex items-center justify-between gap-3 px-4 py-2 bg-red-900/60 text-red-200 text-xs border-b border-red-700 flex-shrink-0">
          <span className="flex-1 min-w-0 truncate" title={error}>{error}</span>
          <a
            href="/api/diagnostics/error-log"
            download="narrativenode-error.log"
            className="flex-shrink-0 text-red-300 hover:text-white underline"
            title="Download the verbose backend error log (full tracebacks for every recent save / export failure). Useful for support."
          >
            Download error log
          </a>
          <button
            onClick={clearError}
            className="flex-shrink-0 text-red-300 hover:text-white"
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {/* Backend connection banner. The periodic poll that drives the
          single-instance handoff doubles as a liveness check: two
          consecutive failed polls flip this on, one success flips it
          off. When the backend is unreachable, saves and loads will
          fail — surface that immediately so the user knows changes
          aren't being persisted. */}
      {backendDisconnected && (
        <div className="px-4 py-2 bg-red-900/80 text-red-100 text-xs border-b border-red-700 flex-shrink-0">
          Lost connection to the NarrativeNode backend. Changes are not being saved.
          Check the terminal window and restart NarrativeNode if needed.
        </div>
      )}

      {/* Transient alert banner — short-lived messages (e.g. invalid
          file drops on the canvas or chat composer). Auto-dismisses
          after a few seconds, dismissible early via the ✕. Same
          layout family as the error / backendDisconnected banners
          above so it pushes the main row down rather than overlay
          anything. Fired via `uiStore.showTransientAlert(message)`. */}
      <TransientAlertBanner />

      {/* MCP session edit-lockout BANNER — thin strip above the main
          row when a session is active. Participates in the outer
          column flex (like the error / backendDisconnected banners
          above) so when it appears it pushes the main area down
          instead of overlaying the canvas's chapter / act header.
          Renders nothing when no session is active. The sidebar +
          canvas components themselves read MCP session state and
          apply their own pointer-events-none + opacity styling when
          locked, so this banner only handles the announcement +
          End session button. */}
      <McpSessionLockOverlay />

      {/* Main area. The Canvas column is wrapped in a vertical flex so the
          BottomZone can dock below it when a panel's `zone === 'bottom'`.
          RightZone wraps both the editor and chat panels in the right
          dock zone — it handles side-by-side vs stacked orientation, and
          gates each panel on its own zone matching 'right'. The same
          panels are also rendered inside BottomZone with `zone='bottom'`,
          and each instance self-selects whether to paint. */}
      <div className="relative flex flex-1 min-h-0">
        <EntityLibraryPanel />
        <div className="flex-1 flex flex-col min-w-0">
          <Canvas />
          <BottomZone />
        </div>
        <RightZone />
      </div>

      {/* Modals */}
      <EntityModal />
      <KnowledgeModal />  {/* open state lives in uiStore.knowledgeModalOpen */}
      {/* MCP destructive-action approval modal — pops whenever
          there's at least one pending destructive approval and the
          user hasn't yet opted into "Approve all destructive
          this session". Renders nothing when the queue is empty. */}
      <McpDestructiveApprovalModal />
      {/* Cross-tab lockout modal — rendered when this tab's WebSocket
          bridge was rejected by the backend because another browser
          tab / window is currently driving an active MCP session
          (first-wins-during-active-session policy). Subscribes to
          `mcpControlStore.bridgeStatus`; renders nothing in the
          normal case. */}
      <McpCrossTabLockoutModal />
      <AwarenessSurfacePanel />    {/* unified awareness modal — uiStore.awarenessSurfacePanel */}
      {showSavePath && <SavePathModal onSave={handleSavePathConfirm} onCancel={handleSavePathCancel} initialPath={activePath} />}
      {showSettings && (
        <SettingsPanel
          initialTabId={settingsInitialTab}
          onClose={() => { setShowSettings(false); setSettingsInitialTab(null) }}
        />
      )}
      <ExportCharacterCardModal open={showCardExport} onClose={() => setShowCardExport(false)} />
      <ExportDialog />         {/* open state lives in uiStore.exportDialogOpen */}
      <GlobalSearchModal />    {/* Phase 1.24d — open state lives in uiStore.globalSearchOpen */}
      <Suspense fallback={null}>
        <DevPreviewPanel />    {/* hidden dev-only preview; toggled via Ctrl+`. Lazy-loaded (F#9). */}
      </Suspense>
      <ImportDialog />         {/* open state lives in uiStore.importDialogOpen */}
      <NovelcrafterImportDialog
        guardUnsavedChanges={guardUnsavedChanges}
        onApplied={async (result) => {
          // Mirrors the TemplateImportDialog onApplied path: clear
          // the detail panel (NC import always wipes the active
          // project — entity-id lookups against the prior project's
          // ids would return null mid-render), then GET the freshly
          // imported story and rebuild canvas + entity store.
          try { await useUiStore.getState().clearDetailPanel({ force: true }) } catch { /* ignore */ }
          try {
            const { data } = await axios.get('/api/story/')
            useProjectStore.getState().applyImportedStory(data)
            useProjectStore.setState({ activePath: null })
          } catch (err) {
            console.error('Novelcrafter import: failed to refresh story after apply', err, result)
          }
        }}
        onCancelled={async (result) => {
          // Phase 3.10 — cancel revert path. The backend has
          // restored `state._story` to the pre-import snapshot and
          // deleted any cues / chats that landed before the cancel
          // arrived. We mirror that on the frontend by clearing the
          // detail panel + re-applying whatever `/api/story/` now
          // returns — which IS the previous story per the backend
          // restore. Same shape as `onApplied`, different semantic:
          // we're loading the SAME state the user had before they
          // clicked Import.
          try { await useUiStore.getState().clearDetailPanel({ force: true }) } catch { /* ignore */ }
          try {
            const { data } = await axios.get('/api/story/')
            useProjectStore.getState().applyImportedStory(data)
          } catch (err) {
            console.error('Novelcrafter import: failed to refresh story after cancel', err, result)
          }
        }}
      />

      <TemplateImportDialog
        open={templateImportDialogOpen}
        onClose={closeTemplateImportDialog}
        guardUnsavedChanges={guardUnsavedChanges}
        onApplied={async (mode) => {
          // Clear any open Detail Panel before swapping the story:
          // the panel is keyed on entity-id / node-id from the prior
          // project, and a `new`-mode import wipes those entirely
          // (chip lookups by stale id return null mid-render and have
          // hit hook-ordering edge cases in EntityDetailView's deep
          // child tree). Force=true bypasses the dirty-draft guard
          // since the import flow already prompted via
          // `guardUnsavedChanges` in `new` mode.
          try { await useUiStore.getState().clearDetailPanel({ force: true }) } catch { /* ignore */ }

          // Pull the freshly-applied story off the backend and rebuild
          // canvas + entity store. New-mode replaces; merge-mode appended.
          // Trailing slash on the GET path matches every other story
          // fetch in the store.
          try {
            const { data } = await axios.get('/api/story/')
            useProjectStore.getState().applyImportedStory(data)
            if (mode === 'new') {
              useProjectStore.setState({ activePath: null })
            }
          } catch (err) {
            console.error('Template import: failed to refresh story after apply', err)
          }
        }}
      />

      <HierarchyEditorModal /> {/* open state lives in uiStore.hierarchyEditorOpen */}
      <SceneTimeModalMount />  {/* Phase 1.23 — open state lives in uiStore.sceneTimeModalOpen */}
      <FactionMemberPromptDialog /> {/* open state lives in uiStore.factionMemberPrompt */}
      <HelpPanel /> {/* Phase 1.27 — open state lives in uiStore.helpPanelOpen */}
      <HelpModeController /> {/* Phase 6.2 — click-to-inspect help mode (Ctrl+H) */}
      <LibraryView onOpenProject={handleOpenLibraryProject} onNewStory={handleNewStoryFromLibrary} onOpenFile={handleOpenFileFromLibrary} onSettings={handleSettingsFromLibrary} /> {/* Phase 5.5 — full-screen story library surface (opens from the hamburger) */}

      {/* "Opening…" overlay shown for the duration of ANY project load
          (recents, hamburger Open, dropped file, library card, file
          association / startup), driven by `_loadingProject` in projectStore
          so every load path gets the same visible feedback. The title shows
          when known; otherwise a generic message. */}
      {_loadingProject && (
        <div className="fixed inset-0 z-[200] flex flex-col items-center justify-center gap-3 bg-zinc-950/80 backdrop-blur-sm">
          <div className="w-10 h-10 rounded-full border-2 border-zinc-600 border-t-accent-500 animate-spin" />
          <div className="text-sm text-zinc-200">
            Opening {_loadingProjectTitle
              ? <span className="font-medium text-zinc-50">{_loadingProjectTitle}</span>
              : 'project'}…
          </div>
        </div>
      )}

      {/* Floating Media Preview Panel (Phase 1.10 Track B) — renders only when
          previewStore has an expanded panel; otherwise returns null. */}
      <MediaPreviewPanel />

      {/* Floating Inline Prompt Block (Phase 2.9c item 2) — singleton
          across the editor. Renders only when `useIpbStore.active`
          is true; otherwise returns null. Mounted at the App level
          so the portal target survives editor remounts when the
          writer switches between editor surfaces. */}
      <InlinePromptBlock />

      {/* Global reusable confirm / alert dialog (Phase 1.13). Reads
          from `dialogStore.confirmDialog`; returns null when no
          dialog is open. Mounted once here at the app root so every
          `confirm({...})` call site shares the same DOM slot. */}
      <ConfirmDialog />
      <AwarenessRolloverModal />
      <AddKnowledgeFromChangePopover />
      <ImageCropHost />
    </div>
  )
}

export default App
