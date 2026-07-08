import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { findMatchesInDoc, countMatchesAcrossScenes } from '../../utils/findReplaceUtils'
import { refreshFindMatchHighlights } from './FindMatchHighlightPlugin'
import { useProjectStore } from '../../store/projectStore'
import { useUiStore } from '../../store/uiStore'
import { useStoryOrder } from '../../hooks/useStoryOrder'
import { confirm } from '../../store/dialogStore'

/**
 * Phase 1.24c — Find / Replace panel for the right-sidebar TipTap
 * editor.
 *
 * This commit ships **this-scene** mode: live match counter,
 * Find next stepping, Replace & next, Replace all. All-scenes
 * cross-scene iteration lands in a follow-up commit (the All Scenes
 * radio is rendered but disabled with an explanatory tooltip).
 *
 * Render position: directly below the editor toolbar inside
 * `RichTextEditor.jsx`. Visibility is owned by the parent via the
 * `open` prop; close paths (× button, Esc) call `onClose`.
 *
 * Match-list lifecycle:
 *   - The matches array is recomputed any time the find query, the
 *     match-case toggle, the whole-word toggle, or the editor's
 *     document changes (the latter via TipTap's transaction event).
 *   - The current-match cursor (`currentIdx`) is clamped to the
 *     new list whenever it shrinks; if the previously-highlighted
 *     match was edited away, currentIdx falls back to the closest
 *     still-valid match in the same direction.
 *
 * Defaults: Match case OFF (planning Q12). Whole word ON (Q13).
 * Scope: "This Scene" (only mode wired in this commit).
 */
