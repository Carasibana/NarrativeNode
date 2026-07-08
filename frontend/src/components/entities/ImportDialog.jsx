/**
 * ImportDialog — Phase 1.12b Track 3.
 *
 * Modal picker for importing entities from a source NarrativeNode
 * project file (`.nnz`, or legacy `.nnplot`). Opens via the Import /
 * Export dropdown in the top header bar.
 *
 * Layout (Track 3 scope):
 *   HEADER         — title + close button.
 *   FILE PICKER    — "Choose project file" button + selected filename +
 *                    loading indicator while /preview is in flight.
 *   LEFT PANE      — Add Entity picker: type tabs (Characters / Locations
 *                    / Items / Factions / Custom), search field, list of
 *                    source entities, per-row Add button, "Add All" for
 *                    the active tab. Rows already in the grid are marked
 *                    with a check + greyed out.
 *   RIGHT PANE     — timeline grid placeholder (Track 4 will replace).
 *                    Shows a count of entities added to the grid so
 *                    Track 3 is testable standalone.
 *   FOOTER         — Import button (disabled until Track 6 lands) +
 *                    Cancel button.
 *
 * State management is entirely local — the dialog is single-instance and
 * short-lived, same reasoning as ExportDialog. Only the open/closed flag
 * lives in `uiStore.importDialogOpen`.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useUiStore } from '../../store/uiStore'
import { useProjectStore, handleSaveFormatLoadError } from '../../store/projectStore'
import { TYPE_ICONS } from '../../utils/entityHelpers'
import ImageHoverPreview from '../ui/ImageHoverPreview'
import ImportTimelineGrid from './ImportTimelineGrid'
import ImportStatePreviewPane from './ImportStatePreviewPane'

/**
 * Entity thumbnail matching the canonical app pattern from
 * [EntityLibraryPanel.jsx:76-90] and [EntityListAttribute.jsx:307-318]:
 *
 *   - ImageHoverPreview wrapper: large-preview-on-hover when src is
 *     non-null, no-op when null.
 *   - w-6 h-6 rounded-sm square with a 1.5px entity-colour border.
 *   - With a profile image: `<img object-cover>` filling the square.
 *   - Without a profile image: TYPE_ICON glyph centred on a
 *     colour-tinted background (`colour + '22'`).
 *
 * The import preview serialises profile images as base64 data URIs
 * (`profile_image_data_uri`) so the src we pass to ImageHoverPreview is
 * the data URI itself — no extra fetch needed for the hover preview.
 */
function EntityThumb({ entity }) {
  const colour = entity.colour || '#888888'
  const src    = entity.profile_image_data_uri || null
  return (
    <ImageHoverPreview src={src} borderColour={colour}>
      {src ? (
        <img
          src={src}
          alt=""
          className="w-6 h-6 rounded-sm object-cover flex-shrink-0"
          style={{ border: `1.5px solid ${colour}` }}
        />
      ) : (
        <span
          className="w-6 h-6 rounded-sm flex items-center justify-center flex-shrink-0 text-xs"
          style={{ backgroundColor: colour + '22', border: `1.5px solid ${colour}` }}
        >
          {TYPE_ICONS[entity.type] || '?'}
        </span>
      )}
    </ImageHoverPreview>
  )
}

// Type tabs mirror the Entity List attribute picker's vocabulary:
// icon-only, tooltip labels, an "All" option at the left using the same
// ⊕ glyph. Icons only so the tab row reads as a uniform strip instead
// of a variable-width button cluster. The rightmost tab is **Preset
// Lists**, which is visually a separate kind of thing from entity
// tabs — it governs a separate selection set (`selectedPresetListIds`)
// and is explicitly NOT rolled into the ⊕ "All" view.
const TYPE_TABS = [
  { key: 'all',          icon: '⊕',                  label: 'All' },
  { key: 'character',    icon: TYPE_ICONS.character, label: 'Characters' },
  { key: 'location',     icon: TYPE_ICONS.location,  label: 'Locations' },
  { key: 'item',         icon: TYPE_ICONS.item,      label: 'Items' },
  { key: 'faction',      icon: TYPE_ICONS.faction,   label: 'Factions' },
  { key: 'custom',       icon: TYPE_ICONS.custom,    label: 'Custom entities' },
  { key: 'knowledge',    icon: TYPE_ICONS.knowledge || '🧠', label: 'Knowledges' },
  { key: 'preset_lists', icon: '📋',                 label: 'Preset lists' },
]

/** Thumbnail for a Knowledge row in the picker. Mirrors
 *  `<EntityThumb>` but reads `colour` / `profile_image_data_uri`
 *  directly off the ImportKnowledgeRow (no entity-type icon
 *  fallback — Knowledge has its own glyph). */
function KnowledgeThumb({ knowledge }) {
  const colour = knowledge.colour || '#888888'
  const src    = knowledge.profile_image_data_uri || null
  return (
    <ImageHoverPreview src={src} borderColour={colour}>
      {src ? (
        <img
          src={src}
          alt=""
          className="w-6 h-6 rounded-sm object-cover flex-shrink-0"
          style={{ border: `1.5px solid ${colour}` }}
        />
      ) : (
        <span
          className="w-6 h-6 rounded-sm flex items-center justify-center flex-shrink-0 text-xs"
          style={{ backgroundColor: colour + '22', border: `1.5px solid ${colour}` }}
        >
          {TYPE_ICONS.knowledge || '🧠'}
        </span>
      )}
    </ImageHoverPreview>
  )
}

