/**
 * sectionPromptBlocksStore — per-Section Prompt Block Header state
 * (Phase 2.9c item 1).
 *
 * Session-only, never persisted. Mirrors the planning doc §4.10
 * rule: "Prompt / model / settings are session-only. Reopening a
 * Section later shows the Prompt Block Header in its collapsed
 * default state with prompt content / model selection / context
 * settings blank — same as a freshly-created Section's Prompt Block
 * Header."
 *
 * State shape keyed by Section id:
 *
 *   blocks: {
 *     [sectionId]: {
 *       // Form contents — what the writer has composed.
 *       message:           string,       // the user-message text
 *       system_prompt_id:  string|null,  // null = inherit project default
 *       profile_id:        string|null,  // null = inherit project default
 *       model:             string|null,  // null = inherit project default
 *
 *       // Display state of the wrapper.
 *       expanded:          boolean,      // expanded vs collapsed
 *
 *       // Live stream state. abortController is the handle the cancel
 *       // path uses (toolbar Stop button / Esc / in-form Stop button).
 *       isStreaming:       boolean,
 *       abortController:   AbortController | null,
 *       streamError:       string | null,  // set when a stream ends in error
 *
 *       // The Send → Stop morph is driven by `isStreaming`.
 *
 *       // Session prompt history (deduped) — wired in a later item.
 *       sessionPromptHistory: string[],
 *
 *       // Title of the most-recently-fired prompt (shown on the
 *       // collapsed-idle bar). Updated on Send.
 *       lastFiredTitle:    string,
 *     }
 *   }
 */

import { create } from 'zustand'
import { usePinnedContextStore } from './pinnedContextStore'

function _blank() {
  return {
    message: '',
    system_prompt_id: null,
    profile_id: null,
    model: null,
    expanded: false,
    isStreaming: false,
    abortController: null,
    streamError: null,
    // Session prompt history was originally a per-block deduped list
    // of fired prompt titles, intended to back a recall/re-fire UI.
    // Feature de-scoped at v0.2.9.40 (writer feedback: overcomplicates
    // the form for low marginal value). The field stays present (and
    // gets initialised here) but no UI consumes it; the append logic
    // in `pushPromptHistory` below is commented out so it doesn't
    // grow over the session. Leaving the empty-array initial value
    // in place avoids breaking any reader that might still iterate
    // it; future cleanup can drop the field entirely once we're sure
    // nothing references it.
    sessionPromptHistory: [],
    lastFiredTitle: '',
    // IPB cursor-mode context window (Phase 2.9c item 4 + item 5
    // merged). Per writer spec 2026-05-27 the preceding / following
    // surrounding-prose blocks are USER-SELECTABLE — the writer can
    // include neither, one, or both via the toggles, AND adjust the
    // word count for each via the hover-popover slider on the
    // corresponding pill. Both toggles default ON (preserves the
    // always-include ±50 words behaviour) and counts default to 50
    // each so fresh blocks behave identically to v0.2.9.28's fixed
    // 50/50 behaviour. Range: 0-500 via slider, custom typed values
    // are clamped to the same range. Read by
    // `InlinePromptBlock.handleSend` when building the cursor-mode
    // system context block; ignored by PBH writes and by IPB
    // section-mode (the anchor selection IS the context in section
    // mode per planning doc §4.11).
    includePreceding: true,
    includeFollowing: true,
    precedingWords: 50,
    followingWords: 50,
    // Auto-attach detected names toggle (Phase 2.9c — writer spec
    // 2026-05-27). Per-Section session-only flag (default TRUE —
    // writer opted-in to PBH auto-attach by default so detected
    // library-object names in the Section's prose auto-pin to the
    // PBH's pinnedContextItems without the writer manually attaching
    // each one). The per-type filter ("which kinds of names to
    // detect") is global across all PBHs (lives on `uiStore` as
    // `pbhAutoAttachTypes`) — only the on/off toggle is per-block,
    // so changing kinds doesn't require setting them on every
    // Section the writer touches. AI-streamed content is filtered
    // out by the scanner plugin (`PromptBlockAutoAttachExtension`)
    // via the `aiWrite` transaction meta + `isStreaming` flag, so
    // AI-introduced names never auto-attach.
    autoAttachEnabled: true,

    // Scene Context toggle (Phase 2.9c item 7 — writer spec
    // 2026-05-27). When ON, the prompt sends the HOST SCENE's full
    // resolved state (scene name, description, entity chips' effective
    // states, in-scene changes, story-level voice settings) rendered
    // via `buildSceneContextBlock(sceneId)` — same behaviour as the
    // chat composer's scene context. Defaults FALSE because the
    // section content is already the implicit context for PBH and the
    // cursor / selection is the implicit context for IPB — scene
    // context is opt-in extra.
    sceneContextEnabled: false,
    // Section / Selection content toggle (writer spec 2026-05-27). The
    // host Section's content (PBH) OR the IPB's selected range (IPB
    // section mode) is the implicit context for the Prompt Block —
    // ON by default. The writer can turn it OFF via the corresponding
    // pill in the context strip, in which case Send fires the prompt
    // WITHOUT the section / selection content in the system message
    // (useful for "ignore what's here, write something new" use cases;
    // the pre-Send Section History snapshot still captures the
    // existing content so Step back is unaffected).
    includeHostSectionContent: true,
    // Phase 2.10b bug 1 refactor — `pinnedContextItems` moved to the
    // unified `pinnedContextStore` keyed `'block:<sectionId>'`. The
    // field no longer lives on the per-block state. Block destruction
    // explicitly clears its bucket via `clearPins('block:<id>')` in
    // the `clear` action below.
  }
}

