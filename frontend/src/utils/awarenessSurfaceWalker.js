/**
 * awarenessSurfaceWalker — shared iteration over every awareness-bearing
 * surface in the project.
 *
 * Extracted in Phase 2.11b to deduplicate the surface-iteration loop
 * that both `awarenessSourceIndex.buildAwarenessSourceConsumers` and
 * `awarenessObserverIndex.buildAwarenessObserverIndex` need. Each
 * consumer used to walk the same set of surfaces (every entity's
 * `awareness` + `name_awareness` + each attribute's `awareness` +
 * each alias's `awareness`, every relationship's `awareness`, every
 * knowledge's `awareness`) and apply its own per-surface logic. With
 * the iteration here, both consumers shrink to the per-surface
 * differentiation that's actually unique to them.
 *
 * This helper covers the HOST-baseline walk only. Chain-time awareness
 * creation (e.g. an alias born mid-chain via a scene-node EntityRef
 * `alias_changes` event with `action='add'`) lives in canvas nodes,
 * not in `entity.aliases[]`. `awarenessSourceIndex` extends this walk
 * with its own canvas-node loop to catch chain-time-born aliases that
 * carry source references. Consumers that need the same coverage for
 * their own indexing target can add an analogous canvas loop (see
 * `awarenessSourceIndex` for the pattern).
 *
 * Visit callback signature:
 *   `visit(awareness, descriptor)`
 *
 *   `awareness` — the awareness wrapper found at this surface, or `null`
 *                 / `undefined` (the helper still calls the callback so
 *                 the consumer can decide whether to treat absence as
 *                 meaningful). Most consumers will return early on a
 *                 falsy wrapper.
 *
 *   `descriptor` — identifies WHICH surface this is. Shape matches the
 *                  one `awarenessSourceIndex` documented as its
 *                  per-emission descriptor (modulo `sourceLevel`, which
 *                  comes from the source object itself, not the
 *                  surface). Fields:
 *
 *     surfaceKind:        'entity' | 'attribute' | 'alias'
 *                       | 'relationship' | 'knowledge'
 *     surfaceId:          string — host id, attribute id, OR alias value
 *                                  (alias surfaces are keyed by value to
 *                                  match the legacy snapshot path).
 *     parentEntityId?:    string — present for `attribute` + `alias`,
 *                                  the entity that owns the surface.
 *     awarenessFieldPath: 'awareness' | 'name_awareness' — distinguishes
 *                                  the entity's own awareness from its
 *                                  name awareness (both live on the
 *                                  entity host).
 */


/**
 * Walk every awareness-bearing surface in the project's host baseline
 * data and invoke `visit(awareness, descriptor)` once per surface.
 *
 * Iteration order is stable and matches the existing `awarenessSourceIndex`
 * order so consumers (including the existing source-consumer index used
 * by `useAlerts`) produce byte-for-byte identical output before and
 * after the refactor:
 *
 *   1. For each entity in `allEntities` (in array order):
 *        a. entity.awareness                              → surfaceKind='entity',        awarenessFieldPath='awareness'
 *        b. entity.name_awareness                         → surfaceKind='entity',        awarenessFieldPath='name_awareness'
 *        c. each attribute in `entity.attributes` (order) → surfaceKind='attribute',     awarenessFieldPath='awareness'
 *        d. each alias in `entity.aliases` (order)        → surfaceKind='alias',         awarenessFieldPath='awareness'
 *   2. For each relationship in `relationships` (order)   → surfaceKind='relationship',  awarenessFieldPath='awareness'
 *   3. For each knowledge in `knowledges` (order)         → surfaceKind='knowledge',     awarenessFieldPath='awareness'
 *
 * Skips entities / attributes / relationships / knowledges missing an
 * id (defensive — same guards source-index applied), and legacy
 * plain-string aliases that carry no awareness wrapper (same guard
 * source-index applied via `typeof alias === 'string'`).
 */
export function forEachAwarenessHostSurface({ allEntities, relationships, knowledges }, visit) {
  for (const ent of (allEntities || [])) {
    if (!ent || !ent.id) continue
    visit(ent.awareness, {
      surfaceKind: 'entity', surfaceId: ent.id, awarenessFieldPath: 'awareness',
    })
    visit(ent.name_awareness, {
      surfaceKind: 'entity', surfaceId: ent.id, awarenessFieldPath: 'name_awareness',
    })
    for (const attr of (ent.attributes || [])) {
      if (!attr || !attr.id) continue
      visit(attr.awareness, {
        surfaceKind: 'attribute', surfaceId: attr.id, parentEntityId: ent.id, awarenessFieldPath: 'awareness',
      })
    }
    for (const alias of (ent.aliases || [])) {
      if (alias == null) continue
      const aliasValue = typeof alias === 'string' ? alias : alias.value
      const aliasAwareness = typeof alias === 'string' ? null : alias.awareness
      if (!aliasValue) continue
      visit(aliasAwareness, {
        surfaceKind: 'alias', surfaceId: aliasValue, parentEntityId: ent.id, awarenessFieldPath: 'awareness',
      })
    }
  }

  for (const rel of (relationships || [])) {
    if (!rel || !rel.id) continue
    visit(rel.awareness, {
      surfaceKind: 'relationship', surfaceId: rel.id, awarenessFieldPath: 'awareness',
    })
  }

  for (const k of (knowledges || [])) {
    if (!k || !k.id) continue
    visit(k.awareness, {
      surfaceKind: 'knowledge', surfaceId: k.id, awarenessFieldPath: 'awareness',
    })
  }
}
