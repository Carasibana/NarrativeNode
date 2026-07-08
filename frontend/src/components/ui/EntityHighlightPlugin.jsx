/**
 * Entity Name Highlighting — TipTap Extension
 *
 * Non-destructive ProseMirror decoration plugin that highlights entity names
 * in the text editor when toggled on. Uses decorations (visual overlays) so the
 * stored document content is never modified.
 *
 * Each entity chip in the current scene provides one or two "name targets":
 *   - If no name change at this scene → one target using post-modification state
 *   - If name changed at this scene → two targets: received name (with received
 *     colour/image) and new name (with changed colour/image)
 */

import { Extension } from '@tiptap/react'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import {
  computeEffectiveState,
  computeEffectiveStateWithPrior,
  computeKnowledgeEffectiveState,
  computeRelationshipEffectiveState,
  getEntityNarrativeChain,
  getKnowledgeNodeOrder,
  getRelationshipNodeOrder,
} from '../../utils/narrativeChain'

const ENTITY_HIGHLIGHT_KEY = new PluginKey('entityHighlight')

/**
 * Build an array of "name targets" for decoration matching.
 *
 * Uses the unified `computeEffectiveStateWithPrior` helper from
 * narrativeChain.js to resolve both the received (pre-scene) and
 * post-change (at-scene) states in one call per entity. Sub-chain
 * anchors and main-chain anchors are handled uniformly.
 *
 * @param {Object} nodeData — the plot point node's data object
 * @param {Function} getEntity — (entityId) => entity object or null
 * @param {Function} _computeEffectiveState — DEPRECATED, kept for
 *   call-site signature compatibility; helper is now imported
 *   directly. Safe to pass null.
 * @param {Function} _getChain — DEPRECATED, same reason.
 * @param {Array} nodes — all nodes
 * @param {Array} edges — all edges
 * @param {string} nodeId — current node ID
 * @returns {Array<{ name, entityId, colour, profileImageRef, entityType }>}
 */
export function buildNameTargets(nodeData, getEntity, _computeEffectiveState, _getChain, nodes, edges, nodeId) {
  if (!nodeData) return []

  const BUCKETS = ['characters', 'locations', 'items', 'factions', 'customs']
  const targets = []

  for (const bucket of BUCKETS) {
    for (const ref of (nodeData[bucket] || [])) {
      const entity = getEntity(ref.entity_id)
      if (!entity) continue

      const hasNameChange = ref.name_change != null

      if (hasNameChange) {
        // Two targets: received name (pre-scene) and new name (at-scene).
        // Both views via the unified helper — handles main-chain AND
        // sub-chain anchors correctly. Replaces the previous pattern
        // of `chain[idx - 1]` lookup that fell back to a per-file
        // baseline literal for sub-chain anchors (lost colour /
        // profile_image inheritance for highlight decoration).
        const { current: postState, prior: receivedState } = computeEffectiveStateWithPrior(entity, nodes, edges, nodeId)

        // Received name target
        if (receivedState.name) {
          targets.push({
            name: receivedState.name,
            entityId: ref.entity_id,
            colour: receivedState.colour,
            profileImageRef: receivedState.profile_image_ref,
            entityType: entity.type,
          })
        }

        // New name target
        if (postState.name && postState.name !== receivedState.name) {
          targets.push({
            name: postState.name,
            entityId: ref.entity_id,
            colour: postState.colour,
            profileImageRef: postState.profile_image_ref,
            entityType: entity.type,
          })
        }
      } else {
        // Single target: post-modification state at this scene. Reuse
        // the unified helper for consistency (we only need `current`).
        const { current: postState } = computeEffectiveStateWithPrior(entity, nodes, edges, nodeId)
        if (postState.name) {
          targets.push({
            name: postState.name,
            entityId: ref.entity_id,
            colour: postState.colour,
            profileImageRef: postState.profile_image_ref,
            entityType: entity.type,
          })
        }
        // Also highlight each alias at this scene
        for (const aliasEntry of (postState.aliases || [])) {
          const aliasStr = typeof aliasEntry === 'string' ? aliasEntry : aliasEntry?.value
          if (aliasStr && aliasStr !== postState.name) {
            targets.push({
              name: aliasStr,
              entityId: ref.entity_id,
              colour: postState.colour,
              profileImageRef: postState.profile_image_ref,
              entityType: entity.type,
            })
          }
        }
      }
    }
  }

  return targets
}

