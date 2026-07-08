/**
 * Marker resolver pipeline — Phase 2.10b item 2.
 *
 * One resolver function per ContextMarker type (see `dynamicMarkers.js`
 * for the marker shape; see planning doc §4.4c for the dependency table
 * and §4.5 for silent-skip semantics).
 *
 * Each resolver takes the marker config + a `ResolutionContext` bundle
 * the caller pre-builds at send-time (or preview-time) and returns
 * either a resolved string (the prose chunk this marker contributes to
 * the wire payload) or `null` (silent skip — dependencies aren't met
 * and the marker should contribute nothing).
 *
 * The orchestrator at the wire-assembly layer (item 12) builds the
 * `ResolutionContext` once per send and passes it to every dynamic
 * pill's resolver. Resolvers are pure functions over the bundle; they
 * never reach into stores or run async work.
 *
 * Performance discipline (§4.4d): resolvers MUST be cheap. The bundle
 * caller does any heavy lifting (chain walks, story-scope rendering)
 * exactly once per send and exposes the result through the bundle;
 * resolvers just pick out the relevant field. No resolver may walk
 * the chain itself, traverse the full nodes array, etc. — those
 * happen at bundle-construction time.
 *
 *
 * ResolutionContext shape (per planning doc §4.4c):
 *
 *   {
 *     // Loaded story — always defined when a project is open.
 *     story: Story | null,
 *
 *     // The scene this surface is fired against. Undefined for chat
 *     // panel without an active scene; undefined for surfaces with
 *     // no scene host.
 *     hostScene: SceneNode | null,
 *
 *     // The Section this surface is hosted on. Undefined for chat /
 *     // Scene Description PBH / IPB-not-in-a-section; defined on
 *     // Section PBH and IPB inside a Section.
 *     hostSection: { id, name, htmlContent } | null,
 *
 *     // Cursor / range anchor inside the host scene's main_content.
 *     // Defined on Section PBH (= section start) and IPB (= cursor /
 *     // range start). Undefined on chat panel + Scene Description PBH.
 *     hostAnchor: { offset, paragraph_index } | null,
 *
 *     // Program-level context cues list.
 *     cues: ContextCue[],
 *
 *     // Pre-computed per-marker payloads (computed once at bundle
 *     // construction so resolvers don't repeat the work):
 *     //   povCharacterName?: string  — chain-resolved name of the host
 *     //                                 scene's has_pov=true entity.
 *     //   previousSceneId?:  string  — id of chain-adjacent prev scene.
 *     //   nextSceneId?:      string  — id of chain-adjacent next scene.
 *     //   chapterTitle?:     string  — title of host scene's chapter.
 *     //   actTitle?:         string  — title of host scene's act.
 *     //   scenesById?:       Map<id, sceneNode>  — for adjacent-scene
 *     //                                            content lookup.
 *     //   storyScopeRenderer?: (granularity, detail) => string | null
 *     //     — produces the rendered story-scope block for a given
 *     //       (granularity, detail) combo, or null on silent-skip.
 *     //       Caller wires this through `buildStoryScopeAppendage`.
 *     precomputed: {
 *       povCharacterName?: string | null,
 *       previousSceneId?: string | null,
 *       nextSceneId?: string | null,
 *       chapterTitle?: string | null,
 *       actTitle?: string | null,
 *       scenesById?: Map<string, object>,
 *       storyScopeRenderer?: (granularity: string, detail: string) => string | null,
 *     },
 *   }
 *
 *
 * Silent-skip dependency table (planning doc §4.4c):
 *
 *   Marker                            | Requires
 *   ----------------------------------|----------------------------------
 *   story_scope_whole_story           | story
 *   story_scope_current_chapter       | story + hostScene in a chapter
 *   story_scope_current_act           | story + hostScene in a chapter + chapter in an act
 *   previous_scene / next_scene       | hostScene + chain-adjacent scene exists
 *   current_scene_body                | hostScene + non-empty main_content
 *   previous_n_words / following_n_words | hostScene + adjacent scene + adjacent's main_content non-empty
 *   pov_character                     | hostScene + has_pov=true chip
 *   chapter_title                     | hostScene in a chapter
 *   act_title                         | hostScene in a chapter + chapter in an act
 *   story_tense/pov_type/language     | story + field non-null
 *
 * Context cues are NOT in this table — per Bug 6 they're static pill
 * attachments routed through `SystemPrompt.static_cue_ids` and
 * `applyPromptOnPick`, not dynamic markers.
 */

