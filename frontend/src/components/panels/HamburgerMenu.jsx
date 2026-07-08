import { useEffect, useRef, useState } from 'react'

/**
 * Phase 1.22j — Hamburger menu (top-bar far-left consolidation).
 *
 * Application menu consolidating file ops + import / export +
 * settings. Replaces the previous spray of individual New / Load /
 * Recent / Save As / Import-Export / Settings buttons that lived
 * directly on the top bar.
 *
 * Layout per menu row: `[icon] [label]` in a fixed-width icon column.
 * Recents render INLINE under Open (no separate header); Import and
 * Export use right-side hover flyouts (not inline expanders).
 *
 * Click-outside detection mirrors the legacy ImportExportMenu —
 * capture-phase pointerdown anchored to the wrapper containing both
 * the toggle button and the dropdown.
 */
export default function HamburgerMenu({
  // File ops
  onNew,
  onOpen,
  onSave,
  onSaveAs,
  // Search (Phase 1.24d — global search modal)
  onFind,
  // Story Library (Phase 5.5)
  onLibrary,
  // Recents
  recentProjects,
  onLoadFromRecent,
  // Import / export
  onExportStory,
  onExportNnz,
  onExportStorySeeds,
  onExportCharacterCard,
  onImportEntities,
  onImportStorySeeds,
  onImportTemplate,
  onImportNovelcrafter,
  onImportCharacterCard,
  // Settings + Help
  onSettings,
  onHelp,
}) {
  const [open, setOpen] = useState(false)
  const [hoverFlyout, setHoverFlyout] = useState(null) // 'import' | 'export' | null
  const wrapperRef = useRef(null)
  const closeTimerRef = useRef(null)

  // Click-outside closes the whole menu (and any flyouts).
  useEffect(() => {
    if (!open) return undefined
    function handler(e) {
      const wrapper = wrapperRef.current
      if (wrapper && !wrapper.contains(e.target)) {
        setOpen(false)
        setHoverFlyout(null)
      }
    }
    document.addEventListener('pointerdown', handler, true)
    return () => document.removeEventListener('pointerdown', handler, true)
  }, [open])

  // Escape closes.
  useEffect(() => {
    if (!open) return undefined
    function onKey(e) {
      if (e.key === 'Escape') {
        setOpen(false)
        setHoverFlyout(null)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  function close() {
    setOpen(false)
    setHoverFlyout(null)
  }

  function fire(handler) {
    return () => {
      close()
      try { handler?.() } catch { /* ignore */ }
    }
  }

  // Flyout open / close with a small grace window so the cursor can
  // travel from the parent row to the flyout panel without the panel
  // closing mid-traverse.
  function openFlyout(name) {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
    setHoverFlyout(name)
  }
  function scheduleCloseFlyout() {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    closeTimerRef.current = setTimeout(() => {
      setHoverFlyout(null)
      closeTimerRef.current = null
    }, 150)
  }

  const recents = (recentProjects || []).slice(0, 5)

  return (
    <div ref={wrapperRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        data-help-region="menu-bar:app_menu"
        className="w-9 h-9 flex items-center justify-center rounded text-zinc-200 hover:bg-zinc-700 transition-colors"
        title="Application menu"
        aria-label="Application menu"
        aria-expanded={open}
      >
        <span className="text-xl leading-none">☰</span>
      </button>

      {open && (
        <div
          className="absolute left-0 top-full mt-1 w-64 bg-zinc-800 border border-zinc-600 rounded shadow-lg z-50 py-1"
          data-help-region="menu-bar:app_menu_dropdown"
        >
          <MenuItem icon={<NewIcon />}     label="New"      onClick={fire(onNew)} dataHelpRegion="menu-bar:menu_new" />
          <MenuItem icon={<OpenIcon />}    label="Open…"    onClick={fire(onOpen)} dataHelpRegion="menu-bar:menu_open" />
          {recents.length > 0 && (
            <div className="ml-4 mr-1 mb-1 border-l border-zinc-700" data-help-region="menu-bar:menu_recents">
              {recents.map((entry) => (
                <button
                  key={entry.name + entry.openedAt}
                  onClick={() => { close(); onLoadFromRecent?.(entry) }}
                  className="w-full text-left pl-3 pr-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-700 rounded truncate"
                  title={entry.name}
                >
                  <span className="block truncate">{entry.name}</span>
                </button>
              ))}
            </div>
          )}
          {onLibrary && (
            <MenuItem icon={<LibraryIcon />} label="Library" onClick={fire(onLibrary)} dataHelpRegion="menu-bar:menu_library" />
          )}
          <Divider />
          <MenuItem icon={<SaveIcon />}    label="Save"     onClick={fire(onSave)} dataHelpRegion="menu-bar:menu_save" />
          <MenuItem icon={<SaveAsIcon />}  label="Save As…" onClick={fire(onSaveAs)} dataHelpRegion="menu-bar:menu_save_as" />
          <Divider />
          <MenuItem icon={<FindIcon />}    label="Find…"    onClick={fire(onFind)} dataHelpRegion="menu-bar:menu_find" />
          <Divider />

          {/* Import flyout */}
          <FlyoutItem
            icon={<ImportIcon />}
            label="Import"
            isOpen={hoverFlyout === 'import'}
            onEnter={() => openFlyout('import')}
            onLeave={scheduleCloseFlyout}
            dataHelpRegion="menu-bar:menu_import"
          >
            <MenuItem label="Import Entities…"     onClick={fire(onImportEntities)} />
            <MenuItem label="Import Story Seeds…" onClick={fire(onImportStorySeeds)} />
            <MenuItem label="Import from Template…" onClick={fire(onImportTemplate)} />
            <MenuItem label="Import from Novelcrafter…" onClick={fire(onImportNovelcrafter)} />
            <MenuItem label="Import Character Card…" onClick={fire(onImportCharacterCard)} />
          </FlyoutItem>

          {/* Export flyout */}
          <FlyoutItem
            icon={<ExportIcon />}
            label="Export"
            isOpen={hoverFlyout === 'export'}
            onEnter={() => openFlyout('export')}
            onLeave={scheduleCloseFlyout}
            dataHelpRegion="menu-bar:menu_export"
          >
            <MenuItem label="Export Story…"        onClick={fire(onExportStory)} />
            <MenuItem label="Export as .nnz"       onClick={fire(onExportNnz)} />
            <MenuItem label="Export Story Seeds"   onClick={fire(onExportStorySeeds)} />
            <MenuItem label="Export Character Card…" onClick={fire(onExportCharacterCard)} />
          </FlyoutItem>

          <Divider />
          <MenuItem icon={<HelpIcon />}    label="Help"     onClick={fire(onHelp)} dataHelpRegion="menu-bar:menu_help" />
          <MenuItem icon={<GearIcon />}    label="Settings" onClick={fire(onSettings)} dataHelpRegion="menu-bar:menu_settings" />
        </div>
      )}
    </div>
  )
}

// ── Menu primitives ──────────────────────────────────────────────────────

function Divider() {
  return <div className="border-t border-zinc-700 my-1" />
}

function MenuItem({ icon, label, onClick, dataHelpRegion }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2 text-left px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700"
      data-help-region={dataHelpRegion}
    >
      <span className="w-4 h-4 flex-shrink-0 flex items-center justify-center text-accent-400">
        {icon || null}
      </span>
      <span className="flex-1 truncate">{label}</span>
    </button>
  )
}

function FlyoutItem({ icon, label, isOpen, onEnter, onLeave, children, dataHelpRegion }) {
  return (
    <div
      className="relative"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <button
        type="button"
        className="w-full flex items-center gap-2 text-left px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700"
        data-help-region={dataHelpRegion}
      >
        <span className="w-4 h-4 flex-shrink-0 flex items-center justify-center text-accent-400">
          {icon || null}
        </span>
        <span className="flex-1 truncate">{label}</span>
        <span className="text-zinc-500 text-[10px]">▸</span>
      </button>
      {isOpen && (
        <div
          className="absolute left-full top-0 ml-1 w-56 bg-zinc-800 border border-zinc-600 rounded shadow-lg py-1"
          onMouseEnter={onEnter}
          onMouseLeave={onLeave}
        >
          {children}
        </div>
      )}
    </div>
  )
}

// ── Icons (inline SVG, currentColor-driven so they pick up the
//    surrounding text colour on hover) ─────────────────────────────────

function NewIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="12" y1="13" x2="12" y2="17" />
      <line x1="10" y1="15" x2="14" y2="15" />
    </svg>
  )
}

function OpenIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  )
}

function SaveIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </svg>
  )
}

function FindIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="M16 16 L21 21" />
    </svg>
  )
}

function SaveAsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
      <path d="M16 16l4-4m0 4l-4-4" />
    </svg>
  )
}

function ImportIcon() {
  // Down-arrow into tray
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )
}

function ExportIcon() {
  // Up-arrow out of tray
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  )
}

function LibraryIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  )
}

function HelpIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}

function GearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}
