import { useMemo, useState } from 'react'
import { useUiStore } from '../../store/uiStore'
import { useProjectStore } from '../../store/projectStore'
import { usePinnedContextStore } from '../../store/pinnedContextStore'
import ScenePickerPopover from '../entities/ScenePickerPopover'


// Stable empty array used by the per-thread scenes selector below.
// Returning a fresh `[]` literal inside a Zustand selector triggers
// the "result of getSnapshot should be cached" warning and an
// infinite re-render loop, since each call yields a new reference.
const _EMPTY_SCENE_IDS = Object.freeze([])
const _EMPTY_PINS = Object.freeze([])

function _newTocSessionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'toc_' + Math.random().toString(36).slice(2) + Date.now().toString(36)
}


/**
 * Story Scope controls — Phase 2.5h.
 *
 * Lives inside the + Add Context popup's "Scenes & Story Scope" tab.
 * Drives the per-thread `chatStoryScope*` state on `uiStore`. The
 * controls themselves don't render scene context — that happens at
 * send time in `ConversationView.streamAssistantReply`, which reads
 * the same per-thread state and calls `buildStoryScopeAppendage`.
 *
 * Per-control validity gating (Phase 2.5h Q10):
 *   - Whole-story radio greys out when the project has zero scenes
 *     (Off stays interactive — that's the default).
 *   - By chapter greys out when zero chapters.
 *   - By act greys out when zero acts.
 *   - Specific scenes greys out when zero scenes.
 *   - Prev / Next greys out when no active scene is set.
 */
