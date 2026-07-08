import { useState, useMemo, useEffect, useRef } from 'react'
import { useEntitiesStore } from '../../store/entitiesStore'
import { useProjectStore } from '../../store/projectStore'
import { TYPE_ICONS } from '../../utils/entityHelpers'
import EntityColorPicker from './EntityColorPicker'

/**
 * Phase 8.4 (Convert To) — the context-aware convert configurator.
 *
 * Opened from the entity origin node's "Convert to →" menu. Shows only the
 * losses and behaviour forks relevant to THIS source→target pair, each with a
 * sensible default, so a user who doesn't care can just hit Convert. On confirm
 * it builds the `options` object and calls `onConvert(options)` (the caller
 * wires that to `projectStore.convertEntityType`).
 *
 * Handled here: leaving-character POV loss (warning), entering-custom category
 * (required pick-or-create), and leaving-location children (reparent-to-
 * grandparent / clear-to-top-level fork). Faction is not offered yet.
 *
 * Props:
 *   entityId, entityName, entityColour, sourceType, targetType
 *   onConvert(options)  — options: { categoryId?, locationChildren?: 'reparent'|'clear' }
 *   onClose()
 */
const TYPE_LABELS = {
  character: 'Character', location: 'Location', item: 'Item', faction: 'Faction', custom: 'Custom',
  knowledge: 'Knowledge',
}

