/**
 * NovelcrafterImportDialog — Phase 3.7N (live).
 *
 * Modal entry point for importing a Novelcrafter `.zip` export bundle
 * into a fresh NarrativeNode project. Opened from the hamburger menu's
 * Import flyout. Open state lives in `uiStore.ncImportDialogOpen`.
 *
 * Layout (mirrors ImportDialog's three-region shape):
 *   HEADER         — title + close (✕) button.
 *   FILE PICKER    — "Choose Novelcrafter bundle" button + selected
 *                    filename + loading indicator while /preview is in
 *                    flight.
 *   PREVIEW PANE   — entity preview rows + counts + warnings returned
 *                    by `POST /api/novelcrafter/preview`.
 *   FOOTER         — Cancel + Import buttons. Import POSTs to
 *                    `/api/novelcrafter/commit` with the preview's
 *                    session_id, then routes through the App-supplied
 *                    `onApplied(result)` callback to refresh the
 *                    project state (same pattern as TemplateImportDialog).
 *
 * No NarrativeNode chain-tracked state is read or written by this
 * dialog: the import always materialises into a fresh project, so all
 * writes happen at each entity's origin EntityNode by definition (per
 * Stage 3 design doc).
 *
 * State is entirely local — single-instance, short-lived, same shape
 * as ImportDialog / TemplateImportDialog. Only the open/closed flag
 * lives in the uiStore.
 *
 * Props:
 *   onApplied(result)         — async callback invoked after a
 *                               successful commit. `result` is the
 *                               commit endpoint's response body
 *                               (counts / warnings / engine_summary /
 *                               story_title). App.jsx uses it to GET
 *                               the fresh story and rebuild canvas +
 *                               entity store.
 *   guardUnsavedChanges(msg)  — optional async guard mirroring the
 *                               New / Open / Template-Import flow.
 *                               Returns 'proceed' to continue or
 *                               anything else to cancel.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import axios from 'axios'
import { useUiStore } from '../../store/uiStore'
import { useProgramTagsStore } from '../../store/programTagsStore'
import { useContextCuesStore } from '../../store/contextCuesStore'
import { useConversationsStore } from '../../store/conversationsStore'
import { useSettingsStore } from '../../store/settingsStore'
import { useAiDisabled } from '../../hooks/useAiDisabled'
import ImportItemPicker from './ImportItemPicker'
import NovelcrafterImportProgressModal from './NovelcrafterImportProgressModal'
import SceneRefinementModal from './SceneRefinementModal'
import { TYPE_ICONS } from '../../utils/entityHelpers'
import ImageHoverPreview from '../ui/ImageHoverPreview'


export default function NovelcrafterImportDialog({ onApplied, onCancelled, guardUnsavedChanges } = {}) {
  const open  = useUiStore((s) => s.ncImportDialogOpen)
  const close = useUiStore((s) => s.closeNcImportDialog)
  const requestSettingsOpen = useUiStore((s) => s.requestSettingsOpen)

  // Local state. Reset whenever the dialog closes (see effect below).
  const fileInputRef = useRef(null)
  const [fileName, setFileName] = useState('')
  const [preview, setPreview]   = useState(null)
  const [loading, setLoading]   = useState(false)
  const [committing, setCommitting] = useState(false)
  const [error, setError]       = useState('')

  // Phase 3.7N Layer 2 — Story-level settings that NC's export
  // doesn't carry, supplied by the writer here at import time.
  // All four are optional; empty strings forward as "no value" and
  // the engine treats them as absence.
  const [defaultPovCharacter, setDefaultPovCharacter] = useState('')
  // Sensible NC-import defaults — most novels are past-tense first-
  // person English. Saves the writer three keystrokes per import.
  // Note: `povType` value matches the select's `<option value>`, not
  // the display label (`'first'`, not `'First Person'`) so the
  // controlled select actually picks the right option on first paint.
  const [tense, setTense] = useState('past')
  const [language, setLanguage] = useState('English')
  const [povType, setPovType] = useState('first')

  // Phase 3.7N Layer 3 — entity auto-placement settings. When the
  // checkbox is on (default), the backend scans each scene's prose
  // and places a chip for any entity whose name or alias matches
  // whole-word. Characters and locations always use threshold 1;
  // items and customs share a user-controllable threshold so writers
  // can tighten the matching when generic-named items produce false
  // positives.
  const [autoPlaceEntities, setAutoPlaceEntities] = useState(true)
  const [itemsCustomsThreshold, setItemsCustomsThreshold] = useState(1)
  // Phase 5.9 — strip leading "Chapter N" / "Act N" prefixes from imported
  // chapter/act titles. Default on.
  const [cleanChapterActTitles, setCleanChapterActTitles] = useState(true)

  // Phase 3.10 Layer 5 — opt-in AI scene refinement. When checked,
  // clicking Import POSTs with `dry_run=true`: backend builds the
  // Story but does NOT project it to state. The dialog then opens
  // the scene-refinement modal against the staged story. The modal's
  // Apply path calls `/commit_staged` to finalise; Cancel-import or
  // Back-to-settings discards the staged work.
  // Off by default — AI calls cost money; this is an explicit opt-in.
  const [refineWithAi, setRefineWithAi] = useState(false)
  // Holds the dry-run /commit response (session_id + staged Story
  // payload) while the SceneRefinementModal is up. Non-null = modal
  // open over the import dialog.
  const [stagedRefinement, setStagedRefinement] = useState(null)

  // Gating: enable the toggle only when at least one AI provider has
  // a selected or manually-added model. Identical heuristic to the
  // existing chat / Layer-5 entry points.
  const hasAiProvider = useSettingsStore((s) => {
    const profiles = s.preferences?.ai_provider_profiles || []
    return profiles.some((p) => {
      const sel = (p.selected_models?.length || 0)
      const man = (p.manually_added_models?.length || 0)
      return (sel + man) > 0
    })
  })
  // Phase 5.7 — hide the AI scene-refinement option when AI
  // integrations are disabled.
  const aiDisabled = useAiDisabled()

  // Phase 3.8 — Snippets import → Context Cue Library. Off by
  // default per the Pre-Prep decision: Context Cues are program-
  // level (not project-scoped), so importing per-project NC
  // snippets adds them to the writer's GLOBAL cue library — a call
  // the writer should make per import, not a silent default. When
  // unchecked, the snippets folder is not read at all.
  const [importSnippets, setImportSnippets] = useState(false)
  // Phase 3.9 — Chats import → Conversation threads. Off by default
  // for the same reason: threads land in this project's per-story
  // conversation list AND surface in the cross-story conversation
  // browser tagged with the story title + `Imported`. Writer makes
  // the call per import.
  const [importChats, setImportChats] = useState(false)
  // Phase 3.9 — per-item selection sets for the picker popover. A
  // Set<string> of nc_id values; the picker uses this as a presence
  // check. Defaults to "all selected" when the parent toggle flips
  // from off→on (handled below via a useEffect on `importSnippets` /
  // `importChats`). Empty Set sends no filter (= import all), and a
  // partial Set sends the comma-joined list in the commit POST.
  const [selectedSnippetIds, setSelectedSnippetIds] = useState(() => new Set())
  const [selectedChatIds, setSelectedChatIds] = useState(() => new Set())

  // Origin-node canvas layout — mirrors the template-import knob.
  // 'columns'          — entity origin nodes sit in per-type columns
  //                      left of chapter 1.
  // 'first_appearance' — each origin lands in the chapter of the
  //                      scene where it first appears as a chip
  //                      (chapters widen on the left to fit).
  const [layoutMode, setLayoutMode] = useState('first_appearance')

  // ── Reset state on close ────────────────────────────────────────────
  // Same pattern as ImportDialog: the dialog is single-instance and
  // re-mounts at the same JSX position, so we clear local state when
  // `open` flips false so the next open starts from a clean slate.
  useEffect(() => {
    if (open) return
    setFileName('')
    setPreview(null)
    setLoading(false)
    setCommitting(false)
    setError('')
    setDefaultPovCharacter('')
    setTense('past')
    setLanguage('English')
    setPovType('first')
    setAutoPlaceEntities(true)
    setItemsCustomsThreshold(1)
    setRefineWithAi(false)
    setStagedRefinement(null)
    setImportSnippets(false)
    setImportChats(false)
    setSelectedSnippetIds(new Set())
    setSelectedChatIds(new Set())
    setLayoutMode('first_appearance')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [open])

  // ── Escape-to-close ─────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  // ── File chosen: POST to /api/novelcrafter/preview ──────────────────
  const handleFileChosen = useCallback(async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name)
    setPreview(null)
    setError('')
    setLoading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const { data } = await axios.post('/api/novelcrafter/preview', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      setPreview(data)
    } catch (err) {
      const detail = err?.response?.data?.detail || err?.message || 'Failed to read bundle.'
      setError(typeof detail === 'string' ? detail : JSON.stringify(detail))
    } finally {
      setLoading(false)
    }
  }, [])

  // ── Import clicked: POST to /api/novelcrafter/commit ────────────────
  // Mirrors TemplateImportDialog's commit pattern: guard unsaved
  // changes (a fresh NC import always wipes the active project per
  // the Stage 3 design — there's no merge mode for NC bundles), POST
  // session_id, then let the App-supplied `onApplied` callback
  // refresh the project state from the backend.
  const handleImport = useCallback(async () => {
    if (!preview?.session_id || committing) return
    if (guardUnsavedChanges) {
      const guard = await guardUnsavedChanges(
        'Importing a Novelcrafter bundle (replaces the active project)'
      )
      if (guard !== 'proceed') return
    }
    setCommitting(true)
    setError('')
    try {
      const fd = new FormData()
      fd.append('session_id', preview.session_id)
      fd.append('layout_mode', layoutMode || 'columns')
      // Phase 3.7N Layer 2 — story-level settings the writer
      // supplied (or left empty). Empty strings forward as "no
      // value" and the backend treats them as absence.
      fd.append('default_pov_character', defaultPovCharacter || '')
      fd.append('tense', tense || '')
      fd.append('language', language || '')
      fd.append('pov_type', povType || '')
      // Phase 3.7N Layer 3 — entity auto-placement.
      fd.append('auto_place_entities', autoPlaceEntities ? 'true' : 'false')
      fd.append('items_customs_threshold', String(Math.max(1, Number(itemsCustomsThreshold) || 1)))
      fd.append('import_snippets', importSnippets ? 'true' : 'false')
      fd.append('import_chats', importChats ? 'true' : 'false')
      fd.append('clean_chapter_act_titles', cleanChapterActTitles ? 'true' : 'false')
      // Phase 3.9 picker — when ALL items are selected, send empty
      // filter (the backend treats absent/empty as "import all" per
      // the current commit-endpoint contract). When the writer
      // deselected some, send the kept ids as a comma-joined list.
      // Skips the field entirely when the parent toggle is off so
      // the backend doesn't second-guess opt-out flow.
      if (importSnippets) {
        const total = (preview?.snippets_preview || []).length
        if (selectedSnippetIds.size < total) {
          fd.append('snippet_ids', Array.from(selectedSnippetIds).join(','))
        }
      }
      if (importChats) {
        const total = (preview?.chats_preview || []).length
        if (selectedChatIds.size < total) {
          fd.append('chat_ids', Array.from(selectedChatIds).join(','))
        }
      }
      // Phase 3.10 Layer 5 — opt-in AI refinement: post with
      // `dry_run=true`. Backend builds the Story without writing it
      // to state, returns the staged shape; the modal opens against
      // it. We hand off the dialog's existing form payload so the
      // modal's finalise call can re-post snippet/chat settings.
      if (refineWithAi && hasAiProvider && !aiDisabled) {
        fd.append('dry_run', 'true')
      }
      const { data } = await axios.post('/api/novelcrafter/commit', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      // Staged branch: stash the response and let the
      // SceneRefinementModal drive the rest. The dialog stays mounted
      // (modal renders on top) so a back-to-settings exit returns
      // cleanly without re-uploading the bundle.
      if (data?.staged === true) {
        setStagedRefinement({
          session_id: data.session_id,
          story: data.story,
          counts: data.counts,
          warnings: data.warnings,
        })
        setCommitting(false)
        return
      }
      // Phase 3.10 — cancel branch. Backend rolled back its disk
      // artifacts (cues + chats it had written so far) AND restored
      // the previous in-memory story. Frontend mirrors that with
      // the App-supplied `onCancelled` callback (which re-fetches
      // `/api/story/` and reapplies the previous shape to the
      // canvas / entity stores, equivalent to the Zustand snapshot
      // revert called for in the ToDo).
      if (data?.cancelled) {
        try { await onCancelled?.(data) } catch (cbErr) {
          console.error('Novelcrafter import: onCancelled callback threw', cbErr)
        }
        // Refresh tag pool + cue / conversation lists too — if
        // ANY artifacts were created before the cancel, the backend
        // deleted them, but the frontend's in-memory mirrors might
        // still cache them.
        try { await useProgramTagsStore.getState().refreshPool() } catch { /* ignore */ }
        try { await useContextCuesStore.getState().reloadCues() } catch { /* ignore */ }
        try { await useConversationsStore.getState().reloadIndex() } catch { /* ignore */ }
        try {
          await axios.post(
            '/api/novelcrafter/commit_progress_clear',
            new URLSearchParams({ session_id: preview.session_id }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
          )
        } catch { /* ignore */ }
        close()
        return
      }
      if (!data?.applied) {
        setError('Import did not complete — see server logs.')
        setCommitting(false)
        return
      }
      try { await onApplied?.(data) } catch (cbErr) {
        console.error('Novelcrafter import: onApplied callback threw', cbErr)
      }
      // Phase 3.8 — when the import added cues to the Context Cue
      // Library, refresh the program-tag pool so the new cue tags
      // (story-title tag + the `Imported` tag) appear in the cue
      // library's tag-filter dropdown. The pool is cached client-
      // side and would otherwise stay stale until next page reload.
      const snippetsImported = Number(data?.counts?.snippets_imported || 0)
      const chatsImported = Number(data?.counts?.chats_imported || 0)
      // Refresh the program-tag pool when EITHER snippets or chats
      // contributed tags. Both categories tag with `[story_title,
      // "Imported"]` so the same dropdown picks up new entries from
      // either path.
      if (snippetsImported > 0 || chatsImported > 0) {
        try { await useProgramTagsStore.getState().refreshPool() } catch (rpErr) {
          console.error('Novelcrafter import: program-tag refresh failed', rpErr)
        }
      }
      if (snippetsImported > 0) {
        // Refresh the cue library list. The backend wrote new files
        // to disk via `create_cue()`; the in-memory store still has
        // its pre-import snapshot.
        try { await useContextCuesStore.getState().reloadCues() } catch (rcErr) {
          console.error('Novelcrafter import: cue list refresh failed', rcErr)
        }
      }
      if (chatsImported > 0) {
        // Refresh the conversations index + categories map for the
        // same reason — backend wrote new thread files via
        // `save_conversation()`; the in-memory store doesn't notice.
        try { await useConversationsStore.getState().reloadIndex() } catch (rcErr) {
          console.error('Novelcrafter import: conversations refresh failed', rcErr)
        }
      }
      // Phase 3.10 — evict the progress slot now that we've
      // processed the terminal poll. Best-effort.
      try {
        await axios.post(
          '/api/novelcrafter/commit_progress_clear',
          new URLSearchParams({ session_id: preview.session_id }),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
        )
      } catch { /* ignore */ }
      close()
    } catch (err) {
      const detail = err?.response?.data?.detail || err?.message || 'Import failed.'
      setError(typeof detail === 'string' ? detail : JSON.stringify(detail))
      setCommitting(false)
    }
  }, [preview, committing, guardUnsavedChanges, onApplied, onCancelled, close, defaultPovCharacter, tense, language, povType, autoPlaceEntities, itemsCustomsThreshold, importSnippets, importChats, selectedSnippetIds, selectedChatIds, layoutMode, cleanChapterActTitles, refineWithAi, hasAiProvider, aiDisabled])


  // ── Staged-refinement modal handlers (Phase 3.10 Layer 5) ───────────
  // The SceneRefinementModal renders on top when `stagedRefinement` is
  // non-null. Three exit paths the writer can take:
  //
  //   • Apply & finish import   → POST /commit_staged with the writer's
  //                               confirmed diff. Backend applies the
  //                               diff to its staged story, projects to
  //                               state.story, runs snippets/chats
  //                               import, clears session. We fire the
  //                               normal post-import refresh hooks +
  //                               onApplied + close.
  //   • Back to settings        → Drop the staged story client-side
  //                               (set stagedRefinement = null) but
  //                               leave the preview session alive so a
  //                               re-Import after tweaking settings
  //                               re-builds + re-stages cleanly. No
  //                               backend call.
  //   • Cancel import entirely  → POST /commit_staged_discard to clear
  //                               the preview session. Close the whole
  //                               dialog. Project state is exactly as
  //                               it was before the writer opened the
  //                               import dialog (nothing was projected
  //                               to state.story).

  const handleStagedApplyAndFinish = useCallback(async (sceneDiffs) => {
    if (!stagedRefinement?.session_id) return
    setCommitting(true)
    setError('')
    try {
      const body = {
        session_id: stagedRefinement.session_id,
        scene_diffs: sceneDiffs || [],
        import_snippets: importSnippets,
        snippet_ids: importSnippets && selectedSnippetIds.size > 0
          ? Array.from(selectedSnippetIds)
          : null,
        import_chats: importChats,
        chat_ids: importChats && selectedChatIds.size > 0
          ? Array.from(selectedChatIds)
          : null,
      }
      const { data } = await axios.post('/api/novelcrafter/commit_staged', body)
      // The standalone /commit_staged endpoint already wrote state.story
      // and ran the side-effects. Mirror the existing onApplied refresh
      // hooks so program-tag pool + cue / conversation indexes pick up
      // any new entries.
      try { await onApplied?.(data) } catch (cbErr) {
         
        console.error('Novelcrafter staged import: onApplied threw', cbErr)
      }
      const snippetsImported = Number(data?.counts?.snippets_imported || 0)
      const chatsImported    = Number(data?.counts?.chats_imported || 0)
      if (snippetsImported > 0 || chatsImported > 0) {
        try { await useProgramTagsStore.getState().refreshPool() } catch { /* ignore */ }
      }
      if (snippetsImported > 0) {
        try { await useContextCuesStore.getState().reloadCues() } catch { /* ignore */ }
      }
      if (chatsImported > 0) {
        try { await useConversationsStore.getState().reloadIndex() } catch { /* ignore */ }
      }
      setStagedRefinement(null)
      close()
    } catch (err) {
      const detail = err?.response?.data?.detail || err?.message || 'Staged commit failed.'
      setError(typeof detail === 'string' ? detail : JSON.stringify(detail))
      setCommitting(false)
    }
  }, [stagedRefinement, importSnippets, selectedSnippetIds, importChats, selectedChatIds, onApplied, close])

  const handleStagedBackToSettings = useCallback(() => {
    // No backend call — the staged story on the session is overwritten
    // on the next Import click anyway. Keeps the writer's preview
    // session + uploaded bundle alive so they don't re-upload.
    setStagedRefinement(null)
  }, [])

  const handleStagedCancelImportEntirely = useCallback(async () => {
    const sid = stagedRefinement?.session_id
    setStagedRefinement(null)
    if (sid) {
      try {
        await axios.post(
          '/api/novelcrafter/commit_staged_discard',
          new URLSearchParams({ session_id: sid }),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
        )
      } catch { /* best-effort cleanup */ }
    }
    close()
  }, [stagedRefinement, close])

  // Phase 3.9 — default the picker selections to ALL when the
  // parent toggle flips off→on. Mirrors the spec: writer turns on
  // "Import chats", every chat is initially selected; they can
  // then open the picker and uncheck individual ones. Resetting on
  // off ensures a fresh "all selected" when they re-enable. Uses
  // the preview's id list as the source of truth.
  useEffect(() => {
    if (!importSnippets) {
      setSelectedSnippetIds(new Set())
      return
    }
    const all = (preview?.snippets_preview || []).map((s) => s.nc_id)
    setSelectedSnippetIds(new Set(all))
  }, [importSnippets, preview])

  useEffect(() => {
    if (!importChats) {
      setSelectedChatIds(new Set())
      return
    }
    const all = (preview?.chats_preview || []).map((c) => c.nc_id)
    setSelectedChatIds(new Set(all))
  }, [importChats, preview])

  // Phase 3.9 — when the writer empties the picker (either by
  // unchecking every item one by one or via Select none), auto-
  // uncheck the parent toggle so the dialog can't try to "import
  // zero items" via an enabled toggle. DEFERRED to popover-close
  // (not the per-selection edge) so the writer can click Select
  // none + then re-tick a few items before closing — the parent
  // would otherwise un-check under them mid-edit. The `onClose`
  // prop on `<ImportItemPicker>` fires once per close (× button,
  // outside click, trigger-toggle close), and we apply the
  // uncheck only if the selection is empty AT THAT MOMENT.
  const onSnippetsPickerClose = useCallback(() => {
    if (selectedSnippetIds.size === 0) setImportSnippets(false)
  }, [selectedSnippetIds])

  const onChatsPickerClose = useCallback(() => {
    if (selectedChatIds.size === 0) setImportChats(false)
  }, [selectedChatIds])

  if (!open) return null

  // ── Counts the preview pane renders. Phase 3.2 fills in entity-typed
  //    counts and `entity_preview`; lore / subplots / snippets / chats /
  //    scenes remain zero until later sub-phases ship. Reads are
  //    tolerant of missing keys so a backend that omits a key still
  //    renders cleanly.
  const counts = preview?.counts || {}
  const lore     = counts.lore     || { knowledge: 0 }
  const subplots = counts.subplots || { reference_nodes: 0 }
  const entityPreview = preview?.entity_preview || {}
  const charList    = entityPreview.character      || []
  const locList     = entityPreview.location       || []
  const itemList    = entityPreview.item           || []
  const custList    = entityPreview.custom         || []
  const knowList    = entityPreview.knowledge      || []
  const refNodeList = entityPreview.reference_node || []

  return (
    <>
    {/* Phase 3.10 — progress modal overlay. Renders ONLY while a
        REAL commit POST is in flight. Lives above this dialog's
        backdrop (z-[2000] vs z-[1000]) so it visually takes over.
        The in-flight POST stays in `handleImport`; the modal polls
        `/commit_progress` independently and handles cancel by
        POSTing `/commit_cancel`, which the backend uses to break
        out at the next phase boundary.

        Phase 3.10 Layer 5 — when the AI refinement toggle is on,
        the FIRST POST is `/commit?dry_run=true`, which only BUILDS
        the staged story (no project mutation, no snippets, no
        chats). That's a sub-second sync call; mounting the progress
        bar for it is misleading — the writer hasn't started a real
        commit yet, only kicked off the build that feeds the staged
        refinement modal. We gate the progress overlay on
        `committing && !stagedRefinement`, which holds:
          • dry_run path: `committing` flips true → /commit dry_run
            runs → response sets `stagedRefinement` while still in
            flight, so the gate stays false → no flash. Once the
            modal mounts and `committing` flips false, no overlay.
          • non-staged path: `stagedRefinement` is always null →
            overlay renders normally for the full commit.
          • staged finalise (/commit_staged): `committing` flips
            true again AND `stagedRefinement` was already cleared
            inside the finalise handler → overlay renders normally.
        */}
    {/* Two paths for when the progress overlay should be visible:
        1. refineWithAi OFF — show during the standard /commit (the
           commit IS the import; progress bar is the writer's view of
           it running).
        2. refineWithAi ON — HIDE during the sub-second /commit?dry_run
           (just a build for the refinement modal; no actual commit
           yet) AND during the refinement modal itself. ONLY show
           during the final /commit_staged call, which is the real
           import that the writer kicked off via "Apply & finish
           import" on the refinement modal. At that point committing
           is true again and `stagedRefinement` is STILL set (cleared
           only after /commit_staged succeeds), so its presence
           cleanly distinguishes "finalising" from "dry-run-building".
        */}
    {committing && preview?.session_id && (!refineWithAi || stagedRefinement) && (
      <NovelcrafterImportProgressModal
        sessionId={preview.session_id}
      />
    )}
    {/* Phase 3.10 Layer 5 — staged-refinement modal. Renders over
        the dialog when the writer ticked "Refine scene placements
        with AI" and clicked Import. The modal drives /scene_wiring/
        refine against the staged Story; on Apply it calls back into
        `handleStagedApplyAndFinish` which posts /commit_staged. */}
    {stagedRefinement && (
      <SceneRefinementModal
        open
        stagedStory={stagedRefinement.story}
        stagedSessionId={stagedRefinement.session_id}
        onClose={handleStagedBackToSettings}
        onStagedApplyAndFinish={handleStagedApplyAndFinish}
        onStagedBackToSettings={handleStagedBackToSettings}
        onStagedCancelImport={handleStagedCancelImportEntirely}
      />
    )}
    <div
      className="fixed inset-0 z-[1000] bg-black/60 flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) close() }}
    >
      <div data-help-region="nc-import:modal" className="bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl w-[900px] max-w-[95vw] h-[70vh] max-h-[70vh] flex flex-col">

        {/* ── Header ───────────────────────────────────────────────── */}
        <div data-help-region="nc-import:header" className="flex items-center justify-between px-4 py-3 border-b border-zinc-700 flex-shrink-0">
          <h2 className="text-zinc-100 font-semibold">
            Import from Novelcrafter
          </h2>
          <button
            onClick={close}
            className="text-zinc-400 hover:text-zinc-100 text-xl leading-none"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* ── File picker row ──────────────────────────────────────── */}
        <div data-help-region="nc-import:file_picker" className="flex items-center gap-3 px-4 py-3 border-b border-zinc-700 flex-shrink-0 bg-zinc-950/40">
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip"
            onChange={handleFileChosen}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="px-3 py-1.5 text-xs bg-accent-700 hover:bg-accent-600 text-white rounded disabled:opacity-50"
            disabled={loading}
          >
            {preview ? 'Choose a different bundle…' : 'Choose Novelcrafter bundle…'}
          </button>
          <div className="text-xs text-zinc-400 flex-1 truncate">
            {loading
              ? <span className="text-zinc-300">Reading {fileName}…</span>
              : preview
                ? <>
                    <span className="text-zinc-200 font-medium">
                      {preview.novelcrafter_title || fileName}
                    </span>
                    {preview.novelcrafter_author && (
                      <span className="text-zinc-500"> by {preview.novelcrafter_author}</span>
                    )}
                    <span className="text-zinc-500"> · {formatLabel(preview.format)} bundle</span>
                  </>
                : fileName
                  ? <span className="text-zinc-500">{fileName}</span>
                  : <span className="text-zinc-600">No file chosen</span>}
          </div>
        </div>

        {/* ── Error banner ─────────────────────────────────────────── */}
        {error && (
          <div className="px-4 py-2 bg-red-900/40 text-red-200 text-xs border-b border-red-800 flex-shrink-0">
            {error}
          </div>
        )}

        {/* ── Preview pane (Phase 3.1: empty skeleton) ──────────────── */}
        <div data-help-region="nc-import:preview" className="flex-1 overflow-y-auto p-4">
          {!preview ? (
            <div className="h-full flex items-center justify-center text-zinc-500 text-xs text-center px-8">
              Choose a Novelcrafter export bundle (.zip) to preview what will be imported.
              The import always creates a new NarrativeNode project.
            </div>
          ) : (
            <div className="space-y-4">
              <PreviewSection title="Story settings (Novelcrafter doesn't export these)">
                <div data-help-region="nc-import:story_settings" className="space-y-3 px-3 py-2">
                  <div data-help-region="nc-import:default_pov">
                    <label className="block text-[11px] text-zinc-400 mb-1">
                      Default POV character
                    </label>
                    <PovCharacterDropdown
                      charList={charList}
                      value={defaultPovCharacter}
                      onChange={setDefaultPovCharacter}
                      disabled={committing}
                    />
                    <p className="mt-1 text-[11px] text-amber-300 leading-snug">
                      Sets the picked character as POV on every imported scene. NarrativeNode cannot recover per-scene POV from Novelcrafter's export; scenes that should belong to other POVs must be updated manually after import (or via the planned AI-assisted scene wiring once available).
                    </p>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-[11px] text-zinc-400 mb-1">Tense</label>
                      <select
                        value={tense}
                        onChange={(e) => setTense(e.target.value)}
                        className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 focus:outline-none focus:border-accent-500"
                        disabled={committing}
                      >
                        <option value="">(unset)</option>
                        <option value="past">Past</option>
                        <option value="present">Present</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[11px] text-zinc-400 mb-1">POV type</label>
                      <select
                        value={povType}
                        onChange={(e) => setPovType(e.target.value)}
                        className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 focus:outline-none focus:border-accent-500"
                        disabled={committing}
                      >
                        <option value="">(unset)</option>
                        <option value="first">First person</option>
                        <option value="second">Second person</option>
                        <option value="third_limited">Third person limited</option>
                        <option value="third_omniscient">Third person omniscient</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[11px] text-zinc-400 mb-1">Language</label>
                      <input
                        type="text"
                        value={language}
                        onChange={(e) => setLanguage(e.target.value)}
                        placeholder="e.g. en, en-CA, fr"
                        className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 focus:outline-none focus:border-accent-500"
                        disabled={committing}
                      />
                    </div>
                  </div>
                  {/* Auto-place + AI refinement live on a single
                      shared row so the writer sees both placement
                      tools at once. Word-wraps within each column at
                      narrow widths so the descriptive paragraph stays
                      legible. */}
                  <div className="pt-2 border-t border-zinc-800 grid grid-cols-2 gap-4">
                    <div data-help-region="nc-import:auto_place">
                      <label className="flex items-center gap-2 text-xs text-zinc-200 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={autoPlaceEntities}
                          onChange={(e) => setAutoPlaceEntities(e.target.checked)}
                          disabled={committing}
                          className="accent-accent-500"
                        />
                        Auto-place entity chips on scenes by name/alias match
                      </label>
                      <p className="mt-1 text-[11px] text-zinc-500 leading-snug">
                        Scans each scene's prose for whole-word matches of every entity's name and aliases. Characters and locations are placed on a single match; items and customs use the threshold below. Knowledges are not auto-placed (they live in their own canvas column).
                      </p>
                      <div className="mt-2 flex items-center gap-2 flex-wrap">
                        <label className="text-[11px] text-zinc-400">Items + customs threshold:</label>
                        <input
                          type="number"
                          min="1"
                          value={itemsCustomsThreshold}
                          onChange={(e) => setItemsCustomsThreshold(Math.max(1, Number(e.target.value) || 1))}
                          disabled={committing || !autoPlaceEntities}
                          className="w-16 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 focus:outline-none focus:border-accent-500 disabled:opacity-50"
                        />
                        <span className="text-[11px] text-zinc-500">minimum mentions to place a chip</span>
                      </div>
                    </div>
                    {/* Phase 3.10 Layer 5 — AI scene refinement toggle.
                        Phase 5.7: hidden when AI integrations are disabled. */}
                    {!aiDisabled && (
                    <div data-help-region="nc-import:refine_with_ai">
                      <label
                        className={`flex items-center gap-2 text-xs cursor-pointer ${
                          hasAiProvider ? 'text-zinc-200' : 'text-zinc-500 cursor-not-allowed'
                        }`}
                        title={hasAiProvider
                          ? ''
                          : 'Configure an AI provider in Settings to enable this.'}
                      >
                        <input
                          type="checkbox"
                          checked={refineWithAi}
                          onChange={(e) => setRefineWithAi(e.target.checked)}
                          disabled={committing || !hasAiProvider}
                          className="accent-accent-500"
                        />
                        Refine scene placements with AI before committing
                      </label>
                      <p className="mt-1 text-[11px] text-zinc-500 leading-snug">
                        After clicking Import, opens a scene-review modal where you can run a configured AI model to refine chip placement and POV per scene. The import is not finalised until you click Apply on the review modal.
                        {!hasAiProvider && (
                          <span className="block mt-1 text-amber-400/80">
                            Disabled: no AI provider configured. Open{' '}
                            <button
                              type="button"
                              onClick={() => { close(); requestSettingsOpen('mcpApi') }}
                              className="underline font-medium text-amber-300 hover:text-amber-200"
                            >
                              Settings → MCP &amp; API Connections
                            </button>{' '}
                            to add one.
                          </span>
                        )}
                      </p>
                    </div>
                    )}
                  </div>
                  <div className="pt-2 border-t border-zinc-800 grid grid-cols-2 gap-3">
                    {/* Snippets opt-in + per-item picker (Phase 3.8 + Phase 3.9 retrofit) */}
                    <div data-help-region="nc-import:import_snippets">
                      <div className="flex items-center gap-2 flex-wrap">
                        <label className="flex items-center gap-2 text-xs text-zinc-200 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={importSnippets}
                            onChange={(e) => setImportSnippets(e.target.checked)}
                            disabled={committing}
                            className="accent-accent-500"
                          />
                          Import snippets to Context Cue Library
                        </label>
                        <ImportItemPicker
                          items={preview?.snippets_preview || []}
                          selectedIds={selectedSnippetIds}
                          setSelectedIds={setSelectedSnippetIds}
                          onClose={onSnippetsPickerClose}
                          disabled={committing || !importSnippets}
                        />
                      </div>
                      <p className="mt-1 text-[11px] text-zinc-500 leading-snug">
                        Context Cues are program-level — they apply to every project. Leave unchecked to skip the snippets folder entirely.
                      </p>
                    </div>
                    {/* Chats opt-in + per-item picker (Phase 3.9) */}
                    <div data-help-region="nc-import:import_chats">
                      <div className="flex items-center gap-2 flex-wrap">
                        <label className="flex items-center gap-2 text-xs text-zinc-200 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={importChats}
                            onChange={(e) => setImportChats(e.target.checked)}
                            disabled={committing}
                            className="accent-accent-500"
                          />
                          Import chats to Conversation threads
                        </label>
                        <ImportItemPicker
                          items={preview?.chats_preview || []}
                          selectedIds={selectedChatIds}
                          setSelectedIds={setSelectedChatIds}
                          onClose={onChatsPickerClose}
                          disabled={committing || !importChats}
                        />
                      </div>
                      <p className="mt-1 text-[11px] text-zinc-500 leading-snug">
                        Threads land in this project's conversation list, tagged with the story title + `Imported`. Profile / model / system prompt left empty — pick those on first resume. Leave unchecked to skip the chats folder entirely.
                      </p>
                    </div>
                  </div>
                  <div data-help-region="nc-import:clean_titles" className="pt-2 border-t border-zinc-800">
                    <label className="flex items-center gap-2 text-xs text-zinc-200 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={cleanChapterActTitles}
                        onChange={(e) => setCleanChapterActTitles(e.target.checked)}
                        disabled={committing}
                        className="accent-accent-500"
                      />
                      Clean Chapter / Act titles
                    </label>
                    <p className="mt-1 text-[11px] text-zinc-500 leading-snug">
                      Removes a leading &quot;Chapter One&quot;, &quot;Act 1:&quot;, &quot;Ch. 3 -&quot; style prefix from imported chapter and act titles, keeping the rest of the title. Turn off to import titles exactly as written.
                    </p>
                  </div>
                  <div data-help-region="nc-import:origin_layout" className="pt-2 border-t border-zinc-800">
                    <label htmlFor="nc-layout-mode" className="block text-[11px] text-zinc-400 mb-1">
                      Origin layout
                    </label>
                    <select
                      id="nc-layout-mode"
                      value={layoutMode}
                      onChange={(e) => setLayoutMode(e.target.value)}
                      disabled={committing}
                      className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 focus:outline-none focus:border-accent-500"
                    >
                      <option value="columns">Group origins before chapters</option>
                      <option value="first_appearance">Place origins by first appearance</option>
                    </select>
                    <p className="mt-1 text-[11px] text-zinc-500 leading-snug">
                      {layoutMode === 'columns'
                        ? 'All entity origin nodes sit in per-type columns to the left of chapter 1.'
                        : 'Each origin lands in the chapter of the scene where it first appears as a chip; chapters widen on the left to fit. Entities never appearing as a chip fall back to columns.'}
                    </p>
                  </div>
                </div>
              </PreviewSection>

              {/* Phase 3.10 — story-structure counts (acts / chapters
                  / scenes) sit ABOVE the codex so the writer sees
                  the prose-level shape of the bundle first, then
                  drills into entities. Values come from the prose
                  walker now running at preview time (was previously
                  hardcoded to 0). */}
              <PreviewSection title="Story structure">
                <Stat label="Acts"     value={counts.acts     ?? 0} />
                <Stat label="Chapters" value={counts.chapters ?? 0} />
                <Stat label="Scenes"   value={counts.scenes   ?? 0} />
              </PreviewSection>

              <PreviewSection title="Codex">
                <Stat label="Characters"   value={counts.characters ?? 0} />
                <Stat label="Locations"    value={counts.locations  ?? 0} />
                <Stat label="Items"        value={counts.items      ?? 0} />
                <Stat label="Other"        value={counts.other      ?? 0} />
              </PreviewSection>

              {charList.length > 0 && (
                <EntityTypeList
                  title="Characters"
                  rows={charList}
                  povCharacter={defaultPovCharacter}
                  onSetPov={setDefaultPovCharacter}
                />
              )}
              {locList.length > 0 && (
                <EntityTypeList title="Locations" rows={locList} />
              )}
              {itemList.length > 0 && (
                <EntityTypeList title="Items" rows={itemList} />
              )}
              {knowList.length > 0 && (
                <EntityTypeList title="Knowledge (from Lore)" rows={knowList} />
              )}
              {refNodeList.length > 0 && (
                <EntityTypeList title="Reference Nodes (from Subplots)" rows={refNodeList} />
              )}
              {custList.length > 0 && (
                <EntityTypeList title="Custom entities" rows={custList} />
              )}

              <PreviewSection title="Lore">
                <Stat label="Knowledges" value={lore.knowledge ?? 0} />
              </PreviewSection>

              <PreviewSection title="Subplots">
                <Stat label="Reference Nodes" value={subplots.reference_nodes ?? 0} />
              </PreviewSection>

              <PreviewSection title="Snippets & chats">
                <Stat label="Snippets" value={counts.snippets ?? 0} />
                <Stat label="Chats"    value={counts.chats    ?? 0} />
              </PreviewSection>

              {Array.isArray(preview.warnings) && preview.warnings.length > 0 && (
                <PreviewSection title="Warnings">
                  <ul className="text-xs text-amber-300 space-y-1">
                    {preview.warnings.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                </PreviewSection>
              )}
            </div>
          )}
        </div>

        {/* ── Footer ───────────────────────────────────────────────── */}
        <div data-help-region="nc-import:footer" className="flex items-center justify-end gap-2 px-4 py-3 border-t border-zinc-700 flex-shrink-0">
          <button
            onClick={close}
            className="px-3 py-1.5 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-100 rounded"
          >
            Cancel
          </button>
          <button
            data-help-region="nc-import:import_action"
            onClick={handleImport}
            disabled={!preview || loading || committing}
            className="px-3 py-1.5 text-xs bg-accent-700 hover:bg-accent-600 text-white rounded disabled:opacity-50 disabled:cursor-not-allowed"
            title={
              !preview
                ? 'Choose a bundle first'
                : committing
                  ? 'Importing...'
                  : 'Replace the active project with the previewed bundle.'
            }
          >
            {committing ? 'Importing...' : 'Import'}
          </button>
        </div>
      </div>
    </div>
    </>
  )
}


