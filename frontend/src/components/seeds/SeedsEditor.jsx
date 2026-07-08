/**
 * Shared seeds editor. Renders two sections:
 *
 *   1. Attribute stubs — five per-type lists (Character / Location /
 *      Item / Faction / Custom). Each stub: name, attribute_type,
 *      default_value (text + preset types only), and preset_list_name
 *      (preset type only).
 *
 *   2. Bundled preset lists — a list of `{name, values}` pairs that
 *      travel with the seeds file (for export portability + for
 *      Default Seeds where there is no project preset-list pool).
 *
 * Controlled component. Parent owns the draft state; this editor only
 * proposes updates via `onChange(nextSeeds)`. Save / Revert / server
 * plumbing is a parent concern so this component can mount cleanly in
 * both the Story Seeds tab (saves via PUT /project/seeds) and the
 * Default Seeds tab (saves via the default-seeds endpoints — lands in
 * a later commit).
 *
 * Preset-list picker for preset-type stubs shows the union of
 * `projectPresetLists` (by name) and any bundled preset lists inside
 * `value.preset_lists`. Deduplicated by name. Stubs whose
 * `preset_list_name` doesn't resolve against either source are flagged
 * as orphan with a visual cue — they still save, they just won't
 * resolve at entity-creation time until the matching preset list
 * exists somewhere the runtime can see it.
 */
import { useMemo, useState } from 'react'

// Knowledge is intentionally NOT in this list. Knowledge is a first-
// class object type with a fixed schema (name / description / colour /
// profile_image / notes / awareness / source_event / history) and does
// NOT carry user-defined attributes — so it can't take attribute-stub
// seeds. The `SeedsByType.knowledge` schema field is vestigial; it
// stays in the model for save-format compatibility but no UI or apply
// path consumes it.
const ENTITY_TYPES = [
  { key: 'character', label: 'Characters' },
  { key: 'location',  label: 'Locations' },
  { key: 'item',      label: 'Items' },
  { key: 'faction',   label: 'Factions' },
  { key: 'custom',    label: 'Custom' },
]

// User-facing labels for attribute types on stub rows. MUST match the
// labels used in the Attributes panel elsewhere in the app so the two
// UIs feel like the same concept: "Text", "Preset", "Media", "Text
// List", "Entity List".
const ATTRIBUTE_TYPES = [
  { value: 'text',        label: 'Text' },
  { value: 'preset',      label: 'Preset' },
  { value: 'file',        label: 'Media' },
  { value: 'text_list',   label: 'Text List' },
  { value: 'entity_list', label: 'Entity List' },
]


