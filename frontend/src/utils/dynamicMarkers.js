/**
 * Dynamic context marker types — Phase 2.10b item 1.
 *
 * Tier 2 marker types attached to surfaces via `pinnedContextItems` with
 * `pin_kind: 'dynamic'`. See Phase 2.10b planning doc §3.2 for the full
 * shape spec; this module is the canonical JS reference.
 *
 * Tier 1 surface-intrinsic affordances (Active Scene, Section content,
 * Before / After N words) are NOT in this list — they live in existing
 * block-state buckets (`block.sceneContextEnabled`,
 * `block.includeHostSectionContent`, `block.includePreceding`/`block.precedingWords`,
 * `block.includeFollowing`/`block.followingWords`) and are populated at
 * prompt-pick time via the separate `SurfaceDefaults` shape on
 * `SystemPrompt` (§3.3). Don't add them to MARKER_TYPES.
 *
 * Marker-set source of truth is Phase 2.10 §1.2's marker table; this
 * module consumes that spec. To add a marker type:
 *   1. Update the Phase 2.10 §1.2 table.
 *   2. Add the type to MARKER_TYPES below.
 *   3. Add a resolver in `utils/markerResolver.js` (item 2 — separate module).
 *   4. Add it to the picker UI in the Add Context popup's Dynamic tab
 *      (item 9 — separate component).
 *
 * Why the constant list lives here and not as a TypeScript discriminated
 * union: the codebase is JS, not TS. JSDoc types would not be enforced
 * at runtime and would diverge silently. A frozen string-array constant
 * gives runtime-checkable validation + autocomplete via JSDoc references.
 */

/**
 * @typedef {object} StoryScopeMarker
 * @property {'story_scope_whole_story' | 'story_scope_current_chapter' | 'story_scope_current_act'} type
 * @property {'descriptions_only' | 'descriptions_and_changes' | 'full_content'} detail
 */

/**
 * @typedef {object} StorySoFarMarker
 * @property {'story_so_far'} type
 * @property {'descriptions_only' | 'descriptions_and_changes' | 'full_content'} detail
 *
 * "Story so far" — same renderer + detail shape as the story_scope_*
 * markers, but the scope filters to ONLY scenes at or before the host
 * scene's POV index (strictly less-than; the host scene itself is
 * EXCLUDED — `storySoFar` semantics are "what's happened up to but
 * not including here"). Silent-skips when there's no host scene
 * (chat with no scene picked), when the host scene is off-POV (no
 * pov_index to compare against), or when the host scene is the first
 * on the POV chain (no preceding scenes).
 */

/**
 * @typedef {object} AdjacentSceneMarker
 * @property {'previous_scene' | 'next_scene'} type
 * @property {'descriptions_only' | 'descriptions_and_changes' | 'full_content'} detail
 */

/**
 * @typedef {object} NWordsMarker
 * @property {'previous_n_words' | 'following_n_words'} type
 * @property {number} n
 */

/**
 * @typedef {{ type: 'current_scene_body' }
 *   | { type: 'pov_character' }
 *   | { type: 'story_default_pov_character' }
 *   | { type: 'chapter_title' }
 *   | { type: 'act_title' }
 *   | { type: 'story_title' }
 *   | { type: 'story_description' }
 *   | { type: 'story_tense' }
 *   | { type: 'story_pov_type' }
 *   | { type: 'story_language' }
 *   | { type: 'today_date' }
 *   | StoryScopeMarker
 *   | StorySoFarMarker
 *   | AdjacentSceneMarker
 *   | NWordsMarker
 * } ContextMarker
 *
 * Context cues are NOT dynamic markers per Phase 2.10 Bug 6 — they live
 * as static cue pill ids on `SystemPrompt.static_cue_ids` and route
 * through `applyPromptOnPick`'s static-cue clear-and-add step.
 *
 * `current_scene_title` and `current_scene_description` were removed
 * per Phase 2.10 Bug 7 — both are strict subsets of what the Scene
 * Context Tier 1 toggle already emits (scene title as the section
 * heading, description as a `**Description**: ...` line). Standalone
 * markers for those subsets are redundant; the writer enables Scene
 * Context to cover them. `current_scene_body` stays because Scene
 * Context does NOT emit the scene's main_content prose.
 */

