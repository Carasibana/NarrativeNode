/**
 * SectionCreationChooser — floating menu for the editor's content
 * area. Opens from two places:
 *
 *   - the editor formatting toolbar's "+ Block" button (anchored
 *     below the button) — creation-only mode (no clipboard rows).
 *   - a right-click in the editor's prose content area (anchored
 *     at the click point, not over existing Section chrome) —
 *     includes Cut / Copy / Paste rows above the creation items,
 *     since we suppress the browser's default context menu in the
 *     editor and mouse-first writers still need clipboard access.
 *
 * Section creation items (always shown):
 *   - **Section** — wired. Label adapts: "Create Section from
 *     selection" when text is highlighted, "Insert empty Section"
 *     otherwise. Either path uses a fresh "Section (N)" default
 *     name computed via `computeNextSectionName`.
 *   - **Inline Prompt Block** — disabled stub. Wires up in Phase
 *     2.9c. Renders in the menu so the design is telegraphed to
 *     the writer immediately.
 *
 * Clipboard items (right-click only, gated on `showClipboardActions`):
 *   - **Cut** — copies the current selection to the clipboard then
 *     deletes it from the doc. Disabled when no selection or when
 *     the editor is read-only.
 *   - **Copy** — copies the current selection to the clipboard.
 *     Disabled when no selection.
 *   - **Paste** — reads text from the clipboard and inserts at the
 *     current cursor / selection. Disabled when read-only. May
 *     prompt for clipboard read permission on first use.
 *
 * Closes on outside click, Escape, or after a wired action fires.
 */

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { createSection } from './SectionExtension'
import { useIpbStore } from '../../store/ipbStore'
import { useEditorSurface } from './EditorSurfaceContext'

export default function SectionCreationChooser({
  editor,
  position,
  onClose,
  showClipboardActions = false,
  readOnly = false,
}) {
  const menuRef = useRef(null)

  // Outside-click + Escape close handlers.
  useEffect(() => {
    function onMouseDown(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        onClose()
      }
    }
    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  // Store / context reads for Inline Prompt Block creation. Hoisted above the
  // early return so these hooks run on every render (Rules of Hooks).
  const ipbOpen = useIpbStore((s) => s.open)
  const editorSurface = useEditorSurface()

  if (!editor || !position) return null

  // Selection state at the moment the chooser was opened. ProseMirror's
  // selection.empty is true when only a caret is present (no range
  // selected) — in that case we'll insert an empty Section at the
  // cursor instead of wrapping. The same flag gates Cut + Copy.
  const hasSelection = !editor.state.selection.empty

  const handleCreateSection = () => {
    createSection(editor)
    onClose()
  }

  // Phase 2.9c item 2 — Inline Prompt Block creation from this
  // chooser. Position the chrome at the right-click point (the
  // chooser's own `position`) so the IPB lands where the writer
  // invoked it; for the toolbar-button entry point the cascade in
  // `RichTextEditor.handleIpbToolbarClick` is used instead.
  const handleCreateIpb = () => {
    ipbOpen({
      chromePos: { left: position.left, top: position.top },
      surface_type: editorSurface?.surface_type || null,
      surface_host_id: editorSurface?.surface_host_id || null,
    })
    onClose()
  }

  const sectionLabel = hasSelection
    ? 'Create Section from selection'
    : 'Insert empty Section'

  // Clipboard actions. Cut + Copy read the editor's current selection
  // as plain text (block boundaries become `\n`) and write to the
  // system clipboard via the modern async Clipboard API. Paste reads
  // text from the clipboard and inserts at the cursor / selection
  // through TipTap's standard insertContent pipeline.
  const handleCopy = async () => {
    if (!hasSelection) { onClose(); return }
    const { from, to } = editor.state.selection
    const text = editor.state.doc.textBetween(from, to, '\n')
    try {
      if (navigator?.clipboard?.writeText) await navigator.clipboard.writeText(text)
    } catch { /* permission denied — silent */ }
    onClose()
  }

  const handleCut = async () => {
    if (!hasSelection || readOnly) { onClose(); return }
    const { from, to } = editor.state.selection
    const text = editor.state.doc.textBetween(from, to, '\n')
    try {
      if (navigator?.clipboard?.writeText) await navigator.clipboard.writeText(text)
    } catch { /* permission denied — silent */ }
    editor.chain().focus().deleteSelection().run()
    onClose()
  }

  const handlePaste = async () => {
    if (readOnly) { onClose(); return }
    try {
      if (navigator?.clipboard?.readText) {
        const text = await navigator.clipboard.readText()
        if (text) editor.chain().focus().insertContent(text).run()
      }
    } catch { /* permission denied / non-secure context — silent */ }
    onClose()
  }

  // The portal places the menu in <body> so it isn't clipped by the
  // editor's overflow container. position { left, top } is viewport-
  // relative (set by the caller from event.clientX/Y or the toolbar
  // button's getBoundingClientRect()).
  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[14rem] rounded border border-zinc-700 bg-zinc-900 shadow-lg py-1"
      style={{ left: position.left, top: position.top }}
      onMouseDown={(e) => e.stopPropagation()}
      data-help-region="editor-block-menu:menu"
    >
      {showClipboardActions && (
        <>
          <ClipboardRow
            label="Cut"
            disabled={!hasSelection || readOnly}
            onClick={handleCut}
            disabledTitle={readOnly ? 'Editor is read-only' : 'Select text to cut'}
            enabledTitle="Cut the selected text to the clipboard"
          />
          <ClipboardRow
            label="Copy"
            disabled={!hasSelection}
            onClick={handleCopy}
            disabledTitle="Select text to copy"
            enabledTitle="Copy the selected text to the clipboard"
          />
          <ClipboardRow
            label="Paste"
            disabled={readOnly}
            onClick={handlePaste}
            disabledTitle="Editor is read-only"
            enabledTitle="Paste from the clipboard"
          />
          <div className="my-1 border-t border-zinc-700/60" />
        </>
      )}
      <button
        type="button"
        className="w-full text-left px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700"
        onClick={handleCreateSection}
        title={sectionLabel}
        data-help-region="editor-block-menu:create_section"
      >
        {sectionLabel}
      </button>
      <button
        type="button"
        className="w-full text-left px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700"
        onClick={handleCreateIpb}
        title="Insert an Inline Prompt Block at this point"
        data-help-region="editor-block-menu:create_inline_prompt"
      >
        Insert Inline Prompt Block
      </button>
      {showClipboardActions && (
        <>
          <div className="my-1 border-t border-zinc-700/60" />
          <div
            className="px-3 py-1 text-[10px] text-zinc-500 leading-snug"
            title="No browser exposes spell-check suggestions to web apps, so we can't include them in this menu. Hold Shift while right-clicking to bypass this menu and use the browser's native one."
          >
            Tip: Shift+Right-click for the browser's spell-check menu.
          </div>
        </>
      )}
    </div>,
    document.body,
  )
}

function ClipboardRow({ label, disabled, onClick, disabledTitle, enabledTitle }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={disabled ? undefined : onClick}
      title={disabled ? disabledTitle : enabledTitle}
      className={
        disabled
          ? 'w-full text-left px-3 py-1.5 text-xs text-zinc-600 cursor-not-allowed'
          : 'w-full text-left px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700'
      }
    >
      {label}
    </button>
  )
}
