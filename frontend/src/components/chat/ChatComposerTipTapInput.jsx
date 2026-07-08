/**
 * Phase 2.8 — TipTap-based chat composer input.
 *
 * Drop-in replacement for the plain `<textarea>` that used to host
 * the chat input. The reason for the swap is purely so we can host
 * inline ProseMirror decorations (coloured name highlights for
 * auto-detected library object names) without losing IME / paste /
 * caret / undo / mobile-keyboard behaviour — TipTap/ProseMirror is
 * itself the contentEditable abstraction that solves those.
 *
 * Extension set is deliberately minimal: `StarterKit` with every
 * rich-text feature disabled (no bold / italic / lists / headings /
 * blockquote / code / horizontal rule / strike). What remains:
 *   - Document + Paragraph + Text (the plain-text primitives)
 *   - HardBreak (so Shift+Enter / Enter-as-newline produces \n)
 *   - History (undo/redo)
 *   - Dropcursor + Gapcursor (visual selection aids)
 *
 * Enter handling matches the textarea predecessor: a custom
 * keyboard extension dispatches to `onSend()` or `setHardBreak`
 * depending on the writer's `chat_send_on_enter` preference, with
 * modifier awareness so Shift+Enter is always a newline regardless.
 *
 * The component is uncontrolled by TipTap convention. `value` is a
 * one-way external reset hook: when the parent sets value to '' (e.g.
 * after a successful send), the editor's content is cleared. Callers
 * can also imperatively `clear()` / `focus()` via the forwarded ref.
 * Mid-typing local state lives in the editor, not in React, which is
 * why mid-compose React rerenders don't clobber the IME composition.
 */
import { forwardRef, useImperativeHandle, useEffect, useMemo, useRef } from 'react'
import { useEditor, EditorContent, Extension } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { EntityHighlightExtension, refreshEntityHighlights } from '../ui/EntityHighlightPlugin'


