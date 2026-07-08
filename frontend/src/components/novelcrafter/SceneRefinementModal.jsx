/**
 * Phase 3.10 Layer 5 item #8 — Scene Refinement Modal.
 *
 * The UI surface for the AI-assisted scene-wiring refinement pass.
 * Writers open this from one of three entry points (item #9) to
 * run an LLM over the regex pipeline's output and adjust scene
 * chip placement + POV per-scene.
 *
 * Wire shape (matches `backend/routers/scene_wiring.py`):
 *   POST /api/scene_wiring/refine
 *     { profile_id, model, scene_ids[], depth, refine_pov, use_thinking }
 *     → { scene_results: {<scene_uuid>: {...}},
 *         diff: {scene_diffs[], total_additions, ...},
 *         warnings[], chunk_count, ... }
 *   POST /api/scene_wiring/apply
 *     { scene_diffs: [...] }
 *     → { scenes_touched, additions, removals, pov_changes }
 *
 * The /refine response already carries the diff inline (no second
 * round-trip). Apply re-sends the writer-confirmed (and possibly
 * filtered) diff payload.
 *
 * MVP scope decisions:
 *   - Flat scene list grouped by chapter header (no act-level Run
 *     button yet). Each scene row gets its own checkbox; chapter
 *     headers carry a tri-state group toggle. "Select All" at the
 *     story level. This produces the same `scene_ids[]` payload
 *     as a tree with per-scope Run buttons would; the runtime
 *     difference is "pick selection, then click Refine" vs "click
 *     Run on a row".
 *   - Cost estimate computed client-side using the same chars/4
 *     heuristic the backend `estimate_refinement_cost` uses;
 *     tokens-only (no dollars) until the deferred provider-rate
 *     config surface lands.
 *   - No progress modal during runs — surface an in-modal spinner
 *     + "Refining N scenes…" line until the deferred per-chunk
 *     progress slot ships. The orchestration endpoint runs
 *     sequentially with per-chunk failure isolation, so a long run
 *     blocks the modal but doesn't poison results.
 *
 * Props:
 *   open               — render gate
 *   initialSceneIds    — optional pre-selection (e.g. from the
 *                        scene-detail-panel entry point). When
 *                        null, all scenes start selected.
 *   onClose()          — close handler. Modal does NOT auto-close
 *                        after apply — writer might want to refine
 *                        more scenes in the same session.
 *   onAppliedDiff()    — optional callback fired after a
 *                        successful /apply; the entry-point caller
 *                        can use this to trigger a project reload
 *                        of the affected scenes' chip displays.
 */
import { createPortal } from 'react-dom'
import { useCallback, useEffect, useMemo, useState } from 'react'
import axios from 'axios'

import { useSettingsStore } from '../../store/settingsStore'
import { useProjectStore } from '../../store/projectStore'
import { useEntitiesStore } from '../../store/entitiesStore'
import { confirm as confirmDialog } from '../../store/dialogStore'
import ConnectionModelPickerList from '../ui/ConnectionModelPickerList'
import PopoverSectionRow from '../ui/PopoverSectionRow'
import { EntityLabelChip } from '../ui/IdentityBadges'
import ReasoningButton from '../chat/ReasoningButton'
import { getChapterIdForNode } from '../../utils/chapterMembership'
import { DEFAULT_POV_COLOR, useAccentColor } from '../../utils/povConstants'


// Same heuristic the backend uses (services/scene_wiring.py:estimate_tokens)
// so the in-modal estimate matches what the backend will charge.
function estimateTokens(str) {
  if (!str) return 0
  return Math.ceil(String(str).length / 4)
}

