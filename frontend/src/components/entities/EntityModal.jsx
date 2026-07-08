import { useState, useEffect, useRef, useMemo } from 'react'
import { useEntitiesStore } from '../../store/entitiesStore'
import { useUiStore } from '../../store/uiStore'
import { useProjectStore } from '../../store/projectStore'
import ProfileImageUpload from './ProfileImageUpload'
import { ATTR_TYPE_LABELS, emptyAttr, TYPE_ICONS } from '../../utils/entityHelpers'
import IntensitySlider from '../ui/IntensitySlider'
import { AttrTypeTag, FileAttrPreview, FileAttrInput } from './SharedEntityComponents'
import EntityColorPicker from '../ui/EntityColorPicker'
import PresetListPicker from '../ui/PresetListPicker'
import EntityPickerPopover from './EntityPickerPopover'
import ImageHoverPreview from '../ui/ImageHoverPreview'
import AwarenessPicker from './AwarenessPicker'

// Phase 1.21c: `knowledge` removed. Knowledge is no longer an Entity
// subtype — it has its own `Knowledge` Pydantic class, `/api/knowledges/`
// router, and library creation flow via `projectStore.createKnowledge`.
// EntityModal is for Entity subtypes only.
const ENTITY_TYPES = ['character', 'location', 'item', 'faction', 'custom']
const ATTR_TYPES = ['text', 'file', 'preset', 'text_list', 'entity_list', 'number', 'circumstance', 'motivator']

function parseListValue(val) {
  try { return JSON.parse(val || '[]') } catch { return [] }
}

// ── Inline item editor for text_list attributes ─────────────────────────────

function TextListRow({ attr, onChange, readOnly }) {
  const [inputVal, setInputVal] = useState('')
  const items = parseListValue(attr.value)

  function addItem() {
    const trimmed = inputVal.trim()
    if (!trimmed || items.includes(trimmed)) return
    onChange({ ...attr, value: JSON.stringify([...items, trimmed]) })
    setInputVal('')
  }

  return (
    <div className="mt-1 space-y-1">
      <div className="flex flex-wrap gap-1">
        {items.map((item, i) => (
          <span key={i} className="inline-flex items-center gap-0.5 bg-zinc-700 text-zinc-300 rounded px-1.5 py-0.5 text-xs">
            {item}
            {!readOnly && (
              <button
                onClick={() => onChange({ ...attr, value: JSON.stringify(items.filter((_, j) => j !== i)) })}
                className="text-zinc-500 hover:text-red-400 ml-0.5 leading-none"
              >×</button>
            )}
          </span>
        ))}
        {items.length === 0 && <em className="text-xs text-zinc-600">{readOnly ? 'Empty.' : 'No items yet.'}</em>}
      </div>
      {!readOnly && (
        <div className="flex gap-1">
          <input
            value={inputVal}
            onChange={e => setInputVal(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addItem() } }}
            placeholder="Add item…"
            className="flex-1 bg-zinc-800 text-xs text-zinc-200 px-2 py-0.5 rounded border border-zinc-700 focus:outline-none focus:border-accent-500"
          />
          <button onClick={addItem} className="text-xs text-accent-400 hover:text-accent-300 px-1">+</button>
        </div>
      )}
    </div>
  )
}

// ── Inline entity picker for entity_list attributes ──────────────────────────

