/**
 * Story-scope bundle builder — Phase 2.5h.
 *
 * The chain-aware companion to `storyScopePrompt.js`. Reads from the
 * project store, walks every entity / relationship / knowledge chain
 * as needed, and emits the plain-data bundle the renderer consumes.
 * Kept separate from the renderer so the renderer stays a pure
 * presentation module (bundle-as-input contract from the planning
 * doc).
 *
 * Anyone who wants the same shape — the chat send path, the system-
 * prompt preview panel, future MCP tools — calls this builder. There
 * is exactly one place that knows how to walk the chain to produce
 * the per-scene change list.
 */
import { ENTITY_BUCKETS } from './entityHelpers'
import { computeEffectiveStateWithPrior } from './narrativeChain'
import { computeStoryOrder } from './storyOrder'
import { computePovChain } from './povSequence'
import { resolveChapterIdForNode, chapterMemberOptsForStory } from './chapterMembership'
import {
  oneline,
  attributeValueString,
  awarenessLevelName,
  flatAwareness,
} from './chatContextFormatters'
import { formatPerspectiveLine } from './perspectiveDescriptor'


/**
 * Build the story-scope bundle from project state. Caller passes the
 * mode + scope so we only do the heavy work the mode actually needs:
 * `full_content` skips chain walking, `summary_with_changes` runs
 * the per-scene diff machinery on every rendered scene.
 *
 * Pure with respect to its inputs — no store reads inside. Caller
 * pulls the needed slices from `projectStore` and passes them in.
 *
 *   buildStoryScopeBundle({
 *     mode, scopeScenes, scopeChapter, scopeAct,
 *     includePrev, includeNext, activeSceneId,
 *     story, nodes, edges,        // raw project state
 *     relationships, knowledges,  // raw project state (for changes)
 *   })
 */
