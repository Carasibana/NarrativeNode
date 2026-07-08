import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

/**
 * Phase 1.24c — Find-match highlight extension.
 *
 * Companion to `FindReplacePanel`. Renders ProseMirror decorations
 * that visually mark every match for the active query AND the
 * single "current" match the writer has stepped to. The stepped-to
 * match is styled like a normal text selection (so the writer reads
 * it as if they had drag-selected the text), and the remaining
 * matches get a subtler tint so their positions are visible at a
 * glance. CSS for both classes lives next to the EntityHighlight
 * styles (see `index.css`).
 *
 * Decoration approach (not selection / not a Mark):
 *   - Selection wouldn't render as highlighted while focus is in
 *     the find/replace input — browsers grey out an unfocused
 *     element's selection. Decorations are visual-only and keep
 *     their styling regardless of focus.
 *   - Marks would mutate the document and create undo entries.
 *     Decorations don't touch the doc.
 *
 * Usage: call `refreshFindMatchHighlights(editor, matches, currentIdx)`
 * whenever the panel's match list or current index changes. Pass
 * `null` / `[]` to clear.
 */
const FIND_MATCH_HIGHLIGHT_KEY = new PluginKey('findMatchHighlight')

function buildDecorations(doc, matches, currentIdx) {
  if (!matches || matches.length === 0) return DecorationSet.empty
  const decos = []
  const docSize = doc.content.size
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]
    if (!m) continue
    const from = Math.max(0, Math.min(m.from, docSize))
    const to = Math.max(0, Math.min(m.to, docSize))
    if (from >= to) continue
    const isCurrent = i === currentIdx
    decos.push(
      Decoration.inline(from, to, {
        class: isCurrent ? 'nn-find-match-current' : 'nn-find-match-other',
      })
    )
  }
  return DecorationSet.create(doc, decos)
}

export const FindMatchHighlightExtension = Extension.create({
  name: 'findMatchHighlight',

  addProseMirrorPlugins() {
    let currentMatches = []
    let currentIdx = -1

    return [
      new Plugin({
        key: FIND_MATCH_HIGHLIGHT_KEY,
        state: {
          init() {
            return DecorationSet.empty
          },
          apply(tr, oldDecos) {
            const meta = tr.getMeta(FIND_MATCH_HIGHLIGHT_KEY)
            if (meta) {
              currentMatches = meta.matches || []
              currentIdx = typeof meta.currentIdx === 'number' ? meta.currentIdx : -1
              return buildDecorations(tr.doc, currentMatches, currentIdx)
            }
            if (currentMatches.length === 0) return DecorationSet.empty
            // Doc change while highlights are live: positions may
            // shift. Mapping the existing decoration set is the
            // cheap path; the panel will re-emit fresh ranges via
            // `refreshFindMatchHighlights` next render anyway.
            if (tr.docChanged) return oldDecos.map(tr.mapping, tr.doc)
            return oldDecos
          },
        },
        props: {
          decorations(state) {
            return FIND_MATCH_HIGHLIGHT_KEY.getState(state)
          },
        },
      }),
    ]
  },
})

export function refreshFindMatchHighlights(editor, matches, currentIdx) {
  if (!editor) return
  editor.view.dispatch(
    editor.view.state.tr.setMeta(FIND_MATCH_HIGHLIGHT_KEY, { matches, currentIdx })
  )
}
