import { forwardRef, useEffect, useImperativeHandle, useMemo } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import { Node, InputRule } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'

/**
 * PlaceholderPillEditor — Phase 2.11a item 3.
 *
 * Reusable inline-pill editor for template strings carrying `{{name}}`
 * placeholders. The visible editor renders each `{{name}}` token as an
 * atomic visual pill (matching the dynamic-pill style used elsewhere
 * in the chat panel's context attachments); the underlying storage is
 * the plain template string — `{{name}}` in, `{{name}}` out.
 *
 * Used by the Persona Preamble editor (Phase 2.11a item 4) and any
 * future placeholder-bearing editor surface.
 *
 *   ─── Behaviour ─────────────────────────────────────────────────────
 *
 * 1. Typing `{{character_name}}` literally — as soon as the closing
 *    `}}` is typed, the literal text is replaced with a pill node.
 * 2. Backspace from immediately after a pill deletes the pill atomically.
 * 3. Arrow keys treat a pill as a single character.
 * 4. Selection sweeps over a pill as a unit (the pill is an atomic
 *    inline node — TipTap's NodeSelection handles this natively).
 * 5. The pill's DOM is `contenteditable=false` so writers can't edit
 *    the inner `{{...}}` text directly. To rename a placeholder, the
 *    writer deletes the pill and types / inserts a new one.
 *
 *   ─── Storage round-trip ────────────────────────────────────────────
 *
 * Input: a plain string with optional `{{name}}` segments.
 * Editor renders: text nodes + atomic placeholderPill nodes.
 * Output (onChange): the equivalent plain string.
 *
 * Underlying storage stays text. Pill rendering is presentation-only.
 *
 *   ─── Props ─────────────────────────────────────────────────────────
 *
 *   - value          string — current template text, with literal
 *                     `{{name}}` segments where placeholders should
 *                     render as pills.
 *   - onChange(next) string — called with the next template text on
 *                     every editor change.
 *   - disabled?      boolean — set the editor to read-only when true.
 *   - autoFocus?     boolean — focus on mount.
 *   - className?     string — extra classes on the editor surface.
 *   - minHeight?     string — CSS min-height for the editor surface
 *                     (e.g. '6rem').
 *
 *   ─── Imperative API (via ref) ──────────────────────────────────────
 *
 *   - insertPlaceholder(name) → void
 *       Inserts a placeholder pill at the current cursor position.
 *       Used by host UIs that want an "Insert {name}" button instead
 *       of (or in addition to) requiring the writer to type the
 *       `{{name}}` literal themselves.
 *   - focus() → void
 *       Focuses the editor.
 */

const PLACEHOLDER_RE = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g

// Custom TipTap Node — atomic inline pill rendered for each `{{name}}`
// in the template. The node's only attribute is `pname` (the
// placeholder name string, e.g. "character_name").
const PlaceholderPill = Node.create({
  name: 'placeholderPill',
  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      pname: {
        default: 'placeholder',
        parseHTML: (el) => el.getAttribute('data-placeholder-name') || 'placeholder',
        renderHTML: (attrs) => ({ 'data-placeholder-name': attrs.pname }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-placeholder-name]' }]
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      'span',
      {
        ...HTMLAttributes,
        class: 'nn-placeholder-pill nn-pill-dynamic',
        contenteditable: 'false',
      },
      `{{${node.attrs.pname}}}`,
    ]
  },

  // Plain-text serialisation used by editor.getText() and by our
  // own docToString() walker below (defensive double-coverage; if
  // a future TipTap API change drops renderText, the walker still
  // emits the canonical token).
  renderText({ node }) {
    return `{{${node.attrs.pname}}}`
  },

  // Input rule: when the writer types `}}` to close a `{{name}}`
  // pattern, replace the entire `{{name}}` text with the pill node.
  // Pattern is anchored at end of input (`$`) per TipTap input-rule
  // convention — the rule fires on the typed character that completes
  // the pattern.
  addInputRules() {
    return [
      new InputRule({
        find: /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}$/,
        handler: ({ range, match, chain }) => {
          const name = match[1]
          chain()
            .deleteRange({ from: range.from, to: range.to })
            .insertContent({
              type: 'placeholderPill',
              attrs: { pname: name },
            })
            .run()
        },
      }),
    ]
  },
})

