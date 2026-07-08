/**
 * findSectionContent — Phase 2.9b item 1.
 *
 * Given a Section pill's `(surface_type, surface_host_id, section_id)`
 * triple, walks the appropriate store to find the host object,
 * extracts its TipTap content (HTML or JSON), then locates the
 * section node with the matching id and returns its name + inner
 * HTML content.
 *
 * Used by:
 *   - `sceneContextPrompt.js` at send time, to bundle the section's
 *     prose into the AI request's context block.
 *   - `ConversationView.jsx` per render, to resolve the section's
 *     display name for the pinned-context chip in the chat composer's
 *     context strip.
 *
 * Returns:
 *   { name, htmlContent } when the section is found, or
 *   null when the host surface or section can't be resolved (host
 *   was deleted, surface emptied, section removed, etc.). Callers
 *   should treat null as "pill is stale; render a placeholder or
 *   skip from the context bundle".
 *
 * Surface types — what the host's TipTap content field is called and
 * how it's stored:
 *   - `scene_main`     → `node.data.main_content` (HTML string)
 *   - `cue_body`       → `cue.body` (HTML string)
 *   - `reference_note` → `node.data.content` (JSON string —
 *                        reference notes store TipTap JSON, NOT HTML)
 *   - `entity_notes`   → `entity.notes` (HTML string)
 *   - `knowledge_notes`→ `knowledge.notes` (HTML string)
 */

import { useProjectStore } from '../store/projectStore'
import { useContextCuesStore } from '../store/contextCuesStore'
import { useEntitiesStore } from '../store/entitiesStore'

function _findInHtml(html, sectionId) {
  if (!html || typeof html !== 'string') return null
  // Use DOMParser to find the section element by its data-id attr.
  // DOMParser is attr-aware (handles HTML-escaped values) and
  // structurally aware (handles nested cases — we want the OUTERMOST
  // match, and querySelector returns it in document order).
  let doc
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return null
  }
  const sel = `div[data-nn-section][data-id="${(window.CSS && CSS.escape ? CSS.escape(sectionId) : sectionId)}"]`
  const el = doc.querySelector(sel)
  if (!el) return null
  return {
    name: el.getAttribute('data-name') || '',
    htmlContent: el.innerHTML,
  }
}

function _findInJsonNode(node, sectionId) {
  if (!node) return null
  if (node.type === 'section' && node.attrs && node.attrs.id === sectionId) {
    // Best-effort: build a tiny HTML string from the JSON children
    // tree. We don't have the TipTap schema available here, so we
    // walk text-leaf-first and concatenate; paragraph-like nodes
    // get separated by <p>...</p>. This loses rich-text marks but
    // preserves block structure enough for plain-text / markdown
    // extraction downstream. Reference notes (the only JSON-storing
    // surface today) rarely contain marks that aren't preserved by
    // this fallback.
    return {
      name: (node.attrs.name || ''),
      htmlContent: _renderJsonFragmentToHtml(node.content || []),
    }
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      const found = _findInJsonNode(child, sectionId)
      if (found) return found
    }
  }
  return null
}

function _renderJsonFragmentToHtml(fragment) {
  if (!Array.isArray(fragment) || fragment.length === 0) return ''
  const parts = []
  for (const node of fragment) {
    if (!node || !node.type) continue
    if (node.type === 'text') {
      parts.push(String(node.text || ''))
      continue
    }
    const inner = _renderJsonFragmentToHtml(node.content || [])
    // Tag map covers the common block / inline types from StarterKit.
    // Unknown types fall back to a div wrapper.
    let tag = 'div'
    if (node.type === 'paragraph') tag = 'p'
    else if (node.type === 'heading') tag = `h${(node.attrs && node.attrs.level) || 1}`
    else if (node.type === 'bulletList') tag = 'ul'
    else if (node.type === 'orderedList') tag = 'ol'
    else if (node.type === 'listItem') tag = 'li'
    else if (node.type === 'blockquote') tag = 'blockquote'
    else if (node.type === 'codeBlock') tag = 'pre'
    else if (node.type === 'horizontalRule') { parts.push('<hr>'); continue }
    else if (node.type === 'hardBreak') { parts.push('<br>'); continue }
    parts.push(`<${tag}>${inner}</${tag}>`)
  }
  return parts.join('')
}