export default function SeedsEditor({ value, onChange, projectPresetLists = [] }) {
  // Union of available preset-list names: project + bundled, name-deduped.
  // Project list wins on name collision (the runtime resolves against
  // `story.preset_lists` first anyway).
  const availableNames = useMemo(() => {
    const names = new Set()
    for (const pl of projectPresetLists) if (pl?.name) names.add(pl.name)
    for (const pl of value?.preset_lists || []) if (pl?.name) names.add(pl.name)
    return Array.from(names).sort((a, b) => a.localeCompare(b))
  }, [projectPresetLists, value?.preset_lists])

  // Map of preset-list name → its values array, sourced from project +
  // bundled lists (project wins on name collision). Used by the preset
  // default-value dropdown — which can only show values if we know the
  // picked list's contents.
  const presetValuesByName = useMemo(() => {
    const m = new Map()
    for (const pl of value?.preset_lists || []) if (pl?.name) m.set(pl.name, pl.values || [])
    for (const pl of projectPresetLists) if (pl?.name) m.set(pl.name, pl.values || [])
    return m
  }, [projectPresetLists, value?.preset_lists])

  function patchSeeds(patch) {
    onChange({ ...value, seeds: { ...value.seeds, ...patch } })
  }

  function addStub(typeKey) {
    const current = value.seeds?.[typeKey] || []
    patchSeeds({
      [typeKey]: [
        ...current,
        { name: '', attribute_type: 'text', default_value: null, preset_list_name: null },
      ],
    })
  }

  function updateStub(typeKey, index, patch) {
    const current = value.seeds?.[typeKey] || []
    patchSeeds({
      [typeKey]: current.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    })
  }

  function removeStub(typeKey, index) {
    const current = value.seeds?.[typeKey] || []
    patchSeeds({ [typeKey]: current.filter((_, i) => i !== index) })
  }

  function setBundledPresetLists(next) {
    onChange({ ...value, preset_lists: next })
  }

  return (
    <div data-help-region="seeds-editor:editor" className="space-y-6">
      {/* ── Attribute stubs ─────────────────────────────────────────── */}
      <section data-help-region="seeds-editor:default_attributes">
        <SectionHeader title="Default Attributes" subtitle="Every new entity of the matching type will be created with these attributes pre-populated." />
        <div className="space-y-3">
          {ENTITY_TYPES.map((t) => (
            <TypeGroup
              key={t.key}
              typeKey={t.key}
              label={t.label}
              stubs={value.seeds?.[t.key] || []}
              availablePresetNames={availableNames}
              presetValuesByName={presetValuesByName}
              onAdd={() => addStub(t.key)}
              onUpdate={(i, patch) => updateStub(t.key, i, patch)}
              onRemove={(i) => removeStub(t.key, i)}
            />
          ))}
        </div>
      </section>

      {/* ── Bundled preset lists ────────────────────────────────────── */}
      <section data-help-region="seeds-editor:bundled_preset_lists">
        <SectionHeader
          title="Bundled Preset Lists"
          subtitle="Preset lists saved alongside the seeds. Any preset-type default attribute can reference a list here by name, even if the list doesn&apos;t exist elsewhere in the project yet."
        />
        <BundledPresetListsEditor
          lists={value.preset_lists || []}
          onChange={setBundledPresetLists}
        />
      </section>
    </div>
  )
}


function SectionHeader({ title, subtitle }) {
  return (
    <div className="mb-2">
      <div className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">{title}</div>
      {subtitle && <div className="text-[11px] text-zinc-500 mt-0.5">{subtitle}</div>}
    </div>
  )
}


function TypeGroup({ label, stubs, availablePresetNames, presetValuesByName, onAdd, onUpdate, onRemove }) {
  return (
    <div data-help-region="seeds-editor:type_group" className="bg-zinc-900/30 rounded border border-zinc-800 p-2">
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-xs font-semibold text-zinc-300">{label}</div>
        <button
          type="button"
          data-help-region="seeds-editor:add_stub"
          onClick={onAdd}
          className="text-xs text-accent-400 hover:text-accent-300 px-1.5 py-0.5"
          title={`Add a new default attribute for ${label}`}
        >
          + Add
        </button>
      </div>
      {stubs.length === 0 ? (
        <div className="text-[11px] text-zinc-600 italic px-1 py-1">No default attributes yet.</div>
      ) : (
        <div className="space-y-1.5">
          {stubs.map((stub, i) => (
            <StubRow
              key={i}
              stub={stub}
              availablePresetNames={availablePresetNames}
              presetValuesByName={presetValuesByName}
              onChange={(patch) => onUpdate(i, patch)}
              onRemove={() => onRemove(i)}
            />
          ))}
        </div>
      )}
    </div>
  )
}


