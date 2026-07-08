import { useSettingsStore } from '../../../store/settingsStore'
import { useUiStore } from '../../../store/uiStore'
import { useEffect, useRef, useState } from 'react'
import axios from 'axios'
import EntityColorPicker from '../../ui/EntityColorPicker'
import ToggleInput from '../../ui/ToggleInput'
import SettingsTabFooter from './SettingsTabFooter'
import {
  MODES as WIRE_VISIBILITY_MODES,
  WIRE_TYPES as WIRE_VISIBILITY_TYPES,
  MODE_HAS_TYPES as WIRE_VISIBILITY_MODE_HAS_TYPES,
  migrateWireVisibility,
} from '../../canvas/WireVisibilityControl'

const TENSE_OPTIONS = [
  { value: 'past',    label: 'Past' },
  { value: 'present', label: 'Present' },
]

const POV_TYPE_OPTIONS = [
  { value: '1st Person',             label: '1st Person' },
  { value: '2nd Person',             label: '2nd Person' },
  { value: '3rd Person',             label: '3rd Person' },
  { value: '3rd Person (Limited)',    label: '3rd Person (Limited)' },
  { value: '3rd Person (Omniscient)', label: '3rd Person (Omniscient)' },
]

const BUILT_IN_ACCENT_COLOR = '#7c3aed'
const BUILT_IN_POV_COLOR    = '#eab308'
const BUILT_IN_AUTOSAVE_INTERVAL_MINUTES = 5
// Phase 2.9a item 10 — editor read-aid zoom defaults / bounds.
const BUILT_IN_EDITOR_ZOOM = 100
const EDITOR_ZOOM_MIN = 50
const EDITOR_ZOOM_MAX = 200
const EDITOR_ZOOM_STEP = 10

// Cheap JSON-based equality used for the dirty check. The
// preferences object is shallow except for `default_gap_shift_threshold`
// (a TimeDelta {unit, value}); JSON.stringify deals with both
// without writing a custom deep-equal. Acceptable here because the
// object is small and stringification fires only when the draft or
// the cached prefs change.
function shallowEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

// Visual classes matching StorySettingsTab
const inputCls        = 'w-full bg-zinc-800 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500'
const selectCls       = inputCls + ' appearance-none'
const sectionCls      = 'rounded border border-zinc-700/60 bg-zinc-900/40 px-4 py-3 space-y-3'
const sectionHdrCls   = 'text-[11px] font-semibold text-zinc-300 uppercase tracking-wider pb-1 mb-2 border-b border-zinc-700/60'
const labelCls        = 'text-[11px] text-zinc-400'

export default function ProgramSettingsTab({ onClose, onDirtyChange, registerSave }) {
  const loaded    = useSettingsStore((s) => s.loaded)
  const loadError = useSettingsStore((s) => s.loadError)
  const loading   = useSettingsStore((s) => s.loading)
  const saveError = useSettingsStore((s) => s.saveError)
  const prefs     = useSettingsStore((s) => s.preferences)
  const updatePreferences = useSettingsStore((s) => s.updatePreferences)

  // Local draft layer — mirrors prefs at mount / panel-open and
  // accumulates field edits until the user commits via Save (or
  // discards via Cancel). Matches the explicit Save/Cancel pattern
  // used by StorySettingsTab so nothing writes to the backend until
  // the user explicitly opts in.
  const [draft, setDraft] = useState(prefs)
  // When the cached prefs object changes underneath us (e.g. an
  // initial fetch completes after this component already mounted),
  // refresh the draft so the visible state reflects what's actually
  // saved on disk.
  useEffect(() => { setDraft(prefs) }, [prefs])

  // Dirty status for the panel-level guard. Shallow-compare the draft
  // against the cached prefs over the union of keys so an extra field
  // on either side still trips the dirty flag.
  const isDirty = !shallowEqual(draft, prefs)
  // Stash the latest onDirtyChange in a ref so the emit / unmount
  // effects don't re-fire whenever the parent passes a fresh inline
  // arrow. Without this, the parent's setState-in-callback creates
  // an infinite re-render loop.
  const onDirtyChangeRef = useRef(onDirtyChange)
  useEffect(() => { onDirtyChangeRef.current = onDirtyChange }, [onDirtyChange])
  useEffect(() => {
    onDirtyChangeRef.current?.(isDirty)
  }, [isDirty])
  // On unmount, clear the dirty flag — drafts vanish with the
  // component so the panel shouldn't keep prompting about them.
  useEffect(() => () => onDirtyChangeRef.current?.(false), [])

  function commit(field, value) {
    setDraft((d) => ({ ...d, [field]: value }))
  }

  // saveDraft writes the current draft to the backend and clears
  // the dirty flag — but does NOT close the panel. Used by the
  // panel's "Save & continue" branch so the user can navigate
  // (tab switch, panel close) without losing edits.
  function saveDraft() {
    updatePreferences(draft)
    onDirtyChangeRef.current?.(false)
  }
  // Stash saveDraft in a ref + register it once, so the parent
  // always invokes the latest closure without us re-registering on
  // every render.
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
    updatePreferences(draft)
    onDirtyChange?.(false)
  }
  function handleCancel() {
    onDirtyChange?.(false)  // explicit cancel = explicit discard
    onClose?.()
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <ScopeBanner />

        {loadError && (
          <div className="rounded border border-red-700/50 bg-red-900/20 px-3 py-2 text-xs text-red-200">
            Couldn&apos;t load user preferences: {loadError}
          </div>
        )}
        {saveError && (
          <div className="rounded border border-red-700/50 bg-red-900/20 px-3 py-2 text-xs text-red-200">
            Couldn&apos;t save: {saveError}
          </div>
        )}
        {!loaded && !loadError && loading && (
          <div className="text-xs text-zinc-500">Loading preferences…</div>
        )}

        {loaded && (
          <>
            <StoryMetadataSection prefs={draft} commit={commit} />
            <StructureSection prefs={draft} commit={commit} />
            <ColourSection prefs={draft} commit={commit} />
            <AutosaveSection prefs={draft} commit={commit} />
            <AwarenessRolloverSection prefs={draft} commit={commit} />
            <TimeTrackingSection prefs={draft} commit={commit} />
            <ApplicationSection prefs={draft} commit={commit} />
            <LayoutDefaultSection />
            <FileAssociationSection />
            <ComingSoonSection
              title="Seeds file"
              note={
                <>
                  Default seeds live in their own file and are edited in the{' '}
                  <span className="font-semibold">Default Seeds</span> tab — not here.
                  A future commit will wire <code className="px-1 py-0.5 bg-zinc-700/60 rounded text-[11px]">newProject()</code>{' '}
                  to copy them into each new project at creation time.
                </>
              }
            />
          </>
        )}
      </div>

      <SettingsTabFooter isDirty={isDirty} onSave={handleSave} onCancel={handleCancel} />
    </div>
  )
}

