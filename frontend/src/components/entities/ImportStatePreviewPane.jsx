/**
 * ImportStatePreviewPane — Phase 1.12b Track 5.
 *
 * Renders the walked state of one imported entity at a specific
 * state-point, so the user can see exactly what they'll be importing
 * before committing. Lives at the bottom of the Import dialog, below
 * the picker + timeline grid, as a fixed-height horizontal strip.
 *
 * Driven by two props:
 *   - `previewedEntityId`: the entity whose state we want to show
 *     (null = no preview, pane shows empty-state message)
 *   - the current pick for that entity, looked up from
 *     `importPicks` by the parent before passing in as
 *     `previewedPick`. If the pick doesn't exist, the pane shows
 *     "no state chosen yet" placeholder.
 *
 * The pane fetches the walked state via
 * `POST /api/project/import/entity_state` and caches the result by
 * cache key `entity_id + ':' + kind + ':' + (scene_id || modifier_node_id || '')`.
 * A second click on the same dot hits the cache — no network call.
 *
 * 3-column layout matches the existing sidebar Detail / Attributes /
 * Relationships tabs so the user's mental model carries over from
 * the normal detail panel.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TYPE_ICONS } from '../../utils/entityHelpers'
import ImageHoverPreview from '../ui/ImageHoverPreview'

/** Describe a pick in human-readable form for the pane header. */
function describePick(pick, columnsById) {
  if (!pick) return 'no state chosen yet'
  if (pick.kind === 'origin') return 'Origin state'
  if (pick.kind === 'final')  return 'Final state (end of chain)'
  if (pick.kind === 'modifier') return 'Modifier node'
  if (pick.kind === 'scene') {
    const col = columnsById.get(pick.scene_id)
    return col ? `Scene: ${col.title}` : `Scene ${pick.scene_id}`
  }
  return String(pick.kind)
}

function buildCacheKey(entityId, pick) {
  if (!entityId || !pick) return null
  const sub = pick.scene_id || pick.modifier_node_id || ''
  return `${entityId}:${pick.kind}:${sub}`
}

/**
 * Resolve the picked dot's effective profile image data URI from the
 * preview row. Backend `_build_entity_rows` embeds an
 * `effective_profile_image_data_uri` on every scene + modifier dot
 * (Phase 1.12c v0.1.12.57), plus a `final_profile_image_data_uri`
 * on the row. This reads the one that matches the current pick, so
 * the preview pane shows the profile image that's active at the
 * user's chosen state-point — not the origin image.
 *
 * Falls back to the row's origin `profile_image_data_uri` whenever
 * the expected effective field is missing (e.g. old preview payloads
 * from before v0.1.12.57).
 */
function resolveEffectiveProfileSrc(previewRow, pick) {
  if (!previewRow) return null
  const origin = previewRow.profile_image_data_uri || null
  if (!pick) return origin
  if (pick.kind === 'origin') return origin
  if (pick.kind === 'final') {
    return previewRow.final_profile_image_data_uri || origin
  }
  const dots = previewRow.dots || []
  if (pick.kind === 'scene') {
    const dot = dots.find((d) => !d.is_modifier && d.column_id === pick.scene_id)
    return dot?.effective_profile_image_data_uri || origin
  }
  if (pick.kind === 'modifier') {
    const dot = dots.find((d) => d.is_modifier && d.modifier_node_id === pick.modifier_node_id)
    return dot?.effective_profile_image_data_uri || origin
  }
  return origin
}

/**
 * Thumbnail identical to the picker's `EntityThumb` — kept local so
 * the preview pane is self-contained. Border colour comes from the
 * walked entity (so it reflects the effective colour at the chosen
 * state-point). Profile image source is resolved from the preview
 * row via `resolveEffectiveProfileSrc` so it matches the effective
 * state at the picked chain point — the backend embeds a data URI
 * per dot in the preview payload since direct <img src> to the
 * SOURCE project's assets isn't possible from the import dialog.
 */
function PreviewThumb({ entity, effectiveSrc }) {
  const colour = entity?.colour || '#888888'
  const src    = effectiveSrc || null
  return (
    <ImageHoverPreview src={src} borderColour={colour} size={120}>
      {src ? (
        <img
          src={src}
          alt=""
          className="w-12 h-12 rounded-sm object-cover flex-shrink-0"
          style={{ border: `2px solid ${colour}` }}
        />
      ) : (
        <span
          className="w-12 h-12 rounded-sm flex items-center justify-center flex-shrink-0 text-xl"
          style={{ backgroundColor: colour + '22', border: `2px solid ${colour}` }}
        >
          {TYPE_ICONS[entity?.type] || '?'}
        </span>
      )}
    </ImageHoverPreview>
  )
}

