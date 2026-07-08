/**
 * Scene-context prompt builder — Phase 2.5c.
 *
 * Produces a writer-readable text block describing the resolved
 * state of one scene, suitable for prepending to the latest user
 * message in a chat request. Lives entirely on the frontend: walks
 * the chain directly via `computeEffectiveStateWithPrior` so the
 * model sees BOTH the inherited state of every entity in the scene
 * (what they're like as the scene opens) AND what changes IN this
 * scene phrased naturally ("Hair: 'long' → 'short' (changes in this
 * scene)").
 *
 * What lands in the block:
 *
 *   - Scene title, description, chapter / act, POV character.
 *   - Time / weekday / season / date / scene-duration / gap details
 *     when set on the scene.
 *   - Scene-level circumstances (the conditions that shape the
 *     whole scene).
 *   - Per-participant detail: name, colour, description, every
 *     attribute, every circumstance, every motivator, with values
 *     resolved AS THE SCENE OPENS, and any value that shifts in
 *     this scene called out inline.
 *
 * The block is the only thing the writer's chat history does NOT
 * carry verbatim: it's injected at send time and dropped from the
 * saved message after the call.
 */
import { useProjectStore } from '../store/projectStore'
import { getLiveStoryEntitiesShape } from '../store/entitiesStore'
import { useContextCuesStore } from '../store/contextCuesStore'
import { tiptapHtmlToMarkdown } from './tiptapToMarkdown'
import { generateHTML } from '@tiptap/react'
import { TIPTAP_EXTENSIONS } from './tiptapExtensions'
import { findSectionContent, findSectionHostInfo } from './findSectionContent'
import { getMcpToolHandler } from '../services/mcpBridge'
import { ENTITY_BUCKETS } from './entityHelpers'
import { formatPerspectiveLine } from './perspectiveDescriptor'
import {
  computeEffectiveStateWithPrior,
  computeEffectiveState,
  computeKnowledgeEffectiveState,
  computeRelationshipEffectiveState,
  getKnowledgeNodeOrder,
  getRelationshipNodeOrder,
  getEntityNarrativeChain,
  knowledgeExistsAtNode,
  resolveObserverAwarenessLevel,
} from './narrativeChain'
import { getOrComputeStoryOrderFromStore } from '../hooks/useStoryOrder'
import { resolveChapterIdForNode, chapterMemberOptsForStory } from './chapterMembership'
import {
  oneline as _oneline,
  titleCase as _titleCase,
  findEntity as _findEntity,
  entityNameBaseline as _entityName,
  sceneOrderList as _sceneOrderList,
  awarenessLevelName as _awarenessLevelName,
  intensityName as _intensityName,
  formatTimeBits as _timeBits,
  flatAwareness as _flatAwareness,
  attributeValueString as _attributeValueString,
} from './chatContextFormatters'
import { resolveMarker } from './markerResolver'
import { buildStoryScopeBundle } from './storyScopeBundleBuilder'
import { buildStoryScopeAppendage } from './storyScopePrompt'


// ── Emission tracker ────────────────────────────────────────────
//
// Per-render dedup tracker. Each emitted sub-component of the
// resolved context block registers a `(kind, id, effective_anchor)`
// tuple here as it commits to `out`. Later emitters consult before
// committing; if the tuple is already registered with greater or
// equal detail, they silent-skip.
//
// Scene Context's per-participant / per-relationship / per-knowledge
// emission registers first. `_renderPinnedSection`'s static-pin loop
// consults next. Static pins that emit also register so a later pin
// at the same anchor (or a future dynamic-entity-resolving pill from
// Bug 5's POV rebuild) silent-skips against them.
//
// Detail fingerprint: string label describing the depth a source
// emitted at. In current code every source uses the same
// `_formatParticipant` / `_formatRelationshipLines` / etc. helpers,
// so the fingerprint is uniformly `'full'`. The merge-upgrade branch
// the spec leaves room for (a future affordance producing richer
// standalone content than Scene Context's chip) would store a
// higher fingerprint and `check()` would return false so the
// caller can replace Scene Context's existing block in place. That
// branch is dormant in current code: every overlap resolves to
// "Scene Context wins, pin silent-skips."
//
// Backward-safe: every consumer that doesn't get an emissions tracker
// gets a fresh empty one. Empty tracker = no dedup = pre-change
// behaviour.
const _DETAIL_RANKS = { full: 2, partial: 1 }
function _detailRank(d) { return _DETAIL_RANKS[d] ?? 0 }
function _createEmissionsTracker() {
  const registry = new Map()  // key: `${kind}:${id}:${anchor}` → { detail }
  function _key(kind, id, anchor) {
    return `${kind}:${id}:${anchor || '__origin__'}`
  }
  return {
    register(kind, id, anchor, detail = 'full') {
      if (!kind || !id) return
      const k = _key(kind, id, anchor)
      const existing = registry.get(k)
      if (!existing || _detailRank(detail) > _detailRank(existing.detail)) {
        registry.set(k, { detail })
      }
    },
    check(kind, id, anchor, neededDetail = 'full') {
      if (!kind || !id) return false
      const existing = registry.get(_key(kind, id, anchor))
      if (!existing) return false
      return _detailRank(existing.detail) >= _detailRank(neededDetail)
    },
  }
}


/**
 * Build the markdown-ish context block for one scene. Returns
 * an empty string when the scene can't be resolved AND there are
 * no pinned items to render.
 *
 * Signature: either a string (legacy: just the scene id) or an
 * object `{ sceneId?, pinnedItems? }`. Pinned items are writer-
 * pinned context entries from `uiStore.chatPinnedContextItems`;
 * they're rendered in a `## Additional Context` section after the
 * main scene block. When sceneId is null/missing but pinned
 * items exist, only the pinned section renders (resolved at
 * origin baseline per the spec).
 *
 * Sync — the builder reads directly from the project store and
 * computes effective state in-process. No network round-trips, no
 * MCP indirection. Async return type is preserved for API
 * symmetry with the chat panel's send path, which awaits the
 * result.
 */
export async function buildSceneContextBlock(arg) {
  const args = typeof arg === 'string' ? { sceneId: arg } : (arg || {})
  const sceneId = args.sceneId || null
  // `hostSceneId` is the surface's structural host scene id —
  // available regardless of whether the writer has the Scene Context
  // toggle on. Drives resolution context for dynamic pins (so
  // markers like `current_scene_body` / `current_scene_title` /
  // `previous_scene` / etc. resolve against the surface's host
  // scene even when the writer hasn't opted into the full Scene
  // Context block emission). When `sceneId` is set (scene context
  // explicitly on), `hostSceneId` is ignored — `sceneId` IS the
  // anchor.
  const hostSceneId = args.hostSceneId || null
  const pinnedItems = Array.isArray(args.pinnedItems) ? args.pinnedItems : []
  const store = useProjectStore.getState()
  const nodes = store.nodes || []
  const edges = store.edges || []
  // Build a local story object whose `entities` field is sourced
  // from the LIVE entitiesStore — not from `projectStore.story.entities`
  // which is a load-time / save-time snapshot and goes stale after any
  // entity creation / edit / deletion during the session. Without this,
  // a character (or any other entity) created mid-session would be
  // missing from every `_findEntity(story, id)` lookup downstream,
  // both in this preview path and in the actual AI send. See
  // `entitiesStore.js` header comment for the full lifecycle of this
  // two-store relationship.
  const story = { ...(store.story || {}), entities: getLiveStoryEntitiesShape() }
  const sceneNode = sceneId
    ? nodes.find((n) => n.id === sceneId && n.type === 'sceneNode')
    : null
  if (!sceneNode && pinnedItems.length === 0) return ''
  // Emission tracker shared across Scene Context's main block and
  // the pinned section. Scene Context registers each chip / rel /
  // knowledge it emits; `_renderPinnedSection` consults before
  // committing each static pin so the same `(kind, id, anchor)`
  // doesn't emit twice.
  const emissions = _createEmissionsTracker()
  // Compute the story order ONCE per render and reuse it for both the
  // scene block and the pinned section. The per-item Option B send path
  // renders many pins per send, so it passes a precomputed
  // `args.storyOrder` — making this expensive walk run once per send
  // instead of once per pin (the cause of the multi-pin send spike).
  const storyOrder = args.storyOrder || getOrComputeStoryOrderFromStore()
  // Pinned-only path — render just the pinned section at origin
  // baseline. Reached when scene context is off / no scene active
  // but the writer still has pinned items they want included.
  // Pass `hostSceneId` as the resolution anchor so dynamic pins
  // like `current_scene_body` resolve against the surface's host
  // scene even though no Scene Context block is emitting.
  if (!sceneNode) {
    return _renderPinnedSection(pinnedItems, hostSceneId, store, story, emissions, storyOrder).join('\n')
  }
  const chapters = story.chapters || []
  const acts = story.acts || []
  const chapterMemberOpts = chapterMemberOptsForStory(story)
  const data = sceneNode.data || {}

  const lines = []
  const title = data.title || 'Untitled scene'
  lines.push(`## Current scene context: ${title}`)
  lines.push('')

  if (data.description) {
    lines.push(`**Description**: ${_oneline(data.description)}`)
  }

  // Register the scene itself in the emissions tracker. Without
  // this, a static `scene` pin pointing at the SAME scene as the
  // active Scene Context would re-emit the description (and the
  // rest of the scene block) inside the Additional Context section
  // — the pin-side dedup check at `_renderPinnedSection` only
  // silent-skips when emissions already holds the `(kind, id,
  // anchor)` tuple. Registering with the scene's own id as the
  // anchor matches the `effectiveAnchor` a same-scene static pin
  // resolves to (scene pins are their own anchor).
  emissions.register('scene', sceneNode.id, sceneNode.id, 'full')

  // Chapter / act resolution. Chapter lives on the scene's
  // position via the chapter overlay; act is found via the
  // chapter's `act_id`.
  const chapterId = resolveChapterIdForNode(sceneNode, chapters, chapterMemberOpts)
  const chapter = chapterId ? chapters.find((c) => c.id === chapterId) : null
  if (chapter) {
    lines.push(`**Chapter**: ${chapter.title || chapter.name || 'Untitled'}`)
    if (chapter.act_id) {
      const act = acts.find((a) => a.id === chapter.act_id)
      if (act) lines.push(`**Act**: ${act.title || act.name || 'Untitled'}`)
    }
  }

  // Scene position along the story sequence. Same ordering the
  // Timeline Navigator uses — filtered from `storyOrder.orderedIds`
  // down to scene nodes only. Helps the model distinguish
  // "moved forward" from "replaced this scene" when the writer
  // switches focus to a different scene mid-conversation. Omitted
  // for scenes off the main path (storyOrder doesn't index them).
  const sceneOrder = storyOrder?.indexById
    ? _sceneOrderList(nodes, storyOrder)
    : []
  const scenePos = sceneOrder.indexOf(sceneNode.id)
  if (scenePos >= 0 && sceneOrder.length > 0) {
    lines.push(`**Scene position**: ${scenePos + 1} of ${sceneOrder.length} in the story`)
  }

  // POV + voice — combined into a natural-language sentence so the
  // model gets a clean prose statement instead of three scattered
  // metadata bullets. Clauses are gated independently:
  //   - POV character (derived from `scene.pov_entity_id`) — present
  //     when the scene has a POV character chip with has_pov=true.
  //     Name resolved AT this scene via the chain walker so a
  //     mid-story rename surfaces correctly.
  //   - Tense (`story.tense`) — story-level metadata in the Story
  //     Settings tab; "past" | "present" | null. Skipped when unset.
  //   - POV type (`story.pov_type_default`) — story-level metadata;
  //     "1st Person" | "2nd Person" | "3rd Person" | etc.; null when
  //     unset. (Previously the code read `story.pov_type` — a name
  //     that doesn't exist on the model — so this clause never
  //     actually fired. Fixed v0.2.9.43.)
  // If NONE of the three are present, the sentence is omitted
  // entirely — there's no context to surface.
  let povCharName = null
  if (data.pov_entity_id) {
    const povEntity = _findEntity(story, data.pov_entity_id)
    if (povEntity?.entity) {
      const { current } = computeEffectiveStateWithPrior(
        povEntity.entity, nodes, edges, sceneNode.id, { storyOrder },
      )
      povCharName = current.name || povEntity.entity.name || null
    }
  }
  const voiceClauses = []
  if (povCharName) voiceClauses.push(`from the point of view of ${povCharName}`)
  if (story.tense) voiceClauses.push(`written in ${story.tense} tense`)
  if (story.pov_type_default) voiceClauses.push(`in ${story.pov_type_default} perspective`)
  if (voiceClauses.length > 0) {
    // Join with commas and an Oxford-style "and" before the last
    // clause when there are three. Two-clause case reads naturally
    // with just a comma; one-clause case stands alone.
    let sentence
    if (voiceClauses.length === 1) {
      sentence = `This scene is ${voiceClauses[0]}.`
    } else if (voiceClauses.length === 2) {
      sentence = `This scene is ${voiceClauses[0]}, ${voiceClauses[1]}.`
    } else {
      sentence = `This scene is ${voiceClauses.slice(0, -1).join(', ')}, and ${voiceClauses[voiceClauses.length - 1]}.`
    }
    lines.push(sentence)
  }
  // Language — story-level metadata, kept as its own one-liner
  // because it doesn't compose naturally into the sentence above
  // ("This scene is in English" reads ambiguously). Skipped when
  // unset.
  if (story.language) lines.push(`**Language**: ${story.language}`)

  // Time / date / duration. Mirror the get_scene verbose `time`
  // extras shape; render as a flat one-liner.
  const timeBits = _timeBits(data)
  if (timeBits) lines.push(`**Time**: ${timeBits}`)
  if (data.is_flashback) lines.push('**This scene is a flashback.**')
  lines.push('')

  // Scene-level circumstances (story-level conditions framing the
  // whole scene). Distinct from per-entity circumstances below.
  if (Array.isArray(data.circumstances) && data.circumstances.length > 0) {
    lines.push('### Scene circumstances')
    for (const c of data.circumstances) {
      const head = c.name || 'Unnamed'
      const intensity = c.intensity != null ? ` *(${_intensityName(c.intensity)})*` : ''
      const desc = c.description ? ` — ${_oneline(c.description)}` : ''
      lines.push(`- ${head}${intensity}${desc}`)
    }
    lines.push('')
  }

  // Participants. Walk every entity in every bucket, compute
  // pre + post state via `computeEffectiveStateWithPrior`, and
  // render with inherited values plus inline change indicators.
  const scenePovEntityId = data.pov_entity_id || null
  let renderedAnyParticipants = false
  for (const bucket of ENTITY_BUCKETS) {
    const refs = data[bucket] || []
    if (!Array.isArray(refs) || refs.length === 0) continue
    const bucketLines = []
    for (const ref of refs) {
      const found = _findEntity(story, ref.entity_id)
      if (!found?.entity) continue
      try {
        const { current, prior } = computeEffectiveStateWithPrior(
          found.entity, nodes, edges, sceneNode.id, { storyOrder },
        )
        const hasPov = scenePovEntityId === ref.entity_id
        // Phase 2.12 — per-entity TEMPORARY circumstances/motivators
        // live on the scene node (NOT the chain). Filter to entries
        // for this entity and pass through; the formatter splices
        // them into the rendered Circumstances / Motivators groups
        // with a "*(temporary — this scene only)*" suffix.
        const entityTemporaries = (sceneNode.data?.entity_temporary_circumstances || [])
          .filter((t) => t && t.entity_id === ref.entity_id)
        bucketLines.push(..._formatParticipant(current, prior, {
          hasPov, type: found.type, story,
          observerCtx: { observerId: ref.entity_id, store, sceneId: sceneNode.id, story, storyOrder },
          entityTemporaries,
        }))
        emissions.register('entity', ref.entity_id, sceneNode.id, 'full')
      } catch {
        // Defensive — if the chain walk fails for one entity,
        // skip rather than nuke the whole block.
        continue
      }
    }
    if (bucketLines.length > 0) {
      if (!renderedAnyParticipants) {
        // No section title above the first bucket; just go
        // straight into headings per bucket so the block reads
        // as a flat list.
        renderedAnyParticipants = true
      }
      lines.push(`### ${_titleCase(bucket)}`)
      lines.push(...bucketLines)
      lines.push('')
    }
  }

  // Collect the set of entity ids that have a chip in this scene
  // so relationships / knowledges can be filtered to "what's
  // relevant to the cast on stage" rather than dumping every rel /
  // knowledge in the story.
  const sceneEntityIds = new Set()
  for (const bucket of ENTITY_BUCKETS) {
    for (const ref of (data[bucket] || [])) {
      if (ref && ref.entity_id) sceneEntityIds.add(ref.entity_id)
    }
  }

  // Relationships block — every relationship that has at least one
  // of the scene's participants on it. Walks the relationship's
  // chain to the scene via `get_relationship(at=this)` and surfaces
  // the resolved type / participants / role / perception. Skipped
  // when the chain walk reports the relationship hasn't yet been
  // established at this scene (`not_yet_exists: true`).
  const relationshipLines = _formatRelationships(store.relationships || [], sceneNode.id, sceneEntityIds, story, emissions)
  if (relationshipLines.length > 0) {
    lines.push('### Relationships in this scene')
    lines.push(...relationshipLines)
    lines.push('')
  }

  // Knowledges block — every knowledge with a chip on this scene
  // (same rule SceneNode uses to render KnowledgeChips: the
  // knowledge's node order includes this scene id), plus any
  // knowledge whose source event lives at this scene. Walks via
  // `get_knowledge(at=this)` so awareness shifts landing at this
  // scene get the same diff treatment as entity-level awareness.
  const knowledgeLines = _formatKnowledges(
    store.knowledges || [], sceneNode.id, sceneEntityIds, story,
    { nodes, edges, storyOrder }, emissions,
  )
  if (knowledgeLines.length > 0) {
    lines.push('### Knowledge relevant to this scene')
    lines.push(...knowledgeLines)
    lines.push('')
  }

  // Writer-pinned context — rendered after the main scene block in
  // a clearly labelled section so the model can tell scene-bound
  // material apart from out-of-scene material the writer wants
  // included.
  if (pinnedItems.length > 0) {
    const pinnedLines = _renderPinnedSection(pinnedItems, sceneNode.id, store, story, emissions, storyOrder)
    lines.push(...pinnedLines)
  }

  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}