/**
 * Phase 2.8 — story-wide name target builder.
 *
 * Unlike the scene-scoped `buildNameTargets` above, this builder
 * walks the ENTIRE story (and program-level context cues) and
 * yields one target per distinct (object, name) pair. The name
 * set spans baseline + every chain-tracked rename / alias add
 * the object has seen, so writers typing any name an object has
 * EVER been known by get a match. Each yielded target is tagged
 * with the colour and profile image that were EFFECTIVE at the
 * chain stop where that specific name first appeared on the
 * object — a character renamed-and-recoloured at scene 3 yields
 * the baseline name in the baseline colour AND the new name in
 * the new colour. Used by the chat composer's TipTap input (which
 * has no scene anchor) and — for the cue / knowledge /
 * relationship kinds — by the scene editor's highlight system.
 *
 * Each call takes a `types` filter (object map kind→bool); only
 * kinds with `true` participate. This matches the writer's per-
 * type checkbox state from the `<NameDetectToggle>` flyout.
 *
 * The data sources:
 *   - entities → `entitiesState` (the 5 entity buckets)
 *   - knowledges → `projectState.knowledges`
 *   - relationships → `projectState.relationships`
 *   - cues → `cuesState.cues`
 *
 * Caller passes raw store snapshots (`getState()` results) rather
 * than the hooks so this remains a pure function the chat input's
 * extension can call from inside `editor.setMeta` without React
 * subscription overhead.
 *
 * Yielded target shape matches the scene-scoped builder:
 *   { name, entityId, colour, profileImageRef, entityType }
 *
 * `entityType` is the kind for cross-builder compatibility; the
 * existing decoration code uses it for the `data-entity-type`
 * attribute and the editor's filter keys off it. Values are the
 * same 8 strings the flyout uses: 'character' | 'location' |
 * 'item' | 'faction' | 'custom' | 'knowledge' | 'relationship' |
 * 'cue'.
 *
 * @param {Object} types — kind→bool filter from the flyout
 * @param {Object} state.entities — `useEntitiesStore.getState()`
 * @param {Object} state.project  — `useProjectStore.getState()`
 * @param {Object} state.cues     — `useContextCuesStore.getState()`
 */
const REL_DEFAULT_COLOUR = '#a78bfa'  // matches RelationshipSummaryHeader

