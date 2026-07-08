/**
 * Dev-only store write tracer (Phase 4.1a diagnostics).
 *
 * The 2026-06-11 post-fix profiles show whole-app commits recurring in
 * pairs (~2.6 s apart, ~8.7 s period) during an idle loaded session:
 * ~10,700 fibers re-render with changed store subscriptions, meaning
 * the underlying stores are genuinely being rewritten on a rhythm. The
 * React profiler cannot name the writer; this tracer can. Every write
 * to a watched store logs the changed top-level keys plus a trimmed
 * stack so the console names the exact store action that fired.
 *
 * `nodes` / `edges` changes are annotated with whether the new arrays
 * are STRUCTURALLY equal to the old ones (identity-only churn vs real
 * content change), which is the load-bearing distinction for the
 * story-order cache and the chain-derived subscriptions.
 *
 * Installed from main.jsx via dynamic import, DEV builds only. No
 * production code path imports this module.
 */
import { useProjectStore } from '../store/projectStore'
import { useEntitiesStore } from '../store/entitiesStore'
import { usePreviewStore } from '../store/previewStore'
import { nodesStructurallyEqual, edgesStructurallyEqual } from '../hooks/useAlerts'

const WATCHED = [
  {
    name: 'projectStore',
    store: useProjectStore,
    keys: [
      'nodes', 'edges', 'story', 'relationships', 'knowledges',
      'loadGeneration', 'hasUnsavedChanges', '_pendingFitView',
    ],
  },
  {
    name: 'entitiesStore',
    store: useEntitiesStore,
    keys: [
      'characters', 'locations', 'items', 'factions', 'customs',
      'customCategories', 'presetLists', 'libraryLayout',
    ],
  },
  {
    name: 'previewStore',
    store: usePreviewStore,
    keys: ['trayChip', 'activePlayerId'],
  },
]

function shortStack() {
  const lines = (new Error().stack || '').split('\n')
  // Drop the Error line + this frame + the subscribe-callback frame.
  return lines.slice(3, 10).map((l) => l.trim()).join('\n    ')
}

function annotate(key, prev, next) {
  if (key === 'nodes') {
    return `nodes(${next?.length ?? 0}, structEq=${nodesStructurallyEqual(prev, next)})`
  }
  if (key === 'edges') {
    return `edges(${next?.length ?? 0}, structEq=${edgesStructurallyEqual(prev, next)})`
  }
  if (Array.isArray(next)) return `${key}(${next.length})`
  return key
}

export function installDevStoreTrace() {
  for (const { name, store, keys } of WATCHED) {
    store.subscribe((state, prev) => {
      const changed = keys.filter((k) => state[k] !== prev[k])
      if (changed.length === 0) return
      const detail = changed.map((k) => annotate(k, prev[k], state[k])).join(', ')
      console.debug(
        `[storeTrace] ${name} @${(performance.now() / 1000).toFixed(1)}s changed: ${detail}\n    ${shortStack()}`
      )
    })
  }
  console.debug('[storeTrace] installed')
}