// ── Story metadata ────────────────────────────────────────────────
function StoryMetadataSection({ prefs, commit }) {
  return (
    <section data-help-region="settings:program_story_metadata" className={sectionCls}>
      <header className={sectionHdrCls}>Story metadata</header>

      <div>
        <FieldLabel label="Author name" value={prefs.author_name} onReset={() => commit('author_name', null)} />
        <TextInput value={prefs.author_name} placeholder="Optional" onCommit={(v) => commit('author_name', v)} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <FieldLabel label="Tense" value={prefs.default_tense} onReset={() => commit('default_tense', null)} />
          <SelectInput value={prefs.default_tense} options={TENSE_OPTIONS} placeholder="Not set" onCommit={(v) => commit('default_tense', v)} />
        </div>
        <div>
          <FieldLabel label="POV Type Default" value={prefs.default_pov_type} onReset={() => commit('default_pov_type', null)} />
          <SelectInput value={prefs.default_pov_type} options={POV_TYPE_OPTIONS} placeholder="Not set" onCommit={(v) => commit('default_pov_type', v)} />
        </div>
      </div>

      <div>
        <FieldLabel label="Language" value={prefs.default_language} onReset={() => commit('default_language', null)} />
        <TextInput value={prefs.default_language} placeholder="Optional" onCommit={(v) => commit('default_language', v)} />
      </div>
    </section>
  )
}

// ── Structure ─────────────────────────────────────────────────────
function StructureSection({ prefs, commit }) {
  return (
    <section data-help-region="settings:program_structure" className={sectionCls}>
      <header className={sectionHdrCls}>Structure</header>

      <div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel label="Chapter label" value={prefs.default_chapter_label} onReset={() => commit('default_chapter_label', null)} />
            <TextInput value={prefs.default_chapter_label} placeholder='default: "Chapter"' onCommit={(v) => commit('default_chapter_label', v)} />
          </div>
          <div>
            <FieldLabel label="Act label" value={prefs.default_act_label} onReset={() => commit('default_act_label', null)} />
            <TextInput value={prefs.default_act_label} placeholder='default: "Act"' onCommit={(v) => commit('default_act_label', v)} />
          </div>
        </div>
        <p className="text-[10px] text-zinc-500 mt-1">
          Override the &quot;Chapter&quot; and &quot;Act&quot; terms used in canvas column headers. Leave empty for defaults.
        </p>
      </div>

      <div>
        <div className="flex items-center gap-2">
          <ToggleInput
            value={prefs.default_chapter_tint_behind_nodes}
            defaultValue={true}
            onLabel="Tint behind scenes"
            offLabel="Tint over scenes"
            onCommit={(v) => commit('default_chapter_tint_behind_nodes', v)}
          />
          {prefs.default_chapter_tint_behind_nodes != null && (
            <ResetBtn onClick={() => commit('default_chapter_tint_behind_nodes', null)} />
          )}
        </div>
        <p className="text-[10px] text-zinc-500 mt-1">
          On: scene nodes render on top of chapter column colours (default). Off: column tint bleeds through nodes as a subtle wash.
        </p>
      </div>
    </section>
  )
}

