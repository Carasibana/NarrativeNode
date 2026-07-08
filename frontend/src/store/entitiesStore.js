/**
 * entitiesStore — THE LIVE SOURCE OF TRUTH for entity data
 * (characters / locations / items / factions / customs) plus their
 * supporting library structures (custom categories, preset lists,
 * library layout).
 *
 * ── HOW THIS RELATES TO `projectStore.story.entities` ─────────────
 *
 * There are TWO places in the frontend that hold entity data and
 * they serve DIFFERENT purposes. Confusing them causes silent
 * stale-read bugs (see CHANGELOG v0.2.9.50).
 *
 *   THIS STORE (entitiesStore):
 *     - LIVE working state. Updated synchronously on every mutation
 *       (`createEntity` / `updateEntity` / `deleteEntity` / etc.)
 *       AND each mutation also fires `axios.X` to the backend.
 *     - This is what every UI surface should read from when it wants
 *       to display current entity data — the auto-attach scanner,
 *       the entity library panel, the detail panel, the chat
 *       composer's name-highlight extension, etc. all read here.
 *     - All entity CRUD goes through this store.
 *
 *   `projectStore.story.entities`:
 *     - A SNAPSHOT shape that only gets refreshed at full project
 *       load and full project save events. Between those events it
 *       is STALE relative to this store.
 *     - Exists because the save serialization wants entities in a
 *       nested `story.entities.{characters, locations, ...}` shape
 *       for the backend's `Story` Pydantic model. The save-shape
 *       builder in `projectStore.js` (see `_buildStoryForSave` /
 *       similar) populates it FROM this store at save-time so the
 *       on-the-wire shape stays correct.
 *     - **DO NOT read `story.entities` for live data.** If you need
 *       the nested-object shape from live data (e.g. to call a
 *       helper that expects `story.entities.characters` etc.), use
 *       `getLiveStoryEntitiesShape()` exported below.
 *
 * If you're reading from `story.entities` somewhere and you didn't
 * personally write the save-serialization code, it's almost
 * certainly a bug — migrate that read to either subscribe to this
 * store directly or call `getLiveStoryEntitiesShape()`.
 */

import { create } from 'zustand'
import axios from 'axios'
// Cross-store import: projectStore also imports us, so this is a cyclic
// import. ES modules resolve cycles as long as the imported value is only
// used inside function bodies (deferred, after both modules finish loading).
// We call useProjectStore.setState(...) inside action bodies only, never
// at module top level. `useProjectStore` is a Zustand store instance whose
// reference is a live binding — by the time any action below runs, the
// projectStore module is fully initialised.
import { useProjectStore } from './projectStore'
import { detectAndFireOvumSilver, detectAndFireOvumWhite, detectAndFireOvumTeal } from '../effects/quarterlyForecasts'
import { ENTITY_BUCKETS } from '../utils/entityHelpers'
import { parseListValue } from '../utils/narrativeChain'

/**
 * Mark the project as having unsaved changes. Called by every entitiesStore
 * action that represents a user-initiated edit (entity CRUD, custom category
 * CRUD, preset list CRUD, library layout mutation). NOT called by load-time
 * sync (`syncFromStory`) or undo/redo helpers (`_restoreEntity`,
 * `_removeEntity`), because those represent state transitions that either
 * already came from a saved file or are handled by the undo history layer.
 *
 * This exists because entitiesStore mutations hit the backend directly via
 * the REST API and previously had no way to tell projectStore that the
 * project had diverged from its saved-to-disk form — so the unsaved-changes
 * guard dialog never fired when users edited an entity in the detail panel
 * and then clicked New / Load. Phase 1.13 data-loss fix, v0.1.13.7.
 */
function _markProjectDirty() {
  useProjectStore.setState({ hasUnsavedChanges: true })
}

