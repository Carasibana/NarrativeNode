/**
 * applyToEditorSection — Phase 2.9b items 4 + 5 + 6 (Apply to Editor
 * Section dispatcher).
 *
 * Given a target Section (identified by surface + section_id), a
 * source markdown string (chat message content or excerpt), and an
 * apply mode (overwrite / append / prepend), this function:
 *
 *   1. Reads the host surface's stored TipTap content from the
 *      appropriate store (project / context-cues / entities /
 *      knowledges).
 *   2. Locates the target Section inside that content.
 *   3. Pushes a PRE-apply Section History snapshot of the section's
 *      current children (so the writer can Step back to the state
 *      they had before the apply).
 *   4. Converts the source markdown to TipTap-compatible HTML via
 *      `markdownToTiptapHtml`. When `opts.plainText` is true, the
 *      source is treated as plain text (no markdown conversion) — used
 *      for the Scene Description Section target (Phase 2.9b item 6 /
 *      planning doc §1.4).
 *   5. Mutates the Section's inner content per the mode:
 *        - 'overwrite' — replaces the existing children with the new
 *          content.
 *        - 'append'    — keeps the existing children and adds the new
 *          content after.
 *        - 'prepend'   — keeps the existing children and adds the new
 *          content before.
 *   6. Writes the mutated host content back through the store's
 *      canonical setter (the same path the live editor uses on every
 *      onUpdate debounce). RichTextEditor's `useEffect([content])`
 *      sync picks up the new value if the editor is currently open
 *      on that surface and re-mounts the editor with the new doc.
 *   7. Pushes a POST-apply snapshot so Step forward returns the writer
 *      to the just-applied state from a stepped-back position.
 *
 * Surface dispatch:
 *
 *   - `scene_main`     — scene's `main_content` (HTML string) on a
 *                        canvas node; write via
 *                        `projectStore.updateNodeData(id, {main_content})`.
 *   - `cue_body`       — cue's `body` (HTML string) in the cues
 *                        store; write via `updateCue(id, {body})`.
 *   - `reference_note` — reference node's `data.content` (TipTap JSON
 *                        string) on a canvas node; the JSON tree is
 *                        walked to find / mutate the section node
 *                        in place. Write via `updateNodeData`.
 *   - `entity_notes`   — entity's `notes` (HTML string) in the
 *                        entities store; write via `updateEntity`.
 *   - `knowledge_notes`— knowledge's `notes` (HTML string) on a
 *                        project knowledge; write via `updateKnowledge`.
 */

import { generateJSON } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Highlight from '@tiptap/extension-highlight'
import TextAlign from '@tiptap/extension-text-align'
import { TextStyle, FontSize, FontFamily } from '@tiptap/extension-text-style'
import Color from '@tiptap/extension-color'
import SectionExtension from '../components/ui/SectionExtension'

import { useProjectStore } from '../store/projectStore'
import { useContextCuesStore } from '../store/contextCuesStore'
import { useEntitiesStore } from '../store/entitiesStore'
import { useSectionHistoryStore } from '../store/sectionHistoryStore'
import { markdownToTiptapHtml } from './markdownToTiptapHtml'

