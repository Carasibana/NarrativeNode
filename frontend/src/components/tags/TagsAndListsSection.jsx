import { useEffect, useMemo, useState } from 'react'
import TagBadge from './TagBadge'
import TagPopover from './TagPopover'
import { useEntitiesStore } from '../../store/entitiesStore'
import { useProgramTagsStore } from '../../store/programTagsStore'
import { useProjectStore } from '../../store/projectStore'
import { confirm } from '../../store/dialogStore'

/**
 * Phase 3.4e — "Tags & Lists" tab container.
 *
 * Three vertical groups in order:
 *   1. Project Tags  — pool entries from `entitiesStore.projectTags`
 *                      with usage counts derived from the projectStore
 *                      walker (baseline + chain references, distinct-
 *                      host de-dup).
 *   2. Program Tags  — aggregated pool from `programTagsStore.pool`
 *                      with cue_count + conversation_count from the
 *                      backend aggregation endpoint.
 *   3. Preset Lists  — existing `PresetListsSection`, mounted as-is.
 *
 * Each row in groups 1 + 2:
 *   - Renders `[#TAG NAME] (N)` via `TagBadge` with `count={N}`.
 *   - Click opens the unified `TagPopover` in edit mode.
 *   - Delete button cascades through the standard confirmation
 *     dialog (counts come from the per-pool usage data).
 *
 * Sorting per group: descending by usage count, alphabetical
 * tie-break. Independent per group — the Project Tags sort doesn't
 * affect the Program Tags sort.
 *
 * Props:
 *   - `nameFilter`         — text filter (passed from the panel's
 *                            top-of-tab search input). Matches
 *                            case-insensitively against the tag's
 *                            stored name.
 *   - `presetListsSection` — the existing PresetListsSection element
 *                            mounted as-is for group 3.
 */
