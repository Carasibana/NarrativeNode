// ── Shared constants ────────────────────────────────────────────────────────────

/**
 * Canonical ordered list of SceneNode entity-bucket keys. Single source of
 * truth for iteration order across the frontend (chip order, chain walking,
 * effective-state computation, etc.). Object.freeze prevents accidental
 * mutation by consumers.
 */
export const ENTITY_BUCKETS = Object.freeze(['characters', 'locations', 'items', 'factions', 'customs'])

/**
 * Default colour assigned to every new entity / knowledge / relationship
 * at creation time (`#888888` — neutral 50% grey). Used to detect whether
 * the writer has explicitly customised an object's colour vs. left it on
 * the default. Surfaces that want to use the entity's colour as an
 * accent (e.g. pill flash) but fall back to story-accent when the
 * entity is on the default should compare via `isDefaultEntityColour`.
 *
 * Kept here (not in `mcpTools.js` where another copy lives) so the
 * value has a single canonical home accessible to frontend code
 * without dragging in the MCP-tools dependency graph.
 */
export const DEFAULT_ENTITY_COLOUR = '#888888'

/** True when the colour is missing OR equal to the canonical default
 *  (`#888888`). Case-insensitive on the hex string. Use this when
 *  deciding "did the writer customise this entity's colour, or is it
 *  still on default?". */
export function isDefaultEntityColour(colour) {
  if (!colour) return true
  return String(colour).toLowerCase() === DEFAULT_ENTITY_COLOUR
}

export const TYPE_ICONS = {
  character: '👤',
  location: '📍',
  item: '🎒',
  faction: '🚩',
  custom: '🔧',
  knowledge: '📜',
}

// ── Participants fallback label ─────────────────────────────────────────────
// When a relationship has no custom name, its display label is built from the
// participants. Use serial comma + ampersand before the last name:
//   1 → "Alice"
//   2 → "Alice & Bob"
//   3 → "Alice, Bob, & Candy"
//   4+ → "Alice, Bob, Candy, & Dave"
// When the caller passes a sliceMax and there are more participants than that,
// the truncated form drops the ampersand (since more follow):
//   "Alice, Bob + 2 more"

