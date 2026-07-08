import { useEffect, useMemo, useRef, useState } from 'react'
import { useUiStore } from '../../store/uiStore'
import { useProjectStore } from '../../store/projectStore'


// Stable empty array used by the per-thread scenes selector below.
// See same-named constant in ConversationView / StoryScopeControls
// for the Zustand-selector-stability rationale.
const _EMPTY_SCENE_IDS = Object.freeze([])
import { useSystemPromptsStore } from '../../store/systemPromptsStore'
import { useSettingsStore } from '../../store/settingsStore'
import { useConversationsStore } from '../../store/conversationsStore'
import { buildStoryScopeAppendage } from '../../utils/storyScopePrompt'
import { buildStoryScopeBundle } from '../../utils/storyScopeBundleBuilder'
import { getLiveStoryEntitiesShape } from '../../store/entitiesStore'
import { MarkdownBody } from './MessageBubble'
import { useAccentColor } from '../../utils/povConstants'


/**
 * System-prompt preview modal — Phase 2.5h.
 *
 * Audit surface for "what's the model currently being sent on the
 * system-prompt side". Two visually distinct stacked sections:
 *
 *   1. Your system prompt — the writer's chosen base prompt verbatim.
 *   2. Story-scope appendage — the rendered output of
 *      `buildStoryScopeAppendage` against current per-thread state.
 *      Hidden when story-scope is off / produces empty output.
 *
 * Behaves like the existing scene-context preview modal — same shell,
 * same MD / Raw toggle, same Esc / backdrop close. The literal
 * `## Additional story context` heading sits inside the appendage
 * section because it's part of the actual payload the model sees.
 */
