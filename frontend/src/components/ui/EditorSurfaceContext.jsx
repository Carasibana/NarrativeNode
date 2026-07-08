/**
 * EditorSurfaceContext — Phase 2.9b item 1.
 *
 * React context carrying the "what editor surface is this" identity
 * down to TipTap NodeView components (specifically SectionView) so
 * they can dispatch surface-aware actions (Attach to Chat, etc.)
 * without prop-drilling through the TipTap NodeView boundary.
 *
 * Why a context: TipTap NodeView components are mounted by
 * ProseMirror, not by their React parent's normal render tree —
 * passing props through them is awkward. React context propagates
 * cleanly across the NodeView boundary because ReactNodeViewRenderer
 * mounts the NodeView inside the parent's React tree.
 *
 * Surface shape:
 *   {
 *     surface_type: 'scene_main' | 'cue_body' | 'reference_note'
 *                 | 'entity_notes' | 'knowledge_notes',
 *     surface_host_id: <UUID of the host object (scene node id, cue
 *                       id, entity id, knowledge id, etc.)>,
 *   }
 *
 * `null` value (default) means no surface info available — the
 * editor is mounted standalone (e.g. dev preview) and surface-aware
 * actions should bail.
 */

import { createContext, useContext } from 'react'

const EditorSurfaceContext = createContext(null)

export const EditorSurfaceProvider = EditorSurfaceContext.Provider

/**
 * Hook used by NodeView components to read the surface ref. Returns
 * `null` when no provider is in scope (standalone editor mount).
 */
export function useEditorSurface() {
  return useContext(EditorSurfaceContext)
}