// ── Additional context renderer ──────────────────────────────────
//
// Two pin shapes:
//   - Anchored: `item.anchor_node_id` is set to a canvas node id
//     (origin EntityNode / modifier / scene / knowledge or relation-
//     ship origin node). The pin resolves at THAT chain anchor,
//     period. No fallback to the conversation's active scene.
//   - Dynamic (legacy quick-picker, drop-zone): no `anchor_node_id`.
//     Falls back to the function-level `anchorSceneId` (the scene the
//     conversation is currently reading from). When that's also null
//     the walker returns the object's origin baseline.
//
// The output section is labelled "Additional Context" (and per-item
// headings "Additional Entity / Knowledge / Relationship / Scene")
// in the wire / preview text; "pinned" remains the internal data-
// model term for the writer-attached items. Anchored pins get an
// "(at <NodeLabel>)" suffix so the model understands the chain
// anchor specificity (e.g. "at scene Chapter 3" or "at origin").
function _renderPinnedSection(pinnedItems, anchorSceneId, store, story, emissions = null, sharedStoryOrder = null) {
  if (!Array.isArray(pinnedItems) || pinnedItems.length === 0) return []
  // Build the section body into `out` without the header; prepend the
  // header at return time only when there's actual content. Prevents
  // a bare "## Additional Context\n" from emitting when every pin
  // silent-skips (e.g. via the v0.2.10.32 dedup pass against Scene
  // Context's chip emissions).
  const out = []
  const nodes = store.nodes || []
  const edges = store.edges || []
  const storyOrder = sharedStoryOrder || getOrComputeStoryOrderFromStore()
  const _emissions = emissions || _createEmissionsTracker()

  // Phase 2.10b item 12 — dynamic pill resolution. Pins carrying
  // `pin_kind: 'dynamic'` route through the markerResolver pipeline
  // (utils/markerResolver.js) instead of the static `(kind, id)` flow
  // below. Resolution is silent-skip-on-missing-deps per planning doc
  // §4.4c; resolvers are pure over a `ResolutionContext` bundle the
  // caller pre-builds once per send. Dynamic resolutions land at the
  // top of the section in their pin-list order; static pins follow.
  //
  // Bundle construction is local to this function — the caller passes
  // `anchorSceneId` (= host scene for the surface) and we derive
  // everything else from the project store / context cues store. This
  // keeps the public `buildSceneContextBlock` signature stable while
  // letting all four send paths (chat / Section PBH / IPB / Scene
  // Description PBH) pick up dynamic-pill resolution for free.
  // Body-prose pins (`current_scene_body`) render in a separate
  // `## Current Scene Body Prose` section AFTER Additional Context, so
  // the model reads all framing context before the scene's actual
  // prose. Per Phase 2.10 Bug 7 follow-up.
  const dynamicPins = pinnedItems.filter((p) => p && p.pin_kind === 'dynamic' && p.marker && p.marker.type !== 'current_scene_body')
  const bodyProsePins = pinnedItems.filter((p) => p && p.pin_kind === 'dynamic' && p.marker && p.marker.type === 'current_scene_body')
  const staticPins = pinnedItems.filter((p) => !p || p.pin_kind !== 'dynamic')
  // Build the resolution context once if either branch needs it
  // (the dynamic-pin loop or the body-prose section below).
  const needsResolutionCtx = dynamicPins.length > 0 || bodyProsePins.length > 0
  const resolutionCtx = needsResolutionCtx
    ? buildResolutionContext(anchorSceneId, store, story, nodes, edges, storyOrder, _emissions)
    : null
  if (dynamicPins.length > 0) {
    for (const pin of dynamicPins) {
      const resolved = resolveMarker(pin.marker, resolutionCtx)
      if (resolved && typeof resolved === 'string') {
        out.push(resolved)
        out.push('')
      }
      // null = silent-skip per planning doc §4.4c. No placeholder, no
      // whitespace residue — the pin contributes nothing this send.
    }
  }
  // The remainder of this function consumes `pinnedItems` for the
  // static-pin grouping; rebind so dynamic pins don't double-render.
  pinnedItems = staticPins

  // Resolve a pin's anchor to its narrative-facing suffix. Stale
  // anchors (pin's anchor_node_id doesn't resolve to a current
  // canvas node — the auto-detach on conversation open SHOULD have
  // removed these, but a mid-session delete creates a transient
  // window) fall back to the origin / initial-state suffix for the
  // object's kind. The LLM never sees an "anchor missing" error;
  // it sees the baseline state with the initial-state framing.
  function _anchorSuffix(pinAnchor, itemKind) {
    if (!pinAnchor) return ''
    const node = nodes.find((n) => n.id === pinAnchor)
    if (!node) {
      return itemKind === 'entity'
        ? ' *(in their initial state at the start of the narrative)*'
        : ' *(in its initial state at the start of the narrative)*'
    }
    if (node.type === 'sceneNode') {
      return ` *(as they are at scene "${node.data?.title || 'Untitled'}")*`
    }
    if (node.type === 'entityNode') {
      return node.data?.is_modifier
        ? ' *(at a state-change point between scenes)*'
        : ' *(in their initial state at the start of the narrative)*'
    }
    if (node.type === 'knowledgeOriginNode' || node.type === 'relationshipOriginNode') {
      return ' *(in its initial state at the start of the narrative)*'
    }
    return ' *(at a specific point on its narrative chain)*'
  }

  // Resolve the pin's anchor for the chain walker. Stale anchors
  // fall back to null (origin baseline), so the walker returns the
  // object's initial state instead of erroring or returning
  // something arbitrary.
  function _resolveEffectiveAnchor(pinAnchor) {
    if (!pinAnchor) return anchorSceneId || null
    const node = nodes.find((n) => n.id === pinAnchor)
    if (!node) return null  // stale → origin baseline
    return pinAnchor
  }

  // Phase 2.7b — group same-(kind, id) pins so the model reads
  // multiple anchored versions of an entity / knowledge / relation-
  // ship as ONE underlying object whose state evolves across chain
  // positions, not as separate unrelated entries. The wrapper
  // explicitly tells the model the entries share a stable identity
  // even if names / attributes / relationships change between them.
  const groups = []
  const groupByKey = new Map()
  for (const item of pinnedItems) {
    if (!item || !item.kind || !item.id) continue
    if (item.kind === 'scene') {
      // Scenes are their own anchor; each scene pin is structurally
      // distinct from every other scene pin, so they don't group.
      groups.push({ kind: 'scene', id: item.id, items: [item] })
      continue
    }
    const key = `${item.kind}:${item.id}`
    let g = groupByKey.get(key)
    if (!g) {
      g = { kind: item.kind, id: item.id, items: [] }
      groupByKey.set(key, g)
      groups.push(g)
    }
    g.items.push(item)
  }

  // Sort each multi-anchor group by chain position so the model
  // reads the entity / knowledge / relationship in narrative order:
  // earliest chain position first (initial state), modifiers between,
  // latest scene last. Dynamic pins (no anchor) sort first within
  // their group (chain index -1).
  function _chainIdsFor(kind, id) {
    try {
      if (kind === 'entity') {
        const chain = getEntityNarrativeChain(id, nodes, edges)
        return (chain || []).map((n) => n.id)
      }
      if (kind === 'knowledge') {
        const k = (store.knowledges || []).find((x) => x.id === id)
        if (k) return getKnowledgeNodeOrder(k, nodes, edges) || []
      }
      if (kind === 'relationship') {
        const r = (store.relationships || []).find((x) => x.id === id)
        if (r) return getRelationshipNodeOrder(r, nodes, edges) || []
      }
    } catch { /* fall through */ }
    return []
  }
  // The chain id a pin "starts at" for sorting purposes. Range pins
  // sort by their start endpoint; single-anchor pins by their anchor
  // node; dynamic pins by -1 (earliest, treated as initial state).
  function _pinSortAnchor(pin) {
    if (pin?.anchor_range?.start_node_id) return pin.anchor_range.start_node_id
    if (pin?.anchor_node_id) return pin.anchor_node_id
    return null
  }
  for (const group of groups) {
    if (group.items.length > 1 && group.kind !== 'scene') {
      const chainIds = _chainIdsFor(group.kind, group.id)
      group.items.sort((a, b) => {
        const aAnchor = _pinSortAnchor(a)
        const bAnchor = _pinSortAnchor(b)
        const aIdx = aAnchor ? chainIds.indexOf(aAnchor) : -1
        const bIdx = bAnchor ? chainIds.indexOf(bAnchor) : -1
        return aIdx - bIdx
      })
    }
  }

  for (const group of groups) {
    const multi = group.items.length > 1
    if (multi) {
      const wrapperLines = _buildGroupWrapperHeading(group, store, story, { nodes, edges, storyOrder })
      if (wrapperLines.length > 0) {
        out.push(...wrapperLines)
        out.push('')
      }
    }
    for (const item of group.items) {
    const pinAnchor = item.anchor_node_id || null
    const effectiveAnchor = _resolveEffectiveAnchor(pinAnchor)
    const atSceneSuffix = _anchorSuffix(pinAnchor, item.kind)
    // Dedup: silent-skip this pin if Scene Context (or an earlier
    // pin in this same render) already emitted the same object at
    // the same anchor with at least as much detail. Range pins are
    // exempt — their multi-anchor delta emission is structurally
    // distinct from a single-anchor chip and shouldn't be folded
    // into a single-anchor registration.
    const isRangePin = !!item.anchor_range
    if (!isRangePin && _emissions.check(item.kind, item.id, effectiveAnchor)) {
      continue
    }
    // Pre-register so a later pin at the same `(kind, id, anchor)`
    // silent-skips against this one. Pre-registration also means a
    // walker-error skip below leaves the tuple "claimed" — the next
    // pin at that anchor won't emit either. That matches current
    // behaviour where both pins fail the same walker call.
    if (!isRangePin) {
      _emissions.register(item.kind, item.id, effectiveAnchor, 'full')
    }
    // When this item belongs to a multi-anchor group, render the
    // per-anchor heading at #### so the parent ### wrapper carries
    // the shared-identity framing. Single-anchor groups keep ###.
    const headLevel = multi ? '####' : '###'
    if (item.kind === 'entity') {
      const found = _findEntity(story, item.id)
      if (!found?.entity) continue
      // Range pin (Phase 2.7c) — emit full state at start, deltas at
      // every in-range point, full state at end.
      if (item.anchor_range) {
        try {
          _emitEntityRangePin(item, found, multi, headLevel, out, {
            nodes, edges, story, store, storyOrder,
          })
        } catch { /* skip pin on walker error */ }
        continue
      }
      // Dynamic-pin fallback semantics: when neither an explicit pin
      // anchor nor an active scene is available, `effectiveAnchor` is
      // null and `computeEffectiveStateWithPrior(..., null, ...)`
      // applies EVERY change in the entity's main forward chain — i.e.
      // the latest state. This is the intentional fallback for "writer
      // references the entity without anchoring to a specific point in
      // the story" — they get the entity as they've authored it so far,
      // not as it was first introduced. The pill tooltip and badge are
      // worded to match.
      //
      // When in this fallback mode, override `prior = current` so the
      // diff annotations in `_formatParticipant` ("renames during this
      // scene", "changes during this scene", "added during this scene")
      // suppress entirely. The walker's default `prior` is baseline,
      // which would cause every chain change to read as "happens during
      // this scene" — misleading, since there IS no "this scene" in
      // the latest-state fallback.
      try {
        let { current, prior } = computeEffectiveStateWithPrior(
          found.entity, nodes, edges, effectiveAnchor, { storyOrder },
        )
        if (!effectiveAnchor) prior = current
        const name = current?.name || found.entity.name || '(unnamed)'
        const typeCap = found.type
          ? found.type.charAt(0).toUpperCase() + found.type.slice(1)
          : 'Entity'
        const headPrefix = multi ? `Same ${typeCap.toLowerCase()}` : `Additional ${typeCap}`
        out.push(`${headLevel} ${headPrefix}: ${name}${atSceneSuffix}`)
        out.push('')
        // Phase 2.12 — temporary c/m on the resolved anchor scene
        // (if the anchor is a scene; entity-node modifier anchors
        // don't carry temporaries, only scenes do).
        const _anchorSceneNode = effectiveAnchor
          ? (nodes || []).find((n) => n && n.id === effectiveAnchor && n.type === 'sceneNode')
          : null
        const entityTemporaries = (_anchorSceneNode?.data?.entity_temporary_circumstances || [])
          .filter((t) => t && t.entity_id === item.id)
        const participantLines = _formatParticipant(current, prior, {
          hasPov: false,
          type: found.type,
          story,
          observerCtx: effectiveAnchor
            ? { observerId: item.id, store, sceneId: effectiveAnchor, story, storyOrder }
            : null,
          entityTemporaries,
        })
        out.push(...participantLines)
        // Relationships this entity participates in, resolved at the
        // same anchor via the relationship chain walker (the proven
        // relationship-pill path; works at a null anchor = latest state).
        // Listed so the model sees who/what the entity is connected to,
        // with any faction membership named (membership_of resolved to
        // the faction's name, never the id).
        try {
          const _relLines = []
          for (const _r of (store.relationships || [])) {
            if (!_r || !_r.id || !_relMentionsEntity(_r, item.id)) continue
            let _eff
            try {
              const _order = getRelationshipNodeOrder(_r, nodes, edges)
              _eff = computeRelationshipEffectiveState(_r, _order, effectiveAnchor, { storyOrder })
            } catch { continue }
            if (!_eff || _eff.not_yet_exists) continue
            const _parts = Array.isArray(_eff.participants) ? _eff.participants : []
            // Only list it if the entity is an EFFECTIVE participant here.
            if (!_parts.some((p) => (p?.entity_id || p?.id) === item.id)) continue
            const _others = _parts
              .filter((p) => (p?.entity_id || p?.id) !== item.id)
              .map((p) => _entityName(story, p.entity_id || p.id) || '(unknown)')
            const _relType = _eff.type || _r.type || 'relationship'
            const _relName = _eff.name
              || _parts.map((p) => _entityName(story, p.entity_id || p.id) || '(unknown)').join(' & ')
              || 'Untitled relationship'
            const _factionId = _r.membership_of || _eff.membership_of || null
            const _factionTag = _factionId ? ` [member of ${_entityName(story, _factionId) || 'a faction'}]` : ''
            const _withWhom = _others.length > 0 ? ` — with ${_others.join(', ')}` : ''
            const _ended = _eff.status === 'ended' ? ' *(ended by this point)*' : ''
            _relLines.push(`- **${_relName}** *(${_relType})*${_factionTag}${_withWhom}${_ended}`)
          }
          if (_relLines.length > 0) {
            out.push('Relationships:')
            out.push(..._relLines)
          }
        } catch { /* skip relationships section on error */ }
        out.push('')
      } catch { /* skip pin on walker error */ }
      continue
    }
    if (item.kind === 'knowledge') {
      const k = (store.knowledges || []).find((x) => x.id === item.id)
      if (!k) continue
      // Range pin (Phase 2.7c).
      if (item.anchor_range) {
        try {
          _emitKnowledgeRangePin(item, k, multi, headLevel, out, {
            nodes, edges, story, storyOrder,
          })
        } catch { /* skip pin on walker error */ }
        continue
      }
      try {
        const order = getKnowledgeNodeOrder(k, nodes, edges)
        const eff = computeKnowledgeEffectiveState(k, order, effectiveAnchor, { nodes, ctx: { storyOrder } })
        const name = eff?.name || k.name || 'Untitled knowledge'
        const headPrefix = multi ? 'Same knowledge' : 'Additional Knowledge'
        out.push(`${headLevel} ${headPrefix}: ${name}${atSceneSuffix}`)
        if (eff?.description) out.push(_oneline(eff.description))
        // Awareness section — who knows this knowledge at the anchor.
        const aw = _flatAwareness(eff?.awareness_raw ?? eff?.awareness)
        if (Object.keys(aw).length > 0) {
          out.push('')
          out.push('Known to:')
          for (const [observerId, level] of Object.entries(aw)) {
            const oname = _entityName(story, observerId) || observerId
            out.push(`- ${oname}: ${_awarenessLevelName(level)}`)
          }
        }
        out.push('')
      } catch { /* skip pin on walker error */ }
      continue
    }
    if (item.kind === 'relationship') {
      const rel = (store.relationships || []).find((x) => x.id === item.id)
      if (!rel) continue
      // Range pin (Phase 2.7c).
      if (item.anchor_range) {
        try {
          _emitRelationshipRangePin(item, rel, multi, headLevel, out, {
            nodes, edges, story, storyOrder,
          })
        } catch { /* skip pin on walker error */ }
        continue
      }
      try {
        const order = getRelationshipNodeOrder(rel, nodes, edges)
        const eff = computeRelationshipEffectiveState(rel, order, effectiveAnchor, { storyOrder })
        const partList = Array.isArray(eff?.participants) ? eff.participants : []
        const names = partList.map((p) => _entityName(story, p.entity_id || p.id) || '(unknown)')
        const head = eff?.name || (names.length > 0 ? names.join(' & ') : 'Untitled relationship')
        const type = eff?.type || rel.type || 'relationship'
        const headPrefix = multi ? 'Same relationship' : 'Additional Relationship'
        out.push(`${headLevel} ${headPrefix}: ${head} *(${type})*${atSceneSuffix}`)
        if (eff?.description) out.push(_oneline(eff.description))
        if (eff?.status === 'ended') out.push('Status: ended *(no longer active by this anchor)*')
        if (partList.length > 0) {
          out.push('Participants:')
          for (const p of partList) {
            const pname = _entityName(story, p.entity_id || p.id) || '(unknown)'
            const role = p.role ? ` (${p.role})` : ''
            const perception = p.perception ? ` — perceives the relationship as: ${_oneline(p.perception)}` : ''
            out.push(`- ${pname}${role}${perception}`)
          }
        }
        const aw = _flatAwareness(eff?.awareness_raw ?? eff?.awareness)
        if (Object.keys(aw).length > 0) {
          out.push('Known to:')
          for (const [observerId, level] of Object.entries(aw)) {
            const oname = _entityName(story, observerId) || observerId
            out.push(`- ${oname}: ${_awarenessLevelName(level)}`)
          }
        }
        out.push('')
      } catch { /* skip pin on walker error */ }
      continue
    }
    if (item.kind === 'scene') {
      const sceneNode = nodes.find((n) => n.id === item.id && n.type === 'sceneNode')
      if (!sceneNode) continue
      // Delegate to the story-scope bundle/appendage machinery so
      // the scene's `mode` (summary / summary_with_changes /
      // full_content) drives the same rendering chat-composer Story
      // Scope chips have always used. One source of truth for
      // scene-pin rendering across every surface; the writer's
      // cycle button on the chip directly affects this output.
      const mode = item.mode || 'summary'
      try {
        const bundle = buildStoryScopeBundle({
          scopeScenes: [{ id: item.id, mode }],
          activeSceneId: anchorSceneId,
          story,
          nodes,
          edges,
          storyOrder,
          // Phase 2.13c — forward live top-level knowledges + rels so
          // perspective target lookup in the change-line walker
          // resolves against current state.
          knowledges: store.knowledges || [],
          relationships: store.relationships || [],
        })
        const rendered = buildStoryScopeAppendage(bundle)
        if (rendered) {
          out.push(rendered)
          out.push('')
        }
      } catch {
        // Defensive fallback — single-line title so the writer
        // doesn't see total silence if the bundle machinery throws.
        const title = sceneNode.data?.title || 'Untitled scene'
        out.push(`### Additional Scene: ${title}`)
        out.push('')
      }
    }
    if (item.kind === 'cue') {
      // Context Cues live in their own store (program-level, no
      // chain). The body is stored as TipTap HTML (rich-text editing
      // landed in v0.2.5.42), so we convert through the shared
      // `tiptapHtmlToMarkdown` helper before emitting — preserves
      // paragraph breaks, bullet lists, etc. without the LLM seeing
      // raw `<p>` / `<li>` markup.
      const cue = useContextCuesStore.getState().getCueById(item.id)
      if (!cue) continue
      const name = (cue.name || '').trim() || 'Untitled cue'
      const body = tiptapHtmlToMarkdown(cue.body)
      out.push(`### Additional Context: ${name}`)
      if (body) out.push(body)
      out.push('')
    }
    if (item.kind === 'concept') {
      // Concept (brainstorming) node — a program-level `referenceNode` with no
      // chain, so it renders like a Context Cue: title + rich-text body. The
      // body is stored as TipTap JSON (`is_rich_text`), so convert JSON → HTML
      // → markdown (reusing the same `tiptapHtmlToMarkdown` helper) so the
      // model reads clean prose, not raw doc markup; a plain-text body (never
      // switched to rich text) is emitted verbatim.
      const node = nodes.find((n) => n.id === item.id && n.type === 'referenceNode' && n.data?.sub_type === 'concept')
      if (!node) continue
      const title = (node.data?.title || '').trim() || 'Untitled concept'
      const rawContent = node.data?.content || ''
      let body = ''
      if (node.data?.is_rich_text && rawContent) {
        try {
          const json = typeof rawContent === 'string' ? JSON.parse(rawContent) : rawContent
          body = tiptapHtmlToMarkdown(generateHTML(json, TIPTAP_EXTENSIONS))
        } catch { body = '' }
      } else if (typeof rawContent === 'string') {
        body = rawContent.trim()
      }
      out.push(`### Additional Context: Concept "${title}"`)
      if (body) out.push(body)
      out.push('')
    }
    if (item.kind === 'section') {
      // Phase 2.9b — Section pill. Sections live inside the host
      // surface's TipTap content (scene main_content / cue body /
      // reference note / entity notes / knowledge notes); resolved
      // live via `findSectionContent`. The pill's content tracks
      // the section's current state — every send re-walks the host
      // surface and emits the section's CURRENT prose. Skip
      // gracefully when the host surface or section has been
      // deleted since the pin was created (stale pill).
      const found = findSectionContent(
        item.surface_type,
        item.surface_host_id,
        item.id,
      )
      if (!found) continue
      const name = (found.name || '').trim() || 'Untitled Section'
      const hostInfo = findSectionHostInfo(item.surface_type, item.surface_host_id)
      const body = tiptapHtmlToMarkdown(found.htmlContent)
      // "Section" is internal vocabulary; the LLM has no reference for
      // what kind of text it's looking at. Frame the excerpt with its
      // host context so the model knows whether it's pulling from a
      // scene's prose, a context cue, a reference note, an entity's
      // Notes, or a knowledge's Notes.
      const heading = hostInfo
        ? `### Additional Context: Section "${name}" (excerpt from ${hostInfo.hostPhrase})`
        : `### Additional Context: Section "${name}"`
      out.push(heading)
      if (body) out.push(body)
      out.push('')
    }
    if (item.kind === 'toc') {
      // Story Table of Contents — static, story-specific pin. The pin's
      // `id` is the story's id; when the loaded story switches, the
      // stale-pin auto-strip removes it (see ConversationView.jsx Bug 4
      // strip logic) so a TOC pin always reflects the current story
      // OR is gone. Builder reads non-chain-tracked structural metadata
      // (chapter/act/scene titles, ordering) and respects user-
      // configured `chapter_label` / `act_label`.
      const tocCtx = {
        story,
        nodes,
        edges,
        storyOrder,
        hostScene: anchorSceneId
          ? nodes.find((n) => n && n.id === anchorSceneId && n.type === 'sceneNode') || null
          : null,
      }
      const tocBlock = buildStoryTocBlock(tocCtx)
      if (tocBlock) {
        out.push(tocBlock)
        out.push('')
      }
      continue
    }
    }
  }
  const result = []
  if (out.length > 0) {
    result.push('## Additional Context', '', ...out)
  }
  // Body-prose section — emitted as a top-level section AFTER
  // Additional Context. The resolver returns a fully wrapped
  // `<Scene title="...">...</Scene>` string so the AI sees the same
  // self-describing tag the Scene Description PBH uses for its
  // persistent Scene-prose pill. No extra header / framing here —
  // the tag IS the framing. Singleton: only the first resolving
  // body-prose pin emits (defence-in-depth against stale duplicates;
  // markerKey dedup at add-time should already prevent multiples).
  if (bodyProsePins.length > 0) {
    for (const pin of bodyProsePins) {
      const prose = resolveMarker(pin.marker, resolutionCtx)
      if (prose && typeof prose === 'string') {
        if (result.length > 0 && result[result.length - 1] !== '') result.push('')
        result.push(prose, '')
        break
      }
    }
  }
  return result
}