// ── Colours ───────────────────────────────────────────────────────
function ColourSection({ prefs, commit }) {
  return (
    <section data-help-region="settings:program_colours" className={sectionCls}>
      <header className={sectionHdrCls}>Colours</header>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={`${labelCls} block mb-1`}>Accent Colour</label>
          <ColourInput
            value={prefs.default_accent_color}
            builtInDefault={BUILT_IN_ACCENT_COLOR}
            onCommit={(v) => commit('default_accent_color', v)}
            onReset={() => commit('default_accent_color', null)}
          />
        </div>
        <div>
          <label className={`${labelCls} block mb-1`}>POV Colour</label>
          <ColourInput
            value={prefs.default_pov_color}
            builtInDefault={BUILT_IN_POV_COLOR}
            onCommit={(v) => commit('default_pov_color', v)}
            onReset={() => commit('default_pov_color', null)}
          />
        </div>
      </div>
    </section>
  )
}

// ── Auto-save ─────────────────────────────────────────────────────
function AutosaveSection({ prefs, commit }) {
  const autosaveOn = prefs.default_autosave_enabled ?? true

  return (
    <section data-help-region="settings:program_autosave" className={sectionCls}>
      <header className={sectionHdrCls}>Auto-save</header>

      <div className="flex items-end gap-4">
        <div className="flex items-center gap-2">
          <ToggleInput
            value={prefs.default_autosave_enabled}
            defaultValue={true}
            onLabel="On by default"
            offLabel="Off by default"
            onCommit={(v) => commit('default_autosave_enabled', v)}
          />
          {prefs.default_autosave_enabled != null && (
            <ResetBtn onClick={() => commit('default_autosave_enabled', null)} />
          )}
        </div>
        <div className={autosaveOn ? '' : 'opacity-50 pointer-events-none'}>
          <FieldLabel label="Interval (minutes)" value={prefs.default_autosave_interval_minutes} onReset={() => commit('default_autosave_interval_minutes', null)} />
          <NumberInput
            value={prefs.default_autosave_interval_minutes}
            min={1}
            placeholder={`${BUILT_IN_AUTOSAVE_INTERVAL_MINUTES}`}
            onCommit={(v) => commit('default_autosave_interval_minutes', v)}
          />
        </div>
      </div>
      <p className="text-[11px] text-zinc-500 leading-relaxed">
        Writes to a sibling file named <code className="px-1 py-0.5 bg-zinc-700/60 rounded text-[10px]">&lt;name&gt;_autosave.nnz</code> in the same folder.
        Skipped until the project has been saved at least once.
      </p>
    </section>
  )
}

// ── Awareness rollover default (story-level) ───────────────────────
function AwarenessRolloverSection({ prefs, commit }) {
  return (
    <section data-help-region="settings:program_awareness_checks" className={sectionCls}>
      <header className={sectionHdrCls}>Awareness checks</header>
      <p className="text-[11px] text-zinc-500 leading-relaxed">
        Default for new stories. Each story carries its own override under
        Story Settings → Awareness checks.
      </p>
      <div className="flex items-center gap-2">
        <ToggleInput
          value={prefs.default_awareness_rollover_check_enabled}
          defaultValue={true}
          onLabel="On by default"
          offLabel="Off by default"
          onCommit={(v) => commit('default_awareness_rollover_check_enabled', v)}
        />
        {prefs.default_awareness_rollover_check_enabled != null && (
          <ResetBtn onClick={() => commit('default_awareness_rollover_check_enabled', null)} />
        )}
      </div>
      <p className="text-[11px] text-zinc-500 leading-relaxed">
        When on, a small modal opens whenever a chain-anchor edit hits a value
        whose awareness layer has tracking enabled (with at least one
        observer), so you can adjust observer awareness for the change.
      </p>
    </section>
  )
}

