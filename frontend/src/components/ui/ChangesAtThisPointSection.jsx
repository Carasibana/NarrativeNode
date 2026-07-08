/**
 * ChangesAtThisPointSection — Phase 1.21d Step E
 *
 * Layer 2 detail-panel-section component. Renders the "Changes at this
 * point" summary in the body of any Detail Panel view that needs one.
 *
 * Pattern B per the planning doc § "Discriminator pattern": the caller
 * resolves the change groups for its object type (each group's rows
 * are pre-rendered ReactNodes — sub-chip components specific to that
 * type's data shape) and passes them in. The component itself has no
 * surface discriminator — it just handles ordering, group headers
 * when more than one group has entries, and the consistent styling
 * (top border, section title, group dividers).
 *
 * Two consumers today:
 *   - EntityDetailView's `<ChangesSummarySection>` wrapper, which
 *     builds 4 groups (Attributes / Relationships / Relationship history
 *     / Awareness) from chain-walker output.
 *   - KnowledgeDetailView's `<KnowledgeChangesAtPointSection>` wrapper,
 *     which builds 2 groups (Content / Awareness) from the Knowledge's
 *     history arrays filtered by node id.
 *
 * Adding a third consumer (e.g. Relationship Detail Panel's "Changes
 * at this point") would just build its own groups and hand them in —
 * no changes here.
 *
 * Props:
 *   - groups: Array<{ key, title, rows }>. Order in the array is the
 *     render order. `rows` is `null | undefined | Array<ReactNode>`.
 *     Empty groups (no rows or empty array) are skipped automatically.
 *   - sectionTitle: top-of-section title. Default 'Changes at this point'.
 *
 * Returns null when every group is empty so callers don't have to
 * pre-check.
 */

export default function ChangesAtThisPointSection({ groups = [], sectionTitle = 'Changes at this point' }) {
  const nonEmpty = (groups || []).filter((g) => Array.isArray(g?.rows) && g.rows.length > 0)
  if (nonEmpty.length === 0) return null
  const showHeaders = nonEmpty.length > 1

  return (
    <div className="mt-4 pt-3 border-t border-zinc-700/50 space-y-0.5" data-help-region="detail-panel:details_changes">
      <div className="text-[9px] text-zinc-600 uppercase tracking-wider mb-1.5">{sectionTitle}</div>
      {nonEmpty.map((group, idx) => (
        <div key={group.key || group.title || idx}>
          {showHeaders && (
            <div className={`text-[8px] text-zinc-400 uppercase tracking-wider ${idx === 0 ? 'mt-1' : 'mt-2 border-t border-zinc-700/30 pt-1'} mb-0.5`}>
              {group.title}
            </div>
          )}
          {group.rows}
        </div>
      ))}
    </div>
  )
}
