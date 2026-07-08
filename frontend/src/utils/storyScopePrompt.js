/**
 * Story-scope context appendage renderer — Phase 2.5h.
 *
 * Produces the "## Additional story context" markdown block that the
 * chat send-path appends to the writer's chosen system prompt. Sibling
 * to `sceneContextPrompt.js` — different machinery (whole-story +
 * static), different wire position (one-shot system-prompt append vs
 * `system_context` blocks in messages history).
 *
 * Bundle-as-input contract:
 *   The caller (e.g. ConversationView.streamAssistantReply, or the
 *   system-prompt preview modal) reads from `projectStore` and
 *   packages a plain bundle the renderer needs. This module never
 *   reaches into Zustand. Two payoffs:
 *     1) The preview modal computes the appendage WITHOUT touching
 *        the send path — it just builds the same bundle and calls
 *        the renderer.
 *     2) Future callers (an MCP tool wanting the same shape, a debug
 *        "export current prompt" affordance, test scaffolding) can do
 *        the same — build a bundle, call the renderer.
 *
 * The renderer returns plain markdown. An empty result means the
 * caller should NOT append the "## Additional story context"
 * separator — the system prompt stays as the writer's prompt alone.
 *
 *
 * Bundle shape:
 *
 *   {
 *     mode: null | 'summary' | 'summary_with_changes' | 'full_content',
 *     scopeScenes: string[],        // hand-picked scene ids
 *     scopeChapter: string | null,
 *     scopeAct: string | null,
 *     includePrev: boolean,
 *     includeNext: boolean,
 *     activeSceneId: string | null, // the scene that scene-context is
 *                                   // active on; used only to resolve
 *                                   // prev/next when the toggles are
 *                                   // on. Otherwise ignored.
 *     // Pre-resolved per-scene payload, one entry per scene in the
 *     // entire story. The renderer filters by mode + scope. The caller
 *     // pre-walks the chain to build the `changes` strings (the
 *     // renderer is presentation-only).
 *     scenes: [{
 *       id, title, description,
 *       mainContent?,             // markdown body — required for
 *                                 // 'full_content' mode; ignored
 *                                 // otherwise.
 *       chapterId, actId,
 *       isOnPovChain, povStep, povTotal,
 *       changes: string[],        // pre-rendered bullet strings;
 *                                 // required for 'summary_with_changes'
 *                                 // mode. Each string is a single line,
 *                                 // already in the shape the scene-
 *                                 // context renderer produces (e.g.
 *                                 // 'Hair: "long" → "short" (changes
 *                                 // during this scene)').
 *     }],
 *     chapters: [{ id, title, actId }],
 *     acts:     [{ id, title }],
 *     // Ordered scene ids used to derive prev/next neighbours and to
 *     // walk the rendered set in story order. When the active scene
 *     // is on the POV chain, prev/next snap to its POV neighbours;
 *     // otherwise prev/next fall back to global-order neighbours.
 *     povChain:    string[],
 *     globalOrder: string[],
 *   }
 *
 * Mode summary:
 *   - `null`            → empty appendage (no story context).
 *   - `summary`         → title + position marker + description.
 *   - `summary_with_changes` → summary + a "Changes at this scene:"
 *                         subheader followed by the bundle's `changes`
 *                         bullets verbatim.
 *   - `full_content`    → summary + scene's `mainContent` markdown.
 */


/**
 * Resolve the set of scene ids that should be rendered given the
 * current mode + scope + prev/next toggles. Pure function — only
 * touches the bundle's id arrays. Caller can use this independently
 * for the token-estimate readout in the popup.
 *
 * Returns `string[]` in story order, de-duplicated.
 */
