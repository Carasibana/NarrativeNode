import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import axios from 'axios'
import { useProjectStore } from '../../../store/projectStore'
import { useEntitiesStore } from '../../../store/entitiesStore'
import { useSettingsStore } from '../../../store/settingsStore'
import { useSystemPromptsStore } from '../../../store/systemPromptsStore'
import { useUiStore } from '../../../store/uiStore'
import { DEFAULT_ACCENT_COLOR, DEFAULT_POV_COLOR } from '../../../utils/povConstants'
import EntityColorPicker from '../../ui/EntityColorPicker'
import ToggleInput from '../../ui/ToggleInput'
import SettingsTabFooter from './SettingsTabFooter'
import PopoverSectionRow from '../../ui/PopoverSectionRow'
import SystemPromptPickerList from '../../ui/SystemPromptPickerList'
import CoverPlaceholder from '../../ui/CoverPlaceholder'
import { detectAndFireOvumOrange } from '../../../effects/quarterlyForecasts'

// Phase 5.2b — cover crop config. 2:3 portrait, output capped at
// 1024x1536 and never upscaled (a smaller source keeps its native
// cropped pixel size). Shared by the Story Settings cover control.
const COVER_ASPECT = 2 / 3
// q0.92: the cover is encoded ONCE here (the single save-time conversion).
// Every downstream copy (the .nnz pack, the library cover cache) is a byte
// copy of this file — never a second JPEG re-encode.
const COVER_OUTPUT = { maxWidth: 1024, maxHeight: 1536, upscale: false, quality: 0.92 }

const SURFACES = [
  { key: 'chat_panel',             label: 'Chat Panel' },
  { key: 'scene_description_pbh',  label: 'Scene Description' },
  { key: 'section_pbh',            label: 'Section Prompt' },
  { key: 'ipb',                    label: 'Inline Prompt' },
]

const TENSE_OPTIONS = ['', 'Past', 'Present']
const POV_TYPE_OPTIONS = [
  '',
  '1st Person',
  '2nd Person',
  '3rd Person',
  '3rd Person (Limited)',
  '3rd Person (Omniscient)',
]

const inputCls  = 'w-full bg-zinc-800 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500'
const selectCls = inputCls + ' appearance-none'
const labelCls  = 'block text-[11px] text-zinc-400 mb-1'
const sectionCls       = 'rounded border border-zinc-700/60 bg-zinc-900/40 px-4 py-3 space-y-3'
const sectionHeaderCls = 'text-[11px] font-semibold text-zinc-300 uppercase tracking-wider pb-1 mb-2 border-b border-zinc-700/60'