function uploadPreview(file) {
  const form = new FormData()
  form.append('file', file)
  return fetch('/api/project/import/preview', { method: 'POST', body: form })
    .then(async (res) => {
      if (!res.ok) {
        // Preserve the full structured detail object on the thrown
        // Error so handleSaveFormatLoadError (which expects an axios-
        // shaped `err.response.data.detail`) can read it. The error's
        // .message stays human-readable for the fallback banner.
        let data = null
        try { data = await res.json() } catch { /* swallow */ }
        const msg = typeof data?.detail === 'string'
          ? data.detail
          : 'Preview failed.'
        const err = new Error(msg)
        err.response = { data, status: res.status }
        throw err
      }
      return res.json()
    })
}

export default function ImportDialog() {
  const open  = useUiStore((s) => s.importDialogOpen)
  const close = useUiStore((s) => s.closeImportDialog)
  const applyImportedStory = useProjectStore((s) => s.applyImportedStory)

  // ── Upload + preview state ───────────────────────────────────────
  const [fileName, setFileName]   = useState(null)
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState(null)
  const [preview, setPreview]     = useState(null)   // full ImportPreview JSON
  const fileInputRef              = useRef(null)
  const panelRef                  = useRef(null)

  // ── Picker state (left pane) ─────────────────────────────────────
  const [activeTab, setActiveTab]   = useState('all')
  const [searchQuery, setSearchQuery] = useState('')

  // ── Grid state (shared w/ Tracks 4-6) ────────────────────────────
  // addedIds is an ordered list of entity ids the user has pulled from
  // the picker into the grid. selectedRowIds is the grid's row-
  // selection set (drives which rows receive column-header clicks).
  // importPicks maps each staged entity id to the chosen state-point
  // for commit — matches the backend's ImportStatePoint shape.
  const [addedIds, setAddedIds] = useState(() => new Set())
  const [selectedRowIds, setSelectedRowIds] = useState(() => new Set())
  const [importPicks, setImportPicks] = useState(() => new Map())
  // Knowledge picker mirrors the entity picker: a Set of staged
  // source knowledge ids + a Map of per-knowledge state-point picks.
  // The grid renders Knowledge rows below the entity rows; the picker
  // tab renders Knowledge rows in its own filtered view.
  const [addedKnowledgeIds, setAddedKnowledgeIds] = useState(() => new Set())
  const [knowledgePicks, setKnowledgePicks] = useState(() => new Map())

  // State preview pane height — user-resizable via the drag handle
  // at the top of the pane. Default 220, clamped to [120, 600],
  // persisted in localStorage so the chosen size sticks across
  // dialog opens + app restarts. `nn_importPreviewPaneH` key.
  const [previewPaneHeight, setPreviewPaneHeight] = useState(() => {
    try {
      const raw = localStorage.getItem('nn_importPreviewPaneH')
      const n = raw ? parseInt(raw, 10) : NaN
      if (Number.isFinite(n) && n >= 120 && n <= 600) return n
    } catch { /* swallow */ }
    return 220
  })
  // Which entity row is currently mirrored in the bottom preview
  // pane. null = no preview shown. Updated when the user clicks a
  // dot in the timeline grid OR clicks a row identity cell; the
  // pane pulls the actual state-point from importPicks on render,
  // so a column-header click that changes the pick for the
  // previewed row auto-refreshes the pane without needing a
  // separate signal.
  const [previewedEntityId, setPreviewedEntityId] = useState(null)

  // ── Commit flow (Track 6) ────────────────────────────────────────
  // `committing` → button spinner state while the POST is in flight.
  // `commitError` → inline error banner below the file row on 400/500.
  // `commitSummary` → when set, the dialog shows a success overlay
  // instead of the picker/grid/preview body and waits for the user
  // to click "Done" (or cancel-key-close). The overlay replaces the
  // need for a separate toast system.
  const [committing, setCommitting] = useState(false)
  const [commitError, setCommitError] = useState(null)
  const [commitSummary, setCommitSummary] = useState(null)
  // Opt-in flag for story-level settings — still a simple checkbox
  // in the footer. Default off per the plan.
  const [importStorySettings, setImportStorySettings] = useState(false)
  // Explicit per-list preset selection set. Populated by the user
  // via the Preset Lists tab in the picker + auto-populated with
  // any list that a staged entity depends on (those are LOCKED —
  // can't be deselected while the dependent entity is in the grid).
  // Feeds the commit request's `preset_list_ids` list.
  const [selectedPresetListIds, setSelectedPresetListIds] = useState(() => new Set())

  // Reset dialog state when it opens so re-opening shows a blank
  // slate. Keeps the previous session id from leaking across opens.
  useEffect(() => {
    if (!open) return
    setFileName(null)
    setLoading(false)
    setError(null)
    setPreview(null)
    setActiveTab('all')
    setSearchQuery('')
    setAddedIds(new Set())
    setSelectedRowIds(new Set())
    setImportPicks(new Map())
    setAddedKnowledgeIds(new Set())
    setKnowledgePicks(new Map())
    setPreviewedEntityId(null)
    setImportStorySettings(false)
    setSelectedPresetListIds(new Set())
    setCommitting(false)
    setCommitError(null)
    setCommitSummary(null)
  }, [open])

  // Close on Escape. Click-outside is intentionally OFF for this
  // dialog — the user's work-in-progress (picked entities) shouldn't
  // be nuked by a stray click outside the panel, matching the
  // "destructive action confirmation" rule of thumb.
  useEffect(() => {
    if (!open) return undefined
    function onKey(e) { if (e.key === 'Escape') close() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, close])

  async function handleFileChosen(e) {
    const file = e.target.files?.[0]
    if (!file) return
    const lower = file.name.toLowerCase()
    if (!(lower.endsWith('.nnz') || lower.endsWith('.nnplot'))) {
      setError('File must have a .nnz extension (or legacy .nnplot).')
      setFileName(file.name)
      setPreview(null)
      return
    }
    setFileName(file.name)
    setLoading(true)
    setError(null)
    setPreview(null)
    try {
      const data = await uploadPreview(file)
      setPreview(data)
      // Clear any previously-added grid entries — they belonged to
      // a different source file.
      setAddedIds(new Set())
    } catch (err) {
      // If the backend rejected the file with a structured save-format
      // error (incompatible_save / corrupt_save), show the shared
      // version-dialog before falling back to the generic banner.
      const structured = await handleSaveFormatLoadError(err)
      setError(structured || err?.message || 'Preview failed.')
    } finally {
      setLoading(false)
      // Reset the native input so picking the SAME file twice still
      // fires onChange (browsers skip the event when value is
      // unchanged).
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  // Source entities filtered by the active type tab and the search
  // field. Memoised so typing in the search box doesn't thrash the
  // rest of the panel's rendering. The `preset_lists` tab is
  // handled separately — this memo only returns entity rows.
  const filteredEntities = useMemo(() => {
    if (!preview?.entities) return []
    if (activeTab === 'preset_lists') return []
    const q = searchQuery.trim().toLowerCase()
    return preview.entities.filter((ent) => {
      if (activeTab !== 'all' && ent.type !== activeTab) return false
      if (!q) return true
      return ent.name.toLowerCase().includes(q)
    })
  }, [preview, activeTab, searchQuery])

  // Knowledges filtered by the search field. Visible under the
  // Knowledge tab AND the All tab (the All view is a unified
  // "everything importable" surface).
  const filteredKnowledges = useMemo(() => {
    if (!preview?.knowledges) return []
    if (activeTab !== 'knowledge' && activeTab !== 'all') return []
    const q = searchQuery.trim().toLowerCase()
    if (!q) return preview.knowledges
    return preview.knowledges.filter((k) =>
      (k.name || '').toLowerCase().includes(q),
    )
  }, [preview, activeTab, searchQuery])

  // Preset lists filtered by the search field when the Preset Lists
  // tab is active.
  const filteredPresetLists = useMemo(() => {
    if (!preview?.preset_lists) return []
    if (activeTab !== 'preset_lists') return []
    const q = searchQuery.trim().toLowerCase()
    if (!q) return preview.preset_lists
    return preview.preset_lists.filter((pl) =>
      (pl.name || '').toLowerCase().includes(q),
    )
  }, [preview, activeTab, searchQuery])

  // Count per-tab so the tab tooltips can surface "(N)" totals without
  // cluttering the icon-only tab row. "all" shows the grand total
  // of entities; `preset_lists` shows the total preset list count.
  const countsByType = useMemo(() => {
    const counts = {
      all: 0, character: 0, location: 0, item: 0, faction: 0, custom: 0,
      knowledge: 0, preset_lists: 0,
    }
    if (preview?.entities) {
      for (const ent of preview.entities) {
        counts.all += 1
        if (counts[ent.type] != null) counts[ent.type] += 1
      }
    }
    if (preview?.knowledges) {
      counts.knowledge = preview.knowledges.length
      // Knowledges are part of the "All" view too.
      counts.all += preview.knowledges.length
    }
    if (preview?.preset_lists) {
      counts.preset_lists = preview.preset_lists.length
    }
    return counts
  }, [preview])

  // Auto-locked preset list ids: the union of `preset_list_ids_used`
  // across every entity currently staged in the grid. These ids are
  // ALWAYS sent in the commit payload (Track 6) and their checkboxes
  // in the Preset Lists tab are disabled with a tooltip explaining
  // why. Recomputed whenever the staged entity set changes.
  const autoLockedPresetIds = useMemo(() => {
    const locked = new Set()
    if (!preview?.entities) return locked
    const byId = new Map(preview.entities.map((e) => [e.id, e]))
    for (const id of addedIds) {
      const ent = byId.get(id)
      if (!ent?.preset_list_ids_used) continue
      for (const plId of ent.preset_list_ids_used) locked.add(plId)
    }
    return locked
  }, [preview, addedIds])

  // Effective selection = user-ticked union auto-locked. Auto-locked
  // ids flow into the commit regardless of the user's manual set,
  // so the commit never silently drops a dependency.
  const effectivePresetIds = useMemo(() => {
    const out = new Set(selectedPresetListIds)
    for (const id of autoLockedPresetIds) out.add(id)
    return out
  }, [selectedPresetListIds, autoLockedPresetIds])

  function addEntity(entityId) {
    setAddedIds((prev) => {
      if (prev.has(entityId)) return prev
      const next = new Set(prev)
      next.add(entityId)
      return next
    })
    // Default-pick origin for the newly added entity. User can
    // override via dot / column / chapter / act click afterward.
    setImportPicks((prev) => {
      if (prev.has(entityId)) return prev
      const next = new Map(prev)
      next.set(entityId, { kind: 'origin' })
      return next
    })
  }

  function removeEntity(entityId) {
    setAddedIds((prev) => {
      if (!prev.has(entityId)) return prev
      const next = new Set(prev)
      next.delete(entityId)
      return next
    })
    // Drop any pick + selection carried by the now-removed entity so
    // an orphaned pick doesn't hang around for a re-add.
    setImportPicks((prev) => {
      if (!prev.has(entityId)) return prev
      const next = new Map(prev)
      next.delete(entityId)
      return next
    })
    setSelectedRowIds((prev) => {
      if (!prev.has(entityId)) return prev
      const next = new Set(prev)
      next.delete(entityId)
      return next
    })
    // Clear the preview pane if it was showing this entity.
    setPreviewedEntityId((prev) => prev === entityId ? null : prev)
  }

  function addKnowledge(knowledgeId) {
    setAddedKnowledgeIds((prev) => {
      if (prev.has(knowledgeId)) return prev
      const next = new Set(prev)
      next.add(knowledgeId)
      return next
    })
    setKnowledgePicks((prev) => {
      if (prev.has(knowledgeId)) return prev
      const next = new Map(prev)
      next.set(knowledgeId, { kind: 'origin' })
      return next
    })
  }

  function removeKnowledge(knowledgeId) {
    setAddedKnowledgeIds((prev) => {
      if (!prev.has(knowledgeId)) return prev
      const next = new Set(prev)
      next.delete(knowledgeId)
      return next
    })
    setKnowledgePicks((prev) => {
      if (!prev.has(knowledgeId)) return prev
      const next = new Map(prev)
      next.delete(knowledgeId)
      return next
    })
    setPreviewedEntityId((prev) => (prev === `knowledge:${knowledgeId}` ? null : prev))
  }

  function addAllInCurrentTab() {
    if (activeTab === 'preset_lists') {
      setSelectedPresetListIds((prev) => {
        const next = new Set(prev)
        for (const pl of filteredPresetLists) next.add(pl.id)
        return next
      })
      return
    }
    if (activeTab === 'knowledge') {
      setAddedKnowledgeIds((prev) => {
        const next = new Set(prev)
        for (const k of filteredKnowledges) next.add(k.id)
        return next
      })
      setKnowledgePicks((prev) => {
        const next = new Map(prev)
        for (const k of filteredKnowledges) {
          if (!next.has(k.id)) next.set(k.id, { kind: 'origin' })
        }
        return next
      })
      return
    }
    setAddedIds((prev) => {
      const next = new Set(prev)
      for (const ent of filteredEntities) next.add(ent.id)
      return next
    })
    // Also default-pick origin for every newly added entity.
    setImportPicks((prev) => {
      const next = new Map(prev)
      for (const ent of filteredEntities) {
        if (!next.has(ent.id)) next.set(ent.id, { kind: 'origin' })
      }
      return next
    })
    // The All tab also pulls in every Knowledge.
    if (activeTab === 'all') {
      setAddedKnowledgeIds((prev) => {
        const next = new Set(prev)
        for (const k of filteredKnowledges) next.add(k.id)
        return next
      })
      setKnowledgePicks((prev) => {
        const next = new Map(prev)
        for (const k of filteredKnowledges) {
          if (!next.has(k.id)) next.set(k.id, { kind: 'origin' })
        }
        return next
      })
    }
  }

  function togglePresetList(presetListId) {
    // Locked lists (auto-used by staged entities) can't be toggled
    // off. The picker row button is disabled in that case, but guard
    // here too in case of programmatic toggling.
    if (autoLockedPresetIds.has(presetListId)) return
    setSelectedPresetListIds((prev) => {
      const next = new Set(prev)
      if (next.has(presetListId)) next.delete(presetListId)
      else next.add(presetListId)
      return next
    })
  }

  const gridEntities = useMemo(() => {
    if (!preview?.entities) return []
    const byId = new Map(preview.entities.map((e) => [e.id, e]))
    const rows = []
    for (const id of addedIds) {
      const ent = byId.get(id)
      if (ent) rows.push(ent)
    }
    return rows
  }, [preview, addedIds])

  const gridKnowledges = useMemo(() => {
    if (!preview?.knowledges) return []
    const byId = new Map(preview.knowledges.map((k) => [k.id, k]))
    const rows = []
    for (const id of addedKnowledgeIds) {
      const k = byId.get(id)
      if (k) rows.push(k)
    }
    return rows
  }, [preview, addedKnowledgeIds])

  // ── Import button state + commit handler ────────────────────────
  //
  // "Ready to commit" = preview loaded + at least one entity on the
  // grid + every staged entity has a pick set. Since newly-added
  // entities auto-pick origin (v0.1.12.30), in practice the pick
  // condition is always satisfied once addedIds is non-empty; the
  // explicit check is belt-and-braces in case a future refactor
  // stops auto-picking. Placed AFTER the `gridEntities` memo so
  // the dep array reference is valid at evaluation time (previously
  // sat above the memo and crashed with a TDZ ReferenceError at
  // mount time in v0.1.12.34).
  const canCommit = useMemo(() => {
    if (!preview) return false
    // Commit is enabled when there's at least one thing staged
    // (entity, knowledge, or explicit preset list) AND every staged
    // entity / knowledge has a pick set.
    if (gridEntities.length === 0 && gridKnowledges.length === 0 && selectedPresetListIds.size === 0) {
      return false
    }
    for (const ent of gridEntities) {
      if (!importPicks.has(ent.id)) return false
    }
    for (const k of gridKnowledges) {
      if (!knowledgePicks.has(k.id)) return false
    }
    return true
  }, [preview, gridEntities, importPicks, gridKnowledges, knowledgePicks, selectedPresetListIds])

  async function handleCommit() {
    if (!canCommit || committing) return
    setCommitting(true)
    setCommitError(null)
    try {
      // Build the commit request body from the local state. Shape
      // matches the backend's `_ImportCommitBody` Pydantic model.
      const picks = gridEntities.map((ent) => {
        const pick = importPicks.get(ent.id)
        return {
          entity_id: ent.id,
          state_point: {
            kind: pick.kind,
            scene_id: pick.scene_id || null,
            modifier_node_id: pick.modifier_node_id || null,
          },
        }
      })
      const knowledge_picks = gridKnowledges.map((k) => {
        const kpick = knowledgePicks.get(k.id)
        return {
          knowledge_id: k.id,
          state_point: {
            kind: kpick.kind,
            scene_id: kpick.scene_id || null,
          },
        }
      })
      const body = {
        session_id: preview.session_id,
        picks,
        import_story_settings: importStorySettings,
        name_collision_strategy: 'suffix',
        preset_list_ids: Array.from(effectivePresetIds),
        knowledge_picks,
      }
      const res = await fetch('/api/project/import/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        let detail = 'Import failed.'
        try {
          const data = await res.json()
          if (data?.detail) detail = data.detail
        } catch { /* swallow */ }
        throw new Error(detail)
      }
      const data = await res.json()
      // Swap the current project's story for the committed one so
      // the Entity Library + canvas reflect the newly-imported
      // entities. Marks hasUnsavedChanges so the user knows to save.
      applyImportedStory(data.story)
      setCommitSummary({
        source_filename: fileName || 'source file',
        ...data.result,
      })
    } catch (err) {
      setCommitError(err?.message || 'Import failed.')
    } finally {
      setCommitting(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div
        ref={panelRef}
        data-help-region="entity-import:modal"
        className="bg-zinc-800 border border-zinc-600 rounded-lg shadow-2xl w-[1100px] max-w-[95vw] h-[80vh] max-h-[80vh] flex flex-col"
      >
        {/* ── Header ───────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700 flex-shrink-0">
          <h2 className="text-sm font-semibold text-zinc-100">
            {commitSummary ? 'Import Complete' : 'Import Entities from Project File'}
          </h2>
          <button onClick={close} className="text-zinc-400 hover:text-zinc-200 text-base leading-none">✕</button>
        </div>

        {/* ── Success overlay ──────────────────────────────────────── */}
        {/* When a commit succeeds, everything below the header is
            replaced with a success summary + Done button. Clicking
            Done closes the dialog. The user can also click ✕ at the
            top or press Escape. */}
        {commitSummary && (
          <div className="flex-1 flex flex-col items-center justify-center p-8 gap-4">
            <div className="text-5xl text-green-400">✓</div>
            <div className="text-lg font-semibold text-zinc-100">
              {(() => {
                const ent = commitSummary.imported_count || 0
                const kn  = commitSummary.imported_knowledge_count || 0
                const parts = []
                if (ent > 0) parts.push(`${ent} entit${ent === 1 ? 'y' : 'ies'}`)
                if (kn > 0)  parts.push(`${kn} knowledge${kn === 1 ? '' : 's'}`)
                const summary = parts.length > 0 ? parts.join(' and ') : 'nothing'
                return `Imported ${summary} from ${commitSummary.source_filename}`
              })()}
            </div>
            <div className="text-xs text-zinc-400 space-y-1 text-center max-w-md">
              {commitSummary.imported_preset_list_count > 0 && (
                <div>
                  {commitSummary.imported_preset_list_count} new preset list{commitSummary.imported_preset_list_count === 1 ? '' : 's'} added to the library.
                </div>
              )}
              {commitSummary.imported_custom_category_count > 0 && (
                <div>
                  {commitSummary.imported_custom_category_count} new custom categor{commitSummary.imported_custom_category_count === 1 ? 'y' : 'ies'} added.
                </div>
              )}
              {commitSummary.imported_asset_count > 0 && (
                <div>
                  {commitSummary.imported_asset_count} asset file{commitSummary.imported_asset_count === 1 ? '' : 's'} copied to the project's assets folder.
                </div>
              )}
              {commitSummary.dropped_relationships && commitSummary.dropped_relationships.length > 0 && (
                <div className="mt-2 p-2 rounded bg-amber-900/20 border border-amber-800/40 text-amber-300 text-left">
                  <div className="font-semibold mb-1">
                    ⚠ {commitSummary.dropped_relationships.length} relationship{commitSummary.dropped_relationships.length === 1 ? '' : 's'} dropped:
                  </div>
                  <ul className="list-disc list-inside space-y-0.5 max-h-32 overflow-y-auto">
                    {commitSummary.dropped_relationships.map((desc, i) => (
                      <li key={i} className="truncate">{desc}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="mt-3 text-[11px] text-zinc-500">
                Don't forget to save the project (Ctrl+S) to preserve the imported entities on disk.
              </div>
            </div>
            <button
              onClick={close}
              className="mt-2 px-6 py-2 text-sm bg-accent-700 hover:bg-accent-600 text-white rounded"
            >
              Done
            </button>
          </div>
        )}

        {/* ── File picker row + body + preview pane + footer ───────
            Wrapped in a fragment gated on !commitSummary so the
            success overlay above replaces all of this when a commit
            has landed. */}
        {!commitSummary && (
        <>
        {/* ── File picker row ──────────────────────────────────────── */}
        <div data-help-region="entity-import:file_picker" className="flex items-center gap-3 px-4 py-3 border-b border-zinc-700 flex-shrink-0 bg-zinc-900/40">
          <input
            ref={fileInputRef}
            type="file"
            accept=".nnz,.nnplot"
            onChange={handleFileChosen}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="px-3 py-1.5 text-xs bg-accent-700 hover:bg-accent-600 text-white rounded disabled:opacity-50"
            disabled={loading}
          >
            {preview ? 'Choose a different file…' : 'Choose project file…'}
          </button>
          <div className="text-xs text-zinc-400 flex-1 truncate">
            {loading
              ? <span className="text-zinc-300">Reading {fileName}…</span>
              : preview
                ? <>
                    <span className="text-zinc-200 font-medium">{preview.story_title}</span>
                    <span className="text-zinc-500"> — {fileName}</span>
                  </>
                : fileName
                  ? <span className="text-zinc-500">{fileName}</span>
                  : <span className="text-zinc-600">No file chosen</span>}
          </div>
          {preview && (
            <div className="text-[10px] text-zinc-500">
              {preview.entities?.length || 0} entities · {preview.columns?.length || 0} scenes
            </div>
          )}
        </div>

        {/* ── Error banner ─────────────────────────────────────────── */}
        {/* Surfaces BOTH file-upload errors (from /preview) and
            commit errors (from /commit) in the same strip so the
            user always sees the latest problem in the same place. */}
        {(error || commitError) && (
          <div className="px-4 py-2 bg-red-900/40 text-red-200 text-xs border-b border-red-800 flex-shrink-0">
            {commitError || error}
          </div>
        )}

        {/* ── Body: picker (left) + grid (right) ──────────────────── */}
        <div className="flex-1 min-h-0 flex">
          {/* ── LEFT: Add Entity picker ────────────────────────────── */}
          {/* Styled to mirror the EntityListAttribute picker popover:
              icon-only tab row at the top with a coloured bottom-border
              accent for the active tab, a single-line search input, and
              a scrollable filtered list below. Kept visually consistent
              with the rest of the app's "pick an entity" affordances. */}
          <div data-help-region="entity-import:picker" className="w-[280px] border-r border-zinc-700 flex flex-col">
            {/* Type tabs — icon-only, tooltip labels via title attr */}
            <div data-help-region="entity-import:picker_type_tabs" className="flex border-b border-zinc-700">
              {TYPE_TABS.map((tab) => {
                const isActive = activeTab === tab.key
                const count = countsByType[tab.key] || 0
                const title = preview ? `${tab.label} (${count})` : tab.label
                return (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setActiveTab(tab.key)}
                    disabled={!preview}
                    title={title}
                    className={`flex-1 flex items-center justify-center py-1.5 text-sm transition-colors border-b-2 disabled:opacity-40 disabled:cursor-not-allowed ${
                      isActive
                        ? 'bg-zinc-700 text-zinc-100 border-accent-500'
                        : 'bg-zinc-800 text-zinc-400 border-transparent hover:bg-zinc-700/50 hover:text-zinc-200'
                    }`}
                  >
                    {tab.icon}
                  </button>
                )
              })}
            </div>

            {/* Search + Add All row */}
            <div data-help-region="entity-import:picker_search" className="flex items-center gap-1.5 px-1.5 py-1.5 border-b border-zinc-700">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                disabled={!preview}
                placeholder="Search…"
                className="flex-1 bg-zinc-700 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500 disabled:opacity-40"
              />
              <button
                onClick={addAllInCurrentTab}
                disabled={
                  !preview ||
                  (activeTab === 'preset_lists'
                    ? filteredPresetLists.length === 0
                    : filteredEntities.length === 0)
                }
                className="px-2 py-1 text-[10px] rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200 disabled:opacity-40 disabled:cursor-not-allowed"
                title={activeTab === 'preset_lists'
                  ? 'Tick every preset list in the current filter'
                  : 'Add every entity in the current tab to the grid'}
              >
                Add All
              </button>
            </div>

            {/* Entity / preset list picker body */}
            <div className="flex-1 overflow-y-auto">
              {!preview && (
                <div className="px-3 py-6 text-center text-xs text-zinc-500">
                  Choose a project file above to load its entities.
                </div>
              )}

              {/* Entity tabs */}
              {preview && activeTab !== 'preset_lists' && filteredEntities.length === 0 && (
                <div className="px-3 py-6 text-center text-xs text-zinc-500">
                  {searchQuery ? 'No matches.' : 'No entities in this tab.'}
                </div>
              )}
              {preview && activeTab !== 'preset_lists' && filteredEntities.map((ent) => {
                const inGrid = addedIds.has(ent.id)
                return (
                  <div
                    key={ent.id}
                    data-help-region="entity-import:picker_entity_row"
                    className={`flex items-center gap-2 px-2 py-1.5 border-b border-zinc-800 ${
                      inGrid ? 'bg-zinc-900/40 opacity-60' : 'hover:bg-zinc-700/40'
                    }`}
                  >
                    {/* Profile image / type-icon fallback with hover preview */}
                    <EntityThumb entity={ent} />
                    {/* Name */}
                    <div className="flex-1 text-xs text-zinc-200 truncate" title={ent.name}>
                      {ent.name}
                    </div>
                    {/* Type icon — same pattern as EntityListAttribute picker */}
                    <span className="text-[10px] flex-shrink-0 opacity-70" title={ent.type}>
                      {TYPE_ICONS[ent.type] || '?'}
                    </span>
                    {/* Add / check */}
                    {inGrid ? (
                      <button
                        onClick={() => removeEntity(ent.id)}
                        className="text-green-500 hover:text-red-400 text-sm leading-none flex-shrink-0"
                        title="Remove from grid"
                      >
                        ✓
                      </button>
                    ) : (
                      <button
                        onClick={() => addEntity(ent.id)}
                        className="px-2 py-0.5 text-[10px] rounded bg-zinc-700 hover:bg-accent-600 text-zinc-200 hover:text-white flex-shrink-0"
                      >
                        Add
                      </button>
                    )}
                  </div>
                )
              })}

              {/* Knowledge rows — visible under both the Knowledge tab
                  and the All tab. The All-tab empty-state branch is
                  already handled by the entity list above (when both
                  entities AND knowledges are empty the entity branch
                  fires "No matches" / "No entities"), so the empty-
                  state below only triggers when the Knowledge tab is
                  active and the filtered set is empty. */}
              {preview && activeTab === 'knowledge' && filteredKnowledges.length === 0 && (
                <div className="px-3 py-6 text-center text-xs text-zinc-500">
                  {searchQuery
                    ? 'No matches.'
                    : (preview.knowledges?.length
                        ? 'No matches.'
                        : 'The source story has no knowledges.')}
                </div>
              )}
              {preview && (activeTab === 'knowledge' || activeTab === 'all') && filteredKnowledges.map((k) => {
                const inGrid = addedKnowledgeIds.has(k.id)
                return (
                  <div
                    key={k.id}
                    className={`flex items-center gap-2 px-2 py-1.5 border-b border-zinc-800 ${
                      inGrid ? 'bg-zinc-900/40 opacity-60' : 'hover:bg-zinc-700/40'
                    }`}
                  >
                    <KnowledgeThumb knowledge={k} />
                    <div className="flex-1 text-xs text-zinc-200 truncate" title={k.name}>
                      {k.name}
                    </div>
                    <span className="text-[10px] flex-shrink-0 opacity-70" title="Knowledge">
                      {TYPE_ICONS.knowledge || '🧠'}
                    </span>
                    {inGrid ? (
                      <button
                        onClick={() => removeKnowledge(k.id)}
                        className="text-green-500 hover:text-red-400 text-sm leading-none flex-shrink-0"
                        title="Remove from grid"
                      >
                        ✓
                      </button>
                    ) : (
                      <button
                        onClick={() => addKnowledge(k.id)}
                        className="px-2 py-0.5 text-[10px] rounded bg-zinc-700 hover:bg-accent-600 text-zinc-200 hover:text-white flex-shrink-0"
                      >
                        Add
                      </button>
                    )}
                  </div>
                )
              })}

              {/* Preset Lists tab */}
              {preview && activeTab === 'preset_lists' && filteredPresetLists.length === 0 && (
                <div className="px-3 py-6 text-center text-xs text-zinc-500">
                  {searchQuery
                    ? 'No matches.'
                    : (preview.preset_lists?.length
                        ? 'No matches.'
                        : 'The source story has no preset lists.')}
                </div>
              )}
              {preview && activeTab === 'preset_lists' && filteredPresetLists.map((pl) => {
                const isLocked   = autoLockedPresetIds.has(pl.id)
                const isTicked   = effectivePresetIds.has(pl.id)
                const tooltip    = isLocked
                  ? 'Required by a staged entity — will be imported automatically. Remove the entity from the grid to unlock this list.'
                  : (isTicked
                      ? 'Selected for import. Click to untick.'
                      : 'Click to include this preset list in the import.')
                const sample = (pl.sample_values && pl.sample_values.length > 0)
                  ? pl.sample_values.join(', ') + (pl.value_count > pl.sample_values.length ? '…' : '')
                  : '(empty list)'
                return (
                  <div
                    key={pl.id}
                    className={`flex items-center gap-2 px-2 py-1.5 border-b border-zinc-800 ${
                      isTicked && !isLocked ? 'bg-accent-900/20' : ''
                    } ${isLocked ? 'bg-zinc-900/40' : 'hover:bg-zinc-700/40'}`}
                    title={tooltip}
                  >
                    <button
                      type="button"
                      onClick={() => togglePresetList(pl.id)}
                      disabled={isLocked}
                      className="flex-shrink-0 w-4 h-4 rounded-sm border-2 flex items-center justify-center transition-colors disabled:cursor-not-allowed"
                      style={{
                        borderColor: isTicked ? '#8b5cf6' : '#52525b',
                        backgroundColor: isTicked ? '#8b5cf6' : 'transparent',
                      }}
                      title={tooltip}
                    >
                      {isTicked && (
                        <span className="text-white text-[10px] leading-none">✓</span>
                      )}
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-zinc-200 truncate flex items-center gap-1" title={pl.name}>
                        {pl.name}
                        {isLocked && (
                          <span className="text-[9px] text-amber-400 ml-1" title={tooltip}>
                            🔒 in use
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-zinc-500 truncate">
                        {pl.value_count} value{pl.value_count === 1 ? '' : 's'}
                        {sample !== '(empty list)' && <> · {sample}</>}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* ── RIGHT: timeline grid (Track 4) ──────────────────────── */}
          <div data-help-region="entity-import:timeline" className="flex-1 flex flex-col min-w-0">
            <div className="px-3 py-2 border-b border-zinc-700 bg-zinc-900/40 flex items-center justify-between">
              <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">
                Timeline grid
              </span>
              <span className="text-[10px] text-zinc-500">
                {gridEntities.length} entit{gridEntities.length === 1 ? 'y' : 'ies'}
                {gridKnowledges.length > 0 && <> · {gridKnowledges.length} knowledge{gridKnowledges.length === 1 ? '' : 's'}</>}
                {' · '}{importPicks.size + knowledgePicks.size} picked · {selectedRowIds.size} selected
              </span>
            </div>
            <div className="flex-1 overflow-auto">
              {!preview && (
                <div className="h-full flex items-center justify-center text-xs text-zinc-600">
                  Load a project file to begin.
                </div>
              )}
              {preview && gridEntities.length === 0 && gridKnowledges.length === 0 && (
                <div className="h-full flex items-center justify-center text-xs text-zinc-500 text-center max-w-sm mx-auto p-6">
                  Use the picker on the left to add source entities or knowledges to the grid. Each row will show dots at every scene where the row has state — click a dot to pick the state to import.
                </div>
              )}
              {preview && (gridEntities.length > 0 || gridKnowledges.length > 0) && (
                <ImportTimelineGrid
                  preview={preview}
                  gridEntities={gridEntities}
                  gridKnowledges={gridKnowledges}
                  selectedRowIds={selectedRowIds}
                  setSelectedRowIds={setSelectedRowIds}
                  importPicks={importPicks}
                  setImportPicks={setImportPicks}
                  knowledgePicks={knowledgePicks}
                  setKnowledgePicks={setKnowledgePicks}
                  onRemoveEntity={removeEntity}
                  onRemoveKnowledge={removeKnowledge}
                  previewedEntityId={previewedEntityId}
                  setPreviewedEntityId={setPreviewedEntityId}
                />
              )}
            </div>
          </div>
        </div>

        {/* ── State preview pane (Track 5) ────────────────────────── */}
        {/* Resizable strip across the full width of the dialog, showing
            the walked state of the currently-previewed entity at its
            chosen state-point. Only rendered when a preview is loaded —
            if no entity is previewed yet, the pane renders its own
            empty-state message ("click a dot…").

            The top border is a drag handle — pointerdown + capture +
            pointermove updates `previewPaneHeight` live, pointerup
            ends the drag and writes the final value to localStorage.
            Drag state lives in a ref (not React state) so live
            dragging doesn't re-render the whole dialog 60 fps. */}
        {preview && (
          <>
            {/* Drag handle — 6px tall grabber above the pane.
                Visual affordance: a faint rule + zinc-500 hover
                highlight + ns-resize cursor. */}
            <div
              role="separator"
              aria-label="Resize state preview pane"
              aria-orientation="horizontal"
              onPointerDown={(e) => {
                if (e.button !== 0) return
                e.preventDefault()
                const startY = e.clientY
                const startH = previewPaneHeight
                let latestH = startH   // closure-local so onUp sees it
                const onMove = (ev) => {
                  const dy = startY - ev.clientY  // drag UP → larger pane
                  latestH = Math.max(120, Math.min(600, startH + dy))
                  setPreviewPaneHeight(latestH)
                }
                const onUp = () => {
                  document.removeEventListener('pointermove', onMove)
                  document.removeEventListener('pointerup', onUp)
                  try { localStorage.setItem('nn_importPreviewPaneH', String(latestH)) } catch { /* swallow */ }
                }
                document.addEventListener('pointermove', onMove)
                document.addEventListener('pointerup', onUp)
              }}
              className="h-1.5 bg-zinc-700 hover:bg-accent-600 cursor-ns-resize flex-shrink-0 transition-colors"
              title="Drag to resize preview pane"
            />
            <div
              data-help-region="entity-import:preview"
              className="border-t border-zinc-700 bg-zinc-800/60 flex-shrink-0"
              style={{ height: previewPaneHeight }}
            >
              <ImportStatePreviewPane
                sessionId={preview.session_id}
                previewedEntityId={previewedEntityId}
                previewedPick={
                  previewedEntityId
                    ? (importPicks.get(previewedEntityId)
                       || knowledgePicks.get(previewedEntityId)
                       || null)
                    : null
                }
                previewEntities={preview.entities}
                previewKnowledges={preview.knowledges}
                gridColumns={preview.columns}
                addedIds={addedIds}
              />
            </div>
          </>
        )}

        {/* ── Footer ──────────────────────────────────────────────── */}
        {/* Story-settings opt-in sits on the left; Cancel + Import
            actions sit on the right. Preset list picking lives in the
            dedicated Preset Lists tab in the picker now (v0.1.12.32),
            so the old "Import all preset lists" checkbox is gone. */}
        <div data-help-region="entity-import:footer" className="flex items-center gap-4 px-4 py-3 border-t border-zinc-700 flex-shrink-0 bg-zinc-900/40">
          <label
            className={`flex items-center gap-1.5 text-[11px] cursor-pointer ${
              preview ? 'text-zinc-300 hover:text-zinc-100' : 'text-zinc-600 cursor-not-allowed'
            }`}
            title="When on, the source story's author / genre / tags / language / default POV character are copied across to the current project."
          >
            <input
              type="checkbox"
              checked={importStorySettings}
              onChange={(e) => setImportStorySettings(e.target.checked)}
              disabled={!preview}
              className="accent-accent-500"
            />
            Import story settings
          </label>
          {preview && effectivePresetIds.size > 0 && (
            <span className="text-[10px] text-zinc-500">
              {effectivePresetIds.size} preset list{effectivePresetIds.size === 1 ? '' : 's'} selected
            </span>
          )}
          <div className="flex-1" />
          <button
            onClick={close}
            disabled={committing}
            className="px-4 py-1.5 text-xs text-zinc-300 hover:text-zinc-100 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={handleCommit}
            disabled={!canCommit || committing}
            title={!preview
              ? 'Load a project file first'
              : gridEntities.length === 0
                ? 'Add at least one entity to the grid first'
                : committing
                  ? 'Committing import…'
                  : `Import ${gridEntities.length} entit${gridEntities.length === 1 ? 'y' : 'ies'} into the current project`}
            className="px-4 py-1.5 text-xs bg-accent-700 hover:bg-accent-600 text-white rounded disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {committing
              ? 'Importing…'
              : `Import ${gridEntities.length > 0 ? `(${gridEntities.length})` : ''}`}
          </button>
        </div>
        </>
        )}
      </div>
    </div>
  )
}