export default function SystemPromptPreviewModal({ threadId, focusKey, onClose }) {
  const [renderMode, setRenderMode] = useState('markdown')
  const accent = useAccentColor() || '#7c3aed'

  // Active system prompt — resolved the same way the send path does:
  // thread override → preferences default → null.
  const prefs           = useSettingsStore((s) => s.preferences)
  const systemPrompts   = useSystemPromptsStore((s) => s.prompts)
  const thread          = useConversationsStore((s) => s.byId[threadId] || null)
  const activeSystemPrompt = useMemo(() => {
    const id = thread?.system_prompt_id || prefs?.default_system_prompt_id || null
    if (!id) return null
    return (systemPrompts || []).find((p) => p.id === id) || null
  }, [systemPrompts, thread, prefs])

  // Per-thread Story Scope state. Pulled fresh so the preview always
  // reflects the writer's current popup settings.
  const mode         = useUiStore((s) => (threadId ? s.chatStoryScopeMode?.[threadId] || null : null))
  const scopeScenes  = useUiStore((s) => (threadId && s.chatStoryScopeScenes?.[threadId]) || _EMPTY_SCENE_IDS)
  const scopeChapter = useUiStore((s) => (threadId ? s.chatStoryScopeChapter?.[threadId] || null : null))
  const scopeAct     = useUiStore((s) => (threadId ? s.chatStoryScopeAct?.[threadId] || null : null))
  const includePrev  = useUiStore((s) => (threadId ? !!s.chatStoryScopeIncludePrev?.[threadId] : false))
  const includeNext  = useUiStore((s) => (threadId ? !!s.chatStoryScopeIncludeNext?.[threadId] : false))
  const activeSceneId = useUiStore((s) => s.chatActiveSceneId)
  const story = useProjectStore((s) => s.story)
  const nodes = useProjectStore((s) => s.nodes)
  const edges = useProjectStore((s) => s.edges)
  // Phase 2.13c — live top-level knowledges + relationships so the
  // perspective target lookup in the change-line walker resolves
  // against current state. `ps.story.knowledges` / `.relationships`
  // are stale snapshots from the last save/load.
  const knowledges    = useProjectStore((s) => s.knowledges)
  const relationships = useProjectStore((s) => s.relationships)

  // Ref for the rendered-body container — focus-and-highlight runs
  // its querySelectorAll against this rather than `document` so
  // there's no risk of matching headings outside the modal body.
  const bodyRef = useRef(null)

  // Compute the appendage. Recomputed on every change to scope state
  // — see the planning doc's "always recompute, no caching" rule.
  const appendage = useMemo(() => {
    try {
      const bundle = buildStoryScopeBundle({
        mode,
        scopeScenes,
        scopeChapter,
        scopeAct,
        includePrev,
        includeNext,
        activeSceneId,
        // `story.entities` is a load-time / save-time snapshot — it does
        // NOT include entities created mid-session. Override with the
        // live entitiesStore shape so the preview reflects what the AI
        // will actually receive, even for mid-session-created entities.
        // See `entitiesStore.js` header comment for the two-store lifecycle.
        story: { ...(story || {}), entities: getLiveStoryEntitiesShape() },
        nodes: nodes || [],
        edges: edges || [],
        // Phase 2.13c — live knowledges + relationships so perspective
        // target lookups in the change-line walker resolve against
        // current state rather than the stale `story.*` snapshot.
        knowledges,
        relationships,
      })
      return buildStoryScopeAppendage(bundle)
    } catch {
      return ''
    }
  }, [mode, scopeScenes, scopeChapter, scopeAct, includePrev, includeNext, activeSceneId, story, nodes, edges])

  const writerPrompt = (activeSystemPrompt?.prompt || '').trim()
  // The appendage section is hidden entirely when there's no output —
  // matches the send-path behaviour (no separator, system prompt
  // stays verbatim).
  const appendageSection = appendage
    ? `## Additional story context\n\n${appendage}`
    : ''

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Phase 2.5h follow-up — focus-and-highlight. When the chip click
  // identifies a specific scope axis, scroll to the matching heading
  // and tint its section so the writer can see where in the rendered
  // appendage that chip's contribution lives. Runs once per focusKey
  // change, only in markdown render mode (raw mode is one big <pre>
  // with no semantic headings). Mirrors the scene-context preview
  // modal's focus-item interaction.
  useEffect(() => {
    if (!focusKey || renderMode !== 'markdown') return
    if (!bodyRef.current) return
    if (!appendage) return  // nothing to scroll into
    const root = bodyRef.current
    const raf = requestAnimationFrame(() => {
      const target = _findFocusTarget(root, focusKey, {
        story,
        nodes,
        scopeChapter,
        scopeAct,
      })
      if (!target) return
      target.scrollIntoView({ behavior: 'smooth', block: 'start' })
      // Collect heading + every following sibling up to the next
      // same-or-higher heading. That covers the whole section body
      // (description, position line, change list, etc.), not just
      // the heading itself.
      const stopAt = _stopTagsForHeading(target.tagName)
      const sectionNodes = [target]
      let next = target.nextElementSibling
      while (next) {
        if (stopAt.has(next.tagName)) break
        sectionNodes.push(next)
        next = next.nextElementSibling
      }
      const tint = _hexToRgba(accent, 0.18)
      for (const el of sectionNodes) {
        el.style.transition = 'background-color 400ms ease'
        el.style.backgroundColor = tint
      }
      setTimeout(() => {
        for (const el of sectionNodes) el.style.backgroundColor = 'transparent'
        setTimeout(() => {
          for (const el of sectionNodes) {
            el.style.transition = ''
            el.style.backgroundColor = ''
          }
        }, 450)
      }, 1500)
    })
    return () => cancelAnimationFrame(raf)
  }, [focusKey, renderMode, appendage, story, nodes, scopeChapter, scopeAct, accent])

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-md shadow-xl max-w-[720px] w-[92vw] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        data-help-region="system-prompt-preview:modal"
      >
        <div className="px-4 py-2.5 border-b border-zinc-800 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-xs text-zinc-300 font-semibold truncate">System Prompt Preview</div>
            <div className="text-[10px] text-zinc-500 truncate">
              Exactly what the model receives on the system-prompt side.
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              type="button"
              onClick={() => setRenderMode((m) => (m === 'markdown' ? 'raw' : 'markdown'))}
              title={renderMode === 'markdown'
                ? 'Currently rendered as Markdown. Click to flip to raw text.'
                : 'Currently showing raw text. Click to flip to rendered Markdown.'}
              aria-pressed={renderMode === 'markdown'}
              data-help-region="system-prompt-preview:view_mode"
              className="text-[9px] px-1.5 py-px rounded border border-zinc-700 bg-zinc-800/40 text-zinc-500 hover:text-zinc-300 transition-colors flex-shrink-0"
            >
              {renderMode === 'markdown' ? 'MD' : 'Raw'}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close system-prompt preview"
              className="text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60 rounded w-6 h-6 flex items-center justify-center"
            >
              ✕
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          <PreviewSection
            heading="Your system prompt"
            body={writerPrompt || '(No system prompt selected for this thread.)'}
            empty={!writerPrompt}
            renderMode={renderMode}
            accent={accent}
            dataHelpRegion="system-prompt-preview:base_prompt"
          />
          {appendageSection && (
            <PreviewSection
              heading="Story-scope appendage"
              body={appendageSection}
              empty={false}
              renderMode={renderMode}
              accent={accent}
              bodyRef={bodyRef}
              dataHelpRegion="system-prompt-preview:scope_appendage"
            />
          )}
        </div>
      </div>
    </div>
  )
}


