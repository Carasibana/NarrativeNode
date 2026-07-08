/**
 * DetailPanelShell — Phase 1.21d Step D
 *
 * Layer 1 chrome wrapper for the four type-specific Layer-3 detail
 * views (`<EntityDetailView>`, `<SceneDetailView>`, `<RelationshipDetailView>`,
 * `<KnowledgeDetailView>`).
 *
 * Owns the OUTER FRAME ONLY:
 *   - the `flex flex-col h-full` container
 *   - vertical layout (navBar → header → subTabs → body → footer)
 *   - body scroll container (`flex-1 overflow-y-auto min-h-0` plus
 *     caller-configurable padding)
 *
 * Type-agnostic by design — **no `objectType=` prop**. Per the planning
 * doc § "Architecture — Layer 1": the moment the shell needs to know
 * what's inside, the abstraction is leaking. If a slot needs to behave
 * differently per type, that behaviour lives in the slot content (which
 * the type-specific view already controls), not in the shell.
 *
 * Slots:
 *   - `navBar`  — typically a `<DetailPanelNavBar>` instance.
 *   - `header`  — typically a `<DetailPanelIdentityHeader>` instance.
 *   - `subTabs` — the sub-tab strip (each view has its own tab key set).
 *                 Pass `null` if the view doesn't have sub-tabs.
 *   - `body`    — the main content for the currently-active sub-tab
 *                 (or the full panel body when there are no sub-tabs).
 *                 Wrapped in the body scroll container by the shell.
 *   - `footer`  — optional sticky footer (Notes button, end-relationship
 *                 button, etc.). Pass `null` if the view has no footer.
 *
 * `bodyPadding` controls the body container's padding via Tailwind class
 * (default `'p-3'`, matches Entity / Knowledge views; pass `'px-2 py-2'`
 * for the Relationship view's tighter padding; pass `''` for views like
 * Scene that handle their own internal padding).
 *
 * `outerKey` lets the caller force-remount the shell on identity change
 * (e.g. switching between two relationships) without the inner views
 * needing to do their own keying. Optional.
 */

export default function DetailPanelShell({
  navBar = null,
  header = null,
  subTabs = null,
  body = null,
  footer = null,
  bodyPadding = 'p-3',
  outerKey,
}) {
  return (
    <div className="flex flex-col h-full" key={outerKey} data-help-region="detail-panel:panel">
      {navBar}
      {header}
      {subTabs}
      <div data-help-region="detail-panel:body" className={`flex-1 overflow-y-auto min-h-0${bodyPadding ? ` ${bodyPadding}` : ''}`}>
        {body}
      </div>
      {footer}
    </div>
  )
}
