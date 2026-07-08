/**
 * ExportDialog — Phase 1.25a — Preset-first restructure.
 *
 * Modal picker for HTML / Markdown / PDF / TXT / DOCX narrative export.
 * The writer first picks a PRESET (their intent — NarrativeNode native,
 * Shunn manuscript, NovelCrafter format, or Customize), then picks a
 * FORMAT from those the preset supports. Customize is the only preset
 * that exposes the granular toggle pane; the others are fixed bundles
 * with a description that explains exactly what they produce.
 *
 * Layout:
 *   PRESET     — vertical list on the left + description pane on the
 *                right. Each preset entry's description names the
 *                supported formats. Selected preset gets a left-edge
 *                accent bar.
 *   FORMAT     — radio group, gated by `preset.supportedFormats`.
 *                Auto-resets to the preset's `defaultFormat` when the
 *                preset changes if the current format isn't supported.
 *   PAGE SIZE  — A4 / Letter, shown only when the current format
 *                declares the `pagination` capability.
 *   SCOPE      — Whole story vs Selected scenes (with the existing
 *                entity-state-boundary radio). Always-visible because
 *                it's orthogonal to the preset's content choice.
 *   CUSTOMIZE  — toggle pane with all the granular per-block toggles.
 *                Visible only when `preset === 'customize'`.
 *
 * Persistence: dialog reads `/api/settings` on open and seeds the
 * preset / format / Customize toggle pane from `export_last_preset`
 * / `export_last_format` / `export_customize_toggles`. The
 * "Save as default" button in the footer PUTs the current state
 * back into `/api/settings`. The button is the ONLY path that
 * persists — Export click does not silently update preferences.
 *
 * Preset metadata + per-preset bundles live in
 * `frontend/src/utils/exportPresets.js`. Slug resolution
 * (`(format, preset)` → renderer slug for the existing
 * `/api/project/export/{slug}` endpoint) lives in
 * `frontend/src/utils/exportSlugResolution.js`.
 */

import { useEffect, useRef, useState } from 'react'
import { useUiStore } from '../../store/uiStore'
import { useProjectStore } from '../../store/projectStore'
import ExportDialogScopeTree from './ExportDialogScopeTree'
import {
  PRESETS,
  PRESET_ORDER,
  getPresetBundle,
} from '../../utils/exportPresets'
import { resolveSlug } from '../../utils/exportSlugResolution'
import { computeStoryOrder } from '../../utils/storyOrder'
import { storyLayoutArgs } from '../../utils/rowLayout'
import { computePovChain } from '../../utils/povSequence'
import { resolveChapterIdForNodeForStory } from '../../utils/chapterMembership'
import {
  formatTimeOfDay,
  formatDate,
  formatSeason,
  formatSceneDuration,
  formatGapExtension,
} from '../../utils/scenetimeVerbiage'
import { getTimeOfDaySvg, getSeasonSvg } from '../../utils/exportSceneTimeIcons.jsx'

// Group toggles by the visual section they belong to in the Customize body.
const TOGGLE_GROUPS = [
  {
    id: 'header',
    label: 'Header',
    items: [
      { key: 'include_cover_image',            label: 'Cover image (first page)' },
      { key: 'include_author',                 label: 'Author' },
      { key: 'include_genre',                  label: 'Genre' },
      { key: 'include_story_description',       label: 'Story description' },
      { key: 'include_tags',                   label: 'Tags' },
      { key: 'include_generated_timestamp',    label: 'Generated timestamp' },
      { key: 'include_tense',                  label: 'Tense' },
      { key: 'include_pov_type',               label: 'POV style' },
      { key: 'include_language',               label: 'Language' },
      { key: 'include_default_pov_character',  label: 'Default POV character' },
    ],
  },
  {
    id: 'structure',
    label: 'Structure',
    items: [
      { key: 'include_act_headings',           label: 'Act headings' },
      { key: 'include_chapter_headings',       label: 'Chapter headings' },
      { key: 'include_unchaptered_heading',    label: 'Unchaptered section heading' },
      { key: 'include_scene_separator',        label: 'Scene break separator  (between scenes in the same chapter)' },
    ],
  },
  {
    id: 'scene',
    label: 'Per-scene',
    items: [
      { key: 'include_transition_text',        label: 'Transition text' },
      { key: 'include_scene_title',            label: 'Scene title' },
      { key: 'include_scene_description',      label: 'Scene description' },
      { key: 'include_scene_pov_line',         label: 'POV line' },
      { key: 'include_entity_context_line',    label: 'Entity context line' },
      { key: 'include_scene_body',             label: 'Scene body' },
      { key: 'include_scene_changes_block',    label: 'Changes block', isParent: true },
      { key: 'include_metadata_changes',       label: 'Metadata changes  (names / colours / descriptions / images)', dependsOn: 'include_scene_changes_block' },
      { key: 'include_attribute_changes',      label: 'Attribute changes  (add / modify / remove)',                   dependsOn: 'include_scene_changes_block' },
      { key: 'include_relationship_changes',   label: 'Relationship changes  (add / modify / remove)',                 dependsOn: 'include_scene_changes_block' },
      { key: 'include_alias_changes',          label: 'Alias changes',                                                 dependsOn: 'include_scene_changes_block' },
      { key: 'include_awareness_changes',      label: 'Awareness changes',                                             dependsOn: 'include_scene_changes_block' },
      { key: 'include_scene_cm_block',         label: 'Circumstances & motivators block' },
      { key: 'include_scene_time',             label: 'Scene time line  (date / weekday / time of day / season / duration / gap)' },
    ],
  },
  {
    id: 'appendices',
    label: 'Appendices',
    items: [
      { key: 'include_offscreen_appendix',     label: 'Off-screen scenes' },
      { key: 'include_entity_sheets',          label: 'Entity reference sheets', isParent: true },
      { key: 'embed_assets',                   label: 'Embed asset images in sheets', dependsOn: 'include_entity_sheets' },
      { key: 'include_entity_notes',           label: 'Notes section',                dependsOn: 'include_entity_sheets' },
      { key: 'include_knowledge_section',         label: 'Knowledge appendix',                                isParent: true },
      { key: 'include_knowledge_chain_history',   label: 'Knowledge chain history',  dependsOn: 'include_knowledge_section' },
    ],
  },
  {
    id: 'media',
    label: 'Media attributes',
    items: [
      { key: 'include_media_attributes',          label: 'Embed media-type attributes inline',                    isParent: true },
      { key: 'include_media_attribute_images',    label: 'Images  (png / jpg / gif / webp / svg)',                dependsOn: 'include_media_attributes' },
      { key: 'include_media_attribute_audio',     label: 'Audio  (mp3 / wav / ogg / m4a)',                         dependsOn: 'include_media_attributes' },
      { key: 'include_media_attribute_video',     label: 'Video  (mp4 / webm / mov)',                              dependsOn: 'include_media_attributes' },
    ],
  },
  {
    id: 'appearance',
    label: 'Appearance',
    items: [
      { key: 'use_entity_colours',                label: 'Use per-entity colours for entity mentions & sheets' },
      { key: 'render_markdown_in_text_fields',    label: 'Render markdown in text fields  (descriptions, attributes, notes)' },
    ],
  },
]