// Build the wrapper heading + framing sentence for a multi-anchor
// group.
//
// Heading format: `<Origin Name>` is the entity / knowledge /
// relationship's baseline name (stable identifier — what the object
// was first called when introduced). When the chain-EARLIEST attached
// anchor resolves to a DIFFERENT name than baseline (the writer
// pinned versions of the object from after a name change), the
// earliest resolved name appears in parens so the LLM can correlate
// the wrapper identity to the actual names it'll see in the entries
// below. When they match, only the single name is shown.
function _buildGroupWrapperHeading(group, store, story, ctx) {
  if (!group || !Array.isArray(group.items) || group.items.length < 2) return []
  const { nodes = [], edges = [], storyOrder = null } = ctx || {}
  // Earliest anchor in the group, after sort: for a range pin we
  // resolve the "earliest" name at its start endpoint; for a single-
  // anchor pin we use its anchor node; for a dynamic pin (no anchor)
  // we fall through to baseline.
  const firstItem = group.items[0]
  const firstAnchor = firstItem?.anchor_range?.start_node_id
    || firstItem?.anchor_node_id
    || null
  const validFirstAnchor = firstAnchor && nodes.find((n) => n.id === firstAnchor) ? firstAnchor : null
  // Wrapper "at N points" — count every distinct chain point covered
  // by the group's pins, deduped. A single-anchor contributes 1; a
  // range contributes (end - start + 1) chain points; a dynamic pin
  // contributes 0 (no anchored coverage). Falls back to item count
  // when the chain can't be resolved.
  function _chainIdsForGroup() {
    try {
      if (group.kind === 'entity') {
        const chain = getEntityNarrativeChain(group.id, nodes, edges)
        return (chain || []).map((n) => n.id)
      }
      if (group.kind === 'knowledge') {
        const k = (store.knowledges || []).find((x) => x.id === group.id)
        if (k) return getKnowledgeNodeOrder(k, nodes, edges) || []
      }
      if (group.kind === 'relationship') {
        const r = (store.relationships || []).find((x) => x.id === group.id)
        if (r) return getRelationshipNodeOrder(r, nodes, edges) || []
      }
    } catch { /* fall through */ }
    return []
  }
  function _countChainPoints() {
    const chainIds = _chainIdsForGroup()
    if (!chainIds || chainIds.length === 0) return group.items.length
    const covered = new Set()
    for (const it of group.items) {
      if (it.anchor_range && it.anchor_range.start_node_id && it.anchor_range.end_node_id) {
        const s = chainIds.indexOf(it.anchor_range.start_node_id)
        const e = chainIds.indexOf(it.anchor_range.end_node_id)
        if (s >= 0 && e >= 0 && s <= e) {
          for (let i = s; i <= e; i++) covered.add(chainIds[i])
        }
        continue
      }
      if (it.anchor_node_id) {
        covered.add(it.anchor_node_id)
      }
    }
    return covered.size > 0 ? covered.size : group.items.length
  }
  const pointCount = _countChainPoints()
  function _formatHeadName(baseline, earliest) {
    const b = (baseline || '').trim()
    const e = (earliest || '').trim()
    if (!b && !e) return '(unnamed)'
    if (!b) return e
    if (!e || b === e) return b
    return `${b} (later called "${e}")`
  }
  if (group.kind === 'entity') {
    const found = _findEntity(story, group.id)
    if (!found?.entity) return []
    const baseline = found.entity.name || '(unnamed)'
    let earliest = baseline
    try {
      const eff = computeEffectiveState(found.entity, nodes, edges, validFirstAnchor, { storyOrder })
      if (eff?.name) earliest = eff.name
    } catch { /* fall through */ }
    const typeCap = found.type
      ? found.type.charAt(0).toUpperCase() + found.type.slice(1)
      : 'Entity'
    return [
      `### Additional ${typeCap} (at ${pointCount} points in the narrative): ${_formatHeadName(baseline, earliest)}`,
      `*The ${group.items.length} entries below all describe the SAME ${typeCap.toLowerCase()} at different points in the narrative. Their identity is stable across the entries even when name, attributes, or relationships change between these points. Treat them as ONE ${typeCap.toLowerCase()} whose state evolves across these points in the narrative.*`,
    ]
  }
  if (group.kind === 'knowledge') {
    const k = (store.knowledges || []).find((x) => x.id === group.id)
    if (!k) return []
    const baseline = k.name || 'Untitled knowledge'
    let earliest = baseline
    try {
      const order = getKnowledgeNodeOrder(k, nodes, edges)
      const eff = computeKnowledgeEffectiveState(k, order, validFirstAnchor, { nodes, ctx: { storyOrder } })
      if (eff?.name) earliest = eff.name
    } catch { /* fall through */ }
    return [
      `### Additional Knowledge (at ${pointCount} points in the narrative): ${_formatHeadName(baseline, earliest)}`,
      `*The ${group.items.length} entries below all describe the SAME knowledge at different points in the narrative. Identity is stable across the entries even when name, description, or awareness change. Treat them as ONE knowledge whose state evolves across these points in the narrative.*`,
    ]
  }
  if (group.kind === 'relationship') {
    const rel = (store.relationships || []).find((x) => x.id === group.id)
    if (!rel) return []
    function _participantsFallback(eff) {
      const partList = Array.isArray(eff?.participants) ? eff.participants : []
      const names = partList.map((p) => _entityName(story, p.entity_id || p.id) || '(unknown)')
      return names.length > 0 ? names.join(' & ') : 'Untitled relationship'
    }
    const baseline = rel.name || _participantsFallback(rel)
    let earliest = baseline
    try {
      const order = getRelationshipNodeOrder(rel, nodes, edges)
      const eff = computeRelationshipEffectiveState(rel, order, validFirstAnchor, { storyOrder })
      earliest = eff?.name || _participantsFallback(eff || rel)
    } catch { /* fall through */ }
    return [
      `### Additional Relationship (at ${pointCount} points in the narrative): ${_formatHeadName(baseline, earliest)}`,
      `*The ${group.items.length} entries below all describe the SAME relationship at different points in the narrative. Identity is stable across the entries even when name, participants, or status change. Treat them as ONE relationship whose state evolves across these points in the narrative.*`,
    ]
  }
  return []
}