function PreviewSection({ heading, body, empty, renderMode, accent, bodyRef, dataHelpRegion }) {
  return (
    <section className="border border-zinc-800 rounded-md overflow-hidden" data-help-region={dataHelpRegion}>
      <header className="px-3 py-1.5 bg-zinc-800/60 border-b border-zinc-800 text-[10px] uppercase tracking-wide text-zinc-300 font-semibold">
        {heading}
      </header>
      <div className="px-3 py-2">
        {empty ? (
          <div className="text-[11px] text-zinc-500 italic">{body}</div>
        ) : renderMode === 'markdown' ? (
          <div ref={bodyRef} className="text-[11px] text-zinc-200 leading-relaxed">
            <MarkdownBody content={body} accent={accent} />
          </div>
        ) : (
          <pre className="text-[11px] text-zinc-200 whitespace-pre-wrap break-words font-mono leading-relaxed">{body}</pre>
        )}
      </div>
    </section>
  )
}


// ── Focus targeting + highlight helpers ──────────────────────────


// Map a focus key to the heading element inside the rendered
// appendage body. Returns null when there's no plausible target
// (e.g. mode focus with no rendered scenes; scenes focus with an
// empty scope). The caller scrolls and tints whichever element
// this returns.
function _findFocusTarget(root, focusKey, { story, nodes, scopeChapter, scopeAct }) {
  if (focusKey === 'prev') {
    return _findHeadingStartingWith(root, 'h5', 'Scene immediately preceding the current scene')
  }
  if (focusKey === 'next') {
    return _findHeadingStartingWith(root, 'h5', 'Scene immediately following the current scene')
  }
  // Phase 2.5h follow-up — per-scene chip uses `scene:<id>` as its
  // focus key. Look up the scene's title from the project nodes
  // and find the heading that ENDS with `: <title>` (scene headings
  // vary by relation: `Scene: ...`, `Current scene: ...`,
  // `Scene immediately preceding ...: <title>`, etc.).
  if (focusKey && focusKey.startsWith('scene:')) {
    const sceneId = focusKey.slice('scene:'.length)
    const sceneNode = (nodes || []).find((n) => n && n.id === sceneId && n.type === 'sceneNode')
    const title = sceneNode?.data?.title || ''
    if (title) return _findHeadingEndingWith(root, 'h5', `: ${title}`)
    return null
  }
  if (focusKey === 'mode' || focusKey === 'scenes') {
    // No single anchor for these — fall back to the first scene
    // heading so the writer at least lands inside the appendage.
    return root.querySelector('h5')
  }
  if (focusKey === 'chapter' && scopeChapter) {
    const chap = (story?.chapters || []).find((c) => c.id === scopeChapter)
    const title = chap?.title || chap?.name
    if (title) return _findHeadingStartingWith(root, 'h4', `Chapter: ${title}`)
    return root.querySelector('h4')
  }
  if (focusKey === 'act' && scopeAct) {
    const act = (story?.acts || []).find((a) => a.id === scopeAct)
    const title = act?.title || act?.name
    if (title) return _findHeadingStartingWith(root, 'h3', `Act: ${title}`)
    return root.querySelector('h3')
  }
  return null
}


function _findHeadingEndingWith(root, tag, suffix) {
  const headings = root.querySelectorAll(tag)
  for (const h of headings) {
    const text = (h.textContent || '').trim()
    if (text.endsWith(suffix)) return h
  }
  return null
}


function _findHeadingStartingWith(root, tag, prefix) {
  const headings = root.querySelectorAll(tag)
  for (const h of headings) {
    const text = (h.textContent || '').trim()
    if (text.startsWith(prefix)) return h
  }
  return null
}


// When highlighting a section starting at a heading, where does
// the section end? Stops at any heading of the SAME level or
// HIGHER (smaller h-number). h3 stops at the next h3 / h2 / h1;
// h4 stops at h4 / h3 / h2 / h1; h5 stops at h5 / h4 / h3 / h2 / h1.
function _stopTagsForHeading(tag) {
  const order = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6']
  const startIdx = order.indexOf((tag || '').toUpperCase())
  if (startIdx < 0) return new Set(order)  // unknown — be defensive
  return new Set(order.slice(0, startIdx + 1))
}


// Hex `#rrggbb` → `rgba(r,g,b,a)`. Mirrors the helper inside
// ConversationView's scene-context highlight path. Inlined here
// to keep the modal self-contained.
function _hexToRgba(hex, alpha) {
  const v = String(hex || '#7c3aed').replace('#', '')
  const norm = v.length === 3
    ? v.split('').map((c) => c + c).join('')
    : v.padEnd(6, '0').slice(0, 6)
  const r = parseInt(norm.slice(0, 2), 16) || 0
  const g = parseInt(norm.slice(2, 4), 16) || 0
  const b = parseInt(norm.slice(4, 6), 16) || 0
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