export default function FindReplacePanel({ open, onClose, editor }) {
  const [findQuery, setFindQuery] = useState('')
  const [replaceQuery, setReplaceQuery] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const [wholeWord, setWholeWord] = useState(true)
  const [scope, setScope] = useState('this-scene')
  const isAllScenes = scope === 'all-scenes'
  const [currentIdx, setCurrentIdx] = useState(-1)
  // Bumps every time the editor signals a doc change so the matches
  // useMemo re-runs (TipTap doc identity is stable until you ask via
  // a transaction; we use a counter for change detection instead).
  const [docVersion, setDocVersion] = useState(0)

  const findInputRef = useRef(null)
  // Pending cross-scene step: when set, the matches-effect applies
  // it once the editor has loaded the target scene and matches have
  // been recomputed. Shape:
  //   { sceneId, position: 'first' | 'last' | <number> }
  const pendingSceneStep = useRef(null)
  const editorSceneId = useUiStore((s) => s.rightSidebarNodeId)
  const openRightSidebar = useUiStore((s) => s.openRightSidebar)
  // Canvas pan-to-node callback — registered by Canvas in a useEffect.
  // Used here when cross-scene Find / Replace iteration crosses a
  // scene boundary so the canvas viewport follows the editor swap.
  const focusNode = useUiStore((s) => s._focusNode)

  // All-Scenes match summary. Pulled from the project's nodes (not
  // the live editor doc, since editor only holds one scene at a
  // time) — walks every sceneNode's stored `main_content` HTML in
  // global story order. Cheap because it's plain-text regex; only
  // recomputes when query / options / nodes / story-order change.
  const projectNodes = useProjectStore((s) => s.nodes)
  const storyOrder = useStoryOrder()
  const allScenesSummary = useMemo(() => {
    if (scope !== 'all-scenes') return null
    const orderedIds = storyOrder?.orderedIds || []
    const sceneById = new Map()
    for (const n of projectNodes || []) {
      if (n.type === 'sceneNode') sceneById.set(n.id, n)
    }
    const scenes = []
    for (const id of orderedIds) {
      const n = sceneById.get(id)
      if (!n) continue
      scenes.push({
        sceneId: n.id,
        html: n.data?.main_content || '',
        title: n.data?.title || 'Untitled Scene',
      })
    }
    // Append any unreached scenes (defensive — story order should
    // already cover all sceneNodes).
    for (const n of sceneById.values()) {
      if (!orderedIds.includes(n.id)) {
        scenes.push({
          sceneId: n.id,
          html: n.data?.main_content || '',
          title: n.data?.title || 'Untitled Scene',
        })
      }
    }
    return countMatchesAcrossScenes(scenes, findQuery, { matchCase, wholeWord })
  }, [scope, projectNodes, storyOrder, findQuery, matchCase, wholeWord])

  useEffect(() => {
    if (open && findInputRef.current) {
      findInputRef.current.focus()
      findInputRef.current.select()
    }
  }, [open])

  // Subscribe to editor doc transactions so the match list stays
  // current as the writer types or as a replace mutates the doc.
  useEffect(() => {
    if (!editor) return undefined
    const handler = ({ transaction }) => {
      if (transaction.docChanged) setDocVersion((v) => v + 1)
    }
    editor.on('transaction', handler)
    return () => { editor.off('transaction', handler) }
  }, [editor])

  // Live match list. Only recomputes when the inputs that affect the
  // match set actually change.
  const matches = useMemo(() => {
    if (!editor) return []
    return findMatchesInDoc(editor.state.doc, findQuery, { matchCase, wholeWord })
    // docVersion intentionally invalidates the memo on doc changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, findQuery, matchCase, wholeWord, docVersion])

  // Clamp the current-match cursor whenever the match list shrinks
  // or grows. -1 means "no current match yet" (idle).
  useEffect(() => {
    if (matches.length === 0) {
      if (currentIdx !== -1) setCurrentIdx(-1)
      return
    }
    if (currentIdx >= matches.length) setCurrentIdx(matches.length - 1)
  }, [matches.length, currentIdx])

  // Auto-highlight the first match as soon as the writer types a
  // query that produces matches. Fires on findQuery / matchCase /
  // wholeWord change, so a fresh query lands on currentIdx=0 without
  // requiring an extra Next click. Doesn't fire on every doc change
  // — the dep set is intentionally limited to query inputs so a
  // user-driven Previous-to-idle (which leaves currentIdx=-1 with
  // matches still present) isn't immediately yanked back to 0.
  useEffect(() => {
    if (matches.length > 0 && currentIdx === -1) {
      setCurrentIdx(0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findQuery, matchCase, wholeWord])

  // Push the latest matches + current index to the editor's
  // highlight decoration extension. Decorations render even when
  // focus is on the panel inputs (unlike browser native selection
  // which greys out for unfocused elements), so the stepped-to
  // match reads as if the writer had drag-selected it.
  useEffect(() => {
    if (!editor) return
    if (!open) {
      // Clear highlights when the panel is closed.
      refreshFindMatchHighlights(editor, [], -1)
      return
    }
    refreshFindMatchHighlights(editor, matches, currentIdx)
  }, [editor, open, matches, currentIdx])

  // Scroll the current match into view in the editor body. Doesn't
  // change focus — stays on the panel input.
  const scrollMatchIntoView = useCallback((idx) => {
    if (!editor || !matches[idx]) return
    try {
      const { from } = matches[idx]
      const dom = editor.view.domAtPos(from)
      const node = dom?.node
      const el = node && node.nodeType === Node.ELEMENT_NODE
        ? node
        : node?.parentElement
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }
    } catch {
      // domAtPos can throw mid-transaction; safe to ignore — the
      // decoration is still applied so the writer sees the match
      // as soon as the editor body re-renders.
    }
  }, [editor, matches])

  // Consume any pending cross-scene step landing once the editor
  // has loaded the target scene and matches have been recomputed.
  // Supports three flavours of `position`:
  //   'first'   — land on matches[0]
  //   'last'    — land on matches[matches.length - 1]
  //   <number>  — land on the given index (used by Previous when
  //               restoring a specific iteration position)
  useEffect(() => {
    if (!pendingSceneStep.current) return
    const { sceneId, position } = pendingSceneStep.current
    if (editorSceneId !== sceneId) return
    if (matches.length === 0) return
    let idx
    if (position === 'first') idx = 0
    else if (position === 'last') idx = matches.length - 1
    else if (typeof position === 'number') idx = Math.max(0, Math.min(position, matches.length - 1))
    else idx = 0
    setCurrentIdx(idx)
    pendingSceneStep.current = null
    // Scroll after a microtask so the editor DOM is mounted.
    queueMicrotask(() => {
      try {
        const t = matches[idx]
        if (!t) return
        const dom = editor?.view.domAtPos(t.from)
        const node = dom?.node
        const el = node && node.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement
        if (el && typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ block: 'center', behavior: 'smooth' })
        }
      } catch { /* ignore */ }
    })
  }, [editor, editorSceneId, matches])

  const handleFindNext = useCallback(() => {
    if (isAllScenes) {
      if (!allScenesSummary || allScenesSummary.totalMatches === 0) return
      // Step within the current scene first when there are remaining matches.
      if (matches.length > 0 && (currentIdx < 0 || currentIdx + 1 < matches.length)) {
        const next = currentIdx < 0 ? 0 : currentIdx + 1
        setCurrentIdx(next)
        scrollMatchIntoView(next)
        return
      }
      // Out of matches in current scene — find the next scene with matches.
      const perScene = allScenesSummary.perScene
      let curIdx = perScene.findIndex((s) => s.sceneId === editorSceneId)
      if (curIdx < 0) curIdx = -1
      const nextSceneIdx = (curIdx + 1) % perScene.length
      const nextScene = perScene[nextSceneIdx]
      if (!nextScene) return
      // If we wrapped back to the same scene with no further matches,
      // restart from its first match.
      if (nextScene.sceneId === editorSceneId) {
        if (matches.length === 0) return
        setCurrentIdx(0)
        scrollMatchIntoView(0)
        return
      }
      pendingSceneStep.current = { sceneId: nextScene.sceneId, position: 'first' }
      openRightSidebar(nextScene.sceneId)
      // Pan + zoom canvas to the new scene so the writer's visual
      // context follows the editor swap.
      if (typeof focusNode === 'function') focusNode(nextScene.sceneId)
      return
    }
    // This-scene mode: wrap inside the current doc.
    if (matches.length === 0) return
    const next = currentIdx < 0 ? 0 : (currentIdx + 1) % matches.length
    setCurrentIdx(next)
    scrollMatchIntoView(next)
  }, [isAllScenes, allScenesSummary, matches.length, currentIdx, scrollMatchIntoView, editorSceneId, openRightSidebar, focusNode])

  const handlePrevious = useCallback(() => {
    // Walk the cursor back through the live matches array, mirroring
    // handleFindNext. Previous does NOT undo a Replace — if the
    // position the user would walk back to was just replaced, that
    // match is gone from the matches array; the cursor lands on
    // whatever the actual previous live match is.
    if (isAllScenes) {
      if (!allScenesSummary || allScenesSummary.totalMatches === 0) return
      if (matches.length > 0 && currentIdx > 0) {
        const prev = currentIdx - 1
        setCurrentIdx(prev)
        scrollMatchIntoView(prev)
        return
      }
      // At the first match (or before) in the current scene — jump to
      // the previous scene with matches in story order, landing on
      // its LAST match.
      const perScene = allScenesSummary.perScene
      let curIdx = perScene.findIndex((s) => s.sceneId === editorSceneId)
      if (curIdx < 0) curIdx = perScene.length
      const prevSceneIdx = (curIdx - 1 + perScene.length) % perScene.length
      const prevScene = perScene[prevSceneIdx]
      if (!prevScene) return
      if (prevScene.sceneId === editorSceneId) {
        if (matches.length === 0) return
        const last = matches.length - 1
        setCurrentIdx(last)
        scrollMatchIntoView(last)
        return
      }
      pendingSceneStep.current = { sceneId: prevScene.sceneId, position: 'last' }
      openRightSidebar(prevScene.sceneId)
      if (typeof focusNode === 'function') focusNode(prevScene.sceneId)
      return
    }
    // This-scene mode: wrap inside the current doc.
    if (matches.length === 0) return
    const prev = currentIdx <= 0 ? matches.length - 1 : currentIdx - 1
    setCurrentIdx(prev)
    scrollMatchIntoView(prev)
  }, [isAllScenes, allScenesSummary, matches.length, currentIdx, scrollMatchIntoView, editorSceneId, openRightSidebar, focusNode])

  const handleReplaceAndNext = useCallback(() => {
    if (!editor) return
    // If no current match in the current scene, treat first click as
    // Find next so the writer can see what's about to be replaced.
    if (currentIdx < 0 || !matches[currentIdx]) {
      handleFindNext()
      return
    }
    const m = matches[currentIdx]
    // Flush the editor's current HTML to the store and capture a
    // canvas-level snapshot BEFORE applying the replace. This puts
    // each Replace on the canvas undo stack so the TipTap toolbar
    // undo button can reach BACK across scene boundaries — the
    // editor's per-scene history alone gets reset on every scene
    // swap, so cross-scene replaces would otherwise be unreachable
    // from the undo button.
    if (editorSceneId) {
      const html = editor.getHTML()
      const ps = useProjectStore.getState()
      const node = ps.nodes.find((n) => n.id === editorSceneId)
      if (node && node.data?.main_content !== html) {
        ps.updateNodeData(editorSceneId, { main_content: html })
      }
      ps._snapshot()
    }
    // Replace the match's text. TipTap's `insertContentAt` with a
    // range performs a single replace in one transaction (one undo
    // step). The doc-change listener above will recompute matches,
    // and the clamp effect lands currentIdx on the next remaining
    // match by virtue of the array shifting under the same index.
    editor.chain().focus().insertContentAt({ from: m.from, to: m.to }, replaceQuery).run()
    // After replace, the original `currentIdx`-th match is gone.
    // If there's a remaining match at the same index, advance to it
    // (which is effectively "next" since the post-replace match list
    // already removed the replaced one). If we ran past the end, go
    // back to idle.
    setTimeout(() => {
      const nextMatches = findMatchesInDoc(editor.state.doc, findQuery, { matchCase, wholeWord })
      if (nextMatches.length === 0) {
        setCurrentIdx(-1)
        // In All Scenes mode, advance to the next scene with matches.
        if (isAllScenes) handleFindNext()
        return
      }
      // Land currentIdx on the first match whose `from` is at or
      // after the replacement's end position. This handles three
      // shapes uniformly:
      //   (a) Replacement removed the original match → next-from-
      //       newTo is what was matches[currentIdx + 1].
      //   (b) Replacement created a NEW match at the same position
      //       (replacement contains the search term, e.g. "foo" →
      //       "FOO" with case-insensitive matching, or "foo" →
      //       "foofoo") → newTo is past the new same-position match,
      //       so we still advance to the next distinct match.
      //   (c) No match after the replacement → wrap to matches[0].
      const newTo = m.from + (replaceQuery || '').length
      let target = nextMatches.findIndex((nm) => nm.from >= newTo)
      if (target < 0) target = 0
      setCurrentIdx(target)
      // Scroll into view; the highlight decoration auto-applies
      // via the matches/currentIdx effect.
      try {
        const t = nextMatches[target]
        const dom = editor.view.domAtPos(t.from)
        const node = dom?.node
        const el = node && node.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement
        if (el && typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ block: 'center', behavior: 'smooth' })
        }
      } catch { /* mid-transaction; safe to ignore */ }
    }, 0)
  }, [editor, matches, currentIdx, replaceQuery, findQuery, matchCase, wholeWord, handleFindNext, isAllScenes])

  const handleReplaceAll = useCallback(async () => {
    if (!editor) return
    if (isAllScenes) {
      // Cross-scene Replace-all path. The store action runs a single
      // snapshot + atomic mutation across every affected scene's
      // main_content, so undo rolls back the whole batch as one step.
      const total = allScenesSummary?.totalMatches || 0
      if (total === 0) return
      // Flush any pending typing in the open scene to the store first
      // (the editor's onUpdate is debounced 400ms; we don't want to
      // operate on stale store state for the open scene).
      if (editorSceneId) {
        const html = editor.getHTML()
        const ps = useProjectStore.getState()
        const node = ps.nodes.find((n) => n.id === editorSceneId)
        if (node && node.data?.main_content !== html) {
          ps.updateNodeData(editorSceneId, { main_content: html })
        }
      }
      const result = useProjectStore.getState().replaceInAllSceneMainContent({
        query: findQuery,
        replacement: replaceQuery,
        matchCase,
        wholeWord,
      })
      setCurrentIdx(-1)
      const replaced = result?.replacedCount || 0
      const sceneCount = result?.affectedSceneCount || 0
      await confirm({
        title: 'Replace all',
        message: replaced === 0
          ? 'No matches were replaced.'
          : `Replaced ${replaced} occurrence${replaced === 1 ? '' : 's'} across ${sceneCount} scene${sceneCount === 1 ? '' : 's'}.`,
        buttons: [{ label: 'OK', value: 'ok', style: 'primary' }],
      })
      return
    }
    if (matches.length === 0) return
    // This-scene path: flush the editor and snapshot before replacing,
    // so the canvas undo system can reach back across scene swaps via
    // the toolbar undo button (the editor's per-scene history alone
    // gets reset on every scene swap).
    if (editorSceneId) {
      const html = editor.getHTML()
      const ps = useProjectStore.getState()
      const node = ps.nodes.find((n) => n.id === editorSceneId)
      if (node && node.data?.main_content !== html) {
        ps.updateNodeData(editorSceneId, { main_content: html })
      }
      ps._snapshot()
    }
    // Replace via the editor's transaction chain (one editor-history
    // step, preserves marks at each replacement position). Apply
    // LAST → FIRST so earlier positions stay valid as later ranges
    // shrink / grow.
    let chain = editor.chain().focus()
    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i]
      chain = chain.insertContentAt({ from: m.from, to: m.to }, replaceQuery)
    }
    chain.run()
    setCurrentIdx(-1)
  }, [editor, matches, replaceQuery, isAllScenes, allScenesSummary, editorSceneId, findQuery, matchCase, wholeWord])

  function handleKeyDown(e) {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      if (e.target === findInputRef.current || (e.target instanceof HTMLInputElement && e.target.type === 'text')) {
        // Enter in either input: advance to next match.
        handleFindNext()
      }
    }
  }

  if (!open) return null

  const matchCount = matches.length
  const hasQuery = !!findQuery.trim()
  const hasMatches = isAllScenes
    ? !!(allScenesSummary && allScenesSummary.totalMatches > 0)
    : matchCount > 0
  // Cumulative match index across the all-scenes iteration: matches in
  // earlier scenes + currentIdx in the current scene. Used to render
  // "Match X of Y · Scene Title" while stepping in all-scenes mode.
  let positionLabel
  if (isAllScenes) {
    const total = allScenesSummary?.totalMatches || 0
    const sceneCount = allScenesSummary?.sceneCount || 0
    if (currentIdx >= 0 && matchCount > 0) {
      const perScene = allScenesSummary?.perScene || []
      const sceneIdxInIter = perScene.findIndex((s) => s.sceneId === editorSceneId)
      let cumulative = currentIdx + 1
      if (sceneIdxInIter > 0) {
        for (let i = 0; i < sceneIdxInIter; i++) cumulative += (perScene[i]?.count || 0)
      }
      const sceneTitle = (sceneIdxInIter >= 0 ? perScene[sceneIdxInIter]?.title : null) || 'Untitled Scene'
      positionLabel = `Match ${cumulative} of ${total} · ${sceneTitle}`
    } else {
      positionLabel = `${total} match${total === 1 ? '' : 'es'} across ${sceneCount} scene${sceneCount === 1 ? '' : 's'}`
    }
  } else if (currentIdx >= 0 && hasMatches) {
    positionLabel = `${currentIdx + 1} of ${matchCount}`
  } else {
    positionLabel = `${matchCount} match${matchCount === 1 ? '' : 'es'}`
  }

  return (
    <div
      onKeyDown={handleKeyDown}
      className="border-b border-zinc-700 bg-zinc-900/80 px-3 py-2 flex flex-col gap-1.5 flex-shrink-0 text-[11px] text-zinc-300"
      data-help-region="find-replace:panel"
    >
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-widest font-semibold text-accent-400">Find &amp; Replace</span>
        <div className="flex items-center gap-2">
          {hasQuery && (
            <span className={hasMatches ? 'text-zinc-400' : 'text-zinc-600 italic'}>
              {hasMatches ? positionLabel : 'No matches'}
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            title="Close find/replace (Esc)"
            aria-label="Close find/replace"
            className="text-zinc-500 hover:text-zinc-200 leading-none px-1"
          >
            ×
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <label className="text-zinc-400 w-14 flex-shrink-0">Find:</label>
        <input
          ref={findInputRef}
          type="text"
          value={findQuery}
          onChange={(e) => setFindQuery(e.target.value)}
          className="flex-1 min-w-0 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-[11px] text-zinc-100 focus:outline-none focus:border-accent-500"
          data-help-region="find-replace:find_input"
        />
      </div>

      <div className="flex items-center gap-2">
        <label className="text-zinc-400 w-14 flex-shrink-0">Replace:</label>
        <input
          type="text"
          value={replaceQuery}
          onChange={(e) => setReplaceQuery(e.target.value)}
          className="flex-1 min-w-0 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-[11px] text-zinc-100 focus:outline-none focus:border-accent-500"
          data-help-region="find-replace:replace_input"
        />
      </div>

      <div className="flex items-center gap-3 flex-wrap pt-0.5" data-help-region="find-replace:options">
        <span className="text-zinc-500">Scope:</span>
        <label className="inline-flex items-center gap-1 cursor-pointer">
          <input type="radio" name="fr-scope" checked={scope === 'this-scene'} onChange={() => setScope('this-scene')} />
          <span>This Scene</span>
        </label>
        <label className="inline-flex items-center gap-1 cursor-pointer">
          <input type="radio" name="fr-scope" checked={scope === 'all-scenes'} onChange={() => setScope('all-scenes')} />
          <span>All Scenes</span>
        </label>
        <span className="inline-block w-px h-3 bg-zinc-700 mx-1" aria-hidden />
        <label className="inline-flex items-center gap-1 cursor-pointer">
          <input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} />
          <span>Match case</span>
        </label>
        <label className="inline-flex items-center gap-1 cursor-pointer">
          <input type="checkbox" checked={wholeWord} onChange={(e) => setWholeWord(e.target.checked)} />
          <span>Whole word</span>
        </label>
      </div>

      <div className="flex items-center justify-end gap-2 pt-1 flex-wrap" data-help-region="find-replace:actions">
        <button
          type="button"
          onClick={handlePrevious}
          disabled={!hasMatches}
          title={isAllScenes
            ? 'Step backwards through matches across every scene in story order.'
            : 'Step backwards to the previous match in this scene.'}
          className="px-2 py-0.5 rounded bg-accent-700/30 border border-accent-700/40 text-accent-200 hover:bg-accent-700/50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Previous
        </button>
        <button
          type="button"
          onClick={handleFindNext}
          disabled={!hasMatches}
          title={isAllScenes
            ? 'Step through matches across every scene in story order.'
            : 'Highlight the next match in this scene.'}
          className="px-2 py-0.5 rounded bg-accent-700/30 border border-accent-700/40 text-accent-200 hover:bg-accent-700/50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Next
        </button>
        <button
          type="button"
          onClick={handleReplaceAndNext}
          disabled={!hasMatches}
          title={isAllScenes
            ? 'Replace the current match and advance to the next one (across scenes).'
            : 'Replace the current match and advance to the next one.'}
          className="px-2 py-0.5 rounded bg-accent-700/30 border border-accent-700/40 text-accent-200 hover:bg-accent-700/50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Replace
        </button>
        <button
          type="button"
          onClick={handleReplaceAll}
          disabled={!hasMatches}
          title={isAllScenes
            ? `Replace every match across all ${allScenesSummary?.sceneCount || 0} affected scene${(allScenesSummary?.sceneCount || 0) === 1 ? '' : 's'} in one undo step.`
            : `Replace all ${matchCount} matches in this scene.`}
          className="px-2 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-200 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Replace all{hasMatches ? ` (${isAllScenes ? (allScenesSummary?.totalMatches || 0) : matchCount})` : ''}
        </button>
      </div>
    </div>
  )
}