export function buildStoryWideNameTargets(types, state) {
  if (!types || !state) return []
  const targets = []

  const nodes = state.project?.nodes || []
  const edges = state.project?.edges || []
  const ENTITY_BUCKETS = ['characters', 'locations', 'items', 'factions', 'customs']

  // For each entity: collect every (chain_stop, new-name-or-alias)
  // pair, then resolve the colour / image effective AT that chain
  // stop via `computeEffectiveState` — the canonical chain walker
  // already used by the scene-scoped highlighter. We use it (rather
  // than hand-rolling the walk) so every chain shape it knows
  // about — sub-chain anchors, modifier nodes, awareness layers,
  // ref-shape variations — works for the chat input too without
  // duplicating logic that has known corner cases.
  //
  // Result: a writer typing the baseline name sees baseline
  // colour; typing a chain rename sees the colour effective at the
  // rename stop; typing an alias added at a chain stop sees the
  // colour effective there.
  function _emitEntityTargets(e, kind) {
    if (!e?.name) return
    const seen = new Set()
    function emit(name, colour, profileImageRef) {
      if (!name || seen.has(name)) return
      seen.add(name)
      targets.push({
        name,
        entityId: e.id,
        colour,
        profileImageRef,
        entityType: kind,
      })
    }
    // Origin: baseline name + baseline aliases use baseline
    // colour / image (the origin is where the colour value also
    // begins; no chain entry exists prior to baseline).
    emit(e.name, e.colour || null, e.profile_image_ref || null)
    for (const aliasEntry of (e.aliases || [])) {
      const aliasStr = typeof aliasEntry === 'string' ? aliasEntry : aliasEntry?.value
      emit(aliasStr, e.colour || null, e.profile_image_ref || null)
    }
    // Chain stops past origin. For each scene node in the chain
    // that carries an EntityRef contributing a new name or alias,
    // resolve effective state AT THAT NODE and tag the new name(s)
    // with that state's colour / image.
    const chain = getEntityNarrativeChain(e.id, nodes, edges)
    for (let i = 1; i < chain.length; i++) {
      const node = chain[i]
      let ref = null
      for (const b of ENTITY_BUCKETS) {
        const r = (node.data?.[b] || []).find((x) => x.entity_id === e.id)
        if (r) { ref = r; break }
      }
      if (!ref) continue
      const introducesName = !!ref.name_change
      const aliasAdds = (ref.alias_changes || [])
        .filter((ev) => ev?.action === 'add' && ev?.alias?.value)
        .map((ev) => ev.alias.value)
      if (!introducesName && aliasAdds.length === 0) continue
      const eff = computeEffectiveState(e, nodes, edges, node.id)
      const c = eff?.colour ?? null
      const img = eff?.profile_image_ref ?? null
      if (introducesName) emit(ref.name_change, c, img)
      for (const aliasStr of aliasAdds) emit(aliasStr, c, img)
    }
  }

  const entityBuckets = [
    ['character', state.entities?.characters],
    ['location',  state.entities?.locations],
    ['item',      state.entities?.items],
    ['faction',   state.entities?.factions],
    ['custom',    state.entities?.customs],
  ]
  for (const [kind, list] of entityBuckets) {
    if (!types[kind]) continue
    for (const e of (list || [])) {
      _emitEntityTargets(e, kind)
    }
  }

  if (types.knowledge) {
    for (const k of (state.project?.knowledges || [])) {
      if (!k?.name) continue
      // Walk the knowledge's chain in node order, tracking the
      // effective colour and profile image. Emit each new name
      // tagged with the colour/image effective at that chain stop.
      // Mirror of the entity walk above.
      let curColour = k.colour || null
      let curImage  = k.profile_image_ref || null
      const seen = new Set()
      function emit(name) {
        if (!name || seen.has(name)) return
        seen.add(name)
        targets.push({
          name,
          entityId: k.id,
          colour: curColour,
          profileImageRef: curImage,
          entityType: 'knowledge',
        })
      }
      // Origin: baseline name + baseline aliases (if any) use
      // baseline colour/image. Knowledges expose aliases via
      // `k.aliases` shaped the same as entity aliases.
      emit(k.name)
      for (const aliasEntry of (k.aliases || [])) {
        const aliasStr = typeof aliasEntry === 'string' ? aliasEntry : aliasEntry?.value
        emit(aliasStr)
      }
      // Per-node maps of the knowledge's chain events for fast
      // lookup as we walk node order. Each is keyed by node_id
      // and carries the new value; the walker applies them in
      // order so a later change at the same node wins.
      const colourByNode = new Map()
      for (const ev of (k.history?.colour_changes || [])) {
        if (ev?.node_id) colourByNode.set(ev.node_id, ev.new_colour)
      }
      const imageByNode = new Map()
      for (const ev of (k.history?.profile_image_changes || [])) {
        if (ev?.node_id) imageByNode.set(ev.node_id, ev.new_profile_image_ref)
      }
      const nameByNode = new Map()
      for (const ev of (k.history?.name_changes || [])) {
        if (ev?.node_id) nameByNode.set(ev.node_id, ev.new_name)
      }
      const order = getKnowledgeNodeOrder(k, nodes, edges) || []
      for (const nodeId of order) {
        if (colourByNode.has(nodeId)) curColour = colourByNode.get(nodeId)
        if (imageByNode.has(nodeId)) {
          const img = imageByNode.get(nodeId)
          curImage = img === '' ? null : img
        }
        if (nameByNode.has(nodeId)) emit(nameByNode.get(nodeId))
      }
    }
  }

  if (types.relationship) {
    for (const r of (state.project?.relationships || [])) {
      // Relationships only highlight when they have an explicit
      // name (the auto-generated participants-fallback label is too
      // noisy for whole-document scanning). A relationship without a
      // baseline `r.name` still qualifies if it has any chain
      // `history.name_changes[]` entries — those are explicit names
      // too, just assigned downstream of the relationship's origin.
      // Relationships have no chain-tracked colour today (no
      // colour_changes history), so every name uses the baseline
      // colour (or the relationship default).
      const colour = r?.colour || REL_DEFAULT_COLOUR
      const rSeen = new Set()
      if (r?.name) {
        rSeen.add(r.name)
        targets.push({
          name: r.name,
          entityId: r.id,
          colour,
          profileImageRef: null,
          entityType: 'relationship',
        })
      }
      for (const ev of (r?.history?.name_changes || [])) {
        const nm = ev?.new_name
        if (!nm || rSeen.has(nm)) continue
        rSeen.add(nm)
        targets.push({
          name: nm,
          entityId: r.id,
          colour,
          profileImageRef: null,
          entityType: 'relationship',
        })
      }
    }
  }

  if (types.cue) {
    for (const c of (state.cues?.cues || [])) {
      if (!c?.name) continue
      targets.push({
        name: c.name,
        entityId: c.id,
        colour: c.colour || null,
        profileImageRef: null,
        entityType: 'cue',
      })
    }
  }

  return targets
}