// ── Relationships ────────────────────────────────────────────────


// True if the raw relationship object lists `entityId` among its
// participants (handles both the `participants[]` array shape and the
// `participant_roles{}` dict shape). Cheap pre-filter for an entity's
// relationships dossier before chain-resolving each candidate.
function _relMentionsEntity(rel, entityId) {
  if (!rel || !entityId) return false
  if (Array.isArray(rel.participants) && rel.participants.some((p) => (p?.entity_id || p) === entityId)) return true
  if (rel.participant_roles && typeof rel.participant_roles === 'object' && entityId in rel.participant_roles) return true
  return false
}

function _formatRelationships(relationships, sceneId, sceneEntityIds, story, emissions = null) {
  if (!Array.isArray(relationships) || relationships.length === 0) return []
  const handler = getMcpToolHandler('get_relationship')
  if (typeof handler !== 'function') return []
  const out = []
  for (const rel of relationships) {
    if (!rel || !rel.id) continue
    const participants = Array.isArray(rel.participants) ? rel.participants : []
    // Filter: relationship must touch at least one entity that's
    // on stage in this scene. Otherwise it's not relevant context.
    const touchesScene = participants.some((p) => p && sceneEntityIds.has(p.entity_id || p))
    if (!touchesScene) continue
    let projected
    try {
      projected = handler({ relationship: rel.id, at: sceneId })
    } catch {
      continue
    }
    if (!projected || projected.not_yet_exists) continue
    out.push(..._formatRelationshipLines(projected, story))
    if (emissions) emissions.register('relationship', rel.id, sceneId, 'full')
  }
  return out
}


function _formatRelationshipLines(rel, story) {
  const out = []
  const type = rel.type || 'relationship'
  // Build a one-line header from participant names. `rel.participants`
  // here is the projected list from `get_relationship(at=scene)`,
  // each carrying `entity_id` and `role`.
  const partList = Array.isArray(rel.participants) ? rel.participants : []
  const names = partList.map((p) => _entityName(story, p.entity_id || p.id) || '(unknown)')
  const head = rel.name || (names.length > 0 ? names.join(' & ') : 'Untitled relationship')
  out.push(`- **${head}** *(${type})*`)
  if (rel.description) out.push(`  - ${_oneline(rel.description)}`)
  if (rel.status === 'ended') out.push('  - Status: ended *(no longer active by this scene)*')
  // Per-participant role + perception.
  if (partList.length > 0) {
    for (const p of partList) {
      const pname = _entityName(story, p.entity_id || p.id) || '(unknown)'
      const role = p.role ? ` (${p.role})` : ''
      const perception = p.perception ? ` — perceives the relationship as: ${_oneline(p.perception)}` : ''
      out.push(`  - ${pname}${role}${perception}`)
    }
  }
  // Awareness — who knows this relationship exists / how clearly.
  const aw = _flatAwareness(rel.awareness)
  if (Object.keys(aw).length > 0) {
    out.push('  - Known to:')
    for (const [observerId, level] of Object.entries(aw)) {
      const oname = _entityName(story, observerId) || observerId
      out.push(`    - ${oname}: ${_awarenessLevelName(level)}`)
    }
  }
  return out
}


// ── Knowledges ───────────────────────────────────────────────────


function _formatKnowledges(knowledges, sceneId, sceneEntityIds, story, ctx, emissions = null) {
  if (!Array.isArray(knowledges) || knowledges.length === 0) return []
  const handler = getMcpToolHandler('get_knowledge')
  if (typeof handler !== 'function') return []
  const { nodes = [], edges = [], storyOrder = null } = ctx || {}
  const out = []
  for (const k of knowledges) {
    if (!k || !k.id) continue
    // Match the SceneNode's own rule for "knowledge appears on
    // this scene's chip strip": the knowledge's chain node order
    // includes this scene id. Any knowledge that's a chip on the
    // scene gets included verbatim.
    let onSceneChips = false
    try {
      const order = getKnowledgeNodeOrder(k, nodes, edges, storyOrder)
      onSceneChips = Array.isArray(order) && order.includes(sceneId)
    } catch {
      onSceneChips = false
    }
    let projected
    try {
      projected = handler({ knowledge: k.id, at: sceneId })
    } catch {
      continue
    }
    if (!projected || projected.not_yet_exists) continue
    // Filter: include if the knowledge has a chip on this scene,
    // its source event lives here, or one of its observers is on
    // stage. Knowledge chips on the scene are the strongest signal
    // — the writer literally placed it there.
    const sourceHere = k.source_event && k.source_event.node_id === sceneId
    const observerOnStage = _knowledgeObserverOnStage(projected, sceneEntityIds)
    if (!onSceneChips && !sourceHere && !observerOnStage) continue
    out.push(..._formatKnowledgeLines(projected, sourceHere, story))
    if (emissions) emissions.register('knowledge', k.id, sceneId, 'full')
  }
  return out
}


function _knowledgeObserverOnStage(projected, sceneEntityIds) {
  const aw = _flatAwareness(projected?.awareness)
  for (const observerId of Object.keys(aw)) {
    if (sceneEntityIds.has(observerId)) return true
  }
  return false
}


function _formatKnowledgeLines(k, sourceHere, story) {
  const out = []
  const head = k.name || 'Untitled knowledge'
  const sourceTag = sourceHere ? ' *(this scene is the source — learned here)*' : ''
  out.push(`- **${head}**${sourceTag}`)
  if (k.description) out.push(`  - ${_oneline(k.description)}`)
  const aw = _flatAwareness(k.awareness)
  if (Object.keys(aw).length > 0) {
    out.push('  - Known to:')
    for (const [observerId, level] of Object.entries(aw)) {
      const oname = _entityName(story, observerId) || observerId
      out.push(`    - ${oname}: ${_awarenessLevelName(level)}`)
    }
  }
  return out
}


// ── Per-participant formatter ────────────────────────────────────


function _formatParticipant(current, prior, { hasPov, type, story, observerCtx, entityTemporaries = [] }) {
  const out = []
  const name = current.name || 'Unnamed'
  const povTag = hasPov ? ' *(POV)*' : ''
  // Name change indicator. If the entity's name itself shifts in
  // this scene, lead with "X (was 'Y')" so the model sees the
  // continuity at a glance.
  if (prior?.name && prior.name !== current.name) {
    out.push(`- **${name}**${povTag} *(was "${prior.name}"; renames during this scene)*`)
  } else {
    out.push(`- **${name}**${povTag}`)
  }
  // Type label so the model can disambiguate when a scene has
  // a character and a location with the same name (edge case but
  // free to surface).
  if (type) out.push(`  - Type: ${type}`)

  // Description. If it shifts in this scene, render as a clear
  // change; else render the inherited value.
  if (prior?.description !== current.description) {
    const beforeText = prior?.description ? `"${_oneline(prior.description)}"` : '(none)'
    const afterText = current.description ? `"${_oneline(current.description)}"` : '(none)'
    out.push(`  - Description: ${beforeText} → ${afterText} *(changes during this scene)*`)
  } else if (current.description) {
    out.push(`  - Description: ${_oneline(current.description)}`)
  }

  // Aliases. Surface the active set; flag added/removed in this
  // scene.
  const priorAliases = _aliasNames(prior?.aliases)
  const currentAliases = _aliasNames(current.aliases)
  if (currentAliases.length > 0 || priorAliases.length > 0) {
    if (_arraysEqual(priorAliases, currentAliases)) {
      if (currentAliases.length > 0) out.push(`  - Aliases: ${currentAliases.join(', ')}`)
    } else {
      const added = currentAliases.filter((a) => !priorAliases.includes(a))
      const removed = priorAliases.filter((a) => !currentAliases.includes(a))
      const diffBits = []
      if (currentAliases.length > 0) diffBits.push(`now ${currentAliases.join(', ')}`)
      if (added.length > 0) diffBits.push(`added: ${added.join(', ')}`)
      if (removed.length > 0) diffBits.push(`dropped: ${removed.join(', ')}`)
      out.push(`  - Aliases: ${diffBits.join('; ')} *(changes during this scene)*`)
    }
  }

  // Group the effective-state attributes into regular / circumstance
  // / motivator buckets so the model gets the conceptual separation
  // (motivators drive what the character WANTS; circumstances are
  // what they're CARRYING; regular attributes are their stable
  // qualities).
  // `name` is the chain-resolved host name resolved earlier in this
  // function (it's the value rendered in the participant header).
  // Pass it through so the Perspectives subsection's lines read as
  // "<host>'s Perspective of <target>: ..." — keeps each row a
  // complete clause for the model, not just a target descriptor.
  const grouped = _groupAttributes(current.attributes, prior?.attributes, story, name)
  // Phase 2.12 — append per-entity TEMPORARY circumstances /
  // motivators that live on the scene node (NOT on the chain). These
  // exist only for this one scene and don't carry forward; the
  // "*(temporary — this scene only)*" suffix on each formatted line
  // tells the model. Already filtered to the current entity by the
  // caller.
  const tempCircLines = []
  const tempMotLines = []
  for (const t of (entityTemporaries || [])) {
    if (!t) continue
    if (t.attribute_type === 'circumstance') tempCircLines.push(_formatTemporaryCM(t))
    else if (t.attribute_type === 'motivator') tempMotLines.push(_formatTemporaryCM(t))
  }
  if (grouped.regular.length > 0) {
    out.push('  - Attributes:')
    for (const line of grouped.regular) out.push(`    - ${line}`)
  }
  if (grouped.circumstances.length > 0 || tempCircLines.length > 0) {
    out.push('  - Circumstances:')
    for (const line of grouped.circumstances) out.push(`    - ${line}`)
    for (const line of tempCircLines) out.push(`    - ${line}`)
  }
  if (grouped.motivators.length > 0 || tempMotLines.length > 0) {
    out.push('  - Motivators:')
    for (const line of grouped.motivators) out.push(`    - ${line}`)
    for (const line of tempMotLines) out.push(`    - ${line}`)
  }
  // Phase 2.13c — Perspectives. Per the planning doc, the
  // "Perspectives:" subsection sits beneath C / M. No temporary
  // variant: perspectives are not scene-scoped, only chain-tracked.
  // Orphaned-target rows were skipped at bucket-time so this block
  // only renders meaningful entries (or stays absent entirely).
  if (grouped.perspectives.length > 0) {
    out.push('  - Perspectives:')
    for (const line of grouped.perspectives) out.push(`    - ${line}`)
  }

  // Known to: who's observing THIS entity (entity-level only).
  const knownToLines = _formatEntityAwarenessLines(current, prior, story)
  if (knownToLines.length > 0) {
    out.push('  - Known to:')
    for (const line of knownToLines) out.push(`    - ${line}`)
  }

  // Aware of: what THIS entity (as the observer) knows about at the
  // scene anchor. Walks every other awareness-bearing surface in the
  // project — other entities' existence / name / aliases /
  // attributes, every relationship, every knowledge — and lists the
  // ones where this entity appears in the awareness dict's keys.
  // Mirrors what the entity Detail Panel's "Aware of" section shows.
  //
  // The level → item hierarchy is two-deep; `_collectAwareOf`
  // already emits its own bullet markers (`- Fully aware:` then
  // `  - knowledge "X"`), so we splice them under "Aware of:" with
  // a plain 4-space indent — adding another `- ` here would
  // double-bullet and flatten the nesting in the rendered Markdown.
  if (observerCtx) {
    const awareOfLines = _collectAwareOf({ ...observerCtx, observerName: name })
    if (awareOfLines.length > 0) {
      // Header reads "Awareness" rather than "Aware of" because the
      // section spans every awareness level — including Unaware,
      // which contradicts "aware of" semantically. "Awareness" is
      // neutral about direction (aware ↔ unaware) and just names
      // the dimension being surfaced.
      out.push('  - Awareness:')
      for (const line of awareOfLines) out.push(`    ${line}`)
    }
  }

  return out
}


