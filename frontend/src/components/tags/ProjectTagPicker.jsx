import { useMemo } from 'react'
import TagPicker from './TagPicker'
import TagBadge from './TagBadge'
import { useEntitiesStore } from '../../store/entitiesStore'

/**
 * Phase 3.4e — Project Tag picker with seamless find-or-create.
 *
 * Thin wrapper around the existing program-tag `TagPicker`. Handles
 * the id ↔ name translation that Project Tags require (the host
 * stores `tag_ids: string[]` of pool-entry UUIDs, but the picker UI
 * thinks in tag names), and the find-or-create routing the writer
 * gets when typing a name that isn't already in the pool.
 *
 * The seamless find-or-create flow (per Phase 3.4 design):
 *
 *   - Writer types `Magic` and presses Enter / clicks a suggestion /
 *     blurs the input.
 *   - If a pool entry exists case-insensitively matching `magic`,
 *     the host gets that pool entry's id. The badge then renders in
 *     the pool entry's stored colour and casing.
 *   - If no match exists, the wrapper POSTs a new pool entry via
 *     `entitiesStore.createProjectTag({name, color})` with the typed
 *     name (`#`-stripped, casing preserved) and the default colour
 *     `#888888`. The host gets the returned id. No explicit
 *     "Create tag?" confirmation step — the writer types and
 *     confirms once, the wrapper routes silently.
 *
 * Detach (`×` on a chip) calls `onRemove(tagId)` directly — the
 * caller's store action strips the id from the host's `tag_ids`.
 *
 * Props:
 *   - `currentTagIds`     — host's currently effective tag ids at the
 *                           active anchor (the chain walker's
 *                           resolved set). Drives which chips render.
 *   - `baselineTagIds?`   — host's raw baseline `tag_ids` field, only
 *                           supplied when the host is chain-trackable
 *                           (Entity / Knowledge / Relationship detail
 *                           panels). Per chip: if its id is in this
 *                           set → solid `TagBadge` (attached at the
 *                           host's origin); else → dashed (attached
 *                           via a chain event). When this prop is
 *                           omitted entirely (Reference Node, Preset
 *                           List, library uses, the standalone demo)
 *                           every chip renders solid — today's
 *                           pre-3.4f behaviour.
 *   - `onAdd(tagId)`      — called with the resolved pool-entry id
 *                           (existing OR freshly-created)
 *   - `onRemove(tagId)`   — called with the id being detached
 *   - `onTagClick?(tagId, event)` — optional; invoked when the writer
 *                           clicks the body of an attached chip (NOT
 *                           the `×` detach button). The host wires
 *                           this to open `TagPopover` in read-only
 *                           mode for the click-through-to-other-hosts
 *                           browser (Phase 3.4f Item 7). When absent,
 *                           the chip body is non-interactive — the
 *                           library's edit popover doesn't open from
 *                           the picker, only from the Tags & Lists
 *                           tab.
 *   - `placeholder?`      — input placeholder; defaults to
 *                           "Add project tag…"
 *   - `autoFocus?`        — passes through to TagPicker
 *
 * Caller responsibility: persist the resulting tag_ids list. This
 * component is pure UI — no chain-aware writes, no store mutation
 * beyond the find-or-create POST (which mutates the project tag
 * pool, NOT any host).
 *
 * Out of scope here (lands in Phase 3.4f):
 *   - Mounting on host detail panels (Entity / Knowledge /
 *     Relationship / Reference Node / Preset List).
 *   - Chain-aware writes — when the active anchor is downstream of
 *     the host's origin, attach / detach must route through
 *     `tag_changes` chain events instead of the baseline
 *     `tag_ids` array. The host's parent component decides which
 *     path applies based on its isOrigin / chain-anchor context;
 *     this picker is the same UI either way.
 */