export function resolveStoryScopeSceneIds(bundle) {
  if (!bundle) return []
  const { mode, scopeScenes = [], scopeChapter, scopeAct,
          includePrev, includeNext, activeSceneId,
          scenes = [], chapters = [], povChain = [], globalOrder = [] } = bundle
  // Whole-story mode: every scene in story order.
  const includeAllByMode = mode === 'summary' || mode === 'summary_with_changes' || mode === 'full_content'

  const selected = new Set()
  if (includeAllByMode) {
    for (const sid of globalOrder) selected.add(sid)
  }

  // Scope-picks are additive on top of the mode. When mode is null
  // and scope-picks are present, the scope-picks render in the
  // default 'summary' shape (handled in the renderer).
  for (const entry of scopeScenes) {
    // Accept both shapes: a raw scene id (legacy / external callers)
    // or a `{ id, mode }` per-scene entry (Phase 2.5h follow-up).
    const sid = typeof entry === 'string' ? entry : entry?.id
    if (sid) selected.add(sid)
  }
  if (scopeChapter) {
    for (const s of scenes) {
      if (s.chapterId === scopeChapter) selected.add(s.id)
    }
  }
  if (scopeAct) {
    // Act → all chapters under the act → all scenes in those chapters.
    const actChapterIds = new Set(
      chapters.filter((c) => c && c.actId === scopeAct).map((c) => c.id)
    )
    for (const s of scenes) {
      if (s.chapterId && actChapterIds.has(s.chapterId)) selected.add(s.id)
    }
  }

  // Prev/Next neighbours of the active scene. Resolved against the
  // POV chain when the active scene is on it; otherwise against
  // global order. Edges silently produce nothing.
  if (activeSceneId && (includePrev || includeNext)) {
    const neighbours = _resolveNeighbours(activeSceneId, povChain, globalOrder)
    if (includePrev && neighbours.prev) selected.add(neighbours.prev)
    if (includeNext && neighbours.next) selected.add(neighbours.next)
  }

  // Return in canonical story order. Any selected id absent from
  // `globalOrder` is dropped — without an order it can't be sequenced
  // and it's almost certainly a stale id.
  const out = []
  for (const sid of globalOrder) {
    if (selected.has(sid)) out.push(sid)
  }
  return out
}


function _resolveNeighbours(sceneId, povChain, globalOrder) {
  const povIdx = (povChain || []).indexOf(sceneId)
  if (povIdx >= 0) {
    return {
      prev: povIdx > 0 ? povChain[povIdx - 1] : null,
      next: povIdx < povChain.length - 1 ? povChain[povIdx + 1] : null,
    }
  }
  const globalIdx = (globalOrder || []).indexOf(sceneId)
  if (globalIdx < 0) return { prev: null, next: null }
  return {
    prev: globalIdx > 0 ? globalOrder[globalIdx - 1] : null,
    next: globalIdx < globalOrder.length - 1 ? globalOrder[globalIdx + 1] : null,
  }
}


/**
 * Build the rendered appendage markdown. Returns '' (empty string)
 * when nothing should be appended — the send path should then leave
 * the system prompt as-is, with no separator.
 */
