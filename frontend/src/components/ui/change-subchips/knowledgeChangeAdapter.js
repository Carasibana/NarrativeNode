/**
 * knowledgeChangeAdapter — Phase 1.21d Step F
 *
 * Converts a single `Knowledge.history.{name|description|colour|profile_image}_changes`
 * entry into the entity-shaped `chip` object that `<ChangeSubChip>`
 * consumes. After this adapter lands, Knowledge content changes render
 * through the same `<ChangeSubChip>` as entity content changes — same
 * visual language for "Name: old → new", "Colour: [swatch] → [swatch]",
 * "Profile Image: [old thumb with red X] → [new thumb]".
 *
 * `priorEffective` is the chain-resolved state IMMEDIATELY BEFORE the
 * change's node — caller computes it via a second `computeKnowledgeEffectiveState`
 * walk anchored at the previous chain position (or falls back to the
 * Knowledge's base values when no prior chain step exists).
 *
 * Args:
 *   field           — 'name' | 'description' | 'colour' | 'profile_image'.
 *   change          — the raw `Knowledge.history.*_changes` entry.
 *   priorEffective  — `{ name, description, colour, profile_image_ref }`
 *                     resolved at the chain position before the change.
 *
 * Returns the entity-shaped chip descriptor or `null` if the field is
 * unrecognised.
 */

const FIELD_LABELS = {
  name:          'Name',
  description:   'Description',
  colour:        'Colour',
  profile_image: 'Profile Image',
}

export function knowledgeContentChangeToSubChip(field, change, priorEffective) {
  const label = FIELD_LABELS[field]
  if (!label) return null

  if (field === 'colour') {
    return {
      action:   'modify',
      field:    label,
      isColour: true,
      oldValue: priorEffective?.colour ?? null,
      newValue: change?.new_colour ?? null,
    }
  }

  if (field === 'profile_image') {
    const oldRef = priorEffective?.profile_image_ref ?? null
    const newRef = change?.new_profile_image_ref ?? null
    // Determine action from the old/new pair: add if going from null to
    // something, remove if going to null, modify otherwise.
    let action = 'modify'
    if (!oldRef && newRef) action = 'add'
    else if (oldRef && !newRef) action = 'remove'
    return {
      action,
      field:          label,
      isProfileImage: true,
      oldImageRef:    oldRef,
      newImageRef:    newRef,
    }
  }

  // Generic text fields: name / description. ChangeSubChip's generic-modify
  // branch renders `field: <old strikethrough> → <new>`.
  const newValue = field === 'name'
    ? (change?.new_name ?? null)
    : (change?.new_description ?? null)
  const oldValue = field === 'name'
    ? (priorEffective?.name ?? null)
    : (priorEffective?.description ?? null)

  return {
    action:   'modify',
    field:    label,
    oldValue: oldValue || null,
    newValue: newValue || null,
  }
}