function StubRow({ stub, availablePresetNames, presetValuesByName, onChange, onRemove }) {
  const inputCls =
    'bg-zinc-700 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500'

  const isPreset = stub.attribute_type === 'preset'

  // Type column first: users pick the kind of attribute they're
  // seeding, then (for non-preset types) give it a name, then configure
  // its value. Preset stubs don't have their own name — they use the
  // preset list's name, so column 2 is the preset-list picker and
  // picking a list auto-syncs `stub.name` alongside `preset_list_name`.
  function handleTypeChange(next) {
    // Always clear `default_value` on any type change. Different types
    // serialise defaults differently (plain string for text, JSON-array
    // string for text_list, one-of-list-values for preset), so
    // preserving a stale value would surface a garbage value in the
    // new input.
    const patch = { attribute_type: next, default_value: null }
    if (next !== 'preset') patch.preset_list_name = null
    onChange(patch)
  }

  // When a preset stub picks a different list, sync the stub's name
  // alongside preset_list_name (Attributes panel convention: preset
  // attributes derive their name from the preset list) and reset the
  // default value (the old default isn't valid in the new list).
  function handlePresetListPick(newName) {
    onChange({
      preset_list_name: newName || null,
      name: newName || '',
      default_value: null,
    })
  }

  return (
    <div data-help-region="seeds-editor:stub_row" className="flex gap-1.5 items-start">
      <select
        value={stub.attribute_type}
        onChange={(e) => handleTypeChange(e.target.value)}
        className={`${inputCls} flex-shrink-0 w-24 appearance-none`}
      >
        {ATTRIBUTE_TYPES.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>

      {isPreset ? (
        <PresetListNameSelect
          value={stub.preset_list_name || ''}
          availableNames={availablePresetNames}
          onChange={handlePresetListPick}
          inputCls={inputCls}
        />
      ) : (
        <input
          value={stub.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="Attribute name"
          className={`${inputCls} flex-1 min-w-0`}
        />
      )}

      <ValueConfig
        stub={stub}
        presetValuesByName={presetValuesByName}
        onChange={onChange}
        inputCls={inputCls}
      />

      <button
        type="button"
        onClick={onRemove}
        className="text-zinc-500 hover:text-red-400 text-xs px-1.5 py-1"
        title="Remove this attribute"
      >
        ×
      </button>
    </div>
  )
}


// Picker for a preset stub's preset-list-name + stub-name (the two are
// kept in sync). Flags orphan references (saved name isn't in the
// available set) with an amber border + "(not found)" option so the
// user can heal by re-picking.
function PresetListNameSelect({ value, availableNames, onChange, inputCls }) {
  const orphan = !!value && !availableNames.includes(value)
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`${inputCls} flex-1 min-w-0 appearance-none ${
        orphan ? 'border-amber-500 text-amber-300' : ''
      }`}
      title={orphan ? 'No preset list with this name exists in the project or bundled here' : ''}
    >
      <option value="">— pick a preset list —</option>
      {orphan && <option value={value}>{value} (not found)</option>}
      {availableNames.map((n) => (
        <option key={n} value={n}>{n}</option>
      ))}
    </select>
  )
}


// Per-attribute-type optional default-value column. Every type that
// has a default-value notion gets its own editor shape:
//
//   text       → plain text input
//   preset     → dropdown of the picked list's values (one of them, or
//                none); empty if no list is picked yet
//   text_list  → tag-chip editor serialising to a JSON-array string
//   media      → nothing (no plain-text default for a file)
//   entity_list→ nothing (entity references need UUIDs; skipped v1)
function ValueConfig({ stub, presetValuesByName, onChange, inputCls }) {
  if (stub.attribute_type === 'text') {
    return (
      <input
        value={stub.default_value ?? ''}
        onChange={(e) => onChange({ default_value: e.target.value === '' ? null : e.target.value })}
        placeholder="Default value (optional)"
        className={`${inputCls} flex-shrink-0 w-48`}
      />
    )
  }

  if (stub.attribute_type === 'preset') {
    const listName = stub.preset_list_name || ''
    const values = listName ? (presetValuesByName.get(listName) || []) : []
    const current = stub.default_value ?? ''
    // Orphan if we picked a list AND we set a default AND that default
    // isn't one of the list's current values (e.g. list was edited).
    const orphan = !!listName && !!current && !values.includes(current)
    return (
      <select
        value={current}
        onChange={(e) => onChange({ default_value: e.target.value === '' ? null : e.target.value })}
        disabled={!listName}
        className={`${inputCls} flex-shrink-0 w-40 appearance-none ${
          orphan ? 'border-amber-500 text-amber-300' : ''
        } disabled:opacity-50 disabled:cursor-not-allowed`}
        title={
          !listName
            ? 'Pick a preset list first'
            : orphan
              ? 'This default value is not in the picked preset list'
              : ''
        }
      >
        <option value="">— default (optional) —</option>
        {orphan && <option value={current}>{current} (not in list)</option>}
        {values.map((v) => (
          <option key={v} value={v}>{v}</option>
        ))}
      </select>
    )
  }

  if (stub.attribute_type === 'text_list') {
    return <TextListDefaultEditor stub={stub} onChange={onChange} />
  }

  // file / entity_list — no value config in v1.
  return null
}


