/**
 * GenericGroupNode — Phase 1.11 Track I.
 *
 * A freeform group container rendered as a React Flow node. Visually a
 * translucent rectangle with a title-bar header and a resize handle.
 * Membership is PURELY GEOMETRIC (see `utils/groupMembership.js`) — this
 * component does not store or track members. Drag of the header moves
 * the box and (via `onNodeDragStart` + `onNodeDrag` at the Canvas level)
 * all currently-contained nodes atomically.
 *
 * Visual layout:
 *
 *   ┌─────────────────────────────────┐ ← header (drag handle, editable title, colour chip)
 *   │                                 │
 *   │           (body — transparent,  │
 *   │            pointer-events:none  │
 *   │            so clicks pass to    │
 *   │            nodes behind)        │
 *   │                                ⟀│ ← resize handle (bottom-right)
 *   └─────────────────────────────────┘
 *
 * The ENTIRE card has `pointer-events: none` by default so it does NOT
 * intercept node selection/drag on the nodes visually inside it. Only
 * the header bar and the resize handle opt back in with
 * `pointer-events: auto`. That way the user can still click the nodes
 * inside the group normally — the group is a decorative / organisational
 * wrapper, not a click-blocker.
 */

import { useRef, useState, useEffect } from 'react'
import { NodeResizeControl, useUpdateNodeInternals } from '@xyflow/react'
import { useProjectStore } from '../../store/projectStore'
import { useUiStore } from '../../store/uiStore'
import { useAccentColor } from '../../utils/povConstants'
import { applyResizeSnap } from '../../utils/snapUtils'
import { useMultiSelectActive } from '../../hooks/useMultiSelectActive'
import EntityColorPicker from '../ui/EntityColorPicker'
import ConceptPorts from './ConceptPorts'

const HEADER_HEIGHT = 26
const MIN_WIDTH = 160
const MIN_HEIGHT = 80