export default function StorySettingsTab({ onClose, onDirtyChange, registerSave }) {
  const story = useProjectStore((s) => s.story)
  const updateStorySettings = useProjectStore((s) => s.updateStorySettings)
  const characters = useEntitiesStore((s) => s.characters)

  // Phase 2.10a item 12 — story-side per-surface prompt overrides.
  // Reads from `story.default_prompt_overrides` (may be null when
  // unset); writes back via `saveDraft`. The picker needs the prompt
  // list + categories for the bespoke flyout shape; load lazily on
  // mount, idempotent.
  const systemPrompts          = useSystemPromptsStore((s) => s.prompts)
  const systemPromptCategories = useSystemPromptsStore((s) => s.categories)
  const loadSystemPrompts      = useSystemPromptsStore((s) => s.loadPrompts)
  const loadSystemPromptCategories = useSystemPromptsStore((s) => s.loadCategories)
  useEffect(() => { loadSystemPrompts() }, [loadSystemPrompts])
  useEffect(() => { loadSystemPromptCategories() }, [loadSystemPromptCategories])
  // System-wide per-surface defaults (read-only here — used for the
  // "inherits from …" label on each row).
  const prefs = useSettingsStore((s) => s.preferences)

  const [title, setTitle]               = useState(story?.title || '')
  const [description, setDescription]   = useState(story?.description || '')
  const [author, setAuthor]             = useState(story?.author || '')
  const [povCharacterId, setPovCharacterId] = useState(story?.pov_character_id || '')
  const [tense, setTense]               = useState(story?.tense || '')
  const [language, setLanguage]         = useState(story?.language || '')
  const [povTypeDefault, setPovTypeDefault] = useState(story?.pov_type_default || '')
  const [genre, setGenre]               = useState(story?.genre || '')
  const [tags, setTags]                 = useState(story?.tags || [])
  const [tagInput, setTagInput]         = useState('')
  // Phase 5.2b — series grouping for the Story Library. `seriesNumber`
  // is held as a string for the text input; committed as a float (or
  // null) in saveDraft. The number input is disabled until a series is
  // entered (a series number is meaningless with no series).
  const [series, setSeries]             = useState(story?.series || '')
  const [seriesNumber, setSeriesNumber] = useState(
    story?.series_number == null ? '' : String(story.series_number)
  )
  const [accentColor, setAccentColor]   = useState(story?.accent_color || DEFAULT_ACCENT_COLOR)
  const [povColorVal, setPovColorVal]   = useState(story?.pov_color || DEFAULT_POV_COLOR)
  const accentAnchorRef = useRef(null)
  const [accentPickerOpen, setAccentPickerOpen] = useState(false)
  const povAnchorRef = useRef(null)
  const [povPickerOpen, setPovPickerOpen] = useState(false)
  const [autosaveEnabled, setAutosaveEnabled] = useState(story?.autosave_enabled !== false)
  const [autosaveInterval, setAutosaveInterval] = useState(
    Number.isFinite(story?.autosave_interval_minutes) && story.autosave_interval_minutes > 0
      ? story.autosave_interval_minutes
      : 5
  )
  const [promptOverrides, setPromptOverrides] = useState(() => ({
    chat_panel:            story?.default_prompt_overrides?.chat_panel || null,
    scene_description_pbh: story?.default_prompt_overrides?.scene_description_pbh || null,
    section_pbh:           story?.default_prompt_overrides?.section_pbh || null,
    ipb:                   story?.default_prompt_overrides?.ipb || null,
  }))
  const [chapterLabel, setChapterLabel] = useState(story?.chapter_label || '')
  const [actLabel, setActLabel]         = useState(story?.act_label || '')
  const [chapterTintBehindNodes, setChapterTintBehindNodes] = useState(
    story?.chapter_tint_behind_nodes !== false
  )
  const [awarenessRolloverCheckEnabled, setAwarenessRolloverCheckEnabled] = useState(
    story?.awareness_rollover_check_enabled !== false
  )
  // Phase 1.23 — Time Tracking settings (plan §7).
  const [timeTrackingEnabled, setTimeTrackingEnabled] = useState(
    story?.time_tracking_enabled === true
  )
  const [allowNegativeTime] = useState(
    story?.allow_negative_time === true
  )
  const [timeFormat, setTimeFormat] = useState(
    story?.time_format === '24h' ? '24h' : '12h'
  )
  const [weekStart, setWeekStart] = useState(
    story?.week_start === 'monday' ? 'monday' : 'sunday'
  )
  const [gapShiftValue, setGapShiftValue] = useState(
    Number.isFinite(story?.gap_shift_threshold?.value)
      ? story.gap_shift_threshold.value
      : 1
  )
  const [gapShiftUnit, setGapShiftUnit] = useState(
    story?.gap_shift_threshold?.unit || 'days'
  )

  // Dirty status for the panel-level guard. Stringify-compare a
  // current-draft snapshot against an identically-shaped baseline
  // built from the same defaults the useState initialisers use, so
  // an untouched panel reads as clean. The colour comparisons match
  // the Save logic: a draft equal to the system default and a null
  // story value are equivalent.
  const baselineSnapshot = JSON.stringify({
    title:    story?.title || '',
    description: story?.description || '',
    author:   story?.author || '',
    pov:      story?.pov_character_id || '',
    tense:    story?.tense || '',
    language: story?.language || '',
    povType:  story?.pov_type_default || '',
    genre:    story?.genre || '',
    tags:     story?.tags || [],
    series:       story?.series || '',
    seriesNumber: story?.series_number == null ? '' : String(story.series_number),
    accent:   story?.accent_color || DEFAULT_ACCENT_COLOR,
    pov_color: story?.pov_color || DEFAULT_POV_COLOR,
    autosave: story?.autosave_enabled !== false,
    autosaveInterval:
      Number.isFinite(story?.autosave_interval_minutes) && story.autosave_interval_minutes > 0
        ? story.autosave_interval_minutes
        : 5,
    chapterLabel:    story?.chapter_label || '',
    actLabel:        story?.act_label || '',
    chapterTint:     story?.chapter_tint_behind_nodes !== false,
    awarenessRoll:   story?.awareness_rollover_check_enabled !== false,
    timeTracking:    story?.time_tracking_enabled === true,
    allowNeg:        story?.allow_negative_time === true,
    timeFormat:      story?.time_format === '24h' ? '24h' : '12h',
    weekStart:       story?.week_start === 'monday' ? 'monday' : 'sunday',
    gapShiftValue:
      Number.isFinite(story?.gap_shift_threshold?.value)
        ? story.gap_shift_threshold.value
        : 1,
    gapShiftUnit:    story?.gap_shift_threshold?.unit || 'days',
    overrides: {
      chat_panel:            story?.default_prompt_overrides?.chat_panel || null,
      scene_description_pbh: story?.default_prompt_overrides?.scene_description_pbh || null,
      section_pbh:           story?.default_prompt_overrides?.section_pbh || null,
      ipb:                   story?.default_prompt_overrides?.ipb || null,
    },
  })
  const draftSnapshot = JSON.stringify({
    title, description, author, pov: povCharacterId, tense, language, povType: povTypeDefault, genre, tags,
    series, seriesNumber,
    accent: accentColor, pov_color: povColorVal,
    autosave: autosaveEnabled,
    autosaveInterval: Math.max(1, parseInt(autosaveInterval, 10) || 5),
    chapterLabel, actLabel,
    chapterTint: chapterTintBehindNodes,
    awarenessRoll: awarenessRolloverCheckEnabled,
    timeTracking: timeTrackingEnabled,
    allowNeg: allowNegativeTime,
    timeFormat,
    weekStart,
    gapShiftValue: Math.max(0, parseInt(gapShiftValue, 10) || 0),
    gapShiftUnit,
    overrides: promptOverrides,
  })
  const isDirty = baselineSnapshot !== draftSnapshot
  // Stash the latest onDirtyChange in a ref so the emit / unmount
  // effects don't re-fire on every parent render (which would re-
  // trigger the panel's setState and infinite-loop).
  const onDirtyChangeRef = useRef(onDirtyChange)
  useEffect(() => { onDirtyChangeRef.current = onDirtyChange }, [onDirtyChange])
  useEffect(() => { onDirtyChangeRef.current?.(isDirty) }, [isDirty])
  useEffect(() => () => onDirtyChangeRef.current?.(false), [])

  // Phase 5.2b — match the cover preview's height to the Title / Author /
  // Default POV field column beside it (its width follows from the 2:3
  // ratio). useLayoutEffect + ResizeObserver so it tracks without a
  // first-paint flash and re-measures if the column reflows.
  const metaFieldsRef = useRef(null)
  const [coverHeight, setCoverHeight] = useState(0)
  useLayoutEffect(() => {
    const el = metaFieldsRef.current
    if (!el) return
    // Guard sub-pixel churn: the cover's width slightly narrows this
    // column, so re-measuring could ping-pong. Only commit a real change.
    const measure = () => {
      const next = el.offsetHeight
      setCoverHeight((prev) => (Math.abs(prev - next) >= 1 ? next : prev))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  function addTag() {
    const val = tagInput.trim()
    if (val && !tags.includes(val)) setTags([...tags, val])
    setTagInput('')
  }

  function removeTag(tag) {
    setTags(tags.filter((t) => t !== tag))
  }

  // saveDraft writes the current draft to the store and clears the
  // dirty flag. It does NOT close the panel — used by the panel's
  // "Save & continue" branch so the user can keep navigating.
  function saveDraft() {
    const prevTags = story?.tags || []
    updateStorySettings({
      title: title.trim() || 'Untitled Story',
      description: description.trim(),
      author: author.trim() || null,
      pov_character_id: povCharacterId || null,
      tense: tense || null,
      language: language.trim() || null,
      pov_type_default: povTypeDefault || null,
      genre: genre.trim() || null,
      tags,
      // Phase 5.2b — series + series number. Series number is parsed to
      // a float; blanked / unparseable / no-series-set all commit null
      // (a series number is meaningless without a series).
      series: series.trim() || null,
      series_number: (() => {
        if (!series.trim()) return null
        const n = parseFloat(seriesNumber)
        return Number.isFinite(n) ? n : null
      })(),
      accent_color: accentColor === DEFAULT_ACCENT_COLOR ? null : accentColor,
      pov_color: povColorVal === DEFAULT_POV_COLOR ? null : povColorVal,
      autosave_enabled: autosaveEnabled,
      autosave_interval_minutes: Math.max(1, parseInt(autosaveInterval, 10) || 5),
      chapter_label: chapterLabel.trim() || null,
      act_label: actLabel.trim() || null,
      chapter_tint_behind_nodes: chapterTintBehindNodes,
      awareness_rollover_check_enabled: awarenessRolloverCheckEnabled,
      time_tracking_enabled: timeTrackingEnabled,
      allow_negative_time: allowNegativeTime,
      time_format: timeFormat,
      week_start: weekStart,
      gap_shift_threshold: {
        unit: gapShiftUnit,
        value: Math.max(0, parseInt(gapShiftValue, 10) || 0),
      },
      // Story-side per-surface prompt overrides — write a struct
      // only when at least one slot is set, else null so the field
      // drops from `narrative.json` on save per the omit-when-empty
      // rule (Pydantic `default_prompt_overrides: Optional[…] = None`).
      default_prompt_overrides: (() => {
        const anySet = SURFACES.some((s) => promptOverrides[s.key])
        if (!anySet) return null
        return {
          chat_panel:            promptOverrides.chat_panel || null,
          scene_description_pbh: promptOverrides.scene_description_pbh || null,
          section_pbh:           promptOverrides.section_pbh || null,
          ipb:                   promptOverrides.ipb || null,
        }
      })(),
    })
    try { detectAndFireOvumOrange(prevTags, tags) } catch { /* never break save */ }
    onDirtyChangeRef.current?.(false)
  }
  // Stash saveDraft + register it once. The ref lets the parent's
  // "Save & continue" callback always invoke the latest closure
  // without us re-registering on every render (which would loop).
  const saveDraftRef = useRef(saveDraft)
  saveDraftRef.current = saveDraft
  const registerSaveRef = useRef(registerSave)
  useEffect(() => { registerSaveRef.current = registerSave }, [registerSave])
  useEffect(() => {
    registerSaveRef.current?.(() => saveDraftRef.current?.())
    return () => registerSaveRef.current?.(null)
  }, [])

  function handleSave() {
    // Commit only — Save no longer closes the panel. The writer
    // stays on the tab to keep editing or browse other tabs. Close
    // paths remain Cancel / Esc / the X in the panel header.
    saveDraft()
  }
  function handleCancel() {
    onDirtyChangeRef.current?.(false)  // explicit cancel = explicit discard
    onClose()
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-4 space-y-3">

        {/* ── Story metadata ── */}
        <section className={sectionCls}>
          <header className={sectionHeaderCls}>Story metadata</header>

          {/* Cover preview on the LEFT, sized to match the height of the
              Title / Author / Default POV field column beside it (its
              width follows from the 2:3 ratio). Clicking the preview
              sets / replaces the cover (Phase 5.2b). */}
          <div className="flex gap-3 items-start">
            <StoryCoverField storyId={story?.id} height={coverHeight} />

            <div ref={metaFieldsRef} className="flex-1 min-w-0 space-y-3">
              <div>
                <label className={labelCls}>Title</label>
                <input value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} className={inputCls} placeholder="Untitled Story" />
              </div>

              <div>
                <label className={labelCls}>Author</label>
                <input value={author} onChange={(e) => setAuthor(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} className={inputCls} placeholder="Optional" />
              </div>

              <div>
                <label className={labelCls}>Default POV Character</label>
                <select value={povCharacterId} onChange={(e) => setPovCharacterId(e.target.value)} className={selectCls}>
                  <option value="">None</option>
                  {characters.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
                <p className="text-[10px] text-zinc-500 mt-0.5">The character whose POV is used by default when wiring scenes.</p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Tense</label>
              <select value={tense} onChange={(e) => setTense(e.target.value)} className={selectCls}>
                {TENSE_OPTIONS.map((t) => (
                  <option key={t} value={t}>{t || 'Not set'}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>POV Type Default</label>
              <select value={povTypeDefault} onChange={(e) => setPovTypeDefault(e.target.value)} className={selectCls}>
                {POV_TYPE_OPTIONS.map((p) => (
                  <option key={p} value={p}>{p || 'Not set'}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className={labelCls}>Language</label>
            <input value={language} onChange={(e) => setLanguage(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} className={inputCls} placeholder="Optional" />
          </div>

          <div>
            <label className={labelCls}>Genre</label>
            <input value={genre} onChange={(e) => setGenre(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} className={inputCls} placeholder="Optional" />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className={labelCls}>Series</label>
              <input
                value={series}
                onChange={(e) => setSeries(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                className={inputCls}
                placeholder="Optional"
              />
            </div>
            <div className={series.trim() ? '' : 'opacity-50'}>
              <label className={labelCls}>Number</label>
              <input
                type="number"
                step="0.5"
                value={seriesNumber}
                onChange={(e) => setSeriesNumber(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                disabled={!series.trim()}
                className={`${inputCls} disabled:cursor-not-allowed`}
                placeholder="e.g. 1"
              />
            </div>
          </div>
          <p className="text-[10px] text-zinc-500 -mt-1.5">
            Group this story in a series for the library. Decimals are allowed for prequels / interquels (0.5, 2.5). The number applies only when a series is set.
          </p>

          <div>
            <label className={labelCls}>Tags</label>
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-1.5">
                {tags.map((tag) => (
                  <span key={tag} className="inline-flex items-center gap-0.5 bg-zinc-700 text-zinc-200 text-xs rounded px-1.5 py-0.5">
                    {tag}
                    <button type="button" onClick={() => removeTag(tag)} className="text-zinc-400 hover:text-red-400 leading-none ml-0.5">×</button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex gap-1">
              <input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag() } }}
                placeholder="Add tag, press Enter..."
                className="flex-1 bg-zinc-800 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
              />
              <button type="button" onClick={addTag} className="text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded px-2 py-1">+</button>
            </div>
          </div>
        </section>

        {/* ── Story description ──
            Free-form summary / blurb for the story. Surfaced today via
            the `story_description` dynamic context pill (Phase 3.11c);
            later surfaces will reuse the same field (Stage 5.1 library
            card body, future export title-page logline, etc.). */}
        <section className={sectionCls}>
          <header className={sectionHeaderCls}>Story description</header>

          <div>
            <label className={labelCls}>Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              placeholder="A short blurb describing the story. Optional."
              className={`${inputCls} resize-y leading-snug`}
            />
          </div>
        </section>

        {/* ── Structure ── */}
        <section className={sectionCls}>
          <header className={sectionHeaderCls}>Structure</header>

          <div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Chapter label</label>
                <input
                  value={chapterLabel}
                  onChange={(e) => setChapterLabel(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                  className={inputCls}
                  placeholder="Chapter"
                  maxLength={24}
                />
              </div>
              <div>
                <label className={labelCls}>Act label</label>
                <input
                  value={actLabel}
                  onChange={(e) => setActLabel(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                  className={inputCls}
                  placeholder="Act"
                  maxLength={24}
                />
              </div>
            </div>
            <p className="text-[10px] text-zinc-500 mt-1">
              Override the &quot;Chapter&quot; and &quot;Act&quot; terms used in canvas column headers. Leave empty for defaults.
            </p>
          </div>

          <div>
            <ToggleInput
              value={chapterTintBehindNodes}
              defaultValue={true}
              onLabel="Tint behind scenes"
              offLabel="Tint over scenes"
              onCommit={setChapterTintBehindNodes}
            />
            <p className="text-[10px] text-zinc-500 mt-1">
              On: scene nodes render on top of chapter column colours (default). Off: column tint bleeds through nodes as a subtle wash.
            </p>
          </div>
        </section>

        {/* ── Colours ── */}
        <section className={sectionCls}>
          <header className={sectionHeaderCls}>Colours</header>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Accent Colour</label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  ref={accentAnchorRef}
                  onClick={() => setAccentPickerOpen((o) => !o)}
                  className="w-7 h-7 rounded border border-zinc-600 cursor-pointer flex-shrink-0"
                  style={{ background: accentColor }}
                  aria-label={`Accent colour: ${accentColor}. Click to open picker.`}
                />
                <EntityColorPicker
                  value={accentColor}
                  onChange={setAccentColor}
                  anchorEl={accentAnchorRef.current}
                  isOpen={accentPickerOpen}
                  onClose={() => setAccentPickerOpen(false)}
                />
                <input
                  value={accentColor}
                  onChange={(e) => setAccentColor(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                  className="flex-1 bg-zinc-800 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500 font-mono"
                />
                <button
                  type="button"
                  onClick={() => setAccentColor(DEFAULT_ACCENT_COLOR)}
                  className="text-[9px] text-zinc-500 hover:text-zinc-300 border border-zinc-600 rounded px-1.5 py-0.5"
                  title="Reset to default"
                >↺</button>
              </div>
            </div>
            <div>
              <label className={labelCls}>POV Colour</label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  ref={povAnchorRef}
                  onClick={() => setPovPickerOpen((o) => !o)}
                  className="w-7 h-7 rounded border border-zinc-600 cursor-pointer flex-shrink-0"
                  style={{ background: povColorVal }}
                  aria-label={`POV colour: ${povColorVal}. Click to open picker.`}
                />
                <EntityColorPicker
                  value={povColorVal}
                  onChange={setPovColorVal}
                  anchorEl={povAnchorRef.current}
                  isOpen={povPickerOpen}
                  onClose={() => setPovPickerOpen(false)}
                />
                <input
                  value={povColorVal}
                  onChange={(e) => setPovColorVal(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                  className="flex-1 bg-zinc-800 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500 font-mono"
                />
                <button
                  type="button"
                  onClick={() => setPovColorVal(DEFAULT_POV_COLOR)}
                  className="text-[9px] text-zinc-500 hover:text-zinc-300 border border-zinc-600 rounded px-1.5 py-0.5"
                  title="Reset to default"
                >↺</button>
              </div>
            </div>
          </div>
        </section>

        {/* ── Auto-save ── */}
        <section className={sectionCls}>
          <header className={sectionHeaderCls}>Auto-save</header>

          <div className="flex items-end gap-4">
            <ToggleInput
              value={autosaveEnabled}
              defaultValue={true}
              onLabel="Enabled"
              offLabel="Disabled"
              onCommit={setAutosaveEnabled}
            />
            <div className={autosaveEnabled ? '' : 'opacity-50 pointer-events-none'}>
              <label className={labelCls}>Interval (minutes)</label>
              <input
                type="number"
                min="1"
                step="1"
                value={autosaveInterval}
                onChange={(e) => setAutosaveInterval(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                className="bg-zinc-800 text-xs text-zinc-100 w-16 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
              />
            </div>
          </div>
          <p className="text-[11px] text-zinc-500 leading-relaxed">
            Writes to a sibling file named <code className="px-1 py-0.5 bg-zinc-700/60 rounded text-[10px]">&lt;name&gt;_autosave.nnz</code> in the same folder. Skipped until the project has been saved at least once.
          </p>
        </section>

        {/* ── Time Tracking (Phase 1.23 §7) ── */}
        <section className={sectionCls}>
          <header className={sectionHeaderCls}>Time Tracking</header>

          <div className="flex items-end gap-4">
            <ToggleInput
              value={timeTrackingEnabled}
              defaultValue={false}
              onLabel="Enabled"
              offLabel="Disabled"
              onCommit={setTimeTrackingEnabled}
            />
            <p className="text-[11px] text-zinc-500 leading-relaxed flex-1">
              Track Time of Day, Day, Scene Duration, and gaps between scenes along the POV chain. When off, time UI is hidden across the app; pinned data on individual scenes is preserved on disk.
            </p>
          </div>

          <div className={timeTrackingEnabled ? 'space-y-3 pt-1' : 'space-y-3 pt-1 opacity-50 pointer-events-none'}>
            {/*
              Phase 1.23 step 14 — "Allow Negative Time (time travel)"
              parked on v0.1.23.15. The Story.allow_negative_time field
              and walker `allowNegative` plumbing remain in place;
              `allowNegativeTime` reads as `false` by default until the
              feature is unparked. Re-enable this control when the
              writer-facing surface (signed gap_extension input + time-
              travelling flag elsewhere) is delivered.
            <div>
              <label className={labelCls}>Allow Negative Time (time travel)</label>
              <ToggleInput
                value={allowNegativeTime}
                defaultValue={false}
                onLabel="Allowed"
                offLabel="Blocked"
                onCommit={setAllowNegativeTime}
              />
              <p className="text-[10px] text-zinc-500 mt-1">
                When allowed, scenes can be pinned before their inferred floor; affected scenes are flagged as time-travelling. When blocked, the floor is a hard constraint at edit time.
              </p>
            </div>
            */}

            <div>
              <label className={labelCls}>Time format</label>
              <ToggleInput
                value={timeFormat === '24h'}
                defaultValue={false}
                onLabel="24-hour"
                offLabel="12-hour"
                onCommit={(v) => setTimeFormat(v ? '24h' : '12h')}
              />
              <p className="text-[10px] text-zinc-500 mt-1">
                Display format for exact-clock pins. Internal storage is always 24-hour.
              </p>
            </div>

            <div>
              <label className={labelCls}>Week starts on</label>
              <ToggleInput
                value={weekStart === 'monday'}
                defaultValue={false}
                onLabel="Monday"
                offLabel="Sunday"
                onCommit={(v) => setWeekStart(v ? 'monday' : 'sunday')}
              />
              <p className="text-[10px] text-zinc-500 mt-1">
                Display order for weekday selectors. Storage is always Sun=0..Sat=6.
              </p>
            </div>

            <div>
              <label className={labelCls}>Gap-shift alert threshold</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={gapShiftValue}
                  onChange={(e) => setGapShiftValue(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                  className="w-20 bg-zinc-800 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
                />
                <select
                  value={gapShiftUnit}
                  onChange={(e) => setGapShiftUnit(e.target.value)}
                  className="bg-zinc-800 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
                >
                  <option value="minutes">Minutes</option>
                  <option value="hours">Hours</option>
                  <option value="days">Days</option>
                  <option value="weeks">Weeks</option>
                </select>
              </div>
              <p className="text-[10px] text-zinc-500 mt-1">
                When the walker recomputes a scene's Time Since Last Scene and the new value differs from the saved baseline by more than this, a notification fires. Smaller shifts are absorbed silently.
              </p>
            </div>
          </div>
        </section>

        {/* Phase 2.10a item 12 — story-side per-surface prompt overrides. */}
        <DefaultPromptOverridesSection
          overrides={promptOverrides}
          onChange={setPromptOverrides}
          prompts={systemPrompts}
          categories={systemPromptCategories}
          prefs={prefs}
        />

        {/* Awareness rollover check */}
        <section className="space-y-2">
          <header className={sectionHeaderCls}>Awareness checks</header>
          <div className="flex items-end gap-4">
            <ToggleInput
              value={awarenessRolloverCheckEnabled}
              defaultValue={true}
              onLabel="Enabled"
              offLabel="Disabled"
              onCommit={setAwarenessRolloverCheckEnabled}
            />
            <div className="text-[11px] text-zinc-500 leading-relaxed flex-1">
              Show this check on tracked-value changes. When a chain-anchor edit
              hits a value whose awareness layer is being tracked (with at least
              one observer), a small modal opens so you can adjust observer
              awareness for the change. Turn off to commit value changes silently;
              the tracking data is preserved either way.
            </div>
          </div>
        </section>

      </div>

      <SettingsTabFooter isDirty={isDirty} onSave={handleSave} onCancel={handleCancel} />
    </div>
  )
}

// ── Phase 5.2b — story cover control ─────────────────────────────
// The cover lives at the .nnz root as cover.jpg (not a Story model
// field), so it is managed directly against the backend working dir
// rather than through the panel's draft/Save. Setting or removing it
// takes effect immediately (like an entity profile-image upload) and
// flips the project's unsaved-changes flag so the header Save persists
// it into the archive. Reuses the shared crop host at a 2:3 book-cover
// ratio; a smaller source is never upscaled (capped at 1024x1536).
function StoryCoverField({ storyId, height }) {
  const fileInputRef = useRef(null)
  const [hasCover, setHasCover] = useState(null)
  const [token, setToken] = useState(0)   // cache-bust for the <img>
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const openImageCropModal = useUiStore((s) => s.openImageCropModal)

  // Read the derived has-cover flag on mount and whenever the active
  // project changes; bump the cache-bust token so the preview reloads
  // for the new project.
  useEffect(() => {
    let cancelled = false
    setError(null)
    axios.get('/api/project/cover/status')
      .then(({ data }) => { if (!cancelled) { setHasCover(!!data.has_cover); setToken((t) => t + 1) } })
      .catch(() => { if (!cancelled) setHasCover(false) })
    return () => { cancelled = true }
  }, [storyId])

  function handleFileSelect(e) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    const reader = new FileReader()
    reader.onload = (ev) => {
      openImageCropModal({
        imageSrc: ev.target.result,
        aspect: COVER_ASPECT,
        output: COVER_OUTPUT,
        title: 'Crop Cover',
        confirmLabel: 'Set Cover',
        onConfirm: handleCropConfirm,
      })
    }
    reader.readAsDataURL(file)
  }

  async function handleCropConfirm(blob) {
    if (!blob) return
    setError(null)
    try {
      const form = new FormData()
      form.append('file', blob, 'cover.jpg')
      await axios.put('/api/project/cover', form)
      setHasCover(true)
      setToken((t) => t + 1)
      try { useProjectStore.setState({ hasUnsavedChanges: true }) } catch { /* store not ready */ }
      useUiStore.getState().bumpCoverVersion()
    } catch {
      setError('Could not set the cover.')
    }
  }

  async function removeCover() {
    setBusy(true)
    setError(null)
    try {
      await axios.delete('/api/project/cover')
      setHasCover(false)
      setToken((t) => t + 1)
      try { useProjectStore.setState({ hasUnsavedChanges: true }) } catch { /* store not ready */ }
      useUiStore.getState().bumpCoverVersion()
    } catch {
      setError('Could not remove the cover.')
    } finally {
      setBusy(false)
    }
  }

  // The preview IS the control: its height is the measured Title/Author/
  // POV column height (passed in), width follows from the 2:3 ratio, and
  // clicking it sets / replaces the cover. A corner × removes it on hover.
  // Fall back to a sensible size until the first measurement lands.
  // Sized at 1.25x the field-column height so the cover reads as the
  // prominent element (it extends a little below the three fields).
  const baseH = height && height > 0 ? height : 168
  const h = Math.round(baseH * 1.25)
  const w = Math.round((h * 2) / 3)
  return (
    <div
      data-help-region="settings:cover"
      className="relative flex-shrink-0 rounded overflow-hidden border border-zinc-700 bg-zinc-900 group cursor-pointer"
      style={{ height: h, width: w }}
      onClick={() => fileInputRef.current?.click()}
      title={hasCover ? 'Click to replace the cover' : 'Click to set a cover'}
    >
      {hasCover ? (
        <img
          src={`/api/project/cover?v=${token}`}
          alt="Story cover"
          className="w-full h-full object-cover"
          onError={() => setHasCover(false)}
        />
      ) : (
        <CoverPlaceholder className="w-full h-full" />
      )}

      {/* hover affordance */}
      <div className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity text-white text-xs font-medium pointer-events-none">
        {hasCover ? 'Change' : 'Set cover'}
      </div>

      {/* remove (only when a cover is set) */}
      {hasCover && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); removeCover() }}
          disabled={busy}
          className="absolute top-1 right-1 w-5 h-5 flex items-center justify-center rounded bg-black/60 hover:bg-red-600 text-white text-sm leading-none opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-50"
          title="Remove cover"
        >
          ×
        </button>
      )}

      {error && (
        <div className="absolute bottom-0 inset-x-0 bg-red-900/80 text-red-100 text-[9px] text-center px-1 py-0.5">
          {error}
        </div>
      )}

      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileSelect} />
    </div>
  )
}

// ── Phase 2.10a item 12 — Default Prompt Overrides per Surface ───
// Story-scoped overrides for the four per-surface system prompt
// defaults. Each column shows the story override's current prompt
// name (or "Inherit") with a small grey "inherits from …" line when
// the slot is unset that reveals what system-wide default would
// apply. Clicking a column opens the bespoke `<SystemPromptPickerList>`
// flyout; picking a prompt sets the override, picking "No system
// prompt" sets the override to "(none)" (explicit per-story OFF
// regardless of the system-wide default).
//
// Note: a story-scoped explicit "No system prompt" override is
// distinguishable from "unset" by inspecting the stored value:
// `null` / undefined / absent slot means inherit; the explicit
// "(none)" pick maps to the string literal `'__none__'` so the
// downstream resolver can tell the difference. *(Future: if this
// distinction proves confusing, the picker could collapse "(none)"
// into "Inherit" — but the planning doc treats them as distinct.)*
function DefaultPromptOverridesSection({ overrides, onChange, prompts, categories, prefs }) {
  // Hover-flyout state — only one column open at a time. 500ms
  // grace mirrors the chat panel + PBH gear popover.
  const [openSurface, setOpenSurface] = useState(null)
  const closeTimerRef = useRef(null)
  function openFlyout(key) {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
    setOpenSurface(key)
  }
  function scheduleCloseFlyout() {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    closeTimerRef.current = setTimeout(() => {
      setOpenSurface(null)
      closeTimerRef.current = null
    }, 500)
  }
  // Per-column remembered open-category — persists across hover
  // open/close cycles within this section's mount.
  const [openKeys, setOpenKeys] = useState({
    chat_panel: null, scene_description_pbh: null, section_pbh: null, ipb: null,
  })
  function setOpenKey(surfaceKey, next) {
    setOpenKeys((prev) => ({ ...prev, [surfaceKey]: next }))
  }

  function setOverride(surfaceKey, value) {
    onChange((prev) => ({ ...(prev || {}), [surfaceKey]: value }))
    setOpenSurface(null)
  }

  function _resolveLabel(promptId) {
    if (promptId == null) return null
    const found = (prompts || []).find((p) => p.id === promptId)
    return found?.name || '(unknown prompt)'
  }

  return (
    <section className="space-y-2">
      <header className="text-[11px] font-semibold text-zinc-300 uppercase tracking-wider pb-1 mb-2 border-b border-zinc-700/60">
        Default Prompt Overrides per Surface
      </header>
      <p className="text-[11px] text-zinc-500 leading-relaxed">
        Set the default system prompt for each AI surface for this story only. Click a column to override; click it again to clear it back to Use Program Settings.
      </p>
      <div className="grid grid-cols-4 gap-2">
        {SURFACES.map((s) => {
          const slot = overrides?.[s.key] ?? null
          const stale = slot != null && !(prompts || []).find((p) => p.id === slot)
          const systemDefault = prefs?.default_prompts_per_surface?.[s.key]
            ?? (s.key === 'chat_panel' ? prefs?.default_system_prompt_id : null)
          // Primary value + secondary line:
          //   - slot unset: "Use Program Settings" + "Currently: <resolved name or No system prompt>"
          //   - slot = id:  "<prompt name>" + "(story override)"
          //   - stale id:   keep primary, secondary becomes the deletion warning
          let label
          let secondary
          if (slot == null) {
            label = 'Use Program Settings'
            const sysName = systemDefault ? (_resolveLabel(systemDefault) || systemDefault) : 'No system prompt'
            secondary = `Currently: ${sysName}`
          } else {
            label = _resolveLabel(slot)
            secondary = stale ? 'Prompt deleted — pick a new override.' : '(story override)'
          }
          return (
            <PopoverSectionRow
              key={s.key}
              label={s.label}
              value={label}
              secondary={secondary}
              isOpen={openSurface === s.key}
              onEnter={() => openFlyout(s.key)}
              onLeave={scheduleCloseFlyout}
              flyoutWidth={260}
              flyoutDataAttr="story-prompt-override-flyout"
              hideChevron
              centerContent
              trigger="click"
            >
              <SystemPromptPickerList
                prompts={prompts || []}
                categories={categories || []}
                noPromptLabel="Use Program Settings"
                activePromptId={slot ?? null}
                defaultPromptId={slot ?? null}
                onPick={(id) => {
                  // In Story Settings the picker's pinned no-prompt
                  // row is labelled "Use Program Settings" — picking
                  // it clears the slot to null (inherit). Picking a
                  // specific prompt sets the override; picking the
                  // already-selected prompt again also clears back
                  // to inherit (toggle).
                  if (id == null || id === slot) {
                    setOverride(s.key, null)
                  } else {
                    setOverride(s.key, id)
                  }
                }}
                controlledOpenKey={openKeys[s.key]}
                onOpenKeyChange={(k) => setOpenKey(s.key, k)}
              />
            </PopoverSectionRow>
          )
        })}
      </div>
    </section>
  )
}