export default function ProjectTagPicker({
  currentTagIds,
  baselineTagIds,
  onAdd,
  onRemove,
  onTagClick,
  placeholder = 'Add tag…',
  autoFocus = false,
}) {
  const projectTags = useEntitiesStore((s) => s.projectTags) || []
  const createProjectTag = useEntitiesStore((s) => s.createProjectTag)

  // id → pool entry, and name → id (case-insensitive), built once
  // per pool change. Both lookups are used in the find-or-create
  // path + the chip render.
  const byId = useMemo(() => {
    const m = new Map()
    for (const t of projectTags) {
      if (t?.id) m.set(t.id, t)
    }
    return m
  }, [projectTags])

  const byNameLower = useMemo(() => {
    const m = new Map()
    for (const t of projectTags) {
      if (t?.name) m.set(t.name.toLowerCase(), t)
    }
    return m
  }, [projectTags])

  // Per-chip dashed-or-solid decision lives here. Rule:
  //   id in baseline → solid (attached at the host's origin)
  //   id not in baseline → dashed (attached only via a chain event
  //                                somewhere on the host's chain)
  // When `baselineTagIds` isn't supplied at all (Reference Node /
  // Preset List / library / standalone), `baselineSet` stays null and
  // every chip renders solid — chain-attribution doesn't apply.
  // Building a Set once per prop change keeps the per-chip lookup
  // O(1) inside `renderAttachedChip`.
  const baselineSet = useMemo(() => {
    if (!Array.isArray(baselineTagIds)) return null
    return new Set(baselineTagIds)
  }, [baselineTagIds])

  // The TagPicker thinks in tag-name strings. Translate the host's
  // tag_ids into the names of their pool entries; drop any id whose
  // pool entry no longer exists (defensive — should never happen in
  // a well-formed save).
  const currentTagNames = useMemo(() => {
    const out = []
    for (const id of (currentTagIds || [])) {
      const t = byId.get(id)
      if (t?.name) out.push(t.name)
    }
    return out
  }, [currentTagIds, byId])

  // No autocomplete dropdown: the writer types the literal name, and
  // the find-or-create in `handleAdd` does the lookup silently. Pass
  // an empty suggestions array so TagPicker never renders the
  // dropdown — the "Press Enter to create…" hint still surfaces when
  // the query is non-empty and that's the only popover the writer
  // needs to see.
  const suggestedTags = []

  // Find-or-create on add. The input here is a plain name string
  // (the TagPicker normalised the casing for display but passes
  // through the typed value). We re-normalise once more (lowercase
  // lookup), and rely on the backend POST's `#`-strip + casing
  // preservation when the pool entry needs creation.
  const handleAdd = async (rawName) => {
    const typed = (rawName || '').replace(/^#+/, '').trim()
    if (!typed) return
    const existing = byNameLower.get(typed.toLowerCase())
    if (existing) {
      // Already attached → silent no-op so #Foo / Foo can't fire a
      // redundant onAdd for an id already in currentTagIds.
      if ((currentTagIds || []).includes(existing.id)) return
      onAdd?.(existing.id)
      return
    }
    try {
      const created = await createProjectTag({ name: typed, color: '#888888' })
      if (created?.id) onAdd?.(created.id)
    } catch (err) {
       
      console.warn('[ProjectTagPicker] createProjectTag failed:', err)
    }
  }

  // Detach: TagPicker hands us back a name string. Resolve it to an
  // id via the same lookup and pass that to the caller.
  const handleRemove = (rawName) => {
    const t = byNameLower.get((rawName || '').toLowerCase())
    if (t?.id) onRemove?.(t.id)
  }

  // Render-prop hook so the attached chip uses `TagBadge` in the
  // pool entry's actual colour, NOT the muted default chip. Also
  // sets `chainAdded` per the baselineSet rule above: solid when
  // the id is in the host's baseline tag_ids, dashed when it isn't.
  // When `baselineSet` is null (prop wasn't supplied) every chip
  // stays solid — the picker is in a non-chain context.
  const renderAttachedChip = (name, { onRemove: detach }) => {
    const t = byNameLower.get((name || '').toLowerCase())
    const chainAdded = baselineSet !== null && t?.id ? !baselineSet.has(t.id) : false
    const handleClick = onTagClick && t?.id
      ? (e) => onTagClick(t.id, e)
      : undefined
    return (
      <TagBadge
        name={name}
        color={t?.color || '#888888'}
        size="sm"
        chainAdded={chainAdded}
        onClick={handleClick}
        onRemove={detach}
      />
    )
  }

  // Hint copy under the input. Three states depending on whether
  // the typed query matches an existing pool entry AND whether the
  // host already carries it:
  //   - matches AND attached → "already attached" (Enter would no-op)
  //   - matches but NOT attached → "already exists, Enter to attach"
  //   - no match              → "Enter to create a new tag"
  //
  // The leading `#` is stripped before lookup AND for display so
  // typing `#Foo` and `Foo` produce the same hint (mirrors the same
  // `#`-strip in `handleAdd`'s find-or-create routing).
  const addNewLabelFor = (query) => {
    const cleaned = (query || '').replace(/^#+/, '').trim()
    if (!cleaned) return null
    const existing = byNameLower.get(cleaned.toLowerCase())
    if (existing) {
      const alreadyAttached = (currentTagIds || []).includes(existing.id)
      if (alreadyAttached) {
        return (
          <span className="text-amber-400 not-italic">
            Tag &quot;{existing.name}&quot; is already attached.
          </span>
        )
      }
      return <>Tag &quot;{existing.name}&quot; already exists. Press Enter to attach.</>
    }
    return <>Press Enter to create a new tag &quot;{cleaned}&quot;.</>
  }

  return (
    // `contents` wrapper is layout-neutral (renders no box): it carries the
    // shared project-tag concept tag without affecting TagPicker's flow. The
    // inventory points `component` at this file, the real picker.
    <div className="contents" data-help-region="project-tag-picker:picker">
      <TagPicker
        currentTags={currentTagNames}
        suggestedTags={suggestedTags}
        onAdd={handleAdd}
        onRemove={handleRemove}
        placeholder={placeholder}
        autoFocus={autoFocus}
        renderAttachedChip={renderAttachedChip}
        addNewLabelFor={addNewLabelFor}
        chipsPosition="below"
        compact
        showAddButton
      />
    </div>
  )
}