// ── Component ───────────────────────────────────────────────────────

export default function ImportStatePreviewPane({
  sessionId,
  previewedEntityId,
  previewedPick,
  previewEntities,              // raw preview.entities list — for type / thumb fallback
  previewKnowledges = [],        // raw preview.knowledges list — for Knowledge row preview
  gridColumns,                  // preview.columns, used for scene title lookups
  addedIds,                     // Set<entityId> of entities currently in the grid
}) {
  // Fetch cache: key → walked Entity JSON.
  const cacheRef = useRef(new Map())
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState(null)
  const [walked, setWalked]   = useState(null)

  // Fast lookups for the header / relationship iteration.
  const columnsById = useMemo(() => {
    const m = new Map()
    for (const c of gridColumns || []) m.set(c.id, c)
    return m
  }, [gridColumns])

  const previewEntitiesById = useMemo(() => {
    const m = new Map()
    for (const e of previewEntities || []) m.set(e.id, e)
    return m
  }, [previewEntities])

  const previewKnowledgesById = useMemo(() => {
    const m = new Map()
    for (const k of previewKnowledges || []) m.set(k.id, k)
    return m
  }, [previewKnowledges])

  // The source preview row for the currently-previewed entity —
  // carries the type + data-URI fallback + source colour. Knowledge
  // rows fall through to `previewKnowledgesById` instead.
  const previewRow = previewedEntityId
    ? (previewEntitiesById.get(previewedEntityId) || previewKnowledgesById.get(previewedEntityId))
    : null
  const isKnowledgeRow = !!(previewedEntityId && previewKnowledgesById.has(previewedEntityId))

  const cacheKey = buildCacheKey(previewedEntityId, previewedPick)

  // Fetch walked state on cache miss. Knowledge rows hit the parallel
  // `/knowledge_state` endpoint; the returned shape carries no
  // attributes / relationships fields (Knowledge has neither).
  const fetchWalked = useCallback(async (key, rowId, pick, asKnowledge) => {
    if (cacheRef.current.has(key)) {
      setWalked(cacheRef.current.get(key))
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const url = asKnowledge
        ? '/api/project/import/knowledge_state'
        : '/api/project/import/entity_state'
      const body = asKnowledge
        ? {
            session_id: sessionId,
            knowledge_id: rowId,
            state_point: {
              kind: pick.kind,
              scene_id: pick.scene_id || null,
            },
          }
        : {
            session_id: sessionId,
            entity_id: rowId,
            state_point: {
              kind: pick.kind,
              scene_id: pick.scene_id || null,
              modifier_node_id: pick.modifier_node_id || null,
            },
          }
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        let detail = 'Failed to load state preview.'
        try {
          const data = await res.json()
          if (data?.detail) detail = data.detail
        } catch { /* swallow */ }
        throw new Error(detail)
      }
      const data = await res.json()
      const result = asKnowledge
        ? { ...(data.knowledge || {}), _kind: 'knowledge' }
        : data.entity
      cacheRef.current.set(key, result)
      setWalked(result)
    } catch (err) {
      setError(err?.message || 'Failed to load state preview.')
      setWalked(null)
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  // Trigger fetch whenever the key changes.
  useEffect(() => {
    if (!sessionId || !previewedEntityId || !previewedPick) {
      setWalked(null)
      setError(null)
      return
    }
    fetchWalked(cacheKey, previewedEntityId, previewedPick, isKnowledgeRow)
  }, [sessionId, previewedEntityId, previewedPick, cacheKey, fetchWalked, isKnowledgeRow])

  // Clear cache when the session changes (new project file loaded).
  useEffect(() => {
    cacheRef.current = new Map()
  }, [sessionId])

  // ── Render ─────────────────────────────────────────────────────

  // Empty state — no previewed entity yet.
  if (!previewedEntityId) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-zinc-600 text-center px-4">
        Click a dot or row in the timeline grid to preview the state you'll import.
      </div>
    )
  }

  if (!previewedPick) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-zinc-500 text-center px-4">
        {previewRow?.name || 'Entity'} — no state-point chosen yet. Click a dot on its row to pick one.
      </div>
    )
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-zinc-500">
        Walking {previewRow?.name || 'entity'} chain…
      </div>
    )
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-red-400 text-center px-4">
        {error}
      </div>
    )
  }

  if (!walked) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-zinc-600">
        No state to display.
      </div>
    )
  }

  const colour = walked.colour || previewRow?.colour || '#888888'
  const description = walked.description || '(no description)'
  const attributes = walked.attributes || []
  const relationships = walked.relationships || []
  const isKnowledge = walked._kind === 'knowledge'
  // Knowledge awareness: dict of source-entity-id → level. We resolve
  // the entity ids against the source preview's entity list to show
  // readable names; ids that aren't in the source library (shouldn't
  // happen, but defensive) fall back to the raw id.
  const knowledgeAwarenessEntries = isKnowledge && walked.awareness && typeof walked.awareness === 'object'
    ? Object.entries(walked.awareness)
    : []

  return (
    <div className="h-full flex flex-col">
      {/* ── Header strip: thumb + name + state description ────────── */}
      <div data-help-region="entity-import:preview_header" className="flex items-center gap-3 px-4 py-2 border-b border-zinc-700 bg-zinc-900/60 flex-shrink-0">
        <PreviewThumb
          entity={walked}
          effectiveSrc={resolveEffectiveProfileSrc(previewRow, previewedPick)}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold" style={{ color: colour }}>
              {walked.name}
            </span>
            <span className="text-[10px] opacity-60" title={isKnowledge ? 'Knowledge' : walked.type}>
              {isKnowledge ? (TYPE_ICONS.knowledge || '🧠') : (TYPE_ICONS[walked.type] || '?')}
            </span>
          </div>
          <div className="text-[10px] text-zinc-500 truncate">
            {describePick(previewedPick, columnsById)}
          </div>
        </div>
      </div>

      {/* ── 3-column body — Knowledge uses a 2-column layout (Details +
          Awareness) since Knowledge has no attributes or relationships;
          entities keep the 3-column Details | Attributes | Relationships
          layout. */}
      <div data-help-region="entity-import:preview_body" className="flex-1 min-h-0 flex text-xs">

        {/* DETAILS — description + scalar fields */}
        <div className="flex-1 border-r border-zinc-700 overflow-y-auto p-3">
          <div className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider mb-1">
            Details
          </div>
          <div className="text-zinc-300 whitespace-pre-wrap break-words">
            {description}
          </div>
        </div>

        {isKnowledge && (
          <div className="flex-1 overflow-y-auto p-3">
            <div className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider mb-1">
              Awareness
              {knowledgeAwarenessEntries.length > 0 && (
                <span className="text-accent-400 ml-1 normal-case">({knowledgeAwarenessEntries.length})</span>
              )}
            </div>
            {walked.awareness == null && (
              <div className="text-[10px] text-zinc-600 italic">tracking off at this state-point</div>
            )}
            {walked.awareness != null && knowledgeAwarenessEntries.length === 0 && (
              <div className="text-[10px] text-zinc-600 italic">no observers yet</div>
            )}
            {knowledgeAwarenessEntries.map(([sourceEntityId, level]) => {
              const observerRow = previewEntitiesById.get(sourceEntityId)
              const observerName = observerRow?.name || sourceEntityId
              const observerColour = observerRow?.colour || '#a1a1aa'
              const willBeDropped = !addedIds || !addedIds.has(sourceEntityId)
              return (
                <div
                  key={sourceEntityId}
                  className={`mb-1 last:mb-0 p-1.5 rounded ${
                    willBeDropped ? 'bg-amber-900/20 border border-amber-800/40' : 'bg-zinc-800/60'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-medium" style={{ color: observerColour }}>
                      {observerName}
                    </span>
                    <span className="text-[10px] text-zinc-400 ml-auto">level {level}</span>
                  </div>
                  {willBeDropped && (
                    <div className="text-[10px] text-amber-400 mt-1 leading-tight">
                      ⚠ will be dropped — observer not in import batch
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* ATTRIBUTES — entity-only */}
        {!isKnowledge && (
        <div className="flex-1 border-r border-zinc-700 overflow-y-auto p-3">
          <div className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider mb-1">
            Attributes
            {attributes.length > 0 && (
              <span className="text-accent-400 ml-1 normal-case">({attributes.length})</span>
            )}
          </div>
          {attributes.length === 0 && (
            <div className="text-[10px] text-zinc-600 italic">no attributes</div>
          )}
          {attributes.map((attr) => {
            const kind = attr.attribute_type || 'text'
            let valueDisplay = attr.value || ''
            if (kind === 'file' && attr.file_ref) {
              valueDisplay = `📎 ${attr.file_ref}`
            } else if (kind === 'preset') {
              valueDisplay = attr.value || '(no value)'
            } else if (kind === 'text_list' || kind === 'entity_list') {
              // The backend stores list values as JSON strings.
              try {
                const arr = JSON.parse(attr.value || '[]')
                valueDisplay = Array.isArray(arr) && arr.length > 0
                  ? arr.join(', ')
                  : '(empty list)'
              } catch {
                valueDisplay = attr.value || '(empty list)'
              }
            }
            return (
              <div key={attr.id} className="mb-1.5 last:mb-0">
                <div className="text-zinc-300 font-medium flex items-center gap-1">
                  {attr.name}
                  <span className="text-[9px] text-zinc-500 uppercase">· {kind}</span>
                </div>
                <div className="text-zinc-400 pl-2 truncate" title={valueDisplay}>
                  {valueDisplay}
                </div>
              </div>
            )
          })}
        </div>

        )}

        {/* RELATIONSHIPS — entity-only */}
        {!isKnowledge && (
        <div className="flex-1 overflow-y-auto p-3">
          <div className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider mb-1">
            Relationships
            {relationships.length > 0 && (
              <span className="text-accent-400 ml-1 normal-case">({relationships.length})</span>
            )}
          </div>
          {relationships.length === 0 && (
            <div className="text-[10px] text-zinc-600 italic">no relationships</div>
          )}
          {relationships.map((rel) => {
            // Determine which side of the relationship the previewed
            // entity sits on. `entity_a_description` / `entity_b_
            // description` are directional — each side has its own
            // description of the relationship, so we pick the one
            // that reads as "how I (the previewed entity) describe
            // this relationship" (same pattern as EntityDetailPanel's
            // RelationshipRow).
            const isA        = rel.entity_a_id === previewedEntityId
            const otherId    = isA ? rel.entity_b_id : rel.entity_a_id
            const myDesc     = (isA ? rel.entity_a_description : rel.entity_b_description) || ''
            const theirDesc  = (isA ? rel.entity_b_description : rel.entity_a_description) || ''
            const otherRow   = previewEntitiesById.get(otherId)
            const otherName  = otherRow?.name || otherId
            const otherColour = otherRow?.colour || '#a1a1aa'
            const willBeDropped = !addedIds || !addedIds.has(otherId)
            return (
              <div
                key={rel.id}
                className={`mb-1.5 last:mb-0 p-1.5 rounded ${
                  willBeDropped ? 'bg-amber-900/20 border border-amber-800/40' : 'bg-zinc-800/60'
                }`}
              >
                <div className="flex items-center gap-1 text-zinc-300">
                  <span className="font-medium" style={{ color: otherColour }}>
                    {otherName}
                  </span>
                </div>
                {/* Description from the previewed entity's side — the
                    primary info the user wants to see when picking
                    an import state-point. */}
                {myDesc && (
                  <div className="text-[10px] text-zinc-300 mt-0.5 leading-tight whitespace-pre-wrap break-words">
                    {myDesc}
                  </div>
                )}
                {/* Reverse description (how the partner describes this
                    entity) — shown below with a ← indicator so the
                    user can see both sides at once. Skipped if empty
                    or if it duplicates the forward description. */}
                {theirDesc && theirDesc !== myDesc && (
                  <div className="text-[10px] text-zinc-500 mt-0.5 leading-tight whitespace-pre-wrap break-words">
                    <span className="text-zinc-600">← </span>{theirDesc}
                  </div>
                )}
                {!myDesc && !theirDesc && (
                  <div className="text-[10px] text-zinc-600 italic mt-0.5">
                    (no description)
                  </div>
                )}
                {willBeDropped && (
                  <div className="text-[10px] text-amber-400 mt-1 leading-tight">
                    ⚠ will be dropped — partner not in import batch
                  </div>
                )}
              </div>
            )
          })}
        </div>
        )}
      </div>
    </div>
  )
}
