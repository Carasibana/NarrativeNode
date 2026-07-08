/**
 * Session-scoped per-scene plain-text cache for Phase 1.24d global
 * search. Each scene's `main_content` HTML is converted to plain
 * text (via `htmlToPlainText`) at most once per content version.
 *
 * Implicit content-keyed invalidation: the cache stores the HTML
 * input alongside its derived text. A subsequent call with a
 * DIFFERENT html for the same sceneId triggers recompute and
 * overwrites the entry. No store subscription needed; consumers
 * just call `getSceneText(sceneId, currentHtml)` and the cache
 * handles freshness automatically.
 *
 * Explicit `invalidateScene(id)` is exposed for callers that want
 * to drop a scene's cache entry directly (e.g., scene deletion,
 * project switch). `clearSceneTextCache()` drops everything.
 */

import { htmlToPlainText } from './htmlToPlainText.js'

const cache = new Map() // sceneId -> { html, text }

/**
 * Return the plain-text representation of `html` for `sceneId`,
 * computed via `htmlToPlainText` and memoised by the (sceneId, html)
 * pair. If `html` matches the previously-cached html for the same
 * sceneId, the cached text is returned without recomputing.
 */
export function getSceneText(sceneId, html) {
  if (!sceneId) return htmlToPlainText(html)
  const cached = cache.get(sceneId)
  if (cached && cached.html === html) return cached.text
  const text = htmlToPlainText(html)
  cache.set(sceneId, { html, text })
  return text
}

/**
 * Drop the cache entry for a single scene.
 */
export function invalidateScene(sceneId) {
  cache.delete(sceneId)
}

/**
 * Drop every cache entry (project switch, full reload, etc.).
 */
export function clearSceneTextCache() {
  cache.clear()
}