/**
 * Phase 2.8 — scene-anchored name target builder.
 *
 * For the scene editor when it's editing a SCENE node: every
 * chain-tracked object (entity / knowledge / relationship) is
 * resolved to its state AT THE SCENE, and its at-scene name +
 * colour are emitted as the highlight target. Entities use the
 * existing scene-scoped two-target pattern (received-name +
 * at-scene-name when a name change happened at this scene, both
 * tagged with their respective at-state colours). Knowledges /
 * relationships emit their at-scene resolved name and colour.
 * Context Cues are program-level (no chain) so they emit the
 * same as the story-wide builder.
 *
 * For non-scene editor surfaces (cue body, reference / entity /
 * knowledge notes) callers should use `buildStoryWideNameTargets`
 * instead — those bodies aren't anchored on the chain and the
 * writer wants the same "every name an object has ever been
 * known by" coverage the chat composer has.
 *
 * @param {Object} types — kind→bool filter (same as story-wide)
 * @param {Object} state — same shape as story-wide builder
 * @param {string} sceneNodeId — id of the scene being edited
 */
export function buildSceneAnchoredNameTargets(types, state, sceneNodeId) {
  if (!types || !state || !sceneNodeId) return []
  const targets = []
  const nodes = state.project?.nodes || []
  const edges = state.project?.edges || []
  const sceneNode = nodes.find((n) => n.id === sceneNodeId)
  if (!sceneNode) return targets
  const nodeData = sceneNode.data || {}

  // Entities — story-wide coverage, but the in-scene path uses
  // the EXACT logic the previous scene-scoped builder used (so
  // aliases / chain colour / received-vs-new rename pattern all
  // keep working for entities chipped on this scene). Entities
  // NOT in this scene's buckets ALSO highlight: their state at
  // this scene's chain position is resolved via the canonical
  // walker, so the writer sees their name with the colour they
  // would have at this scene even when they don't have a chip
  // here. The walker falls back to baseline naturally when the
  // scene anchor isn't in the entity's chain — that IS the
  // correct "as the entity would be at this scene" state.
  const ENTITY_BUCKETS = ['characters', 'locations', 'items', 'factions', 'customs']
  const sceneEntityRefs = new Map()
  for (const bucket of ENTITY_BUCKETS) {
    for (const ref of (nodeData[bucket] || [])) {
      if (ref?.entity_id) sceneEntityRefs.set(ref.entity_id, ref)
    }
  }
  const entityKinds = [
    ['character', state.entities?.characters],
    ['location',  state.entities?.locations],
    ['item',      state.entities?.items],
    ['faction',   state.entities?.factions],
    ['custom',    state.entities?.customs],
  ]
  for (const [kind, list] of entityKinds) {
    if (!types[kind]) continue
    for (const e of (list || [])) {
      if (!e?.id) continue
      const ref = sceneEntityRefs.get(e.id)
      if (ref) {
        // In-scene path — same logic as the legacy
        // `buildNameTargets`. The two-target rename pattern only
        // fires when this scene records a name_change; otherwise
        // single target + at-scene aliases.
        const hasNameChange = ref.name_change != null
        const { current: postState, prior: receivedState } = computeEffectiveStateWithPrior(e, nodes, edges, sceneNodeId)
        if (hasNameChange) {
          if (receivedState?.name) {
            targets.push({
              name: receivedState.name,
              entityId: e.id,
              colour: receivedState.colour,
              profileImageRef: receivedState.profile_image_ref,
              entityType: kind,
            })
          }
          if (postState?.name && postState.name !== receivedState.name) {
            targets.push({
              name: postState.name,
              entityId: e.id,
              colour: postState.colour,
              profileImageRef: postState.profile_image_ref,
              entityType: kind,
            })
          }
        } else {
          if (postState?.name) {
            targets.push({
              name: postState.name,
              entityId: e.id,
              colour: postState.colour,
              profileImageRef: postState.profile_image_ref,
              entityType: kind,
            })
          }
          for (const aliasEntry of (postState?.aliases || [])) {
            const aliasStr = typeof aliasEntry === 'string' ? aliasEntry : aliasEntry?.value
            if (!aliasStr || aliasStr === postState.name) continue
            targets.push({
              name: aliasStr,
              entityId: e.id,
              colour: postState.colour,
              profileImageRef: postState.profile_image_ref,
              entityType: kind,
            })
          }
        }
      } else {
        // Not-in-scene path — entity has no chip on this scene
        // but its name may still appear in the prose. Resolve at
        // this scene's chain position; walker falls back through
        // sub-chains / baseline when the scene anchor isn't in
        // the entity's forward chain.
        const eff = computeEffectiveState(e, nodes, edges, sceneNodeId)
        if (!eff?.name) continue
        targets.push({
          name: eff.name,
          entityId: e.id,
          colour: eff.colour ?? e.colour ?? null,
          profileImageRef: eff.profile_image_ref ?? e.profile_image_ref ?? null,
          entityType: kind,
        })
        for (const aliasEntry of (eff.aliases || [])) {
          const aliasStr = typeof aliasEntry === 'string' ? aliasEntry : aliasEntry?.value
          if (!aliasStr || aliasStr === eff.name) continue
          targets.push({
            name: aliasStr,
            entityId: e.id,
            colour: eff.colour ?? e.colour ?? null,
            profileImageRef: eff.profile_image_ref ?? e.profile_image_ref ?? null,
            entityType: kind,
          })
        }
      }
    }
  }

  // Knowledges — at-scene resolved state. Knowledges that don't
  // yet exist at this scene's chain position drop out naturally
  // (the walker returns no name).
  if (types.knowledge) {
    for (const k of (state.project?.knowledges || [])) {
      if (!k?.id) continue
      const order = getKnowledgeNodeOrder(k, nodes, edges) || []
      const eff = computeKnowledgeEffectiveState(k, order, sceneNodeId)
      const name = eff?.name
      if (!name) continue
      targets.push({
        name,
        entityId: k.id,
        colour: eff.colour ?? k.colour ?? null,
        profileImageRef: eff.profile_image_ref ?? k.profile_image_ref ?? null,
        entityType: 'knowledge',
      })
      for (const aliasEntry of (eff.aliases || [])) {
        const aliasStr = typeof aliasEntry === 'string' ? aliasEntry : aliasEntry?.value
        if (!aliasStr || aliasStr === name) continue
        targets.push({
          name: aliasStr,
          entityId: k.id,
          colour: eff.colour ?? k.colour ?? null,
          profileImageRef: eff.profile_image_ref ?? k.profile_image_ref ?? null,
          entityType: 'knowledge',
        })
      }
    }
  }

  // Relationships — at-scene resolved state. Skip if no explicit
  // name resolves (auto-generated participant-fallback labels
  // are too noisy for whole-document scanning, same rule as
  // story-wide). Relationships have no chain colour today so we
  // fall through to the baseline / rel-default.
  if (types.relationship) {
    for (const r of (state.project?.relationships || [])) {
      if (!r?.id) continue
      const order = getRelationshipNodeOrder(r, nodes, edges) || []
      const eff = computeRelationshipEffectiveState(r, order, sceneNodeId)
      const name = eff?.name
      if (!name) continue
      targets.push({
        name,
        entityId: r.id,
        colour: r.colour || REL_DEFAULT_COLOUR,
        profileImageRef: null,
        entityType: 'relationship',
      })
    }
  }

  // Context Cues — program-level, no chain. Same as story-wide.
  if (types.cue) {
    for (const c of (state.cues?.cues || [])) {
      if (!c?.name) continue
      targets.push({
        name: c.name,
        entityId: c.id,
        colour: c.colour || null,
        profileImageRef: null,
        entityType: 'cue',
      })
    }
  }

  return targets
}


