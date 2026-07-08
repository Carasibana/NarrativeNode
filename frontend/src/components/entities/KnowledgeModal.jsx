import { useState, useEffect, useMemo, useRef } from 'react'
import { useUiStore } from '../../store/uiStore'
import { useProjectStore } from '../../store/projectStore'
import { useEntitiesStore } from '../../store/entitiesStore'
import { confirm } from '../../store/dialogStore'
import ProfileImageUpload from './ProfileImageUpload'
import EntityColorPicker from '../ui/EntityColorPicker'
import AwarenessPicker from './AwarenessPicker'
import { SCALE_ALIAS, SCALE_BINARY } from '../ui/AwarenessBadges'
import { EventBadge } from '../ui/IdentityBadges'

const BLANK_FORM = {
  name: '',
  colour: '#888888',
  description: '',
  profile_image_ref: null,
  awareness: null,
  awareness_scale: 'full',
}

export default function KnowledgeModal() {
  const knowledgeModalOpen = useUiStore((s) => s.knowledgeModalOpen)
  const closeKnowledgeModal = useUiStore((s) => s.closeKnowledgeModal)
  const pendingPosition = useUiStore((s) => s.knowledgeModalPendingPosition)
  const pendingSource = useUiStore((s) => s.knowledgeModalPendingSource)

  const createKnowledge = useProjectStore((s) => s.createKnowledge)
  const createKnowledgeAtScene = useProjectStore((s) => s.createKnowledgeAtScene)
  const addKnowledgeOriginNodeToCanvas = useProjectStore((s) => s.addKnowledgeOriginNodeToCanvas)
  const projectNodes = useProjectStore((s) => s.nodes)
  const allKnowledges = useProjectStore((s) => s.knowledges)

  const characters = useEntitiesStore((s) => s.characters)
  const locations  = useEntitiesStore((s) => s.locations)
  const items      = useEntitiesStore((s) => s.items)
  const factions   = useEntitiesStore((s) => s.factions)
  const customs    = useEntitiesStore((s) => s.customs)
  const entityMap = useMemo(() => {
    const m = new Map()
    for (const e of [...characters, ...locations, ...items, ...factions, ...customs]) m.set(e.id, e)
    return m
  }, [characters, locations, items, factions, customs])

  const [form, setForm] = useState(BLANK_FORM)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const colourAnchorRef = useRef(null)
  const [colourPickerOpen, setColourPickerOpen] = useState(false)

  useEffect(() => {
    if (!knowledgeModalOpen) return
    // Pre-fill the name field when opened from a change sub-chip
    // (`pendingSource.suggestedName`); otherwise blank for the
    // standard "+ New Knowledge" flow.
    setForm({
      ...BLANK_FORM,
      name: pendingSource?.suggestedName || '',
    })
    setError(null)
    setColourPickerOpen(false)
  }, [knowledgeModalOpen, pendingSource?.suggestedName])

  if (!knowledgeModalOpen) return null

  const patch = (p) => setForm((f) => ({ ...f, ...p }))

  async function handleCreate() {
    const trimmed = form.name.trim()
    if (!trimmed) { setError('Name is required.'); return }
    // Duplicate-name guard: prompt before creating a second Knowledge
    // whose origin name matches an existing one. Compares against each
    // Knowledge's baseline `name` (its origin value) — chain-renamed
    // copies further downstream don't trigger the check, since the
    // origin name is what the writer is committing to here.
    const lower = trimmed.toLowerCase()
    const collision = (allKnowledges || []).some((k) => (k?.name || '').trim().toLowerCase() === lower)
    if (collision) {
      const choice = await confirm({
        title: 'Knowledge name already exists',
        message: `Another Knowledge named "${trimmed}" already exists. Create a second one with the same name?`,
        buttons: [
          { label: 'Cancel', value: 'cancel', style: 'secondary' },
          { label: 'Create anyway', value: 'create', style: 'primary' },
        ],
        cancelValue: 'cancel',
      })
      if (choice !== 'create') return
    }
    setSaving(true)
    try {
      const payload = {
        name: form.name.trim(),
        colour: form.colour,
        description: form.description,
        profile_image_ref: form.profile_image_ref,
        awareness: form.awareness,
        awareness_scale: form.awareness_scale,
      }
      // Path A — when pendingSource is set, the writer is creating a
      // Knowledge from a change sub-chip's "Add knowledge of this
      // change" affordance. The new Knowledge is born at the trigger
      // scene (scene-born activate event) and carries the back-pointer
      // on its baseline `source_event` field. No canvas origin node is
      // created — the trigger scene IS the creation anchor.
      if (pendingSource?.sourceEvent && pendingSource?.triggerNodeId) {
        payload.source_event = pendingSource.sourceEvent
        await createKnowledgeAtScene(payload, pendingSource.triggerNodeId)
        closeKnowledgeModal()
        return
      }
      const knowledge = await createKnowledge(payload)
      // Auto-spawn a canvas origin node alongside the Knowledge. The
      // user can delete it from the canvas if they want a pre-story-
      // baseline Knowledge with no canvas anchor. `pendingPosition`
      // (set when the modal was opened from a canvas right-click)
      // pins the origin node at the click location; null falls back
      // to the viewport centre (library-opened modal).
      if (knowledge?.id) {
        addKnowledgeOriginNodeToCanvas(knowledge.id, pendingPosition || null)
      }
      closeKnowledgeModal()
    } catch {
      setError('Failed to create knowledge.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60">
      <div data-help-region="knowledge-modal:modal" className="bg-zinc-800 border border-zinc-600 rounded-lg shadow-2xl w-[480px] max-h-[85vh] flex flex-col">
        {/* Header */}
        <div data-help-region="knowledge-modal:header" className="flex items-center justify-between px-4 py-3 border-b border-zinc-700 flex-shrink-0">
          <h2 className="text-sm font-semibold text-zinc-100">New Knowledge</h2>
          <button onClick={closeKnowledgeModal} className="text-zinc-400 hover:text-zinc-200">✕</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {error && (
            <div className="text-xs text-red-400 bg-red-900/30 border border-red-700/50 rounded px-3 py-2">
              {error}
            </div>
          )}

          {/* Profile image + (optional) Attached event side by side.
              When the modal is opened from a change sub-chip's "Add
              knowledge of this change" path, the EventBadge sits to
              the right of the profile image upload, roughly aligned to
              its top edge. When opened standalone, the profile image
              renders alone as before. */}
          {pendingSource?.sourceEvent ? (() => {
            const ev = pendingSource.sourceEvent
            const display = pendingSource.eventDisplay || {}
            const ownerId = display.ownerEntityId || ev.entity_id
            const owner = ownerId ? entityMap.get(ownerId) : null
            return (
              <div className="flex items-center justify-between gap-3">
                <ProfileImageUpload
                  fileRef={form.profile_image_ref}
                  entityType="knowledge"
                  entityColour={form.colour}
                  onChange={(fileRef) => patch({ profile_image_ref: fileRef })}
                />
                <EventBadge
                  entity={owner}
                  nodeId={ev.node_id}
                  nodes={projectNodes}
                  entityMap={entityMap}
                  fieldLabel={display.fieldLabel || 'Change'}
                  action={display.action || 'modify'}
                  oldValue={display.oldValue}
                  newValue={display.newValue}
                />
              </div>
            )
          })() : (
            <ProfileImageUpload
              fileRef={form.profile_image_ref}
              entityType="knowledge"
              entityColour={form.colour}
              onChange={(fileRef) => patch({ profile_image_ref: fileRef })}
            />
          )}

          <div data-help-region="knowledge-modal:name">
            <label className="block text-xs text-zinc-400 mb-1">Name</label>
            <input
              autoFocus
              value={form.name}
              onChange={(e) => patch({ name: e.target.value })}
              onKeyDown={(e) => { e.stopPropagation() }}
              placeholder="Knowledge name..."
              className="w-full bg-zinc-700 text-sm text-zinc-100 px-3 py-2 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
            />
          </div>

          <div data-help-region="knowledge-modal:colour">
            <label className="block text-xs text-zinc-400 mb-1">Colour</label>
            <div className="flex items-center gap-3">
              <button
                type="button"
                ref={colourAnchorRef}
                onClick={() => setColourPickerOpen((o) => !o)}
                className="w-10 h-8 rounded border border-zinc-600 cursor-pointer flex-shrink-0"
                style={{ background: form.colour }}
                aria-label={`Colour: ${form.colour}. Click to open picker.`}
              />
              <EntityColorPicker
                value={form.colour}
                onChange={(hex) => patch({ colour: hex })}
                anchorEl={colourAnchorRef.current}
                isOpen={colourPickerOpen}
                onClose={() => setColourPickerOpen(false)}
              />
              <input
                value={form.colour}
                onChange={(e) => patch({ colour: e.target.value })}
                maxLength={7}
                placeholder="#888888"
                className="flex-1 bg-zinc-700 text-sm text-zinc-100 px-3 py-2 rounded border border-zinc-600 focus:outline-none focus:border-accent-500 font-mono"
              />
            </div>
          </div>

          <div data-help-region="knowledge-modal:description">
            <label className="block text-xs text-zinc-400 mb-1">Description</label>
            <textarea
              value={form.description}
              onChange={(e) => patch({ description: e.target.value })}
              placeholder="Brief description..."
              rows={3}
              className="w-full bg-zinc-700 text-sm text-zinc-100 px-3 py-2 rounded border border-zinc-600 focus:outline-none focus:border-accent-500 resize-none"
            />
          </div>

          <div data-help-region="knowledge-modal:awareness" className="space-y-2">
            <AwarenessPicker
              value={form.awareness}
              onChange={(next) => patch({ awareness: next })}
              surface="knowledge"
              scale={form.awareness_scale === 'binary' ? SCALE_BINARY : SCALE_ALIAS}
              parentEntityId={null}
              context={{ parentName: form.name?.trim() || 'this knowledge' }}
            />
            {/* Phase 1.21c — precision toggle. Only visible when tracking
                is on (form.awareness != null). The 4-level "full" scale
                tracks "knows it exists / knows the name / knows it's a
                pseudonym / knows the linkage" gradations; the 2-level
                "binary" scale collapses to plain aware / unaware for
                simpler secrets. Default: full. */}
            {form.awareness != null && (
              <div data-help-region="knowledge-modal:precision" className="flex items-center gap-2 text-[11px] pl-1">
                <span className="text-zinc-400">Precision:</span>
                <div className="inline-flex rounded border border-zinc-700 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => patch({ awareness_scale: 'full' })}
                    className={`px-2.5 py-1 transition ${
                      form.awareness_scale === 'full'
                        ? 'bg-accent-500/30 text-accent-300'
                        : 'text-zinc-400 hover:bg-zinc-800'
                    }`}
                  >Full (4 levels)</button>
                  <button
                    type="button"
                    onClick={() => patch({ awareness_scale: 'binary' })}
                    className={`px-2.5 py-1 transition border-l border-zinc-700 ${
                      form.awareness_scale === 'binary'
                        ? 'bg-accent-500/30 text-accent-300'
                        : 'text-zinc-400 hover:bg-zinc-800'
                    }`}
                  >Binary (2 levels)</button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-zinc-700 flex-shrink-0">
          <button
            onClick={closeKnowledgeModal}
            className="px-4 py-1.5 text-sm text-zinc-300 hover:text-zinc-100"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={saving}
            className="px-4 py-1.5 text-sm bg-accent-700 hover:bg-accent-600 text-white rounded disabled:opacity-50"
          >
            {saving ? 'Creating...' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}