// ── Aware of: walk every awareness-bearing surface at this scene
// and collect entries where `observerId` is a key (i.e. this entity
// is the observer). Returns ready-to-render lines grouped by level.
function _collectAwareOf({ observerId, store, sceneId, story, storyOrder, observerName = null }) {
  if (!observerId || !store) return []
  const nodes = store.nodes || []
  const edges = store.edges || []
  const relationships = store.relationships || []
  const knowledges = store.knowledges || []
  const entitiesObj = story.entities || {}
  const allEntities = ENTITY_BUCKETS.flatMap((b) => entitiesObj[b] || [])

  // Bucket records by level (3 fully → 0 unaware) then format.
  const byLevel = { 3: [], 2: [], 1: [], 0: [] }

  // Shared ctx for the observer-side resolver. The resolver walks
  // the wrapper (`awareness_raw`) at the anchor with the full
  // inheritance rules: direct entry wins, then faction
  // direct-entry cascade via the faction's membership relationship,
  // then relationship sources, then attribute sources. Without
  // this ctx the inherited paths can't resolve.
  const resolverCtx = {
    allEntities,
    allRelationships: relationships,
    nodes,
    edges,
    storyOrder,
    anchorNodeId: sceneId,
  }
  const observerLevel = (wrapper) => resolveObserverAwarenessLevel(wrapper, observerId, resolverCtx)

  // Phase 2.12 — descriptions ride along with awareness entries so
  // the model knows WHAT the observer is aware (or unaware) of, not
  // just the name. Critical when the observer is Unaware of a piece
  // of knowledge — without the description, the model doesn't know
  // what to keep the character ignorant of.
  const _descSuffix = (text) => {
    if (!text) return ''
    const trimmed = String(text).trim()
    return trimmed ? ` : "${trimmed}"` : ''
  }

  // Iterate every entity in the story; check entity-existence,
  // name, per-alias, and per-attribute awareness for `observerId`.
  for (const bucket of ENTITY_BUCKETS) {
    const list = entitiesObj[bucket] || []
    for (const e of list) {
      if (!e || e.id === observerId) continue
      let eff
      try {
        eff = computeEffectiveState(e, nodes, edges, sceneId, { storyOrder })
      } catch { continue }
      const subjName = eff?.name || e.name || '(unnamed)'
      const subjDesc = _descSuffix(eff?.description || e.description)

      // (1) Entity-existence awareness.
      let lvl = observerLevel(eff?.awareness_raw ?? eff?.awareness)
      if (lvl != null && lvl in byLevel) {
        byLevel[lvl].push(`${subjName}'s existence${subjDesc}`)
      }
      // (2) Canonical-name awareness. The name IS the data point;
      // including the entity description gives the model "what
      // person this name refers to" context.
      lvl = observerLevel(eff?.name_awareness_raw ?? eff?.name_awareness)
      if (lvl != null && lvl in byLevel) {
        byLevel[lvl].push(`${subjName}'s canonical name "${subjName}"${subjDesc}`)
      }
      // (3) Per-alias awareness. Aliases don't carry their own
      // description, so attach the parent entity's description for
      // context.
      for (const alias of (eff?.aliases || [])) {
        const al = observerLevel(alias?.awareness_raw ?? alias?.awareness)
        if (al != null && al in byLevel) {
          const av = typeof alias === 'string' ? alias : (alias?.value || '(unnamed alias)')
          byLevel[al].push(`${subjName}'s alias "${av}"${subjDesc}`)
        }
      }
      // (4) Per-attribute awareness. Value is already inline; no
      // separate description field on attributes.
      for (const attr of (eff?.attributes || [])) {
        const at = observerLevel(attr?.awareness_raw ?? attr?.awareness)
        if (at != null && at in byLevel) {
          const attrName = attr?.name || '(unnamed attribute)'
          const attrValue = _attributeValueString(attr)
          const valueBit = attrValue ? ` (currently: ${attrValue})` : ''
          byLevel[at].push(`${subjName}'s ${attrName}${valueBit}`)
        }
      }
    }
  }

  // (5) Relationship awareness.
  for (const rel of relationships) {
    if (!rel) continue
    let eff
    try {
      const nodeOrder = getRelationshipNodeOrder(rel, nodes, edges)
      eff = computeRelationshipEffectiveState(rel, nodeOrder, sceneId, { storyOrder })
    } catch { continue }
    const lvl = observerLevel(eff?.awareness_raw ?? eff?.awareness)
    if (lvl == null || !(lvl in byLevel)) continue
    const head = eff?.name || rel.name || _relationshipFallbackLabel(eff?.participants || rel.participants, story)
    const type = eff?.type || rel.type || 'relationship'
    const relDesc = _descSuffix(eff?.description || rel.description)
    byLevel[lvl].push(`the ${type} "${head}"${relDesc}`)
  }

  // (6) Knowledge awareness.
  for (const k of knowledges) {
    if (!k) continue
    if (!knowledgeExistsAtNode(k, sceneId, nodes, edges, storyOrder)) continue
    let eff
    try {
      eff = computeKnowledgeEffectiveState(k, storyOrder?.orderedIds || [], sceneId, { nodes, ctx: { storyOrder } })
    } catch { continue }
    if (eff?.notYetExists) continue
    const lvl = observerLevel(eff?.awareness_raw ?? eff?.awareness)
    if (lvl == null || !(lvl in byLevel)) continue
    const name = eff?.name || k.name || 'Unnamed knowledge'
    const knDesc = _descSuffix(eff?.description || k.description)
    byLevel[lvl].push(`the knowledge "${name}"${knDesc}`)
  }

  // Render most-aware first, level header per group so the model
  // can see the gradient. Lines carry their own markdown bullet
  // markers so the consumer can splice them under another bullet
  // with a single uniform indent — the level header is a top-level
  // bullet, and the items beneath it are nested one indent deeper.
  // Without this, the consumer would prefix `- ` to every line and
  // flatten the hierarchy.
  const lines = []
  const obsLabel = observerName || 'They'
  for (const level of [3, 2, 1, 0]) {
    const items = byLevel[level]
    if (!items || items.length === 0) continue
    const levelLabel = _awarenessLevelName(level)
    lines.push(`- ${levelLabel}:`)
    for (const item of items) {
      lines.push(`  - ${obsLabel} is ${levelLabel} of ${item}`)
    }
  }
  return lines
}


// Resolve an awareness wrapper / flat dict and return the level
// assigned to `observerId`, or null when the observer doesn't
// appear. Wrapper shape (`{entries, sources}`) is handled
// separately because raw entries are direct assignments while
// `sources` may pull in observers transitively (e.g. faction
// membership). Sources are skipped here — they require additional
// resolution that the chain walker should have already projected
// into `awareness` (the flat dict on the resolved state). The
// `awareness_raw` field is consulted first because the
// `awareness` flat dict drops the wrapper structure entirely.
function _levelFor(awareness, observerId) {
  if (!awareness || typeof awareness !== 'object') return null
  // Wrapper-with-entries.
  if (awareness.entries && typeof awareness.entries === 'object') {
    if (observerId in awareness.entries) {
      const v = awareness.entries[observerId]
      return typeof v === 'number' ? v : null
    }
    // Don't dive into sources here — too expensive without the
    // membership resolver. The flat-dict path below catches them.
  }
  // Flat dict.
  if (observerId in awareness) {
    const v = awareness[observerId]
    return typeof v === 'number' ? v : null
  }
  return null
}