const ChatComposerTipTapInput = forwardRef(function ChatComposerTipTapInput(
  {
    value, onChange, onSend, sendOnEnter, placeholder, disabled, className, innerClassName,
    // Behaviour-neutral help-region passthrough applied to the input's
    // root wrapper. The chat composer sets it; other hosts (PBH) omit
    // it and the attribute simply doesn't render.
    dataHelpRegion,
    // Phase 2.8 — name-highlight props. When `highlightEnabled` is
    // true AND `nameTargets` is non-empty, the
    // `EntityHighlightExtension` paints each matched name in its
    // target colour via ProseMirror decorations. `accentColor` is
    // the story accent — used as the visual cue for AMBIGUOUS
    // matches (typed name maps to >1 object). All three are pushed
    // into the editor via `refreshEntityHighlights` on every change.
    nameTargets,
    highlightEnabled,
    accentColor,
  },
  ref,
) {
  // Send-keybind handler. Pure Enter / Ctrl-Enter / Shift-Enter
  // each route to send OR setHardBreak depending on the writer's
  // pref. Returning `true` from a TipTap keyboard shortcut tells
  // ProseMirror the event was handled (so the default split-block
  // behaviour doesn't also fire).
  //
  // `sendOnEnter` and `onSend` are read THROUGH REFS rather than
  // captured by closure. Reason: `useEditor` only takes the
  // extension array at initialisation — even if `KeyboardHandler`
  // gets regenerated when its deps change, the editor keeps the
  // first instance. The parent's `send` callback has `prompt` in
  // its useCallback deps, so it gets a new identity on every
  // keystroke; without refs, the keybind would always call the
  // FIRST `send` ever created (with empty-prompt closure), which
  // short-circuits on its own `!prompt.trim()` guard — exactly
  // the "Ctrl+Enter does nothing" regression. Reading refs at
  // call time means the handler always sees the current values.
  const sendOnEnterRef = useRef(sendOnEnter)
  const onSendRef = useRef(onSend)
  useEffect(() => { sendOnEnterRef.current = sendOnEnter }, [sendOnEnter])
  useEffect(() => { onSendRef.current = onSend }, [onSend])
  const KeyboardHandler = useMemo(() => Extension.create({
    name: 'chatComposerKeyboard',
    addKeyboardShortcuts() {
      return {
        Enter: () => {
          if (sendOnEnterRef.current) {
            onSendRef.current?.()
            return true
          }
          this.editor.commands.setHardBreak()
          return true
        },
        'Shift-Enter': () => {
          this.editor.commands.setHardBreak()
          return true
        },
        'Mod-Enter': () => {
          if (!sendOnEnterRef.current) {
            onSendRef.current?.()
            return true
          }
          this.editor.commands.setHardBreak()
          return true
        },
      }
    },
  }), [])

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        blockquote: false,
        bold: false,
        bulletList: false,
        code: false,
        codeBlock: false,
        heading: false,
        horizontalRule: false,
        italic: false,
        listItem: false,
        orderedList: false,
        strike: false,
        // Defaults left enabled: document, paragraph, text,
        // hardBreak, history, dropcursor, gapcursor.
      }),
      KeyboardHandler,
      // Phase 2.8 — inline coloured name-highlight decorations.
      // The extension itself is dormant until `refreshEntityHighlights`
      // pushes targets + enabled into it via setMeta; targets and
      // the enabled flag come from props (driven by uiStore +
      // story-wide builder in the parent).
      EntityHighlightExtension,
    ],
    content: value || '',
    editable: !disabled,
    onUpdate: ({ editor }) => {
      // `blockSeparator: '\n'` keeps multi-paragraph paste output
      // consistent with the textarea's plain-text semantics.
      onChange?.(editor.getText({ blockSeparator: '\n' }))
    },
  })

  // Mirror disabled prop into the editor's editable state.
  useEffect(() => {
    if (!editor) return
    editor.setEditable(!disabled)
  }, [editor, disabled])

  // Push name-highlight targets + enabled + accent into the
  // `EntityHighlightExtension`. The extension's plugin reads its
  // state from a transaction meta key, so we dispatch a setMeta
  // tx whenever the inputs change. `refreshEntityHighlights` is
  // the canonical helper from `EntityHighlightPlugin.jsx`.
  // `accentColor` drives the visual cue for AMBIGUOUS matches
  // (typed name maps to >1 distinct object); single-match
  // decorations use the matched object's own colour as before.
  useEffect(() => {
    if (!editor) return
    refreshEntityHighlights(editor, nameTargets || [], !!highlightEnabled, accentColor)
  }, [editor, nameTargets, highlightEnabled, accentColor])

  // External value reset hook. When the parent sets `value` back
  // to an empty string (e.g. after a send), clear the editor so
  // the composer becomes empty again. Without this, the editor
  // would still hold the last-typed content because TipTap is
  // uncontrolled by default.
  useEffect(() => {
    if (!editor) return
    if ((value || '') === '' && editor.getText() !== '') {
      editor.commands.clearContent()
    }
  }, [editor, value])

  useImperativeHandle(ref, () => ({
    clear: () => editor?.commands.clearContent(),
    focus: () => editor?.commands.focus(),
    getText: () => editor?.getText({ blockSeparator: '\n' }) || '',
    getEditor: () => editor,
  }), [editor])

  const isEmpty = !editor || editor.isEmpty

  return (
    <div className={`relative ${className || ''}`} data-help-region={dataHelpRegion}>
      <EditorContent
        editor={editor}
        className={innerClassName || ''}
      />
      {/* Manual placeholder — we don't pull in @tiptap/extension-
          placeholder for one string of grey text. Visible only when
          the editor is empty, positioned to match the editor's own
          first-line position via the same padding rules the wrapper
          applies to the inner ProseMirror surface. */}
      {placeholder && isEmpty && (
        <span
          className="absolute top-1.5 left-2 text-xs text-zinc-500 pointer-events-none select-none"
          aria-hidden="true"
        >
          {placeholder}
        </span>
      )}
    </div>
  )
})

export default ChatComposerTipTapInput