// Must match RichTextEditor's extension list. Duplicated here +
// in ReferenceNode for `generateHTML` / `generateJSON` calls outside
// a live editor instance. If the editor's list changes, update here.
//
// Lazy-built so the `SectionExtension` reference doesn't run at
// module-init time. Phase 2.9c item 7 introduced a static-import
// chain (SectionExtension → SectionView → PromptBlockForm →
// ConversationView → MessageBubble → ApplyToSectionMenu →
// ApplyToSectionPicker → applyToEditorSection) that hits this
// module while SectionExtension is still initialising. Referencing
// SectionExtension in a top-level `const` array triggers a TDZ
// violation in that load order; deferring construction until first
// call breaks the cycle.
let _tiptapExtensionsCache = null
function _getTiptapExtensions() {
  if (_tiptapExtensionsCache) return _tiptapExtensionsCache
  _tiptapExtensionsCache = [
    StarterKit.configure({ link: false, underline: false }),
    Underline,
    Highlight.configure({ multicolor: true }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    TextStyle,
    FontSize,
    FontFamily,
    Color,
    SectionExtension,
  ]
  return _tiptapExtensionsCache
}

function _htmlToFragment(html) {
  if (!html) return []
  try {
    const doc = generateJSON(html, _getTiptapExtensions())
    return Array.isArray(doc?.content) ? doc.content : []
  } catch {
    return []
  }
}

/**
 * Sentinel section_id for the Scene Description target (v0.2.9.71).
 * The Scene Description Section is NOT a TipTap document node — it's
 * the scene's `data.description` plain-text field, surfaced through
 * the Scene Description UI in the editor. When the picker offers it
 * as an Apply target and the writer picks it, the dispatcher routes
 * through a special branch that bypasses the in-document section
 * mutation path and writes directly to `data.description` via
 * `projectStore.updateNodeData`. The section_id is a fixed sentinel
 * (not a UUID) because there's exactly one Scene Description per
 * scene; the surface_host_id tells us which scene.
 */
export const SCENE_DESCRIPTION_SECTION_ID = '__scene_description__'

/**
 * Strip markdown formatting and convert to plain text. Used for the
 * Scene Description target where the `description` field is a plain
 * string (no HTML, no TipTap doc). Same approach as
 * `SceneDescriptionSection.handleSend`'s response-flush path.
 */
function _markdownToPlainText(md) {
  if (!md) return ''
  const html = markdownToTiptapHtml(md)
  if (!html) return ''
  if (typeof document === 'undefined') return md
  const tmp = document.createElement('div')
  tmp.innerHTML = html
  // textContent strips all tags; convert leading/trailing whitespace
  // per paragraph back into single newlines for legibility.
  return (tmp.textContent || '').replace(/\u00A0/g, ' ').trim()
}

function _plainTextToHtml(text) {
  if (!text) return ''
  // Escape HTML special chars, split on blank lines into paragraphs.
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return escaped
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('')
}

function _readHostHtml(surface_type, surface_host_id) {
  if (surface_type === 'scene_main') {
    const node = useProjectStore.getState().nodes.find((n) => n.id === surface_host_id)
    return { ok: !!node, html: node?.data?.main_content || '' }
  }
  if (surface_type === 'cue_body') {
    const cue = useContextCuesStore.getState().getCueById?.(surface_host_id)
    return { ok: !!cue, html: cue?.body || '' }
  }
  if (surface_type === 'entity_notes') {
    const s = useEntitiesStore.getState()
    for (const bucket of [s.characters, s.locations, s.items, s.factions, s.customs]) {
      if (!Array.isArray(bucket)) continue
      const e = bucket.find((x) => x.id === surface_host_id)
      if (e) return { ok: true, html: e.notes || '' }
    }
    return { ok: false, html: '' }
  }
  if (surface_type === 'knowledge_notes') {
    const k = (useProjectStore.getState().knowledges || []).find((kk) => kk.id === surface_host_id)
    return { ok: !!k, html: k?.notes || '' }
  }
  return { ok: false, html: '' }
}

function _writeHostHtml(surface_type, surface_host_id, newHtml) {
  if (surface_type === 'scene_main') {
    useProjectStore.getState().updateNodeData(surface_host_id, { main_content: newHtml })
    return true
  }
  if (surface_type === 'cue_body') {
    const update = useContextCuesStore.getState().updateCue
    if (typeof update === 'function') { update(surface_host_id, { body: newHtml }); return true }
    return false
  }
  if (surface_type === 'entity_notes') {
    const update = useEntitiesStore.getState().updateEntity
    if (typeof update === 'function') { update(surface_host_id, { notes: newHtml }); return true }
    return false
  }
  if (surface_type === 'knowledge_notes') {
    const update = useProjectStore.getState().updateKnowledge
    if (typeof update === 'function') { update(surface_host_id, { notes: newHtml }); return true }
    return false
  }
  return false
}

/**
 * Mutate a section element's inner HTML inside a parsed host document
 * per the apply mode, then return the serialized host HTML.
 *
 * Returns `{ ok, preInner, postInner, newHostHtml }` so the caller can
 * push the pre / post Section History snapshots before / after the
 * store write.
 */
function _mutateHtmlSection(hostHtml, section_id, contentHtml, mode) {
  let doc
  try {
    doc = new DOMParser().parseFromString(hostHtml, 'text/html')
  } catch {
    return { ok: false }
  }
  const idEsc = (window.CSS && CSS.escape) ? CSS.escape(section_id) : section_id
  const el = doc.querySelector(`div[data-nn-section][data-id="${idEsc}"]`)
  if (!el) return { ok: false }
  const preInner = el.innerHTML
  let postInner
  if (mode === 'overwrite') postInner = contentHtml
  else if (mode === 'append') postInner = preInner + contentHtml
  else if (mode === 'prepend') postInner = contentHtml + preInner
  else return { ok: false }
  el.innerHTML = postInner
  return { ok: true, preInner, postInner, newHostHtml: doc.body.innerHTML }
}

/**
 * Reference-note variant — host content is TipTap JSON, not HTML.
 * Walks the JSON tree to find / mutate the section node, then writes
 * the JSON back. The pre / post snapshot extraction uses the JSON
 * children directly (no need to round-trip through HTML).
 */
function _mutateJsonReferenceNote(node, section_id, postChildrenJson, mode) {
  if (!node) return null
  if (node.type === 'section' && node.attrs?.id === section_id) {
    const preChildren = Array.isArray(node.content) ? node.content : []
    let newChildren
    if (mode === 'overwrite') newChildren = postChildrenJson
    else if (mode === 'append') newChildren = [...preChildren, ...postChildrenJson]
    else if (mode === 'prepend') newChildren = [...postChildrenJson, ...preChildren]
    else return null
    return { matched: true, preChildren, postChildren: newChildren, node: { ...node, content: newChildren } }
  }
  if (Array.isArray(node.content)) {
    for (let i = 0; i < node.content.length; i += 1) {
      const childResult = _mutateJsonReferenceNote(node.content[i], section_id, postChildrenJson, mode)
      if (childResult && childResult.matched) {
        const newContent = [...node.content]
        newContent[i] = childResult.node
        return {
          matched: true,
          preChildren: childResult.preChildren,
          postChildren: childResult.postChildren,
          node: { ...node, content: newContent },
        }
      }
    }
  }
  return { matched: false }
}

/**
 * Apply chat-message markdown (or plain text) to a target Section.
 *
 * @returns {{ success: boolean, error?: string }}
 */
export function applyToEditorSection(opts) {
  const {
    surface_type,
    surface_host_id,
    section_id,
    sourceMarkdown,
    mode,
    plainText = false,
  } = opts || {}

  if (!surface_type || !surface_host_id || !section_id) {
    return { success: false, error: 'missing-target' }
  }
  if (typeof sourceMarkdown !== 'string') {
    return { success: false, error: 'missing-source' }
  }
  if (!['overwrite', 'append', 'prepend'].includes(mode)) {
    return { success: false, error: 'invalid-mode' }
  }

  const sectionHistory = useSectionHistoryStore.getState()

  // v0.2.9.71 — Scene Description target. The Scene Description is the
  // scene node's `data.description` plain-text field, NOT a TipTap
  // section node embedded in the prose document. Bypass the in-document
  // mutation pipeline entirely: read the existing plain-text
  // description, apply the mode on it directly, write back via
  // `updateNodeData`. History snapshots key on `sd:${sceneId}` to
  // match the Scene Description PBH's keying convention (v0.2.9.42).
  if (section_id === SCENE_DESCRIPTION_SECTION_ID) {
    if (surface_type !== 'scene_main') {
      return { success: false, error: 'scene-description-wrong-surface' }
    }
    const node = useProjectStore.getState().nodes.find((n) => n.id === surface_host_id)
    if (!node) return { success: false, error: 'host-not-found' }
    const preText = typeof node.data?.description === 'string' ? node.data.description : ''
    const incomingText = _markdownToPlainText(sourceMarkdown)
    let nextText
    if (mode === 'overwrite') nextText = incomingText
    else if (mode === 'append') nextText = preText ? `${preText}\n\n${incomingText}` : incomingText
    else if (mode === 'prepend') nextText = preText ? `${incomingText}\n\n${preText}` : incomingText
    else return { success: false, error: 'invalid-mode' }
    // Snapshots use the same `sd:${sceneId}` key the Scene Description
    // PBH (v0.2.9.42) uses, so Step back / Step forward unify the
    // history across both write paths (PBH fires + Apply-to-Editor
    // fires both land in one timeline).
    const sdKey = `sd:${surface_host_id}`
    // Snapshot shape: a single text-paragraph fragment. The PBH's own
    // snapshot pattern flushes plain-string content; we mirror that
    // shape here so Step back returns a usable snapshot.
    sectionHistory.pushSnapshot(sdKey, preText)
    useProjectStore.getState().updateNodeData(surface_host_id, { description: nextText })
    sectionHistory.pushSnapshot(sdKey, nextText)
    return { success: true }
  }

  const contentHtml = plainText
    ? _plainTextToHtml(sourceMarkdown)
    : markdownToTiptapHtml(sourceMarkdown)

  // Reference notes store TipTap JSON; HTML surfaces store HTML.
  if (surface_type === 'reference_note') {
    const node = useProjectStore.getState().nodes.find((n) => n.id === surface_host_id)
    if (!node) return { success: false, error: 'host-not-found' }
    const raw = node.data?.content
    let parsed
    try {
      parsed = typeof raw === 'string' && raw.trim().startsWith('{') ? JSON.parse(raw) : null
    } catch {
      parsed = null
    }
    if (!parsed) return { success: false, error: 'host-not-json' }
    const newChildrenJson = _htmlToFragment(contentHtml)
    const result = _mutateJsonReferenceNote(parsed, section_id, newChildrenJson, mode)
    if (!result || !result.matched) return { success: false, error: 'section-not-found' }
    sectionHistory.pushSnapshot(section_id, result.preChildren)
    useProjectStore.getState().updateNodeData(surface_host_id, { content: JSON.stringify(result.node) })
    sectionHistory.pushSnapshot(section_id, result.postChildren)
    return { success: true }
  }

  const { ok: hostOk, html: hostHtml } = _readHostHtml(surface_type, surface_host_id)
  if (!hostOk) return { success: false, error: 'host-not-found' }

  const mutation = _mutateHtmlSection(hostHtml, section_id, contentHtml, mode)
  if (!mutation.ok) return { success: false, error: 'section-not-found' }

  const preFragment = _htmlToFragment(mutation.preInner)
  sectionHistory.pushSnapshot(section_id, preFragment)

  const wrote = _writeHostHtml(surface_type, surface_host_id, mutation.newHostHtml)
  if (!wrote) return { success: false, error: 'host-write-failed' }

  const postFragment = _htmlToFragment(mutation.postInner)
  sectionHistory.pushSnapshot(section_id, postFragment)

  return { success: true }
}

/**
 * Enumerate all named Sections present in a given editor surface's
 * stored content. Used by the chat panel's Apply menu to populate the
 * target picker. Returns `Array<{ id, name }>` in document order;
 * empty when the surface is empty or has no sections.
 */
export function listSectionsInSurface(surface_type, surface_host_id) {
  if (!surface_type || !surface_host_id) return []

  if (surface_type === 'reference_note') {
    const node = useProjectStore.getState().nodes.find((n) => n.id === surface_host_id)
    if (!node) return []
    const raw = node.data?.content
    let parsed
    try {
      parsed = typeof raw === 'string' && raw.trim().startsWith('{') ? JSON.parse(raw) : null
    } catch {
      parsed = null
    }
    if (!parsed) return []
    const out = []
    function _walk(n) {
      if (!n) return
      if (n.type === 'section' && n.attrs?.id) {
        out.push({ id: n.attrs.id, name: n.attrs.name || '' })
      }
      if (Array.isArray(n.content)) n.content.forEach(_walk)
    }
    _walk(parsed)
    return out
  }

  const { ok, html } = _readHostHtml(surface_type, surface_host_id)
  if (!ok || !html) return []
  let doc
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return []
  }
  const els = doc.querySelectorAll('div[data-nn-section]')
  const out = []
  els.forEach((el) => {
    const id = el.getAttribute('data-id')
    if (!id) return
    out.push({ id, name: el.getAttribute('data-name') || '' })
  })
  return out
}