export default function TagsAndListsSection({ nameFilter = '', presetListsSection }) {
  // ── Pool state ─────────────────────────────────────────────────
  const projectTags = useEntitiesStore((s) => s.projectTags) || []
  const programPool = useProgramTagsStore((s) => s.pool) || []
  const loadProgramPool = useProgramTagsStore((s) => s.loadPool)

  useEffect(() => { loadProgramPool() }, [loadProgramPool])

  // ── Project Tag usage counts (distinct-host, baseline + chain) ─
  // Walks every chain-trackable + baseline-only host on the
  // projectStore + entitiesStore and counts each host AT MOST ONCE
  // per tag — matching the cascade-strip dialog's "this will strip
  // it from N objects" number.
  const knowledges = useProjectStore((s) => s.knowledges)
  const relationships = useProjectStore((s) => s.relationships)
  const nodes = useProjectStore((s) => s.nodes)
  const characters = useEntitiesStore((s) => s.characters)
  const locations = useEntitiesStore((s) => s.locations)
  const items = useEntitiesStore((s) => s.items)
  const factions = useEntitiesStore((s) => s.factions)
  const customs = useEntitiesStore((s) => s.customs)
  const presetLists = useEntitiesStore((s) => s.presetLists)

  const projectTagCounts = useMemo(() => {
    const tally = {}  // tag_id -> Set of host keys (de-dup per host)
    const bump = (tagId, hostKey) => {
      if (!tagId || !hostKey) return
      if (!tally[tagId]) tally[tagId] = new Set()
      tally[tagId].add(hostKey)
    }

    // Entities — baseline tag_ids.
    for (const bucket of [characters, locations, items, factions, customs]) {
      for (const e of (bucket || [])) {
        for (const id of (e.tag_ids || [])) bump(id, `entity:${e.id}`)
      }
    }
    // Knowledge — baseline + chain events. Distinct-host: knowledge
    // counts once even if its chain has multiple add events.
    for (const k of (knowledges || [])) {
      for (const id of (k.tag_ids || [])) bump(id, `knowledge:${k.id}`)
      for (const ev of (k.history?.tag_changes || [])) {
        if (ev?.action === 'add' && ev.tag_id) bump(ev.tag_id, `knowledge:${k.id}`)
      }
    }
    // Relationships — baseline + chain events.
    for (const r of (relationships || [])) {
      for (const id of (r.tag_ids || [])) bump(id, `relationship:${r.id}`)
      for (const ev of (r.history?.tag_changes || [])) {
        if (ev?.action === 'add' && ev.tag_id) bump(ev.tag_id, `relationship:${r.id}`)
      }
    }
    // Preset lists + Reference nodes — baseline only.
    for (const pl of (presetLists || [])) {
      for (const id of (pl.tag_ids || [])) bump(id, `presetList:${pl.id}`)
    }
    for (const n of (nodes || [])) {
      if (n.type === 'referenceNode') {
        for (const id of (n.data?.tag_ids || [])) bump(id, `referenceNode:${n.id}`)
      }
      // SceneNode EntityRefs — chain tag_changes on per-scene chips.
      if (n.type === 'sceneNode') {
        for (const bucket of ['characters', 'locations', 'items', 'factions', 'customs']) {
          for (const ref of (n.data?.[bucket] || [])) {
            for (const ev of (ref.tag_changes || [])) {
              if (ev?.action === 'add' && ev.tag_id) bump(ev.tag_id, `entity:${ref.entity_id}`)
            }
          }
        }
      }
      // EntityNode modifier-mode tag_changes.
      if (n.type === 'entityNode' && n.data?.is_modifier && n.data?.entity_id) {
        for (const ev of (n.data?.tag_changes || [])) {
          if (ev?.action === 'add' && ev.tag_id) bump(ev.tag_id, `entity:${n.data.entity_id}`)
        }
      }
    }

    const counts = {}
    for (const [id, hostSet] of Object.entries(tally)) counts[id] = hostSet.size
    return counts
  }, [characters, locations, items, factions, customs, knowledges, relationships, nodes, presetLists])

  // ── Sort + filter pipelines ────────────────────────────────────
  const filterLower = (nameFilter || '').toLowerCase().replace(/^#/, '').trim()
  const matchesFilter = (name) => {
    if (!filterLower) return true
    return (name || '').toLowerCase().includes(filterLower)
  }

  const projectTagRows = useMemo(() => {
    const rows = (projectTags || [])
      .filter((t) => matchesFilter(t.name))
      .map((t) => ({ ...t, count: projectTagCounts[t.id] || 0 }))
    rows.sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    return rows
  // matchesFilter closes over filterLower which is derived from nameFilter
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectTags, projectTagCounts, nameFilter])

  const programTagRows = useMemo(() => {
    const rows = (programPool || [])
      .filter((t) => matchesFilter(t.name))
      .map((t) => ({ ...t, count: t.count || 0 }))
    rows.sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    return rows
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [programPool, nameFilter])

  // ── Modal state ────────────────────────────────────────────────
  const [editTarget, setEditTarget] = useState(null)  // { mode, tag, count, anchor } | null

  // Identity used to detect "click same badge again to toggle".
  // Project tags identify by id; program tags by name; create-mode
  // entries have no id/name so a second click on the same "+ New"
  // button is keyed by mode + null sentinel.
  const sameTarget = (current, mode, tag) => {
    if (!current) return false
    if (current.mode !== mode) return false
    if (!tag && !current.tag) return true
    if (!tag || !current.tag) return false
    if (mode === 'project') return current.tag.id === tag.id
    if (mode === 'program') return current.tag.name === tag.name
    return false
  }

  const openEditModal = (mode, tag, count, e) => {
    // Toggle: clicking the same badge / button that's currently
    // anchoring the popover closes it instead of re-opening.
    if (sameTarget(editTarget, mode, tag)) {
      setEditTarget(null)
      return
    }
    // Anchor to the clicked element's bounding rect; popover floats
    // directly above it. We capture BOTH the rect (for layout) and
    // the element reference (so the popover's click-outside handler
    // can recognise clicks on this badge and let its onClick handle
    // the toggle — otherwise the mousedown listener would close the
    // popover before the click event fires, producing a re-open
    // bounce).
    let anchor = null
    let anchorEl = null
    if (e?.currentTarget?.getBoundingClientRect) {
      const r = e.currentTarget.getBoundingClientRect()
      anchor = { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
      anchorEl = e.currentTarget
    }
    setEditTarget({ mode, tag, count, anchor, anchorEl })
  }
  const closeEditModal = () => setEditTarget(null)

  // ── Delete handlers (with cascade-strip confirmation) ──────────
  const deleteObject = useProjectStore((s) => s.deleteObject)

  const handleDeleteProjectTag = async (tag, count) => {
    const noun = count === 1 ? 'object' : 'objects'
    const ok = await confirm({
      title: 'Delete tag',
      message: count > 0
        ? `Remove tag "${tag.name}"? This will strip it from ${count} ${noun}.`
        : `Delete tag "${tag.name}"? Nothing currently uses it.`,
      buttons: [
        { label: 'Delete', value: 'delete', style: 'danger' },
        { label: 'Cancel', value: 'cancel', style: 'default' },
      ],
    })
    if (ok !== 'delete') return
    try {
      await deleteObject('projectTag', tag.id)
    } catch (err) {
      console.error('[delete project tag]', err)
    }
  }

  const handleDeleteProgramTag = async (tag) => {
    // For program tags we want the cascade summary BEFORE confirm so
    // the dialog can list affected host names. Fetch the
    // affected-host preview by calling the DELETE endpoint, but only
    // after the user confirms — to avoid the dialog feeling
    // committed before they say yes.
    const total = tag.count || 0
    const noun = total === 1 ? 'object' : 'objects'
    const ok = await confirm({
      title: 'Delete program tag',
      message: total > 0
        ? `Remove tag "${tag.name}"? This will strip it from ${total} ${noun} (across context cues + conversations).`
        : `Delete tag "${tag.name}"? Nothing currently uses it.`,
      buttons: [
        { label: 'Delete', value: 'delete', style: 'danger' },
        { label: 'Cancel', value: 'cancel', style: 'default' },
      ],
    })
    if (ok !== 'delete') return
    try {
      await deleteObject('programTag', tag.name)
      // Pool entry is stripped locally by `_deleteProgramTagInternal`
      // for instant UI feedback; no need to await the backend
      // round-trip + refresh here.
    } catch (err) {
      console.error('[delete program tag]', err)
    }
  }

  // ── Render ─────────────────────────────────────────────────────
  //
  // Layout: fragment of two zones so `PresetListsSection`'s own
  // flex children (header / scroll-area / "+ New List" footer)
  // compose directly into the panel root, keeping its "+ New List"
  // button pinned at the bottom of the panel just like the other
  // library tabs. The tag-pool groups sit ABOVE the preset section
  // in their own bounded scroll zone so they can grow without
  // displacing the preset list's pinned footer.
  return (
    <>
      <div className="flex-shrink-0 max-h-[40vh] overflow-y-auto p-2 space-y-4 border-b border-zinc-800">
        {/* ── Project Tags group ── */}
        <section data-help-region="tags-and-lists:project_tags" className="space-y-1">
          <header className="flex items-center justify-between px-1 py-1 border-b border-zinc-800">
            <h3 className="text-zinc-400 text-[11px] uppercase tracking-wide font-semibold">
              Project Tags
              <span className="ml-1 text-zinc-600 font-normal normal-case">({projectTagRows.length})</span>
            </h3>
            <button
              type="button"
              data-help-region="tags-and-lists:new_project_tag"
              onClick={(e) => openEditModal('project', null, 0, e)}
              className="text-[10px] px-1.5 py-0.5 rounded bg-accent-700/20 border border-accent-700/40 text-accent-300 hover:bg-accent-700/40"
              title="New project tag"
            >
              + New
            </button>
          </header>
          {projectTagRows.length === 0 ? (
            <div className="text-zinc-500 text-[11px] px-2 py-2 italic">
              No project tags yet. Tag entities, knowledges, or relationships and pool entries appear here.
            </div>
          ) : (
            <div className="flex flex-wrap gap-1 px-1 py-1">
              {projectTagRows.map((tag) => (
                <TagBadge
                  key={tag.id}
                  name={tag.name}
                  color={tag.color}
                  count={tag.count}
                  size="sm"
                  onClick={(e) => openEditModal('project', tag, tag.count, e)}
                  onRemove={() => handleDeleteProjectTag(tag, tag.count)}
                />
              ))}
            </div>
          )}
        </section>

        {/* ── Program Tags group ── */}
        <section data-help-region="tags-and-lists:program_tags" className="space-y-1">
          <header className="flex items-center justify-between px-1 py-1 border-b border-zinc-800">
            <h3 className="text-zinc-400 text-[11px] uppercase tracking-wide font-semibold">
              Program Tags
              <span className="ml-1 text-zinc-600 font-normal normal-case">({programTagRows.length})</span>
            </h3>
            <button
              type="button"
              data-help-region="tags-and-lists:new_program_tag"
              onClick={(e) => openEditModal('program', null, 0, e)}
              className="text-[10px] px-1.5 py-0.5 rounded bg-accent-700/20 border border-accent-700/40 text-accent-300 hover:bg-accent-700/40"
              title="New program tag"
            >
              + New
            </button>
          </header>
          {programTagRows.length === 0 ? (
            <div className="text-zinc-500 text-[11px] px-2 py-2 italic">
              No program tags yet. Tag context cues or conversations and pool entries appear here.
            </div>
          ) : (
            <div className="flex flex-wrap gap-1 px-1 py-1">
              {programTagRows.map((tag) => (
                <TagBadge
                  key={tag.name}
                  name={tag.name}
                  color={tag.color}
                  count={tag.count}
                  size="sm"
                  onClick={(e) => openEditModal('program', tag, tag.count, e)}
                  onRemove={() => handleDeleteProgramTag(tag)}
                />
              ))}
            </div>
          )}
        </section>

      </div>

      {/* ── Preset Lists ── rendered OUTSIDE the bounded scroll
          zone so its own internal flex layout (header / scroll-area
          / "+ New List" footer) composes directly with the panel
          root, keeping the footer pinned at the bottom of the panel
          like the other library tabs. */}
      {presetListsSection}

      <TagPopover
        // Re-key per target so useState initializers re-run and the
        // first paint has the right name/color — no flash of stale
        // state, no propagation-note appearance shifting the
        // popover's height (which would visually look like a
        // bounce on open).
        key={editTarget
          ? `${editTarget.mode}::${editTarget.tag?.id || editTarget.tag?.name || '__new__'}`
          : 'closed'}
        isOpen={!!editTarget}
        onClose={closeEditModal}
        mode={editTarget?.mode}
        tag={editTarget?.tag}
        count={editTarget?.count}
        anchor={editTarget?.anchor}
        anchorEl={editTarget?.anchorEl}
      />
    </>
  )
}