export function joinWithSerialAmpersand(names) {
  if (!names || names.length === 0) return ''
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} & ${names[1]}`
  const last = names[names.length - 1]
  const rest = names.slice(0, -1).join(', ')
  return `${rest}, & ${last}`
}

/**
 * Build the participants fallback label for a relationship with no custom name.
 * - participants: array of objects with entity_id
 * - getEntity: function(id) → entity | undefined
 * - sliceMax: optional — when participants.length > sliceMax, only the first
 *   sliceMax names are shown and a "+ N more" suffix is appended. Callers
 *   without space constraints should omit this argument.
 * - relForAliases: optional — when provided, each participant's name is
 *   annotated with ` as {alias}` whenever the relationship's history carries
 *   an alias override for that entity.
 *
 * This is the PLAIN-STRING variant used by contexts that need a flat string
 * (alert template literals, length comparisons, title attributes, etc.).
 * JSX render sites should use `<ParticipantsFallbackLabel>` in
 * `components/ui/IdentityBadges.jsx` instead — it styles the ` as {alias}`
 * suffix as subtle italic grey, matching the Participants list in the
 * relationship detail panel.
 */
export function participantsFallbackLabel(participants, getEntity, sliceMax = Infinity, relForAliases = null, resolveName = null) {
  const { items, truncated } = buildParticipantNameItems(participants, getEntity, sliceMax, relForAliases, resolveName)
  if (items.length === 0) return ''
  const names = items.map((it) => it.alias ? `${it.name} as ${it.alias}` : it.name)
  if (truncated === 0) return joinWithSerialAmpersand(names)
  return `${names.join(', ')} + ${truncated} more`
}

/** Shared building block for both the plain-string `participantsFallbackLabel`
 *  and the JSX `<ParticipantsFallbackLabel>` component. Walks participants
 *  (respecting sliceMax) and resolves each one's display name + optional
 *  alias from the relationship's history.
 *
 *  `resolveName(entityId) => string | null`: optional resolver that lets the
 *  caller provide the chain-resolved effective name at a specific chain
 *  position. When it returns a non-null string, that name wins; otherwise
 *  the helper falls back to `getEntity(id)?.name`. Without a resolver (the
 *  default) the helper reads base-library names, matching pre-Phase 1.21
 *  behaviour for call sites that have no chain context (e.g. drag tooltips,
 *  dev-preview fixtures). */
export function buildParticipantNameItems(participants, getEntity, sliceMax = Infinity, rel = null, resolveName = null) {
  if (!participants || participants.length === 0) return { items: [], truncated: 0 }
  const aliasMap = buildAliasMap(rel)
  const n = Math.min(participants.length, sliceMax)
  const items = participants.slice(0, n).map((p) => {
    const resolved = resolveName ? resolveName(p.entity_id) : null
    return {
      name: resolved || getEntity(p.entity_id)?.name || '?',
      alias: aliasMap.get(p.entity_id) || null,
    }
  })
  return { items, truncated: Math.max(0, participants.length - n) }
}

/** Build a per-entity alias map from a relationship's history. First `join`
 *  for an entity seeds the alias from `initial_alias_override`; later
 *  `alias_changes` entries overwrite (most recent wins). Returns an empty
 *  Map when `rel` is null/undefined or has no history. */
export function buildAliasMap(rel) {
  const map = new Map()
  if (!rel?.history) return map
  for (const c of (rel.history.participant_changes || [])) {
    if (c.action === 'join' && c.initial_alias_override && !map.has(c.entity_id)) {
      map.set(c.entity_id, c.initial_alias_override)
    }
  }
  for (const a of (rel.history.alias_changes || [])) {
    if (a.alias_override) map.set(a.entity_id, a.alias_override)
  }
  return map
}

// ── Ghost partner resolution ────────────────────────────────────────────────
// Relationships that reference a partner entity_id that no longer
// resolves (partner was deleted, or the reference is deliberately
// unresolvable) can carry optional per-side *_name_fallback /
// *_colour_fallback fields on the Relationship so render paths don't
// have to fall through to "Unknown". This helper returns a synthetic
// entity-shaped object built from those fallback fields so callers can
// pass it to rendering components that expect an entity. Returns null
// when no fallback name is present.
export function resolveGhostPartner(relObj, ownerEntityId) {
  if (!relObj) return null
  const ownerIsA = relObj.entity_a_id === ownerEntityId
  const name = ownerIsA ? relObj.entity_b_name_fallback : relObj.entity_a_name_fallback
  if (!name) return null
  const colour = (ownerIsA ? relObj.entity_b_colour_fallback : relObj.entity_a_colour_fallback) || '#888888'
  const otherId = ownerIsA ? relObj.entity_b_id : relObj.entity_a_id
  return {
    id: otherId,
    name,
    colour,
    type: 'character',
    profile_image_ref: null,
    attributes: [],
    relationships: [],
    _ghost: true,
  }
}

// User-facing labels for attribute types. The backend identifier for "Media"
// attributes is still `"file"` — the label has been renamed to better
// reflect the media-only usage, but the internal id is unchanged so saves
// stay compatible.
export const ATTR_TYPE_LABELS = {
  text:         'Text',
  file:         'Media',
  preset:       'Preset',
  text_list:    'Text List',
  entity_list:  'Entity List',
  number:       'Number',
  circumstance: 'Circumstance',
  motivator:    'Motivator',
}

export const ATTR_TYPE_COLOURS = {
  text:         'bg-blue-900/60 text-blue-300',
  file:         'bg-green-900/60 text-green-300',
  preset:       'bg-amber-900/60 text-amber-300',
  text_list:    'bg-sky-900/60 text-sky-300',
  entity_list:  'bg-fuchsia-900/60 text-fuchsia-300',
  number:       'bg-purple-900/60 text-purple-300',
  circumstance: 'bg-slate-900/60 text-slate-300',
  motivator:    'bg-orange-900/60 text-orange-300',
}

export function emptyAttr() {
  // Shape carries all per-type fields up-front so a `setNewAttr((a) => ({ ...a, attribute_type: 'number' }))`-
  // style type switch doesn't have to remember which extra fields each type needs.
  // Backend stores `null` for unused fields regardless of attribute_type, so
  // round-trip is clean.
  return {
    id: crypto.randomUUID(),
    name: '',
    attribute_type: 'text',
    value: '',
    file_ref: null,
    preset_list_id: null,
    preset_list_name: null,
    number_value: null,
    description: '',
    intensity: null,
  }
}

// ── Attribute display order (Phase 4.2) ─────────────────────────────────────────

/**
 * Apply an entity's `attribute_order` (a list of attribute ids — the
 * user's chosen display order) to a list of attributes, per the Phase
 * 4.2 rules:
 *   1. Attributes whose id appears in `attributeOrder` sort by their
 *      index there.
 *   2. Ids in `attributeOrder` not present in `attrs` are skipped (an
 *      attribute removed at this chain position, or one added at a
 *      LATER scene than the position being rendered) — no gap, no
 *      placeholder. This falls out naturally: we only sort the attrs
 *      that exist.
 *   3. Attributes not yet in `attributeOrder` (e.g. a freshly chain-
 *      added one nobody has dragged) keep their original `attrs` order
 *      and are appended at the end, stable.
 *
 * Pure + presentation-only: `attribute_order` is NOT chain-tracked, so
 * the same shared list governs the order wherever the attribute list is
 * built (the chain-resolved detail view, the baseline library / modal).
 * Returns a new array; never mutates the input. An absent / empty order
 * returns `attrs` unchanged (the pre-Phase-4.2 array-order fallback).
 *
 * @param {Array} items                        attributes (or change
 *        entries) to order
 * @param {string[]|undefined|null} attributeOrder  entity.attribute_order
 * @param {(item:any)=>string} [getId]          extracts the attribute id
 *        from each item. Defaults to `item.id` (effective attributes);
 *        pass `(ac) => ac.attribute.id` for draft-add change entries.
 * @returns {Array} ordered copy
 */
export function applyAttributeOrder(items, attributeOrder, getId = (x) => x.id) {
  if (!Array.isArray(items) || items.length === 0) return items
  if (!Array.isArray(attributeOrder) || attributeOrder.length === 0) return items
  const orderIndex = new Map(attributeOrder.map((id, i) => [id, i]))
  const ordered = []
  const unordered = []
  for (const a of items) {
    if (orderIndex.has(getId(a))) ordered.push(a)
    else unordered.push(a)
  }
  ordered.sort((x, y) => orderIndex.get(getId(x)) - orderIndex.get(getId(y)))
  return [...ordered, ...unordered]
}

// ── EntityRef / node helpers ────────────────────────────────────────────────────

/**
 * Find an EntityRef inside a SceneNode's data buckets.
 * Returns the ref object or null if not found.
 */
export function getEntityRefAtNode(nodeId, entityId, nodes) {
  const node = nodes.find((n) => n.id === nodeId && n.type === 'sceneNode')
  if (!node) return null
  for (const b of ENTITY_BUCKETS) {
    const ref = (node.data[b] || []).find((r) => r.entity_id === entityId)
    if (ref) return ref
  }
  return null
}

// ── Changes-draft helpers ────────────────────────────────────────────────────
// Shared between EntityChipDetailView and EntityNodeModifierView, which both
// use the same { name_change, colour_change, description_change,
// attribute_changes[] } draft shape.

/**
 * Returns true when `draft` has no changes beyond the baseline (draft can be
 * discarded / set to null).  Baseline is produced by calling `initDraft()`.
 */
export function changesDraftIsClean(draft, initDraft) {
  if (!draft) return true
  const init = initDraft()
  return (
    draft.name_change === init.name_change &&
    draft.colour_change === init.colour_change &&
    draft.description_change === init.description_change &&
    (draft.profile_image_change ?? null) === (init.profile_image_change ?? null) &&
    JSON.stringify(draft.alias_changes || []) === JSON.stringify(init.alias_changes || []) &&
    JSON.stringify(draft.attribute_changes) === JSON.stringify(init.attribute_changes)
  )
}

/**
 * Build all draft-mutation helpers that are identical between EntityChipDetailView
 * and EntityNodeModifierView.  Call once in the component body; the returned
 * functions close over the component's own setDraft / initDraft / entityId.
 *
 * @param {Function} setDraft   — React state setter for the draft
 * @param {Function} initDraft  — returns a fresh baseline draft object
 * @param {Function} draftIsClean — (draft) => boolean
 */
export function makeChangesDraftHelpers(setDraft, initDraft, draftIsClean) {
  // Internal: apply transform to draft, optionally null-out if clean
  const update = (fn) => setDraft((d) => fn(d ?? initDraft()))
  const updateOrNull = (fn) => setDraft((d) => {
    const result = fn(d ?? initDraft())
    return draftIsClean(result) ? null : result
  })

  return {
    // ── Scalar override ──────────────────────────────────────────────────
    updateDraftOverride: (key, val) => update((base) => ({ ...base, [key]: val })),
    clearDraftOverride:  (key) => updateOrNull((base) => ({ ...base, [key]: null })),

    // ── Attribute helpers ────────────────────────────────────────────────
    /**
     * Phase 1.22d — Apply an edit to a circumstance / motivator
     * attribute. Writes are chain-aware:
     *
     *   - When the attribute has an `add` entry at this anchor in the
     *     draft (it was added here OR we're at the attribute's origin
     *     and the panel's add-fallback ternary populated draft from
     *     `entity.attributes`), mutate the embedded attribute's fields
     *     in place. This is the chain-aware path: the add entry IS the
     *     attribute's origin, and origin baselines update directly.
     *
     *   - Otherwise (the attribute was added at an earlier chain stop;
     *     this anchor is downstream of the attribute's origin), write
     *     a `modify` chain entry with `new_name` / `new_description` /
     *     `new_intensity` per the Option (a) per-field payload shape
     *     from Phase 1.22a. Re-edits at the same anchor replace the
     *     existing modify entry in place rather than appending.
     *
     * `patch` is `{ name?, description?, intensity? }`. Only fields
     * present in the patch are applied; fields omitted are left
     * unchanged. To clear `intensity` back to unset, pass
     * `intensity: null` explicitly.
     */
    setAttrCMOverride: (attrId, patch) => update((base) => {
      const addIdx = base.attribute_changes.findIndex((ac) => ac.action === 'add' && ac.attribute?.id === attrId)
      if (addIdx !== -1) {
        // Mutate the add entry's embedded attribute. This is the
        // attribute's own origin baseline.
        const newPatch = {}
        if ('name'        in patch) newPatch.name        = patch.name
        if ('description' in patch) newPatch.description = patch.description
        if ('intensity'   in patch) newPatch.intensity   = patch.intensity
        return {
          ...base,
          attribute_changes: base.attribute_changes.map((ac, i) =>
            i === addIdx ? { ...ac, attribute: { ...ac.attribute, ...newPatch } } : ac
          ),
        }
      }
      // Chain-anchor modify entry. Upsert.
      const existingIdx = base.attribute_changes.findIndex((ac) => ac.action === 'modify' && ac.attribute_id === attrId)
      const fieldOverrides = {}
      if ('name'        in patch) fieldOverrides.new_name        = patch.name
      if ('description' in patch) fieldOverrides.new_description = patch.description
      if ('intensity'   in patch) fieldOverrides.new_intensity   = patch.intensity
      if (existingIdx !== -1) {
        return {
          ...base,
          attribute_changes: base.attribute_changes.map((ac, i) =>
            i === existingIdx ? { ...ac, ...fieldOverrides } : ac
          ),
        }
      }
      return {
        ...base,
        attribute_changes: [
          ...base.attribute_changes,
          { id: crypto.randomUUID(), action: 'modify', attribute_id: attrId, attribute: null, ...fieldOverrides },
        ],
      }
    }),

    /**
     * Phase 2.13b — chain-aware mutation of a perspective attribute.
     * Same routing pattern as `setAttrCMOverride`:
     *   - If the active anchor IS the attribute's own origin (an
     *     `action='add'` entry for this attribute is present in this
     *     anchor's draft), mutate the add entry's embedded baseline
     *     attribute. This is the perspective's own origin baseline.
     *   - Otherwise (the active anchor is downstream of the
     *     perspective's origin), upsert a `modify` chain entry with
     *     `new_description` / `new_perspective_target_kind` /
     *     `new_perspective_target_id` per the Phase 2.13b per-field
     *     payload. Re-edits at the same anchor replace the existing
     *     modify entry in place rather than appending.
     *
     * `patch` is `{ description?, perspective_target_kind?,
     * perspective_target_id? }`. Only fields present in the patch are
     * applied; fields omitted are left unchanged.
     *
     * Perspectives don't have a name field, so no `name` here. They
     * also don't carry intensity. To orphan the target (cascade-
     * compatible null-target shape from Phase 2.13a), pass
     * `perspective_target_kind: null` AND `perspective_target_id: null`
     * together.
     */
    setAttrPerspectiveOverride: (attrId, patch) => update((base) => {
      const addIdx = base.attribute_changes.findIndex((ac) => ac.action === 'add' && ac.attribute?.id === attrId)
      if (addIdx !== -1) {
        const newPatch = {}
        if ('description'             in patch) newPatch.description             = patch.description
        if ('perspective_target_kind' in patch) newPatch.perspective_target_kind = patch.perspective_target_kind
        if ('perspective_target_id'   in patch) newPatch.perspective_target_id   = patch.perspective_target_id
        return {
          ...base,
          attribute_changes: base.attribute_changes.map((ac, i) =>
            i === addIdx ? { ...ac, attribute: { ...ac.attribute, ...newPatch } } : ac
          ),
        }
      }
      const existingIdx = base.attribute_changes.findIndex((ac) => ac.action === 'modify' && ac.attribute_id === attrId)
      const fieldOverrides = {}
      if ('description'             in patch) fieldOverrides.new_description             = patch.description
      if ('perspective_target_kind' in patch) fieldOverrides.new_perspective_target_kind = patch.perspective_target_kind
      if ('perspective_target_id'   in patch) fieldOverrides.new_perspective_target_id   = patch.perspective_target_id
      if (existingIdx !== -1) {
        return {
          ...base,
          attribute_changes: base.attribute_changes.map((ac, i) =>
            i === existingIdx ? { ...ac, ...fieldOverrides } : ac
          ),
        }
      }
      return {
        ...base,
        attribute_changes: [
          ...base.attribute_changes,
          { id: crypto.randomUUID(), action: 'modify', attribute_id: attrId, attribute: null, ...fieldOverrides },
        ],
      }
    }),

    setAttrOverride: (attrId, value) => update((base) => {
      // If this attribute was added at this same node, update the add entry's value in place
      const addIdx = base.attribute_changes.findIndex((ac) => ac.action === 'add' && ac.attribute?.id === attrId)
      if (addIdx !== -1) {
        return {
          ...base,
          attribute_changes: base.attribute_changes.map((ac, i) =>
            i === addIdx ? { ...ac, attribute: { ...ac.attribute, value } } : ac
          ),
        }
      }
      return {
        ...base,
        attribute_changes: base.attribute_changes.some((ac) => ac.action === 'modify' && ac.attribute_id === attrId)
          ? base.attribute_changes.map((ac) => ac.action === 'modify' && ac.attribute_id === attrId ? { ...ac, new_value: value } : ac)
          : [...base.attribute_changes, { id: crypto.randomUUID(), action: 'modify', attribute_id: attrId, attribute: null, new_value: value }],
      }
    }),

    // Media attribute helper. `fileRef` is either a new "assets/…" path, or "" to clear
    // the file at this chain position without removing the attribute itself.
    setAttrFileRefOverride: (attrId, fileRef) => update((base) => {
      // If this attribute was added at this same node, update the add entry's file_ref in place.
      // Mirror both `file_ref` and `value` on the embedded attribute, matching the create-time
      // pattern in EntityDetailPanel where both fields are kept in lockstep for media attributes.
      const addIdx = base.attribute_changes.findIndex((ac) => ac.action === 'add' && ac.attribute?.id === attrId)
      if (addIdx !== -1) {
        return {
          ...base,
          attribute_changes: base.attribute_changes.map((ac, i) =>
            i === addIdx ? { ...ac, attribute: { ...ac.attribute, file_ref: fileRef || null, value: fileRef || '' } } : ac
          ),
        }
      }
      return {
        ...base,
        attribute_changes: base.attribute_changes.some((ac) => ac.action === 'modify' && ac.attribute_id === attrId)
          ? base.attribute_changes.map((ac) => ac.action === 'modify' && ac.attribute_id === attrId ? { ...ac, file_ref_change: fileRef } : ac)
          : [...base.attribute_changes, { id: crypto.randomUUID(), action: 'modify', attribute_id: attrId, attribute: null, file_ref_change: fileRef }],
      }
    }),

    // Number attribute helper. `numberValue` is a finite float, or null to
    // clear the numeric value at this chain position. Mirrors
    // `setAttrFileRefOverride`: if the attribute was ADDED at this same node
    // (the draft holds its `add` entry — also the origin-edit path, where the
    // panel's add-fallback ternary seeds the draft from `entity.attributes`),
    // mutate the embedded attribute's `number_value` in place; that add entry
    // IS the attribute's origin baseline. Otherwise (this anchor is downstream
    // of the attribute's origin) upsert a `modify` chain entry carrying
    // `new_number_value`. Re-edits at the same anchor replace in place rather
    // than appending. The chain walker reads `new_number_value` via a
    // hasOwnProperty check, so an explicit null is a real "clear" event.
    setAttrNumberOverride: (attrId, numberValue) => update((base) => {
      const addIdx = base.attribute_changes.findIndex((ac) => ac.action === 'add' && ac.attribute?.id === attrId)
      if (addIdx !== -1) {
        return {
          ...base,
          attribute_changes: base.attribute_changes.map((ac, i) =>
            i === addIdx ? { ...ac, attribute: { ...ac.attribute, number_value: numberValue } } : ac
          ),
        }
      }
      return {
        ...base,
        attribute_changes: base.attribute_changes.some((ac) => ac.action === 'modify' && ac.attribute_id === attrId)
          ? base.attribute_changes.map((ac) => ac.action === 'modify' && ac.attribute_id === attrId ? { ...ac, new_number_value: numberValue } : ac)
          : [...base.attribute_changes, { id: crypto.randomUUID(), action: 'modify', attribute_id: attrId, attribute: null, new_number_value: numberValue }],
      }
    }),

    clearAttrOverride: (attrId) => updateOrNull((base) => ({
      ...base,
      attribute_changes: base.attribute_changes.filter((ac) => !(ac.action === 'modify' && ac.attribute_id === attrId)),
    })),

    // ── List attribute helpers (text_list / entity_list) ────────────────────
    // Mid-chain list edits are stored granularly: each add is a `list_add`
    // entry, each remove is a `list_remove` entry, both keyed by attribute_id
    // with the single changed item in `list_item`. `computeEffectiveState`
    // applies them sequentially per attribute to produce the effective list.
    //
    // If the attribute was ADDED at this same node (draft contains an `add`
    // entry for it), we mutate the embedded attribute's `value` JSON array
    // directly instead of writing list_add / list_remove entries — those
    // would be redundant since the add entry already carries the full list.
    //
    // The helpers also fold against each other: adding an item that has a
    // pending list_remove removes the list_remove instead of adding a new
    // list_add, and vice versa. Keeps the draft minimal and makes Save
    // commits idempotent with respect to user ping-pong.

    addListItem: (attrId, item) => update((base) => {
      if (!item) return base
      // At-origin (add entry): mutate the embedded attribute's value array
      const addIdx = base.attribute_changes.findIndex((ac) => ac.action === 'add' && ac.attribute?.id === attrId)
      if (addIdx !== -1) {
        return {
          ...base,
          attribute_changes: base.attribute_changes.map((ac, i) => {
            if (i !== addIdx) return ac
            let list = []
            try { list = JSON.parse(ac.attribute.value || '[]') } catch { /* noop */ }
            if (!Array.isArray(list)) list = []
            if (list.includes(item)) return ac
            return { ...ac, attribute: { ...ac.attribute, value: JSON.stringify([...list, item]) } }
          }),
        }
      }
      // Mid-chain: check for pending list_remove of this item first and
      // cancel it (ping-pong fold), otherwise append a list_add.
      const pendingRemoveIdx = base.attribute_changes.findIndex(
        (ac) => ac.action === 'list_remove' && ac.attribute_id === attrId && ac.list_item === item
      )
      if (pendingRemoveIdx !== -1) {
        return {
          ...base,
          attribute_changes: base.attribute_changes.filter((_, i) => i !== pendingRemoveIdx),
        }
      }
      // Skip if a matching list_add is already pending
      if (base.attribute_changes.some((ac) => ac.action === 'list_add' && ac.attribute_id === attrId && ac.list_item === item)) {
        return base
      }
      return {
        ...base,
        attribute_changes: [...base.attribute_changes, { id: crypto.randomUUID(), action: 'list_add', attribute_id: attrId, list_item: item }],
      }
    }),

    removeListItem: (attrId, item) => updateOrNull((base) => {
      if (!item) return base
      // At-origin (add entry): mutate the embedded attribute's value array
      const addIdx = base.attribute_changes.findIndex((ac) => ac.action === 'add' && ac.attribute?.id === attrId)
      if (addIdx !== -1) {
        return {
          ...base,
          attribute_changes: base.attribute_changes.map((ac, i) => {
            if (i !== addIdx) return ac
            let list = []
            try { list = JSON.parse(ac.attribute.value || '[]') } catch { /* noop */ }
            if (!Array.isArray(list)) list = []
            return { ...ac, attribute: { ...ac.attribute, value: JSON.stringify(list.filter((x) => x !== item)) } }
          }),
        }
      }
      // Mid-chain: cancel any pending list_add for this item first
      const pendingAddIdx = base.attribute_changes.findIndex(
        (ac) => ac.action === 'list_add' && ac.attribute_id === attrId && ac.list_item === item
      )
      if (pendingAddIdx !== -1) {
        return {
          ...base,
          attribute_changes: base.attribute_changes.filter((_, i) => i !== pendingAddIdx),
        }
      }
      // Skip if a matching list_remove is already pending
      if (base.attribute_changes.some((ac) => ac.action === 'list_remove' && ac.attribute_id === attrId && ac.list_item === item)) {
        return base
      }
      return {
        ...base,
        attribute_changes: [...base.attribute_changes, { id: crypto.randomUUID(), action: 'list_remove', attribute_id: attrId, list_item: item }],
      }
    }),

    addAttrChange: (attr) => update((base) => ({
      ...base,
      attribute_changes: [...base.attribute_changes, { id: crypto.randomUUID(), action: 'add', attribute: attr }],
    })),

    removeAttrChange: (attrId) => update((base) => {
      if (base.attribute_changes.some((ac) => ac.action === 'remove' && ac.attribute_id === attrId)) return base
      // Remove supersedes any list_add/list_remove ops for this attribute — the whole attribute is gone.
      const filtered = base.attribute_changes.filter(
        (ac) => !((ac.action === 'list_add' || ac.action === 'list_remove') && ac.attribute_id === attrId)
      )
      return { ...base, attribute_changes: [...filtered, { id: crypto.randomUUID(), action: 'remove', attribute_id: attrId }] }
    }),

    undoAttrRemove: (attrId) => updateOrNull((base) => ({
      ...base,
      attribute_changes: base.attribute_changes.filter((ac) => !(ac.action === 'remove' && ac.attribute_id === attrId)),
    })),

    revokeAttrAdd: (attrId) => updateOrNull((base) => ({
      ...base,
      attribute_changes: base.attribute_changes.filter((ac) => !(ac.action === 'add' && ac.attribute?.id === attrId)),
    })),

    renameAttr: (attrId, newName) => update((base) => {
      const existing = base.attribute_changes
      const idx = existing.findIndex((ac) => ac.action === 'rename' && ac.attribute_id === attrId)
      const prior = idx >= 0 ? existing[idx] : null
      const entry = { id: prior?.id || crypto.randomUUID(), action: 'rename', attribute_id: attrId, new_name: newName }
      return {
        ...base,
        attribute_changes: idx >= 0
          ? existing.map((ac, i) => i === idx ? entry : ac)
          : [...existing, entry],
      }
    }),

    clearAttrRename: (attrId) => updateOrNull((base) => ({
      ...base,
      attribute_changes: base.attribute_changes.filter((ac) => !(ac.action === 'rename' && ac.attribute_id === attrId)),
    })),

  }
}