export default function StoryScopeControls({ threadId }) {
  // Per-thread state pulls.
  const mode             = useUiStore((s) => (threadId ? s.chatStoryScopeMode?.[threadId] || null : null))
  const includePrev      = useUiStore((s) => (threadId ? !!s.chatStoryScopeIncludePrev?.[threadId] : false))
  const includeNext      = useUiStore((s) => (threadId ? !!s.chatStoryScopeIncludeNext?.[threadId] : false))
  const scopeChapter     = useUiStore((s) => (threadId ? s.chatStoryScopeChapter?.[threadId] || '' : ''))
  const scopeAct         = useUiStore((s) => (threadId ? s.chatStoryScopeAct?.[threadId] || '' : ''))
  const activeSceneId    = useUiStore((s) => s.chatActiveSceneId)

  const setMode          = useUiStore((s) => s.setChatStoryScopeMode)
  const setChapter       = useUiStore((s) => s.setChatStoryScopeChapter)
  const setAct           = useUiStore((s) => s.setChatStoryScopeAct)
  const setIncludePrev   = useUiStore((s) => s.setChatStoryScopeIncludePrev)
  const setIncludeNext   = useUiStore((s) => s.setChatStoryScopeIncludeNext)

  // Project shape — counts drive validity gating, lists drive the
  // dropdown options.
  const projectNodes  = useProjectStore((s) => s.nodes)
  const chapters      = useProjectStore((s) => s.story?.chapters)
  const acts          = useProjectStore((s) => s.story?.acts)
  const storyId       = useProjectStore((s) => s.story?.id) || ''

  // Pinned-context surface — drives both the TOC pin (kind:'toc')
  // lookup below AND the unified scene-pin list (kind:'scene')
  // that powers SceneScopeList's picker exclude set + count.
  // Declared BEFORE the dependent memos so they don't TDZ-trap.
  const surfaceKey = threadId ? `chat:${threadId}` : null
  const surfacePins = usePinnedContextStore((s) => (surfaceKey ? s.surfaces[surfaceKey] : null)) || _EMPTY_PINS
  const addPin = usePinnedContextStore((s) => s.addPin)
  const removePin = usePinnedContextStore((s) => s.removePin)
  const updatePinMode = usePinnedContextStore((s) => s.updatePinMode)
  // Per-scene picks now live as static `kind: 'scene'` pins on the
  // unified pinnedContextStore — same storage and same chip type
  // as canvas-Attach scene pins. Derive a `[{id, mode}]` projection
  // for the picker's exclude-set + count from the live pin list.
  const scopeScenes      = useMemo(() => {
    return surfacePins
      .filter((p) => p && p.kind === 'scene' && p.id)
      .map((p) => ({ id: p.id, mode: p.mode || 'summary', sessionId: p.sessionId }))
  }, [surfacePins])
  const tocPin = useMemo(
    () => surfacePins.find((p) => p && p.kind === 'toc' && p.id === storyId) || null,
    [surfacePins, storyId],
  )
  const hasToc = !!tocPin
  function toggleToc() {
    if (!surfaceKey || !storyId) return
    if (hasToc) {
      removePin(surfaceKey, tocPin.sessionId)
    } else {
      addPin(surfaceKey, {
        sessionId: _newTocSessionId(),
        kind: 'toc',
        id: storyId,
        source: 'manual',
      })
    }
  }

  const sceneCount = useMemo(
    () => (projectNodes || []).filter((n) => n && n.type === 'sceneNode').length,
    [projectNodes]
  )
  const hasChapters = (chapters || []).length > 0
  const hasActs     = (acts || []).length > 0
  const hasAnyScenes = sceneCount > 0
  const hasActiveScene = !!activeSceneId

  const noThread = !threadId

  // Radio handler — accepts the special 'off' value as a clear.
  function onModeChange(next) {
    if (!threadId) return
    setMode(threadId, next === 'off' ? null : next)
  }

  return (
    <div className="px-1.5 pb-1 space-y-2 text-zinc-200" data-help-region="story-scope:controls">
      {/* Story Table of Contents toggle — story-specific static pin. */}
      <fieldset className="space-y-1" disabled={noThread || !storyId} data-help-region="story-scope:table_of_contents">
        <legend className="text-[9px] uppercase tracking-wide text-zinc-500 mb-0.5">
          Story overview
        </legend>
        <label
          className={`flex items-start gap-1.5 text-[10.5px] leading-tight rounded px-1 py-0.5 ${
            noThread || !storyId
              ? 'opacity-40 cursor-not-allowed'
              : 'hover:bg-zinc-800/60 cursor-pointer'
          }`}
          title={
            !storyId
              ? 'Open a story to attach its table of contents.'
              : hasToc
                ? 'Click to remove the story table of contents from this conversation.'
                : 'Click to attach a nested outline of the story (acts, chapters, scenes) with an indicator on the current scene.'
          }
        >
          <input
            type="checkbox"
            checked={hasToc}
            onChange={toggleToc}
            disabled={noThread || !storyId}
            className="mt-0.5"
          />
          <span>
            <div className="font-medium">Story Table of Contents</div>
            <div className="text-zinc-400 text-[9px]">
              Nested outline of acts, chapters, and scenes with an indicator on the current scene.
            </div>
          </span>
        </label>
      </fieldset>
      {/* Whole-story radio */}
      <fieldset className="space-y-1" disabled={noThread} data-help-region="story-scope:whole_story">
        <legend className="text-[9px] uppercase tracking-wide text-zinc-500 mb-0.5">
          Whole story
        </legend>
        <ModeRadio
          name={`storyscope-mode-${threadId || 'none'}`}
          value="off"
          label="Off"
          description="No whole-story context added."
          checked={!mode}
          onChange={onModeChange}
          disabled={false /* Off is always interactive */}
        />
        <ModeRadio
          name={`storyscope-mode-${threadId || 'none'}`}
          value="summary"
          label="Whole story descriptions"
          description="Every scene: title, position, and short description."
          checked={mode === 'summary'}
          onChange={onModeChange}
          disabled={!hasAnyScenes}
          hint={!hasAnyScenes ? 'No scenes in this project yet.' : ''}
        />
        <ModeRadio
          name={`storyscope-mode-${threadId || 'none'}`}
          value="summary_with_changes"
          label="Whole story descriptions + changes"
          description="Adds per-scene change list (entity / relationship / knowledge / awareness deltas)."
          checked={mode === 'summary_with_changes'}
          onChange={onModeChange}
          disabled={!hasAnyScenes}
          hint={!hasAnyScenes ? 'No scenes in this project yet.' : ''}
        />
        <ModeRadio
          name={`storyscope-mode-${threadId || 'none'}`}
          value="full_content"
          label="Whole story full content"
          description="Adds the full main_content body for every scene. Token-heavy."
          checked={mode === 'full_content'}
          onChange={onModeChange}
          disabled={!hasAnyScenes}
          hint={!hasAnyScenes ? 'No scenes in this project yet.' : ''}
        />
      </fieldset>

      {/* Prev / Next neighbours */}
      <fieldset className="space-y-1" disabled={noThread} data-help-region="story-scope:scene_neighbours">
        <legend className="text-[9px] uppercase tracking-wide text-zinc-500 mb-0.5">
          Active scene neighbours
        </legend>
        <CheckboxRow
          checked={includePrev}
          disabled={!hasActiveScene}
          hint={!hasActiveScene ? 'No active scene to anchor neighbours to.' : ''}
          onChange={(v) => threadId && setIncludePrev(threadId, v)}
          label="Include previous scene"
        />
        <CheckboxRow
          checked={includeNext}
          disabled={!hasActiveScene}
          hint={!hasActiveScene ? 'No active scene to anchor neighbours to.' : ''}
          onChange={(v) => threadId && setIncludeNext(threadId, v)}
          label="Include next scene"
        />
      </fieldset>

      {/* Chapter / Act scope */}
      <fieldset className="space-y-1" disabled={noThread} data-help-region="story-scope:scope">
        <legend className="text-[9px] uppercase tracking-wide text-zinc-500 mb-0.5">
          Scope
        </legend>
        <ScopeSelect
          label="By chapter"
          value={scopeChapter}
          options={(chapters || []).map((c) => ({ id: c.id, label: c.title || c.name || 'Untitled chapter' }))}
          onChange={(v) => threadId && setChapter(threadId, v || null)}
          disabled={!hasChapters}
          hint={!hasChapters ? 'No chapters in this project yet.' : ''}
        />
        <ScopeSelect
          label="By act"
          value={scopeAct}
          options={(acts || []).map((a) => ({ id: a.id, label: a.title || a.name || 'Untitled act' }))}
          onChange={(v) => threadId && setAct(threadId, v || null)}
          disabled={!hasActs}
          hint={!hasActs ? 'No acts in this project yet.' : ''}
        />
        <SceneScopeList
          sceneEntries={scopeScenes}
          projectNodes={projectNodes || []}
          onAdd={(id) => {
            if (!surfaceKey || !id) return
            // Dedup: if a scene-kind pin for this id already exists,
            // skip. The picker's exclude-set should already prevent
            // double-adds, but defence-in-depth.
            const already = scopeScenes.some((e) => e.id === id)
            if (already) return
            addPin(surfaceKey, { kind: 'scene', id, mode: 'summary', source: 'manual' })
          }}
          onRemove={(id) => {
            if (!surfaceKey) return
            const entry = scopeScenes.find((e) => e.id === id)
            if (entry?.sessionId) removePin(surfaceKey, entry.sessionId)
          }}
          onClear={() => {
            if (!surfaceKey) return
            // Remove every scene-kind pin one at a time. Cheap;
            // typical writer-pinned scene counts are small.
            for (const e of scopeScenes) {
              if (e.sessionId) removePin(surfaceKey, e.sessionId)
            }
          }}
          onCycleMode={(id, nextMode) => {
            if (!surfaceKey) return
            const entry = scopeScenes.find((e) => e.id === id)
            if (entry?.sessionId) updatePinMode(surfaceKey, entry.sessionId, nextMode)
          }}
          disabled={!hasAnyScenes}
        />
      </fieldset>
    </div>
  )
}