export function buildStoryScopeAppendage(bundle) {
  if (!bundle) return ''
  const sceneIds = resolveStoryScopeSceneIds(bundle)
  if (sceneIds.length === 0) return ''

  const { mode, scopeChapter, scopeAct, scenes = [], chapters = [], acts = [] } = bundle
  // Fallback for scene bundles that don't carry a per-scene mode
  // (legacy callers / external bundles). When the writer has scope
  // picks but no whole-story mode set, the planning doc calls for
  // the default 'summary' shape.
  const fallbackMode = mode || 'summary'
  // Chapter / Act headers only make sense when the writer's selection
  // is structured AROUND chapters or acts. For ad-hoc scene picks
  // (or just prev / next neighbours), the headers add noise — drop
  // them and just list the scenes directly. Triggers headers when:
  //   - a whole-story mode is on (summary / changes / full content),
  //   - the writer scoped by chapter,
  //   - the writer scoped by act.
  const groupByStructure = !!(mode || scopeChapter || scopeAct)
  const sceneById = new Map()
  for (const s of scenes) {
    if (s && s.id) sceneById.set(s.id, s)
  }
  const chapterById = new Map()
  for (const c of chapters) {
    if (c && c.id) chapterById.set(c.id, c)
  }
  const actById = new Map()
  for (const a of acts) {
    if (a && a.id) actById.set(a.id, a)
  }

  // Group rendered scenes by (act, chapter) preserving story order
  // when structure grouping is on. When it's off, just emit the
  // scene blocks back-to-back without any container headers.
  const lines = []
  let lastAct = '__none__'
  let lastChapter = '__none__'
  for (const sid of sceneIds) {
    const scene = sceneById.get(sid)
    if (!scene) continue

    if (groupByStructure) {
      const chapter = scene.chapterId ? chapterById.get(scene.chapterId) : null
      const act = chapter?.actId ? actById.get(chapter.actId) : null
      const actKey = act?.id || '__no_act__'
      const chapterKey = chapter?.id || '__no_chapter__'
      if (actKey !== lastAct) {
        if (act?.title) lines.push(`### Act: ${act.title}`)
        lastAct = actKey
        // Reset chapter tracking when act changes so the chapter
        // heading reprints under the new act.
        lastChapter = '__none__'
      }
      if (chapterKey !== lastChapter) {
        if (chapter?.title) lines.push(`#### Chapter: ${chapter.title}`)
        lastChapter = chapterKey
      }
    }

    lines.push(..._renderSceneBlock(scene, scene.effectiveMode || fallbackMode))
    lines.push('')
  }

  // Strip a trailing blank line — keeps the appendage tidy.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}


function _renderSceneBlock(scene, mode) {
  const out = []
  const title = scene.title || 'Untitled scene'

  // Heading carries the relationship lead-in when the scene is the
  // active scene or one of its immediate neighbours. Otherwise it's
  // a plain `Scene: <title>`. Keeping the relation on the heading
  // (rather than as a separate line under it) makes the appendage
  // skimmable for the model — the first line of every block tells
  // it exactly what role the scene plays.
  let heading
  if (scene.activeSceneRelation === 'active') {
    heading = `##### Current scene: ${title}`
  } else if (scene.activeSceneRelation === 'prev') {
    heading = `##### Scene immediately preceding the current scene: ${title}`
  } else if (scene.activeSceneRelation === 'next') {
    heading = `##### Scene immediately following the current scene: ${title}`
  } else {
    heading = `##### Scene: ${title}`
  }
  out.push(heading)

  // Position marker — terse, no jargon. On-chain scenes get
  // "Scene N of M" so the model can place them in the sequence;
  // off-chain scenes get a one-line flag.
  if (scene.isOnPovChain) {
    if (scene.povStep != null && scene.povTotal != null) {
      out.push(`Scene ${scene.povStep} of ${scene.povTotal}.`)
    }
  } else {
    out.push('Off-page / off-screen scene.')
  }

  // Body — varies by mode. Full is the most complete granularity:
  // it surfaces everything Sum+Chng surfaces (description + changes
  // at this scene) PLUS the scene's main_content body on top.
  const wantsChanges = mode === 'summary_with_changes' || mode === 'full_content'

  // Description first — present for all three modes.
  if (scene.description) {
    out.push('')
    out.push(scene.description)
  }

  // Changes block — Sum+Chng and Full both include it.
  if (wantsChanges && Array.isArray(scene.changes) && scene.changes.length > 0) {
    out.push('')
    out.push('Changes at this scene:')
    for (const line of scene.changes) {
      // Each `changes` string is a single pre-formatted line; the
      // renderer just prefixes the bullet marker so the writer's
      // model sees the same per-change shape used by the scene-
      // context block.
      out.push(`- ${line}`)
    }
  }

  // Main content body — Full only. Defensive fallback to description
  // when the writer picked full_content but the scene has no
  // main_content yet is unnecessary now because description already
  // emitted above for all three modes.
  if (mode === 'full_content') {
    const body = (scene.mainContent || '').trim()
    if (body) {
      out.push('')
      out.push(body)
    }
  }
  return out
}
