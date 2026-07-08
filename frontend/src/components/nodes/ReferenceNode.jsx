import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { NodeResizeControl, useUpdateNodeInternals } from '@xyflow/react'
import { useProjectStore } from '../../store/projectStore'
import { useUiStore } from '../../store/uiStore'
import { usePreviewStore } from '../../store/previewStore'
import { useAccentColor } from '../../utils/povConstants'
import { applyResizeSnap } from '../../utils/snapUtils'
import { confirm } from '../../store/dialogStore'
import { useMultiSelectActive } from '../../hooks/useMultiSelectActive'
import EntityColorPicker from '../ui/EntityColorPicker'
import ConceptPorts from './ConceptPorts'
import { generateHTML } from '@tiptap/react'
import { TIPTAP_EXTENSIONS } from '../../utils/tiptapExtensions'
import ProjectTagPicker from '../tags/ProjectTagPicker'
import TagBadge from '../tags/TagBadge'
import TagPopover from '../tags/TagPopover'
import { useTagBrowsePopover } from '../tags/useTagBrowsePopover'
import { useEntitiesStore } from '../../store/entitiesStore'
import AttachToChatButton from '../chat/AttachToChatButton'
import axios from 'axios'

const IMAGE_EXTS = /\.(png|jpe?g|gif|webp|svg)$/i
const VIDEO_EXTS = /\.(mp4|webm|mov)$/i
const AUDIO_EXTS = /\.(mp3|wav|ogg|flac)$/i

// Registry of each media reference node's inline <video>/<audio> element,
// keyed by node id. Populated/cleared by the useEffect below. Consumed by the
// canvas auto-migrate hook so it can read/pause/seek a specific node's player
// in O(1) without traversing React Flow internals.
const inlineMediaRegistry = new Map()
export function getInlineMediaEl(nodeId) {
  return inlineMediaRegistry.get(nodeId) || null
}