function ModeRadio({ name, value, label, description, checked, onChange, disabled, hint }) {
  return (
    <label
      className={`flex items-start gap-1.5 text-[10.5px] leading-tight cursor-pointer ${disabled ? 'opacity-40 cursor-not-allowed' : 'hover:bg-zinc-800/60'} rounded px-1 py-0.5`}
      title={hint || undefined}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={() => onChange(value)}
        className="mt-0.5 cursor-pointer"
      />
      <span className="flex-1">
        <span className="font-medium text-zinc-100">{label}</span>
        <span className="block text-[9.5px] text-zinc-500">{description}</span>
      </span>
    </label>
  )
}


function CheckboxRow({ checked, disabled, onChange, label, hint }) {
  return (
    <label
      className={`flex items-center gap-1.5 text-[10.5px] cursor-pointer ${disabled ? 'opacity-40 cursor-not-allowed' : 'hover:bg-zinc-800/60'} rounded px-1 py-0.5`}
      title={hint || undefined}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="cursor-pointer"
      />
      <span className="text-zinc-200">{label}</span>
    </label>
  )
}


function ScopeSelect({ label, value, options, onChange, disabled, hint }) {
  return (
    <div className="flex items-center gap-1.5 text-[10.5px] px-1 py-0.5" title={hint || undefined}>
      <span className={`w-20 ${disabled ? 'text-zinc-600' : 'text-zinc-400'}`}>{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={`flex-1 bg-zinc-800 border border-zinc-700 rounded px-1 py-0.5 text-[10px] ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
      >
        <option value="">(none)</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>{o.label}</option>
        ))}
      </select>
    </div>
  )
}


// Inline list of hand-picked scenes plus a collapsible "Add scene"
// picker. The picker is hidden by default; clicking "+ Add scene"
// opens the project's full ScenePickerPopover inline, scoped to
// scenes not already in the list. Picking a scene adds it and
// keeps the picker open (additive multi-select per the planning
// doc); the writer closes the picker explicitly via "Done".
function SceneScopeList({ sceneEntries, projectNodes, onAdd, onClear, disabled }) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const sceneNodeById = useMemo(() => {
    const out = new Map()
    for (const n of projectNodes) {
      if (n && n.type === 'sceneNode') out.set(n.id, n)
    }
    return out
  }, [projectNodes])

  // Normalise entries — accept the new `{ id, mode }` shape AND
  // legacy plain-string entries from any callers that haven't
  // migrated. Default mode is `'summary'`.
  const items = (sceneEntries || []).map((e) => {
    const id = typeof e === 'string' ? e : e?.id
    const mode = typeof e === 'string' ? 'summary' : (e?.mode || 'summary')
    const node = sceneNodeById.get(id)
    return { id, mode, label: node?.data?.title || '(scene)' }
  })

  // List of every scene node for the picker — derived from projectNodes
  // rather than refetching from the store so the data stays in sync
  // with whatever the popup tab already pulled.
  const allScenes = useMemo(
    () => projectNodes.filter((n) => n && n.type === 'sceneNode'),
    [projectNodes],
  )
  const excludeSet = useMemo(
    () => new Set((sceneEntries || []).map((e) => (typeof e === 'string' ? e : e?.id)).filter(Boolean)),
    [sceneEntries],
  )

  return (
    <div className="px-1 py-0.5 space-y-0.5" aria-disabled={disabled}>
      <div className="flex items-center gap-2 text-[9px] uppercase tracking-wide text-zinc-500">
        <span>Specific scenes</span>
        <div className="ml-auto flex items-center gap-1.5">
          {items.length > 0 && !disabled && (
            <button
              type="button"
              onClick={onClear}
              className="text-zinc-500 hover:text-zinc-300 text-[9px] uppercase tracking-wide"
            >
              Clear
            </button>
          )}
          {!disabled && (
            <button
              type="button"
              onClick={() => setPickerOpen((v) => !v)}
              className={`text-[9px] uppercase tracking-wide ${pickerOpen ? 'text-zinc-200' : 'text-zinc-400 hover:text-zinc-200'}`}
              aria-expanded={pickerOpen}
              title={pickerOpen ? 'Hide scene picker' : 'Open scene picker to add scenes'}
            >
              {pickerOpen ? 'Done' : '+ Add scene'}
            </button>
          )}
        </div>
      </div>
      {/* The picker shows just the "+ Add scene" affordance now —
          the previous inline pseudo-pill display has been removed.
          Picked scenes appear as chips in the chat composer's active
          context strip directly (above the textarea), where the
          writer can cycle their detail level, remove them, etc.
          Eliminates the previous redundancy where added scenes
          showed BOTH inside this popup AND on the active context
          strip with two separate copies of the cycle button. */}
      {items.length === 0 && (
        <div className={`text-[9.5px] ${disabled ? 'text-zinc-700' : 'text-zinc-500'}`}>
          {disabled
            ? 'No scenes in this project yet.'
            : 'Click + Add scene to pick scenes. Picks appear as chips in the composer\'s context strip below.'}
        </div>
      )}
      {items.length > 0 && (
        <div className={`text-[9.5px] ${disabled ? 'text-zinc-700' : 'text-zinc-500'}`}>
          {items.length} scene{items.length === 1 ? '' : 's'} picked. View / edit on the chips in the context strip below.
        </div>
      )}
      {pickerOpen && !disabled && (
        <div className="mt-1 border border-zinc-800 rounded bg-zinc-950/60">
          <ScenePickerPopover
            allScenes={allScenes}
            excludeIds={excludeSet}
            onPick={(id) => {
              if (id) onAdd(id)
              // Stay open — writer can pick more. The Done button
              // (or another tab switch) closes it.
            }}
            onClose={() => setPickerOpen(false)}
          />
        </div>
      )}
    </div>
  )
}


// Mode cycle: Summary → Summary + changes → Full content → Summary.
const _MODE_CYCLE = ['summary', 'summary_with_changes', 'full_content']
function _nextMode(current) {
  const idx = _MODE_CYCLE.indexOf(current)
  if (idx < 0) return 'summary_with_changes'
  return _MODE_CYCLE[(idx + 1) % _MODE_CYCLE.length]
}
function _modeLabel(mode) {
  switch (mode) {
    case 'summary_with_changes': return 'Desc+Chng'
    case 'full_content': return 'Full'
    case 'summary':
    default:
      return 'Description'
  }
}


// Multi-line hover tooltip describing the current state, the other
// two states, and what clicking does. Uses `\n` line breaks — most
// browsers render native `title` tooltips on multiple lines when the
// value contains newlines.
//
// Note: the user-facing label is "Description" / "Desc+Chng" / "Full"
// because what the lightest level actually sends is the scene's
// `description` field (not a generated summary). Internal mode keys
// (`summary` / `summary_with_changes` / `full_content`) stay as they
// were — changing them would migrate the per-thread uiStore state.
function _modeTooltip(current) {
  const lines = []
  lines.push(`Current: ${_modeLabel(current)}`)
  lines.push('')
  lines.push('Description — scene title, position in the story, and the scene\'s short description.')
  lines.push('Desc+Chng — Description, plus the chain events recorded at this scene (entity, relationship, knowledge, and awareness changes).')
  lines.push('Full — Desc+Chng, plus the scene\'s full main_content body. Token-heavy.')
  lines.push('')
  lines.push(`Click to cycle to: ${_modeLabel(_nextMode(current))}.`)
  return lines.join('\n')
}
