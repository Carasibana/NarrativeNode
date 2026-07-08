/**
 * PromptBlockAutoAttachExtension — TipTap extension that powers the
 * PBH's "auto-attach detected names" feature (Phase 2.9c — writer
 * spec 2026-05-27).
 *
 * When the writer types a library-object name (entity / knowledge /
 * relationship / cue) into a Section's prose AND that Section's
 * PBH has `autoAttachEnabled: true`, the matched item auto-pins to
 * the PBH's `pinnedContextItems[]` list (without the writer needing
 * to manually drag / drop / pick from the popover).
 *
 * Reuses the chat composer's name-detection infrastructure directly:
 *   - `buildStoryWideNameTargets` (from `EntityHighlightPlugin.jsx`)
 *     — the same store-agnostic scanner the chat composer's
 *     `chatNameTargets` is built from. Picks up baseline names +
 *     aliases + chain renames across every selected kind.
 *   - The same regex-match pattern (longest-name-first sort so
 *     "Mina Murray" wins over the alias "Mina").
 *   - The same per-(kind,id) dedupe key shape ("kind:id").
 *
 * AI-streamed content does NOT trigger auto-attach:
 *   - The streaming write path (`SectionView.handleSend` /
 *     `InlinePromptBlock.handleSend`) tags every chunk-flush
 *     transaction with `tr.setMeta('aiWrite', true)`. This extension
 *     reads that meta and SILENTLY updates the per-Section baseline
 *     (no `addPinnedItem` dispatch) so the AI's names are absorbed
 *     into the "already known" set — the next writer transaction's
 *     diff doesn't see them as new.
 *   - Same silent-baseline treatment for transactions while a
 *     Section is `isStreaming` (defensive belt-and-braces — the
 *     aiWrite meta should cover this on its own, but if any
 *     in-streaming transaction lands without the meta, we still
 *     don't attach).
 *
 * Per-Section state lookup at every transaction:
 *   - `autoAttachEnabled` from `sectionPromptBlocksStore.blocks[sid]`
 *     — toggle off → skip the Section entirely + clear its baseline
 *     so re-enabling later starts fresh from current state.
 *   - `isStreaming` from the same store — gate the dispatch (silent
 *     baseline instead).
 *   - `pbhAutoAttachTypes` from `uiStore` — global to all PBHs
 *     (separate from `chatAutoAttachTypes` so changing PBH kinds
 *     doesn't affect the chat composer).
 *
 * Lifecycle:
 *   - `onCreate`: walk the doc, populate the `prevMatchedKeys` map
 *     with every existing Section's current matches. Prevents a
 *     fresh load of a saved story from auto-attaching everything
 *     in every Section's existing prose.
 *   - `onTransaction`: per-Section diff dispatch (see flow above).
 *   - Section dissolve / delete cleans `sectionPromptBlocksStore`
 *     for that id; the map entry here will go stale but harmlessly
 *     so (the next time a Section happens to reuse that id — which
 *     shouldn't happen since ids are UUIDs).
 */

import { Extension } from '@tiptap/core'
import { buildStoryWideNameTargets } from './EntityHighlightPlugin'
import { useSectionPromptBlocksStore } from '../../store/sectionPromptBlocksStore'
import { usePinnedContextStore } from '../../store/pinnedContextStore'
import { useUiStore } from '../../store/uiStore'
import { useProjectStore } from '../../store/projectStore'
import { useEntitiesStore } from '../../store/entitiesStore'
import { useContextCuesStore } from '../../store/contextCuesStore'
import { useIpbStore, IPB_FORM_KEY } from '../../store/ipbStore'

// Per-Section "previously matched names" tracker. Sectionid → Set of
// `"kind:id"` strings. Kept outside the extension instance because the
// extension is instantiated once per editor and we don't need to
// share across editors (each editor's doc lives in its own scope).
// IPB section-mode scans share this map keyed by the IPB sentinel
// (`IPB_FORM_KEY = '__ipb__'`) so the same code path works for both
// PBH and IPB targets.
const prevMatchedKeysBySection = new Map()

// Track the IPB's last-seen anchor range. When the writer Ctrl+clicks
// or Ctrl+drags to a new range, the previously-baselined matches were
// against a DIFFERENT span of text — treating the new range's existing
// names as "new" would auto-pin everything inside the freshly-chosen
// selection on every retarget. We compare anchor keys (`from:to`)
// across transactions and silently rebaseline whenever it changes.
let lastIpbAnchorKey = null

// Build the targets array from current store state. Returns null when
// no kinds are selected (writer turned everything off in the flyout).
function _buildTargets(types) {
  const enabledAny = Object.values(types || {}).some(Boolean)
  if (!enabledAny) return null
  const targets = buildStoryWideNameTargets(types || {}, {
    entities: useEntitiesStore.getState(),
    project: useProjectStore.getState(),
    cues: useContextCuesStore.getState(),
  })
  if (!targets.length) return null
  return targets
}

