import { useCallback, useState } from 'react'
import { useEntitiesStore } from '../../store/entitiesStore'

/**
 * Phase 3.4f Item 7 — shared local-state hook for the host-side
 * read-only TagPopover. Every place a host renders a project-tag
 * chip (Entity / Knowledge / Relationship detail panels + Reference
 * Node canvas body) wants the exact same behaviour when the chip
 * body is clicked: resolve the tag from the project-tag pool, pin
 * a popover next to the clicked badge, show the host browser, close
 * on outside-click / Escape / re-click-the-same-chip.
 *
 * The hook avoids re-duplicating the resolve + anchor-rect + state
 * triple on every surface. Each consumer renders:
 *
 *   const { target, open, close } = useTagBrowsePopover()
 *   ...
 *   <ProjectTagPicker ... onTagClick={open} />
 *   ...
 *   <TagPopover
 *     key={target?.tag?.id || 'closed'}
 *     isOpen={!!target}
 *     onClose={close}
 *     mode="project"
 *     tag={target?.tag}
 *     anchor={target?.anchor}
 *     anchorEl={target?.anchorEl}
 *     readOnly
 *   />
 *
 * The pool read is a flat baseline read of `entitiesStore.projectTags`
 * — tag definitions are not chain-tracked (see `models/tag.py` and
 * the Phase 3.4 planning doc; only tag-on-host membership is
 * chain-tracked, not the pool entries themselves).
 */
export function useTagBrowsePopover() {
  const projectTags = useEntitiesStore((s) => s.projectTags) || []
  const [target, setTarget] = useState(null)

  const open = useCallback((tagId, event) => {
    const tag = projectTags.find((t) => t?.id === tagId)
    if (!tag) return
    let anchor = null
    let anchorEl = null
    if (event?.currentTarget) {
      const r = event.currentTarget.getBoundingClientRect()
      anchor = {
        left: r.left, top: r.top,
        right: r.right, bottom: r.bottom,
        width: r.width, height: r.height,
      }
      anchorEl = event.currentTarget
    }
    setTarget({ tag, anchor, anchorEl })
  }, [projectTags])

  const close = useCallback(() => setTarget(null), [])

  return { target, open, close }
}
