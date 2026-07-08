import { useEffect, useRef, useState } from 'react'
import axios from 'axios'
import PlaceholderPillEditor from '../../ui/PlaceholderPillEditor'

/**
 * PersonaPreambleSection — Phase 2.11a item 4.
 *
 * Top-of-tab section in Settings → System Prompts that lets the writer
 * customise the Persona Preamble (the program-injected identity
 * declaration prepended to every Persona system prompt at send time).
 *
 *   ─── Storage ───────────────────────────────────────────────────────
 *
 * Shipped default lives as a Python constant on the backend
 * (`backend/services/persona_preamble_service.py`). User customisation
 * writes to `preferences/persona_preamble.json` with shape `{body: str}`.
 * File presence IS the "customised" signal — see the planning doc and
 * the service module's header for the full design.
 *
 * Three REST endpoints:
 *   - GET    /api/persona-preamble  → `{body: str, is_custom: bool}`
 *   - PUT    /api/persona-preamble  with `{body: str}`
 *   - DELETE /api/persona-preamble  → resets to shipped default
 *
 *   ─── Field pre-population ──────────────────────────────────────────
 *
 * The editor is NEVER blank. On mount we GET the effective preamble
 * and seed `draftBody` with it. The writer always has a real starting
 * point — their customisation if one exists, the shipped default if
 * not. After Reset, the field repopulates from the now-effective
 * shipped default.
 *
 *   ─── Save / Reset semantics ────────────────────────────────────────
 *
 * Save = PUT the current draft. Disabled until the draft differs from
 * the loaded saved value, and during the in-flight write.
 *
 * Reset = DELETE the customisation file. Disabled when `is_custom` is
 * already false (the writer is already on the shipped default). After
 * a successful Reset, the field repopulates from the GET response.
 */
export default function PersonaPreambleSection() {
  const [draftBody, setDraftBody] = useState('')
  const [savedBody, setSavedBody] = useState('')
  const [isCustom, setIsCustom] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [writeError, setWriteError] = useState(null)
  const [collapsed, setCollapsed] = useState(true)
  const editorRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const { data } = await axios.get('/api/persona-preamble')
        if (cancelled) return
        const body = typeof data?.body === 'string' ? data.body : ''
        setDraftBody(body)
        setSavedBody(body)
        setIsCustom(!!data?.is_custom)
        setLoaded(true)
      } catch (err) {
        if (cancelled) return
        setLoadError(err?.response?.data?.detail || err?.message || 'Failed to load Persona Preamble')
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  const isDirty = draftBody !== savedBody

  async function handleSave() {
    setBusy(true)
    setWriteError(null)
    try {
      const { data } = await axios.put('/api/persona-preamble', { body: draftBody })
      const body = typeof data?.body === 'string' ? data.body : draftBody
      setDraftBody(body)
      setSavedBody(body)
      setIsCustom(!!data?.is_custom)
    } catch (err) {
      setWriteError(err?.response?.data?.detail || err?.message || 'Failed to save Persona Preamble')
    } finally {
      setBusy(false)
    }
  }

  async function handleReset() {
    setBusy(true)
    setWriteError(null)
    try {
      const { data } = await axios.delete('/api/persona-preamble')
      const body = typeof data?.body === 'string' ? data.body : ''
      setDraftBody(body)
      setSavedBody(body)
      setIsCustom(!!data?.is_custom)
    } catch (err) {
      setWriteError(err?.response?.data?.detail || err?.message || 'Failed to reset Persona Preamble')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section data-help-region="settings:persona_preamble" className="rounded border border-accent-700/40 bg-zinc-900/40">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        title={collapsed ? 'Expand Persona Preamble' : 'Collapse Persona Preamble'}
        data-help-region="settings:persona_preamble_toggle"
        className="w-full px-3 py-2 border-b border-zinc-800 flex items-baseline gap-2 flex-wrap text-left hover:bg-zinc-800/40 transition-colors"
        style={collapsed ? { borderBottomColor: 'transparent' } : undefined}
      >
        <span className="text-[10px] text-zinc-500 flex-shrink-0">{collapsed ? '▸' : '▾'}</span>
        <span className="text-[11px] uppercase tracking-wide text-accent-200 font-semibold">🎭 Persona Preamble</span>
        <span className="text-[10px] text-zinc-500">prepended to every Persona system prompt at send time</span>
      </button>
      {!collapsed && (
      <div className="px-3 py-2 space-y-2">
        <p className="text-[10px] text-zinc-500 leading-snug">
          The Persona Preamble is the identity declaration the program prepends to every Persona-flagged system prompt automatically. It exists outside your voice templates so heavy customisation of a voice template can&apos;t accidentally strip the &ldquo;be this character&rdquo; instruction. Use the <code className="px-1 bg-zinc-800 rounded text-[10px]">{`{{character_name}}`}</code> placeholder where the resolved character name should appear; the program substitutes it at send time.
        </p>
        {loadError && (
          <div className="text-[11px] text-red-300 bg-red-900/20 border border-red-700/50 rounded px-2 py-1">
            {loadError}
          </div>
        )}
        {loaded && (
          <>
            <div data-help-region="settings:persona_preamble_editor" className="rounded border border-zinc-700 bg-zinc-900/60">
              <PlaceholderPillEditor
                ref={editorRef}
                value={draftBody}
                onChange={setDraftBody}
                disabled={busy}
                minHeight="5rem"
              />
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => editorRef.current?.insertPlaceholder('character_name')}
                disabled={busy}
                title="Insert {{character_name}} placeholder at the cursor. The program substitutes the resolved character name at send time."
                data-help-region="settings:persona_preamble_insert_placeholder"
                className="text-[10px] px-2 py-1 rounded border border-zinc-700 bg-zinc-800 text-zinc-300 hover:text-zinc-100 hover:bg-zinc-700/60 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                Insert {`{{character_name}}`}
              </button>
              <div className="flex-1" />
              {writeError && (
                <span className="text-[11px] text-red-300 mr-1 truncate" title={writeError}>{writeError}</span>
              )}
              <button
                type="button"
                onClick={handleReset}
                disabled={busy || !isCustom}
                title={isCustom
                  ? 'Reset to the shipped default. Deletes your customisation file.'
                  : 'Already on the shipped default — nothing to reset.'}
                data-help-region="settings:persona_preamble_reset"
                className="text-[10px] px-2 py-1 rounded border border-zinc-700 bg-zinc-800 text-zinc-300 hover:text-zinc-100 hover:bg-zinc-700/60 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                Reset to default
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={busy || !isDirty}
                data-help-region="settings:persona_preamble_save"
                className="text-[10px] px-2.5 py-1 rounded bg-accent-700 text-white hover:bg-accent-600 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        )}
      </div>
      )}
    </section>
  )
}