/**
 * Build a regex that matches any of the given name targets as whole words
 * (case-insensitive). Returns null if no targets.
 */
function buildMatchRegex(targets) {
  if (!targets.length) return null
  // Sort by name length descending so longer names match first (e.g. "Amy Smith" before "Amy")
  const sorted = [...targets].sort((a, b) => b.name.length - a.name.length)
  const escaped = sorted.map((t) => t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`\\b(${escaped.join('|')})\\b`, 'gi')
}

/**
 * Create a DecorationSet from name targets for a given document.
 *
 * `accentColor` is the writer's story accent — used as the visual
 * cue for AMBIGUOUS matches (where the typed name maps to more
 * than one distinct entityId). Ambiguous matches get a dotted
 * underline + accent text colour + a tooltip listing the colliding
 * objects, instead of a single object's colour.
 */
// Scan a [from, to] range of the doc and return all match
// decorations within it. Caller controls whether this is a full
// doc scan (initial / target-change rebuild) or a window scan
// (incremental update around a doc edit). The scan only walks
// text nodes whose position overlaps the range — bounded by the
// range size, not the doc size.
function scanRange(doc, from, to, targets, accentColor) {
  const decorations = []
  if (!targets.length) return decorations
  const regex = buildMatchRegex(targets)
  if (!regex) return decorations

  // Lookup keyed by lowercase name → ALL matching targets. When
  // multiple distinct entityIds share a name, the decoration
  // emits "ambiguous" instead of picking arbitrarily.
  const lookup = new Map()
  for (const t of targets) {
    const key = t.name.toLowerCase()
    const list = lookup.get(key) || []
    list.push(t)
    lookup.set(key, list)
  }

  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return
    const text = node.text
    if (!text) return
    // Clip the regex scan window to the requested doc range so an
    // incremental update around an edit doesn't redundantly re-scan
    // text far from the change.
    const localFrom = Math.max(0, from - pos)
    const localTo = Math.min(text.length, to - pos)
    if (localFrom >= localTo) return
    const sub = text.slice(localFrom, localTo)
    let match
    regex.lastIndex = 0
    while ((match = regex.exec(sub)) !== null) {
      const matchStart = pos + localFrom + match.index
      const matchEnd = matchStart + match[0].length
      const matchList = lookup.get(match[0].toLowerCase())
      if (!matchList || !matchList.length) continue

      const distinctIds = new Set(matchList.map((t) => t.entityId))
      const ambiguous = distinctIds.size > 1

      if (ambiguous) {
        const names = matchList.map((t) => t.name).join(', ')
        const ids = matchList.map((t) => t.entityId).join(',')
        const kinds = matchList.map((t) => t.entityType).join(',')
        decorations.push(
          Decoration.inline(matchStart, matchEnd, {
            class: 'nn-entity-highlight nn-entity-highlight-ambiguous',
            style: `color: ${accentColor || '#a78bfa'}; text-decoration: underline dotted; text-underline-offset: 2px; cursor: help;`,
            title: `Ambiguous match — could be any of: ${names}`,
            'data-ambiguous': 'true',
            'data-ambiguous-ids': ids,
            'data-ambiguous-types': kinds,
          })
        )
      } else {
        const target = matchList[0]
        const imgRef = target.profileImageRef
        const assetName = imgRef ? imgRef.replace(/^assets\//, '') : ''
        decorations.push(
          Decoration.inline(matchStart, matchEnd, {
            class: 'nn-entity-highlight',
            style: `color: ${target.colour}; cursor: pointer;`,
            'data-entity-id': target.entityId,
            'data-entity-colour': target.colour,
            'data-entity-image': assetName,
            'data-entity-type': target.entityType,
          })
        )
      }
    }
  })

  return decorations
}

