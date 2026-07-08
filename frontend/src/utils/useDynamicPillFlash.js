import { useEffect, useRef } from 'react'
import { useUiStore } from '../store/uiStore'

/**
 * Dynamic pill update-flash hook — Phase 2.10b item 4.
 *
 * Each dynamic pill calls this hook with its current `targetKey` and
 * its surface's flash `scope` + the pill's stable `sessionId`. When
 * the `targetKey` changes between renders, the hook fires
 * `flashPill(scope, 'dynamic', sessionId)` UNLESS the change was
 * caused by the writer's direct interaction with the pill itself
 * (the parent passes `suppressNext: true` ahead of a direct-
 * interaction commit, then clears it next render).
 *
 *   ─── Performance discipline (planning doc §4.4d) ────────────────
 *
 * `targetKey` MUST track the TARGET'S IDENTITY (which scene id,
 * which chapter id, etc.) NOT the resolved content. Writer typing
 * into an adjacent scene's main_content doesn't change the prev-
 * scene's id, so `previous_n_words.targetKey` stays stable and no
 * flash fires. Same for anchor-region keys on Before/After (paragraph
 * index, not character offset).
 *
 * `targetKey` must be cheap to compute — the parent component
 * computes it during render, so anything more than a couple of
 * id lookups + a string concat is too much. If a marker resolver
 * would need a full chain walk to determine "did my target
 * change?", the caller should derive a proxy key (the entity id,
 * not the resolved name) and let the actual chain-walked resolution
 * happen at send-time only.
 *
 * The hook is event-driven by virtue of React's render cycle —
 * `targetKey` only changes when the parent re-renders with a new
 * value, which only happens when subscribed state changes. No
 * polling loops anywhere in this module.
 *
 *   ─── Mount-time suppression ─────────────────────────────────────
 *
 * The initial render's `targetKey` is recorded as the baseline; no
 * flash fires until a subsequent render brings a different
 * `targetKey`. This is what stops every pill on every surface from
 * flashing on every page-load. The baseline lives in a ref so it
 * survives renders without triggering its own re-renders.
 *
 *   ─── Direct-interaction suppression ─────────────────────────────
 *
 * The parent passes `suppressNext: true` immediately before a
 * direct-interaction handler (hover-slider commit, click-cycle,
 * etc.) updates state in a way that'd otherwise change `targetKey`.
 * The hook clears `suppressNext` to false on the next render after
 * consuming it. This means:
 *   - direct interaction → suppress the next would-be flash
 *   - out-of-band update right after → does flash normally
 *
 *   ─── Silent-skip transitions ────────────────────────────────────
 *
 * `targetKey === null` is the canonical "currently silent-skipping"
 * value. Transitioning into or out of `null` is a target change
 * and flashes (when out-of-band). Direct-interaction parents can
 * suppress these transitions just like any other.
 *
 *
 * @param {object} args
 * @param {string} args.scope        — surface flash scope (chat, sectionId, '__ipb__', 'sd:<sceneId>')
 * @param {string} args.sessionId    — the pill's stable sessionId (from item 1)
 * @param {string|null} args.targetKey  — current target-identity key; null when silent-skipping
 * @param {boolean} [args.suppressNext]  — parent-controlled flag: skip the next would-be flash
 */
export function useDynamicPillFlash({ scope, sessionId, targetKey, suppressNext = false }) {
  const flashPill = useUiStore((s) => s.flashPill)
  const prevKeyRef = useRef(targetKey)
  const initializedRef = useRef(false)
  const suppressNextRef = useRef(suppressNext)
  // Keep the suppress flag fresh without triggering the change effect
  // to re-fire on every render.
  useEffect(() => { suppressNextRef.current = suppressNext }, [suppressNext])

  useEffect(() => {
    if (!initializedRef.current) {
      // Mount-time render: record the baseline without flashing.
      prevKeyRef.current = targetKey
      initializedRef.current = true
      return
    }
    if (prevKeyRef.current === targetKey) {
      // No-op render — key unchanged, nothing to do.
      return
    }
    const wasDirectInteraction = suppressNextRef.current
    // Consume the suppression flag in either branch so it doesn't
    // accidentally swallow a subsequent out-of-band flash.
    suppressNextRef.current = false
    prevKeyRef.current = targetKey
    if (wasDirectInteraction) return
    if (!scope || !sessionId) return
    flashPill(scope, 'dynamic', sessionId)
  }, [scope, sessionId, targetKey, flashPill])
}