function _relationshipFallbackLabel(participants, story) {
  if (!Array.isArray(participants) || participants.length === 0) return 'Untitled relationship'
  const names = participants.map((p) => _entityName(story, p?.entity_id || p?.id) || '?').filter(Boolean)
  if (names.length === 0) return 'Untitled relationship'
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} & ${names[1]}`
  return `${names.slice(0, -1).join(', ')}, & ${names[names.length - 1]}`
}


// Phase 2.12 — render a per-entity TEMPORARY circumstance / motivator
// (lives on the scene node, NOT on the entity's chain). Format
// mirrors `_formatAttribute` for the c/m branches but with a
// "*(temporary — this scene only)*" suffix so the model knows the
// item won't carry forward. At-least-one-of-name-or-description is
// guaranteed by the model validator, so we never render an entirely
// blank line.
function _formatTemporaryCM(temp) {
  const name = (temp?.name && temp.name.trim()) || ''
  const desc = (temp?.description && temp.description.trim()) || ''
  const intensity = (temp?.intensity != null) ? ` *(${_intensityName(temp.intensity)})*` : ''
  const headBase = name || desc.split('\n')[0] || 'Temporary'
  // Match `_formatAttribute`'s "Name: Value" shape when both present;
  // otherwise just the description body.
  const body = (name && desc) ? `${headBase}${intensity}: ${_oneline(desc)}` : `${headBase}${intensity}`
  return `${body} *(temporary — this scene only)*`
}


function _groupAttributes(currentAttrs, priorAttrs, story, hostName) {
  const regular = []
  const circumstances = []
  const motivators = []
  const perspectives = []
  const priorById = new Map()
  for (const a of (priorAttrs || [])) {
    if (a && a.id) priorById.set(a.id, a)
  }
  const currentById = new Set()
  for (const attr of (currentAttrs || [])) {
    if (!attr) continue
    currentById.add(attr.id)
    const priorAttr = priorById.get(attr.id)
    // Phase 2.13c — perspectives are a specialised attribute type
    // with their own line shape (target descriptor + description body)
    // and no surrounding awareness block (perspectives don't carry
    // per-observer awareness in v1). Orphaned-target perspectives
    // (cascade-nulled target_kind / target_id) are skipped — the
    // formatter returns null for those.
    if (attr.attribute_type === 'perspective') {
      const line = _formatPerspective(attr, priorAttr, story, hostName)
      if (line) perspectives.push(line)
      continue
    }
    // _formatAttribute now returns an array (one or more lines)
    // because each attribute may carry its own awareness block
    // listing who knows about this specific fact and at what level.
    const lines = _formatAttribute(attr, priorAttr, story)
    if (!lines || lines.length === 0) continue
    if (attr.attribute_type === 'circumstance') circumstances.push(...lines)
    else if (attr.attribute_type === 'motivator') motivators.push(...lines)
    else regular.push(...lines)
  }
  // Surface attributes that USED to be on the entity but were
  // removed at this scene.
  for (const [id, priorAttr] of priorById.entries()) {
    if (currentById.has(id)) continue
    if (priorAttr.attribute_type === 'perspective') {
      const line = _formatRemovedPerspective(priorAttr, story, hostName)
      if (line) perspectives.push(line)
      continue
    }
    const removedLine = _formatRemovedAttribute(priorAttr)
    if (priorAttr.attribute_type === 'circumstance') circumstances.push(removedLine)
    else if (priorAttr.attribute_type === 'motivator') motivators.push(removedLine)
    else regular.push(removedLine)
  }
  return { regular, circumstances, motivators, perspectives }
}

/**
 * Phase 2.13c — Format a perspective attribute row for the
 * "Perspectives:" block. Returns null when the target was
 * cascade-orphaned (kind / id null) so the caller can skip it.
 * Annotates added / changed perspectives the same way the C / M and
 * regular-attribute formatters do — "*(added during this scene)*",
 * "*(changes during this scene)*". `hostName` is the chain-resolved
 * name of the entity that owns this perspective at the scene anchor;
 * the formatter prefixes each line with "<host>'s Perspective of " so
 * the row reads as a complete clause even when surrounding scaffolding
 * doesn't name the host.
 */
function _formatPerspective(attr, priorAttr, story, hostName) {
  const body = formatPerspectiveLine(attr, story, { hostName })
  if (!body) return null
  if (!priorAttr) return `${body} *(added during this scene)*`
  const priorBody = formatPerspectiveLine(priorAttr, story, { hostName })
  if (priorBody === body) return body
  return `${body} *(changes during this scene)*`
}

function _formatRemovedPerspective(priorAttr, story, hostName) {
  const body = formatPerspectiveLine(priorAttr, story, { hostName })
  if (!body) return null
  return `${body} *(removed during this scene)*`
}


function _formatAttribute(attr, priorAttr, story) {
  const name = attr.name || 'Unnamed'
  const value = _attributeValueString(attr)
  const lines = []
  let head
  if (!priorAttr) {
    head = value ? `${name}: ${value} *(added during this scene)*` : `${name} *(added during this scene)*`
  } else {
    const priorValue = _attributeValueString(priorAttr)
    if (priorValue === value) {
      head = value ? `${name}: ${value}` : name
    } else {
      const before = priorValue || '(none)'
      const after = value || '(none)'
      head = `${name}: "${before}" → "${after}" *(changes during this scene)*`
    }
  }
  lines.push(head)
  // Per-attribute awareness — who knows about this specific fact,
  // and any awareness shift during this scene. Mirrors the
  // entity-level awareness block; nested one indent deeper because
  // the parent is already inside the entity's attribute group.
  const awarenessLines = _formatAttributeAwarenessLines(attr, priorAttr, story)
  if (awarenessLines.length > 0) {
    lines.push('  - Known to:')
    for (const a of awarenessLines) lines.push(`    - ${a}`)
  }
  return lines
}


// Per-attribute awareness lines — same diff shape as the
// entity-level helper but operating on `attr.awareness` instead.
// Hoisted out so the formatter doesn't carry the diff logic inline.
function _formatAttributeAwarenessLines(attr, priorAttr, story) {
  const currentMap = _flatAwareness(attr?.awareness)
  const priorMap = _flatAwareness(priorAttr?.awareness)
  const allObservers = new Set([...Object.keys(currentMap), ...Object.keys(priorMap)])
  if (allObservers.size === 0) return []
  const out = []
  const ordered = [...allObservers]
    .map((id) => ({ id, name: _entityName(story, id) || id }))
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const { id, name } of ordered) {
    const cur = currentMap[id]
    const pri = priorMap[id]
    if (cur == null && pri == null) continue
    if (cur === pri) {
      out.push(`${name}: ${_awarenessLevelName(cur)}`)
    } else if (pri == null) {
      out.push(`${name}: ${_awarenessLevelName(cur)} *(becomes aware during this scene)*`)
    } else if (cur == null) {
      out.push(`${name}: ${_awarenessLevelName(pri)} → no longer tracked *(awareness cleared during this scene)*`)
    } else {
      out.push(`${name}: ${_awarenessLevelName(pri)} → ${_awarenessLevelName(cur)} *(awareness changes during this scene)*`)
    }
  }
  return out
}


function _formatRemovedAttribute(priorAttr) {
  const name = priorAttr.name || 'Unnamed'
  const priorValue = _attributeValueString(priorAttr)
  return priorValue
    ? `~~${name}: ${priorValue}~~ *(removed during this scene)*`
    : `~~${name}~~ *(removed during this scene)*`
}


// ── Range pin rendering (Phase 2.7c) ─────────────────────────────


// Writer-facing label for a chain point on the timeline. Scene nodes
// use their title; entity origin EntityNodes read as the entity's
// `NEW : <TYPE>` canvas badge (matches the wrapper heading
// vocabulary); modifier EntityNodes are labelled "Non-Scene Modifier
// N" where N is the modifier's index along the chain (numbered
// because off-canvas modifier nodes have no display name). Knowledge
// / relationship origin nodes use their own `NEW : <KIND>` form.
// Pass `modifierIndex` only when the node is a modifier — that's the
// modifier's 1-based position among the entity's modifier nodes in
// chain order.
function _chainPointLabel(node, kind, modifierIndex) {
  if (!node) return '(missing point)'
  if (node.type === 'sceneNode') return node.data?.title || 'Untitled scene'
  if (node.type === 'entityNode') {
    return node.data?.is_modifier
      ? `Non-Scene Modifier ${modifierIndex || '?'}`
      : `NEW : ${(kind || 'entity').toUpperCase()}`
  }
  if (node.type === 'knowledgeOriginNode') return 'NEW : KNOWLEDGE'
  if (node.type === 'relationshipOriginNode') return 'NEW : RELATIONSHIP'
  return '(chain point)'
}


// Compact change-delta lines for an entity between two adjacent
// chain points. Only emits lines for fields that DIFFER between
// `prior` and `current`; everything unchanged stays silent. Returns
// the lines (empty array means "no changes at this point").
//
// Chain-aware: both `current` and `prior` are computed via the
// walker at their respective chain anchors, so each field already
// carries the chain-resolved value at that point. The diff is the
// difference between two chain-resolved states.
function _formatEntityChangeDelta(current, prior) {
  if (!current || !prior) return []
  const lines = []
  if ((prior.name || '') !== (current.name || '')) {
    lines.push(`- Name: "${prior.name || '(none)'}" → "${current.name || '(none)'}"`)
  }
  if ((prior.description || '') !== (current.description || '')) {
    const beforeText = prior.description ? `"${_oneline(prior.description)}"` : '(none)'
    const afterText = current.description ? `"${_oneline(current.description)}"` : '(none)'
    lines.push(`- Description: ${beforeText} → ${afterText}`)
  }
  if ((prior.colour || '') !== (current.colour || '')) {
    lines.push(`- Colour: ${prior.colour || '(none)'} → ${current.colour || '(none)'}`)
  }
  // Aliases
  const priorAliases = _aliasNames(prior.aliases)
  const currentAliases = _aliasNames(current.aliases)
  if (!_arraysEqual(priorAliases, currentAliases)) {
    const added = currentAliases.filter((a) => !priorAliases.includes(a))
    const removed = priorAliases.filter((a) => !currentAliases.includes(a))
    const parts = []
    if (added.length > 0) parts.push(`added ${added.map((a) => `"${a}"`).join(', ')}`)
    if (removed.length > 0) parts.push(`dropped ${removed.map((a) => `"${a}"`).join(', ')}`)
    if (parts.length > 0) lines.push(`- Aliases: ${parts.join('; ')}`)
  }
  // Attributes — diff by name. Show added / removed / modified groups
  // with the attribute name only (deep value diffs are too noisy for
  // a per-point delta; the start/end full-state sections carry the
  // exact values).
  const priorByName = new Map((prior.attributes || []).map((a) => [a?.name || '', a]))
  const currentByName = new Map((current.attributes || []).map((a) => [a?.name || '', a]))
  const attrAdded = []
  const attrRemoved = []
  const attrModified = []
  for (const [name, a] of currentByName) {
    if (!name) continue
    if (!priorByName.has(name)) {
      attrAdded.push(name)
    } else {
      const before = JSON.stringify(priorByName.get(name)?.value ?? null)
      const after = JSON.stringify(a?.value ?? null)
      if (before !== after) attrModified.push(name)
    }
  }
  for (const [name] of priorByName) {
    if (!name) continue
    if (!currentByName.has(name)) attrRemoved.push(name)
  }
  if (attrAdded.length > 0 || attrRemoved.length > 0 || attrModified.length > 0) {
    const parts = []
    if (attrAdded.length > 0) parts.push(`added: ${attrAdded.join(', ')}`)
    if (attrRemoved.length > 0) parts.push(`removed: ${attrRemoved.join(', ')}`)
    if (attrModified.length > 0) parts.push(`changed: ${attrModified.join(', ')}`)
    lines.push(`- Attributes — ${parts.join('; ')}`)
  }
  // Awareness — surface "awareness changed" as a coarse marker. The
  // start/end full-state sections carry the exact awareness state.
  const priorAwareJson = JSON.stringify(prior.awareness_raw ?? prior.awareness ?? {})
  const currentAwareJson = JSON.stringify(current.awareness_raw ?? current.awareness ?? {})
  if (priorAwareJson !== currentAwareJson) {
    lines.push('- Awareness changed at this point.')
  }
  return lines
}


// Emit a range pin for an entity: wrapper heading + initial-state /
// changes-at-X / final-state sections. Called by `_renderPinnedSection`
// when an entity item carries `anchor_range`. The chain walker stays
// the chain-aware exit for every state read; no baseline shortcut.
function _emitEntityRangePin(item, found, multi, headLevel, out, ctx) {
  const { nodes, edges, story, store, storyOrder } = ctx
  const range = item.anchor_range || {}
  const startId = range.start_node_id
  const endId = range.end_node_id
  if (!startId || !endId) return
  // Walk the entity's narrative chain (chain-aware exit).
  const chain = getEntityNarrativeChain(item.id, nodes, edges) || []
  const chainIds = chain.map((n) => n.id)
  const startIdx = chainIds.indexOf(startId)
  const endIdx = chainIds.indexOf(endId)
  if (startIdx < 0 || endIdx < 0 || startIdx > endIdx) {
    // Stale endpoints; auto-detach on conversation open will clean
    // these up. Skip rendering.
    return
  }
  const inRange = chain.slice(startIdx, endIdx + 1)
  const typeCap = found.type
    ? found.type.charAt(0).toUpperCase() + found.type.slice(1)
    : 'Entity'
  // Number modifier nodes along the chain (1-based). Used by
  // _chainPointLabel for "Non-Scene Modifier N" labels.
  const modifierIdxByNode = new Map()
  let modCounter = 0
  for (const n of chain) {
    if (n.type === 'entityNode' && n.data?.is_modifier) {
      modCounter += 1
      modifierIdxByNode.set(n.id, modCounter)
    }
  }
  // Resolve the chain-earliest name for the wrapper heading.
  let earliestName = found.entity.name || '(unnamed)'
  try {
    const eff = computeEffectiveState(found.entity, nodes, edges, startId, { storyOrder })
    if (eff?.name) earliestName = eff.name
  } catch { /* baseline fallback */ }
  const baselineName = found.entity.name || '(unnamed)'
  const headName = (baselineName === earliestName)
    ? baselineName
    : `${baselineName} (later called "${earliestName}")`
  const startNode = inRange[0]
  const endNode = inRange[inRange.length - 1]
  const startLabel = _chainPointLabel(startNode, found.type, modifierIdxByNode.get(startNode.id))
  const endLabel = _chainPointLabel(endNode, found.type, modifierIdxByNode.get(endNode.id))
  const headPrefix = multi ? `Same ${typeCap.toLowerCase()}` : `Additional ${typeCap}`
  out.push(`${headLevel} ${headPrefix} (across ${inRange.length} points in the narrative, from "${startLabel}" to "${endLabel}"): ${headName}`)
  out.push('')
  out.push(`*The ${inRange.length} entries below describe how this ${typeCap.toLowerCase()} evolves across a contiguous span of the narrative. Treat the changes as cumulative — each "Changes at X" applies on top of all prior states in this section.*`)
  out.push('')
  // Iterate the in-range chain points. Render full state at the
  // first and last points; deltas only at intermediates.
  for (let i = 0; i < inRange.length; i++) {
    const pointNode = inRange[i]
    const pointLabel = _chainPointLabel(pointNode, found.type, modifierIdxByNode.get(pointNode.id))
    const isFirst = i === 0
    const isLast = i === inRange.length - 1
    if (isFirst || isLast) {
      // Full-state emission via the existing formatter. `prior` is
      // the chain step JUST BEFORE this point (or null for origin) —
      // the formatter uses it to flag fields that changed AT this
      // point inline. Both reads go through the chain walker.
      const { current, prior } = computeEffectiveStateWithPrior(
        found.entity, nodes, edges, pointNode.id, { storyOrder },
      )
      out.push(`#### ${isFirst ? 'Initial state at' : 'Final state at'} "${pointLabel}"`)
      out.push('')
      // Phase 2.12 — temporary c/m on this range chain stop (when
      // it's a scene; modifier entity nodes don't carry temporaries).
      const _pointTemporaries = pointNode.type === 'sceneNode'
        ? (pointNode.data?.entity_temporary_circumstances || [])
            .filter((t) => t && t.entity_id === item.id)
        : []
      const lines = _formatParticipant(current, prior, {
        hasPov: false,
        type: found.type,
        story,
        observerCtx: { observerId: item.id, store, sceneId: pointNode.id, story, storyOrder },
        entityTemporaries: _pointTemporaries,
      })
      out.push(...lines)
      out.push('')
      continue
    }
    // Intermediate — emit deltas only. Chain-aware: both current and
    // prior reads are at chain anchors (current = THIS point, prior
    // = previous chain step in `inRange`).
    const priorPoint = inRange[i - 1]
    let current
    let prior
    try {
      current = computeEffectiveState(found.entity, nodes, edges, pointNode.id, { storyOrder })
      prior = computeEffectiveState(found.entity, nodes, edges, priorPoint.id, { storyOrder })
    } catch { current = null; prior = null }
    out.push(`#### Changes at "${pointLabel}"`)
    out.push('')
    const deltaLines = _formatEntityChangeDelta(current, prior)
    if (deltaLines.length === 0) {
      out.push(`*No changes for this ${typeCap.toLowerCase()} at this point.*`)
    } else {
      out.push(...deltaLines)
    }
    out.push('')
  }
}


// Knowledge range pin. Chain-aware all the way down: every state
// read goes through `computeKnowledgeEffectiveState` at the chain
// point id; deltas at intermediates are diffed between two chain-
// resolved states. Mirrors the entity range pin's structure.
function _emitKnowledgeRangePin(item, k, multi, headLevel, out, ctx) {
  const { nodes, edges, story, storyOrder } = ctx
  const range = item.anchor_range || {}
  const startId = range.start_node_id
  const endId = range.end_node_id
  if (!startId || !endId) return
  const order = getKnowledgeNodeOrder(k, nodes, edges) || []
  const startIdx = order.indexOf(startId)
  const endIdx = order.indexOf(endId)
  if (startIdx < 0 || endIdx < 0 || startIdx > endIdx) return
  const inRange = order.slice(startIdx, endIdx + 1)
  // Resolve chain-earliest name for the wrapper heading.
  const baselineName = k.name || 'Untitled knowledge'
  let earliestName = baselineName
  try {
    const eff = computeKnowledgeEffectiveState(k, order, startId, { nodes, ctx: { storyOrder } })
    if (eff?.name) earliestName = eff.name
  } catch { /* baseline fallback */ }
  const headName = (baselineName === earliestName)
    ? baselineName
    : `${baselineName} (later called "${earliestName}")`
  const startNode = nodes.find((n) => n.id === inRange[0])
  const endNode = nodes.find((n) => n.id === inRange[inRange.length - 1])
  const startLabel = _chainPointLabel(startNode, 'knowledge')
  const endLabel = _chainPointLabel(endNode, 'knowledge')
  const headPrefix = multi ? 'Same knowledge' : 'Additional Knowledge'
  out.push(`${headLevel} ${headPrefix} (across ${inRange.length} points in the narrative, from "${startLabel}" to "${endLabel}"): ${headName}`)
  out.push('')
  out.push(`*The ${inRange.length} entries below describe how this knowledge evolves across a contiguous span of the narrative. Treat the changes as cumulative — each "Changes at X" applies on top of all prior states in this section.*`)
  out.push('')
  for (let i = 0; i < inRange.length; i++) {
    const pointId = inRange[i]
    const pointNode = nodes.find((n) => n.id === pointId)
    const pointLabel = _chainPointLabel(pointNode, 'knowledge')
    const isFirst = i === 0
    const isLast = i === inRange.length - 1
    if (isFirst || isLast) {
      const eff = computeKnowledgeEffectiveState(k, order, pointId, { nodes, ctx: { storyOrder } })
      out.push(`#### ${isFirst ? 'Initial state at' : 'Final state at'} "${pointLabel}"`)
      out.push('')
      const name = eff?.name || baselineName
      out.push(`Name: ${name}`)
      if (eff?.description) out.push(`Description: ${_oneline(eff.description)}`)
      const aw = _flatAwareness(eff?.awareness_raw ?? eff?.awareness)
      if (Object.keys(aw).length > 0) {
        out.push('Known to:')
        for (const [observerId, level] of Object.entries(aw)) {
          const oname = _entityName(story, observerId) || observerId
          out.push(`- ${oname}: ${_awarenessLevelName(level)}`)
        }
      }
      out.push('')
      continue
    }
    // Intermediate point — compute current + prior states (both
    // chain-aware), emit deltas only.
    const priorId = inRange[i - 1]
    let current
    let prior
    try {
      current = computeKnowledgeEffectiveState(k, order, pointId, { nodes, ctx: { storyOrder } })
      prior = computeKnowledgeEffectiveState(k, order, priorId, { nodes, ctx: { storyOrder } })
    } catch { current = null; prior = null }
    out.push(`#### Changes at "${pointLabel}"`)
    out.push('')
    const lines = []
    if (current && prior) {
      if ((prior.name || '') !== (current.name || '')) {
        lines.push(`- Name: "${prior.name || '(none)'}" → "${current.name || '(none)'}"`)
      }
      if ((prior.description || '') !== (current.description || '')) {
        lines.push(`- Description: "${_oneline(prior.description) || '(none)'}" → "${_oneline(current.description) || '(none)'}"`)
      }
      if ((prior.colour || '') !== (current.colour || '')) {
        lines.push(`- Colour: ${prior.colour || '(none)'} → ${current.colour || '(none)'}`)
      }
      const priorAw = JSON.stringify(prior.awareness_raw ?? prior.awareness ?? {})
      const currentAw = JSON.stringify(current.awareness_raw ?? current.awareness ?? {})
      if (priorAw !== currentAw) lines.push('- Awareness changed at this point.')
    }
    if (lines.length === 0) {
      out.push('*No changes for this knowledge at this point.*')
    } else {
      out.push(...lines)
    }
    out.push('')
  }
}