// Tag-style editor for text_list default values. The underlying
// `stub.default_value` is a JSON-encoded array string (matching how
// Attribute.value is stored for text_list attributes at runtime).
// Null / empty default = empty list. Each commit round-trips through
// JSON so the stored shape stays consistent with the runtime reader.
function TextListDefaultEditor({ stub, onChange }) {
  const values = parseTextListDefault(stub.default_value)
  const [input, setInput] = useState('')

  function commit(next) {
    onChange({ default_value: serializeTextListDefault(next) })
  }
  function addValue() {
    const v = input.trim()
    if (!v || values.includes(v)) {
      setInput('')
      return
    }
    commit([...values, v])
    setInput('')
  }
  function removeValue(v) {
    commit(values.filter((x) => x !== v))
  }

  return (
    <div className="flex flex-col gap-1 w-64 flex-shrink-0">
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {values.map((v) => (
            <span key={v} className="inline-flex items-center gap-0.5 bg-zinc-600 text-zinc-200 text-[11px] rounded px-1.5 py-0.5">
              {v}
              <button
                type="button"
                onClick={() => removeValue(v)}
                className="text-zinc-400 hover:text-red-400 leading-none ml-0.5 font-bold"
              >−</button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-1">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addValue() } }}
          placeholder="Default values (press Enter)"
          className="flex-1 bg-zinc-700 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
        />
        <button
          type="button"
          onClick={addValue}
          className="text-xs bg-zinc-600 hover:bg-zinc-500 text-zinc-200 rounded px-2 py-1"
        >+</button>
      </div>
    </div>
  )
}

function parseTextListDefault(raw) {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : []
  } catch {
    return []
  }
}

function serializeTextListDefault(list) {
  return list.length === 0 ? null : JSON.stringify(list)
}


function BundledPresetListsEditor({ lists, onChange }) {
  const [showAdd, setShowAdd]   = useState(false)
  const [addName, setAddName]   = useState('')
  const [addValues, setAddValues] = useState([])
  const [addInput, setAddInput] = useState('')
  const [editingIndex, setEditingIndex] = useState(null)
  const [editName, setEditName] = useState('')
  const [editValues, setEditValues] = useState([])
  const [editInput, setEditInput] = useState('')

  function startEdit(i) {
    setEditingIndex(i)
    setEditName(lists[i].name)
    setEditValues([...(lists[i].values || [])])
    setEditInput('')
  }

  function commitEdit() {
    if (!editName.trim()) return
    onChange(lists.map((pl, i) =>
      i === editingIndex ? { name: editName.trim(), values: editValues } : pl
    ))
    setEditingIndex(null)
  }

  function handleAdd() {
    if (!addName.trim()) return
    onChange([...lists, { name: addName.trim(), values: addValues }])
    setAddName('')
    setAddValues([])
    setAddInput('')
    setShowAdd(false)
  }

  function removeList(i) {
    onChange(lists.filter((_, idx) => idx !== i))
  }

  function commitValue(values, setValues, input, setInput) {
    const v = input.trim()
    if (!v || values.includes(v)) {
      setInput('')
      return
    }
    setValues([...values, v])
    setInput('')
  }

  function renderValueEditor(values, setValues, valueInput, setValueInput) {
    return (
      <div className="space-y-1">
        {values.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {values.map((v) => (
              <span key={v} className="inline-flex items-center gap-0.5 bg-zinc-600 text-zinc-200 text-xs rounded px-1.5 py-0.5">
                {v}
                <button
                  type="button"
                  onClick={() => setValues(values.filter((x) => x !== v))}
                  className="text-zinc-400 hover:text-red-400 leading-none ml-0.5 font-bold"
                >−</button>
              </span>
            ))}
          </div>
        )}
        <div className="flex gap-1">
          <input
            value={valueInput}
            onChange={(e) => setValueInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitValue(values, setValues, valueInput, setValueInput)
              }
            }}
            placeholder="Add value, press Enter…"
            className="flex-1 bg-zinc-700 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
          />
          <button
            type="button"
            onClick={() => commitValue(values, setValues, valueInput, setValueInput)}
            className="text-xs bg-zinc-600 hover:bg-zinc-500 text-zinc-200 rounded px-2 py-1"
          >+</button>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-zinc-900/30 rounded border border-zinc-800 p-2 space-y-2">
      <button
        type="button"
        data-help-region="seeds-editor:add_bundled_preset_list"
        onClick={() => setShowAdd((v) => !v)}
        className="w-full text-xs text-accent-400 hover:text-accent-300 text-left px-1 py-1"
      >
        {showAdd ? '× Cancel' : '+ New Preset List'}
      </button>

      {showAdd && (
        <div className="bg-zinc-700/40 rounded p-2 space-y-1.5">
          {/* Name + Save row first. Keeping Save inline with the name
              means it stays visible no matter how many tag chips the
              user adds below — the previous full-width Save button at
              the bottom of the form got pushed off-screen once enough
              values were entered. */}
          <div className="flex gap-1">
            <input
              autoFocus
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              placeholder="List name (e.g. Species)"
              className="flex-1 bg-zinc-700 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
            />
            <button
              onClick={handleAdd}
              className="text-xs bg-accent-700 hover:bg-accent-600 text-white rounded px-3 py-1 flex-shrink-0"
            >
              Save List
            </button>
          </div>
          {renderValueEditor(addValues, setAddValues, addInput, setAddInput)}
        </div>
      )}

      {lists.length === 0 && !showAdd && (
        <p className="text-[11px] text-zinc-600 italic px-1">No bundled preset lists.</p>
      )}

      {lists.map((pl, i) => (
        <div key={i} data-help-region="seeds-editor:bundled_preset_list_row" className="bg-zinc-700/30 rounded p-2">
          {editingIndex === i ? (
            <div className="space-y-1.5">
              {/* Name + Save/Cancel inline on the top row so they stay
                  visible regardless of how many tag chips the user has
                  added. */}
              <div className="flex gap-1">
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="flex-1 bg-zinc-700 text-xs text-zinc-100 px-2 py-1 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
                />
                <button
                  onClick={() => setEditingIndex(null)}
                  className="text-xs text-zinc-400 hover:text-zinc-200 px-2 py-1 flex-shrink-0"
                >
                  Cancel
                </button>
                <button
                  onClick={commitEdit}
                  className="text-xs bg-accent-700 hover:bg-accent-600 text-white rounded px-3 py-1 flex-shrink-0"
                >
                  Save
                </button>
              </div>
              {renderValueEditor(editValues, setEditValues, editInput, setEditInput)}
            </div>
          ) : (
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold text-zinc-200 truncate">{pl.name || '(unnamed)'}</div>
                <div className="text-[11px] text-zinc-500 truncate">
                  {pl.values?.length
                    ? pl.values.join(' · ')
                    : 'No values yet.'}
                </div>
              </div>
              <div className="flex gap-1 flex-shrink-0">
                <button
                  onClick={() => startEdit(i)}
                  className="text-[11px] text-zinc-400 hover:text-zinc-200 px-1.5 py-0.5"
                >
                  Edit
                </button>
                <button
                  onClick={() => removeList(i)}
                  className="text-[11px] text-zinc-500 hover:text-red-400 px-1.5 py-0.5"
                >
                  Remove
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
