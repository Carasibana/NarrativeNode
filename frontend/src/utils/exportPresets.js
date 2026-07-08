/**
 * Phase 1.25a — Export preset registry (frontend).
 *
 * Each preset describes the writer's INTENT for an export — what kind
 * of document they want to produce, not which file format. The format
 * picker lives downstream of the preset; only formats the chosen
 * preset supports are offered.
 *
 * Four presets ship in 1.25a:
 *   - native       writer's working copy. Includes Changes blocks,
 *                  entity sheets, transition notes, everything
 *                  NarrativeNode tracks. Available for every format.
 *   - shunn        submission-ready manuscript in the standard
 *                  fiction-publishing format codified by William
 *                  Shunn. Body-only, Publication mode. DOCX + PDF
 *                  only. The actual `docx-shunn` / `pdf-shunn`
 *                  renderers ship in Phase 1.25e — for 1.25a the
 *                  preset entry exists with a "coming next sub-phase"
 *                  note in the description.
 *   - novelcrafter clean export shaped for NovelCrafter import.
 *                  DOCX + Markdown only. Maps to the existing
 *                  docx-novelcrafter / markdown-novelcrafter slugs.
 *   - customize    writer-defined. Toggle pane editable. Available
 *                  for every format.
 *
 * Preset semantics live on the frontend in this phase: the dialog
 * applies a preset's toggle bundle to its local state when the
 * preset changes, then POSTs the resulting toggles to the existing
 * `POST /api/project/export/{slug}` endpoint with `preset_key` in
 * the request body. Backend `ExportOptions.preset_key` is informational
 * for now (logging + future server-side enforcement hook).
 */

// ── Toggle defaults shared by Native and any preset that wants the
// "everything on" baseline. Mirrors the field names on backend
// `ExportOptions` (see `backend/services/export_service.py`).
const ALL_TOGGLES_DEFAULT = {
  // Header / story metadata
  include_author: true,
  include_genre: true,
  // Phase 5.8b — story description blurb on the title page.
  include_story_description: true,
  // Phase 5.8b — story cover image as the first page (image formats only).
  include_cover_image: true,
  // Phase 5.8b — render markdown typed into free-form text fields
  // (descriptions, attribute values, notes, etc.) on export.
  render_markdown_in_text_fields: true,
  // Phase 5.8b — scene-break ornament between same-chapter scenes.
  include_scene_separator: true,
  include_tags: true,
  include_tense: true,
  include_pov_type: true,
  include_language: true,
  include_default_pov_character: true,
  include_generated_timestamp: true,
  // Structure
  include_act_headings: true,
  include_chapter_headings: true,
  include_unchaptered_heading: true,
  // Per-scene elements
  include_transition_text: true,
  include_scene_title: true,
  include_scene_description: true,
  include_scene_pov_line: true,
  include_entity_context_line: true,
  include_scene_body: true,
  include_scene_changes_block: true,
  // Phase 1.22i — Circumstances & Motivators block
  include_scene_cm_block: true,
  // Scene changes granularity
  include_metadata_changes: true,
  include_attribute_changes: true,
  include_relationship_changes: true,
  include_alias_changes: true,
  include_awareness_changes: true,
  // Appendices
  include_offscreen_appendix: true,
  include_entity_sheets: true,
  // Phase 1.25c — entity Notes sub-section on entity reference sheets
  include_entity_notes: true,
  // Phase 1.25c — Knowledge appendix (after entity sheets)
  include_knowledge_section: true,
  include_knowledge_chain_history: false,
  // Phase 1.25c — scene-time line on each scene header
  include_scene_time: true,
  // Media attributes — images travel by default; audio/video opt-in
  include_media_attributes: true,
  include_media_attribute_images: true,
  include_media_attribute_audio: false,
  include_media_attribute_video: false,
  // Build-level
  embed_assets: true,
  // Per-entity colours — off so existing renderer behaviour is preserved
  use_entity_colours: false,
  // Entity context line mode
  entity_context_mode: 'minimal',
}

