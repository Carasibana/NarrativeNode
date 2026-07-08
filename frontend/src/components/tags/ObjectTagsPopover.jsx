/**
 * Phase 3.4i — Read-only per-row tag glance popover.
 *
 * Renders inside `ObjectTagsButton`'s portal anchor. Lists every tag
 * the host carries:
 *
 *   ┌─────────────────────────────────────────┐
 *   │ Tags                                [✕] │
 *   ├─────────────────────────────────────────┤
 *   │  [#MAGIC]  [#LORE]                       │   ← baseline tags (solid)
 *   │  ⌐[#CURSED]⌐  ⌐[#ANCIENT]⌐               │   ← chain-added tags (dashed)
 *   └─────────────────────────────────────────┘
 *
 * Baseline tags render with the default solid `TagBadge`; chain-added
 * tags render with `chainAdded` true so they get the dashed-border
 * variant from `TagBadge`. Each group is alphabetical (case-insensitive).
 *
 * Pool-agnostic via props — the parent button already resolved the
 * split before passing in.
 *
 * Read-only: clicking a tag does NOT cycle a filter, open `TagPopover`,
 * or do anything else. It's a glance affordance.
 *
 * Props:
 *   - `hostHeader?`: optional React node rendered to the LEFT of the
 *                    "Tags" label in the header — typically the host's
 *                    identity chip (EntityLabelChip / KnowledgeLabelChip
 *                    / RelationshipLabelChip / etc.) so the writer can
 *                    immediately see WHICH object's tags they're
 *                    looking at without having to remember which row
 *                    they hovered.
 *   - `baseline`:   `[{ id?, name, color }, ...]` — sorted alphabetical
 *   - `chainAdded`: `[{ id?, name, color }, ...]` — sorted alphabetical
 *   - `onClose`:    handler for the header `✕`
 *   - `size?`:      passed through to inner `TagBadge`. Defaults `'sm'`.
 *
 * Layout / open behaviour is owned by `ObjectTagsButton` — this
 * component renders the inner body only.
 */
import { memo } from 'react'
import TagBadge from './TagBadge'

function ObjectTagsPopover({
  hostHeader = null,
  baseline = [],
  chainAdded = [],
  onClose,
  size = 'sm',
}) {
  const isEmpty = baseline.length === 0 && chainAdded.length === 0

  return (
    <div className="flex flex-col" data-help-region="tag-picker:object_tags_popover">
      {/* Header — optional host-identity badge first (so the writer
          knows WHICH object's tags they're looking at), then the
          "Tags" section label, then the close button on the right. */}
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          {hostHeader}
          <span className="text-[11px] text-zinc-400 uppercase tracking-wider">Tags</span>
        </div>
        {typeof onClose === 'function' && (
          <button
            type="button"
            onClick={onClose}
            className="w-5 h-5 inline-flex items-center justify-center rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-700/60"
            title="Close"
            aria-label="Close tag glance"
          >
            ✕
          </button>
        )}
      </div>

      {/* Empty state */}
      {isEmpty && (
        <div className="text-[10px] italic text-zinc-600 px-1 py-1">
          No tags attached.
        </div>
      )}

      {/* Single flex-wrap container — baseline first (solid border), then
          chain-added (dashed border). One container so baseline and
          chain-added pack onto the same row when there's room, instead
          of always wrapping at the group boundary. The solid-vs-dashed
          distinction rides per-badge via `TagBadge.chainAdded`. */}
      {!isEmpty && (
        <div className="flex flex-wrap items-center gap-1">
          {baseline.map((t) => (
            <TagBadge
              key={`b-${t.id || t.name}`}
              name={t.name || ''}
              color={t.color || '#888888'}
              size={size}
            />
          ))}
          {chainAdded.map((t) => (
            <TagBadge
              key={`c-${t.id || t.name}`}
              name={t.name || ''}
              color={t.color || '#888888'}
              chainAdded
              size={size}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default memo(ObjectTagsPopover)