/**
 * The 14 Tier 2 marker type strings. Used for runtime validation
 * (`isContextMarker`) and to drive the picker UI's marker list (item 9).
 */
export const MARKER_TYPES = Object.freeze([
  'story_scope_whole_story',
  'story_scope_current_chapter',
  'story_scope_current_act',
  'story_so_far',
  'previous_scene',
  'next_scene',
  'current_scene_body',
  'previous_n_words',
  'following_n_words',
  'pov_character',
  'story_default_pov_character',
  'chapter_title',
  'act_title',
  'story_title',
  'story_description',
  'story_tense',
  'story_pov_type',
  'story_language',
  'today_date',
])

/**
 * Detail-level enum used by `story_scope_*` and adjacent-scene markers.
 * Order matters: this is the cycle order for click-to-cycle (item 5).
 */
export const DETAIL_LEVELS = Object.freeze([
  'descriptions_only',
  'descriptions_and_changes',
  'full_content',
])

/**
 * Default N value for newly-added N-words markers. Matches the existing
 * surface affordance default (PromptBlockForm.jsx `precedingWords` /
 * `followingWords` initial values).
 */
export const DEFAULT_N_WORDS = 50

/**
 * Light-weight runtime check that a value is a plausible ContextMarker.
 * Doesn't validate every field of every variant — just confirms `type`
 * is in MARKER_TYPES. Used as a defence-in-depth check on the write
 * path; the picker UI is the primary source of validated markers.
 *
 * @param {unknown} m
 * @returns {boolean}
 */
export function isContextMarker(m) {
  return (
    m != null
    && typeof m === 'object'
    && typeof m.type === 'string'
    && MARKER_TYPES.includes(m.type)
  )
}

/**
 * Canonical key for de-duplication. Two pills with the same marker key
 * collide; the second add is a no-op (item 11's two-step dispatcher
 * enforces this; manual pins always win the collision).
 *
 * The key is the JSON of the marker with keys sorted lexicographically
 * so logically-equivalent markers stringify identically regardless of
 * how they were constructed. Without the sort, `{type, n}` and `{n, type}`
 * would dedupe differently.
 *
 * @param {ContextMarker} marker
 * @returns {string}
 */
export function markerKey(marker) {
  if (!marker || typeof marker !== 'object') return ''
  const sorted = {}
  for (const key of Object.keys(marker).sort()) {
    sorted[key] = marker[key]
  }
  return JSON.stringify(sorted)
}

/**
 * Construct a fresh marker of `type` with that type's default config.
 * Used by the picker UI when the writer first adds a marker (item 9)
 * and by the prompt editor's "+ Add marker" action (item 8).
 *
 * @param {ContextMarker['type']} type
 * @returns {ContextMarker | null}  null when `type` isn't a known marker.
 */
export function defaultMarker(type) {
  switch (type) {
    case 'story_scope_whole_story':
    case 'story_scope_current_chapter':
    case 'story_scope_current_act':
    case 'story_so_far':
    case 'previous_scene':
    case 'next_scene':
      return { type, detail: DETAIL_LEVELS[0] }
    case 'previous_n_words':
    case 'following_n_words':
      return { type, n: DEFAULT_N_WORDS }
    case 'current_scene_body':
    case 'pov_character':
    case 'story_default_pov_character':
    case 'chapter_title':
    case 'act_title':
    case 'story_title':
    case 'story_description':
    case 'story_tense':
    case 'story_pov_type':
    case 'story_language':
    case 'today_date':
      return { type }
    default:
      return null
  }
}