// ── Time Tracking defaults (Phase 1.23 §7) ──────────────────────
function TimeTrackingSection({ prefs, commit }) {
  const masterOn = prefs.default_time_tracking_enabled ?? false
  const threshold = prefs.default_gap_shift_threshold
  const thresholdValue = Number.isFinite(threshold?.value) ? threshold.value : null
  const thresholdUnit  = threshold?.unit || null

  function commitThresholdValue(nextValue) {
    if (nextValue == null) {
      commit('default_gap_shift_threshold', null)
      return
    }
    commit('default_gap_shift_threshold', {
      unit: thresholdUnit || 'days',
      value: nextValue,
    })
  }
  function commitThresholdUnit(nextUnit) {
    if (thresholdValue == null) {
      // No override yet — just establish the unit by writing a full
      // override using the shipped default value of 1.
      commit('default_gap_shift_threshold', { unit: nextUnit, value: 1 })
      return
    }
    commit('default_gap_shift_threshold', { unit: nextUnit, value: thresholdValue })
  }

  return (
    <section data-help-region="settings:program_time_tracking" className={sectionCls}>
      <header className={sectionHdrCls}>Time Tracking</header>
      <p className="text-[11px] text-zinc-500 leading-relaxed">
        Defaults for new stories. Each story carries its own overrides under
        Story Settings → Time Tracking.
      </p>

      <div className="flex items-center gap-2">
        <ToggleInput
          value={prefs.default_time_tracking_enabled}
          defaultValue={false}
          onLabel="On by default"
          offLabel="Off by default"
          onCommit={(v) => commit('default_time_tracking_enabled', v)}
        />
        {prefs.default_time_tracking_enabled != null && (
          <ResetBtn onClick={() => commit('default_time_tracking_enabled', null)} />
        )}
      </div>

      <div className={masterOn ? 'space-y-3 pt-1' : 'space-y-3 pt-1 opacity-50 pointer-events-none'}>
        {/*
          Phase 1.23 step 14 — "Allow Negative Time (time travel)"
          program-default control parked on v0.1.23.15. The
          UserPreferences.default_allow_negative_time field and the
          backend `_PREFS_TO_STORY` mapping remain in place; the
          default value stays `false` until the feature is unparked.
          Re-enable when the writer-facing surface is delivered.
        <div>
          <div className="flex items-baseline justify-between mb-1">
            <span className={labelCls}>Allow Negative Time (time travel)</span>
            {prefs.default_allow_negative_time != null && (
              <ResetBtn onClick={() => commit('default_allow_negative_time', null)} />
            )}
          </div>
          <ToggleInput
            value={prefs.default_allow_negative_time}
            defaultValue={false}
            onLabel="Allowed by default"
            offLabel="Blocked by default"
            onCommit={(v) => commit('default_allow_negative_time', v)}
          />
        </div>
        */}

        <div>
          <div className="flex items-baseline justify-between mb-1">
            <span className={labelCls}>Time format</span>
            {prefs.default_time_format != null && (
              <ResetBtn onClick={() => commit('default_time_format', null)} />
            )}
          </div>
          <ToggleInput
            value={prefs.default_time_format === '24h'}
            defaultValue={false}
            onLabel="24-hour"
            offLabel="12-hour"
            onCommit={(v) => commit('default_time_format', v ? '24h' : '12h')}
          />
        </div>

        <div>
          <div className="flex items-baseline justify-between mb-1">
            <span className={labelCls}>Week starts on</span>
            {prefs.default_week_start != null && (
              <ResetBtn onClick={() => commit('default_week_start', null)} />
            )}
          </div>
          <ToggleInput
            value={prefs.default_week_start === 'monday'}
            defaultValue={false}
            onLabel="Monday"
            offLabel="Sunday"
            onCommit={(v) => commit('default_week_start', v ? 'monday' : 'sunday')}
          />
        </div>

        <div>
          <div className="flex items-baseline justify-between mb-1">
            <span className={labelCls}>Gap-shift alert threshold</span>
            {threshold != null && (
              <ResetBtn onClick={() => commit('default_gap_shift_threshold', null)} />
            )}
          </div>
          <div className="flex items-center gap-2">
            <NumberInput
              value={thresholdValue}
              min={0}
              placeholder="1"
              onCommit={commitThresholdValue}
            />
            <select
              value={thresholdUnit || 'days'}
              onChange={(e) => commitThresholdUnit(e.target.value)}
              className={selectCls + ' w-32'}
            >
              <option value="minutes">Minutes</option>
              <option value="hours">Hours</option>
              <option value="days">Days</option>
              <option value="weeks">Weeks</option>
            </select>
          </div>
        </div>
      </div>
    </section>
  )
}