function EntityListRow({ attr, onChange, readOnly }) {
  const [showPicker, setShowPicker] = useState(false)
  const characters  = useEntitiesStore(s => s.characters)
  const locations_  = useEntitiesStore(s => s.locations)
  const items_      = useEntitiesStore(s => s.items)
  const factions_   = useEntitiesStore(s => s.factions)
  const customs_    = useEntitiesStore(s => s.customs)
  const knowledges_ = useProjectStore(s => s.knowledges)
  const allEntities = useMemo(
    () => [...characters, ...locations_, ...items_, ...factions_, ...customs_, ...(knowledges_ || [])],
    [characters, locations_, items_, factions_, customs_, knowledges_]
  )
  const entityIds = parseListValue(attr.value)

  function addEntity(id) {
    if (entityIds.includes(id)) return
    onChange({ ...attr, value: JSON.stringify([...entityIds, id]) })
  }

  function removeEntity(id) {
    onChange({ ...attr, value: JSON.stringify(entityIds.filter(eid => eid !== id)) })
  }

  return (
    <div className="mt-1 space-y-1">
      <div className="flex flex-wrap gap-1">
        {entityIds.map(id => {
          const entity = allEntities.find(e => e.id === id)
          if (!entity) return null
          const colour = entity.colour || '#888888'
          const assetName = entity.profile_image_ref ? entity.profile_image_ref.split('/').pop() : null
          return (
            <span
              key={id}
              className="inline-flex items-center gap-1 rounded px-1 py-0.5 border border-zinc-700 bg-zinc-800/50"
            >
              <ImageHoverPreview src={assetName ? `/api/project/assets/${assetName}` : null} borderColour={colour} size={80}>
                {assetName ? (
                  <img
                    src={`/api/project/assets/${assetName}`}
                    alt=""
                    className="rounded-sm object-cover flex-shrink-0"
                    style={{ width: 16, height: 16, border: `1.5px solid ${colour}` }}
                  />
                ) : (
                  <span
                    className="rounded-sm flex items-center justify-center flex-shrink-0 text-[9px]"
                    style={{ width: 16, height: 16, backgroundColor: colour + '22', border: `1.5px solid ${colour}` }}
                  >
                    {TYPE_ICONS[entity.type] || '?'}
                  </span>
                )}
              </ImageHoverPreview>
              <span className="text-[10px] truncate max-w-[120px]" style={{ color: colour }}>
                {entity.name}
              </span>
              {!readOnly && (
                <button
                  onClick={() => removeEntity(id)}
                  className="text-zinc-500 hover:text-red-400 leading-none ml-0.5"
                  title="Remove from list"
                >×</button>
              )}
            </span>
          )
        })}
        {entityIds.length === 0 && <em className="text-xs text-zinc-600">{readOnly ? 'Empty.' : 'No entities yet.'}</em>}
      </div>
      {!readOnly && !showPicker && (
        <button onClick={() => setShowPicker(true)} className="text-xs text-accent-400 hover:text-accent-300">+ Add Entity</button>
      )}
      {!readOnly && showPicker && (
        <EntityPickerPopover
          allEntities={allEntities}
          excludeIds={new Set(entityIds)}
          onPick={addEntity}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  )
}

// ── Attribute Editor / Viewer ────────────────────────────────────────────────
// readOnly=true  → view-only list; no add/edit/remove controls
// readOnly=false → full editor (create mode only)

function AttributeEditor({ attributes, onChange, presetLists, readOnly }) {
  // `addingInSection` is which of the three sections (attributes /
  // circumstances / motivators) has the add-form open. `null` = closed.
  // The single add-form state (`addForm`) is reused; what changes per
  // section is the form's initial `attribute_type` and where it renders
  // in the JSX tree.
  const [addingInSection, setAddingInSection] = useState(null)
  const showAddForm = addingInSection !== null
  const [editingId, setEditingId] = useState(null)
  const [addForm, setAddForm] = useState(() => emptyAttr())
  const [editForm, setEditForm] = useState(null)
  const [attrNameError, setAttrNameError] = useState(null)  // null | 'blank' | 'duplicate'
  function openAddForm(sectionId, initialType) {
    setAddingInSection(sectionId)
    setAddForm({ ...emptyAttr(), attribute_type: initialType })
    setAttrNameError(null)
  }
  function closeAddForm() {
    setAddingInSection(null)
    setAddForm(emptyAttr())
    setAttrNameError(null)
  }
  const addValueInputRef    = useRef(null)  // text type: add-form Enter in name → focus value
  const addFileUploadTrigger = useRef(null) // file type: add-form Enter in name → open picker
  // Preset list picker: one per context (add / edit); only one open at a time.
  const [addPickerOpen,  setAddPickerOpen]  = useState(false)
  const [editPickerOpen, setEditPickerOpen] = useState(false)
  const addPresetAnchorRef  = useRef(null)
  const editPresetAnchorRef = useRef(null)

  function handlePresetListChange(listId, setForm) {
    const list = presetLists.find(p => p.id === listId) || null
    setForm(f => ({
      ...f,
      preset_list_id: listId || null,
      preset_list_name: list ? list.name : f.preset_list_name,
      name: list ? list.name : f.name,
      value: '',
    }))
  }

  // context: 'add' | 'edit'
  // In 'add' context, Enter in the name field follows type-aware tab flow (matching left sidebar).
  // In 'edit' context, Enter always triggers onEnter (save).
  function renderStructural(form, setForm, autoFocus, onEnter, context = 'add') {
    const isPreset    = form.attribute_type === 'preset'
    const isFile      = form.attribute_type === 'file'
    const isText      = form.attribute_type === 'text'
    const isList      = form.attribute_type === 'text_list' || form.attribute_type === 'entity_list'
    const isNumber    = form.attribute_type === 'number'
    const isCircumstance = form.attribute_type === 'circumstance'
    const isMotivator = form.attribute_type === 'motivator'
    const isCM        = isCircumstance || isMotivator
    const isAddCtx    = context === 'add'
    const selectedList = isPreset && form.preset_list_id
      ? presetLists.find(p => p.id === form.preset_list_id)
      : null

    return (
      <>
        {/* First row: for preset the list selector replaces the name field entirely */}
        <div className="flex gap-2">
          {isPreset ? (
            <>
              <button
                ref={context === 'add' ? addPresetAnchorRef : editPresetAnchorRef}
                type="button"
                onClick={() => context === 'add' ? setAddPickerOpen(true) : setEditPickerOpen(true)}
                className="flex-1 text-left bg-zinc-700 text-xs px-2 py-1 rounded border border-zinc-600 hover:border-accent-500 focus:outline-none truncate"
              >
                {selectedList
                  ? <span className="text-zinc-100">{selectedList.name}</span>
                  : <span className="text-zinc-500">— select list —</span>}
              </button>
              <PresetListPicker
                value={form.preset_list_id || null}
                onChange={(listId) => handlePresetListChange(listId, setForm)}
                anchorEl={context === 'add' ? addPresetAnchorRef.current : editPresetAnchorRef.current}
                isOpen={context === 'add' ? addPickerOpen : editPickerOpen}
                onClose={() => context === 'add' ? setAddPickerOpen(false) : setEditPickerOpen(false)}
              />
            </>
          ) : (
            <input
              autoFocus={autoFocus}
              value={form.name}
              onChange={e => { setForm(f => ({ ...f, name: e.target.value })); if (isAddCtx) setAttrNameError(null) }}
              onKeyDown={e => {
                if (e.key !== 'Enter') return
                e.preventDefault()
                // CM allows name OR description; let onEnter / addAttribute
                // arbitrate. Other types still need a name before advancing.
                if (!isCM && !form.name.trim()) { if (isAddCtx) setAttrNameError('blank'); return }
                if (isText && isAddCtx)  { addValueInputRef.current?.focus(); return }
                if (isFile && isAddCtx)  { addFileUploadTrigger.current?.(); return }
                if (onEnter) onEnter()
              }}
              placeholder={isCM ? 'Name (optional if a description is set)' : 'Attribute name'}
              className={`flex-1 bg-zinc-700 text-xs text-zinc-100 px-2 py-1.5 rounded border ${isAddCtx && attrNameError === 'blank' ? 'border-red-500' : 'border-zinc-600'} focus:outline-none focus:border-accent-500`}
            />
          )}
          {/* Hide the type dropdown when adding from the Circumstances /
              Motivators section — the section already pins the type and
              switching to e.g. Text would dump the entry into a different
              section, which is more confusing than useful. */}
          {!isCM && (
            <select
              value={form.attribute_type}
              onChange={e => setForm(f => ({ ...f, attribute_type: e.target.value, value: '', file_ref: null, preset_list_id: null, name: '' }))}
              className="bg-zinc-700 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none"
            >
              {ATTR_TYPES
                .filter(t => t !== 'circumstance' && t !== 'motivator')
                .map(t => <option key={t} value={t}>{ATTR_TYPE_LABELS[t]}</option>)}
            </select>
          )}
        </div>

        {/* Text: initial value input */}
        {isText && (
          <input
            ref={isAddCtx ? addValueInputRef : undefined}
            value={form.value || ''}
            onChange={e => setForm(f => ({ ...f, value: e.target.value }))}
            onKeyDown={e => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              if (!form.name.trim()) return
              if (onEnter) onEnter()
            }}
            placeholder="Initial value (optional)"
            className="w-full bg-zinc-700 text-xs text-zinc-100 px-2 py-1.5 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
          />
        )}

        {/* File: upload button (and preview if already set) */}
        {isFile && (
          <div className="flex items-center gap-2">
            {form.file_ref && <FileAttrPreview fileRef={form.file_ref} />}
            <FileAttrInput
              fileRef={form.file_ref}
              onChange={fileRef => setForm(f => ({ ...f, file_ref: fileRef }))}
              triggerRef={isAddCtx ? addFileUploadTrigger : undefined}
            />
          </div>
        )}

        {/* Preset: hint if no lists exist; value picker once a list is chosen */}
        {isPreset && presetLists.length === 0 && (
          <p className="text-xs text-zinc-500 italic">No preset lists yet — create one in the Preset Lists tab first.</p>
        )}
        {isPreset && selectedList && selectedList.values?.length > 0 && (
          <select
            value={form.value || ''}
            onChange={e => setForm(f => ({ ...f, value: e.target.value }))}
            onKeyDown={e => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              if (!form.preset_list_id || !form.value) return
              if (onEnter) onEnter()
            }}
            className="w-full bg-zinc-700 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none"
          >
            <option value="">— select value —</option>
            {selectedList.values.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        )}

        {/* List types: no value input needed — list starts empty, items added in the row view */}
        {isList && (
          <p className="text-xs text-zinc-500 italic">Items can be added after the attribute is created.</p>
        )}

        {/* Number: float input. Stored on `number_value` (the canonical
            Pydantic field); `value` stays empty for number attributes. */}
        {isNumber && (
          <input
            type="number"
            step="any"
            value={form.number_value ?? ''}
            onChange={e => {
              const raw = e.target.value
              if (raw === '') { setForm(f => ({ ...f, number_value: null })); return }
              const n = Number(raw)
              setForm(f => ({ ...f, number_value: Number.isFinite(n) ? n : null }))
            }}
            onKeyDown={e => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              if (!form.name.trim()) return
              if (onEnter) onEnter()
            }}
            placeholder="Number value"
            className="w-full bg-zinc-700 text-xs text-zinc-100 px-2 py-1.5 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
          />
        )}

        {/* Circumstance / Motivator: description + intensity. Name is
            shared with the top-row input. The `+ Add Circumstance` /
            `+ Add Motivator` flow in the Detail Panel sidebar accepts
            "name OR description" — same rule here. */}
        {isCM && (
          <>
            <textarea
              rows={3}
              value={form.description || ''}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Description (optional if a name is set)"
              className="w-full bg-zinc-700 text-xs text-zinc-100 px-2 py-1.5 rounded border border-zinc-600 focus:outline-none focus:border-accent-500 resize-y placeholder:italic placeholder:text-zinc-500"
            />
            <IntensitySlider
              level={form.intensity ?? null}
              onChange={v => setForm(f => ({ ...f, intensity: v }))}
              discBg="bg-zinc-800"
              scale={1.75}
            />
          </>
        )}
      </>
    )
  }

  function addAttribute() {
    const isCM = addForm.attribute_type === 'circumstance' || addForm.attribute_type === 'motivator'
    const isList = addForm.attribute_type === 'text_list' || addForm.attribute_type === 'entity_list'
    const isNumber = addForm.attribute_type === 'number'
    // CM accepts name OR description; every other type still requires a name.
    if (isCM) {
      const hasName = !!addForm.name.trim()
      const hasDesc = !!(addForm.description || '').trim()
      if (!hasName && !hasDesc) { setAttrNameError('blank'); return }
    } else if (!addForm.name.trim()) {
      setAttrNameError('blank'); return
    }
    // Duplicate-name guard only applies when there's a name. (Unnamed
    // circumstances and motivators can co-exist — they're disambiguated
    // by description / id.)
    const trimmedName = addForm.name.trim().toLowerCase()
    if (trimmedName) {
      const existingNames = new Set((attributes || []).map(a => (a.name || '').trim().toLowerCase()).filter(Boolean))
      if (existingNames.has(trimmedName)) { setAttrNameError('duplicate'); return }
    }
    setAttrNameError(null)
    let value = addForm.value
    if (isList) value = '[]'
    if (isNumber || isCM) value = ''
    const next = {
      ...addForm,
      name: addForm.name.trim(),
      value,
      // Strip irrelevant per-type fields so each attribute carries only
      // what its type uses. Keeps saves clean.
      number_value: isNumber ? addForm.number_value : null,
      description: isCM ? (addForm.description || '').trim() : '',
      intensity:   isCM ? (addForm.intensity ?? null) : null,
    }
    onChange([...attributes, next])
    closeAddForm()
  }

  function startEdit(attr) {
    let form = { ...attr }
    // Auto re-link orphaned preset when a list with the saved name exists again
    if (attr.attribute_type === 'preset' && attr.preset_list_id && attr.preset_list_name) {
      const listStillExists = presetLists.find(p => p.id === attr.preset_list_id)
      if (!listStillExists) {
        const matchByName = presetLists.find(p => p.name === attr.preset_list_name)
        if (matchByName) form = { ...form, preset_list_id: matchByName.id }
      }
    }
    setEditingId(attr.id)
    setEditForm(form)
  }

  function saveEdit() {
    if (!editForm?.name.trim()) return
    onChange(attributes.map(a => a.id === editingId ? editForm : a))
    setEditingId(null)
    setEditForm(null)
  }

  if (attributes.length === 0 && readOnly) {
    return <p className="text-xs text-zinc-500 italic">No attributes defined.</p>
  }

  // Sectioning mirrors the Detail Panel sidebar's Attributes tab (see
  // EntityDetailView.jsx ~line 1617):
  //   1. Attributes     — every type that isn't circumstance/motivator
  //   2. Circumstances  — attribute_type === 'circumstance'
  //   3. Motivators     — attribute_type === 'motivator'
  // Each section has its own list + `+ Add` button; the shared
  // add-form renders inline under the section the writer launched it
  // from, seeded with that section's attribute type.
  const SECTIONS = [
    { id: 'attributes',    title: 'Attributes',    initialType: 'text',         match: (t) => t !== 'circumstance' && t !== 'motivator', addLabel: '+ Add Attribute',    emptyLabel: 'No attributes yet.'    },
    { id: 'circumstances', title: 'Circumstances', initialType: 'circumstance', match: (t) => t === 'circumstance',                       addLabel: '+ Add Circumstance', emptyLabel: 'No circumstances yet.' },
    { id: 'motivators',    title: 'Motivators',    initialType: 'motivator',    match: (t) => t === 'motivator',                          addLabel: '+ Add Motivator',    emptyLabel: 'No motivators yet.'    },
  ]

  function renderAttrRow(attr) {
    return (
      <div key={attr.id} className="bg-zinc-700/40 rounded p-2">
        {!readOnly && editingId === attr.id && editForm ? (
          <div className="space-y-2">
            {renderStructural(editForm, setEditForm, true, saveEdit, 'edit')}
            <div className="flex gap-2">
              <button onClick={saveEdit} className="text-xs bg-accent-700 hover:bg-accent-600 text-white rounded px-3 py-1">Save</button>
              <button onClick={() => setEditingId(null)} className="text-xs text-zinc-400 hover:text-zinc-200">Cancel</button>
            </div>
          </div>
        ) : (
          <div className="flex items-start justify-between gap-2 group">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                {(attr.name || '').trim() ? (
                  <span className="text-xs text-zinc-300 font-medium">{attr.name}</span>
                ) : (
                  <em className="text-xs text-zinc-600">Unnamed</em>
                )}
                <AttrTypeTag
                  type={attr.attribute_type}
                  orphaned={attr.attribute_type === 'preset' && !!attr.preset_list_id && !presetLists.find(p => p.id === attr.preset_list_id)}
                />
              </div>
              {attr.attribute_type === 'preset' ? (
                <div className="text-xs text-zinc-400">
                  {attr.value || <em className="text-zinc-600">No value selected</em>}
                </div>
              ) : attr.attribute_type === 'file' ? (
                <div className="flex items-center gap-2 mt-0.5">
                  {attr.file_ref && <FileAttrPreview fileRef={attr.file_ref} />}
                  {!readOnly && <FileAttrInput fileRef={attr.file_ref} compact onChange={fileRef => onChange(attributes.map(a => a.id === attr.id ? { ...a, file_ref: fileRef } : a))} />}
                  {!attr.file_ref && readOnly && <span className="text-xs text-zinc-600 italic">No media.</span>}
                </div>
              ) : attr.attribute_type === 'text_list' ? (
                <TextListRow
                  attr={attr}
                  onChange={updated => onChange(attributes.map(a => a.id === attr.id ? updated : a))}
                  readOnly={readOnly}
                />
              ) : attr.attribute_type === 'entity_list' ? (
                <EntityListRow
                  attr={attr}
                  onChange={updated => onChange(attributes.map(a => a.id === attr.id ? updated : a))}
                  readOnly={readOnly}
                />
              ) : attr.attribute_type === 'number' ? (
                <div className="text-xs text-zinc-400">
                  {attr.number_value != null
                    ? String(attr.number_value)
                    : <em className="text-zinc-600">No value set.</em>}
                </div>
              ) : attr.attribute_type === 'circumstance' || attr.attribute_type === 'motivator' ? (
                <div className="text-xs text-zinc-400 space-y-0.5">
                  {(attr.description || '').trim() && (
                    <div className="italic">{attr.description}</div>
                  )}
                  {attr.intensity != null && (
                    <div className="text-[10px] text-zinc-500">Intensity: {attr.intensity}/4</div>
                  )}
                  {!((attr.description || '').trim()) && attr.intensity == null && (
                    <em className="text-zinc-600">No description or intensity set.</em>
                  )}
                </div>
              ) : (
                <div className="text-xs text-zinc-400">{attr.value || <em className="text-zinc-600">No value set.</em>}</div>
              )}
            </div>
            {!readOnly && (
              <div className="flex gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100">
                <button onClick={() => startEdit(attr)} className="text-zinc-500 hover:text-zinc-200 text-xs">✎</button>
                <button onClick={() => onChange(attributes.filter(a => a.id !== attr.id))} className="text-zinc-500 hover:text-red-400 text-xs">✕</button>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {SECTIONS.map((section, sectionIdx) => {
        const rows = attributes.filter(a => section.match(a.attribute_type))
        const isAddingHere = showAddForm && addingInSection === section.id
        return (
          <div key={section.id} className="space-y-2">
            {sectionIdx > 0 && <div className="border-t border-zinc-700" />}
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wider text-zinc-400">{section.title}</span>
              {!readOnly && !isAddingHere && (
                <button
                  onClick={() => openAddForm(section.id, section.initialType)}
                  className="text-xs text-accent-400 hover:text-accent-300"
                  disabled={showAddForm}
                >
                  {section.addLabel}
                </button>
              )}
            </div>
            {rows.length === 0 && !isAddingHere && (
              <p className="text-xs text-zinc-500 italic">{section.emptyLabel}</p>
            )}
            {rows.map(renderAttrRow)}
            {isAddingHere && (
              <div className="bg-zinc-700/40 rounded p-2 space-y-2">
                {renderStructural(addForm, setAddForm, true, addAttribute, 'add')}
                {attrNameError === 'duplicate' && (
                  <p className="text-[10px] text-red-400">An attribute with this name already exists.</p>
                )}
                <div className="flex gap-2">
                  <button onClick={addAttribute} className="text-xs bg-accent-700 hover:bg-accent-600 text-white rounded px-3 py-1">Add</button>
                  <button onClick={closeAddForm} className="text-xs text-zinc-400 hover:text-zinc-200">Cancel</button>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}


// ── Main EntityModal ────────────────────────────────────────────────────────────

const BLANK_FORM = {
  type: 'character', name: '', colour: '#888888', description: '',
  attributes: [], parent_id: null, category_id: null,
  profile_image_ref: null,
  awareness: null,
}

export default function EntityModal() {
  const entityModalOpen = useUiStore((s) => s.entityModalOpen)
  const entityModalEntityId = useUiStore((s) => s.entityModalEntityId)
  const entityModalInitialType = useUiStore((s) => s.entityModalInitialType)
  const entityModalPendingPosition = useUiStore((s) => s.entityModalPendingPosition)
  const closeEntityModal = useUiStore((s) => s.closeEntityModal)

  const locations = useEntitiesStore((s) => s.locations)
  const customs = useEntitiesStore((s) => s.customs)
  const customCategories = useEntitiesStore((s) => s.customCategories)
  const presetLists = useEntitiesStore((s) => s.presetLists)
  const createEntity = useEntitiesStore((s) => s.createEntity)
  const createCustomCategory = useEntitiesStore((s) => s.createCustomCategory)

  const addEntityNodeToCanvas   = useProjectStore((s) => s.addEntityNodeToCanvas)
  const createFactionMembership = useProjectStore((s) => s.createFactionMembership)

  // This modal is now create-only. Editing is done in the sidebar.
  const isNew = entityModalEntityId === null

  const [form, setForm] = useState(BLANK_FORM)
  const [activeTab, setActiveTab] = useState('details')
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [showNewCatForm, setShowNewCatForm] = useState(false)
  const [newCatName, setNewCatName] = useState('')
  const [newCatDesc, setNewCatDesc] = useState('')
  const [newCatColour, setNewCatColour] = useState('#888888')
  const formColourAnchorRef = useRef(null)
  const [formColourPickerOpen, setFormColourPickerOpen] = useState(false)
  const newCatColourAnchorRef = useRef(null)
  const [newCatColourPickerOpen, setNewCatColourPickerOpen] = useState(false)

  useEffect(() => {
    if (!entityModalOpen) return
    setForm({ ...BLANK_FORM, type: entityModalInitialType })
    setActiveTab('details')
    setError(null)
    setShowNewCatForm(false)
    setNewCatName('')
    setNewCatDesc('')
    setNewCatColour('#888888')
  }, [entityModalOpen, entityModalInitialType])

  // When a category is selected for a new Custom entity, pre-populate colour and profile image from category defaults.
  // The profile image only falls back to the category default when the user has NOT already picked one — selecting a
  // category must never wipe an image the user chose first (categories have no image-upload UI, so the category default
  // is almost always null; without this guard, choosing a category just cleared the user's picked image).
  // Must be before the early return below — hooks must be called unconditionally (Rules of Hooks).
  useEffect(() => {
    if (!entityModalOpen || !isNew || form.type !== 'custom' || !form.category_id) return
    const cat = customCategories.find(c => c.id === form.category_id)
    if (cat) setForm(f => ({ ...f, colour: cat.colour || '#888888', profile_image_ref: f.profile_image_ref ?? (cat.profile_image_ref || null) }))
  }, [entityModalOpen, isNew, form.type, form.category_id, customCategories])  

  // Only render for create-new mode; editing is handled in the sidebar
  if (!entityModalOpen || !isNew) return null

  const patch = (p) => setForm(f => ({ ...f, ...p }))

  // Compute auto-display name for Custom entities: "CategoryName #N"
  const sameCatCount = form.type === 'custom' ? customs.filter(c => c.category_id === form.category_id).length : 0
  const category = form.category_id ? customCategories.find(c => c.id === form.category_id) : null
  const customAutoName = category ? `${category.name} #${sameCatCount + 1}` : null

  async function handleCreate() {
    if (form.type === 'custom') {
      if (!form.category_id) { setError('A Custom Category is required.'); return }
    } else {
      if (!form.name.trim()) { setError('Name is required.'); return }
    }
    setSaving(true)
    try {
      // For custom entities, the writer-typed name in `form.name` wins.
      // Blank → fall back to the category-derived auto-name (e.g.
      // "Goblins #1") so the entity always has a non-empty display
      // label. The legacy `label` field has been retired (v0.2.12.18);
      // backend Pydantic validator lifts old saves' label into name on
      // load, and `name` is now the single source of truth.
      //
      // Colour: when the writer hasn't picked one (default #888888),
      // inherit the chosen category's colour at create time so the
      // new custom shares the category's visual identity by default.
      // Writer can still override either before create (via the
      // colour picker in the form) or after via the entity detail
      // panel; the inheritance only fires at the create boundary.
      let customColour = form.colour
      if (form.type === 'custom' && (form.colour === '#888888' || !form.colour)) {
        const pickedCategory = (customCategories || []).find((c) => c.id === form.category_id)
        if (pickedCategory?.colour) customColour = pickedCategory.colour
      }
      const entityData = form.type === 'custom'
        ? { ...form, colour: customColour, name: form.name?.trim() || customAutoName || 'Custom' }
        : form
      const result = await createEntity(entityData)
      if (result.entity.type === 'faction') {
        await createFactionMembership(result.entity.id, result.entity_node.id, result.entity.name)
      }
      addEntityNodeToCanvas(result.entity_node, entityModalPendingPosition || undefined, { createdEntity: result.entity })
      closeEntityModal()
    } catch {
      setError('Failed to create entity.')
    } finally {
      setSaving(false)
    }
  }

  async function handleCreateCategory() {
    if (!newCatName.trim()) return
    const cat = await createCustomCategory({ name: newCatName.trim(), description: newCatDesc.trim(), colour: newCatColour })
    if (cat) { patch({ category_id: cat.id }); setNewCatName(''); setNewCatDesc(''); setNewCatColour('#888888'); setShowNewCatForm(false) }
  }

  const tabs = [
    { key: 'details', label: 'Details' },
    { key: 'attributes', label: 'Attributes' },
  ]

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60">
      <div data-help-region="entity-modal:modal" className="bg-zinc-800 border border-zinc-600 rounded-lg shadow-2xl w-[480px] max-h-[85vh] flex flex-col">
        {/* Header */}
        <div data-help-region="entity-modal:header" className="flex items-center justify-between px-4 py-3 border-b border-zinc-700 flex-shrink-0">
          <h2 className="text-sm font-semibold text-zinc-100">
            {`New ${form.type.charAt(0).toUpperCase() + form.type.slice(1)}`}
          </h2>
          <button onClick={closeEntityModal} className="text-zinc-400 hover:text-zinc-200">✕</button>
        </div>

        {/* Tabs */}
        <div data-help-region="entity-modal:tabs" className="flex border-b border-zinc-700 px-4 flex-shrink-0">
          {tabs.map(tab => (
            <button key={tab.key} data-help-region={`entity-modal:tab_${tab.key}`} onClick={() => setActiveTab(tab.key)}
              className={`py-2 px-3 text-xs mr-1 ${activeTab === tab.key ? 'text-accent-400 border-b-2 border-accent-400' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div data-help-region="entity-modal:body" className="flex-1 overflow-y-auto p-4 space-y-4">
          {error && <div className="text-xs text-red-400 bg-red-900/30 border border-red-700/50 rounded px-3 py-2">{error}</div>}

          {/* ── Details Tab ─────────────────────────── */}
          {activeTab === 'details' && (
            <>
              <ProfileImageUpload
                fileRef={form.profile_image_ref}
                entityType={form.type}
                entityColour={form.colour}
                onChange={fileRef => patch({ profile_image_ref: fileRef })}
              />

              {form.type !== 'custom' && (
                <div data-help-region="entity-modal:name">
                  <label className="block text-xs text-zinc-400 mb-1">Name</label>
                  <input autoFocus value={form.name} onChange={e => patch({ name: e.target.value })}
                    onKeyDown={e => { e.stopPropagation() }}
                    placeholder="Entity name…"
                    className="w-full bg-zinc-700 text-sm text-zinc-100 px-3 py-2 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
                  />
                </div>
              )}
              {form.type === 'custom' && (
                <div data-help-region="entity-modal:name">
                  <label className="block text-xs text-zinc-400 mb-1">
                    Name <span className="text-zinc-600">(optional — defaults to category auto-name)</span>
                  </label>
                  <input value={form.name || ''} onChange={e => patch({ name: e.target.value })}
                    onKeyDown={e => { e.stopPropagation() }}
                    placeholder={customAutoName || 'e.g. Grugnak…'}
                    className="w-full bg-zinc-700 text-sm text-zinc-100 px-3 py-2 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
                  />
                  {customAutoName && (
                    <p className="mt-1 text-xs text-zinc-500">
                      Will be stored as: <span className="text-zinc-400">{form.name?.trim() || customAutoName}</span>
                    </p>
                  )}
                </div>
              )}

              <div data-help-region="entity-modal:type">
                <label className="block text-xs text-zinc-400 mb-1">Type</label>
                <select value={form.type}
                  onChange={e => patch({ type: e.target.value, parent_id: null, category_id: null })}
                  className="w-full bg-zinc-700 text-sm text-zinc-100 px-3 py-2 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
                >
                  {ENTITY_TYPES.map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
                </select>
              </div>

              <div data-help-region="entity-modal:colour">
                <label className="block text-xs text-zinc-400 mb-1">Colour</label>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    ref={formColourAnchorRef}
                    onClick={() => setFormColourPickerOpen((o) => !o)}
                    className="w-10 h-8 rounded border border-zinc-600 cursor-pointer flex-shrink-0"
                    style={{ background: form.colour }}
                    aria-label={`Colour: ${form.colour}. Click to open picker.`}
                  />
                  <EntityColorPicker
                    value={form.colour}
                    onChange={(hex) => patch({ colour: hex })}
                    anchorEl={formColourAnchorRef.current}
                    isOpen={formColourPickerOpen}
                    onClose={() => setFormColourPickerOpen(false)}
                  />
                  <input value={form.colour} onChange={e => patch({ colour: e.target.value })}
                    maxLength={7} placeholder="#888888"
                    className="flex-1 bg-zinc-700 text-sm text-zinc-100 px-3 py-2 rounded border border-zinc-600 focus:outline-none focus:border-accent-500 font-mono"
                  />
                </div>
              </div>

              <div data-help-region="entity-modal:description">
                <label className="block text-xs text-zinc-400 mb-1">Description</label>
                <textarea value={form.description} onChange={e => patch({ description: e.target.value })}
                  placeholder="Brief description…" rows={3}
                  className="w-full bg-zinc-700 text-sm text-zinc-100 px-3 py-2 rounded border border-zinc-600 focus:outline-none focus:border-accent-500 resize-none"
                />
              </div>

              {/* Custom: category */}
              {form.type === 'custom' && (
                <div data-help-region="entity-modal:custom_category">
                  <label className="block text-xs text-zinc-400 mb-1">Custom Category</label>
                  {!showNewCatForm ? (
                      <div className="flex gap-2">
                        <select value={form.category_id || ''} onChange={e => patch({ category_id: e.target.value || null })}
                          className="flex-1 bg-zinc-700 text-sm text-zinc-100 px-3 py-2 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
                        >
                          <option value="">— select category —</option>
                          {customCategories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                        <button type="button" onClick={() => setShowNewCatForm(true)} className="text-xs text-accent-400 hover:text-accent-300 whitespace-nowrap">+ New</button>
                      </div>
                    ) : (
                      <div className="space-y-2 bg-zinc-700/40 rounded p-2">
                        <input autoFocus value={newCatName} onChange={e => setNewCatName(e.target.value)} placeholder="Category name…"
                          className="w-full bg-zinc-700 text-xs text-zinc-100 px-2 py-1.5 rounded border border-zinc-600 focus:outline-none focus:border-accent-500" />
                        <input value={newCatDesc} onChange={e => setNewCatDesc(e.target.value)} placeholder="Description (optional)"
                          className="w-full bg-zinc-700 text-xs text-zinc-100 px-2 py-1.5 rounded border border-zinc-600 focus:outline-none focus:border-accent-500" />
                        <div className="flex items-center gap-2">
                          <label className="text-xs text-zinc-400 whitespace-nowrap">Default colour</label>
                          <button
                            type="button"
                            ref={newCatColourAnchorRef}
                            onClick={() => setNewCatColourPickerOpen((o) => !o)}
                            className="w-8 h-6 rounded border border-zinc-600 cursor-pointer flex-shrink-0"
                            style={{ background: newCatColour }}
                            aria-label={`Default colour: ${newCatColour}. Click to open picker.`}
                          />
                          <EntityColorPicker
                            value={newCatColour}
                            onChange={setNewCatColour}
                            anchorEl={newCatColourAnchorRef.current}
                            isOpen={newCatColourPickerOpen}
                            onClose={() => setNewCatColourPickerOpen(false)}
                          />
                          <input value={newCatColour} onChange={e => setNewCatColour(e.target.value)} maxLength={7}
                            className="flex-1 bg-zinc-700 text-xs text-zinc-100 px-2 py-1.5 rounded border border-zinc-600 focus:outline-none focus:border-accent-500 font-mono" />
                        </div>
                        <div className="flex gap-2">
                          <button onClick={handleCreateCategory} className="text-xs bg-accent-700 hover:bg-accent-600 text-white rounded px-3 py-1">Create & Select</button>
                          <button onClick={() => setShowNewCatForm(false)} className="text-xs text-zinc-400 hover:text-zinc-200">Cancel</button>
                        </div>
                      </div>
                    )
                  }
                </div>
              )}

              {/* Location: parent */}
              {form.type === 'location' && (
                <div data-help-region="entity-modal:parent_location">
                  <label className="block text-xs text-zinc-400 mb-1">Parent Location</label>
                  <select value={form.parent_id || ''} onChange={e => patch({ parent_id: e.target.value || null })}
                    className="w-full bg-zinc-700 text-sm text-zinc-100 px-3 py-2 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
                  >
                    <option value="">— none (top-level) —</option>
                    {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                </div>
              )}

              {/* Awareness (existence) — who knows this entity exists at the origin */}
              <div data-help-region="entity-modal:awareness">
                <AwarenessPicker
                  value={form.awareness}
                  onChange={(next) => patch({ awareness: next })}
                  surface="entity"
                  parentEntityId={null}
                  context={{
                    parentName:
                      form.name?.trim() ||
                      customAutoName ||
                      'this entity',
                  }}
                />
              </div>
            </>
          )}

          {/* ── Attributes Tab ───────────────────────── */}
          {activeTab === 'attributes' && (
            <div data-help-region="entity-modal:attribute_editor">
              <AttributeEditor
                attributes={form.attributes}
                onChange={attrs => patch({ attributes: attrs })}
                presetLists={presetLists}
                readOnly={false}
              />
            </div>
          )}

        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-zinc-700 flex-shrink-0">
          <button onClick={closeEntityModal} className="px-4 py-1.5 text-sm text-zinc-300 hover:text-zinc-100">Cancel</button>
          <button onClick={handleCreate} disabled={saving}
            className="px-4 py-1.5 text-sm bg-accent-700 hover:bg-accent-600 text-white rounded disabled:opacity-50"
          >
            {saving ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}