// Phase 2.10b bug 1 refactor — pinned-context state + helpers moved
// to the unified `pinnedContextStore`. The four pin actions
// (`addPinnedItem` / `removePinnedItem` / `updatePinnedItemMarker` /
// `clearPinnedItems`), the dedup helper, and the markerKey + session-
// id helpers are gone from this module. Block-level pin storage now
// lives at `pinnedContextStore.surfaces['block:<sectionId>']`. The
// `clear(sectionId)` action explicitly clears that bucket so destroyed
// blocks don't leave orphan pins in session memory.

export const useSectionPromptBlocksStore = create((set) => ({
  blocks: {},

  /**
   * Read or lazily-create a section's block state. Components select
   * with `useSectionPromptBlocksStore((s) => s.blocks[id])` and fall
   * back to `_blank()` defaults when the entry is missing. Materialise
   * an entry only when the writer first interacts (e.g. expands the
   * PBH); keeps the map empty for sections the writer hasn't touched.
   */
  ensure: (sectionId) => set((state) => {
    if (!sectionId) return state
    if (state.blocks[sectionId]) return state
    return { blocks: { ...state.blocks, [sectionId]: _blank() } }
  }),

  /**
   * Patch one or more fields on a section's block state. Materialises
   * the entry if missing.
   */
  patch: (sectionId, patch) => set((state) => {
    if (!sectionId) return state
    const existing = state.blocks[sectionId] || _blank()
    return {
      blocks: {
        ...state.blocks,
        [sectionId]: { ...existing, ...patch },
      },
    }
  }),

  /**
   * Clear a section's block state — wired on Section Dissolve /
   * Delete so the map doesn't leak entries for vanished sections.
   * If a stream is in flight, the abort controller is aborted first.
   */
  clear: (sectionId) => set((state) => {
    if (!sectionId || !(sectionId in state.blocks)) return state
    const entry = state.blocks[sectionId]
    if (entry?.abortController) {
      try { entry.abortController.abort() } catch { /* ignore */ }
    }
    // Phase 2.10b bug 1 — explicitly clear this block's pin bucket on
    // the unified pinnedContextStore so destroying the block doesn't
    // leak orphan pins in session memory.
    try { usePinnedContextStore.getState().clearPins(`block:${sectionId}`) } catch { /* ignore */ }
    const next = { ...state.blocks }
    delete next[sectionId]
    return { blocks: next }
  }),

  // Updates the per-block `lastFiredTitle` (used by the collapsed-
  // idle bar to show the most-recently-fired prompt). The dedupe-
  // and-append-to-`sessionPromptHistory` part of this action was
  // commented out at v0.2.9.40 when the session-prompt-history
  // feature was de-scoped (writer feedback: recall UI overcomplicates
  // the form for low marginal value). Callers in `SectionView` and
  // `InlinePromptBlock` keep calling this on each Send — they just
  // get the `lastFiredTitle` update now, not the history append.
  pushPromptHistory: (sectionId, title) => set((state) => {
    if (!sectionId || !title) return state
    const existing = state.blocks[sectionId] || _blank()
    const trimmed = title.trim()
    if (!trimmed) return state
    // v0.2.9.40 — session-history append commented out (feature de-
    // scoped). Restore these two lines + the `sessionPromptHistory`
    // field in the return below if the recall UI is ever picked
    // back up.
    // const filtered = (existing.sessionPromptHistory || []).filter((s) => s !== trimmed)
    // const next = [trimmed, ...filtered].slice(0, 50)
    return {
      blocks: {
        ...state.blocks,
        [sectionId]: { ...existing, lastFiredTitle: trimmed },
      },
    }
  }),
}))