// Run a regex scan over a text string against the given targets,
// returning the `Set<"kind:id">` of all matched library objects.
// Mirrors the chat composer's logic in ConversationView (longest-
// name-first sort, lowercase lookup grouping for ambiguous matches).
function _scanText(text, targets) {
  if (!text || !targets || !targets.length) return new Set()
  const sorted = [...targets].sort((a, b) => b.name.length - a.name.length)
  const escaped = sorted.map((x) => x.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const regex = new RegExp(`\\b(${escaped.join('|')})\\b`, 'gi')
  const lookup = new Map()
  for (const x of targets) {
    const k = x.name.toLowerCase()
    const arr = lookup.get(k) || []
    arr.push(x)
    lookup.set(k, arr)
  }
  const out = new Set()
  let m
  regex.lastIndex = 0
  while ((m = regex.exec(text)) !== null) {
    const matchKey = m[0].toLowerCase()
    const matchedTargets = lookup.get(matchKey)
    if (!matchedTargets) continue
    for (const target of matchedTargets) {
      let kind
      if (target.entityType === 'cue') kind = 'cue'
      else if (target.entityType === 'knowledge') kind = 'knowledge'
      else if (target.entityType === 'relationship') kind = 'relationship'
      else kind = 'entity'
      out.add(`${kind}:${target.entityId}`)
    }
  }
  return out
}

// Walk the doc for the Section node with the given id, return its
// plain text (or null when not found). `node.textContent` recursively
// concatenates child text nodes — that's all we need to match against
// the regex (positions are irrelevant for the diff-dispatch path).
function _getSectionText(doc, sectionId) {
  let text = null
  doc.descendants((node) => {
    if (text !== null) return false
    if (node.type.name === 'section' && node.attrs?.id === sectionId) {
      text = node.textContent || ''
      return false
    }
    return true
  })
  return text
}

// Find the set of Section ids touched by a transaction's mapping.
// A transaction may affect multiple Sections (cross-Section paste,
// for example) — return all of them.
function _affectedSectionIds(transaction, doc) {
  const ids = new Set()
  try {
    transaction.mapping.maps.forEach((m) => {
      m.forEach((_oldStart, _oldEnd, newStart) => {
        const $pos = doc.resolve(Math.min(newStart, doc.content.size))
        for (let d = $pos.depth; d > 0; d--) {
          const node = $pos.node(d)
          if (node.type.name === 'section' && node.attrs?.id) {
            ids.add(node.attrs.id)
            break
          }
        }
      })
    })
  } catch { /* ignore mapping read errors */ }
  return ids
}

export const PromptBlockAutoAttachExtension = Extension.create({
  name: 'promptBlockAutoAttach',

  onCreate({ editor }) {
    // Initial baseline. Walk the doc, build per-Section matched sets
    // for every existing Section. Without this, the FIRST writer
    // transaction after a story load would diff against an empty
    // prevMatchedKeys and dispatch addPinnedItem for every name
    // already in every Section's prose.
    const types = useUiStore.getState().pbhAutoAttachTypes
    const targets = _buildTargets(types)
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'section' && node.attrs?.id) {
        const sid = node.attrs.id
        const matches = targets ? _scanText(node.textContent, targets) : new Set()
        prevMatchedKeysBySection.set(sid, matches)
        return false
      }
      return true
    })
  },

  onTransaction({ editor, transaction }) {
    if (!transaction.docChanged) return

    const affected = _affectedSectionIds(transaction, editor.state.doc)
    if (affected.size === 0) return

    const blocks = useSectionPromptBlocksStore.getState().blocks
    // Phase 2.10b bug 1 refactor — pin writes go through the unified
    // pinnedContextStore with surfaceKey `'block:<sectionId>'`.
    const pinStore = usePinnedContextStore.getState()
    const types = useUiStore.getState().pbhAutoAttachTypes
    const targets = _buildTargets(types)
    // No targets / no enabled kinds — STILL keep the baseline fresh
    // so re-enabling kinds later doesn't immediately attach
    // everything in the affected Sections.
    const isAiWrite = !!transaction.getMeta('aiWrite')

    for (const sectionId of affected) {
      const block = blocks[sectionId]
      const autoAttachEnabled = block?.autoAttachEnabled !== false  // default true
      const isStreaming = !!block?.isStreaming

      if (!autoAttachEnabled) {
        // Toggle off — drop the baseline so re-enabling starts fresh.
        prevMatchedKeysBySection.delete(sectionId)
        continue
      }

      // Get the Section's current text. If somehow it can't be
      // resolved (e.g. it was just deleted by this transaction),
      // drop the baseline and move on.
      const text = _getSectionText(editor.state.doc, sectionId)
      if (text === null) {
        prevMatchedKeysBySection.delete(sectionId)
        continue
      }

      // Scan against the current targets (or an empty set when no
      // kinds enabled).
      const currentKeys = targets ? _scanText(text, targets) : new Set()
      const hadPrev = prevMatchedKeysBySection.has(sectionId)
      const prev = prevMatchedKeysBySection.get(sectionId) || new Set()

      // SILENT BASELINE paths — update prev, don't dispatch:
      //   - First time we see this Section (e.g. just created in
      //     this transaction): treat existing content as known.
      //   - AI-write transaction: AI-introduced names go into the
      //     baseline so subsequent writer transactions don't see
      //     them as "new".
      //   - Section is currently streaming: defensive cover even if
      //     somehow a non-aiWrite transaction lands during streaming.
      if (!hadPrev || isAiWrite || isStreaming) {
        prevMatchedKeysBySection.set(sectionId, currentKeys)
        continue
      }

      // DIFF DISPATCH — for each newly-appeared key, addPinnedItem.
      // The store's own dedupe also drops duplicates (matching the
      // chat composer's pattern) so we don't need to worry about
      // re-dispatching for already-pinned ids. Flash-on-add fires
      // surface-scoped to THIS Section so the cue is visible on its
      // own PBH chip strip without bleeding into other surfaces.
      const flashPill = useUiStore.getState().flashPill
      for (const key of currentKeys) {
        if (prev.has(key)) continue
        const colonIdx = key.indexOf(':')
        if (colonIdx < 0) continue
        const kind = key.slice(0, colonIdx)
        const id = key.slice(colonIdx + 1)
        pinStore.addPin(`block:${sectionId}`, { kind, id })
        flashPill(sectionId, kind, id)
      }
      prevMatchedKeysBySection.set(sectionId, currentKeys)
    }

    // ── IPB section-mode secondary scan (writer spec 2026-05-27).
    // When the IPB is active AND its anchor is a range (section
    // mode), the selected text acts as a secondary scan target
    // alongside the IPB form's prompt textarea (the primary scan,
    // handled by a useEffect in PromptBlockForm). Cursor mode has
    // NO secondary scan — the Before/After context window already
    // covers surrounding-prose context. Reuses the same prev-set
    // map keyed by `IPB_FORM_KEY` so the diff dispatch logic is
    // shared with the per-Section path above.
    const ipbState = useIpbStore.getState()
    if (ipbState.active && ipbState.anchor?.kind === 'range') {
      const ipbBlock = blocks[IPB_FORM_KEY]
      const ipbAutoAttach = ipbBlock?.autoAttachEnabled !== false
      const ipbStreaming = !!ipbBlock?.isStreaming
      const fromPos = ipbState.anchor.from
      const toPos = ipbState.anchor.to
      const docSize = editor.state.doc.content.size
      const safeFrom = Math.max(0, Math.min(fromPos, docSize))
      const safeTo = Math.max(safeFrom, Math.min(toPos, docSize))
      const anchorKey = `${safeFrom}:${safeTo}`
      // Anchor-change rebaseline. If the writer Ctrl+clicked or
      // Ctrl+dragged to a new range since the last transaction,
      // treat this scan as silent — otherwise every existing name
      // inside the freshly-chosen selection would auto-pin on
      // retarget.
      const anchorChanged = lastIpbAnchorKey !== anchorKey

      if (!ipbAutoAttach) {
        prevMatchedKeysBySection.delete(IPB_FORM_KEY)
      } else if (safeFrom >= safeTo) {
        // Empty / invalid range — drop the baseline.
        prevMatchedKeysBySection.delete(IPB_FORM_KEY)
      } else {
        let rangeText = ''
        try {
          rangeText = editor.state.doc.textBetween(safeFrom, safeTo, '\n', ' ')
        } catch { rangeText = '' }
        const currentKeys = targets ? _scanText(rangeText, targets) : new Set()
        const hadPrev = prevMatchedKeysBySection.has(IPB_FORM_KEY)
        const prev = prevMatchedKeysBySection.get(IPB_FORM_KEY) || new Set()
        if (!hadPrev || anchorChanged || isAiWrite || ipbStreaming) {
          // Silent baseline.
          prevMatchedKeysBySection.set(IPB_FORM_KEY, currentKeys)
        } else {
          const flashPill = useUiStore.getState().flashPill
          for (const key of currentKeys) {
            if (prev.has(key)) continue
            const colonIdx = key.indexOf(':')
            if (colonIdx < 0) continue
            const kind = key.slice(0, colonIdx)
            const id = key.slice(colonIdx + 1)
            pinStore.addPin(`block:${IPB_FORM_KEY}`, { kind, id })
            flashPill(IPB_FORM_KEY, kind, id)
          }
          prevMatchedKeysBySection.set(IPB_FORM_KEY, currentKeys)
        }
      }
      lastIpbAnchorKey = anchorKey
    } else {
      // IPB not active or in cursor mode — clear IPB baseline so a
      // future activation in section mode starts fresh.
      if (prevMatchedKeysBySection.has(IPB_FORM_KEY)) {
        prevMatchedKeysBySection.delete(IPB_FORM_KEY)
      }
      lastIpbAnchorKey = null
    }
  },
})

export default PromptBlockAutoAttachExtension