// ── Renderer capability tags ──────────────────────────────────────────
//
// Map from individual toggle keys → the renderer capability tag that
// gates them. Toggles whose required capability isn't declared by the
// currently-selected format are hidden entirely (not greyed — they're
// conceptually meaningless for that format).
//
// Capability tags are the same set declared in
// `backend/services/renderers/registry.py` KNOWN_CAPABILITIES and
// documented in `docs/export-renderer-guide.md`. Keep this map in
// sync with the catalogue in the guide.
//
// Toggles not present in this map are universal — always visible for
// any format (header metadata, structure, per-scene elements, scene
// changes granularity, appendices that every renderer handles).
const OPTION_CAPABILITIES = {
  embed_assets:                     'embedded_assets',
  include_cover_image:              'embedded_assets',
  include_media_attributes:         'embedded_media',
  include_media_attribute_images:   'embedded_media',
  include_media_attribute_audio:    'embedded_media',
  include_media_attribute_video:    'embedded_media',
  use_entity_colours:               'entity_colours',
}

function toggleVisibleFor(key, capabilities) {
  const required = OPTION_CAPABILITIES[key]
  if (!required) return true
  return capabilities.has(required)
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Trigger a browser download of the blob returned by the export endpoint. */
async function triggerExportDownload(slug, options) {
  const response = await fetch(`/api/project/export/${slug}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  })
  if (!response.ok) {
    let detail = 'Export failed.'
    try {
      const data = await response.json()
      if (data?.detail) detail = `Export failed: ${data.detail}`
    } catch {
      // Swallow — we still raise below with the default message.
    }
    throw new Error(detail)
  }
  const blob = await response.blob()
  const cd = response.headers.get('content-disposition') || ''
  const filenameMatch = /filename="([^"]+)"/.exec(cd)
  const filename = filenameMatch ? filenameMatch[1] : `story.${slug}`
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// Built-in fallback when no preference is saved and no preset bundle
// applies (e.g. Customize mode on first open). Mirrors backend
// `ExportOptions` defaults — every toggle on, off-screen + entity
// sheets off (writer's-working-copy posture without the appendices
// noise).
const CUSTOMIZE_FIRST_OPEN_DEFAULTS = {
  include_cover_image: true,
  render_markdown_in_text_fields: true,
  include_scene_separator: true,
  include_author: true,
  include_genre: true,
  include_story_description: true,
  include_tags: true,
  include_tense: true,
  include_pov_type: true,
  include_language: true,
  include_default_pov_character: true,
  include_generated_timestamp: true,
  include_act_headings: true,
  include_chapter_headings: true,
  include_unchaptered_heading: true,
  include_transition_text: true,
  include_scene_title: true,
  // Phase 3.11 — defaults to OFF so a fresh dialog produces a
  // prose-only manuscript by default (mirrors the backend
  // `ExportOptions.include_scene_description = False` default).
  // Writers can tick it on to also include the scene description
  // (writer-facing summary) alongside the prose body.
  include_scene_description: false,
  include_scene_pov_line: true,
  include_entity_context_line: true,
  include_scene_body: true,
  include_scene_changes_block: true,
  include_scene_cm_block: true,
  include_metadata_changes: true,
  include_attribute_changes: true,
  include_relationship_changes: true,
  include_alias_changes: true,
  include_awareness_changes: true,
  include_offscreen_appendix: false,
  include_entity_sheets: false,
  include_entity_notes: true,
  include_knowledge_section: true,
  include_knowledge_chain_history: false,
  include_scene_time: true,
  include_media_attributes: true,
  include_media_attribute_images: true,
  include_media_attribute_audio: false,
  include_media_attribute_video: false,
  embed_assets: true,
  use_entity_colours: false,
  entity_context_mode: 'minimal',
}

// ── Component ──────────────────────────────────────────────────────────

export default function ExportDialog() {
  const open = useUiStore((s) => s.exportDialogOpen)
  const close = useUiStore((s) => s.closeExportDialog)

  // Preset selection. One of 'native' / 'shunn' / 'novelcrafter' /
  // 'customize'. Drives both the format-picker filter and the
  // visibility of the Customize toggle pane.
  const [preset, setPreset] = useState('native')
  // Selected file format (one of 'docx' / 'pdf' / 'markdown' / 'html'
  // / 'txt'). Constrained at change-time to the preset's
  // `supportedFormats`; auto-bumps when the preset switches and the
  // current format becomes unsupported.
  const [format, setFormat] = useState('pdf')
  // Toggle state. For non-Customize presets this is the preset's
  // bundle (read-only — the toggle pane is hidden). For Customize
  // it's the writer's editable state.
  const [options, setOptions] = useState(CUSTOMIZE_FIRST_OPEN_DEFAULTS)
  // Page size is orthogonal to the preset / options system — it only
  // affects paginated formats (pdf / docx). Stored separately so
  // flipping A4 / Letter doesn't change the preset.
  const [pageSize, setPageSize] = useState('a4')
  // Scope selector. Always-visible regardless of preset because the
  // scope choice is orthogonal to the preset's content / layout
  // choice — a writer might want a Shunn manuscript of just chapters
  // 1-3 (selected), or a Native export of just the POV-path scenes
  // (pov_only). Three modes:
  //   - 'whole'    — every scene in Story Order (Full mode)
  //   - 'pov_only' — POV-path scenes only, in narrative order
  //                  (Publication mode); the reader-facing manuscript
  //   - 'selected' — only the scenes the writer ticked in the tree
  // `selectedSceneIds` is the Set the ScopeTree owns; only consulted
  // when scopeMode === 'selected'. `entityStateBoundary` is 'origin'
  // (full-story start) or 'scope' (walked-forward state at the
  // moment before the earliest exported scene); only meaningful when
  // scopeMode === 'selected'.
  const [scopeMode, setScopeMode] = useState('whole')
  const [selectedSceneIds, setSelectedSceneIds] = useState(() => new Set())
  const [entityStateBoundary, setEntityStateBoundary] = useState('origin')
  const [exporting, setExporting] = useState(false)
  const [savingDefault, setSavingDefault] = useState(false)
  const [error, setError] = useState(null)
  const [statusMessage, setStatusMessage] = useState(null)
  const [collapsedGroups, setCollapsedGroups] = useState({})
  // Raw format catalogue from the backend /formats endpoint. Used to
  // build the per-format capability map below.
  const [formatsList, setFormatsList] = useState([])
  // Map of format_id → Set of capability tags, derived from formatsList.
  const [formatCapabilities, setFormatCapabilities] = useState({})

  const presetInfo = PRESETS[preset] || PRESETS.native
  // Capability set for the renderer that will run if the user clicks
  // Export now — derived from the resolved slug for the (format,
  // preset) pair, not just the bare format. This makes capability
  // gating work for variant slugs (e.g. `docx-novelcrafter` may
  // declare different capabilities than `docx`).
  const currentSlug = resolveSlug(format, preset)
  const currentCapabilities = formatCapabilities[currentSlug] || formatCapabilities[format] || new Set()
  const showPageSize = currentCapabilities.has('pagination')

  const panelRef = useRef(null)

  // Reset state on open + load user preferences + fetch formats.
  useEffect(() => {
    if (!open) return undefined

    setError(null)
    setStatusMessage(null)
    setCollapsedGroups({})
    // scopeMode is seeded from the resolved preset's defaultScope
    // below in the /api/settings load path (or falls back to Native's
    // 'whole' when nothing is saved).
    setSelectedSceneIds(new Set())
    setEntityStateBoundary('origin')

    let cancelled = false

    // Fetch user preferences first; seed the preset / format /
    // Customize toggle state from saved values, falling back to
    // Native if nothing is saved. Failures fall through to
    // Native silently — the dialog stays usable.
    fetch('/api/settings')
      .then((res) => (res.ok ? res.json() : null))
      .then((prefs) => {
        if (cancelled) return
        const savedPreset = prefs?.export_last_preset
        const savedFormat = prefs?.export_last_format
        const savedToggles = prefs?.export_customize_toggles

        const initialPreset = (savedPreset && PRESETS[savedPreset]) ? savedPreset : 'native'
        const presetSpec = PRESETS[initialPreset]

        // Validate the saved format against the preset's supported
        // list — if a writer saved Shunn+DOCX then later turned off
        // a preset, the saved format may no longer apply.
        const initialFormat = (savedFormat && presetSpec.supportedFormats.includes(savedFormat))
          ? savedFormat
          : presetSpec.defaultFormat

        setPreset(initialPreset)
        setFormat(initialFormat)
        setPageSize('a4')
        setScopeMode(presetSpec.defaultScope || 'whole')

        // Toggle state seeding rule:
        //   - Customize preset + saved customize_toggles → use saved
        //   - Customize preset + no saved toggles → first-open defaults
        //   - Non-customize preset → preset's bundle
        if (initialPreset === 'customize') {
          setOptions(savedToggles && typeof savedToggles === 'object'
            ? { ...CUSTOMIZE_FIRST_OPEN_DEFAULTS, ...savedToggles }
            : CUSTOMIZE_FIRST_OPEN_DEFAULTS)
        } else {
          setOptions(getPresetBundle(initialPreset))
        }
      })
      .catch(() => {
        // Silent fall-through: dialog opens with Native + PDF +
        // native bundle. Failure usually means the backend is down,
        // in which case the export itself will also fail; let the
        // user see the dialog so they get a clear "export failed"
        // instead of a stuck spinner.
        if (cancelled) return
        setPreset('native')
        setFormat('pdf')
        setOptions(getPresetBundle('native'))
        setScopeMode(PRESETS.native.defaultScope || 'whole')
      })

    // Fetch the renderer catalogue. The capability map is keyed by
    // `format_id` (the slug) so e.g. `docx-novelcrafter` and `docx`
    // can declare different capability sets.
    fetch('/api/project/export/formats')
      .then((res) => (res.ok ? res.json() : []))
      .then((list) => {
        if (cancelled || !Array.isArray(list)) return
        setFormatsList(list)
        const capsMap = {}
        for (const entry of list) {
          capsMap[entry.format_id] = new Set(entry.capabilities || [])
        }
        setFormatCapabilities(capsMap)
      })
      .catch(() => { /* silent */ })

    return () => { cancelled = true }
  }, [open])

  // The entity-state-boundary radio is only meaningful in 'selected'
  // mode (where there's a defined "earliest exported scene" to walk
  // forward to). For 'whole' and 'pov_only' the boundary is the
  // entity's origin always — force back to 'origin' so the payload
  // matches the disabled-radio UI state.
  useEffect(() => {
    if (scopeMode !== 'selected' && entityStateBoundary !== 'origin') {
      setEntityStateBoundary('origin')
    }
  }, [scopeMode, entityStateBoundary])

  // Close on outside click and on Escape.
  useEffect(() => {
    if (!open) return undefined
    function onPointer(e) {
      if (panelRef.current && !panelRef.current.contains(e.target)) close()
    }
    function onKey(e) {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close])

  // Preset switch handler. Applies the new preset's bundle to the
  // toggle state (or leaves the toggles alone for Customize), and
  // bumps the format if the new preset doesn't support the current
  // format choice.
  function selectPreset(nextPreset) {
    if (nextPreset === preset) return
    setPreset(nextPreset)
    const spec = PRESETS[nextPreset]
    if (!spec) return
    if (!spec.supportedFormats.includes(format)) {
      setFormat(spec.defaultFormat)
    }
    // Apply preset's bundle for non-Customize. Customize keeps the
    // existing toggle state so a writer who picked Customize, tweaked
    // toggles, then bounced to Native and back doesn't lose their work.
    if (nextPreset !== 'customize') {
      setOptions(getPresetBundle(nextPreset))
    }
    // Phase 3.11 — when switching INTO the NC preset with the
    // Customize state carrying both depth flags on (only possible
    // in the Customize path, since non-Customize presets get their
    // bundle overwritten above), collapse to prose so the writer's
    // pick respects NC's one-or-the-other constraint immediately.
    // The backend renderer also enforces this at render time; the
    // dialog flip makes the constraint visible up-front.
    if (nextPreset === 'novelcrafter') {
      setOptions((prev) => {
        if (prev.include_scene_description && prev.include_scene_body) {
          return { ...prev, include_scene_description: false }
        }
        return prev
      })
    }
    // Auto-bump scope to the preset's default scope. Don't clobber
    // 'selected' — if the writer carefully ticked specific scenes
    // and then switches preset, they probably still want those
    // scenes; only switch when the current scope is the OTHER
    // preset-shaped option (whole / pov_only).
    if (scopeMode !== 'selected') {
      setScopeMode(spec.defaultScope || 'whole')
    }
    // Clear any stale "saved as default" message — the writer is
    // making a new selection now.
    setStatusMessage(null)
  }

  function toggleOption(key) {
    setOptions((prev) => {
      const next = { ...prev, [key]: !prev[key] }
      // Phase 3.11 — Novelcrafter's importer ingests EITHER prose OR
      // summaries, not both at once. When the NC preset is active and
      // the writer ticks one of the two per-scene depth flags, the
      // other auto-unticks so the dialog reflects the constraint
      // before they click Export. The backend renderer also enforces
      // one-or-the-other (both-on collapses to prose), but this UX
      // hint makes the constraint visible up-front. The gate is on
      // `preset === 'novelcrafter'` because the Format radio holds the
      // family slug (`markdown` / `docx`); the NC variant is selected
      // via the preset row above the format radio.
      const isNcPreset = preset === 'novelcrafter'
      if (isNcPreset && next[key] && (key === 'include_scene_description' || key === 'include_scene_body')) {
        const other = key === 'include_scene_description'
          ? 'include_scene_body'
          : 'include_scene_description'
        next[other] = false
      }
      return next
    })
    setStatusMessage(null)
  }

  async function handleExport(slugOverride) {
    setExporting(true)
    setError(null)
    setStatusMessage(null)
    try {
      // Phase 1.25b — `export_mode` is derived from the scope choice:
      //   - 'pov_only' → 'publication' (POV-only narrative manuscript)
      //   - 'whole' / 'selected' → 'full' (the difference is which
      //     scene id list is sent, not whether off-screen content is
      //     filtered out)
      const exportMode = scopeMode === 'pov_only' ? 'publication' : 'full'
      const payload = {
        ...options,
        page_size: pageSize,
        preset_key: preset,
        export_mode: exportMode,
      }
      if (scopeMode === 'selected') {
        payload.scope_scene_ids = Array.from(selectedSceneIds)
      } else {
        payload.scope_scene_ids = null
      }
      payload.entity_state_boundary = entityStateBoundary
      // Phase 1.25b — pre-compute the canonical scene order on the
      // frontend and ship it. Backend uses the list as the main-
      // narrative sequence instead of the legacy POV-wire walker.
      // POV-only filters to scenes that participate in the POV chain
      // (the writer's intended reader-facing manuscript); Whole and
      // Selected include every scene in Story Order (selected mode
      // additionally restricts via scope_scene_ids).
      const orderResult = computePreComputedOrder(scopeMode)
      payload.pre_computed_order = orderResult.sceneOrder
      payload.pov_path_scene_ids = orderResult.povPathSceneIds
      // Phase 4.3 — ship the mode-aware scene id → chapter id map so the
      // export's chapter sectioning matches the canvas in multi-row
      // (the backend only carries the single-row resolver).
      payload.pre_computed_chapter_ids = computePreComputedChapterIds()
      // Phase 1.25c — pre-compute scene-time text + season / time-of-
      // day icon SVGs per scene. Backend slots into ExportScene fields
      // verbatim. Skip the work entirely when the toggle is off.
      if (options.include_scene_time) {
        payload.pre_computed_scene_times = computePreComputedSceneTimes()
      } else {
        payload.pre_computed_scene_times = null
      }
      // Phase 3.11 — Novelcrafter download-variant slugs (story /
      // codex / bundle) are dispatched by the three-button footer
      // bar via `slugOverride`. When no override is given, fall
      // back to the normal `resolveSlug(format, preset)` path.
      const slug = slugOverride || resolveSlug(format, preset)
      await triggerExportDownload(slug, payload)
      close()
    } catch (e) {
      setError(e?.message || 'Export failed.')
    } finally {
      setExporting(false)
    }
  }

  // Compute the scene-id sequence to ship as `pre_computed_order`,
  // plus the POV-path membership set to ship as `pov_path_scene_ids`.
  // Reads from `useProjectStore` at submit time (no subscription —
  // the dialog doesn't need to re-render when nodes / edges change
  // mid-export-config).
  //
  // Returns `{ sceneOrder, povPathSceneIds }`:
  //   - `sceneOrder` — list of scene ids in canonical narrative
  //     sequence. POV-only scope = POV-filtered Story Order;
  //     Whole / Selected = every scene in Story Order (Selected
  //     also restricts via `scope_scene_ids` server-side).
  //   - `povPathSceneIds` — list of scene ids that are on the POV
  //     chain (i.e. reader-facing). Backend uses this to set
  //     `is_on_pov_path` on each `ExportScene` so renderers can
  //     flag off-screen content distinctly in Whole / Selected
  //     exports. In POV-only scope this list equals `sceneOrder`.
  function computePreComputedOrder(scopeModeArg) {
    const state = useProjectStore.getState()
    const nodes = state.nodes || []
    const edges = state.edges || []
    const story = state.story || {}
    const chapters = story.chapters || []
    const chapterXOffset = story.chapter_x_offset != null ? story.chapter_x_offset : 10
    // POV chain is a Tier 1 input to Story Order. We always compute
    // it here regardless of export_mode: Full needs it for ordering,
    // Publication needs it both for ordering AND as the membership
    // set to filter against.
    const povChain = computePovChain(nodes, edges)
    // Story Order returns ALL chain-participating node ids in
    // narrative order (scenes + modifier nodes + relationship origin
    // nodes + etc.). For the export's main-narrative sequence we
    // only care about scene nodes — the rest sit on the chain but
    // aren't reader-facing as a sequence position.
    // computeStoryOrder returns `{ orderedIds, indexById, tierById, ... }`
    // — an object, not a bare array. Pull the list out.
    const storyOrderResult = computeStoryOrder({ nodes, edges, povChain, chapters, chapterXOffset, ...storyLayoutArgs(story) })
    const orderedIds = (storyOrderResult && storyOrderResult.orderedIds) || []
    const sceneSet = new Set(
      nodes.filter((n) => n.type === 'sceneNode').map((n) => n.id)
    )
    const sceneOrderFull = orderedIds.filter((id) => sceneSet.has(id))
    const povPathSceneIds = sceneOrderFull.filter((id) => povChain.reachable.has(id))
    const sceneOrder = scopeModeArg === 'pov_only' ? povPathSceneIds : sceneOrderFull
    return { sceneOrder, povPathSceneIds }
  }

  // Phase 4.3 — pre-compute the scene id → chapter id map, resolved
  // mode-aware (single-row x-only or multi-row 2D row band) from the
  // live story. Backend's `_add_chapter_sections` prefers this map so
  // chapter sectioning matches the canvas in both layout modes; the
  // backend only carries the single-row resolver. Scenes with no
  // chapter are omitted (treated as unchaptered server-side). Reads
  // from `useProjectStore` at submit time, same pattern as
  // `computePreComputedOrder`.
  function computePreComputedChapterIds() {
    const state = useProjectStore.getState()
    const nodes = state.nodes || []
    const story = state.story || {}
    const map = {}
    for (const n of nodes) {
      if (n.type !== 'sceneNode') continue
      const cid = resolveChapterIdForNodeForStory(n, story)
      if (cid) map[n.id] = cid
    }
    return map
  }

  // Phase 1.25c — pre-compute the per-scene scene-time payload that
  // backend renderers slot into each ExportScene. Returns a map keyed
  // by scene id; each entry is `{text, season_svg, tod_svg}` (all
  // strings; empty when the scene carries no data for that field).
  // Reads from `useProjectStore` at submit time, same pattern as
  // `computePreComputedOrder`.
  function computePreComputedSceneTimes() {
    const state = useProjectStore.getState()
    const nodes = state.nodes || []
    const story = state.story || {}
    const timeFormat = story.time_format || '12h'
    const out = {}
    for (const n of nodes) {
      if (n.type !== 'sceneNode') continue
      const data = n.data || {}
      // The scene-time formatters expect a scene-shaped object — the
      // fields they read are flat on `node.data` (mirrors the SceneNode
      // model). Pass `data` directly.
      const opts = { timeFormat }
      const bits = []
      const dateStr = formatDate(data, 'value', opts)
      if (dateStr) bits.push(dateStr)
      const todStr = formatTimeOfDay(data, 'value', opts)
      if (todStr) bits.push(todStr)
      const seasonStr = formatSeason(data, 'value', opts)
      if (seasonStr) bits.push(seasonStr)
      const durationStr = data.scene_duration
        ? formatSceneDuration(data.scene_duration, 'value', opts)
        : null
      if (durationStr) bits.push(`(${durationStr})`)
      const gapStr = data.gap_extension
        ? formatGapExtension(data.gap_extension, 'value', opts)
        : null
      if (gapStr) bits.push(`+${gapStr}`)
      const text = bits.join(' · ')
      // Icons — only emit when the underlying tier value is set.
      const todLabel = data.time_of_day_tier === 'labelled' ? data.time_of_day_labelled : null
      const seasonIdx = typeof data.season === 'number' ? data.season : null
      const tod_svg = todLabel ? getTimeOfDaySvg(todLabel) : ''
      const season_svg = seasonIdx !== null ? getSeasonSvg(seasonIdx) : ''
      // Skip the entry entirely when there's nothing to ship.
      if (!text && !tod_svg && !season_svg) continue
      out[n.id] = { text: text || '', season_svg, tod_svg }
    }
    return out
  }

  async function handleSaveAsDefault() {
    setSavingDefault(true)
    setError(null)
    setStatusMessage(null)
    try {
      // Read current preferences, merge in the export-related fields,
      // and PUT the merged shape back. The PUT endpoint replaces the
      // entire preferences payload; merging client-side preserves
      // every other field the writer has set.
      const current = await fetch('/api/settings').then((res) => (res.ok ? res.json() : {}))
      const next = {
        ...(current || {}),
        export_last_preset: preset,
        export_last_format: format,
        // Only persist the toggle state when the writer is in
        // Customize mode — for other presets the toggle state is
        // the preset's bundle and persisting it would freeze the
        // writer to the bundle's current shape. Set to null for
        // non-Customize presets so the field reflects "use the
        // current bundle" semantics.
        export_customize_toggles: preset === 'customize' ? options : null,
      }
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      })
      if (!res.ok) throw new Error('Could not save defaults.')
      setStatusMessage('Saved.')
    } catch (e) {
      setError(e?.message || 'Could not save defaults.')
    } finally {
      setSavingDefault(false)
    }
  }

  if (!open) return null

  // Format catalogue lookup — used only to render the format radio
  // labels. Formats not in the catalogue still render with their key
  // as fallback label so the UI degrades gracefully when the
  // /formats fetch fails.
  function formatLabel(formatKey) {
    const entry = formatsList.find((f) => f.format_id === formatKey)
    return entry?.label || FORMAT_FALLBACK_LABELS[formatKey] || formatKey.toUpperCase()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div
        ref={panelRef}
        data-help-region="export-dialog:modal"
        className="bg-zinc-800 border border-zinc-600 rounded-lg shadow-2xl w-[680px] max-h-[85vh] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700 flex-shrink-0">
          <h2 className="text-sm font-semibold text-zinc-100">Export Story</h2>
          <button onClick={close} className="text-zinc-400 hover:text-zinc-200 text-base leading-none">✕</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-5">

          {/* PRESET — list-left + description-right */}
          <section data-help-region="export-dialog:preset">
            <h3 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider mb-2">Preset</h3>
            <div className="flex border border-zinc-700 rounded overflow-hidden">
              <div className="w-[160px] bg-zinc-900/40 flex flex-col flex-shrink-0">
                {PRESET_ORDER.map((key) => {
                  const spec = PRESETS[key]
                  const selected = preset === key
                  return (
                    <button
                      key={key}
                      type="button"
                      data-help-region={`export-dialog:preset_${key}`}
                      onClick={() => selectPreset(key)}
                      className={`text-left px-3 py-2 text-xs border-l-2 transition-colors ${
                        selected
                          ? 'border-l-accent-500 bg-zinc-700/50 text-zinc-100 font-semibold'
                          : 'border-l-transparent text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'
                      }`}
                    >
                      {spec.label}
                    </button>
                  )
                })}
              </div>
              <div className="flex-1 px-3 py-2.5 bg-zinc-800/40">
                <div className="text-sm font-semibold text-zinc-100 mb-1">{presetInfo.label}</div>
                <p className="text-[11px] text-zinc-300 leading-snug whitespace-pre-line">
                  {presetInfo.description}
                </p>
                <div className="text-[10px] text-zinc-500 mt-2">
                  Available formats: {presetInfo.supportedFormats.map((f) => formatLabel(f)).join(', ')}
                </div>
              </div>
            </div>
          </section>

          {/* FORMAT — gated by preset.supportedFormats */}
          <section data-help-region="export-dialog:format">
            <h3 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider mb-2">Format</h3>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {presetInfo.supportedFormats.map((fkey) => (
                <label key={fkey} data-help-region={`export-dialog:format_${fkey}`} className="flex items-center gap-2 text-sm text-zinc-200 cursor-pointer">
                  <input
                    type="radio"
                    checked={format === fkey}
                    onChange={() => setFormat(fkey)}
                    className="accent-accent-500"
                  />
                  {formatLabel(fkey)}
                </label>
              ))}
            </div>
            {preset === 'novelcrafter' && (
              <p className="text-[10px] text-zinc-500 mt-1.5 italic">
                Novelcrafter's importer ingests either prose or summaries — not both. Pick one in the per-scene options below; the file is suffixed -Prose or -Summaries.
              </p>
            )}
          </section>

          {/* PAGE SIZE — only shown for paginated formats */}
          {showPageSize && (
            <section data-help-region="export-dialog:page_size">
              <h3 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider mb-2">Page size</h3>
              <div className="flex items-center gap-4">
                <label data-help-region="export-dialog:page_size_a4" className="flex items-center gap-2 text-sm text-zinc-200 cursor-pointer">
                  <input
                    type="radio"
                    checked={pageSize === 'a4'}
                    onChange={() => setPageSize('a4')}
                    className="accent-accent-500"
                  />
                  A4  <span className="text-[10px] text-zinc-500">210 × 297 mm</span>
                </label>
                <label data-help-region="export-dialog:page_size_letter" className="flex items-center gap-2 text-sm text-zinc-200 cursor-pointer">
                  <input
                    type="radio"
                    checked={pageSize === 'letter'}
                    onChange={() => setPageSize('letter')}
                    className="accent-accent-500"
                  />
                  Letter  <span className="text-[10px] text-zinc-500">8½ × 11 in</span>
                </label>
              </div>
            </section>
          )}

          {/* SCOPE — Track 9 — limit the export to specific scenes */}
          <section data-help-region="export-dialog:scope">
            <h3 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider mb-2">Scope</h3>
            <div className="space-y-1.5">
              <label data-help-region="export-dialog:scope_whole" className="flex items-center gap-2 text-sm text-zinc-200 cursor-pointer">
                <input
                  type="radio"
                  checked={scopeMode === 'whole'}
                  onChange={() => setScopeMode('whole')}
                  className="accent-accent-500"
                />
                Whole story  <span className="text-[10px] text-zinc-500">every scene in Story Order</span>
              </label>
              <label data-help-region="export-dialog:scope_pov_only" className="flex items-center gap-2 text-sm text-zinc-200 cursor-pointer">
                <input
                  type="radio"
                  checked={scopeMode === 'pov_only'}
                  onChange={() => setScopeMode('pov_only')}
                  className="accent-accent-500"
                />
                POV only  <span className="text-[10px] text-zinc-500">reader-facing manuscript; off-screen scenes excluded</span>
              </label>
              <label data-help-region="export-dialog:scope_selected" className="flex items-center gap-2 text-sm text-zinc-200 cursor-pointer">
                <input
                  type="radio"
                  checked={scopeMode === 'selected'}
                  onChange={() => setScopeMode('selected')}
                  className="accent-accent-500"
                />
                Selected scope…  <span className="text-[10px] text-zinc-500">tick specific scenes</span>
              </label>
            </div>
            {scopeMode === 'selected' && (
              <div data-help-region="export-dialog:scope_tree" className="mt-2">
                <ExportDialogScopeTree
                  selectedIds={selectedSceneIds}
                  onChange={setSelectedSceneIds}
                />
                <p className="text-[11px] text-zinc-500 mt-1.5 leading-snug">
                  {selectedSceneIds.size === 0
                    ? 'Tick scenes in the tree to include them in the export.'
                    : `${selectedSceneIds.size} scene${selectedSceneIds.size === 1 ? '' : 's'} selected.`}
                </p>
              </div>
            )}

            {/* Entity state boundary — only meaningful when the
                writer ticked specific scenes (Selected scope). For
                Whole story / POV only there's no boundary to walk
                to, so the section would be a one-option non-choice;
                hide it entirely in those modes per writer feedback.
                The payload defaults to 'origin' anyway when the
                section isn't shown, so behaviour is unchanged. */}
            {scopeMode === 'selected' && (
              <div data-help-region="export-dialog:entity_state_boundary" className="mt-3">
                <div className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">
                  Entity state in reference sheets
                </div>
                <div className="space-y-1">
                  <label className="flex items-start gap-2 text-xs cursor-pointer text-zinc-200 hover:text-zinc-100">
                    <input
                      type="radio"
                      checked={entityStateBoundary === 'origin'}
                      onChange={() => setEntityStateBoundary('origin')}
                      className="accent-accent-500 mt-0.5"
                    />
                    <span>
                      <strong>Use full story starting state</strong>
                      <span className="block text-zinc-500 text-[11px] leading-snug mt-0.5">
                        Entity reference sheets show each entity's library / origin state, same as a whole-story export.
                      </span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-xs cursor-pointer text-zinc-200 hover:text-zinc-100">
                    <input
                      type="radio"
                      checked={entityStateBoundary === 'scope'}
                      onChange={() => setEntityStateBoundary('scope')}
                      className="accent-accent-500 mt-0.5"
                    />
                    <span>
                      <strong>Use scope starting state</strong>
                      <span className="block text-zinc-500 text-[11px] leading-snug mt-0.5">
                        Walk each entity's chain forward to the moment immediately before the earliest exported scene. A reader who only receives Chapter&nbsp;7 sees characters as they are at the start of Chapter&nbsp;7, not as they are at Chapter&nbsp;1. Sheets are also filtered to only entities that appear in the exported scope.
                      </span>
                    </span>
                  </label>
                </div>
              </div>
            )}
          </section>

          {/* PROSE — one exposed toggle: append reference sheets or not. */}
          {preset === 'prose' && (
            <section data-help-region="export-dialog:prose_options">
              <h3 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider mb-2">Prose options</h3>
              <label className="flex items-start gap-2 text-xs cursor-pointer text-zinc-200 hover:text-zinc-100 border border-zinc-700 rounded p-2.5">
                <input
                  type="checkbox"
                  checked={!!(options.include_entity_sheets && options.include_knowledge_section)}
                  onChange={() => {
                    const next = !(options.include_entity_sheets && options.include_knowledge_section)
                    setOptions((prev) => ({
                      ...prev,
                      include_entity_sheets: next,
                      include_knowledge_section: next,
                    }))
                  }}
                  className="accent-accent-500 mt-0.5"
                />
                <span>
                  <strong>Include reference sheets at the end</strong>
                  <span className="block text-zinc-500 text-[11px] leading-snug mt-0.5">
                    Append the entity reference sheets and the Knowledge appendix after the prose. Turn off for prose only.
                  </span>
                </span>
              </label>
            </section>
          )}

          {/* CUSTOMIZE — toggle pane visible only for the Customize preset */}
          {preset === 'customize' && (
            <section data-help-region="export-dialog:customize">
              <h3 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider mb-2">Customize</h3>
              {/* Entity context mode — verbosity of the per-scene
                  entity-context line. Sits ahead of the toggle
                  groups because it's an enum, not a boolean. The
                  separate `include_entity_context_line` toggle in the
                  Per-scene group gates whether the line is emitted at
                  all; this select controls how detailed it is when
                  emitted. */}
              <div data-help-region="export-dialog:entity_context_mode" className="border border-zinc-700 rounded mb-3 p-2.5 space-y-1">
                <label className="block text-[10px] font-semibold text-zinc-400 uppercase tracking-wider mb-1">
                  Entity context line detail
                </label>
                <select
                  value={options.entity_context_mode || 'minimal'}
                  onChange={(e) => setOptions((prev) => ({ ...prev, entity_context_mode: e.target.value }))}
                  className="w-full bg-zinc-900 text-xs text-zinc-200 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
                >
                  <option value="off">Off</option>
                  <option value="minimal">Minimal — names only</option>
                  <option value="full">Full — names + types + hover popovers</option>
                </select>
                <p className="text-[10px] text-zinc-500 leading-snug pt-1">
                  Affects the per-scene entity context line when the line itself is enabled (Per-scene group below).
                </p>
              </div>
              <div className="space-y-3">
                {TOGGLE_GROUPS.map((group) => {
                  const visibleItems = group.items.filter((item) =>
                    toggleVisibleFor(item.key, currentCapabilities)
                  )
                  if (visibleItems.length === 0) return null
                  const groupCollapsed = collapsedGroups[group.id]
                  return (
                    <div key={group.id} data-help-region={`export-dialog:customize_${group.id}`} className="border border-zinc-700 rounded">
                      <button
                        type="button"
                        onClick={() => setCollapsedGroups((prev) => ({ ...prev, [group.id]: !prev[group.id] }))}
                        className="w-full flex items-center justify-between px-2.5 py-1.5 bg-zinc-700/40 text-[10px] text-zinc-400 uppercase tracking-wider hover:bg-zinc-700/60"
                      >
                        <span>{group.label}</span>
                        <span className="text-zinc-500">{groupCollapsed ? '▸' : '▾'}</span>
                      </button>
                      {!groupCollapsed && (
                        <div className="p-2.5 space-y-1">
                          {visibleItems.map((item) => {
                            const parentOff = item.dependsOn && !options[item.dependsOn]
                            const value = options[item.key]
                            return (
                              <label
                                key={item.key}
                                className={`flex items-center gap-2 text-xs ${
                                  parentOff ? 'text-zinc-600 cursor-not-allowed' : 'text-zinc-200 cursor-pointer hover:text-zinc-100'
                                } ${item.dependsOn ? 'ml-5' : ''}`}
                              >
                                <input
                                  type="checkbox"
                                  checked={!!value}
                                  disabled={parentOff}
                                  onChange={() => toggleOption(item.key)}
                                  className="accent-accent-500"
                                />
                                {item.label}
                              </label>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>
          )}

          {/* ERROR / STATUS */}
          {error && (
            <div className="text-xs text-red-400 bg-red-900/30 border border-red-900/60 rounded px-3 py-2">
              {error}
            </div>
          )}
          {statusMessage && !error && (
            <div className="text-xs text-emerald-400 bg-emerald-900/20 border border-emerald-900/50 rounded px-3 py-2">
              {statusMessage}
            </div>
          )}
        </div>

        {/* Footer — "Save as default" appears only in Customize mode.
            The other presets are fixed bundles with nothing
            preset-specific to persist beyond the preset choice itself,
            so the button would be visually noisy and conceptually
            confusing for them. */}
        <div data-help-region="export-dialog:footer" className="flex items-center justify-between gap-2 px-4 py-3 border-t border-zinc-700 flex-shrink-0">
          <div>
            {preset === 'customize' && (
              <button
                onClick={handleSaveAsDefault}
                disabled={savingDefault || exporting}
                data-help-region="export-dialog:save_as_default"
                className="px-3 py-1.5 text-xs rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200 disabled:opacity-50"
                title="Save the current Customize toggles + format as your default Customize state for the next time you open this dialog."
              >
                {savingDefault ? 'Saving…' : 'Save as default'}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={close}
              disabled={exporting}
              className="px-3 py-1.5 text-xs rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200 disabled:opacity-50"
            >
              Cancel
            </button>
            {/* Phase 3.11 — Novelcrafter preset splits the single
                Export action into three buttons: Story alone, Codex
                alone, and the Bundle (zip of both). Each dispatches
                to its own hidden variant slug so the writer can grab
                just the file they need without unzipping. The slug
                base is the resolved umbrella (`markdown-novelcrafter`
                / `docx-novelcrafter`) so the buttons stay correct
                regardless of which file family the writer picked.
                Other presets keep the single Export button. */}
            {preset === 'novelcrafter' ? (
              <>
                <button
                  onClick={() => handleExport(`${currentSlug}-story`)}
                  disabled={exporting || (scopeMode === 'selected' && selectedSceneIds.size === 0)}
                  data-help-region="export-dialog:download_story"
                  title="Download the manuscript file alone (Prose or Summaries, per the per-scene depth pick above)."
                  className="px-3 py-1.5 text-xs rounded bg-accent-700 hover:bg-accent-600 text-white disabled:opacity-50"
                >
                  {exporting ? 'Exporting…' : 'Download story'}
                </button>
                <button
                  onClick={() => handleExport(`${currentSlug}-codex`)}
                  disabled={exporting || (scopeMode === 'selected' && selectedSceneIds.size === 0)}
                  data-help-region="export-dialog:download_codex"
                  title="Download the entity codex sheet alone."
                  className="px-3 py-1.5 text-xs rounded bg-accent-700 hover:bg-accent-600 text-white disabled:opacity-50"
                >
                  {exporting ? 'Exporting…' : 'Download codex'}
                </button>
                <button
                  onClick={() => handleExport()}
                  disabled={exporting || (scopeMode === 'selected' && selectedSceneIds.size === 0)}
                  data-help-region="export-dialog:download_bundle"
                  title="Download a ZIP containing both the manuscript and the codex."
                  className="px-3 py-1.5 text-xs rounded bg-accent-700 hover:bg-accent-600 text-white disabled:opacity-50"
                >
                  {exporting ? 'Exporting…' : 'Download bundle (zip)'}
                </button>
              </>
            ) : (
              <button
                onClick={() => handleExport()}
                disabled={exporting || (scopeMode === 'selected' && selectedSceneIds.size === 0)}
                data-help-region="export-dialog:export_button"
                title={
                  scopeMode === 'selected' && selectedSceneIds.size === 0
                    ? 'Select at least one scene in the Scope tree first.'
                    : undefined
                }
                className="px-3 py-1.5 text-xs rounded bg-accent-700 hover:bg-accent-600 text-white disabled:opacity-50"
              >
                {exporting ? 'Exporting…' : 'Export'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// Fallback labels used while the /formats catalogue fetch hasn't
// resolved yet. Once the catalogue lands these are superseded by the
// backend-supplied label. Kept narrow on purpose — the renderer
// catalogue is the source of truth for human-readable format names.
const FORMAT_FALLBACK_LABELS = {
  docx: 'Microsoft Word (.docx)',
  pdf: 'PDF',
  markdown: 'Markdown',
  html: 'HTML',
  txt: 'Plain text (.txt)',
}