export default function ConvertEntityDialog({
  entityId, entityName, entityColour = '#888888', sourceType, targetType, onConvert, onClose,
  sourceKind = 'entity', batch = false, batchCount = 1,
}) {
  const customCategories = useEntitiesStore((s) => s.customCategories) || []
  const createCustomCategory = useEntitiesStore((s) => s.createCustomCategory)
  const getEntityById = useEntitiesStore((s) => s.getEntityById)
  const locations = useEntitiesStore((s) => s.locations) || []
  const nodes = useProjectStore((s) => s.nodes)
  const story = useProjectStore((s) => s.story)
  const relationships = useProjectStore((s) => s.relationships) || []

  const backdropRef = useRef(null)

  const knowledges = useProjectStore((s) => s.knowledges) || []

  const fromKnowledge = sourceKind === 'knowledge'
  const leavingCharacter = sourceType === 'character'
  const leavingLocation = sourceType === 'location'
  const enteringCustom = targetType === 'custom'
  const enteringFaction = targetType === 'faction'
  const leavingFaction = sourceType === 'faction'

  const entity = getEntityById(entityId)

  // Knowledge → Entity: the source knowledge + a count of the mappable
  // downstream changes (name / description / colour / profile image / tags) and
  // the scenes they sit on, for the population-mode fork + the origin-only loss.
  const knowledge = fromKnowledge ? knowledges.find((k) => k.id === entityId) : null
  const { mappedChangeCount, mappedSceneCount } = useMemo(() => {
    if (!knowledge) return { mappedChangeCount: 0, mappedSceneCount: 0 }
    const h = knowledge.history || {}
    const lists = [h.name_changes, h.description_changes, h.colour_changes, h.profile_image_changes, h.tag_changes]
    let count = 0
    const scenes = new Set()
    for (const list of lists) for (const c of (list || [])) { count += 1; if (c.node_id) scenes.add(c.node_id) }
    return { mappedChangeCount: count, mappedSceneCount: scenes.size }
  }, [knowledge])
  const [population, setPopulation] = useState('auto')

  // A relationship's display label + the members it currently lists (unique
  // join-event participants), for the enter-faction adopt / copy picker.
  const relLabel = (r) => r.name || 'Unnamed relationship'
  const relParticipantNames = (r) => {
    const ids = [...new Set((r.history?.participant_changes || [])
      .filter((c) => c.action === 'join').map((c) => c.entity_id))]
    const names = ids.map((id) => getEntityById(id)?.name).filter(Boolean)
    return names
  }

  // Entering faction: adopt can only take a relationship that is not already a
  // membership container (membership_of == null); copy can source from any.
  const adoptCandidates = useMemo(
    () => (enteringFaction ? relationships.filter((r) => !r.membership_of) : []),
    [enteringFaction, relationships],
  )
  const copyCandidates = useMemo(
    () => (enteringFaction ? relationships : []),
    [enteringFaction, relationships],
  )

  // Leaving faction: the existing Members relationship being disposed of.
  const membersRel = useMemo(
    () => (leavingFaction ? relationships.find((r) => r.membership_of === entityId) : null),
    [leavingFaction, relationships, entityId],
  )
  const membersRelMemberCount = membersRel ? relParticipantNames(membersRel).length : 0

  // POV loss (leaving character): how many scenes carry this character's POV,
  // and whether it's the story-default POV.
  const povSceneCount = useMemo(() => {
    if (!leavingCharacter) return 0
    return (nodes || []).filter(
      (n) => n.type === 'sceneNode' && (n.data?.characters || []).some((r) => r.entity_id === entityId && r.has_pov),
    ).length
  }, [leavingCharacter, nodes, entityId])
  const isStoryPov = leavingCharacter && story?.pov_character_id === entityId

  // Location children (leaving location): count, and whether a grandparent exists
  // to reparent them to.
  const childCount = useMemo(
    () => (leavingLocation ? locations.filter((l) => l.parent_id === entityId).length : 0),
    [leavingLocation, locations, entityId],
  )
  const grandparent = leavingLocation && entity?.parent_id ? getEntityById(entity.parent_id) : null
  const hasGrandparent = !!grandparent

  // ── Fork state ──
  const [categoryId, setCategoryId] = useState('')
  const [childMode, setChildMode] = useState(batch || hasGrandparent ? 'reparent' : 'clear')
  const [busy, setBusy] = useState(false)

  // Entering faction: how to satisfy the mandatory Members relationship.
  const [factionMode, setFactionMode] = useState('create')  // 'create' | 'adopt' | 'copy'
  const [factionSourceRelId, setFactionSourceRelId] = useState('')
  // Leaving faction: what happens to the existing Members relationship.
  const [factionLeaveMode, setFactionLeaveMode] = useState('convert')  // 'convert' | 'delete'

  // Inline "new custom category" form — mirrors the New Custom entity modal so
  // creating a category here produces one identical in shape (name, description,
  // default colour) and auto-selects it.
  const [showNewCatForm, setShowNewCatForm] = useState(false)
  const [newCatName, setNewCatName] = useState('')
  const [newCatDesc, setNewCatDesc] = useState('')
  const [newCatColour, setNewCatColour] = useState(entityColour || '#888888')
  const newCatColourAnchorRef = useRef(null)
  const [newCatColourPickerOpen, setNewCatColourPickerOpen] = useState(false)

  const handleCreateCategory = async () => {
    if (!newCatName.trim()) return
    const cat = await createCustomCategory({ name: newCatName.trim(), description: newCatDesc.trim(), colour: newCatColour })
    if (cat) {
      setCategoryId(cat.id)
      setNewCatName(''); setNewCatDesc(''); setNewCatColour(entityColour || '#888888')
      setShowNewCatForm(false)
    }
  }

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape' && !busy) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  const needsCategory = enteringCustom
  // The inline "+ New" form creates the category and selects it before confirm,
  // so a ready state always means a real categoryId is in hand.
  const categoryReady = !needsCategory || !!categoryId
  // Entering faction via adopt / copy needs a chosen source relationship.
  const factionReady = !enteringFaction || factionMode === 'create' || !!factionSourceRelId
  const canConfirm = categoryReady && factionReady && !busy && !showNewCatForm

  const handleConfirm = () => {
    if (!canConfirm) return
    setBusy(true)
    onConvert({
      categoryId: enteringCustom ? (categoryId || null) : undefined,
      locationChildren: childMode,
      factionMembers: enteringFaction
        ? { mode: factionMode, sourceRelId: factionMode === 'create' ? undefined : factionSourceRelId }
        : undefined,
      factionLeave: leavingFaction ? factionLeaveMode : undefined,
      population: fromKnowledge ? population : undefined,
    })
  }

  const handleBackdropClick = (e) => { if (e.target === backdropRef.current && !busy) onClose() }

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60"
      onClick={handleBackdropClick}
    >
      <div className="bg-zinc-800 border border-zinc-600 rounded-lg shadow-2xl w-[420px] overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="h-1" style={{ backgroundColor: entityColour }} />

        <div className="p-5 space-y-4">
          <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
            <span>Convert</span>
            <span className="text-zinc-300">{entityName}</span>
            <span className="text-zinc-500">to</span>
            <span className="flex items-center gap-1 text-zinc-100">
              <span>{TYPE_ICONS[targetType]}</span>{TYPE_LABELS[targetType]}
            </span>
          </h2>

          {batch && (
            <p className="text-xs text-zinc-400">
              Converting <strong>{batchCount}</strong> {TYPE_LABELS[sourceType].toLowerCase()}{batchCount === 1 ? '' : 's'}. The choices below apply to every one; each keeps all its own work and only its type-specific items change. Undo reverts the whole batch in one step.
            </p>
          )}

          {!batch && !fromKnowledge && (
            <p className="text-xs text-zinc-400">
              The {TYPE_LABELS[sourceType].toLowerCase()} keeps all its work (attributes, aliases, awareness, description, and every scene change). Only the type-specific items below change. Undo restores everything in one step.
            </p>
          )}

          {!batch && fromKnowledge && (
            <p className="text-xs text-zinc-400">
              The knowledge keeps its name, description, colour, image, notes, tags, and its full awareness (now read as who knows this {TYPE_LABELS[targetType].toLowerCase()} exists). It gains an origin node and the dimensions an entity has. Undo restores everything in one step.
            </p>
          )}

          {/* ── Knowledge → Entity: forced losses + population ── */}
          {fromKnowledge && (
            <div className="space-y-2">
              <div className="bg-amber-900/30 border border-amber-700/50 rounded px-3 py-2 text-xs text-amber-300 space-y-1">
                <div><strong>Some knowledge-only details are dropped</strong> (entities have no equivalent): its source event, its born/exists lifecycle, source-event re-bindings, and any manual scene pins.</div>
                {population === 'origin' && !batch && mappedChangeCount > 0 && (
                  <div><strong>{mappedChangeCount}</strong> downstream change{mappedChangeCount === 1 ? '' : 's'} at <strong>{mappedSceneCount}</strong> scene{mappedSceneCount === 1 ? '' : 's'} will not be carried over.</div>
                )}
                {population === 'origin' && batch && (
                  <div>Any downstream changes on these knowledges will not be carried over.</div>
                )}
              </div>
              {(batch || mappedChangeCount > 0) && (
                <div className="space-y-1.5">
                  <div className="text-xs text-zinc-400">
                    {batch
                      ? 'Downstream changes (name / description / colour / image / tags):'
                      : <>Its <strong>{mappedChangeCount}</strong> downstream change{mappedChangeCount === 1 ? '' : 's'} (name / description / colour / image / tags):</>}
                  </div>
                  <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
                    <input type="radio" name="population" checked={population === 'auto'} onChange={() => setPopulation('auto')} />
                    <span>Recreate them as chips wired in story order</span>
                  </label>
                  <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
                    <input type="radio" name="population" checked={population === 'orphaned'} onChange={() => setPopulation('orphaned')} />
                    <span>Recreate them as chips, but leave them unwired for me to connect</span>
                  </label>
                  <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
                    <input type="radio" name="population" checked={population === 'origin'} onChange={() => setPopulation('origin')} />
                    <span>Origin only (discard the downstream changes)</span>
                  </label>
                </div>
              )}
            </div>
          )}

          {/* ── Losses / warnings ── */}
          {leavingCharacter && !batch && (povSceneCount > 0 || isStoryPov) && (
            <div className="bg-amber-900/30 border border-amber-700/50 rounded px-3 py-2 text-xs text-amber-300 space-y-1">
              <div><strong>POV will be detached.</strong> Only characters can hold POV.</div>
              {povSceneCount > 0 && <div>This character holds POV on <strong>{povSceneCount}</strong> scene{povSceneCount === 1 ? '' : 's'}. Those scenes keep their place and order on the POV path; the POV simply stops being attached to a character.</div>}
              {isStoryPov && <div>It is also the story's default POV, which will be cleared.</div>}
            </div>
          )}
          {leavingCharacter && batch && (
            <div className="bg-amber-900/30 border border-amber-700/50 rounded px-3 py-2 text-xs text-amber-300 space-y-1">
              <div><strong>POV will be detached.</strong> Only characters can hold POV. Any of these characters that hold POV lose it; those scenes keep their place and order on the POV path (now unattached), and the story default POV is cleared if it was one of them.</div>
            </div>
          )}

          {/* ── Fork: location children ── */}
          {leavingLocation && (batch || childCount > 0) && (
            <div className="space-y-1.5">
              <div className="text-xs text-zinc-300">
                {batch
                  ? 'For any of these locations that have child locations:'
                  : <><strong>{childCount}</strong> location{childCount === 1 ? '' : 's'} {childCount === 1 ? 'has' : 'have'} this as their parent:</>}
              </div>
              {(batch || hasGrandparent) && (
                <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
                  <input type="radio" name="childMode" checked={childMode === 'reparent'} onChange={() => setChildMode('reparent')} />
                  <span>{batch ? 'Reparent each to its own parent location' : <>Reparent them to <strong>{grandparent.name}</strong></>}</span>
                </label>
              )}
              <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
                <input type="radio" name="childMode" checked={childMode === 'clear'} onChange={() => setChildMode('clear')} />
                <span>Make them top-level (clear their parent)</span>
              </label>
            </div>
          )}

          {/* ── Fork: entering custom needs a category ── */}
          {enteringCustom && (
            <div className="space-y-1.5">
              <label className="text-xs text-zinc-400">Custom category <span className="text-amber-400">(required)</span>:</label>
              {!showNewCatForm ? (
                <div className="flex gap-2">
                  <select
                    value={categoryId}
                    onChange={(e) => setCategoryId(e.target.value)}
                    className="flex-1 bg-zinc-700 text-sm text-zinc-100 px-3 py-2 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
                  >
                    <option value="">— select category —</option>
                    {customCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <button type="button" onClick={() => setShowNewCatForm(true)} className="text-xs text-accent-400 hover:text-accent-300 whitespace-nowrap">+ New</button>
                </div>
              ) : (
                <div className="space-y-2 bg-zinc-700/40 rounded p-2">
                  <input autoFocus value={newCatName} onChange={(e) => setNewCatName(e.target.value)} placeholder="Category name…"
                    className="w-full bg-zinc-700 text-xs text-zinc-100 px-2 py-1.5 rounded border border-zinc-600 focus:outline-none focus:border-accent-500" />
                  <input value={newCatDesc} onChange={(e) => setNewCatDesc(e.target.value)} placeholder="Description (optional)"
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
                    <input value={newCatColour} onChange={(e) => setNewCatColour(e.target.value)} maxLength={7}
                      className="flex-1 bg-zinc-700 text-xs text-zinc-100 px-2 py-1.5 rounded border border-zinc-600 focus:outline-none focus:border-accent-500 font-mono" />
                  </div>
                  <div className="flex gap-2">
                    <button type="button" onClick={handleCreateCategory} className="text-xs bg-accent-700 hover:bg-accent-600 text-white rounded px-3 py-1">Create &amp; Select</button>
                    <button type="button" onClick={() => setShowNewCatForm(false)} className="text-xs text-zinc-400 hover:text-zinc-200">Cancel</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Fork: entering faction needs a Members relationship ── */}
          {enteringFaction && (
            <div className="space-y-1.5">
              <div className="text-xs text-zinc-400">Members relationship <span className="text-amber-400">(required)</span>:</div>
              <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
                <input type="radio" name="factionMode" checked={factionMode === 'create'} onChange={() => { setFactionMode('create'); setFactionSourceRelId('') }} />
                <span>Create a new empty Members relationship</span>
              </label>
              {batch && (
                <div className="text-[11px] text-zinc-500">Each new faction gets its own new empty Members relationship. (Adopt / Copy target one specific relationship, so they are not available for a batch.)</div>
              )}
              {!batch && (
                <>
                  <label className={`flex items-center gap-2 text-xs cursor-pointer ${adoptCandidates.length === 0 ? 'text-zinc-600 cursor-not-allowed' : 'text-zinc-300'}`}>
                    <input type="radio" name="factionMode" disabled={adoptCandidates.length === 0} checked={factionMode === 'adopt'} onChange={() => { setFactionMode('adopt'); setFactionSourceRelId('') }} />
                    <span>Adopt an existing relationship{adoptCandidates.length === 0 ? ' (none available)' : ''}</span>
                  </label>
                  <label className={`flex items-center gap-2 text-xs cursor-pointer ${copyCandidates.length === 0 ? 'text-zinc-600 cursor-not-allowed' : 'text-zinc-300'}`}>
                    <input type="radio" name="factionMode" disabled={copyCandidates.length === 0} checked={factionMode === 'copy'} onChange={() => { setFactionMode('copy'); setFactionSourceRelId('') }} />
                    <span>Copy an existing relationship{copyCandidates.length === 0 ? ' (none available)' : ''}</span>
                  </label>
                  {(factionMode === 'adopt' || factionMode === 'copy') && (
                    <select
                      value={factionSourceRelId}
                      onChange={(e) => setFactionSourceRelId(e.target.value)}
                      className="w-full bg-zinc-700 text-sm text-zinc-100 px-3 py-2 rounded border border-zinc-600 focus:outline-none focus:border-accent-500"
                    >
                      <option value="">— select relationship —</option>
                      {(factionMode === 'adopt' ? adoptCandidates : copyCandidates).map((r) => {
                        const members = relParticipantNames(r)
                        return (
                          <option key={r.id} value={r.id}>
                            {relLabel(r)}{members.length ? ` (${members.join(', ')})` : ''}
                          </option>
                        )
                      })}
                    </select>
                  )}
                  {factionMode === 'adopt' && (
                    <div className="text-[11px] text-zinc-500">Its current participants become this faction&apos;s members.</div>
                  )}
                  {factionMode === 'copy' && (
                    <div className="text-[11px] text-zinc-500">A duplicate is made (new id, renamed to &ldquo;{entityName} Members&rdquo;); the original is untouched.</div>
                  )}
                </>
              )}
            </div>
          )}

          {/* ── Fork: leaving faction disposes of its Members relationship ── */}
          {leavingFaction && (batch || membersRel) && (
            <div className="space-y-1.5">
              <div className="text-xs text-zinc-300">
                {batch
                  ? 'Each faction’s Members relationship:'
                  : <>This faction has a Members relationship{membersRelMemberCount > 0 ? <> with <strong>{membersRelMemberCount}</strong> member{membersRelMemberCount === 1 ? '' : 's'}</> : ''}:</>}
              </div>
              <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
                <input type="radio" name="factionLeave" checked={factionLeaveMode === 'convert'} onChange={() => setFactionLeaveMode('convert')} />
                <span>Convert it to a normal relationship (keeps the members&apos; connections)</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
                <input type="radio" name="factionLeave" checked={factionLeaveMode === 'delete'} onChange={() => setFactionLeaveMode('delete')} />
                <span>Delete it</span>
              </label>
            </div>
          )}

          {/* ── Actions ── */}
          <div className="flex gap-2 justify-end pt-1">
            <button
              onClick={onClose}
              disabled={busy}
              className="px-3 py-1.5 text-xs text-zinc-300 hover:text-zinc-100 rounded border border-zinc-600 hover:border-zinc-500 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={!canConfirm}
              className={`px-3 py-1.5 text-xs rounded border ${
                canConfirm
                  ? 'bg-accent-700 hover:bg-accent-600 text-white border-accent-600'
                  : 'bg-zinc-700 text-zinc-500 border-zinc-600 cursor-not-allowed'
              }`}
            >
              Convert to {TYPE_LABELS[targetType]}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