export default function ReferenceNode({ id, data, selected }) {
  const accentColor = useAccentColor()
  const multiSelectActive = useMultiSelectActive()
  const updateNodeData = useProjectStore((s) => s.updateNodeData)
  const deleteNode = useProjectStore((s) => s.deleteNode)
  const convertReferenceNodeSubType = useProjectStore((s) => s.convertReferenceNodeSubType)
  const updateNodeInternals = useUpdateNodeInternals()
  const toggleReferenceCollapse = useProjectStore((s) => s.toggleReferenceCollapse)
  const setReferenceCollapsedDims = useProjectStore((s) => s.setReferenceCollapsedDims)
  const openRightSidebar = useUiStore((s) => s.openRightSidebar)
  const closeRightSidebar = useUiStore((s) => s.closeRightSidebar)
  const togglePreview = usePreviewStore((s) => s.togglePreview)
  const setActivePlayer = usePreviewStore((s) => s.setActivePlayer)
  const activePlayerId = usePreviewStore((s) => s.activePlayerId)
  const isEditorOpenForThis = useUiStore((s) => s.rightSidebarOpen && s.rightSidebarNodeId === id)
  const [hovered, setHovered] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [contextMenu, setContextMenu] = useState(null) // { x, y } or null
  // Phase 3.4f Item 6 follow-up — collapsable tags section. Collapsed
  // by default; expanding reveals the picker input so the writer can
  // add / remove tags. Collapsed view shows the existing chips inline
  // on the body's notes background.
  const [tagsExpanded, setTagsExpanded] = useState(false)
  // Phase 3.4f Item 7 — host-side TagBadge click-through to the
  // read-only TagPopover host browser. Pure UI state; never reads
  // or writes any chain-tracked value.
  const {
    target: _tagPopoverTarget,
    open: _openTagPopover,
    close: _closeTagPopover,
  } = useTagBrowsePopover()
  // Project Tag pool resolver — drives the collapsed-view chip
  // rendering. Pool entries are baseline-only (no chain), so this is
  // a plain lookup of name + colour for each id on `data.tag_ids`.
  const projectTags = useEntitiesStore((s) => s.projectTags) || []
  const attachedTagPoolEntries = useMemo(() => {
    if (!Array.isArray(data.tag_ids) || data.tag_ids.length === 0) return []
    const byId = new Map(projectTags.map((t) => [t.id, t]))
    const out = []
    for (const id of data.tag_ids) {
      const t = byId.get(id)
      if (t) out.push(t)
    }
    return out
  }, [data.tag_ids, projectTags])
  const colourAnchorRef = useRef(null)
  const [colourPickerOpen, setColourPickerOpen] = useState(false)
  const fileInputRef = useRef(null)
  const nodeRef = useRef(null)
  const contextMenuRef = useRef(null)
  // Ref to the inline <video> or <audio> element (whichever is rendered based
  // on file extension). Used by the "Open in Preview" button to hand off
  // current playback position and state to the floating Media Preview Panel,
  // and by the cross-player coordinator effect below to pause inline playback
  // when any other media player claims the active-player slot.
  const inlineMediaRef = useRef(null)
  // Stable player id for this reference node's inline player in the
  // cross-player coordinator. Reference nodes always use `reference:<node id>`.
  const inlinePlayerId = `reference:${id}`

  const subType = data.sub_type || 'note'
  // Phase 8.4 (Convert To) — when the sub_type flips (note ↔ concept) the eight
  // concept ports appear or disappear. React Flow caches handle geometry, so
  // without re-measuring, a wire dragged from a freshly-added concept port
  // anchors to stale bounds (the same class of bug the generic group's concept
  // ports needed `updateNodeInternals` to fix). Re-measure on any sub_type change.
  useEffect(() => {
    const raf = requestAnimationFrame(() => updateNodeInternals(id))
    return () => cancelAnimationFrame(raf)
  }, [subType, id, updateNodeInternals])
  // Phase 8.1 , 'concept' is a note-like sub_type: it reuses the titled
  // rich-text body of a note ('media' is the only sub_type with the
  // upload/player body) and shows its own badge. Note-like gates below
  // therefore test `subType !== 'media'` so concept follows the note path.
  const badgeLabel = subType === 'concept' ? 'CONCEPT' : subType === 'media' ? 'MEDIA' : 'NOTE'
  const title = data.title || ''
  const colour = data.colour || '#40afd0'
  const content = data.content || ''
  const fileRef = data.file_ref || null
  const collapsed = data.collapsed || false
  const opaque = data.opaque || false
  const isRichText = data.is_rich_text || false

  // After first collapse render, if no stored collapsed dims yet, measure and store them
  useEffect(() => {
    if (collapsed && !data.collapsed_width && nodeRef.current) {
      requestAnimationFrame(() => {
        const el = nodeRef.current
        if (!el) return
        setReferenceCollapsedDims(id, el.offsetWidth, el.offsetHeight)
      })
    }
  }, [collapsed, data.collapsed_width, id, setReferenceCollapsedDims])

  // Close context menu on outside click, scroll, or any key press
  useEffect(() => {
    if (!contextMenu) return
    function handleMouseDown(e) {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target)) setContextMenu(null)
    }
    function handleDismiss() { setContextMenu(null) }
    document.addEventListener('mousedown', handleMouseDown, true)
    document.addEventListener('scroll', handleDismiss, true)
    document.addEventListener('keydown', handleDismiss)
    window.addEventListener('blur', handleDismiss)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown, true)
      document.removeEventListener('scroll', handleDismiss, true)
      document.removeEventListener('keydown', handleDismiss)
      window.removeEventListener('blur', handleDismiss)
    }
  }, [contextMenu])

  // ── Cross-player coordinator ─────────────────────────────────────────────
  // Pause this reference node's inline player whenever any other media player
  // (another reference node, the floating preview panel, the tray chip) claims
  // the active-player slot. The active-player id format is `reference:<node id>`
  // for inline players and `preview:<instance id>` for panel/tray players.
  useEffect(() => {
    const el = inlineMediaRef.current
    if (!el) return
    if (activePlayerId && activePlayerId !== inlinePlayerId && !el.paused) {
      el.pause()
    }
  }, [activePlayerId, inlinePlayerId])

  // Handler for the inline player's `play` event — claims the active-player
  // slot so every other media player pauses itself via their own effects.
  const handleInlinePlay = useCallback(() => {
    setActivePlayer(inlinePlayerId)
  }, [setActivePlayer, inlinePlayerId])

  // Register the inline element in the module-level registry so the canvas
  // auto-migrate hook can look it up by nodeId. Re-runs whenever the element
  // is (re)mounted — i.e. on mount, on fileRef change, or when the node
  // toggles collapsed/expanded (collapsed hides the media element).
  useEffect(() => {
    if (subType !== 'media' || !fileRef || collapsed) return undefined
    const el = inlineMediaRef.current
    if (!el) return undefined
    inlineMediaRegistry.set(id, el)
    return () => {
      if (inlineMediaRegistry.get(id) === el) inlineMediaRegistry.delete(id)
    }
  }, [id, fileRef, subType, collapsed])

  // Title draft state — Phase 2.8. Mirrors the scene-node
  // `SceneTitleInput` pattern: typing accumulates into a local
  // draft so the store is only touched on commit (Enter / blur).
  // Avoids triggering downstream re-renders / autosave hooks per
  // keystroke, and keeps the input bound to whatever the writer
  // last typed instead of being whipped around by external updates
  // mid-edit.
  const [titleFocused, setTitleFocused] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const titleEditedRef = useRef(false)
  const handleTitleFocus = useCallback(() => {
    setTitleDraft(title || '')
    titleEditedRef.current = false
    setTitleFocused(true)
  }, [title])
  const handleTitleChange = useCallback((e) => {
    titleEditedRef.current = true
    setTitleDraft(e.target.value)
  }, [])
  const handleTitleBlur = useCallback(() => {
    setTitleFocused(false)
    if (titleEditedRef.current && (title || '') !== titleDraft) {
      updateNodeData(id, { title: titleDraft })
    }
  }, [id, updateNodeData, title, titleDraft])
  const titleDisplay = titleFocused ? titleDraft : (title || '')

  const handleContentChange = useCallback((e) => {
    updateNodeData(id, { content: e.target.value })
  }, [id, updateNodeData])

  const handleFileUpload = useCallback(async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const res = await axios.post('/api/project/assets/upload', formData)
      updateNodeData(id, { file_ref: res.data.file_ref })
    } catch (err) {
      console.error('Reference media upload failed:', err)
    } finally {
      setUploading(false)
    }
  }, [id, updateNodeData])

  const handleRemoveMedia = useCallback(() => {
    updateNodeData(id, { file_ref: null })
  }, [id, updateNodeData])

  const handleOpenInEditor = useCallback(() => {
    if (isEditorOpenForThis) {
      closeRightSidebar()
    } else {
      openRightSidebar(id)
    }
  }, [id, openRightSidebar, closeRightSidebar, isEditorOpenForThis])

  const handleConvertToPlainText = useCallback(async () => {
    setContextMenu(null)
    const result = await confirm({
      title: 'Convert to plain text',
      message: 'Convert to plain text? All formatting will be lost.',
      buttons: [
        { label: 'Convert', value: 'convert', style: 'primary' },
        { label: 'Cancel',  value: 'cancel',  style: 'neutral' },
      ],
    })
    if (result !== 'convert') return
    // Extract plain text from TipTap JSON content, preserving newlines between blocks
    let plainText = content
    try {
      const json = typeof content === 'string' ? JSON.parse(content) : content
      const BLOCK_TYPES = new Set(['paragraph', 'heading', 'blockquote', 'codeBlock', 'listItem', 'bulletList', 'orderedList', 'hardBreak'])
      function extractText(node) {
        if (node.type === 'hardBreak') return '\n'
        if (node.text) return node.text
        if (!node.content) return ''
        return node.content.map((child, i) => {
          const text = extractText(child)
          // Add newline between block-level children (not before the first one)
          if (i > 0 && BLOCK_TYPES.has(child.type)) return '\n' + text
          return text
        }).join('')
      }
      plainText = extractText(json)
    } catch {
      // If parsing fails, content is already plain text
    }
    updateNodeData(id, { content: plainText, is_rich_text: false })
  }, [id, content, updateNodeData])

  const handleContextMenu = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    // Note and concept nodes get a context menu (Convert to concept / note, plus
    // Convert to plain text for rich-text notes). Media has no convert options.
    if (subType !== 'media') {
      setContextMenu({ x: e.clientX, y: e.clientY })
    }
  }, [subType])

  // Phase 8.4 (Convert To) — flip note ↔ concept in place. note → concept is
  // additive (gains the concept ports); concept → note strips this node's
  // concept wires, so warn first when it has any.
  const handleConvertToConcept = useCallback(() => {
    setContextMenu(null)
    convertReferenceNodeSubType(id, 'concept')
  }, [id, convertReferenceNodeSubType])

  const handleConvertToNote = useCallback(async () => {
    setContextMenu(null)
    const conceptWireCount = useProjectStore.getState().edges.filter(
      (e) => e.data?.kind === 'concept' && (e.source === id || e.target === id),
    ).length
    if (conceptWireCount > 0) {
      const decision = await confirm({
        title: 'Convert concept to note?',
        message: `This concept has ${conceptWireCount} concept ${conceptWireCount === 1 ? 'wire' : 'wires'}. Converting it to a note removes ${conceptWireCount === 1 ? 'it' : 'them'} (a note has no concept ports). Undo restores everything.`,
        buttons: [
          { label: 'Cancel', value: 'cancel' },
          { label: 'Convert to note', value: 'ok', style: 'primary' },
        ],
        cancelValue: 'cancel',
      })
      if (decision !== 'ok') return
    }
    convertReferenceNodeSubType(id, 'note')
  }, [id, convertReferenceNodeSubType])

  // Generate HTML preview from TipTap JSON content
  const richTextPreview = useMemo(() => {
    if (!isRichText || !content) return ''
    try {
      const json = typeof content === 'string' ? JSON.parse(content) : content
      return generateHTML(json, TIPTAP_EXTENSIONS)
    } catch {
      return content // fallback to raw content
    }
  }, [isRichText, content])

  // Extract asset filename from file_ref (e.g. "assets/photo.png" → "photo.png")
  const assetName = fileRef ? fileRef.replace(/^assets\//, '') : null

  // Title is hidden when empty and not hovered; stays hidden when collapsed.
  // Phase 8.1 , concept nodes always show their title field when expanded
  // (the label is the mind-map node's identity), even empty and un-hovered.
  const showTitle = subType === 'concept' ? !collapsed : (title || (hovered && !collapsed))

  return (
    <div
      ref={nodeRef}
      data-help-region={subType === 'concept' ? 'concept-node:node' : 'reference-node:node'}
      className="relative rounded"
      style={{
        border: `1.5px dashed ${colour}60`,
        background: opaque ? `#27272a` : 'transparent',
        minWidth: collapsed ? undefined : 180,
        minHeight: collapsed ? undefined : 80,
        width: collapsed ? 'fit-content' : (data.width || 220),
        height: collapsed ? 'fit-content' : (data.height || undefined),
        display: 'flex',
        flexDirection: 'column',
        // Phase 1.11 Track I — dashed selection outline only in multi-select.
        outline: (selected && multiSelectActive) ? `2px dashed ${accentColor}` : undefined,
        outlineOffset: (selected && multiSelectActive) ? 3 : undefined,
        // Single-select highlight: accent-colour ring, matching every other
        // node's active-selection indicator (scene / entity / knowledge /
        // relationship all use this same boxShadow). Multi-select uses the
        // dashed outline above instead, so this is gated on single-select.
        boxShadow: (selected && !multiSelectActive) ? `0 0 0 2px ${accentColor}` : undefined,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onContextMenu={handleContextMenu}
    >
      {/* Resize grip — hidden when collapsed */}
      {selected && !collapsed && (
        <NodeResizeControl
          minWidth={180}
          minHeight={80}
          position="bottom-right"
          onResizeStart={() => useUiStore.getState().setCanvasGestureActive(true)}
          onResize={(_, dims) => {
            const snapped = applyResizeSnap(dims, useProjectStore.getState().snapToGrid)
            updateNodeData(id, snapped)
          }}
          onResizeEnd={(_, dims) => {
            useUiStore.getState().setCanvasGestureActive(false)
            const snapped = applyResizeSnap(dims, useProjectStore.getState().snapToGrid)
            updateNodeData(id, snapped)
          }}
          style={{ width: 14, height: 14, background: 'transparent', border: 'none', left: 'auto', top: 'auto', right: 1, bottom: 1, translate: 'none', zIndex: 10 }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" style={{ display: 'block', margin: '2px', pointerEvents: 'none' }}>
            <line x1="0" y1="10" x2="10" y2="0" stroke="#52525b" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="4" y1="10" x2="10" y2="4" stroke="#52525b" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="8" y1="10" x2="10" y2="8" stroke="#52525b" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </NodeResizeControl>
      )}

      {/* Phase 8.1 , concept ports (visual layer). Only the concept sub_type,
          expanded. Reveal on hover / selection; the bottom-right port insets
          while the resize grip (selected && !collapsed) is showing. */}
      {subType === 'concept' && !collapsed && (
        <ConceptPorts
          nodeId={id}
          nodeType="referenceNode"
          visible={hovered || selected}
          gripVisible={selected && !collapsed}
          colour={colour}
        />
      )}

      {/* Header: colour chip + badge + title + buttons */}
      <div data-help-region={subType === 'concept' ? 'concept-node:header' : 'reference-node:header'} className="flex items-center gap-1.5 px-2.5 pt-2 pb-1 flex-shrink-0" style={{
        background: '#27272a',
        borderTop: `2px dotted ${colour}`,
        borderRadius: '3px 3px 0 0',
      }}>
        {/* Colour picker chip */}
        <button
          type="button"
          ref={colourAnchorRef}
          className="nodrag w-3.5 h-3.5 rounded-sm border border-zinc-500 flex-shrink-0 cursor-pointer p-0"
          style={{ backgroundColor: colour }}
          onClick={() => setColourPickerOpen((o) => !o)}
          title="Set node colour"
          aria-label={`Node colour: ${colour}. Click to open picker.`}
        />
        <EntityColorPicker
          value={colour}
          onChange={(hex) => updateNodeData(id, { colour: hex })}
          anchorEl={colourAnchorRef.current}
          isOpen={colourPickerOpen}
          onClose={() => setColourPickerOpen(false)}
        />
        {/* Sub-type badge — tinted with node colour */}
        <span className="text-[9px] uppercase tracking-widest font-semibold px-1.5 py-0.5 rounded flex-shrink-0"
          style={{
            color: colour,
            background: colour + '22',
          }}
        >
          {badgeLabel}
        </span>
        {/* Title — when collapsed: shown only if title has a value (as static text); when expanded: shown on hover if empty */}
        {collapsed ? (
          title && <span className="text-zinc-200 text-xs font-medium truncate">{title}</span>
        ) : (
          <>
            {showTitle && (
              <input
                className="nodrag nopan bg-transparent border-none outline-none text-zinc-200 text-xs font-medium flex-1 min-w-0 placeholder-zinc-600"
                value={titleDisplay}
                onFocus={handleTitleFocus}
                onChange={handleTitleChange}
                onBlur={handleTitleBlur}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                placeholder="Title"
                spellCheck={false}
              />
            )}
            {!showTitle && <div className="flex-1" />}
          </>
        )}
        {/* Attach this concept to the open conversation as chat context. A
            concept is a program-level referenceNode with no chain, so no
            anchor is passed — the pin is `{ kind:'concept', id }`. Self-gates
            on a conversation being open (renders null otherwise). Concept
            sub-type only. */}
        {!collapsed && subType === 'concept' && (
          <AttachToChatButton
            kind="concept"
            id={id}
            size={12}
            title="Add this concept as context to the open conversation"
            stopPropagation
            className={`nodrag flex-shrink-0 ${hovered ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
          />
        )}
        {/* Open in editor button — note sub-type only, hidden when collapsed */}
        {!collapsed && subType !== 'media' && (
          <button
            className={`nodrag flex-shrink-0 text-xs leading-none transition-opacity ${
              hovered ? 'text-zinc-500 hover:text-accent-400 opacity-100' : 'opacity-0 pointer-events-none'
            }`}
            onClick={handleOpenInEditor}
            title="Open in text editor"
          >
            ✎
          </button>
        )}
        {/* Open in Media Preview Panel — media sub-type with an uploaded file, expanded only */}
        {!collapsed && subType === 'media' && fileRef && (
          <button
            className="nodrag flex-shrink-0 transition-colors rounded"
            style={{
              width: 16, height: 16,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#52525b',
              border: '1px solid #52525b',
            }}
            onClick={(e) => {
              e.stopPropagation()
              // If the preview is already showing this reference node's file,
              // togglePreview will dismiss it (second-click closes).
              // Otherwise, hand off the inline player's current playback state
              // so the preview panel resumes at the exact timestamp with no
              // interruption. Pause the inline element first so playback
              // continues in one place.
              const alreadyShowing = (() => {
                const s = usePreviewStore.getState()
                if (s.expanded?.source?.fileRef === fileRef) return true
                if (s.trayChip?.source?.fileRef === fileRef) return true
                return false
              })()
              const inlineEl = inlineMediaRef.current
              let initialState = null
              if (inlineEl && !alreadyShowing) {
                initialState = {
                  currentTime: inlineEl.currentTime,
                  playing: !inlineEl.paused,
                  paused: inlineEl.paused,
                  volume: inlineEl.volume,
                }
                if (!inlineEl.paused) inlineEl.pause()
              }
              togglePreview({
                type: 'reference_node',
                nodeId: id,
                fileRef,
                title: title || 'Untitled',
                colour,
              }, initialState)
            }}
            title="Open in Media Preview Panel (click again to close)"
            onMouseEnter={(e) => { e.currentTarget.style.color = '#d4d4d8' }}
            onMouseLeave={(e) => { e.currentTarget.style.color = '#52525b' }}
          >
            {/* Eye icon — inline SVG so it inherits currentColor */}
            <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" />
              <circle cx="8" cy="8" r="2" />
            </svg>
          </button>
        )}
        {/* Opacity toggle — expanded only */}
        {!collapsed && (
          <button
            className="nodrag flex-shrink-0 transition-colors rounded"
            style={{
              width: 16, height: 16,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 10, lineHeight: 1,
              color: opaque ? '#d4d4d8' : '#52525b',
              backgroundColor: opaque ? '#52525b' : 'transparent',
              border: opaque ? '1px solid #52525b' : '1px solid #52525b',
            }}
            onClick={() => updateNodeData(id, { opaque: !opaque })}
            title={opaque ? 'Semi-transparent background' : 'Opaque background'}
          >
            {opaque ? '\u25CF' : '\u25CC'}
          </button>
        )}
        {/* Collapse / expand toggle */}
        <button
          className="nodrag flex-shrink-0 transition-colors rounded"
          style={{
            width: 16, height: 16,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 10, lineHeight: 1,
            color: '#52525b',
            border: '1px solid #52525b',
          }}
          onClick={() => toggleReferenceCollapse(id)}
          title={collapsed ? 'Expand' : 'Collapse'}
          onMouseEnter={(e) => { e.currentTarget.style.color = '#d4d4d8' }}
          onMouseLeave={(e) => { e.currentTarget.style.color = '#52525b' }}
        >
          {collapsed ? '\u25BC' : '\u25B2'}
        </button>
        {/* Delete button — hidden when collapsed */}
        {!collapsed && (
          <button
            className={`nodrag text-sm leading-none transition-opacity flex-shrink-0 ${
              hovered ? 'text-zinc-600 hover:text-red-400 opacity-100' : 'opacity-0 pointer-events-none'
            }`}
            onClick={() => deleteNode(id)}
            title="Delete reference node"
          >
            &times;
          </button>
        )}
      </div>

      {/* Phase 3.4f Item 6 — Tags section. Sits between the header
          bar and the body, both states using the body's "notes"
          background (`colour + '1a'`) so the chips blend with the
          content area. Collapsed (default): only the existing chips
          render — no input. Expanded: the full ProjectTagPicker
          surfaces so the writer can attach / detach. The collapsed
          empty state shows a quiet "+ Add tag" pill so the writer
          can discover the affordance on a tag-less node. */}
      {!collapsed && (
        <div
          data-help-region={subType === 'concept' ? 'concept-node:tags' : 'reference-node:tags'}
          className="nodrag nopan nowheel px-2.5 pt-1.5 pb-1"
          style={{ background: colour + '1a' }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {tagsExpanded ? (
            <div>
              <button
                type="button"
                onClick={() => setTagsExpanded(false)}
                className="flex items-center justify-between w-full text-[9px] uppercase tracking-wider text-zinc-500 hover:text-zinc-300 mb-1"
                title="Collapse tags"
              >
                <span>Tags</span><span>▾</span>
              </button>
              <ProjectTagPicker
                currentTagIds={data.tag_ids || []}
                onAdd={(tagId) => {
                  const list = data.tag_ids || []
                  if (list.includes(tagId)) return
                  updateNodeData(id, { tag_ids: [...list, tagId] })
                }}
                onRemove={(tagId) => {
                  const list = data.tag_ids || []
                  if (!list.includes(tagId)) return
                  updateNodeData(id, { tag_ids: list.filter((t) => t !== tagId) })
                  // Phase 3.4 Bugs & Fixes — orphan-cleanup gate for
                  // the Reference Node baseline tag-detach path. The
                  // `updateNodeData` call above takes its own
                  // `_snapshot()`; the cleanup splices the pool
                  // entry on the same Zustand state in the same tick
                  // so Ctrl-Z restores both.
                  useProjectStore.getState()._maybeCleanupOrphanedTagInline(tagId)
                }}
                onTagClick={_openTagPopover}
              />
            </div>
          ) : (
            <div className="flex items-center gap-1.5 w-full px-1 -mx-1 py-0.5 rounded">
              {attachedTagPoolEntries.length > 0 ? (
                <div className="flex flex-wrap gap-1 flex-1 min-w-0">
                  {attachedTagPoolEntries.map((t) => (
                    <TagBadge
                      key={t.id}
                      name={t.name}
                      color={t.color || '#888888'}
                      size="xs"
                      onClick={(e) => _openTagPopover(t.id, e)}
                    />
                  ))}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setTagsExpanded(true)}
                  className="text-[10px] text-zinc-500 italic flex-1 text-left hover:text-zinc-300"
                  title="Add a tag"
                >
                  + Add tag
                </button>
              )}
              <button
                type="button"
                onClick={() => setTagsExpanded(true)}
                className="text-[9px] text-zinc-500 hover:text-zinc-300 flex-shrink-0 px-0.5"
                title="Expand tags to add or remove"
              >
                ▸
              </button>
            </div>
          )}
        </div>
      )}

      {/* Body — hidden when collapsed */}
      {!collapsed && <div data-help-region={subType === 'concept' ? 'concept-node:body' : 'reference-node:body'} className="flex-1 px-2.5 pb-2 overflow-hidden" style={{ minHeight: 0, background: colour + '1a' }}>
        {subType !== 'media' ? (
          isRichText ? (
            /* Rich text mode — read-only rendered preview; double-click to edit, draggable */
            <div
              className="nn-tiptap-content w-full h-full overflow-y-auto text-xs leading-relaxed nowheel"
              style={{ minHeight: 40 }}
              dangerouslySetInnerHTML={{ __html: richTextPreview }}
              onDoubleClick={handleOpenInEditor}
              title="Double-click to edit in text editor"
            />
          ) : (
            /* Plain text mode — editable textarea */
            <textarea
              className="nodrag nopan bg-transparent border-none outline-none resize-none w-full h-full text-zinc-300 text-xs leading-relaxed placeholder-zinc-600"
              value={content}
              onChange={handleContentChange}
              onKeyDown={(e) => {
                if (e.key === 'Tab') {
                  e.preventDefault()
                  const ta = e.target
                  const start = ta.selectionStart
                  const end = ta.selectionEnd
                  const val = ta.value
                  const newVal = val.substring(0, start) + '\t' + val.substring(end)
                  handleContentChange({ target: { value: newVal } })
                  requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = start + 1 })
                }
              }}
              placeholder="Type your notes here..."
              spellCheck={false}
              style={{ minHeight: 40, tabSize: 4 }}
            />
          )
        ) : (
          /* MEDIA sub-type */
          <div className="w-full h-full flex flex-col items-center justify-center" style={{ minHeight: 40 }}>
            {!fileRef ? (
              /* Upload zone */
              <div className="flex flex-col items-center gap-1.5">
                <button
                  className="nodrag nopan px-3 py-1.5 text-[10px] rounded bg-zinc-700 text-zinc-400 hover:bg-zinc-600 hover:text-zinc-200 transition-colors"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                >
                  {uploading ? 'Uploading...' : 'Upload Media'}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  onChange={handleFileUpload}
                  accept="image/*,video/*,audio/*"
                />
              </div>
            ) : (
              /* Media display */
              <div className="relative w-full h-full flex items-center justify-center" style={{ minHeight: 40 }}>
                {IMAGE_EXTS.test(assetName) && (
                  <img
                    src={`/api/project/assets/${assetName}`}
                    alt={title || 'Reference image'}
                    className="nodrag"
                    style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                    draggable={false}
                  />
                )}
                {VIDEO_EXTS.test(assetName) && (
                  <video
                    ref={inlineMediaRef}
                    src={`/api/project/assets/${assetName}`}
                    controls
                    className="nodrag nopan"
                    style={{ width: '100%', maxHeight: '100%', objectFit: 'contain' }}
                    onPlay={handleInlinePlay}
                  />
                )}
                {AUDIO_EXTS.test(assetName) && (
                  <audio
                    ref={inlineMediaRef}
                    src={`/api/project/assets/${assetName}`}
                    controls
                    className="nodrag nopan"
                    style={{ width: '100%' }}
                    onPlay={handleInlinePlay}
                  />
                )}
                {/* Remove media button — trash icon to distinguish from node delete */}
                <button
                  className={`nodrag absolute top-0 right-0 text-[10px] px-1 py-0.5 rounded bg-zinc-800/80 transition-opacity ${
                    hovered ? 'text-zinc-400 hover:text-red-400 opacity-100' : 'opacity-0 pointer-events-none'
                  }`}
                  onClick={handleRemoveMedia}
                  title="Remove media"
                >
                  {'\u{1F5D1}'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>}

      {/* Context menu — Convert to concept / note, plus Convert to plain text for
          rich-text notes — rendered via portal to escape transform context */}
      {contextMenu && createPortal(
        <div
          ref={contextMenuRef}
          className="fixed bg-zinc-800 border border-zinc-600 rounded shadow-lg py-1 min-w-[180px]"
          style={{ left: contextMenu.x, top: contextMenu.y, zIndex: 9999 }}
        >
          {subType === 'note' && (
            <button
              className="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
              onClick={handleConvertToConcept}
            >
              Convert to concept
            </button>
          )}
          {subType === 'concept' && (
            <button
              className="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
              onClick={handleConvertToNote}
            >
              Convert to note
            </button>
          )}
          {isRichText && subType !== 'media' && (
            <button
              className="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
              onClick={handleConvertToPlainText}
            >
              Convert to plain text
            </button>
          )}
        </div>,
        document.body
      )}

      <TagPopover
        key={_tagPopoverTarget?.tag?.id || 'closed'}
        isOpen={!!_tagPopoverTarget}
        onClose={_closeTagPopover}
        mode="project"
        tag={_tagPopoverTarget?.tag}
        anchor={_tagPopoverTarget?.anchor}
        anchorEl={_tagPopoverTarget?.anchorEl}
        readOnly
      />
    </div>
  )
}
