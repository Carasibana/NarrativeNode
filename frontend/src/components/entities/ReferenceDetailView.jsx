import { useMemo, useCallback, useState } from 'react'
import { generateHTML } from '@tiptap/react'
import { useUiStore } from '../../store/uiStore'
import { useProjectStore } from '../../store/projectStore'
import { TIPTAP_EXTENSIONS } from '../../utils/tiptapExtensions'
import DetailPanelShell from '../ui/DetailPanelShell'
import DetailPanelIdentityHeader from '../ui/DetailPanelIdentityHeader'
import EntityColorPicker from '../ui/EntityColorPicker'
import ProjectTagPicker from '../tags/ProjectTagPicker'
import TagPopover from '../tags/TagPopover'
import { useTagBrowsePopover } from '../tags/useTagBrowsePopover'
import AttachToChatButton from '../chat/AttachToChatButton'
import EmptyDetailState from './EmptyDetailState'

// ── Reference (Concept / Note) Detail View — Phase 8.6 ───────────────────────
//
// Context-aware left-sidebar detail view for a selected Concept or Note node
// (a `referenceNode`, sub_type `concept` / `note`). Mirrors the layout of the
// entity / knowledge / relationship views by reusing the shared shell + identity
// header — no new design language: TYPE:name header with a colour chip, a tags
// row, and the node's rich-text body.
//
// Concepts / notes are NOT chain-tracked, so their state is plain baseline node
// data with no chain nav. Every edit here persists straight to the node via
// `updateNodeData` — the same baseline path the node's own controls use:
//   - Name  — click-to-edit input in the header (commit on Enter / blur).
//   - Colour — colour chip in the header corner opening the shared
//              `EntityColorPicker`.
//   - Tags  — the shared find-or-create `ProjectTagPicker` (attach / detach on
//              `tag_ids`, with the orphan-pool cleanup the node does).
// The Notes body stays read-only; clicking it opens that field in the
// right-sidebar Text Editor, the SAME action as the node's own edit button.
//
// Media reference nodes are routed away upstream (Canvas selection handler) —
// they carry a player/upload body, not a notes body — so this view only ever
// renders concept / note.
export default function ReferenceDetailView() {
  const refId = useUiStore((s) => s.activeSelection?.id)
  const node = useProjectStore((s) => (s.nodes || []).find((n) => n.id === refId))
  const openRightSidebar = useUiStore((s) => s.openRightSidebar)
  const updateNodeData = useProjectStore((s) => s.updateNodeData)
  const { target: tagPopoverTarget, open: openTagPopover, close: closeTagPopover } = useTagBrowsePopover()

  const [editingName, setEditingName] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [colourPickerOpen, setColourPickerOpen] = useState(false)
  // Callback ref into state so the picker's `anchorEl` is read from state (not a
  // ref during render) and re-renders once the button element mounts.
  const [colourAnchorEl, setColourAnchorEl] = useState(null)

  const data = node?.data || {}
  const subType = data.sub_type === 'concept' ? 'concept' : 'note'
  const badgeLabel = subType === 'concept' ? 'CONCEPT' : 'NOTE'
  const title = data.title || ''
  const colour = data.colour || '#40afd0'
  const content = data.content || ''
  const isRichText = data.is_rich_text || false

  // Read-only HTML preview from the TipTap JSON body — same derivation the node
  // uses for its own in-canvas read-only preview.
  const richTextPreview = useMemo(() => {
    if (!isRichText || !content) return ''
    try {
      const json = typeof content === 'string' ? JSON.parse(content) : content
      return generateHTML(json, TIPTAP_EXTENSIONS)
    } catch {
      return typeof content === 'string' ? content : ''
    }
  }, [isRichText, content])

  const hasBody = isRichText ? !!richTextPreview : !!(typeof content === 'string' && content.trim())

  const openEditor = useCallback(() => {
    if (refId) openRightSidebar(refId)
  }, [refId, openRightSidebar])

  // Name — enter edit mode seeded from the current title; commit on Enter/blur.
  const startEditName = useCallback(() => {
    setDraftName(useProjectStore.getState().nodes.find((n) => n.id === refId)?.data?.title || '')
    setEditingName(true)
  }, [refId])
  const commitName = useCallback(() => {
    setEditingName(false)
    const cur = useProjectStore.getState().nodes.find((n) => n.id === refId)?.data?.title || ''
    if (cur !== draftName) updateNodeData(refId, { title: draftName })
  }, [refId, draftName, updateNodeData])

  // Colour — baseline edit straight to the node.
  const handleSaveColour = useCallback((hex) => {
    updateNodeData(refId, { colour: hex })
  }, [refId, updateNodeData])

  // Tags — attach / detach on the node's baseline `tag_ids` (reads the live list
  // at call time, no stale closure). Mirrors the node's tag wiring, including the
  // orphan-pool cleanup on detach.
  const handleAddTag = useCallback((tagId) => {
    const cur = useProjectStore.getState().nodes.find((n) => n.id === refId)?.data?.tag_ids || []
    if (cur.includes(tagId)) return
    updateNodeData(refId, { tag_ids: [...cur, tagId] })
  }, [refId, updateNodeData])
  const handleRemoveTag = useCallback((tagId) => {
    const cur = useProjectStore.getState().nodes.find((n) => n.id === refId)?.data?.tag_ids || []
    if (!cur.includes(tagId)) return
    updateNodeData(refId, { tag_ids: cur.filter((t) => t !== tagId) })
    useProjectStore.getState()._maybeCleanupOrphanedTagInline(tagId)
  }, [refId, updateNodeData])

  // Selection points at a node that no longer exists (e.g. just deleted).
  if (!node) return <EmptyDetailState />

  const nameSlot = editingName ? (
    <input
      autoFocus
      className="text-sm font-medium leading-tight w-40 max-w-full text-center bg-transparent border-b border-zinc-500 focus:border-accent-500 focus:outline-none text-zinc-100"
      value={draftName}
      onChange={(e) => setDraftName(e.target.value)}
      onBlur={commitName}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commitName() }
        if (e.key === 'Escape') { setEditingName(false) }
      }}
      placeholder={`Untitled ${badgeLabel.toLowerCase()}`}
    />
  ) : (
    <div
      className="text-sm font-medium leading-tight break-words min-w-0 text-center cursor-text hover:opacity-75 text-zinc-100"
      onClick={startEditName}
      title="Click to edit name"
    >
      {title || <span className="italic text-zinc-500">Untitled {badgeLabel.toLowerCase()}</span>}
    </div>
  )

  const header = (
    <DetailPanelIdentityHeader
      typeLabel={badgeLabel}
      typeColour={colour}
      nameSlot={nameSlot}
      cornerActionLeft={
        <>
          <button
            type="button"
            ref={setColourAnchorEl}
            onClick={() => setColourPickerOpen((o) => !o)}
            className="w-6 h-6 rounded border border-zinc-600 hover:border-zinc-400 cursor-pointer flex-shrink-0 transition-colors"
            style={{ background: colour }}
            aria-label={`Colour: ${colour}. Click to edit.`}
            title="Edit colour"
          />
          <EntityColorPicker
            value={colour}
            onChange={handleSaveColour}
            anchorEl={colourAnchorEl}
            isOpen={colourPickerOpen}
            onClose={() => setColourPickerOpen(false)}
          />
        </>
      }
      cornerAction={
        // Attach-to-chat parity with the entity / knowledge / relationship /
        // scene detail headers. Concepts are the only reference sub-type that
        // is attachable as chat context (notes are not), so gate on it. The
        // button self-hides when no conversation is open. Concepts are not
        // chain-tracked, so the pin is dynamic (no anchor) and references the
        // node id directly, matching the concept node's own corner button.
        subType === 'concept' ? (
          <AttachToChatButton
            kind="concept"
            id={refId}
            title="Add this concept as context to the open conversation"
            className="w-5 h-5"
          />
        ) : null
      }
      row2Slot={null}
    />
  )

  const body = (
    <div className="flex flex-col gap-3">
      {/* Tags — editable via the shared find-or-create picker (same as the node).
          No baselineTagIds: reference-node tags are baseline-only, so every chip
          renders solid. */}
      <section data-help-region="reference-detail:tags">
        <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Tags</div>
        <ProjectTagPicker
          currentTagIds={Array.isArray(data.tag_ids) ? data.tag_ids : []}
          onAdd={handleAddTag}
          onRemove={handleRemoveTag}
          onTagClick={openTagPopover}
        />
      </section>

      {/* Notes — read-only body; click opens the right-sidebar Text Editor,
          the same as the node's own edit button. */}
      <section data-help-region="reference-detail:notes">
        <div className="flex items-center justify-between mb-1">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500">Notes</div>
          <button
            type="button"
            onClick={openEditor}
            className="text-[10px] text-accent-400 hover:text-accent-300"
            title="Open this note in the Text Editor"
          >
            Open in Text Editor
          </button>
        </div>
        <div
          role="button"
          tabIndex={0}
          onClick={openEditor}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEditor() } }}
          title="Click to edit in the Text Editor"
          className="cursor-text rounded border border-zinc-700/60 bg-zinc-800/30 px-2 py-1.5 hover:border-accent-500/50 transition-colors"
        >
          {hasBody ? (
            isRichText ? (
              <div
                className="nn-tiptap-content text-xs leading-relaxed"
                dangerouslySetInnerHTML={{ __html: richTextPreview }}
              />
            ) : (
              <div className="text-xs leading-relaxed text-zinc-300 whitespace-pre-wrap break-words">{content}</div>
            )
          ) : (
            <div className="text-xs text-zinc-600 italic">No notes yet. Click to add.</div>
          )}
        </div>
      </section>
    </div>
  )

  return (
    <>
      <DetailPanelShell header={header} body={body} />
      <TagPopover
        key={tagPopoverTarget?.tag?.id || 'closed'}
        isOpen={!!tagPopoverTarget}
        onClose={closeTagPopover}
        mode="project"
        tag={tagPopoverTarget?.tag}
        anchor={tagPopoverTarget?.anchor}
        anchorEl={tagPopoverTarget?.anchorEl}
        readOnly
      />
    </>
  )
}