// ── Application (program-only) ───────────────────────────────────
function ApplicationSection({ prefs, commit }) {
  return (
    <section data-help-region="settings:program_application" className={sectionCls}>
      <header className={sectionHdrCls}>Application</header>
      <p className="text-[11px] text-zinc-500 leading-relaxed">
        Session preferences applied on every launch. Not stored in any project file.
      </p>

      <div data-help-region="settings:program_snap_to_grid" className="flex items-center gap-2">
        <ToggleInput
          value={prefs.snap_to_grid_default}
          defaultValue={false}
          onLabel="Snap to grid on by default"
          offLabel="Snap to grid off by default"
          onCommit={(v) => commit('snap_to_grid_default', v)}
        />
        {prefs.snap_to_grid_default != null && (
          <ResetBtn onClick={() => commit('snap_to_grid_default', null)} />
        )}
      </div>

      <div data-help-region="settings:program_wire_visibility">
        <FieldLabel
          label="Default wire visibility mode"
          value={prefs.default_wire_visibility_mode}
          onReset={() => {
            commit('default_wire_visibility_mode', null)
            commit('default_wire_visibility_types', null)
          }}
        />
        {(() => {
          const { mode: curMode, types: curTypes } = migrateWireVisibility(
            prefs.default_wire_visibility_mode,
            prefs.default_wire_visibility_types,
          )
          return (
            <div className="flex flex-col items-center gap-1.5">
              {[WIRE_VISIBILITY_MODES.slice(0, 2), WIRE_VISIBILITY_MODES.slice(2)].map((row, ri) => (
                <div key={ri} className="flex justify-center gap-1.5">
                  {row.map((m) => {
                    const MIcon = m.Icon
                    const selected = curMode === m.key
                    return (
                      <button
                        key={m.key}
                        type="button"
                        onClick={() => commit('default_wire_visibility_mode', m.key === 'all' ? null : m.key)}
                        title={m.tip}
                        className={`flex items-center gap-1.5 px-2 py-1 rounded border text-[11px] transition-colors ${
                          selected
                            ? 'border-accent-500 bg-accent-700/30 text-zinc-100'
                            : 'border-zinc-700 text-zinc-400 hover:bg-zinc-700/40 hover:text-zinc-200'
                        }`}
                      >
                        <span className="inline-flex items-center justify-center" style={{ width: 16, height: 16 }}>
                          <MIcon />
                        </span>
                        <span>{m.label}</span>
                      </button>
                    )
                  })}
                </div>
              ))}
              {WIRE_VISIBILITY_MODE_HAS_TYPES(curMode) && (
                <div className="flex justify-center gap-3 mt-0.5">
                  {WIRE_VISIBILITY_TYPES.map((t) => (
                    <label key={t.key} className="flex items-center gap-1 text-[11px] text-zinc-300 cursor-pointer">
                      <input
                        type="checkbox"
                        className="accent-accent-500"
                        checked={!!curTypes[t.key]}
                        onChange={(e) => commit('default_wire_visibility_types', { ...curTypes, [t.key]: e.target.checked })}
                      />
                      <span>{t.label}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )
        })()}
        <p className="text-[10px] text-zinc-500 mt-1 leading-relaxed">
          The canvas starts in this wire-visibility mode each session. Switching modes during a session isn&apos;t remembered, it resets to this default on the next launch.
        </p>
      </div>

      {/* Phase 5.3c — story library master toggle, with the Phase 5.5c
          "show on startup" sub-toggle nested beneath it. */}
      <div data-help-region="settings:program_project_library">
        <ToggleInput
          value={prefs.use_project_library !== false}
          defaultValue={true}
          onLabel="Use the project library"
          offLabel="Project library off"
          onCommit={(v) => commit('use_project_library', v)}
        />
        <p className="text-[10px] text-zinc-500 mt-1 leading-relaxed">
          Opening or saving a project adds it to your library so you can find and reopen it later. When off, nothing is recorded to the library and it stays hidden.
        </p>
        <div className={`mt-3 ml-4 pl-3 border-l border-zinc-700 ${prefs.use_project_library === false ? 'opacity-40 pointer-events-none' : ''}`}>
          <ToggleInput
            value={prefs.show_library_on_startup !== false}
            defaultValue={true}
            onLabel="Show the library on startup"
            offLabel="Don't show the library on startup"
            onCommit={(v) => commit('show_library_on_startup', v)}
          />
          <p className="text-[10px] text-zinc-500 mt-1 leading-relaxed">
            Open the Story Library automatically when the app launches, over a fresh blank story. You can also toggle this from the checkbox in the library's bottom-left corner.
          </p>
        </div>
      </div>

      {/* Phase 5.7 — Disable AI integrations. Hides every AI-related UI
          surface so the program can be used purely as a planner. `prefs`
          here is the section's live draft (passed in as prefs={draft}), so
          the controlled toggle reflects the click immediately; the surfaces
          and teardown act on the saved preference once the writer hits
          Save. */}
      <div data-help-region="settings:program_disable_ai">
        <ToggleInput
          value={prefs.disable_ai_integrations === true}
          defaultValue={false}
          onLabel="AI integrations disabled"
          offLabel="AI integrations enabled"
          onCommit={(v) => commit('disable_ai_integrations', v)}
        />
        <p className="text-[10px] text-zinc-500 mt-1 leading-relaxed">
          When on, hides all AI features: the MCP server controls, the AI chat panel and its show/hide button, the "talk to this character" and "add as context" buttons, the AI insert tools in the editor, the MCP and System Prompts settings tabs, and the AI refine option when importing. Turning it on ends any active AI session and stops the MCP server. Turn it off to bring everything back.
        </p>
      </div>

      {/* Deletion confirmation — gate the delete dialog's type-the-name
          step. On by default; off keeps the same dialog but enables the
          delete button immediately. */}
      <div data-help-region="settings:program_require_typed_name_delete">
        <label className={`${labelCls} block mb-1`}>Require typing an object's name to confirm deletion</label>
        <ToggleInput
          value={prefs.require_typed_name_to_delete !== false}
          defaultValue={true}
          onLabel="On — type the name before deleting"
          offLabel="Off — delete button enabled immediately"
          onCommit={(v) => commit('require_typed_name_to_delete', v)}
        />
        <p className="text-[10px] text-zinc-500 mt-1 leading-relaxed">
          When on (the default), the delete confirmation dialog requires you to type the object's name before the delete button activates, a guard against accidental deletion. When off, the same dialog still appears, but the delete button is enabled immediately with no name to type.
        </p>
      </div>

      {/* Phase 2.9a item 10 — Default editor zoom level. The footer
          slider in the editor panel starts at this value on every
          editor mount and the reset affordance reverts to it.
          Range 50-200 in 10% increments. Pure display zoom; does
          NOT change any document's stored font-size. */}
      <div data-help-region="settings:program_editor_zoom">
        <FieldLabel
          label="Default editor zoom level (%)"
          value={prefs.editor_default_zoom_level}
          onReset={() => commit('editor_default_zoom_level', null)}
        />
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={EDITOR_ZOOM_MIN}
            max={EDITOR_ZOOM_MAX}
            step={EDITOR_ZOOM_STEP}
            value={prefs.editor_default_zoom_level ?? BUILT_IN_EDITOR_ZOOM}
            onChange={(e) => commit('editor_default_zoom_level', Number(e.target.value))}
            className="flex-1 accent-accent-500"
          />
          <span className="text-xs text-zinc-400 w-12 text-right tabular-nums">
            {prefs.editor_default_zoom_level ?? BUILT_IN_EDITOR_ZOOM}%
          </span>
        </div>
      </div>

      {/* Phase 2.4 — Chat input keybind. Lets the writer flip
          which of Enter / Ctrl+Enter sends vs inserts a newline
          in the AI chat input. Default matches every typical
          chat app (Enter sends). */}
      <div data-help-region="settings:program_chat_keybind">
        <label className={`${labelCls} block mb-1`}>AI chat input keybind</label>
        <div className="flex items-center gap-2">
          <ToggleInput
            value={prefs.chat_send_on_enter}
            defaultValue={true}
            onLabel="Enter sends, Shift+Enter for newline"
            offLabel="Ctrl+Enter sends, Enter for newline"
            onCommit={(v) => commit('chat_send_on_enter', v)}
          />
          {prefs.chat_send_on_enter != null && (
            <ResetBtn onClick={() => commit('chat_send_on_enter', null)} />
          )}
        </div>
        <p className="text-[10px] text-zinc-500 mt-1 leading-relaxed">
          Pick the second mode if you do a lot of multi-line drafting in the chat input and want Enter to behave like a regular textarea.
        </p>
      </div>
    </section>
  )
}

// ── Panel layout default snapshot ────────────────────────────────
// Immediate-action section: the buttons write directly to
// `user_preferences.json` (PUT /settings with the updated
// `default_panel_layout` field) and to localStorage, bypassing the
// surrounding draft / Save / Cancel flow. The layout snapshot is its
// own concern — committing other unrelated preference edits at the
// same time isn't required.
function LayoutDefaultSection() {
  const prefs = useSettingsStore((s) => s.preferences)
  const savedLayout = prefs.default_panel_layout
  const [busy,   setBusy]   = useState(false)
  const [status, setStatus] = useState(null) // 'saved' | 'reset' | 'error' | null
  const [errMsg, setErrMsg] = useState('')

  // Helpful summary of what's currently saved (or "Built-in default" when
  // the writer hasn't saved a custom layout).
  let summary = 'Using built-in default layout.'
  if (savedLayout) {
    const editorZ = savedLayout.editor_zone || 'right'
    const chatZ = savedLayout.chat_zone || 'right'
    summary = `Saved: editor in ${editorZ} zone, chat in ${chatZ} zone.`
  }

  async function saveCurrentAsDefault() {
    setBusy(true)
    setStatus(null)
    setErrMsg('')
    try {
      const snapshot = useUiStore.getState().getCurrentLayoutSnapshot()
      const next = { ...prefs, default_panel_layout: snapshot }
      const { data } = await axios.put('/api/settings', next)
      // The PUT response is the canonical state.
      useSettingsStore.setState({ preferences: { ...useSettingsStore.getState().preferences, ...data } })
      setStatus('saved')
    } catch (err) {
      setStatus('error')
      setErrMsg(err?.response?.data?.detail || err.message || 'Failed to save layout default.')
    } finally {
      setBusy(false)
    }
  }

  async function resetToDefault() {
    setBusy(true)
    setStatus(null)
    setErrMsg('')
    try {
      const next = { ...prefs, default_panel_layout: null }
      const { data } = await axios.put('/api/settings', next)
      useSettingsStore.setState({ preferences: { ...useSettingsStore.getState().preferences, ...data, default_panel_layout: null } })
      // Wipe localStorage layout keys and revert in-memory uiStore so the
      // canvas reflects the factory defaults immediately.
      useUiStore.getState().resetLayoutToFactoryDefaults()
      setStatus('reset')
    } catch (err) {
      setStatus('error')
      setErrMsg(err?.response?.data?.detail || err.message || 'Failed to reset layout default.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section data-help-region="settings:program_panel_layout" className={sectionCls}>
      <header className={sectionHdrCls}>Panel layout</header>
      <p className="text-[11px] text-zinc-500 leading-relaxed">
        Save the current arrangement of the Editor and Chat panels (which zone each is docked to, whether they're open, their sizes, and the editor / chat split when they share a zone) as your default. Applied on the next launch when this machine has no in-session layout cached.
      </p>
      <p className="text-[11px] text-zinc-400">{summary}</p>
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={saveCurrentAsDefault}
          disabled={busy}
          className="px-3 py-1.5 text-xs bg-accent-700 hover:bg-accent-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded transition-colors"
        >
          Save current layout as default
        </button>
        <button
          type="button"
          onClick={resetToDefault}
          disabled={busy}
          className="px-3 py-1.5 text-xs bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 disabled:cursor-not-allowed text-zinc-100 rounded transition-colors"
        >
          Reset layout to default
        </button>
        {status === 'saved' && <span className="text-[11px] text-emerald-400">Saved.</span>}
        {status === 'reset' && <span className="text-[11px] text-emerald-400">Reset to built-in default.</span>}
        {status === 'error' && <span className="text-[11px] text-red-400">{errMsg}</span>}
      </div>
    </section>
  )
}

// ── File-type association ────────────────────────────────────────
function FileAssociationSection() {
  const [supported,  setSupported]  = useState(null)
  const [registered, setRegistered] = useState(false)
  const [busy,       setBusy]       = useState(false)
  const [error,      setError]      = useState(null)

  useEffect(() => {
    let cancelled = false
    axios.get('/api/settings/file-association').then((res) => {
      if (cancelled) return
      setSupported(res.data.supported)
      setRegistered(res.data.registered)
    }).catch((e) => {
      if (cancelled) return
      setSupported(false)
      setError(e?.message || 'Failed to query file-association status')
    })
    return () => { cancelled = true }
  }, [])

  if (supported === null) return null
  if (supported === false) return null

  async function toggle() {
    setBusy(true)
    setError(null)
    const url = registered ? '/api/settings/file-association/unregister' : '/api/settings/file-association/register'
    try {
      const res = await axios.post(url)
      setRegistered(res.data.registered)
    } catch (e) {
      setError(e?.response?.data?.detail || e?.message || 'Action failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section data-help-region="settings:program_file_association" className={sectionCls}>
      <header className={sectionHdrCls}>File-type association</header>
      <p className="text-[11px] text-zinc-500 leading-relaxed">
        When registered, double-clicking a <code className="px-1 py-0.5 bg-zinc-700/60 rounded text-[11px]">.nnz</code>{' '}
        file in Windows Explorer opens it with NarrativeNode. Registration is per-user and points at this repo&apos;s{' '}
        <code className="px-1 py-0.5 bg-zinc-700/60 rounded text-[11px]">run.bat</code>.
      </p>
      <div className="flex items-center gap-3 pt-1">
        <span className="flex-1 text-xs text-zinc-300">
          Status: {registered
            ? <span className="text-emerald-400 font-medium">Registered</span>
            : <span className="text-zinc-500">Not registered</span>}
        </span>
        <button
          onClick={toggle}
          disabled={busy}
          className={`px-3 py-1 text-xs rounded border ${
            registered
              ? 'border-zinc-600 text-zinc-300 hover:bg-zinc-700/40'
              : 'border-emerald-700 bg-emerald-700/30 text-emerald-100 hover:bg-emerald-700/50'
          } disabled:opacity-50 disabled:cursor-wait`}
        >
          {busy ? '…' : registered ? 'Unregister' : 'Register'}
        </button>
      </div>
      {error && <div className="text-[11px] text-red-300 pt-1">{error}</div>}
    </section>
  )
}

// ── Shared helpers ───────────────────────────────────────────────

// Label row with an optional ↺ reset button that appears only when a value is set.
function FieldLabel({ label, value, onReset }) {
  const isSet = value != null && value !== ''
  return (
    <div className="flex items-baseline justify-between mb-1">
      <span className={labelCls}>{label}</span>
      {isSet && <ResetBtn onClick={onReset} />}
    </div>
  )
}

function ResetBtn({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[10px] text-zinc-600 hover:text-zinc-400 leading-none"
      title="Clear this override"
    >↺</button>
  )
}

// Controlled text input — commits on blur.
function TextInput({ value, placeholder, onCommit }) {
  const [draft, setDraft] = useState(value || '')
  useEffect(() => {
    const t = setTimeout(() => setDraft(value || ''), 0)
    return () => clearTimeout(t)
  }, [value])

  function handleBlur() {
    const trimmed = draft.trim()
    const next = trimmed === '' ? null : trimmed
    if (next !== (value ?? null)) onCommit(next)
  }

  return (
    <input
      type="text"
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={handleBlur}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
      className={inputCls}
    />
  )
}

// Native select — commits on change.
function SelectInput({ value, options, placeholder, onCommit }) {
  return (
    <select
      value={value || ''}
      onChange={(e) => onCommit(e.target.value === '' ? null : e.target.value)}
      className={selectCls}
    >
      <option value="">{placeholder}</option>
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </select>
  )
}

// Integer input — commits on blur. Empty = null; invalid reverts.
function NumberInput({ value, min = 0, placeholder, onCommit }) {
  const [draft, setDraft] = useState(value == null ? '' : String(value))
  useEffect(() => {
    const t = setTimeout(() => setDraft(value == null ? '' : String(value)), 0)
    return () => clearTimeout(t)
  }, [value])

  function handleBlur() {
    const trimmed = draft.trim()
    if (trimmed === '') { if (value != null) onCommit(null); return }
    const n = parseInt(trimmed, 10)
    if (!Number.isFinite(n) || n < min) { setDraft(value == null ? '' : String(value)); return }
    if (n !== value) onCommit(n)
  }

  return (
    <input
      type="number"
      value={draft}
      min={min}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={handleBlur}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
      className={inputCls}
    />
  )
}

// Colour swatch + picker + editable hex input + reset button — matching Story Settings layout.
function ColourInput({ value, builtInDefault, onCommit, onReset }) {
  const effective = value || builtInDefault
  const isOverride = !!value
  const anchorRef = useRef(null)
  const [isOpen, setIsOpen] = useState(false)
  const [draft, setDraft] = useState(effective)

  useEffect(() => { setDraft(value || builtInDefault) }, [value, builtInDefault])

  function handleHexBlur() {
    const v = draft.trim()
    if (/^#[0-9a-fA-F]{6}$/.test(v) && v !== effective) onCommit(v)
    else setDraft(effective)
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        ref={anchorRef}
        onClick={() => setIsOpen((o) => !o)}
        className="w-7 h-7 rounded border border-zinc-600 cursor-pointer flex-shrink-0"
        style={{ background: effective }}
        aria-label={`Colour: ${effective}. Click to open picker.`}
      />
      <EntityColorPicker
        value={effective}
        onChange={onCommit}
        anchorEl={anchorRef.current}
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
      />
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={handleHexBlur}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
        className="flex-1 bg-zinc-800 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500 font-mono"
      />
      <button
        type="button"
        onClick={onReset}
        disabled={!isOverride}
        className="text-[9px] text-zinc-500 hover:text-zinc-300 disabled:text-zinc-700 disabled:cursor-default border border-zinc-600 rounded px-1.5 py-0.5"
        title={isOverride ? 'Reset to built-in default' : 'Already using built-in default'}
      >↺</button>
    </div>
  )
}

// ── Scope banner ─────────────────────────────────────────────────
function ScopeBanner() {
  return (
    <div className="rounded border border-sky-700/50 bg-sky-900/20 px-3 py-2 text-[11px] text-sky-200 space-y-1.5">
      <div>
        <span className="font-semibold">Whole-program settings.</span>{' '}
        These apply to every <span className="font-semibold">new</span>{' '}
        project you create — they pre-fill the relevant fields so you don&apos;t have to set them by hand every time.
      </div>
      <div>
        Existing projects aren&apos;t touched. To change settings on a project that already exists, open it and use the{' '}
        <span className="font-semibold">Story Settings</span> tab instead.
      </div>
      <div className="text-sky-300/80">
        Stored in{' '}
        <code className="px-1 py-0.5 bg-sky-950/60 rounded text-[10px]">preferences/user_preferences.json</code>{' '}
        alongside the app, outside any project.
      </div>
    </div>
  )
}

// ── Coming-soon placeholder ──────────────────────────────────────
function ComingSoonSection({ title, note }) {
  return (
    <section className="rounded border border-zinc-700/60 bg-zinc-900/40 px-3 py-2.5 space-y-1">
      <div className="text-[11px] font-semibold text-zinc-300 uppercase tracking-wider">{title}</div>
      <div className="text-[11px] text-zinc-500 leading-relaxed">{note}</div>
    </section>
  )
}
