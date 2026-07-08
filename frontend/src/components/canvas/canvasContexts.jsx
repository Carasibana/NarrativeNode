/**
 * Canvas-level React contexts that distribute story-static values
 * (e.g. the writer's chosen accent colour) to leaf canvas components
 * without forcing every leaf to subscribe to the store directly.
 *
 * Motivation (F#11): components mounted in large counts (PortHandle
 * has ~2k instances on a real canvas) historically each called
 * `useAccentColor()` directly — that's ~2k subscriptions to a value
 * that essentially never changes during a session. Hoisting to a
 * context means one subscription at the canvas root distributes the
 * value to every leaf via context lookup (no per-instance store
 * subscription). When the accent does change (writer edits it in
 * settings), the context value propagates and every consumer
 * re-renders once — a rare, intentional cost.
 */

import { createContext, useContext } from 'react'

const AccentColorContext = createContext(null)

export const AccentColorProvider = AccentColorContext.Provider

/**
 * Returns the canvas-level accent colour. Returns `null` when the
 * caller is rendered outside an `<AccentColorProvider>`; callers
 * outside the canvas tree should keep their direct `useAccentColor()`
 * subscription and use this hook only when they know they're under
 * the provider.
 */
export function useCanvasAccentColor() {
  return useContext(AccentColorContext)
}