/* ── Small presentational helpers ─────────────────────────────────────── */

function PreviewSection({ title, children }) {
  return (
    <div className="border border-zinc-700 rounded bg-zinc-950/40">
      <div className="px-3 py-1.5 text-[11px] uppercase tracking-wide text-zinc-400 border-b border-zinc-700/60">
        {title}
      </div>
      <div className="px-3 py-2 flex flex-wrap gap-x-6 gap-y-1">
        {children}
      </div>
    </div>
  )
}

function formatLabel(format) {
  if (format === 'html') return 'HTML'
  if (format === 'docx') return 'DOCX'
  return 'Markdown'
}


// Phase 3.10 — POV character dropdown that mirrors the Entity Row
// styling pattern: each option shows a small avatar (or type-icon
// fallback) bordered in the character's colour, and the name in
// the character's colour. Replaces the plain `<select>` so the
// writer can recognise the character visually instead of by name
// alone. Default state (no colour, no profile image) renders
// identically to the existing EntityRow with default `#888888`
// styling.
function PovCharacterDropdown({ charList, value, onChange, disabled }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)
  // Outside-click closer. Capture-phase so it beats other dialog
  // click handlers in the import dialog's preview pane.
  useEffect(() => {
    if (!open) return undefined
    function onPointerDown(e) {
      if (wrapRef.current && wrapRef.current.contains(e.target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open])

  const selected = value ? charList.find((c) => c.name === value) : null

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => { if (!disabled) setOpen((v) => !v) }}
        disabled={disabled}
        className="w-full flex items-center gap-2 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 focus:outline-none focus:border-accent-500 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {selected ? (
          <CharacterRowInline row={selected} />
        ) : (
          <span className="text-zinc-400">(none: scenes import without a POV character)</span>
        )}
        <span className="ml-auto text-zinc-500 text-[10px]">▾</span>
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 z-30 bg-zinc-900 border border-zinc-700 rounded shadow-xl max-h-72 overflow-y-auto">
          <button
            type="button"
            onClick={() => { onChange(''); setOpen(false) }}
            className="w-full text-left px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800/80 border-b border-zinc-800"
          >
            (none: scenes import without a POV character)
          </button>
          {charList.map((c) => (
            <button
              key={c.name}
              type="button"
              onClick={() => { onChange(c.name); setOpen(false) }}
              className={`w-full text-left px-2 py-1.5 text-xs hover:bg-zinc-800/80 ${
                c.name === value ? 'bg-zinc-800/60' : ''
              }`}
            >
              <CharacterRowInline row={c} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// Compact one-line row used inside the dropdown trigger AND each
// option. Mirrors the bigger EntityRow's avatar + colour-name
// pattern (including the hover-preview popup) so the visual
// language is consistent everywhere a character avatar shows up.
function CharacterRowInline({ row }) {
  const colour = row.colour || '#888888'
  const src = row.profile_image_data_uri || null
  return (
    <span className="flex items-center gap-2 min-w-0">
      <ImageHoverPreview src={src} borderColour={colour}>
        {src ? (
          <img
            src={src}
            alt=""
            className="w-5 h-5 rounded-sm object-cover flex-shrink-0"
            style={{ border: `1.5px solid ${colour}` }}
          />
        ) : (
          <span
            className="w-5 h-5 rounded-sm flex items-center justify-center text-[11px] flex-shrink-0"
            style={{ backgroundColor: colour + '22', border: `1.5px solid ${colour}` }}
          >
            {TYPE_ICONS[row.type] || '?'}
          </span>
        )}
      </ImageHoverPreview>
      <span className="truncate" style={{ color: colour }}>{row.name}</span>
    </span>
  )
}

function EntityTypeList({ title, rows, povCharacter, onSetPov }) {
  // Phase 3.10 — `povCharacter` + `onSetPov` are only passed for
  // the characters list; everything else (locations, items, etc.)
  // gets them undefined and falls back to the existing render path.
  return (
    <div data-help-region="nc-import:entity_preview_list" className="border border-zinc-700 rounded bg-zinc-950/40">
      <div className="px-3 py-1.5 text-[11px] uppercase tracking-wide text-zinc-400 border-b border-zinc-700/60 flex items-baseline gap-2">
        <span>{title}</span>
        <span className="text-zinc-600 font-normal normal-case tracking-normal">{rows.length}</span>
      </div>
      <div className="divide-y divide-zinc-800/60">
        {rows.map((row) => (
          <EntityRow
            key={row.nn_uuid}
            row={row}
            isPov={!!(povCharacter && row.name === povCharacter)}
            onSetAsPov={onSetPov ? () => onSetPov(row.name) : null}
          />
        ))}
      </div>
    </div>
  )
}

function EntityRow({ row, isPov = false, onSetAsPov = null }) {
  const colour = row.colour || '#888888'
  const src    = row.profile_image_data_uri || null
  // Phase 3.10 — POV character row gets a left accent stripe + a
  // subtle accent-tinted background so it pops at a glance while
  // staying readable; the swatch + name colours are still the
  // character's own. The pl-[10px] compensates for the 2px border
  // so column content stays in the same horizontal position as
  // non-POV rows (px-3 = 12px on those).
  const rowClass = isPov
    ? 'group px-3 py-2 pl-[10px] border-l-2 border-l-accent-500 bg-accent-900/15 flex items-start gap-3 text-xs'
    : 'group px-3 py-2 flex items-start gap-3 text-xs'
  return (
    <div className={rowClass}>
      {/* Thumb / type-icon swatch */}
      <div className="flex-shrink-0">
        <ImageHoverPreview src={src} borderColour={colour}>
          {src ? (
            <img
              src={src}
              alt=""
              className="w-7 h-7 rounded-sm object-cover"
              style={{ border: `1.5px solid ${colour}` }}
            />
          ) : (
            <span
              className="w-7 h-7 rounded-sm flex items-center justify-center text-sm"
              style={{ backgroundColor: colour + '22', border: `1.5px solid ${colour}` }}
            >
              {TYPE_ICONS[row.type] || '?'}
            </span>
          )}
        </ImageHoverPreview>
      </div>

      {/* Name + chips + description */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-zinc-100 font-medium truncate" style={{ color: colour }}>{row.name}</span>
          {row.aliases.length > 0 && (
            <span className="text-[10px] text-zinc-500">
              aka {row.aliases.join(', ')}
            </span>
          )}
        </div>
        {row.description_preview && (
          <div className="text-[11px] text-zinc-400 mt-0.5 truncate">{row.description_preview}</div>
        )}
        <div className="flex flex-wrap gap-1.5 mt-1">
          {row.tags.map((t) => (
            <span key={t} className="px-1.5 py-0.5 text-[10px] rounded bg-zinc-700/60 text-zinc-300">
              #{t}
            </span>
          ))}
          {row.fields_count > 0 && (
            <span className="px-1.5 py-0.5 text-[10px] rounded bg-zinc-700/40 text-zinc-400">
              {row.fields_count} {row.fields_count === 1 ? 'field' : 'fields'}
            </span>
          )}
          {row.nested_count > 0 && (
            <span className="px-1.5 py-0.5 text-[10px] rounded bg-zinc-700/40 text-zinc-400">
              {row.nested_count} nested
            </span>
          )}
        </div>
      </div>

      {/* Phase 3.10 — Set as POV button. Rendered ONLY for character
          rows (controlled by `onSetAsPov` being non-null at the
          EntityTypeList level). The POV row's badge is always
          visible (visual anchor for the current selection); non-POV
          rows' buttons stay hidden until the writer hovers the row
          to keep the entity-preview list visually quiet. The
          dropdown + this button share the same `defaultPovCharacter`
          state, so changes in either surface immediately sync the
          other. */}
      {onSetAsPov && (
        <div className={`flex-shrink-0 self-center transition-opacity ${
          isPov ? '' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'
        }`}>
          {isPov ? (
            <span className="text-[10px] px-2 py-0.5 rounded border border-accent-700/60 bg-accent-900/40 text-accent-200">
              ✓ Default POV
            </span>
          ) : (
            <button
              type="button"
              onClick={onSetAsPov}
              className="text-[10px] px-2 py-0.5 rounded border border-zinc-700 text-zinc-400 hover:text-accent-300 hover:border-accent-600 transition-colors"
            >
              Set as default POV
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function Stat({ label, value }) {
  return (
    <div className="flex items-baseline gap-2 text-xs">
      <span className="text-zinc-500">{label}:</span>
      <span className="text-zinc-200 font-medium">{value}</span>
    </div>
  )
}