export const useEntitiesStore = create((set, get) => ({
  characters: [],
  locations: [],
  items: [],
  factions: [],
  customs: [],
  customCategories: [],
  presetLists: [],
  // Phase 3.4 — project-level Tag pool. Flat list of `{id, name, color}`
  // entries. Not chain-tracked; pool-CRUD operations propagate to every
  // host referencing the tag (see `_sweepStaleTagRefsFromEntitiesAndPresets`
  // for the entitiesStore-side cascade-strip + the projectStore
  // `_stripReferencesToTag` for the projectStore-side cascade-strip).
  projectTags: [],
  libraryLayout: { characters: [], locations: [], items: [], factions: [], customs: [], knowledges: [], relationships: [], preset_lists: [], reference_nodes: [] },

  /** Sync entity data from a story object (called after load/reset). */
  syncFromStory: (story) => {
    if (!story) return
    set({
      characters: story.entities?.characters || [],
      locations: story.entities?.locations || [],
      items: story.entities?.items || [],
      factions: story.entities?.factions || [],
      customs: story.entities?.customs || [],
      customCategories: story.custom_categories || [],
      presetLists: story.preset_lists || [],
      projectTags: story.project_tags || [],
      libraryLayout: {
        characters: story.library_layout?.characters || [],
        locations: story.library_layout?.locations || [],
        items: story.library_layout?.items || [],
        factions: story.library_layout?.factions || [],
        customs: story.library_layout?.customs || [],
        knowledges: story.library_layout?.knowledges || [],
        relationships: story.library_layout?.relationships || [],
        preset_lists: story.library_layout?.preset_lists || [],
        reference_nodes: story.library_layout?.reference_nodes || [],
      },
    })
  },

  /** Returns all entities as a flat array. */
  allEntities: () => {
    const s = get()
    return [...s.characters, ...s.locations, ...s.items, ...s.factions, ...s.customs]
  },

  getEntityById: (id) => {
    const s = get()
    return [...s.characters, ...s.locations, ...s.items, ...s.factions, ...s.customs].find(e => e.id === id) || null
  },

  // --- Entity CRUD ---

  /** Returns { entity, entity_node } */
  createEntity: async (entityData) => {
    const { data } = await axios.post('/api/entities/', entityData)
    const bucketKey = data.entity.type + 's'
    set({ [bucketKey]: [...get()[bucketKey], data.entity] })
    // Append to library layout
    const curLayout = get().libraryLayout[bucketKey] || []
    set({ libraryLayout: { ...get().libraryLayout, [bucketKey]: [...curLayout, data.entity.id] } })
    _markProjectDirty()
    try { detectAndFireOvumSilver(data.entity) } catch { /* effects must never break saves */ }
    try { detectAndFireOvumWhite(data.entity) } catch { /* effects must never break saves */ }
    try { detectAndFireOvumTeal(data.entity) } catch { /* effects must never break saves */ }
    return data  // { entity, entity_node }
  },

  updateEntity: async (entityId, entityData) => {
    const { data } = await axios.put(`/api/entities/${entityId}`, entityData)
    const bucketKey = data.type + 's'
    set({ [bucketKey]: get()[bucketKey].map(e => e.id === entityId ? data : e) })
    _markProjectDirty()
    try { detectAndFireOvumSilver(data) } catch { /* effects must never break saves */ }
    try { detectAndFireOvumWhite(data) } catch { /* effects must never break saves */ }
    try { detectAndFireOvumTeal(data) } catch { /* effects must never break saves */ }
    return data
  },

  /** Phase 4.2 — set an entity's `attribute_order` (the display order of
   *  its attributes, as a list of attribute ids). PRESENTATION property,
   *  NOT chain-tracked: there is one shared order per entity regardless
   *  of which chain anchor the reorder was performed from, so this is a
   *  baseline/entity-level write, never a chain entry. Local-only —
   *  save-time `PUT /story` syncs the backend (mirrors the
   *  `_sweep*`/`_restore*` local-mutation pattern; no fire-and-forget
   *  backend call during the action, so undo stays symmetric). No-op if
   *  the entity isn't found. */
  reorderEntityAttributes: (entityId, orderedIds) => {
    for (const bucket of ENTITY_BUCKETS) {
      const current = get()[bucket] || []
      const idx = current.findIndex((e) => e.id === entityId)
      if (idx === -1) continue
      const next = current.map((e) => (e.id === entityId ? { ...e, attribute_order: [...orderedIds] } : e))
      set({ [bucket]: next })
      _markProjectDirty()
      return
    }
  },

  deleteEntity: async (entityId, entityType) => {
    await axios.delete(`/api/entities/${entityId}`)
    const bucketKey = entityType + 's'
    set({ [bucketKey]: get()[bucketKey].filter(e => e.id !== entityId) })
    // Remove from library layout
    const curLayout = get().libraryLayout[bucketKey] || []
    set({ libraryLayout: { ...get().libraryLayout, [bucketKey]: curLayout.filter(item => item !== entityId) } })
    _markProjectDirty()
  },

  /** Re-add an entity that was purged (used by undo). Does NOT call the API — the
   *  entity will be re-persisted on the next save. */
  _restoreEntity: (bucketKey, entityData) => {
    const existing = get()[bucketKey] || []
    // Avoid duplicates if undo is triggered multiple times
    if (existing.some((e) => e.id === entityData.id)) return
    set({ [bucketKey]: [...existing, entityData] })
    // Restore library layout entry
    const curLayout = get().libraryLayout[bucketKey] || []
    if (!curLayout.includes(entityData.id)) {
      set({ libraryLayout: { ...get().libraryLayout, [bucketKey]: [...curLayout, entityData.id] } })
    }
  },

  /** Replace an existing entity's full data with the passed snapshot. Used by undo
   *  to reverse cross-entity sweeps (e.g. `_sweepStaleEntityReferencesFromEntities`
   *  mutated OTHER entities' `parent_id` or attribute values during a purgeEntity
   *  cascade — undo restores each to the pre-sweep state). Local-only; save-time
   *  `PUT /story` syncs backend. No-op if the entity isn't currently in the bucket. */
  _restoreEntityData: (bucketKey, entityData) => {
    const current = get()[bucketKey] || []
    if (!current.some((e) => e.id === entityData.id)) return
    set({ [bucketKey]: current.map((e) => e.id === entityData.id ? entityData : e) })
  },

  /** Remove an entity locally (used by redo and purgeEntity). Does NOT call the API —
   *  the deletion is persisted on the next save. Mirror of _restoreEntity. */
  _removeEntity: (bucketKey, entityId) => {
    set({ [bucketKey]: (get()[bucketKey] || []).filter((e) => e.id !== entityId) })
    const curLayout = get().libraryLayout[bucketKey] || []
    set({ libraryLayout: { ...get().libraryLayout, [bucketKey]: curLayout.filter((item) => item !== entityId) } })
  },

  /** Strip every reference TO the given preset-list id FROM entity attributes. Called
   *  by `deletePresetList` as part of the DELETE cascade. Local-only — save-time
   *  `PUT /story` syncs backend. Clears `preset_list_id` on matching attributes while
   *  preserving their current `value` as free-form text (the last selected value).
   *  The related sweep on relationship participant_roles lives in projectStore. */
  _sweepStalePresetListRefsFromAttributes: (listId) => {
    const update = {}
    for (const bucket of ENTITY_BUCKETS) {
      const current = get()[bucket] || []
      let bucketChanged = false
      const next = current.map((entity) => {
        const origAttrs = entity.attributes || []
        let attrsChanged = false
        const newAttrs = origAttrs.map((a) => {
          if (a.preset_list_id === listId) {
            attrsChanged = true
            return { ...a, preset_list_id: null }
          }
          return a
        })
        if (attrsChanged) {
          bucketChanged = true
          return { ...entity, attributes: newAttrs }
        }
        return entity
      })
      if (bucketChanged) update[bucket] = next
    }
    if (Object.keys(update).length > 0) set(update)
  },

  /** Strip every reference TO the given Project Tag id FROM entity baselines
   *  + preset list baselines. Called by `projectStore._deleteProjectTagInternal`
   *  as part of the DELETE cascade. Local-only — save-time `PUT /story` syncs
   *  backend. Pairs with the projectStore `_stripReferencesToTag` primitive
   *  which handles the projectStore-owned state (knowledges, relationships,
   *  scene EntityRefs, EntityNode modifier-mode tag_changes, ReferenceNode
   *  baseline). Each entity / preset list is rewritten only when it actually
   *  loses a reference. */
  _sweepStaleTagRefsFromEntitiesAndPresets: (tagId) => {
    const update = {}
    for (const bucket of ENTITY_BUCKETS) {
      const current = get()[bucket] || []
      let bucketChanged = false
      const next = current.map((entity) => {
        const baseline = (entity.tag_ids || []).filter((t) => t !== tagId)
        if (baseline.length === (entity.tag_ids || []).length) return entity
        bucketChanged = true
        return { ...entity, tag_ids: baseline }
      })
      if (bucketChanged) update[bucket] = next
    }
    const lists = get().presetLists || []
    let listsChanged = false
    const nextLists = lists.map((pl) => {
      const baseline = (pl.tag_ids || []).filter((t) => t !== tagId)
      if (baseline.length === (pl.tag_ids || []).length) return pl
      listsChanged = true
      return { ...pl, tag_ids: baseline }
    })
    if (listsChanged) update.presetLists = nextLists
    if (Object.keys(update).length > 0) set(update)
  },

  /** Strip every reference TO the given custom-category id FROM custom entities.
   *  Called by `deleteCustomCategory` as part of the DELETE cascade. Local-only —
   *  save-time `PUT /story` syncs backend. Clears `category_id` to null on affected
   *  custom entities. */
  _sweepStaleCustomCategoryRefsFromEntities: (categoryId) => {
    const current = get().customs || []
    const hasRefs = current.some((e) => e.category_id === categoryId)
    if (!hasRefs) return
    set({
      customs: current.map((e) => e.category_id === categoryId ? { ...e, category_id: null } : e),
    })
  },

  /** Strip every reference TO the given entity id FROM other entities in the store.
   *  Called by `projectStore._deleteEntityInternal` as part of the DELETE cascade for
   *  cross-store cleanup (parent_id children + entity_list attribute values). Local-only
   *  — save-time `PUT /story` syncs the backend. Reference-stripping counterpart for the
   *  projectStore `_stripReferencesToEntity` primitive. */
  _sweepStaleEntityReferencesFromEntities: (deletedEntityId) => {
    // Phase 1.21 — strip `deletedEntityId` from any scalar-dict `awareness`
    // field (on an entity, attribute, or alias). AwarenessRef fields are
    // untouched here: refs are all-or-nothing projections keyed on
    // relationships, not entities, so an entity delete can't dangle one.
    const stripAwarenessKey = (awareness) => {
      if (!awareness || typeof awareness !== 'object') return awareness
      if ('relationship_id' in awareness && 'level' in awareness) return awareness
      if (!(deletedEntityId in awareness)) return awareness
      const next = { ...awareness }
      delete next[deletedEntityId]
      return Object.keys(next).length > 0 ? next : null
    }
    const update = {}
    for (const bucket of ENTITY_BUCKETS) {
      const current = get()[bucket] || []
      let bucketChanged = false
      const next = current.map((entity) => {
        let entityChanged = false
        let e = entity
        // parent_id: clear if it was the deleted entity
        if (e.parent_id === deletedEntityId) {
          e = { ...e, parent_id: null }
          entityChanged = true
        }
        // Entity-level awareness
        const nextEntAw = stripAwarenessKey(e.awareness)
        if (nextEntAw !== e.awareness) {
          e = { ...e, awareness: nextEntAw }
          entityChanged = true
        }
        // entity_list attribute values: filter out the deleted entity id
        // Attribute-level awareness also swept.
        const origAttrs = e.attributes || []
        let attrsChanged = false
        const newAttrs = origAttrs.map((a) => {
          let a2 = a
          if (a.attribute_type === 'entity_list') {
            const list = parseListValue(a.value)
            if (list.includes(deletedEntityId)) {
              a2 = { ...a2, value: JSON.stringify(list.filter((id) => id !== deletedEntityId)) }
              attrsChanged = true
            }
          }
          const nextAw = stripAwarenessKey(a2.awareness)
          if (nextAw !== a2.awareness) {
            a2 = { ...a2, awareness: nextAw }
            attrsChanged = true
          }
          return a2
        })
        if (attrsChanged) {
          e = { ...e, attributes: newAttrs }
          entityChanged = true
        }
        // Alias-level awareness
        const origAliases = e.aliases || []
        let aliasesChanged = false
        const newAliases = origAliases.map((al) => {
          const nextAw = stripAwarenessKey(al.awareness)
          if (nextAw === al.awareness) return al
          aliasesChanged = true
          return { ...al, awareness: nextAw }
        })
        if (aliasesChanged) {
          e = { ...e, aliases: newAliases }
          entityChanged = true
        }
        if (entityChanged) bucketChanged = true
        return e
      })
      if (bucketChanged) update[bucket] = next
    }
    if (Object.keys(update).length > 0) set(update)
  },

  /** Phase 2.13 — null `perspective_target_kind` + `perspective_target_id`
   *  on every baseline perspective attribute whose target matches
   *  `(kindSet, targetId)`. Per the null-target-keep-description cascade
   *  contract (Phase 2.13 planning doc, decision 3): the perspective row
   *  survives, its description text is preserved, the UI surfaces it as
   *  a "(deleted target)" orphan and an alert is emitted from the
   *  dispatcher layer (Phase 2.13d). Local-only — save-time `PUT /story`
   *  syncs the backend.
   *
   *  `kindSet` is a Set of `perspective_target_kind` values to match
   *  against ('character' / 'location' / 'item' / 'faction' / 'custom'
   *  for an entity delete; 'knowledge' for a knowledge delete;
   *  'relationship' for a relationship delete). */
  _sweepStalePerspectiveTargetsFromEntities: (kindSet, targetId) => {
    if (!(kindSet instanceof Set) || !targetId) return
    const update = {}
    for (const bucket of ENTITY_BUCKETS) {
      const current = get()[bucket] || []
      let bucketChanged = false
      const next = current.map((entity) => {
        const origAttrs = entity.attributes || []
        let attrsChanged = false
        const newAttrs = origAttrs.map((a) => {
          if (
            a.attribute_type === 'perspective' &&
            a.perspective_target_id === targetId &&
            kindSet.has(a.perspective_target_kind)
          ) {
            attrsChanged = true
            return { ...a, perspective_target_kind: null, perspective_target_id: null }
          }
          return a
        })
        if (!attrsChanged) return entity
        bucketChanged = true
        return { ...entity, attributes: newAttrs }
      })
      if (bucketChanged) update[bucket] = next
    }
    if (Object.keys(update).length > 0) set(update)
  },

  /** Phase 1.21 — clear any scalar `awareness` field (on an entity, attribute,
   *  or alias) that is an `AwarenessRef` pointing at the deleted relationship.
   *  Refs are all-or-nothing, so the whole field becomes null. Called by
   *  projectStore's `_deleteRelationshipInternal` as part of the DELETE cascade
   *  for cross-store cleanup. */
  _sweepStaleRelationshipReferencesFromEntities: (deletedRelationshipId) => {
    const scrubRef = (awareness) => {
      if (!awareness || typeof awareness !== 'object') return awareness
      if (!('relationship_id' in awareness) || !('level' in awareness)) return awareness
      if (awareness.relationship_id !== deletedRelationshipId) return awareness
      return null
    }
    const update = {}
    for (const bucket of ENTITY_BUCKETS) {
      const current = get()[bucket] || []
      let bucketChanged = false
      const next = current.map((entity) => {
        let e = entity
        let entityChanged = false
        const nextEntAw = scrubRef(e.awareness)
        if (nextEntAw !== e.awareness) {
          e = { ...e, awareness: nextEntAw }
          entityChanged = true
        }
        const origAttrs = e.attributes || []
        let attrsChanged = false
        const newAttrs = origAttrs.map((a) => {
          const nextAw = scrubRef(a.awareness)
          if (nextAw === a.awareness) return a
          attrsChanged = true
          return { ...a, awareness: nextAw }
        })
        if (attrsChanged) {
          e = { ...e, attributes: newAttrs }
          entityChanged = true
        }
        const origAliases = e.aliases || []
        let aliasesChanged = false
        const newAliases = origAliases.map((al) => {
          const nextAw = scrubRef(al.awareness)
          if (nextAw === al.awareness) return al
          aliasesChanged = true
          return { ...al, awareness: nextAw }
        })
        if (aliasesChanged) {
          e = { ...e, aliases: newAliases }
          entityChanged = true
        }
        if (entityChanged) bucketChanged = true
        return e
      })
      if (bucketChanged) update[bucket] = next
    }
    if (Object.keys(update).length > 0) set(update)
  },

  /**
   * Replace the entire `presetLists` array in one set(). Used when a
   * server round-trip (e.g. the seeds-apply endpoint) returns a new
   * canonical list; callers then don't have to reach into
   * `useEntitiesStore.setState` directly, which bypasses the store-action
   * layer of the 3-layer write convention.
   */
  setPresetLists: (lists) => {
    set({ presetLists: Array.isArray(lists) ? lists : [] })
  },

  /** Re-add a preset list that was deleted (used by undo). Does NOT call the API —
   *  the caller is responsible for the backend sync. Mirror of `_removePresetList`. */
  _restorePresetList: (listData) => {
    const existing = get().presetLists || []
    if (existing.some((p) => p.id === listData.id)) return
    set({ presetLists: [...existing, listData] })
  },

  /** Remove a preset list locally (used by redo). Does NOT call the API —
   *  the caller is responsible for the backend sync. Mirror of `_restorePresetList`. */
  _removePresetList: (listId) => {
    set({ presetLists: (get().presetLists || []).filter((p) => p.id !== listId) })
  },

  /** Re-add a custom category that was deleted (used by undo). Does NOT call
   *  the API — caller handles backend sync. Mirror of `_removeCustomCategory`. */
  _restoreCustomCategory: (catData) => {
    const existing = get().customCategories || []
    if (existing.some((c) => c.id === catData.id)) return
    set({ customCategories: [...existing, catData] })
  },

  /** Remove a custom category locally (used by redo). Does NOT call the API —
   *  caller handles backend sync. Mirror of `_restoreCustomCategory`. */
  _removeCustomCategory: (catId) => {
    set({ customCategories: (get().customCategories || []).filter((c) => c.id !== catId) })
  },

  // --- Custom categories ---

  createCustomCategory: async (catData) => {
    const { data } = await axios.post('/api/custom-categories/', catData)
    set({ customCategories: [...get().customCategories, data] })
    _markProjectDirty()
    return data
  },

  updateCustomCategory: async (catId, catData) => {
    const { data } = await axios.put(`/api/custom-categories/${catId}`, catData)
    set({ customCategories: get().customCategories.map(c => c.id === catId ? data : c) })
    _markProjectDirty()
    return data
  },

  deleteCustomCategory: async (catId) => {
    await axios.delete(`/api/custom-categories/${catId}`)
    set({ customCategories: get().customCategories.filter(c => c.id !== catId) })
    // Strip references: clear category_id on any custom entities that pointed at it.
    get()._sweepStaleCustomCategoryRefsFromEntities(catId)
    _markProjectDirty()
  },

  /** Reorder customCategories[] by an array of ids. Categories not
   *  present in `orderedIds` keep their relative order, appended to
   *  the end (defensive — the writer's drag-drop UI should always
   *  supply the full set, but if it doesn't we don't lose categories).
   *  Used by the customs library panel's category-header drag reorder. */
  reorderCustomCategories: (orderedIds) => {
    const cur = get().customCategories || []
    const byId = new Map(cur.map((c) => [c.id, c]))
    const seen = new Set()
    const out = []
    for (const id of (orderedIds || [])) {
      const c = byId.get(id)
      if (c && !seen.has(id)) { out.push(c); seen.add(id) }
    }
    for (const c of cur) {
      if (!seen.has(c.id)) out.push(c)
    }
    set({ customCategories: out })
    _markProjectDirty()
  },

  // --- Preset lists ---

  createPresetList: async (listData) => {
    const { data } = await axios.post('/api/preset-lists/', listData)
    const newList = data
    const existingLists = get().presetLists  // snapshot before adding
    set({ presetLists: [...existingLists, newList] })
    _markProjectDirty()

    // Reactively re-link orphaned preset attributes whose saved name matches this new list.
    // An attribute is orphaned when its preset_list_id references a list that no longer exists.
    const s = get()
    for (const bucket of ENTITY_BUCKETS) {
      for (const entity of [...(s[bucket] || [])]) {
        const attrs = entity.attributes || []
        const relinked = attrs.map((attr) => {
          if (
            attr.attribute_type === 'preset' &&
            attr.preset_list_name === newList.name &&
            attr.preset_list_id &&
            !existingLists.find((p) => p.id === attr.preset_list_id)
          ) {
            return { ...attr, preset_list_id: newList.id }
          }
          return attr
        })
        if (relinked.some((a, i) => a !== attrs[i])) {
          await get().updateEntity(entity.id, { ...entity, attributes: relinked })
        }
      }
    }

    return newList
  },

  updatePresetList: async (listId, listData) => {
    const { data } = await axios.put(`/api/preset-lists/${listId}`, listData)
    set({ presetLists: get().presetLists.map(p => p.id === listId ? data : p) })
    _markProjectDirty()
    return data
  },

  deletePresetList: async (listId) => {
    await axios.delete(`/api/preset-lists/${listId}`)
    set({ presetLists: get().presetLists.filter(p => p.id !== listId) })
    // Strip references: clear preset_list_id on entity attributes AND on relationship
    // participant roles. Preserves the last value as free-form text in each case.
    get()._sweepStalePresetListRefsFromAttributes(listId)
    useProjectStore.getState()._sweepStalePresetListRefsFromRelationships(listId)
    _markProjectDirty()
  },

  // --- Project Tags (Phase 3.4e) ---

  /** Create a Project Tag pool entry. POSTs to the backend; on
   *  case-insensitive name collision the backend returns the
   *  existing entry (seamless find-or-create) so a fresh POST is
   *  idempotent for the caller. The returned entry is appended to
   *  local state — duplicate-id guards prevent double-insertion on
   *  the collision path. */
  createProjectTag: async (tagData) => {
    const { data } = await axios.post('/api/project-tags/', tagData)
    const existing = get().projectTags || []
    if (existing.some((t) => t.id === data.id)) {
      // Collision — backend returned the existing entry. Local state
      // already has it; no insertion needed.
      _markProjectDirty()
      return data
    }
    set({ projectTags: [...existing, data] })
    _markProjectDirty()
    return data
  },

  /* Phase 7.2 — parse an uploaded file as a SillyTavern character card and,
   *  if it is one, create a populated character entity. Returns the
   *  createEntity result ({entity, entity_node}) so the caller can place the
   *  origin node; returns null when the file is NOT a card (so a drag-drop can
   *  fall through to normal image handling). Throws only on a real failure
   *  after a card was recognised. */
  importCharacterCardFile: async (file) => {
    let draft
    try {
      const form = new FormData()
      form.append('file', file, file.name || 'card')
      const { data } = await axios.post('/api/character-card/parse', form)
      if (!data?.is_card || !data.draft) return null
      draft = data.draft
    } catch {
      return null  // parse failure -> treat as not-a-card (fall through)
    }
    // Find-or-create the card's tags as project tags (case-insensitive dedup).
    const tag_ids = []
    for (const tagName of (draft.tag_names || [])) {
      try {
        const tag = await get().createProjectTag({ name: tagName })
        if (tag?.id && !tag_ids.includes(tag.id)) tag_ids.push(tag.id)
      } catch { /* skip a tag that fails */ }
    }
    // Use the card image as the profile picture (processed to 256x256).
    let profile_image_ref = null
    if (/\.png$/i.test(file.name || '') || file.type === 'image/png') {
      try {
        const imgForm = new FormData()
        imgForm.append('file', file, file.name || 'card.png')
        const { data } = await axios.post('/api/character-card/profile-image', imgForm)
        profile_image_ref = data?.file_ref || null
      } catch { /* profile image is optional */ }
    }
    const attributes = (draft.attributes || []).map((a) => ({
      name: a.name, attribute_type: 'text', value: a.value || '',
    }))
    return await get().createEntity({
      type: 'character',
      name: draft.name || 'Imported Character',
      colour: draft.colour || '#888888',
      description: draft.description || '',
      attributes,
      tag_ids,
      notes: draft.notes || '',
      profile_image_ref,
    })
  },

  /** Rename and/or recolour a Project Tag pool entry. Backend PUT
   *  enforces case-insensitive uniqueness (excluding the tag being
   *  renamed). Throws on 409 — caller surfaces the saveError. */
  updateProjectTag: async (tagId, patch) => {
    const { data } = await axios.put(`/api/project-tags/${tagId}`, patch)
    set({
      projectTags: (get().projectTags || []).map((t) => (t.id === tagId ? data : t)),
    })
    _markProjectDirty()
    return data
  },

  // --- Library layout (ordering + dividers) ---

  /** Set the full ordered layout for one entity type bucket. */
  setLibraryLayout: (bucketKey, layout) => {
    set({ libraryLayout: { ...get().libraryLayout, [bucketKey]: layout } })
    _markProjectDirty()
  },

  /** Add a divider to the end of a type bucket. */
  addLibraryDivider: (bucketKey) => {
    const id = crypto.randomUUID()
    const divider = { type: 'divider', id, title: '' }
    const cur = get().libraryLayout[bucketKey] || []
    set({ libraryLayout: { ...get().libraryLayout, [bucketKey]: [...cur, divider] } })
    _markProjectDirty()
    return id
  },

  /** Update a divider's title. */
  updateLibraryDivider: (bucketKey, dividerId, title) => {
    const cur = get().libraryLayout[bucketKey] || []
    set({
      libraryLayout: {
        ...get().libraryLayout,
        [bucketKey]: cur.map(item =>
          (typeof item === 'object' && item.id === dividerId) ? { ...item, title } : item
        ),
      },
    })
    _markProjectDirty()
  },

  /** Remove a divider. */
  removeLibraryDivider: (bucketKey, dividerId) => {
    const cur = get().libraryLayout[bucketKey] || []
    set({
      libraryLayout: {
        ...get().libraryLayout,
        [bucketKey]: cur.filter(item => !(typeof item === 'object' && item.id === dividerId)),
      },
    })
    _markProjectDirty()
  },
}))

/**
 * Returns the entities in the nested-object shape that historical
 * code expects from `story.entities` (i.e.
 * `{ characters, locations, items, factions, customs }`), but
 * populated from THIS store's live data — not from the stale
 * `projectStore.story.entities` snapshot.
 *
 * Use this anywhere a helper expects a `story.entities`-shaped
 * argument (e.g. `findEntity(story, id)` from
 * `utils/chatContextFormatters.js`) and you want the lookup to see
 * current data. The typical pattern in builder functions that took
 * a `story` argument is:
 *
 *   const story = { ...(store.story || {}) }
 *   story.entities = getLiveStoryEntitiesShape()
 *   // ... everything downstream that reads story.entities now sees live
 *
 * The returned object is freshly allocated on every call (cheap —
 * five array references) so it is safe to mutate the wrapping
 * `story` object the caller builds. The inner bucket arrays are
 * the LIVE references from this store; callers MUST NOT mutate
 * those bucket arrays in place.
 */
export function getLiveStoryEntitiesShape() {
  const s = useEntitiesStore.getState()
  return {
    characters: s.characters || [],
    locations: s.locations || [],
    items: s.items || [],
    factions: s.factions || [],
    customs: s.customs || [],
  }
}