// Relationship range pin. Chain-aware: every state read goes
// through `computeRelationshipEffectiveState` at the chain point id.
function _emitRelationshipRangePin(item, rel, multi, headLevel, out, ctx) {
  const { nodes, edges, story, storyOrder } = ctx
  const range = item.anchor_range || {}
  const startId = range.start_node_id
  const endId = range.end_node_id
  if (!startId || !endId) return
  const order = getRelationshipNodeOrder(rel, nodes, edges) || []
  const startIdx = order.indexOf(startId)
  const endIdx = order.indexOf(endId)
  if (startIdx < 0 || endIdx < 0 || startIdx > endIdx) return
  const inRange = order.slice(startIdx, endIdx + 1)
  function _relParticipantsLabel(eff) {
    const partList = Array.isArray(eff?.participants) ? eff.participants : []
    const names = partList.map((p) => _entityName(story, p.entity_id || p.id) || '(unknown)')
    return names.length > 0 ? names.join(' & ') : 'Untitled relationship'
  }
  const baselineName = rel.name || _relParticipantsLabel(rel)
  let earliestName = baselineName
  try {
    const eff = computeRelationshipEffectiveState(rel, order, startId, { storyOrder })
    earliestName = eff?.name || _relParticipantsLabel(eff || rel)
  } catch { /* baseline fallback */ }
  const headName = (baselineName === earliestName)
    ? baselineName
    : `${baselineName} (later called "${earliestName}")`
  const startNode = nodes.find((n) => n.id === inRange[0])
  const endNode = nodes.find((n) => n.id === inRange[inRange.length - 1])
  const startLabel = _chainPointLabel(startNode, 'relationship')
  const endLabel = _chainPointLabel(endNode, 'relationship')
  const headPrefix = multi ? 'Same relationship' : 'Additional Relationship'
  out.push(`${headLevel} ${headPrefix} (across ${inRange.length} points in the narrative, from "${startLabel}" to "${endLabel}"): ${headName}`)
  out.push('')
  out.push(`*The ${inRange.length} entries below describe how this relationship evolves across a contiguous span of the narrative. Treat the changes as cumulative — each "Changes at X" applies on top of all prior states in this section.*`)
  out.push('')
  for (let i = 0; i < inRange.length; i++) {
    const pointId = inRange[i]
    const pointNode = nodes.find((n) => n.id === pointId)
    const pointLabel = _chainPointLabel(pointNode, 'relationship')
    const isFirst = i === 0
    const isLast = i === inRange.length - 1
    if (isFirst || isLast) {
      const eff = computeRelationshipEffectiveState(rel, order, pointId, { storyOrder })
      const partList = Array.isArray(eff?.participants) ? eff.participants : []
      out.push(`#### ${isFirst ? 'Initial state at' : 'Final state at'} "${pointLabel}"`)
      out.push('')
      const name = eff?.name || _relParticipantsLabel(eff)
      const type = eff?.type || rel.type || 'relationship'
      out.push(`Name: ${name} *(${type})*`)
      if (eff?.description) out.push(`Description: ${_oneline(eff.description)}`)
      if (eff?.status === 'ended') out.push('Status: ended *(no longer active by this point)*')
      if (partList.length > 0) {
        out.push('Participants:')
        for (const p of partList) {
          const pname = _entityName(story, p.entity_id || p.id) || '(unknown)'
          const role = p.role ? ` (${p.role})` : ''
          out.push(`- ${pname}${role}`)
        }
      }
      const aw = _flatAwareness(eff?.awareness_raw ?? eff?.awareness)
      if (Object.keys(aw).length > 0) {
        out.push('Known to:')
        for (const [observerId, level] of Object.entries(aw)) {
          const oname = _entityName(story, observerId) || observerId
          out.push(`- ${oname}: ${_awarenessLevelName(level)}`)
        }
      }
      out.push('')
      continue
    }
    const priorId = inRange[i - 1]
    let current
    let prior
    try {
      current = computeRelationshipEffectiveState(rel, order, pointId, { storyOrder })
      prior = computeRelationshipEffectiveState(rel, order, priorId, { storyOrder })
    } catch { current = null; prior = null }
    out.push(`#### Changes at "${pointLabel}"`)
    out.push('')
    const lines = []
    if (current && prior) {
      if ((prior.name || '') !== (current.name || '')) {
        lines.push(`- Name: "${prior.name || '(none)'}" → "${current.name || '(none)'}"`)
      }
      if ((prior.type || '') !== (current.type || '')) {
        lines.push(`- Type: "${prior.type || '(none)'}" → "${current.type || '(none)'}"`)
      }
      if ((prior.status || 'active') !== (current.status || 'active')) {
        lines.push(`- Status: ${prior.status || 'active'} → ${current.status || 'active'}`)
      }
      if ((prior.description || '') !== (current.description || '')) {
        lines.push(`- Description: "${_oneline(prior.description) || '(none)'}" → "${_oneline(current.description) || '(none)'}"`)
      }
      // Participants — compare member sets
      const priorParts = new Set((prior.participants || []).map((p) => p.entity_id || p.id).filter(Boolean))
      const currentParts = new Set((current.participants || []).map((p) => p.entity_id || p.id).filter(Boolean))
      const joined = [...currentParts].filter((id) => !priorParts.has(id))
      const left = [...priorParts].filter((id) => !currentParts.has(id))
      if (joined.length > 0) {
        const names = joined.map((id) => _entityName(story, id) || id).join(', ')
        lines.push(`- Joined: ${names}`)
      }
      if (left.length > 0) {
        const names = left.map((id) => _entityName(story, id) || id).join(', ')
        lines.push(`- Left: ${names}`)
      }
      const priorAw = JSON.stringify(prior.awareness_raw ?? prior.awareness ?? {})
      const currentAw = JSON.stringify(current.awareness_raw ?? current.awareness ?? {})
      if (priorAw !== currentAw) lines.push('- Awareness changed at this point.')
    }
    if (lines.length === 0) {
      out.push('*No changes for this relationship at this point.*')
    } else {
      out.push(...lines)
    }
    out.push('')
  }
}


// ── Misc helpers ─────────────────────────────────────────────────


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


// Surface entity-level awareness as a sub-section under the
// participant. Walks `current.awareness` (a flat dict keyed by
// observer entity id, valued by 0-3 level) and diffs against
// `prior.awareness` to flag any observer whose awareness changes
// during this scene. Observer ids are resolved to names via the
// story object so the model sees readable text.
function _formatEntityAwarenessLines(current, prior, story) {
  const currentMap = _flatAwareness(current?.awareness)
  const priorMap = _flatAwareness(prior?.awareness)
  const allObservers = new Set([...Object.keys(currentMap), ...Object.keys(priorMap)])
  if (allObservers.size === 0) return []
  const lines = []
  // Stable order: alphabetical by resolved observer name.
  const ordered = [...allObservers]
    .map((id) => ({ id, name: _entityName(story, id) || id }))
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const { id, name } of ordered) {
    const cur = currentMap[id]
    const pri = priorMap[id]
    if (cur == null && pri == null) continue
    if (cur === pri) {
      lines.push(`${name}: ${_awarenessLevelName(cur)}`)
    } else if (pri == null) {
      lines.push(`${name}: ${_awarenessLevelName(cur)} *(becomes aware during this scene)*`)
    } else if (cur == null) {
      lines.push(`${name}: ${_awarenessLevelName(pri)} → no longer tracked *(awareness cleared during this scene)*`)
    } else {
      lines.push(`${name}: ${_awarenessLevelName(pri)} → ${_awarenessLevelName(cur)} *(awareness changes during this scene)*`)
    }
  }
  return lines
}