/**
 * findSectionHostInfo — resolve the host object that owns a Section
 * surface so callers can render an identity badge / descriptive
 * phrase WITHOUT also walking for the section's content.
 *
 * Used by:
 *   - `ConversationView.jsx` — the Section pinned-chip's anchor badge
 *     (`@ <host name>`) so the writer can see which scene / cue / etc.
 *     the Section is from. The badge follows the host, NOT the
 *     conversation's currently-active scene.
 *   - `sceneContextPrompt.js` — to descriptively frame the Section
 *     in the bundled LLM context (e.g. "Section "X" from the main
 *     body of scene "Y"") instead of the bare internal term
 *     "Section" which the model has no reference for.
 *
 * Returns `{ hostKind, hostName, hostPhrase }` or `null`:
 *   - `hostKind`  — `'scene'` / `'cue'` / `'reference'` / `'entity'`
 *                   / `'knowledge'` — used by the chip to colour-code
 *                   the badge to match the host kind's existing tone.
 *   - `hostName`  — the host's display name (scene title, cue name,
 *                   etc.). What the chip badge shows.
 *   - `hostPhrase`— descriptive long-form phrase for the LLM context
 *                   heading. Includes the host's name AND enough
 *                   framing for the model to understand what KIND of
 *                   thing the Section is excerpted from.
 */
export function findSectionHostInfo(surfaceType, surfaceHostId) {
  if (!surfaceType || !surfaceHostId) return null

  if (surfaceType === 'scene_main') {
    const node = useProjectStore.getState().nodes.find((n) => n.id === surfaceHostId)
    if (!node) return null
    const title = (node.data?.title || '').trim() || 'Untitled scene'
    return {
      hostKind: 'scene',
      hostName: title,
      hostPhrase: `the main body of scene "${title}"`,
    }
  }

  if (surfaceType === 'cue_body') {
    const getCueById = useContextCuesStore.getState().getCueById
    const cue = typeof getCueById === 'function' ? getCueById(surfaceHostId) : null
    if (!cue) return null
    const name = (cue.name || '').trim() || 'Untitled context cue'
    return {
      hostKind: 'cue',
      hostName: name,
      hostPhrase: `the context cue "${name}"`,
    }
  }

  if (surfaceType === 'reference_note') {
    const node = useProjectStore.getState().nodes.find((n) => n.id === surfaceHostId)
    if (!node) return null
    const title = (node.data?.title || '').trim() || 'Untitled reference'
    return {
      hostKind: 'reference',
      hostName: title,
      hostPhrase: `the reference note "${title}"`,
    }
  }

  if (surfaceType === 'entity_notes') {
    const s = useEntitiesStore.getState()
    for (const bucket of [s.characters, s.locations, s.items, s.factions, s.customs]) {
      if (!Array.isArray(bucket)) continue
      const e = bucket.find((x) => x.id === surfaceHostId)
      if (e) {
        const name = (e.name || '').trim() || 'Unnamed entity'
        return {
          hostKind: 'entity',
          hostName: name,
          hostPhrase: `the Notes field of ${name}`,
        }
      }
    }
    return null
  }

  if (surfaceType === 'knowledge_notes') {
    const k = (useProjectStore.getState().knowledges || []).find(
      (kk) => kk.id === surfaceHostId,
    )
    if (!k) return null
    const name = (k.name || '').trim() || 'Unnamed knowledge'
    return {
      hostKind: 'knowledge',
      hostName: name,
      hostPhrase: `the Notes field of knowledge "${name}"`,
    }
  }

  return null
}

export function findSectionContent(surfaceType, surfaceHostId, sectionId) {
  if (!surfaceType || !surfaceHostId || !sectionId) return null

  if (surfaceType === 'scene_main') {
    const node = useProjectStore.getState().nodes.find((n) => n.id === surfaceHostId)
    if (!node) return null
    return _findInHtml(node.data?.main_content, sectionId)
  }

  if (surfaceType === 'cue_body') {
    const getCueById = useContextCuesStore.getState().getCueById
    const cue = typeof getCueById === 'function' ? getCueById(surfaceHostId) : null
    if (!cue) return null
    return _findInHtml(cue.body, sectionId)
  }

  if (surfaceType === 'reference_note') {
    const node = useProjectStore.getState().nodes.find((n) => n.id === surfaceHostId)
    if (!node) return null
    const raw = node.data?.content
    if (!raw) return null
    let parsed
    try {
      parsed = typeof raw === 'string' && raw.trim().startsWith('{') ? JSON.parse(raw) : null
    } catch {
      parsed = null
    }
    if (parsed) return _findInJsonNode(parsed, sectionId)
    // Fallback: if the reference-note content turned out to be HTML
    // (legacy / migrated data), try the HTML path.
    return typeof raw === 'string' ? _findInHtml(raw, sectionId) : null
  }

  if (surfaceType === 'entity_notes') {
    const s = useEntitiesStore.getState()
    for (const bucket of [s.characters, s.locations, s.items, s.factions, s.customs]) {
      if (!Array.isArray(bucket)) continue
      const e = bucket.find((x) => x.id === surfaceHostId)
      if (e) return _findInHtml(e.notes, sectionId)
    }
    return null
  }

  if (surfaceType === 'knowledge_notes') {
    const k = (useProjectStore.getState().knowledges || []).find(
      (kk) => kk.id === surfaceHostId,
    )
    if (!k) return null
    return _findInHtml(k.notes, sectionId)
  }

  return null
}
