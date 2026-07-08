import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import axios from 'axios'

/**
 * Phase 1.25h — LLM Template Import dialog.
 *
 * Stages:
 *   1. PICK — choose source (Paste text / Upload file), pick mode
 *      (New project / Merge), download a blank template.
 *   2. PREVIEW — backend dry-run summary + parse errors.
 *   3. APPLYING / DONE.
 *
 * "New project" mode starts a fresh project from the template; if
 * the active project has unsaved changes the dialog routes through
 * the standard save / discard / cancel guard first via the
 * `guardUnsavedChanges` prop. Merge mode never wipes — name-suffix
 * dedup handles collisions.
 *
 * Open / close state lives in `uiStore.templateImportDialogOpen`.
 * UI uses the story accent palette (`bg-accent-*` / `text-accent-*`)
 * — no hardcoded purple.
 */
export default function TemplateImportDialog({ open, onClose, onApplied, guardUnsavedChanges }) {
  const [stage, setStage]       = useState('pick')   // 'pick' | 'preview' | 'applying' | 'done'
  const [source, setSource]     = useState('paste')  // 'paste' | 'file' — paste-default for the LLM-response use case
  const [file, setFile]         = useState(null)
  const [pasteText, setPasteText] = useState('')
  const [mode, setMode]         = useState('new')
  // Origin-node layout for the imported story:
  //   'columns'          — per-type columns left of chapter 1 (default).
  //   'first_appearance' — origins land in the chapter of the scene
  //                        where each entity first appears as a chip;
  //                        chapters widen to fit. Entities that never
  //                        appear as a chip fall back to columns.
  const [layoutMode, setLayoutMode] = useState('first_appearance')
  // Phase 5.9 — strip leading "Chapter N" / "Act N" prefixes from imported
  // chapter/act titles. Default on.
  const [cleanChapterActTitles, setCleanChapterActTitles] = useState(true)
  const [busy, setBusy]         = useState(false)
  const [errors, setErrors]     = useState([])
  const [summary, setSummary]   = useState(null)
  const [serverError, setServerError] = useState(null)
  // Source text snapshot last sent to the parser. We keep this so the
  // per-error inline-fix UI can show the offending line, edit it, and
  // splice the result back into the payload before re-parsing —
  // regardless of whether the original source was paste or file.
  const [sourceText, setSourceText] = useState('')
  const [editingErrorIdx, setEditingErrorIdx] = useState(null)
  const [editDraft, setEditDraft] = useState('')
  const fileInputRef = useRef(null)

  useEffect(() => {
    if (!open) {
      setStage('pick')
      setSource('paste')
      setFile(null)
      setPasteText('')
      setMode('new')
      setLayoutMode('first_appearance')
      setBusy(false)
      setErrors([])
      setSummary(null)
      setServerError(null)
      setSourceText('')
      setEditingErrorIdx(null)
      setEditDraft('')
    }
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    function onKey(e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  // Pull the active template payload (file or paste) into a Blob so
  // the same multipart request shape works for both sources.
  function buildPayloadBlob() {
    if (source === 'file') {
      return file
    }
    const trimmed = pasteText
    if (!trimmed) return null
    return new Blob([trimmed], { type: 'text/markdown' })
  }

  function payloadFilename() {
    if (source === 'file') return file?.name || 'template.md'
    return 'pasted-template.md'
  }

  function hasPayload() {
    if (source === 'file') return !!file
    return pasteText.trim().length > 0
  }

  async function payloadAsText() {
    if (source === 'paste') return pasteText
    if (file) {
      try { return await file.text() } catch { return '' }
    }
    return ''
  }

  async function postTemplate(previewFlag, { skipErrors = false, overrideText = null } = {}) {
    let blob
    let text
    if (overrideText !== null) {
      text = overrideText
      blob = new Blob([overrideText], { type: 'text/markdown' })
    } else {
      text = await payloadAsText()
      blob = buildPayloadBlob()
    }
    if (!blob) return null
    setSourceText(text)
    const fd = new FormData()
    fd.append('file', blob, payloadFilename())
    fd.append('mode', mode)
    fd.append('preview', previewFlag ? 'true' : 'false')
    fd.append('layout_mode', layoutMode)
    fd.append('clean_chapter_act_titles', cleanChapterActTitles ? 'true' : 'false')
    if (skipErrors) fd.append('skip_errors', 'true')
    const { data } = await axios.post('/api/project/import/template', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    return data
  }

  // Per-error inline-fix helpers. The errors carry 1-indexed line
  // numbers; we splice the source text at that line, then re-run the
  // preview against the patched payload.
  function startEditError(idx) {
    const err = errors[idx]
    if (!err) return
    const lines = sourceText.split('\n')
    const lineText = lines[err.line - 1] ?? ''
    setEditingErrorIdx(idx)
    setEditDraft(lineText)
  }

  function cancelEditError() {
    setEditingErrorIdx(null)
    setEditDraft('')
  }

  async function rerunPreviewWith(newText) {
    // Promote to paste source so the writer's edits stick.
    setPasteText(newText)
    setSource('paste')
    setFile(null)
    setEditingErrorIdx(null)
    setEditDraft('')
    setBusy(true)
    setServerError(null)
    try {
      const data = await postTemplate(true, { overrideText: newText })
      setErrors(data.errors || [])
      setSummary(data.summary || null)
    } catch (e) {
      setServerError(e?.response?.data?.detail || e?.message || 'Re-parse failed.')
    } finally {
      setBusy(false)
    }
  }

  async function saveEditError() {
    const err = errors[editingErrorIdx]
    if (!err) return
    const lines = sourceText.split('\n')
    if (err.line < 1 || err.line > lines.length) return
    lines[err.line - 1] = editDraft
    await rerunPreviewWith(lines.join('\n'))
  }

  async function skipErrorLine(idx) {
    const err = errors[idx]
    if (!err) return
    const lines = sourceText.split('\n')
    if (err.line < 1 || err.line > lines.length) return
    lines.splice(err.line - 1, 1)
    await rerunPreviewWith(lines.join('\n'))
  }

  async function runPreview() {
    if (!hasPayload()) return
    setBusy(true)
    setServerError(null)
    try {
      const data = await postTemplate(true)
      setErrors(data.errors || [])
      setSummary(data.summary || null)
      setStage('preview')
    } catch (e) {
      setServerError(e?.response?.data?.detail || e?.message || 'Upload failed.')
    } finally {
      setBusy(false)
    }
  }

  async function applyImport({ skipErrors = false } = {}) {
    if (!hasPayload()) return
    if (mode === 'new') {
      // Mirrors the New / Open / Load-from-recent flow: if the active
      // project has unsaved changes, the standard guard prompts the
      // writer to save / discard / cancel before we proceed.
      const guard = guardUnsavedChanges
        ? await guardUnsavedChanges('Starting a new project from this template')
        : 'proceed'
      if (guard !== 'proceed') return
    }
    setBusy(true)
    setServerError(null)
    setStage('applying')
    try {
      const data = await postTemplate(false, { skipErrors })
      if (!data.applied) {
        setErrors(data.errors || [])
        setStage('preview')
        return
      }
      setSummary(data.summary || null)
      setStage('done')
      try { await onApplied?.(mode) } catch { /* ignore */ }
    } catch (e) {
      setServerError(e?.response?.data?.detail || e?.message || 'Apply failed.')
      setStage('preview')
    } finally {
      setBusy(false)
    }
  }

  // "Edit & re-parse" — flip back to the pick stage with the current
  // payload converted into editable text, so the writer can fix the
  // problematic lines inline without leaving the dialog. Used for
  // file-uploaded payloads (paste-mode payloads can already be edited
  // in place).
  async function openForEdit() {
    if (source === 'paste') {
      setStage('pick')
      return
    }
    if (file) {
      try {
        const text = await file.text()
        setPasteText(text)
        setSource('paste')
        setFile(null)
        setStage('pick')
      } catch (e) {
        setServerError('Could not read file for editing: ' + (e?.message || e))
      }
    }
  }

  // Diagnostics split into hard errors (block apply) and warnings
  // (auto-corrected or skipped lines — apply proceeds, but the writer
  // sees the list so they can review).
  const hardErrors = errors.filter((e) => (e.severity || 'error') === 'error')
  const warnings   = errors.filter((e) => e.severity === 'warning')
  const canApply   = stage === 'preview' && hardErrors.length === 0 && summary

  return createPortal(
    <div
      className="fixed inset-0 z-[1000] bg-black/60 flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div data-help-region="template-import:modal" className="bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl w-[640px] max-w-[90vw] max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700">
          <h2 className="text-zinc-100 font-semibold">Import from Template</h2>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-100 text-xl leading-none"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div data-help-region="template-import:body" className="flex-1 overflow-y-auto p-4 text-sm text-zinc-200 space-y-4">
          {stage === 'pick' && (
            <>
              <p className="text-zinc-300 leading-relaxed">
                Hand a populated NarrativeNode story template (markdown) to the importer.
                Need a blank template to give an LLM? Download the canonical one and paste it
                into your conversation:
              </p>
              <p>
                <a
                  href="/templates/narrativenode-story-template.md"
                  download="narrativenode-story-template.md"
                  className="text-accent-400 hover:text-accent-300 underline"
                >
                  Download story template (.md)
                </a>
              </p>

              {/* Source toggle: file vs paste */}
              <div data-help-region="template-import:source" className="border border-zinc-700 rounded bg-zinc-950/40">
                <div className="flex border-b border-zinc-700">
                  <SourceTab
                    label="Paste text"
                    active={source === 'paste'}
                    onClick={() => setSource('paste')}
                  />
                  <SourceTab
                    label="Upload file"
                    active={source === 'file'}
                    onClick={() => setSource('file')}
                  />
                </div>
                <div className="p-3">
                  {source === 'file' && (
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".md,.markdown,text/markdown,text/plain"
                      onChange={(e) => setFile(e.target.files?.[0] || null)}
                      className="block w-full text-sm text-zinc-300 file:mr-3 file:py-1 file:px-3 file:rounded file:border-0 file:bg-zinc-700 file:text-zinc-100 hover:file:bg-zinc-600"
                    />
                  )}
                  {source === 'paste' && (
                    <>
                      <textarea
                        value={pasteText}
                        onChange={(e) => setPasteText(e.target.value)}
                        spellCheck={false}
                        placeholder="Paste your populated template here…"
                        className="w-full h-56 bg-zinc-950 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-100 font-mono focus:outline-none focus:border-accent-500 resize-y"
                      />
                      <div className="text-xs text-zinc-500 mt-1">
                        {pasteText.length.toLocaleString()} character{pasteText.length === 1 ? '' : 's'}
                      </div>
                    </>
                  )}
                </div>
              </div>

              <div data-help-region="template-import:mode" className="border border-zinc-700 rounded p-3 bg-zinc-950/40 space-y-2">
                <div className="text-zinc-300">Mode</div>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="template-mode"
                    value="new"
                    checked={mode === 'new'}
                    onChange={() => setMode('new')}
                    className="mt-0.5 accent-accent-500"
                  />
                  <span>
                    <span className="text-zinc-100">New project</span>
                    <span className="text-zinc-400"> — start a fresh project from the template. If the active project has unsaved changes, you'll be prompted to save first.</span>
                  </span>
                </label>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="template-mode"
                    value="merge"
                    checked={mode === 'merge'}
                    onChange={() => setMode('merge')}
                    className="mt-0.5 accent-accent-500"
                  />
                  <span>
                    <span className="text-zinc-100">Merge</span>
                    <span className="text-zinc-400"> — append into the active project. Name collisions are renamed (e.g. "Alice" → "Alice (2)").</span>
                  </span>
                </label>

                {/* Origin layout — only visible for "New project" since
                    merge keeps existing positions. Drives entity origin
                    node placement on import. */}
                {mode === 'new' && (
                  <div data-help-region="template-import:origin_layout" className="pt-2 mt-2 border-t border-zinc-800 space-y-1">
                    <label
                      htmlFor="template-layout-mode"
                      className="block text-zinc-300"
                    >
                      Origin layout
                    </label>
                    <select
                      id="template-layout-mode"
                      value={layoutMode}
                      onChange={(e) => setLayoutMode(e.target.value)}
                      className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-zinc-100 focus:outline-none focus:border-accent-500"
                    >
                      <option value="columns">Group origins before chapters</option>
                      <option value="first_appearance">Place origins by first appearance</option>
                    </select>
                    <div className="text-xs text-zinc-500 pl-0.5">
                      {layoutMode === 'columns'
                        ? 'All entity origin nodes sit in per-type columns to the left of chapter 1.'
                        : 'Each origin lands in the chapter of the scene where it first appears as a chip; chapters widen on the left to fit. Entities never appearing as a chip fall back to columns.'}
                    </div>
                  </div>
                )}

                {/* Phase 5.9 — chapter/act title cleaning. Applies to both
                    new and merge imports, so it sits outside the new-only
                    layout block. */}
                <div data-help-region="template-import:clean_titles" className="pt-2 mt-2 border-t border-zinc-800 space-y-1">
                  <label className="flex items-center gap-2 text-zinc-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={cleanChapterActTitles}
                      onChange={(e) => setCleanChapterActTitles(e.target.checked)}
                      className="accent-accent-500"
                    />
                    Clean Chapter / Act titles
                  </label>
                  <div className="text-xs text-zinc-500 pl-0.5">
                    Removes a leading &quot;Chapter One&quot;, &quot;Act 1:&quot;, &quot;Ch. 3 -&quot; style prefix from imported chapter and act titles, keeping the rest of the title. Turn off to import titles exactly as written.
                  </div>
                </div>
              </div>

              {serverError && (
                <div className="text-red-400 border border-red-800/50 bg-red-950/30 rounded p-2">
                  {serverError}
                </div>
              )}
            </>
          )}

          {stage === 'preview' && summary && (
            <>
              <div className="text-zinc-300">
                Parsed <span className="text-zinc-100">{payloadFilename()}</span> in <span className="text-zinc-100">{mode}</span> mode.
              </div>
              <div data-help-region="template-import:preview_summary" className="grid grid-cols-2 gap-2 text-sm">
                <SummaryRow label="Characters"        value={summary.characters} />
                <SummaryRow label="Locations"         value={summary.locations} />
                <SummaryRow label="Items"             value={summary.items} />
                <SummaryRow label="Factions"          value={summary.factions} />
                <SummaryRow label="Customs"           value={summary.customs} />
                <SummaryRow label="Relationships"     value={summary.relationships} />
                <SummaryRow label="Knowledge"         value={summary.knowledges} />
                <SummaryRow label="Scenes"            value={summary.scenes} />
                <SummaryRow label="Chapters"          value={summary.chapters} />
                <SummaryRow label="Preset Lists"      value={summary.preset_lists} />
                <SummaryRow label="Custom Categories" value={summary.custom_categories} />
              </div>
              {hardErrors.length > 0 && (
                <div data-help-region="template-import:diagnostics_errors" className="border border-red-800/50 bg-red-950/30 rounded p-2 max-h-80 overflow-y-auto">
                  <div className="text-red-300 font-semibold mb-1">
                    {hardErrors.length} parse error{hardErrors.length === 1 ? '' : 's'} (blocking) — click a row to fix or skip
                  </div>
                  <ul className="space-y-1 text-xs text-red-200">
                    {errors.map((e, i) => {
                      const isError = (e.severity || 'error') === 'error'
                      if (!isError) return null
                      const isEditing = editingErrorIdx === i
                      return (
                        <li key={i} className="border-b border-red-900/40 last:border-b-0 pb-1 last:pb-0">
                          <button
                            type="button"
                            onClick={() => isEditing ? cancelEditError() : startEditError(i)}
                            className="text-left w-full hover:bg-red-900/30 rounded px-1 py-0.5"
                          >
                            <span className="text-red-100">L{e.line}</span>{' '}
                            expected <span className="text-zinc-100">{e.expected}</span>;{' '}
                            found <span className="text-zinc-300">{e.found}</span>
                            {e.hint && <span className="text-zinc-500"> — {e.hint}</span>}
                            <span className="ml-1 text-zinc-500">[{isEditing ? 'close' : 'fix …'}]</span>
                          </button>
                          {isEditing && (
                            <div className="mt-1 pl-2 border-l-2 border-red-700/60 space-y-2">
                              <div>
                                <label className="block text-[11px] text-zinc-400 mb-0.5">Line {e.line} — original (problem highlighted):</label>
                                <div className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-300 font-mono whitespace-pre-wrap break-words">
                                  {renderHighlightedLine(sourceText.split('\n')[e.line - 1] ?? '', e.found)}
                                </div>
                              </div>
                              <div>
                                <label className="block text-[11px] text-zinc-400 mb-0.5">Edit:</label>
                                <textarea
                                  value={editDraft}
                                  onChange={(ev) => setEditDraft(ev.target.value)}
                                  spellCheck={false}
                                  rows={Math.min(6, Math.max(2, (editDraft.match(/\n/g) || []).length + 1))}
                                  className="w-full bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 font-mono focus:outline-none focus:border-accent-500 resize-y"
                                />
                              </div>
                              {Array.isArray(e.suggestions) && e.suggestions.length > 0 && (
                                <div>
                                  <label className="block text-[11px] text-zinc-400 mb-0.5">Suggestions (click to substitute):</label>
                                  <div className="flex flex-wrap gap-1">
                                    {e.suggestions.map((sug, si) => (
                                      <button
                                        key={si}
                                        type="button"
                                        onClick={() => setEditDraft(applySuggestion(editDraft, e.found, sug))}
                                        className="px-2 py-0.5 rounded border border-emerald-700 bg-emerald-900/30 hover:bg-emerald-900/50 text-emerald-100 text-[11px] font-mono"
                                        title={`Replace "${e.found}" with "${sug}" in the line above`}
                                      >
                                        {sug}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              )}
                              <div className="flex gap-2 justify-end">
                                <button
                                  type="button"
                                  onClick={cancelEditError}
                                  disabled={busy}
                                  className="px-2 py-0.5 rounded border border-zinc-600 text-zinc-300 hover:bg-zinc-800 text-[11px]"
                                >
                                  Cancel
                                </button>
                                <button
                                  type="button"
                                  onClick={() => skipErrorLine(i)}
                                  disabled={busy}
                                  className="px-2 py-0.5 rounded border border-amber-700 text-amber-100 hover:bg-amber-900/40 text-[11px]"
                                  title="Remove this line entirely from the template and re-parse."
                                >
                                  Skip this line
                                </button>
                                <button
                                  type="button"
                                  onClick={saveEditError}
                                  disabled={busy}
                                  className="px-2 py-0.5 rounded bg-accent-700 hover:bg-accent-600 text-white text-[11px]"
                                >
                                  {busy ? 'Re-parsing…' : 'Save & re-parse'}
                                </button>
                              </div>
                            </div>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}
              {warnings.length > 0 && (
                <div data-help-region="template-import:diagnostics_warnings" className="border border-amber-800/50 bg-amber-950/30 rounded p-2 max-h-64 overflow-y-auto">
                  <div className="text-amber-300 font-semibold mb-1">{warnings.length} warning{warnings.length === 1 ? '' : 's'} (auto-corrected or skipped — apply will proceed)</div>
                  <ul className="space-y-1 text-xs text-amber-200">
                    {warnings.map((e, i) => (
                      <li key={i}>
                        <span className="text-amber-100">L{e.line}</span>{' '}
                        expected <span className="text-zinc-100">{e.expected}</span>;{' '}
                        found <span className="text-zinc-300">{e.found}</span>
                        {e.hint && <span className="text-zinc-500"> — {e.hint}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {serverError && (
                <div className="text-red-400 border border-red-800/50 bg-red-950/30 rounded p-2">
                  {serverError}
                </div>
              )}
            </>
          )}

          {stage === 'applying' && (
            <div className="text-zinc-300">Applying import…</div>
          )}

          {stage === 'done' && summary && (
            <>
              <div className="text-zinc-100 font-semibold">Import complete.</div>
              <div className="text-zinc-300 text-sm">
                Created {summary.entities ?? 0} entities, {summary.relationships ?? 0} relationships,
                {' '}{summary.knowledges ?? 0} knowledge entries, and {summary.scenes ?? 0} scenes.
              </div>
            </>
          )}
        </div>

        {/* Action bar */}
        <div data-help-region="template-import:actions" className="flex items-center justify-end gap-2 px-4 py-3 border-t border-zinc-700">
          {stage === 'pick' && (
            <>
              <button
                onClick={onClose}
                className="px-3 py-1.5 rounded border border-zinc-600 text-zinc-300 hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                onClick={runPreview}
                disabled={!hasPayload() || busy}
                className="px-3 py-1.5 rounded bg-accent-700 hover:bg-accent-600 text-white disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {busy ? 'Parsing…' : 'Preview'}
              </button>
            </>
          )}
          {stage === 'preview' && (
            <>
              <button
                onClick={() => setStage('pick')}
                className="px-3 py-1.5 rounded border border-zinc-600 text-zinc-300 hover:bg-zinc-800"
              >
                Back
              </button>
              {hardErrors.length > 0 && (
                <>
                  <button
                    onClick={openForEdit}
                    className="px-3 py-1.5 rounded border border-zinc-600 text-zinc-200 hover:bg-zinc-800"
                    title="Open the template text in the editor so you can fix the flagged lines."
                  >
                    Edit & re-parse
                  </button>
                  <button
                    onClick={() => applyImport({ skipErrors: true })}
                    disabled={busy || !summary}
                    className="px-3 py-1.5 rounded border border-amber-700 text-amber-100 hover:bg-amber-900/40 disabled:opacity-40 disabled:cursor-not-allowed"
                    title={`Apply the import anyway. The ${hardErrors.length} flagged line${hardErrors.length === 1 ? '' : 's'} will be skipped; everything else lands as previewed.`}
                  >
                    {busy ? 'Applying…' : 'Apply anyway (skip errors)'}
                  </button>
                </>
              )}
              <button
                onClick={() => applyImport()}
                disabled={!canApply || busy}
                className="px-3 py-1.5 rounded bg-accent-700 hover:bg-accent-600 text-white disabled:opacity-40 disabled:cursor-not-allowed"
                title={hardErrors.length ? 'Fix parse errors first, or use "Apply anyway" to skip the flagged lines.' : null}
              >
                {busy ? 'Applying…' : (mode === 'new' ? 'Start new project' : 'Merge into project')}
              </button>
            </>
          )}
          {stage === 'done' && (
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded bg-accent-700 hover:bg-accent-600 text-white"
            >
              Done
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}


// Render a single source line with the parser's `found` substring
// highlighted in red. When the substring isn't a clean match (e.g. the
// found text is a paraphrase like "missing entity"), fall back to
// rendering the line plain.
function renderHighlightedLine(line, found) {
  if (!found || typeof found !== 'string') return line
  const idx = line.indexOf(found)
  if (idx < 0) return line
  return (
    <>
      {line.slice(0, idx)}
      <mark className="bg-red-700/40 text-red-100 rounded px-0.5">{line.slice(idx, idx + found.length)}</mark>
      {line.slice(idx + found.length)}
    </>
  )
}

// Substitute the offending `found` substring in `currentDraft` with
// the suggestion. If `found` doesn't appear in the current draft,
// fall back to replacing the suggestion alone (writer can still hand-
// edit afterwards).
function applySuggestion(currentDraft, found, suggestion) {
  if (typeof currentDraft !== 'string' || typeof suggestion !== 'string') return currentDraft
  if (typeof found === 'string' && found && currentDraft.includes(found)) {
    return currentDraft.replace(found, suggestion)
  }
  return suggestion
}


function SourceTab({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 text-sm border-b-2 transition-colors ${
        active
          ? 'border-accent-500 text-zinc-100 bg-zinc-900/40'
          : 'border-transparent text-zinc-400 hover:text-zinc-200'
      }`}
    >
      {label}
    </button>
  )
}


function SummaryRow({ label, value }) {
  return (
    <div className="flex justify-between border border-zinc-800 rounded px-2 py-1 bg-zinc-950/40">
      <span className="text-zinc-400">{label}</span>
      <span className="text-zinc-100">{value ?? 0}</span>
    </div>
  )
}
