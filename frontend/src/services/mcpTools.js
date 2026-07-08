/**
 * MCP tool handlers — Phase 2.1 Phase B (Wave 1 read tools).
 *
 * Each handler is a thin wrapper that reads from the live Zustand
 * stores (and, where scene-resolved state is needed, the chain
 * walkers in `narrativeChain.js`) and returns the result. Imported
 * for side-effects from `App.jsx` so the registrations happen at
 * app mount.
 *
 * Pattern: registerMcpTool(name, async (args) => result). The
 * dispatcher in `mcpBridge.js` wraps the result in a `tool_result`
 * envelope and sends it back over the WebSocket. Throwing inside a
 * handler is captured and surfaced as a `tool_execution_error` to
 * the MCP client.
 *
 * Naming: each tool's name here matches the name passed to
 * `bridge.invoke_tool(...)` from the Python side
 * (`backend/services/mcp_server.py`). Keep them in sync.
 *
 * Reference args (`entity`, `relationship`, `scene`) accept EITHER
 * a UUID OR an exact case-insensitive name/title/alias. Resolution
 * happens via the shared `_resolveEntity` / `_resolveRelationship`
 * / `_resolveScene` helpers below; on zero matches they throw "not
 * found", on multiple matches they throw an "ambiguous" error
 * listing the candidates so the MCP client can disambiguate by
 * passing the UUID instead.
 *
 * Phase B (this file):
 *   - get_project_summary — high-level project overview.
 *   - list_entities — entities by type (id, name, colour only — light).
 *   - get_entity — full origin-baseline state for one entity.
 *   - get_entity_at_scene — scene-resolved state at a scene.
 *   - find_by_name — case-insensitive substring match against names,
 *                    aliases, scene titles, relationship names, and
 *                    knowledge names.
 *   - list_scenes / list_relationships / get_relationship /
 *     get_relationship_at_scene.
 *   - list_knowledges / get_knowledge / get_knowledge_at_scene.
 *   - get_scene / get_scene_context.
 */

import { useProjectStore } from '../store/projectStore'
import { getMeasuredWidth, getMeasuredHeight } from '../utils/measuredDimensionsStore'
import { useEntitiesStore } from '../store/entitiesStore'
import { useMcpControlStore as _useMcpControlStoreRef } from '../store/mcpControlStore'
import { ENTITY_BUCKETS } from '../utils/entityHelpers'
import {
  computeEffectiveState,
  computeEffectiveStateWithPrior,
  computeRelationshipEffectiveState,
  getRelationshipNodeOrder,
  computeKnowledgeEffectiveState,
  getKnowledgeNodeOrder,
  getEntityNarrativeChain,
  resolveAwarenessFieldWithProvenance,
  knowledgeExistsAtNode,
  resolveKnowledgeCreationPoint,
} from '../utils/narrativeChain'
import { computeStoryOrder } from '../utils/storyOrder'
import { getOrComputeStoryOrderFromStore } from '../hooks/useStoryOrder'
import { placeMcpConceptNode, placeMcpGroupNode, computeConceptTidyLayout, computeConceptRegion, computeReorganizeConceptLayout, computeChapterConceptRegion } from '../utils/conceptLayout'
import { generateJSON, generateHTML } from '@tiptap/react'
import { TIPTAP_EXTENSIONS } from '../utils/tiptapExtensions'
import { storyLayoutArgs } from '../utils/rowLayout'
import { computePovChain } from '../utils/povSequence'
import { getChapterIdForNode, resolveChapterIdForNode, chapterMemberOptsForStory } from '../utils/chapterMembership'
import { getNodesInGroup, getGroupsForNode } from '../utils/groupMembership'
import { collectAffectedHostsForTag as _utilCollectAffectedHostsForTag } from '../utils/projectTagHosts'
import { buildAwarenessSourceConsumers } from '../utils/awarenessSourceIndex'
import { computeAlerts, composeAllEntities, composeEntityMap } from '../hooks/useAlerts'
import { readAwarenessAtTarget, readEffectiveAwarenessForTarget } from '../utils/awarenessCommit'
import {
  formatSceneDuration,
  formatGapExtension,
  formatGap,
  formatSlot,
  looserTier,
  sceneBucket,
} from '../utils/scenetimeVerbiage'
import { walkPovChainTime, sceneDurationMinutes } from '../utils/povChainTimeWalker'
// Canonical label sources for MCP enum I/O. Imported from the same
// files the modal carousels render from so MCP and UI can never drift:
//
//   - calendarConventions exposes the ACTIVE calendar object via
//     `getActiveCalendar()`. Default is `GREGORIAN_CALENDAR`; future
//     sci-fi / fantasy calendars plug in by either changing the
//     default import in `calendarConventions.js` OR calling
//     `setActiveCalendar(MY_CUSTOM_CAL)` once at app load. The MCP
//     reads `getActiveCalendar()` per request so whichever calendar
//     is currently active drives weekday / season / month I/O —
//     no separate MCP swap needed. Calendar shape contract:
//     `{ weekdays:{long}, seasons:{long}, months:{long}, ... }` —
//     see `gregorianCalendar.js` for the reference implementation.
//   - TimeOfDayCarousel owns the 15 labelled Time-of-Day vocabulary
//     values rendered in the gearshift picker.
//   - IntensityBadge owns the 5-tier Faint..Intense ladder rendered
//     in the circumstance / motivator intensity badge.
import { getActiveCalendar } from '../utils/calendarConventions'
import { TIME_OF_DAY_LABELS, TIME_OF_DAY_LABEL_SYNONYMS, displayTimeOfDayLabel } from '../components/ui/TimeOfDayCarousel'
import { INTENSITY_LABELS } from '../components/ui/IntensityBadge'
import { registerMcpTool, getMcpToolHandler } from './mcpBridge'

// ── Shared helpers ──────────────────────────────────────────────────────

const _ENTITY_TYPES = ['character', 'location', 'item', 'faction', 'custom']
const _LOOKUP_TYPES = [..._ENTITY_TYPES, 'scene', 'relationship', 'knowledge', 'chapter', 'act']

const _UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function _isUuid(value) {
  return typeof value === 'string' && _UUID_RE.test(value)
}

function _bucketFor(type) {
  return useEntitiesStore.getState()[`${type}s`] || []
}

function _findEntity(id) {
  for (const type of _ENTITY_TYPES) {
    const entity = _bucketFor(type).find((e) => e.id === id)
    if (entity) return { entity, type }
  }
  return null
}

/** Scan every SceneNode's EntityRef chips for `name_change` entries
 *  (and `alias_changes` per-alias add/modify events) whose value
 *  matches `value` case-insensitively. Returns a list of
 *  `{ entity_id, entity_name, entity_type, scene_id, scene_title,
 *  matched_via }` — empty when no chain-anchored rename / alias-add
 *  matches the lookup string.
 *
 *  Powers the chain-resolved-name fallback in `_resolveEntity`:
 *  origin name / alias scan runs first, and this scan is the
 *  fallback when origin produces no matches. A single hit resolves
 *  to that entity; multiple hits surface as an ambiguous error with
 *  the candidate list. Lets the MCP client pass an entity's name at
 *  ANY scene (origin, or a downstream chain-anchored rename) and
 *  have the lookup succeed without manual translation back to the
 *  origin name. Surfaced 2026-05-17b in the blind-agent rom-com
 *  test; promoted from error-enrichment-only to active resolver
 *  per user direction. */
function _findChainRenamedEntities(value) {
  const valueLower = (value || '').toLowerCase()
  if (!valueLower) return []
  const nodes = useProjectStore.getState().nodes || []
  const out = []
  const seen = new Set() // dedupe by (entity_id, scene_id, matched_via)
  for (const node of nodes) {
    if (!node || node.type !== 'sceneNode') continue
    const sceneTitle = node.data?.title || '(untitled scene)'
    for (const bucket of ENTITY_BUCKETS) {
      const refs = node.data?.[bucket] || []
      for (const ref of refs) {
        if (!ref?.entity_id) continue
        const found = _findEntity(ref.entity_id)
        if (!found) continue
        // name_change is a scalar string on EntityRef — the new
        // name from this scene forward.
        if (typeof ref.name_change === 'string' && ref.name_change.toLowerCase() === valueLower) {
          const key = `${ref.entity_id}|${node.id}|name_change`
          if (!seen.has(key)) {
            seen.add(key)
            out.push({
              entity_id: ref.entity_id,
              entity_name: found.entity?.name || '(unnamed)',
              entity_type: found.type,
              scene_id: node.id,
              scene_title: sceneTitle,
              matched_via: 'name_change',
            })
          }
        }
        // alias_changes carries per-alias events (add / modify /
        // remove / awareness_*) from this scene forward — surface a
        // match if any add or modify event introduces an alias that
        // matches the lookup value. Per-event shape:
        // `{ action, alias: {value}, alias_id, new_value, ... }`.
        // Remove / awareness events don't introduce a new alias
        // value to look up against, so they're skipped. Field name
        // is `alias_changes` (post-v0.2.1.76 refactor), NOT the
        // legacy `aliases_change` (full-list replacement).
        const aliasEvents = ref.alias_changes
        if (Array.isArray(aliasEvents)) {
          for (const ev of aliasEvents) {
            if (!ev || typeof ev !== 'object') continue
            let candidate = null
            if (ev.action === 'add' && ev.alias?.value != null) candidate = ev.alias.value
            else if (ev.action === 'modify' && ev.new_value != null) candidate = ev.new_value
            if (candidate && candidate.toLowerCase() === valueLower) {
              const key = `${ref.entity_id}|${node.id}|alias_changes`
              if (!seen.has(key)) {
                seen.add(key)
                out.push({
                  entity_id: ref.entity_id,
                  entity_name: found.entity?.name || '(unnamed)',
                  entity_type: found.type,
                  scene_id: node.id,
                  scene_title: sceneTitle,
                  matched_via: 'alias_changes',
                })
              }
              break
            }
          }
        }
      }
    }
  }
  return out
}


/** Resolve a reference (UUID OR exact case-insensitive name/alias) to
 *  a concrete entity. Returns `{ entity, type }`. Throws "not found"
 *  on zero matches and "ambiguous" with the candidate list on 2+
 *  matches. Used at the top of every tool that takes an `entity` arg
 *  so MCP clients can pass either form.
 *
 *  `typeHint` (optional): if set, restricts the search to that
 *  entity type. Passing a UUID of a different type errors out.
 *
 *  Name matching is EXACT (case-insensitive), NOT substring — use
 *  `find_by_name` for substring discovery. This keeps the resolver
 *  predictable: either you give it a unique label or you get a
 *  clarification request. */
function _resolveEntity(value, typeHint = null) {
  if (!value || typeof value !== 'string') {
    throw new Error('entity reference is required (UUID or exact name)')
  }
  if (_isUuid(value)) {
    const found = _findEntity(value)
    if (found) {
      if (typeHint && found.type !== typeHint) {
        throw new Error(
          `'${found.entity?.name || value}' is a ${found.type}, not a ${typeHint}. ` +
          `Pass a ${typeHint} reference, or call create_entity(type='${typeHint}', ...) to mint one.`
        )
      }
      return found
    }
    // fall through to name lookup — string happens to look like a uuid
  }
  const valueLower = value.toLowerCase()
  const matches = []
  const types = typeHint ? [typeHint] : _ENTITY_TYPES
  for (const type of types) {
    for (const entity of _bucketFor(type)) {
      const name = (entity.name || '')
      if (name && name.toLowerCase() === valueLower) {
        matches.push({ entity, type, matched_via: 'name', matched_value: name })
        continue
      }
      for (const a of (entity.aliases || [])) {
        const alias = typeof a === 'string' ? a : a?.value
        if (alias && alias.toLowerCase() === valueLower) {
          matches.push({ entity, type, matched_via: 'alias', matched_value: alias })
          break
        }
      }
    }
  }
  if (matches.length === 0) {
    // When a typeHint was set, the search above was restricted to that
    // type's bucket — a name/alias matching a DIFFERENT type would
    // surface as "entity not found" which misleads (the entity DOES
    // exist, just as the wrong type). Re-scan across every type so
    // the error can name the actual type and tell the caller the type
    // they passed doesn't match.
    if (typeHint) {
      for (const otherType of _ENTITY_TYPES) {
        if (otherType === typeHint) continue
        for (const entity of _bucketFor(otherType)) {
          const name = (entity.name || '')
          if (name && name.toLowerCase() === valueLower) {
            throw new Error(
              `'${name}' is a ${otherType}, not a ${typeHint}. ` +
              `Pass a ${typeHint} reference, or call create_entity(type='${typeHint}', name='${name}', ...) ` +
              `to mint a ${typeHint} by that name.`
            )
          }
          for (const a of (entity.aliases || [])) {
            const alias = typeof a === 'string' ? a : a?.value
            if (alias && alias.toLowerCase() === valueLower) {
              throw new Error(
                `'${alias}' is an alias of '${name}' (${otherType}), not a ${typeHint}. ` +
                `Pass a ${typeHint} reference, or call create_entity(type='${typeHint}', ...) to mint one.`
              )
            }
          }
        }
      }
    }
    // Before falling through to the generic "not found", check whether
    // the failed lookup matches a chain-anchored rename (or aliases_
    // change) on some entity — i.e. the client passed the entity's
    // name AT SOME SCENE rather than its origin name. Workflow guides
    // train clients to think in chain-resolved terms; this resolver
    // now matches that mental model: a chain-resolved name resolves
    // to the (sole) entity it refers to, no manual translation to
    // origin needed. Origin-name lookup takes precedence (the scan
    // above already returned matches when present) — chain-rename
    // resolution only kicks in when origin/alias produced zero hits.
    // Multiple chain-rename matches stay an ambiguous error with the
    // candidate list so the client can disambiguate via UUID.
    // Surfaced 2026-05-17b in the blind-agent rom-com test; ship-
    // resolution direction confirmed by user as the "fuller" fix
    // (vs. error-enrichment-only). Origin baseline + alias scan
    // above is unaffected.
    let chainHits = _findChainRenamedEntities(value)
    if (typeHint) {
      chainHits = chainHits.filter((h) => h.entity_type === typeHint)
    }
    if (chainHits.length >= 1) {
      // A single entity can produce MULTIPLE chain hits for one lookup
      // value — e.g. a name_change to "Leah" AND an alias_changes add of
      // "Leah" on the same entity (possibly across several scenes). That is
      // NOT ambiguous: every hit resolves to the same entity. Dedupe by
      // entity id; only 2+ DISTINCT entities is a genuine ambiguity.
      const uniqueIds = [...new Set(chainHits.map((h) => h.entity_id))]
      if (uniqueIds.length === 1) {
        const found = _findEntity(uniqueIds[0])
        if (found) {
          return { entity: found.entity, type: found.type }
        }
        // Defensive: _findEntity gone stale (entity deleted between
        // scan and resolve) — fall through to the not-found error.
      } else {
        const list = chainHits
          .map((h) => `'${h.entity_name}' (${h.entity_type}, id=${h.entity_id}) — ${h.matched_via} at scene '${h.scene_title}'`)
          .join('; ')
        throw new Error(
          `ambiguous chain-anchored name "${value}" — ${uniqueIds.length} entities have a scene-anchored rename ` +
          `or alias matching this name: ${list}. Pass the UUID to disambiguate.`
        )
      }
    }
    throw new Error(
      `entity not found: "${value}". Pass a UUID or exact (case-insensitive) name/alias. ` +
      `Lookup also accepts any chain-anchored rename / alias the entity has acquired at a downstream scene. ` +
      `Use find_by_name for substring search. ` +
      `If you need a new entity by this name, call create_entity first.`
    )
  }
  if (matches.length > 1) {
    const list = matches.map((m) =>
      `${m.entity.name} (${m.type}, id=${m.entity.id}, via ${m.matched_via})`
    ).join('; ')
    throw new Error(
      `ambiguous entity reference "${value}" — ${matches.length} matches: ${list}. ` +
      `Pass the UUID to disambiguate.`
    )
  }
  return { entity: matches[0].entity, type: matches[0].type }
}

/** Resolve a reference (UUID OR exact case-insensitive title) to a
 *  scene node. Throws "not found" / "ambiguous" same as
 *  `_resolveEntity`. */
function _resolveScene(value) {
  if (!value || typeof value !== 'string') {
    throw new Error('scene reference is required (UUID or exact title)')
  }
  const nodes = useProjectStore.getState().nodes || []
  if (_isUuid(value)) {
    const node = nodes.find((n) => n.id === value)
    if (node) {
      if (node.type !== 'sceneNode') {
        throw new Error(`node ${value} is not a scene node`)
      }
      return node
    }
  }
  const valueLower = value.toLowerCase()
  const matches = nodes.filter(
    (n) => n.type === 'sceneNode' && (n.data?.title || '').toLowerCase() === valueLower
  )
  if (matches.length === 0) {
    throw new Error(
      `scene not found: "${value}". Pass a UUID or exact (case-insensitive) title. ` +
      `Use list_scenes or find_by_name (type='scene') to discover scenes. ` +
      `If you need a new scene by this title, call create_scene first.`
    )
  }
  if (matches.length > 1) {
    const list = matches.map((n) => `"${n.data?.title}" (id=${n.id})`).join('; ')
    throw new Error(
      `ambiguous scene reference "${value}" — ${matches.length} matches: ${list}. ` +
      `Pass the UUID to disambiguate.`
    )
  }
  return matches[0]
}

/** Resolve an attribute reference (UUID OR exact case-insensitive
 *  name) within a given entity's BASELINE attributes. Used by the
 *  attribute write tools. Returns the matched attribute object.
 *  Throws on zero or 2+ matches.
 *
 *  Name matches are EXACT case-insensitive against `attribute.name`.
 *  Duplicates can theoretically exist for unnamed circumstance /
 *  motivator attributes (per the EntityModal's add validation),
 *  in which case the AI must pass the UUID explicitly.
 *
 *  Searches the entity's BASELINE list, not the scene-resolved view
 *  at any scene. Origin attribute operations only touch baseline
 *  anyway; scene-anchored operations search differently (TODO when
 *  scene-path attribute tools land). */
/** Scan every SceneNode's EntityRef chips for this entity and surface
 *  any `attribute_changes` entries that touch an attribute matching
 *  `value` (by UUID OR by name). Returns
 *  `[{ scene_id, scene_title, action, attribute_id, attribute_name,
 *  attribute_type }]` — empty when nothing matches. Used purely to
 *  enrich the "attribute not found on entity" error when the named /
 *  uuid'd attribute exists in chain history but isn't reachable at
 *  the scene the call targeted (the broken-wire-upstream case the
 *  blind-agent edit test 2026-05-18 reported). */
function _findAttributeInChainHistory(entity, value) {
  if (!entity || !value || typeof value !== 'string') return []
  const valueLower = value.toLowerCase()
  const wantUuid = _isUuid(value)
  const nodes = useProjectStore.getState().nodes || []
  const out = []
  const seen = new Set() // dedupe by (scene_id, attribute_id, action)
  for (const node of nodes) {
    if (!node || node.type !== 'sceneNode') continue
    const sceneTitle = node.data?.title || '(untitled scene)'
    for (const bucket of ENTITY_BUCKETS) {
      const refs = node.data?.[bucket] || []
      for (const ref of refs) {
        if (ref?.entity_id !== entity.id) continue
        for (const ac of (ref.attribute_changes || [])) {
          // Match by UUID — attribute_id on every action variant.
          if (wantUuid && ac.attribute_id === value) {
            const key = `${node.id}|${ac.attribute_id}|${ac.action}`
            if (!seen.has(key)) {
              seen.add(key)
              out.push({
                scene_id: node.id,
                scene_title: sceneTitle,
                action: ac.action,
                attribute_id: ac.attribute_id,
                attribute_name: ac.attribute?.name || ac.new_name || null,
                attribute_type: ac.attribute?.attribute_type || null,
              })
            }
            continue
          }
          // Match by name. The name lives in different fields depending
          // on the action: `add` carries the full attribute payload;
          // `rename` carries `new_name`; other actions only have the
          // id (so name-match falls through). We additionally check
          // the entity's baseline attribute name for the resolved id
          // when matching by name on non-add actions.
          if (!wantUuid) {
            let matched = false
            if (ac.action === 'add' && ac.attribute && (ac.attribute.name || '').toLowerCase() === valueLower) {
              matched = true
            } else if (ac.action === 'rename' && (ac.new_name || '').toLowerCase() === valueLower) {
              matched = true
            } else if (ac.attribute_id) {
              const baseAttr = (entity.attributes || []).find((a) => a.id === ac.attribute_id)
              if (baseAttr && (baseAttr.name || '').toLowerCase() === valueLower) matched = true
            }
            if (matched) {
              const key = `${node.id}|${ac.attribute_id}|${ac.action}`
              if (!seen.has(key)) {
                seen.add(key)
                out.push({
                  scene_id: node.id,
                  scene_title: sceneTitle,
                  action: ac.action,
                  attribute_id: ac.attribute_id || null,
                  attribute_name: ac.attribute?.name || ac.new_name ||
                    (entity.attributes || []).find((a) => a.id === ac.attribute_id)?.name || null,
                  attribute_type: ac.attribute?.attribute_type ||
                    (entity.attributes || []).find((a) => a.id === ac.attribute_id)?.attribute_type || null,
                })
              }
            }
          }
        }
      }
    }
  }
  return out
}


function _resolveAttribute(entity, value, options = {}) {
  if (!entity) throw new Error('entity is required for attribute resolution')
  if (!value || typeof value !== 'string') {
    throw new Error('attribute reference is required (UUID or exact name)')
  }
  // `attributesList` lets callers override the search list. Scene-path
  // attribute resolution passes the scene-resolved attribute list at
  // the scene anchor (computed via computeEffectiveState) so names
  // and ids that came into existence via downstream `action='add'`
  // chain entries can be matched. Origin-path resolution defaults to
  // entity.attributes (baseline only).
  const attrs = options.attributesList || entity.attributes || []
  if (_isUuid(value)) {
    const match = attrs.find((a) => a.id === value)
    if (match) return match
    // fall through to name match (string happens to look like a uuid)
  }
  const valueLower = value.toLowerCase()
  const matches = attrs.filter((a) => (a.name || '').toLowerCase() === valueLower && a.name)
  if (matches.length === 0) {
    // Before falling through to the generic "not found", check whether
    // the named / uuid'd attribute exists in the entity's CHAIN
    // HISTORY somewhere — i.e. it was added / modified / renamed at
    // some scene but isn't reachable at the resolution target this
    // call passed. Common cause: the entity's chip wire at the target
    // scene bypasses prior chain entries (wires direct from origin),
    // so the chain walker can't reach the add and the resolved-view
    // list (or baseline list, on origin path) doesn't contain the
    // attribute. The generic error hides this; the enriched form
    // tells the caller exactly where the chain history references
    // the attribute so they can fix the upstream wire or operate at
    // the right scene. Surfaced 2026-05-18 in the blind-agent edit
    // test.
    const chainHits = _findAttributeInChainHistory(entity, value)
    if (chainHits.length > 0) {
      // Distinct scenes where the attribute is referenced (for the
      // brief "found at: [list]" suffix).
      const sceneLabel = chainHits.length === 1
        ? `scene '${chainHits[0].scene_title}'`
        : `${chainHits.length} scenes (e.g. '${chainHits[0].scene_title}')`
      const addHits = chainHits.filter((h) => h.action === 'add')
      const addedAt = addHits.length > 0
        ? ` First added at scene '${addHits[0].scene_title}'.`
        : ''
      const attrName = chainHits[0].attribute_name || value
      const targetCtx = options.attributesList
        ? `the chain at the targeted scene doesn't reach this attribute (likely a broken or origin-direct upstream wire)`
        : `the attribute exists only as a scene-anchored chain entry, not at the entity's baseline`
      throw new Error(
        `attribute '${attrName}' exists in the chain history of '${entity.name}' ` +
        `(referenced at ${sceneLabel})${addedAt} but is NOT REACHABLE at the resolution target ` +
        `of this call — ${targetCtx}. To operate on this chain entry, target the scene where ` +
        `it lives in the chain (pass \`at='<that scene>'\`), or fix the upstream wire so the ` +
        `chain at this scene walks through to the add.`
      )
    }
    throw new Error(
      `attribute not found on entity '${entity.name}': "${value}". ` +
      `Pass a UUID or exact (case-insensitive) name. ` +
      `Use get_entity (origin or at-scene via the at arg) to discover the attribute list. ` +
      `If you need a new attribute by this name, call add_attribute first.`
    )
  }
  if (matches.length > 1) {
    const list = matches.map((a) => `"${a.name}" (id=${a.id})`).join('; ')
    throw new Error(
      `ambiguous attribute reference "${value}" on '${entity.name}' — ` +
      `${matches.length} matches: ${list}. Pass the UUID to disambiguate.`
    )
  }
  return matches[0]
}

/** Resolve a reference (UUID OR exact case-insensitive name) to a
 *  knowledge. Knowledges always have a name (it's required by the
 *  model), so unlike relationships they can always be referenced by
 *  string. Throws "not found" / "ambiguous" same as `_resolveEntity`. */
function _resolveKnowledge(value) {
  if (!value || typeof value !== 'string') {
    throw new Error('knowledge reference is required (UUID or exact name)')
  }
  const knowledges = useProjectStore.getState().knowledges || []
  if (_isUuid(value)) {
    const k = knowledges.find((kk) => kk.id === value)
    if (k) return k
  }
  const valueLower = value.toLowerCase()
  const matches = knowledges.filter(
    (k) => (k.name || '').toLowerCase() === valueLower
  )
  if (matches.length === 0) {
    throw new Error(
      `knowledge not found: "${value}". Pass a UUID or exact (case-insensitive) name. ` +
      `Use list_knowledges or find_by_name (type='knowledge') to discover knowledges. ` +
      `If you need a new knowledge by this name, call create_knowledge first.`
    )
  }
  if (matches.length > 1) {
    const list = matches.map((k) => `"${k.name}" (id=${k.id})`).join('; ')
    throw new Error(
      `ambiguous knowledge reference "${value}" — ${matches.length} matches: ${list}. ` +
      `Pass the UUID to disambiguate.`
    )
  }
  return matches[0]
}

/** Resolve a reference (UUID OR exact case-insensitive name) to a
 *  relationship. Relationships often have no name (the writer hasn't
 *  set an explicit label) — those can only be referenced by UUID.
 *  Throws "not found" / "ambiguous" same as `_resolveEntity`. */
function _resolveRelationship(value) {
  if (!value || typeof value !== 'string') {
    throw new Error('relationship reference is required (UUID or exact name)')
  }
  const rels = useProjectStore.getState().relationships || []
  if (_isUuid(value)) {
    const rel = rels.find((r) => r.id === value)
    if (rel) return rel
  }
  const valueLower = value.toLowerCase()
  const matches = rels.filter(
    (r) => r.name && r.name.toLowerCase() === valueLower
  )
  if (matches.length > 1) {
    const list = matches.map((r) => `"${r.name}" (id=${r.id})`).join('; ')
    throw new Error(
      `ambiguous relationship reference "${value}" — ${matches.length} matches: ${list}. ` +
      `Pass the UUID to disambiguate.`
    )
  }
  if (matches.length === 1) return matches[0]
  // Baseline-name lookup found nothing. Try chain-anchored renames —
  // any relationship whose `history.name_changes[]` carries a
  // `new_name` matching `value` (case-insensitive) was renamed to this
  // string at some scene. Same fallback shape `_resolveEntity` uses
  // for entity chain-renames (v0.2.1.162+), promoted from
  // error-enrichment-only to active resolver. Surfaced 2026-05-18 by
  // the blind-agent rom-com test: agent renamed a relationship
  // mid-chain and then couldn't reference it by its new name.
  const chainHits = []
  const seen = new Set()
  for (const rel of rels) {
    const nameChanges = rel.history?.name_changes || []
    for (const nc of nameChanges) {
      if (typeof nc?.new_name === 'string' && nc.new_name.toLowerCase() === valueLower) {
        const key = `${rel.id}|${nc.node_id || ''}`
        if (!seen.has(key)) {
          seen.add(key)
          chainHits.push({ rel, scene_id: nc.node_id || null, new_name: nc.new_name })
        }
        break  // one hit per rel is enough for resolution
      }
    }
  }
  // Dedupe by rel id — multiple renames to the same new name on the
  // same relationship still resolve to a single entity.
  const uniqueRels = []
  const uniqueRelIds = new Set()
  for (const h of chainHits) {
    if (uniqueRelIds.has(h.rel.id)) continue
    uniqueRelIds.add(h.rel.id)
    uniqueRels.push(h)
  }
  if (uniqueRels.length === 1) return uniqueRels[0].rel
  if (uniqueRels.length > 1) {
    // Pull scene titles for the diagnostic; missing titles fall back
    // to the scene id.
    const nodes = useProjectStore.getState().nodes || []
    const titleFor = (sid) => {
      if (!sid) return '<no scene>'
      const n = nodes.find((nn) => nn.id === sid)
      return n?.data?.title || sid
    }
    const list = uniqueRels
      .map((h) => `'${h.rel.name || '(unnamed)'}' (id=${h.rel.id}) — renamed to '${h.new_name}' at scene '${titleFor(h.scene_id)}'`)
      .join('; ')
    throw new Error(
      `ambiguous chain-anchored name "${value}" — ${uniqueRels.length} relationships have a scene-anchored rename ` +
      `matching this name: ${list}. Pass the UUID to disambiguate.`
    )
  }
  throw new Error(
    `relationship not found: "${value}". Pass a UUID or exact (case-insensitive) name. ` +
    `Lookup also accepts any chain-anchored rename the relationship has acquired at a downstream scene. ` +
    `Unnamed relationships can only be referenced by UUID — use list_relationships to discover them. ` +
    `If you need a new relationship by this name, call create_relationship first.`
  )
}

/** Phase 2.13e — resolve a perspective `target` arg to a canonical
 *  `{ kind, id }` pair. The MCP `target` shape is `{ kind, ref }` where
 *  kind is one of the seven valid kinds and ref is a UUID OR exact
 *  name. Dispatches through the per-kind resolver
 *  (`_resolveEntity` / `_resolveKnowledge` / `_resolveRelationship`).
 *  For the five entity kinds, also verifies the resolved entity's
 *  type matches the declared `kind` — passing a character UUID with
 *  `kind: 'location'` rejects with a clear type-mismatch error rather
 *  than silently letting the wrong object through. */
const _PERSPECTIVE_TARGET_KINDS = new Set([
  'character', 'location', 'item', 'faction', 'custom',
  'knowledge', 'relationship',
])
function _resolvePerspectiveTarget(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new Error(
      'target must be an object { kind, ref }. ' +
      'kind ∈ character|location|item|faction|custom|knowledge|relationship; ' +
      'ref is a UUID or exact name.'
    )
  }
  // Case-insensitive on input; canonical lowercase form stored downstream.
  const kind = (typeof target.kind === 'string' ? target.kind.trim().toLowerCase() : target.kind)
  const ref = target.ref
  if (!kind || !_PERSPECTIVE_TARGET_KINDS.has(kind)) {
    throw new Error(
      `target.kind must be one of: character, location, item, faction, custom, knowledge, relationship (case-insensitive). Got: ${JSON.stringify(target.kind)}`
    )
  }
  if (!ref || typeof ref !== 'string') {
    throw new Error('target.ref is required (UUID or exact name of the target object).')
  }
  if (kind === 'knowledge') {
    const k = _resolveKnowledge(ref)
    return { kind, id: k.id }
  }
  if (kind === 'relationship') {
    const r = _resolveRelationship(ref)
    return { kind, id: r.id }
  }
  // Entity kinds — pass the kind through as a typeHint so a mismatched
  // type errors with a clear message.
  const found = _resolveEntity(ref, kind)
  return { kind, id: found.entity.id }
}

/** Resolve a chapter reference (UUID or exact case-insensitive title) to
 *  its chapter object. Used by create_scene / update_scene for the
 *  `chapter` arg and by the chapter CRUD / read tools. Throws on
 *  not-found / ambiguous with the standard D1 error shape — direct the
 *  AI at `create_chapter` to mint a missing chapter. */
function _resolveChapter(value) {
  if (!value || typeof value !== 'string') {
    throw new Error('chapter reference is required (UUID or exact title)')
  }
  const chapters = useProjectStore.getState().story?.chapters || []
  if (_isUuid(value)) {
    const match = chapters.find((c) => c.id === value)
    if (match) return match
  }
  const valueLower = value.toLowerCase()
  // Match against stored title; OR against the UI's placeholder
  // `Chapter {index+1}` for chapters with empty title. The placeholder
  // is what the writer sees in the UI when they haven't named a
  // chapter — accept it here too so the AI can reference chapters
  // by their natural displayed names.
  const matches = chapters.filter((c, idx) => {
    const storedLower = (c.title || '').toLowerCase()
    if (storedLower && storedLower === valueLower) return true
    if (!storedLower && valueLower === `chapter ${idx + 1}`) return true
    return false
  })
  if (matches.length === 0) {
    throw new Error(
      `chapter not found: "${value}". Pass a UUID, exact ` +
      `(case-insensitive) title, or the placeholder display name ` +
      `("Chapter 1", "Chapter 2", …) for unnamed chapters. ` +
      `Call create_chapter(title=...) to mint a new one if needed.`
    )
  }
  if (matches.length > 1) {
    const list = matches.map((c) => `"${c.title}" (id=${c.id})`).join('; ')
    throw new Error(
      `ambiguous chapter "${value}" — ${matches.length} matches: ${list}. ` +
      `Pass the UUID to disambiguate.`
    )
  }
  return matches[0]
}

/** Resolve an act reference (UUID or exact case-insensitive title) to
 *  its act object. Used by act CRUD / read tools. Unnamed acts have
 *  no placeholder display name in the UI ("Untitled act" is rendered
 *  but isn't matchable here since it isn't a real title) — the AI must
 *  reference unnamed acts by UUID. */
function _resolveAct(value) {
  if (!value || typeof value !== 'string') {
    throw new Error('act reference is required (UUID or exact title)')
  }
  const acts = useProjectStore.getState().story?.acts || []
  if (_isUuid(value)) {
    const match = acts.find((a) => a.id === value)
    if (match) return match
  }
  const valueLower = value.toLowerCase()
  const matches = acts.filter((a) => {
    const storedLower = (a.title || '').toLowerCase()
    return storedLower && storedLower === valueLower
  })
  if (matches.length === 0) {
    throw new Error(
      `act not found: "${value}". Pass a UUID or an exact ` +
      `(case-insensitive) title. Unnamed acts have no matchable ` +
      `display name — reference them by UUID. Call ` +
      `create_act(chapters=[...]) to mint a new act if needed.`
    )
  }
  if (matches.length > 1) {
    const list = matches.map((a) => `"${a.title}" (id=${a.id})`).join('; ')
    throw new Error(
      `ambiguous act "${value}" — ${matches.length} matches: ${list}. ` +
      `Pass the UUID to disambiguate.`
    )
  }
  return matches[0]
}

/** Compute the canvas x-coordinate that lands a node inside the
 *  named chapter's column. Returns the chapter's horizontal centre
 *  in canvas coordinates — far enough from the chapter edges that
 *  `getChapterIdForNode`'s centre-point rule reliably maps the node
 *  back to this chapter. Used by create_scene / update_scene when
 *  the AI passes a `chapter` arg. */
function _chapterCentreX(chapter) {
  const story = useProjectStore.getState().story || {}
  const chapters = story.chapters || []
  const chapterXOffset = story.chapter_x_offset ?? 10
  let cumulative = chapterXOffset
  for (const c of chapters) {
    if (c.id === chapter.id) {
      return cumulative + (c.width || 0) / 2
    }
    cumulative += c.width || 0
  }
  // Should not happen — _resolveChapter already verified existence
  // before this gets called. Defensive fallback.
  return chapterXOffset
}

// ── MCP smart scene placement ────────────────────────────────────
//
// MCP-created scenes need predictable, non-overlapping placement on
// the canvas instead of the random viewport-blind fallback that
// `addSceneNode` defaults to when no `position` arg is supplied. The
// AI driving MCP doesn't see where the user's viewport is looking,
// and dropping new scenes on top of each other or in places that
// contradict the POV chain wiring (triggering tier-1 story-order
// errors) makes the result unusable.
//
// Strategy (constraint: NEVER move existing user-positioned nodes —
// the user's canvas layout is preserved verbatim):
//
//   1. POV-positional args (pov_after / pov_before) take priority —
//      place adjacent to the reference scene so canvas-x matches
//      chain order naturally. Mid-chain insertions pick the midpoint
//      between predecessor and successor x.
//   2. Chapter arg sets the target chapter — place within that
//      chapter's x-range. If the chapter is full (all centre-line
//      slots occupied), the placement bumps down a row.
//   3. Default — place to the right of all existing scenes at a
//      consistent y-row (the "MCP append slot").
//
// y-collision avoidance: if the target (x, y) overlaps any existing
// node within MCP_SCENE_WIDTH × MCP_SCENE_HEIGHT, shift downward by
// MCP_ROW_GAP until clear.
//
// Chapter widening: NOT done in v1. If a scene needs to land in a
// chapter that's already crowded, it may overlap inside that
// chapter's range — but the chapter membership stays correct
// (`getChapterIdForNode` resolves by centre-point), and no adjacent
// chapter's scenes get reclassified. The future `reorganize_canvas`
// tool will widen + reflow more aggressively.

// MCP layout constants. Widths default to 220 since both SceneNode and
// EntityNode use `data.width || 220` in their renderers; the fallback
// matches the React component's first-render shape. Height fallbacks
// err on the larger side (180) so freshly-placed nodes that haven't
// been measured yet don't undershoot collision checks. Actual measured
// dimensions are preferred whenever available via `_nodeWidth` /
// `_nodeHeight`.
const MCP_SCENE_GAP = 40
const MCP_ROW_GAP = 60
const MCP_DEFAULT_ROW_Y = 100
// Non-POV scenes packed inside a chapter sit at this y-offset below
// the POV row so they're visually distinguishable from POV-attached
// scenes without colliding with them. Matches the convention
// `reorganizeCanvas` uses (NON_POV_Y_OFFSET = 60 in projectStore.js).
const MCP_NON_POV_Y_OFFSET = 60
const MCP_SCENE_ROW_START_X = 150
const MCP_SCENE_WIDTH_FALLBACK = 220
const MCP_SCENE_HEIGHT_FALLBACK = 180

const MCP_ENTITY_NODE_GAP = 30
const MCP_ENTITY_ROW_Y = -260  // negative so the strip sits visually above scene rows
const MCP_ENTITY_ROW_GAP = 50
const MCP_ENTITY_ROW_START_X = 80
const MCP_ENTITY_WIDTH_FALLBACK = 220
const MCP_ENTITY_HEIGHT_FALLBACK = 180

// Relationship-origin nodes get their own row further above the
// entity row so the two object types are visually separated and
// stop overlapping. Width fallback is smaller than entities/scenes
// because relationship origin nodes are typically narrower.
// Surfaced 2026-05-18: agent reported new relationship nodes
// being dropped overlapping existing entity origin nodes because
// the prior placement used `avg(participants' positions) + (80, 40)`,
// which lands right on the entity row.
const MCP_RELATIONSHIP_ROW_Y = -480
const MCP_RELATIONSHIP_ROW_START_X = 80
const MCP_RELATIONSHIP_NODE_GAP = 30
const MCP_RELATIONSHIP_WIDTH_FALLBACK = 180
const MCP_RELATIONSHIP_HEIGHT_FALLBACK = 120

/**
 * Canonical node-dimension accessors. Match the pattern used elsewhere
 * in the codebase (`ChapterColumnsOverlay.jsx`, `projectStore.js`
 * lines 5620 / 5699 / 5798): prefer React Flow's measured dimensions
 * (set after the node renders), then the writer's explicit
 * `data.width` / `data.height` override (set when the user manually
 * resized the node), then React Flow's own `width` / `height` props
 * (older API), and finally the per-node-type fallback for nodes that
 * haven't been measured yet.
 *
 * Caller passes the appropriate fallback for the node type — scenes
 * and entity origins both default to 220 wide, but their height
 * fallbacks differ a bit because SceneNode's natural minimum is more
 * variable than EntityNode's.
 */
const _nodeWidth = (n, fallback) => n.measured?.width ?? getMeasuredWidth(n.id) ?? n.data?.width ?? n.width ?? fallback
const _nodeHeight = (n, fallback) => n.measured?.height ?? getMeasuredHeight(n.id) ?? n.data?.height ?? n.height ?? fallback

/**
 * Session-scoped Sets of node ids the current MCP session created.
 * `_mcpTidyLayout` only repositions ids in these Sets — user-positioned
 * nodes (anything the user created via the UI, anything from prior
 * sessions, anything pre-existing in the loaded project) is never
 * touched per user direction "we only want it to work by default on
 * nodes that have been created by the MCP session so that it doesnt
 * automatically reorganize the users existing layout".
 *
 * The Sets live in module scope (not in any Zustand store) because
 * they're purely an MCP-session concern; they're cleared on
 * `end_mcp_session`, and a backend restart naturally re-initialises
 * them as empty.
 */
const _mcpSessionEntityNodeIds = new Set()
const _mcpSessionSceneNodeIds = new Set()
// Phase 8.5 — concept-layer nodes this MCP session created. The concept
// auto-layout only ever moves ids in these Sets (never user-placed concepts /
// groups), mirroring the narrative isolation rule above.
const _mcpSessionConceptNodeIds = new Set()
const _mcpSessionGroupNodeIds = new Set()

/**
 * MCP session chapter-intent tracking. Populated when create_scene or
 * update_scene is called with a `chapter` arg — records the AI's
 * intent so subsequent tidy passes can honour it (widen chapters via
 * `setChapterResizeLive` when needed; shrink chapters back when no
 * session scenes remain in them).
 *
 *   _mcpSessionSceneIntendedChapter: sceneId → chapterId. The chapter
 *     the AI explicitly asked this scene to belong to.
 *   _mcpSessionChapterPreWidths: chapterId → originalWidth. The width
 *     the chapter had BEFORE the MCP session first touched it; used
 *     by tidy's shrink-when-emptied pass to restore the original
 *     width if the session no longer has scenes in that chapter.
 */
const _mcpSessionSceneIntendedChapter = new Map()
const _mcpSessionChapterPreWidths = new Map()

// Subscribe to MCP session state transitions and clear the
// session-scoped tracking Sets when a session ends (transitions out
// of 'active'). The Sets are pure layout-tracking metadata; the
// nodes themselves persist as part of the project. Cleared so a
// fresh session starts with an empty layout-tracking ledger.
// `useMcpControlStore` is imported at the top of the file alongside
// the other store imports; the subscribe call here runs at module
// load and stays alive for the JS-context lifetime.
let _prevMcpSessionState = _useMcpControlStoreRef.getState().sessionState
_useMcpControlStoreRef.subscribe((state) => {
  const next = state.sessionState
  if (_prevMcpSessionState === 'active' && next !== 'active') {
    _mcpSessionEntityNodeIds.clear()
    _mcpSessionSceneNodeIds.clear()
    _mcpSessionSceneIntendedChapter.clear()
    _mcpSessionChapterPreWidths.clear()
    _mcpSessionConceptNodeIds.clear()
    _mcpSessionGroupNodeIds.clear()
  }
  _prevMcpSessionState = next
})

/**
 * Tidy the canvas layout of MCP-session-created nodes ONLY. Runs
 * after every MCP `create_scene` / `create_entity` to produce a
 * clean horizontal layout that survives subsequent placements
 * (mid-chain inserts no longer collapse to a stacked y because we
 * re-row everything consistently).
 *
 * Constraint: never touches user-positioned nodes (nodes NOT in the
 * session Sets). User layout is preserved verbatim.
 *
 * Algorithm:
 *  - Entity origins in `_mcpSessionEntityNodeIds`: re-row at
 *    `MCP_ENTITY_ROW_Y`, x stepped by index (start + i * (width + gap)),
 *    skipping x-slots that would collide with user-positioned nodes
 *    on the entity row.
 *  - Scenes in `_mcpSessionSceneNodeIds`: walked in canonical STORY
 *    ORDER (via `computeStoryOrder` — the same topo sort
 *    `reorganizeCanvas` uses). Story order interleaves POV-chain and
 *    off-POV-chain scenes by chain constraints, so a non-POV scene
 *    wired between two POV scenes via entity continuity ends up
 *    physically BETWEEN them in x rather than appended after the
 *    entire POV chain. For each scene:
 *      • User-positioned (not session-tracked) → preserve its x;
 *        advance the linear cursor past it.
 *      • Session-tracked + intended chapter → pack inside that
 *        chapter's column at the chapter cursor, widening the chapter
 *        via `setChapterResizeLive` when needed. POV-chain scenes go
 *        on the POV row (`y = MCP_DEFAULT_ROW_Y`); non-POV scenes go
 *        on the row a small offset below
 *        (`y = MCP_DEFAULT_ROW_Y + MCP_NON_POV_Y_OFFSET`). The
 *        chapter cursor is shared across both rows so POV + non-POV
 *        scenes in the same chapter pack side-by-side without
 *        colliding.
 *      • Session-tracked + no intended chapter → linear scene-row
 *        cursor (skipping user-positioned scene collisions).
 *  - Orphan session scenes (not chain-participating, so
 *    `computeStoryOrder` skipped them) get a trailing pass: chapter-
 *    aware if an intended chapter is recorded, else far-below
 *    off-chain fallback row.
 */
function _mcpTidyLayout() {
  const projectStore = useProjectStore.getState()
  const nodes = projectStore.nodes || []
  const edges = projectStore.edges || []
  if (_mcpSessionEntityNodeIds.size === 0 && _mcpSessionSceneNodeIds.size === 0) return

  // Index nodes by id for O(1) per-id dim lookups in the cursor walks.
  const nodeById = new Map(nodes.map((n) => [n.id, n]))

  // ── Tidy entity origins ─────────────────────────────────────
  // Walk session-created entity origins in CREATION ORDER (we keep
  // creation order by Set insertion order in JS — Set iteration
  // follows insertion order). Place each at the next free x-slot
  // on the entity row, skipping slots where a user-positioned node
  // already lives. Per-node widths/heights come from actual measured
  // dimensions when available (via `_nodeWidth` / `_nodeHeight`).
  const userEntityOriginsOnRow = []
  for (const n of nodes) {
    if (n.type !== 'entityNode') continue
    if (n.data?.is_modifier) continue
    if (_mcpSessionEntityNodeIds.has(n.id)) continue
    // Approximate "on the entity row": within one row-height of MCP_ENTITY_ROW_Y
    const ny = n.position?.y || 0
    const nh = _nodeHeight(n, MCP_ENTITY_HEIGHT_FALLBACK)
    if (Math.abs(ny - MCP_ENTITY_ROW_Y) > nh) continue
    userEntityOriginsOnRow.push(n)
  }
  const xCollidesUserEntityRow = (cx, cw) => {
    for (const n of userEntityOriginsOnRow) {
      const nx = n.position?.x || 0
      const nw = _nodeWidth(n, MCP_ENTITY_WIDTH_FALLBACK)
      // AABB range overlap on x (positions are top-left in React Flow).
      const xOverlap = cx < nx + nw && cx + cw > nx
      if (xOverlap) return true
    }
    return false
  }

  let entityCursorX = MCP_ENTITY_ROW_START_X
  const entityPatches = new Map()  // node id → { x, y }
  for (const nodeId of _mcpSessionEntityNodeIds) {
    const n = nodeById.get(nodeId)
    if (!n) continue  // stale id (entity deleted out from under us)
    const myW = _nodeWidth(n, MCP_ENTITY_WIDTH_FALLBACK)
    // Advance cursor past any user-positioned collisions, using
    // actual widths for both this node and the user nodes.
    let guard = 0
    while (xCollidesUserEntityRow(entityCursorX, myW) && guard < 40) {
      entityCursorX += myW + MCP_ENTITY_NODE_GAP
      guard += 1
    }
    entityPatches.set(nodeId, { x: entityCursorX, y: MCP_ENTITY_ROW_Y })
    entityCursorX += myW + MCP_ENTITY_NODE_GAP
  }

  // ── Tidy scenes ─────────────────────────────────────────────
  // Walk POV chain forward from POV origin. For each session-created
  // scene encountered:
  //   - If it has an intended chapter recorded
  //     (`_mcpSessionSceneIntendedChapter`), place inside that chapter's
  //     column, packing left starting at the chapter's left edge. If
  //     the chapter doesn't have room, the chapter gets widened (via
  //     `setChapterResizeLive`, the same canonical resize-with-slide
  //     action the UI's chapter-drag handle uses), sliding all
  //     downstream nodes right to preserve their chapter membership.
  //   - Otherwise (no intended chapter), place at the linear scene-row
  //     cursor — existing behaviour preserved.
  //
  // After all session scenes are placed, any chapter the session
  // touched that no longer holds a session scene gets shrunk back to
  // its pre-MCP width (again via setChapterResizeLive, sliding
  // downstream nodes left to keep their memberships).
  //
  // Non-session scenes don't move; we step the linear cursor past
  // their x-position to maintain monotonic ordering. Off-chain
  // session-created scenes get placed on a second row below after
  // the chain walk.

  // ── Pre-walk PASS 1: shrink-when-emptied for any chapter the
  // session has touched but no longer has session scenes intended
  // for. We do this BEFORE computing scene placements so the
  // placement walk reads post-shrink chapter widths and scene
  // patches land at coordinates that match the final chapter
  // geometry. (Doing it after the placement walk meant scene
  // patches were computed against pre-shrink widths, then the
  // shrink moved Chapter N left, then scene patches landed too far
  // right — the scenes ended up outside their intended chapter's
  // post-shrink position.)
  //
  // Determine intended populations from the current intent map (it's
  // already up to date — _applySceneEnhancementArgs ran before this
  // tidy call and re-records intent on every chapter assignment).
  const intendedChaptersPopulated = new Set()
  for (const [sceneId, chapterId] of _mcpSessionSceneIntendedChapter) {
    // Only count if the scene still exists AND is still session-tracked
    // AND its intent still points at this chapter (the map can hold
    // stale entries when a scene's chapter is reassigned — the
    // re-set replaces the value but old entries for chapters not
    // re-set could linger; defensive belt-and-suspenders).
    if (!_mcpSessionSceneNodeIds.has(sceneId)) continue
    intendedChaptersPopulated.add(chapterId)
  }
  for (const [chapterId, preWidth] of _mcpSessionChapterPreWidths) {
    if (intendedChaptersPopulated.has(chapterId)) continue
    const liveState = useProjectStore.getState()
    const liveChapter = (liveState.story?.chapters || []).find((cc) => cc.id === chapterId)
    if (!liveChapter) continue
    if (liveChapter.width <= preWidth) continue
    const widthDelta = preWidth - liveChapter.width  // negative
    // Live right edge for shifting downstream nodes.
    let liveRightEdge = liveState.story?.chapter_x_offset ?? 10
    for (const cc of liveState.story?.chapters || []) {
      liveRightEdge += cc.width || 0
      if (cc.id === chapterId) break
    }
    const liveNodes = liveState.nodes || []
    const shrinkNodeUpdates = []
    for (const n of liveNodes) {
      const isScene = n.type === 'sceneNode'
      const nw = _nodeWidth(n, isScene ? MCP_SCENE_WIDTH_FALLBACK : MCP_ENTITY_WIDTH_FALLBACK)
      const nx = n.position?.x || 0
      const centreX = nx + nw / 2
      if (centreX > liveRightEdge) {
        shrinkNodeUpdates.push({ id: n.id, x: nx + widthDelta })
      }
    }
    useProjectStore.getState().setChapterResizeLive(chapterId, {
      width: preWidth,
      nodeUpdates: shrinkNodeUpdates,
    })
  }

  // Re-read store state after shrinks so the placement walk sees
  // post-shrink chapter widths + node positions.
  const refreshedStore = useProjectStore.getState()
  const chapters = refreshedStore.story?.chapters || []
  const chapterXOffset = refreshedStore.story?.chapter_x_offset ?? 10
  // Per-chapter geometry: original width + the widening delta this
  // tidy pass needs to apply. `effectiveLeftEdge` / `effectiveRightEdge`
  // resolve a chapter's bounds with cumulative widenings of upstream
  // chapters factored in.
  const chapterGeometry = new Map()
  for (const c of chapters) {
    chapterGeometry.set(c.id, { originalWidth: c.width || 0, addedWidth: 0 })
  }
  const effectiveLeftEdge = (chapterId) => {
    let edge = chapterXOffset
    for (const c of chapters) {
      if (c.id === chapterId) return edge
      const g = chapterGeometry.get(c.id)
      edge += (g?.originalWidth || 0) + (g?.addedWidth || 0)
    }
    return edge
  }
  const effectiveRightEdge = (chapterId) => {
    const g = chapterGeometry.get(chapterId)
    if (!g) return chapterXOffset
    return effectiveLeftEdge(chapterId) + g.originalWidth + g.addedWidth
  }

  // Per-chapter cursor: next free x INSIDE the chapter (in effective
  // coordinates that account for upstream widenings). The cursor
  // advances past EVERY scene placed in the chapter in story order —
  // both session and non-session — so a session scene inserted
  // between two non-session scenes via pov_after lands BETWEEN them
  // spatially rather than at the chapter's right edge. Lazy-init to
  // the chapter's left edge + gap on first scene encountered.
  // Surfaced 2026-05-18 in the blind-agent edit test: previously the
  // cursor only tracked session-placed scenes, so a new session
  // scene would land at the chapter's left edge and the collision
  // walk would push it past every existing user scene — ending at
  // the chapter's right edge regardless of chain position.
  const chapterScenesCursors = new Map()
  // Track which chapters had at least one session scene placed (used
  // by the shrink-when-emptied pass to decide whether to restore the
  // pre-MCP width).
  const chaptersWithSessionScenes = new Set()
  // Helper shared by the per-scene branch below — initialise the
  // chapter cursor to either an existing tracked value OR to the
  // chapter's left edge + gap. Wrapping it lets both the non-session
  // branch (cursor follows preserved/shifted scenes) and the session
  // branch (cursor anchors fresh placement) share the same init.
  const getOrInitChapterCursor = (chapterId) => {
    let cursor = chapterScenesCursors.get(chapterId)
    if (cursor === undefined) cursor = effectiveLeftEdge(chapterId) + MCP_SCENE_GAP
    return cursor
  }

  const userScenesOnRow = []
  for (const n of nodes) {
    if (n.type !== 'sceneNode') continue
    if (_mcpSessionSceneNodeIds.has(n.id)) continue
    const ny = n.position?.y || 0
    const nh = _nodeHeight(n, MCP_SCENE_HEIGHT_FALLBACK)
    if (Math.abs(ny - MCP_DEFAULT_ROW_Y) > nh) continue
    userScenesOnRow.push(n)
  }
  const xCollidesUserSceneRow = (cx, cw) => {
    for (const n of userScenesOnRow) {
      const nx = n.position?.x || 0
      const nw = _nodeWidth(n, MCP_SCENE_WIDTH_FALLBACK)
      // AABB range overlap on x (positions are top-left in React Flow).
      const xOverlap = cx < nx + nw && cx + cw > nx
      if (xOverlap) return true
    }
    return false
  }

  const scenePatches = new Map()
  let sceneCursorX = MCP_SCENE_ROW_START_X
  // Off-chain fallback row — only used for session scenes that are
  // both (a) NOT placeable in any chapter (no intended chapter recorded
  // OR the recorded chapter no longer exists) AND (b) NOT on the POV
  // chain. Far below the main row so they don't accidentally drift
  // into chapter columns.
  let offChainCursorX = MCP_SCENE_ROW_START_X
  const offChainRowY = MCP_DEFAULT_ROW_Y + MCP_SCENE_HEIGHT_FALLBACK + MCP_ROW_GAP * 2

  // POV-chain membership: build a Set of scene ids the POV walker
  // reaches from the POV origin node. Drives the y-row decision —
  // POV-chain scenes go to MCP_DEFAULT_ROW_Y; non-POV (off-POV chain
  // stop) scenes go to the non-POV row a small offset below. Built
  // independently of placement so the placement walk below can use a
  // story-order (topo-sorted) iteration that interleaves POV + off-POV
  // scenes by chain constraints — that way an off-POV scene chain-
  // wired between two POV scenes (e.g. an entity-continuity wire
  // through a non-POV scene) ends up physically BETWEEN them in x,
  // not appended after the POV chain.
  const povChainSceneIds = new Set()
  {
    const povOriginNode = nodes.find((n) => n.type === 'povOriginNode')
    if (povOriginNode) {
      let curId = povOriginNode.id
      const visited = new Set()
      while (curId) {
        if (visited.has(curId)) break
        visited.add(curId)
        const out = edges.find((e) => e.data?.is_pov_path && e.source === curId)
        if (!out) break
        const nextSceneId = out.target
        const nextNode = nodeById.get(nextSceneId)
        if (!nextNode || nextNode.type !== 'sceneNode') break
        povChainSceneIds.add(nextSceneId)
        curId = nextSceneId
      }
    }
  }

  // Drive placement off the canonical story-order topo sort — the same
  // one `reorganizeCanvas` uses. This gives us a single ordered list of
  // every chain-participating node (POV + off-POV scenes interleaved
  // by chain constraints), so a non-POV scene wired between two POV
  // scenes via entity continuity gets placed BETWEEN them rather than
  // after the entire POV chain. computeStoryOrder may return modifier
  // EntityNodes alongside scenes — we filter to sceneNode only here
  // since modifier-node placement isn't part of this tidy pass.
  const storyOrder = computeStoryOrder({ nodes, edges, chapters, chapterXOffset, ...storyLayoutArgs(refreshedStore.story) })
  const orderedIds = storyOrder?.orderedIds || []
  const orderedScenes = orderedIds
    .map((id) => nodeById.get(id))
    .filter((n) => n && n.type === 'sceneNode')

  // Track scenes the walk visited so trailing off-chain (truly
  // orphan — not even chain-participating, so computeStoryOrder
  // skipped them) session scenes can be placed afterwards.
  const visitedSceneIds = new Set()

  for (const node of orderedScenes) {
    const sceneId = node.id
    visitedSceneIds.add(sceneId)
    const sw = _nodeWidth(node, MCP_SCENE_WIDTH_FALLBACK)
    const isPovScene = povChainSceneIds.has(sceneId)
    const yRow = isPovScene
      ? MCP_DEFAULT_ROW_Y
      : MCP_DEFAULT_ROW_Y + MCP_NON_POV_Y_OFFSET

    if (!_mcpSessionSceneNodeIds.has(sceneId)) {
      // Non-session scene — preserve its x in most cases, but cascade-
      // shift it RIGHT when an upstream session-scene insert has
      // advanced the chapter cursor past this scene's current
      // position. Without the shift, a session scene inserted via
      // pov_after that should sit between B and C would land at C's
      // x (cursor advanced past C via the collision walk), defeating
      // the spatial-matches-chain-order goal. With the shift, C
      // slides right to make room and any further downstream scenes
      // cascade right too via the next iteration of this same loop.
      // User direction confirmed 2026-05-18: cascade-shift is the
      // right behaviour.
      const ux = node.position?.x || 0
      const chapterIdForNonSession = getChapterIdForNode(node, chapters, chapterXOffset)
      if (chapterIdForNonSession && chapterGeometry.has(chapterIdForNonSession)) {
        const chapCursor = getOrInitChapterCursor(chapterIdForNonSession)
        if (ux < chapCursor) {
          // Shift right to chapter cursor so the previous session
          // scene's right edge doesn't overlap this one.
          scenePatches.set(sceneId, { x: chapCursor, y: yRow })
          chapterScenesCursors.set(chapterIdForNonSession, chapCursor + sw + MCP_SCENE_GAP)
          // Track widening if the shift pushes past chapter's right edge.
          const rightEdge = effectiveRightEdge(chapterIdForNonSession)
          if (chapCursor + sw + MCP_SCENE_GAP > rightEdge) {
            const overflow = (chapCursor + sw + MCP_SCENE_GAP) - rightEdge
            chapterGeometry.get(chapterIdForNonSession).addedWidth += overflow
          }
          // Linear cursor follows the shifted position.
          const advanceTo = chapCursor + sw + MCP_SCENE_GAP
          if (advanceTo > sceneCursorX) sceneCursorX = advanceTo
        } else {
          // Preserve current x; advance cursor past this scene's
          // right edge so the NEXT session scene in the chapter (if
          // any) starts in the right spot.
          chapterScenesCursors.set(chapterIdForNonSession, ux + sw + MCP_SCENE_GAP)
          const advanceTo = ux + sw + MCP_SCENE_GAP
          if (advanceTo > sceneCursorX) sceneCursorX = advanceTo
        }
      } else {
        // No chapter membership — preserve current x; advance linear
        // cursor only.
        const advanceTo = ux + sw + MCP_SCENE_GAP
        if (advanceTo > sceneCursorX) sceneCursorX = advanceTo
      }
      continue
    }

    // Session-tracked scene — place either chapter-aware (intended
    // chapter recorded) or linear (no intent / chapter gone).
    const intendedChapterId = _mcpSessionSceneIntendedChapter.get(sceneId)
    if (intendedChapterId && chapterGeometry.has(intendedChapterId)) {
      let chapCursor = getOrInitChapterCursor(intendedChapterId)
      // Skip x-slots that collide with user-positioned scenes whose
      // bodies straddle into this chapter from an ADJACENT chapter
      // (most commonly after `create_chapter(before|after)` shifts
      // boundaries past a wide existing scene). User scenes IN this
      // chapter and earlier in story order have already advanced the
      // cursor; collisions with them won't happen.
      let guardCh = 0
      while (xCollidesUserSceneRow(chapCursor, sw) && guardCh < 40) {
        chapCursor += sw + MCP_SCENE_GAP
        guardCh += 1
      }
      const rightEdge = effectiveRightEdge(intendedChapterId)
      if (chapCursor + sw + MCP_SCENE_GAP > rightEdge) {
        const overflow = (chapCursor + sw + MCP_SCENE_GAP) - rightEdge
        chapterGeometry.get(intendedChapterId).addedWidth += overflow
      }
      scenePatches.set(sceneId, { x: chapCursor, y: yRow })
      chapterScenesCursors.set(intendedChapterId, chapCursor + sw + MCP_SCENE_GAP)
      chaptersWithSessionScenes.add(intendedChapterId)
    } else {
      // Linear cursor placement, skipping x-slots that would collide
      // with user-positioned scenes on the POV row. yRow already
      // picks POV vs non-POV row above.
      let guard = 0
      while (xCollidesUserSceneRow(sceneCursorX, sw) && guard < 40) {
        sceneCursorX += sw + MCP_SCENE_GAP
        guard += 1
      }
      scenePatches.set(sceneId, { x: sceneCursorX, y: yRow })
      sceneCursorX += sw + MCP_SCENE_GAP
    }
  }

  // Orphan session scenes — not chain-participating, so computeStoryOrder
  // didn't include them. Same fallback policy as before: chapter-aware
  // if an intended chapter is recorded, else linear off-chain row far
  // below the main rows.
  for (const sceneId of _mcpSessionSceneNodeIds) {
    if (visitedSceneIds.has(sceneId)) continue
    const sn = nodeById.get(sceneId)
    if (!sn) continue
    const sw = _nodeWidth(sn, MCP_SCENE_WIDTH_FALLBACK)
    const intendedChapterId = _mcpSessionSceneIntendedChapter.get(sceneId)
    if (intendedChapterId && chapterGeometry.has(intendedChapterId)) {
      let chapCursor = chapterScenesCursors.get(intendedChapterId)
      if (chapCursor === undefined) {
        chapCursor = effectiveLeftEdge(intendedChapterId) + MCP_SCENE_GAP
      }
      // Same user-scene-collision avoidance as the main placement
      // walk above — see comment there for the straddling-scene case
      // this handles.
      let guardCh = 0
      while (xCollidesUserSceneRow(chapCursor, sw) && guardCh < 40) {
        chapCursor += sw + MCP_SCENE_GAP
        guardCh += 1
      }
      const rightEdge = effectiveRightEdge(intendedChapterId)
      if (chapCursor + sw + MCP_SCENE_GAP > rightEdge) {
        const overflow = (chapCursor + sw + MCP_SCENE_GAP) - rightEdge
        chapterGeometry.get(intendedChapterId).addedWidth += overflow
      }
      scenePatches.set(sceneId, {
        x: chapCursor,
        y: MCP_DEFAULT_ROW_Y + MCP_NON_POV_Y_OFFSET,
      })
      chapterScenesCursors.set(intendedChapterId, chapCursor + sw + MCP_SCENE_GAP)
      chaptersWithSessionScenes.add(intendedChapterId)
    } else {
      scenePatches.set(sceneId, { x: offChainCursorX, y: offChainRowY })
      offChainCursorX += sw + MCP_SCENE_GAP
    }
  }

  // ── Apply chapter widenings via setChapterResizeLive ────────
  // For each chapter that needs widening (in chapter index order so
  // each call's nodeUpdates is computed against the post-previous-
  // widening state), call the canonical resize-with-slide action.
  // Downstream nodes (centre past the chapter's CURRENT right edge)
  // get shifted right by addedWidth, preserving their chapter
  // membership. Session scene patches computed above used effective
  // edges that already account for cumulative widenings, so the
  // final scenePatches setState will override the slide for any
  // session scene targeted past the widened chapter.
  for (const c of chapters) {
    const g = chapterGeometry.get(c.id)
    if (!g || g.addedWidth <= 0) continue
    const liveState = useProjectStore.getState()
    const liveChapter = (liveState.story?.chapters || []).find((cc) => cc.id === c.id)
    if (!liveChapter) continue
    // Compute live right edge (chapters before c may already have
    // been widened by earlier iterations).
    let liveRightEdge = liveState.story?.chapter_x_offset ?? 10
    for (const cc of liveState.story?.chapters || []) {
      liveRightEdge += cc.width || 0
      if (cc.id === c.id) break
    }
    const liveNodes = liveState.nodes || []
    const nodeUpdates = []
    for (const n of liveNodes) {
      const isScene = n.type === 'sceneNode'
      const nw = _nodeWidth(n, isScene ? MCP_SCENE_WIDTH_FALLBACK : MCP_ENTITY_WIDTH_FALLBACK)
      const nx = n.position?.x || 0
      const centreX = nx + nw / 2
      if (centreX > liveRightEdge) {
        nodeUpdates.push({ id: n.id, x: nx + g.addedWidth })
      }
    }
    useProjectStore.getState().setChapterResizeLive(c.id, {
      width: (liveChapter.width || 0) + g.addedWidth,
      nodeUpdates,
    })
  }

  // ── Commit patches in one set() ─────────────────────────────
  if (entityPatches.size === 0 && scenePatches.size === 0) return
  useProjectStore.setState((s) => ({
    nodes: s.nodes.map((n) => {
      const entPatch = entityPatches.get(n.id)
      if (entPatch) return { ...n, position: entPatch }
      const scnPatch = scenePatches.get(n.id)
      if (scnPatch) return { ...n, position: scnPatch }
      return n
    }),
    hasUnsavedChanges: true,
  }))
}

/**
 * MCP-side smart placement for entity origin EntityNodes — same
 * constraint as `_mcpComputeScenePosition`: never move existing
 * nodes, only compute a clean spot for the new one. Picks an x to
 * the right of all existing entity origin nodes and a y on the
 * "entity row" above the scene area, shifting downward on collision.
 */
function _mcpComputeEntityNodePosition() {
  const projectStore = useProjectStore.getState()
  const nodes = projectStore.nodes || []
  const originEntityNodes = nodes.filter(
    (n) => n.type === 'entityNode' && !n.data?.is_modifier,
  )

  // y: existing row mean if there are origins, else the entity-row default.
  let baseY = MCP_ENTITY_ROW_Y
  if (originEntityNodes.length > 0) {
    const meanY = originEntityNodes.reduce(
      (s, n) => s + (n.position?.y || 0), 0,
    ) / originEntityNodes.length
    baseY = Math.round(meanY / 20) * 20
  }
  // Keep the entity strip clear of the concept band. The band (concept nodes +
  // concept groups) now shares the negative-y space the entity row lives in, so
  // a bare row default drops origins on top of the brainstorming map. Start no
  // higher than just below the band's lowest edge; the collision-shift below then
  // handles fine placement. (Grouped entities get moved into their group after.)
  const conceptBottom = nodes.reduce((mx, n) => {
    const isConcept = n.type === 'genericGroupNode' || (n.type === 'referenceNode' && n.data?.sub_type === 'concept')
    if (!isConcept) return mx
    return Math.max(mx, (n.position?.y || 0) + _nodeHeight(n, MCP_ENTITY_HEIGHT_FALLBACK))
  }, -Infinity)
  if (Number.isFinite(conceptBottom)) baseY = Math.max(baseY, conceptBottom + MCP_ENTITY_ROW_GAP)

  // x: rightmost existing origin + its actual width + gap, OR a
  // default start when no origins exist yet. Reads measured width
  // from each existing origin so the cursor steps by the actual node
  // sizes rather than a hardcoded assumption.
  let baseX
  if (originEntityNodes.length > 0) {
    const rightEdges = originEntityNodes.map((n) => {
      const nx = n.position?.x || 0
      const nw = _nodeWidth(n, MCP_ENTITY_WIDTH_FALLBACK)
      return nx + nw / 2  // node positions are top-left in React Flow; right edge = x + width / 2 from centre OR x + width from top-left? See note.
    })
    // React Flow positions are TOP-LEFT corners (not centres). Rightmost
    // edge of a node = position.x + width. Use that for the step.
    const maxRight = Math.max(...originEntityNodes.map((n) => (n.position?.x || 0) + _nodeWidth(n, MCP_ENTITY_WIDTH_FALLBACK)))
    baseX = maxRight + MCP_ENTITY_NODE_GAP
    void rightEdges  // silence unused (kept for docstring clarity)
  } else {
    baseX = MCP_ENTITY_ROW_START_X
  }

  // Collision: shift downward (toward the scene area) until clear.
  // Per-node dimensions come from actual measured values via
  // `_nodeWidth` / `_nodeHeight`; the new node uses the fallback width
  // since it hasn't been measured yet.
  const slotsOverlap = (cx, cy) => {
    const myW = MCP_ENTITY_WIDTH_FALLBACK
    const myH = MCP_ENTITY_HEIGHT_FALLBACK
    for (const n of nodes) {
      const nx = n.position?.x || 0
      const ny = n.position?.y || 0
      const nh = _nodeHeight(n, MCP_ENTITY_HEIGHT_FALLBACK)
      const nw = _nodeWidth(n, MCP_ENTITY_WIDTH_FALLBACK)
      // React Flow positions are top-left; overlap is per-axis range overlap.
      const overlapX = cx < nx + nw && cx + myW > nx
      const overlapY = cy < ny + nh && cy + myH > ny
      if (overlapX && overlapY) return true
    }
    return false
  }
  let targetY = baseY
  let guard = 0
  while (slotsOverlap(baseX, targetY) && guard < 40) {
    targetY += MCP_ENTITY_HEIGHT_FALLBACK + MCP_ENTITY_ROW_GAP
    guard += 1
  }

  return { x: baseX, y: targetY }
}


/**
 * MCP-side smart placement for relationship-origin nodes.
 *
 * Drops the new origin onto the dedicated relationship row
 * (`MCP_RELATIONSHIP_ROW_Y`) at the next free x-slot — same row-and-
 * cursor pattern as `_mcpComputeEntityNodePosition` but on a row
 * distinct from the entity row so the two object types don't
 * overlap. Surfaced 2026-05-18: the prior placement used
 * `avg(participants' origin positions) + (80, 40)` which landed
 * relationship origins right on top of entity origins.
 *
 * Constraint (same as the entity helper): never move existing
 * nodes; only compute a clean spot for the new one. Collision-shift
 * downward on conflict, identical to the entity placement walk.
 */
function _mcpComputeRelationshipNodePosition() {
  const projectStore = useProjectStore.getState()
  const nodes = projectStore.nodes || []
  const relOriginNodes = nodes.filter((n) => n.type === 'relationshipOriginNode')

  // y: existing row mean if there are origins, else the relationship-
  // row default.
  let baseY = MCP_RELATIONSHIP_ROW_Y
  if (relOriginNodes.length > 0) {
    const meanY = relOriginNodes.reduce((s, n) => s + (n.position?.y || 0), 0) / relOriginNodes.length
    baseY = Math.round(meanY / 20) * 20
  }

  // x: rightmost existing relationship origin + width + gap, else
  // the row's start. Reads measured width per existing node so the
  // cursor steps by actual sizes instead of a hardcoded assumption.
  let baseX
  if (relOriginNodes.length > 0) {
    const maxRight = Math.max(
      ...relOriginNodes.map((n) =>
        (n.position?.x || 0) + _nodeWidth(n, MCP_RELATIONSHIP_WIDTH_FALLBACK),
      ),
    )
    baseX = maxRight + MCP_RELATIONSHIP_NODE_GAP
  } else {
    baseX = MCP_RELATIONSHIP_ROW_START_X
  }

  // Collision: shift downward (toward the entity / scene rows) until
  // clear. AABB check against every existing node — relationship row
  // shouldn't overlap entities OR scenes either, so include all.
  const slotsOverlap = (cx, cy) => {
    const myW = MCP_RELATIONSHIP_WIDTH_FALLBACK
    const myH = MCP_RELATIONSHIP_HEIGHT_FALLBACK
    for (const n of nodes) {
      const nx = n.position?.x || 0
      const ny = n.position?.y || 0
      const nw = _nodeWidth(n, MCP_RELATIONSHIP_WIDTH_FALLBACK)
      const nh = _nodeHeight(n, MCP_RELATIONSHIP_HEIGHT_FALLBACK)
      if (cx < nx + nw && cx + myW > nx && cy < ny + nh && cy + myH > ny) return true
    }
    return false
  }
  let targetY = baseY
  let guard = 0
  while (slotsOverlap(baseX, targetY) && guard < 40) {
    targetY += MCP_RELATIONSHIP_HEIGHT_FALLBACK + MCP_ENTITY_ROW_GAP
    guard += 1
  }
  return { x: baseX, y: targetY }
}


function _mcpComputeScenePosition(args) {
  const projectStore = useProjectStore.getState()
  const nodes = projectStore.nodes || []
  const sceneNodes = nodes.filter((n) => n.type === 'sceneNode')

  // Default row y — mean of existing scene y rounded to nearest 20px
  // (the canvas dot-grid pitch), falling back to MCP_DEFAULT_ROW_Y
  // when no scenes exist yet.
  let baseY = MCP_DEFAULT_ROW_Y
  if (sceneNodes.length > 0) {
    const meanY = sceneNodes.reduce((s, n) => s + (n.position?.y || 0), 0) / sceneNodes.length
    baseY = Math.round(meanY / 20) * 20
  }

  // Resolve placement target x by priority. React Flow positions are
  // TOP-LEFT corners; "right edge" of a node = position.x + width. We
  // read actual measured widths via `_nodeWidth` so the step matches
  // each node's real size instead of a hardcoded assumption.
  let targetX = null
  if (args.pov_after !== undefined && args.pov_after !== null && args.pov_after !== '') {
    const ref = _resolveScene(args.pov_after)
    const refX = ref.position?.x || 0
    const refW = _nodeWidth(ref, MCP_SCENE_WIDTH_FALLBACK)
    const projectStoreEdges = projectStore.edges || []
    const outEdge = projectStoreEdges.find(
      (e) => e.data?.is_pov_path && e.source === ref.id,
    )
    if (outEdge) {
      const successor = nodes.find((n) => n.id === outEdge.target)
      const succX = successor?.position?.x
      if (succX != null && succX > refX) {
        // Place new scene's left edge midway between ref's right edge
        // and successor's left edge.
        const refRight = refX + refW
        const midpoint = Math.round((refRight + succX) / 2)
        targetX = midpoint - Math.round(MCP_SCENE_WIDTH_FALLBACK / 2)
      } else {
        targetX = refX + refW + MCP_SCENE_GAP
      }
    } else {
      targetX = refX + refW + MCP_SCENE_GAP
    }
  } else if (args.pov_before !== undefined && args.pov_before !== null && args.pov_before !== '') {
    const ref = _resolveScene(args.pov_before)
    const refX = ref.position?.x || 0
    const projectStoreEdges = projectStore.edges || []
    const inEdge = projectStoreEdges.find(
      (e) => e.data?.is_pov_path && e.target === ref.id,
    )
    if (inEdge) {
      const predecessor = nodes.find((n) => n.id === inEdge.source)
      const predX = predecessor?.position?.x
      const predW = predecessor ? _nodeWidth(predecessor, MCP_SCENE_WIDTH_FALLBACK) : 0
      if (predX != null && predX + predW < refX) {
        const predRight = predX + predW
        const midpoint = Math.round((predRight + refX) / 2)
        targetX = midpoint - Math.round(MCP_SCENE_WIDTH_FALLBACK / 2)
      } else {
        targetX = refX - MCP_SCENE_WIDTH_FALLBACK - MCP_SCENE_GAP
      }
    } else {
      targetX = refX - MCP_SCENE_WIDTH_FALLBACK - MCP_SCENE_GAP
    }
  } else if (args.chapter !== undefined && args.chapter !== null && args.chapter !== '') {
    const chapter = _resolveChapter(args.chapter)
    // Chapter centre is the chapter column's horizontal centre; shift
    // left by half the new scene's width so the centre of the scene
    // sits at the chapter centre.
    targetX = _chapterCentreX(chapter) - Math.round(MCP_SCENE_WIDTH_FALLBACK / 2)
  } else {
    // Default: right of all existing scenes' right edges
    const maxRight = sceneNodes.length > 0
      ? Math.max(...sceneNodes.map((n) => (n.position?.x || 0) + _nodeWidth(n, MCP_SCENE_WIDTH_FALLBACK)))
      : 0
    targetX = sceneNodes.length > 0
      ? maxRight + MCP_SCENE_GAP
      : MCP_SCENE_ROW_START_X
  }

  // y-collision avoidance: shift down until the target slot has no
  // overlap with any existing node. AABB (top-left coordinate)
  // overlap, with per-node measured dimensions.
  let targetY = baseY
  const slotsOverlap = (cx, cy) => {
    const myW = MCP_SCENE_WIDTH_FALLBACK
    const myH = MCP_SCENE_HEIGHT_FALLBACK
    for (const n of nodes) {
      const nx = n.position?.x || 0
      const ny = n.position?.y || 0
      const nh = _nodeHeight(n, MCP_SCENE_HEIGHT_FALLBACK)
      const nw = _nodeWidth(n, MCP_SCENE_WIDTH_FALLBACK)
      const overlapX = cx < nx + nw && cx + myW > nx
      const overlapY = cy < ny + nh && cy + myH > ny
      if (overlapX && overlapY) return true
    }
    return false
  }
  let guard = 0
  while (slotsOverlap(targetX, targetY) && guard < 40) {
    targetY += MCP_SCENE_HEIGHT_FALLBACK + MCP_ROW_GAP
    guard += 1
  }

  return { x: targetX, y: targetY }
}

/** Resolve a custom-category reference (UUID or exact case-insensitive
 *  name) to its id. Used by create_entity / update_entity for the
 *  `category_id` arg on 'custom' entities. Throws on not-found / ambiguous
 *  with a helpful message — no MCP create-tool exists for custom
 *  categories yet, so the not-found error directs the user at the UI. */
/** Resolve a custom-category reference (UUID or exact case-insensitive
 *  name) to its full category object. Used by the custom_category CRUD
 *  tools and by any other tool that needs the full record. Throws on
 *  not-found / ambiguous with the standard D1 error shape. */
function _resolveCustomCategory(value) {
  if (!value || typeof value !== 'string') {
    throw new Error('custom_category reference is required (UUID or exact name)')
  }
  const cats = useEntitiesStore.getState().customCategories || []
  if (_isUuid(value)) {
    const match = cats.find((c) => c.id === value)
    if (match) return match
  }
  const valueLower = value.toLowerCase()
  const matches = cats.filter((c) => (c.name || '').toLowerCase() === valueLower)
  if (matches.length === 0) {
    throw new Error(
      `custom_category not found: "${value}". Pass a UUID or exact ` +
      `(case-insensitive) name. Call create_custom_category(name=...) ` +
      `to mint a new one if needed.`
    )
  }
  if (matches.length > 1) {
    const list = matches.map((c) => `"${c.name}" (id=${c.id})`).join('; ')
    throw new Error(
      `ambiguous custom_category "${value}" — ${matches.length} matches: ${list}. ` +
      `Pass the UUID to disambiguate.`
    )
  }
  return matches[0]
}

function _resolveCustomCategoryId(value) {
  return _resolveCustomCategory(value).id
}

/** Project a custom category for MCP return shapes. */
function _projectCustomCategory(cat) {
  return {
    id: cat.id,
    name: cat.name || '',
    description: cat.description || '',
    colour: cat.colour || null,
    profile_image_ref: cat.profile_image_ref || null,
  }
}

/** Project an Attribute to a clean MCP-client-friendly shape per its
 *  attribute_type. Strips internal fields (awareness wrappers, change
 *  ids, etc.) and surfaces the right value field based on type. */
function _projectAttribute(attr) {
  if (!attr) return null
  const out = {
    id: attr.id,
    name: attr.name || '',
    type: attr.attribute_type || 'text',
  }
  switch (attr.attribute_type) {
    case 'file':
      out.file_ref = attr.file_ref || null
      break
    case 'preset':
      out.value = attr.value || ''
      if (attr.preset_list_name) out.preset_list_name = attr.preset_list_name
      break
    case 'number':
      out.number_value = attr.number_value ?? null
      break
    case 'text_list':
    case 'entity_list': {
      let values = []
      try { values = JSON.parse(attr.value || '[]') } catch { values = [] }
      out.values = Array.isArray(values) ? values : []
      break
    }
    case 'circumstance':
    case 'motivator':
      out.description = attr.description || ''
      // intensity returns as a CANONICAL NAME ('Faint' / 'Mild' /
      // 'Moderate' / 'Strong' / 'Intense') instead of a bare 0-4 int
      // so the AI sees the same label as the IntensityBadge tooltip
      // shows the writer. Input resolvers accept either int or name
      // for round-trip — echoing the returned string is sufficient.
      if (attr.intensity != null) out.intensity = _intensityName(attr.intensity)
      break
    case 'perspective':
      out.description = attr.description || ''
      // Surface the target as a `{ kind, id, name }` triple. The name
      // is resolved live from the project store so the AI sees the
      // target's current display name. Orphaned-target perspectives
      // (kind / id both null after the cascade) surface as
      // `target: null` so the AI can detect them and act.
      if (attr.perspective_target_kind && attr.perspective_target_id) {
        const kind = attr.perspective_target_kind
        const id = attr.perspective_target_id
        let name = null
        if (kind === 'knowledge') {
          const k = (useProjectStore.getState().knowledges || []).find((x) => x.id === id)
          name = k?.name || null
        } else if (kind === 'relationship') {
          const r = (useProjectStore.getState().relationships || []).find((x) => x.id === id)
          name = r?.name || null
        } else {
          const found = _findEntity(id)
          name = found?.entity?.name || null
        }
        out.target = { kind, id, name }
      } else {
        out.target = null
      }
      break
    default:
      out.value = attr.value || ''
  }
  return out
}

/** Collect every entity that has ever been a participant in a
 *  relationship. Unions TWO sources: (a) entities that joined via an
 *  explicit `history.participant_changes` event with `action='join'`,
 *  and (b) entities that have a `participant_roles` entry at origin
 *  (some relationships are modeled as "ambient with roles" without
 *  explicit join events — e.g. the Dracula project's
 *  "Jonathan and Mina's Marriage" assigns Husband/Wife roles directly
 *  without history join events).
 *
 *  NOT a "currently in the relationship" view — that requires walking
 *  to a scene. Used by `list_relationships` and `get_relationship`
 *  for a cheap "who's been involved at any point" browse field. */
function _participantsEver(rel) {
  const set = new Set()
  for (const ch of (rel?.history?.participant_changes || [])) {
    if (ch.action === 'join' && ch.entity_id) set.add(ch.entity_id)
  }
  for (const eid of Object.keys(rel?.participant_roles || {})) {
    if (eid) set.add(eid)
  }
  return [...set]
}

/** Project a Relationship's ORIGIN baseline. Strips internal fields
 *  (awareness wrappers, creation_anchor_node_id). */
function _projectRelationshipOrigin(rel) {
  if (!rel) return null
  return {
    id: rel.id,
    name: rel.name || null,
    description: rel.description || '',
    membership_of: rel.membership_of || null,
    participant_ids_ever: _participantsEver(rel),
    participant_roles: rel.participant_roles || {},
    hierarchy: rel.hierarchy || null,
    awareness_scale: rel.awareness_scale || 'binary',
    // Origin location: scene id when the relationship was born at a
    // scene (existence_changes activate@scene), or a
    // RelationshipOriginNode id when born standalone on the canvas.
    // Both creation patterns are supported by `create_relationship`.
    origin_node_id: rel.creation_anchor_node_id || null,
    origin_kind: _originKindForNodeId(rel.creation_anchor_node_id || null),
    scene_id: null,
  }
}

/** Classify an origin node id as 'scene' | 'standalone' for the S3 audit
 *  verdict's `origin_kind` field on `get_relationship` / `get_knowledge`.
 *  - When the id resolves to a SceneNode → 'scene' (the object's origin
 *    lives ON a scene; the AI can request `at=<that_scene>` for the
 *    scene-resolved state without crossing a chain boundary).
 *  - Otherwise → 'standalone' (RelationshipOriginNode /
 *    KnowledgeOriginNode / EntityNode anchor / null / unresolved).
 *  Always returns one of the two literal strings — never null — so the
 *  AI can treat it as a discriminator without unwrap logic. */
function _originKindForNodeId(nodeId) {
  if (!nodeId) return 'standalone'
  const nodes = useProjectStore.getState().nodes || []
  const node = nodes.find((n) => n.id === nodeId)
  if (node?.type === 'sceneNode') return 'scene'
  return 'standalone'
}

/** Derive a Knowledge's origin node id. Knowledge can be born:
 *   - From a tracked chain event on another object: `source_event.node_id`
 *     (the "Track awareness of this change" flow); takes priority since
 *     it pins the knowledge to a specific other-object change.
 *   - Scene-born via `create_knowledge(scene=...)` or the equivalent UI:
 *     the earliest `history.existence_changes[]` activate event records
 *     the birth scene. Per the model docstring, this is the Knowledge's
 *     scene-born creation point.
 *   - Standalone with a canvas presence: a `KnowledgeOriginNode` exists
 *     with `data.knowledge_id === k.id` (pre-story baseline, no scene).
 *   - Fully standalone with no canvas node: returns null.
 *  Used by the unified `get_knowledge` handler so the MCP client knows
 *  where the origin physically lives, regardless of which creation path. */
function _knowledgeOriginNodeId(k) {
  if (!k) return null
  if (k.source_event?.node_id) return k.source_event.node_id
  // Scene-born path: walk existence_changes for the earliest activate
  // event's node_id. Story-order isn't available here; the create flow
  // appends in chain order, but use the array's first activate as a
  // pragmatic stand-in (typical scene-born knowledges have a single
  // activate event anyway). If a future deactivate/reactivate pattern
  // ships, this can grow to consult computeStoryOrder.
  const activates = (k.history?.existence_changes || []).filter((c) => c?.action === 'activate' && c?.node_id)
  if (activates.length > 0) return activates[0].node_id
  const nodes = useProjectStore.getState().nodes || []
  const originNode = nodes.find(
    (n) => n.type === 'knowledgeOriginNode' && n.data?.knowledge_id === k.id
  )
  return originNode?.id || null
}

/** Option F — apply the polymorphic `track_as_knowledge` arg AFTER a
 *  change-making tool has landed its chain event.
 *
 *  `trackArg` shapes:
 *    - undefined / null → no-op, returns null
 *    - string → resolves to an existing Knowledge by UUID / exact name;
 *      appends a `source_event_changes` rebind entry at the trigger
 *      scene so the Knowledge from this scene forward represents the
 *      just-made change. Returns the existing Knowledge's id.
 *    - object `{ name, description?, colour?, awareness_scale? }` →
 *      creates a NEW Knowledge with `source_event` set to the passed
 *      SourceEventRef. Returns the new Knowledge's id. `name` is
 *      required and must be non-empty; other fields default per
 *      `create_knowledge` (description='', colour='#888888',
 *      awareness_scale='full'). The Knowledge's `creation_anchor_node_id`
 *      is set to the trigger scene so the chip renders there.
 *
 *  `sourceEventRef` is the caller's already-built SourceEventRef dict
 *  pointing at the change just recorded. Required when `trackArg` is
 *  set; the helper validates shape and surfaces a clean error if
 *  required fields are missing.
 *
 *  Returns the resulting Knowledge id (`tracking_knowledge_id`) so the
 *  caller can include it in the tool's return shape. */
async function _applyKnowledgeTracking(trackArg, sourceEventRef) {
  if (trackArg === undefined || trackArg === null) return null
  if (!sourceEventRef || typeof sourceEventRef !== 'object') {
    throw new Error('internal: track_as_knowledge invoked without a sourceEventRef')
  }
  if (!sourceEventRef.node_id) {
    throw new Error('internal: sourceEventRef is missing node_id (cannot anchor the rebind / new Knowledge)')
  }
  const triggerNodeId = sourceEventRef.node_id

  // Path B — rebind existing Knowledge.
  if (typeof trackArg === 'string') {
    const k = _resolveKnowledge(trackArg)  // throws on missing per D1
    useProjectStore.getState().attachKnowledgeSourceEvent(k.id, sourceEventRef, triggerNodeId)
    return k.id
  }

  // Path A — create new Knowledge bound to this change. Mirror the UI
  // "+ New Knowledge from this change" flow (KnowledgeModal.jsx) which
  // uses `createKnowledgeAtScene(payload, triggerNodeId)` — seeds an
  // `existence_changes: activate@<triggerNodeId>` event so the Knowledge
  // is anchored to the trigger scene. The plain `createKnowledge` path
  // would leave the Knowledge anchorless on the canvas (no
  // existence_changes, no KnowledgeOriginNode), which fires the
  // "no creation anchor" + "dangling source_event" alerts even though
  // the source_event back-pointer is set. This is the same bug shape as
  // the "Alice's new vendetta" repro on v0.2.1.118 smoke test.
  if (typeof trackArg === 'object' && !Array.isArray(trackArg)) {
    const name = (trackArg.name || '').trim()
    if (!name) {
      throw new Error(
        `track_as_knowledge.name is required when creating a new Knowledge ` +
        `(pass a string instead to tie an existing Knowledge to this change).`
      )
    }
    _validateHexColour(trackArg.colour, 'track_as_knowledge.colour')
    const knowledgeData = {
      name,
      description: trackArg.description || '',
      colour: trackArg.colour || '#888888',
      awareness_scale: trackArg.awareness_scale || 'full',
      source_event: sourceEventRef,
    }
    const result = await useProjectStore.getState().createKnowledgeAtScene(knowledgeData, triggerNodeId)
    return result.id
  }

  throw new Error(
    `track_as_knowledge must be a string (existing Knowledge UUID / name) or ` +
    `an object { name, description?, colour?, awareness_scale? } to create a new Knowledge.`
  )
}

/** Project an Entity at its origin baseline. Use for get_entity and as
 *  the structure for get_entity_at_scene (the latter swaps the
 *  scene-resolved state in). */
/** Split a flat attribute array into three grouped buckets keyed by
 *  attribute_type — circumstances and motivators surface in their
 *  own response keys instead of being mixed into one big `attributes`
 *  array that the client then has to filter by `.type`. Returns
 *  `{ attributes, circumstances, motivators }` where each bucket is
 *  the projected (canonical-shape) list. Surfaced 2026-05-17b in the
 *  blind-agent rom-com test (final-scene `get_entity` returned 26
 *  entries in one bucket, mixed types).
 *
 *  Empty buckets are returned as empty arrays (not omitted) so the
 *  client always sees the three keys and knows the type didn't just
 *  go missing. */
function _projectAndGroupAttributes(rawAttributes) {
  const attributes = []
  const circumstances = []
  const motivators = []
  for (const raw of (rawAttributes || [])) {
    const projected = _projectAttribute(raw)
    if (!projected) continue
    const t = raw?.attribute_type
    if (t === 'circumstance') circumstances.push(projected)
    else if (t === 'motivator') motivators.push(projected)
    else attributes.push(projected)
  }
  return { attributes, circumstances, motivators }
}

function _projectEntity(entity, type) {
  if (!entity) return null
  const grouped = _projectAndGroupAttributes(entity.attributes)
  const out = {
    id: entity.id,
    type,
    // Canvas origin-node id (distinct from the entity library id above) so
    // MCP callers can target it with add_to_group. Null if not on the canvas.
    origin_node_id: _entityOriginNode(entity.id)?.id || null,
    name: entity.name || '',
    colour: entity.colour || null,
    description: entity.description || '',
    profile_image_ref: entity.profile_image_ref || null,
    notes: entity.notes || '',
    awareness_scale: entity.awareness_scale || 'binary',
    aliases: (entity.aliases || []).map((a) => (typeof a === 'string' ? a : a?.value)).filter(Boolean),
    attributes: grouped.attributes,
    circumstances: grouped.circumstances,
    motivators: grouped.motivators,
  }
  // Type-specific extras.
  if (type === 'location' && entity.parent_id) out.parent_id = entity.parent_id
  if (type === 'custom' && entity.category_id) out.category_id = entity.category_id
  return out
}


/** Introspect HOW the chain-walker reached the resolved state at a
 *  given scene anchor — surfaces the "silent baseline fallback"
 *  case the blind-agent edit test 2026-05-18 reported. Returns
 *  `{ reached_via, walked_through_count, chain_entries_applied,
 *  field_changes_applied, from_origin_baseline,
 *  chain_entries_not_on_path }` where:
 *
 *  - `reached_via`: 'chain' (anchor IS in the entity's chain, walk
 *    crossed it normally), 'orphan' (anchor scene exists but is NOT
 *    in the entity's chain — orphan code path applies only that
 *    ref's own changes to baseline), or 'no_anchor' (origin-path
 *    read with no scene anchor).
 *  - `walked_through_count`: number of chain stops between origin
 *    and the anchor that the walk crossed (exclusive on both ends).
 *  - `chain_entries_applied`: number of chain STOPS (EntityRef
 *    records, one per scene) in that walk that carried any ref
 *    change for this entity. Counts the chain stop ONCE regardless
 *    of how many distinct fields shifted at that stop — a multi-
 *    field `update_entity(at=..., name=..., colour=..., desc=...)`
 *    lands as ONE EntityRef carrying three field changes, so this
 *    counter increments by 1.
 *  - `field_changes_applied`: total number of distinct FIELD
 *    changes summed across the chain stops counted by
 *    `chain_entries_applied`. The same multi-field update above
 *    contributes 3 here (name + colour + description). List-shaped
 *    change buckets (alias_changes, attribute_changes,
 *    awareness_changes) contribute their length.
 *  - `from_origin_baseline`: true when the resolved state is
 *    identical to the entity's baseline because NO chain entries
 *    were applied — the silent-fallback case. Signals to the AI
 *    client that the resolved state might not reflect changes
 *    recorded elsewhere in the chain.
 *  - `chain_entries_not_on_path`: number of OTHER scenes in the
 *    project where this entity has ref changes recorded but the
 *    walk's wire path to the anchor did NOT reach them. Non-zero
 *    on this field is the smoking gun for the broken-wire case (a
 *    chip wired direct from origin skips intermediate chain entries
 *    the writer actually authored). It means "these exist but
 *    aren't on this entity's wire path to the scene you asked
 *    about" — NOT "the resolver actively chose to skip them." The
 *    list of affected scene ids is on `chain_entries_not_on_path_scenes`.
 *
 *  Origin-path callers (`at` omitted / null / 'origin') get a
 *  no-introspection `null` return — the response shape for origin
 *  reads doesn't carry chain_resolution at all. */
function _computeChainResolutionMeta(entity, nodes, edges, anchorSceneId) {
  if (!anchorSceneId) return null
  const chain = getEntityNarrativeChain(entity.id, nodes, edges)
  const inChain = chain.some((n) => n.id === anchorSceneId)
  let reachedVia = inChain ? 'chain' : 'orphan'
  // Determine how many ref-bearing nodes the walker actually crossed
  // between the chain origin and the anchor (chain path) OR whether
  // the orphan-path applied changes from the anchor's own ref (which
  // `computeEffectiveStateFromRef` does even when the chain walk
  // can't reach it).
  let walkedThroughCount = 0
  let chainEntriesApplied = 0
  let fieldChangesApplied = 0
  if (inChain) {
    for (const n of chain) {
      if (n.id === anchorSceneId) break
      walkedThroughCount += 1
      // Count any ref change on this entity at this node — same shape
      // checks `extractChangeSet` does, abbreviated to "has any
      // recorded change" rather than projecting the change set.
      const ref = _findRefForEntityOnNode(n, entity.id)
      if (ref && _refHasRecordedChange(ref)) {
        chainEntriesApplied += 1
        fieldChangesApplied += _countRefFieldChanges(ref)
      }
    }
    // Also count the anchor itself if it carries changes — surfaces
    // "the anchor IS where the change happens" cases.
    const anchorNode = chain.find((n) => n.id === anchorSceneId)
    if (anchorNode) {
      const ref = _findRefForEntityOnNode(anchorNode, entity.id)
      if (ref && _refHasRecordedChange(ref)) {
        chainEntriesApplied += 1
        fieldChangesApplied += _countRefFieldChanges(ref)
      }
    }
  } else {
    // Orphan-path resolution: `computeEffectiveState` now ALSO walks
    // backward from the anchor along incoming entity-continuity wires
    // to reconstruct any sub-chain leading INTO the anchor and apply
    // its changes (v0.2.1.168 walker fix). Mirror that backward walk
    // here so the metadata counts every sub-chain ref-change applied,
    // not just the anchor's own. Without this mirror, an orphan
    // anchor that inherits changes from an upstream sub-chain node
    // would report `chain_entries_applied: 0` even though the
    // resolved state correctly carries those changes.
    //
    // `reached_via` distinguishes three orphan-side cases now:
    //   - 'orphan' — anchor has no incoming continuity wire (true
    //     standalone orphan; only its own ref counts).
    //   - 'sub_chain' — anchor has incoming wires forming a sub-chain
    //     that the backward walk traversed. May or may not reach back
    //     to the entity's origin EntityNode; either way the sub-chain
    //     changes are applied.
    const subChain = []  // origin-most → anchor (same order
                          // computeEffectiveState builds)
    const subVisited = new Set()
    let cursorId = anchorSceneId
    while (cursorId && !subVisited.has(cursorId)) {
      subVisited.add(cursorId)
      const cur = nodes.find((n) => n.id === cursorId)
      if (!cur) break
      subChain.unshift(cur)
      const inEdge = edges.find((e) =>
        e.target === cursorId
        && e.data?.source_entity_id === entity.id
        && !e.data?.is_pov_path
        && !e.data?.is_relationship
      )
      if (!inEdge) break
      const srcNode = nodes.find((n) => n.id === inEdge.source)
      if (!srcNode) break
      if (srcNode.type === 'entityNode') break  // reached origin
      cursorId = inEdge.source
    }
    // Count ref-bearing nodes in the sub-chain. walked_through_count
    // is sub-chain length excluding the anchor itself (mirrors the
    // chain-path semantic: how many stops did the walker cross
    // BEFORE reaching the anchor).
    for (let i = 0; i < subChain.length; i++) {
      const subNode = subChain[i]
      if (subNode.id !== anchorSceneId) walkedThroughCount += 1
      const ref = _findRefForEntityOnNode(subNode, entity.id)
      if (ref && _refHasRecordedChange(ref)) {
        chainEntriesApplied += 1
        fieldChangesApplied += _countRefFieldChanges(ref)
      }
    }
    // Reclassify reached_via: if the backward walk found wires
    // leading into the anchor (sub-chain length > 1), it's a sub-
    // chain orphan; otherwise a true standalone orphan.
    if (subChain.length > 1) reachedVia = 'sub_chain'
  }
  // Detect "bypassed chain entries": scenes anywhere in the project
  // where this entity has ref changes recorded, but the walk above
  // didn't include them. The reachable set is the main chain (when
  // anchor is in chain) OR the sub-chain (when orphan/sub-chain).
  // Sub-chain nodes were collected above; for the inChain branch we
  // rebuild here from the chain array.
  let reachableIds
  if (inChain) {
    reachableIds = new Set(
      chain.map((n) => n.id).slice(0, chain.findIndex((n) => n.id === anchorSceneId) + 1),
    )
  } else {
    // Re-do the backward walk to collect ids (it would be cleaner
    // to hoist the result from the else branch above, but the
    // chainEntriesApplied counting loop above already populated
    // subVisited — reuse it).
    reachableIds = new Set([anchorSceneId])
    let cur2Id = anchorSceneId
    const visited2 = new Set()
    while (cur2Id && !visited2.has(cur2Id)) {
      visited2.add(cur2Id)
      reachableIds.add(cur2Id)
      const inE = edges.find((e) =>
        e.target === cur2Id
        && e.data?.source_entity_id === entity.id
        && !e.data?.is_pov_path
        && !e.data?.is_relationship
      )
      if (!inE) break
      const src = nodes.find((n) => n.id === inE.source)
      if (!src || src.type === 'entityNode') break
      cur2Id = inE.source
    }
  }
  const bypassed = []
  for (const n of nodes) {
    if (n.type !== 'sceneNode') continue
    if (reachableIds.has(n.id)) continue
    const ref = _findRefForEntityOnNode(n, entity.id)
    if (ref && _refHasRecordedChange(ref)) bypassed.push(n.id)
  }
  return {
    reached_via: reachedVia,
    walked_through_count: walkedThroughCount,
    chain_entries_applied: chainEntriesApplied,
    field_changes_applied: fieldChangesApplied,
    from_origin_baseline: chainEntriesApplied === 0,
    chain_entries_not_on_path: bypassed.length,
    ...(bypassed.length > 0 ? { chain_entries_not_on_path_scenes: bypassed } : {}),
  }
}


/** Find the EntityRef for `entityId` on the given sceneNode (across
 *  every bucket). Returns null when the entity isn't chipped here. */
function _findRefForEntityOnNode(node, entityId) {
  if (!node || node.type !== 'sceneNode') return null
  for (const bucket of ENTITY_BUCKETS) {
    const refs = node.data?.[bucket] || []
    const match = refs.find((r) => r?.entity_id === entityId)
    if (match) return match
  }
  return null
}


/** True iff the EntityRef carries any scene-anchored change (scalar
 *  field change, alias event, attribute change, or awareness
 *  change). Excludes presence-only refs whose only role is "this
 *  entity is in this scene."
 *
 *  Note: the canonical alias-event field is `alias_changes` (plural
 *  events, post-v0.2.1.76 refactor), NOT `aliases_change` (the
 *  pre-refactor full-list replacement). `extractChangeSet` in
 *  `narrativeChain.js` reads `alias_changes`; this helper must use
 *  the same name. Surfaced 2026-05-18 in self-test follow-up: an
 *  orphan scene with a real chain-anchored alias-add event was
 *  reporting `from_origin_baseline: true` because the check looked
 *  for the wrong field name. */
function _refHasRecordedChange(ref) {
  if (!ref) return false
  if (ref.name_change != null) return true
  if (ref.colour_change != null) return true
  if (ref.description_change != null) return true
  if (ref.profile_image_change != null) return true
  if (Array.isArray(ref.alias_changes) && ref.alias_changes.length > 0) return true
  if (Array.isArray(ref.attribute_changes) && ref.attribute_changes.length > 0) return true
  if (Array.isArray(ref.awareness_changes) && ref.awareness_changes.length > 0) return true
  return false
}

/** Count the number of distinct field changes recorded on a single
 *  EntityRef. A multi-field `update_entity(at=..., name=..., colour=...,
 *  description=...)` lands one EntityRef carrying three scalar field
 *  changes — `_refHasRecordedChange` returns true (one ref-bearing
 *  chain stop), but the AI client also wants to know how many distinct
 *  fields shifted at that stop. Scalar fields count 1 each; list-shaped
 *  change buckets (`alias_changes`, `attribute_changes`,
 *  `awareness_changes`) count their length. */
function _countRefFieldChanges(ref) {
  if (!ref) return 0
  let n = 0
  if (ref.name_change != null) n += 1
  if (ref.colour_change != null) n += 1
  if (ref.description_change != null) n += 1
  if (ref.profile_image_change != null) n += 1
  if (Array.isArray(ref.alias_changes)) n += ref.alias_changes.length
  if (Array.isArray(ref.attribute_changes)) n += ref.attribute_changes.length
  if (Array.isArray(ref.awareness_changes)) n += ref.awareness_changes.length
  return n
}

// ── Wave 1: get_project_summary ─────────────────────────────────────────
// Fast, no-arg read of the live in-memory project. Returns counts +
// title — the smallest useful payload for an MCP client wanting to
// orient itself before reaching for more detailed tools.

registerMcpTool('get_project_summary', () => {
  const projectStore = useProjectStore.getState()
  const entitiesStore = useEntitiesStore.getState()
  const story = projectStore.story
  const nodes = projectStore.nodes || []
  const counts = {
    characters:    entitiesStore.characters.length,
    locations:     entitiesStore.locations.length,
    items:         entitiesStore.items.length,
    factions:      entitiesStore.factions.length,
    customs:       entitiesStore.customs.length,
    knowledges:    (projectStore.knowledges || []).length,
    relationships: (projectStore.relationships || []).length,
    scenes:        nodes.filter((n) => n.type === 'sceneNode').length,
  }
  // `is_empty` is true when every count is zero. Pure factual signal
  // surfaced so MCP clients can branch on "fresh project" vs "loaded
  // project" without having to compare every count to 0 themselves.
  // Deliberately does NOT carry a workflow hint — empty doesn't imply
  // a "right" first step (entity import, manual create_entity, template
  // import, chapter setup before scenes, etc. are all legitimate
  // starting points depending on the writer's goal).
  const is_empty = Object.values(counts).every((n) => n === 0)
  return {
    title: story?.title || 'Untitled',
    // Story description is always present in the return — empty
    // string when the writer hasn't filled it in. Convention is
    // "field always present with sensible empty value" so AI
    // clients don't have to handle two distinct code paths
    // ("key missing" vs "key present but empty"). Added v0.3.11.5.
    description: story?.description || '',
    is_empty,
    counts,
  }
})

// ── update_story (story-level settings write) ───────────────────────────────
// Story-level settings write tool. Covers the writer-settable Story fields
// the Settings panel edits (excluding autosave + awareness-rollover, which
// stay UI-only). Story settings are singleton fields (no chain), so this
// routes through the canonical `updateStorySettings(patch)` store action —
// the same path the Settings panel's Story tab uses (same snapshot, dirty
// flag, undo entry). Nullable text fields clear on empty string, matching
// the panel's `.trim() || null`; `pov_character_id` accepts a name or id and
// resolves to the entity id.
registerMcpTool('update_story', async (args) => {
  const a = args || {}
  const patch = {}

  // Nullable free-text fields: empty string -> null (clear), mirroring the
  // Settings panel. pov_type_default / tense are select-style but stored as
  // free strings, so the same treatment applies (no case-folding — values
  // like "1st Person" are Title-Cased).
  const CLEARABLE_TEXT = [
    'description', 'author', 'genre', 'tense', 'language', 'pov_type_default',
    'series', 'accent_color', 'pov_color', 'chapter_label', 'act_label',
  ]
  for (const k of CLEARABLE_TEXT) {
    if (typeof a[k] === 'string') {
      const trimmed = a[k].trim()
      patch[k] = trimmed === '' ? null : trimmed
    }
  }

  // Title never clears to null — empty falls back to 'Untitled Story'.
  if (typeof a.title === 'string') patch.title = a.title.trim() || 'Untitled Story'

  // pov_character_id: accept a name OR id; resolve to the entity id. Empty /
  // null clears the story default POV.
  if ('pov_character_id' in a) {
    const ref = a.pov_character_id
    if (ref == null || (typeof ref === 'string' && ref.trim() === '')) {
      patch.pov_character_id = null
    } else {
      patch.pov_character_id = _resolveEntity(ref, 'character').entity.id
    }
  }

  // series_number is meaningless without a series; blank / unparseable -> null.
  if ('series_number' in a) {
    const n = typeof a.series_number === 'number' ? a.series_number : parseFloat(a.series_number)
    patch.series_number = Number.isFinite(n) ? n : null
  }

  if (Array.isArray(a.tags)) patch.tags = a.tags.filter((t) => typeof t === 'string')

  for (const k of ['chapter_tint_behind_nodes', 'time_tracking_enabled', 'allow_negative_time']) {
    if (typeof a[k] === 'boolean') patch[k] = a[k]
  }
  if (typeof a.time_format === 'string') patch.time_format = a.time_format
  if (typeof a.week_start === 'string') patch.week_start = a.week_start

  if (Object.keys(patch).length === 0) {
    throw new Error('update_story: pass at least one settable field (e.g. title, description, author, genre, tense, pov_character_id, series, tags, time settings).')
  }
  useProjectStore.getState().updateStorySettings(patch)

  const story = useProjectStore.getState().story
  return {
    title:                     story?.title || 'Untitled',
    description:               story?.description || '',
    author:                    story?.author || null,
    genre:                     story?.genre || null,
    tense:                     story?.tense || null,
    language:                  story?.language || null,
    pov_type_default:          story?.pov_type_default || null,
    pov_character_id:          story?.pov_character_id || null,
    series:                    story?.series || null,
    series_number:             story?.series_number ?? null,
    tags:                      Array.isArray(story?.tags) ? story.tags : [],
    accent_color:              story?.accent_color || null,
    pov_color:                 story?.pov_color || null,
    chapter_label:             story?.chapter_label || null,
    act_label:                 story?.act_label || null,
    chapter_tint_behind_nodes: story?.chapter_tint_behind_nodes ?? null,
    time_tracking_enabled:     story?.time_tracking_enabled ?? null,
    allow_negative_time:       story?.allow_negative_time ?? null,
    time_format:               story?.time_format || null,
    week_start:                story?.week_start || null,
  }
})

// ── Wave 1: get_story (story-level full read) ──────────────────────
// Companion to update_story: returns every story-level Pydantic
// field the writer sets via the Story Settings panel. Singleton
// shape — no `at` arg, no ref-by-uuid-or-name, because there is
// exactly one Story per project. Use when the AI wants to know
// "what's the story actually about / how is it set up" without
// pulling counts + seeds the way get_project_summary does.

registerMcpTool('get_story', () => {
  const story = useProjectStore.getState().story
  return {
    title:               story?.title || 'Untitled',
    description:         story?.description || '',
    author:              story?.author || null,
    tense:               story?.tense || null,
    language:            story?.language || null,
    pov_type_default:    story?.pov_type_default || null,
    pov_character_id:    story?.pov_character_id || null,
    genre:               story?.genre || null,
    tags:                Array.isArray(story?.tags) ? story.tags : [],
    accent_color:        story?.accent_color || null,
  }
})

// ── Wave 1: get_story_description (focused single-field read) ──────
// Convention exception (the first single-field reader on the
// surface). Justified by AI-prompting ergonomics — clients that
// only need the story blurb avoid the cognitive overhead of
// filtering it out of get_story / get_project_summary. The cost is
// real (sets a precedent that every Story-level field could plausibly
// claim the same shortcut) so we're treating this as a narrow
// exception, not a new pattern.

registerMcpTool('get_story_description', () => {
  const story = useProjectStore.getState().story
  return { description: story?.description || '' }
})

// ── Wave 1: list_entities ───────────────────────────────────────────────
// Lightweight listing — id, name, colour per entity, grouped by type.
// Intentionally omits descriptions, attributes, and aliases so the
// payload stays small for "what's in this project?" orientation reads.
// MCP client follows up with get_entity / get_entity_at_scene for
// details on a specific entity.

registerMcpTool('list_entities', (args) => {
  const typeFilter = args?.type || null
  if (typeFilter && !_ENTITY_TYPES.includes(typeFilter)) {
    throw new Error(`unknown entity type: ${typeFilter}. Valid: ${_ENTITY_TYPES.join(', ')}`)
  }
  // Index each entity's canvas ORIGIN node id once (entity id → node id) so the
  // per-entity lookup is O(1). Origin = the non-modifier entityNode.
  const originByEntity = new Map()
  for (const n of (useProjectStore.getState().nodes || [])) {
    if (n.type === 'entityNode' && !n.data?.is_modifier && n.data?.entity_id
        && !originByEntity.has(n.data.entity_id)) {
      originByEntity.set(n.data.entity_id, n.id)
    }
  }
  const types = typeFilter ? [typeFilter] : _ENTITY_TYPES
  const out = {}
  for (const type of types) {
    out[`${type}s`] = _bucketFor(type).map((e) => ({
      id: e.id,
      name: e.name || '',
      colour: e.colour || null,
      origin_node_id: originByEntity.get(e.id) || null,
    }))
  }
  return out
})

// ── Wave 1: get_entity (unified origin / scene reads) ──────────────────
// One tool, two paths controlled by the `at` arg per the unified
// MCP tool shape (see docs/mcp-tool-shape.md):
//   - omitted / null / 'origin' → ORIGIN-baseline projection.
//   - scene UUID or exact title → scene-resolved projection (walks
//     the entity's chain from origin through every modifier up to the
//     named scene, applying name / description / colour / profile_image
//     / alias / attribute changes along the way).
// Both paths accept UUID or exact (case-insensitive) name/alias for
// the `entity` arg. Both return the same field shape with `scene_id`
// (null on the origin path, the scene id on the scene path) and
// `scene_title` on the scene path so the AI knows what was resolved.

registerMcpTool('get_entity', (args) => {
  const { entity, type } = _resolveEntity(args?.entity)
  const at = args?.at
  const isOriginPath = !at || at === 'origin'

  if (isOriginPath) {
    return {
      ..._projectEntity(entity, type),
      scene_id: null,
      // Always present so clients can rely on the field existing
      // (docstring contract). Null on origin path because there's
      // no chain walk to introspect — the origin IS the baseline.
      chain_resolution: null,
    }
  }

  const sceneNode = _resolveScene(at)
  const projectStore = useProjectStore.getState()
  const nodes = projectStore.nodes || []
  const edges = projectStore.edges || []
  const storyOrder = computeStoryOrder({ nodes, edges })
  const effective = computeEffectiveState(entity, nodes, edges, sceneNode.id, { storyOrder })

  const grouped = _projectAndGroupAttributes(effective.attributes)
  const chainResolution = _computeChainResolutionMeta(entity, nodes, edges, sceneNode.id)
  return {
    id: entity.id,
    type,
    origin_node_id: _entityOriginNode(entity.id)?.id || null,
    scene_id: sceneNode.id,
    scene_title: sceneNode.data?.title || '',
    name: effective.name || '',
    colour: effective.colour || null,
    description: effective.description || '',
    profile_image_ref: effective.profile_image_ref || null,
    notes: entity.notes || '',  // notes is not scene-tracked
    aliases: (effective.aliases || []).map((a) => (typeof a === 'string' ? a : a?.value)).filter(Boolean),
    attributes: grouped.attributes,
    circumstances: grouped.circumstances,
    motivators: grouped.motivators,
    chain_resolution: chainResolution,
    ...(type === 'location' && entity.parent_id ? { parent_id: entity.parent_id } : {}),
    ...(type === 'custom' && entity.category_id ? { category_id: entity.category_id } : {}),
  }
})

// ── Wave 3: get_entity_chain_history ─────────────────────────────────
// Read tool that surfaces every scene-anchored change recorded on an
// entity, in story order, so an AI client can sanity-check its writes
// ("did I forget to record the change I meant to?") without walking
// `get_entity(at=<each scene>)` N times. Surfaced 2026-05-17b in the
// blind-agent rom-com test. Includes a `first_appeared_at` tag per
// circumstance / motivator surfaced in the history's added events,
// addressing the agent's separate "no way to tell when each motivator
// entered the chain" complaint.

registerMcpTool('get_entity_chain_history', (args) => {
  const { entity, type } = _resolveEntity(args?.entity)
  const projectStore = useProjectStore.getState()
  const nodes = projectStore.nodes || []
  const edges = projectStore.edges || []
  const storyOrder = computeStoryOrder({ nodes, edges })
  const orderedIds = storyOrder?.orderedIds || []
  const povChain = computePovChain(nodes, edges)
  const povIndexById = new Map(povChain.sequence.map((e) => [e.nodeId, e.index]))

  // Optional `scenes` filter — restricts the `history[]` output to
  // changes that landed at one of the named scenes. Pass scene UUIDs
  // or titles. Lifecycle aggregation still runs over the full chain
  // (it has to, to compute correct add_at / last_modified_at status
  // even when the caller is filtering the visible history view).
  // Surfaced 2026-05-18: agent wants to spot-check "what changed
  // about this entity at these three story beats" without paging
  // through the whole chain history.
  let sceneFilterIds = null
  if (Array.isArray(args?.scenes) && args.scenes.length > 0) {
    sceneFilterIds = new Set()
    for (let i = 0; i < args.scenes.length; i++) {
      const ref = args.scenes[i]
      if (typeof ref !== 'string' || !ref) {
        throw new Error(`scenes[${i}] must be a non-empty string (UUID or exact scene title).`)
      }
      try {
        const sn = _resolveScene(ref)
        sceneFilterIds.add(sn.id)
      } catch (err) {
        throw new Error(`scenes[${i}]: ${err.message}`)
      }
    }
  }

  // Bucket selector — entity type plural to map into scene.data[bucket].
  const bucket = `${type}s`

  // Lifecycle aggregation map — keyed by attribute_id, accumulates the
  // add / modify / remove events for circumstance + motivator
  // attributes as we walk the chain. Built in the same pass as the
  // change-by-change history so we don't double-iterate the data.
  // After the walk, split by attribute_type into
  // `circumstance_lifecycle` and `motivator_lifecycle` on the
  // response — direct answer to the editor's "anything stale?"
  // question without re-deriving from the flat change list.
  // Surfaced 2026-05-18 in the blind-agent edit test.
  const lifecycle = new Map() // attribute_id → { name, attribute_type, added_at, last_modified_at, removed_at, last_intensity, status }

  // Seed the lifecycle map with origin-baseline CM attributes — these
  // start at origin with no chain `add` event. `added_at` is null for
  // these (the entity's own origin is the implicit add point).
  for (const attr of (entity.attributes || [])) {
    if (attr.attribute_type !== 'circumstance' && attr.attribute_type !== 'motivator') continue
    lifecycle.set(attr.id, {
      name: attr.name || null,
      attribute_type: attr.attribute_type,
      attribute_id: attr.id,
      added_at: { origin: true, scene_id: null, scene_title: null, pov_index: null },
      last_modified_at: null,
      removed_at: null,
      last_intensity: attr.intensity != null ? _intensityName(attr.intensity) : null,
      status: 'active',
    })
  }

  // Walk scenes in story order, surface any change recorded on this
  // entity at each scene. A scene with a chip but NO recorded changes
  // (entity is just present, nothing happened to them) is skipped —
  // the history is about the changes themselves, not about presence.
  // Presence is what `get_entity(at=<scene>)` is for.
  const history = []
  for (const sceneId of orderedIds) {
    const node = nodes.find((n) => n.id === sceneId)
    if (!node || node.type !== 'sceneNode') continue
    const refs = node.data?.[bucket] || []
    const ref = refs.find((r) => r.entity_id === entity.id)
    if (!ref) continue

    const changes = []

    // Scalar field changes — name / colour / description / profile
    // image. Each is a single field on the EntityRef carrying the
    // post-change value; null/undefined means no change at this scene.
    if (ref.name_change != null) {
      changes.push({ kind: 'name', field: 'name', new_value: ref.name_change })
    }
    if (ref.colour_change != null) {
      changes.push({ kind: 'colour', field: 'colour', new_value: ref.colour_change })
    }
    if (ref.description_change != null) {
      changes.push({ kind: 'description', field: 'description', new_value: ref.description_change })
    }
    if (ref.profile_image_change != null) {
      changes.push({
        kind: 'profile_image',
        field: 'profile_image_ref',
        new_value: ref.profile_image_change === '' ? null : ref.profile_image_change,
      })
    }

    // Alias events — `alias_changes` is a per-event list (add /
    // modify / remove / awareness_*). Project each into a uniform
    // `{kind: 'alias', action, ...}` entry so the AI sees scene-
    // anchored alias mutations one at a time. Field is
    // `alias_changes` (post-v0.2.1.76 events refactor), NOT the
    // legacy `aliases_change` (full-list replacement).
    for (const ev of (ref.alias_changes || [])) {
      if (!ev || typeof ev !== 'object') continue
      const projected = { kind: 'alias', action: ev.action || null }
      if (ev.alias_id) projected.alias_id = ev.alias_id
      if (ev.action === 'add' && ev.alias) {
        projected.value = ev.alias.value || null
      } else if (ev.action === 'modify' && ev.new_value !== undefined) {
        projected.new_value = ev.new_value
      } else if (ev.action === 'remove') {
        // Remove events carry only alias_id (resolution against the
        // entity's baseline aliases is the reader's responsibility).
      } else if (ev.action === 'awareness_set' || ev.action === 'awareness_source_add'
        || ev.action === 'awareness_source_remove' || ev.action === 'awareness_source_set_level') {
        projected.kind = 'alias_awareness'
        if (ev.observer_id !== undefined) projected.observer_id = ev.observer_id
        if (ev.level !== undefined) projected.level = ev.level
      }
      changes.push(projected)
    }

    // Attribute changes — add / modify / remove / list_add /
    // list_remove / rename + per-attribute awareness events. Project
    // each into a uniform shape so the AI doesn't have to know the
    // model's per-action field-name variations.
    const sceneCtx = {
      scene_id: node.id,
      scene_title: node.data?.title || '',
      pov_index: povIndexById.get(node.id) ?? null,
    }
    for (const ac of (ref.attribute_changes || [])) {
      const action = ac.action
      // `attribute_id` is at top level for modify / rename / remove /
      // list_* / awareness_* actions, but for `add` it's nested on
      // `ac.attribute.id` (the new attribute's id) and top-level
      // `ac.attribute_id` is null. Fall back to the nested id so the
      // projected entry always carries the right id regardless of
      // action kind.
      const projected = {
        kind: 'attribute',
        action,
        attribute_id: ac.attribute_id || ac.attribute?.id || null,
      }
      // For `add`, project the attribute payload so the response
      // shows what was added (with attribute_type so the AI can tell
      // whether a circumstance / motivator was introduced here).
      if (action === 'add' && ac.attribute) {
        const proj = _projectAttribute(ac.attribute)
        if (proj) {
          projected.attribute = proj
          projected.attribute_type = ac.attribute.attribute_type
          projected.name = ac.attribute.name
        }
        // Lifecycle accumulator: seed an entry for chain-added CMs
        // at the scene of their add event. If a prior entry exists
        // (e.g. the CM was added, removed, then re-added), record
        // this as a re-add: clear `removed_at`, push this scene as
        // the most recent `added_at`. The status returns to active.
        // Add events carry the new attribute's id NESTED on
        // `ac.attribute.id` (not on top-level `ac.attribute_id`,
        // which is null for adds). Fall back to the nested id so
        // the lifecycle entry's `attribute_id` field is populated.
        // Surfaced 2026-05-18 in self-test follow-up.
        if (ac.attribute && (ac.attribute.attribute_type === 'circumstance' || ac.attribute.attribute_type === 'motivator')) {
          const lifecycleKey = ac.attribute_id || ac.attribute.id || null
          const existing = lifecycleKey ? lifecycle.get(lifecycleKey) : null
          if (existing) {
            existing.added_at = { origin: false, ...sceneCtx }
            existing.removed_at = null
            existing.status = 'active'
            existing.last_intensity = ac.attribute.intensity != null ? _intensityName(ac.attribute.intensity) : null
            if (ac.attribute.name) existing.name = ac.attribute.name
          } else if (lifecycleKey) {
            lifecycle.set(lifecycleKey, {
              name: ac.attribute.name || null,
              attribute_type: ac.attribute.attribute_type,
              attribute_id: lifecycleKey,
              added_at: { origin: false, ...sceneCtx },
              last_modified_at: null,
              removed_at: null,
              last_intensity: ac.attribute.intensity != null ? _intensityName(ac.attribute.intensity) : null,
              status: 'active',
            })
          }
        }
      }
      // For per-field modify events, surface whichever fields changed
      // at this scene.
      if (action === 'modify') {
        if (ac.new_value !== undefined) projected.new_value = ac.new_value
        if (ac.new_number_value !== undefined) projected.new_number_value = ac.new_number_value
        if (ac.file_ref_change !== undefined) projected.new_file_ref = ac.file_ref_change === '' ? null : ac.file_ref_change
        if (ac.new_name !== undefined) projected.new_name = ac.new_name
        if (ac.new_description !== undefined) projected.new_description = ac.new_description
        if (ac.new_intensity !== undefined) {
          projected.new_intensity = ac.new_intensity != null ? _intensityName(ac.new_intensity) : null
        }
        // Lifecycle: mark this scene as the most recent modify for
        // the affected CM. Update last_intensity when this modify
        // touched it (an explicit `null` clears the intensity back
        // to unset).
        const existing = lifecycle.get(ac.attribute_id)
        if (existing) {
          existing.last_modified_at = { ...sceneCtx }
          if (Object.prototype.hasOwnProperty.call(ac, 'new_intensity')) {
            existing.last_intensity = ac.new_intensity != null ? _intensityName(ac.new_intensity) : null
          }
          if (Object.prototype.hasOwnProperty.call(ac, 'new_name') && ac.new_name) {
            existing.name = ac.new_name
          }
        }
      }
      if (action === 'rename' && ac.new_name !== undefined) {
        projected.new_name = ac.new_name
        const existing = lifecycle.get(ac.attribute_id)
        if (existing) {
          existing.last_modified_at = { ...sceneCtx }
          if (ac.new_name) existing.name = ac.new_name
        }
      }
      if (action === 'remove') {
        const existing = lifecycle.get(ac.attribute_id)
        if (existing) {
          existing.removed_at = { ...sceneCtx }
          existing.status = 'removed'
        }
      }
      if (action === 'list_add' || action === 'list_remove') {
        if (ac.value !== undefined) projected.value = ac.value
        if (ac.entity_id_value !== undefined) projected.entity_id_value = ac.entity_id_value
      }
      // Per-attribute awareness mutations ride as their own action
      // kinds inside attribute_changes — surface them so the chain-
      // history view includes "Bob's awareness of attribute X changed
      // at scene N".
      if (action === 'awareness_set' || action === 'awareness_source_add' ||
          action === 'awareness_source_remove' || action === 'awareness_source_set_level') {
        projected.kind = 'attribute_awareness'
        if (ac.observer_id !== undefined) projected.observer_id = ac.observer_id
        if (ac.level !== undefined) projected.level = ac.level
      }
      changes.push(projected)
    }

    // Entity-level / relationship-level / entity-name / alias-name
    // awareness mutations live on a separate `awareness_changes[]`
    // array on the EntityRef.
    for (const aw of (ref.awareness_changes || [])) {
      changes.push({
        kind: 'awareness',
        scope: aw.scope || null,
        action: aw.action || null,
        observer_id: aw.observer_id || null,
        level: aw.level != null ? aw.level : null,
        target_id: aw.target_id || null,
      })
    }

    if (changes.length === 0) continue

    // Scene-filter gate: skip pushing to the visible history list
    // when a `scenes=[...]` filter is set and this scene isn't in
    // it. Lifecycle aggregation above still ran over this scene's
    // changes so the lifecycle summary stays accurate.
    if (sceneFilterIds && !sceneFilterIds.has(node.id)) continue

    history.push({
      scene_id: node.id,
      scene_title: node.data?.title || '',
      pov_index: povIndexById.get(node.id) ?? null,
      changes,
    })
  }

  // Split the lifecycle map by attribute_type and sort each bucket
  // by added-at story order so the writer can scan the staleness
  // status in narrative order. Origin-baseline CMs sort first
  // (added_at.origin: true) followed by chain-added CMs in scene
  // order. Each entry surfaces the lifecycle answer the editor
  // actually wants — "is this still in effect?" — via `status`
  // ('active' | 'removed') plus the supporting timestamps.
  const allLifecycle = Array.from(lifecycle.values())
  const sortLifecycle = (a, b) => {
    const aIdx = a.added_at?.origin ? -1 : (a.added_at?.pov_index ?? Infinity)
    const bIdx = b.added_at?.origin ? -1 : (b.added_at?.pov_index ?? Infinity)
    if (aIdx !== bIdx) return aIdx - bIdx
    return (a.name || '').localeCompare(b.name || '')
  }
  const circumstance_lifecycle = allLifecycle
    .filter((l) => l.attribute_type === 'circumstance')
    .sort(sortLifecycle)
  const motivator_lifecycle = allLifecycle
    .filter((l) => l.attribute_type === 'motivator')
    .sort(sortLifecycle)

  return {
    entity_id: entity.id,
    entity_type: type,
    origin_name: entity.name || '',
    origin: _projectEntity(entity, type),
    history,
    circumstance_lifecycle,
    motivator_lifecycle,
  }
})

// ── Wave 1: list_scenes ─────────────────────────────────────────────────
// Lightweight listing of every scene in the project, ordered by the POV
// path first (1-based `pov_index`) and then off-POV scenes (`pov_index:
// null`) in a stable order. Includes chapter membership when set.

/** Build the heavier "verbose" projection fields for a scene node —
 *  participants_by_type (with chain-walked names), scene-level
 *  circumstances, time block. Mirrors the corresponding sections of
 *  `get_scene`'s response so verbose-mode `list_scenes` and `get_scene`
 *  stay aligned on shape. Takes pre-computed caches (`nodes`, `edges`,
 *  `storyOrder`) so a batch loop in list_scenes doesn't redo the
 *  expensive POV / story-order walks per scene.
 *
 *  This intentionally does NOT include the scene's `main_content`,
 *  `description`, `id`, `title`, `position`, chapter / POV index
 *  fields — those are already part of every list_scenes entry. Only
 *  the additive verbose extras live here. */
function _buildVerboseSceneExtras(sceneNode, { nodes, edges, storyOrder }) {
  const data = sceneNode.data || {}
  const participants_by_type = {}
  // `has_pov` is derived from the scene's `pov_entity_id` field
  // rather than read from `ref.has_pov` — the latter is never set to
  // true anywhere in the project store (only ever initialised false
  // at chip creation), so `ref.has_pov` always reads false even when
  // the scene has a POV character. `pov_entity_id` on the scene is
  // the canonical POV storage. Surfaced 2026-05-18 in the self-test
  // pass: `list_scenes(verbose=true)` showed `has_pov: false` on
  // every participant despite scenes carrying a POV character.
  const scenePovEntityId = data.pov_entity_id || null
  for (const type of _ENTITY_TYPES) {
    const refs = data[`${type}s`] || []
    const out = []
    for (const ref of refs) {
      const entity = _findEntity(ref.entity_id)?.entity
      if (!entity) continue
      const eff = computeEffectiveState(entity, nodes, edges, sceneNode.id, { storyOrder })
      out.push({
        entity_id: ref.entity_id,
        name: eff?.name || entity.name || '',
        colour: eff?.colour || entity.colour || null,
        has_pov: scenePovEntityId === ref.entity_id,
      })
    }
    participants_by_type[`${type}s`] = out
  }
  const circumstances = (data.circumstances || []).map((c) => ({
    id: c.id,
    name: c.name || null,
    description: c.description || '',
    intensity: c.intensity != null ? _intensityName(c.intensity) : null,
  }))
  const time = {}
  if (data.time_of_day_tier === 'labelled' && data.time_of_day_labelled) {
    time.time_of_day = data.time_of_day_labelled
  } else if (data.time_of_day_tier === 'exact' && data.time_of_day_exact) {
    time.time_of_day = data.time_of_day_exact
  } else if (data.time_of_day_tier === 'broad' && data.time_of_day_broad) {
    time.time_of_day = data.time_of_day_broad
  }
  if (data.weekday != null) {
    const name = _weekdayName(data.weekday)
    if (name) time.weekday = name
  }
  if (data.season != null) {
    const name = _seasonName(data.season)
    if (name) time.season = name
  }
  if (data.date_month != null) {
    const monthName = _monthName(data.date_month)
    if (monthName) {
      time.date = {
        month: monthName,
        ...(data.date_day_of_month != null ? { day: data.date_day_of_month } : {}),
      }
    }
  }
  if (data.scene_duration) {
    const sd = data.scene_duration
    const display = formatSceneDuration(sd, 'value') || null
    time.scene_duration = {
      ...sd,
      ...(display ? { display } : {}),
    }
  }
  if (data.gap_extension) {
    const display = formatGapExtension(data.gap_extension, 'value') || null
    time.gap_extension = {
      ...data.gap_extension,
      ...(display ? { display } : {}),
    }
  }
  const derived = _walkerDerivedTimeForScene(sceneNode)
  if (derived) time.derived = derived
  return {
    pov_entity_id: data.pov_entity_id || null,
    is_flashback: !!data.is_flashback,
    participants_by_type,
    circumstances,
    time,
  }
}


registerMcpTool('list_scenes', (args) => {
  const verbose = args?.verbose === true
  const projectStore = useProjectStore.getState()
  const nodes = projectStore.nodes || []
  const edges = projectStore.edges || []
  const story = projectStore.story || {}
  const chapters = story.chapters || []
  const chapterMemberOpts = chapterMemberOptsForStory(story)

  const sceneNodes = nodes.filter((n) => n.type === 'sceneNode')
  const povChain = computePovChain(nodes, edges)
  const indexByNodeId = new Map(povChain.sequence.map((entry) => [entry.nodeId, entry.index]))
  const chapterById = new Map(chapters.map((c) => [c.id, c]))

  // storyOrder cached once and threaded into the verbose helper so
  // we don't recompute it per scene — chain walks are the heaviest
  // cost in the verbose path.
  const storyOrder = verbose ? computeStoryOrder({ nodes, edges }) : null

  const scenes = sceneNodes.map((n) => {
    const chapterId = resolveChapterIdForNode(n, chapters, chapterMemberOpts)
    const chapter = chapterById.get(chapterId)
    const povIndex = indexByNodeId.get(n.id) ?? null
    const base = {
      id: n.id,
      title: n.data?.title || '',
      summary: n.data?.description || '',
      pov_index: povIndex,
      on_pov_path: povIndex != null,
      chapter_id: chapterId || null,
      chapter_title: chapter?.title || null,
    }
    if (!verbose) return base
    return {
      ...base,
      ..._buildVerboseSceneExtras(n, { nodes, edges, storyOrder }),
    }
  })

  // POV-on scenes first in POV order; off-POV after, stable by id for determinism.
  scenes.sort((a, b) => {
    if (a.on_pov_path && b.on_pov_path) return a.pov_index - b.pov_index
    if (a.on_pov_path) return -1
    if (b.on_pov_path) return 1
    return a.id.localeCompare(b.id)
  })

  // Wrap in a single object so the MCP layer renders ONE content
  // block, not one per array element. Empty-list returns also render
  // as one (empty) object rather than "no output." Mirrors the
  // `list_entities` pattern (`{characters: [...], locations: [...]}`).
  return { scenes }
})

// ── Wave 1: find_by_name ────────────────────────────────────────────────
// Case-insensitive SUBSTRING match across the project. Searches entity
// names + aliases, scene titles, and relationship names. Returns an
// array of `{ id, type, name, matched_via, matched_value }` per match;
// `type` is one of the entity types ('character'/'location'/'item'/
// 'faction'/'custom') OR 'scene' / 'relationship'. `matched_via` is
// 'name' | 'alias' | 'title'.
//
// Useful for:
//  (a) discovery — what's in this project that's named like X?
//  (b) when the resolver helpers used by other tools fail with an
//      "ambiguous" or "not found" error and the client needs to see
//      the candidate list.
// Optionally filter to one type via the `type` arg.

registerMcpTool('find_by_name', (args) => {
  const query = (args?.name || '').trim().toLowerCase()
  if (!query) throw new Error('name is required')
  const typeFilter = args?.type || null
  if (typeFilter && !_LOOKUP_TYPES.includes(typeFilter)) {
    throw new Error(`unknown type: ${typeFilter}. Valid: ${_LOOKUP_TYPES.join(', ')}`)
  }
  const matches = []

  const wantEntities = !typeFilter || _ENTITY_TYPES.includes(typeFilter)
  const wantScenes = !typeFilter || typeFilter === 'scene'
  const wantRels = !typeFilter || typeFilter === 'relationship'
  const wantKnowledges = !typeFilter || typeFilter === 'knowledge'
  const wantChapters = !typeFilter || typeFilter === 'chapter'
  const wantActs = !typeFilter || typeFilter === 'act'

  if (wantEntities) {
    const types = (typeFilter && _ENTITY_TYPES.includes(typeFilter)) ? [typeFilter] : _ENTITY_TYPES
    for (const type of types) {
      for (const entity of _bucketFor(type)) {
        const entityName = entity.name || ''
        if (entityName.toLowerCase().includes(query)) {
          matches.push({
            id: entity.id, type, name: entityName,
            matched_via: 'name', matched_value: entityName,
          })
          continue
        }
        for (const a of (entity.aliases || [])) {
          const value = typeof a === 'string' ? a : a?.value
          if (value && value.toLowerCase().includes(query)) {
            matches.push({
              id: entity.id, type, name: entityName,
              matched_via: 'alias', matched_value: value,
            })
            break
          }
        }
      }
    }
  }

  if (wantScenes) {
    const nodes = useProjectStore.getState().nodes || []
    for (const n of nodes) {
      if (n.type !== 'sceneNode') continue
      const title = n.data?.title || ''
      if (title && title.toLowerCase().includes(query)) {
        matches.push({
          id: n.id, type: 'scene', name: title,
          matched_via: 'title', matched_value: title,
        })
      }
    }
  }

  if (wantRels) {
    const rels = useProjectStore.getState().relationships || []
    for (const r of rels) {
      const name = r.name || ''
      if (name && name.toLowerCase().includes(query)) {
        matches.push({
          id: r.id, type: 'relationship', name,
          matched_via: 'name', matched_value: name,
        })
      }
    }
  }

  if (wantKnowledges) {
    const knowledges = useProjectStore.getState().knowledges || []
    for (const k of knowledges) {
      const name = k.name || ''
      if (name && name.toLowerCase().includes(query)) {
        matches.push({
          id: k.id, type: 'knowledge', name,
          matched_via: 'name', matched_value: name,
        })
      }
    }
  }

  if (wantChapters) {
    const chapters = useProjectStore.getState().story?.chapters || []
    // Match stored title OR the UI placeholder "Chapter N" for unnamed
    // chapters — same matching rule as `_resolveChapter`.
    chapters.forEach((c, idx) => {
      const storedTitle = c.title || ''
      if (storedTitle && storedTitle.toLowerCase().includes(query)) {
        matches.push({
          id: c.id, type: 'chapter', name: storedTitle,
          matched_via: 'title', matched_value: storedTitle,
        })
        return
      }
      if (!storedTitle) {
        const placeholder = `Chapter ${idx + 1}`
        if (placeholder.toLowerCase().includes(query)) {
          matches.push({
            id: c.id, type: 'chapter', name: placeholder,
            matched_via: 'title', matched_value: placeholder,
          })
        }
      }
    })
  }

  if (wantActs) {
    const acts = useProjectStore.getState().story?.acts || []
    for (const a of acts) {
      const title = a.title || ''
      if (title && title.toLowerCase().includes(query)) {
        matches.push({
          id: a.id, type: 'act', name: title,
          matched_via: 'title', matched_value: title,
        })
      }
    }
  }

  // Wrap in `{matches: [...]}` so the MCP layer renders ONE content
  // block instead of one per array element — same reason as the
  // other list / find tools.
  return { matches }
})

// ── Wave 1: list_relationships ──────────────────────────────────────────
// Lightweight listing of every relationship in the project. Returns
// `{ id, name, participant_ids_ever, membership_of }` per entry.
// `participant_ids_ever` is the union of every entity that has joined
// at any point in the relationship's history (NOT the current member
// list at any specific scene — use get_relationship_at_scene for
// that). `name` may be null when the writer hasn't set an explicit
// label; unnamed relationships are referenceable only by UUID.

registerMcpTool('list_relationships', () => {
  const rels = useProjectStore.getState().relationships || []
  const relationships = rels.map((r) => ({
    id: r.id,
    name: r.name || null,
    participant_ids_ever: _participantsEver(r),
    membership_of: r.membership_of || null,
  }))
  return { relationships }
})

// ── Wave 1: get_relationship (unified origin / scene reads) ────────────
// One tool, two paths via `at` per the unified MCP tool shape:
//   - omitted / null / 'origin' → ORIGIN-baseline projection.
//     Returns the relationship's baseline fields regardless of where
//     its origin physically lives — a scene (existence_changes
//     activate@scene) OR a dedicated RelationshipOriginNode on the
//     canvas. Both creation patterns are supported by
//     `create_relationship`. The projection includes `origin_node_id`
//     so the MCP client knows where the origin actually is.
//   - scene UUID or exact title → scene-resolved projection. Walks
//     the relationship's history (existence, participant join/leave,
//     perception, alias-override, role, hierarchy, name, description
//     changes) up to and including the named scene. Returns the
//     effective state with participants as a merged array of
//     { entity_id, perception, alias_override, role } per current
//     participant — role inlined for convenience.

/** Scene-resolved projection of a Relationship at a specific scene.
 *  Walks the relationship's history (existence, participant join/leave,
 *  perception, alias-override, role, hierarchy, name, description) up
 *  to and including the named scene and returns the effective state.
 *  Shared by `get_relationship(at=...)` and `update_relationship(at=...)`
 *  so both tools' return shape stays in sync — and so a write tool's
 *  return reflects the chain entries it just recorded instead of the
 *  baseline. */
function _projectRelationshipAtScene(rel, sceneNode) {
  const projectStore = useProjectStore.getState()
  const nodes = projectStore.nodes || []
  const edges = projectStore.edges || []
  const storyOrder = computeStoryOrder({ nodes, edges })
  const nodeOrder = getRelationshipNodeOrder(rel, nodes, edges, storyOrder)
  const eff = computeRelationshipEffectiveState(rel, nodeOrder, sceneNode.id)

  // Build the merged participants list. The scene resolver's
  // `eff.participants` comes from `history.participant_changes` join
  // events only — entities with `participant_roles` but no explicit
  // join event (the "ambient with roles" pattern, e.g. the Dracula
  // project's marriage relationship) would be missing. Union both
  // sources so the MCP client gets the complete "who's in this now"
  // view; role is merged inline per entry.
  const joinedIds = new Set((eff?.participants || []).map((p) => p.entity_id))
  const roleMap = eff?.participant_roles || {}
  const participants = (eff?.participants || []).map((p) => ({
    entity_id: p.entity_id,
    perception: p.perception || '',
    alias_override: p.alias_override || null,
    role: roleMap[p.entity_id] || null,
  }))
  for (const entityId of Object.keys(roleMap)) {
    if (joinedIds.has(entityId)) continue
    participants.push({
      entity_id: entityId,
      perception: '',
      alias_override: null,
      role: roleMap[entityId] || null,
    })
  }

  return {
    id: rel.id,
    scene_id: sceneNode.id,
    scene_title: sceneNode.data?.title || '',
    origin_node_id: rel.creation_anchor_node_id || null,
    origin_kind: _originKindForNodeId(rel.creation_anchor_node_id || null),
    is_active: eff?.is_active ?? true,
    name: eff?.name || null,
    description: eff?.description || '',
    membership_of: eff?.membership_of || null,
    participants,
    hierarchy: eff?.hierarchy || null,
  }
}

registerMcpTool('get_relationship', (args) => {
  const rel = _resolveRelationship(args?.relationship)
  const at = args?.at
  const isOriginPath = !at || at === 'origin'

  if (isOriginPath) {
    return _projectRelationshipOrigin(rel)
  }

  const sceneNode = _resolveScene(at)
  return _projectRelationshipAtScene(rel, sceneNode)
})

// ── Wave 1: list_knowledges ─────────────────────────────────────────────
// Lightweight listing of every Knowledge in the project. Returns
// `{ id, name, colour, awareness_scale, source_event }` per entry —
// no descriptions, awareness dicts, or history. `source_event` is set
// on knowledges that were created from a scene-tracked event (the
// "Track awareness of this change" flow); standalone knowledges
// (created via "+ New Knowledge") leave it null.

registerMcpTool('list_knowledges', () => {
  const knowledgesRaw = useProjectStore.getState().knowledges || []
  const knowledges = knowledgesRaw.map((k) => ({
    id: k.id,
    name: k.name || '',
    colour: k.colour || null,
    awareness_scale: k.awareness_scale || 'full',
    source_event: k.source_event || null,
  }))
  return { knowledges }
})

// ── Wave 1: get_knowledge (unified origin / scene reads) ───────────────
// One tool, two paths via `at` per the unified MCP tool shape:
//   - omitted / null / 'origin' → ORIGIN-baseline projection. The
//     knowledge's baseline fields regardless of where its origin
//     physically lives — a scene (when created from a scene-tracked
//     event, with `source_event.node_id` pointing there), a
//     KnowledgeOriginNode on the canvas (when standalone with a
//     canvas presence), or no canvas node at all (fully standalone).
//     `origin_node_id` surfaces whichever applies, or null.
//   - scene UUID or exact title → scene-resolved projection. Walks
//     the knowledge's history (name / description / colour /
//     profile_image / awareness changes plus creation-point gating)
//     up to the named scene. Returns the same shape as the origin
//     path with the walked values plus `scene_id`, `scene_title`,
//     and `not_yet_exists` (true when the knowledge has a creation
//     anchor and `scene` is strictly before it).

registerMcpTool('get_knowledge', (args) => {
  const k = _resolveKnowledge(args?.knowledge)
  const at = args?.at
  const isOriginPath = !at || at === 'origin'

  if (isOriginPath) {
    // Awareness may be a flat dict or a wrapper `{entries, sources,
    // history}`; project to a clean `{levels, provenance}` nested
    // shape for MCP clients. Origin reads of awareness include any
    // baseline source projections — the projection resolves at the
    // origin anchor (null anchorNodeId) and surfaces members of each
    // source-relationship at their baseline membership state.
    const ctx = _buildAwarenessProvenanceCtx(null)
    const { flat: levels, observers, provenance } =
      _projectAwarenessWithProvenance(k.awareness, ctx)
    return {
      id: k.id,
      name: k.name || '',
      description: k.description || '',
      colour: k.colour || null,
      profile_image_ref: k.profile_image_ref || null,
      notes: k.notes || '',
      awareness_scale: k.awareness_scale || 'full',
      awareness: { levels, observers, provenance },
      source_event: k.source_event || null,
      manual_anchor_node_ids: (k.manual_anchors || [])
        .map((a) => (typeof a === 'string' ? a : a?.node_id))
        .filter(Boolean),
      origin_node_id: _knowledgeOriginNodeId(k),
      origin_kind: _originKindForNodeId(_knowledgeOriginNodeId(k)),
      scene_id: null,
    }
  }

  // Scene-resolved path
  const sceneNode = _resolveScene(at)
  return _projectKnowledgeAtScene(k, sceneNode)
})

/** Scene-resolved projection of a Knowledge at a specific scene.
 *  Walks `k.history` (name / description / colour / profile_image /
 *  existence / awareness changes) up to and including the named scene
 *  and returns the effective state. Shared by `get_knowledge(at=...)`
 *  and `update_knowledge(at=...)` so both tools' return shape stays
 *  in sync — and so a write tool's return reflects the chain entries
 *  it just recorded instead of leaking the baseline. */
function _projectKnowledgeAtScene(k, sceneNode) {
  const projectStore = useProjectStore.getState()
  const nodes = projectStore.nodes || []
  const edges = projectStore.edges || []
  // Use the SHARED, cached story order: the scene-context renderer calls
  // this once PER KNOWLEDGE, so a fresh ~110ms graph walk here fired once
  // per knowledge per send (dozens on a knowledge-heavy story). The order
  // is global, so the cache makes every call after the first near-free.
  const storyOrder = getOrComputeStoryOrderFromStore()
  const nodeOrder = getKnowledgeNodeOrder(k, nodes, edges, storyOrder)
  const eff = computeKnowledgeEffectiveState(k, nodeOrder, sceneNode.id, {
    nodes,
    ctx: { storyOrder },
  })

  const originNodeId = _knowledgeOriginNodeId(k)

  if (eff?.notYetExists) {
    return {
      id: k.id,
      scene_id: sceneNode.id,
      scene_title: sceneNode.data?.title || '',
      origin_node_id: originNodeId,
      origin_kind: _originKindForNodeId(originNodeId),
      not_yet_exists: true,
      name: '',
      description: '',
      colour: k.colour || null,
      profile_image_ref: null,
      notes: k.notes || '',
      awareness_scale: k.awareness_scale || 'full',
      awareness: { levels: {}, observers: {}, provenance: {} },
    }
  }

  // Scene-resolved awareness with per-observer provenance, surfaced
  // as a nested `{ levels, provenance }` object so the response
  // shape is structurally distinct from a flat observer-id-keyed
  // dict. The knowledge-state walker (`computeKnowledgeEffectiveState`)
  // collapses the awareness wrapper to a flat dict on `eff.awareness`,
  // which loses the source-projection information we need for
  // provenance. Pass the baseline `k.awareness` wrapper to the
  // provenance helper directly — it internally walks `awareness.history`
  // (tracking on/off events + per-observer entries + source mutations)
  // up to the anchor and resolves sources at chain-time, so the result
  // matches `eff.awareness` for the flat dict while ALSO carrying the
  // per-observer provenance the flat dict drops.
  const ctx = _buildAwarenessProvenanceCtx(sceneNode.id)
  const { flat: levels, observers, provenance } =
    _projectAwarenessWithProvenance(k.awareness, ctx)

  return {
    id: k.id,
    scene_id: sceneNode.id,
    scene_title: sceneNode.data?.title || '',
    origin_node_id: originNodeId,
    origin_kind: _originKindForNodeId(originNodeId),
    not_yet_exists: false,
    name: eff?.name || '',
    description: eff?.description || '',
    colour: eff?.colour || null,
    profile_image_ref: eff?.profile_image_ref || null,
    notes: k.notes || '',  // notes is not scene-tracked
    awareness_scale: k.awareness_scale || 'full',
    awareness: { levels, observers, provenance },
  }
}


// ── get_knowledge_awareness_history ───────────────────────────────
// Walks `k.awareness.history` and surfaces every awareness event in
// story order, projecting each into a uniform `{ kind, scene_id,
// scene_title, pov_index, ... }` shape so the AI client can see the
// full propagation of who-knows-what-when in one read. Mirrors the
// shape `get_entity_chain_history` returns. Optional `scenes=[...]`
// filter restricts the event list to events landing at one of the
// named scenes. Surfaced 2026-05-18 in the rom-com v2 blind-agent
// test: agent wanted to audit the full awareness propagation across
// the chain without fanning out get_knowledge(at=<each scene>) N
// times.

registerMcpTool('get_knowledge_awareness_history', (args) => {
  const k = _resolveKnowledge(args?.knowledge)
  const projectStore = useProjectStore.getState()
  const nodes = projectStore.nodes || []
  const edges = projectStore.edges || []
  const storyOrder = computeStoryOrder({ nodes, edges })
  const povChain = computePovChain(nodes, edges)
  const povIndexById = new Map(povChain.sequence.map((e) => [e.nodeId, e.index]))
  const orderedIds = storyOrder?.orderedIds || []
  const orderIndex = new Map(orderedIds.map((id, i) => [id, i]))

  // Optional `scenes` filter — restricts the events list to those at
  // the named scenes.
  let sceneFilterIds = null
  if (Array.isArray(args?.scenes) && args.scenes.length > 0) {
    sceneFilterIds = new Set()
    for (let i = 0; i < args.scenes.length; i++) {
      const ref = args.scenes[i]
      if (typeof ref !== 'string' || !ref) {
        throw new Error(`scenes[${i}] must be a non-empty string (UUID or exact scene title).`)
      }
      try {
        const sn = _resolveScene(ref)
        sceneFilterIds.add(sn.id)
      } catch (err) {
        throw new Error(`scenes[${i}]: ${err.message}`)
      }
    }
  }

  // Pull the awareness wrapper history list. Knowledge awareness
  // lives in `k.awareness.history[]` per the second-class-object
  // model (awareness is its own chain on the host). Flat-dict
  // baseline awareness has no history.
  const aware = k.awareness
  const historyList = (aware && typeof aware === 'object' && Array.isArray(aware.history))
    ? aware.history
    : []

  // Baseline (origin) awareness — observers set at the knowledge's
  // origin live on `aware.entries` (post-v0.2.1.x wrapper shape).
  // Project these as `kind: 'baseline'` entries at the knowledge's
  // creation anchor so the AI sees the starting state alongside the
  // chain events.
  //
  // Defensive: filter out reserved wrapper keys ('entries' / 'sources'
  // / 'history') that may have leaked into the baseline entries dict
  // from a partial legacy migration — they aren't observer ids and
  // shouldn't surface as fake `baseline_set` events. Without this
  // guard the freeform v7 test saw `{ kind: 'baseline_set',
  // observer_id: 'history', level: <the history array> }` events
  // in the response. Same fix applied at every awareness parse
  // boundary; see `awarenessCommit.js#_AWARENESS_RESERVED_WRAPPER_KEYS`
  // for the source-of-truth list.
  const baselineEntries = {}
  if (aware && typeof aware === 'object' && !Array.isArray(aware) && aware.entries && typeof aware.entries === 'object') {
    for (const [obs, lvl] of Object.entries(aware.entries)) {
      if (obs === 'entries' || obs === 'sources' || obs === 'history') continue
      baselineEntries[obs] = lvl
    }
  }
  const creationAnchorId = _knowledgeOriginNodeId(k)
  const creationAnchorNode = creationAnchorId ? nodes.find((n) => n.id === creationAnchorId) : null

  const events = []
  const observerName = (id) => {
    if (!id) return null
    const f = _findEntity(id)
    return f?.entity?.name || null
  }

  // Baseline entries first (one event per observer set at origin).
  if (creationAnchorId && Object.keys(baselineEntries).length > 0) {
    const baseSceneTitle = creationAnchorNode?.data?.title || null
    const baseSceneIsScene = creationAnchorNode?.type === 'sceneNode'
    if (!sceneFilterIds || sceneFilterIds.has(creationAnchorId)) {
      for (const [obsId, lvl] of Object.entries(baselineEntries)) {
        events.push({
          kind: 'baseline_set',
          scene_id: baseSceneIsScene ? creationAnchorId : null,
          scene_title: baseSceneIsScene ? baseSceneTitle : null,
          pov_index: baseSceneIsScene ? (povIndexById.get(creationAnchorId) ?? null) : null,
          observer_id: obsId,
          observer_name: observerName(obsId),
          level: lvl,
          level_name: _levelName(lvl),
        })
      }
    }
  }

  // Walk chain history in story order.
  const inOrderHistory = [...historyList].sort((a, b) => {
    const ai = orderIndex.has(a?.node_id) ? orderIndex.get(a.node_id) : Infinity
    const bi = orderIndex.has(b?.node_id) ? orderIndex.get(b.node_id) : Infinity
    return ai - bi
  })
  for (const h of inOrderHistory) {
    if (!h || !h.node_id) continue
    if (sceneFilterIds && !sceneFilterIds.has(h.node_id)) continue
    const node = nodes.find((n) => n.id === h.node_id)
    const sceneCtx = {
      scene_id: h.node_id,
      scene_title: node?.data?.title || null,
      pov_index: povIndexById.get(h.node_id) ?? null,
    }
    if (h.tracking_action === 'on') {
      events.push({ kind: 'tracking_on', ...sceneCtx })
    } else if (h.tracking_action === 'off') {
      events.push({ kind: 'tracking_off', ...sceneCtx })
    } else if (h.source_action) {
      events.push({
        kind: 'source_change',
        action: h.source_action,
        source: h.source || null,
        ...sceneCtx,
      })
    } else if (h.observer_id) {
      events.push({
        kind: 'observer_set',
        observer_id: h.observer_id,
        observer_name: observerName(h.observer_id),
        level: h.level,
        level_name: h.level != null ? _levelName(h.level) : null,
        ...sceneCtx,
      })
    }
  }

  return {
    knowledge_id: k.id,
    knowledge_name: k.name || '',
    awareness_scale: k.awareness_scale || 'full',
    events,
  }
})


// ── Wave 1: get_scene ───────────────────────────────────────────────────
// Full state of one scene. The `scene` arg accepts UUID or exact
// (case-insensitive) title. Returns:
//   id, title, description, main_content (TipTap HTML), position,
//   chapter_id, chapter_title, pov_index, on_pov_path, is_flashback,
//   parent_scene_id, pov_entity_id, circumstances (scene-level),
//   participants_by_type (entity chips grouped per type with
//     scene-resolved name + colour + has_pov per chip), and
//   time/date fields when set.
//
// `participants_by_type` is keyed by entity type plural
// ('characters' / 'locations' / 'items' / 'factions' / 'customs') and
// each entry is `{ entity_id, name, colour, has_pov }` — name/colour
// are walked to this scene so the MCP client sees the in-scene state.
// Use `get_entity_at_scene` for the full scene-resolved entity shape
// (description, attributes, aliases, etc.) on any participant.

registerMcpTool('get_scene', (args) => {
  const sceneNode = _resolveScene(args?.scene)
  const data = sceneNode.data || {}
  const projectStore = useProjectStore.getState()
  const nodes = projectStore.nodes || []
  const edges = projectStore.edges || []
  const story = projectStore.story || {}
  const chapters = story.chapters || []
  const chapterMemberOpts = chapterMemberOptsForStory(story)

  const storyOrder = computeStoryOrder({ nodes, edges })
  const povChain = computePovChain(nodes, edges)
  const povIndex = povChain.sequence.find((e) => e.nodeId === sceneNode.id)?.index ?? null

  const chapterId = resolveChapterIdForNode(sceneNode, chapters, chapterMemberOpts)
  const chapter = chapterId ? chapters.find((c) => c.id === chapterId) : null

  // Build participants_by_type: one lightweight {id, name, colour,
  // has_pov} per EntityRef per type bucket. Names/colours are walked
  // to this scene so the MCP client sees in-scene labels (which may
  // differ from the entity's origin name). `has_pov` is derived from
  // the scene's `pov_entity_id` (the canonical POV storage) rather
  // than `ref.has_pov` — see the same fix in `_buildVerboseSceneExtras`
  // above for context.
  const participants_by_type = {}
  const scenePovEntityId = data.pov_entity_id || null
  for (const type of _ENTITY_TYPES) {
    const refs = data[`${type}s`] || []
    const out = []
    for (const ref of refs) {
      const entity = _findEntity(ref.entity_id)?.entity
      if (!entity) continue
      const eff = computeEffectiveState(entity, nodes, edges, sceneNode.id, { storyOrder })
      out.push({
        entity_id: ref.entity_id,
        name: eff?.name || entity.name || '',
        colour: eff?.colour || entity.colour || null,
        has_pov: scenePovEntityId === ref.entity_id,
      })
    }
    participants_by_type[`${type}s`] = out
  }

  // Scene-level circumstances — intensity returned as a canonical name
  // (Faint / Mild / Moderate / Strong / Intense) matching the
  // IntensityBadge tooltip, not a bare 0-4 int.
  const circumstances = (data.circumstances || []).map((c) => ({
    id: c.id,
    name: c.name || null,
    description: c.description || '',
    intensity: c.intensity != null ? _intensityName(c.intensity) : null,
  }))

  // Time/date fields — collapsed presentation shape:
  //
  //   - `time_of_day` is a single string (the populated tier's value).
  //     Tier is implicit: broad pins return 'day' / 'night', labelled
  //     pins return one of the 15 canonical labels, exact pins return
  //     'HH:MM'. AI clients write back via the same string shape; the
  //     `_resolveTimeOfDay` input resolver picks tier from shape.
  //   - `weekday` returns a canonical day name ("Tuesday") instead of
  //     a bare 0-6 int.
  //   - `season` returns a canonical season name ("Spring") instead
  //     of a bare 0-3 int.
  //   - `date` is a nested object `{ month: "October", day: 17 }` —
  //     replaces the three-field `date_tier` / `date_month` /
  //     `date_day_of_month` shape. month is the full English name; day
  //     is the 1-31 int when set. `date_tier` discriminator is
  //     omitted (derivable from whether `day` is set).
  //   - `scene_duration` and `gap_extension` gain a `display` field
  //     carrying the time-modal-matching phrasing ("30 minutes",
  //     "about 2 hours"). Internal `kind` / `value` fields retained
  //     for round-trip writes.
  const time = {}
  if (data.time_of_day_tier === 'labelled' && data.time_of_day_labelled) {
    time.time_of_day = data.time_of_day_labelled
  } else if (data.time_of_day_tier === 'exact' && data.time_of_day_exact) {
    time.time_of_day = data.time_of_day_exact
  } else if (data.time_of_day_tier === 'broad' && data.time_of_day_broad) {
    time.time_of_day = data.time_of_day_broad
  }
  if (data.weekday != null) {
    const name = _weekdayName(data.weekday)
    if (name) time.weekday = name
  }
  if (data.season != null) {
    const name = _seasonName(data.season)
    if (name) time.season = name
  }
  if (data.date_month != null) {
    const monthName = _monthName(data.date_month)
    if (monthName) {
      time.date = {
        month: monthName,
        ...(data.date_day_of_month != null ? { day: data.date_day_of_month } : {}),
      }
    }
  }
  if (data.scene_duration) {
    const sd = data.scene_duration
    const display = formatSceneDuration(sd, 'value') || null
    time.scene_duration = {
      ...sd,
      ...(display ? { display } : {}),
    }
  }
  if (data.gap_extension) {
    const display = formatGapExtension(data.gap_extension, 'value') || null
    time.gap_extension = {
      ...data.gap_extension,
      ...(display ? { display } : {}),
    }
  }
  // Walker-derived chain-position info: effective start, floor,
  // time-since-prior-scene with the same phrasing the chip's leading
  // segment + the Time Modal show the writer. Surfaces what the
  // writer SEES, not just what they PINNED, so the AI can reason
  // about the chain-position context without having to re-implement
  // the walker. Off-chain scenes (not on POV path) → derived is null.
  const derived = _walkerDerivedTimeForScene(sceneNode)
  if (derived) time.derived = derived

  const baseShape = {
    id: sceneNode.id,
    title: data.title || '',
    description: data.description || '',
    main_content: data.main_content || '',
    position: sceneNode.position || { x: 0, y: 0 },
    chapter_id: chapterId || null,
    chapter_title: chapter?.title || null,
    pov_index: povIndex,
    on_pov_path: povIndex != null,
    pov_entity_id: data.pov_entity_id || null,
    is_flashback: !!data.is_flashback,
    parent_scene_id: data.parent_scene_id || null,
    participants_by_type,
    circumstances,
    ...(Object.keys(time).length ? { time } : {}),
  }

  // Verbose mode — adds the full composite read so the AI client
  // doesn't need to fan out to per-participant / per-relationship /
  // per-knowledge calls just to understand what's in the scene. The
  // most common use case is prose-writing context: "give me
  // everything I need to know about scene X in one shot."
  // Surfaced 2026-05-18 in the blind-agent rom-com test (v2).
  if (args?.verbose !== true) {
    return baseShape
  }

  // Per-participant full chain-resolved state — same shape
  // `get_entity(at=<this scene>)` returns. Routes through the
  // unified `computeEffectiveStateWithPrior` helper so we get the
  // resolved current state plus chain_resolution provenance.
  const participants = []
  for (const type of _ENTITY_TYPES) {
    const refs = data[`${type}s`] || []
    for (const ref of refs) {
      const found = _findEntity(ref.entity_id)
      if (!found) continue
      const { current: effective } = computeEffectiveStateWithPrior(
        found.entity, nodes, edges, sceneNode.id,
      )
      const grouped = _projectAndGroupAttributes(effective.attributes)
      const chainResolution = _computeChainResolutionMeta(found.entity, nodes, edges, sceneNode.id)
      participants.push({
        id: found.entity.id,
        type: found.type,
        scene_id: sceneNode.id,
        scene_title: data.title || '',
        name: effective.name || '',
        colour: effective.colour || null,
        description: effective.description || '',
        profile_image_ref: effective.profile_image_ref || null,
        notes: found.entity.notes || '',
        aliases: (effective.aliases || []).map((a) => (typeof a === 'string' ? a : a?.value)).filter(Boolean),
        attributes: grouped.attributes,
        circumstances: grouped.circumstances,
        motivators: grouped.motivators,
        chain_resolution: chainResolution,
        has_pov: scenePovEntityId === ref.entity_id,
        ...(found.type === 'location' && found.entity.parent_id ? { parent_id: found.entity.parent_id } : {}),
        ...(found.type === 'custom' && found.entity.category_id ? { category_id: found.entity.category_id } : {}),
      })
    }
  }

  // Per-entity TEMPORARY circumstances scoped to this scene (one-off
  // states that apply only at this scene, distinct from chain-tracked
  // entity circumstances that ride on each entity's chain history).
  // Entity name resolves to the chain-walked name at this scene (so
  // a character renamed mid-chain shows their current scene-resolved
  // name here, not their origin baseline name).
  const entity_temporary_circumstances = (data.entity_temporary_circumstances || []).map((tc) => {
    const owner = _findEntity(tc.entity_id)
    let resolvedName = owner?.entity?.name || null
    if (owner?.entity) {
      try {
        const eff = computeEffectiveState(owner.entity, nodes, edges, sceneNode.id, { storyOrder })
        resolvedName = eff?.name || resolvedName
      } catch {
        // Defensive: fall back to baseline name on resolver error.
      }
    }
    return {
      id: tc.id,
      entity_id: tc.entity_id,
      entity_name: resolvedName,
      entity_type: owner?.type || null,
      attribute_type: tc.attribute_type || 'circumstance',
      name: tc.name || null,
      description: tc.description || '',
      intensity: tc.intensity != null ? _intensityName(tc.intensity) : null,
    }
  })

  // Active relationships at this scene — any relationship whose
  // participant set at this scene is non-empty. Each projected
  // through the existing scene-resolved helper for shape parity
  // with `get_relationship(at=<this scene>)`.
  const relationships = []
  const participantEntityIds = new Set()
  for (const type of _ENTITY_TYPES) {
    for (const ref of (data[`${type}s`] || [])) {
      if (ref?.entity_id) participantEntityIds.add(ref.entity_id)
    }
  }
  for (const rel of (projectStore.relationships || [])) {
    const joinEvents = (rel.history?.participant_changes || []).filter((c) => c?.action === 'join')
    const everParticipantIds = new Set(joinEvents.map((c) => c.entity_id).filter(Boolean))
    const touchesScene = [...everParticipantIds].some((eid) => participantEntityIds.has(eid))
    if (!touchesScene) continue
    try {
      relationships.push(_projectRelationshipAtScene(rel, sceneNode))
    } catch {
      // Defensive: skip relationships the resolver can't project at
      // this scene (e.g. not-yet-active). Don't fail the whole verbose
      // read on one bad relationship.
    }
  }

  // All knowledges with their scene-resolved state at this anchor —
  // includes the cumulative `awareness` map (which observers know
  // what at this scene). Replaces the agent pain of fanning out
  // get_knowledge per knowledge.
  const knowledges = []
  for (const k of (projectStore.knowledges || [])) {
    try {
      knowledges.push(_projectKnowledgeAtScene(k, sceneNode))
    } catch {
      // Same defensive skip.
    }
  }

  return {
    ...baseShape,
    participants,
    entity_temporary_circumstances,
    relationships,
    knowledges,
  }
})

// ── Wave 1: get_scene_context ───────────────────────────────────────────
// Neighbouring scenes of one scene. Returns:
//   pov_prev / pov_next  — neighbouring POV-path scenes (null when
//                          the scene is off-POV or at an end).
//   predecessors         — scene ids of every scene with a connection
//                          wire TARGETING this scene.
//   successors           — scene ids of every scene with a connection
//                          wire ORIGINATING from this scene.
//   chapter / pov_index  — same fields as get_scene, repeated for
//                          convenience so the client doesn't need two
//                          calls to orient a scene.
// Each predecessor/successor entry is `{ id, title }` for cheap
// readability; follow up with `get_scene` for full details.

registerMcpTool('get_scene_context', (args) => {
  const sceneNode = _resolveScene(args?.scene)
  const projectStore = useProjectStore.getState()
  const nodes = projectStore.nodes || []
  const edges = projectStore.edges || []
  const story = projectStore.story || {}
  const chapters = story.chapters || []
  const chapterMemberOpts = chapterMemberOptsForStory(story)

  const sceneById = new Map(nodes.filter((n) => n.type === 'sceneNode').map((n) => [n.id, n]))
  const titleFor = (id) => sceneById.get(id)?.data?.title || ''

  // Predecessors / successors via the React Flow edge graph. Only
  // count scene-to-scene edges; entity-origin / knowledge-origin /
  // relationship-origin wires are skipped because they don't
  // represent scene-to-scene transitions.
  const predecessors = []
  const successors = []
  for (const edge of edges) {
    if (edge.target === sceneNode.id && sceneById.has(edge.source)) {
      predecessors.push({ id: edge.source, title: titleFor(edge.source) })
    }
    if (edge.source === sceneNode.id && sceneById.has(edge.target)) {
      successors.push({ id: edge.target, title: titleFor(edge.target) })
    }
  }
  // De-dupe by id (a scene pair can have multiple entity wires
  // between them — we only want one neighbour entry per pair).
  const dedupe = (arr) => {
    const seen = new Set()
    return arr.filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true)))
  }

  // POV-path neighbours.
  const povChain = computePovChain(nodes, edges)
  const idx = povChain.sequence.findIndex((e) => e.nodeId === sceneNode.id)
  const povPrev = idx > 0 ? povChain.sequence[idx - 1] : null
  const povNext = (idx >= 0 && idx < povChain.sequence.length - 1)
    ? povChain.sequence[idx + 1]
    : null

  const chapterId = resolveChapterIdForNode(sceneNode, chapters, chapterMemberOpts)
  const chapter = chapterId ? chapters.find((c) => c.id === chapterId) : null

  return {
    id: sceneNode.id,
    title: sceneNode.data?.title || '',
    // Story-level blurb included so the AI orienting on a scene also
    // sees the "what is this story about" framing without a second
    // call. Always present (empty string when unset) per convention.
    story_description: story?.description || '',
    pov_index: idx >= 0 ? povChain.sequence[idx].index : null,
    on_pov_path: idx >= 0,
    chapter_id: chapterId || null,
    chapter_title: chapter?.title || null,
    pov_prev: povPrev ? { id: povPrev.nodeId, title: titleFor(povPrev.nodeId) } : null,
    pov_next: povNext ? { id: povNext.nodeId, title: titleFor(povNext.nodeId) } : null,
    predecessors: dedupe(predecessors),
    successors: dedupe(successors),
  }
})

// ── Phase D — Wave 2 write tools ───────────────────────────────────────
//
// Each handler is async (calls Zustand actions that POST to the backend).
// The bridge dispatcher already awaits handler return values, so async
// is fine.
//
// Backend gating: every Phase D MCP tool routes through
// `_proxy_write_tool` on the Python side, which checks
// `session_manager.state == 'active'` BEFORE forwarding over the
// bridge. If no session is active, the bridge isn't even contacted —
// so by the time a handler here runs, the session is GUARANTEED to
// be active. No need to re-check on this side.

// ── Wave 2: create_entity ───────────────────────────────────────────────
// Creates a NEW entity at its origin. Per the scene-aware rule, the
// moment of creation IS the entity's origin — no prior scene-anchored change
// exists, so writing baseline values here is the scene-aware path
// (not a bypass). Subsequent edits to scene-tracked fields at any
// scene downstream of the origin go through a different tool
// (`set_entity_change_at_scene`, lands later in Phase D), NOT
// through create_entity again.
//
// Validates inputs, calls the existing `createEntity` Zustand
// action (which POSTs to `/api/entities/`), returns the new id /
// type / name so the AI can chain subsequent calls.
//
// Default colour matches the UI's "+ New Entity" modal default
// (zinc-grey `#888888`) for every entity type — see `EntityModal.jsx`
// line 587. The user can change it after via `update_entity` or
// the colour picker in the entity detail panel.

const _DEFAULT_NEW_ENTITY_COLOUR = '#888888'

// Hex-colour validator — canonical 6-digit form `#RRGGBB`. The
// codebase (IntensityBadge, entity / knowledge colour pickers, etc.)
// consistently uses 6-digit hex; rejecting other shapes keeps writes
// canonical. Surfaced 2026-05-18 by the freeform v8 blind-agent test
// where `update_entity(colour='not-a-hex')` was accepted silently.
//
// Accepts: null / undefined / empty string (passes through as
// "no colour" — caller's defaulting logic still applies); `#RRGGBB`
// (exactly 7 chars, case-insensitive on the hex digits).
// Rejects: 3-digit shorthand, missing leading `#`, any other shape.
const _HEX_COLOUR_RE = /^#[0-9a-fA-F]{6}$/
function _validateHexColour(value, fieldLabel = 'colour') {
  if (value === null || value === undefined || value === '') return
  if (typeof value !== 'string') {
    throw new Error(
      `${fieldLabel} must be a string in 6-digit hex format like '#aabbcc'. ` +
      `Got ${typeof value} instead.`
    )
  }
  if (!_HEX_COLOUR_RE.test(value)) {
    throw new Error(
      `${fieldLabel} '${value}' is not a valid hex colour. ` +
      `Expected 6-digit hex format like '#aabbcc' (leading '#' required; ` +
      `3-digit shorthand and other shapes are not accepted).`
    )
  }
}

registerMcpTool('create_entity', async (args) => {
  const type = args?.type
  if (!type || !_ENTITY_TYPES.includes(type)) {
    throw new Error(
      `type is required, must be one of: ${_ENTITY_TYPES.join(', ')}`
    )
  }
  const name = (args?.name || '').trim()
  if (!name) throw new Error('name is required and must be non-empty')

  // Per-type validation. The args come through the MCP server's
  // strictly-typed tool signature, which only forwards declared
  // params — so `args.category` / `args.parent` are the only forms
  // we'll ever see at this layer. (The pre-v0.2.1.141 names
  // `category_id` / `parent_id` are gone; clients still sending
  // them get filtered out at the MCP layer before reaching here,
  // and the resulting "custom entities require `category`" error
  // tells them what to switch to.)
  const categoryArg = args?.category
  const parentArg = args?.parent
  if (type === 'custom' && !categoryArg) {
    throw new Error(
      "custom entities require `category` (UUID or exact name of an " +
      "existing custom category). Call create_custom_category(name=...) " +
      "first to mint a new one if needed."
    )
  }
  // Resolve category polymorphically (UUID or name) and verify it
  // points at a real category — reject-on-missing-reference per the
  // MCP audit's D1 verdict.
  let resolvedCategoryId = null
  if (type === 'custom') {
    resolvedCategoryId = _resolveCustomCategoryId(categoryArg)
  }
  // Resolve parent similarly when set on locations: the field is a
  // location-entity reference (UUID), but the AI may pass a name.
  let resolvedParentId = null
  if (type === 'location' && parentArg) {
    const parent = _resolveEntity(parentArg, 'location')
    resolvedParentId = parent.entity.id
  }

  // Pre-validate batch attribute + alias args BEFORE creating the entity.
  // If any item is malformed (bad attribute_type, duplicate name, etc.)
  // the whole call errors with a per-item-indexed message and the
  // entity itself is never created — no half-baked state landing.
  // Both args are optional; omitting them is identical to the pre-
  // v0.2.1.155 single-shot create_entity behaviour.
  const builtAttributes = []
  const attributesArg = args?.attributes
  if (attributesArg !== undefined && attributesArg !== null) {
    if (!Array.isArray(attributesArg)) {
      throw new Error('attributes must be an array of attribute objects')
    }
    const seenNames = new Set()
    for (let i = 0; i < attributesArg.length; i++) {
      const item = attributesArg[i]
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error(`attributes[${i}] must be an object with attribute fields`)
      }
      let built
      try {
        built = _buildAttributeFromMcpInput(item)
      } catch (err) {
        throw new Error(`attributes[${i}]: ${err.message}`)
      }
      // Duplicate-name check inside the batch (mirrors the single-shot
      // add_attribute origin-path guard). Unnamed CM attributes can
      // coexist; only error on named duplicates.
      const lower = (built.name || '').trim().toLowerCase()
      if (lower) {
        if (seenNames.has(lower)) {
          throw new Error(
            `attributes[${i}]: duplicate name "${built.name}" within the batch — ` +
            `each named attribute in a create_entity attributes list must be unique.`
          )
        }
        seenNames.add(lower)
      }
      builtAttributes.push(built)
    }
  }
  // Batch circumstances + motivators get folded into the same
  // attributes pipeline since both are stored as attribute objects
  // with `attribute_type='circumstance' | 'motivator'`. The polished
  // per-item shape is `{name, description, intensity?}` (matching
  // add_circumstances / add_motivators) — we expand each into the
  // full attribute payload before feeding `_buildAttributeFromMcpInput`,
  // which handles the CM-specific validation and intensity resolution.
  // Per-item attribution preserves the source bucket so error messages
  // point at the right list.
  function _foldCmBatch(itemsArg, batchName, attributeType) {
    if (itemsArg === undefined || itemsArg === null) return
    if (!Array.isArray(itemsArg)) {
      throw new Error(`${batchName} must be an array of ${attributeType} objects`)
    }
    for (let i = 0; i < itemsArg.length; i++) {
      const item = itemsArg[i]
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error(`${batchName}[${i}] must be an object with name / description / intensity fields`)
      }
      const payload = {
        attribute_type: attributeType,
        name: item.name,
        description: item.description,
        intensity: item.intensity,
      }
      let built
      try {
        built = _buildAttributeFromMcpInput(payload)
      } catch (err) {
        throw new Error(`${batchName}[${i}]: ${err.message}`)
      }
      // Duplicate-name check shares the same `seenNames` set used by
      // the attributes batch above so collisions across batches also
      // get caught (a circumstance and an attribute can't share a name
      // on the same entity).
      const lower = (built.name || '').trim().toLowerCase()
      if (lower) {
        if (seenNames.has(lower)) {
          throw new Error(
            `${batchName}[${i}]: name "${built.name}" duplicates a name already in the ` +
            `entity's create batch (attributes / circumstances / motivators share a single ` +
            `attribute pool — each named item must be unique across all three).`
          )
        }
        seenNames.add(lower)
      }
      builtAttributes.push(built)
    }
  }
  // `seenNames` was scoped to the attributes-batch loop above; re-
  // expose it here so the CM folds participate in the same dedupe.
  // (The original loop's local set is gone; rebuild from current
  // builtAttributes.)
  const seenNames = new Set(
    builtAttributes
      .map((a) => (a.name || '').trim().toLowerCase())
      .filter(Boolean),
  )
  _foldCmBatch(args?.circumstances, 'circumstances', 'circumstance')
  _foldCmBatch(args?.motivators, 'motivators', 'motivator')

  const builtAliases = []
  const aliasesArg = args?.aliases
  if (aliasesArg !== undefined && aliasesArg !== null) {
    if (!Array.isArray(aliasesArg)) {
      throw new Error('aliases must be an array of alias objects (e.g. [{value: "Marc"}]). Bare strings accepted as shorthand.')
    }
    const seenAliasValues = new Set()
    for (let i = 0; i < aliasesArg.length; i++) {
      // Same polymorphic per-item shape as add_aliases: accept either
      // a bare string (auto-promoted) or an object `{value: <string>}`
      // for shape-consistency with the `attributes` batch.
      const raw = aliasesArg[i]
      let value
      if (typeof raw === 'string') {
        value = raw.trim()
      } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        if (raw.value === undefined || raw.value === null) {
          throw new Error(`aliases[${i}]: object form requires a 'value' field (e.g. {value: "Marc"}).`)
        }
        if (typeof raw.value !== 'string') {
          throw new Error(`aliases[${i}].value must be a string`)
        }
        value = raw.value.trim()
      } else {
        throw new Error(`aliases[${i}] must be either a string or an object {value: <string>}`)
      }
      if (!value) {
        throw new Error(`aliases[${i}] is empty after trimming; aliases must be non-empty strings`)
      }
      const lower = value.toLowerCase()
      if (seenAliasValues.has(lower)) {
        throw new Error(
          `aliases[${i}]: duplicate value "${value}" within the batch — ` +
          `each alias in a create_entity aliases list must be unique.`
        )
      }
      seenAliasValues.add(lower)
      builtAliases.push({ id: crypto.randomUUID(), value, awareness: null })
    }
  }

  // Build the entity payload that the backend's POST /api/entities/
  // endpoint expects. This is the SAME shape the user-driven entity
  // creation flow sends; we're the AI counterpart, not a special
  // path. The pre-validated batch attributes / aliases (if any) ride
  // in here so the whole origin-state lands in one round-trip.
  _validateHexColour(args?.colour, 'colour')
  const entityData = {
    type,
    name,
    description: args?.description || '',
    colour: args?.colour || _DEFAULT_NEW_ENTITY_COLOUR,
    attributes: builtAttributes,
    aliases: builtAliases,
  }
  if (type === 'location' && resolvedParentId) {
    entityData.parent_id = resolvedParentId
  }
  if (type === 'custom') {
    entityData.category_id = resolvedCategoryId
  }

  // The Zustand action returns `{ entity, entity_node }` — the
  // entity is already in the library bucket at this point, but the
  // entity_node still needs to be placed on the canvas explicitly
  // (the action doesn't auto-place; the UI's EntityModal does it as
  // a follow-up step). Mirror that flow here so the AI's create_entity
  // call lands exactly the same on-canvas state as the user clicking
  // "+ New Character".
  const result = await useEntitiesStore.getState().createEntity(entityData)

  // Faction-specific: also create the faction's membership
  // relationship at the new origin node. EntityModal does this same
  // step before placing the canvas node. Without it, the faction
  // exists but has no membership relationship to track joiners
  // against.
  if (result.entity.type === 'faction') {
    await useProjectStore.getState().createFactionMembership(
      result.entity.id,
      result.entity_node.id,
      result.entity.name,
    )
  }

  // Place the entity origin EntityNode on the canvas. MCP path uses
  // smart-placement (right of all existing origin EntityNodes on a
  // consistent "entity row", collision-shifted downward if needed)
  // instead of `addEntityNodeToCanvas`'s viewport-blind random
  // fallback. The AI driving MCP doesn't see the user's viewport;
  // viewport-centre placement made multiple MCP-created entities
  // stack on top of each other. Same isolation rule as MCP scene
  // placement: this only affects the MCP path; the UI's user-driven
  // entity-add still hits the random fallback for clicked / dropped
  // creation gestures.
  const entityNodePosition = _mcpComputeEntityNodePosition()
  useProjectStore.getState().addEntityNodeToCanvas(
    result.entity_node,
    entityNodePosition,
    { createdEntity: result.entity },
  )

  // Track for session-scoped tidy pass.
  _mcpSessionEntityNodeIds.add(result.entity_node.id)
  _mcpTidyLayout()

  // Echo the batch results back so the AI sees what landed without a
  // follow-up get_entity. Split by attribute_type so circumstances and
  // motivators surface in their own buckets — matches the
  // get_entity grouped-response shape and avoids the "everything in
  // one attributes array, scan by .type to filter" pain the blind-
  // agent rom-com test reported (2026-05-17b).
  const echoAttrs = builtAttributes.filter((a) => a.attribute_type !== 'circumstance' && a.attribute_type !== 'motivator')
  const echoCirc = builtAttributes.filter((a) => a.attribute_type === 'circumstance')
  const echoMot = builtAttributes.filter((a) => a.attribute_type === 'motivator')
  // Detect attributes auto-attached by story seeds. The backend's
  // `apply_seeds_to_entity` runs before the entity is persisted and
  // adds seed attributes silently — the response carries them on
  // `result.entity.attributes` alongside the caller-passed ones. The
  // freeform v7 blind-agent test caught this as a discoverability
  // gap: a "Gender" preset seed was auto-attached to every character
  // and the agent never knew. Compare the input attribute id set to
  // the post-create id set; anything new came from seeds. Surface as
  // structured objects per the v8 follow-up — each entry has the
  // human-readable `message` (so a log surface or chat-like UI can
  // print it directly) AND the structured fields (`attribute_id`,
  // `attribute_name`, `attribute_type`) so an agent can act on the
  // seed-attached attribute (e.g. immediately update its value via
  // `update_attributes`) without having to follow up with `get_entity`.
  const builtAttrIds = new Set(builtAttributes.map((a) => a.id))
  const postAttrs = (result.entity.attributes || []).filter(
    (a) => a && a.id && !builtAttrIds.has(a.id),
  )
  const seedsApplied = postAttrs.map((a) => {
    const aName = a.name || '(unnamed)'
    const aType = a.attribute_type || 'text'
    const eName = result.entity.name || '(unnamed)'
    return {
      attribute_id: a.id,
      attribute_name: aName,
      attribute_type: aType,
      entity_type: result.entity.type,
      entity_name: eName,
      message: `seed automatically created attribute '${aName}' on ${result.entity.type} '${eName}'`,
    }
  })
  return {
    id: result.entity.id,
    type: result.entity.type,
    name: result.entity.name,
    entity_node_id: result.entity_node.id,
    ...(echoAttrs.length > 0 ? { attributes: echoAttrs.map(_projectAttribute) } : {}),
    ...(echoCirc.length > 0 ? { circumstances: echoCirc.map(_projectAttribute) } : {}),
    ...(echoMot.length > 0 ? { motivators: echoMot.map(_projectAttribute) } : {}),
    ...(builtAliases.length > 0 ? { aliases: builtAliases.map((a) => a.value) } : {}),
    ...(seedsApplied.length > 0 ? { seeds_applied: seedsApplied } : {}),
  }
})

// ── Wave 2: update_entity ───────────────────────────────────────────────
// Unified update tool — handles BOTH the entity's baseline (origin)
// AND scene-anchored chain entries through one call shape. The `at`
// argument selects the anchor:
//
//   - omitted / null / "" / "origin" → BASELINE write at the
//     entity's origin. Per the project's scene-aware rule, this IS
//     the scene-aware path because the entity is its own origin for
//     these baseline fields — there is no prior scene-anchored change to walk
//     back to, and the chain explicitly does not record changes at
//     origin. Routes through `useEntitiesStore.getState().updateEntity`,
//     the SAME Zustand action that EntityDetailView uses on the
//     `isOrigin` branch.
//
//   - scene UUID or exact (case-insensitive) scene title → CHAIN
//     ENTRY write on the entity's chip in that scene. Each
//     supported field maps to its EntityRef `*_change` slot (e.g.
//     `name` → `name_change`). The scene resolver reads these on every
//     subsequent walk and applies them from this scene forward.
//     Routes through `useProjectStore.getState().updateEntityRef`,
//     the SAME action used by the per-chip edit affordances. If the
//     entity isn't already chipped in the scene, AUTO-CHIPS it
//     first via `addEntityChipToNode(..., { skipUpstreamConfirm: true })`.
//
// Field validity differs per anchor (see _validateUpdateEntityFields).
// notes / parent_id / category_id are origin-only because they're
// not scene-tracked; attributes and has_pov go through their own
// dedicated tools. Everything else (name / description / colour /
// profile_image_ref / aliases) is settable at either anchor.

function _normaliseAliasesInput(value) {
  if (!Array.isArray(value)) {
    throw new Error('aliases must be an array of strings')
  }
  return value
    .map((a) => (typeof a === 'string' ? { value: a.trim() } : a))
    .filter((a) => a && a.value)
}

registerMcpTool('update_entity', async (args) => {
  const { entity, type } = _resolveEntity(args?.entity)
  const at = args?.at

  // Branch on anchor. An empty / null / "origin" `at` means
  // baseline write; anything else is a scene reference.
  const isOriginPath = !at || at === 'origin'

  if (isOriginPath) {
    // ─── ORIGIN PATH (baseline write) ────────────────────────────
    // The entity IS its own origin for these baseline fields, so
    // writing baseline directly is the scene-aware path per the
    // project's scene-tracked-field convention.

    // Option F — track_as_knowledge requires a scene anchor (a chain
    // event to anchor the Knowledge against). Baseline edits don't
    // produce a chain event; reject cleanly with the workaround.
    if (args?.track_as_knowledge !== undefined && args?.track_as_knowledge !== null) {
      throw new Error(
        `track_as_knowledge requires a scene anchor (pass \`at=<scene>\`). ` +
        `Baseline edits at the entity's origin don't produce a chain event ` +
        `that a Knowledge can anchor to.`
      )
    }

    // The args come through the MCP server's strictly-typed tool
    // signature, which only forwards declared params (`category` /
    // `parent` post-v0.2.1.141 rename). See create_entity for the
    // rename rationale.
    const parentPassed = Object.prototype.hasOwnProperty.call(args, 'parent')
    const categoryPassed = Object.prototype.hasOwnProperty.call(args, 'category')
    const parentArg = parentPassed ? args.parent : undefined
    const categoryArg = categoryPassed ? args.category : undefined

    // Type-specific arg validation only relevant at origin.
    if (parentPassed && type !== 'location') {
      throw new Error(
        `parent can only be set on 'location' entities. ` +
        `Resolved entity '${entity.name}' is type '${type}'.`
      )
    }
    if (categoryPassed && type !== 'custom') {
      throw new Error(
        `category can only be set on 'custom' entities. ` +
        `Resolved entity '${entity.name}' is type '${type}'.`
      )
    }

    // Partial merge: spread current baseline, override only the
    // fields the AI passed. Same merge shape as the UI's baseline
    // edit handlers in `EntityDetailView`.
    const updated = { ...entity }
    if (args.name !== undefined) {
      const trimmed = String(args.name).trim()
      if (!trimmed) throw new Error('name cannot be empty')
      updated.name = trimmed
    }
    if (args.description !== undefined) updated.description = String(args.description)
    if (args.colour !== undefined) {
      _validateHexColour(args.colour, 'colour')
      updated.colour = String(args.colour)
    }
    if (args.profile_image_ref !== undefined) {
      updated.profile_image_ref = args.profile_image_ref === '' ? null : String(args.profile_image_ref)
    }
    if (args.notes !== undefined) updated.notes = String(args.notes)
    // awareness_scale is a whole-entity presentation setting (binary/full),
    // not scene-tracked — it lives on the baseline like notes.
    if (args.awareness_scale !== undefined) updated.awareness_scale = args.awareness_scale
    if (args.aliases !== undefined) updated.aliases = _normaliseAliasesInput(args.aliases)
    if (parentPassed) {
      // Polymorphic ref: UUID or location-entity name. Empty / null
      // clears the parent. Non-empty values are resolved through the
      // entity resolver (with location type-hint), reject-on-missing
      // per D1.
      if (parentArg === null || parentArg === '') {
        updated.parent_id = null
      } else {
        const parent = _resolveEntity(parentArg, 'location')
        updated.parent_id = parent.entity.id
      }
    }
    if (categoryPassed) {
      // Polymorphic ref: UUID or custom-category name. Reject-on-missing
      // per D1.
      updated.category_id = _resolveCustomCategoryId(categoryArg)
    }

    const result = await useEntitiesStore.getState().updateEntity(entity.id, updated)
    // Return shape mirrors get_entity origin-path: grouped projection +
    // scene_id: null + chain_resolution: null. Surfaced 2026-05-18 in
    // the self-test pass — get_entity and update_entity should agree
    // on the same shape for the same anchor.
    return {
      ..._projectEntity(result, type),
      scene_id: null,
      chain_resolution: null,
    }
  }

  // ─── SCENE PATH (scene-anchored change write) ────────────────────────────
  // Anchor is a scene downstream of origin (or potentially the
  // entity's origin scene if the entity was scene-born — either way
  // the scene is NOT the entity's origin since entities have their
  // own origin EntityNode separate from any scene). Writes go
  // through a scene-anchored change on the EntityRef, NOT to baseline.
  const sceneNode = _resolveScene(at)

  // Reject origin-only fields at the scene anchor — these are not
  // scene-tracked and have no `*_change` slot on EntityRef.
  for (const k of ['notes', 'awareness_scale', 'parent_id', 'category_id']) {
    if (args[k] !== undefined) {
      throw new Error(
        `Field '${k}' can only be set with at='origin' (or omitted). ` +
        `It's not scene-tracked, so there's no scene-anchored ` +
        `equivalent. Use a separate update_entity call without ` +
        `'at' to set this on the baseline.`
      )
    }
  }

  // Build the EntityRef changes payload. Each scene-tracked field
  // the AI passed maps to its `*_change` slot; passing the field
  // explicitly with a value records the change at this scene,
  // which the walker reads on every subsequent walk. NOT setting
  // a field leaves any existing change on this scene's chip
  // untouched (we don't want to clear pre-existing edits the user
  // may have set).
  const changes = {}
  let touchedAny = false
  if (args.name !== undefined) {
    const trimmed = String(args.name).trim()
    if (!trimmed) throw new Error('name cannot be empty')
    changes.name_change = trimmed
    touchedAny = true
  }
  if (args.description !== undefined) {
    changes.description_change = String(args.description)
    touchedAny = true
  }
  if (args.colour !== undefined) {
    _validateHexColour(args.colour, 'colour')
    changes.colour_change = String(args.colour)
    touchedAny = true
  }
  if (args.profile_image_ref !== undefined) {
    // Empty string clears the scene-anchored change's image override; the
    // walker treats this as "image cleared from this scene
    // forward". Non-empty string sets it.
    changes.profile_image_change = args.profile_image_ref === '' ? '' : String(args.profile_image_ref)
    touchedAny = true
  }
  if (args.aliases !== undefined) {
    // Per-event `alias_changes` model (post v0.2.1.76). The MCP arg
    // is a full desired list; convert to per-event by diffing against
    // the entity's effective alias state JUST BEFORE this scene's own
    // contribution. Same diff shape the editor's `saveEntityChipDraft`
    // uses: `add` events for values in the new list but not upstream,
    // `remove` events (by alias_id) for values upstream but not in the
    // new list. Value-only diff — alias `modify` (renaming an existing
    // alias) is not expressible through this full-list arg shape;
    // callers wanting to rename should use a dedicated `update_alias`
    // tool when it ships.
    const proposed = _normaliseAliasesInput(args.aliases)
    const ps = useProjectStore.getState()
    const allNodes = ps.nodes || []
    const allEdges = ps.edges || []
    // Compute upstream effective state by walking the chain to this
    // scene with this entity's own contribution at this scene blanked
    // out — mirrors the editor's save-handler diff to avoid double-
    // counting events already on the ref.
    const upstreamNodes = allNodes.map((n) => {
      if (n.id !== sceneNode.id || n.type !== 'sceneNode') return n
      const newData = { ...n.data }
      for (const bucket of ENTITY_BUCKETS) {
        const refs = newData[bucket] || []
        const idx = refs.findIndex((r) => r.entity_id === entity.id)
        if (idx !== -1) {
          newData[bucket] = refs.map((r, i) =>
            i === idx ? { ...r, alias_changes: [] } : r,
          )
          break
        }
      }
      return { ...n, data: newData }
    })
    const upstreamEff = computeEffectiveState(entity, upstreamNodes, allEdges, sceneNode.id)
    const upstreamAliases = Array.isArray(upstreamEff?.aliases) ? upstreamEff.aliases : []
    const upstreamByValue = new Map()
    for (const a of upstreamAliases) {
      if (typeof a === 'string' || !a) continue
      if (a.value && a.id) upstreamByValue.set(a.value, a)
    }
    const proposedByValue = new Map()
    for (const a of proposed) {
      if (a?.value) proposedByValue.set(a.value, a)
    }
    const events = []
    // Remove events: in upstream, missing from proposed.
    for (const [value, upstreamAlias] of upstreamByValue) {
      if (!proposedByValue.has(value)) {
        events.push({
          id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
          action: 'remove',
          alias_id: upstreamAlias.id,
        })
      }
    }
    // Add events: in proposed, missing from upstream.
    for (const [value, proposedAlias] of proposedByValue) {
      if (!upstreamByValue.has(value)) {
        const newAliasId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
        events.push({
          id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
          action: 'add',
          alias: {
            id: newAliasId,
            value,
            awareness: proposedAlias.awareness ?? null,
          },
        })
      }
    }
    changes.alias_changes = events
    touchedAny = true
  }

  if (!touchedAny) {
    throw new Error(
      "no scene-tracked field provided. At a scene anchor, you must " +
      "pass at least one of: name, description, colour, " +
      "profile_image_ref, aliases."
    )
  }

  // Option F — pre-validate `track_as_knowledge`. Must be string OR
  // `{name, ...}` object. Tracking requires the call to record exactly
  // ONE scalar chain event (the SourceEventRef points at a single
  // event). Multi-field calls (e.g. name + description in the same
  // update_entity) plus tracking surface a clean error asking the AI
  // to split the call.
  const trackArg = args.track_as_knowledge
  if (trackArg !== undefined && trackArg !== null) {
    const scalarFields = ['name', 'description', 'colour', 'profile_image_ref']
    const touchedScalars = scalarFields.filter((k) => args[k] !== undefined)
    if (touchedScalars.length === 0) {
      throw new Error(
        `track_as_knowledge requires exactly one scalar field change ` +
        `(name / description / colour / profile_image_ref). This call ` +
        `passed only aliases; alias-tracking isn't supported via this tool ` +
        `— use the per-alias tools when track_as_knowledge ships there.`
      )
    }
    if (touchedScalars.length > 1) {
      throw new Error(
        `track_as_knowledge requires exactly one scalar field change per ` +
        `call (the Knowledge anchors to one chain event). This call touches ` +
        `${touchedScalars.length} fields: ${touchedScalars.join(', ')}. Split ` +
        `into separate update_entity calls and pass track_as_knowledge on the ` +
        `one you want to anchor.`
      )
    }
    if (args.aliases !== undefined) {
      throw new Error(
        `track_as_knowledge cannot be combined with aliases in the same ` +
        `update_entity call. Split aliases into a separate call.`
      )
    }
    // Pre-resolve when string (D1 reject-on-missing happens upfront).
    if (typeof trackArg === 'string') _resolveKnowledge(trackArg)
    // Shape check for object form.
    else if (typeof trackArg === 'object' && !Array.isArray(trackArg)) {
      if (!(trackArg.name || '').trim()) {
        throw new Error('track_as_knowledge.name is required when creating a new Knowledge.')
      }
    } else {
      throw new Error(
        `track_as_knowledge must be a string (existing Knowledge UUID / name) ` +
        `or an object { name, description?, colour?, awareness_scale? }.`
      )
    }
  }

  // Auto-chip the entity to the scene if not already chipped. The
  // chip-add is idempotent (early-returns if already present); the
  // skipUpstreamConfirm flag suppresses the user-facing connect-
  // wire dialog that would otherwise interrupt the AI flow. D2
  // auto-wire runs separately below so the chip lands wired into
  // the entity's chain (not orphaned).
  const buckets = ['characters', 'locations', 'items', 'factions', 'customs']
  const wasAlreadyChipped = buckets.some((b) =>
    (sceneNode.data?.[b] || []).some((r) => r.entity_id === entity.id),
  )
  useProjectStore.getState().addEntityChipToNode(
    sceneNode.id,
    entity.id,
    { skipUpstreamConfirm: true },
  )
  if (!wasAlreadyChipped) {
    try {
      await useProjectStore.getState()._autoConnectUpstreamForChain(sceneNode.id, entity.id)
    } catch (err) {
      throw new Error(`update_entity auto-wire failed: ${err.message}`)
    }
  }

  // Record the scene-anchored change on the chip's EntityRef. The walker
  // picks up `*_change` fields on every subsequent walk past this
  // scene.
  useProjectStore.getState().updateEntityRef(sceneNode.id, entity.id, changes)

  // Option F — apply knowledge tracking AFTER the change has landed
  // (the EntityRef now has a `scalar_change_ids[field]` entry whose
  // UUID is the change's stable id). Read it back to build the
  // SourceEventRef pointer.
  let trackingKnowledgeId = null
  if (trackArg !== undefined && trackArg !== null) {
    const scalarFieldMap = {
      name: 'name_change',
      description: 'description_change',
      colour: 'colour_change',
      profile_image_ref: 'profile_image_change',
    }
    const touchedKey = ['name', 'description', 'colour', 'profile_image_ref'].find((k) => args[k] !== undefined)
    const refField = scalarFieldMap[touchedKey]
    const postState = useProjectStore.getState()
    const postSceneNode = postState.nodes.find((n) => n.id === sceneNode.id)
    const postRef = ENTITY_BUCKETS
      .map((b) => (postSceneNode?.data?.[b] || []).find((r) => r.entity_id === entity.id))
      .find(Boolean)
    const changeId = postRef?.scalar_change_ids?.[refField] || null
    if (!changeId) {
      throw new Error(
        `track_as_knowledge: failed to locate change_id for field '${refField}' on ` +
        `the post-change EntityRef. This shouldn't happen — please report.`
      )
    }
    const sourceEventRef = {
      event_type: 'entity_ref_scalar',
      change_id: changeId,
      node_id: sceneNode.id,
      entity_id: entity.id,
      field: refField,
    }
    trackingKnowledgeId = await _applyKnowledgeTracking(trackArg, sourceEventRef)
  }

  // Return the scene-resolved entity AT this scene, so the AI sees
  // the final effective state after its change. Same shape as
  // `get_entity_at_scene`.
  const projectStore = useProjectStore.getState()
  const nodes = projectStore.nodes || []
  const edges = projectStore.edges || []
  const storyOrder = computeStoryOrder({ nodes, edges })
  const effective = computeEffectiveState(entity, nodes, edges, sceneNode.id, { storyOrder })

  // Project the chain-resolved attributes through the SAME grouped
  // helper `get_entity(at=)` uses, and surface the same
  // `chain_resolution` provenance block — keeps the two tools'
  // scene-path response shapes identical so clients don't have to
  // remember which tool returns which shape. Surfaced 2026-05-18 in
  // the self-test pass.
  const grouped = _projectAndGroupAttributes(effective.attributes)
  const chainResolution = _computeChainResolutionMeta(entity, nodes, edges, sceneNode.id)
  return {
    id: entity.id,
    type,
    origin_node_id: _entityOriginNode(entity.id)?.id || null,
    scene_id: sceneNode.id,
    scene_title: sceneNode.data?.title || '',
    name: effective.name || '',
    colour: effective.colour || null,
    description: effective.description || '',
    profile_image_ref: effective.profile_image_ref || null,
    notes: entity.notes || '',
    aliases: (effective.aliases || []).map((a) => (typeof a === 'string' ? a : a?.value)).filter(Boolean),
    attributes: grouped.attributes,
    circumstances: grouped.circumstances,
    motivators: grouped.motivators,
    chain_resolution: chainResolution,
    ...(type === 'location' && entity.parent_id ? { parent_id: entity.parent_id } : {}),
    ...(type === 'custom' && entity.category_id ? { category_id: entity.category_id } : {}),
    ...(trackingKnowledgeId ? { tracking_knowledge_id: trackingKnowledgeId } : {}),
  }
})


// ── Attribute write tools (origin path; scene path lands in a
// follow-up commit) ────────────────────────────────────────────────────
//
// Each tool follows the unified `at?` parameter pattern established
// in v0.2.1.49. For attributes specifically:
//
//   - at = "origin" (or omitted) — operates on the entity's
//     BASELINE attributes list. For ADD: the new attribute IS its
//     own origin (it's just being created), so writing baseline is
//     the scene-aware path (origin is the one place baseline is
//     correct). For UPDATE: same — modifying an
//     attribute that lives at the entity's baseline IS at the
//     attribute's origin. For REMOVE: routes through deleteObject
//     ('attribute', id), the project's centralised attribute-delete
//     dispatcher.
//
//   - at = scene reference — would record a scene-anchored change on the
//     entity's chip in that scene (`attribute_changes[].action =
//     'add' | 'modify' | 'remove'`). NOT YET IMPLEMENTED here;
//     handler returns a clear "not yet implemented" error so the
//     AI knows to stick with origin operations until the follow-up
//     commit lands the scene-anchored variants.
//
// All routes go through existing Zustand actions:
//   - origin add / update → useEntitiesStore.updateEntity (the same
//     path EntityModal uses when the user adds / edits attributes
//     at the origin EntityNode)
//   - origin remove → useProjectStore.deleteObject('attribute', id)
//     (the project's canonical scene-aware attribute-delete dispatcher
//     that strips chain entries referencing the attribute id across
//     every scene's EntityRef.attribute_changes)

/** Append AliasChange entries to a chip's `alias_changes` list and
 *  write back via updateEntityRef. Auto-chips the entity to the scene
 *  first if not already chipped (skipUpstreamConfirm so no user dialog
 *  mid-tool-call). Mirrors `_appendAttributeChainEntries`'s shape for
 *  consistency with the per-attribute pattern. */
async function _appendAliasChainEntries(sceneNode, entityId, newEntries) {
  const buckets = ['characters', 'locations', 'items', 'factions', 'customs']
  const wasAlreadyChipped = buckets.some((b) =>
    (sceneNode.data?.[b] || []).some((r) => r.entity_id === entityId),
  )
  useProjectStore.getState().addEntityChipToNode(
    sceneNode.id,
    entityId,
    { skipUpstreamConfirm: true },
  )
  if (!wasAlreadyChipped) {
    try {
      await useProjectStore.getState()._autoConnectUpstreamForChain(sceneNode.id, entityId)
    } catch (err) {
      throw new Error(`alias write auto-wire failed: ${err.message}`)
    }
  }

  // Read current chip state to merge with existing alias_changes
  const currentNodes = useProjectStore.getState().nodes
  const currentScene = currentNodes.find((n) => n.id === sceneNode.id)
  let currentRef = null
  for (const bucket of buckets) {
    const refs = currentScene?.data?.[bucket] || []
    const found = refs.find((r) => r.entity_id === entityId)
    if (found) { currentRef = found; break }
  }
  const existing = currentRef?.alias_changes || []
  useProjectStore.getState().updateEntityRef(sceneNode.id, entityId, {
    alias_changes: [...existing, ...newEntries],
  })
}

/** Collect every alias that exists anywhere in the entity's narrative
 *  chain — baseline aliases PLUS every `AliasChange(action='add')`
 *  event on any EntityNode (origin or modifier) or EntityRef along
 *  the chain — de-duplicated by alias.id, preferring the most-recent
 *  value when `modify` events have renamed it. Used as a fallback for
 *  `_resolveAlias` so the resolver can find an alias added via the
 *  per-event chain mechanism even when the requested scene anchor
 *  doesn't have the entity chipped (the scene-effective walker can't
 *  reach scenes the entity isn't wired through).
 *
 *  Returns an array of `{ id, value, awareness }` objects mirroring
 *  the shape `_resolveAlias` expects. Order: baseline aliases first
 *  (in their `entity.aliases` order), then chain-added aliases in
 *  the order their `add` events appear when walking the chain from
 *  origin outward. */
function _aliasesAcrossEntityChain(entity) {
  if (!entity) return []
  const projectStore = useProjectStore.getState()
  const nodes = projectStore.nodes || []
  const edges = projectStore.edges || []
  const collected = []   // [{id, value, awareness}, ...] in encounter order
  const byId = new Map() // id → index into collected
  // 1) Baseline aliases first.
  for (const a of (entity.aliases || [])) {
    const obj = (typeof a === 'string')
      ? { id: null, value: a, awareness: null }
      : { id: a?.id || null, value: a?.value || '', awareness: a?.awareness || null }
    if (!obj.value) continue
    if (obj.id) byId.set(obj.id, collected.length)
    collected.push(obj)
  }
  // 2) Walk the entity's narrative chain, harvesting `add` events from
  //    every chain stop's alias_changes (EntityNode origin / modifier
  //    OR plot-point-scene EntityRef bucket entry).
  const chain = getEntityNarrativeChain(entity.id, nodes, edges)
  for (const node of chain) {
    let aliasChanges = []
    if (node.type === 'entityNode') {
      aliasChanges = node.data?.alias_changes || []
    } else {
      for (const b of ENTITY_BUCKETS) {
        const ref = (node.data?.[b] || []).find((r) => r.entity_id === entity.id)
        if (ref) { aliasChanges = ref.alias_changes || []; break }
      }
    }
    for (const ev of aliasChanges) {
      if (!ev || typeof ev !== 'object') continue
      if (ev.action === 'add' && ev.alias?.id && ev.alias?.value) {
        if (byId.has(ev.alias.id)) continue
        const obj = { id: ev.alias.id, value: ev.alias.value, awareness: ev.alias.awareness || null }
        byId.set(obj.id, collected.length)
        collected.push(obj)
      } else if (ev.action === 'modify' && ev.alias_id && ev.new_value != null) {
        const idx = byId.get(ev.alias_id)
        if (idx != null) collected[idx] = { ...collected[idx], value: ev.new_value }
      } else if (ev.action === 'remove' && ev.alias_id) {
        // Keep the entry around so the resolver can still match by id
        // for awareness writes; the actual chain-walker decides whether
        // the alias is present at any given scene. Resolver's job is
        // "can I name this alias?" — yes, even after removal in some
        // downstream scene.
      }
    }
  }
  return collected
}

/** Resolve an alias reference (UUID or exact case-insensitive value)
 *  against either the entity's BASELINE aliases (origin path) or the
 *  scene-effective alias list at a given scene (scene path). Throws
 *  "not found" / "ambiguous" same shape as the other resolvers.
 *
 *  For the scene path, the resolver looks at the chain-walked alias
 *  list (which includes both baseline aliases that survived the chain
 *  AND chain-only aliases introduced via upstream `AliasChange.add`
 *  events), so the AI can reference either flavour by value or by
 *  UUID uniformly.
 *
 *  Final fallback: scan EVERY alias across the entity's full chain
 *  (`_aliasesAcrossEntityChain`) so an MCP client can reference an
 *  alias added at any scene anywhere in the chain — even when the
 *  current awareness anchor doesn't have the entity chipped through
 *  to that point. */
function _resolveAlias(entity, value, options = {}) {
  if (!entity) throw new Error('entity is required for alias resolution')
  if (!value || typeof value !== 'string') {
    throw new Error('alias reference is required (UUID or exact value)')
  }
  // `aliasesList` lets the scene path pass the chain-walked alias list
  // (computed via computeEffectiveState). Origin path defaults to
  // entity.aliases (baseline only).
  const aliases = options.aliasesList || entity.aliases || []
  const tryResolve = (list) => {
    if (_isUuid(value)) {
      const match = list.find((a) => (typeof a === 'object' && a?.id === value))
      if (match) return [match]
    }
    const valueLower = value.toLowerCase()
    return list.filter((a) => {
      const av = (typeof a === 'string') ? a : a?.value
      return av && av.toLowerCase() === valueLower
    }).map((a) => (typeof a === 'string' ? { id: null, value: a, awareness: null } : a))
  }
  let matches = tryResolve(aliases)
  // Fallback: scan the full chain (baseline + every chain-add event).
  // Covers the case where the alias was added at a scene the resolver's
  // primary list doesn't reach.
  if (matches.length === 0) {
    const chainWide = _aliasesAcrossEntityChain(entity)
    matches = tryResolve(chainWide)
  }
  if (matches.length === 0) {
    const where = options.sceneId
      ? `at scene '${options.sceneTitle || options.sceneId}' or anywhere in '${entity.name}'s chain`
      : `on entity '${entity.name}' baseline or anywhere in its chain`
    throw new Error(
      `alias not found ${where}: "${value}". Pass a UUID or exact (case-insensitive) value. ` +
      `Use get_entity (origin or at-scene via the at arg) to discover the alias list. ` +
      `If you need a new alias by this value, call add_alias first.`
    )
  }
  if (matches.length > 1) {
    const list = matches.map((a) => `"${a.value}" (id=${a.id || 'no-id'})`).join('; ')
    throw new Error(
      `ambiguous alias reference "${value}" on '${entity.name}' — ` +
      `${matches.length} matches: ${list}. Pass the UUID to disambiguate.`
    )
  }
  return matches[0]
}

/** Compute scene-resolved alias list for an entity at a scene anchor.
 *  Used by scene-path alias tools so the AI can reference an alias
 *  by value even if it was added by an upstream chain entry (not in
 *  the entity's baseline). */
function _aliasesAtScene(entity, sceneId) {
  const projectStore = useProjectStore.getState()
  const nodes = projectStore.nodes || []
  const edges = projectStore.edges || []
  const eff = computeEffectiveState(entity, nodes, edges, sceneId)
  return Array.isArray(eff?.aliases) ? eff.aliases : []
}

/** Auto-chip an entity to a scene if not already chipped, running the
 *  D2 upstream auto-wire so the chain links forward through this
 *  scene instead of leaving the chip orphaned. Idempotent: no-op when
 *  the entity is already chipped at the scene.
 *
 *  HOIST THIS BEFORE pre-validation that depends on the chain reaching
 *  the target scene (e.g. `_attributesAtScene` for attribute-resolution
 *  pre-validation). The scene-path remove / update flows used to call
 *  `_attributesAtScene` against an unchipped entity and threw a
 *  misleading "not reachable" error from `_resolveAttribute` — the
 *  attribute existed in the entity's chain history but the cleanup-
 *  target scene was downstream of the last scene the entity was chipped
 *  at, so the walker couldn't see the attribute as active there.
 *  Surfaced 2026-05-18 by the blind-agent rom-com v6 test (location
 *  cleanup at the morning-after scene that didn't include the location
 *  as a participant). */
async function _ensureEntityChipAtScene(sceneNode, entityId) {
  const buckets = ['characters', 'locations', 'items', 'factions', 'customs']
  const wasAlreadyChipped = buckets.some((b) =>
    (sceneNode.data?.[b] || []).some((r) => r.entity_id === entityId),
  )
  if (wasAlreadyChipped) return
  useProjectStore.getState().addEntityChipToNode(
    sceneNode.id,
    entityId,
    { skipUpstreamConfirm: true },
  )
  try {
    await useProjectStore.getState()._autoConnectUpstreamForChain(sceneNode.id, entityId)
  } catch (err) {
    throw new Error(`auto-wire failed for entity ${entityId} at scene '${sceneNode.data?.title || sceneNode.id}': ${err.message}`)
  }
}

/** Append AttributeChange entries to a chip's `attribute_changes`
 *  list and write back via updateEntityRef. Auto-chips the entity to
 *  the scene first if not already chipped (skipUpstreamConfirm so no
 *  user dialog mid-tool-call). */
async function _appendAttributeChainEntries(sceneNode, entityId, newEntries) {
  // Auto-chip + auto-wire if not already present (idempotent).
  await _ensureEntityChipAtScene(sceneNode, entityId)

  // Read current chip state to merge with existing attribute_changes
  const currentNodes = useProjectStore.getState().nodes
  const currentScene = currentNodes.find((n) => n.id === sceneNode.id)
  let currentRef = null
  for (const bucket of ['characters', 'locations', 'items', 'factions', 'customs']) {
    const refs = currentScene?.data?.[bucket] || []
    const found = refs.find((r) => r.entity_id === entityId)
    if (found) { currentRef = found; break }
  }
  const existing = currentRef?.attribute_changes || []
  useProjectStore.getState().updateEntityRef(sceneNode.id, entityId, {
    attribute_changes: [...existing, ...newEntries],
  })
}

/** Compute scene-resolved attribute list for an entity at a scene
 *  anchor. Used by scene-path attribute resolvers so the AI can
 *  reference attributes by names that came into existence via
 *  upstream `action='add'` chain entries. */
function _attributesAtScene(entity, sceneId) {
  const projectStore = useProjectStore.getState()
  const nodes = projectStore.nodes || []
  const edges = projectStore.edges || []
  const storyOrder = computeStoryOrder({ nodes, edges })
  const eff = computeEffectiveState(entity, nodes, edges, sceneId, { storyOrder })
  return eff?.attributes || []
}

/** Resolve a preset_list reference (UUID or exact name) to its id.
 *  Used by add_attribute/update_attribute when attribute_type is
 *  'preset'. Throws on not-found / ambiguous. */
/** Resolve a preset list reference (UUID or exact case-insensitive
 *  name) to its full preset_list object. Used by the preset_list CRUD
 *  tools and by any other tool that needs the full list (e.g. to read
 *  its current values). Throws on not-found / ambiguous with the
 *  standard D1 error shape. */
function _resolvePresetList(value) {
  if (!value || typeof value !== 'string') {
    throw new Error('preset_list reference is required (UUID or exact name)')
  }
  // Read from `entitiesStore.presetLists` — it's the live in-session
  // source that mutations (createPresetList / updatePresetList /
  // deletePresetList) write to directly. `story.preset_lists` is the
  // persisted shape (loaded from save, written on save) and lags
  // behind in-session mutations until the next save — checking it
  // first would miss preset lists created earlier in this MCP session.
  // Fall back to story.preset_lists only as a defensive belt-and-
  // suspenders for any environment where the entitiesStore hasn't
  // initialised yet.
  const lists = useEntitiesStore.getState().presetLists
    ?? useProjectStore.getState().story?.preset_lists ?? []
  if (_isUuid(value)) {
    const match = lists.find((l) => l.id === value)
    if (match) return match
  }
  const valueLower = value.toLowerCase()
  const matches = lists.filter((l) => (l.name || '').toLowerCase() === valueLower)
  if (matches.length === 0) {
    throw new Error(
      `preset_list not found: "${value}". Pass a UUID or exact ` +
      `(case-insensitive) name. Call create_preset_list(name=...) ` +
      `to mint a new one if needed.`
    )
  }
  if (matches.length > 1) {
    throw new Error(
      `ambiguous preset_list "${value}" — ${matches.length} matches. ` +
      `Pass the UUID to disambiguate.`
    )
  }
  return matches[0]
}

function _resolvePresetListId(value) {
  return _resolvePresetList(value).id
}

/** Project a preset list for MCP return shapes. */
function _projectPresetList(list) {
  return {
    id: list.id,
    name: list.name || '',
    values: Array.isArray(list.values) ? [...list.values] : [],
  }
}

// ── Project Tag resolver + projector ─────────────────────────────────────
//
// Project Tags are flat pool entries `{ id, name, color }` stored at
// the story level (`Story.project_tags`). MCP exposes them as the
// single "tag" surface — Program Tags (per-host strings on Context
// Cues + Conversations) are NOT exposed via MCP (per Phase 3.4 design
// note), so the helpers below don't need a pool discriminator.
function _resolveTag(value) {
  if (!value || typeof value !== 'string') {
    throw new Error('tag reference is required (UUID or exact name)')
  }
  // Same source-priority as `_resolvePresetList`: live entitiesStore
  // first (reflects in-session mutations from create_tag / update_tag),
  // story.project_tags as defensive fallback.
  const pool = useEntitiesStore.getState().projectTags
    ?? useProjectStore.getState().story?.project_tags ?? []
  // Name lookups strip a leading `#` so callers can pass `#magic` or
  // `magic` interchangeably (same normalisation the frontend
  // `ProjectTagPicker` applies).
  const stripped = value.replace(/^#+/, '').trim()
  if (_isUuid(stripped)) {
    const match = pool.find((t) => t.id === stripped)
    if (match) return match
  }
  const lower = stripped.toLowerCase()
  const matches = pool.filter((t) => (t.name || '').toLowerCase() === lower)
  if (matches.length === 0) {
    throw new Error(
      `tag not found: "${value}". Pass a UUID or exact (case-insensitive) ` +
      `name. Call create_tag(name=...) to mint a new one if needed.`
    )
  }
  if (matches.length > 1) {
    throw new Error(
      `ambiguous tag "${value}" — ${matches.length} matches. ` +
      `Pass the UUID to disambiguate.`
    )
  }
  return matches[0]
}

/** Project a tag for MCP return shapes. */
function _projectTag(tag) {
  return {
    id: tag.id,
    name: tag.name || '',
    color: tag.color || '#888888',
  }
}

// ── Tag-host helpers (used by create_tag.attach_to + add_tags / remove_tags) ──
//
// Tag-carrying host kinds: character / location / item / faction /
// custom (all entities) + knowledge + relationship + referenceNode.
// Preset Lists are NOT a tag host (Phase 3.4f Item 6 descoped).
// Program Tag hosts (ContextCue / Conversation) aren't reachable from
// these helpers — they live behind a different store and are not
// exposed via MCP.

const _TAG_HOST_ENTITY_BUCKETS = ['characters', 'locations', 'items', 'factions', 'customs']
const _TAG_HOST_KIND_FROM_BUCKET = {
  characters: 'character',
  locations:  'location',
  items:      'item',
  factions:   'faction',
  customs:    'custom',
}

/** Resolve a host ref (UUID or name) across all tag-carrying host
 *  pools. Returns `{ kind, id, name, host }` on a unique match;
 *  throws "not found" / "ambiguous" with attribution otherwise. The
 *  `host` field is the raw store object (entity / knowledge /
 *  relationship row, or canvas-node object for referenceNode). */
function _resolveHostForTag(value) {
  if (!value || typeof value !== 'string') {
    throw new Error('host reference is required (UUID or exact name)')
  }
  const entitiesState = useEntitiesStore.getState()
  const projectState = useProjectStore.getState()
  const knowledges = projectState.knowledges || []
  const relationships = projectState.relationships || []
  const nodes = projectState.nodes || []
  const matches = []

  if (_isUuid(value)) {
    for (const bucket of _TAG_HOST_ENTITY_BUCKETS) {
      for (const e of (entitiesState[bucket] || [])) {
        if (e.id === value) matches.push({ kind: _TAG_HOST_KIND_FROM_BUCKET[bucket], id: e.id, name: e.name || '', host: e })
      }
    }
    for (const k of knowledges) {
      if (k.id === value) matches.push({ kind: 'knowledge', id: k.id, name: k.name || '', host: k })
    }
    for (const r of relationships) {
      if (r.id === value) matches.push({ kind: 'relationship', id: r.id, name: r.name || '', host: r })
    }
    for (const n of nodes) {
      if (n.type === 'referenceNode' && n.id === value) {
        matches.push({ kind: 'referenceNode', id: n.id, name: n.data?.title || '', host: n })
      }
    }
  } else {
    const lower = value.toLowerCase()
    for (const bucket of _TAG_HOST_ENTITY_BUCKETS) {
      for (const e of (entitiesState[bucket] || [])) {
        if ((e.name || '').toLowerCase() === lower) {
          matches.push({ kind: _TAG_HOST_KIND_FROM_BUCKET[bucket], id: e.id, name: e.name || '', host: e })
        }
      }
    }
    for (const k of knowledges) {
      if ((k.name || '').toLowerCase() === lower) matches.push({ kind: 'knowledge', id: k.id, name: k.name || '', host: k })
    }
    for (const r of relationships) {
      if ((r.name || '').toLowerCase() === lower) matches.push({ kind: 'relationship', id: r.id, name: r.name || '', host: r })
    }
    for (const n of nodes) {
      if (n.type === 'referenceNode' && (n.data?.title || '').toLowerCase() === lower) {
        matches.push({ kind: 'referenceNode', id: n.id, name: n.data?.title || '', host: n })
      }
    }
  }

  if (matches.length === 0) {
    throw new Error(
      `host not found: "${value}". Pass a UUID or exact (case-insensitive) ` +
      `name. Tag-carrying host kinds: character / location / item / faction / ` +
      `custom / knowledge / relationship / referenceNode.`
    )
  }
  if (matches.length > 1) {
    const summary = matches.map((m) => `${m.kind}:${m.name || '(unnamed)'}`).join(', ')
    throw new Error(
      `ambiguous host "${value}" — ${matches.length} matches (${summary}). ` +
      `Pass the UUID to disambiguate.`
    )
  }
  return matches[0]
}

/** Attach `tagId` to `resolvedHost` at the supplied anchor.
 *
 *  `atNodeId` routes baseline vs chain:
 *    - null / 'origin' → baseline write on the host's `tag_ids`.
 *    - scene UUID/title-resolved node id → chain `add@N` event on
 *      the host's chain-event carrier (EntityRef.tag_changes /
 *      knowledge.history.tag_changes / relationship.history.tag_changes
 *      / modifier-EntityNode.data.tag_changes). For entity hosts at
 *      a scene anchor, auto-adds the entity chip to the scene with
 *      D2 auto-wire if not already present (mirrors the alias path
 *      via `_appendAliasChainEntries`).
 *    - any non-null on a referenceNode host → throws (reference nodes
 *      are baseline-only; no chain).
 *
 *  Idempotent on already-attached at the resolved anchor:
 *    - Baseline: short-circuits when `tagId` is already in the host's
 *      baseline `tag_ids`.
 *    - Chain anchor: short-circuits when an existing `add@anchor` event
 *      for the same `tag_id` is already present on the carrier.
 *  Returns `{ already_attached: true }` on the short-circuit and
 *  `{ already_attached: false }` on a fresh attach.
 *
 *  For chain-anchor adds against an existing `remove@anchor` event:
 *  the underlying record-action's pair-cancel rule fires and strips
 *  both events. Caller observes `already_attached: false` because the
 *  effective result is "tag was-not-effective at anchor, now-is".
 */
async function _attachTagToHost(resolvedHost, tagId, atNodeId) {
  const { kind, id, host } = resolvedHost
  if (kind === 'referenceNode') {
    if (atNodeId) {
      throw new Error(
        `Reference Nodes are baseline-only (no chain). Drop the \`at\` arg ` +
        `or address this host by another kind if you need chain-anchor writes.`
      )
    }
    const existing = host.data?.tag_ids || []
    if (existing.includes(tagId)) return { already_attached: true }
    useProjectStore.getState().updateNodeData(id, { tag_ids: [...existing, tagId] })
    return { already_attached: false }
  }

  // Chain-trackable hosts. Compute already_attached BEFORE writing so
  // the caller can report idempotent state correctly. The check shape
  // depends on the anchor:
  //   - atNodeId === null → baseline check against host.tag_ids
  //   - atNodeId !== null → chain check for an existing add@anchor on
  //     the right carrier (EntityRef / knowledge.history /
  //     relationship.history / modifier-EntityNode)
  let alreadyAttached = false
  if (!atNodeId) {
    alreadyAttached = (host.tag_ids || []).includes(tagId)
  } else if (kind === 'knowledge') {
    alreadyAttached = (host.history?.tag_changes || []).some(
      (ev) => ev?.node_id === atNodeId && ev?.tag_id === tagId && ev?.action === 'add'
    )
  } else if (kind === 'relationship') {
    alreadyAttached = (host.history?.tag_changes || []).some(
      (ev) => ev?.node_id === atNodeId && ev?.tag_id === tagId && ev?.action === 'add'
    )
  } else {
    // Entity at chain anchor — has-event check needs the live nodes
    // because the carrier is on the scene's EntityRef or on a modifier
    // EntityNode, not on the entity row itself.
    const projectNodes = useProjectStore.getState().nodes || []
    const anchorNode = projectNodes.find((n) => n.id === atNodeId)
    if (anchorNode?.type === 'sceneNode') {
      const buckets = ['characters', 'locations', 'items', 'factions', 'customs']
      for (const bk of buckets) {
        const ref = (anchorNode.data?.[bk] || []).find((r) => r.entity_id === id)
        if (ref) {
          alreadyAttached = (ref.tag_changes || []).some(
            (ev) => ev?.tag_id === tagId && ev?.action === 'add'
          )
          break
        }
      }
    } else if (anchorNode?.type === 'entityNode' && anchorNode.data?.is_modifier && anchorNode.data?.entity_id === id) {
      alreadyAttached = (anchorNode.data?.tag_changes || []).some(
        (ev) => ev?.tag_id === tagId && ev?.action === 'add'
      )
    }
  }
  if (alreadyAttached) return { already_attached: true }

  // Auto-add-to-scene for entity hosts at a scene anchor. Mirrors
  // `_appendAliasChainEntries` — adds the chip via `addEntityChipToNode`
  // with `skipUpstreamConfirm` and runs D2 auto-wire when the entity
  // wasn't already chipped at this scene. Knowledge / relationship
  // chain events don't need this since their history lives on the host
  // itself, not on a scene-node bucket.
  if (atNodeId && (kind === 'character' || kind === 'location' || kind === 'item' || kind === 'faction' || kind === 'custom')) {
    const projectStore = useProjectStore.getState()
    const sceneNode = (projectStore.nodes || []).find((n) => n.id === atNodeId)
    if (sceneNode?.type === 'sceneNode') {
      const buckets = ['characters', 'locations', 'items', 'factions', 'customs']
      const wasAlreadyChipped = buckets.some((b) =>
        (sceneNode.data?.[b] || []).some((r) => r.entity_id === id),
      )
      projectStore.addEntityChipToNode(atNodeId, id, { skipUpstreamConfirm: true })
      if (!wasAlreadyChipped) {
        try {
          await useProjectStore.getState()._autoConnectUpstreamForChain(atNodeId, id)
        } catch (err) {
          throw new Error(`add_tags auto-wire failed: ${err.message}`)
        }
      }
    }
  }

  // Dispatch to the appropriate record-action.
  if (kind === 'character' || kind === 'location' || kind === 'item' || kind === 'faction' || kind === 'custom') {
    await useProjectStore.getState().recordEntityTagChange(id, 'add', tagId, atNodeId)
  } else if (kind === 'knowledge') {
    useProjectStore.getState().recordKnowledgeTagChange(id, 'add', tagId, atNodeId)
  } else if (kind === 'relationship') {
    useProjectStore.getState().recordRelationshipTagChange(id, 'add', tagId, atNodeId)
  } else {
    throw new Error(`unsupported host kind for tag attach: "${kind}"`)
  }
  return { already_attached: false }
}

/** Auto-cleanup helper: if `tagId` is no longer referenced by ANY
 *  host (baseline or chain), strip it from the pool via the canonical
 *  `deleteObject('projectTag', id)` dispatcher. Called from
 *  `_detachTagFromHost` after every successful detach so a tag's
 *  `>0 → 0` host-count transition silently removes the pool entry
 *  (locked Phase 3.4g Line 3 design — "scrap the popup, auto-cleanup
 *  is the default behaviour"). Returns `true` when the cleanup
 *  fired, `false` otherwise.
 *
 *  Frontend chip-`×` detach paths and host-deletion cascade-strip
 *  paths are intentionally NOT covered by this helper yet — they get
 *  their own integration in the cross-cutting auto-cleanup ToDo
 *  entry under Phase 3.4 Bugs & Fixes. */
async function _maybeCleanupOrphanedTag(tagId) {
  if (!tagId) return false
  const affected = _collectAffectedHostsForTag(tagId)
  if (affected.length > 0) return false
  await useProjectStore.getState().deleteObject('projectTag', tagId)
  return true
}

/** Detach `tagId` from `resolvedHost` at the supplied anchor.
 *  Mirror of `_attachTagToHost`. Idempotent on was-not-attached:
 *  returns `{ was_attached: false }` without writing when the tag
 *  isn't present at the resolved anchor. On successful detach,
 *  invokes `_maybeCleanupOrphanedTag(tagId)` so the pool entry is
 *  stripped if this detach dropped the host count to zero. */
async function _detachTagFromHost(resolvedHost, tagId, atNodeId) {
  const { kind, id, host } = resolvedHost
  if (kind === 'referenceNode') {
    if (atNodeId) {
      throw new Error(
        `Reference Nodes are baseline-only (no chain). Drop the \`at\` arg ` +
        `or address this host by another kind if you need chain-anchor writes.`
      )
    }
    const existing = host.data?.tag_ids || []
    if (!existing.includes(tagId)) return { was_attached: false }
    useProjectStore.getState().updateNodeData(id, { tag_ids: existing.filter((t) => t !== tagId) })
    const pool_deleted = await _maybeCleanupOrphanedTag(tagId)
    return { was_attached: true, pool_deleted }
  }

  let wasAttached = false
  if (!atNodeId) {
    wasAttached = (host.tag_ids || []).includes(tagId)
  } else if (kind === 'knowledge') {
    wasAttached = (host.history?.tag_changes || []).some(
      (ev) => ev?.node_id === atNodeId && ev?.tag_id === tagId && ev?.action === 'add'
    )
  } else if (kind === 'relationship') {
    wasAttached = (host.history?.tag_changes || []).some(
      (ev) => ev?.node_id === atNodeId && ev?.tag_id === tagId && ev?.action === 'add'
    )
  } else {
    const projectNodes = useProjectStore.getState().nodes || []
    const anchorNode = projectNodes.find((n) => n.id === atNodeId)
    if (anchorNode?.type === 'sceneNode') {
      const buckets = ['characters', 'locations', 'items', 'factions', 'customs']
      for (const bk of buckets) {
        const ref = (anchorNode.data?.[bk] || []).find((r) => r.entity_id === id)
        if (ref) {
          wasAttached = (ref.tag_changes || []).some(
            (ev) => ev?.tag_id === tagId && ev?.action === 'add'
          )
          break
        }
      }
    } else if (anchorNode?.type === 'entityNode' && anchorNode.data?.is_modifier && anchorNode.data?.entity_id === id) {
      wasAttached = (anchorNode.data?.tag_changes || []).some(
        (ev) => ev?.tag_id === tagId && ev?.action === 'add'
      )
    }
  }
  if (!wasAttached) return { was_attached: false }

  // Auto-add-to-scene for entity hosts at a scene anchor (so the
  // remove event can land on the EntityRef even if the entity isn't
  // currently chipped). Same pattern as `_attachTagToHost` for adds.
  // Edge case: if wasAttached was computed false because the entity
  // isn't chipped, we never reach here. If they ARE chipped (current
  // path), no auto-add needed. So this block is effectively a no-op
  // for the remove case — the entity must already be chipped for
  // wasAttached to be true. Leaving the check off here.

  if (kind === 'character' || kind === 'location' || kind === 'item' || kind === 'faction' || kind === 'custom') {
    await useProjectStore.getState().recordEntityTagChange(id, 'remove', tagId, atNodeId)
  } else if (kind === 'knowledge') {
    useProjectStore.getState().recordKnowledgeTagChange(id, 'remove', tagId, atNodeId)
  } else if (kind === 'relationship') {
    useProjectStore.getState().recordRelationshipTagChange(id, 'remove', tagId, atNodeId)
  } else if (kind === 'referenceNode') {
    // Reference Node baseline path is handled by the early-return
    // block above — this branch is unreachable for refNode but kept
    // for kind-coverage symmetry with the attach path.
  } else {
    throw new Error(`unsupported host kind for tag detach: "${kind}"`)
  }

  // Auto-cleanup the pool entry if this detach left the tag with no
  // remaining hosts. Silent — no popup, no AI confirmation (per the
  // locked Phase 3.4g Line 3 design). The pool_deleted return flag
  // tells the caller whether cleanup fired.
  const pool_deleted = await _maybeCleanupOrphanedTag(tagId)
  return { was_attached: true, pool_deleted }
}

/** Back-compat shim: `_attachTagToHostAtOrigin` was the v0.3.4.34
 *  helper signature; `create_tag.attach_to` (origin-only by design)
 *  still uses this entry point. Forwards to the generic
 *  `_attachTagToHost` with atNodeId=null. */
async function _attachTagToHostAtOrigin(resolvedHost, tagId) {
  return _attachTagToHost(resolvedHost, tagId, null)
}

/** Walk the project pools and return `[{kind, id, name}, ...]` for
 *  every host that currently carries `tagId` at baseline OR via any
 *  chain `add` event. Used by `delete_tag` (cascade-strip summary)
 *  and `update_tag` (affected-host count). Mirrors
 *  `collectHostsForProjectTag` from `globalSearch.js` but yields
 *  resolved-name records instead of `kind:id` keys. */
function _collectAffectedHostsForTag(tagId) {
  // Thin wrapper around the shared `utils/projectTagHosts.js` walker.
  // Extracted in v0.3.4.49 so the frontend chip-`×` cleanup paths and
  // the host-deletion cascade-strip paths share one implementation
  // with the MCP `_maybeCleanupOrphanedTag` gate.
  const entitiesState = useEntitiesStore.getState()
  const projectState = useProjectStore.getState()
  return _utilCollectAffectedHostsForTag(tagId, {
    entities: entitiesState,
    knowledges: projectState.knowledges,
    relationships: projectState.relationships,
    nodes: projectState.nodes,
  })
}

/** Build a clean Attribute object from MCP-shaped per-type fields.
 *  Validates per type, fills auto-generated id, returns the dict
 *  ready to push into entity.attributes. */
// ── Attribute type inference helpers ────────────────────────────────────────
// The MCP attribute tools no longer require `attribute_type`: a valid value is
// the only hard requirement, and the type is inferred from what's supplied
// (see _inferAttributeType). `attribute_type` / `preset_list` remain optional
// overrides.

function _presetListByName(name) {
  if (!name || typeof name !== 'string') return null
  const lower = name.trim().toLowerCase()
  const lists = useProjectStore.getState().story?.preset_lists || []
  return lists.find((l) => (l.name || '').trim().toLowerCase() === lower) || null
}

function _valueOnPresetList(list, value) {
  if (!list || !Array.isArray(list.values)) return false
  const lower = String(value).trim().toLowerCase()
  return list.values.some((v) => String(v).trim().toLowerCase() === lower)
}

function _looksNumeric(v) {
  if (typeof v === 'number') return true
  if (typeof v !== 'string') return false
  const t = v.trim()
  return t !== '' && !Number.isNaN(Number(t))
}

/** Conservatively parse a scalar string into a list ONLY when it clearly reads
 *  as a short delimited list (e.g. "Elf, Human, Dwarf"), never prose that
 *  merely contains commas ("tall, dark, and handsome"). Returns the items, or
 *  null if it doesn't look like a list. */
function _maybeDelimitedList(str) {
  if (typeof str !== 'string') return null
  const s = str.trim()
  if (!s) return null
  for (const delim of [',', ';', '|', '\n']) {
    if (!s.includes(delim)) continue
    const parts = s.split(delim).map((p) => p.trim()).filter(Boolean)
    if (parts.length < 2) continue
    const looksListy = parts.every(
      (p) => p.length <= 40 && !/[.!?]$/.test(p) && p.split(/\s+/).length <= 5
    )
    if (looksListy) return parts
  }
  return null
}

/** entity_list when every value resolves to an existing entity; else text_list. */
function _listTypeFromValues(values) {
  if (!Array.isArray(values) || values.length === 0) return 'text_list'
  const allEntities = values.every((v) => {
    try { _resolveEntity(v); return true } catch { return false }
  })
  return allEntities ? 'entity_list' : 'text_list'
}

/** Infer the attribute type from the supplied fields. Mutates `args` in place
 *  to normalise a delimited/numeric scalar `value` into the canonical field
 *  (`values` / `number_value`) and to fill an inferred `preset_list`. Throws a
 *  descriptive error when the type genuinely can't be determined. */
function _inferAttributeType(args) {
  if (args.file_ref) return 'file'
  if (Array.isArray(args.values)) return _listTypeFromValues(args.values)
  if (args.number_value !== undefined && args.number_value !== null) return 'number'
  if (args.target !== undefined && args.target !== null) return 'perspective'
  if (args.value !== undefined && args.value !== null) {
    const listItems = _maybeDelimitedList(String(args.value))
    if (listItems) {
      args.values = listItems
      delete args.value
      return _listTypeFromValues(listItems)
    }
    if (_looksNumeric(args.value)) {
      args.number_value = Number(args.value)
      delete args.value
      return 'number'
    }
    const list = _presetListByName(args.name)
    if (list && _valueOnPresetList(list, args.value)) {
      if (args.preset_list === undefined) args.preset_list = list.name
      return 'preset'
    }
    return 'text'
  }
  if (args.description !== undefined || args.intensity !== undefined) {
    throw new Error(
      "can't tell whether this is a circumstance or a motivator from description / intensity " +
      "alone — use add_circumstances or add_motivators (or pass attribute_type explicitly)."
    )
  }
  throw new Error(
    "can't determine the attribute type: supply a `value` (or `values` / `number_value` / " +
    "`file_ref` / `target`), or pass `attribute_type` explicitly."
  )
}

function _buildAttributeFromMcpInput(rawArgs, { existingId, existingType } = {}) {
  // Work on a shallow copy — inference may normalise value -> values/number_value.
  const args = { ...rawArgs }
  // Case-insensitive on input; canonical lowercase form drives every
  // switch-arm and the stored attribute_type field downstream so the
  // walker / detail panel render path sees a consistent value.
  let attribute_type = (typeof args.attribute_type === 'string'
    ? args.attribute_type.trim().toLowerCase()
    : args.attribute_type)
  if (!attribute_type) {
    // No explicit type: for an existing attribute the caller passes its known
    // type; otherwise infer from the supplied fields.
    attribute_type = existingType || _inferAttributeType(args)
  }
  const isCM = attribute_type === 'circumstance' || attribute_type === 'motivator'
  const isPerspective = attribute_type === 'perspective'

  // Name validation: most types require non-empty name; CM allows
  // either name or description (but not both blank). Perspectives
  // don't have a name field in the UI (the target IS the perspective's
  // identity) — accept empty name without complaint.
  if (isCM) {
    const hasName = !!(args.name || '').trim()
    const hasDesc = !!(args.description || '').trim()
    if (!hasName && !hasDesc) {
      throw new Error(
        "circumstance / motivator attributes require at least one of " +
        "`name` or `description` to be non-empty."
      )
    }
  } else if (isPerspective) {
    // No name validation for perspectives — empty is the expected
    // shape. The description + target carry the row's identity.
  } else {
    if (!(args.name || '').trim()) {
      throw new Error(`attribute_type='${attribute_type}' requires a non-empty name`)
    }
  }

  // Build the type-specific value field(s)
  let value = ''
  let number_value = null
  let file_ref = null
  let preset_list_id = null
  let preset_list_name = null
  let description = ''
  let intensity = null
  let perspective_target_kind = null
  let perspective_target_id = null

  switch (attribute_type) {
    case 'text':
      if (args.value === undefined) throw new Error("'text' attributes require `value`")
      value = String(args.value)
      break
    case 'preset': {
      // Infer the preset list from the attribute name when not given (a
      // "Gender" attribute uses the "Gender" list).
      let presetListRef = args.preset_list
      if (!presetListRef) {
        const byName = _presetListByName(args.name)
        if (byName) presetListRef = byName.name
      }
      if (!presetListRef) {
        throw new Error(
          `'${args.name}' is a preset attribute but no preset_list was given and no preset ` +
          `list matches its name. Pass preset_list (UUID or name), or create the list first ` +
          `with create_preset_list.`
        )
      }
      preset_list_id = _resolvePresetListId(presetListRef)
      const _list = useProjectStore.getState().story.preset_lists.find((l) => l.id === preset_list_id)
      preset_list_name = _list?.name || null
      if (args.value === undefined) {
        throw new Error(
          `'${args.name}' is a preset attribute on the '${_list?.name}' list; it requires a ` +
          `\`value\` — one of: ${(_list?.values || []).join(', ')}.`
        )
      }
      value = String(args.value)
      // Case-insensitive membership; store the list's canonical spelling.
      if (_list && Array.isArray(_list.values)) {
        const canonical = _list.values.find(
          (v) => String(v).trim().toLowerCase() === value.trim().toLowerCase()
        )
        if (canonical === undefined) {
          throw new Error(
            `'${value}' is not on the '${_list.name}' preset list (which the '${args.name}' ` +
            `attribute uses). Allowed values: ${_list.values.join(', ')}. Use one of those, ` +
            `or add '${value}' to the list with update_preset_list.`
          )
        }
        value = String(canonical)
      }
      break
    }
    case 'number':
      if (args.number_value === undefined || args.number_value === null) {
        throw new Error("'number' attributes require `number_value`")
      }
      number_value = Number(args.number_value)
      if (Number.isNaN(number_value)) {
        throw new Error(`number_value must be numeric, got: ${args.number_value}`)
      }
      break
    case 'text_list':
      if (!Array.isArray(args.values)) {
        throw new Error("'text_list' attributes require `values` (array of strings)")
      }
      value = JSON.stringify(args.values.map((v) => String(v)))
      break
    case 'entity_list':
      if (!Array.isArray(args.values)) {
        throw new Error("'entity_list' attributes require `values` (array of entity UUIDs or names)")
      }
      // Resolve each entity ref to an id
      value = JSON.stringify(args.values.map((v) => _resolveEntity(v).entity.id))
      break
    case 'file':
      if (!args.file_ref) throw new Error("'file' attributes require `file_ref`")
      file_ref = String(args.file_ref)
      break
    case 'circumstance':
    case 'motivator':
      description = (args.description || '').trim()
      if (args.intensity !== undefined) {
        intensity = _resolveIntensity(args.intensity)
      }
      break
    case 'perspective': {
      description = (args.description || '').trim()
      if (!description) {
        throw new Error("'perspective' attributes require a non-empty `description` (the perspective body).")
      }
      // Target is required at perspective build time. Orphaned-target
      // perspectives only exist as the post-cascade state of a target
      // deletion; a fresh add MUST point at a real target. The
      // resolver throws clean type-mismatch / not-found errors on bad
      // input.
      if (!args.target) {
        throw new Error("'perspective' attributes require a `target` arg: { kind, ref }.")
      }
      const { kind: tk, id: tid } = _resolvePerspectiveTarget(args.target)
      perspective_target_kind = tk
      perspective_target_id = tid
      break
    }
    default:
      throw new Error(`unknown attribute_type: ${attribute_type}`)
  }

  return {
    id: existingId || crypto.randomUUID(),
    attribute_type,
    name: (args.name || '').trim(),
    value,
    number_value,
    file_ref,
    preset_list_id,
    preset_list_name,
    description,
    intensity,
    perspective_target_kind,
    perspective_target_id,
  }
}

// Singular `add_attribute` tool retired in v0.2.1.156 — `add_attributes`
// is the canonical tool (pass a one-element list for the singular case).
// Removed to consolidate the tool surface: one canonical add tool per
// object kind, taking a list. See plot_planning / world_setup workflow
// guides for the worked patterns.


// ── Batch tool: add_attributes ──────────────────────────────────────────
//
// Bulk-add multiple attributes to an existing entity in one call.
// Mirrors `add_attribute`'s per-item shape but takes an `attributes`
// list instead of the singular field set; the per-attribute fields
// (name / attribute_type / value / number_value / file_ref / preset_list
// / values / description / intensity) live inside each list item.
//
// Same `at?` arg: omit / 'origin' for baseline writes, scene UUID /
// title for scene-anchored adds (one chain entry per item).
// `track_as_knowledge?` follows the same single-anchor constraint
// `update_attribute` enforces — requires the batch to produce exactly
// one chain entry; multi-item batches reject cleanly.
//
// Pre-validate ALL items upfront. If item 3 of 5 has a bad shape the
// whole batch errors with `attributes[3]: ...` attribution and no
// writes have landed. Same fail-fast pattern as `create_scene`'s pre-
// validation.

/** Transform an add-attributes item into an update_attributes update item:
 *  reference the existing attribute by name, and carry only the
 *  value-bearing fields (type / preset_list come from the existing
 *  attribute, so they're dropped). Powers the add->update upsert. */
function _attrItemToUpdateItem(item) {
  const upd = { attribute: item.name }
  for (const k of ['value', 'number_value', 'values', 'file_ref', 'description', 'intensity']) {
    if (item[k] !== undefined) upd[k] = item[k]
  }
  return upd
}

registerMcpTool('add_attributes', async (args) => {
  const at = args?.at
  const isOriginPath = !at || at === 'origin'
  const { entity } = _resolveEntity(args?.entity)

  // Validate the batch arg.
  const itemsArg = args?.attributes
  if (!Array.isArray(itemsArg) || itemsArg.length === 0) {
    throw new Error('attributes must be a non-empty array of attribute objects')
  }

  // Pre-validate track_as_knowledge shape upfront (same as add_attribute).
  const trackArg = args?.track_as_knowledge
  if (trackArg !== undefined && trackArg !== null) {
    if (isOriginPath) {
      throw new Error(
        `track_as_knowledge requires a scene anchor (pass \`at=<scene>\`). ` +
        `Origin-path attribute adds are baseline writes — no chain event to anchor to.`
      )
    }
    if (itemsArg.length !== 1) {
      throw new Error(
        `track_as_knowledge requires exactly one chain entry per call ` +
        `(a Knowledge anchors to one event). This batch has ${itemsArg.length} ` +
        `attributes. Split into separate add_attributes calls and pass ` +
        `track_as_knowledge on the one you want to anchor.`
      )
    }
    if (typeof trackArg === 'string') _resolveKnowledge(trackArg)
    else if (typeof trackArg === 'object' && !Array.isArray(trackArg)) {
      if (!(trackArg.name || '').trim()) {
        throw new Error('track_as_knowledge.name is required when creating a new Knowledge.')
      }
    } else {
      throw new Error(
        `track_as_knowledge must be a string (existing Knowledge UUID / name) ` +
        `or an object { name, description?, colour?, awareness_scale? }.`
      )
    }
  }

  // Build each attribute, validating per item with index attribution.
  // Duplicate-name check inside the batch + against the entity's
  // current resolved state at the target anchor.
  const builtAttributes = []
  const seenBatchNames = new Set()
  for (let i = 0; i < itemsArg.length; i++) {
    const item = itemsArg[i]
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`attributes[${i}] must be an object with attribute fields`)
    }
    let built
    try {
      built = _buildAttributeFromMcpInput(item)
    } catch (err) {
      throw new Error(`attributes[${i}]: ${err.message}`)
    }
    const lower = (built.name || '').trim().toLowerCase()
    if (lower) {
      if (seenBatchNames.has(lower)) {
        throw new Error(
          `attributes[${i}]: duplicate name "${built.name}" within the batch — ` +
          `each named attribute must be unique in a single add_attributes call.`
        )
      }
      seenBatchNames.add(lower)
    }
    builtAttributes.push(built)
  }

  if (isOriginPath) {
    // Upsert: an item whose name already exists on the baseline UPDATES the
    // existing attribute (routed through update_attributes, which keeps its
    // known type/list) instead of dup-erroring. New names are added.
    const newBuilt = []
    const upsertItems = []
    for (let i = 0; i < builtAttributes.length; i++) {
      const lower = (builtAttributes[i].name || '').trim().toLowerCase()
      const dup = lower && (entity.attributes || []).some(
        (a) => (a.name || '').trim().toLowerCase() === lower
      )
      if (dup) upsertItems.push(_attrItemToUpdateItem(itemsArg[i]))
      else newBuilt.push(builtAttributes[i])
    }
    let addedOut = []
    if (newBuilt.length) {
      const updated = { ...entity, attributes: [...(entity.attributes || []), ...newBuilt] }
      await useEntitiesStore.getState().updateEntity(entity.id, updated)
      addedOut = newBuilt.map(_projectAttribute)
    }
    let upsertOut = []
    if (upsertItems.length) {
      const r = await _updateAttributesImpl({ entity: entity.id, at: 'origin', updates: upsertItems })
      upsertOut = r?.updates || []
    }
    return {
      entity_id: entity.id,
      attributes: [...addedOut, ...upsertOut],
      ...(upsertItems.length
        ? { _note: `${upsertItems.length} attribute(s) already existed and were updated in place (add -> update).` }
        : {}),
    }
  }

  // ─── SCENE PATH ──────────────────────────────────────────────────
  const sceneNode = _resolveScene(at)
  const sceneAttrs = _attributesAtScene(entity, sceneNode.id)

  // Upsert: items whose name already exists scene-resolved UPDATE the existing
  // attribute (from this scene forward) instead of dup-erroring; new names add.
  const newBuilt = []
  const sceneUpsertItems = []
  for (let i = 0; i < builtAttributes.length; i++) {
    const lower = (builtAttributes[i].name || '').trim().toLowerCase()
    const dup = lower && sceneAttrs.some((a) => (a.name || '').trim().toLowerCase() === lower)
    if (dup) sceneUpsertItems.push(_attrItemToUpdateItem(itemsArg[i]))
    else newBuilt.push(builtAttributes[i])
  }

  // track_as_knowledge requires a one-item batch (enforced above), so the
  // single item is wholly an add or wholly an upsert — route the tracking
  // flag to whichever half holds it.
  const trackForUpsert = trackArg != null && sceneUpsertItems.length === 1 && newBuilt.length === 0

  let addedOut = []
  let addTrackingId = null
  if (newBuilt.length) {
    const changeEntries = newBuilt.map((attr) => ({ id: crypto.randomUUID(), action: 'add', attribute: attr }))
    await _appendAttributeChainEntries(sceneNode, entity.id, changeEntries)
    if (trackArg != null && !trackForUpsert) {
      addTrackingId = await _applyKnowledgeTracking(trackArg, {
        event_type: 'attribute_change',
        change_id: changeEntries[0].id,
        node_id: sceneNode.id,
        entity_id: entity.id,
        attribute_id: newBuilt[0].id,
      })
    }
    addedOut = newBuilt.map(_projectAttribute)
  }

  let upsertOut = []
  let upsertTrackingId = null
  if (sceneUpsertItems.length) {
    const r = await _updateAttributesImpl({
      entity: entity.id, at, updates: sceneUpsertItems,
      ...(trackForUpsert ? { track_as_knowledge: trackArg } : {}),
    })
    upsertOut = r?.updates || []
    upsertTrackingId = r?.tracking_knowledge_id || null
  }

  const trackingKnowledgeId = addTrackingId || upsertTrackingId
  return {
    entity_id: entity.id,
    scene_id: sceneNode.id,
    scene_title: sceneNode.data?.title || '',
    attributes: [...addedOut, ...upsertOut],
    chain_actions: newBuilt.map(() => 'add'),
    ...(sceneUpsertItems.length
      ? { _note: `${sceneUpsertItems.length} attribute(s) already existed at this scene and were updated from here forward (add -> update).` }
      : {}),
    ...(trackingKnowledgeId ? { tracking_knowledge_id: trackingKnowledgeId } : {}),
  }
})

// Singular `update_attribute` retired in v0.2.1.158 — `update_attributes`
// is the canonical update tool (pass a one-element list for the single case).

// ── Batch tool: update_attributes ──────────────────────────────────────
//
// Bulk-update multiple attribute values on a single entity in one call.
// Each item in `updates` references one existing attribute (by UUID,
// id, or exact case-insensitive name) and supplies the field(s) to
// change. Same field shape as the retired `update_attribute` per item.
// Same `at?` arg semantics — omit / 'origin' for baseline, scene ref
// for scene-anchored chain entries.
//
// Pre-validation runs across ALL items BEFORE any write commits. If
// item 3 has a bad field-type combination or references a missing
// attribute the whole batch errors with `updates[3]: ...` attribution
// and nothing has landed.
//
// track_as_knowledge: requires the batch to produce exactly ONE chain
// entry total (the Knowledge anchors to one event).

async function _updateAttributesImpl(args) {
  const at = args?.at
  const isOriginPath = !at || at === 'origin'
  const { entity } = _resolveEntity(args?.entity)

  const itemsArg = args?.updates
  if (!Array.isArray(itemsArg) || itemsArg.length === 0) {
    throw new Error('updates must be a non-empty array of update objects (each referencing an attribute + the fields to change)')
  }

  // Pre-validate track_as_knowledge shape.
  const trackArg = args?.track_as_knowledge
  if (trackArg !== undefined && trackArg !== null) {
    if (isOriginPath) {
      throw new Error(
        `track_as_knowledge requires a scene anchor (pass \`at=<scene>\`). ` +
        `Origin-path attribute edits are baseline writes — no chain event to anchor to.`
      )
    }
    if (typeof trackArg === 'string') _resolveKnowledge(trackArg)
    else if (typeof trackArg === 'object' && !Array.isArray(trackArg)) {
      if (!(trackArg.name || '').trim()) {
        throw new Error('track_as_knowledge.name is required when creating a new Knowledge.')
      }
    } else {
      throw new Error(
        `track_as_knowledge must be a string (existing Knowledge UUID / name) ` +
        `or an object { name, description?, colour?, awareness_scale? }.`
      )
    }
  }

  // ─── ORIGIN PATH ─────────────────────────────────────────────────
  if (isOriginPath) {
    const rebuiltById = new Map()
    for (let i = 0; i < itemsArg.length; i++) {
      const item = itemsArg[i]
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error(`updates[${i}] must be an object with an attribute ref + the fields to change`)
      }
      const ref = item.attribute
      if (!ref) {
        throw new Error(`updates[${i}].attribute is required (UUID or exact attribute name)`)
      }
      let existing
      try {
        existing = _resolveAttribute(entity, ref)
      } catch (err) {
        throw new Error(`updates[${i}]: ${err.message}`)
      }
      const merged = {
        attribute_type: existing.attribute_type,
        name: item.name !== undefined ? item.name : existing.name,
        description: item.description !== undefined ? item.description : existing.description,
        intensity: item.intensity !== undefined ? item.intensity : existing.intensity,
      }
      if (item.value !== undefined) merged.value = item.value
      else if (existing.attribute_type === 'text' || existing.attribute_type === 'preset') {
        merged.value = existing.value
      }
      if (item.number_value !== undefined) merged.number_value = item.number_value
      else if (existing.attribute_type === 'number') {
        merged.number_value = existing.number_value
      }
      if (item.file_ref !== undefined) merged.file_ref = item.file_ref
      else if (existing.attribute_type === 'file') {
        merged.file_ref = existing.file_ref
      }
      if (item.values !== undefined) merged.values = item.values
      else if (existing.attribute_type === 'text_list' || existing.attribute_type === 'entity_list') {
        try {
          const parsed = JSON.parse(existing.value || '[]')
          merged.values = Array.isArray(parsed) ? parsed : []
        } catch { merged.values = [] }
      }
      if (item.preset_list !== undefined) merged.preset_list = item.preset_list
      else if (existing.attribute_type === 'preset') {
        const lists = useProjectStore.getState().story?.preset_lists || []
        const list = lists.find((l) => l.id === existing.preset_list_id)
        if (list) merged.preset_list = list.name
      }
      let rebuilt
      try {
        rebuilt = _buildAttributeFromMcpInput(merged, { existingId: existing.id })
      } catch (err) {
        throw new Error(`updates[${i}]: ${err.message}`)
      }
      rebuiltById.set(existing.id, rebuilt)
    }
    const updated = {
      ...entity,
      attributes: (entity.attributes || []).map((a) =>
        rebuiltById.has(a.id) ? rebuiltById.get(a.id) : a
      ),
    }
    await useEntitiesStore.getState().updateEntity(entity.id, updated)
    return {
      entity_id: entity.id,
      updates: Array.from(rebuiltById.values()).map(_projectAttribute),
    }
  }

  // ─── SCENE PATH ──────────────────────────────────────────────────
  const sceneNode = _resolveScene(at)
  // Auto-chip + auto-wire the entity at the target scene BEFORE
  // pre-validation. Same rationale as remove_attributes: without
  // this, `_attributesAtScene` can't reach the entity's chain at the
  // target scene when the entity isn't already chipped there, and
  // `_resolveAttribute` throws a misleading "not reachable" error
  // even though the attribute exists in the entity's chain history.
  await _ensureEntityChipAtScene(sceneNode, entity.id)
  const sceneAttrs = _attributesAtScene(entity, sceneNode.id)
  const allEntries = []
  const perItemEntryRanges = []

  for (let i = 0; i < itemsArg.length; i++) {
    const item = itemsArg[i]
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`updates[${i}] must be an object with an attribute ref + the fields to change`)
    }
    const ref = item.attribute
    if (!ref) {
      throw new Error(`updates[${i}].attribute is required (UUID or exact attribute name)`)
    }
    let target
    try {
      target = _resolveAttribute(entity, ref, { attributesList: sceneAttrs })
    } catch (err) {
      throw new Error(`updates[${i}]: ${err.message}`)
    }
    const attrId = target.id
    const attrType = target.attribute_type

    if (item.preset_list !== undefined) {
      throw new Error(`updates[${i}]: Reassigning preset_list at a scene anchor is not supported. Use at='origin' to change the preset list.`)
    }

    const startIdx = allEntries.length
    if (item.name !== undefined) {
      const trimmed = String(item.name).trim()
      if (!trimmed) throw new Error(`updates[${i}].name cannot be empty`)
      allEntries.push({ id: crypto.randomUUID(), action: 'rename', attribute_id: attrId, new_name: trimmed })
    }
    if (item.value !== undefined) {
      if (!['text', 'preset'].includes(attrType)) {
        throw new Error(`updates[${i}]: 'value' is only valid for text or preset attributes; attribute '${target.name}' is type '${attrType}'.`)
      }
      let newVal = String(item.value)
      // Preset value must be on the attribute's list (case-insensitive; store
      // the list's canonical spelling). We already know the list from the
      // existing attribute — the model only needs to supply a valid value.
      if (attrType === 'preset') {
        const lists = useProjectStore.getState().story?.preset_lists || []
        const list = lists.find((l) => l.id === target.preset_list_id)
        if (list && Array.isArray(list.values)) {
          const canonical = list.values.find(
            (v) => String(v).trim().toLowerCase() === newVal.trim().toLowerCase()
          )
          if (canonical === undefined) {
            throw new Error(
              `updates[${i}]: '${newVal}' is not on the '${list.name}' preset list (which the ` +
              `'${target.name}' attribute uses). Allowed values: ${list.values.join(', ')}. ` +
              `Use one of those, or add '${newVal}' to the list with update_preset_list.`
            )
          }
          newVal = String(canonical)
        }
      }
      allEntries.push({ id: crypto.randomUUID(), action: 'modify', attribute_id: attrId, new_value: newVal })
    }
    if (item.number_value !== undefined) {
      if (attrType !== 'number') {
        throw new Error(`updates[${i}]: 'number_value' is only valid for number attributes; attribute '${target.name}' is type '${attrType}'.`)
      }
      const n = Number(item.number_value)
      if (Number.isNaN(n)) throw new Error(`updates[${i}]: number_value must be numeric, got: ${item.number_value}`)
      allEntries.push({ id: crypto.randomUUID(), action: 'modify', attribute_id: attrId, new_number_value: n })
    }
    if (item.file_ref !== undefined) {
      if (attrType !== 'file') {
        throw new Error(`updates[${i}]: 'file_ref' is only valid for file attributes; attribute '${target.name}' is type '${attrType}'.`)
      }
      allEntries.push({ id: crypto.randomUUID(), action: 'modify', attribute_id: attrId, file_ref_change: item.file_ref === '' ? '' : String(item.file_ref) })
    }
    if (item.description !== undefined) {
      if (!['circumstance', 'motivator'].includes(attrType)) {
        throw new Error(`updates[${i}]: 'description' is only valid for circumstance / motivator attributes; attribute '${target.name}' is type '${attrType}'.`)
      }
      allEntries.push({ id: crypto.randomUUID(), action: 'modify', attribute_id: attrId, new_description: String(item.description) })
    }
    if (item.intensity !== undefined) {
      if (!['circumstance', 'motivator'].includes(attrType)) {
        throw new Error(`updates[${i}]: 'intensity' is only valid for circumstance / motivator attributes; attribute '${target.name}' is type '${attrType}'.`)
      }
      const intensityValue = _resolveIntensity(item.intensity)
      allEntries.push({ id: crypto.randomUUID(), action: 'modify', attribute_id: attrId, new_intensity: intensityValue })
    }
    if (item.values !== undefined) {
      if (attrType !== 'text_list' && attrType !== 'entity_list') {
        throw new Error(`updates[${i}]: 'values' is only valid for text_list / entity_list attributes; attribute '${target.name}' is type '${attrType}'.`)
      }
      if (!Array.isArray(item.values)) {
        throw new Error(`updates[${i}]: 'values' must be an array (of strings for text_list, of entity refs for entity_list).`)
      }
      const newList = (attrType === 'entity_list')
        ? item.values.map((v) => _resolveEntity(v).entity.id)
        : item.values.map((v) => String(v))
      let currentList = []
      try {
        const parsed = JSON.parse(target.value || '[]')
        if (Array.isArray(parsed)) currentList = parsed
      } catch { /* malformed — treat as empty */ }
      const currentSet = new Set(currentList)
      const newSet = new Set(newList)
      for (const v of currentList) {
        if (!newSet.has(v)) {
          allEntries.push({ id: crypto.randomUUID(), action: 'list_remove', attribute_id: attrId, list_item: v })
        }
      }
      for (const v of newList) {
        if (!currentSet.has(v)) {
          allEntries.push({ id: crypto.randomUUID(), action: 'list_add', attribute_id: attrId, list_item: v })
        }
      }
    }

    if (allEntries.length === startIdx) {
      throw new Error(
        `updates[${i}]: no fields supplied to update at scene for attribute ` +
        `'${target.name}'. Pass at least one of: name, value, number_value, ` +
        `file_ref, description, intensity, values.`
      )
    }
    perItemEntryRanges.push({ start: startIdx, end: allEntries.length, attrId, attrName: target.name })
  }

  if (trackArg !== undefined && trackArg !== null) {
    if (allEntries.length !== 1) {
      throw new Error(
        `track_as_knowledge requires exactly one chain entry per call ` +
        `(the Knowledge anchors to one event). This batch produces ` +
        `${allEntries.length} entries across ${itemsArg.length} updates. ` +
        `Split into separate update_attributes calls and pass ` +
        `track_as_knowledge on the one you want to anchor.`
      )
    }
  }

  await _appendAttributeChainEntries(sceneNode, entity.id, allEntries)

  let trackingKnowledgeId = null
  if (trackArg !== undefined && trackArg !== null) {
    trackingKnowledgeId = await _applyKnowledgeTracking(trackArg, {
      event_type: 'attribute_change',
      change_id: allEntries[0].id,
      node_id: sceneNode.id,
      entity_id: entity.id,
      attribute_id: allEntries[0].attribute_id,
    })
  }

  const updatedSceneAttrs = _attributesAtScene(entity, sceneNode.id)
  const updatesOut = perItemEntryRanges.map((r) => {
    const updated = updatedSceneAttrs.find((a) => a.id === r.attrId)
    return {
      ..._projectAttribute(updated || { id: r.attrId, name: r.attrName, attribute_type: 'text' }),
      chain_actions: allEntries.slice(r.start, r.end).map((e) => e.action),
    }
  })

  return {
    entity_id: entity.id,
    scene_id: sceneNode.id,
    scene_title: sceneNode.data?.title || '',
    updates: updatesOut,
    ...(trackingKnowledgeId ? { tracking_knowledge_id: trackingKnowledgeId } : {}),
  }
}

registerMcpTool('update_attributes', _updateAttributesImpl)


// ── Batch tool: remove_attributes ──────────────────────────────────────
//
// Bulk-remove one or more attributes from an entity. Origin path is
// DESTRUCTIVE (strips the attribute + all chain entries referencing
// it from baseline); scene path is REMOVE (records `action='remove'`
// chain entries — baseline + upstream-scene entries untouched). Same
// `at?` and `track_as_knowledge?` semantics as the singular tools.
// Pre-validates every reference upfront — if item 3 references a
// missing attribute the whole batch errors with `attributes[3]: ...`
// and nothing has been removed.

registerMcpTool('remove_attributes', async (args) => {
  const at = args?.at
  const isOriginPath = !at || at === 'origin'
  const { entity } = _resolveEntity(args?.entity)

  const itemsArg = args?.attributes
  if (!Array.isArray(itemsArg) || itemsArg.length === 0) {
    throw new Error('attributes must be a non-empty array of attribute references (UUID or exact name). For a single attribute pass a one-element list.')
  }

  // Option F — pre-validate track_as_knowledge shape.
  const trackArg = args?.track_as_knowledge
  if (trackArg !== undefined && trackArg !== null) {
    if (isOriginPath) {
      throw new Error(
        `track_as_knowledge requires a scene anchor (pass \`at=<scene>\`). ` +
        `Origin-path remove_attributes is a DELETE — no chain event remains to anchor to.`
      )
    }
    if (itemsArg.length !== 1) {
      throw new Error(
        `track_as_knowledge requires exactly one chain entry per call ` +
        `(the Knowledge anchors to one event). This batch has ${itemsArg.length} ` +
        `attributes. Split into separate remove_attributes calls and pass ` +
        `track_as_knowledge on the one you want to anchor.`
      )
    }
    if (typeof trackArg === 'string') _resolveKnowledge(trackArg)
    else if (typeof trackArg === 'object' && !Array.isArray(trackArg)) {
      if (!(trackArg.name || '').trim()) {
        throw new Error('track_as_knowledge.name is required when creating a new Knowledge.')
      }
    } else {
      throw new Error(
        `track_as_knowledge must be a string (existing Knowledge UUID / name) ` +
        `or an object { name, description?, colour?, awareness_scale? }.`
      )
    }
  }

  if (!isOriginPath) {
    // ─── SCENE PATH (REMOVE — not destructive) ─────────────────────
    const sceneNode = _resolveScene(at)
    // Auto-chip + auto-wire the entity to the cleanup scene BEFORE
    // pre-validation. Without this, `_attributesAtScene` would walk
    // the entity's chain starting from the last scene the entity was
    // actually chipped at, miss the cleanup scene entirely, and the
    // attribute-resolution would throw the misleading "exists in chain
    // history but NOT REACHABLE" error. Cleaning up a chain-tracked
    // location circumstance at a scene that doesn't already include
    // the location as a participant is the canonical case (e.g.
    // remove "Party in full swing" from Sigma Pi House at the morning-
    // after scene where Marisol walks home solo).
    await _ensureEntityChipAtScene(sceneNode, entity.id)
    const sceneAttrs = _attributesAtScene(entity, sceneNode.id)
    const targets = []
    for (let i = 0; i < itemsArg.length; i++) {
      const ref = itemsArg[i]
      if (typeof ref !== 'string' || !ref) {
        throw new Error(`attributes[${i}] must be a non-empty string (UUID or exact attribute name)`)
      }
      let t
      try {
        t = _resolveAttribute(entity, ref, { attributesList: sceneAttrs })
      } catch (err) {
        throw new Error(`attributes[${i}]: ${err.message}`)
      }
      targets.push(t)
    }
    const changeEntries = targets.map((t) => ({
      id: crypto.randomUUID(),
      action: 'remove',
      attribute_id: t.id,
    }))
    await _appendAttributeChainEntries(sceneNode, entity.id, changeEntries)

    let trackingKnowledgeId = null
    if (trackArg !== undefined && trackArg !== null) {
      trackingKnowledgeId = await _applyKnowledgeTracking(trackArg, {
        event_type: 'attribute_change',
        change_id: changeEntries[0].id,
        node_id: sceneNode.id,
        entity_id: entity.id,
        attribute_id: targets[0].id,
      })
    }

    return {
      entity_id: entity.id,
      scene_id: sceneNode.id,
      scene_title: sceneNode.data?.title || '',
      attributes: targets.map((t) => ({ id: t.id, name: t.name || '', type: t.attribute_type })),
      chain_actions: changeEntries.map(() => 'remove'),
      ...(trackingKnowledgeId ? { tracking_knowledge_id: trackingKnowledgeId } : {}),
    }
  }

  // ─── ORIGIN PATH (DESTRUCTIVE — backend has already gated approval) ─
  // Pre-resolve every reference upfront before any deletion lands.
  const targets = []
  for (let i = 0; i < itemsArg.length; i++) {
    const ref = itemsArg[i]
    if (typeof ref !== 'string' || !ref) {
      throw new Error(`attributes[${i}] must be a non-empty string (UUID or exact attribute name)`)
    }
    let t
    try {
      t = _resolveAttribute(entity, ref)
    } catch (err) {
      throw new Error(`attributes[${i}]: ${err.message}`)
    }
    targets.push(t)
  }
  const targetIds = new Set(targets.map((t) => t.id))
  const updated = {
    ...entity,
    attributes: (entity.attributes || []).filter((a) => !targetIds.has(a.id)),
  }
  await useEntitiesStore.getState().updateEntity(entity.id, updated)

  return {
    entity_id: entity.id,
    attributes: targets.map((t) => ({ id: t.id, name: t.name || '', type: t.attribute_type })),
  }
})


// Singular remove_attribute retired in v0.2.1.158 - remove_attributes is the canonical remove tool (pass a one-element list for the single case).



// ── Circumstance tools (Phase 2.1 audit verdict) ──────────────────────
//
// Three goal-level tools — `add_circumstance` / `update_circumstance` /
// `remove_circumstance` — with polymorphic `target` arg (entity OR scene).
// Per the audit, entity-targeted writes get `is_temporary?` + `at?`;
// scene-targeted writes reject both (scenes aren't chain-tracked; the
// concept of "temporary" makes no sense for a scene's own property).
//
// Routing under the hood:
//   target=scene                      → scene-side Circumstance via
//                                       addSceneCircumstance / update /
//                                       remove on SceneNode.circumstances
//   target=entity + is_temporary=true → EntityTemporaryCM on the at-scene
//                                       (scoped to one entity at one scene
//                                       only; not chain-tracked)
//   target=entity + at=origin         → entity baseline attribute_type=
//                                       'circumstance' via updateEntity
//   target=entity + at=<scene>        → scene-anchored AttributeChange
//                                       on the entity's chip
//
// The shared `_resolveCircumstanceTarget` helper tries scene resolution
// first then entity, returning a discriminated result the tools branch
// on. Names overlap across the two namespaces are rare; when ambiguous
// the user should pass a UUID.


function _resolveCircumstanceTarget(targetRef) {
  if (!targetRef || typeof targetRef !== 'string') {
    throw new Error('target reference is required (UUID or exact name/title of a scene or entity)')
  }
  // Try scene first.
  try {
    const sceneNode = _resolveScene(targetRef)
    return { kind: 'scene', sceneNode }
  } catch {
    // Fall through to entity attempt.
  }
  try {
    const { entity, type } = _resolveEntity(targetRef)
    return { kind: 'entity', entity, entityType: type }
  } catch {
    throw new Error(
      `target "${targetRef}" did not resolve to either a scene or an entity. ` +
      `Pass a UUID or an exact (case-insensitive) name/title; use ` +
      `list_scenes / list_entities to discover.`
    )
  }
}

/** Validate the shared circumstance payload (name / description /
 *  intensity). Mirrors the backend Circumstance model's post-init rule:
 *  at least one of name / description must be non-empty; intensity is
 *  optional int 0-4. Returns a cleaned payload `{ name, description,
 *  intensity }` (name=null when empty, intensity=null when unset). */
function _validateCircumstancePayload(args) {
  const name = (args.name === undefined || args.name === null || args.name === '')
    ? null
    : String(args.name).trim() || null
  const description = (args.description === undefined || args.description === null)
    ? ''
    : String(args.description)
  if (!name && !description.trim()) {
    throw new Error(
      `circumstance requires at least one of name or description to be non-empty.`
    )
  }
  const intensity = args.intensity !== undefined ? _resolveIntensity(args.intensity) : null
  return { name, description, intensity }
}

// Singular `add_circumstance` retired in v0.2.1.156 — `add_circumstances`
// is the canonical tool (pass a one-element list). Consolidates the
// add-tool surface to one canonical batch shape per object kind.


// ── update_circumstance ───────────────────────────────────────────────

registerMcpTool('update_circumstance', async (args) => {
  const target = _resolveCircumstanceTarget(args?.target)
  const circRef = args?.circumstance
  if (!circRef || typeof circRef !== 'string') {
    throw new Error('circumstance reference is required (UUID or exact name).')
  }
  const isTemporary = args?.is_temporary === true

  if (target.kind === 'scene') {
    if (isTemporary || (args?.at !== undefined && args?.at !== null)) {
      throw new Error(`is_temporary / at are invalid for scene targets.`)
    }
    if (args?.track_as_knowledge !== undefined && args?.track_as_knowledge !== null) {
      throw new Error(`track_as_knowledge is invalid for scene targets.`)
    }
    const list = Array.isArray(target.sceneNode.data?.circumstances)
      ? target.sceneNode.data.circumstances
      : []
    const cir = _resolveCircumstanceInList(list, circRef)
    const patch = {}
    if (args.name !== undefined) patch.name = (args.name || '').trim() || null
    if (args.description !== undefined) patch.description = String(args.description)
    if (args.intensity !== undefined) {
      patch.intensity = _resolveIntensity(args.intensity)
    }
    if (Object.keys(patch).length === 0) {
      throw new Error('no fields to update — pass at least one of name, description, intensity.')
    }
    useProjectStore.getState().updateSceneCircumstance(target.sceneNode.id, cir.id, patch)
    return {
      id: cir.id, scope: 'scene',
      scene_id: target.sceneNode.id, scene_title: target.sceneNode.data?.title || '',
      ...patch,
    }
  }

  // Entity target.
  const at = args?.at
  const isOriginPath = !at || at === 'origin'

  if (isTemporary) {
    if (isOriginPath) {
      throw new Error(`is_temporary requires a scene anchor (pass at=<scene>).`)
    }
    const sceneNode = _resolveScene(at)
    const list = (sceneNode.data?.entity_temporary_circumstances || []).filter(
      (e) => e.entity_id === target.entity.id && e.attribute_type === 'circumstance',
    )
    const cm = _resolveCircumstanceInList(list, circRef)
    const patch = {}
    if (args.name !== undefined) patch.name = (args.name || '').trim() || null
    if (args.description !== undefined) patch.description = String(args.description)
    if (args.intensity !== undefined) {
      patch.intensity = _resolveIntensity(args.intensity)
    }
    if (Object.keys(patch).length === 0) {
      throw new Error('no fields to update.')
    }
    useProjectStore.getState().updateEntityTemporaryCM(sceneNode.id, cm.id, patch)
    return {
      id: cm.id, scope: 'entity_temporary',
      entity_id: target.entity.id, entity_type: target.entityType,
      scene_id: sceneNode.id, scene_title: sceneNode.data?.title || '',
      ...patch,
    }
  }

  // Persistent entity circumstance — route through update_attributes
  // with a one-element list (the singular `update_attribute` tool was
  // retired in v0.2.1.158 in favour of the plural form).
  const updateAttrs = getMcpToolHandler('update_attributes')
  const updateItem = { attribute: circRef }
  if (args.name !== undefined) updateItem.name = args.name
  if (args.description !== undefined) updateItem.description = args.description
  if (args.intensity !== undefined) updateItem.intensity = args.intensity
  const result = await updateAttrs({
    entity: target.entity.id,
    updates: [updateItem],
    at: isOriginPath ? undefined : at,
    track_as_knowledge: args?.track_as_knowledge,
  })
  // Project the single-item batch result into the same shape the old
  // singular-routed call returned (callers downstream rely on this).
  const single = (result?.updates && result.updates[0]) || {}
  return {
    ...single,
    ...(result?.scene_id ? { scene_id: result.scene_id, scene_title: result.scene_title } : {}),
    ...(result?.tracking_knowledge_id ? { tracking_knowledge_id: result.tracking_knowledge_id } : {}),
    scope: isOriginPath ? 'entity_baseline' : 'entity_scene_chain',
    entity_id: target.entity.id, entity_type: target.entityType,
  }
})

// ── Batch tool: add_circumstances ─────────────────────────────────────
//
// Bulk-add multiple circumstances in one call. All items in the batch
// share the same `target` + `at` + `is_temporary` — i.e. they all
// land in the same scope (scene-level / entity-baseline / entity-
// scene-chain / entity-temporary). Per-item fields: `name`,
// `description`, `intensity`.
//
// Pre-validates every payload upfront. Persistent-entity path routes
// through `add_attributes` for atomic single-call commit; scene-level
// and entity-temporary paths iterate the validated payloads (commits
// are simple data inserts on already-resolved targets, no further
// resolution failures possible).

registerMcpTool('add_circumstances', async (args) => {
  const target = _resolveCircumstanceTarget(args?.target)
  const itemsArg = args?.circumstances
  if (!Array.isArray(itemsArg) || itemsArg.length === 0) {
    throw new Error('circumstances must be a non-empty array of circumstance objects (each with name? / description? / intensity?)')
  }
  const isTemporary = args?.is_temporary === true

  // Pre-validate every per-item payload upfront (collect or fail-fast
  // with item-index attribution). Each item is shaped just like the
  // singular tool's payload args, just bundled into a list.
  const payloads = []
  for (let i = 0; i < itemsArg.length; i++) {
    const item = itemsArg[i]
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`circumstances[${i}] must be an object with name? / description? / intensity?`)
    }
    try {
      payloads.push(_validateCircumstancePayload(item))
    } catch (err) {
      throw new Error(`circumstances[${i}]: ${err.message}`)
    }
  }

  // ─── SCENE-LEVEL PATH ──────────────────────────────────────────
  if (target.kind === 'scene') {
    if (isTemporary) {
      throw new Error(`is_temporary is invalid for scene targets — scenes aren't chain-tracked.`)
    }
    if (args?.at !== undefined && args?.at !== null) {
      throw new Error(`'at' is invalid for scene targets — the scene IS the anchor.`)
    }
    if (args?.track_as_knowledge !== undefined && args?.track_as_knowledge !== null) {
      throw new Error(`track_as_knowledge is invalid for scene targets — scene-side circumstances aren't chain events.`)
    }
    const out = []
    for (const payload of payloads) {
      const id = crypto.randomUUID()
      useProjectStore.getState().addSceneCircumstance(target.sceneNode.id, {
        id, name: payload.name, description: payload.description, intensity: payload.intensity,
      })
      out.push({
        id, scope: 'scene',
        scene_id: target.sceneNode.id,
        scene_title: target.sceneNode.data?.title || '',
        name: payload.name, description: payload.description, intensity: payload.intensity,
      })
    }
    return { target_kind: 'scene', circumstances: out }
  }

  // ─── ENTITY PATHS ──────────────────────────────────────────────
  const at = args?.at
  const isOriginPath = !at || at === 'origin'

  // is_temporary path — N EntityTemporaryCM rows on the at-scene.
  if (isTemporary) {
    if (isOriginPath) {
      throw new Error(`is_temporary requires a scene anchor (pass at=<scene>). Temporary circumstances are scoped to one entity at one scene.`)
    }
    if (args?.track_as_knowledge !== undefined && args?.track_as_knowledge !== null) {
      throw new Error(`track_as_knowledge is invalid for temporary circumstances — they're not chain-tracked, so there's no chain event to anchor a Knowledge to.`)
    }
    const sceneNode = _resolveScene(at)
    const out = []
    for (const payload of payloads) {
      const id = crypto.randomUUID()
      useProjectStore.getState().addEntityTemporaryCM(sceneNode.id, target.entity.id, {
        id, attribute_type: 'circumstance',
        name: payload.name, description: payload.description, intensity: payload.intensity,
      })
      out.push({
        id, scope: 'entity_temporary',
        entity_id: target.entity.id, entity_type: target.entityType,
        scene_id: sceneNode.id, scene_title: sceneNode.data?.title || '',
        name: payload.name, description: payload.description, intensity: payload.intensity,
      })
    }
    return { target_kind: 'entity', circumstances: out }
  }

  // Persistent path — route through add_attributes (one batch call).
  // Each circumstance becomes a circumstance-typed attribute item.
  const addAttrs = getMcpToolHandler('add_attributes')
  const attrItems = payloads.map((p) => ({
    attribute_type: 'circumstance',
    name: p.name || undefined,
    description: p.description || undefined,
    intensity: p.intensity,
  }))
  const result = await addAttrs({
    entity: target.entity.id,
    attributes: attrItems,
    at: isOriginPath ? undefined : at,
    track_as_knowledge: args?.track_as_knowledge,
  })
  return {
    target_kind: 'entity',
    entity_id: target.entity.id,
    entity_type: target.entityType,
    scope: isOriginPath ? 'entity_baseline' : 'entity_scene_chain',
    ...(result.scene_id ? { scene_id: result.scene_id, scene_title: result.scene_title } : {}),
    circumstances: result.attributes || [],
    ...(result.tracking_knowledge_id ? { tracking_knowledge_id: result.tracking_knowledge_id } : {}),
  }
})

// ── Batch tool: remove_circumstances ──────────────────────────────────
//
// Bulk-remove one or more circumstances. All items share the same
// `target` + `at` + `is_temporary`. Per-item is just a reference
// string (UUID or exact name) into the appropriate scope's list.
// Persistent path routes through `remove_attributes` (one batch call);
// scene-level + entity-temporary paths iterate the resolved targets
// (simple data deletes, no further failure modes).

registerMcpTool('remove_circumstances', async (args) => {
  const target = _resolveCircumstanceTarget(args?.target)
  const itemsArg = args?.circumstances
  if (!Array.isArray(itemsArg) || itemsArg.length === 0) {
    throw new Error('circumstances must be a non-empty array of circumstance references (UUID or exact name). For a single circumstance pass a one-element list.')
  }
  for (let i = 0; i < itemsArg.length; i++) {
    if (typeof itemsArg[i] !== 'string' || !itemsArg[i]) {
      throw new Error(`circumstances[${i}] must be a non-empty string (UUID or exact circumstance name)`)
    }
  }
  const isTemporary = args?.is_temporary === true

  // ─── SCENE-LEVEL PATH ──────────────────────────────────────────
  if (target.kind === 'scene') {
    if (isTemporary || (args?.at !== undefined && args?.at !== null)) {
      throw new Error(`is_temporary / at are invalid for scene targets.`)
    }
    const list = Array.isArray(target.sceneNode.data?.circumstances)
      ? target.sceneNode.data.circumstances
      : []
    const targets = []
    for (let i = 0; i < itemsArg.length; i++) {
      try {
        targets.push(_resolveCircumstanceInList(list, itemsArg[i]))
      } catch (err) {
        throw new Error(`circumstances[${i}]: ${err.message}`)
      }
    }
    for (const t of targets) {
      useProjectStore.getState().removeSceneCircumstance(target.sceneNode.id, t.id)
    }
    return {
      target_kind: 'scene',
      scene_id: target.sceneNode.id,
      scene_title: target.sceneNode.data?.title || '',
      circumstances: targets.map((t) => ({ id: t.id, name: t.name || '' })),
    }
  }

  // ─── ENTITY PATHS ──────────────────────────────────────────────
  const at = args?.at
  const isOriginPath = !at || at === 'origin'

  if (isTemporary) {
    if (isOriginPath) {
      throw new Error(`is_temporary requires a scene anchor (pass at=<scene>).`)
    }
    const sceneNode = _resolveScene(at)
    const list = (sceneNode.data?.entity_temporary_circumstances || []).filter(
      (e) => e.entity_id === target.entity.id && e.attribute_type === 'circumstance',
    )
    const targets = []
    for (let i = 0; i < itemsArg.length; i++) {
      try {
        targets.push(_resolveCircumstanceInList(list, itemsArg[i]))
      } catch (err) {
        throw new Error(`circumstances[${i}]: ${err.message}`)
      }
    }
    for (const t of targets) {
      useProjectStore.getState().removeEntityTemporaryCM(sceneNode.id, t.id)
    }
    return {
      target_kind: 'entity',
      scope: 'entity_temporary',
      entity_id: target.entity.id, entity_type: target.entityType,
      scene_id: sceneNode.id, scene_title: sceneNode.data?.title || '',
      circumstances: targets.map((t) => ({ id: t.id, name: t.name || '' })),
    }
  }

  // Persistent path — route through remove_attributes (batch).
  const removeAttrs = getMcpToolHandler('remove_attributes')
  const result = await removeAttrs({
    entity: target.entity.id,
    attributes: itemsArg,
    at: isOriginPath ? undefined : at,
    track_as_knowledge: args?.track_as_knowledge,
  })
  return {
    target_kind: 'entity',
    entity_id: target.entity.id,
    entity_type: target.entityType,
    scope: isOriginPath ? 'entity_baseline' : 'entity_scene_chain',
    ...(result?.scene_id ? { scene_id: result.scene_id, scene_title: result.scene_title } : {}),
    circumstances: result?.attributes || [],
    ...(result?.chain_actions ? { chain_actions: result.chain_actions } : {}),
    ...(result?.tracking_knowledge_id ? { tracking_knowledge_id: result.tracking_knowledge_id } : {}),
  }
})

/** Resolve a circumstance reference (UUID or exact name) against a flat
 *  list of circumstance / CM entries. Each entry must have `id` and may
 *  have `name`. Throws on missing or ambiguous matches. */
// ── Motivator tools (audit verdict — entity-only) ─────────────────────
//
// Same shape as circumstance tools but entity-only (motivators don't
// live on scenes per the data model). Three routing paths:
//   target=entity (no at)               → entity baseline attribute
//                                         type='motivator' via canonical
//                                         updateEntity (origin write).
//   target=entity + at=<scene>          → scene-anchored AttributeChange
//                                         on the entity's chip (chain
//                                         event; supports
//                                         track_as_knowledge per Option F).
//   target=entity + is_temporary=true   → EntityTemporaryCM with
//                                         attribute_type='motivator',
//                                         scoped to one entity at one
//                                         scene only (NOT chain-tracked).


// Singular `add_motivator` retired in v0.2.1.156 — `add_motivators` is
// the canonical tool (pass a one-element list). Consolidates the
// add-tool surface to one canonical batch shape per object kind.


// ── Batch tool: add_motivators ────────────────────────────────────────
//
// Bulk-add multiple motivators on a single entity in one call.
// Motivators are character-only and entity-only (no scene-level
// motivators — motivators are inner drives, not environmental state).
// Same per-item shape as `add_motivator`: each item carries `name`,
// `description`, `intensity`. All items share the batch-level `at`,
// `is_temporary`, and `track_as_knowledge`.
//
// Pre-validates every payload upfront. Persistent path routes through
// `add_attributes` for atomic commit; entity-temporary path iterates
// validated payloads (data inserts, no further failure modes).

registerMcpTool('add_motivators', async (args) => {
  const { entity, type: entityType } = _resolveEntity(args?.entity)
  const itemsArg = args?.motivators
  if (!Array.isArray(itemsArg) || itemsArg.length === 0) {
    throw new Error('motivators must be a non-empty array of motivator objects (each with name? / description? / intensity?)')
  }
  const isTemporary = args?.is_temporary === true
  const at = args?.at
  const isOriginPath = !at || at === 'origin'

  // Pre-validate every per-item payload.
  const payloads = []
  for (let i = 0; i < itemsArg.length; i++) {
    const item = itemsArg[i]
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`motivators[${i}] must be an object with name? / description? / intensity?`)
    }
    try {
      payloads.push(_validateCircumstancePayload(item))
    } catch (err) {
      throw new Error(`motivators[${i}]: ${err.message}`)
    }
  }

  // ─── is_temporary path ────────────────────────────────────────
  if (isTemporary) {
    if (isOriginPath) {
      throw new Error(`is_temporary requires a scene anchor (pass at=<scene>). Temporary motivators are scoped to one entity at one scene.`)
    }
    if (args?.track_as_knowledge !== undefined && args?.track_as_knowledge !== null) {
      throw new Error(`track_as_knowledge is invalid for temporary motivators — they're not chain-tracked, so there's no chain event to anchor a Knowledge to.`)
    }
    const sceneNode = _resolveScene(at)
    const out = []
    for (const payload of payloads) {
      const id = crypto.randomUUID()
      useProjectStore.getState().addEntityTemporaryCM(sceneNode.id, entity.id, {
        id, attribute_type: 'motivator',
        name: payload.name, description: payload.description, intensity: payload.intensity,
      })
      out.push({
        id, scope: 'entity_temporary',
        entity_id: entity.id, entity_type: entityType,
        scene_id: sceneNode.id, scene_title: sceneNode.data?.title || '',
        name: payload.name, description: payload.description, intensity: payload.intensity,
      })
    }
    return { motivators: out }
  }

  // ─── Persistent path — route through add_attributes ────────────
  const addAttrs = getMcpToolHandler('add_attributes')
  const attrItems = payloads.map((p) => ({
    attribute_type: 'motivator',
    name: p.name || undefined,
    description: p.description || undefined,
    intensity: p.intensity,
  }))
  const result = await addAttrs({
    entity: entity.id,
    attributes: attrItems,
    at: isOriginPath ? undefined : at,
    track_as_knowledge: args?.track_as_knowledge,
  })
  return {
    entity_id: entity.id,
    entity_type: entityType,
    scope: isOriginPath ? 'entity_baseline' : 'entity_scene_chain',
    ...(result.scene_id ? { scene_id: result.scene_id, scene_title: result.scene_title } : {}),
    motivators: result.attributes || [],
    ...(result.tracking_knowledge_id ? { tracking_knowledge_id: result.tracking_knowledge_id } : {}),
  }
})

registerMcpTool('update_motivator', async (args) => {
  const { entity, type: entityType } = _resolveEntity(args?.entity)
  const motivatorRef = args?.motivator
  if (!motivatorRef || typeof motivatorRef !== 'string') {
    throw new Error('motivator reference is required (UUID or exact name).')
  }
  const isTemporary = args?.is_temporary === true
  const at = args?.at
  const isOriginPath = !at || at === 'origin'

  if (isTemporary) {
    if (isOriginPath) {
      throw new Error(`is_temporary requires a scene anchor (pass at=<scene>).`)
    }
    const sceneNode = _resolveScene(at)
    const list = (sceneNode.data?.entity_temporary_circumstances || []).filter(
      (e) => e.entity_id === entity.id && e.attribute_type === 'motivator',
    )
    const cm = _resolveCircumstanceInList(list, motivatorRef, 'motivator')
    const patch = {}
    if (args.name !== undefined) patch.name = (args.name || '').trim() || null
    if (args.description !== undefined) patch.description = String(args.description)
    if (args.intensity !== undefined) {
      patch.intensity = _resolveIntensity(args.intensity)
    }
    if (Object.keys(patch).length === 0) {
      throw new Error('no fields to update.')
    }
    useProjectStore.getState().updateEntityTemporaryCM(sceneNode.id, cm.id, patch)
    return {
      id: cm.id,
      scope: 'entity_temporary',
      entity_id: entity.id,
      entity_type: entityType,
      scene_id: sceneNode.id,
      scene_title: sceneNode.data?.title || '',
      ...patch,
    }
  }

  // Persistent motivator — route through update_attributes with a
  // one-element list (singular `update_attribute` retired in v0.2.1.158).
  const updateAttrs = getMcpToolHandler('update_attributes')
  const updateItem = { attribute: motivatorRef }
  if (args.name !== undefined) updateItem.name = args.name
  if (args.description !== undefined) updateItem.description = args.description
  if (args.intensity !== undefined) updateItem.intensity = args.intensity
  const result = await updateAttrs({
    entity: entity.id,
    updates: [updateItem],
    at: isOriginPath ? undefined : at,
    track_as_knowledge: args?.track_as_knowledge,
  })
  const single = (result?.updates && result.updates[0]) || {}
  return {
    ...single,
    ...(result?.scene_id ? { scene_id: result.scene_id, scene_title: result.scene_title } : {}),
    ...(result?.tracking_knowledge_id ? { tracking_knowledge_id: result.tracking_knowledge_id } : {}),
    scope: isOriginPath ? 'entity_baseline' : 'entity_scene_chain',
    entity_id: entity.id,
    entity_type: entityType,
  }
})

// ── Batch tool: remove_motivators ─────────────────────────────────────
//
// Bulk-remove one or more motivators from a single entity. All items
// share the batch-level `at` + `is_temporary` + `track_as_knowledge`.
// Per-item is just a reference string (UUID or exact name).

registerMcpTool('remove_motivators', async (args) => {
  const { entity, type: entityType } = _resolveEntity(args?.entity)
  const itemsArg = args?.motivators
  if (!Array.isArray(itemsArg) || itemsArg.length === 0) {
    throw new Error('motivators must be a non-empty array of motivator references (UUID or exact name). For a single motivator pass a one-element list.')
  }
  for (let i = 0; i < itemsArg.length; i++) {
    if (typeof itemsArg[i] !== 'string' || !itemsArg[i]) {
      throw new Error(`motivators[${i}] must be a non-empty string (UUID or exact motivator name)`)
    }
  }
  const isTemporary = args?.is_temporary === true
  const at = args?.at
  const isOriginPath = !at || at === 'origin'

  if (isTemporary) {
    if (isOriginPath) {
      throw new Error(`is_temporary requires a scene anchor (pass at=<scene>).`)
    }
    const sceneNode = _resolveScene(at)
    const list = (sceneNode.data?.entity_temporary_circumstances || []).filter(
      (e) => e.entity_id === entity.id && e.attribute_type === 'motivator',
    )
    const targets = []
    for (let i = 0; i < itemsArg.length; i++) {
      try {
        targets.push(_resolveCircumstanceInList(list, itemsArg[i], 'motivator'))
      } catch (err) {
        throw new Error(`motivators[${i}]: ${err.message}`)
      }
    }
    for (const t of targets) {
      useProjectStore.getState().removeEntityTemporaryCM(sceneNode.id, t.id)
    }
    return {
      scope: 'entity_temporary',
      entity_id: entity.id,
      entity_type: entityType,
      scene_id: sceneNode.id,
      scene_title: sceneNode.data?.title || '',
      motivators: targets.map((t) => ({ id: t.id, name: t.name || '' })),
    }
  }

  // Persistent path — route through remove_attributes (batch).
  const removeAttrs = getMcpToolHandler('remove_attributes')
  const result = await removeAttrs({
    entity: entity.id,
    attributes: itemsArg,
    at: isOriginPath ? undefined : at,
    track_as_knowledge: args?.track_as_knowledge,
  })
  return {
    entity_id: entity.id,
    entity_type: entityType,
    scope: isOriginPath ? 'entity_baseline' : 'entity_scene_chain',
    ...(result?.scene_id ? { scene_id: result.scene_id, scene_title: result.scene_title } : {}),
    motivators: result?.attributes || [],
    ...(result?.chain_actions ? { chain_actions: result.chain_actions } : {}),
    ...(result?.tracking_knowledge_id ? { tracking_knowledge_id: result.tracking_knowledge_id } : {}),
  }
})


// ── Perspective tools (Phase 2.13e) ──────────────────────────────────
//
// Entity-only batch add / single update / batch remove for perspective
// attributes. Same architecture as motivator tools — perspectives are
// a specialised `attribute_type='perspective'` with target fields
// (perspective_target_kind + perspective_target_id) and a description
// body. Two routing paths:
//   - entity (no at)         → entity baseline attribute_type=
//                              'perspective' via canonical updateEntity.
//   - entity + at=<scene>    → chain-event write via add_attributes /
//                              update modify entries / remove_attributes.
//
// Targets cover all 7 valid kinds (5 entity kinds + knowledge +
// relationship). No is_temporary — perspectives aren't scene-scoped
// in v1.

/** Resolve a perspective reference (UUID, perspective's own name, OR
 *  target's name when the perspective has no name of its own) to its
 *  attribute object inside the provided list. Three resolution
 *  passes; first unambiguous match wins. */
function _resolvePerspectiveInList(list, ref) {
  if (!ref || typeof ref !== 'string') {
    throw new Error('perspective reference is required (UUID, perspective name, or target name).')
  }
  if (_isUuid(ref)) {
    const byId = list.find((p) => p.id === ref)
    if (byId) return byId
    throw new Error(`perspective not found by UUID: ${ref}.`)
  }
  const refLower = ref.toLowerCase()
  // Pass 1 — by perspective's own name (if set; perspectives often
  // have empty names so this misses for most rows).
  const byName = list.filter((p) => (p.name || '').toLowerCase() === refLower)
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) {
    throw new Error(
      `perspective name "${ref}" is ambiguous (${byName.length} matches on the host entity). Pass a UUID instead.`
    )
  }
  // Pass 2 — by target name. Resolve each perspective's
  // (target_kind, target_id) pair to a name and match. Orphaned-target
  // perspectives (both fields null after the cascade) can't be reached
  // this way — pass a UUID for those.
  const ps = useProjectStore.getState()
  const byTarget = list.filter((p) => {
    if (!p.perspective_target_kind || !p.perspective_target_id) return false
    let name = null
    if (p.perspective_target_kind === 'knowledge') {
      name = (ps.knowledges || []).find((x) => x.id === p.perspective_target_id)?.name
    } else if (p.perspective_target_kind === 'relationship') {
      name = (ps.relationships || []).find((x) => x.id === p.perspective_target_id)?.name
    } else {
      const found = _findEntity(p.perspective_target_id)
      name = found?.entity?.name
    }
    return name && name.toLowerCase() === refLower
  })
  if (byTarget.length === 1) return byTarget[0]
  if (byTarget.length > 1) {
    throw new Error(
      `perspective target name "${ref}" is ambiguous (${byTarget.length} matches on the host entity). Pass a UUID instead.`
    )
  }
  throw new Error(
    `perspective not found by name or target name: "${ref}". ` +
    `Use list_entities + get_entity(entity, at=...) to find the perspective's UUID, or pass the target's exact name.`
  )
}

registerMcpTool('add_perspectives', async (args) => {
  const { entity, type: entityType } = _resolveEntity(args?.entity)
  const itemsArg = args?.perspectives
  if (!Array.isArray(itemsArg) || itemsArg.length === 0) {
    throw new Error('perspectives must be a non-empty array of perspective objects (each with description + target { kind, ref })')
  }
  const at = args?.at
  const isOriginPath = !at || at === 'origin'

  // Pre-validate every per-item payload. Empty / malformed shape
  // throws with index attribution and no writes have landed.
  const payloads = []
  for (let i = 0; i < itemsArg.length; i++) {
    const item = itemsArg[i]
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`perspectives[${i}] must be an object with description + target`)
    }
    const desc = (item.description || '').trim()
    if (!desc) {
      throw new Error(`perspectives[${i}]: description is required (the perspective body — what this entity thinks/feels/believes about the target)`)
    }
    if (!item.target) {
      throw new Error(`perspectives[${i}]: target is required ({ kind, ref })`)
    }
    let target
    try {
      target = _resolvePerspectiveTarget(item.target)
    } catch (err) {
      throw new Error(`perspectives[${i}].target: ${err.message}`)
    }
    payloads.push({
      name: (item.name || '').trim(),
      description: desc,
      target,
    })
  }

  // Route through add_attributes — _buildAttributeFromMcpInput's
  // perspective branch handles the target resolution + validation
  // again, and the canonical add_attributes flow handles origin /
  // chain-anchor / auto-chip / track_as_knowledge / etc.
  const addAttrs = getMcpToolHandler('add_attributes')
  const attrItems = payloads.map((p) => ({
    attribute_type: 'perspective',
    name: p.name || undefined,
    description: p.description,
    target: { kind: p.target.kind, ref: p.target.id },
  }))
  const result = await addAttrs({
    entity: entity.id,
    attributes: attrItems,
    at: isOriginPath ? undefined : at,
    track_as_knowledge: args?.track_as_knowledge,
  })
  return {
    entity_id: entity.id,
    entity_type: entityType,
    scope: isOriginPath ? 'entity_baseline' : 'entity_scene_chain',
    ...(result?.scene_id ? { scene_id: result.scene_id, scene_title: result.scene_title } : {}),
    perspectives: result?.attributes || [],
    ...(result?.tracking_knowledge_id ? { tracking_knowledge_id: result.tracking_knowledge_id } : {}),
  }
})

registerMcpTool('update_perspective', async (args) => {
  const { entity, type: entityType } = _resolveEntity(args?.entity)
  const ref = args?.perspective
  if (!ref || typeof ref !== 'string') {
    throw new Error('perspective reference is required (UUID, perspective name, or target name).')
  }
  const at = args?.at
  const isOriginPath = !at || at === 'origin'

  // Locate the perspective at the active anchor. Origin path reads
  // baseline (chain-aware exit at origin); scene path reads chain-
  // resolved attributes at the scene.
  let perspList
  let sceneNode = null
  if (isOriginPath) {
    perspList = (entity.attributes || []).filter((a) => a.attribute_type === 'perspective')
  } else {
    sceneNode = _resolveScene(at)
    await _ensureEntityChipAtScene(sceneNode, entity.id)
    perspList = _attributesAtScene(entity, sceneNode.id).filter((a) => a.attribute_type === 'perspective')
  }
  const target = _resolvePerspectiveInList(perspList, ref)

  // Validate the patch fields. At least one of name / description /
  // target must be present (no-op edits reject cleanly).
  const hasName = args.name !== undefined
  const hasDesc = args.description !== undefined
  const hasTarget = args.target !== undefined
  if (!hasName && !hasDesc && !hasTarget) {
    throw new Error('no fields to update — pass at least one of name / description / target.')
  }
  let newTargetResolved = null
  if (hasTarget) {
    // `target: null` is explicit orphan (matches the cascade contract).
    // Otherwise resolve via the per-kind helper.
    if (args.target === null) {
      newTargetResolved = { kind: null, id: null }
    } else {
      newTargetResolved = _resolvePerspectiveTarget(args.target)
    }
  }

  if (isOriginPath) {
    // Origin path — rebuild the attribute baseline. The perspective's
    // own origin IS the entity origin here; writing the baseline is
    // the chain-aware path.
    const newAttr = {
      ...target,
      ...(hasName ? { name: String(args.name || '').trim() } : {}),
      ...(hasDesc ? { description: String(args.description || '').trim() } : {}),
      ...(hasTarget ? {
        perspective_target_kind: newTargetResolved.kind,
        perspective_target_id: newTargetResolved.id,
      } : {}),
    }
    const updated = {
      ...entity,
      attributes: (entity.attributes || []).map((a) => a.id === target.id ? newAttr : a),
    }
    await useEntitiesStore.getState().updateEntity(entity.id, updated)
    return {
      entity_id: entity.id,
      entity_type: entityType,
      scope: 'entity_baseline',
      perspective: _projectAttribute(newAttr),
    }
  }

  // Scene path — write modify chain entries with the new_* fields.
  // One entry per changed field so the chain history reads cleanly.
  const entries = []
  if (hasName) {
    const trimmed = String(args.name || '').trim()
    entries.push({ id: crypto.randomUUID(), action: 'rename', attribute_id: target.id, new_name: trimmed })
  }
  if (hasDesc) {
    entries.push({
      id: crypto.randomUUID(), action: 'modify', attribute_id: target.id,
      new_description: String(args.description || '').trim(),
    })
  }
  if (hasTarget) {
    entries.push({
      id: crypto.randomUUID(), action: 'modify', attribute_id: target.id,
      new_perspective_target_kind: newTargetResolved.kind,
      new_perspective_target_id: newTargetResolved.id,
    })
  }
  await _appendAttributeChainEntries(sceneNode, entity.id, entries)
  return {
    entity_id: entity.id,
    entity_type: entityType,
    scope: 'entity_scene_chain',
    scene_id: sceneNode.id,
    scene_title: sceneNode.data?.title || '',
    perspective: { id: target.id, applied: { name: hasName, description: hasDesc, target: hasTarget } },
  }
})

registerMcpTool('remove_perspectives', async (args) => {
  const { entity, type: entityType } = _resolveEntity(args?.entity)
  const itemsArg = args?.perspectives
  if (!Array.isArray(itemsArg) || itemsArg.length === 0) {
    throw new Error('perspectives must be a non-empty array of perspective references (UUID, perspective name, or target name). For a single perspective pass a one-element list.')
  }
  for (let i = 0; i < itemsArg.length; i++) {
    if (typeof itemsArg[i] !== 'string' || !itemsArg[i]) {
      throw new Error(`perspectives[${i}] must be a non-empty string (UUID, perspective name, or target name)`)
    }
  }
  const at = args?.at
  const isOriginPath = !at || at === 'origin'

  // Pre-resolve each ref so a bad ref errors with index attribution
  // before any writes land.
  let perspList
  let sceneNode = null
  if (isOriginPath) {
    perspList = (entity.attributes || []).filter((a) => a.attribute_type === 'perspective')
  } else {
    sceneNode = _resolveScene(at)
    await _ensureEntityChipAtScene(sceneNode, entity.id)
    perspList = _attributesAtScene(entity, sceneNode.id).filter((a) => a.attribute_type === 'perspective')
  }
  const targets = []
  for (let i = 0; i < itemsArg.length; i++) {
    try {
      targets.push(_resolvePerspectiveInList(perspList, itemsArg[i]))
    } catch (err) {
      throw new Error(`perspectives[${i}]: ${err.message}`)
    }
  }

  // Route through remove_attributes for the actual delete + chain
  // stripping. UUIDs are unambiguous; pass them through.
  const removeAttrs = getMcpToolHandler('remove_attributes')
  const result = await removeAttrs({
    entity: entity.id,
    attributes: targets.map((t) => t.id),
    at: isOriginPath ? undefined : at,
    track_as_knowledge: args?.track_as_knowledge,
  })
  return {
    entity_id: entity.id,
    entity_type: entityType,
    scope: isOriginPath ? 'entity_baseline' : 'entity_scene_chain',
    ...(result?.scene_id ? { scene_id: result.scene_id, scene_title: result.scene_title } : {}),
    perspectives: result?.attributes || [],
    ...(result?.chain_actions ? { chain_actions: result.chain_actions } : {}),
    ...(result?.tracking_knowledge_id ? { tracking_knowledge_id: result.tracking_knowledge_id } : {}),
  }
})


function _resolveCircumstanceInList(list, ref, kindLabel = 'circumstance') {
  if (_isUuid(ref)) {
    const byId = list.find((c) => c.id === ref)
    if (byId) return byId
    throw new Error(`${kindLabel} not found by UUID: ${ref}.`)
  }
  const refLower = ref.toLowerCase()
  const matches = list.filter((c) => (c.name || '').toLowerCase() === refLower)
  if (matches.length === 0) {
    throw new Error(`${kindLabel} not found by name: "${ref}".`)
  }
  if (matches.length > 1) {
    throw new Error(
      `${kindLabel} name "${ref}" is ambiguous (${matches.length} matches). ` +
      `Pass a UUID instead.`
    )
  }
  return matches[0]
}


// ── Alias write tools ──────────────────────────────────────────────────
//
// Per-alias goal-level tools shipped as the final commit of the
// aliases bugfix arc (started 2026-05-17). The model already supports
// per-alias chain events via `AliasChange` (actions: add / remove /
// modify / awareness_*); the underlying chain mechanism has been
// working since v0.2.1.76. These tools expose the chain operations
// as dedicated MCP affordances on top of the existing
// `update_entity(at=<scene>, aliases=[full-list])` path, which is
// itself a full-list replacement that delegates to the same chain
// events under the hood (v0.2.1.90).
//
// Use the dedicated tools when you want to surgically add / remove /
// rename a SPECIFIC alias without specifying the full list. Use
// `update_entity` when you want to set the entity's full alias list
// to a known value.

// ── Wave 2: add_alias ────────────────────────────────────────────────────

// ── Batch tool: add_aliases ─────────────────────────────────────────────
//
// Bulk-add one or more alias values on an entity in one call. Each
// item is an object `{ value: <string> }` (mirrors the per-item
// object shape used by add_attributes). Bare strings are accepted as
// a backward-compat shorthand and auto-promoted to `{ value }`.
// Same `at?` semantics as the other batch tools — omit / 'origin'
// for baseline, scene UUID or title for scene-anchored chain adds
// (one AliasChange entry per item).
//
// Pre-validates every value upfront — empty strings, within-batch
// duplicates, and existing-value collisions all rejected before any
// write commits. Atomic on both paths: origin commits via one
// `updateEntity` call; scene commits via one
// `_appendAliasChainEntries` call (which accepts the full list).

registerMcpTool('add_aliases', async (args) => {
  const at = args?.at
  const isOriginPath = !at || at === 'origin'

  const { entity } = _resolveEntity(args?.entity)

  const itemsArg = args?.aliases
  if (!Array.isArray(itemsArg) || itemsArg.length === 0) {
    throw new Error('aliases must be a non-empty array of alias objects (e.g. aliases=[{value: "Marc"}]). Bare strings are accepted as shorthand and auto-promoted to {value}.')
  }

  // Pre-validate track_as_knowledge (single-anchor rule).
  const trackArg = args?.track_as_knowledge
  if (trackArg !== undefined && trackArg !== null) {
    if (isOriginPath) {
      throw new Error(
        `track_as_knowledge requires a scene anchor (pass \`at=<scene>\`). ` +
        `Origin-path alias adds are baseline writes — no chain event to anchor to.`
      )
    }
    if (itemsArg.length !== 1) {
      throw new Error(
        `track_as_knowledge requires exactly one chain entry per call ` +
        `(the Knowledge anchors to one event). This batch has ${itemsArg.length} ` +
        `aliases. Split into separate add_aliases calls and pass track_as_knowledge ` +
        `on the one you want to anchor.`
      )
    }
    if (typeof trackArg === 'string') _resolveKnowledge(trackArg)
    else if (typeof trackArg === 'object' && !Array.isArray(trackArg)) {
      if (!(trackArg.name || '').trim()) {
        throw new Error('track_as_knowledge.name is required when creating a new Knowledge.')
      }
    } else {
      throw new Error(
        `track_as_knowledge must be a string (existing Knowledge UUID / name) ` +
        `or an object { name, description?, colour?, awareness_scale? }.`
      )
    }
  }

  // Per-item validation: accept either a bare string (auto-promoted
  // to {value}) or an object {value: <string>}. Same shape contract
  // as add_attributes — each item is an object with named fields.
  // Bare strings stay supported for terseness and backward-compat.
  const seenInBatch = new Set()
  const values = []
  for (let i = 0; i < itemsArg.length; i++) {
    const raw = itemsArg[i]
    let v
    if (typeof raw === 'string') {
      v = raw.trim()
    } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      if (raw.value === undefined || raw.value === null) {
        throw new Error(`aliases[${i}]: object form requires a 'value' field (e.g. {value: "Marc"}).`)
      }
      if (typeof raw.value !== 'string') {
        throw new Error(`aliases[${i}].value must be a string`)
      }
      v = raw.value.trim()
    } else {
      throw new Error(`aliases[${i}] must be either a string or an object {value: <string>}`)
    }
    if (!v) throw new Error(`aliases[${i}] is empty after trimming; aliases must be non-empty strings`)
    const lower = v.toLowerCase()
    if (seenInBatch.has(lower)) {
      throw new Error(`aliases[${i}]: duplicate value "${v}" within the batch — each alias must be unique in a single add_aliases call.`)
    }
    seenInBatch.add(lower)
    values.push(v)
  }

  if (isOriginPath) {
    // Duplicate-value guard against entity's existing baseline aliases.
    for (let i = 0; i < values.length; i++) {
      const lower = values[i].toLowerCase()
      const dup = (entity.aliases || []).some((a) => {
        const av = (typeof a === 'string') ? a : a?.value
        return av && av.toLowerCase() === lower
      })
      if (dup) {
        throw new Error(
          `aliases[${i}]: entity '${entity.name}' already has an alias with value "${values[i]}" at baseline. ` +
          `Either pick a different value, or use update_alias to rename the existing one.`
        )
      }
    }
    const newAliases = values.map((v) => ({ id: crypto.randomUUID(), value: v, awareness: null }))
    const updated = {
      ...entity,
      aliases: [...(entity.aliases || []), ...newAliases],
    }
    await useEntitiesStore.getState().updateEntity(entity.id, updated)
    return {
      entity_id: entity.id,
      aliases: newAliases.map((a) => ({ id: a.id, value: a.value })),
    }
  }

  // ─── SCENE PATH ──────────────────────────────────────────────────
  const sceneNode = _resolveScene(at)
  const sceneAliases = _aliasesAtScene(entity, sceneNode.id)
  for (let i = 0; i < values.length; i++) {
    const lower = values[i].toLowerCase()
    const dup = sceneAliases.some((a) => {
      const av = (typeof a === 'string') ? a : a?.value
      return av && av.toLowerCase() === lower
    })
    if (dup) {
      throw new Error(
        `aliases[${i}]: entity '${entity.name}' already has an alias with value "${values[i]}" ` +
        `scene-resolved at scene '${sceneNode.data?.title || sceneNode.id}'. ` +
        `Either pick a different value, or use update_alias(at=<scene>) to rename it.`
      )
    }
  }
  const newAliases = values.map((v) => ({ id: crypto.randomUUID(), value: v, awareness: null }))
  const changeEntries = newAliases.map((a) => ({
    id: crypto.randomUUID(),
    action: 'add',
    alias: a,
  }))
  await _appendAliasChainEntries(sceneNode, entity.id, changeEntries)

  // track_as_knowledge applies to the single entry when size === 1
  // (the constraint above already gated this).
  let trackingKnowledgeId = null
  if (trackArg !== undefined && trackArg !== null) {
    trackingKnowledgeId = await _applyKnowledgeTracking(trackArg, {
      event_type: 'alias_change',
      change_id: changeEntries[0].id,
      node_id: sceneNode.id,
      entity_id: entity.id,
      alias_id: newAliases[0].id,
    })
  }

  return {
    entity_id: entity.id,
    scene_id: sceneNode.id,
    scene_title: sceneNode.data?.title || '',
    aliases: newAliases.map((a) => ({ id: a.id, value: a.value })),
    chain_actions: changeEntries.map(() => 'add'),
    ...(trackingKnowledgeId ? { tracking_knowledge_id: trackingKnowledgeId } : {}),
  }
})

// ── Wave 2: update_alias ─────────────────────────────────────────────────

registerMcpTool('update_alias', async (args) => {
  const at = args?.at
  const isOriginPath = !at || at === 'origin'

  const { entity } = _resolveEntity(args?.entity)
  const newValue = (args?.new_value || '').trim()
  if (!newValue) throw new Error('new_value is required and must be non-empty')

  if (isOriginPath) {
    // ─── ORIGIN PATH (baseline write) ────────────────────────────
    const target = _resolveAlias(entity, args?.alias)
    // Duplicate-value guard for the new value (must not match any
    // other baseline alias).
    const newLower = newValue.toLowerCase()
    const dup = (entity.aliases || []).some((a) => {
      if (typeof a === 'object' && a?.id === target.id) return false
      const av = (typeof a === 'string') ? a : a?.value
      return av && av.toLowerCase() === newLower
    })
    if (dup) {
      throw new Error(
        `entity '${entity.name}' already has another alias with value "${newValue}" at baseline. ` +
        `Pick a different new_value.`
      )
    }
    const oldValue = target.value
    const updated = {
      ...entity,
      aliases: (entity.aliases || []).map((a) => {
        if (typeof a === 'object' && a?.id === target.id) {
          return { ...a, value: newValue }
        }
        return a
      }),
    }
    await useEntitiesStore.getState().updateEntity(entity.id, updated)
    return {
      entity_id: entity.id,
      alias_id: target.id,
      old_value: oldValue,
      value: newValue,
    }
  }

  // ─── SCENE PATH (scene-anchored chain event) ─────────────────
  const sceneNode = _resolveScene(at)
  const sceneAliases = _aliasesAtScene(entity, sceneNode.id)
  const target = _resolveAlias(entity, args?.alias, {
    aliasesList: sceneAliases,
    sceneId: sceneNode.id,
    sceneTitle: sceneNode.data?.title,
  })
  if (!target.id) {
    throw new Error(
      `alias "${target.value}" on '${entity.name}' has no id — cannot target it with a chain ` +
      `modify event. Pre-migration aliases without ids should have been migrated; this likely ` +
      `means the alias was added via a pre-v0.2.1.76 save path. Re-add the alias and try again.`
    )
  }
  // Duplicate-value guard for the new value at this scene's
  // effective state (excluding the alias being renamed).
  const newLower = newValue.toLowerCase()
  const dup = sceneAliases.some((a) => {
    if (typeof a === 'object' && a?.id === target.id) return false
    const av = (typeof a === 'string') ? a : a?.value
    return av && av.toLowerCase() === newLower
  })
  if (dup) {
    throw new Error(
      `entity '${entity.name}' already has another alias with value "${newValue}" ` +
      `scene-resolved at scene '${sceneNode.data?.title || sceneNode.id}'. ` +
      `Pick a different new_value.`
    )
  }
  const changeEntry = {
    id: crypto.randomUUID(),
    action: 'modify',
    alias_id: target.id,
    new_value: newValue,
  }
  await _appendAliasChainEntries(sceneNode, entity.id, [changeEntry])

  return {
    entity_id: entity.id,
    alias_id: target.id,
    old_value: target.value,
    value: newValue,
    scene_id: sceneNode.id,
    scene_title: sceneNode.data?.title || '',
    chain_action: 'modify',
  }
})

// ── Batch tool: remove_aliases ──────────────────────────────────────────
//
// Bulk-remove one or more aliases from an entity. Scene path records
// one `action='remove'` AliasChange per item (REMOVE semantics — the
// alias goes away from THIS scene forward; baseline + upstream entries
// untouched). Origin path filters items out of `entity.aliases[]`
// directly (downstream chain events that referenced them become no-op
// stubs; the walker tolerates them defensively).

registerMcpTool('remove_aliases', async (args) => {
  const at = args?.at
  const isOriginPath = !at || at === 'origin'
  const { entity } = _resolveEntity(args?.entity)

  const itemsArg = args?.aliases
  if (!Array.isArray(itemsArg) || itemsArg.length === 0) {
    throw new Error('aliases must be a non-empty array of alias references (UUID or exact value). For a single alias pass a one-element list.')
  }
  for (let i = 0; i < itemsArg.length; i++) {
    if (typeof itemsArg[i] !== 'string' || !itemsArg[i]) {
      throw new Error(`aliases[${i}] must be a non-empty string (UUID or exact alias value)`)
    }
  }

  if (!isOriginPath) {
    // ─── SCENE PATH (REMOVE) ───────────────────────────────────────
    const sceneNode = _resolveScene(at)
    const sceneAliases = _aliasesAtScene(entity, sceneNode.id)
    const targets = []
    for (let i = 0; i < itemsArg.length; i++) {
      let t
      try {
        t = _resolveAlias(entity, itemsArg[i], {
          aliasesList: sceneAliases,
          sceneId: sceneNode.id,
          sceneTitle: sceneNode.data?.title,
        })
      } catch (err) {
        throw new Error(`aliases[${i}]: ${err.message}`)
      }
      if (!t.id) {
        throw new Error(
          `aliases[${i}]: alias "${t.value}" on '${entity.name}' has no id — cannot target it with a chain ` +
          `remove event. Re-add the alias and try again.`
        )
      }
      targets.push(t)
    }
    const changeEntries = targets.map((t) => ({
      id: crypto.randomUUID(),
      action: 'remove',
      alias_id: t.id,
    }))
    await _appendAliasChainEntries(sceneNode, entity.id, changeEntries)
    return {
      entity_id: entity.id,
      scene_id: sceneNode.id,
      scene_title: sceneNode.data?.title || '',
      aliases: targets.map((t) => ({ id: t.id, value: t.value })),
      chain_actions: changeEntries.map(() => 'remove'),
    }
  }

  // ─── ORIGIN PATH ────────────────────────────────────────────────
  const targets = []
  for (let i = 0; i < itemsArg.length; i++) {
    let t
    try {
      t = _resolveAlias(entity, itemsArg[i])
    } catch (err) {
      throw new Error(`aliases[${i}]: ${err.message}`)
    }
    targets.push(t)
  }
  const targetIds = new Set(targets.map((t) => t.id).filter(Boolean))
  const updated = {
    ...entity,
    aliases: (entity.aliases || []).filter((a) => {
      if (typeof a === 'object' && a?.id && targetIds.has(a.id)) return false
      return true
    }),
  }
  await useEntitiesStore.getState().updateEntity(entity.id, updated)
  return {
    entity_id: entity.id,
    aliases: targets.map((t) => ({ id: t.id, value: t.value })),
  }
})


// ── Scene write tools ──────────────────────────────────────────────────
//
// Scene container metadata (title, description, main_content,
// is_flashback, parent_scene_id) is per-scene baseline data; scenes
// don't have their own history. They host changes to OTHER objects
// (entities / attributes / etc) but their own metadata fields are
// just baseline. So these tools route straight through `addSceneNode`
// / `updateNodeData` / `deleteObject('node', id)` — the same actions
// the UI uses when the user creates / edits / deletes a scene from
// the canvas.

// ── Wave 2: create_scene ────────────────────────────────────────────────

// ── D3+D4 Part B: time-pin vocabularies ─────────────────────────────
//
// Time-of-day has three tiers (broad / labelled / exact); the AI passes
// a single string and the resolver picks the tier based on shape.
//   - Broad-tier values ('day' / 'night') are model-canonical Literals
//     (backend `SceneNode.time_of_day_broad: Literal["day", "night"]`);
//     hardcoded here since any change would require a coordinated
//     backend model change.
//   - Labelled-tier vocabulary is imported from `TIME_OF_DAY_LABELS`
//     (the same array the modal's gearshift carousel renders from)
//     so MCP and UI can never drift on this set. Per-call match is
//     case-insensitive on input but stores the canonical Title-Case
//     form ("Late Morning", not "late morning") so the modal renders
//     the right glyph and downstream consumers see a stable casing.
//   - Exact-tier is the 24-hour HH:MM regex.
const _MCP_TOD_BROAD = ['day', 'night']
const _MCP_TOD_EXACT_RE = /^([01]\d|2[0-3]):([0-5]\d)$/
// `_MCP_TOD_LABELLED` removed — `TIME_OF_DAY_LABELS` imported directly
// from `components/ui/TimeOfDayCarousel.jsx` (single source of truth).

// ── Calendar-derived enum I/O ────────────────────────────────────────────
//
// Weekday / season / month I/O reads from the ACTIVE calendar object
// directly — `getActiveCalendar()` returns whichever calendar is
// currently installed (Gregorian by default, swappable to a custom
// sci-fi / fantasy provider). All MCP enum helpers below reference
// the calendar object's fields in-line — no parallel hardcoded copies
// here, and no helper wrappers around the calendar (the calendar IS
// the source of truth).
//
// Calendar shape — every provider exposes:
//     { weekdays: { long: string[] },
//       seasons:  { long: string[] },
//       months:   { long: string[] }, ... }
// See `gregorianCalendar.js` for the reference implementation.

/** Build a lowercase-name → index map from a label array, skipping
 *  empty/null entries. Used by the input resolvers to turn the
 *  active calendar's `long` arrays into case-insensitive lookups. */
function _labelsToNameMap(labels) {
  const out = {}
  for (let i = 0; i < labels.length; i++) {
    const v = labels[i]
    if (v && typeof v === 'string') out[v.toLowerCase()] = i
  }
  return out
}

/** Comma-joined human-readable list of valid names for the given
 *  enum, used in resolver error messages. */
function _joinNames(labels) {
  return labels.filter((l) => l && typeof l === 'string').join(' / ')
}

// Intensity input lowercase-name → index map (memoised at module-init).
// Sourced from `INTENSITY_LABELS` imported at the top of the file so a
// future label rename in `IntensityBadge.jsx` carries to MCP
// automatically.
const _MCP_INTENSITY_NAME_MAP = _labelsToNameMap(INTENSITY_LABELS)

/** Resolve an `intensity` arg into the canonical 0-N int the model
 *  stores, accepting EITHER an int OR a case-insensitive name from
 *  `INTENSITY_LABELS` (imported from `IntensityBadge.jsx`). null / ''
 *  clears. Mirrors the awareness `_resolveAwarenessLevel` pattern so
 *  AI clients can pass back the same string the projector emits
 *  without int translation. Range is derived from `INTENSITY_LABELS`
 *  length so a future ladder change carries through automatically. */
function _resolveIntensity(value) {
  if (value === null || value === undefined || value === '') return null
  const maxIdx = INTENSITY_LABELS.length - 1
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= maxIdx) return value
  if (typeof value === 'string') {
    const key = value.trim().toLowerCase()
    // Numeric-string fallback for the MCP bridge's int-stringify behaviour.
    if (/^\d+$/.test(key)) {
      const n = parseInt(key, 10)
      if (n >= 0 && n <= maxIdx) return n
    }
    if (key in _MCP_INTENSITY_NAME_MAP) return _MCP_INTENSITY_NAME_MAP[key]
  }
  throw new Error(
    `intensity "${value}" invalid. Expected a case-insensitive name string: ` +
    `'Faint' (1/5), 'Mild' (2/5), 'Moderate' (3/5), 'Strong' (4/5), or ` +
    `'Intense' (5/5). Pass null to clear back to unset (0/5).`
  )
}

/** Get the canonical name for an int weekday from the active calendar.
 *  Returns null on out-of-range / non-int. Gregorian: 0=Sunday..6=Saturday. */
function _weekdayName(n) {
  const labels = getActiveCalendar().weekdays?.long || []
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n >= labels.length) return null
  return labels[n] || null
}

/** Get the canonical name for an int season from the active calendar.
 *  Returns null on out-of-range / non-int. Gregorian: 0..3 temperate
 *  (Spring/Summer/Fall/Winter), 4..5 tropical (Wet/Dry). */
function _seasonName(n) {
  const labels = getActiveCalendar().seasons?.long || []
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n >= labels.length) return null
  return labels[n] || null
}

/** Get the canonical name for an int month from the active calendar.
 *  NOTE: `n` is 1-indexed (matches backend `date_month` which stores
 *  1-12 in Gregorian); the calendar's `months.long` array is 0-indexed.
 *  Returns null on out-of-range / non-int. */
function _monthName(n) {
  const labels = getActiveCalendar().months?.long || []
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > labels.length) return null
  return labels[n - 1] || null
}

/** Get the canonical intensity label for an int intensity, sourced
 *  from `INTENSITY_LABELS` (Faint / Mild / Moderate / Strong / Intense,
 *  corresponding to 1/5..5/5 on the surface). Returns null on
 *  out-of-range / non-int / null. */
function _intensityName(n) {
  if (n == null) return null
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n >= INTENSITY_LABELS.length) return null
  return INTENSITY_LABELS[n]
}

/** Compute walker-derived time info for one scene at its current chain
 *  position. Mirrors what the scene-card chip's leading segment + the
 *  Time Modal Section 3 display show the writer — the same gap-from-
 *  prior phrasing, same effective-start slot, same snap-forward
 *  indicator. Surfaced via MCP so the AI sees the same constraint info
 *  the writer sees, not just the raw pinned axes.
 *
 *  Returns an object with the walker-computed fields, or null when the
 *  scene isn't on the POV chain (the walker only produces output for
 *  POV-chain scenes). When the scene IS the chain's first scene,
 *  `time_since_prior_scene` is omitted (no prior to compare against)
 *  and `is_first_scene: true` flags the position.
 *
 *  Field shape:
 *    {
 *      is_first_scene: bool,
 *      effective_start_minutes: number (chain-relative minutes from origin),
 *      effective_start_display: "Day 6 · Late Morning",
 *      floor_minutes: number (earliest possible start before gap_extension),
 *      time_since_prior_scene: {
 *        minutes: number (effective_start - prior_end),
 *        display: "3 hours later" / "the next day" / "right after" / etc,
 *      },
 *      snap_forward: true (only present when set; indicates the
 *        writer's pin forced the floor past midnight to honour the label),
 *    }
 */
function _walkerDerivedTimeForScene(sceneNode) {
  const projectStore = useProjectStore.getState()
  const nodes = projectStore.nodes || []
  const edges = projectStore.edges || []
  const story = projectStore.story || {}
  const allowNegative = story?.allow_negative_time === true
  const timeFormat = story?.time_format || '12h'
  const povChain = computePovChain(nodes, edges)
  const sceneIdx = povChain.sequence.findIndex((e) => e.nodeId === sceneNode.id)
  if (sceneIdx < 0) return null   // off-chain — walker doesn't produce data
  // Walk the chain (cheap — pure compute) and pluck this scene's entry.
  const orderedSceneIds = povChain.sequence.map((e) => e.nodeId)
  const scenesById = new Map()
  for (const n of nodes) {
    if (n.type === 'sceneNode') scenesById.set(n.id, n.data)
  }
  const walkResult = walkPovChainTime({ orderedSceneIds, scenesById, allowNegative })
  const walkEntry = walkResult.get(sceneNode.id)
  if (!walkEntry) return null
  const sceneData = scenesById.get(sceneNode.id) || {}
  const thisTier = sceneData?.time_of_day_tier ?? null
  const out = {
    is_first_scene: !!walkEntry.isFirstScene,
    effective_start_minutes: walkEntry.effectiveStartMinutes,
    effective_start_display: formatSlot(walkEntry.effectiveStartMinutes, 'value-with-slot', { tier: thisTier, timeFormat }) || null,
    floor_minutes: walkEntry.floorMinutes,
  }
  if (!walkEntry.isFirstScene && sceneIdx > 0) {
    const priorId = orderedSceneIds[sceneIdx - 1]
    const priorScene = scenesById.get(priorId)
    const priorEntry = walkResult.get(priorId)
    if (priorScene && priorEntry) {
      // Elapsed gap = current effective start - prior end. Matches the
      // chip's leading-segment math (SceneTimeRow.jsx#showGapFromPrior)
      // and the modal's Section 3 visual. The walker's raw `gapMinutes`
      // is (effective - prior_effective) which differs from this
      // (this subtracts prior duration too) — formatGap expects the
      // post-end-of-prior figure per its docstring.
      const priorEnd = priorEntry.effectiveStartMinutes + (sceneDurationMinutes(priorScene) ?? 0)
      const elapsedGap = walkEntry.effectiveStartMinutes - priorEnd
      const priorTier = priorScene?.time_of_day_tier ?? null
      const gapTier = looserTier(priorTier, thisTier)
      const MIN_PER_DAY = 1440
      const dayShift = Math.floor(walkEntry.effectiveStartMinutes / MIN_PER_DAY)
                     - Math.floor(priorEnd / MIN_PER_DAY)
      const priorWeekday = (typeof priorScene?.weekday === 'number'
        && priorScene.weekday >= 0 && priorScene.weekday <= 6) ? priorScene.weekday : null
      const currentWeekday = (typeof sceneData?.weekday === 'number'
        && sceneData.weekday >= 0 && sceneData.weekday <= 6) ? sceneData.weekday : null
      const display = formatGap(elapsedGap, 'compact-gap', {
        tier: gapTier,
        timeFormat,
        priorBucket: sceneBucket(priorScene),
        currentBucket: sceneBucket(sceneData),
        priorWeekday,
        currentWeekday,
        priorLabel: priorScene?.time_of_day_labelled ?? null,
        currentLabel: sceneData?.time_of_day_labelled ?? null,
        priorDateMonth: (typeof priorScene?.date_month === 'number') ? priorScene.date_month : null,
        priorDateDay: (typeof priorScene?.date_day_of_month === 'number') ? priorScene.date_day_of_month : null,
        currentDateMonth: (typeof sceneData?.date_month === 'number') ? sceneData.date_month : null,
        currentDateDay: (typeof sceneData?.date_day_of_month === 'number') ? sceneData.date_day_of_month : null,
        dayShift,
      })
      out.time_since_prior_scene = {
        minutes: elapsedGap,
        display: display || null,
        prior_scene_id: priorId,
        prior_scene_title: priorScene?.title || '',
      }
    }
  }
  if (walkEntry.snapForward) {
    out.snap_forward = true
    // Surface the WHY of the snap as a short human-readable
    // explanation. Three possible causes (date pin / weekday pin /
    // time-of-day pin); the walker tags `snapReasonKind` per scene
    // so we can format a clear message. Important framing: a snap
    // means the EARLIEST POSSIBLE START moved forward to honour
    // the pin — any user-passed `gap` is still applied ADDITIVELY
    // on top of the snapped floor (gaps are additive, not in-lieu-
    // of). Without this `snap_reason` the client sees snap_forward
    // fire but can't tell which pin caused it. Surfaced 2026-05-18
    // in the blind-agent rom-com test (v2).
    const kind = walkEntry.snapReasonKind
    const val = walkEntry.snapReasonValue
    if (kind === 'date_pin' && val && typeof val === 'object') {
      const monthName = _monthName(val.month)
      const dateLabel = monthName
        ? (val.day != null ? `${monthName} ${val.day}` : monthName)
        : 'the pinned date'
      out.snap_reason = `Earliest start moved forward so this scene lands on its pinned date (${dateLabel}). Any pinned gap is still applied on top of the snapped floor.`
    } else if (kind === 'weekday_pin' && typeof val === 'number') {
      const wdName = _weekdayName(val) || 'the pinned weekday'
      out.snap_reason = `Earliest start moved forward so this scene lands on its pinned weekday (${wdName}). Any pinned gap is still applied on top of the snapped floor.`
    } else if (kind === 'time_of_day_pin') {
      out.snap_reason = `Earliest start moved forward so this scene lands at its pinned time of day (the pin would otherwise fall earlier on the same day than the chain had reached). Any pinned gap is still applied on top of the snapped floor.`
    }
  }
  return out
}

/**
 * Resolve a `time_of_day` MCP arg into the four-field tier payload the
 * scene model uses. `null` clears all four fields. String shapes:
 *
 *   - 'day' / 'night' → tier='broad', broad=value
 *   - One of the 15 labelled vocab values (case-sensitive match) →
 *     tier='labelled', labelled=value
 *   - 'HH:MM' (24h, 00:00 to 23:59) → tier='exact', exact=value
 *
 * Anything else throws with a list of valid options.
 */
function _resolveTimeOfDay(value) {
  if (value === null || value === '') {
    return {
      time_of_day_tier: null,
      time_of_day_broad: null,
      time_of_day_labelled: null,
      time_of_day_exact: null,
    }
  }
  if (typeof value !== 'string') {
    throw new Error(`time_of_day must be a string or null, got ${typeof value}`)
  }
  // Tier matching is case-insensitive on input but stores the canonical
  // form (lowercase for broad, Title-Case for labelled) so downstream
  // storage stays consistent and the UI renders the right glyph. Trims
  // surrounding whitespace too. Exact-tier is HH:MM, no casing concern.
  const trimmed = value.trim()
  const lower = trimmed.toLowerCase()
  const broadHit = _MCP_TOD_BROAD.find(b => b === lower)
  if (broadHit) {
    return {
      time_of_day_tier: 'broad',
      time_of_day_broad: broadHit,
      time_of_day_labelled: null,
      time_of_day_exact: null,
    }
  }
  const labelHit = TIME_OF_DAY_LABELS.find(l => l.toLowerCase() === lower)
  if (labelHit) {
    return {
      time_of_day_tier: 'labelled',
      time_of_day_broad: null,
      time_of_day_labelled: labelHit,
      time_of_day_exact: null,
    }
  }
  // Synonym: a common term (e.g. "Late Night") that resolves to a canonical
  // label ("Midnight"). The STORED value is the canonical label — no
  // save-format change; the synonym is an input convenience.
  const synonymHit = TIME_OF_DAY_LABEL_SYNONYMS[lower]
  if (synonymHit) {
    return {
      time_of_day_tier: 'labelled',
      time_of_day_broad: null,
      time_of_day_labelled: synonymHit,
      time_of_day_exact: null,
    }
  }
  if (_MCP_TOD_EXACT_RE.test(trimmed)) {
    return {
      time_of_day_tier: 'exact',
      time_of_day_broad: null,
      time_of_day_labelled: null,
      time_of_day_exact: trimmed,
    }
  }
  throw new Error(
    `time_of_day "${value}" doesn't match any tier. Valid forms: ` +
    `broad (${_MCP_TOD_BROAD.join(' | ')}), labelled ` +
    `(${TIME_OF_DAY_LABELS.map(displayTimeOfDayLabel).join(' | ')}), or exact 'HH:MM' (24h). ` +
    `Matching is case-insensitive; a "/" label accepts either name.`
  )
}

/**
 * Resolve a `weekday` arg (int OR case-insensitive day name) into the
 * 0-indexed int the model stores, or null when input is null/empty.
 * Accepted range and names come from the active calendar — Gregorian
 * is 0..6 (Sunday..Saturday); custom calendars define their own
 * weekday count + vocab.
 */
function _resolveWeekday(value) {
  if (value === null || value === '') return null
  const labels = getActiveCalendar().weekdays?.long || []
  const maxIdx = labels.length - 1
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= maxIdx) return value
  if (typeof value === 'string') {
    const key = value.trim().toLowerCase()
    // Numeric-string fallback — the MCP bridge stringifies some int args
    // (e.g. `weekday: 5` arrives as `"5"`).
    if (/^\d+$/.test(key)) {
      const n = parseInt(key, 10)
      if (n >= 0 && n <= maxIdx) return n
    }
    const map = _labelsToNameMap(labels)
    if (key in map) return map[key]
  }
  throw new Error(
    `weekday "${value}" invalid. Expected int 0-${maxIdx} or case-insensitive ` +
    `day name (${_joinNames(labels)}).`
  )
}

/**
 * Resolve a `season` arg (int OR case-insensitive name) into the
 * 0-indexed int the model stores, or null when input is null/empty.
 * Accepted range and names come from the active calendar — Gregorian
 * is 0..5 (0=Spring, 1=Summer, 2=Fall, 3=Winter, 4=Wet, 5=Dry). When
 * the calendar exposes a 'Fall' season, 'autumn' is also accepted as
 * an English synonym; custom calendars define their own season names.
 */
function _resolveSeason(value) {
  if (value === null || value === '') return null
  const labels = getActiveCalendar().seasons?.long || []
  const maxIdx = labels.length - 1
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= maxIdx) return value
  if (typeof value === 'string') {
    const key = value.trim().toLowerCase()
    if (/^\d+$/.test(key)) {
      const n = parseInt(key, 10)
      if (n >= 0 && n <= maxIdx) return n
    }
    const map = _labelsToNameMap(labels)
    // 'autumn' → Fall synonym when the calendar has a Fall season.
    const fallIdx = labels.findIndex((n) => (n || '').toLowerCase() === 'fall')
    if (fallIdx >= 0) map.autumn = fallIdx
    if (key in map) return map[key]
  }
  const hasFall = labels.some((l) => (l || '').toLowerCase() === 'fall')
  throw new Error(
    `season "${value}" invalid. Expected int 0-${maxIdx} or case-insensitive name ` +
    `(${_joinNames(labels)}${hasFall ? ' / autumn' : ''}).`
  )
}

/**
 * Resolve a `date` arg into the date_tier + date_month +
 * date_day_of_month payload. Accepts an object:
 *
 *   { month?: int 1-12 or name, day?: int 1-31 }
 *
 * - null / {} / undefined → clear date fields
 * - { month } → tier='month_dow', date_month set, day cleared
 * - { month, day } → tier='month_day_dow', both set
 * - { day } without month → error (day requires month for context)
 *
 * Note: weekday is NOT part of the date arg here — it's a separate
 * top-level arg per the audit verdict. The walker model keeps weekday
 * on its own field independently of date_tier.
 */
function _resolveDate(value) {
  if (value === null || value === undefined || (typeof value === 'object' && Object.keys(value).length === 0)) {
    return { date_tier: null, date_month: null, date_day_of_month: null }
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      `date must be null or an object { month?, day? }, got ${typeof value === 'object' ? 'array' : typeof value}.`
    )
  }
  // Reject unknown keys to surface typos (e.g. passing `weekday` inside
  // the date object instead of as a top-level arg).
  const allowed = new Set(['month', 'day'])
  const unknown = Object.keys(value).filter((k) => !allowed.has(k))
  if (unknown.length > 0) {
    throw new Error(
      `date has unknown field(s): ${unknown.join(', ')}. Allowed: month, day. ` +
      `(Weekday is a separate top-level arg, not part of the date object.)`
    )
  }
  let monthInt = null
  const monthLabels = getActiveCalendar().months?.long || []
  const monthMax = monthLabels.length
  if (value.month !== undefined && value.month !== null && value.month !== '') {
    if (typeof value.month === 'number' && Number.isInteger(value.month) && value.month >= 1 && value.month <= monthMax) {
      monthInt = value.month
    } else if (typeof value.month === 'string') {
      const key = value.month.trim().toLowerCase()
      // Build a lowercase-name → 1-indexed-int lookup directly from the
      // calendar's months array. (1-indexed because the backend stores
      // `date_month` as 1-12 for Gregorian; the array is 0-indexed.)
      const idx = monthLabels.findIndex((l) => (l || '').toLowerCase() === key)
      if (idx >= 0) {
        monthInt = idx + 1
      } else if (/^\d+$/.test(key)) {
        // Numeric-string fallback for the bridge's int-stringify behaviour.
        const n = parseInt(key, 10)
        if (n >= 1 && n <= monthMax) monthInt = n
      }
    }
    if (monthInt === null) {
      throw new Error(
        `date.month "${value.month}" invalid. Expected int 1-${monthMax} or ` +
        `case-insensitive month name (${_joinNames(monthLabels)}).`
      )
    }
  }
  let dayInt = null
  if (value.day !== undefined && value.day !== null && value.day !== '') {
    let dayCoerced = null
    if (typeof value.day === 'number' && Number.isInteger(value.day)) {
      dayCoerced = value.day
    } else if (typeof value.day === 'string' && /^\d+$/.test(value.day.trim())) {
      dayCoerced = parseInt(value.day.trim(), 10)
    }
    if (dayCoerced === null || dayCoerced < 1 || dayCoerced > 31) {
      throw new Error(`date.day "${value.day}" invalid. Expected int 1-31.`)
    }
    if (monthInt === null) {
      throw new Error(`date.day requires date.month — pass both, or omit day for a month-only pin.`)
    }
    dayInt = dayCoerced
  }
  if (monthInt === null) {
    return { date_tier: null, date_month: null, date_day_of_month: null }
  }
  return {
    date_tier: dayInt != null ? 'month_day_dow' : 'month_dow',
    date_month: monthInt,
    date_day_of_month: dayInt,
  }
}

/**
 * Resolve a `duration` arg into the SceneNode.scene_duration Duration
 * discriminated union. Accepts an object:
 *
 *   - null → clear (same effect as kind='ambiguous')
 *   - { kind: 'ambiguous' } → unspecified
 *   - { kind: 'minutes' | 'hours' | 'days', value?: number } → numeric
 *     of that unit; value optional ("on the order of X" without exact)
 *   - { kind: 'span', end_period: string } → span ending at the named
 *     period (vocab kept open — passes through to model for now)
 *   - { kind: 'all_day', all_day_variant?: string } → all-day variant
 */
function _resolveDuration(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`duration must be null or an object with a 'kind' field; got ${typeof value === 'object' ? 'array' : typeof value}.`)
  }
  // Empty dict {} → clear pin (one of the supported clear-sentinels along
  // with explicit clear_pins; see backend mcp_server.py).
  const keys = Object.keys(value)
  if (keys.length === 0) return null
  const kind = value.kind
  if (kind == null || kind === 'ambiguous') {
    _rejectUnknownDurationKeys(value, kind || 'ambiguous', ['kind'])
    return null
  }
  if (kind === 'minutes' || kind === 'hours' || kind === 'days') {
    _rejectUnknownDurationKeys(value, kind, ['kind', 'value'])
    const out = { kind }
    if (value.value !== undefined && value.value !== null) {
      const coerced = _coerceNumberMaybeString(value.value)
      if (coerced === null) {
        throw new Error(`duration.value must be a number for kind='${kind}'; got "${value.value}".`)
      }
      out.value = coerced
    }
    return out
  }
  if (kind === 'span') {
    _rejectUnknownDurationKeys(value, kind, ['kind', 'end_period'])
    const out = { kind: 'span' }
    if (value.end_period !== undefined) out.end_period = value.end_period
    return out
  }
  if (kind === 'all_day') {
    _rejectUnknownDurationKeys(value, kind, ['kind', 'all_day_variant'])
    const out = { kind: 'all_day' }
    if (value.all_day_variant !== undefined) out.all_day_variant = value.all_day_variant
    return out
  }
  if (kind === 'all_period') {
    _rejectUnknownDurationKeys(value, kind, ['kind'])
    return { kind: 'all_period' }
  }
  throw new Error(
    `duration.kind "${kind}" invalid. Valid kinds: ambiguous, minutes, hours, days, span, all_day, all_period.`
  )
}

/**
 * Helper for `_resolveDuration` — throws when `value` contains keys not
 * listed in `allowedKeys`. Catches the user passing e.g. `{kind: 'span',
 * from: '11:55', to: '12:30'}` when the actual span shape uses
 * `end_period`, which we'd otherwise silently drop.
 */
function _rejectUnknownDurationKeys(value, kind, allowedKeys) {
  const allowed = new Set(allowedKeys)
  const unknown = Object.keys(value).filter((k) => !allowed.has(k))
  if (unknown.length > 0) {
    throw new Error(
      `duration with kind='${kind}' has unknown field(s): ${unknown.join(', ')}. ` +
      `Allowed fields for this kind: ${allowedKeys.join(', ')}.`
    )
  }
}

/**
 * Coerce a value that should be a number — accepts actual numbers and
 * numeric strings (the MCP bridge stringifies some numeric args). Returns
 * the coerced number, or null when the value can't be coerced cleanly.
 */
function _coerceNumberMaybeString(value) {
  if (typeof value === 'number' && !Number.isNaN(value)) return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return null
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed)
      if (!Number.isNaN(n)) return n
    }
  }
  return null
}

/**
 * Resolve a `gap` arg into a TimeDelta `{ unit, value }`. Used for
 * `gap_extension` — the writer's pinned relative offset added to the
 * walker-computed Time-Since-Last-Scene floor. null clears the pin.
 */
function _resolveGap(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`gap must be null or { unit, value }; got ${typeof value === 'object' ? 'array' : typeof value}.`)
  }
  // Empty dict {} → clear pin (clear-sentinel — see backend mcp_server.py).
  const keys = Object.keys(value)
  if (keys.length === 0) return null
  // Reject unknown fields to surface typos rather than silently dropping.
  const allowed = new Set(['unit', 'value'])
  const unknown = keys.filter((k) => !allowed.has(k))
  if (unknown.length > 0) {
    throw new Error(
      `gap has unknown field(s): ${unknown.join(', ')}. Allowed: unit, value.`
    )
  }
  const validUnits = ['minutes', 'hours', 'days', 'weeks']
  if (!validUnits.includes(value.unit)) {
    throw new Error(`gap.unit "${value.unit}" invalid. Valid: ${validUnits.join(', ')}.`)
  }
  const coerced = _coerceNumberMaybeString(value.value)
  if (coerced === null || !Number.isInteger(coerced)) {
    throw new Error(`gap.value must be an integer; got "${value.value}".`)
  }
  return { unit: value.unit, value: coerced }
}

/**
 * Process the optional baseline-field args (`title` / `description` /
 * `main_content` / `is_flashback` / `parent_scene_id`, plus the D3+D4
 * Part B time pins) into a dataPatch object suitable for
 * `updateNodeData`. Pure — does not touch the store. The other D3+D4
 * args (`chapter`, `pov_character`, `pov_after`, `pov_before`,
 * `off_screen`) are handled separately in `_applySceneEnhancementArgs`
 * since they require store mutations beyond a single dataPatch write.
 */
function _buildSceneBaselineDataPatch(args) {
  const dataPatch = {}
  if (args.title !== undefined)            dataPatch.title = String(args.title)
  if (args.description !== undefined)      dataPatch.description = String(args.description)
  if (args.main_content !== undefined)     dataPatch.main_content = String(args.main_content)
  if (args.is_flashback !== undefined)     dataPatch.is_flashback = !!args.is_flashback
  if (args.parent_scene_id !== undefined) {
    if (args.parent_scene_id === null || args.parent_scene_id === '') {
      dataPatch.parent_scene_id = null
    } else {
      const parent = _resolveScene(args.parent_scene_id)
      dataPatch.parent_scene_id = parent.id
    }
  }
  // ── Pin clears (applied first; set-args below override) ─────────
  // `clear_pins` is the explicit clearing surface for time pins. The
  // JSON-null path is ambiguous over the MCP bridge for object-typed
  // args (pydantic rejects null/'' for dict types; None is filtered
  // out as 'not passed'). `clear_pins` accepts an array of pin names.
  if (args.clear_pins !== undefined && args.clear_pins !== null) {
    if (!Array.isArray(args.clear_pins)) {
      throw new Error(`clear_pins must be an array of pin names; got ${typeof args.clear_pins}.`)
    }
    const validPins = new Set(['time_of_day', 'weekday', 'season', 'date', 'duration', 'gap'])
    for (const pin of args.clear_pins) {
      if (!validPins.has(pin)) {
        throw new Error(
          `clear_pins entry "${pin}" invalid. Valid pin names: ${[...validPins].join(', ')}.`
        )
      }
      _applyPinClearToPatch(dataPatch, pin)
    }
  }
  // ── D3+D4 Part B: time pins ─────────────────────────────────────
  // Each resolver returns the appropriate sub-shape (tier discriminator
  // + leaf fields for the tiered fields, plain int/object for the
  // others). Spread the result into the patch so `updateNodeData`
  // writes only the affected fields and leaves others untouched.
  if (args.time_of_day !== undefined) {
    Object.assign(dataPatch, _resolveTimeOfDay(args.time_of_day))
  }
  if (args.weekday !== undefined) {
    dataPatch.weekday = _resolveWeekday(args.weekday)
  }
  if (args.season !== undefined) {
    dataPatch.season = _resolveSeason(args.season)
  }
  if (args.date !== undefined) {
    Object.assign(dataPatch, _resolveDate(args.date))
  }
  if (args.duration !== undefined) {
    dataPatch.scene_duration = _resolveDuration(args.duration)
  }
  if (args.gap !== undefined) {
    dataPatch.gap_extension = _resolveGap(args.gap)
  }
  return dataPatch
}

/**
 * Mutate `dataPatch` in place to clear all model fields backing the
 * given pin name. Mirrors the per-pin model shape — time_of_day spans
 * three tier fields; date spans tier + month + day_of_month; others
 * are single-field.
 */
function _applyPinClearToPatch(dataPatch, pin) {
  if (pin === 'time_of_day') {
    dataPatch.time_of_day_tier = null
    dataPatch.time_of_day_broad = null
    dataPatch.time_of_day_labelled = null
    dataPatch.time_of_day_exact = null
  } else if (pin === 'weekday') {
    dataPatch.weekday = null
  } else if (pin === 'season') {
    dataPatch.season = null
  } else if (pin === 'date') {
    dataPatch.date_tier = null
    dataPatch.date_month = null
    dataPatch.date_day_of_month = null
  } else if (pin === 'duration') {
    dataPatch.scene_duration = null
  } else if (pin === 'gap') {
    dataPatch.gap_extension = null
  }
}

/**
 * Apply the D3+D4 enhancement args (`chapter`, `pov_character`,
 * `pov_after`, `pov_before`, `off_screen`) to an existing scene.
 * Each arg is independently optional; passing none is a no-op.
 *
 * Mutual exclusion enforced for the POV-position args: at most one
 * of `pov_after`, `pov_before`, `off_screen=true` may appear in a
 * single call. Combining them surfaces a clear error before any
 * mutation runs.
 *
 * Default-append behaviour: when `pov_character` is set AND none of
 * the position args are passed AND the scene is NOT already on the
 * POV chain, the scene appends to the chain tail. When `pov_character`
 * is cleared (`null` / `''`), POV wires are stripped (off-screen).
 *
 * Returns a result summary `{ chapter_id?, pov_entity_id?, pov_placement? }`
 * surfacing what was applied so the caller can include it in the
 * tool's return shape.
 *
 * Side effects: writes via `updateNodeData` (chapter x-positioning,
 * pov_entity_id), `addEntityChipToNode` + `_autoConnectUpstreamForChain`
 * (POV character auto-chip + D2 auto-wire), `_insertSceneIntoPovChain`
 * (POV chain manipulation), `removePovWiresForScene` (POV clear).
 */
/**
 * Pure pre-validation pass over the scene-create / scene-update args.
 * Runs every throwing check that doesn't require an already-created
 * scene to exist: time-pin resolver throws, chapter-clear rejection,
 * chapter / pov_character / pov_after / pov_before reference resolution,
 * POV-position mutual exclusion. Returns the built dataPatch so the
 * caller doesn't have to rebuild it.
 *
 * The point: any throw the resolver would surface mid-mutation in
 * `_applySceneEnhancementArgs` or `_buildSceneBaselineDataPatch` is
 * surfaced FIRST, so `create_scene` can run pre-validation before
 * `addSceneNode` and abort cleanly without leaking an empty scene
 * onto the canvas.
 *
 * Does NOT mutate state. Subsequent re-resolution inside
 * `_applySceneEnhancementArgs` will succeed (or fail consistently)
 * since this helper proves the references exist at call time.
 */
function _preValidateSceneArgs(args) {
  const dataPatch = _buildSceneBaselineDataPatch(args)

  // Chapter: null / empty string is the un-chapter signal (handled in
  // _applySceneEnhancementArgs by moving the scene past the rightmost
  // chapter). Any non-null value must resolve to an existing chapter.
  if (args.chapter !== undefined && args.chapter !== null && args.chapter !== '') {
    _resolveChapter(args.chapter)
  }

  // POV-position mutual exclusion (same logic as the apply path).
  const posArgsSet = []
  if (args.pov_after  !== undefined && args.pov_after  !== null && args.pov_after  !== '') posArgsSet.push('after')
  if (args.pov_before !== undefined && args.pov_before !== null && args.pov_before !== '') posArgsSet.push('before')
  if (args.off_screen === true)                                                            posArgsSet.push('off_screen')
  if (posArgsSet.length > 1) {
    const argNames = posArgsSet.map((k) => k === 'after' ? 'pov_after' : k === 'before' ? 'pov_before' : 'off_screen=true')
    throw new Error(
      `POV position args are mutually exclusive — pass at most one of ` +
      `pov_after, pov_before, off_screen=true. Got: ${argNames.join(', ')}.`
    )
  }

  // pov_character: validate resolution + type when a non-clear value is passed.
  // The resolver's typeHint enforces character-only matching and emits a
  // self-describing "X is a <type>, not a character; pass a character ref or
  // omit pov_character for an off-screen scene"-style error if the wrong
  // type is passed. The redundant `type !== 'character'` defensive check
  // below stays as a belt-and-braces guard against any future resolver
  // change that loosens the type contract.
  if (args.pov_character !== undefined && args.pov_character !== null && args.pov_character !== '') {
    const { entity, type } = _resolveEntity(args.pov_character, 'character')
    if (type !== 'character') {
      throw new Error(
        `pov_character must reference a Character entity; '${entity.name}' is a ${type}. ` +
        `Pass a character ref, or omit pov_character / pass off_screen=true for an off-screen scene.`
      )
    }
  }

  // pov_after / pov_before reference resolution.
  if (args.pov_after !== undefined && args.pov_after !== null && args.pov_after !== '') {
    _resolveScene(args.pov_after)
  }
  if (args.pov_before !== undefined && args.pov_before !== null && args.pov_before !== '') {
    _resolveScene(args.pov_before)
  }

  return { dataPatch }
}

async function _applySceneEnhancementArgs(sceneNode, args) {
  const result = {}

  // ── Infer chapter from POV reference when chapter is unspecified ─
  // When `pov_after=X` or `pov_before=X` is passed WITHOUT an
  // explicit `chapter`, infer the new scene's intended chapter from
  // the referenced scene's chapter. This makes the spatial-matches-
  // chain-order outcome obvious: insert after X → land in X's
  // chapter, between X and X's successor. Without this inference
  // the new scene falls back to the linear cursor in the tidy pass
  // and ends up appended past every other scene in any chapter,
  // which is the regression the blind-agent edit test 2026-05-18
  // surfaced.
  //
  // When BOTH `chapter` AND `pov_after`/`pov_before` are explicit
  // AND they disagree, the user direction is: POV wire as
  // directed, scene placed in the EXPLICIT chapter. The existing
  // `pov_chapter_order` alert in useAlerts will fire automatically
  // when the chain crosses chapters in the wrong direction, so the
  // writer sees the consequence without us needing to emit
  // anything from here.
  //
  // `off_screen=true` does NOT trigger inference — off-screen
  // scenes can live anywhere, and the user controls placement
  // separately.
  if (args.chapter === undefined) {
    let povRef = null
    if (args.pov_after !== undefined && args.pov_after !== null && args.pov_after !== '') {
      try { povRef = _resolveScene(args.pov_after) } catch { povRef = null }
    } else if (args.pov_before !== undefined && args.pov_before !== null && args.pov_before !== '') {
      try { povRef = _resolveScene(args.pov_before) } catch { povRef = null }
    }
    if (povRef) {
      const projectState = useProjectStore.getState()
      const chaptersForInfer = projectState.story?.chapters || []
      const xOffsetForInfer = projectState.story?.chapter_x_offset ?? 10
      const refChapterId = getChapterIdForNode(povRef, chaptersForInfer, xOffsetForInfer)
      const refChapter = refChapterId ? chaptersForInfer.find((c) => c.id === refChapterId) : null
      if (refChapter) {
        // Mutate `args.chapter` so the existing chapter-set branch
        // below handles centring + intended-chapter tracking
        // identically to the explicit-chapter case. Use the
        // chapter's UUID since names may collide.
        args.chapter = refChapter.id
      }
    }
  }

  // ── Chapter membership via x-positioning ─────────────────────
  if (args.chapter !== undefined) {
    if (args.chapter === null || args.chapter === '') {
      // Un-chapter: move the scene's centre-x past the rightmost
      // chapter's right edge so `getChapterIdForNode` resolves the
      // scene's chapter to null. The 80 px buffer matches the
      // first-chapter UX guard's separation (projectStore.addChapter)
      // and the `addChapter` preservation guard for subsequent chapter
      // additions — those rules together keep off-chapter scenes at
      // the right end of the canvas and ensure they stay off-chapter
      // even when more chapters are added later (the addChapter guard
      // shifts off-chapter nodes right by the new chapter's width on
      // every chapter append).
      //
      // If there are no chapters at all, the scene is already
      // un-chaptered (no chapter ranges to belong to); no-op the
      // position change but still emit the null projection so the
      // response shape is consistent.
      const projectState = useProjectStore.getState()
      const chapters = projectState.story?.chapters || []
      if (chapters.length > 0) {
        const xOffset = projectState.story?.chapter_x_offset ?? 10
        let rightmost = xOffset
        for (const c of chapters) rightmost += c.width || 0
        const curScene = projectState.nodes.find((n) => n.id === sceneNode.id)
        const curPos = curScene?.position || { x: 0, y: 0 }
        const newX = rightmost + 80
        useProjectStore.getState().updateNodeData(sceneNode.id, {
          position: { x: newX, y: curPos.y },
        })
        useProjectStore.setState((s) => ({
          nodes: s.nodes.map((n) =>
            n.id === sceneNode.id
              ? { ...n, position: { x: newX, y: curPos.y } }
              : n,
          ),
          hasUnsavedChanges: true,
        }))
      }
      // Remove from the session-intended-chapter map (the scene is no
      // longer intended for any chapter; subsequent tidy passes
      // shouldn't pack it into one). Also remove from the session
      // scene-tracked set so tidy treats the un-chaptered scene as
      // user-positioned — keeping it at the rightmost-past position
      // we just set instead of repositioning it via the chapter cursor
      // or linear cursor.
      _mcpSessionSceneIntendedChapter.delete(sceneNode.id)
      _mcpSessionSceneNodeIds.delete(sceneNode.id)
      result.chapter_id = null
      result.chapter_title = null
      // Skip the chapter-set fall-through below since we handled the
      // null case here. Other args (pov, time pins, etc.) keep
      // processing below.
      args.chapter = undefined
    }
  }
  if (args.chapter !== undefined) {
    const chapter = _resolveChapter(args.chapter)
    const curScene = useProjectStore.getState().nodes.find((n) => n.id === sceneNode.id)
    const curPos = curScene?.position || { x: 0, y: 0 }
    // Centre the scene's CENTRE-X on the chapter centre — not its
    // left edge. The chapter-membership resolver (`getChapterIdForNode`)
    // uses the node's centre-x to decide membership; if we set
    // position.x = chapter centre directly, the node's centre lands at
    // `chapter centre + width/2`, which can fall past the chapter's
    // right edge (especially for narrow chapters) and misclassify the
    // scene into the next chapter. Mirror create_scene's smart
    // placement formula here.
    const sceneWidth = _nodeWidth(curScene || {}, MCP_SCENE_WIDTH_FALLBACK)
    const newX = _chapterCentreX(chapter) - Math.round(sceneWidth / 2)
    useProjectStore.getState().updateNodeData(sceneNode.id, {
      position: { x: newX, y: curPos.y },
    })
    // updateNodeData merges data, but position lives at node-level
    // not in data. Also patch via the React-Flow nodes array directly
    // so the on-canvas position updates.
    useProjectStore.setState((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === sceneNode.id
          ? { ...n, position: { x: newX, y: curPos.y } }
          : n,
      ),
      hasUnsavedChanges: true,
    }))
    // Record this scene's intended chapter so subsequent tidy passes
    // can honour it (widen the chapter as needed; preserve membership
    // across POV-order re-rowings). Also record the chapter's pre-MCP
    // width on first encounter so tidy can shrink it back if the
    // session no longer has scenes in it.
    _mcpSessionSceneIntendedChapter.set(sceneNode.id, chapter.id)
    if (!_mcpSessionChapterPreWidths.has(chapter.id)) {
      _mcpSessionChapterPreWidths.set(chapter.id, chapter.width || 0)
    }
    // Add this scene to the session-tracked set so the chapter-aware
    // tidy pass re-rows it inside the chapter cursor (left-to-right
    // packing) instead of leaving it stacked at the centre we set
    // above. Without this, every scene re-assigned to the same
    // chapter via `update_scene(chapter=...)` lands at the same
    // (centre - width/2) x and silently overlaps — the tidy only
    // re-positions scenes in `_mcpSessionSceneNodeIds`, treating
    // non-session scenes as user-positioned-don't-touch. The newX
    // we computed above is the initial "land somewhere inside the
    // chapter" position; tidy then takes over per-chapter cursor
    // placement so multiple assigned scenes get distinct x slots.
    _mcpSessionSceneNodeIds.add(sceneNode.id)
    result.chapter_id = chapter.id
    result.chapter_title = chapter.title || ''
  }

  // ── POV-position arg mutual exclusion ────────────────────────
  // posArgsSet uses the same kind-strings the dispatcher below
  // branches on (`after` / `before` / `off_screen` / `append`) so a
  // single source of truth governs both validation + dispatch.
  const posArgsSet = []
  if (args.pov_after  !== undefined && args.pov_after  !== null && args.pov_after  !== '') posArgsSet.push('after')
  if (args.pov_before !== undefined && args.pov_before !== null && args.pov_before !== '') posArgsSet.push('before')
  if (args.off_screen === true)                                                            posArgsSet.push('off_screen')
  if (posArgsSet.length > 1) {
    const argNames = posArgsSet.map((k) => k === 'after' ? 'pov_after' : k === 'before' ? 'pov_before' : 'off_screen=true')
    throw new Error(
      `POV position args are mutually exclusive — pass at most one of ` +
      `pov_after, pov_before, off_screen=true. Got: ${argNames.join(', ')}.`
    )
  }

  // ── POV character + chain placement ──────────────────────────
  let povEntityId = null
  let wantsOnChain = posArgsSet.length === 0 ? null : (posArgsSet[0] !== 'off_screen')

  if (args.pov_character !== undefined) {
    if (args.pov_character === null || args.pov_character === '') {
      // Clearing POV: strip wires + pov_entity_id via the canonical
      // removePovWiresForScene action.
      useProjectStore.getState().removePovWiresForScene(sceneNode.id)
      result.pov_entity_id = null
      result.pov_placement = 'off_screen'
      // Subsequent position args are ignored when POV is being cleared
      // — clearing IS off-screen. Don't double-apply.
      return result
    }
    const { entity, type } = _resolveEntity(args.pov_character, 'character')
    if (type !== 'character') {
      throw new Error(
        `pov_character must reference a Character entity; '${entity.name}' is a ${type}. ` +
        `Pass a character ref, or omit pov_character / pass off_screen=true for an off-screen scene.`
      )
    }
    povEntityId = entity.id

    // Auto-chip the character on the scene (with D2 auto-wire on
    // fresh chip) — same pattern as set_pov.
    const _povBuckets = ['characters', 'locations', 'items', 'factions', 'customs']
    const curScene = useProjectStore.getState().nodes.find((n) => n.id === sceneNode.id)
    const wasAlreadyChipped = _povBuckets.some((b) =>
      (curScene?.data?.[b] || []).some((r) => r.entity_id === povEntityId),
    )
    useProjectStore.getState().addEntityChipToNode(
      sceneNode.id, povEntityId, { skipUpstreamConfirm: true },
    )
    if (!wasAlreadyChipped) {
      try {
        await useProjectStore.getState()._autoConnectUpstreamForChain(sceneNode.id, povEntityId)
      } catch (err) {
        throw new Error(`update_scene/create_scene pov_character auto-wire failed: ${err.message}`)
      }
    }
    // Set pov_entity_id on the scene's data
    useProjectStore.getState().updateNodeData(sceneNode.id, { pov_entity_id: povEntityId })
    result.pov_entity_id = povEntityId

    // Default-append: when pov_character is set and no explicit POV
    // position is passed, append to the POV chain tail iff the scene
    // is not already on the chain.
    if (wantsOnChain === null) {
      const curEdges = useProjectStore.getState().edges
      const isAlreadyOnChain = curEdges.some(
        (e) => e.data?.is_pov_path && (e.source === sceneNode.id || e.target === sceneNode.id),
      )
      wantsOnChain = !isAlreadyOnChain
      if (wantsOnChain) posArgsSet.push('append')  // synthetic marker
    }
  }

  // ── POV chain insertion / removal ────────────────────────────
  if (posArgsSet.length > 0) {
    const kind = posArgsSet[0]
    if (kind === 'off_screen') {
      useProjectStore.getState().removePovWiresForScene(sceneNode.id)
      result.pov_placement = 'off_screen'
      // D2-part-two: off_screen does NOT trigger entity-continuity rewire
      // per the user's verdict (off-chain wires stay intact).
    } else {
      // Carry forward any pov_entity_id the scene already has so the
      // response shape stays accurate, but DO NOT require it. A scene
      // can sit on the POV chain without a POV character attached —
      // pov_entity_id is independent of chain wiring. When the AI
      // specifies `pov_after` / `pov_before` without `pov_character`,
      // wire the scene into the chain at the requested position and
      // leave the POV-character slot empty; the writer (or a later
      // `set_pov` call) can populate it when they know who should
      // carry it.
      if (povEntityId === null) {
        const curScene = useProjectStore.getState().nodes.find((n) => n.id === sceneNode.id)
        povEntityId = curScene?.data?.pov_entity_id || null
      }

      // D2-part-two: capture OLD POV neighbours BEFORE the reorg so the
      // rewire helper can compute the full affected-scene set (5 scenes
      // max: moved + old pred + old succ + new pred + new succ).
      const oldNeighbours = useProjectStore.getState()._getPovNeighboursOfScene(sceneNode.id)

      let placeResult
      if (kind === 'after') {
        const refScene = _resolveScene(args.pov_after)
        placeResult = useProjectStore.getState()._insertSceneIntoPovChain(
          sceneNode.id, { kind: 'after', refId: refScene.id },
        )
      } else if (kind === 'before') {
        const refScene = _resolveScene(args.pov_before)
        placeResult = useProjectStore.getState()._insertSceneIntoPovChain(
          sceneNode.id, { kind: 'before', refId: refScene.id },
        )
      } else {
        // 'append' (default or synthetic marker from earlier)
        placeResult = useProjectStore.getState()._insertSceneIntoPovChain(
          sceneNode.id, { kind: 'append' },
        )
      }
      result.pov_placement = placeResult.placed
      if (placeResult.ref_scene_id) result.pov_placement_ref = placeResult.ref_scene_id
      if (placeResult.tail_source_id) result.pov_placement_tail = placeResult.tail_source_id

      // D2-part-two: reconstruct entity-continuity wires for affected
      // entities so each affected chain matches the new POV temporal
      // order. MCP-only — UI-driven POV reorg paths don't run this.
      // 'append' from an empty chain has no old neighbours and the moved
      // scene's only new neighbour is the chain tail it just attached to
      // — still safe to call (the helper handles the trivial case).
      await useProjectStore.getState()._rewireEntityChainsForMcpPovReorg(
        sceneNode.id, oldNeighbours.predecessorId, oldNeighbours.successorId,
      )
    }
  }

  return result
}

registerMcpTool('create_scene', async (args) => {
  // Reject duplicate-title creates upfront. Without this, an MCP
  // client that retries a successful create (because the response
  // looked like an error from the AI's side, or because two parallel
  // plan paths land on the same title) silently produces two scenes
  // with identical titles. From that point on, name-based references
  // — `add_entity_to_scene(scene=<title>)`, `at=<title>` chain-write
  // args, `update_scene(scene=<title>)`, etc. — fail with the
  // ambiguous-reference error from `_resolveScene` until the writer
  // notices and manually renames. Forcing title uniqueness at create
  // time keeps the project addressable by name across the whole MCP
  // surface. Empty / whitespace titles are skipped — clearing a
  // title is a valid edit and untitled scenes don't carry a name to
  // collide on.
  if (typeof args?.title === 'string') {
    const titleLower = args.title.trim().toLowerCase()
    if (titleLower) {
      const existing = useProjectStore.getState().nodes.find(
        (n) => n.type === 'sceneNode'
          && (n.data?.title || '').trim().toLowerCase() === titleLower,
      )
      if (existing) {
        throw new Error(
          `scene title "${args.title}" already exists (id=${existing.id}). ` +
          `Scene titles are unique within a project so name-based references ` +
          `(add_entity_to_scene, at=<title>, etc.) always resolve. ` +
          `Use update_scene(scene="${existing.id}", ...) if you intended to ` +
          `modify the existing scene, or pass a different title.`
        )
      }
    }
  }

  // PRE-VALIDATE every throwing path BEFORE mutating state. Without
  // this, a bad time-pin shape / unknown chapter / type-mismatched
  // pov_character would create the scene first then throw on the
  // subsequent resolver call, leaking an empty scene onto the canvas.
  // `_preValidateSceneArgs` is pure — it builds the dataPatch and
  // verifies every reference, throwing on the first problem.
  const { dataPatch } = _preValidateSceneArgs(args)

  // Compute a smart non-overlapping placement based on the args
  // (POV neighbours, chapter, or rightmost-of-existing default).
  // Never random / viewport-blind — the AI driving MCP doesn't see
  // the user's viewport and shouldn't drop scenes on top of each
  // other or in places that contradict POV chain order. The
  // post-create `_mcpTidyLayout()` call further normalises the row
  // by re-positioning every MCP-session-created scene in POV chain
  // order — covers the case where this smart pre-placement landed
  // a scene at an x that conflicts with neighbours added in a later
  // call (mid-chain inserts that would otherwise collide).
  const position = _mcpComputeScenePosition(args)
  const id = useProjectStore.getState().addSceneNode(position)

  // Track for session-scoped tidy pass; tidy runs at end-of-handler
  // after POV chain has been wired so the chain-walk in tidy sees
  // the new scene in its correct chain position.
  _mcpSessionSceneNodeIds.add(id)

  if (Object.keys(dataPatch).length > 0) {
    useProjectStore.getState().updateNodeData(id, dataPatch)
  }

  // Apply D3+D4 enhancement args (chapter, pov_character, pov_after,
  // pov_before, off_screen) — each independently optional.
  //
  // Rollback on failure: `_applySceneEnhancementArgs` runs AFTER
  // `addSceneNode` has already committed the scene. Without a
  // rollback, any throw here leaves an orphan scene on the canvas
  // AND surfaces a `status: failure` response to the MCP client,
  // which then retries with adjusted args and produces a duplicate.
  // (Root cause of the 2026-06-03 conversation-log duplicate scenes:
  // first call had `pov_after` without `pov_character`, threw during
  // POV wiring, left a "Game of Chicken" scene orphaned; retry with
  // `pov_character` added then created a SECOND "Game of Chicken".)
  // On any throw: delete the just-added node via the canonical
  // delete dispatcher, drop it from the session tracking set so
  // tidy doesn't try to re-position it, and re-throw so the AI sees
  // a clean failure with no orphan to retry around.
  const sceneNode = useProjectStore.getState().nodes.find((n) => n.id === id)
  let enhancement
  try {
    enhancement = await _applySceneEnhancementArgs(sceneNode, args)
  } catch (err) {
    _mcpSessionSceneNodeIds.delete(id)
    try {
      await useProjectStore.getState().deleteObject('node', id)
    } catch {
      // Rollback's own failure is non-fatal — surfacing the original
      // enhancement error to the MCP client is what matters; an
      // orphan node left behind on a failed rollback is worse than
      // a successful rollback, but still better than swallowing the
      // root cause.
    }
    throw err
  }

  // Tidy the layout now that the POV chain reflects the new scene's
  // chain position. Moves only MCP-session-created nodes.
  _mcpTidyLayout()

  // Read the post-patch scene back so the return shape is accurate.
  const final = useProjectStore.getState().nodes.find((n) => n.id === id)
  // Walker-derived time info — same shape as get_scene.time.derived. Shows
  // the AI the resulting chain-position context (gap to prior scene with
  // the time-modal phrasing, effective start slot) so it can verify the
  // write landed where it expected. Omitted for off-POV-chain scenes.
  const derivedTime = final ? _walkerDerivedTimeForScene(final) : null
  return {
    id,
    title: final?.data?.title || '',
    ...(enhancement.chapter_id ? { chapter_id: enhancement.chapter_id, chapter_title: enhancement.chapter_title } : {}),
    ...(enhancement.pov_entity_id !== undefined ? { pov_entity_id: enhancement.pov_entity_id } : {}),
    ...(enhancement.pov_placement ? { pov_placement: enhancement.pov_placement } : {}),
    ...(enhancement.pov_placement_ref ? { pov_placement_ref: enhancement.pov_placement_ref } : {}),
    ...(enhancement.pov_placement_tail ? { pov_placement_tail: enhancement.pov_placement_tail } : {}),
    ...(derivedTime ? { time: { derived: derivedTime } } : {}),
  }
})

// ── Wave 2: update_scene ────────────────────────────────────────────────

registerMcpTool('update_scene', async (args) => {
  const sceneNode = _resolveScene(args?.scene)

  // Same uniqueness rule applied at create time — reject a rename
  // that would collide with another scene's title. Updating a scene
  // to its OWN current title is a no-op, not a collision, so we
  // filter `sceneNode.id` out of the search.
  if (typeof args?.title === 'string') {
    const titleLower = args.title.trim().toLowerCase()
    if (titleLower) {
      const existing = useProjectStore.getState().nodes.find(
        (n) => n.type === 'sceneNode'
          && n.id !== sceneNode.id
          && (n.data?.title || '').trim().toLowerCase() === titleLower,
      )
      if (existing) {
        throw new Error(
          `scene title "${args.title}" already exists (id=${existing.id}). ` +
          `Scene titles are unique within a project so name-based references ` +
          `(add_entity_to_scene, at=<title>, etc.) always resolve. ` +
          `Pass a different title.`
        )
      }
    }
  }

  // PRE-VALIDATE every throwing path BEFORE mutating state. Surfaces
  // bad time-pin shapes / unknown chapter / type-mismatched
  // pov_character / unknown pov_after|before references upfront so
  // partial-state mutations don't land when a later resolver throws.
  const { dataPatch } = _preValidateSceneArgs(args)

  // Validate at least ONE field is being touched (baseline or enhancement).
  const hasEnhancementArg = (
    args.chapter !== undefined ||
    args.pov_character !== undefined ||
    args.pov_after !== undefined ||
    args.pov_before !== undefined ||
    args.off_screen !== undefined
  )
  if (Object.keys(dataPatch).length === 0 && !hasEnhancementArg) {
    throw new Error(
      'no fields to update — pass at least one of: title, ' +
      'description, main_content, is_flashback, parent_scene_id, ' +
      'chapter, pov_character, pov_after, pov_before, off_screen, ' +
      'time_of_day, weekday, season, date, duration, gap, clear_pins.'
    )
  }

  if (Object.keys(dataPatch).length > 0) {
    useProjectStore.getState().updateNodeData(sceneNode.id, dataPatch)
  }

  // Apply D3+D4 enhancement args.
  const enhancement = await _applySceneEnhancementArgs(sceneNode, args)

  // Tidy MCP-session layout after the update lands. Same call
  // `create_scene` makes at end-of-handler: walks POV chain forward
  // and re-rows every session-tracked scene in chain order, honouring
  // chapter intent (widening narrow chapters to fit + sliding
  // downstream nodes; shrinking when emptied). Without this call,
  // `update_scene(chapter=…)` would set the scene's position via the
  // chapter-centre formula but not widen the chapter to fit, leaving
  // wide scenes straddling boundaries in narrow chapters.
  _mcpTidyLayout()

  // Read post-patch state back.
  const updated = useProjectStore.getState().nodes.find((n) => n.id === sceneNode.id)
  const data = updated?.data || {}
  // Walker-derived time info (same shape as get_scene.time.derived).
  // Surfaces the resulting chain-position context after the write —
  // gap-to-prior with time-modal phrasing, effective start slot — so
  // the AI sees the consequence of time/POV-placement changes without
  // a follow-up get_scene call.
  const derivedTime = updated ? _walkerDerivedTimeForScene(updated) : null
  return {
    id: sceneNode.id,
    title: data.title || '',
    description: data.description || '',
    main_content: data.main_content || '',
    is_flashback: !!data.is_flashback,
    parent_scene_id: data.parent_scene_id || null,
    ...(enhancement.chapter_id ? { chapter_id: enhancement.chapter_id, chapter_title: enhancement.chapter_title } : {}),
    ...(enhancement.pov_entity_id !== undefined ? { pov_entity_id: enhancement.pov_entity_id } : {}),
    ...(enhancement.pov_placement ? { pov_placement: enhancement.pov_placement } : {}),
    ...(enhancement.pov_placement_ref ? { pov_placement_ref: enhancement.pov_placement_ref } : {}),
    ...(enhancement.pov_placement_tail ? { pov_placement_tail: enhancement.pov_placement_tail } : {}),
    ...(derivedTime ? { time: { derived: derivedTime } } : {}),
  }
})

// ── Wave 2: delete_scene (DESTRUCTIVE) ──────────────────────────────────

registerMcpTool('delete_scene', async (args) => {
  // Backend has already passed both gates (session-active +
  // destructive approval) before this handler runs.
  const sceneNode = _resolveScene(args?.scene)
  const id = sceneNode.id
  const title = sceneNode.data?.title || ''

  // Use deleteObject('node', id) — the project's centralised
  // scene-aware node-deletion dispatcher. Same path the user-driven
  // "Delete scene" affordance uses; handles snapshot for undo,
  // cascade through entity chips on the scene, connection wires
  // to/from the scene, chain entries that lived on this scene's
  // chips, and chapter membership.
  await useProjectStore.getState().deleteObject('node', id)

  return { id, title }
})

// ── Canvas layout tool ───────────────────────────────────────────────
//
// `reorganize_canvas` — the AI's single goal-level affordance for
// canvas re-layout. Routes through the canonical `reorganizeCanvas`
// store action (same path the in-app "Reorganize canvas" toolbar
// button uses). Backend has already passed the destructive-approval
// gate (with `tone='amber'`) before this handler runs.

registerMcpTool('reorganize_canvas', async () => {
  useProjectStore.getState().reorganizeCanvas()
  return { status: 'applied' }
})


// ── POV + entity-presence tools ────────────────────────────────────────
//
// These tools operate on scene-container state (the scene's
// `pov_entity_id` field, the per-scene EntityRef chip arrays). They
// are NOT scene-tracked entity value writes — adding a chip records
// no chain mutation (the new EntityRef has all `*_change` fields
// null), removing a chip is REMOVE not DELETE (the entity
// baseline survives), and POV attachment lives on the scene node's
// data, not on any entity's chain.
//
// All three route through existing Zustand actions:
//   - set_pov → updateNodeData(sceneId, { pov_entity_id })
//     OR removePovWiresForScene(sceneId) for clear
//   - add_entity_to_scene → addEntityChipToNode(sceneId, entityId,
//     { skipUpstreamConfirm: true })
//   - remove_entity_from_scene → removeEntityChip(sceneId, entityId)
//
// "Chip" is internal UI vocabulary (the React component that
// renders an entity's presence on a scene); MCP-facing names use
// "in the scene" / "presence at the scene" instead.

// ── Wave 2: set_pov ────────────────────────────────────────────

registerMcpTool('set_pov', async (args) => {
  const sceneNode = _resolveScene(args?.scene)
  const characterRef = args?.character

  if (characterRef === undefined || characterRef === null || characterRef === '') {
    // Clear POV completely (also strips POV wires) — same path the
    // UI's "Remove POV" button uses. Scene is now off-POV-chain so
    // walker-derived block is null and omitted from the response.
    useProjectStore.getState().removePovWiresForScene(sceneNode.id)
    return {
      scene_id: sceneNode.id,
      pov_entity_id: null,
    }
  }

  // Resolve the character. Reject non-character entity types — POV
  // is character-only per the project's data model (`has_pov` and
  // `pov_entity_id` only meaningful for characters).
  const { entity, type } = _resolveEntity(characterRef, 'character')
  if (type !== 'character') {
    throw new Error(
      `set_pov must reference a Character entity; '${entity.name}' is a ${type}. ` +
      `Pass a character ref, or call set_pov(scene, null) / set_pov(scene) to clear POV (off-screen).`
    )
  }

  // Auto-chip the character on the scene if not already chipped.
  // Same skipUpstreamConfirm flag as update_entity's scene path so
  // the user-facing connect-wire dialog doesn't pop mid-tool-call.
  // D2 auto-wire runs on fresh-chip so set_pov also lands the
  // character into the entity's chain at this scene.
  const _povBuckets = ['characters', 'locations', 'items', 'factions', 'customs']
  const _wasAlreadyChipped = _povBuckets.some((b) =>
    (sceneNode.data?.[b] || []).some((r) => r.entity_id === entity.id),
  )
  useProjectStore.getState().addEntityChipToNode(
    sceneNode.id,
    entity.id,
    { skipUpstreamConfirm: true },
  )
  if (!_wasAlreadyChipped) {
    try {
      await useProjectStore.getState()._autoConnectUpstreamForChain(sceneNode.id, entity.id)
    } catch (err) {
      throw new Error(`set_pov auto-wire failed: ${err.message}`)
    }
  }

  // Set POV via updateNodeData — same canonical path as the UI's
  // POV-attach drag handlers. Stores the character id on the
  // scene's `pov_entity_id` field; the scene resolver reads from
  // there to determine which scenes are on the POV path.
  useProjectStore.getState().updateNodeData(sceneNode.id, { pov_entity_id: entity.id })

  // POV-chain placement: ensure the scene is actually ON the POV
  // chain. Without this, `pov_entity_id` is set but no POV wire
  // connects the scene to the chain, so `on_pov_path` / `pov_index`
  // would stay false / null and the walker-derived time block would
  // be empty — silently breaking the natural "set POV → scene
  // appears in the POV chain" expectation. Blind-agent smoke test
  // (2026-05-17) caught this gap: agent called set_pov, saw POV
  // attached, but couldn't figure out why the scene never appeared
  // on the POV path.
  //
  // Idempotent default-append: skip if the scene is already on the
  // chain (re-setting the POV character shouldn't re-wire); else
  // append to the chain tail via the canonical insert action —
  // same path `update_scene(pov_character=...)` uses (without an
  // explicit position arg). For non-default placement
  // (pov_after / pov_before / off_screen), the AI should use
  // `update_scene` directly — set_pov keeps its narrow scope.
  let povPlacement = null
  let povPlacementTail = null
  const currentChain = computePovChain(
    useProjectStore.getState().nodes,
    useProjectStore.getState().edges,
  )
  const alreadyOnChain = currentChain.sequence.some((e) => e.nodeId === sceneNode.id)
  if (!alreadyOnChain) {
    const placeResult = useProjectStore.getState()._insertSceneIntoPovChain(
      sceneNode.id,
      { kind: 'append' },
    )
    povPlacement = placeResult.placed || 'append'
    povPlacementTail = placeResult.tail_source_id || null
  }

  // Walker-derived time info — the scene is now on the POV chain so
  // surface its chain-position context (gap to prior scene with time-
  // modal phrasing, effective start slot). Mirrors the same shape
  // get_scene.time.derived emits.
  const updated = useProjectStore.getState().nodes.find((n) => n.id === sceneNode.id)
  const derivedTime = updated ? _walkerDerivedTimeForScene(updated) : null

  return {
    scene_id: sceneNode.id,
    pov_entity_id: entity.id,
    ...(povPlacement ? { pov_placement: povPlacement } : {}),
    ...(povPlacementTail ? { pov_placement_tail: povPlacementTail } : {}),
    ...(derivedTime ? { time: { derived: derivedTime } } : {}),
  }
})

// ── Wave 2: add_entity_to_scene ─────────────────────────────────────────

registerMcpTool('add_entity_to_scene', async (args) => {
  const sceneNode = _resolveScene(args?.scene)
  const itemsArg = args?.entities
  if (!Array.isArray(itemsArg) || itemsArg.length === 0) {
    throw new Error(
      'entities must be a non-empty array of entity references. Each item is ' +
      'either a bare string (UUID or exact name/alias) OR an object ' +
      '`{ entity: <ref>, predecessor?: <scene ref> }` where `predecessor` ' +
      "explicitly names the prior scene to chain from (use when auto-wire " +
      "reports an ambiguous upstream search). For a single entity, pass a " +
      'one-element list: entities=["Mira"] or entities=[{entity:"Mira", predecessor:"Scene 3"}].'
    )
  }
  // Pre-resolve every ref upfront — fail-fast on any bad reference
  // before any chip is added. Resolution errors include per-item
  // `entities[N]: ...` attribution. Per-item shape: either a bare
  // string or an object with `entity` + optional `predecessor`.
  const resolved = []
  for (let i = 0; i < itemsArg.length; i++) {
    const item = itemsArg[i]
    let entityRef = null
    let predecessorRef = null
    if (typeof item === 'string') {
      entityRef = item
    } else if (item && typeof item === 'object') {
      entityRef = item.entity
      predecessorRef = item.predecessor || null
      if (typeof entityRef !== 'string' || !entityRef) {
        throw new Error(
          `entities[${i}].entity must be a non-empty string (UUID or exact name/alias).`
        )
      }
      if (predecessorRef != null && typeof predecessorRef !== 'string') {
        throw new Error(
          `entities[${i}].predecessor must be a string scene reference (UUID or exact title) when provided.`
        )
      }
    } else {
      throw new Error(
        `entities[${i}] must be a string OR an object {entity, predecessor?}.`
      )
    }
    let r
    try {
      r = _resolveEntity(entityRef)
    } catch (err) {
      throw new Error(`entities[${i}]: ${err.message}`)
    }
    let predecessorNode = null
    if (predecessorRef) {
      try {
        predecessorNode = _resolveScene(predecessorRef)
      } catch (err) {
        throw new Error(`entities[${i}].predecessor: ${err.message}`)
      }
    }
    resolved.push({
      entity: r.entity,
      type: r.type,
      predecessorNodeId: predecessorNode?.id || null,
    })
  }

  // Commit per item. chip-add is idempotent; auto-wire fires only on
  // fresh chips. On auto-wire failure for a FRESH chip we roll the
  // chip back via removeEntityChip BEFORE throwing so the scene
  // returns to its pre-item state — no orphan chip left behind.
  // Items already committed earlier in the batch stay committed
  // (per-item atomicity, not batch-wide rollback); the error message
  // explains the cleanup.
  const out = []
  for (let i = 0; i < resolved.length; i++) {
    const { entity, type, predecessorNodeId } = resolved[i]
    const bucket = `${type}s`
    // Re-read the scene each iteration since earlier items may have
    // mutated it (e.g. added chips that change `existingRefs`).
    const curScene = useProjectStore.getState().nodes.find((n) => n.id === sceneNode.id)
    const existingRefs = curScene?.data?.[bucket] || []
    const alreadyInScene = existingRefs.some((r) => r.entity_id === entity.id)

    useProjectStore.getState().addEntityChipToNode(
      sceneNode.id, entity.id, { skipUpstreamConfirm: true },
    )

    let autoWired = null
    if (!alreadyInScene) {
      try {
        const result = await useProjectStore.getState()._autoConnectUpstreamForChain(
          sceneNode.id, entity.id, { predecessorNodeId },
        )
        autoWired = {
          source_node_id: result.sourceNodeId,
          from_origin: result.fromOrigin,
          ...(predecessorNodeId ? { from_predecessor: true } : {}),
        }
      } catch (err) {
        // Wire failed on a fresh chip — roll the chip back so the
        // scene returns to its pre-item state. Earlier items in the
        // batch stay committed (per-item atomicity). The error tells
        // the AI exactly how to recover (retry with `predecessor`).
        try {
          await useProjectStore.getState().removeEntityChip(sceneNode.id, entity.id)
        } catch (rollbackErr) {
          // Roll-back failure is exceptional — if it happens, surface
          // both errors so the user knows the scene MAY have an
          // orphan chip that needs manual cleanup.
          throw new Error(
            `entities[${i}] (${entity.name}): auto-wire failed: ${err.message}. ` +
            `ROLLBACK ALSO FAILED: ${rollbackErr.message}. ` +
            `The chip for '${entity.name}' may be left in the scene without a wire — ` +
            `inspect the scene and call remove_entity_from_scene manually if needed.`
          )
        }
        const hint = predecessorNodeId
          ? `The explicit predecessor was '${predecessorNodeId}'; verify the entity has a chip in that scene and try again.`
          : `Retry with the per-item 'predecessor' field naming the upstream scene to chain from, ` +
            `e.g. entities=[{entity:'${entity.name}', predecessor:'<scene title>'}].`
        throw new Error(
          `entities[${i}] (${entity.name}): auto-wire failed: ${err.message}. ` +
          `${i} entit${i === 1 ? 'y' : 'ies'} added successfully before this point. ` +
          `The chip for '${entity.name}' was rolled back so the scene is clean. ` +
          hint
        )
      }
    }

    out.push({
      entity_id: entity.id,
      already_in_scene: alreadyInScene,
      ...(autoWired ? { auto_wired: autoWired } : {}),
    })
  }

  return {
    scene_id: sceneNode.id,
    entities: out,
  }
})

// ── Wave 2: remove_entity_from_scene ────────────────────────────────────
//
// REMOVE not DELETE per the DELETE-vs-REMOVE distinction.
// The entity baseline survives; only the scene-anchored EntityRef
// on this scene is stripped. No destructive-approval modal fires.
// `removeEntityChip` is the canonical Zustand action — handles
// chip_order cleanup, temporary circumstance scrub, and POV
// auto-eject if this entity was carrying POV at the scene.
// (Internal action name keeps "Chip"; the MCP tool name does not.)

registerMcpTool('remove_entity_from_scene', async (args) => {
  const sceneNode = _resolveScene(args?.scene)
  const { entity, type } = _resolveEntity(args?.entity)

  // Pre-check that the entity is actually in the scene, so we can
  // surface a clean "not found" error instead of silently no-opping.
  const bucket = `${type}s`
  const existingRefs = sceneNode.data?.[bucket] || []
  if (!existingRefs.some((r) => r.entity_id === entity.id)) {
    throw new Error(
      `entity '${entity.name}' is not in scene ` +
      `'${sceneNode.data?.title || sceneNode.id}'. Nothing to remove.`
    )
  }

  // D2 auto-stitch: pass `autoStitchChain: true` so removeEntityChip
  // captures the entity's incoming + outgoing flow edges at this scene
  // BEFORE removing them, and rewires upstream → downstream directly
  // after the chip leaves. Single-side scenarios (only incoming OR
  // only outgoing) leave the surviving end as a chain terminus, no
  // stitch needed. Cycle-safeguarded; throws on loop.
  await useProjectStore.getState().removeEntityChip(sceneNode.id, entity.id, { autoStitchChain: true })

  return {
    scene_id: sceneNode.id,
    entity_id: entity.id,
  }
})


// ── Relationship write tools ───────────────────────────────────────────
//
// Relationships have their own baseline + their own
// scene-anchored history. The relationship's ORIGIN is the chain stop where
// it was established (its `creation_anchor_node_id`). At origin,
// writing baseline directly is the scene-aware path. Downstream
// scene-anchored changes go through history entries (name_changes,
// description_changes, hierarchy_changes for scalars; the dedicated
// participant_changes / role_changes / perception_changes /
// alias_changes lists for per-participant fields).
//
// All routes go through existing Zustand actions:
//   - createRelationship(relData) → POST /api/relationships/, builds
//     the rel with creation_anchor_node_id derived from initial joins.
//   - updateRelationship(id, relData) → PUT /api/relationships/{id},
//     baseline replacement.
//   - deleteObject('relationship', id) → centralised deletion path.
//   - addParticipant(relId, entityId, atNodeId, role?) → records
//     join chain event with normalised-history invariants enforced.
//   - removeParticipant(relId, entityId, atNodeId) → records leave
//     chain event with same invariants + cascade-on-zero.
//   - recordRelationshipChange(relId, { type, data }) → upserts
//     scalar chain entries (name / description / hierarchy /
//     existence at the per-node level).

// ── Wave 2: create_relationship ─────────────────────────────────────────

registerMcpTool('create_relationship', async (args) => {
  // Optional scene anchor: if provided, the relationship's origin
  // is the scene; if omitted, a fresh relationship-origin node is
  // placed on the canvas and the relationship anchors there.
  const sceneNode = (args?.scene !== undefined && args?.scene !== null && args?.scene !== '')
    ? _resolveScene(args.scene)
    : null

  // Resolve participants. Accept each as EITHER a plain entity ref (string)
  // OR an object `{ entity | entity_id | id | name, role? }` — the model
  // intuitively attaches roles inline per participant. Inline roles are
  // folded into participant_roles below.
  const inlineRoles = {}
  const participantRefs = Array.isArray(args?.participants) ? args.participants : []
  const resolvedParticipants = participantRefs.map((ref) => {
    if (ref && typeof ref === 'object' && !Array.isArray(ref)) {
      const entityRef = ref.entity ?? ref.entity_id ?? ref.id ?? ref.name
      if (entityRef === undefined || entityRef === null) {
        throw new Error(
          `each participant must be an entity ref (string) or an object with an ` +
          `'entity' (or 'entity_id') field; got ${JSON.stringify(ref)}`
        )
      }
      const ent = _resolveEntity(entityRef).entity
      if (ref.role) {
        inlineRoles[ent.id] = (typeof ref.role === 'string')
          ? { value: ref.role, preset_list_id: null } : ref.role
      }
      return ent
    }
    return _resolveEntity(ref).entity
  })

  // Build participant_roles from a `roles` map (keyed by entity ref) and/or
  // inline participant roles. AI keys the map by the same refs used in
  // `participants`; resolve each to its entity id.
  let participant_roles = undefined
  if (args?.roles && typeof args.roles === 'object') {
    participant_roles = {}
    for (const [refKey, roleValue] of Object.entries(args.roles)) {
      const { entity: keyEntity } = _resolveEntity(refKey)
      participant_roles[keyEntity.id] = (typeof roleValue === 'string')
        ? { value: roleValue, preset_list_id: null }
        : roleValue
    }
  }
  if (Object.keys(inlineRoles).length) {
    participant_roles = { ...(participant_roles || {}), ...inlineRoles }
  }

  // `hierarchy` is a structured HierarchyConfig object; the model frequently
  // passes a bare string. Treat flat/none/peer as "no structural ordering"
  // (null); reject other strings with a descriptive error rather than letting
  // the backend throw an opaque 422.
  let hierarchyArg = args?.hierarchy
  if (typeof hierarchyArg === 'string') {
    const h = hierarchyArg.trim().toLowerCase()
    if (h === '' || h === 'flat' || h === 'none' || h === 'peer' || h === 'equal' || h === 'null') {
      hierarchyArg = null
    } else {
      throw new Error(
        `hierarchy for a flat relationship should be omitted (or null). A structured ` +
        `hierarchy is a config object, not the string "${args.hierarchy}" — set that up ` +
        `in the app. Roles go in \`roles\` / per-participant \`role\`, not \`hierarchy\`.`
      )
    }
  }

  // Duplicate-participant guard (session 012): the model tends to create a
  // SECOND relationship for a pair it should have UPDATED at a later scene.
  // A soft description nudge wasn't enough, so reject by default when the new
  // participant set EXACTLY matches an existing (non-faction-membership)
  // relationship's ever-participants, and require force=true to override.
  const forced = args?.force === true || args?.force === 'true'
  const newParticipantIds = resolvedParticipants.map((p) => p.id)
  if (newParticipantIds.length > 0 && !forced) {
    const newSet = new Set(newParticipantIds)
    const existingRels = useProjectStore.getState().relationships || []
    const dup = existingRels.find((r) => {
      if (r.membership_of) return false  // faction membership is a distinct kind
      const everIds = _participantsEver(r)
      return everIds.length === newSet.size && everIds.every((id) => newSet.has(id))
    })
    if (dup) {
      const dupName = dup.name || '(unnamed)'
      const partNames = resolvedParticipants.map((p) => p.name).join(', ')
      throw new Error(
        `a relationship with exactly these participants (${partNames}) already exists: ` +
        `'${dupName}' (id=${dup.id}). To create a SECOND relationship between these same ` +
        `participants anyway, re-call create_relationship with force=true. Otherwise a ` +
        `relationship evolves along the chain, so to change its description, roles, status, ` +
        `hierarchy, or name at a later point, UPDATE the existing one (update_relationship / ` +
        `set_participant / add_participants with at=<scene>) rather than creating a duplicate.`
      )
    }
  }

  if (sceneNode) {
    // ─── Scene-anchored creation ─────────────────────────────
    // Origin = the scene; participants get join@scene entries.
    const joinEntries = resolvedParticipants.map((p) => ({
      node_id: sceneNode.id,
      entity_id: p.id,
      action: 'join',
    }))

    const relData = {
      name: args?.name || null,
      description: args?.description || '',
      hierarchy: hierarchyArg || null,
      awareness_scale: args?.awareness_scale || 'binary',
      creation_anchor_node_id: sceneNode.id,
      history: {
        existence_changes: [{ node_id: sceneNode.id, action: 'activate' }],
        participant_changes: joinEntries,
        perception_changes: [],
        alias_changes: [],
        role_changes: [],
        hierarchy_changes: [],
      },
    }
    if (participant_roles) relData.participant_roles = participant_roles

    const result = await useProjectStore.getState().createRelationship(relData)
    return {
      id: result.id,
      name: result.name || null,
      scene_id: sceneNode.id,
      origin_node_id: sceneNode.id,
      participant_ids: resolvedParticipants.map((p) => p.id),
    }
  }

  // ─── Origin-node creation (no scene) ─────────────────────
  // Pre-allocate ids so participants can join@originNode in the
  // same createRelationship call (mirrors createRelationshipViaEntityOrigin).
  const relId = crypto.randomUUID()
  const originNodeId = crypto.randomUUID()

  // Position: place on the dedicated relationship row via the
  // smart-placement helper so new relationship origins don't drop
  // onto entity origins. Surfaced 2026-05-18: prior placement used
  // `avg(participants' positions) + (80, 40)` which landed right on
  // the entity row.
  const originPos = _mcpComputeRelationshipNodePosition()

  // Snapshot once for the whole compound action so undo rolls back
  // both the node insert and the relationship create together.
  useProjectStore.getState()._snapshot()

  // Insert the relationship-origin node into local state directly
  // (bypasses createRelationshipOriginNode's own _snapshot since we
  // already took one).
  useProjectStore.setState({
    nodes: [
      ...useProjectStore.getState().nodes,
      {
        id: originNodeId,
        type: 'relationshipOriginNode',
        position: originPos,
        zIndex: 1000,
        data: {
          id: originNodeId,
          node_type: 'relationship_origin',
          relationship_id: relId,
          position: originPos,
        },
      },
    ],
    hasUnsavedChanges: true,
  })

  const joinEntries = resolvedParticipants.map((p) => ({
    node_id: originNodeId,
    entity_id: p.id,
    action: 'join',
    initial_perception: '',
    initial_alias_override: null,
  }))

  const relData = {
    id: relId,
    name: args?.name || null,
    description: args?.description || '',
    hierarchy: args?.hierarchy || null,
    awareness_scale: args?.awareness_scale || 'binary',
    creation_anchor_node_id: originNodeId,
    history: {
      existence_changes: [],
      participant_changes: joinEntries,
      perception_changes: [],
      alias_changes: [],
      role_changes: [],
      hierarchy_changes: [],
      name_changes: [],
      description_changes: [],
    },
  }
  if (participant_roles) relData.participant_roles = participant_roles

  const result = await useProjectStore.getState().createRelationship(relData)

  // Wire each participant's entity origin node into the relationship
  // origin node so the canvas shows the link visually.
  for (const p of resolvedParticipants) {
    useProjectStore.getState().ensureRelationshipOriginWire(p.id, result.id, originNodeId)
  }

  return {
    id: result.id,
    name: result.name || null,
    scene_id: null,
    origin_node_id: originNodeId,
    participant_ids: resolvedParticipants.map((p) => p.id),
  }
})

// ── Wave 2: delete_relationship (DESTRUCTIVE) ───────────────────────────

registerMcpTool('delete_relationship', async (args) => {
  // Backend has already passed both gates (session-active +
  // destructive approval) before this handler runs.
  const rel = _resolveRelationship(args?.relationship)
  const id = rel.id
  const name = rel.name || null

  // Centralised scene-aware deletion dispatcher — handles snapshot
  // for undo, strips chain entries / chips / wires across the project.
  await useProjectStore.getState().deleteObject('relationship', id)

  return { id, name }
})

// ── Wave 2: update_relationship (origin OR scene) ───────────────────────

registerMcpTool('update_relationship', async (args) => {
  const rel = _resolveRelationship(args?.relationship)
  const at = args?.at
  const isOriginPath = !at || at === 'origin'

  // Option F — reject track_as_knowledge on origin path.
  if (isOriginPath && args?.track_as_knowledge !== undefined && args?.track_as_knowledge !== null) {
    throw new Error(
      `track_as_knowledge requires a scene anchor (pass \`at=<scene>\`). ` +
      `Origin-path relationship edits are baseline writes — no chain event to anchor to.`
    )
  }

  if (isOriginPath) {
    // ─── ORIGIN PATH (baseline write) ────────────────────────────
    // Per chain rule, baseline writes at the relationship's origin
    // (its creation_anchor_node_id) ARE the scene-aware path.
    // updateRelationship → PUT /api/relationships/{id} replaces the
    // relationship's baseline.
    const updated = { ...rel }
    if (args.name !== undefined) updated.name = args.name || null
    if (args.description !== undefined) updated.description = String(args.description)
    if (args.hierarchy !== undefined) updated.hierarchy = args.hierarchy || null
    if (args.awareness_scale !== undefined) updated.awareness_scale = args.awareness_scale
    if (args.membership_of !== undefined) {
      updated.membership_of = args.membership_of
        ? _resolveEntity(args.membership_of).entity.id
        : null
    }
    const result = await useProjectStore.getState().updateRelationship(rel.id, updated)
    return _projectRelationshipOrigin(result)
  }

  // ─── SCENE PATH (scene-anchored change write) ────────────────────────────
  const sceneNode = _resolveScene(at)

  // Reject origin-only fields on the scene path.
  for (const k of ['membership_of', 'awareness_scale']) {
    if (args[k] !== undefined) {
      throw new Error(
        `Field '${k}' can only be set with at='origin' (or omitted) — ` +
        `it's not scene-tracked on the relationship's history.`
      )
    }
  }

  // Option F — pre-validate track_as_knowledge. Trackable scalars
  // (each gets its own SourceEventRef event_type): name / hierarchy /
  // status. `description` is chain-tracked but has no event_type in
  // the SourceEventRef enum — not trackable as a Knowledge event.
  // Require exactly one trackable scalar + no description.
  const trackArg = args?.track_as_knowledge
  if (trackArg !== undefined && trackArg !== null) {
    const trackable = ['name', 'hierarchy', 'status']
    const touchedTrackable = trackable.filter((k) => args[k] !== undefined)
    if (args.description !== undefined) {
      throw new Error(
        `track_as_knowledge cannot be combined with description (description ` +
        `changes have no Knowledge event_type in this version). Split into ` +
        `separate calls.`
      )
    }
    if (touchedTrackable.length === 0) {
      throw new Error(
        `track_as_knowledge requires exactly one trackable scalar change ` +
        `(name / hierarchy / status). None of those were passed.`
      )
    }
    if (touchedTrackable.length > 1) {
      throw new Error(
        `track_as_knowledge requires exactly one trackable scalar change per ` +
        `call. This call touches ${touchedTrackable.length} fields: ` +
        `${touchedTrackable.join(', ')}. Split into separate calls.`
      )
    }
    if (typeof trackArg === 'string') _resolveKnowledge(trackArg)
    else if (typeof trackArg === 'object' && !Array.isArray(trackArg)) {
      if (!(trackArg.name || '').trim()) {
        throw new Error('track_as_knowledge.name is required when creating a new Knowledge.')
      }
    } else {
      throw new Error(
        `track_as_knowledge must be a string (existing Knowledge UUID / name) ` +
        `or an object { name, description?, colour?, awareness_scale? }.`
      )
    }
  }

  // Record chain entries via recordRelationshipChange. Each scalar
  // is a separate change-type call. Capture the change_id we generate
  // here so Option F can build the SourceEventRef post-change.
  let touched = false
  const generatedIds = {}  // { name?, description?, hierarchy?, status? }
  // Field-name note: the chain-entry models use type-specific field
  // names (NameChange.new_name, DescriptionChange.new_description,
  // HierarchyChange.new_hierarchy) — NOT a generic `value` field.
  // Earlier MCP handler code wrote `value: ...` here, which Pydantic
  // either stripped or the walker silently ignored (since it reads
  // `ch.new_name` etc), with the net effect that the chain entry
  // existed but resolved to null. Use the correct per-type field
  // names so the walker actually picks the values up.
  if (args.name !== undefined) {
    generatedIds.name = crypto.randomUUID()
    await useProjectStore.getState().recordRelationshipChange(rel.id, {
      type: 'name',
      data: { id: generatedIds.name, node_id: sceneNode.id, new_name: args.name || null },
    })
    touched = true
  }
  if (args.description !== undefined) {
    generatedIds.description = crypto.randomUUID()
    await useProjectStore.getState().recordRelationshipChange(rel.id, {
      type: 'description',
      data: { id: generatedIds.description, node_id: sceneNode.id, new_description: String(args.description) },
    })
    touched = true
  }
  if (args.hierarchy !== undefined) {
    generatedIds.hierarchy = crypto.randomUUID()
    await useProjectStore.getState().recordRelationshipChange(rel.id, {
      type: 'hierarchy',
      data: { id: generatedIds.hierarchy, node_id: sceneNode.id, new_hierarchy: args.hierarchy || null },
    })
    touched = true
  }
  if (args.status !== undefined) {
    // status: 'active' | 'ended' → existence_changes activate / deactivate.
    // The chain layer (recordRelationshipChange's existence pair-cancel
    // rule) auto-strips opposite-action entries at the same node, so
    // writing 'active' at a scene that has a prior 'ended' acts as a
    // revert; same-action duplicate is a no-op.
    if (args.status !== 'active' && args.status !== 'ended') {
      throw new Error(
        `'status' must be 'active' or 'ended', got: ${args.status}`
      )
    }
    const action = args.status === 'ended' ? 'deactivate' : 'activate'
    generatedIds.status = crypto.randomUUID()
    await useProjectStore.getState().recordRelationshipChange(rel.id, {
      type: 'existence',
      data: { id: generatedIds.status, node_id: sceneNode.id, action },
    })
    touched = true
  }

  if (!touched) {
    throw new Error(
      'no scene-tracked field provided. At a scene anchor, you must ' +
      'pass at least one of: name, description, hierarchy, status.'
    )
  }

  // Option F — build SourceEventRef from the captured change_id.
  let trackingKnowledgeId = null
  if (trackArg !== undefined && trackArg !== null) {
    const eventTypeMap = {
      name: 'relationship_name_change',
      hierarchy: 'relationship_hierarchy_change',
      status: 'relationship_existence_change',
    }
    const touchedKey = ['name', 'hierarchy', 'status'].find((k) => args[k] !== undefined)
    trackingKnowledgeId = await _applyKnowledgeTracking(trackArg, {
      event_type: eventTypeMap[touchedKey],
      change_id: generatedIds[touchedKey],
      node_id: sceneNode.id,
      relationship_id: rel.id,
    })
  }

  // Read post-change rel + return the SCENE-RESOLVED projection so the
  // response reflects the chain entries we just recorded (and not the
  // unchanged baseline). Pre-this-fix the return spread the baseline
  // projection, which meant a caller passing `name="X"` at a scene got
  // a response showing the baseline name instead of "X" — surfaced
  // during a blind usability test, the agent literally couldn't tell
  // from the response whether their change landed. Shared
  // `_projectRelationshipAtScene` helper keeps the get/update return
  // shapes in lockstep.
  const updated = useProjectStore.getState().relationships.find((r) => r.id === rel.id)
  return {
    ..._projectRelationshipAtScene(updated, sceneNode),
    ...(trackingKnowledgeId ? { tracking_knowledge_id: trackingKnowledgeId } : {}),
  }
})

// ── Batch tool: add_participants ───────────────────────────────────────
//
// Bulk-add one or more participants to a relationship in one call.
// All items share the relationship + at + track_as_knowledge. Each
// item is `{ entity, role? }` — entity ref (UUID or exact name/alias),
// optional role (string or ParticipantRole object).
//
// Pre-validates every ref + role upfront. track_as_knowledge requires
// the batch to produce exactly 1 chain entry (the Knowledge anchors
// to one event); multi-item batches with track_as_knowledge reject.

registerMcpTool('add_participants', async (args) => {
  const rel = _resolveRelationship(args?.relationship)
  const at = args?.at
  const isOriginPath = !at || at === 'origin'

  const itemsArg = args?.participants
  if (!Array.isArray(itemsArg) || itemsArg.length === 0) {
    throw new Error('participants must be a non-empty array of { entity, role? } objects. For a single participant pass a one-element list: participants=[{entity: "Mira"}].')
  }

  // Resolve the target node id once. Origin path → relationship's
  // creation_anchor_node_id (scene id when scene-anchored, a
  // RelationshipOriginNode id otherwise). Scene path → resolve the scene.
  const atNodeId = isOriginPath
    ? rel.creation_anchor_node_id
    : _resolveScene(at).id
  if (!atNodeId) {
    throw new Error(
      `relationship has no creation_anchor_node_id; cannot add baseline ` +
      `participants. Pass an explicit scene via 'at' instead.`
    )
  }

  // Pre-validate track_as_knowledge. Requires the resolved anchor to
  // be a SceneNode + batch size === 1.
  const trackArg = args?.track_as_knowledge
  if (trackArg !== undefined && trackArg !== null) {
    const atNode = useProjectStore.getState().nodes.find((n) => n.id === atNodeId)
    if (atNode?.type !== 'sceneNode') {
      throw new Error(
        `track_as_knowledge requires the anchor to be a scene. This call ` +
        `lands on a non-scene origin node — pass \`at=<scene>\` instead.`
      )
    }
    if (itemsArg.length !== 1) {
      throw new Error(
        `track_as_knowledge requires exactly one chain entry per call ` +
        `(the Knowledge anchors to one event). This batch has ${itemsArg.length} ` +
        `participants. Split into separate add_participants calls and pass ` +
        `track_as_knowledge on the one you want to anchor.`
      )
    }
    if (typeof trackArg === 'string') _resolveKnowledge(trackArg)
    else if (typeof trackArg === 'object' && !Array.isArray(trackArg)) {
      if (!(trackArg.name || '').trim()) {
        throw new Error('track_as_knowledge.name is required when creating a new Knowledge.')
      }
    } else {
      throw new Error(
        `track_as_knowledge must be a string (existing Knowledge UUID / name) ` +
        `or an object { name, description?, colour?, awareness_scale? }.`
      )
    }
  }

  // Pre-resolve each entity + normalize role upfront.
  const resolved = []
  for (let i = 0; i < itemsArg.length; i++) {
    const item = itemsArg[i]
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`participants[${i}] must be an object with an entity ref + optional role`)
    }
    if (!item.entity) {
      throw new Error(`participants[${i}].entity is required (UUID or exact name/alias)`)
    }
    let r
    try {
      r = _resolveEntity(item.entity)
    } catch (err) {
      throw new Error(`participants[${i}]: ${err.message}`)
    }
    let role
    if (item.role !== undefined && item.role !== null) {
      role = (typeof item.role === 'string')
        ? { value: item.role, preset_list_id: null }
        : item.role
    }
    resolved.push({ entity: r.entity, role })
  }

  // Commit per item via the canonical addParticipant action (handles
  // normalized-history invariants like same-node pair cancellation).
  for (const item of resolved) {
    await useProjectStore.getState().addParticipant(rel.id, item.entity.id, atNodeId, item.role)
  }

  // Read post-change state once for the return shape.
  const updated = useProjectStore.getState().relationships.find((r) => r.id === rel.id)

  // track_as_knowledge applies to the single join entry (batch size
  // === 1 already enforced above).
  let trackingKnowledgeId = null
  if (trackArg !== undefined && trackArg !== null) {
    const joinEntry = (updated?.history?.participant_changes || []).find(
      (c) => c?.entity_id === resolved[0].entity.id && c?.action === 'join' && c?.node_id === atNodeId,
    )
    if (!joinEntry?.id) {
      throw new Error(
        `track_as_knowledge: could not locate the post-change join entry ` +
        `(this may indicate pair-cancellation absorbed the change). Skipped.`
      )
    }
    trackingKnowledgeId = await _applyKnowledgeTracking(trackArg, {
      event_type: 'relationship_participant_change',
      change_id: joinEntry.id,
      node_id: atNodeId,
      relationship_id: rel.id,
      entity_id: resolved[0].entity.id,
    })
  }

  return {
    relationship_id: rel.id,
    scene_id: isOriginPath ? null : atNodeId,
    origin_node_id: rel.creation_anchor_node_id || null,
    participants: resolved.map((r) => ({ entity_id: r.entity.id })),
    participant_ids_ever: _participantsEver(updated),
    ...(trackingKnowledgeId ? { tracking_knowledge_id: trackingKnowledgeId } : {}),
  }
})

// ── Batch tool: remove_participants ────────────────────────────────────
//
// Bulk-remove one or more participants from a relationship. All items
// share the batch-level `at` + `track_as_knowledge`. Pre-resolves
// every entity ref upfront with per-item attribution. Cascade
// awareness: if removing the participants drops the relationship to
// zero effective members, the relationship itself is cascade-deleted
// (`cascaded: true` flagged in the response); when this happens the
// loop short-circuits — subsequent items in the batch report as
// already-cascaded.

registerMcpTool('remove_participants', async (args) => {
  const rel = _resolveRelationship(args?.relationship)
  const at = args?.at
  const isOriginPath = !at || at === 'origin'

  const itemsArg = args?.participants
  if (!Array.isArray(itemsArg) || itemsArg.length === 0) {
    throw new Error('participants must be a non-empty array of entity references (UUID or exact name/alias). For a single participant pass a one-element list.')
  }

  const atNodeId = isOriginPath
    ? rel.creation_anchor_node_id
    : _resolveScene(at).id
  if (!atNodeId) {
    throw new Error(
      `relationship has no creation_anchor_node_id; cannot remove baseline ` +
      `participants. Pass an explicit scene via 'at' instead.`
    )
  }

  // Pre-validate track_as_knowledge (single-anchor rule).
  const trackArg = args?.track_as_knowledge
  if (trackArg !== undefined && trackArg !== null) {
    const atNode = useProjectStore.getState().nodes.find((n) => n.id === atNodeId)
    if (atNode?.type !== 'sceneNode') {
      throw new Error(
        `track_as_knowledge requires the anchor to be a scene. This call ` +
        `lands on a non-scene origin node — pass \`at=<scene>\` instead.`
      )
    }
    if (itemsArg.length !== 1) {
      throw new Error(
        `track_as_knowledge requires exactly one chain entry per call ` +
        `(the Knowledge anchors to one event). This batch removes ${itemsArg.length} ` +
        `participants. Split into separate remove_participants calls and pass ` +
        `track_as_knowledge on the one you want to anchor.`
      )
    }
    if (typeof trackArg === 'string') _resolveKnowledge(trackArg)
    else if (typeof trackArg === 'object' && !Array.isArray(trackArg)) {
      if (!(trackArg.name || '').trim()) {
        throw new Error('track_as_knowledge.name is required when creating a new Knowledge.')
      }
    } else {
      throw new Error(
        `track_as_knowledge must be a string (existing Knowledge UUID / name) ` +
        `or an object { name, description?, colour?, awareness_scale? }.`
      )
    }
  }

  // Pre-resolve each entity ref.
  const resolved = []
  for (let i = 0; i < itemsArg.length; i++) {
    const ref = itemsArg[i]
    if (typeof ref !== 'string' || !ref) {
      throw new Error(`participants[${i}] must be a non-empty string (UUID or exact name/alias)`)
    }
    let r
    try {
      r = _resolveEntity(ref)
    } catch (err) {
      throw new Error(`participants[${i}]: ${err.message}`)
    }
    resolved.push(r.entity)
  }

  // Loop. Per item: call canonical removeParticipant; detect cascade
  // (relationship deletion when effective participants → 0). If a
  // cascade fires mid-loop, remaining items become moot — report and stop.
  const out = []
  let cascaded = false
  let cascadedAfterIdx = null
  for (let i = 0; i < resolved.length; i++) {
    if (cascaded) {
      out.push({
        entity_id: resolved[i].id,
        skipped: true,
        skip_reason: 'relationship cascade-deleted earlier in batch',
      })
      continue
    }
    await useProjectStore.getState().removeParticipant(rel.id, resolved[i].id, atNodeId)
    const updated = useProjectStore.getState().relationships.find((r) => r.id === rel.id)
    if (!updated) {
      cascaded = true
      cascadedAfterIdx = i
      out.push({
        entity_id: resolved[i].id,
        cascaded: true,
        cascade_reason: 'relationship had zero remaining effective participants after this removal',
      })
    } else {
      out.push({ entity_id: resolved[i].id, cascaded: false })
    }
  }

  // track_as_knowledge (single-anchor rule already enforced — batch
  // size === 1 when set). Cascade rejection mirrors the singular tool.
  let trackingKnowledgeId = null
  if (trackArg !== undefined && trackArg !== null) {
    if (cascaded) {
      throw new Error(
        `track_as_knowledge: remove_participants cascaded to relationship ` +
        `deletion (last effective participant left). No chain event remains ` +
        `to anchor a Knowledge to.`
      )
    }
    const updated = useProjectStore.getState().relationships.find((r) => r.id === rel.id)
    const leaveEntry = (updated?.history?.participant_changes || []).find(
      (c) => c?.entity_id === resolved[0].id && c?.action === 'leave' && c?.node_id === atNodeId,
    )
    if (!leaveEntry?.id) {
      throw new Error(
        `track_as_knowledge: no leave entry landed at this scene — likely ` +
        `the same-node join+leave pair-cancellation rule stripped both. No ` +
        `chain event remains to anchor a Knowledge to.`
      )
    }
    trackingKnowledgeId = await _applyKnowledgeTracking(trackArg, {
      event_type: 'relationship_participant_change',
      change_id: leaveEntry.id,
      node_id: atNodeId,
      relationship_id: rel.id,
      entity_id: resolved[0].id,
    })
  }

  // Final state of the relationship (or null when cascaded).
  const updated = useProjectStore.getState().relationships.find((r) => r.id === rel.id)
  return {
    relationship_id: rel.id,
    scene_id: isOriginPath ? null : atNodeId,
    origin_node_id: rel.creation_anchor_node_id || null,
    participants: out,
    cascaded,
    ...(cascaded ? { cascade_after_index: cascadedAfterIdx } : {}),
    ...(updated ? { participant_ids_ever: _participantsEver(updated) } : {}),
    ...(trackingKnowledgeId ? { tracking_knowledge_id: trackingKnowledgeId } : {}),
  }
})


// ── Per-participant scalar chain changes (relationship cluster part 2) ─
//
// Each tool records ONE scene-anchored change on the relationship's history
// list scoped to (entity_id, scene_id). The scene resolver reads the
// most-recent entry on or before the read scene to determine the
// participant's effective role / perception / alias-override at that
// point. Per-entity per-scene upsert: re-setting the same field for
// the same entity at the same scene REPLACES the prior entry — the
// canonical `recordRelationshipChange` action enforces this
// invariant (see store action's `perEntityUpsert` set).
//
// `set_participant_role` supports BOTH origin (writes
// `participant_roles[entity_id]` baseline) and scene paths via the
// canonical `setParticipantRole` action; the other two
// (`set_participant_perception`,
// `set_participant_alias`) are scene-only because their
// baseline forms ride on the participant's join entry
// (`initial_perception` / `initial_alias_override`) and aren't
// independently editable.

// ── Consolidated: set_participant (origin OR scene) ────────────────────
//
// One tool for setting any of a participant's per-relationship fields
// (role / perception / alias_override) — pass whichever you want to
// change; omitted fields are untouched. Replaces the three singulars
// `set_participant_role` / `set_participant_perception` /
// `set_participant_alias` (retired in v0.2.1.157). Same `at?` and
// `track_as_knowledge?` semantics as the singulars.
//
// Per-field-omitted: pass `undefined` / don't include the arg.
// Per-field-clear: pass `null` (or empty string for role / alias_override).
//
// track_as_knowledge single-anchor rule: requires exactly one chain
// entry across the whole call. Pass at most one of role / perception /
// alias_override at a scene anchor when track_as_knowledge is set;
// multi-field calls with track_as_knowledge reject cleanly with a
// "split into separate calls" error.

registerMcpTool('set_participant', async (args) => {
  const rel = _resolveRelationship(args?.relationship)
  const { entity } = _resolveEntity(args?.entity)
  const at = args?.at
  const isOriginPath = !at || at === 'origin'

  // Identify which fields were supplied (undefined = not provided).
  const hasRole = args?.role !== undefined
  const hasPerception = args?.perception !== undefined
  const hasAlias = args?.alias_override !== undefined
  const fieldCount = (hasRole ? 1 : 0) + (hasPerception ? 1 : 0) + (hasAlias ? 1 : 0)
  if (fieldCount === 0) {
    throw new Error(
      `set_participant requires at least one of: role, perception, alias_override. ` +
      `Pass null / empty string to clear a field, or undefined / omit to leave it untouched.`
    )
  }

  // Pre-validate track_as_knowledge shape upfront.
  const trackArg = args?.track_as_knowledge
  if (trackArg !== undefined && trackArg !== null) {
    if (isOriginPath) {
      throw new Error(
        `track_as_knowledge requires a scene anchor (pass \`at=<scene>\`). ` +
        `Origin-path set_participant writes are baseline (no chain event to anchor to).`
      )
    }
    if (fieldCount !== 1) {
      throw new Error(
        `track_as_knowledge requires exactly one chain entry per call ` +
        `(the Knowledge anchors to one event). This call sets ${fieldCount} fields. ` +
        `Split into separate set_participant calls and pass track_as_knowledge on ` +
        `the field you want to anchor.`
      )
    }
    if (typeof trackArg === 'string') _resolveKnowledge(trackArg)
    else if (typeof trackArg === 'object' && !Array.isArray(trackArg)) {
      if (!(trackArg.name || '').trim()) {
        throw new Error('track_as_knowledge.name is required when creating a new Knowledge.')
      }
    } else {
      throw new Error(
        `track_as_knowledge must be a string (existing Knowledge UUID / name) ` +
        `or an object { name, description?, colour?, awareness_scale? }.`
      )
    }
  }

  // ─── ORIGIN PATH: baseline writes ────────────────────────────────
  //
  // perception + alias_override require the entity to have at least
  // one join entry on the relationship (their baseline forms live on
  // the join entries — initial_perception / initial_alias_override).
  // role baseline goes into the relationship's participant_roles map
  // and doesn't need a prior join.

  if (isOriginPath) {
    // Pre-flight: validate join-required fields have a join entry.
    if (hasPerception || hasAlias) {
      const hasJoin = (rel.history?.participant_changes || []).some(
        (c) => c?.action === 'join' && c?.entity_id === entity.id,
      )
      if (!hasJoin) {
        throw new Error(
          `entity '${entity.name}' has no join entry on relationship '${rel.name || rel.id}'. ` +
          `Baseline perception / alias_override write requires the entity to be a participant. ` +
          `Use add_participants first.`
        )
      }
    }

    const out = {
      relationship_id: rel.id,
      entity_id: entity.id,
      scene_id: null,
      origin_node_id: rel.creation_anchor_node_id || null,
    }
    if (hasRole) {
      const roleValue = args.role
      const roleShape = (roleValue === null || roleValue === '')
        ? { value: '', preset_list_id: null }
        : (typeof roleValue === 'string')
          ? { value: roleValue, preset_list_id: null }
          : roleValue
      await useProjectStore.getState().setParticipantRole(rel.id, entity.id, roleShape, null)
      out.role = roleShape
    }
    if (hasPerception) {
      const perception = args.perception === null ? '' : String(args.perception)
      await useProjectStore.getState().setParticipantPerception(rel.id, entity.id, perception)
      out.perception = perception
    }
    if (hasAlias) {
      const alias_override = args.alias_override === null
        ? null
        : String(args.alias_override) || null
      await useProjectStore.getState().setParticipantAlias(rel.id, entity.id, alias_override)
      out.alias_override = alias_override
    }
    return out
  }

  // ─── SCENE PATH: chain entries ───────────────────────────────────
  const sceneNode = _resolveScene(at)
  const atNodeId = sceneNode.id

  const out = {
    relationship_id: rel.id,
    entity_id: entity.id,
    scene_id: atNodeId,
    origin_node_id: rel.creation_anchor_node_id || null,
  }

  // Track the change id of the SINGLE chain entry (for track_as_knowledge).
  let singleChangeId = null
  let singleEventType = null

  if (hasRole) {
    const roleValue = args.role
    const roleShape = (roleValue === null || roleValue === '')
      ? { value: '', preset_list_id: null }
      : (typeof roleValue === 'string')
        ? { value: roleValue, preset_list_id: null }
        : roleValue
    await useProjectStore.getState().setParticipantRole(rel.id, entity.id, roleShape, atNodeId)
    // The store action wrote a role_changes entry; locate it for tracking.
    const updated = useProjectStore.getState().relationships.find((r) => r.id === rel.id)
    const roleEntry = (updated?.history?.role_changes || []).find(
      (c) => c?.entity_id === entity.id && c?.node_id === atNodeId,
    )
    if (roleEntry?.id) {
      singleChangeId = roleEntry.id
      singleEventType = 'relationship_role_change'
    }
    out.role = roleShape
  }
  if (hasPerception) {
    const perception = args.perception === null ? '' : String(args.perception)
    const changeId = crypto.randomUUID()
    await useProjectStore.getState().recordRelationshipChange(rel.id, {
      type: 'perception',
      data: { id: changeId, node_id: atNodeId, entity_id: entity.id, new_perception: perception },
    })
    singleChangeId = changeId
    singleEventType = 'relationship_perception_change'
    out.perception = perception
  }
  if (hasAlias) {
    const alias_override = args.alias_override === null
      ? null
      : String(args.alias_override) || null
    const changeId = crypto.randomUUID()
    await useProjectStore.getState().recordRelationshipChange(rel.id, {
      type: 'alias',
      data: { id: changeId, node_id: atNodeId, entity_id: entity.id, new_alias_override: alias_override },
    })
    singleChangeId = changeId
    singleEventType = 'relationship_alias_change'
    out.alias_override = alias_override
  }

  // track_as_knowledge — single-anchor rule already enforced above
  // (fieldCount === 1 when trackArg is set).
  let trackingKnowledgeId = null
  if (trackArg !== undefined && trackArg !== null && singleChangeId) {
    trackingKnowledgeId = await _applyKnowledgeTracking(trackArg, {
      event_type: singleEventType,
      change_id: singleChangeId,
      node_id: atNodeId,
      relationship_id: rel.id,
      entity_id: entity.id,
    })
  }

  if (trackingKnowledgeId) out.tracking_knowledge_id = trackingKnowledgeId
  return out
})

// Singular `set_participant_role`, `set_participant_perception`,
// `set_participant_alias` retired in v0.2.1.157 — consolidated into
// `set_participant` above. Pass whichever field(s) you want to set;
// omitted fields are untouched.



// ── Awareness setters for non-Knowledge hosts (audit verdict) ──────────
//
// Four goal-level tools — `set_entity_awareness` / `set_attribute_awareness`
// / `set_alias_awareness` / `set_relationship_awareness` — exposing the
// chain-tracked awareness writes that previously had no MCP affordance
// (only knowledge awareness was reachable, via setKnowledgeAwarenessOrigin
// + setKnowledgeAwarenessAtNode store actions). Each tool wraps the
// canonical `commitAwarenessAtAnchor` store action, the same path the
// awareness panel UIs use.
//
// Each tool accepts:
//   - host-specific reference (entity / attribute / alias / relationship)
//   - `observer` — entity reference; whose awareness level we're setting
//   - `level` — int 0-3 (or null to clear the observer's entry)
//   - `at?` — optional scene anchor; omit / null / 'origin' for baseline.


// Canonical level-name → int mapping for awareness level resolution.
// Strings are the preferred / readable form; ints still accepted for
// callers that prefer raw values. Case-insensitive. Names match the
// help-tour vocabulary so the AI's serialised tool calls read the same
// way the user-facing UI labels these levels.
//
// 4-level ('full') scale uses { 0, 1, 2, 3 }: Unaware (0) / Nominally
// (1) / Partially (2) / Fully (3).
//
// 2-level ('binary') scale uses { 0, 3 } only — the same int values as
// the endpoints of the 4-level scale (NOT 0/1) so a target's level
// reads consistently across scales. On binary, "Aware" maps to 3
// (synonymous with "Fully" since the scale doesn't distinguish
// degrees); "Partially" / "Nominally" on a binary target would be
// coerced or rejected by the downstream awareness-apply path.
//
// Scale-specific validity is NOT enforced here. This resolver's job
// is just string-to-int translation; per-scale checks live downstream
// in the awareness apply path.
const _AWARENESS_LEVEL_NAMES = {
  'fully': 3, 'fully aware': 3, 'full': 3,
  'aware': 3,
  'partially': 2, 'partially aware': 2, 'partial': 2,
  'nominally': 1, 'nominally aware': 1, 'nominal': 1,
  'unaware': 0,
}

function _resolveAwarenessLevel(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 3) return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return null
    // Canonical string name first (preferred form).
    const named = _AWARENESS_LEVEL_NAMES[trimmed.toLowerCase()]
    if (named !== undefined) return named
    // Numeric string fallback (some MCP bridges stringify ints).
    if (/^\d+$/.test(trimmed)) {
      const n = parseInt(trimmed, 10)
      if (n >= 0 && n <= 3) return n
    }
  }
  throw new Error(
    `level "${value}" invalid. Expected one of: "Fully" / "Partially" ` +
    `/ "Nominally" / "Unaware" (4-level scale) or "Aware" / "Unaware" ` +
    `(2-level scale), case-insensitive; or an integer 0-3; or null to ` +
    `clear the observer's entry.`
  )
}

/** Directive guard for an awareness entry with no observer. The model
 *  frequently sends empty `{}` entries (session 012 sent `entries: [{}]`
 *  27 times); the generic "entity reference is required" resolve error
 *  didn't convey the entry SHAPE. This states it inline with an example so
 *  the model self-corrects in one step. */
function _requireAwarenessObserver(e, i) {
  if (e.observer === undefined || e.observer === null || e.observer === '') {
    throw new Error(
      `entries[${i}] is missing 'observer' (an empty or observer-less entry). ` +
      `Each entry needs { observer: <entity who becomes aware, UUID or exact ` +
      `name/alias>, level: <awareness level>, at?: <scene> }. ` +
      `Example: entries=[{observer: "Eva", level: "knows"}]. ` +
      `Call get_tool_help('awareness') for the accepted level values.`
    )
  }
}

// Inverse of `_resolveAwarenessLevel` — returns a canonical
// self-describing human-readable name for an int level so awareness
// tool responses are self-documenting (no need for the AI to remember
// 0=Unaware, 1=Nominally, etc.). Scale-agnostic: 4-level forms used
// even on binary targets (binary's `3` means "Aware" semantically but
// reads as "Fully Aware" here for consistency with the 4-level vocab
// the rest of the surface uses).
//
// All four names use the "<level> Aware" / "Unaware" form per the
// help-tour vocabulary so the response phrasing matches what writers
// see in the UI labels.
function _levelName(level) {
  if (level === null || level === undefined) return null
  switch (level) {
    case 0: return 'Unaware'
    case 1: return 'Nominally Aware'
    case 2: return 'Partially Aware'
    case 3: return 'Fully Aware'
    default: return null
  }
}

/**
 * Project an awareness wrapper for MCP read responses with per-observer
 * PROVENANCE and observer-name enrichment. Returns `{ flat, observers,
 * provenance }` where:
 *   - `flat` — the flat `{entity_id: level}` dict every read tool
 *     currently surfaces as the `awareness` field. Empty `{}` when no
 *     observers are resolved.
 *   - `observers` — `{entity_id: { observer_name, level, level_name }}`
 *     enriched per-observer record. Saves a per-observer fan-out lookup
 *     when the agent wants to display awareness against character
 *     names (the common prose-writing case). `observer_name` resolves
 *     via `_findEntity` (chain-baseline name only — chain-renames are
 *     a separate read path) and falls back to '' when the entity has
 *     been deleted out from under the awareness pin.
 *   - `provenance` — `{entity_id: { via, inherited_from? }}` ONLY for
 *     observers whose level came from a projection (`via: 'inherited'`).
 *     Observers with direct entry pins are omitted — direct is the
 *     implicit default; absence from `provenance` means "direct pin
 *     (or fall through to the flat dict)." `inherited_from` is a list
 *     of contributing sources enriched with the relationship's
 *     human-readable name so the response is self-describing without
 *     a fan-out per source: `[{ kind: 'relationship', relationship_id,
 *     relationship_name, level, level_name }, ...]`.
 *
 * `ctx` must carry the data `resolveSourceMembership` needs:
 * `{ allEntities, allRelationships, nodes, edges, storyOrder, anchorNodeId }`.
 */
function _projectAwarenessWithProvenance(awareness, ctx) {
  const { levels, provenance } = resolveAwarenessFieldWithProvenance(awareness, ctx)
  if (!levels) return { flat: {}, observers: {}, provenance: {} }
  const projectStore = useProjectStore.getState()
  const relationships = projectStore.relationships || []
  const relById = new Map(relationships.map((r) => [r.id, r]))
  const observers = {}
  for (const [obsId, level] of Object.entries(levels)) {
    const f = _findEntity(obsId)
    observers[obsId] = {
      observer_name: f?.entity?.name || '',
      level,
      level_name: _levelName(level),
    }
  }
  const enriched = {}
  for (const [obsId, p] of Object.entries(provenance || {})) {
    if (!p || p.via !== 'inherited') continue
    const inheritedFrom = (p.inherited_from || []).map((src) => {
      if (src?.kind === 'relationship') {
        const r = relById.get(src.relationship_id)
        return {
          kind: 'relationship',
          relationship_id: src.relationship_id,
          relationship_name: r?.name || '',
          level: src.level,
          level_name: _levelName(src.level),
        }
      }
      return { ...src }
    })
    enriched[obsId] = { via: 'inherited', inherited_from: inheritedFrom }
  }
  return { flat: levels, observers, provenance: enriched }
}

/** Build the ctx object that `resolveAwarenessFieldWithProvenance`
 *  needs to resolve source memberships. Shared across all read sites
 *  that surface awareness in their responses. */
function _buildAwarenessProvenanceCtx(anchorNodeId) {
  const projectStore = useProjectStore.getState()
  const nodes = projectStore.nodes || []
  const edges = projectStore.edges || []
  return {
    allEntities: useEntitiesStore.getState().allEntities(),
    allRelationships: projectStore.relationships || [],
    nodes,
    edges,
    // Cached: this ctx is rebuilt once PER KNOWLEDGE by the scene-context
    // renderer (via `_projectKnowledgeAtScene`), so an uncached walk here
    // fired once per knowledge per send. The order is global; reuse it.
    storyOrder: getOrComputeStoryOrderFromStore(),
    anchorNodeId: anchorNodeId || null,
  }
}

// ── Awareness SOURCE helpers (Phase 2.1 awareness-projection MCP) ────────
//
// Awareness on every host (Entity / Attribute / Alias / Relationship /
// Knowledge) supports projection from a SOURCE (typically a
// relationship) to all of its members at the chain anchor. The chain
// walker resolves the source's membership at read time and projects
// the source's level onto every member not pinned by a direct entry.
// This is how "the Sigma Tau frat as a group is Unaware of the
// transformation" gets expressed in one declaration that scales as
// members join / leave the faction's membership relationship.
//
// The MCP tools expose this by accepting a `sources=[...]` arg
// alongside the existing `entries=[...]`. Each item is processed
// independently at its own anchor — same per-item idiom the entries
// path uses.

/** Resolve an MCP source spec to the canonical Source shape that the
 *  chain layer carries on `wrapper.sources[]`. Only `'relationship'`
 *  is exposed via MCP (attribute-list sources are an internal
 *  primitive used by entity-list attributes; not user-facing yet). */
function _resolveAwarenessSourceRef(sourceKindArg, sourceArg) {
  const kind = sourceKindArg || 'relationship'
  if (kind !== 'relationship') {
    throw new Error(
      `source_kind '${kind}' not supported via MCP; only 'relationship' is exposed. ` +
      `For faction-style group awareness, use the faction's auto-created membership ` +
      `relationship: "<Faction Name> Members".`
    )
  }
  const rel = _resolveRelationship(sourceArg)
  return { kind: 'relationship', relationship_id: rel.id, _resolvedName: rel.name || '' }
}

/** Stable key for matching sources in an array by identity. Mirrors
 *  the `sourceKey` helper in utils/awarenessCommit.js. */
function _sourceKeyForMatch(source) {
  if (!source) return ''
  if (source.kind === 'relationship') return `rel:${source.relationship_id}`
  if (source.kind === 'attribute')    return `attr:${source.entity_id}:${source.attribute_id}`
  return ''
}

/** Build the new awareness draft by reading the prior wrapper and
 *  mutating its `sources[]` per `action`. The entries dict carries
 *  forward unchanged (only the sources array is touched).
 *
 *  `action`:
 *    'add'       — insert a new source at `level`; errors if a source
 *                  with the same identity already exists at the anchor.
 *    'remove'    — strip the matching source; errors if not present.
 *    'set_level' — change the level of an existing source; errors if
 *                  not present.
 *
 *  Returns a wrapper-shaped draft `{ entries?, sources? }` or null
 *  when both fall out empty. The commit pipeline diffs against prior
 *  and emits the right `awareness_source_add` / `awareness_source_
 *  remove` / `awareness_source_set_level` chain entries. */
function _buildAwarenessDraftWithSourceMutation(priorWrapper, action, source, level) {
  // Skip legacy single-source AwarenessRef baselines — not editable here.
  if (priorWrapper && typeof priorWrapper === 'object'
    && 'relationship_id' in priorWrapper && 'level' in priorWrapper) {
    throw new Error(
      `target's awareness is a legacy AwarenessRef baseline (single-source) ` +
      `which isn't editable via this tool. Edit through the UI to migrate it ` +
      `to the modern multi-observer / multi-source wrapper first.`
    )
  }
  const priorEntries = (priorWrapper && typeof priorWrapper === 'object' && !Array.isArray(priorWrapper))
    ? (priorWrapper.entries ?? priorWrapper) : {}
  const priorSources = (priorWrapper && typeof priorWrapper === 'object' && Array.isArray(priorWrapper.sources))
    ? priorWrapper.sources : []
  const targetKey = _sourceKeyForMatch(source)
  if (!targetKey) throw new Error(`internal: invalid source for awareness mutation`)
  const nextSources = [...priorSources]
  const existingIdx = nextSources.findIndex((s) => _sourceKeyForMatch(s) === targetKey)
  if (action === 'add') {
    if (existingIdx >= 0) {
      throw new Error(
        `awareness source already exists at this anchor (current level: ` +
        `${_levelName(nextSources[existingIdx].level)}). Use action='set_level' ` +
        `to change its level or action='remove' to drop it first.`
      )
    }
    if (level === null || level === undefined) {
      throw new Error(`level is required for action='add'`)
    }
    nextSources.push({ kind: source.kind, relationship_id: source.relationship_id, level })
  } else if (action === 'set_level') {
    if (existingIdx < 0) {
      throw new Error(
        `awareness source not present at this anchor; nothing to set the level on. ` +
        `Use action='add' to introduce the source first.`
      )
    }
    if (level === null || level === undefined) {
      throw new Error(`level is required for action='set_level'`)
    }
    nextSources[existingIdx] = { ...nextSources[existingIdx], level }
  } else if (action === 'remove') {
    if (existingIdx < 0) {
      throw new Error(
        `awareness source not present at this anchor; nothing to remove.`
      )
    }
    nextSources.splice(existingIdx, 1)
  } else {
    throw new Error(`action '${action}' invalid; expected 'add' | 'remove' | 'set_level'.`)
  }
  const hasEntries = priorEntries && Object.keys(priorEntries).length > 0
  if (hasEntries && nextSources.length > 0) return { entries: { ...priorEntries }, sources: nextSources }
  if (hasEntries) return { ...priorEntries }
  if (nextSources.length > 0) return { entries: {}, sources: nextSources }
  return null
}

/** Pre-validate every item in a `sources=[...]` MCP arg. Returns a
 *  list of validated items ready for per-item commit; throws on any
 *  bad item with `sources[N].<field>: ...` attribution so the whole
 *  batch errors atomically before any write lands.
 *
 *  Item shape: `{ action, source_kind?, source, level?, at? }`:
 *    action      — 'add' | 'remove' | 'set_level' (required)
 *    source_kind — 'relationship' (default; only supported kind)
 *    source      — UUID or name of the source relationship
 *    level       — required when action ≠ 'remove'; awareness level
 *                  (string name or 0-3 int)
 *    at          — origin (omitted / null / 'origin') or scene
 *                  UUID / title (chain anchor)
 */
function _validateAwarenessSourceItems(sourcesArg, contextLabel = 'sources') {
  if (sourcesArg === undefined || sourcesArg === null) return []
  if (!Array.isArray(sourcesArg)) {
    throw new Error(`${contextLabel} must be an array of source-mutation objects`)
  }
  const out = []
  for (let i = 0; i < sourcesArg.length; i++) {
    const s = sourcesArg[i]
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      throw new Error(`${contextLabel}[${i}] must be an object with { action, source_kind?, source, level?, at? } fields.`)
    }
    // Required-field presence is checked FIRST, before validity of any
    // single field — so an agent passing `{relationship: ..., level: ...,
    // at: ...}` (with the wrong key name `relationship` instead of
    // `source`) gets "source field missing" up front rather than the
    // less-helpful "action 'undefined' invalid" that used to surface
    // first. Same check order for sources items used by `set_*_awareness`
    // tools per the v8 blind-agent test report.
    if (s.source === undefined || s.source === null || s.source === '') {
      throw new Error(`${contextLabel}[${i}].source is required (UUID or exact name of the source relationship).`)
    }
    if (s.action === undefined || s.action === null || s.action === '') {
      throw new Error(`${contextLabel}[${i}].action is required ('add' | 'remove' | 'set_level').`)
    }
    const action = s.action
    if (!['add', 'remove', 'set_level'].includes(action)) {
      throw new Error(`${contextLabel}[${i}].action '${action}' invalid; expected 'add' | 'remove' | 'set_level'.`)
    }
    let resolvedSource
    try { resolvedSource = _resolveAwarenessSourceRef(s.source_kind, s.source) }
    catch (err) { throw new Error(`${contextLabel}[${i}].source: ${err.message}`) }
    let level = null
    if (action !== 'remove') {
      if (s.level === undefined || s.level === null) {
        throw new Error(`${contextLabel}[${i}].level is required for action='${action}'`)
      }
      try { level = _resolveAwarenessLevel(s.level) }
      catch (err) { throw new Error(`${contextLabel}[${i}].level: ${err.message}`) }
    }
    const at = s.at
    const isOriginPath = !at || at === 'origin'
    let sceneNode = null
    if (!isOriginPath) {
      try { sceneNode = _resolveScene(at) }
      catch (err) { throw new Error(`${contextLabel}[${i}].at: ${err.message}`) }
    }
    out.push({ action, source: resolvedSource, level, isOriginPath, sceneNode })
  }
  return out
}

/** Build the new awareness draft by reading the prior wrapper and
 *  overriding one observer's level (or clearing it when level=null).
 *  Mirrors the pattern used by setKnowledgeAwarenessOrigin /
 *  setRelationshipAwareness so wrapper-shape preservation
 *  (entries+sources vs flat dict) stays consistent across surfaces. */
function _buildAwarenessDraftWithOverride(priorWrapper, observerEntityId, level) {
  // Skip legacy single-source AwarenessRef baselines — not editable here.
  if (priorWrapper && typeof priorWrapper === 'object'
    && 'relationship_id' in priorWrapper && 'level' in priorWrapper) {
    throw new Error(
      `target's awareness is a legacy AwarenessRef baseline (single-source) ` +
      `which isn't editable via this tool. Edit through the UI to migrate it ` +
      `to the modern multi-observer dict first.`
    )
  }
  const priorEntries = (priorWrapper && typeof priorWrapper === 'object' && !Array.isArray(priorWrapper))
    ? (priorWrapper.entries ?? priorWrapper)
    : {}
  const priorSources = (priorWrapper && typeof priorWrapper === 'object' && Array.isArray(priorWrapper.sources))
    ? priorWrapper.sources : []
  const nextEntries = { ...priorEntries }
  if (level == null) delete nextEntries[observerEntityId]
  else nextEntries[observerEntityId] = level
  if (priorSources.length > 0) return { entries: nextEntries, sources: priorSources }
  if (Object.keys(nextEntries).length > 0) return nextEntries
  return null
}

/** Read the prior awareness wrapper for a target at an anchor.
 *  Dispatches on target.kind (entity / attribute / alias OR relationship)
 *  and anchor.kind (origin OR chain). For chain reads, computes scene-
 *  resolved effective state then projects the awareness-bearing field.
 *  For origin reads, reads directly from the host baseline. */
function _readPriorAwarenessForCommit(target, anchor, hostEntity, hostRel) {
  const isOriginAnchor = anchor.kind === 'origin' || !anchor.nodeId
  if (target.kind === 'relationship') {
    if (isOriginAnchor) return hostRel?.awareness ?? null
    const projectStore = useProjectStore.getState()
    const eff = computeRelationshipEffectiveState(hostRel, projectStore.nodes || [], projectStore.edges || [], anchor.nodeId)
    return eff?.awareness_raw ?? eff?.awareness ?? null
  }
  // Entity-bound (entity / attribute / alias).
  if (isOriginAnchor) return readAwarenessAtTarget(hostEntity, target)
  const projectStore = useProjectStore.getState()
  const eff = computeEffectiveState(hostEntity, projectStore.nodes || [], projectStore.edges || [], anchor.nodeId)
  return readEffectiveAwarenessForTarget(eff, target)
}

// ── set_entity_awareness ──────────────────────────────────────────────

registerMcpTool('set_entity_awareness', async (args) => {
  const { entity } = _resolveEntity(args?.entity)
  // `aspect` picks the awareness surface: the entity's EXISTENCE (default)
  // or its canonical NAME. Both are handled chain-aware by the shared commit
  // path (commitAwarenessAtAnchor + the awarenessCommit readers), which map
  // target.kind 'entity' -> Entity.awareness and 'entity_name' -> name_awareness.
  const targetKind = (typeof args?.aspect === 'string' && args.aspect.trim().toLowerCase() === 'name')
    ? 'entity_name' : 'entity'
  const entriesArg = args?.entries
  const sourcesArg = args?.sources
  const hasEntries = Array.isArray(entriesArg) && entriesArg.length > 0
  const hasSources = Array.isArray(sourcesArg) && sourcesArg.length > 0
  if (!hasEntries && !hasSources) {
    throw new Error(
      'pass either `entries` (per-observer direct pins) or `sources` ' +
      '(per-relationship group projections), or both. ' +
      'entries item: { observer, level, at? }. ' +
      'sources item: { action, source_kind?, source, level?, at? } where ' +
      "action is 'add' | 'remove' | 'set_level'."
    )
  }
  // Pre-validate every entry upfront — atomic batch on resolution
  // failure (no writes land if any entry has a bad observer/level/at).
  const validated = []
  for (let i = 0; i < (entriesArg || []).length; i++) {
    const e = entriesArg[i]
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      throw new Error(`entries[${i}] must be an object with { observer, level, at? } fields.`)
    }
    _requireAwarenessObserver(e, i)
    let observerEntity, level, sceneNode
    try { observerEntity = _resolveEntity(e.observer).entity }
    catch (err) { throw new Error(`entries[${i}].observer: ${err.message}`) }
    try { level = _resolveAwarenessLevel(e.level) }
    catch (err) { throw new Error(`entries[${i}].level: ${err.message}`) }
    const at = e.at
    const isOriginPath = !at || at === 'origin'
    if (!isOriginPath) {
      try { sceneNode = _resolveScene(at) }
      catch (err) { throw new Error(`entries[${i}].at: ${err.message}`) }
    }
    validated.push({ observerEntity, level, isOriginPath, sceneNode })
  }
  const validatedSources = _validateAwarenessSourceItems(sourcesArg)
  const out = []
  const sourcesOut = []
  const target = { kind: targetKind, entityId: entity.id }
  for (const v of validated) {
    const anchor = v.isOriginPath
      ? { kind: 'origin', nodeId: null }
      : { kind: 'chain', nodeId: v.sceneNode.id }
    const prior = _readPriorAwarenessForCommit(target, anchor, entity, null)
    const draft = _buildAwarenessDraftWithOverride(prior, v.observerEntity.id, v.level)
    await useProjectStore.getState().commitAwarenessAtAnchor({ target, anchor, draft })
    out.push({
      observer_id: v.observerEntity.id,
      level: v.level,
      level_name: _levelName(v.level),
      scene_id: v.isOriginPath ? null : anchor.nodeId,
    })
  }
  for (const v of validatedSources) {
    const anchor = v.isOriginPath
      ? { kind: 'origin', nodeId: null }
      : { kind: 'chain', nodeId: v.sceneNode.id }
    const prior = _readPriorAwarenessForCommit(target, anchor, entity, null)
    const draft = _buildAwarenessDraftWithSourceMutation(prior, v.action, v.source, v.level)
    await useProjectStore.getState().commitAwarenessAtAnchor({ target, anchor, draft })
    sourcesOut.push({
      action: v.action,
      source_kind: v.source.kind,
      source_id: v.source.relationship_id,
      source_name: v.source._resolvedName,
      level: v.level,
      level_name: _levelName(v.level),
      scene_id: v.isOriginPath ? null : anchor.nodeId,
    })
  }
  return {
    target_kind: targetKind,
    entity_id: entity.id,
    entries: out,
    sources: sourcesOut,
  }
})

// ── set_attribute_awareness ───────────────────────────────────────────

registerMcpTool('set_attribute_awareness', async (args) => {
  const { entity } = _resolveEntity(args?.entity)
  const entriesArg = args?.entries
  const sourcesArg = args?.sources
  const hasEntries = Array.isArray(entriesArg) && entriesArg.length > 0
  const hasSources = Array.isArray(sourcesArg) && sourcesArg.length > 0
  if (!hasEntries && !hasSources) {
    throw new Error(
      'pass either `entries` (per-observer direct pins) or `sources` ' +
      '(per-relationship group projections), or both. ' +
      'entries item: { attribute, observer, level, at? }. ' +
      'sources item: { attribute, action, source_kind?, source, level?, at? }.'
    )
  }
  // Pre-validate every entry upfront. Attribute resolution mirrors the
  // singular tool: scene-resolved attribute list when `at` is a scene,
  // baseline list when origin. The same entity is shared across all
  // entries; attribute / observer / level / at vary per-entry.
  const validated = []
  for (let i = 0; i < (entriesArg || []).length; i++) {
    const e = entriesArg[i]
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      throw new Error(`entries[${i}] must be an object with { attribute, observer, level, at? } fields.`)
    }
    const at = e.at
    const isOriginPath = !at || at === 'origin'
    let sceneNode = null
    if (!isOriginPath) {
      try { sceneNode = _resolveScene(at) }
      catch (err) { throw new Error(`entries[${i}].at: ${err.message}`) }
    }
    let attrTarget
    try {
      if (isOriginPath) {
        attrTarget = _resolveAttribute(entity, e.attribute)
      } else {
        const sceneAttrs = _attributesAtScene(entity, sceneNode.id)
        attrTarget = _resolveAttribute(entity, e.attribute, { attributesList: sceneAttrs })
      }
    } catch (err) {
      throw new Error(`entries[${i}].attribute: ${err.message}`)
    }
    let observerEntity, level
    try { observerEntity = _resolveEntity(e.observer).entity }
    catch (err) { throw new Error(`entries[${i}].observer: ${err.message}`) }
    try { level = _resolveAwarenessLevel(e.level) }
    catch (err) { throw new Error(`entries[${i}].level: ${err.message}`) }
    validated.push({ attrTarget, observerEntity, level, isOriginPath, sceneNode })
  }
  // Per-item validation for sources. Each source entry needs an
  // `attribute` ref alongside the standard source-mutation fields,
  // because the awareness object lives on each individual attribute.
  const validatedSources = []
  for (let i = 0; i < (sourcesArg || []).length; i++) {
    const s = sourcesArg[i]
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      throw new Error(`sources[${i}] must be an object with { attribute, action, source_kind?, source, level?, at? } fields.`)
    }
    const at = s.at
    const isOriginPath = !at || at === 'origin'
    let sceneNode = null
    if (!isOriginPath) {
      try { sceneNode = _resolveScene(at) }
      catch (err) { throw new Error(`sources[${i}].at: ${err.message}`) }
    }
    // Required-field presence checked FIRST per the v8-test validation
    // ordering fix: bad key names (e.g. `relationship:` instead of
    // `source:`) report the missing required field first, not a
    // downstream "action 'undefined' invalid" error.
    if (s.source === undefined || s.source === null || s.source === '') {
      throw new Error(`sources[${i}].source is required (UUID or exact name of the source relationship).`)
    }
    if (s.action === undefined || s.action === null || s.action === '') {
      throw new Error(`sources[${i}].action is required ('add' | 'remove' | 'set_level').`)
    }
    if (s.attribute === undefined || s.attribute === null || s.attribute === '') {
      throw new Error(`sources[${i}].attribute is required (UUID or exact attribute name on the entity).`)
    }
    let attrTarget
    try {
      if (isOriginPath) {
        attrTarget = _resolveAttribute(entity, s.attribute)
      } else {
        const sceneAttrs = _attributesAtScene(entity, sceneNode.id)
        attrTarget = _resolveAttribute(entity, s.attribute, { attributesList: sceneAttrs })
      }
    } catch (err) {
      throw new Error(`sources[${i}].attribute: ${err.message}`)
    }
    const action = s.action
    if (!['add', 'remove', 'set_level'].includes(action)) {
      throw new Error(`sources[${i}].action '${action}' invalid; expected 'add' | 'remove' | 'set_level'.`)
    }
    let resolvedSource
    try { resolvedSource = _resolveAwarenessSourceRef(s.source_kind, s.source) }
    catch (err) { throw new Error(`sources[${i}].source: ${err.message}`) }
    let level = null
    if (action !== 'remove') {
      if (s.level === undefined || s.level === null) {
        throw new Error(`sources[${i}].level is required for action='${action}'`)
      }
      try { level = _resolveAwarenessLevel(s.level) }
      catch (err) { throw new Error(`sources[${i}].level: ${err.message}`) }
    }
    validatedSources.push({ attrTarget, action, source: resolvedSource, level, isOriginPath, sceneNode })
  }
  const out = []
  const sourcesOut = []
  for (const v of validated) {
    const target = { kind: 'attribute', entityId: entity.id, attributeId: v.attrTarget.id }
    const anchor = v.isOriginPath
      ? { kind: 'origin', nodeId: null }
      : { kind: 'chain', nodeId: v.sceneNode.id }
    const prior = _readPriorAwarenessForCommit(target, anchor, entity, null)
    const draft = _buildAwarenessDraftWithOverride(prior, v.observerEntity.id, v.level)
    await useProjectStore.getState().commitAwarenessAtAnchor({ target, anchor, draft })
    out.push({
      attribute_id: v.attrTarget.id,
      observer_id: v.observerEntity.id,
      level: v.level,
      level_name: _levelName(v.level),
      scene_id: v.isOriginPath ? null : anchor.nodeId,
    })
  }
  for (const v of validatedSources) {
    const target = { kind: 'attribute', entityId: entity.id, attributeId: v.attrTarget.id }
    const anchor = v.isOriginPath
      ? { kind: 'origin', nodeId: null }
      : { kind: 'chain', nodeId: v.sceneNode.id }
    const prior = _readPriorAwarenessForCommit(target, anchor, entity, null)
    const draft = _buildAwarenessDraftWithSourceMutation(prior, v.action, v.source, v.level)
    await useProjectStore.getState().commitAwarenessAtAnchor({ target, anchor, draft })
    sourcesOut.push({
      attribute_id: v.attrTarget.id,
      action: v.action,
      source_kind: v.source.kind,
      source_id: v.source.relationship_id,
      source_name: v.source._resolvedName,
      level: v.level,
      level_name: _levelName(v.level),
      scene_id: v.isOriginPath ? null : anchor.nodeId,
    })
  }
  return {
    target_kind: 'attribute',
    entity_id: entity.id,
    entries: out,
    sources: sourcesOut,
  }
})

// ── set_alias_awareness ───────────────────────────────────────────────

registerMcpTool('set_alias_awareness', async (args) => {
  const { entity } = _resolveEntity(args?.entity)
  const entriesArg = args?.entries
  const sourcesArg = args?.sources
  const hasEntries = Array.isArray(entriesArg) && entriesArg.length > 0
  const hasSources = Array.isArray(sourcesArg) && sourcesArg.length > 0
  if (!hasEntries && !hasSources) {
    throw new Error(
      'pass either `entries` (per-observer direct pins) or `sources` ' +
      '(per-relationship group projections), or both. ' +
      'entries item: { alias, observer, level, at? }. ' +
      'sources item: { alias, action, source_kind?, source, level?, at? }.'
    )
  }
  // Pre-validate every entry upfront. Alias resolution mirrors the
  // singular tool's chain-wide fallback so aliases added anywhere in
  // the chain are findable.
  const validated = []
  for (let i = 0; i < (entriesArg || []).length; i++) {
    const e = entriesArg[i]
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      throw new Error(`entries[${i}] must be an object with { alias, observer, level, at? } fields.`)
    }
    const at = e.at
    const isOriginPath = !at || at === 'origin'
    let sceneNode = null
    if (!isOriginPath) {
      try { sceneNode = _resolveScene(at) }
      catch (err) { throw new Error(`entries[${i}].at: ${err.message}`) }
    }
    let aliasTarget
    try {
      if (isOriginPath) {
        aliasTarget = _resolveAlias(entity, e.alias)
      } else {
        const sceneAliases = _aliasesAtScene(entity, sceneNode.id)
        aliasTarget = _resolveAlias(entity, e.alias, { aliasesList: sceneAliases })
      }
    } catch (err) {
      throw new Error(`entries[${i}].alias: ${err.message}`)
    }
    if (!aliasTarget?.value) {
      throw new Error(`entries[${i}].alias: alias resolution returned no value — cannot build awareness target.`)
    }
    let observerEntity, level
    try { observerEntity = _resolveEntity(e.observer).entity }
    catch (err) { throw new Error(`entries[${i}].observer: ${err.message}`) }
    try { level = _resolveAwarenessLevel(e.level) }
    catch (err) { throw new Error(`entries[${i}].level: ${err.message}`) }
    validated.push({ aliasTarget, observerEntity, level, isOriginPath, sceneNode })
  }
  // Per-item validation for sources. Each source entry needs an
  // `alias` ref alongside the standard source-mutation fields.
  const validatedSources = []
  for (let i = 0; i < (sourcesArg || []).length; i++) {
    const s = sourcesArg[i]
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      throw new Error(`sources[${i}] must be an object with { alias, action, source_kind?, source, level?, at? } fields.`)
    }
    const at = s.at
    const isOriginPath = !at || at === 'origin'
    let sceneNode = null
    if (!isOriginPath) {
      try { sceneNode = _resolveScene(at) }
      catch (err) { throw new Error(`sources[${i}].at: ${err.message}`) }
    }
    // Required-field presence checked FIRST per the v8-test validation
    // ordering fix.
    if (s.source === undefined || s.source === null || s.source === '') {
      throw new Error(`sources[${i}].source is required (UUID or exact name of the source relationship).`)
    }
    if (s.action === undefined || s.action === null || s.action === '') {
      throw new Error(`sources[${i}].action is required ('add' | 'remove' | 'set_level').`)
    }
    if (s.alias === undefined || s.alias === null || s.alias === '') {
      throw new Error(`sources[${i}].alias is required (UUID or exact alias value on the entity).`)
    }
    let aliasTarget
    try {
      if (isOriginPath) {
        aliasTarget = _resolveAlias(entity, s.alias)
      } else {
        const sceneAliases = _aliasesAtScene(entity, sceneNode.id)
        aliasTarget = _resolveAlias(entity, s.alias, { aliasesList: sceneAliases })
      }
    } catch (err) {
      throw new Error(`sources[${i}].alias: ${err.message}`)
    }
    if (!aliasTarget?.value) {
      throw new Error(`sources[${i}].alias: alias resolution returned no value — cannot build awareness target.`)
    }
    const action = s.action
    if (!['add', 'remove', 'set_level'].includes(action)) {
      throw new Error(`sources[${i}].action '${action}' invalid; expected 'add' | 'remove' | 'set_level'.`)
    }
    let resolvedSource
    try { resolvedSource = _resolveAwarenessSourceRef(s.source_kind, s.source) }
    catch (err) { throw new Error(`sources[${i}].source: ${err.message}`) }
    let level = null
    if (action !== 'remove') {
      if (s.level === undefined || s.level === null) {
        throw new Error(`sources[${i}].level is required for action='${action}'`)
      }
      try { level = _resolveAwarenessLevel(s.level) }
      catch (err) { throw new Error(`sources[${i}].level: ${err.message}`) }
    }
    validatedSources.push({ aliasTarget, action, source: resolvedSource, level, isOriginPath, sceneNode })
  }
  // Scene-path entries each need the entity chipped at their anchor
  // scene (same auto-chip behaviour the singular tool had). Origin-
  // path entries don't need chipping.
  async function _autoChipForAlias(sceneNode) {
    const wasAlreadyChipped = ENTITY_BUCKETS.some((b) =>
      (sceneNode.data?.[b] || []).some((r) => r.entity_id === entity.id),
    )
    useProjectStore.getState().addEntityChipToNode(
      sceneNode.id, entity.id, { skipUpstreamConfirm: true },
    )
    if (!wasAlreadyChipped) {
      try {
        await useProjectStore.getState()._autoConnectUpstreamForChain(sceneNode.id, entity.id)
      } catch (err) {
        throw new Error(`alias-awareness auto-wire failed at scene ${sceneNode.id}: ${err.message}`)
      }
    }
  }
  const out = []
  const sourcesOut = []
  for (const v of validated) {
    const target = { kind: 'alias', entityId: entity.id, aliasValue: v.aliasTarget.value }
    const anchor = v.isOriginPath
      ? { kind: 'origin', nodeId: null }
      : { kind: 'chain', nodeId: v.sceneNode.id }
    if (!v.isOriginPath) await _autoChipForAlias(v.sceneNode)
    const prior = _readPriorAwarenessForCommit(target, anchor, entity, null)
    const draft = _buildAwarenessDraftWithOverride(prior, v.observerEntity.id, v.level)
    await useProjectStore.getState().commitAwarenessAtAnchor({ target, anchor, draft })
    out.push({
      alias_value: v.aliasTarget.value,
      observer_id: v.observerEntity.id,
      level: v.level,
      level_name: _levelName(v.level),
      scene_id: v.isOriginPath ? null : anchor.nodeId,
    })
  }
  for (const v of validatedSources) {
    const target = { kind: 'alias', entityId: entity.id, aliasValue: v.aliasTarget.value }
    const anchor = v.isOriginPath
      ? { kind: 'origin', nodeId: null }
      : { kind: 'chain', nodeId: v.sceneNode.id }
    if (!v.isOriginPath) await _autoChipForAlias(v.sceneNode)
    const prior = _readPriorAwarenessForCommit(target, anchor, entity, null)
    const draft = _buildAwarenessDraftWithSourceMutation(prior, v.action, v.source, v.level)
    await useProjectStore.getState().commitAwarenessAtAnchor({ target, anchor, draft })
    sourcesOut.push({
      alias_value: v.aliasTarget.value,
      action: v.action,
      source_kind: v.source.kind,
      source_id: v.source.relationship_id,
      source_name: v.source._resolvedName,
      level: v.level,
      level_name: _levelName(v.level),
      scene_id: v.isOriginPath ? null : anchor.nodeId,
    })
  }
  return {
    target_kind: 'alias',
    entity_id: entity.id,
    entries: out,
    sources: sourcesOut,
  }
})

// ── set_relationship_awareness ────────────────────────────────────────

registerMcpTool('set_relationship_awareness', async (args) => {
  const rel = _resolveRelationship(args?.relationship)
  const entriesArg = args?.entries
  const sourcesArg = args?.sources
  const hasEntries = Array.isArray(entriesArg) && entriesArg.length > 0
  const hasSources = Array.isArray(sourcesArg) && sourcesArg.length > 0
  if (!hasEntries && !hasSources) {
    throw new Error(
      'pass either `entries` (per-observer direct pins) or `sources` ' +
      '(per-relationship group projections), or both. ' +
      'entries item: { observer, level, at? }. ' +
      'sources item: { action, source_kind?, source, level?, at? }.'
    )
  }
  // Pre-validate every entry upfront — atomic batch. Awareness lives
  // ON the relationship's own `.awareness.history[]` list (Phase
  // 1.21g awareness-as-second-class-object model), so there's no
  // need to pick a "carrier" entity. Origin writes land on
  // `rel.awareness` baseline; scene writes append to
  // `rel.awareness.history[]` via the canonical
  // `commitAwarenessAtAnchor` pipeline.
  const validated = []
  for (let i = 0; i < (entriesArg || []).length; i++) {
    const e = entriesArg[i]
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      throw new Error(`entries[${i}] must be an object with { observer, level, at? } fields.`)
    }
    _requireAwarenessObserver(e, i)
    let observerEntity, level, sceneNode
    try { observerEntity = _resolveEntity(e.observer).entity }
    catch (err) { throw new Error(`entries[${i}].observer: ${err.message}`) }
    try { level = _resolveAwarenessLevel(e.level) }
    catch (err) { throw new Error(`entries[${i}].level: ${err.message}`) }
    const at = e.at
    const isOriginPath = !at || at === 'origin'
    if (!isOriginPath) {
      try { sceneNode = _resolveScene(at) }
      catch (err) { throw new Error(`entries[${i}].at: ${err.message}`) }
    }
    validated.push({ observerEntity, level, isOriginPath, sceneNode })
  }
  const validatedSources = _validateAwarenessSourceItems(sourcesArg)
  const out = []
  const sourcesOut = []
  for (const v of validated) {
    await useProjectStore.getState().setRelationshipAwareness(
      rel.id,
      v.observerEntity.id,
      v.level,
      v.isOriginPath ? null : v.sceneNode.id,
    )
    out.push({
      observer_id: v.observerEntity.id,
      level: v.level,
      level_name: _levelName(v.level),
      scene_id: v.isOriginPath ? null : v.sceneNode.id,
    })
  }
  const target = { kind: 'relationship', relationshipId: rel.id }
  for (const v of validatedSources) {
    const anchor = v.isOriginPath
      ? { kind: 'origin', nodeId: null }
      : { kind: 'chain', nodeId: v.sceneNode.id }
    const prior = _readPriorAwarenessForCommit(target, anchor, null, rel)
    const draft = _buildAwarenessDraftWithSourceMutation(prior, v.action, v.source, v.level)
    await useProjectStore.getState().commitAwarenessAtAnchor({ target, anchor, draft })
    sourcesOut.push({
      action: v.action,
      source_kind: v.source.kind,
      source_id: v.source.relationship_id,
      source_name: v.source._resolvedName,
      level: v.level,
      level_name: _levelName(v.level),
      scene_id: v.isOriginPath ? null : anchor.nodeId,
    })
  }
  return {
    target_kind: 'relationship',
    relationship_id: rel.id,
    entries: out,
    sources: sourcesOut,
  }
})


// ── Knowledge write tools ──────────────────────────────────────────────
//
// Knowledge has its own baseline + its own scene-anchored history list.
// The knowledge's ORIGIN is the chain stop where it was
// established (its source-event / `existence_changes: activate@scene`
// for born-at-scene knowledges, or unbounded for standalone
// knowledges). At origin: writing baseline directly is the
// scene-aware path. Downstream scene-anchored changes go through
// history entries (name_changes / description_changes /
// colour_changes / profile_image_changes for scalars; awareness
// chain entries via the canonical commitAwarenessAtAnchor path).
//
// All routes go through existing Zustand actions:
//   - createKnowledge / createKnowledgeAtScene → POST + activate event
//   - updateKnowledge → PUT replaces baseline OR appends history entry
//   - deleteObject('knowledge', id) → centralised deletion path
//   - setKnowledgeAwarenessOrigin / setKnowledgeAwarenessAtNode →
//     route through commitAwarenessAtAnchor

// ── Wave 2: create_knowledge ────────────────────────────────────────────

registerMcpTool('create_knowledge', async (args) => {
  const name = (args?.name || '').trim()
  if (!name) throw new Error('name is required and must be non-empty')

  _validateHexColour(args?.colour, 'colour')
  const knowledgeData = {
    name,
    description: args?.description || '',
    colour: args?.colour || '#888888',
    notes: args?.notes || '',
    awareness_scale: args?.awareness_scale || 'full',
  }
  if (args?.profile_image_ref !== undefined) {
    knowledgeData.profile_image_ref = args.profile_image_ref || null
  }

  // Branch: born-at-scene vs standalone. Born-at-scene anchors the
  // knowledge's chain birth to a specific scene via an
  // `existence_changes: activate@scene` event; the scene resolver
  // treats reads before that scene as `not_yet_exists`. Standalone
  // knowledges have no chain birth; the user can pin manual anchors
  // later.
  let result
  if (args?.scene) {
    const sceneNode = _resolveScene(args.scene)
    result = await useProjectStore.getState().createKnowledgeAtScene(knowledgeData, sceneNode.id)
  } else {
    result = await useProjectStore.getState().createKnowledge(knowledgeData)
  }

  return {
    id: result.id,
    name: result.name || '',
  }
})

// ── Phase 8.5 — concept-node helpers (shared by create / get / update) ──────

/** A concept card body accepts EITHER plain text OR rich text as HTML. An HTML
 *  body is converted to the TipTap JSON the reference node's rich-text mode
 *  stores (is_rich_text on) so it renders / edits / converts-to-plain
 *  correctly; plain text stays plain. Returns `{ content, is_rich_text }`. */
function _conceptBodyToStored(body) {
  const raw = (body ?? '').toString()
  if (/<\/?[a-z][a-z0-9]*(\s[^>]*)?\/?>/i.test(raw)) {
    try {
      return { content: JSON.stringify(generateJSON(raw, TIPTAP_EXTENSIONS)), is_rich_text: true }
    } catch {
      return { content: raw, is_rich_text: false }
    }
  }
  return { content: raw, is_rich_text: false }
}

/** Project a concept node's stored body back to readable text/HTML: a rich-text
 *  node's TipTap JSON renders to HTML; a plain node returns its plain text. */
function _conceptBodyForRead(node) {
  const content = node?.data?.content || ''
  if (!node?.data?.is_rich_text) return content
  try {
    return generateHTML(JSON.parse(content), TIPTAP_EXTENSIONS)
  } catch {
    return content
  }
}

/** Resolve a concept reference (UUID or exact, case-insensitive title) to its
 *  concept node. Concept titles are not unique, so an ambiguous title errors. */
function _resolveConcept(ref) {
  if (!ref || typeof ref !== 'string') {
    throw new Error('concept reference is required (UUID or exact title)')
  }
  const concepts = (useProjectStore.getState().nodes || [])
    .filter((n) => n.type === 'referenceNode' && n.data?.sub_type === 'concept')
  const stripped = ref.trim()
  if (_isUuid(stripped)) {
    const byId = concepts.find((n) => n.id === stripped)
    if (byId) return byId
  }
  const lower = stripped.toLowerCase()
  const matches = concepts.filter((n) => (n.data?.title || '').trim().toLowerCase() === lower)
  if (matches.length === 0) {
    throw new Error(`concept not found: "${ref}". Pass a UUID or exact title; call list_concepts to see all concepts.`)
  }
  if (matches.length > 1) {
    throw new Error(`ambiguous concept "${ref}" — ${matches.length} share that title. Pass the UUID to disambiguate.`)
  }
  return matches[0]
}

/** Resolve a reference-node reference (a NOTE or a CONCEPT) by UUID or exact,
 *  case-insensitive title. `_resolveConcept` only matches concepts, so
 *  convert_reference (which must address a note by title to turn it INTO a
 *  concept) uses this instead. Ambiguous title → asks for the UUID. */
function _resolveReferenceNode(ref) {
  if (!ref || typeof ref !== 'string') {
    throw new Error('reference node reference is required (UUID or exact title)')
  }
  const refs = (useProjectStore.getState().nodes || []).filter((n) => n.type === 'referenceNode')
  const stripped = ref.trim()
  if (_isUuid(stripped)) {
    const byId = refs.find((n) => n.id === stripped)
    if (byId) return byId
    throw new Error(`reference node not found: "${ref}".`)
  }
  const lower = stripped.toLowerCase()
  const matches = refs.filter((n) => (n.data?.title || '').trim().toLowerCase() === lower)
  if (matches.length === 0) {
    throw new Error(`reference node not found: "${ref}". Pass a UUID or the exact title of a note or concept.`)
  }
  if (matches.length > 1) {
    throw new Error(`ambiguous reference node "${ref}" — ${matches.length} share that title. Pass the UUID to disambiguate.`)
  }
  return matches[0]
}

/** Resolve a group reference (UUID or exact, case-insensitive title) to its
 *  generic-group node. Group titles are not unique, so an ambiguous title
 *  errors and asks for the UUID. */
function _resolveGroup(ref) {
  if (!ref || typeof ref !== 'string') {
    throw new Error('group reference is required (UUID or exact title)')
  }
  const groups = (useProjectStore.getState().nodes || [])
    .filter((n) => n.type === 'genericGroupNode')
  const stripped = ref.trim()
  if (_isUuid(stripped)) {
    const byId = groups.find((n) => n.id === stripped)
    if (byId) return byId
  }
  const lower = stripped.toLowerCase()
  const matches = groups.filter((n) => (n.data?.title || '').trim().toLowerCase() === lower)
  if (matches.length === 0) {
    throw new Error(`group not found: "${ref}". Pass a UUID or the exact group title.`)
  }
  if (matches.length > 1) {
    throw new Error(`ambiguous group "${ref}" — ${matches.length} share that title. Pass the UUID to disambiguate.`)
  }
  return matches[0]
}

/** Resolve a concept-WIRE endpoint: a concept card OR a concept-mode group.
 *  Concept wiring is a closed world, but a concept-mode group (ports on) is a
 *  first-class wireable body too, so wire_concepts / unwire_concepts accept
 *  either end being a group. Tries a concept card first, then a group; an
 *  ORGANISATION group (concept ports off) is rejected with a pointed message,
 *  and a ref that matches nothing gets a combined not-found error. */
function _resolveConceptEndpoint(ref) {
  try {
    return _resolveConcept(ref)
  } catch {
    let group
    try {
      group = _resolveGroup(ref)
    } catch {
      // Neither a concept nor a group — surface a message covering both.
      throw new Error(
        `no concept or concept-mode group found for "${ref}". Pass a UUID or exact title; call list_concepts to see concepts.`,
      )
    }
    if (group.data?.concept_group !== true) {
      throw new Error(
        `"${group.data?.title || ref}" is an organisation group (concept ports off), so it cannot take a concept wire. Switch it to a concept group first, or wire a concept.`,
      )
    }
    return group
  }
}

/** Find an entity's canvas ORIGIN node — the non-modifier `entityNode` carrying
 *  its entity_id (one per entity). Returns the node, or null when the entity has
 *  no origin node on the canvas. Mirrors the canonical origin-node predicate
 *  used across projectStore.js (`type==='entityNode' && !is_modifier`). */
function _entityOriginNode(entityId) {
  if (!entityId) return null
  return (useProjectStore.getState().nodes || []).find(
    (n) => n.type === 'entityNode' && !n.data?.is_modifier && n.data?.entity_id === entityId,
  ) || null
}

/** Resolve the node to add to a group. Accepts, in order:
 *   - a raw node UUID (any node type);
 *   - a concept title (the concept-layer case);
 *   - an entity name / alias → that entity's canvas ORIGIN node.
 *  A UUID that is an entity library id (not a node id) also maps to the
 *  entity's origin node, so either id shape works for entities. */
function _resolveGroupMemberNode(ref) {
  if (!ref || typeof ref !== 'string') {
    throw new Error('node reference is required (UUID, concept title, or entity name)')
  }
  const stripped = ref.trim()
  if (_isUuid(stripped)) {
    const byId = (useProjectStore.getState().nodes || []).find((n) => n.id === stripped)
    if (byId) return byId
    // Not a node id — maybe an entity library id → map to its origin node.
    const originById = _entityOriginNode(stripped)
    if (originById) return originById
    throw new Error(`node not found: "${ref}".`)
  }
  // Not a UUID → try a concept title first, then an entity name → origin node.
  try {
    return _resolveConcept(stripped)
  } catch { /* not a concept — fall through to entity-name resolution */ }
  let resolved
  try {
    resolved = _resolveEntity(stripped)
  } catch {
    throw new Error(
      `could not resolve "${ref}" to a node. Pass a node UUID, a concept title, or an entity name.`,
    )
  }
  const origin = _entityOriginNode(resolved.entity.id)
  if (!origin) {
    throw new Error(
      `"${ref}" is the entity '${resolved.entity.name || ref}', but it has no origin node on the canvas to group.`,
    )
  }
  return origin
}

/** Resolve a tags arg (single ref or array of refs) to a list of tag ids. */
function _resolveConceptTagIds(tags) {
  const refs = Array.isArray(tags) ? tags : (tags != null ? [tags] : [])
  return refs.map((t) => _resolveTag(t).id)
}

// ── Phase 8.5 — create_concept (concept-layer brainstorming node) ───────────
// Creates a concept node (a reference node with sub_type='concept') on the
// canvas's concept layer. The AI never positions it: the concept auto-layout
// packs it into the concept region (above the topmost node, left of the first
// chapter) and tracks it in the session Set so later concept-layout passes may
// arrange it without disturbing user-placed nodes.
registerMcpTool('create_concept', async (args) => {
  const ps = useProjectStore.getState()
  const title = (args?.title ?? '').toString().trim()
  const { content, is_rich_text } = _conceptBodyToStored(args?.body ?? args?.content ?? '')
  if (args?.colour != null) _validateHexColour(args.colour, 'colour')
  const tag_ids = _resolveConceptTagIds(args?.tags)

  // Placement: OFF-chapter concept region by default (concepts live off to the
  // side); an optional `chapter` arg drops it into a band above that chapter's
  // scenes instead, where the partition-aware tidy keeps it. A brand-new concept
  // has no wires yet, so it takes the next free slot.
  const chapter = _interpretChapterArg(args)   // undefined | null (off) | chapter obj
  const pos = (chapter && chapter.id)
    ? _placeConceptInChapter(ps, chapter, null)
    : placeMcpConceptNode(ps.nodes, ps.nodes.filter((n) => _mcpSessionConceptNodeIds.has(n.id)), null)

  const extra = { title, content, is_rich_text }
  if (args?.colour != null) extra.colour = args.colour
  if (tag_ids.length) extra.tag_ids = tag_ids

  const id = ps.addReferenceNode(pos, 'concept', extra)
  _mcpSessionConceptNodeIds.add(id)

  return { id, title, chapter: (chapter && chapter.id) ? (chapter.title || chapter.id) : null }
})

// ── Phase 8.5 — list_concepts (discovery) ───────────────────────────────────
/** Chapter (title, or null when off-chapter) + the group(s) that geometrically
 *  contain a concept node — for the read tools, so an MCP client can verify
 *  placement + membership from a read, not only the create/update echo. */
function _conceptPlacement(node) {
  const ps = useProjectStore.getState()
  const chapterId = _conceptChapterOfNode(ps)(node)
  let chapter = null
  if (chapterId) {
    const chapters = ps.story?.chapters || []
    const idx = chapters.findIndex((c) => c.id === chapterId)
    chapter = idx >= 0 ? (chapters[idx].title || `Chapter ${idx + 1}`) : chapterId
  }
  const groups = getGroupsForNode(node, ps.nodes || []).map((g) => ({
    id: g.id,
    title: g.data?.title || '',
    mode: g.data?.concept_group ? 'concept' : 'organization',
  }))
  return { chapter, groups }
}

registerMcpTool('list_concepts', () => {
  const concepts = (useProjectStore.getState().nodes || [])
    .filter((n) => n.type === 'referenceNode' && n.data?.sub_type === 'concept')
    .map((n) => {
      const { chapter, groups } = _conceptPlacement(n)
      return {
        id: n.id,
        title: n.data?.title || '',
        colour: n.data?.colour || null,
        is_rich_text: !!n.data?.is_rich_text,
        chapter,
        groups,
      }
    })
  return { concepts }
})

// ── Phase 8.5 — get_concept (read one) ──────────────────────────────────────
registerMcpTool('get_concept', (args) => {
  const node = _resolveConcept(args?.concept)
  const tagIds = node.data?.tag_ids || []
  const tags = tagIds.map((id) => {
    const pool = useEntitiesStore.getState().projectTags
      ?? useProjectStore.getState().story?.project_tags ?? []
    const t = pool.find((x) => x.id === id)
    return t ? { id: t.id, name: t.name || '' } : { id, name: '' }
  })
  const { chapter, groups } = _conceptPlacement(node)
  return {
    id: node.id,
    title: node.data?.title || '',
    body: _conceptBodyForRead(node),
    is_rich_text: !!node.data?.is_rich_text,
    colour: node.data?.colour || null,
    tags,
    chapter,
    groups,
  }
})

// ── Phase 8.5 — update_concept (title / body / colour / tags) ────────────────
registerMcpTool('update_concept', async (args) => {
  const node = _resolveConcept(args?.concept)
  const patch = {}
  const updated = []  // SEMANTIC field names (body, not the internal content/is_rich_text)
  if (args?.title != null) { patch.title = args.title.toString(); updated.push('title') }
  if (args?.body != null || args?.content != null) {
    const { content, is_rich_text } = _conceptBodyToStored(args?.body ?? args?.content ?? '')
    patch.content = content
    patch.is_rich_text = is_rich_text
    updated.push('body')
  }
  if (args?.colour != null) {
    _validateHexColour(args.colour, 'colour')
    patch.colour = args.colour
    updated.push('colour')
  }
  if (args?.tags != null) { patch.tag_ids = _resolveConceptTagIds(args.tags); updated.push('tags') }
  const chapterArg = _interpretChapterArg(args)  // undefined (no change) | null (→ off-chapter) | chapter obj
  if (updated.length === 0 && chapterArg === undefined) {
    throw new Error('update_concept: nothing to update — pass at least one of title / body / colour / tags / chapter.')
  }
  if (updated.length) useProjectStore.getState().updateNodeData(node.id, patch)
  let chapterResult
  if (chapterArg !== undefined) {
    const psNow = useProjectStore.getState()
    const fresh = psNow.nodes.find((n) => n.id === node.id) || node
    const curChapterId = _conceptChapterOfNode(psNow)(fresh)
    const targetChapterId = (chapterArg && chapterArg.id) ? chapterArg.id : null
    chapterResult = (chapterArg && chapterArg.id) ? (chapterArg.title || chapterArg.id) : null
    // Only reposition (and report "chapter") on an ACTUAL change — re-assigning the
    // same chapter, or clearing an already-off-chapter concept, is a no-op. Otherwise
    // reposition into the chapter's band, or (clear) back to the off-chapter region;
    // applyConceptLayout also re-faces the node's wires for the new spot.
    if (curChapterId !== targetChapterId) {
      const pos = (chapterArg && chapterArg.id)
        ? _placeConceptInChapter(psNow, chapterArg, node.id)
        : placeMcpConceptNode(psNow.nodes, [], node.id)
      psNow.applyConceptLayout(new Map([[node.id, pos]]), { snapshot: true })
      updated.push('chapter')
    }
  }
  const now = useProjectStore.getState().nodes.find((n) => n.id === node.id) || node
  return { id: node.id, title: now.data?.title || '', updated, chapter: chapterResult }
})

// ── Phase 8.5 — delete_concept (DESTRUCTIVE) ─────────────────────────────────
registerMcpTool('delete_concept', async (args) => {
  const node = _resolveConcept(args?.concept)
  const id = node.id
  const title = node.data?.title || ''
  // Routes through the delete dispatcher (strips any concept wires touching it,
  // no confirm dialog). Also drop it from the session tracking Set.
  await useProjectStore.getState().deleteObject('node', id)
  _mcpSessionConceptNodeIds.delete(id)
  return { deleted: true, id, title }
})

// ── Phase 8.5 — wire_concepts / unwire_concepts (concept wires) ──────────────
// Concept wiring is a closed world: concept nodes connect only to concept
// nodes. The AI names the two concepts and the app picks facing ports + builds
// the conceptEdge (mirroring the GUI drag path). Idempotent on the node pair.
// ── Phase 8.5 item 459 — relational concept tidy (wire-driven auto-layout) ───
// The intelligent, wire-driven layout: on every wire / unwire the concept map is
// re-arranged so the new connection reads correctly right then (a hub looks like
// a hub, a chain like a line, clusters separate). Only THIS session's nodes move
// (the isolation set); user-placed concepts stay put but are taken into account
// as anchors when a session node is wired to them.

/** Left edge of the first chapter (single-row AND multi-row both extend chapters
 *  rightward from `chapter_x_offset`), so the concept tidy keeps the map left of
 *  it. Infinity when the story has no chapters — no chapter region to avoid. */
function _conceptChapterLeftEdge(ps) {
  const chapters = ps.story?.chapters
  if (!chapters || chapters.length === 0) return Infinity
  return typeof ps.story?.chapter_x_offset === 'number' ? ps.story.chapter_x_offset : 10
}

/** Mode-aware chapter-membership fn for the concept layout (single-row OR
 *  multi-row), resolved from the active story. Concepts left of the first
 *  chapter resolve to null (off-chapter). */
function _conceptChapterOfNode(ps) {
  const story = ps.story || {}
  const chapters = story.chapters || []
  const opts = chapterMemberOptsForStory(story)
  return (n) => resolveChapterIdForNode(n, chapters, opts)
}

/** Recompute + apply the relational concept tidy for this session's nodes.
 *  Chapter-partitioned (Phase 8.5): off-chapter session concepts tidy in the
 *  off-to-the-side cluster; a session concept assigned to a chapter tidies in a
 *  band above that chapter's scenes and STAYS there. Only this session's nodes
 *  move; user-placed concepts anchor the layout. `snapshot=false` folds the
 *  reposition into a preceding store snapshot (the wire that triggered it) so one
 *  undo reverts both. Returns nodes moved. */
function _tidyConceptsSession({ snapshot = true } = {}) {
  const ps = useProjectStore.getState()
  const merged = computeReorganizeConceptLayout(ps.nodes, ps.edges, {
    chapterOfNode: _conceptChapterOfNode(ps),
    snapToGrid: ps.snapToGrid,
    chapterLeftEdge: _conceptChapterLeftEdge(ps),
    movableConceptIds: _mcpSessionConceptNodeIds,
    movableGroupIds: _mcpSessionGroupNodeIds,
  })
  return ps.applyConceptLayout(merged, { snapshot })
}

/** Interpret an optional `chapter` tool arg for the concept / group tools.
 *  Returns `undefined` when the key is absent (no chapter change), `null` when it
 *  is an explicit clear ("none" / "off" / empty / null → move OFF-chapter), or the
 *  resolved chapter object to assign. Throws (via `_resolveChapter`) on a bad ref. */
function _interpretChapterArg(args) {
  if (!args || !('chapter' in args)) return undefined
  const v = args.chapter
  if (v == null) return null
  const s = v.toString().trim().toLowerCase()
  if (s === '' || s === 'none' || s === 'off' || s === 'off-chapter' || s === 'no' || s === 'null') return null
  return _resolveChapter(v)
}

/** Position for a concept assigned to a chapter: a free slot in the band ABOVE
 *  that chapter's scenes. Falls back to the chapter centre (above the strip) when
 *  the chapter has no scenes yet. `chapter` is a resolved chapter object. */
function _placeConceptInChapter(ps, chapter, newId = null) {
  const region = computeChapterConceptRegion(ps.nodes, _conceptChapterOfNode(ps), chapter.id)
  if (region) return placeMcpConceptNode(ps.nodes, [], newId, {
    regionOverride: { leftX: region.leftX, floorY: region.floorY },
    bandMaxWidth: region.maxX - region.leftX,   // confine to the chapter's scene span (no spill into the next chapter)
  })
  return { x: Math.round(_chapterCentreX(chapter) - 120), y: 0 }
}

/** Like `_placeConceptInChapter` but for a concept GROUP (a larger container). */
function _placeGroupInChapter(ps, chapter, newId = null, height) {
  const region = computeChapterConceptRegion(ps.nodes, _conceptChapterOfNode(ps), chapter.id)
  if (region) return placeMcpGroupNode(ps.nodes, null, newId, { height, regionOverride: { leftX: region.leftX, floorY: region.floorY } })
  return { x: Math.round(_chapterCentreX(chapter) - 200), y: 0 }
}

/** Resolve the `tidy_concepts` scope to the movable id sets. */
function _tidyMovableForScope(scope) {
  const s = (scope || 'session').toString().toLowerCase()
  const nodes = useProjectStore.getState().nodes || []
  const isConceptNode = (n) => n.type === 'referenceNode' && n.data?.sub_type === 'concept'
  const isConceptGroup = (n) => n.type === 'genericGroupNode' && n.data?.concept_group === true
  if (s === 'all') {
    return {
      movableConceptIds: new Set(nodes.filter(isConceptNode).map((n) => n.id)),
      movableGroupIds: new Set(nodes.filter(isConceptGroup).map((n) => n.id)),
    }
  }
  if (s === 'region') {
    const conceptLayer = new Set(nodes.filter((n) => isConceptNode(n) || isConceptGroup(n)).map((n) => n.id))
    const { floorY } = computeConceptRegion(nodes, conceptLayer)
    const inBand = (n) => (n.position?.y ?? 0) < floorY
    return {
      movableConceptIds: new Set(nodes.filter((n) => isConceptNode(n) && inBand(n)).map((n) => n.id)),
      movableGroupIds: new Set(nodes.filter((n) => isConceptGroup(n) && inBand(n)).map((n) => n.id)),
    }
  }
  // 'session' (default): only this session's nodes. If empty (e.g. after a
  // reload) fall through to the spatial band proxy so an explicit re-tidy works.
  if (_mcpSessionConceptNodeIds.size === 0 && _mcpSessionGroupNodeIds.size === 0) {
    return _tidyMovableForScope('region')
  }
  return { movableConceptIds: _mcpSessionConceptNodeIds, movableGroupIds: _mcpSessionGroupNodeIds }
}

registerMcpTool('wire_concepts', async (args) => {
  const a = _resolveConceptEndpoint(args?.a ?? args?.from ?? args?.source ?? args?.concept_a)
  const b = _resolveConceptEndpoint(args?.b ?? args?.to ?? args?.target ?? args?.concept_b)
  if (a.id === b.id) throw new Error('wire_concepts: a concept cannot be wired to itself.')
  const edgeId = useProjectStore.getState().addConceptEdge(a.id, b.id)
  // Re-lay-out so the new connection reads correctly, folded into the wire's undo step.
  const moved = _tidyConceptsSession({ snapshot: false })
  return { wired: true, edge_id: edgeId, a: a.data?.title || '', b: b.data?.title || '', relaid_out: moved }
})

registerMcpTool('unwire_concepts', async (args) => {
  const a = _resolveConceptEndpoint(args?.a ?? args?.from ?? args?.source ?? args?.concept_a)
  const b = _resolveConceptEndpoint(args?.b ?? args?.to ?? args?.target ?? args?.concept_b)
  const removed = useProjectStore.getState().removeConceptEdge(a.id, b.id)
  const moved = removed > 0 ? _tidyConceptsSession({ snapshot: false }) : 0
  return { unwired: removed > 0, removed_count: removed, a: a.data?.title || '', b: b.data?.title || '', relaid_out: moved }
})

registerMcpTool('tidy_concepts', async (args) => {
  const scope = (args?.scope ?? 'session').toString().toLowerCase()
  if (!['session', 'region', 'all'].includes(scope)) {
    throw new Error(`tidy_concepts: scope must be 'session', 'region', or 'all' (got '${args?.scope}').`)
  }
  const { movableConceptIds, movableGroupIds } = _tidyMovableForScope(scope)
  const ps = useProjectStore.getState()
  const { positions } = computeConceptTidyLayout(ps.nodes, ps.edges, { movableConceptIds, movableGroupIds, snapToGrid: ps.snapToGrid, chapterLeftEdge: _conceptChapterLeftEdge(ps) })
  const moved = ps.applyConceptLayout(positions, { snapshot: true })
  return { tidied: true, moved, scope }
})

// ── Phase 8.5 — create_group / add_to_group (group containers) ───────────────
// A group is a canvas container whose membership is purely geometric (a node is
// "in" the group when its bbox sits inside the group's bbox). `mode` picks
// whether it's a CONCEPT group (concept ports on, so it can be wired into the
// concept layer) or a plain ORGANISATION container (ports off). The AI never
// positions it: create_group packs it into the concept region, add_to_group
// moves a node into the group's interior and grows the group to fit.
registerMcpTool('create_group', async (args) => {
  const ps = useProjectStore.getState()
  const raw = (args?.mode ?? 'concept').toString().trim().toLowerCase()
  // Validate the enum instead of silently coercing an unknown value to 'concept'
  // (mirrors how tidy_concepts validates its scope).
  if (raw !== 'concept' && raw !== 'organization' && raw !== 'organisation') {
    throw new Error(`create_group: mode must be 'concept' or 'organization' (got '${args.mode}').`)
  }
  const mode = (raw === 'organization' || raw === 'organisation') ? 'organization' : 'concept'
  const conceptGroup = mode === 'concept'
  const title = (args?.title ?? '').toString().trim()
  let colour = '#71717a'
  if (args?.colour != null) { _validateHexColour(args.colour, 'colour'); colour = args.colour }
  // Placement: OFF-chapter concept region by default (to the right of this
  // session's concept-layer nodes so it never lands on the band); an optional
  // `chapter` arg drops it into a band above that chapter's scenes instead.
  const chapter = _interpretChapterArg(args)   // undefined | null (off) | chapter obj
  const pos = (chapter && chapter.id)
    ? _placeGroupInChapter(ps, chapter, null)
    : placeMcpGroupNode(ps.nodes, new Set([..._mcpSessionConceptNodeIds, ..._mcpSessionGroupNodeIds]), null)
  const id = ps.addGroupNode(pos, { conceptGroup, title, colour })
  _mcpSessionGroupNodeIds.add(id)
  return { id, title, mode, chapter: (chapter && chapter.id) ? (chapter.title || chapter.id) : null }
})

registerMcpTool('add_to_group', async (args) => {
  const group = _resolveGroup(args?.group)
  const node = _resolveGroupMemberNode(args?.node ?? args?.concept)
  if (node.id === group.id) throw new Error('add_to_group: a group cannot be added to itself.')
  const ok = useProjectStore.getState().addNodeToGroup(node.id, group.id)
  if (!ok) throw new Error('add_to_group: could not place the node in the group.')
  // Friendly label: concept title, else the referenced entity's name, else id.
  let nodeLabel = node.data?.title
  if (!nodeLabel && node.data?.entity_id) nodeLabel = _findEntity(node.data.entity_id)?.entity?.name
  return { added: true, node: nodeLabel || node.id, group: group.data?.title || group.id }
})

// ── Phase 8.5 — update_group (title / colour / chapter reassignment) ─────────
// Modify an existing group. `chapter` moves the WHOLE group (box + every node
// inside it) to a band above that chapter's scenes, or (clear) back off-chapter;
// the group and its contents translate together so containment always holds.
registerMcpTool('update_group', async (args) => {
  const group = _resolveGroup(args?.group)
  const patch = {}
  const updated = []
  if (args?.title != null) { patch.title = args.title.toString(); updated.push('title') }
  if (args?.colour != null) { _validateHexColour(args.colour, 'colour'); patch.colour = args.colour; updated.push('colour') }
  const chapterArg = _interpretChapterArg(args)  // undefined (no change) | null (→ off-chapter) | chapter obj
  if (updated.length === 0 && chapterArg === undefined) {
    throw new Error('update_group: nothing to update — pass at least one of title / colour / chapter.')
  }
  if (updated.length) useProjectStore.getState().updateNodeData(group.id, patch)
  let chapterResult
  if (chapterArg !== undefined) {
    const psNow = useProjectStore.getState()
    const g = psNow.nodes.find((n) => n.id === group.id)
    const curChapterId = _conceptChapterOfNode(psNow)(g)
    const targetChapterId = (chapterArg && chapterArg.id) ? chapterArg.id : null
    chapterResult = (chapterArg && chapterArg.id) ? (chapterArg.title || chapterArg.id) : null
    // Only move (and report "chapter") on an ACTUAL change — moving to the chapter
    // it is already in, or clearing an already-off-chapter group, is a no-op.
    if (curChapterId !== targetChapterId) {
      const height = g?.measured?.height ?? g?.data?.height ?? g?.height ?? 300
      const newPos = (chapterArg && chapterArg.id)
        ? _placeGroupInChapter(psNow, chapterArg, group.id, height)
        : placeMcpGroupNode(psNow.nodes, null, group.id, { height })
      // Rigid translate: the box AND every contained node move by the same delta so
      // geometric membership holds. applyConceptLayout re-faces any concept wires.
      const dx = newPos.x - (g?.position?.x ?? 0)
      const dy = newPos.y - (g?.position?.y ?? 0)
      const posMap = new Map([[group.id, { x: newPos.x, y: newPos.y }]])
      for (const m of getNodesInGroup(g, psNow.nodes, { excludeGroups: false })) {
        posMap.set(m.id, { x: (m.position?.x ?? 0) + dx, y: (m.position?.y ?? 0) + dy })
      }
      psNow.applyConceptLayout(posMap, { snapshot: true })
      updated.push('chapter')
    }
  }
  const now = useProjectStore.getState().nodes.find((n) => n.id === group.id) || group
  return { id: group.id, title: now.data?.title || '', updated, chapter: chapterResult }
})

/** Describe one group member node as a compact `{ id, kind, title }` for
 *  list_group_members. `kind` is a plain-language node label (scene, concept,
 *  note, media, the entity's own type, group); `title` is its human name (an
 *  entity node resolves to the entity's name). Mirrors the geometric membership
 *  the count in list_groups reports, so the two stay in lockstep. */
function _describeGroupMember(node) {
  const data = node.data || {}
  let kind = node.type
  let title = data.title || ''
  switch (node.type) {
    case 'sceneNode':
      kind = 'scene'
      break
    case 'referenceNode':
      kind = data.sub_type || 'note'   // 'concept' | 'note' | 'media'
      break
    case 'entityNode': {
      const found = data.entity_id ? _findEntity(data.entity_id) : null
      kind = found ? found.type : 'entity'
      if (found?.entity?.name) title = found.entity.name
      break
    }
    case 'povOriginNode':
      kind = 'pov'
      break
    case 'genericGroupNode':
      kind = data.concept_group ? 'concept group' : 'organization group'
      break
    default:
      break
  }
  return { id: node.id, kind, title }
}

// ── Phase 8.5 — list_groups + list_group_members (discovery) + delete_group ──
registerMcpTool('list_groups', () => {
  const nodes = useProjectStore.getState().nodes || []
  const groups = nodes
    .filter((n) => n.type === 'genericGroupNode')
    .map((g) => ({
      id: g.id,
      title: g.data?.title || '',
      mode: g.data?.concept_group ? 'concept' : 'organization',
      member_count: getNodesInGroup(g, nodes, { excludeGroups: false }).length,
    }))
  return { groups }
})

// List the actual CONTENTS of one group — every node geometrically inside it,
// each as { id, kind, title }. list_groups gives only a count; this is how a
// client sees WHICH nodes (including any narrative nodes a box happens to
// enclose) are inside, e.g. to spot and clean up unintended members.
registerMcpTool('list_group_members', (args) => {
  const group = _resolveGroup(args?.group)
  const nodes = useProjectStore.getState().nodes || []
  const members = getNodesInGroup(group, nodes, { excludeGroups: false }).map(_describeGroupMember)
  return {
    id: group.id,
    title: group.data?.title || '',
    mode: group.data?.concept_group ? 'concept' : 'organization',
    members,
  }
})

/** Display title for a chapter: its stored title, or the UI placeholder
 *  `Chapter N` (1-based row-major index) for an unnamed chapter — the same name
 *  the writer sees in the UI and that `_resolveChapter` accepts on input. */
function _chapterDisplayTitle(chapter, chapters) {
  if (chapter?.title) return chapter.title
  const idx = (chapters || []).findIndex((c) => c.id === chapter?.id)
  return idx >= 0 ? `Chapter ${idx + 1}` : ''
}

/** Resolve a NAME to a single canvas node of ANY type, for get_chapter_membership.
 *  Collects every node whose displayed name matches (scene / concept / note /
 *  media / group by `data.title`; an entity origin node by the entity's name),
 *  case-insensitive. Exactly one → that node; none → not-found; several →
 *  ambiguous (ask for the UUID). */
function _resolveAnyNodeByName(name) {
  const lower = name.trim().toLowerCase()
  const nodes = useProjectStore.getState().nodes || []
  const hits = []
  for (const n of nodes) {
    const title = (n.data?.title || '').trim().toLowerCase()
    if (title && title === lower) { hits.push(n); continue }
    if (n.type === 'entityNode' && !n.data?.is_modifier && n.data?.entity_id) {
      const found = _findEntity(n.data.entity_id)
      if (found?.entity?.name && found.entity.name.trim().toLowerCase() === lower) hits.push(n)
    }
  }
  if (hits.length === 0) throw new Error(`no node named "${name}".`)
  if (hits.length > 1) {
    const list = hits.map((n) => { const d = _describeGroupMember(n); return `${d.kind} "${d.title}" (id=${n.id})` }).join('; ')
    throw new Error(`ambiguous node "${name}" — ${hits.length} matches: ${list}. Pass the UUID to disambiguate.`)
  }
  return hits[0]
}

/** Resolve the bidirectional get_chapter_membership `ref` to EITHER a chapter or
 *  a node. A UUID is unambiguous: chapter id → chapter, else node id → node,
 *  else entity-library id → that entity's origin node. A NAME is resolved as a
 *  chapter and as a node independently; a name that matches BOTH kinds is
 *  ambiguous and asks for the UUID. Returns `{ kind:'chapter', chapter }` or
 *  `{ kind:'node', node }`. */
function _resolveChapterOrNode(ref) {
  if (!ref || typeof ref !== 'string' || !ref.trim()) {
    throw new Error('a chapter or node reference is required (UUID or exact name)')
  }
  const stripped = ref.trim()
  const state = useProjectStore.getState()
  if (_isUuid(stripped)) {
    const ch = (state.story?.chapters || []).find((c) => c.id === stripped)
    if (ch) return { kind: 'chapter', chapter: ch }
    const node = (state.nodes || []).find((n) => n.id === stripped)
    if (node) return { kind: 'node', node }
    const origin = _entityOriginNode(stripped)   // an entity library id → its origin node
    if (origin) return { kind: 'node', node: origin }
    throw new Error(`no chapter or node found for id "${ref}".`)
  }
  let chapter = null
  try { chapter = _resolveChapter(stripped) } catch { /* not a chapter name */ }
  let node = null
  try { node = _resolveAnyNodeByName(stripped) } catch { /* not a node name */ }
  if (chapter && node) {
    throw new Error(
      `"${ref}" matches both a chapter (id=${chapter.id}) and a node (id=${node.id}). ` +
      `Pass the UUID to disambiguate.`,
    )
  }
  if (chapter) return { kind: 'chapter', chapter }
  if (node) return { kind: 'node', node }
  throw new Error(
    `could not resolve "${ref}" to a chapter or a node. Pass a UUID, an exact ` +
    `chapter title (or the "Chapter 1" placeholder), a scene / concept / note title, ` +
    `an entity name, or a group title.`,
  )
}

// Bidirectional chapter membership. A NODE ref → the chapter it sits in; a
// CHAPTER ref → the nodes that sit in it. Membership is geometric and
// mode-aware (single- AND multi-row) via resolveChapterIdForNode +
// chapterMemberOptsForStory — the same rule the canvas / table of contents use.
// Complements list_group_members (a group's contents) on the chapter axis.
registerMcpTool('get_chapter_membership', (args) => {
  const resolved = _resolveChapterOrNode(args?.ref)
  const state = useProjectStore.getState()
  const story = state.story || {}
  const chapters = story.chapters || []
  const opts = chapterMemberOptsForStory(story)

  if (resolved.kind === 'node') {
    const node = resolved.node
    const chId = resolveChapterIdForNode(node, chapters, opts)
    const ch = chId ? chapters.find((c) => c.id === chId) : null
    return {
      query: args?.ref,
      resolved: 'node',
      node: _describeGroupMember(node),
      chapter: ch ? { id: ch.id, title: _chapterDisplayTitle(ch, chapters) } : null,
    }
  }

  const chapter = resolved.chapter
  const members = (state.nodes || [])
    .filter((n) => resolveChapterIdForNode(n, chapters, opts) === chapter.id)
    .map(_describeGroupMember)
  return {
    query: args?.ref,
    resolved: 'chapter',
    chapter: { id: chapter.id, title: _chapterDisplayTitle(chapter, chapters) },
    members,
  }
})

registerMcpTool('delete_group', async (args) => {
  const group = _resolveGroup(args?.group)
  const id = group.id
  const title = group.data?.title || ''
  // Deletes only the group BOX. Membership is geometric, so the members are
  // separate canvas nodes that stay put (just ungrouped); concept wires touching
  // the group are stripped by the node-delete path.
  await useProjectStore.getState().deleteObject('node', id)
  _mcpSessionGroupNodeIds.delete(id)
  return { deleted: true, id, title }
})

// ── Phase 8.5 — convert tools (expose Phase 8.4 "Convert to") ────────────────
// Surface the GUI "Convert to" conversions as tool calls. Convert is a MOVE
// (the object keeps its id, so every by-id reference stays valid), so these are
// session-gated writes, not destructive deletes. The choices the GUI modal
// collects are optional tool params; omitted ones fall back to the Phase 8.4
// defaults resolved inside the shared convert actions.

/** Resolve the faction-Members handling (entering a faction) into the shape
 *  `convertEntityType` / `convertKnowledgeToEntity` expect. `create` (default)
 *  makes a fresh Members relationship; `adopt` / `copy` reuse an existing
 *  relationship named by `faction_source`. */
function _resolveFactionMembers(mode, sourceRef) {
  const m = (mode || 'create').toString().toLowerCase()
  if (m === 'create') return { mode: 'create' }
  if (m === 'adopt' || m === 'copy') {
    if (!sourceRef) {
      throw new Error(`faction_members='${m}' needs faction_source (the existing relationship to ${m} as the Members relationship).`)
    }
    return { mode: m, sourceRelId: _resolveRelationship(sourceRef).id }
  }
  throw new Error(`faction_members must be 'create', 'adopt', or 'copy' (got '${mode}').`)
}

registerMcpTool('convert_entity', async (args) => {
  const { entity, type: fromType } = _resolveEntity(args?.entity)
  const toType = (args?.to_type ?? args?.type ?? '').toString().trim().toLowerCase()
  if (!_ENTITY_TYPES.includes(toType)) {
    throw new Error(`to_type must be one of ${_ENTITY_TYPES.join(', ')} (got '${args?.to_type}').`)
  }
  if (toType === fromType) throw new Error(`'${entity.name || entity.id}' is already a ${toType}.`)

  const options = {}
  if (toType === 'custom') {
    if (args?.category == null) {
      throw new Error(`converting to a custom entity requires 'category' (an existing custom category name or id).`)
    }
    options.categoryId = _resolveCustomCategoryId(args.category)
  }
  if (fromType === 'location' && args?.location_children != null) {
    const lc = args.location_children.toString().toLowerCase()
    if (lc !== 'reparent' && lc !== 'clear') throw new Error(`location_children must be 'reparent' or 'clear'.`)
    options.locationChildren = lc
  }
  if (toType === 'faction') {
    options.factionMembers = _resolveFactionMembers(args?.faction_members, args?.faction_source)
  }
  if (fromType === 'faction' && args?.faction_leave != null) {
    const fl = args.faction_leave.toString().toLowerCase()
    if (fl !== 'convert' && fl !== 'delete') throw new Error(`faction_leave must be 'convert' or 'delete'.`)
    options.factionLeave = fl
  }

  useProjectStore.getState().convertEntityType(entity.id, toType, options)
  const now = useEntitiesStore.getState().getEntityById(entity.id)
  if (!now || now.type !== toType) {
    throw new Error(`convert_entity: the conversion of '${entity.name || entity.id}' to ${toType} did not apply.`)
  }
  return { id: entity.id, name: now.name || '', from_type: fromType, to_type: toType }
})

registerMcpTool('convert_knowledge', async (args) => {
  const k = _resolveKnowledge(args?.knowledge)
  const toType = (args?.to_type ?? args?.type ?? '').toString().trim().toLowerCase()
  if (!_ENTITY_TYPES.includes(toType)) {
    throw new Error(`to_type must be one of ${_ENTITY_TYPES.join(', ')} (got '${args?.to_type}').`)
  }

  const options = {}
  if (args?.population != null) {
    const p = args.population.toString().toLowerCase()
    if (!['auto', 'orphaned', 'origin'].includes(p)) {
      throw new Error(`population must be 'auto', 'orphaned', or 'origin' (got '${args.population}').`)
    }
    options.population = p
  }
  if (toType === 'custom') {
    if (args?.category == null) {
      throw new Error(`converting to a custom entity requires 'category' (an existing custom category name or id).`)
    }
    options.categoryId = _resolveCustomCategoryId(args.category)
  }
  if (toType === 'faction') {
    options.factionMembers = _resolveFactionMembers(args?.faction_members, args?.faction_source)
  }

  const kName = k.name || ''
  useProjectStore.getState().convertKnowledgeToEntity(k.id, toType, options)
  const now = useEntitiesStore.getState().getEntityById(k.id)
  if (!now || now.type !== toType) {
    throw new Error(`convert_knowledge: the conversion of '${kName || k.id}' to a ${toType} entity did not apply.`)
  }
  return { id: k.id, name: now.name || '', from: 'knowledge', to_type: toType }
})

registerMcpTool('convert_reference', async (args) => {
  const to = (args?.to ?? args?.to_type ?? '').toString().trim().toLowerCase()
  if (to !== 'note' && to !== 'concept') {
    throw new Error(`convert_reference 'to' must be 'note' or 'concept' (got '${args?.to}').`)
  }
  const ref = (args?.reference ?? args?.node ?? args?.concept ?? '').toString().trim()
  if (!ref) throw new Error(`convert_reference needs 'reference' (a reference-node UUID, or a note/concept title).`)
  const node = _resolveReferenceNode(ref)  // a NOTE or a CONCEPT, by UUID or exact title
  const from = node.data?.sub_type || 'note'
  if (from === to) throw new Error(`that reference node is already a ${to}.`)
  if (from !== 'note' && from !== 'concept') {
    throw new Error(`that reference node is a ${from} node and can't be converted between note and concept.`)
  }
  useProjectStore.getState().convertReferenceNodeSubType(node.id, to)
  const now = (useProjectStore.getState().nodes || []).find((n) => n.id === node.id)
  if ((now?.data?.sub_type || 'note') !== to) {
    throw new Error(`convert_reference: the conversion to ${to} did not apply.`)
  }
  return { id: node.id, from, to }
})

// ── Wave 2: delete_knowledge (DESTRUCTIVE) ──────────────────────────────

registerMcpTool('delete_knowledge', async (args) => {
  // Backend has already passed both gates (session-active +
  // destructive approval) before this handler runs.
  const k = _resolveKnowledge(args?.knowledge)
  const id = k.id
  const name = k.name || ''

  await useProjectStore.getState().deleteObject('knowledge', id)

  return { id, name }
})

// ── Wave 2: update_knowledge (origin OR scene) ──────────────────────────

registerMcpTool('update_knowledge', async (args) => {
  const k = _resolveKnowledge(args?.knowledge)
  const at = args?.at
  const isOriginPath = !at || at === 'origin'

  if (isOriginPath) {
    // ─── ORIGIN PATH (baseline write) ────────────────────────────
    // Per chain rule, baseline writes at the knowledge's origin
    // ARE the scene-aware path. updateKnowledge → PUT replaces
    // the knowledge baseline.
    const updated = { ...k }
    if (args.name !== undefined) {
      const trimmed = String(args.name).trim()
      if (!trimmed) throw new Error('name cannot be empty')
      updated.name = trimmed
    }
    if (args.description !== undefined) updated.description = String(args.description)
    if (args.colour !== undefined) {
      _validateHexColour(args.colour, 'colour')
      updated.colour = String(args.colour)
    }
    if (args.profile_image_ref !== undefined) {
      updated.profile_image_ref = args.profile_image_ref === '' ? null : String(args.profile_image_ref)
    }
    if (args.notes !== undefined) updated.notes = String(args.notes)
    if (args.awareness_scale !== undefined) updated.awareness_scale = args.awareness_scale

    const result = await useProjectStore.getState().updateKnowledge(k.id, updated)
    return {
      id: result.id,
      name: result.name || '',
      description: result.description || '',
      colour: result.colour || null,
      profile_image_ref: result.profile_image_ref || null,
      notes: result.notes || '',
      awareness_scale: result.awareness_scale || 'full',
    }
  }

  // ─── SCENE PATH (scene-anchored change write) ────────────────────────────
  const sceneNode = _resolveScene(at)

  // Reject origin-only fields at the scene anchor.
  for (const fieldName of ['notes', 'awareness_scale']) {
    if (args[fieldName] !== undefined) {
      throw new Error(
        `Field '${fieldName}' can only be set with at='origin' (or omitted) — ` +
        `it's not scene-tracked on the knowledge's history.`
      )
    }
  }

  // Build chain-entry additions for whichever fields the AI passed.
  // Each goes into the corresponding KnowledgeHistory list. We then
  // call updateKnowledge with the modified history (PUT replaces).
  const history = {
    name_changes: [...(k.history?.name_changes || [])],
    description_changes: [...(k.history?.description_changes || [])],
    colour_changes: [...(k.history?.colour_changes || [])],
    profile_image_changes: [...(k.history?.profile_image_changes || [])],
    source_event_changes: [...(k.history?.source_event_changes || [])],
    existence_changes: [...(k.history?.existence_changes || [])],
    awareness_changes: [...(k.history?.awareness_changes || [])],
  }
  let touched = false
  // Field-name note: the KnowledgeXChange models each use a type-
  // specific value field name (new_name / new_description / new_colour
  // / new_profile_image_ref) — NOT a generic `value` field. Earlier
  // code wrote `value: ...` here, which Pydantic stripped on save and
  // the walker silently ignored on read (since it looks up
  // `ch.new_name` etc), so chain entries existed but resolved to null.
  // The map below routes each list key to the matching field name so
  // the entry payload is shaped correctly per type.
  const VALUE_FIELD = {
    name_changes: 'new_name',
    description_changes: 'new_description',
    colour_changes: 'new_colour',
    profile_image_changes: 'new_profile_image_ref',
  }
  function _appendChainEntry(listKey, value) {
    // Per-node upsert: if an entry already exists for this node in
    // this list, replace it (matches the normalised-history rule
    // for scalar chain types).
    const existing = history[listKey]
    const idx = existing.findIndex((e) => e.node_id === sceneNode.id)
    const valueField = VALUE_FIELD[listKey]
    const newEntry = { id: crypto.randomUUID(), node_id: sceneNode.id, [valueField]: value }
    if (idx >= 0) existing[idx] = { ...existing[idx], ...newEntry }
    else existing.push(newEntry)
    touched = true
  }
  if (args.name !== undefined) {
    const trimmed = String(args.name).trim()
    if (!trimmed) throw new Error('name cannot be empty')
    _appendChainEntry('name_changes', trimmed)
  }
  if (args.description !== undefined) _appendChainEntry('description_changes', String(args.description))
  if (args.colour !== undefined) {
    _validateHexColour(args.colour, 'colour')
    _appendChainEntry('colour_changes', String(args.colour))
  }
  if (args.profile_image_ref !== undefined) {
    _appendChainEntry('profile_image_changes', args.profile_image_ref === '' ? null : String(args.profile_image_ref))
  }

  if (!touched) {
    throw new Error(
      'no scene-tracked field provided. At a scene anchor, you must ' +
      'pass at least one of: name, description, colour, profile_image_ref.'
    )
  }

  const updated = { ...k, history }
  const result = await useProjectStore.getState().updateKnowledge(k.id, updated)

  // Return the SCENE-RESOLVED projection (via the shared
  // `_projectKnowledgeAtScene` helper) so the response reflects the
  // chain entries we just recorded — not the unchanged baseline.
  // Same fix pattern as `update_relationship` (v0.2.1.134); shipped
  // alongside it because the same return-shape-lies bug existed on
  // both surfaces.
  return _projectKnowledgeAtScene(result, sceneNode)
})

// ── Wave 2: set_knowledge_awareness (origin OR scene) ───────────────────

registerMcpTool('set_knowledge_awareness', async (args) => {
  const k = _resolveKnowledge(args?.knowledge)
  const entriesArg = args?.entries
  const sourcesArg = args?.sources
  const hasEntries = Array.isArray(entriesArg) && entriesArg.length > 0
  const hasSources = Array.isArray(sourcesArg) && sourcesArg.length > 0
  if (!hasEntries && !hasSources) {
    throw new Error(
      'pass either `entries` (per-observer direct pins) or `sources` ' +
      '(per-relationship group projections), or both. ' +
      'entries item: { observer, level, at? }. ' +
      'sources item: { action, source_kind?, source, level?, at? } where ' +
      "action is 'add' | 'remove' | 'set_level'."
    )
  }
  // Compute the Knowledge's creation point once for pre-existence
  // validation below. A scene-anchored pin at a scene BEFORE the
  // Knowledge's creation anchor would be silently dropped by the
  // scene-resolved reader (the resolver correctly reports
  // `not_yet_exists: true` and discards the awareness map) — surfaced
  // 2026-05-18 by the freeform v7 blind-agent test as a silent-data-
  // loss bug (write succeeded, history showed the event, reads
  // dropped the pin). Reject at the boundary instead.
  const projectStoreSnapshot = useProjectStore.getState()
  const _kNodes = projectStoreSnapshot.nodes || []
  const _kEdges = projectStoreSnapshot.edges || []
  const _kStoryOrder = computeStoryOrder({ nodes: _kNodes, edges: _kEdges })
  const _kCreationPoint = resolveKnowledgeCreationPoint(k, _kNodes, _kEdges, _kStoryOrder)
  function _assertSceneOnOrAfterKnowledgeCreation(sceneNode, contextLabel) {
    if (!sceneNode) return
    if (_kCreationPoint.creationOrderIndex === -Infinity) return  // pre-story baseline; any scene is on-or-after
    if (!knowledgeExistsAtNode(k, sceneNode.id, _kNodes, _kEdges, _kStoryOrder)) {
      const orderIds = _kStoryOrder?.orderedIds || []
      const creationNode = _kNodes.find((n) => n.id === _kCreationPoint.creationNodeId)
      const creationLabel = creationNode?.data?.title
        ? `scene '${creationNode.data.title}'`
        : creationNode?.type === 'knowledgeOriginNode'
          ? 'its dedicated origin node'
          : `node id ${_kCreationPoint.creationNodeId}`
      const sceneLabel = sceneNode.data?.title || sceneNode.id
      const atIdx = orderIds.indexOf(sceneNode.id)
      const distance = (atIdx >= 0 && _kCreationPoint.creationOrderIndex >= 0)
        ? ` (target scene is ${_kCreationPoint.creationOrderIndex - atIdx} step(s) upstream of the creation point in story order)`
        : ''
      throw new Error(
        `${contextLabel}: knowledge '${k.name || k.id}' does not yet exist at scene '${sceneLabel}'${distance} — ` +
        `its creation anchor is ${creationLabel}. Awareness pins at scenes upstream of the creation anchor ` +
        `would be silently dropped by the scene-resolved reader (the knowledge resolves as not-yet-exists ` +
        `there). Pin at the creation scene or later; for "pre-story baseline awareness" use \`at='origin'\` ` +
        `or omit \`at\`.`
      )
    }
  }
  // Pre-validate every entry upfront — atomic batch. If item N has a
  // bad observer/level/scene ref, the call errors with
  // `entries[N]: ...` attribution and NO writes have landed.
  const validated = []
  for (let i = 0; i < (entriesArg || []).length; i++) {
    const e = entriesArg[i]
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      throw new Error(`entries[${i}] must be an object with { observer, level, at? } fields.`)
    }
    _requireAwarenessObserver(e, i)
    let observerEntity, level, sceneNode
    try {
      observerEntity = _resolveEntity(e.observer).entity
    } catch (err) {
      throw new Error(`entries[${i}].observer: ${err.message}`)
    }
    try {
      level = _resolveAwarenessLevel(e.level)
    } catch (err) {
      throw new Error(`entries[${i}].level: ${err.message}`)
    }
    const at = e.at
    const isOriginPath = !at || at === 'origin'
    if (!isOriginPath) {
      try {
        sceneNode = _resolveScene(at)
      } catch (err) {
        throw new Error(`entries[${i}].at: ${err.message}`)
      }
      _assertSceneOnOrAfterKnowledgeCreation(sceneNode, `entries[${i}].at`)
    }
    validated.push({ observerEntity, level, isOriginPath, sceneNode })
  }
  const validatedSources = _validateAwarenessSourceItems(sourcesArg)
  // Apply the same pre-existence guard to scene-anchored sources.
  for (let i = 0; i < validatedSources.length; i++) {
    const v = validatedSources[i]
    if (!v.isOriginPath) {
      _assertSceneOnOrAfterKnowledgeCreation(v.sceneNode, `sources[${i}].at`)
    }
  }
  // Per-entry commit. The store actions are idempotent at a given
  // anchor (same-observer-at-same-anchor overwrites cleanly), so
  // re-running an entry is safe — useful if the AI submits a batch
  // with duplicate (observer, at) pairs.
  const out = []
  const sourcesOut = []
  for (const v of validated) {
    if (v.isOriginPath) {
      useProjectStore.getState().setKnowledgeAwarenessOrigin(k.id, v.observerEntity.id, v.level)
      out.push({
        observer_id: v.observerEntity.id,
        scene_id: null,
        level: v.level,
        level_name: _levelName(v.level),
      })
    } else {
      useProjectStore.getState().setKnowledgeAwarenessAtNode(k.id, v.observerEntity.id, v.sceneNode.id, v.level)
      out.push({
        observer_id: v.observerEntity.id,
        scene_id: v.sceneNode.id,
        level: v.level,
        level_name: _levelName(v.level),
      })
    }
  }
  const target = { kind: 'knowledge', knowledgeId: k.id }
  for (const v of validatedSources) {
    const anchor = v.isOriginPath
      ? { kind: 'origin', nodeId: null }
      : { kind: 'chain', nodeId: v.sceneNode.id }
    // Knowledge prior-read: origin reads baseline awareness directly;
    // chain reads use the knowledge effective-state walker.
    let prior = null
    if (v.isOriginPath) {
      prior = k.awareness ?? null
    } else {
      const projectStore = useProjectStore.getState()
      const nodes = projectStore.nodes || []
      const edges = projectStore.edges || []
      const storyOrder = computeStoryOrder({ nodes, edges })
      const nodeOrder = getKnowledgeNodeOrder(k, nodes, edges, storyOrder)
      const eff = computeKnowledgeEffectiveState(k, nodeOrder, v.sceneNode.id, {
        nodes, ctx: { storyOrder },
      })
      prior = eff?.awareness ?? null
    }
    const draft = _buildAwarenessDraftWithSourceMutation(prior, v.action, v.source, v.level)
    await useProjectStore.getState().commitAwarenessAtAnchor({ target, anchor, draft })
    sourcesOut.push({
      action: v.action,
      source_kind: v.source.kind,
      source_id: v.source.relationship_id,
      source_name: v.source._resolvedName,
      level: v.level,
      level_name: _levelName(v.level),
      scene_id: v.isOriginPath ? null : anchor.nodeId,
    })
  }
  return { knowledge_id: k.id, entries: out, sources: sourcesOut }
})


// ── Wave 2: delete_entity (DESTRUCTIVE) ─────────────────────────────────
// Backend has already passed both gates (session-active + per-action
// destructive approval) before this handler runs — see
// `_proxy_destructive_tool` on the Python side. This handler's job
// is to resolve the entity reference (UUID or name/alias, same as
// read tools) and route the deletion through the project's
// centralized `deleteObject('entity', id)` dispatcher.
//
// `deleteObject` is the canonical scene-aware deletion path. It
// snapshots the pre-delete state for undo, strips every reference
// to the entity's id from EntityRef chains across all scenes, from
// other entities' attribute / parent_id / category_id fields, from
// every relationship's participant_changes / participant_roles /
// membership_of, from every knowledge's awareness, and from
// chapter / act memberships. Removes the origin EntityNode + every
// modifier EntityNode that referenced it. The MCP path uses the
// EXACT SAME deletion code as the user-driven "Delete entity"
// button — no shortcuts that could leave dangling references.

registerMcpTool('delete_entity', async (args) => {
  const { entity, type } = _resolveEntity(args?.entity)
  // Capture identity BEFORE the delete (so we can return it).
  const id = entity.id
  const name = entity.name || ''
  const resolvedType = type
  await useProjectStore.getState().deleteObject('entity', id)
  return { id, type: resolvedType, name }
})


// ── Wave 2: chapter / act CRUD + reads ──────────────────────────────────
//
// Phase 2.1 audit deliverable. Chapters and acts are first-class writer
// objects (the writer creates / renames / colours / arranges them in the
// canvas top header strip). Pre-this-cluster, the MCP surface could
// REFERENCE existing chapters via `update_scene(chapter=...)` /
// `create_scene(chapter=...)` but couldn't MINT new ones — the AI had to
// stop and ask the user to create chapters in the UI before any
// chapter-aware operation could land. This cluster closes that gap.
//
// Design choices (settled with the user, see CHANGELOG entry):
//
//   - **No `update_chapter(act=...)`**. The data model is acts-own-
//     chapters (`act.chapter_ids[]` with a contiguity invariant). A
//     chapter doesn't have a single mutable "which act am I in" pointer
//     — its membership is implied by being in some act's chapter_ids.
//     Exposing `update_chapter(act=...)` would require implicit shuffles
//     (remove from old act, validate adjacency to new act, etc) that
//     leak modeling complexity to the AI. Cleaner answer: act membership
//     is set explicitly via `update_act(act, chapters=[...])` — the AI
//     passes the full chapter list it wants the act to span; the server
//     validates contiguity and errors clearly if it can't grant it.
//
//   - **Create requires at least one chapter for acts; create_chapter
//     takes only an optional title.** Acts can't exist without chapters
//     per the model (empty acts get pruned by various flows). Chapters
//     are standalone objects with their own width / colour / title.
//
//   - **Width is NOT exposed.** Chapter widths are UI layout concerns,
//     not narrative goals. The AI never sets pixel widths; the
//     `reorganize_canvas` tool widens chapters as needed when scenes
//     pack into them. Default width comes from `addChapter`.
//
//   - **Reject + cascade for `update_act(chapters=[])`.** An empty
//     chapter list would naturally cascade to act deletion (via the
//     same `chapter_ids.length > 0` filter `deleteChapter` uses). To
//     prevent accidental act deletion via update, this errors with
//     "use delete_act instead".
//
// Frontend handler responsibilities: resolve refs, validate contiguity
// for act chapter lists, route through canonical store actions
// (`addChapter`, `renameChapter`, `setChapterColour`, `deleteChapter`,
// `addAct`, `renameAct`, `setActColour`, `setActRange`, `deleteAct`),
// return canonical projections.

/** Project a chapter for MCP return shapes. Includes the placeholder
 *  display title (`"Chapter N"`) for unnamed chapters since that's how
 *  the writer sees them in the UI — keeps the AI's mental model
 *  aligned with the writer's. */
function _projectChapter(chapter, idx, story) {
  const chapters = story?.chapters || []
  const acts = story?.acts || []
  const resolvedIdx = (typeof idx === 'number') ? idx : chapters.findIndex((c) => c.id === chapter.id)
  const containingAct = acts.find((a) => (a.chapter_ids || []).includes(chapter.id)) || null
  return {
    id: chapter.id,
    title: chapter.title || '',
    display_title: chapter.title || `Chapter ${resolvedIdx + 1}`,
    colour: chapter.colour || null,
    index: resolvedIdx,
    width: chapter.width || 0,
    act_id: containingAct?.id || null,
    act_title: containingAct?.title || null,
  }
}

/** Project an act for MCP return shapes. */
function _projectAct(act, story) {
  const chapters = story?.chapters || []
  const chapterById = new Map(chapters.map((c, i) => [c.id, { c, i }]))
  const orderedChapterIds = (act.chapter_ids || [])
    .map((id) => chapterById.get(id))
    .filter(Boolean)
    .sort((a, b) => a.i - b.i)
    .map((p) => p.c.id)
  const orderedChapterTitles = orderedChapterIds.map((id) => {
    const pair = chapterById.get(id)
    return pair?.c?.title || `Chapter ${(pair?.i ?? 0) + 1}`
  })
  return {
    id: act.id,
    title: act.title || '',
    display_title: act.title || 'Untitled act',
    colour: act.colour || null,
    chapter_ids: orderedChapterIds,
    chapter_titles: orderedChapterTitles,
  }
}

/** Validate that a chapter-id list forms a strictly contiguous run in
 *  the chapters[] order. Resolves each ref through _resolveChapter
 *  first, then walks chapters[] indices for contiguity. Returns
 *  `{ chapterIds, leftId, rightId }` on success. Throws a clear error
 *  on duplicates, missing references, or non-contiguity — used by
 *  create_act and update_act's `chapters` arg. */
function _resolveAndValidateContiguousChapters(chapterRefs) {
  if (!Array.isArray(chapterRefs) || chapterRefs.length === 0) {
    throw new Error(
      'chapters must be a non-empty array of chapter references (UUID or exact title). ' +
      'Acts must span at least one chapter.'
    )
  }
  const chapters = useProjectStore.getState().story?.chapters || []
  const indexById = new Map(chapters.map((c, i) => [c.id, i]))
  const seen = new Set()
  const resolved = []
  for (const ref of chapterRefs) {
    const chapter = _resolveChapter(ref) // throws on not-found / ambiguous
    if (seen.has(chapter.id)) {
      throw new Error(
        `duplicate chapter in list: "${ref}" (id=${chapter.id}). ` +
        'Each chapter may appear at most once.'
      )
    }
    seen.add(chapter.id)
    resolved.push(chapter)
  }
  // Sort by chapters[] order so the AI doesn't have to pass them in
  // canvas order — passing ['B', 'A', 'C'] is fine as long as A/B/C
  // are contiguous when sorted into canvas order.
  resolved.sort((a, b) => indexById.get(a.id) - indexById.get(b.id))
  const indices = resolved.map((c) => indexById.get(c.id))
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] !== indices[i - 1] + 1) {
      const titles = resolved.map((c, idx) => c.title || `Chapter ${indices[idx] + 1}`)
      throw new Error(
        `chapters must be contiguous in canvas order. Got ${titles.join(', ')} ` +
        `at indices ${indices.join(', ')}, which has a gap. Acts span a single ` +
        'contiguous run of chapters; reorder chapters in the UI first or pick a ' +
        'contiguous subset.'
      )
    }
  }
  return {
    chapterIds: resolved.map((c) => c.id),
    leftId: resolved[0].id,
    rightId: resolved[resolved.length - 1].id,
  }
}

// ── Chapter CRUD + reads ─────────────────────────────────────────────────

registerMcpTool('list_chapters', () => {
  const story = useProjectStore.getState().story || {}
  const chapters = (story.chapters || []).map((c, idx) => _projectChapter(c, idx, story))
  return { chapters }
})

registerMcpTool('get_chapter', (args) => {
  const chapter = _resolveChapter(args?.chapter)
  const story = useProjectStore.getState().story || {}
  return _projectChapter(chapter, undefined, story)
})

registerMcpTool('create_chapter', async (args) => {
  const titleArg = args?.title
  const beforeArg = args?.before
  const afterArg = args?.after
  if (titleArg != null && typeof titleArg !== 'string') {
    throw new Error('title, if provided, must be a string')
  }
  if (beforeArg != null && afterArg != null) {
    throw new Error(
      'create_chapter accepts at most one of `before` or `after` — they ' +
      'are mutually exclusive insertion-position args. Omit both to ' +
      'append to the end of the chapter strip.'
    )
  }

  // Resolve insertion position if a positional ref was given. Both
  // `before` and `after` accept the same reference shape `_resolveChapter`
  // takes (UUID / exact title / "Chapter N" placeholder).
  let insertIndex = null
  if (beforeArg != null) {
    const target = _resolveChapter(beforeArg)
    const chapters = useProjectStore.getState().story?.chapters || []
    insertIndex = chapters.findIndex((c) => c.id === target.id)
    if (insertIndex < 0) {
      // _resolveChapter already verified existence — defensive check.
      throw new Error(`failed to locate chapter "${beforeArg}" in chapters[]`)
    }
  } else if (afterArg != null) {
    const target = _resolveChapter(afterArg)
    const chapters = useProjectStore.getState().story?.chapters || []
    const targetIdx = chapters.findIndex((c) => c.id === target.id)
    if (targetIdx < 0) {
      throw new Error(`failed to locate chapter "${afterArg}" in chapters[]`)
    }
    insertIndex = targetIdx + 1
  }

  let id
  if (insertIndex == null) {
    // No positional ref → append (existing behaviour). Plus optional
    // post-rename for the title, same shape as before.
    id = useProjectStore.getState().addChapter()
    if (!id) throw new Error('failed to create chapter (no story loaded)')
    if (typeof titleArg === 'string' && titleArg.length > 0) {
      useProjectStore.getState().renameChapter(id, titleArg)
    }
  } else {
    // Insert at the resolved position. The canonical `insertChapterAt`
    // store action handles canvas-node shifting (centre-x rule preserves
    // chapter membership of every existing node) AND act-membership
    // expansion (any act whose old span strictly straddles the insertion
    // point grows by one to include the new chapter). Title is applied
    // by the store action directly to avoid an extra renameChapter step
    // / second undo entry.
    id = useProjectStore.getState().insertChapterAt(insertIndex, {
      title: typeof titleArg === 'string' ? titleArg : '',
    })
    if (!id) throw new Error('failed to insert chapter (no story loaded)')
  }

  const story = useProjectStore.getState().story || {}
  const chapters = story.chapters || []
  const idx = chapters.findIndex((c) => c.id === id)
  const created = chapters[idx]
  return _projectChapter(created, idx, story)
})

registerMcpTool('update_chapter', async (args) => {
  const chapter = _resolveChapter(args?.chapter)
  const hasTitle = Object.prototype.hasOwnProperty.call(args || {}, 'title')
  const hasColour = Object.prototype.hasOwnProperty.call(args || {}, 'colour')
  if (!hasTitle && !hasColour) {
    throw new Error('update_chapter requires at least one of: title, colour')
  }
  if (hasTitle && args.title != null && typeof args.title !== 'string') {
    throw new Error('title must be a string or null')
  }
  if (hasColour && args.colour != null) _validateHexColour(args.colour, 'colour')
  // Atomic title + colour set when both are passed so one MCP call =
  // one undo step.
  if (hasTitle && hasColour) {
    useProjectStore.getState().setChapterTitleAndColour(
      chapter.id,
      args.title ?? '',
      args.colour ?? null,
    )
  } else if (hasTitle) {
    useProjectStore.getState().renameChapter(chapter.id, args.title ?? '')
  } else if (hasColour) {
    useProjectStore.getState().setChapterColour(chapter.id, args.colour ?? null)
  }
  const story = useProjectStore.getState().story || {}
  const chapters = story.chapters || []
  const idx = chapters.findIndex((c) => c.id === chapter.id)
  return _projectChapter(chapters[idx], idx, story)
})

registerMcpTool('delete_chapter', async (args) => {
  const chapter = _resolveChapter(args?.chapter)
  const story = useProjectStore.getState().story || {}
  const chapters = story.chapters || []
  const idx = chapters.findIndex((c) => c.id === chapter.id)
  const id = chapter.id
  const title = chapter.title || ''
  const displayTitle = chapter.title || `Chapter ${idx + 1}`
  useProjectStore.getState().deleteChapter(id)
  return { id, title, display_title: displayTitle }
})

// ── Act CRUD + reads ─────────────────────────────────────────────────────

registerMcpTool('list_acts', () => {
  const story = useProjectStore.getState().story || {}
  const acts = (story.acts || []).map((a) => _projectAct(a, story))
  return { acts }
})

registerMcpTool('get_act', (args) => {
  const act = _resolveAct(args?.act)
  const story = useProjectStore.getState().story || {}
  return _projectAct(act, story)
})

registerMcpTool('create_act', async (args) => {
  const { chapterIds } = _resolveAndValidateContiguousChapters(args?.chapters)
  const titleArg = args?.title
  const colourArg = args?.colour
  if (titleArg != null && typeof titleArg !== 'string') {
    throw new Error('title, if provided, must be a string')
  }
  if (colourArg != null) _validateHexColour(colourArg, 'colour')
  const id = useProjectStore.getState().addAct(chapterIds)
  if (!id) {
    // addAct returns null when no contiguous run could be formed —
    // shouldn't fire after _resolveAndValidateContiguousChapters
    // passed, but defensive guard for any future internal pruning.
    throw new Error('failed to create act (no valid contiguous chapter run after pruning)')
  }
  const hasTitle = typeof titleArg === 'string' && titleArg.length > 0
  const hasColour = typeof colourArg === 'string' && colourArg.length > 0
  if (hasTitle && hasColour) {
    useProjectStore.getState().setActTitleAndColour(id, titleArg, colourArg)
  } else if (hasTitle) {
    useProjectStore.getState().renameAct(id, titleArg)
  } else if (hasColour) {
    useProjectStore.getState().setActColour(id, colourArg)
  }
  const story = useProjectStore.getState().story || {}
  const acts = story.acts || []
  const created = acts.find((a) => a.id === id)
  return _projectAct(created, story)
})

registerMcpTool('update_act', async (args) => {
  const act = _resolveAct(args?.act)
  const hasTitle = Object.prototype.hasOwnProperty.call(args || {}, 'title')
  const hasColour = Object.prototype.hasOwnProperty.call(args || {}, 'colour')
  const hasChapters = Object.prototype.hasOwnProperty.call(args || {}, 'chapters')
  if (!hasTitle && !hasColour && !hasChapters) {
    throw new Error('update_act requires at least one of: title, colour, chapters')
  }
  if (hasTitle && args.title != null && typeof args.title !== 'string') {
    throw new Error('title must be a string or null')
  }
  if (hasColour && args.colour != null) _validateHexColour(args.colour, 'colour')
  if (hasChapters) {
    if (Array.isArray(args.chapters) && args.chapters.length === 0) {
      throw new Error(
        'update_act chapters list cannot be empty — that would cascade to ' +
        'act deletion. Use delete_act to remove an act explicitly.'
      )
    }
    const { leftId, rightId } = _resolveAndValidateContiguousChapters(args.chapters)
    useProjectStore.getState().setActRange(act.id, leftId, rightId)
  }
  // Title + colour applied after chapters so any single-snapshot atomicity
  // sits on the title/colour pair if both are passed. Each call is its
  // own snapshot today; for now we accept multi-step undo if all three
  // fields are passed together. (Future enhancement: bundle into one
  // _snapshot via a new canonical action if writers ask for it.)
  if (hasTitle && hasColour) {
    useProjectStore.getState().setActTitleAndColour(
      act.id,
      args.title ?? '',
      args.colour ?? null,
    )
  } else if (hasTitle) {
    useProjectStore.getState().renameAct(act.id, args.title ?? '')
  } else if (hasColour) {
    useProjectStore.getState().setActColour(act.id, args.colour ?? null)
  }
  const story = useProjectStore.getState().story || {}
  const acts = story.acts || []
  const updated = acts.find((a) => a.id === act.id)
  if (!updated) {
    // Shouldn't fire — but if a downstream invariant somehow stripped
    // the act mid-update, surface that explicitly.
    throw new Error(`act ${act.id} no longer exists after update`)
  }
  return _projectAct(updated, story)
})

registerMcpTool('delete_act', async (args) => {
  const act = _resolveAct(args?.act)
  const id = act.id
  const title = act.title || ''
  const displayTitle = act.title || 'Untitled act'
  useProjectStore.getState().deleteAct(id)
  return { id, title, display_title: displayTitle }
})


// ── Preset list CRUD + reads ────────────────────────────────────────────
//
// Preset lists are story-level named value-sets (e.g. a "Genders" list
// of ["Female", "Male", "Other"]) that preset-type attributes pick
// from. Story seeds also reference them by name when seeding preset-
// type attributes onto newly-created entities. Pre-this-cluster the
// MCP surface could REFERENCE existing preset lists via
// `update_attribute(preset_list=...)` but couldn't mint new ones —
// the AI had to ask the user to create lists in the UI before any
// preset-using flow could land. These tools close that gap and
// unblock the seed CRUD cluster below (which references preset lists
// by name).
//
// Implementation routes through the canonical `entitiesStore`
// preset-list actions (`createPresetList` / `updatePresetList` /
// `deletePresetList`), which:
//   - persist to backend via `axios.post|put|delete('/api/preset-lists/...')`,
//   - keep `entitiesStore.presetLists` in sync,
//   - re-link orphaned preset attributes on create (matching saved
//     `preset_list_name`),
//   - strip preset_list_id refs from entity attributes + relationship
//     participant roles on delete (preserves the last value as
//     free-form text).
// All the cross-reference housekeeping is shared with the UI flow.

registerMcpTool('list_preset_lists', () => {
  // Same source-priority as `_resolvePresetList`: live entitiesStore
  // first (reflects in-session mutations), story.preset_lists as
  // defensive fallback.
  const lists = useEntitiesStore.getState().presetLists
    ?? useProjectStore.getState().story?.preset_lists ?? []
  const preset_lists = lists.map(_projectPresetList)
  return { preset_lists }
})

registerMcpTool('get_preset_list', (args) => {
  const list = _resolvePresetList(args?.preset_list)
  return _projectPresetList(list)
})

registerMcpTool('create_preset_list', async (args) => {
  const name = (args?.name || '').trim()
  if (!name) throw new Error('name is required')
  // Reject duplicate name up front — both `_resolvePresetList` and
  // the seed model identify preset lists by name, so duplicates would
  // make those references ambiguous.
  const existing = useEntitiesStore.getState().presetLists
    ?? useProjectStore.getState().story?.preset_lists ?? []
  const nameLower = name.toLowerCase()
  const collision = existing.find((l) => (l.name || '').toLowerCase() === nameLower)
  if (collision) {
    // Include the existing list's values + id in the error so an MCP
    // client can decide whether to reuse it as-is, append values via
    // update_preset_list, or pick a different name — without a follow-
    // up get_preset_list round trip.
    const existingValues = Array.isArray(collision.values) ? collision.values : []
    const valuesPreview = existingValues.length
      ? existingValues.map((v) => `"${v}"`).join(', ')
      : '(empty list)'
    throw new Error(
      `preset_list with name "${name}" already exists with values [${valuesPreview}] ` +
      `(id=${collision.id}). Names are case-insensitive; either reuse the existing list, ` +
      `call update_preset_list(preset_list="${name}", values=[...]) to extend it, ` +
      `or pick a different name.`
    )
  }
  const values = Array.isArray(args?.values) ? args.values.map(String) : []
  const created = await useEntitiesStore.getState().createPresetList({ name, values })
  return _projectPresetList(created)
})

registerMcpTool('update_preset_list', async (args) => {
  const list = _resolvePresetList(args?.preset_list)
  const hasName = Object.prototype.hasOwnProperty.call(args || {}, 'name')
  const hasValues = Object.prototype.hasOwnProperty.call(args || {}, 'values')
  if (!hasName && !hasValues) {
    throw new Error('update_preset_list requires at least one of: name, values')
  }
  const updated = { ...list }
  if (hasName) {
    const newName = String(args.name || '').trim()
    if (!newName) throw new Error('name cannot be empty')
    // Reject rename collision against any OTHER list.
    const newNameLower = newName.toLowerCase()
    const others = (useEntitiesStore.getState().presetLists
      ?? useProjectStore.getState().story?.preset_lists ?? [])
      .filter((l) => l.id !== list.id)
    if (others.some((l) => (l.name || '').toLowerCase() === newNameLower)) {
      throw new Error(
        `preset_list with name "${newName}" already exists (case-` +
        `insensitive). Pick a unique name.`
      )
    }
    updated.name = newName
  }
  if (hasValues) {
    if (!Array.isArray(args.values)) {
      throw new Error('values must be an array of strings')
    }
    updated.values = args.values.map(String)
  }
  const result = await useEntitiesStore.getState().updatePresetList(list.id, updated)
  return _projectPresetList(result)
})

registerMcpTool('delete_preset_list', async (args) => {
  const list = _resolvePresetList(args?.preset_list)
  const id = list.id
  const name = list.name || ''
  // Routes through entitiesStore.deletePresetList which DELETEs via
  // REST AND strips refs from entity attributes + relationship
  // participant roles (preserves the last value as free-form text).
  await useEntitiesStore.getState().deletePresetList(id)
  return { id, name }
})


// ── Project Tag reads (Phase 3.4g Line 1) ───────────────────────────────
//
// Read-side surface for the single-pool tag system. Pool CRUD
// (create / update / delete) and host attach / detach land in
// subsequent ToDo lines. See `_resolveTag` / `_projectTag` above for
// the resolver + projector pair this section consumes.

registerMcpTool('list_tags', () => {
  // Same source-priority as `_resolveTag`: live entitiesStore first
  // (reflects in-session mutations), story.project_tags as defensive
  // fallback.
  const pool = useEntitiesStore.getState().projectTags
    ?? useProjectStore.getState().story?.project_tags ?? []
  const tags = pool.map(_projectTag)
  return { tags }
})

registerMcpTool('get_tag', (args) => {
  const tag = _resolveTag(args?.tag)
  return _projectTag(tag)
})


// ── Project Tag pool CRUD (Phase 3.4g Line 2) ───────────────────────────
//
// Create / update / delete on the project tag pool. `create_tag` also
// supports an optional `attach_to` list for batch origin-attach to
// chain-trackable hosts (entity / knowledge / relationship /
// referenceNode). Pool-level update and delete propagate to every host
// via id reference (no host walk needed for update; cascade-strip on
// delete).

registerMcpTool('create_tag', async (args) => {
  // Name normalisation: strip leading `#` (mirrors the frontend
  // `ProjectTagPicker` find-or-create behaviour); reject if empty.
  const rawName = String(args?.name ?? '').replace(/^#+/, '').trim()
  if (!rawName) throw new Error('name is required (non-empty after stripping leading "#" and trimming)')
  const color = (typeof args?.color === 'string' && args.color.trim()) ? args.color.trim() : '#888888'

  // Detect find-or-create vs fresh-create: probe the pool BEFORE
  // the POST so we can populate the `created` flag honestly. The
  // backend's case-insensitive uniqueness guarantee means a pool
  // match here = the POST will return the existing entry.
  const poolBefore = useEntitiesStore.getState().projectTags
    ?? useProjectStore.getState().story?.project_tags ?? []
  const nameLower = rawName.toLowerCase()
  const preExisting = poolBefore.find((t) => (t.name || '').toLowerCase() === nameLower)

  // Validate `attach_to` upfront before any write commits. Per-item
  // polymorphic: bare string OR `{ kind, ref }`. Resolution errors
  // attribute back to the bad item via `attach_to[N]: ...`.
  const attachToInput = args?.attach_to
  let resolvedHosts = []
  if (attachToInput != null) {
    if (!Array.isArray(attachToInput)) {
      throw new Error('attach_to must be a list (omit or pass [] for no attach)')
    }
    for (let i = 0; i < attachToInput.length; i += 1) {
      const item = attachToInput[i]
      let ref = null
      if (typeof item === 'string') {
        ref = item
      } else if (item && typeof item === 'object' && typeof item.ref === 'string') {
        // `kind` is currently advisory — the resolver scans all pools
        // regardless. When supplied, we cross-check the resolved kind
        // matches; mismatches error attributing the bad item.
        ref = item.ref
      } else {
        throw new Error(`attach_to[${i}]: each item must be a string (UUID or name) or an object {kind, ref}`)
      }
      let host
      try {
        host = _resolveHostForTag(ref)
      } catch (e) {
        throw new Error(`attach_to[${i}]: ${e.message}`)
      }
      if (item && typeof item === 'object' && typeof item.kind === 'string' && item.kind !== host.kind) {
        throw new Error(`attach_to[${i}]: resolved kind "${host.kind}" does not match requested kind "${item.kind}"`)
      }
      resolvedHosts.push(host)
    }
  }

  // Mint (or find existing) — backend POST returns the existing
  // entry on case-insensitive collision, so this is idempotent.
  const tag = await useEntitiesStore.getState().createProjectTag({ name: rawName, color })
  const created = !preExisting

  // Origin-attach to every resolved host, building the per-host
  // already_attached report.
  const attached_to = []
  for (const host of resolvedHosts) {
    const { already_attached } = await _attachTagToHostAtOrigin(host, tag.id)
    attached_to.push({
      host_id: host.id,
      host_kind: host.kind,
      host_name: host.name,
      already_attached,
    })
  }

  const result = {
    tag: { ..._projectTag(tag), created },
  }
  if (resolvedHosts.length > 0) result.attached_to = attached_to
  return result
})

registerMcpTool('update_tag', async (args) => {
  const tag = _resolveTag(args?.tag)
  const hasName = Object.prototype.hasOwnProperty.call(args || {}, 'name')
  const hasColor = Object.prototype.hasOwnProperty.call(args || {}, 'color')
  if (!hasName && !hasColor) {
    throw new Error('update_tag requires at least one of: name, color')
  }
  const patch = {}
  if (hasName) {
    const stripped = String(args.name ?? '').replace(/^#+/, '').trim()
    if (!stripped) throw new Error('name must be non-empty after stripping leading "#" and trimming')
    // Re-check case-insensitive uniqueness against OTHER pool entries
    // up front so we surface the collision with a clear message before
    // the backend PUT errors with a generic 409.
    const lower = stripped.toLowerCase()
    const pool = useEntitiesStore.getState().projectTags
      ?? useProjectStore.getState().story?.project_tags ?? []
    const collision = pool.find((t) => t.id !== tag.id && (t.name || '').toLowerCase() === lower)
    if (collision) {
      throw new Error(
        `tag with name "${stripped}" already exists (id=${collision.id}). ` +
        `Names are case-insensitive; pick a different name or delete the ` +
        `existing tag first.`
      )
    }
    patch.name = stripped
  }
  if (hasColor) {
    if (typeof args.color !== 'string' || !args.color.trim()) {
      throw new Error('color must be a non-empty hex string (e.g. "#ff8800")')
    }
    patch.color = args.color.trim()
  }
  const updated = await useEntitiesStore.getState().updateProjectTag(tag.id, patch)
  const affected_host_count = _collectAffectedHostsForTag(tag.id).length
  return { ..._projectTag(updated), affected_host_count }
})

const _DELETE_TAG_AFFECTED_SAMPLE_CAP = 10
registerMcpTool('delete_tag', async (args) => {
  const tag = _resolveTag(args?.tag)
  const id = tag.id
  const name = tag.name || ''
  // Snapshot the affected-host list BEFORE the delete so the return
  // payload can show what was about to be (and now has been)
  // stripped. The dispatcher's pre-action _snapshot also captures
  // the same info for undo purposes; this is purely for the return.
  const allAffected = _collectAffectedHostsForTag(id)
  const affected_hosts = allAffected.slice(0, _DELETE_TAG_AFFECTED_SAMPLE_CAP)
  const truncated = allAffected.length > _DELETE_TAG_AFFECTED_SAMPLE_CAP
  // Route through the canonical deleteObject dispatcher (cascade-
  // strips baseline + chain events across every host, snapshots for
  // undo).
  await useProjectStore.getState().deleteObject('projectTag', id)
  const result = {
    id,
    name,
    affected_host_count: allAffected.length,
    affected_hosts,
  }
  if (truncated) {
    result.affected_hosts_truncated = true
    result.affected_hosts_total = allAffected.length
  }
  return result
})


// ── Project Tag host attach / detach (Phase 3.4g Line 3) ────────────────
//
// `add_tags(host, tags[], at?)` / `remove_tags(host, tags[], at?)`
// mirror the alias batch shape: polymorphic per-item, optional
// chain-anchor routing, pre-validation upfront with `tags[N]: ...`
// attribution, idempotent on already-attached / was-not-attached.
// Both reuse `_attachTagToHost` / `_detachTagFromHost` so the
// per-host record-action dispatch lives in one place.

/** Resolve a tags batch arg into `[{ id, name, color, created }, ...]`
 *  per item, preserving input order.
 *
 *  Per-item polymorphism (mirrors `add_aliases`):
 *    - bare string → tag name (`#`-stripped, trimmed); find-or-create
 *      lookup against the pool.
 *    - `{ id: <uuid> }` → existing tag fetched via `_resolveTag`.
 *    - `{ name: <string>, color?: <hex> }` → find-or-create with
 *      explicit colour when minting a new entry; ignored when the
 *      name resolves to an existing entry (the existing colour is
 *      preserved).
 *
 *  Pre-validation:
 *    - Empty / whitespace-only names rejected.
 *    - Within-batch duplicates (by resolved-or-normalised id) rejected.
 *    - Item shape errors attribute back to `tags[N]: ...`.
 *
 *  Find-or-create vs strict mode:
 *    - `allowFindOrCreate=true`: unknown names mint a new pool entry
 *      with the supplied color (or default `#888888`). Used by
 *      `add_tags`.
 *    - `allowFindOrCreate=false`: unknown names reject with
 *      "tag not found". Used by `remove_tags` — you can't detach a
 *      tag that doesn't exist.
 *
 *  Returns `[{ id, name, color, created }, ...]` where `created` is
 *  `true` only when this call minted the pool entry (false for
 *  pre-existing).
 */
async function _resolveTagBatch(tagsArg, allowFindOrCreate) {
  if (!Array.isArray(tagsArg) || tagsArg.length === 0) {
    throw new Error('tags must be a non-empty array (use a one-element list for the single-tag case)')
  }
  const pool = useEntitiesStore.getState().projectTags
    ?? useProjectStore.getState().story?.project_tags ?? []
  const poolById = new Map(pool.map((t) => [t.id, t]))
  const poolByNameLower = new Map(pool.map((t) => [(t.name || '').toLowerCase(), t]))

  // First pass: classify each item, validate shape, collect identity
  // info for within-batch dedup. Defer all writes (mints) to a second
  // pass so a bad item rejects the WHOLE batch atomically.
  const classified = []  // [{ kind: 'existing'|'mint', tag?, mintName?, mintColor? }, ...]
  const seenIds = new Set()
  const seenNamesLower = new Set()

  for (let i = 0; i < tagsArg.length; i += 1) {
    const raw = tagsArg[i]
    if (typeof raw === 'string') {
      const stripped = raw.replace(/^#+/, '').trim()
      if (!stripped) throw new Error(`tags[${i}] is empty after stripping leading "#" and trimming`)
      const existing = poolByNameLower.get(stripped.toLowerCase())
      if (existing) {
        if (seenIds.has(existing.id)) throw new Error(`tags[${i}]: duplicate of an earlier item in this batch (resolves to "${existing.name}")`)
        seenIds.add(existing.id)
        classified.push({ kind: 'existing', tag: existing })
      } else {
        if (!allowFindOrCreate) {
          throw new Error(`tags[${i}]: tag not found: "${raw}". Pass an existing UUID or name. Call create_tag(name=...) to mint a new one first.`)
        }
        const nameLower = stripped.toLowerCase()
        if (seenNamesLower.has(nameLower)) throw new Error(`tags[${i}]: duplicate of an earlier new tag name in this batch ("${stripped}")`)
        seenNamesLower.add(nameLower)
        classified.push({ kind: 'mint', mintName: stripped, mintColor: '#888888' })
      }
      continue
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      if (typeof raw.id === 'string') {
        const existing = poolById.get(raw.id)
        if (!existing) throw new Error(`tags[${i}]: tag id "${raw.id}" not found in the pool`)
        if (seenIds.has(existing.id)) throw new Error(`tags[${i}]: duplicate of an earlier item in this batch (resolves to "${existing.name}")`)
        seenIds.add(existing.id)
        classified.push({ kind: 'existing', tag: existing })
        continue
      }
      if (typeof raw.name === 'string') {
        const stripped = raw.name.replace(/^#+/, '').trim()
        if (!stripped) throw new Error(`tags[${i}].name is empty after stripping leading "#" and trimming`)
        const existing = poolByNameLower.get(stripped.toLowerCase())
        if (existing) {
          if (seenIds.has(existing.id)) throw new Error(`tags[${i}]: duplicate of an earlier item in this batch (resolves to "${existing.name}")`)
          seenIds.add(existing.id)
          classified.push({ kind: 'existing', tag: existing })
          continue
        }
        if (!allowFindOrCreate) {
          throw new Error(`tags[${i}]: tag not found: "${raw.name}". Pass an existing id/name or call create_tag(name=...) to mint a new one first.`)
        }
        const color = (typeof raw.color === 'string' && raw.color.trim()) ? raw.color.trim() : '#888888'
        const nameLower = stripped.toLowerCase()
        if (seenNamesLower.has(nameLower)) throw new Error(`tags[${i}]: duplicate of an earlier new tag name in this batch ("${stripped}")`)
        seenNamesLower.add(nameLower)
        classified.push({ kind: 'mint', mintName: stripped, mintColor: color })
        continue
      }
      throw new Error(`tags[${i}]: object form requires either { id } or { name, color? }`)
    }
    throw new Error(`tags[${i}] must be a string (UUID or name) or an object ({ id } or { name, color? })`)
  }

  // Second pass: mint the new pool entries (idempotent under
  // case-insensitive collision per the backend's find-or-create
  // semantics). Sequential POSTs — one per new name.
  const resolved = []
  for (const c of classified) {
    if (c.kind === 'existing') {
      resolved.push({ id: c.tag.id, name: c.tag.name || '', color: c.tag.color || '#888888', created: false })
    } else {
      const minted = await useEntitiesStore.getState().createProjectTag({ name: c.mintName, color: c.mintColor })
      resolved.push({ id: minted.id, name: minted.name || '', color: minted.color || '#888888', created: true })
    }
  }
  return resolved
}

registerMcpTool('add_tags', async (args) => {
  // Resolve host upfront (UUID or name across all chain-trackable
  // host pools; ambiguity-errored).
  const host = _resolveHostForTag(args?.host)

  // Resolve `at` upfront. null/'origin' → baseline; otherwise resolve
  // a scene reference (UUID or title) to a node id. Reference Nodes
  // reject `at` since they're baseline-only.
  const at = args?.at
  const isOriginPath = !at || at === 'origin'
  let atNodeId = null
  if (!isOriginPath) {
    if (host.kind === 'referenceNode') {
      throw new Error(
        `Reference Nodes are baseline-only — drop the \`at\` arg, or address ` +
        `this host by another kind if you need chain-anchor writes.`
      )
    }
    const sceneNode = _resolveScene(at)
    atNodeId = sceneNode.id
  }

  // Resolve the tag batch (find-or-create on names). Pre-validates
  // shape + within-batch dedup; throws cleanly before any tag mint
  // OR host write commits.
  const resolvedTags = await _resolveTagBatch(args?.tags, /* allowFindOrCreate */ true)

  // Per-tag attach. Tracks `already_attached` for the canonical
  // projection return.
  const results = []
  for (const t of resolvedTags) {
    const { already_attached } = await _attachTagToHost(host, t.id, atNodeId)
    results.push({ id: t.id, name: t.name, color: t.color, created: t.created, already_attached })
  }

  const result = {
    host_id: host.id,
    host_kind: host.kind,
    host_name: host.name,
    tags: results,
  }
  if (atNodeId) {
    const sceneNode = useProjectStore.getState().nodes.find((n) => n.id === atNodeId)
    result.scene_id = atNodeId
    result.scene_title = sceneNode?.data?.title || ''
    result.chain_actions = results.map((r) => r.already_attached ? 'noop' : 'add')
  }
  return result
})

registerMcpTool('remove_tags', async (args) => {
  const host = _resolveHostForTag(args?.host)
  const at = args?.at
  const isOriginPath = !at || at === 'origin'
  let atNodeId = null
  if (!isOriginPath) {
    if (host.kind === 'referenceNode') {
      throw new Error(
        `Reference Nodes are baseline-only — drop the \`at\` arg, or address ` +
        `this host by another kind if you need chain-anchor writes.`
      )
    }
    const sceneNode = _resolveScene(at)
    atNodeId = sceneNode.id
  }

  // remove_tags uses strict resolution (allowFindOrCreate=false) —
  // you can't detach a tag that doesn't exist in the pool.
  const resolvedTags = await _resolveTagBatch(args?.tags, /* allowFindOrCreate */ false)

  const results = []
  for (const t of resolvedTags) {
    const { was_attached, pool_deleted } = await _detachTagFromHost(host, t.id, atNodeId)
    const item = { id: t.id, name: t.name, color: t.color, was_attached }
    if (pool_deleted) item.pool_deleted = true
    results.push(item)
  }

  const result = {
    host_id: host.id,
    host_kind: host.kind,
    host_name: host.name,
    tags: results,
  }
  if (atNodeId) {
    const sceneNode = useProjectStore.getState().nodes.find((n) => n.id === atNodeId)
    result.scene_id = atNodeId
    result.scene_title = sceneNode?.data?.title || ''
    result.chain_actions = results.map((r) => r.was_attached ? 'remove' : 'noop')
  }
  return result
})


// ── Custom category CRUD + reads ────────────────────────────────────────
//
// Custom categories are fungible templates Custom entities belong to
// (e.g. a "Goblins" category for multiple goblin instances, or "Ancient
// Oak Trees" for tree instances). They're story-level configuration,
// not chain-tracked. Pre-this-cluster the MCP surface could REFERENCE
// existing categories via `create_entity(type='custom', category_id=...)`
// but couldn't MINT new ones — making Custom entities effectively
// unreachable from MCP unless the project already had categories
// created via the UI. These tools close that gap.
//
// Implementation routes through the canonical `entitiesStore` actions
// (`createCustomCategory` / `updateCustomCategory` / `deleteCustomCategory`)
// which persist to backend via `axios.post|put|delete('/api/custom-categories/...')`,
// keep `entitiesStore.customCategories` in sync, and (on delete) strip
// `category_id` refs from Custom entities that pointed to the deleted
// category. All cross-reference housekeeping is shared with the UI flow.

registerMcpTool('list_custom_categories', () => {
  const cats = useEntitiesStore.getState().customCategories || []
  return { custom_categories: cats.map(_projectCustomCategory) }
})

registerMcpTool('get_custom_category', (args) => {
  const cat = _resolveCustomCategory(args?.custom_category)
  return _projectCustomCategory(cat)
})

registerMcpTool('create_custom_category', async (args) => {
  const name = (args?.name || '').trim()
  if (!name) throw new Error('name is required')
  // Reject duplicate name up front — both `_resolveCustomCategory` and
  // the seed model identify categories by name, so duplicates would
  // make those references ambiguous.
  const existing = useEntitiesStore.getState().customCategories || []
  const nameLower = name.toLowerCase()
  if (existing.some((c) => (c.name || '').toLowerCase() === nameLower)) {
    throw new Error(
      `custom_category with name "${name}" already exists. Names are ` +
      `case-insensitive; pick a unique name.`
    )
  }
  const description = (args?.description != null) ? String(args.description) : ''
  const payload = { name, description }
  if (typeof args?.colour === 'string' && args.colour.trim()) payload.colour = args.colour.trim()
  if (typeof args?.profile_image_ref === 'string') payload.profile_image_ref = args.profile_image_ref || null
  const created = await useEntitiesStore.getState().createCustomCategory(payload)
  return _projectCustomCategory(created)
})

registerMcpTool('update_custom_category', async (args) => {
  const cat = _resolveCustomCategory(args?.custom_category)
  const hasName = Object.prototype.hasOwnProperty.call(args || {}, 'name')
  const hasDescription = Object.prototype.hasOwnProperty.call(args || {}, 'description')
  const hasColour = Object.prototype.hasOwnProperty.call(args || {}, 'colour')
  const hasImage = Object.prototype.hasOwnProperty.call(args || {}, 'profile_image_ref')
  if (!hasName && !hasDescription && !hasColour && !hasImage) {
    throw new Error('update_custom_category requires at least one of: name, description, colour, profile_image_ref')
  }
  const updated = { ...cat }
  if (hasName) {
    const newName = String(args.name || '').trim()
    if (!newName) throw new Error('name cannot be empty')
    // Reject rename collision against any OTHER category.
    const newNameLower = newName.toLowerCase()
    const others = (useEntitiesStore.getState().customCategories || [])
      .filter((c) => c.id !== cat.id)
    if (others.some((c) => (c.name || '').toLowerCase() === newNameLower)) {
      throw new Error(
        `custom_category with name "${newName}" already exists (case-` +
        `insensitive). Pick a unique name.`
      )
    }
    updated.name = newName
  }
  if (hasDescription) {
    updated.description = String(args.description ?? '')
  }
  if (hasColour) {
    // Empty string reverts to the default category tint (#888888), matching
    // the model default; a hex value is stored as-is.
    updated.colour = String(args.colour ?? '').trim() || '#888888'
  }
  if (hasImage) {
    // Empty string clears the category avatar.
    updated.profile_image_ref = args.profile_image_ref || null
  }
  const result = await useEntitiesStore.getState().updateCustomCategory(cat.id, updated)
  return _projectCustomCategory(result)
})

registerMcpTool('delete_custom_category', async (args) => {
  const cat = _resolveCustomCategory(args?.custom_category)
  const id = cat.id
  const name = cat.name || ''
  // Routes through entitiesStore.deleteCustomCategory which DELETEs
  // via REST AND strips `category_id` refs from any Custom entities
  // that pointed at this category (those entities then have a null
  // category_id and become "uncategorised customs" — still valid).
  await useEntitiesStore.getState().deleteCustomCategory(id)
  return { id, name }
})


// ── list_alerts (Phase 2.13e+) ───────────────────────────────────────
//
// Surfaces the same alerts the sidebar Alerts panel renders, so an AI
// agent can discover what needs cleanup (uninstantiated entities,
// orphaned perspectives, POV chain gaps, etc.) without having to walk
// the project itself. Routes through the same pure derivation function
// (`computeAlerts`) that the React hook uses — one source of truth for
// alert computation, no drift possible.
//
// Optional `type` arg filters the returned list to a single alert kind
// (e.g. `type='orphaned_perspective_target'` to find every host that
// has a cascade-orphaned perspective). Omit for the full set.

registerMcpTool('list_alerts', (args) => {
  const ps = useProjectStore.getState()
  const es = useEntitiesStore.getState()
  const nodes = ps.nodes || []
  const edges = ps.edges || []
  const relationships = ps.relationships || []
  const projectKnowledges = ps.knowledges || []
  const story = ps.story || {}
  const chapters = story.chapters || []
  const chapterXOffset = typeof story.chapter_x_offset === 'number' ? story.chapter_x_offset : 10
  const povTypeDefault = story.pov_type_default || ''
  const characters = es.characters || []
  const locations  = es.locations || []
  const items      = es.items || []
  const factions   = es.factions || []
  const customs    = es.customs || []
  const customCategories = es.customCategories || []
  // Compose `allEntities` and `entityMap` via the shared helpers
  // exported from `useAlerts.js`. SINGLE source of truth: the React
  // hook and this MCP path must compose identical inputs to
  // `computeAlerts`, otherwise the sidebar Alerts panel and
  // `list_alerts` MCP results drift (which is exactly how the
  // knowledge-`type` bug went unnoticed before).
  const allEntities = composeAllEntities({
    characters, locations, items, factions, customs, knowledges: projectKnowledges,
  })
  // Mode-aware layout args so list_alerts matches the sidebar Alerts
  // panel in multi-row (the drift the comment above warns about): both
  // the story-order canonicalization and the pov_chapter_order check
  // need the active layout mode + row grouping.
  const lyt = storyLayoutArgs(story)
  const storyOrder = computeStoryOrder({ nodes, edges, chapters, chapterXOffset, ...lyt })
  const entityMap = composeEntityMap({ allEntities, projectKnowledges })
  const povChain = computePovChain(nodes, edges)
  const sourceConsumers = buildAwarenessSourceConsumers(
    allEntities, relationships, projectKnowledges, nodes,
  )
  const alerts = computeAlerts({
    nodes, edges, allEntities, chapters, chapterXOffset, povTypeDefault,
    relationships, customs, customCategories, storyOrder,
    projectKnowledges, entityMap, povChain, sourceConsumers,
    layoutMode: lyt.layoutMode, chapterRows: lyt.chapterRows,
  })
  const typeFilter = (args?.type || '').trim() || null
  const filtered = typeFilter ? alerts.filter((a) => a.type === typeFilter) : alerts
  return {
    count: filtered.length,
    total: alerts.length,
    type_filter: typeFilter,
    alerts: filtered,
  }
})