// Phase 2.10b item 12 — ResolutionContext bundle construction for the
// dynamic-pill resolver pipeline. Built once per send by
// `_renderPinnedSection`; passed verbatim to every dynamic pill's
// resolver. Shape per planning doc §4.4c.
//
// Chain-awareness discipline:
//
//   - `povCharacterName` walks the host scene's chain-anchored POV
//     entity via `computeEffectiveStateWithPrior`, NOT a baseline
//     read. The has_pov=true entity at the host scene is found by
//     scanning the scene's characters[] (whose `has_pov` is the
//     EntityRef-level chain fact), then resolved chain-aware to the
//     host scene anchor for its NAME so mid-story renames surface
//     correctly. Same pattern as the inline POV-clause resolver
//     above (line 168-177).
//   - `chapterTitle` / `actTitle` read from Chapter / Act baseline.
//     Chapter and Act titles are not chain-tracked — they live on
//     the Chapter / Act object directly. Baseline read is correct
//     and is the chain-aware path for these objects.
//   - `previousSceneId` / `nextSceneId` come from `storyOrder.orderedIds`,
//     filtered to scene nodes. Story order is not a chain value —
//     it's the canvas-topology answer to "what scene comes after
//     this one in the POV path", which is the same answer the
//     resolver wants.
//   - `scenesById` is a Map of `sceneNode` references; the resolver
//     reads `scene.data.title` / `description` / `main_content` from
//     them. Scene metadata (title, description, main_content prose)
//     is not chain-tracked — these are scene-level fields, not
//     entity values that vary along the chain.
//
//   - `storyScopeRenderer` is `null` in v1 — story_scope_* markers
//     silent-skip here. Wiring buildStoryScopeAppendage through the
//     bundle requires constructing the story-scope `bundle` shape
//     (scenes / chapters / acts / mode / scopeChapter / scopeAct);
//     deferred until the chat composer's existing storyScopePrompt
//     path is unified with the dynamic-pill path (a separate
//     follow-up).
export function buildResolutionContext(anchorSceneId, store, story, nodes, edges, storyOrder, emissions = null) {
  const cuesStore = useContextCuesStore.getState()
  const cues = Array.isArray(cuesStore.cues) ? cuesStore.cues : []
  const sceneNode = anchorSceneId
    ? nodes.find((n) => n.id === anchorSceneId && n.type === 'sceneNode')
    : null

  // Build scenesById map. Cheap O(N) pass, used by adjacent-scene
  // markers (previous_scene / next_scene / previous_n_words /
  // following_n_words) to look up scene content by id.
  const scenesById = new Map()
  for (const n of nodes) {
    if (n && n.type === 'sceneNode') scenesById.set(n.id, n)
  }

  // Chain-walk POV character name at the host scene anchor. Reads
  // the scene's characters[] for a chip with has_pov=true (the
  // EntityRef-level chain fact), then walks that entity's chain to
  // the host scene anchor to get the chain-resolved NAME. Falls
  // back to the entity's baseline name only when the walker can't
  // resolve (defence-in-depth — `current.name` is the chain-aware
  // value, the `|| found.entity.name` is the documented walker-
  // returns-undefined fallback used everywhere in this file).
  let povCharacterName = null
  let povCharacterId = null
  let povCharacterColour = null
  let povCharacterProfileImageRef = null
  let povCharacterCurrent = null
  let povCharacterPrior = null
  let povCharacterType = null
  if (sceneNode) {
    const data = sceneNode.data || {}
    const povId = data.pov_entity_id
      || (Array.isArray(data.characters)
        ? (data.characters.find((c) => c && c.has_pov)?.entity_id || null)
        : null)
    if (povId) {
      const found = _findEntity(story, povId)
      if (found?.entity) {
        povCharacterId = povId
        povCharacterType = found.type || null
        try {
          const { current, prior } = computeEffectiveStateWithPrior(
            found.entity, nodes, edges, sceneNode.id, { storyOrder },
          )
          povCharacterName = current?.name || found.entity.name || null
          povCharacterColour = current?.colour || found.entity.colour || null
          povCharacterProfileImageRef = current?.profile_image_ref ?? found.entity.profile_image_ref ?? null
          povCharacterCurrent = current || null
          povCharacterPrior = prior || null
        } catch {
          povCharacterName = found.entity.name || null
          povCharacterColour = found.entity.colour || null
          povCharacterProfileImageRef = found.entity.profile_image_ref || null
        }
      }
    }
  }

  // Phase 3.11c — story default POV character. `story.pov_character_id`
  // is a story-level metadata field (NOT chain-tracked) pointing at one
  // character entity by id. The character's `name` IS chain-tracked, so
  // we walk THAT entity's chain to the host scene anchor and return the
  // chain-resolved name. With no scene anchor (author mode / chat before
  // a scene is picked), fall back to the entity's origin name — there's
  // no anchor to walk the chain to, so origin is the chain-aware path.
  let storyDefaultPovCharacterName = null
  let storyDefaultPovCharacterId = null
  const storyDefaultPovId = story?.pov_character_id || null
  if (storyDefaultPovId) {
    const found = _findEntity(story, storyDefaultPovId)
    if (found?.entity) {
      storyDefaultPovCharacterId = storyDefaultPovId
      if (sceneNode) {
        try {
          const { current } = computeEffectiveStateWithPrior(
            found.entity, nodes, edges, sceneNode.id, { storyOrder },
          )
          storyDefaultPovCharacterName = current?.name || found.entity.name || null
        } catch {
          storyDefaultPovCharacterName = found.entity.name || null
        }
      } else {
        storyDefaultPovCharacterName = found.entity.name || null
      }
    }
  }

  // Chapter / Act titles via the existing chapter-membership helper.
  // Baseline reads — chapter / act titles are not chain-tracked.
  let chapterTitle = null
  let actTitle = null
  if (sceneNode) {
    const chapters = story?.chapters || []
    const acts = story?.acts || []
    const chapterMemberOpts = chapterMemberOptsForStory(story)
    const chapterId = resolveChapterIdForNode(sceneNode, chapters, chapterMemberOpts)
    const chapter = chapterId ? chapters.find((c) => c.id === chapterId) : null
    if (chapter) {
      chapterTitle = chapter.title || chapter.name || null
      if (chapter.act_id) {
        const act = acts.find((a) => a.id === chapter.act_id)
        if (act) actTitle = act.title || act.name || null
      }
    }
  }

  // Adjacent scene ids from storyOrder. Filtered to scene nodes
  // only (storyOrder.orderedIds includes non-scene nodes on the
  // path); resolve relative to the host scene's position.
  let previousSceneId = null
  let nextSceneId = null
  if (sceneNode && storyOrder?.indexById) {
    const sceneIds = _sceneOrderList(nodes, storyOrder)
    const pos = sceneIds.indexOf(sceneNode.id)
    if (pos > 0) previousSceneId = sceneIds[pos - 1]
    if (pos >= 0 && pos < sceneIds.length - 1) nextSceneId = sceneIds[pos + 1]
  }

  return {
    story,
    hostScene: sceneNode,
    hostSection: null,
    hostAnchor: null,
    cues,
    emissions,
    // Project-store handles + canvas refs exposed for resolvers that
    // need to call back into the chain-aware formatters (e.g. the
    // POV character resolver invokes `buildPovCharacterContextBlock`
    // which needs `store` to construct observerCtx for `_collectAwareOf`).
    store,
    nodes,
    edges,
    storyOrder,
    precomputed: {
      povCharacterName,
      povCharacterId,
      povCharacterColour,
      povCharacterProfileImageRef,
      povCharacterCurrent,
      povCharacterPrior,
      povCharacterType,
      storyDefaultPovCharacterName,
      storyDefaultPovCharacterId,
      previousSceneId,
      nextSceneId,
      chapterTitle,
      actTitle,
      scenesById,
      // story_scope_* marker renderer. Closes over the loaded story +
      // canvas state and runs `buildStoryScopeBundle` +
      // `buildStoryScopeAppendage` for the requested granularity /
      // detail combination. The bundle's chain-aware machinery walks
      // every entity / relationship / knowledge chain to produce the
      // per-scene "changes" payloads required for
      // `descriptions_and_changes` mode — that's the standard
      // chain-resolution path, not a bypass.
      //
      // Granularity → bundle args:
      //   whole_story:      top-level `mode` set; no scope picks.
      //   current_chapter:  `scopeScenes` of every scene in the host
      //                      scene's chapter, each with the requested
      //                      per-scene mode; top-level `mode` left null.
      //   current_act:      `scopeScenes` of every scene in any
      //                      chapter belonging to the host scene's act,
      //                      each with the requested per-scene mode.
      //
      // Detail → mode:
      //   descriptions_only         → 'summary'
      //   descriptions_and_changes  → 'summary_with_changes'
      //   full_content              → 'full_content'
      storyScopeRenderer: (granularity, detail) => {
        if (!story) return null
        const mode = detail === 'descriptions_and_changes' ? 'summary_with_changes'
          : detail === 'full_content' ? 'full_content'
          : 'summary'
        let bundleArgs
        // Phase 2.13c — `liveExtras` injects live top-level knowledges
        // + relationships into every bundleArgs shape below. The
        // storyScope bundle builder's change-line walker reads them
        // for perspective target resolution; `ps.story.knowledges` /
        // `.relationships` are stale snapshots from the last
        // save/load.
        const liveExtras = {
          knowledges:    store.knowledges    || [],
          relationships: store.relationships || [],
        }
        if (granularity === 'whole_story') {
          bundleArgs = {
            mode,
            activeSceneId: anchorSceneId,
            story, nodes, edges,
            ...liveExtras,
          }
        } else if (granularity === 'current_chapter') {
          if (!sceneNode) return null
          const chapterMemberOpts = chapterMemberOptsForStory(story)
          const chapters = story?.chapters || []
          const chapterId = resolveChapterIdForNode(sceneNode, chapters, chapterMemberOpts)
          if (!chapterId) return null
          const chapterSceneIds = []
          for (const n of nodes) {
            if (n && n.type === 'sceneNode'
              && resolveChapterIdForNode(n, chapters, chapterMemberOpts) === chapterId) {
              chapterSceneIds.push(n.id)
            }
          }
          if (chapterSceneIds.length === 0) return null
          bundleArgs = {
            scopeScenes: chapterSceneIds.map((id) => ({ id, mode })),
            activeSceneId: anchorSceneId,
            story, nodes, edges,
            ...liveExtras,
          }
        } else if (granularity === 'current_act') {
          if (!sceneNode) return null
          const chapterMemberOpts = chapterMemberOptsForStory(story)
          const chapters = story?.chapters || []
          const chapterId = resolveChapterIdForNode(sceneNode, chapters, chapterMemberOpts)
          const chapter = chapterId ? chapters.find((c) => c.id === chapterId) : null
          const actId = chapter?.act_id || null
          if (!actId) return null
          const actChapterIds = new Set(
            chapters.filter((c) => c && c.act_id === actId).map((c) => c.id)
          )
          const actSceneIds = []
          for (const n of nodes) {
            if (n && n.type === 'sceneNode'
              && actChapterIds.has(resolveChapterIdForNode(n, chapters, chapterMemberOpts))) {
              actSceneIds.push(n.id)
            }
          }
          if (actSceneIds.length === 0) return null
          bundleArgs = {
            scopeScenes: actSceneIds.map((id) => ({ id, mode })),
            activeSceneId: anchorSceneId,
            story, nodes, edges,
            ...liveExtras,
          }
        } else if (granularity === 'so_far') {
          // Phase 3.11c — "Story so far": every POV-chain scene whose
          // pov_index is STRICTLY less than the host scene's
          // pov_index. Excludes the host scene itself ("so far" = "up
          // to but not including here"), all future scenes, and any
          // off-POV scenes (which aren't part of the narrative order
          // the AI is being primed for). Silent-skip when there's no
          // host scene, when the host scene is off-POV, or when the
          // host is the first POV-chain scene (no preceding scenes
          // means there's nothing to show).
          if (!sceneNode || !storyOrder?.indexById) return null
          const hostStep = storyOrder.indexById.get(sceneNode.id)
          if (typeof hostStep !== 'number' || hostStep <= 0) return null
          const sceneIds = _sceneOrderList(nodes, storyOrder)
          // `_sceneOrderList` already filters to POV-chain scene nodes
          // in story order; take everything BEFORE the host scene.
          const hostPosInList = sceneIds.indexOf(sceneNode.id)
          if (hostPosInList <= 0) return null
          const priorIds = sceneIds.slice(0, hostPosInList)
          if (priorIds.length === 0) return null
          bundleArgs = {
            scopeScenes: priorIds.map((id) => ({ id, mode })),
            activeSceneId: anchorSceneId,
            story, nodes, edges,
            ...liveExtras,
          }
        } else {
          return null
        }
        try {
          const bundle = buildStoryScopeBundle({ ...bundleArgs, storyOrder })
          const out = buildStoryScopeAppendage(bundle)
          return out ? out : null
        } catch {
          return null
        }
      },
    },
  }
}


/**
 * Build a nested-markdown Story Table of Contents block. Lists the
 * story title, acts (if any), chapters (numbered + named via the
 * configured `chapter_label`), and scenes (titles), with an inline
 * indicator on whichever scene matches `ctx.hostScene.id`. Acts use
 * the configured `act_label`. Phase 2.10b TOC feature.
 *
 * Returns `null` when the story has no structural content (no chapters
 * AND no scenes) — silent-skip per the marker-resolver convention.
 *
 * Performance: this is a single O(chapters + acts + scenes) walk over
 * already-loaded story state; cheap enough to run per resolve. The
 * walk consumes already-stable references (`ctx.story`, `ctx.nodes`,
 * `ctx.storyOrder`); no chain walks are needed.
 */
export function buildStoryTocBlock(ctx) {
  if (!ctx?.story) return null
  const story = ctx.story
  const nodes = ctx.nodes || []
  const storyOrder = ctx.storyOrder
  const activeSceneId = ctx.hostScene?.id || null
  const chapters = Array.isArray(story.chapters) ? story.chapters : []
  const acts = Array.isArray(story.acts) ? story.acts : []
  const chapterLabel = ((story.chapter_label || '').trim()) || 'Chapter'
  const actLabel = ((story.act_label || '').trim()) || 'Act'
  const chapterMemberOpts = chapterMemberOptsForStory(story)

  // Build chapter → ordered scene-node list, plus orphan scenes (no
  // chapter assignment). Scene order from `storyOrder.orderedIds`
  // filtered to scene nodes.
  const sceneIdsInOrder = _sceneOrderList(nodes, storyOrder)
  const sceneNodeById = new Map()
  for (const n of nodes) {
    if (n && n.type === 'sceneNode') sceneNodeById.set(n.id, n)
  }
  const scenesByChapter = new Map()  // chapterId → [sceneNode...]
  const orphanScenes = []
  for (const sid of sceneIdsInOrder) {
    const sn = sceneNodeById.get(sid)
    if (!sn) continue
    const cid = resolveChapterIdForNode(sn, chapters, chapterMemberOpts)
    if (cid) {
      if (!scenesByChapter.has(cid)) scenesByChapter.set(cid, [])
      scenesByChapter.get(cid).push(sn)
    } else {
      orphanScenes.push(sn)
    }
  }

  const sceneTitleLine = (sn) => {
    const t = (sn.data?.title || '').trim() || '(untitled scene)'
    const isCurrent = sn.id === activeSceneId
    return `- ${t}${isCurrent ? ' *(current scene)*' : ''}`
  }

  const renderChapter = (chapter, chapterIdx, headingLevel, out) => {
    const title = (chapter.title || '').trim() || '(untitled)'
    const heading = '#'.repeat(headingLevel)
    out.push(`${heading} ${chapterLabel} ${chapterIdx}: ${title}`)
    const scenes = scenesByChapter.get(chapter.id) || []
    for (const sn of scenes) out.push(sceneTitleLine(sn))
    out.push('')
  }

  const out = []
  out.push(`# ${story.title || 'Untitled Story'}`)
  out.push('')

  let renderedAny = false

  if (acts.length > 0) {
    // Acts → chapters → scenes. Each chapter's global index (its
    // position in `story.chapters`) is used for numbering so the
    // chapter labels match across the canvas and the TOC.
    let actIdx = 0
    for (const act of acts) {
      actIdx++
      const actTitle = (act.title || '').trim() || '(untitled)'
      out.push(`## ${actLabel} ${actIdx}: ${actTitle}`)
      out.push('')
      const cidList = Array.isArray(act.chapter_ids) ? act.chapter_ids : []
      for (const cid of cidList) {
        const chapter = chapters.find((c) => c.id === cid)
        if (!chapter) continue
        const globalIdx = chapters.findIndex((c) => c.id === cid) + 1
        renderChapter(chapter, globalIdx, 3, out)
        renderedAny = true
      }
    }
    // Chapters not in any act (orphan chapters).
    const chaptersInActs = new Set(acts.flatMap((a) => Array.isArray(a.chapter_ids) ? a.chapter_ids : []))
    const orphanChapters = chapters.filter((c) => !chaptersInActs.has(c.id))
    if (orphanChapters.length > 0) {
      out.push(`## ${chapterLabel}s outside any ${actLabel.toLowerCase()}`)
      out.push('')
      for (const chapter of orphanChapters) {
        const globalIdx = chapters.findIndex((c) => c.id === chapter.id) + 1
        renderChapter(chapter, globalIdx, 3, out)
        renderedAny = true
      }
    }
  } else if (chapters.length > 0) {
    // No acts — chapters → scenes directly at `##`.
    let chapterIdx = 0
    for (const chapter of chapters) {
      chapterIdx++
      renderChapter(chapter, chapterIdx, 2, out)
      renderedAny = true
    }
  }

  // Orphan scenes (not in any chapter).
  if (orphanScenes.length > 0) {
    out.push(`## Scenes outside any ${chapterLabel.toLowerCase()}`)
    for (const sn of orphanScenes) out.push(sceneTitleLine(sn))
    out.push('')
    renderedAny = true
  }

  if (!renderedAny) return null
  return ['## Story Table of Contents', '', ...out].join('\n').trimEnd()
}


/**
 * Build the resolved-context block for the host scene's POV character.
 * Called from `markerResolver.js` for the `pov_character` dynamic marker
 * after the dedup check passes. Returns the joined markdown string or
 * `null` when prerequisites are missing.
 *
 * Uses the chain-walked `current` / `prior` state cached in
 * `ctx.precomputed.povCharacterCurrent` / `povCharacterPrior` so no new
 * chain walk fires per resolver invocation. Passes `hasPov: true` so
 * the inline `*(POV)*` tag rides in the wire — matches what Scene
 * Context's chip emits, so when Scene Context is off, the AI still
 * gets the POV semantic via this block.
 */
export function buildPovCharacterContextBlock(ctx) {
  if (!ctx?.hostScene) return null
  const pre = ctx.precomputed || {}
  const povId = pre.povCharacterId
  const current = pre.povCharacterCurrent
  if (!povId || !current) return null
  const store = ctx.store
  const storyOrder = ctx.storyOrder
  if (!store) return null
  const name = pre.povCharacterName || current.name || '(unnamed)'
  let participantLines
  try {
    participantLines = _formatParticipant(current, pre.povCharacterPrior || null, {
      hasPov: true,
      type: pre.povCharacterType || null,
      story: ctx.story,
      observerCtx: {
        observerId: povId,
        store,
        sceneId: ctx.hostScene.id,
        story: ctx.story,
        storyOrder,
      },
    })
  } catch {
    return null
  }
  if (!participantLines || participantLines.length === 0) return null
  return [`### POV character: ${name}`, '', ...participantLines].join('\n')
}