function buildDecorations(doc, targets, accentColor) {
  if (!targets.length) return DecorationSet.empty
  const decorations = scanRange(doc, 0, doc.content.size, targets, accentColor)
  return DecorationSet.create(doc, decorations)
}

// Longest target name in characters — used to widen the
// incremental-rescan window around an edit so a match spanning
// the edit boundary still gets picked up.
function maxNameLength(targets) {
  let max = 0
  for (const t of targets) {
    if (t.name.length > max) max = t.name.length
  }
  return max
}

/**
 * TipTap Extension: EntityHighlight
 *
 * Uses transaction metadata to pass targets and enabled state into the plugin,
 * avoiding closure capture issues with extension options.
 *
 * Call refreshEntityHighlights(editor, targets, enabled) to update.
 */
export const EntityHighlightExtension = Extension.create({
  name: 'entityHighlight',

  addProseMirrorPlugins() {
    // Module-level state that the plugin reads — updated via transaction meta
    let currentTargets = []
    let currentEnabled = false
    let currentAccent = null

    return [
      new Plugin({
        key: ENTITY_HIGHLIGHT_KEY,
        state: {
          init() {
            return DecorationSet.empty
          },
          apply(tr, oldDecos) {
            // Meta-driven full rebuild — targets / enabled / accent
            // changed. This is the only path that does a whole-doc
            // scan; the docChanged path below only touches the
            // window around each edit step.
            const meta = tr.getMeta(ENTITY_HIGHLIGHT_KEY)
            if (meta) {
              currentTargets = meta.targets || []
              currentEnabled = !!meta.enabled
              if (meta.accentColor !== undefined) currentAccent = meta.accentColor
              if (!currentEnabled) return DecorationSet.empty
              return buildDecorations(tr.doc, currentTargets, currentAccent)
            }
            if (!currentEnabled) return DecorationSet.empty
            if (!tr.docChanged) return oldDecos.map(tr.mapping, tr.doc)
            // Incremental update on doc changes: map existing
            // decorations across the edit (cheap, O(log n) per
            // decoration), then for each step's changed range
            // expand by the longest target name (so a match
            // straddling the edit boundary still gets caught),
            // drop existing decorations in that window, and
            // re-scan only that window. Result: per-keystroke
            // work is bounded by O(maxNameLength) text scan
            // instead of O(doc.size).
            let decos = oldDecos.map(tr.mapping, tr.doc)
            const pad = maxNameLength(currentTargets)
            const docSize = tr.doc.content.size
            tr.mapping.maps.forEach((m) => {
              m.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
                const winStart = Math.max(0, newStart - pad)
                const winEnd   = Math.min(docSize, newEnd + pad)
                // Drop only decorations FULLY CONTAINED in the window,
                // then rescan it. A target overlapping the actual edit
                // is always fully contained (the `pad` guarantees it),
                // so genuinely-stale highlights are still dropped and
                // re-emitted. But a highlight that merely TOUCHES the
                // window edge — e.g. "Amanda" when the writer types a
                // space right after it — must NOT be dropped: the rescan
                // slices the text at `winStart` (`text.slice(localFrom,
                // …)`), so a word the window begins mid-way through
                // ("…manda") can't re-match `\bAmanda\b` and would be
                // lost for good. Leaving edge-touching decorations alone
                // preserves them via the position mapping above.
                const stale = decos
                  .find(winStart, winEnd)
                  .filter((d) => d.from >= winStart && d.to <= winEnd)
                if (stale.length) decos = decos.remove(stale)
                const fresh = scanRange(tr.doc, winStart, winEnd, currentTargets, currentAccent)
                if (fresh.length) decos = decos.add(tr.doc, fresh)
              })
            })
            return decos
          },
        },
        props: {
          decorations(state) {
            return ENTITY_HIGHLIGHT_KEY.getState(state)
          },
        },
      }),
    ]
  },
})

/**
 * Send targets and enabled state to the plugin via transaction metadata.
 */
export function refreshEntityHighlights(editor, targets, enabled, accentColor) {
  if (!editor) return
  editor.view.dispatch(
    editor.view.state.tr.setMeta(ENTITY_HIGHLIGHT_KEY, { targets, enabled, accentColor })
  )
}