// Translate a `#RRGGBB` hex into a CSS `rgba(r, g, b, a)` string.
// Falls back to a violet rgba so the running-button glow still
// looks reasonable if the accent isn't wired up.
function _withAlpha(hex, alpha) {
  if (typeof hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(hex)) {
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  return `rgba(124, 58, 237, ${alpha})`
}

// Rough per-scene output budget. Mirrors backend constant
// `_PER_SCENE_OUTPUT_TOKENS = 50`. Doubled when thinking is on,
// per backend `_PER_SCENE_THINKING_TOKENS = 250` -> total ~300/scene.
function perSceneOutputTokens(useThinking) {
  return useThinking ? 300 : 50
}

// Conservative input estimate per scene: catalog snippet share plus
// the scene's own text. The grid modal can't see the chunked prompt
// shape, so we use a simple `text_length / 4` per scene + a flat
// system+catalog overhead. Matches backend's order-of-magnitude.
const SYSTEM_PROMPT_OVERHEAD_TOKENS = 1_200

// Collect every entity ref off a scene-node-shape into a flat list
// with type tagging, in chip_order if present (so badges render in
// the same order they appear on the canvas chip strip).
function _collectChipRefs(sceneData) {
  const buckets = [
    ['character', sceneData?.characters || []],
    ['location',  sceneData?.locations  || []],
    ['item',      sceneData?.items      || []],
    ['faction',   sceneData?.factions   || []],
    ['custom',    sceneData?.customs    || []],
  ]
  const all = []
  for (const [type, refs] of buckets) {
    for (const ref of refs) {
      if (ref?.entity_id) all.push({
        entity_id: ref.entity_id,
        entity_type: type,
        has_pov: !!ref.has_pov,
      })
    }
  }
  // Honour chip_order when present.
  const order = Array.isArray(sceneData?.chip_order) ? sceneData.chip_order : []
  if (order.length) {
    const indexById = new Map(order.map((id, i) => [id, i]))
    all.sort((a, b) => {
      const ai = indexById.has(a.entity_id) ? indexById.get(a.entity_id) : 1e9
      const bi = indexById.has(b.entity_id) ? indexById.get(b.entity_id) : 1e9
      return ai - bi
    })
  }
  return all
}

// Short scene-text preview shown on each grid card. ~140 chars,
// stripped of HTML, with ellipsis when truncated.
function _buildDescriptionPreview(sceneData) {
  const raw = sceneData?.description
            || stripHtml(sceneData?.main_content || '')
            || ''
  const trimmed = raw.trim().replace(/\s+/g, ' ')
  if (trimmed.length <= 140) return trimmed
  return trimmed.slice(0, 140).trimEnd() + '…'
}

function buildSceneRow(node, chapters, depth) {
  const chapterId = getChapterIdForNode(node, chapters)
  // The actual payload the LLM sees is composed server-side as
  // XML-wrapped fields: `<description>…</description>` always in
  // description mode; `<description>…</description>` AND
  // `<prose>…</prose>` together in prose mode. The token estimate
  // here mirrors that shape so the cost panel is roughly accurate.
  const desc  = (node.data?.description || '').trim()
  const prose = depth === 'prose' ? stripHtml(node.data?.main_content || '') : ''
  const text = depth === 'prose'
    ? (desc ? `${desc}\n${prose}` : prose)
    : desc
  return {
    id: node.id,
    title: node.data?.title || 'Untitled scene',
    chapter_id: chapterId,
    text,
    text_tokens: estimateTokens(text),
    chip_refs: _collectChipRefs(node.data),
    description_preview: _buildDescriptionPreview(node.data),
  }
}

function stripHtml(html) {
  if (!html) return ''
  // Cheap strip — same as backend's plaintext fallback. Not
  // canonicalising entities here; the token estimate doesn't need it.
  return String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}


export default function SceneRefinementModal({
  open,
  initialSceneIds = null,
  onClose,
  onAppliedDiff,
  // Phase 3.10 Layer 5 staged-mode props. When `stagedStory` is
  // provided, the modal renders against the freshly-built (but
  // not-yet-projected) NC import Story instead of the live project.
  // The footer switches to three exit buttons:
  //   • Apply & finish import  → onStagedApplyAndFinish(sceneDiffs)
  //   • Back to settings       → onStagedBackToSettings() (writer
  //                              keeps the import settings; refinement
  //                              work is discarded; destructive-confirm
  //                              kicks in when refinements exist).
  //   • Cancel import entirely → onStagedCancelImport()
  // In staged mode the modal does NOT call /scene_wiring/apply or
  // mutate projectStore directly — the parent handles finalisation.
  stagedStory = null,
  onStagedApplyAndFinish,
  onStagedBackToSettings,
  onStagedCancelImport,
}) {
  const staged = !!stagedStory
  const prefs       = useSettingsStore((s) => s.preferences)
  const liveStory   = useProjectStore((s) => s.story)
  const liveNodes   = useProjectStore((s) => s.nodes)
  const applyRefinementDiff = useProjectStore((s) => s.applyRefinementDiff)
  // Live-mode entity buckets — used to render badges on each scene
  // card. In staged mode we build the same map from the passed-in
  // staged story; either way the badge component reads off the
  // resulting `entityById` Map.
  const liveCharacters = useEntitiesStore((s) => s.characters)
  const liveLocations  = useEntitiesStore((s) => s.locations)
  const liveItems      = useEntitiesStore((s) => s.items)
  const liveFactions   = useEntitiesStore((s) => s.factions)
  const liveCustoms    = useEntitiesStore((s) => s.customs)
  // In staged mode the modal operates entirely on the passed-in
  // staged story; the live project is irrelevant. Always read the
  // staged story when `staged` is true to avoid accidental crossover.
  const story = staged ? stagedStory : liveStory
  const nodes = liveNodes  // only consulted in standalone mode
  const povColor = story?.pov_color || DEFAULT_POV_COLOR
  // Story accent colour drives the running-Refine glow. Reuses the
  // chat panel's `.nn-tool-active` animation (orbiting border highlight
  // + soft accent-coloured pulse), set per-button via the inline
  // `--tool-active-accent` CSS custom property.
  const accent = useAccentColor() || '#7c3aed'

  // Entity lookup table — id → entity. Used by the badge renderer
  // on each scene card. Staged-mode reads off the freshly-built NC
  // import (no chain modifiers exist; baseline IS the canonical
  // value at every scene); live-mode reads off entitiesStore.
  const entityById = useMemo(() => {
    const map = new Map()
    const buckets = staged
      ? [
          stagedStory?.entities?.characters || [],
          stagedStory?.entities?.locations  || [],
          stagedStory?.entities?.items      || [],
          stagedStory?.entities?.factions   || [],
          stagedStory?.entities?.customs    || [],
        ]
      : [liveCharacters, liveLocations, liveItems, liveFactions, liveCustoms]
    for (const bucket of buckets) {
      for (const e of (bucket || [])) {
        if (e?.id) map.set(e.id, e)
      }
    }
    return map
  }, [staged, stagedStory,
      liveCharacters, liveLocations, liveItems, liveFactions, liveCustoms])

  // ── Provider + model picker state ───────────────────────────────
  // Default to the writer's global default if one is configured;
  // otherwise leave null so the picker shows its empty state.
  const defaultProfileId = prefs?.ai_default_profile_id || null
  const defaultModel     = prefs?.ai_default_model?.model || null

  const [pickedProfileId, setPickedProfileId] = useState(defaultProfileId)
  const [pickedModel,     setPickedModel]     = useState(defaultModel)

  // Reset to defaults whenever the modal opens fresh.
  useEffect(() => {
    if (!open) return
    setPickedProfileId(defaultProfileId)
    setPickedModel(defaultModel)
  }, [open, defaultProfileId, defaultModel])

  // Resolve the model_capabilities entry for the picked pair so we
  // can gate the thinking toggle.
  const pickedCaps = useMemo(() => {
    const profiles = prefs?.ai_provider_profiles || []
    const profile = profiles.find((p) => p.id === pickedProfileId)
    if (!profile || !pickedModel) return null
    return profile.model_capabilities?.[pickedModel] || null
  }, [prefs?.ai_provider_profiles, pickedProfileId, pickedModel])

  const supportsThinking = pickedCaps?.supports_reasoning === true

  // ── Settings band state ────────────────────────────────────────
  const [depth,       setDepth]       = useState('description')
  const [refinePov,   setRefinePov]   = useState(true)
  const [useThinking, setUseThinking] = useState(false)

  // Reset settings when reopened.
  useEffect(() => {
    if (!open) return
    setDepth('description')
    setRefinePov(true)
    setUseThinking(false)
  }, [open])

  // Gate thinking toggle off when the picked model doesn't support it.
  useEffect(() => {
    if (!supportsThinking && useThinking) setUseThinking(false)
  }, [supportsThinking, useThinking])

  // ── Scene tree + selection ──────────────────────────────────────
  // Live-project mode: walk projectStore.nodes filtered by type.
  // Staged-import mode: walk stagedStory.scenes (Pydantic-dumped
  // SceneNode shape) directly. The two shapes differ — projectStore
  // nodes carry their fields nested under `.data`, the dumped
  // SceneNode shape carries them at the top level. We adapt the
  // staged records into the node shape `getChapterIdForNode` and
  // `buildSceneRow` expect so the downstream pipeline doesn't have
  // to branch.
  const sceneNodes = useMemo(() => {
    if (staged) {
      const scenes = stagedStory?.scenes || []
      return scenes.map((sc) => ({
        id: sc.id,
        type: 'sceneNode',
        position: sc.position,
        width: sc.width,
        data: sc,  // SceneNode fields land flat on .data so the
        // existing buildSceneRow / chapterMembership helpers find
        // them without modification.
      }))
    }
    return (nodes || []).filter((n) => n.type === 'sceneNode')
  }, [staged, stagedStory, nodes])
  const chapters = story?.chapters || []

  // Build scene rows once per depth flip (depth changes which text
  // the row pulls — description vs full prose).
  const sceneRows = useMemo(
    () => sceneNodes.map((n) => buildSceneRow(n, chapters, depth)),
    [sceneNodes, chapters, depth],
  )

  // Selection state — keyed by scene id. Defaults to ALL selected
  // when `initialSceneIds` is null; otherwise just the pre-selected
  // ids (entry from a scene-detail-panel button passes a single id).
  const [selected, setSelected] = useState(() => new Set())
  useEffect(() => {
    if (!open) return
    if (Array.isArray(initialSceneIds) && initialSceneIds.length > 0) {
      setSelected(new Set(initialSceneIds))
    } else {
      setSelected(new Set(sceneRows.map((r) => r.id)))
    }
  // We deliberately want this to fire on (open) edge + when the row
  // set changes, not when the writer ticks rows.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sceneNodes.length])

  const toggleScene = useCallback((id) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }, [])

  const toggleChapter = useCallback((chapterId) => {
    setSelected((prev) => {
      const next = new Set(prev)
      const rowsInCh = sceneRows.filter((r) => r.chapter_id === chapterId)
      const allOn = rowsInCh.every((r) => next.has(r.id))
      rowsInCh.forEach((r) => {
        if (allOn) next.delete(r.id); else next.add(r.id)
      })
      return next
    })
  }, [sceneRows])

  const selectAll = useCallback(() => {
    setSelected(new Set(sceneRows.map((r) => r.id)))
  }, [sceneRows])
  const selectNone = useCallback(() => setSelected(new Set()), [])
  // "Select unrefined" — picks only the scenes that have NOT been
  // sent to the LLM yet. Scenes the LLM returned with no proposed
  // changes (`no_change`) and declined-POV scenes count as refined
  // and are excluded — the writer ran them once already and doesn't
  // need them re-run by default. Used after a partial refine to
  // pick up the leftovers without re-spending tokens on completed
  // scenes.

  // Act + chapter numbering. Acts are numbered 1..N by their order
  // in `story.acts`; chapters by their order in `story.chapters`.
  // Per-chapter scene numbers (Scene 1, 2, 3 within Chapter X) are
  // assigned per-group when building `grouped` below.
  const acts = story?.acts || []
  const chapterNumberById = useMemo(() => {
    const m = new Map()
    chapters.forEach((c, i) => m.set(c.id, i + 1))
    return m
  }, [chapters])
  const actNumberByChapterId = useMemo(() => {
    const m = new Map()
    acts.forEach((a, ai) => {
      const ids = Array.isArray(a?.chapter_ids) ? a.chapter_ids : []
      for (const chId of ids) m.set(chId, ai + 1)
    })
    return m
  }, [acts])

  // Group scene rows by chapter for rendering. Unchaptered scenes
  // get a "(Unchaptered)" group at the bottom. Each group carries
  // its display number plus per-card scene_index for the Scene N
  // prefix the writer asked for.
  const grouped = useMemo(() => {
    const byCh = new Map()
    for (const r of sceneRows) {
      const k = r.chapter_id || '__unchaptered__'
      if (!byCh.has(k)) byCh.set(k, [])
      byCh.get(k).push(r)
    }
    // Order: follow chapters[] order; unchaptered last.
    const groups = []
    for (const ch of chapters) {
      const list = byCh.get(ch.id)
      if (!list || !list.length) continue
      const chNum = chapterNumberById.get(ch.id) || null
      const actNum = actNumberByChapterId.get(ch.id) || null
      const numberedRows = list.map((r, i) => ({ ...r, scene_index: i + 1 }))
      groups.push({
        id: ch.id,
        chapter_number: chNum,
        act_number: actNum,
        chapter_name: ch.title || '',
        rows: numberedRows,
      })
    }
    const unch = byCh.get('__unchaptered__')
    if (unch && unch.length) {
      const numberedRows = unch.map((r, i) => ({ ...r, scene_index: i + 1 }))
      groups.push({
        id: null,
        chapter_number: null,
        act_number: null,
        chapter_name: '(Unchaptered)',
        rows: numberedRows,
      })
    }
    return groups
  }, [sceneRows, chapters, chapterNumberById, actNumberByChapterId])

  // ── Cost estimate ──────────────────────────────────────────────
  const estimate = useMemo(() => {
    const sel = sceneRows.filter((r) => selected.has(r.id))
    const inputTokens = SYSTEM_PROMPT_OVERHEAD_TOKENS
                      + sel.reduce((s, r) => s + r.text_tokens, 0)
    const outputTokens = sel.length * perSceneOutputTokens(useThinking)
    return {
      scene_count: sel.length,
      input_tokens:  inputTokens,
      output_tokens: outputTokens,
      total_tokens:  inputTokens + outputTokens,
    }
  }, [sceneRows, selected, useThinking])

  // ── Run + apply state ──────────────────────────────────────────
  // running:     true while /refine is in flight
  // refineError: top-level error message (network / 500 / no provider)
  // results:     map of scene_id → {pov, entities_present, warnings}
  // diff:        the serialised diff returned by /refine
  // sceneStatus: derived UX-level status per scene id
  // applying:    true while /apply is in flight
  // appliedSummary: last-apply counts surfaced under the footer
  const [running,       setRunning]       = useState(false)
  // Per-run id assigned by the backend at /refine kickoff. Held in
  // local state so the Cancel button can fire /refine_cancel against
  // the right slot and so the polling loop sees the id update if a
  // second refine is started after the first finishes.
  const [activeRunId,   setActiveRunId]   = useState(null)
  const [cancelling,    setCancelling]    = useState(false)
  const [refineError,   setRefineError]   = useState(null)
  const [results,       setResults]       = useState({})
  const [diff,          setDiff]          = useState(null)
  const [applying,      setApplying]      = useState(false)
  const [applyError,    setApplyError]    = useState(null)
  const [appliedSummary, setAppliedSummary] = useState(null)
  // Last /refine response metadata for the summary banner. Accumulated
  // across multiple refines if the writer runs the model more than
  // once during the same session (e.g. refines part of the project,
  // changes settings, refines another part). Counts are derived from
  // the latest response — not cumulative — so the banner reflects the
  // most recent run's stats and any leftover unactioned diff entries
  // surface via the per-card badges instead.
  const [runMeta, setRunMeta] = useState(null)
  // Per-scene streaming state. Both are sets of NN UUIDs the
  // backend ships on every /refine_progress tick:
  //   • queuedSceneIds    — selected for this run, chunk hasn't
  //                         started yet. Card renders a neutral
  //                         "Queued" badge.
  //   • refiningSceneIds  — the LLM is currently producing output
  //                         for these scenes. Card renders a
  //                         "Refining" badge in the story accent
  //                         colour with the spinning-coin animation.
  //   • A scene whose verdict has fully streamed in lands in
  //     `results` and falls out of both sets. The status helper
  //     below resolves its real state from results + diff.
  const [queuedSceneIds, setQueuedSceneIds] = useState(() => new Set())
  const [refiningSceneIds, setRefiningSceneIds] = useState(() => new Set())

  // Per-scene UX status derived from (results, diff). The badges:
  //   not_refined — no entry in results
  //   refined     — has a parsed result + diff entry
  //   pov_declined — result has pov=null (LLM returned ?*)
  //   failed      — present in run.warnings as a scene-level failure
  const sceneStatus = useMemo(() => {
    const out = {}
    // Build the diff lookup once for the no_change vs refined split.
    const diffByUuid = new Map((diff?.scene_diffs || []).map((sd) => [sd.scene_uuid, sd]))
    for (const r of sceneRows) {
      // In-flight states take precedence so the modal never shows
      // a stale not_refined/no_change on a scene the backend is
      // actively working on. Refining > Queued > final-state.
      if (refiningSceneIds.has(r.id)) { out[r.id] = 'refining'; continue }
      if (queuedSceneIds.has(r.id))   { out[r.id] = 'queued';   continue }
      const res = results[r.id]
      if (!res) { out[r.id] = 'not_refined'; continue }
      if (refinePov && res.pov === null) { out[r.id] = 'pov_declined'; continue }
      const sd = diffByUuid.get(r.id)
      const hasChanges = !!sd && (
        (sd.chip_changes?.length || 0) > 0 || sd.pov_change != null
      )
      out[r.id] = hasChanges ? 'refined' : 'no_change'
    }
    return out
  }, [sceneRows, results, diff, refinePov, refiningSceneIds, queuedSceneIds])

  const sceneDiffById = useMemo(() => {
    const m = {}
    if (diff?.scene_diffs) {
      for (const sd of diff.scene_diffs) m[sd.scene_uuid] = sd
    }
    return m
  }, [diff])

  // ── Refine click handler ────────────────────────────────────────
  const onRefine = useCallback(async () => {
    setRefineError(null)
    if (!pickedProfileId || !pickedModel) {
      setRefineError('Pick a provider and model first.')
      return
    }
    const scene_ids = Array.from(selected)
    if (scene_ids.length === 0) {
      setRefineError('Select at least one scene to refine.')
      return
    }
    setRunning(true)
    try {
      const body = {
        profile_id:   pickedProfileId,
        model:        pickedModel,
        scene_ids,
        depth,
        refine_pov:   refinePov,
        use_thinking: useThinking,
      }
      // Staged-mode: refine against the NC-import staged story
      // rather than state.story (which holds the writer's
      // existing project — wrong universe for refinement).
      if (staged) body.staged_story = stagedStory
      // POST kicks off the run as a background task on the backend
      // and returns the run_id immediately. We then poll
      // /refine_progress until done=true, merging per-chunk results
      // into the modal as they land so the writer sees scenes
      // tick over one chunk at a time instead of waiting for the
      // whole run.
      const { data: startResp } = await axios.post('/api/scene_wiring/refine', body)
      const runId = startResp.run_id
      if (!runId) {
        throw new Error('Backend did not return run_id; refresh and try again.')
      }
      setActiveRunId(runId)
      // Poll loop. ~500 ms tick: fast enough that the writer sees
      // each chunk tick over within a half-second of it landing,
      // slow enough that 100+ scenes' worth of polling doesn't
      // hammer the backend.
      const finalState = await new Promise((resolve, reject) => {
        let stopped = false
        const tick = async () => {
          if (stopped) return
          try {
            const { data: progress } = await axios.get(
              '/api/scene_wiring/refine_progress',
              { params: { run_id: runId } },
            )
            // Merge per-scene results into modal state as they
            // land. UUID-keyed so they slot directly into the
            // existing `results` map.
            if (progress.scene_results && Object.keys(progress.scene_results).length) {
              setResults((prev) => ({ ...prev, ...progress.scene_results }))
            }
            // Merge the accumulating diff (per-scene from the
            // streaming parser, per-chunk from the chunk-end
            // fallback) so per-card "refined" status reflects
            // current backend state mid-run.
            if (progress.diff?.scene_diffs?.length) {
              setDiff((prev) => {
                if (!prev) return progress.diff
                const byUuid = new Map(prev.scene_diffs.map((sd) => [sd.scene_uuid, sd]))
                for (const sd of progress.diff.scene_diffs) byUuid.set(sd.scene_uuid, sd)
                const merged = Array.from(byUuid.values())
                return {
                  ...progress.diff,
                  scene_diffs: merged,
                }
              })
            }
            // In-flight badge sets — replace wholesale (these are
            // ephemeral state the backend ships every tick).
            setQueuedSceneIds(new Set(progress.queued_scene_ids || []))
            setRefiningSceneIds(new Set(progress.processing_scene_ids || []))
            if (progress.done) {
              stopped = true
              resolve(progress)
              return
            }
            if (progress.error) {
              stopped = true
              reject(new Error(progress.error))
              return
            }
            setTimeout(tick, 500)
          } catch (err) {
            // 404 = slot evicted (shouldn't happen mid-run but be
            // defensive). Stop polling and report.
            stopped = true
            reject(err)
          }
        }
        tick()
      })
      // Terminal poll carries the final diff + meta.
      const finalDiff = finalState.diff || { scene_diffs: [] }
      const sceneResultsCount = Object.keys(finalState.scene_results || {}).length
      const actionableThisRun = (finalDiff.scene_diffs || []).filter(
        (sd) => (sd.chip_changes?.length || 0) > 0 || sd.pov_change != null,
      ).length
      const noChangeThisRun = sceneResultsCount - actionableThisRun
                            - Number(finalDiff.pov_declined_count || 0)
      const finalMeta = finalState.meta || {}
      setRunMeta({
        scenes_requested:  Number(finalMeta.scenes_requested  || scene_ids.length),
        scenes_attempted:  Number(finalMeta.scenes_attempted  || sceneResultsCount),
        scenes_resolved:   Number(finalMeta.scenes_resolved   || sceneResultsCount),
        chunks_run:        Number(finalMeta.chunks_run        || finalState.chunks_done || 0),
        chunks_failed:     Number(finalMeta.chunks_failed     || finalState.chunks_failed || 0),
        actionable_count:  actionableThisRun,
        no_change_count:   Math.max(0, noChangeThisRun),
        pov_declined:      Number(finalDiff.pov_declined_count || 0),
        warnings:          Array.isArray(finalState.warnings) ? finalState.warnings : [],
      })
      // Merge per-run diff with any previous diffs so subsequent
      // refines on different scenes accumulate.
      setDiff((prev) => {
        if (!finalState.diff) return prev
        if (!prev) return finalState.diff
        const byUuid = new Map()
        for (const sd of prev.scene_diffs) byUuid.set(sd.scene_uuid, sd)
        for (const sd of finalState.diff.scene_diffs) byUuid.set(sd.scene_uuid, sd)
        const merged_scene_diffs = Array.from(byUuid.values())
        return {
          ...finalState.diff,
          scene_diffs: merged_scene_diffs,
          total_additions:   merged_scene_diffs.reduce((s, d) => s + d.chip_changes.filter((c) => c.kind === 'add').length, 0),
          total_removals:    merged_scene_diffs.reduce((s, d) => s + d.chip_changes.filter((c) => c.kind === 'remove').length, 0),
          total_pov_changes: merged_scene_diffs.reduce((s, d) => s + (d.pov_change ? 1 : 0), 0),
        }
      })
      // Best-effort cleanup; ignore failures.
      try {
        await axios.post('/api/scene_wiring/refine_progress_clear', null, {
          params: { run_id: runId },
        })
      } catch { /* ignore */ }
    } catch (err) {
      const msg = err?.response?.data?.detail || err?.message || String(err)
      setRefineError(`Refinement failed: ${msg}`)
    } finally {
      setRunning(false)
      setActiveRunId(null)
      setCancelling(false)
      // Clear in-flight badge sets — once `running` flips false the
      // backend slot is also drained, but the modal's local state
      // doesn't auto-mirror that so wipe explicitly.
      setQueuedSceneIds(new Set())
      setRefiningSceneIds(new Set())
    }
  }, [pickedProfileId, pickedModel, selected, depth, refinePov, useThinking, staged, stagedStory])

  // ── Cancel click handler ──────────────────────────────────────
  // POSTs the cancel flag onto the backend's progress slot. The
  // polling loop above is unaffected — it keeps reading until the
  // backend flips `done=true` (which happens once the orchestrator
  // sees the cancel signal at the next chunk boundary). Completed
  // chunks' results are RETAINED in the modal's draft state; the
  // in-flight chunk's partial response is dropped. Writer can then
  // review what landed and click Apply if they want to commit it.
  const onCancelRefine = useCallback(async () => {
    if (!activeRunId || cancelling) return
    setCancelling(true)
    try {
      await axios.post('/api/scene_wiring/refine_cancel', null, {
        params: { run_id: activeRunId },
      })
    } catch {
      // Best-effort — if the backend already finished or the slot
      // was cleared, the modal's polling will see done=true on the
      // next tick and resolve normally.
    }
  }, [activeRunId, cancelling])

  // ── Apply click handler ────────────────────────────────────────
  const onApply = useCallback(async () => {
    setApplyError(null)
    setAppliedSummary(null)
    if (!diff || !diff.scene_diffs?.length) {
      setApplyError('Nothing to apply.')
      return
    }
    // Only apply diffs that have at least one actionable mutation.
    const actionable = diff.scene_diffs.filter(
      (sd) => (sd.chip_changes?.length || 0) > 0 || sd.pov_change != null,
    )
    if (actionable.length === 0) {
      setApplyError('No scene changes to apply.')
      return
    }
    setApplying(true)
    try {
      // Backend mutates state.story (so any backend-side process
      // reading state.story stays consistent); frontend mirrors the
      // same mutation into projectStore.nodes so the canvas /
      // detail panel reflect the change immediately. Both apply
      // the SAME diff so they cannot diverge.
      const { data } = await axios.post('/api/scene_wiring/apply', {
        scene_diffs: actionable,
      })
      applyRefinementDiff({ scene_diffs: actionable })
      setAppliedSummary({
        scenes_touched: data.scenes_touched,
        additions:      data.additions,
        removals:       data.removals,
        pov_changes:    data.pov_changes,
      })
      // Clear the applied diff so a second click doesn't re-apply.
      setDiff(null)
      onAppliedDiff?.(data)
    } catch (err) {
      const msg = err?.response?.data?.detail || err?.message || String(err)
      setApplyError(`Apply failed: ${msg}`)
    } finally {
      setApplying(false)
    }
  }, [diff, onAppliedDiff, applyRefinementDiff])

  // ── Discard click handler ──────────────────────────────────────
  const onDiscard = useCallback(() => {
    setResults({})
    setDiff(null)
    setRunMeta(null)
    setRefineError(null)
    setApplyError(null)
    setAppliedSummary(null)
  }, [])

  // ── Provider/model picker tree ──────────────────────────────────
  const modelTree = useMemo(() => {
    const profiles = prefs?.ai_provider_profiles || []
    return profiles
      .map((profile) => {
        const sel = profile.selected_models || []
        const man = profile.manually_added_models || []
        const models = Array.from(new Set([...sel, ...man]))
        return { profile, models }
      })
      .filter(({ models }) => models.length > 0)
  }, [prefs?.ai_provider_profiles])

  const pickedProfile = useMemo(() => {
    return (prefs?.ai_provider_profiles || []).find((p) => p.id === pickedProfileId) || null
  }, [prefs?.ai_provider_profiles, pickedProfileId])
  const pickedCapsApiType = pickedProfile?.api_type || null

  const [pickerOpen, setPickerOpen] = useState(false)

  if (!open) return null

  const totalSelected   = estimate.scene_count
  const totalScenes     = sceneRows.length
  const canRefine       = !running && !applying && totalSelected > 0 && !!pickedProfileId && !!pickedModel
  const actionableCount = diff?.scene_diffs?.filter(
    (sd) => (sd.chip_changes?.length || 0) > 0 || sd.pov_change != null,
  ).length || 0

  return createPortal(
    <div
      className="fixed inset-0 z-[1500] flex items-center justify-center bg-black/70"
      role="dialog"
      aria-modal="true"
      aria-labelledby="scene-refinement-title"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}
    >
      <div data-help-region="scene-refinement:modal" className="w-[760px] max-w-[95vw] max-h-[90vh] flex flex-col bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl">
        {/* Header */}
        <div data-help-region="scene-refinement:header" className="flex items-center justify-between px-4 py-3 border-b border-zinc-700">
          <h2 id="scene-refinement-title" className="text-sm font-semibold text-zinc-100">
            Refine scene placements with AI
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-xl text-zinc-400 hover:text-zinc-100"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Body — scrollable */}
        <div data-help-region="scene-refinement:body" className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-4">
          {/* Provider / model row */}
          <div data-help-region="scene-refinement:provider_model">
            <label className="text-[11px] text-zinc-400 block mb-1">AI provider and model</label>
            <PopoverSectionRow
              label="Connection"
              value={pickedProfile && pickedModel
                ? `${pickedProfile.name} · ${pickedModel}`
                : 'Pick a provider and model…'}
              isOpen={pickerOpen}
              onEnter={() => setPickerOpen(true)}
              onLeave={() => setPickerOpen(false)}
              trigger="click"
              flyoutWidth={340}
              flyoutZClass="z-[1600]"
              flyoutDataAttr="scene-refinement-picker"
            >
              <ConnectionModelPickerList
                tree={modelTree}
                activeProfileId={pickedProfileId}
                activeModel={pickedModel}
                defaultProfileId={defaultProfileId}
                defaultModel={defaultModel}
                onPick={(profileId, modelId) => {
                  setPickedProfileId(profileId)
                  setPickedModel(modelId)
                  setPickerOpen(false)
                }}
                emptyMessage="No connections configured."
              />
            </PopoverSectionRow>
          </div>

          {/* Settings band */}
          <div data-help-region="scene-refinement:settings_band" className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-[11px] text-zinc-400 block mb-1">Scene text depth</label>
              <div className="flex flex-col gap-1 text-xs text-zinc-200">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="scene-refinement-depth"
                    value="description"
                    checked={depth === 'description'}
                    onChange={() => setDepth('description')}
                    className="accent-accent-500"
                  />
                  Description
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="scene-refinement-depth"
                    value="prose"
                    checked={depth === 'prose'}
                    onChange={() => setDepth('prose')}
                    className="accent-accent-500"
                  />
                  Full prose
                </label>
              </div>
            </div>
            <div>
              <label className="text-[11px] text-zinc-400 block mb-1">Refinement scope</label>
              <label className="flex items-center gap-2 text-xs text-zinc-200">
                <input
                  type="checkbox"
                  checked={refinePov}
                  onChange={(e) => setRefinePov(e.target.checked)}
                  className="accent-accent-500"
                />
                Refine POV character
              </label>
            </div>
            <div>
              <label className="text-[11px] text-zinc-400 block mb-1">Reasoning</label>
              <div className="flex items-center gap-2">
                {/* Same control as the chat composer's reasoning
                    toggle, driven by the modal's local (pickedCaps,
                    useThinking) state via the controlled-mode props
                    on ReasoningButton. */}
                <ReasoningButton
                  caps={{
                    api_type:           pickedCapsApiType,
                    profile_id:         pickedProfileId,
                    model:              pickedModel,
                    supports_reasoning: supportsThinking,
                    reasoning_options:  pickedCaps?.reasoning_options || null,
                    reasoning_budget_range: pickedCaps?.reasoning_budget_range || null,
                    reasoning_default:  pickedCaps?.reasoning_default || null,
                  }}
                  enabled={useThinking}
                  onToggle={(next) => setUseThinking(!!next)}
                />
                <span className={`text-xs ${supportsThinking ? 'text-zinc-300' : 'text-zinc-500'}`}>
                  {supportsThinking
                    ? (useThinking ? 'Thinking on' : 'Thinking off')
                    : 'Not exposed by this model'}
                </span>
              </div>
            </div>
          </div>

          {/* Scene tree + selection */}
          <div data-help-region="scene-refinement:scene_selection">
            <div className="flex items-center justify-between mb-1">
              <label className="text-[11px] text-zinc-400">
                Scenes to refine ({totalSelected} / {totalScenes} selected)
              </label>
              <div className="flex items-center gap-2 text-[11px]">
                <button
                  type="button"
                  onClick={selectAll}
                  className="text-zinc-400 hover:text-zinc-100 underline-offset-2 hover:underline"
                >
                  Select all
                </button>
                {/* Shown only after at least one scene has been
                    refined this session. Selecting "unrefined" picks
                    every scene the LLM hasn't seen yet — scenes
                    refined but returned with no changes, or with POV
                    declined, count as refined and are excluded. */}
                {sceneRows.some((r) => sceneStatus[r.id] && sceneStatus[r.id] !== 'not_refined') && (
                  <>
                    <span className="text-zinc-700">·</span>
                    <button
                      type="button"
                      onClick={() => {
                        const ids = sceneRows
                          .filter((r) => !sceneStatus[r.id] || sceneStatus[r.id] === 'not_refined')
                          .map((r) => r.id)
                        setSelected(new Set(ids))
                      }}
                      className="text-zinc-400 hover:text-zinc-100 underline-offset-2 hover:underline"
                      title="Select only scenes that haven't been refined yet"
                    >
                      Unrefined
                    </button>
                  </>
                )}
                <span className="text-zinc-700">·</span>
                <button
                  type="button"
                  onClick={selectNone}
                  className="text-zinc-400 hover:text-zinc-100 underline-offset-2 hover:underline"
                >
                  None
                </button>
              </div>
            </div>
            {runMeta && <RefinementSummary meta={runMeta} />}
            <div className="border border-zinc-700 rounded bg-zinc-950 max-h-[420px] overflow-y-auto p-3 space-y-4">
              {grouped.length === 0 && (
                <div className="text-[11px] text-zinc-500 italic px-1 py-2">
                  No scenes in this project yet.
                </div>
              )}
              {grouped.map((g) => {
                const allOn = g.rows.every((r) => selected.has(r.id))
                const someOn = g.rows.some((r) => selected.has(r.id))
                return (
                  <div key={g.id || '__unchaptered__'} className="text-xs">
                    {/* Chapter band header. Plain separator above
                        each chapter's row of scene cards — scrolls
                        with the grid (previous sticky behaviour was
                        clipping the cards below). Shows "Act N ·
                        Chapter M · Name" (or omits any piece that
                        doesn't exist for this group — e.g. unchaptered
                        scenes have no numbering; chapters not assigned
                        to an act omit the Act N prefix; an unnamed
                        chapter shows only "Chapter M"). */}
                    <div className="flex items-center gap-2 px-1 py-1.5 border-b border-zinc-800 mb-2">
                      <input
                        type="checkbox"
                        checked={allOn}
                        ref={(el) => { if (el) el.indeterminate = !allOn && someOn }}
                        onChange={() => toggleChapter(g.id)}
                        className="accent-accent-500"
                      />
                      <span className="text-zinc-200 font-medium uppercase tracking-wide text-[11px]">
                        {[
                          g.act_number ? `Act ${g.act_number}` : null,
                          g.chapter_number ? `Chapter ${g.chapter_number}` : null,
                          g.chapter_name && g.chapter_name !== '(Unchaptered)' ? g.chapter_name : null,
                          g.chapter_name === '(Unchaptered)' ? '(Unchaptered)' : null,
                        ].filter(Boolean).join(' · ')}
                      </span>
                      <span className="text-[10px] text-zinc-600 ml-auto">{g.rows.length} scenes</span>
                    </div>
                    {/* Scene-card grid. CSS grid with auto-fill columns
                        so cards reflow as the dialog width changes. */}
                    <div
                      className="grid gap-2"
                      style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}
                    >
                      {g.rows.map((r) => (
                        <SceneCard
                          key={r.id}
                          row={r}
                          selected={selected.has(r.id)}
                          status={sceneStatus[r.id]}
                          diff={sceneDiffById[r.id]}
                          verdict={results[r.id] || null}
                          entityById={entityById}
                          povColor={povColor}
                          accent={accent}
                          onToggle={() => toggleScene(r.id)}
                        />
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Token-use estimate */}
          <div data-help-region="scene-refinement:token_estimate" className="rounded border border-zinc-700 bg-zinc-950/60 px-3 py-2 text-[11px] text-zinc-300">
            <div className="font-medium text-zinc-200">Token use estimation</div>
            <div className="mt-1 grid grid-cols-3 gap-2 text-[11px]">
              <div>
                <span className="text-zinc-500">Input:</span>{' '}
                <span className="text-zinc-200">{estimate.input_tokens.toLocaleString()} tok</span>
              </div>
              <div>
                <span className="text-zinc-500">Output:</span>{' '}
                <span className="text-zinc-200">{estimate.output_tokens.toLocaleString()} tok</span>
              </div>
              <div>
                <span className="text-zinc-500">Total:</span>{' '}
                <span className="text-zinc-200">{estimate.total_tokens.toLocaleString()} tok</span>
              </div>
            </div>
            <div className="mt-1 text-[10px] text-zinc-500 italic">
              Rough estimate. Actual count depends on the provider's tokenizer.
            </div>
          </div>

          {/* Status messages */}
          {refineError && (
            <div className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-[11px] text-red-200">
              {refineError}
            </div>
          )}
          {applyError && (
            <div className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-[11px] text-red-200">
              {applyError}
            </div>
          )}
          {appliedSummary && (
            <div className="rounded border border-emerald-900 bg-emerald-950/40 px-3 py-2 text-[11px] text-emerald-200">
              Applied to {appliedSummary.scenes_touched} scene{appliedSummary.scenes_touched === 1 ? '' : 's'}:
              {' '}+{appliedSummary.additions} chip{appliedSummary.additions === 1 ? '' : 's'},
              {' '}−{appliedSummary.removals} chip{appliedSummary.removals === 1 ? '' : 's'},
              {' '}{appliedSummary.pov_changes} POV change{appliedSummary.pov_changes === 1 ? '' : 's'}.
            </div>
          )}
        </div>

        {/* Footer */}
        <div data-help-region="scene-refinement:footer" className="border-t border-zinc-700 px-4 py-3 flex items-center justify-between">
          <div className="text-[11px] text-zinc-500">
            {diff?.pov_declined_count > 0 && (
              <span>LLM declined POV for {diff.pov_declined_count} scene{diff.pov_declined_count === 1 ? '' : 's'}. </span>
            )}
            {actionableCount > 0 && (
              <span className="text-zinc-300">{actionableCount} pending apply</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {staged ? (
              <StagedFooterButtons
                running={running}
                applying={applying}
                canRefine={canRefine}
                cancelling={cancelling}
                accent={accent}
                totalSelected={totalSelected}
                actionableCount={actionableCount}
                hasRefinements={Object.keys(results).length > 0 || !!diff}
                onRefine={onRefine}
                onCancelRefine={onCancelRefine}
                onCancelImport={onStagedCancelImport}
                onBackToSettings={() => {
                  const hasRefinements = Object.keys(results).length > 0 || !!diff
                  if (!hasRefinements) {
                    onStagedBackToSettings?.()
                    return
                  }
                  confirmDialog({
                    title: 'Discard AI refinements?',
                    message: 'Going back to the import settings discards every scene refinement made so far. The import is not committed yet, so you can run a fresh refinement after tweaking the settings. Continue?',
                    confirmLabel: 'Discard and go back',
                    cancelLabel: 'Stay here',
                    destructive: true,
                  }).then((ok) => {
                    if (ok) onStagedBackToSettings?.()
                  })
                }}
                onApplyAndFinish={() => {
                  // Collect the diffs (or empty array when refinement
                  // was skipped). The parent posts /commit_staged.
                  const actionable = diff?.scene_diffs?.filter(
                    (sd) => (sd.chip_changes?.length || 0) > 0 || sd.pov_change != null,
                  ) || []
                  onStagedApplyAndFinish?.(actionable)
                }}
              />
            ) : (
              <>
                <button
                  type="button"
                  onClick={onDiscard}
                  disabled={running || applying || (Object.keys(results).length === 0 && !diff)}
                  className="px-3 py-1.5 text-xs rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Discard results
                </button>
                <button
                  type="button"
                  onClick={onRefine}
                  disabled={!canRefine}
                  className={`px-3 py-1.5 text-xs rounded border border-accent-700 bg-accent-950/40 text-accent-200 inline-flex items-center gap-1 ${
                    running
                      ? 'nn-tool-active cursor-progress'
                      : canRefine
                        ? 'hover:bg-accent-900/50'
                        : 'opacity-40 cursor-not-allowed'
                  }`}
                  style={running ? { '--tool-active-accent': _withAlpha(accent, 0.95) } : undefined}
                >
                  {running && <RefiningCoin />}
                  {running ? `Refining ${totalSelected}…` : `Refine ${totalSelected} scene${totalSelected === 1 ? '' : 's'}`}
                </button>
                {running && (
                  <button
                    type="button"
                    onClick={onCancelRefine}
                    disabled={cancelling}
                    className="px-2.5 py-1.5 text-xs rounded border border-red-800/70 bg-red-950/40 text-red-200 hover:bg-red-900/50 disabled:opacity-40 disabled:cursor-not-allowed"
                    title="Stop the AI request. Completed chunks' results are kept; the in-flight chunk's partial response is discarded."
                  >
                    {cancelling ? 'Cancelling…' : 'Cancel'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={onApply}
                  disabled={applying || running || actionableCount === 0}
                  className="px-3 py-1.5 text-xs rounded border border-emerald-700 bg-emerald-950/40 text-emerald-200 hover:bg-emerald-900/50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {applying ? 'Applying…' : `Apply ${actionableCount} pending`}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}


/**
 * Single scene tile in the grid. Renders:
 *   • top row: selection checkbox + scene title + (status badge if any)
 *   • entity badges row (one chip per entity currently in the scene,
 *     baseline name + colour — see entityById notes upstream for why
 *     baseline reads are the right shape on a freshly-built staged
 *     NC import)
 *   • description preview (~140 chars, truncated)
 *   • diff summary footer (only when a /refine result mutated this
 *     scene — green for adds, red for removes, amber for POV change)
 *
 * POV character chips render with a small amber crown glyph next
 * to the badge so the writer can spot the current POV at a glance
 * without having to read the diff.
 */
function SceneCard({ row, selected, status, diff, verdict, entityById, povColor, accent, onToggle }) {
  const [expanded, setExpanded] = useState(false)
  const canExpand = !!verdict  // only meaningful after a refine pass returned a verdict
  // Mirror the canvas SceneNode's visual identity — purple top
  // border (the same `#7c3aed` accent the SceneNode uses) plus the
  // same uppercase `Scene` badge treatment. Keeps grid cards
  // recognisable as the same entity-class as canvas scene nodes.
  return (
    <div
      data-help-region="scene-refinement:scene_card"
      className={`rounded border bg-zinc-900 p-2 flex flex-col gap-1.5 transition-colors border-t-2 ${
        selected ? 'border-zinc-600' : 'border-zinc-800'
      }`}
      style={{ borderTopColor: '#7c3aed' }}
    >
      <div className="flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          className="accent-accent-500 flex-shrink-0"
        />
        {row.scene_index ? (
          <span className="text-[9px] text-purple-400 uppercase tracking-widest font-semibold bg-purple-900/30 px-1.5 py-0.5 rounded flex-shrink-0">
            Scene {row.scene_index}
          </span>
        ) : null}
        <span
          className="text-zinc-100 text-[12px] font-medium truncate flex-1 min-w-0"
          title={row.title}
        >
          {row.title}
        </span>
        <StatusBadge status={status} accent={accent} />
      </div>

      {(row.chip_refs.length > 0 || (diff?.chip_changes?.length || 0) > 0) && (() => {
        // Build per-card change maps so the badges THEMSELVES reflect
        // the AI's proposed mutations:
        //   • existing chip + AI removes  → render strikethrough + faded
        //   • AI adds a new entity        → render new chip with "+"
        //   • existing chip + no change   → render normally
        //   • new POV character           → render with the POV diamond
        const removedIds = new Set()
        const addedRefs = []
        for (const c of (diff?.chip_changes || [])) {
          if (c.kind === 'remove') removedIds.add(c.entity_id)
          else if (c.kind === 'add') addedRefs.push(c)
        }
        const newPovId  = diff?.pov_change?.new_pov_entity_id || null
        const prevPovId = diff?.pov_change?.previous_pov_entity_id || null
        return (
          <div className="flex flex-wrap gap-1">
            {row.chip_refs.map((cr) => {
              const entity = entityById.get(cr.entity_id)
              if (!entity) return null
              const removed = removedIds.has(cr.entity_id)
              const isPov = cr.has_pov && cr.entity_id !== prevPovId  // keep current POV marker until/unless this scene gets a new POV
              const povSuffix = isPov && !removed
                ? <PovInlineBadge color={povColor} title="POV character at this scene" />
                : null
              return (
                <span
                  key={cr.entity_id}
                  className={`inline-flex items-center gap-0.5 ${removed ? 'opacity-40 line-through' : ''}`}
                  title={removed ? 'AI proposes removing this chip' : undefined}
                >
                  {removed && (
                    <span
                      className="text-[10px] leading-none text-red-400"
                      title="AI proposes removing this chip"
                    >
                      −
                    </span>
                  )}
                  <EntityLabelChip entity={entity} suffix={povSuffix} />
                </span>
              )
            })}
            {addedRefs.map((ar) => {
              const entity = entityById.get(ar.entity_id)
              if (!entity) return null
              const isNewPov = ar.entity_id === newPovId
              const povSuffix = isNewPov
                ? <PovInlineBadge color={povColor} title="AI proposes this as the new POV character" />
                : null
              return (
                <span
                  key={`add-${ar.entity_id}`}
                  className="inline-flex items-center gap-0.5"
                  title="AI proposes adding this chip"
                >
                  <span className="text-[10px] leading-none text-emerald-400" title="AI proposes adding this chip">
                    +
                  </span>
                  <EntityLabelChip entity={entity} suffix={povSuffix} />
                </span>
              )
            })}
            {/* POV reassignment to an entity ALREADY in the scene
                (no add, just POV move) — surface a small inline cue
                next to the new POV's existing chip. We can't visually
                modify a chip we already rendered above, so render a
                trailing badge instead. */}
            {newPovId && !addedRefs.some((ar) => ar.entity_id === newPovId)
              && row.chip_refs.some((cr) => cr.entity_id === newPovId) && (
              <span
                className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded border text-[9px] uppercase tracking-wide font-medium"
                style={{ color: povColor, borderColor: povColor + '99', backgroundColor: povColor + '18' }}
                title="AI proposes reassigning POV to this character"
              >
                POV → {diff?.pov_change?.new_pov_entity_name || '?'}
              </span>
            )}
          </div>
        )
      })()}

      {row.description_preview && (
        <p className="text-[11px] text-zinc-400 leading-snug line-clamp-3">
          {row.description_preview}
        </p>
      )}

      {diff && <DiffSummaryInline diff={diff} />}

      {canExpand && (
        <div className="mt-1 border-t border-zinc-800 pt-1">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-[10px] text-zinc-400 hover:text-zinc-100 underline-offset-2 hover:underline w-full text-left"
          >
            {expanded ? 'Hide' : 'Show'} AI verdict
          </button>
          {expanded && (
            <div className="mt-1 text-[10px] text-zinc-300 space-y-0.5">
              <div>
                <span className="text-zinc-500">POV: </span>
                {verdict.pov === null
                  ? <span className="text-amber-300 italic">declined (?*)</span>
                  : verdict.pov
                    ? <span className="text-amber-200">{verdict.pov}</span>
                    : <span className="text-zinc-500 italic">none</span>}
              </div>
              <div>
                <span className="text-zinc-500">Entities present: </span>
                {Array.isArray(verdict.entities_present) && verdict.entities_present.length > 0
                  ? <span className="text-zinc-200">{verdict.entities_present.join(', ')}</span>
                  : <span className="text-zinc-500 italic">none</span>}
              </div>
              {Array.isArray(verdict.warnings) && verdict.warnings.length > 0 && (
                <ul className="pl-3 list-disc text-amber-300 space-y-0.5">
                  {verdict.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}


/**
 * Reuses the chat panel's `.nn-streaming-coin` animation — a 1.4s
 * vertical-axis spin with a synchronised glow that brightens
 * face-on and dims edge-on. Drops into the Refine button while
 * /scene_wiring/refine is in flight so the writer has a clear
 * "AI is working" signal during chunk wait time.
 */
function RefiningCoin() {
  return (
    <span
      className="nn-streaming-coin"
      style={{ color: 'currentColor' }}
      aria-label="Refining"
      title="Waiting for the AI to return scene placements."
    >
      <svg viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    </span>
  )
}


/**
 * Inline POV marker injected into an `EntityLabelChip` via its
 * `suffix` prop so it sits INSIDE the chip's coloured border, not as
 * a separate sibling badge floating beside the chip.
 */
function PovInlineBadge({ color, title }) {
  return (
    <span
      className="ml-1 inline-flex items-center text-[8px] uppercase font-bold tracking-wide leading-none px-1 py-0.5 rounded"
      style={{ color, backgroundColor: color + '33' }}
      title={title}
    >
      POV
    </span>
  )
}


function StagedFooterButtons({
  running, applying, canRefine, cancelling, accent,
  totalSelected, actionableCount, hasRefinements,
  onRefine, onCancelRefine, onCancelImport, onBackToSettings, onApplyAndFinish,
}) {
  const busy = running || applying
  return (
    <>
      <button
        type="button"
        onClick={onCancelImport}
        disabled={busy}
        className="px-3 py-1.5 text-xs rounded border border-red-800/70 bg-red-950/40 text-red-200 hover:bg-red-900/50 disabled:opacity-40 disabled:cursor-not-allowed"
        title="Abandon the import. Project state stays exactly as it was before opening the dialog."
      >
        Cancel import
      </button>
      <button
        type="button"
        onClick={onBackToSettings}
        disabled={busy}
        className="px-3 py-1.5 text-xs rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed"
        title={hasRefinements
          ? 'Discard refinements and return to the import settings (confirms first).'
          : 'Return to the import settings.'}
      >
        Back to settings
      </button>
      <button
        type="button"
        onClick={onRefine}
        disabled={!canRefine}
        className={`px-3 py-1.5 text-xs rounded border border-accent-700 bg-accent-950/40 text-accent-200 inline-flex items-center gap-1 ${
          running
            ? 'nn-tool-active cursor-progress'
            : canRefine
              ? 'hover:bg-accent-900/50'
              : 'opacity-40 cursor-not-allowed'
        }`}
        style={running ? { '--tool-active-accent': _withAlpha(accent, 0.95) } : undefined}
      >
        {running && <RefiningCoin />}
        {running ? `Refining ${totalSelected}…` : `Refine ${totalSelected} scene${totalSelected === 1 ? '' : 's'}`}
      </button>
      {running && (
        <button
          type="button"
          onClick={onCancelRefine}
          disabled={cancelling}
          className="px-2.5 py-1.5 text-xs rounded border border-red-800/70 bg-red-950/40 text-red-200 hover:bg-red-900/50 disabled:opacity-40 disabled:cursor-not-allowed"
          title="Stop the AI request. Completed chunks' results are kept; the in-flight chunk's partial response is discarded."
        >
          {cancelling ? 'Cancelling…' : 'Cancel'}
        </button>
      )}
      <button
        type="button"
        onClick={onApplyAndFinish}
        disabled={busy}
        className="px-3 py-1.5 text-xs rounded border border-emerald-700 bg-emerald-950/40 text-emerald-200 hover:bg-emerald-900/50 disabled:opacity-40 disabled:cursor-not-allowed"
        title={actionableCount > 0
          ? `Apply ${actionableCount} pending refinement${actionableCount === 1 ? '' : 's'} and finish the import.`
          : 'Finish the import without applying any AI refinements.'}
      >
        {applying ? 'Finishing…' : actionableCount > 0
          ? `Apply ${actionableCount} & finish import`
          : 'Finish import without refinements'}
      </button>
    </>
  )
}


/**
 * Post-refinement summary banner. Renders after the first /refine call
 * completes so the writer sees a concrete read-out of what the model
 * did: how many scenes returned a parseable verdict, how many produced
 * actionable changes, how many were "no changes" (LLM looked but kept
 * the existing chip set + POV), how many POVs were declined, how many
 * chunks failed, plus any backend-side warnings.
 *
 * Distinct visual treatment per state so the writer can spot at-a-glance
 * whether the run was useful: green when there are actionable changes,
 * amber when only declines / warnings landed, neutral when the LLM
 * returned all-no-changes (i.e. it ran fine but agrees with the regex
 * pipeline's output), red when chunks failed.
 */
function RefinementSummary({ meta }) {
  const failed = meta.chunks_failed > 0
  const allNoChange = meta.actionable_count === 0 && meta.pov_declined === 0 && !failed
  const tone = failed
    ? 'border-red-900 bg-red-950/40 text-red-200'
    : meta.actionable_count > 0
      ? 'border-emerald-900 bg-emerald-950/40 text-emerald-200'
      : 'border-zinc-700 bg-zinc-900/60 text-zinc-300'
  return (
    <div className={`mt-2 rounded border ${tone} px-3 py-2 text-[11px]`}>
      <div className="font-medium text-zinc-100 mb-1">Last refinement result</div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-0.5">
        <div>
          <span className="text-zinc-500">Asked about: </span>
          <span className="text-zinc-100">{meta.scenes_requested}</span>
        </div>
        <div>
          <span className="text-zinc-500">AI returned: </span>
          <span className="text-zinc-100">{meta.scenes_resolved}</span>
        </div>
        <div>
          <span className="text-zinc-500">Chunks: </span>
          <span className="text-zinc-100">{meta.chunks_run}</span>
          {meta.chunks_failed > 0 && (
            <span className="text-red-300"> ({meta.chunks_failed} failed)</span>
          )}
        </div>
        <div>
          <span className="text-zinc-500">Scenes with changes: </span>
          <span className={meta.actionable_count > 0 ? 'text-emerald-300' : 'text-zinc-300'}>
            {meta.actionable_count}
          </span>
        </div>
        <div>
          <span className="text-zinc-500">No-change scenes: </span>
          <span className="text-zinc-100">{meta.no_change_count}</span>
        </div>
        <div>
          <span className="text-zinc-500">POV declined: </span>
          <span className={meta.pov_declined > 0 ? 'text-amber-300' : 'text-zinc-100'}>
            {meta.pov_declined}
          </span>
        </div>
      </div>
      {allNoChange && (
        <div className="mt-1 text-[10px] text-zinc-500 italic">
          The AI ran successfully but did not propose any changes. The regex-pipeline placement matches what the model would have set.
        </div>
      )}
      {meta.warnings.length > 0 && (
        <details className="mt-1.5">
          <summary className="text-[10px] cursor-pointer text-amber-300 hover:text-amber-200">
            {meta.warnings.length} warning{meta.warnings.length === 1 ? '' : 's'}
          </summary>
          <ul className="mt-1 pl-4 list-disc text-[10px] text-amber-200 space-y-0.5">
            {meta.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </details>
      )}
    </div>
  )
}


function StatusBadge({ status, accent }) {
  switch (status) {
    case 'queued':
      return (
        <span
          className="text-[9px] uppercase tracking-wide px-1 py-0.5 rounded bg-zinc-800/60 border border-zinc-700 text-zinc-400"
          title="Selected for this run. Waiting for the LLM to start this scene's chunk."
        >
          queued
        </span>
      )
    case 'refining':
      return (
        <span
          className="inline-flex items-center gap-1 text-[9px] uppercase tracking-wide px-1 py-0.5 rounded border font-semibold"
          style={{
            color: accent || '#a78bfa',
            borderColor: (accent || '#a78bfa') + '80',
            backgroundColor: (accent || '#a78bfa') + '22',
          }}
          title="The AI is currently producing this scene's verdict."
        >
          <span
            className="nn-streaming-coin"
            style={{ color: accent || '#a78bfa', width: '0.7em', height: '0.7em' }}
            aria-hidden="true"
          >
            <svg viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.6" />
            </svg>
          </span>
          refining
        </span>
      )
    case 'refined':
      return (
        <span className="text-[9px] uppercase tracking-wide px-1 py-0.5 rounded bg-emerald-950/60 border border-emerald-800 text-emerald-300">
          refined
        </span>
      )
    case 'no_change':
      return (
        <span
          className="text-[9px] uppercase tracking-wide px-1 py-0.5 rounded bg-zinc-800/60 border border-zinc-700 text-zinc-300"
          title="The AI returned a verdict but proposed no changes for this scene — current chip placement and POV match what the model would have set."
        >
          no changes
        </span>
      )
    case 'pov_declined':
      return (
        <span
          className="text-[9px] uppercase tracking-wide px-1 py-0.5 rounded bg-amber-950/60 border border-amber-800 text-amber-300"
          title="The AI explicitly declined to set a POV character (returned the `?*` decline token). Existing POV is preserved."
        >
          POV declined
        </span>
      )
    case 'failed':
      return (
        <span className="text-[9px] uppercase tracking-wide px-1 py-0.5 rounded bg-red-950/60 border border-red-800 text-red-300">
          failed
        </span>
      )
    default:
      return null
  }
}


function DiffSummaryInline({ diff }) {
  if (!diff) return null
  const adds   = diff.chip_changes.filter((c) => c.kind === 'add')
  const removes = diff.chip_changes.filter((c) => c.kind === 'remove')
  const parts = []
  for (const a of adds)     parts.push(<span key={`add-${a.entity_id}`}    className="text-emerald-400">+{a.entity_name}</span>)
  for (const r of removes)  parts.push(<span key={`rem-${r.entity_id}`}    className="text-red-400">−{r.entity_name}</span>)
  if (diff.pov_change?.new_pov_entity_name) {
    parts.push(<span key="pov" className="text-amber-300">POV→{diff.pov_change.new_pov_entity_name}</span>)
  }
  if (parts.length === 0) return null
  return (
    <span className="text-[10px] flex items-center gap-1 ml-2 overflow-hidden">
      {parts.map((p, i) => (
        <span key={i} className="flex items-center">
          {i > 0 && <span className="text-zinc-700 mx-0.5">·</span>}
          {p}
        </span>
      ))}
    </span>
  )
}
