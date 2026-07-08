/**
 * AwarenessModal — Phase 1.21f
 *
 * Reusable presentational shell for awareness-editing modals. Used by
 * the Aliases variant (canonical name + each alias) and the Attributes
 * variant (each attribute on the entity). The shell handles modal
 * frame, header chrome, left-sidebar list layout, right-pane container,
 * and OK / Cancel footer. Variants own draft state, chain-aware reads
 * + writes, and the contents of the right pane.
 *
 * Layout:
 *   - Header: badge label (e.g. "Names & Aliases" / "Attributes") +
 *     entity name + amber "Chain anchor" badge when at non-origin.
 *   - Body: split horizontally — left sidebar = vertical-tab list of
 *     items; right pane = caller-supplied ReactNode (typically the
 *     awareness picker for the selected item).
 *   - Footer: OK (primary) + Cancel, both bordered, primary first per
 *     the canonical ConfirmDialog button conventions.
 *
 * Modal scope is awareness-only by design — variants must NOT add
 * value / type / name editing UI inside the right pane. Editing the
 * underlying items lives in the existing inline editors elsewhere
 * (Aliases tag editor, Attributes tab inline rows, etc.).
 */

export default function AwarenessModal({
  open,
  onClose,
  badgeLabel,
  contextSlot,
  items,
  selectedId,
  onSelectItem,
  rightPane,
  saving,
  onOk,
  emptyMessage,
}) {
  if (!open) return null

  // Sidebar visibility: when `items` is null/undefined, the variant
  // doesn't have a list of sub-items (single-surface kinds — entity,
  // relationship, knowledge). Hide the sidebar entirely so the right
  // pane uses the full body width.
  const showSidebar = Array.isArray(items)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        data-help-region="awareness:modal"
        className="w-[640px] h-[70vh] flex flex-col bg-zinc-900 border border-zinc-700 rounded shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — split into a fixed-width left segment (matches the
            sidebar width below) holding the type badge, and a flex-1
            right segment holding the context (entity badge + scene/node
            badge). Context is left-aligned to the same x as the divider
            between the sidebar and the right pane. */}
        <div data-help-region="awareness:header" className="flex items-center px-3 py-2 border-b border-zinc-700 flex-shrink-0">
          <div className={`${showSidebar ? 'w-[168px]' : 'w-auto pr-3'} flex-shrink-0`}>
            <span className="text-[9px] text-accent-400 uppercase tracking-widest font-semibold bg-accent-900/30 px-1.5 py-0.5 rounded">
              {badgeLabel}
            </span>
          </div>
          <div className="flex-1 min-w-0 flex items-center gap-2 overflow-hidden">
            {contextSlot}
          </div>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-200 text-sm leading-none flex-shrink-0 ml-2"
            title="Close panel (discards unsaved changes)"
          >✕</button>
        </div>

        {/* Body — split: left sidebar of items + right pane (multi-tab
            kinds), or just the right pane full-width (single-surface
            kinds). Sidebar visibility is driven by whether `items` is
            an array (truthy = show sidebar; null/undefined = hide). */}
        <div className="flex-1 flex min-h-0 overflow-hidden">
          {showSidebar && (
            <div data-help-region="awareness:item_list" className="w-[180px] border-r border-zinc-700 flex-shrink-0 overflow-y-auto bg-zinc-950/40">
              {items.length === 0 ? (
                <div className="p-3 text-[10px] text-zinc-600 italic">
                  {emptyMessage || 'No items'}
                </div>
              ) : (
                <div className="py-1">
                  {items.map((item) => {
                    const isSelected = item.id === selectedId
                    return (
                      <button
                        key={item.id}
                        onClick={() => onSelectItem(item.id)}
                        className={`w-full text-left px-3 py-1.5 text-[11px] transition-colors border-l-2 flex items-center gap-1.5 ${
                          isSelected
                            ? 'bg-zinc-800 border-current'
                            : 'border-transparent hover:bg-zinc-800/60 text-zinc-400 hover:text-zinc-200'
                        }`}
                        style={isSelected && item.color ? { color: item.color } : undefined}
                        title={item.label || '(empty)'}
                      >
                        {item.leadingNode}
                        <span className={`flex-1 truncate ${item.italic ? 'italic' : ''}`}>
                          {item.label || '(empty)'}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* Right pane — variant-supplied content */}
          <div data-help-region="awareness:picker" className="flex-1 overflow-y-auto min-h-0 p-3">
            {rightPane}
          </div>
        </div>

        {/* Footer */}
        <div data-help-region="awareness:footer" className="flex items-center justify-end gap-2 px-4 py-3 border-t border-zinc-700 flex-shrink-0">
          <button
            onClick={onOk}
            disabled={saving}
            className="px-3 py-1.5 text-xs rounded border bg-accent-700 hover:bg-accent-600 text-white border-accent-600 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'OK'}
          </button>
          <button
            onClick={onClose}
            disabled={saving}
            className="px-3 py-1.5 text-xs rounded border text-zinc-300 hover:text-zinc-100 border-zinc-600 hover:border-zinc-500 disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