export default function GenericGroupNode({ id, data, selected, width, height }) {
  const updateNodeData = useProjectStore((s) => s.updateNodeData)
  const deleteNode     = useProjectStore((s) => s.deleteNode)
  const accentColor    = useAccentColor()
  const multiSelectActive = useMultiSelectActive()

  const [editingTitle, setEditingTitle] = useState(false)
  const [hovered, setHovered] = useState(false)
  const colourAnchorRef = useRef(null)
  const [colourPickerOpen, setColourPickerOpen] = useState(false)

  const colour = data?.colour || '#71717a'
  const title  = data?.title || ''
  // Phase 8.5 — concept-group mode. Only an EXPLICIT `true` is a concept group;
  // an absent flag (a pre-8.5 group saved before the field existed) reads as a
  // plain organisation container with no concept ports. New groups are created
  // with the flag explicitly true (see `addGroupNode`); the header toggle flips
  // it either way.
  const isConceptGroup = data?.concept_group === true

  // Title edit draft — committed on blur or Enter, NOT per keystroke.
  // Mirrors the SceneNode / ReferenceNode title-edit pattern so each
  // rename produces ONE project-level undo entry (v0.2.9.52 added
  // `title` to `updateNodeData`'s `_snapshot()` trigger; the previous
  // per-keystroke `onChange={(e) => updateNodeData(id, { title: e.target.value })}`
  // pattern would have pushed a snapshot per character — unusable).
  // Escape cancels without commit; blur or Enter commits if changed.
  const [titleDraft, setTitleDraft] = useState(title)
  const titleEditedRef = useRef(false)
  const titleEscapedRef = useRef(false)
  const commitTitleIfChanged = () => {
    if (titleEscapedRef.current) {
      titleEscapedRef.current = false
      titleEditedRef.current = false
      setTitleDraft(title)
      setEditingTitle(false)
      return
    }
    if (titleEditedRef.current && titleDraft !== title) {
      updateNodeData(id, { title: titleDraft })
    }
    titleEditedRef.current = false
    setEditingTitle(false)
  }

  // Effective width/height for the outer div. React Flow passes these
  // from `style` / `measured` as top-level props on the component.
  const w = width ?? data?.width ?? 400
  const h = height ?? data?.height ?? 300

  // Re-measure the concept-port handle bounds after mount and on every size
  // change. The eight ports are positioned with percentage offsets (top/left
  // %), and React Flow's ONE-TIME initial handle measurement can land while
  // the container's percentage basis is still resolving, collapsing all eight
  // bounds onto the top-left corner. Unlike the reference node (whose
  // content-driven height re-fires the resize observer and re-measures for
  // free), the group's size is fixed, so those stale bounds would persist and
  // every concept-wire drag would resolve to the top-left port. Forcing a
  // re-measure here registers the ports at their true positions.
  const updateNodeInternals = useUpdateNodeInternals()
  useEffect(() => {
    updateNodeInternals(id)
  }, [id, w, h, updateNodeInternals])

  return (
    <div
      data-help-region="group-node:node"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: w,
        height: h,
        // The outer card is pointer-events: none so clicks pass through
        // to nodes visually inside the group. Header + resize handle
        // re-enable pointer events below.
        pointerEvents: 'none',
        position: 'relative',
        // Phase 1.11 Track I — dashed accent-colour selection outline
        // only in multi-select. Single-click selection is already
        // indicated by the body border switching from dashed to solid.
        outline: (selected && multiSelectActive) ? `2px dashed ${accentColor}` : undefined,
        outlineOffset: (selected && multiSelectActive) ? 3 : undefined,
        borderRadius: 6,
      }}
    >
      {/* Body — a translucent tinted rectangle. Not clickable. */}
      <div
        data-help-region="group-node:body"
        style={{
          position: 'absolute',
          inset: 0,
          backgroundColor: colour,
          opacity: 0.08,
          borderRadius: 6,
          border: `1.5px ${selected ? 'solid' : 'dashed'} ${colour}`,
          pointerEvents: 'none',
        }}
      />

      {/* Header — the drag handle. Matches the `dragHandle: '.nn-group-drag-handle'`
          selector on the React Flow node so drag is scoped to the header
          ONLY, not the whole group body. Pointer events and cursor are
          set via the global CSS rule in index.css (grab / grabbing). */}
      <div
        data-help-region="group-node:header"
        className="nn-group-drag-handle nowheel"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: HEADER_HEIGHT,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '0 8px',
          backgroundColor: colour,
          borderRadius: '6px 6px 0 0',
          color: '#fafafa',
          fontSize: 11,
          fontWeight: 600,
          userSelect: 'none',
        }}
      >
        {/* Colour picker chip */}
        <button
          type="button"
          ref={colourAnchorRef}
          className="nodrag"
          onClick={() => setColourPickerOpen((o) => !o)}
          title="Set group colour"
          style={{
            flexShrink: 0,
            cursor: 'pointer',
            width: 12,
            height: 12,
            borderRadius: 2,
            border: '1px solid rgba(255, 255, 255, 0.5)',
            backgroundColor: colour,
            padding: 0,
          }}
          aria-label={`Group colour: ${colour}. Click to open picker.`}
        />
        <EntityColorPicker
          value={colour}
          onChange={(hex) => updateNodeData(id, { colour: hex })}
          anchorEl={colourAnchorRef.current}
          isOpen={colourPickerOpen}
          onClose={() => setColourPickerOpen(false)}
        />

        {/* Title — click to edit in-place. Commit on blur or Enter
            (Escape cancels without committing). Per-keystroke writes
            would push a project-level undo snapshot per character
            (v0.2.9.52's updateNodeData snapshot trigger). */}
        {editingTitle ? (
          <input
            className="nodrag"
            autoFocus
            value={titleDraft}
            placeholder="Group title…"
            onFocus={() => { titleEditedRef.current = false; titleEscapedRef.current = false; setTitleDraft(title) }}
            onChange={(e) => { titleEditedRef.current = true; setTitleDraft(e.target.value) }}
            onBlur={commitTitleIfChanged}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.currentTarget.blur() }
              else if (e.key === 'Escape') { titleEscapedRef.current = true; e.currentTarget.blur() }
            }}
            style={{
              flex: 1,
              background: 'rgba(0, 0, 0, 0.25)',
              border: '1px solid rgba(255, 255, 255, 0.35)',
              borderRadius: 2,
              color: '#fafafa',
              fontSize: 11,
              fontWeight: 600,
              padding: '1px 4px',
              outline: 'none',
              minWidth: 0,
            }}
          />
        ) : (
          <span
            onDoubleClick={(e) => { e.stopPropagation(); setEditingTitle(true) }}
            style={{
              flex: 1,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              opacity: title ? 1 : 0.6,
              fontStyle: title ? 'normal' : 'italic',
            }}
            title="Double-click to edit"
          >
            {title || 'Group'}
          </span>
        )}

        {/* Concept-group toggle — flips between a concept / brainstorming group
            (concept ports on, joins the concept graph) and a plain organisation
            container (ports off). Visible on hover only, in both modes, matching
            the delete button beside it. */}
        <button
          className="nodrag"
          onClick={(e) => { e.stopPropagation(); updateNodeData(id, { concept_group: !isConceptGroup }) }}
          title={isConceptGroup
            ? 'Concept group (ports on). Click to make it an organisation-only group.'
            : 'Organisation group (ports off). Click to turn concept mode on.'}
          style={{
            flexShrink: 0,
            background: 'transparent',
            border: 'none',
            color: '#fafafa',
            cursor: 'pointer',
            fontSize: 12,
            lineHeight: 1,
            padding: 0,
            opacity: hovered ? 0.75 : 0,
            transition: 'opacity 0.15s',
          }}
          aria-label={isConceptGroup ? 'Concept group; click to switch to organisation only' : 'Organisation group; click to enable concept mode'}
        >
          {isConceptGroup ? '◈' : '▭'}
        </button>

        {/* Delete button — visible on hover only */}
        <button
          className="nodrag"
          onClick={(e) => { e.stopPropagation(); deleteNode(id) }}
          title="Delete group (contents stay on the canvas)"
          style={{
            flexShrink: 0,
            background: 'transparent',
            border: 'none',
            color: '#fafafa',
            cursor: 'pointer',
            fontSize: 13,
            lineHeight: 1,
            padding: 0,
            opacity: hovered ? 0.7 : 0,
            transition: 'opacity 0.15s',
          }}
        >
          ✕
        </button>
      </div>

      {/* Resize handle — bottom-right. Phase 8.1 (§8.1.5) , shown only when
          selected (matching the reference node and every other node), which
          also keeps the concept-port bottom-right inset rule uniform. Pointer
          events re-enabled. */}
      {selected && (
      <NodeResizeControl
        minWidth={MIN_WIDTH}
        minHeight={MIN_HEIGHT}
        position="bottom-right"
        onResizeStart={() => useUiStore.getState().setCanvasGestureActive(true)}
        onResize={(_, dims) => {
          const snapped = applyResizeSnap(dims, useProjectStore.getState().snapToGrid)
          updateNodeData(id, { width: snapped.width, height: snapped.height })
        }}
        onResizeEnd={(_, dims) => {
          useUiStore.getState().setCanvasGestureActive(false)
          const snapped = applyResizeSnap(dims, useProjectStore.getState().snapToGrid)
          updateNodeData(id, { width: snapped.width, height: snapped.height })
        }}
        style={{
          width: 14,
          height: 14,
          background: 'transparent',
          border: 'none',
          left: 'auto',
          top: 'auto',
          right: 1,
          bottom: 1,
          translate: 'none',
          zIndex: 10,
          pointerEvents: 'auto',
          cursor: 'nwse-resize',
        }}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" style={{ display: 'block', margin: '2px', pointerEvents: 'none' }}>
          <line x1="0" y1="10" x2="10" y2="0" stroke={colour} strokeWidth="1.5" strokeLinecap="round" />
          <line x1="4" y1="10" x2="10" y2="4" stroke={colour} strokeWidth="1.5" strokeLinecap="round" />
          <line x1="8" y1="10" x2="10" y2="8" stroke={colour} strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </NodeResizeControl>
      )}

      {/* Phase 8.1 (§8.1.5) , concept ports. Latent on every CONCEPT group;
          hidden until hover / selection / connection / drag. gripVisible =
          selected (the grip is now selection-gated above), so the bottom-right
          inset matches the concept node. Phase 8.5: only concept groups expose
          ports; an organisation group (`concept_group === false`) has none. */}
      {isConceptGroup && (
        <ConceptPorts
          nodeId={id}
          nodeType="genericGroupNode"
          visible={hovered || selected}
          gripVisible={selected}
          colour={colour}
        />
      )}
    </div>
  )
}