// ── String ⇄ TipTap doc conversion ────────────────────────────────────

// Convert a plain template string into a TipTap doc JSON. The result
// has a single paragraph with interleaved text + placeholderPill nodes.
function stringToDocJson(text) {
  const parts = []
  const re = new RegExp(PLACEHOLDER_RE.source, 'g')
  let last = 0
  let m
  while ((m = re.exec(text || '')) !== null) {
    if (m.index > last) {
      parts.push({ type: 'text', text: (text || '').slice(last, m.index) })
    }
    parts.push({ type: 'placeholderPill', attrs: { pname: m[1] } })
    last = m.index + m[0].length
  }
  if (last < (text || '').length) {
    parts.push({ type: 'text', text: (text || '').slice(last) })
  }
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: parts }],
  }
}

// Walk a TipTap doc and emit the equivalent plain string. Pill nodes
// emit `{{pname}}`; text nodes emit their literal text. Paragraph
// breaks emit `\n` (we don't normally expect multi-paragraph content
// in this editor since the host UIs use it for single-block template
// strings, but the walker handles it defensively if shift-enter or a
// paste introduces a hard break).
function docToString(doc) {
  let out = ''
  let firstPara = true
  doc.forEach((para) => {
    if (!firstPara) out += '\n'
    firstPara = false
    para.forEach((child) => {
      if (child.isText) {
        out += child.text
      } else if (child.type.name === 'placeholderPill') {
        out += `{{${child.attrs.pname}}}`
      }
    })
  })
  return out
}

// ── Editor component ──────────────────────────────────────────────────

const PlaceholderPillEditor = forwardRef(function PlaceholderPillEditor(
  { value, onChange, disabled = false, autoFocus = false, className = '', minHeight = '4rem' },
  ref,
) {
  const initialDoc = useMemo(() => stringToDocJson(value || ''), [])
  // `initialDoc` is intentionally a one-shot — we don't want the editor
  // to re-mount whenever `value` changes (that would lose cursor /
  // focus / history). External-value-replaces-internal-state sync is
  // handled below via a manual commands.setContent() in a useEffect.
   

  const editor = useEditor({
    extensions: [
      // StarterKit pulls in Document, Paragraph, Text, History, and
      // the cursor helpers. Block extensions we don't want for a
      // template-text editor (heading / lists / blockquote / etc.)
      // are disabled here — the writer should be typing a single-
      // paragraph template string, not authoring rich prose. Markdown
      // shortcuts like `# foo` or `- ` won't trigger anything.
      StarterKit.configure({
        heading: false,
        blockquote: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        codeBlock: false,
        code: false,
        horizontalRule: false,
        bold: false,
        italic: false,
        strike: false,
        link: false,
      }),
      PlaceholderPill,
    ],
    content: initialDoc,
    editable: !disabled,
    autofocus: autoFocus,
    onUpdate({ editor: ed }) {
      onChange?.(docToString(ed.state.doc))
    },
  })

  // External-value sync: if the parent passes a new `value` that
  // differs from the editor's current content, replace the document.
  // Skip when the diff is one we just emitted (the parent's onChange
  // round-trip would otherwise cause a render loop).
  useEffect(() => {
    if (!editor) return
    const current = docToString(editor.state.doc)
    if (current === (value || '')) return
    editor.commands.setContent(stringToDocJson(value || ''), { emitUpdate: false })
  }, [value, editor])

  // Track disabled prop changes after mount.
  useEffect(() => {
    if (!editor) return
    editor.setEditable(!disabled)
  }, [disabled, editor])

  useImperativeHandle(ref, () => ({
    insertPlaceholder(name) {
      if (!editor) return
      editor.chain().focus().insertContent({
        type: 'placeholderPill',
        attrs: { pname: name },
      }).run()
    },
    focus() {
      editor?.commands.focus()
    },
  }), [editor])

  return (
    <div
      className={`nn-placeholder-pill-editor ${className}`}
      style={{ minHeight }}
      data-help-region="placeholder-pill-editor:editor"
    >
      <EditorContent editor={editor} />
    </div>
  )
})

export default PlaceholderPillEditor