export function buildStoryScopeBundle(args) {
  const {
    mode = null,
    scopeScenes = [],
    scopeChapter = null,
    scopeAct = null,
    includePrev = false,
    includeNext = false,
    activeSceneId = null,
    story = {},
    nodes = [],
    edges = [],
    // Phase 2.13c — top-level knowledges + relationships, in case the
    // caller's `story` object doesn't carry the live values (the
    // projectStore keeps them as top-level fields; `ps.story.knowledges`
    // / `.relationships` are stale between save/load events). The
    // builder injects them into the story it forwards to the
    // change-line walker so perspective target lookup resolves
    // against current state.
    knowledges = null,
    relationships = null,
    // Caller-provided story order. The chat send path passes the SHARED,
    // cached order so the conversation-history replay (which re-renders
    // every block on each send) does not recompute the full ~110ms graph
    // walk once per rendered block. Null falls back to a local compute.
    storyOrder: passedStoryOrder = null,
  } = args || {}
  // Merge live top-level overrides into the forwarded story so the
  // change-line walker (and any downstream helper that reads
  // `story.knowledges` / `story.relationships`) gets fresh data when
  // the caller has it.
  const storyForChanges = {
    ...story,
    ...(knowledges != null ? { knowledges } : {}),
    ...(relationships != null ? { relationships } : {}),
  }

  // Normalise scopeScenes so each entry is `{ id, mode }`. Accepts
  // legacy plain-string entries for forward-compat — they get the
  // default 'summary' mode.
  const scopeSceneEntries = (scopeScenes || [])
    .map((e) => (typeof e === 'string'
      ? { id: e, mode: 'summary' }
      : (e && e.id ? { id: e.id, mode: e.mode || 'summary' } : null)))
    .filter(Boolean)
  const perSceneModeMap = new Map(scopeSceneEntries.map((e) => [e.id, e.mode]))

  const storyOrder = passedStoryOrder || computeStoryOrder({ nodes, edges })
  const povChainData = computePovChain(nodes, edges)
  const povChain = (povChainData?.sequence || []).map((s) => s.nodeId)
  const povTotal = povChain.length

  const chapters = story.chapters || []
  const acts = story.acts || []
  const chapterMemberOpts = chapterMemberOptsForStory(story)

  // Build the full per-scene bundle entries. We bundle every scene
  // regardless of selection — the renderer (and resolver) filter
  // afterwards via the scope arguments. This also makes the bundle
  // self-contained for the preview panel even when the selection
  // changes interactively.
  const sceneNodes = nodes.filter((n) => n && n.type === 'sceneNode')
  const sceneNodeById = new Map()
  for (const n of sceneNodes) sceneNodeById.set(n.id, n)

  // Scene-node ids in canonical story order. Mirrors the helper in
  // `chatContextFormatters` but inlined here so the bundle doesn't
  // round-trip through another import for a tiny utility.
  const globalOrder = []
  for (const sid of (storyOrder?.orderedIds || [])) {
    if (sceneNodeById.has(sid)) globalOrder.push(sid)
  }

  // Pre-resolve POV step numbers so the renderer can stamp them on
  // each block without re-walking the chain itself.
  const povStepBySceneId = new Map()
  povChain.forEach((sid, i) => povStepBySceneId.set(sid, i + 1))

  // Phase 2.5h follow-up — pre-compute the prev / next neighbours of
  // the active scene so the renderer can tag those scenes with a
  // human-readable relationship line (the model needs to know that
  // "the scene immediately before" is RELATIVE TO the active scene,
  // not just "earlier in the story"). Snaps to the POV chain when
  // the active scene is on it; otherwise falls back to global order.
  let prevNeighbourId = null
  let nextNeighbourId = null
  if (activeSceneId) {
    const povIdx = povChain.indexOf(activeSceneId)
    if (povIdx >= 0) {
      prevNeighbourId = povIdx > 0 ? povChain[povIdx - 1] : null
      nextNeighbourId = povIdx < povChain.length - 1 ? povChain[povIdx + 1] : null
    } else {
      const globalIdx = globalOrder.indexOf(activeSceneId)
      if (globalIdx >= 0) {
        prevNeighbourId = globalIdx > 0 ? globalOrder[globalIdx - 1] : null
        nextNeighbourId = globalIdx < globalOrder.length - 1 ? globalOrder[globalIdx + 1] : null
      }
    }
  }

  // Determine per-scene mode at build time so we know what content
  // each scene needs pre-computed. A scene's effective mode is:
  //   - its per-scene mode when it's in the writer's hand-picks
  //   - otherwise the whole-story `mode` (when set)
  //   - otherwise null (scene isn't rendered)
  // We then look at the union of all effective modes to decide
  // which heavy passes to run.
  function effectiveModeFor(sceneId) {
    if (perSceneModeMap.has(sceneId)) return perSceneModeMap.get(sceneId)
    return mode || null
  }

  // Memoised chain-aware name resolver. Keyed by `${sceneId}:${entityId}`.
  // Used to look up an entity's name AT a specific scene, which is
  // what the model should see for both subjects and observers in
  // awareness change lines (baseline names would misrepresent the
  // state of the world by that scene if the entity was renamed
  // upstream). Lives at bundle-build scope so the cache fills in
  // naturally as scenes are walked.
  const nameAtScene = new Map()
  const resolveNameAtScene = (entityId, sceneId) => {
    if (!entityId || !sceneId) return ''
    const key = `${sceneId}:${entityId}`
    if (nameAtScene.has(key)) return nameAtScene.get(key)
    const entity = _findEntity(story, entityId)
    if (!entity) {
      nameAtScene.set(key, '')
      return ''
    }
    let name = ''
    try {
      const walked = computeEffectiveStateWithPrior(entity, nodes, edges, sceneId, { storyOrder })
      name = walked?.current?.name || entity.name || ''
    } catch {
      // Walker failure — fall through with empty string; callers
      // substitute the raw observer id so the model still has a
      // referent. Never silently substitute baseline here — that
      // would mask the failure mode.
      name = ''
    }
    nameAtScene.set(key, name)
    return name
  }

  const sceneBundles = sceneNodes.map((sceneNode) => {
    const data = sceneNode.data || {}
    const chapterId = resolveChapterIdForNode(sceneNode, chapters, chapterMemberOpts)
    const chapter = chapterId ? chapters.find((c) => c.id === chapterId) : null
    const actId = chapter?.act_id || null
    const onChain = povStepBySceneId.has(sceneNode.id)
    // Phase 2.5h follow-up — tag the scene's relationship to the
    // current writer focus so the renderer can label prev / next /
    // active in plain English. Three possible values plus null when
    // no active scene is set or this scene has no special relation.
    let activeSceneRelation = null
    if (activeSceneId) {
      if (sceneNode.id === activeSceneId) activeSceneRelation = 'active'
      else if (sceneNode.id === prevNeighbourId) activeSceneRelation = 'prev'
      else if (sceneNode.id === nextNeighbourId) activeSceneRelation = 'next'
    }
    const sceneEffectiveMode = effectiveModeFor(sceneNode.id)
    return {
      id: sceneNode.id,
      title: data.title || 'Untitled scene',
      description: data.description ? oneline(data.description) : '',
      // Main content only when THIS scene's effective mode is
      // full_content. Pre-Phase-2.5h-followup behaviour required a
      // global full_content mode; per-scene mode now overrides
      // that for the picked scene only.
      mainContent: sceneEffectiveMode === 'full_content'
        ? _tiptapHtmlToMarkdown(data.main_content || '')
        : '',
      chapterId,
      actId,
      isOnPovChain: onChain,
      povStep: onChain ? povStepBySceneId.get(sceneNode.id) : null,
      povTotal: onChain ? povTotal : null,
      activeSceneRelation,
      effectiveMode: sceneEffectiveMode,
      // Changes are included for BOTH `summary_with_changes` AND
      // `full_content` — Full is the most complete granularity, so
      // anything Sum+Chng surfaces, Full surfaces too (plus the
      // scene's main_content body on top).
      changes: (sceneEffectiveMode === 'summary_with_changes' || sceneEffectiveMode === 'full_content')
        ? _collectSceneChanges({ sceneNode, story: storyForChanges, nodes, edges, storyOrder, resolveNameAtScene })
        : [],
    }
  })

  return {
    mode,
    scopeScenes,
    scopeChapter,
    scopeAct,
    includePrev,
    includeNext,
    activeSceneId,
    scenes: sceneBundles,
    chapters: chapters.map((c) => ({ id: c.id, title: c.title || c.name || 'Untitled chapter', actId: c.act_id || null })),
    acts: acts.map((a) => ({ id: a.id, title: a.title || a.name || 'Untitled act' })),
    povChain,
    globalOrder,
  }
}