// Per-preset toggle bundles. Customize has no bundle — its values come
// from the writer's edits in the toggle pane. The other three are
// fixed: switching to that preset overwrites the toggle state with
// the bundle wholesale.
export const PRESET_BUNDLES = {
  // NarrativeNode native — kitchen-sink writer's working copy
  native: { ...ALL_TOGGLES_DEFAULT },

  // NarrativeNode prose — native, but with everything that renders in a
  // light-grey box removed (scene description, the context block — time /
  // C&M / POV / entity context — and the Scene Changes block), leaving the
  // story prose. Reference sheets (entity sheets + Knowledge appendix) are
  // ON by default and the writer toggles them via the dialog's one exposed
  // prose control.
  prose: {
    ...ALL_TOGGLES_DEFAULT,
    include_scene_description: false,
    include_scene_time: false,
    include_scene_cm_block: false,
    include_scene_pov_line: false,
    include_entity_context_line: false,
    include_scene_changes_block: false,
  },

  // Shunn manuscript — body-only, Publication mode. Most NarrativeNode-
  // specific blocks turn off because Shunn is for the reader (a real
  // submitted-to-an-agent manuscript), not the writer's notes. The
  // actual layout (Times 12pt, double spaced, page breaks, etc.) is
  // hard-coded by the docx-shunn / pdf-shunn renderers in Phase 1.25e
  // — these toggles cover the content choices the renderer reads.
  shunn: {
    ...ALL_TOGGLES_DEFAULT,
    include_author: false,
    include_genre: false,
    include_tags: false,
    include_tense: false,
    include_pov_type: false,
    include_language: false,
    include_default_pov_character: false,
    include_generated_timestamp: false,
    include_act_headings: true,
    include_chapter_headings: true,
    include_unchaptered_heading: false,
    include_transition_text: false,
    include_scene_title: false,
    include_scene_description: false,
    include_scene_pov_line: false,
    include_entity_context_line: false,
    include_scene_changes_block: false,
    include_scene_cm_block: false,
    include_metadata_changes: false,
    include_attribute_changes: false,
    include_relationship_changes: false,
    include_offscreen_appendix: false,
    include_entity_sheets: false,
    include_media_attributes: false,
    include_media_attribute_images: false,
    include_media_attribute_audio: false,
    include_media_attribute_video: false,
    use_entity_colours: false,
    entity_context_mode: 'off',
  },

  // NovelCrafter format — manuscript file (body-only, *** between
  // scenes) plus codex sheets for entities. Matches the existing
  // markdown-novelcrafter / docx-novelcrafter renderer behaviour.
  novelcrafter: {
    ...ALL_TOGGLES_DEFAULT,
    include_author: false,
    include_genre: false,
    include_tags: false,
    include_tense: false,
    include_pov_type: false,
    include_language: false,
    include_default_pov_character: false,
    include_generated_timestamp: false,
    include_transition_text: false,
    include_scene_title: false,
    include_scene_description: false,
    include_scene_pov_line: false,
    include_entity_context_line: false,
    include_scene_changes_block: false,
    include_scene_cm_block: false,
    include_metadata_changes: false,
    include_attribute_changes: false,
    include_relationship_changes: false,
    include_offscreen_appendix: false,
    include_entity_sheets: true,
    use_entity_colours: false,
    entity_context_mode: 'off',
  },
}

// Per-preset metadata consumed by the dialog UI.
export const PRESETS = {
  native: {
    key: 'native',
    label: 'NarrativeNode native',
    description:
      "The writer's working copy. Includes Changes blocks at every scene, full entity reference sheets, transition notes — everything NarrativeNode tracks. " +
      'Use for: continuity review, sharing in-progress state, your own records.',
    supportedFormats: ['pdf', 'docx', 'markdown', 'html', 'txt'],
    defaultFormat: 'pdf',
    defaultScope: 'whole',
  },
  prose: {
    key: 'prose',
    label: 'NarrativeNode prose',
    description:
      'Like NarrativeNode native, but with the metadata boxes left out (scene description, the context block — POV / characters / items / circumstances & motivators / time — and the per-scene Changes block), leaving the story prose. ' +
      'A single option below chooses whether to append the reference sheets (entity sheets + Knowledge appendix) at the end. ' +
      'Use for: a clean reading copy.',
    supportedFormats: ['pdf', 'docx', 'markdown', 'html', 'txt'],
    defaultFormat: 'pdf',
    defaultScope: 'whole',
  },
  shunn: {
    key: 'shunn',
    label: 'Shunn manuscript',
    description:
      'Submission-ready manuscript in the standard fiction-publishing format codified by William Shunn. ' +
      'Title page with contact info; double-spaced Times New Roman 12pt body; chapter breaks; centred `#` scene breaks; `# # #` end marker. ' +
      'Body-only, narrative order (Publication mode). ' +
      'Use for: sending to agents and editors. ' +
      '\n\nNote: the Shunn DOCX and PDF renderers ship in Phase 1.25e. Selecting this preset before then has no rendered output.',
    supportedFormats: ['docx', 'pdf'],
    defaultFormat: 'docx',
    defaultScope: 'pov_only',
  },
  novelcrafter: {
    key: 'novelcrafter',
    label: 'NovelCrafter Compatible',
    description:
      'Clean export shaped for import into NovelCrafter. Manuscript file is body-only with `***` between scenes; ' +
      'codex sheets capture entities (name, type, aliases, description). ' +
      'Use for: moving the project into NovelCrafter for further drafting.',
    supportedFormats: ['docx', 'markdown'],
    defaultFormat: 'docx',
    defaultScope: 'whole',
  },
  customize: {
    key: 'customize',
    label: 'Customize',
    description:
      'Set every export option yourself. Pick any format, toggle any block on or off. ' +
      'Use for: producing a specific output that doesn\'t match a preset (e.g. a chapter-only export, or a writer\'s-notes copy without entity sheets).',
    supportedFormats: ['pdf', 'docx', 'markdown', 'html', 'txt'],
    defaultFormat: 'pdf',
    defaultScope: 'whole',
  },
}

// Render order for the preset list. Customize sits last by convention
// — it's the "I want something different" option, presented after
// the curated intent presets.
export const PRESET_ORDER = ['native', 'prose', 'shunn', 'novelcrafter', 'customize']

/**
 * Resolve the toggle bundle to apply for the given preset.
 * For Customize, returns null (caller should leave the toggle state
 * alone — the writer's edits are the source of truth).
 */
export function getPresetBundle(presetKey) {
  if (presetKey === 'customize') return null
  return PRESET_BUNDLES[presetKey] || null
}
