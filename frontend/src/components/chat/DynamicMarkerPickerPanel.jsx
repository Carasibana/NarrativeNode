import { useMemo, useState } from 'react'
import DynamicBoltIcon from '../ui/DynamicBoltIcon'
import { MARKER_TYPES, defaultMarker, markerKey } from '../../utils/dynamicMarkers'

/**
 * DynamicMarkerPickerPanel — Phase 2.10b item 9.
 *
 * Picker for the 17 Tier 2 marker types (per planning doc §3.2) inside
 * the Dynamic tab of the Add Context popup. Each row represents one
 * marker type; clicking it dispatches `onPick(marker)` to the host
 * (which routes the marker through the surface's pinned-items add path
 * as a `pin_kind: 'dynamic'` pill with `source: 'manual'`).
 *
 *   ─── No surface-viability filtering ──────────────────────────────
 *
 * Every Tier 2 marker is always available to add regardless of whether
 * its dependencies are currently satisfied (planning doc §4.4e). A
 * marker added when its host context isn't viable renders in the
 * silent-skip strike-through state immediately; if context later
 * changes to satisfy the requirements, the pill resolves and flashes.
 * The pill owns the "do I have what I need?" check, not the picker.
 *
 *   ─── Tier 1 markers are NOT in this picker ───────────────────────
 *
 * Active Scene, Section content, Before, After are Tier 1 surface-
 * baked toggles per planning doc §4.4e. They live as surface chrome,
 * not as attached markers; this picker does not surface them.
 *
 *   ─── Context cues are NOT in this picker ─────────────────────────
 *
 * Per Phase 2.10 Bug 6, cues are static pill attachments (program-
 * level static references), not dynamic markers. They have their own
 * dedicated Context Cues tab in the Add Context popover for the writer
 * surface, and live on `SystemPrompt.static_cue_ids` for the author
 * surface. This picker offers only the chain / scene / story-state-
 * dependent dynamic markers.
 *
 *   ─── N-value + enum-config markers use defaults ──────────────────
 *
 * `previous_n_words` / `following_n_words` add with `n: 50` (matches
 * `DEFAULT_N_WORDS` in `dynamicMarkers.js`). `story_scope_*` and
 * adjacent-scene markers add with `detail: 'descriptions_only'`
 * (smallest detail level — writer can click-cycle up afterward).
 * Per-pill config is adjustable on the pill itself via `DynamicPillChip`
 * (item 5).
 */
export default function DynamicMarkerPickerPanel({ pinned, onPick }) {
  const [filter, setFilter] = useState('')

  // Group markers into writer-facing categories. The categorization
  // is purely UI organization; the marker types in MARKER_TYPES are
  // the source of truth for what shapes are valid.
  const groups = useMemo(() => ([
    {
      key: 'story_scope',
      label: 'Story Scope',
      hint: 'Whole-story / chapter / act framing',
      items: [
        { type: 'story_scope_whole_story',     label: 'Whole story' },
        { type: 'story_so_far',                label: 'Story so far' },
        { type: 'story_scope_current_chapter', label: 'Current chapter' },
        { type: 'story_scope_current_act',     label: 'Current act' },
      ],
    },
    {
      key: 'adjacent',
      label: 'Adjacent Scenes',
      hint: 'Previous / next scene relative to the host scene',
      items: [
        { type: 'previous_scene',    label: 'Previous scene' },
        { type: 'next_scene',        label: 'Next scene' },
        { type: 'previous_n_words',  label: 'Last N words of previous scene' },
        { type: 'following_n_words', label: 'First N words of next scene' },
      ],
    },
    {
      key: 'current_scene',
      label: 'Current Scene',
      hint: 'Full prose body of the host scene',
      items: [
        { type: 'current_scene_body', label: 'Scene body prose' },
      ],
    },
    {
      key: 'story_meta',
      label: 'Story Metadata',
      hint: 'Programmatic story-level fields',
      items: [
        { type: 'pov_character',      label: 'POV character' },
        { type: 'story_default_pov_character', label: 'Story default POV character' },
        { type: 'chapter_title',      label: 'Chapter title' },
        { type: 'act_title',          label: 'Act title' },
        { type: 'story_title',        label: 'Story title' },
        { type: 'story_description',  label: 'Story description' },
        { type: 'story_tense',        label: 'Story tense' },
        { type: 'story_pov_type',     label: 'Story POV type' },
        { type: 'story_language',     label: 'Story language' },
      ],
    },
    {
      key: 'live',
      label: 'Live',
      hint: 'Real-world values evaluated when the prompt sends',
      items: [
        { type: 'today_date',         label: 'Today’s date' },
      ],
    },
  ]), [])

  // Dedup against the surface's current dynamic pills via markerKey.
  // Static pins don't collide — they're keyed by (kind, id), not by
  // marker shape. The dedup is best-effort: defaultMarker() values
  // are used for the key check; if the writer already has a previous_n_words
  // with n=80 pinned, picking the picker's previous_n_words (which
  // would default to n=50) is allowed since the keys differ.
  const dedupKeys = useMemo(() => {
    const out = new Set()
    for (const p of (pinned || [])) {
      if (!p || p.pin_kind !== 'dynamic' || !p.marker) continue
      out.add(markerKey(p.marker))
    }
    return out
  }, [pinned])

  // Apply the filter input as a substring match on the label OR the
  // group's label/hint. Case-insensitive.
  const lc = filter.trim().toLowerCase()
  const filteredGroups = useMemo(() => {
    if (!lc) return groups
    return groups
      .map((g) => ({
        ...g,
        items: g.items.filter((it) => it.label.toLowerCase().includes(lc) || g.label.toLowerCase().includes(lc)),
      }))
      .filter((g) => g.items.length > 0)
  }, [groups, lc])

  function handlePick(type) {
    const m = defaultMarker(type)
    if (!m) return
    onPick(m)
  }

  return (
    <div className="space-y-1" data-help-region="dynamic-marker-picker:panel">
      <input
        type="text"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter markers..."
        data-help-region="dynamic-marker-picker:filter"
        className="w-full px-2 py-1 text-[10px] rounded bg-zinc-800 border border-zinc-700 text-zinc-200 placeholder:text-zinc-500"
      />
      <div className="max-h-[260px] overflow-y-auto pr-1" data-help-region="dynamic-marker-picker:marker_list">
        {filteredGroups.length === 0 && (
          <div className="px-2 py-2 text-[10px] text-zinc-500 italic">No markers match.</div>
        )}
        {filteredGroups.map((g) => (
          <div key={g.key} className="mb-1.5">
            <div className="px-1 pt-0.5 pb-0.5 text-[9px] uppercase tracking-wide text-zinc-500">{g.label}</div>
            {g.items.map((it) => {
              const sample = defaultMarker(it.type)
              const dup = sample ? dedupKeys.has(markerKey(sample)) : false
              return (
                <button
                  key={it.type}
                  type="button"
                  onClick={() => handlePick(it.type)}
                  disabled={dup}
                  className={`w-full flex items-center gap-1.5 px-1.5 py-1 text-left text-[10px] rounded transition-colors ${
                    dup
                      ? 'text-zinc-500 cursor-default'
                      : 'text-zinc-200 hover:bg-zinc-800/80 cursor-pointer'
                  }`}
                  title={dup
                    ? 'Already added to this surface.'
                    : 'Add as a dynamic context pill. Configure on the pill afterward.'}
                >
                  <DynamicBoltIcon size={9} />
                  <span className={dup ? 'line-through' : ''}>{it.label}</span>
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