// ── Per-scene change collection ──────────────────────────────────
//
// For every entity in every bucket on this scene, walk the chain
// via `computeEffectiveStateWithPrior(at=sceneNode.id)` and diff
// the prior vs current state. Each detected delta turns into one
// pre-formatted line in the returned array.
//
// Bullet shape:
//   "<Entity name>: name '<old>' → '<new>'"
//   "<Entity name>: description '<old>' → '<new>'"
//   "<Entity name>: <Attribute name> '<old>' → '<new>'"
//   "<Entity name>: <Attribute name> added (<value>)"
//   "<Entity name>: <Attribute name> removed"
//   "<Entity name>: <Observer> awareness '<old>' → '<new>'"
//
// All chain-walked — no baseline reads bypassing the walker. The
// only "baseline" touch is for entity-name resolution when the
// entity itself isn't on the scene's chip list (e.g. an observer
// referenced in awareness changes); for those we use the entity's
// origin name as a label, which is the chain-aware exit for the
// "I just need a stable identifier" case.
function _collectSceneChanges({ sceneNode, story, nodes, edges, storyOrder, resolveNameAtScene }) {
  const out = []
  const data = sceneNode.data || {}
  for (const bucket of ENTITY_BUCKETS) {
    const refs = data[bucket] || []
    if (!Array.isArray(refs) || refs.length === 0) continue
    for (const ref of refs) {
      const entityId = ref?.entity_id
      if (!entityId) continue
      const entity = _findEntity(story, entityId)
      if (!entity) continue
      let walked
      try {
        walked = computeEffectiveStateWithPrior(entity, nodes, edges, sceneNode.id, { storyOrder })
      } catch {
        continue
      }
      const { current, prior } = walked || {}
      if (!current) continue
      // Subject name — `current.name` is already chain-resolved at this
      // scene anchor by the walker. Fallback handles the rare case where
      // the walker returned a state without a name field.
      const subjName = current.name || '(unnamed)'

      // Name change.
      if (prior?.name != null && prior.name !== current.name) {
        out.push(`${subjName}: name "${prior.name}" → "${current.name}"`)
      }
      // Description change.
      if ((prior?.description || '') !== (current.description || '')) {
        const before = prior?.description ? `"${oneline(prior.description)}"` : '(none)'
        const after = current.description ? `"${oneline(current.description)}"` : '(none)'
        out.push(`${subjName}: description ${before} → ${after}`)
      }
      // Aliases change.
      const priorAliases = _aliasNames(prior?.aliases)
      const currentAliases = _aliasNames(current.aliases)
      if (!_arraysEqual(priorAliases, currentAliases)) {
        const added = currentAliases.filter((a) => !priorAliases.includes(a))
        const removed = priorAliases.filter((a) => !currentAliases.includes(a))
        if (added.length > 0) out.push(`${subjName}: aliases added: ${added.join(', ')}`)
        if (removed.length > 0) out.push(`${subjName}: aliases dropped: ${removed.join(', ')}`)
      }
      // Attribute changes. Circumstances and motivators are attributes
      // with `attribute_type: 'circumstance' | 'motivator'`; surface the
      // type as a parenthetical so the model knows whether a changed
      // value is a regular trait, a transient circumstance, or a
      // motivator. Regular attributes carry no label (their format is
      // self-evident in context).
      const priorAttrById = new Map()
      for (const a of (prior?.attributes || [])) {
        if (a && a.id) priorAttrById.set(a.id, a)
      }
      const currentAttrIds = new Set()
      for (const attr of (current.attributes || [])) {
        if (!attr) continue
        currentAttrIds.add(attr.id)
        const priorAttr = priorAttrById.get(attr.id)
        // Phase 2.13c — perspectives are a specialised attribute with
        // their own line shape (target descriptor + description body).
        // Surface add / change as "Perspective on <target>: '<body>'"
        // so the model sees the host entity, the target, and the new
        // text in one line. Orphaned-target perspectives (cascade-
        // nulled target_kind / target_id) are skipped — the formatter
        // returns null for those.
        if (attr.attribute_type === 'perspective') {
          // Host-aware format: the helper produces a complete clause
          // ("<host>'s Perspective of <target>: '<body>'") so the
          // change line doesn't need a separate `${subjName}:`
          // prefix — that would just duplicate the host name.
          const line = formatPerspectiveLine(attr, story, { hostName: subjName })
          if (!line) continue
          if (!priorAttr) {
            out.push(`${line} (added)`)
          } else {
            const priorLine = formatPerspectiveLine(priorAttr, story, { hostName: subjName })
            if (priorLine !== line) {
              out.push(`${line} (changed)`)
            }
          }
          continue
        }
        const value = attributeValueString(attr)
        const typeLabel = attr.attribute_type === 'circumstance' ? ' (circumstance)'
          : attr.attribute_type === 'motivator' ? ' (motivator)'
          : ''
        if (!priorAttr) {
          const name = attr.name || 'Unnamed attribute'
          out.push(value
            ? `${subjName}: ${name}${typeLabel} added (${value})`
            : `${subjName}: ${name}${typeLabel} added`)
          continue
        }
        const priorValue = attributeValueString(priorAttr)
        if (priorValue !== value) {
          const name = attr.name || 'Unnamed attribute'
          const before = priorValue || '(none)'
          const after = value || '(none)'
          out.push(`${subjName}: ${name}${typeLabel} "${before}" → "${after}"`)
        }
      }
      // Removed attributes — present in prior, absent in current.
      for (const [id, priorAttr] of priorAttrById.entries()) {
        if (currentAttrIds.has(id)) continue
        if (priorAttr.attribute_type === 'perspective') {
          // Host-aware format here too — same rationale as the add /
          // change branch above.
          const priorLine = formatPerspectiveLine(priorAttr, story, { hostName: subjName })
          if (priorLine) out.push(`${priorLine} (removed)`)
          continue
        }
        const name = priorAttr.name || 'Unnamed attribute'
        const typeLabel = priorAttr.attribute_type === 'circumstance' ? ' (circumstance)'
          : priorAttr.attribute_type === 'motivator' ? ' (motivator)'
          : ''
        out.push(`${subjName}: ${name}${typeLabel} removed`)
      }
      // Awareness changes. Diff per observer.
      const priorAware = flatAwareness(prior?.awareness)
      const currentAware = flatAwareness(current?.awareness)
      const allObservers = new Set([...Object.keys(priorAware), ...Object.keys(currentAware)])
      for (const observerId of allObservers) {
        const before = priorAware[observerId]
        const after = currentAware[observerId]
        if (before === after) continue
        // Observer name — chain-resolved at this scene's anchor via
        // the memoised resolver. Cost is bounded because every
        // observer encountered is cached and reused across scenes /
        // entities. Falls back to the raw id when the walker can't
        // resolve a name, never to baseline (using baseline silently
        // would misrepresent the world to the model if the observer
        // was renamed upstream of this scene).
        const observerName = resolveNameAtScene(observerId, sceneNode.id) || observerId
        if (before == null) {
          out.push(`${subjName}: ${observerName} becomes ${awarenessLevelName(after).toLowerCase()}`)
        } else if (after == null) {
          out.push(`${subjName}: ${observerName} awareness cleared (was ${awarenessLevelName(before)})`)
        } else {
          out.push(`${subjName}: ${observerName} awareness ${awarenessLevelName(before)} → ${awarenessLevelName(after)}`)
        }
      }
    }
  }
  return out
}


function _findEntity(story, entityId) {
  const entities = story?.entities || {}
  for (const bucket of ENTITY_BUCKETS) {
    for (const e of (entities[bucket] || [])) {
      if (e && e.id === entityId) return e
    }
  }
  return null
}


function _aliasNames(aliases) {
  if (!Array.isArray(aliases)) return []
  return aliases.map((a) => (typeof a === 'string' ? a : a?.value)).filter(Boolean)
}


function _arraysEqual(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}


// Quick-and-dirty TipTap HTML → markdown. The full content renderer
// in `frontend/src/utils/tiptapToMarkdown.js` would be richer; this
// shim is enough to give the model a readable surface for
// `full_content` mode (preserves paragraph breaks, strips tags).
// When the dedicated converter lands we swap this for it.
function _tiptapHtmlToMarkdown(html) {
  if (!html) return ''
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