import { MARKER_TYPES } from './dynamicMarkers'
import { buildPovCharacterContextBlock } from './sceneContextPrompt'

/**
 * Strip HTML to plain text. Used by main_content / scene body resolvers
 * so they emit human-readable prose, not raw TipTap HTML.
 *
 * Cheap. Synchronous. Uses a detached DOM element. Block-level close
 * tags get a trailing `\n\n` injected BEFORE the tag strip so
 * paragraph / section / heading / list boundaries survive as
 * paragraph breaks in the resulting plain text. Without this,
 * `textContent` concatenates adjacent blocks into one run-on line
 * (e.g. `<section>Section contents</section><p>Next paragraph</p>`
 * collapses to `Section contentsNext paragraph`). Same fix lives in
 * SceneDescriptionSection.jsx's `_toPlainText` for the same reason.
 */
function _toPlainText(html) {
  if (!html || typeof html !== 'string') return ''
  if (typeof document === 'undefined') return html
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|h[1-6]|li|blockquote|pre|tr|figure|figcaption|article|aside|header|footer|nav|main)>/gi, '$&\n\n')
  const tmp = document.createElement('div')
  tmp.innerHTML = withBreaks
  const text = tmp.textContent || tmp.innerText || ''
  return text.replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '')
}

// XML attribute-value escape for `<Scene title="...">` tag wrapping.
// Mirrors the helper in SceneDescriptionSection.jsx + SectionView.jsx.
function _xmlAttrEscape(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Slice the last N words of a plain-text string. Returns the empty
 * string for missing / empty input. Word boundary = whitespace
 * (collapsed). Matches the existing Before / After pill semantics
 * (PromptBlockForm.jsx).
 */
function _lastNWords(text, n) {
  if (!text || typeof text !== 'string') return ''
  if (!Number.isFinite(n) || n <= 0) return ''
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return ''
  return words.slice(Math.max(0, words.length - n)).join(' ')
}

/**
 * Slice the first N words of a plain-text string. Mirror of `_lastNWords`.
 */
function _firstNWords(text, n) {
  if (!text || typeof text !== 'string') return ''
  if (!Number.isFinite(n) || n <= 0) return ''
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return ''
  return words.slice(0, n).join(' ')
}

// ── Per-marker resolvers ────────────────────────────────────────

const RESOLVERS = {
  story_scope_whole_story(marker, ctx) {
    if (!ctx?.story) return null
    const render = ctx?.precomputed?.storyScopeRenderer
    if (typeof render === 'function') return render('whole_story', marker.detail) || null
    return null
  },

  story_scope_current_chapter(marker, ctx) {
    if (!ctx?.story) return null
    if (!ctx?.precomputed?.chapterTitle) return null  // cascade silent-skip per §4.4c
    const render = ctx?.precomputed?.storyScopeRenderer
    if (typeof render === 'function') return render('current_chapter', marker.detail) || null
    return null
  },

  story_scope_current_act(marker, ctx) {
    if (!ctx?.story) return null
    if (!ctx?.precomputed?.chapterTitle) return null
    if (!ctx?.precomputed?.actTitle) return null
    const render = ctx?.precomputed?.storyScopeRenderer
    if (typeof render === 'function') return render('current_act', marker.detail) || null
    return null
  },

  story_so_far(marker, ctx) {
    if (!ctx?.story) return null
    // Renderer handles the actual silent-skip cascade (no host scene,
    // host off-POV, host is first POV scene) by returning null.
    const render = ctx?.precomputed?.storyScopeRenderer
    if (typeof render === 'function') return render('so_far', marker.detail) || null
    return null
  },

  previous_scene(marker, ctx) {
    const prevId = ctx?.precomputed?.previousSceneId
    if (!prevId) return null
    const scene = ctx?.precomputed?.scenesById?.get?.(prevId)
    if (!scene) return null
    return _renderAdjacentScene(scene, marker.detail, 'Previous')
  },

  next_scene(marker, ctx) {
    const nextId = ctx?.precomputed?.nextSceneId
    if (!nextId) return null
    const scene = ctx?.precomputed?.scenesById?.get?.(nextId)
    if (!scene) return null
    return _renderAdjacentScene(scene, marker.detail, 'Next')
  },

  current_scene_body(_marker, ctx) {
    // Returns the scene's main_content wrapped in `<Scene title="...">`
    // so the AI sees a self-describing tagged block (same shape as the
    // Scene Description PBH's persistent Scene-prose pill output —
    // single source of truth for "this is the scene's narrative prose"
    // framing across every surface). The renderer
    // (`_renderPinnedSection` in `sceneContextPrompt.js`) appends the
    // returned string verbatim after the Additional Context section.
    if (!ctx?.hostScene) return null
    const text = _toPlainText(ctx.hostScene.data?.main_content || '')
    if (!text) return null
    const title = ctx.hostScene.data?.title || ''
    const titleAttr = title ? ` title="${_xmlAttrEscape(title)}"` : ''
    return `<Scene${titleAttr}>\n${text}\n</Scene>`
  },

  previous_n_words(marker, ctx) {
    const prevId = ctx?.precomputed?.previousSceneId
    if (!prevId) return null
    const scene = ctx?.precomputed?.scenesById?.get?.(prevId)
    if (!scene) return null
    const text = _toPlainText(scene.data?.main_content || '')
    const slice = _lastNWords(text, marker.n)
    if (!slice) return null
    return `Last ${marker.n} words of the previous scene:\n\n${slice}`
  },

  following_n_words(marker, ctx) {
    const nextId = ctx?.precomputed?.nextSceneId
    if (!nextId) return null
    const scene = ctx?.precomputed?.scenesById?.get?.(nextId)
    if (!scene) return null
    const text = _toPlainText(scene.data?.main_content || '')
    const slice = _firstNWords(text, marker.n)
    if (!slice) return null
    return `First ${marker.n} words of the next scene:\n\n${slice}`
  },

  pov_character(_marker, ctx) {
    if (!ctx?.hostScene) return null
    const povId = ctx?.precomputed?.povCharacterId
    if (!povId) return null
    // Dedup against Scene Context's chip emission (or any earlier
    // pin) for the same entity at the same anchor. Pill stays visible
    // in the UI; the wire receives no second copy.
    if (ctx.emissions?.check?.('entity', povId, ctx.hostScene.id)) return null
    const block = buildPovCharacterContextBlock(ctx)
    if (!block) return null
    // Register so a downstream static entity pin for the same
    // character at the same anchor silent-skips against this.
    ctx.emissions?.register?.('entity', povId, ctx.hostScene.id, 'full')
    return block
  },

  story_default_pov_character(_marker, ctx) {
    // The character entity's `name` is chain-tracked; the bundle
    // builder runs the chain walk against `story.pov_character_id`
    // at the host scene anchor and exposes the resolved name here.
    // No-anchor (author mode / chat with no scene picked) falls
    // back to the entity's baseline name — that's the chain-aware
    // path when there's no anchor to walk to. Silent-skip when
    // the story has no default POV character set.
    const name = ctx?.precomputed?.storyDefaultPovCharacterName
    if (!name) return null
    return `Story default POV character: ${name}`
  },

  chapter_title(_marker, ctx) {
    const title = ctx?.precomputed?.chapterTitle
    if (!title) return null
    return `Current chapter: ${title}`
  },

  act_title(_marker, ctx) {
    const title = ctx?.precomputed?.actTitle
    if (!title) return null
    return `Current act: ${title}`
  },

  story_title(_marker, ctx) {
    const title = (ctx?.story?.title || '').trim()
    if (!title) return null
    return `Story title: ${title}`
  },

  story_description(_marker, ctx) {
    const description = (ctx?.story?.description || '').trim()
    if (!description) return null
    return `Story description: ${description}`
  },

  story_tense(_marker, ctx) {
    const tense = ctx?.story?.tense
    if (!tense) return null
    return `Story tense: ${tense}`
  },

  story_pov_type(_marker, ctx) {
    const pov = ctx?.story?.pov_type_default
    if (!pov) return null
    return `Story POV type: ${pov}`
  },

  story_language(_marker, ctx) {
    const lang = ctx?.story?.language
    if (!lang) return null
    return `Story language: ${lang}`
  },

  today_date() {
    // Real-world wall-clock value; not tied to any story object so no
    // chain involvement. Re-evaluated at every fire so midnight rolls
    // over naturally between sends. Natural-language format chosen
    // for AI prompt readability ("Today is Thursday, June 11, 2026"
    // reads cleanly in a system prompt); ISO would also work but
    // looks more terse. Locale-aware via Intl — we don't force a
    // specific locale, letting the user's system locale drive
    // month / day-name strings.
    const today = new Date()
    const formatted = today.toLocaleDateString(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
    return `Today's date: ${formatted}`
  },
}

function _renderAdjacentScene(scene, detail, prefix) {
  const title = (scene.data?.title || '').trim() || '(untitled)'
  const description = (scene.data?.description || '').trim()
  switch (detail) {
    case 'descriptions_only': {
      const desc = description ? `\n\n${description}` : ''
      return `${prefix} scene: ${title}${desc}`
    }
    case 'descriptions_and_changes': {
      // Pre-computed changes payload not surfaced yet — fall back to
      // descriptions-only equivalent for v1; item 12 wires the full
      // chain-walked changes list through the bundle when integrating
      // with the storyScopePrompt machinery.
      const desc = description ? `\n\n${description}` : ''
      return `${prefix} scene: ${title}${desc}`
    }
    case 'full_content': {
      const body = _toPlainText(scene.data?.main_content || '')
      if (!body) {
        const desc = description ? `\n\n${description}` : ''
        return `${prefix} scene: ${title}${desc}`
      }
      return `${prefix} scene: ${title}\n\n${body}`
    }
    default:
      return null
  }
}

/**
 * Dispatch a marker to its resolver and return the resolved text or
 * `null` (silent skip).
 *
 * @param {object} marker   ContextMarker per `dynamicMarkers.js`.
 * @param {object} ctx      ResolutionContext bundle (see top-of-file).
 * @returns {string | null}
 */
export function resolveMarker(marker, ctx) {
  if (!marker || typeof marker.type !== 'string') return null
  if (!MARKER_TYPES.includes(marker.type)) return null
  const fn = RESOLVERS[marker.type]
  if (typeof fn !== 'function') return null
  try {
    return fn(marker, ctx)
  } catch {
    // Defence-in-depth: a buggy resolver shouldn't take down the whole
    // wire-assembly path. Silent-skip on throw.
    return null
  }
}

/**
 * Export the per-marker table for callers that need to inspect which
 * marker types have resolvers wired up (mostly useful for debug + test).
 */
export const RESOLVER_NAMES = Object.freeze(Object.keys(RESOLVERS))

// ── Per-marker display label functions ─────────────────────────────
//
// Return a short writer-facing string for the pill body. Distinct from
// the resolver's full wire string. The chip shows this label inline;
// the wire payload still uses `resolveMarker()`'s output. Where the
// resolved value is itself a useful short identifier (a scene title,
// a chapter title, a POV character name), the label prefers it over a
// generic type-name. Falls back to a generic when the resolved value
// isn't available (silent-skip case).

const LABEL_FNS = {
  story_scope_whole_story:     () => 'Whole story',
  story_so_far:                () => 'Story so far',
  story_scope_current_chapter: () => 'Current chapter scope',
  story_scope_current_act:     () => 'Current act scope',
  previous_scene(_marker, ctx) {
    const id = ctx?.precomputed?.previousSceneId
    const s = id && ctx?.precomputed?.scenesById?.get?.(id)
    const t = (s?.data?.title || '').trim()
    return t ? `Prev: ${t}` : 'Previous scene'
  },
  next_scene(_marker, ctx) {
    const id = ctx?.precomputed?.nextSceneId
    const s = id && ctx?.precomputed?.scenesById?.get?.(id)
    const t = (s?.data?.title || '').trim()
    return t ? `Next: ${t}` : 'Next scene'
  },
  previous_n_words: () => 'Prev words',
  following_n_words: () => 'Next words',
  current_scene_body:        () => 'Scene body prose',
  pov_character(_marker, ctx) {
    const name = ctx?.precomputed?.povCharacterName
    return name ? `POV: ${name}` : 'POV character'
  },
  chapter_title(_marker, ctx) {
    const t = ctx?.precomputed?.chapterTitle
    return t ? `Chapter: ${t}` : 'Chapter title'
  },
  act_title(_marker, ctx) {
    const t = ctx?.precomputed?.actTitle
    return t ? `Act: ${t}` : 'Act title'
  },
  story_default_pov_character(_marker, ctx) {
    const name = ctx?.precomputed?.storyDefaultPovCharacterName
    return name ? `Default POV: ${name}` : 'Default POV character'
  },
  story_title:        () => 'Story title',
  story_description:  () => 'Story description',
  story_tense:        () => 'Story tense',
  story_pov_type: () => 'POV type',
  story_language: () => 'Story language',
  today_date:     () => 'Today’s date',
}

// ── Per-marker target-identity functions (planning doc §4.4d) ──────
//
// Return a cheap string identifying WHICH thing the marker is resolving
// against right now. Used by `useDynamicPillFlash` to detect out-of-band
// target changes. MUST track identity, NOT resolved content (writer
// typing into an adjacent scene's body doesn't change the prev-scene's
// id; the targetKey should stay stable through that edit so no flash
// fires).
//
// Returning `null` means "currently silent-skipping" — the hook treats
// transitions into / out of null as legitimate target changes.

// Story-dependent markers append `:${story.id}` so a story-switch
// always changes the targetKey (and flashes) even when the resolved
// value happens to coincide across stories. Scene-relative markers
// (previous_scene, etc.) key on scene UUIDs which are unique across
// stories — no story.id needed. Cue marker is program-level (cues
// live in `context_cues/` at program root and survive story switches)
// — no story.id needed.
const TARGET_KEY_FNS = {
  story_scope_whole_story:     (_m, ctx) => `whole_story:${ctx?.story?.id || ''}`,
  // story_so_far cutoff depends on the host scene's position, so the
  // host scene id is part of the identity — switching scenes shifts
  // what counts as "so far" and the pill should re-flash.
  story_so_far:                (_m, ctx) => ctx?.hostScene?.id ? `so_far:${ctx.hostScene.id}:${ctx?.story?.id || ''}` : null,
  story_scope_current_chapter: (_m, ctx) => ctx?.precomputed?.chapterTitle ? `chapter:${ctx.precomputed.chapterTitle}:${ctx?.story?.id || ''}` : null,
  story_scope_current_act:     (_m, ctx) => ctx?.precomputed?.actTitle ? `act:${ctx.precomputed.actTitle}:${ctx?.story?.id || ''}` : null,
  previous_scene(_m, ctx)      { return ctx?.precomputed?.previousSceneId ? `prev:${ctx.precomputed.previousSceneId}` : null },
  next_scene(_m, ctx)          { return ctx?.precomputed?.nextSceneId ? `next:${ctx.precomputed.nextSceneId}` : null },
  previous_n_words(_m, ctx)    { return ctx?.precomputed?.previousSceneId ? `prev:${ctx.precomputed.previousSceneId}` : null },
  following_n_words(_m, ctx)   { return ctx?.precomputed?.nextSceneId ? `next:${ctx.precomputed.nextSceneId}` : null },
  current_scene_body(_m, ctx)        { return ctx?.hostScene?.id ? `scene:${ctx.hostScene.id}` : null },
  pov_character(_m, ctx)             { return ctx?.precomputed?.povCharacterId ? `pov:${ctx.precomputed.povCharacterId}:${ctx?.story?.id || ''}` : null },
  story_default_pov_character(_m, ctx) {
    // Key includes the chain-resolved name so a rename of the default
    // POV character at any scene anchor on the chain triggers a re-
    // flash. The id alone wouldn't catch that — the entity stays the
    // same, just its name changed.
    const id = ctx?.story?.pov_character_id
    if (!id) return null
    const name = ctx?.precomputed?.storyDefaultPovCharacterName || ''
    return `default_pov:${id}:${name}:${ctx?.story?.id || ''}`
  },
  chapter_title(_m, ctx)             { return ctx?.precomputed?.chapterTitle ? `chap:${ctx.precomputed.chapterTitle}:${ctx?.story?.id || ''}` : null },
  act_title(_m, ctx)                 { return ctx?.precomputed?.actTitle ? `act:${ctx.precomputed.actTitle}:${ctx?.story?.id || ''}` : null },
  story_title(_m, ctx)               { return ctx?.story?.title ? `title:${ctx.story.title}:${ctx?.story?.id || ''}` : null },
  story_description(_m, ctx)         { return ctx?.story?.description ? `desc:${ctx.story.description.length}:${ctx?.story?.id || ''}` : null },
  story_tense(_m, ctx)               { return ctx?.story?.tense ? `tense:${ctx.story.tense}:${ctx?.story?.id || ''}` : null },
  story_pov_type(_m, ctx)            { return ctx?.story?.pov_type_default ? `pov_type:${ctx.story.pov_type_default}:${ctx?.story?.id || ''}` : null },
  story_language(_m, ctx)            { return ctx?.story?.language ? `lang:${ctx.story.language}:${ctx?.story?.id || ''}` : null },
  today_date() {
    // Key on the local date (YYYY-MM-DD) so the pill re-flashes
    // exactly on midnight rollover and stays stable in between.
    // No story-scoping needed — the value is global wall-clock.
    const now = new Date()
    const y = now.getFullYear()
    const m = String(now.getMonth() + 1).padStart(2, '0')
    const d = String(now.getDate()).padStart(2, '0')
    return `today:${y}-${m}-${d}`
  },
}

/**
 * Describe a marker for chip rendering. Returns the three caller-supplied
 * inputs `<DynamicPillChip>` needs: a short display label, an identity
 * key for `useDynamicPillFlash`, and a silent-skip flag.
 *
 * `silentSkip` is determined by re-running `resolveMarker()` and checking
 * for null. The resolver is cheap (heavy chain-walk work was done once
 * at bundle-construction time per planning doc §4.4d), so this isn't a
 * meaningful re-cost in render. Future optimization: dedicated dep-check
 * functions per marker that don't build the wire string.
 *
 * `identityBadgeData` carries marker-specific data the chip needs to
 * render an inline identity badge (e.g. POV character's entity colour
 * + name alongside `<PovStartGlyph />`). Returned as a plain data
 * object so this module stays JS / pure; the React rendering happens
 * in `PinRow.jsx`.
 *
 *   { kind: 'pov', entityId, entityName, entityColour }   for pov_character
 *   null                                                  for every other marker
 *
 * @param {object} marker  ContextMarker
 * @param {object} ctx     ResolutionContext bundle
 * @returns {{ label: string, targetKey: string|null, silentSkip: boolean, identityBadgeData: object|null }}
 */
export function describeMarker(marker, ctx) {
  if (!marker || typeof marker.type !== 'string') {
    return { label: '(unknown marker)', targetKey: null, silentSkip: true, identityBadgeData: null }
  }
  let label = '(unknown marker)'
  let targetKey = null
  try {
    label = LABEL_FNS[marker.type]?.(marker, ctx) || marker.type
  } catch { /* fall back to type name */ }
  try {
    targetKey = TARGET_KEY_FNS[marker.type]?.(marker, ctx) ?? null
  } catch { /* null targetKey is acceptable */ }
  const silentSkip = resolveMarker(marker, ctx) === null
  let identityBadgeData = null
  if (marker.type === 'pov_character') {
    const pre = ctx?.precomputed || {}
    if (pre.povCharacterId) {
      identityBadgeData = {
        kind: 'pov',
        entityId: pre.povCharacterId,
        entityName: pre.povCharacterName || null,
        entityColour: pre.povCharacterColour || null,
        entityProfileImageRef: pre.povCharacterProfileImageRef || null,
        entityType: pre.povCharacterType || 'character',
      }
    }
  }
  return { label, targetKey, silentSkip, identityBadgeData }
}
