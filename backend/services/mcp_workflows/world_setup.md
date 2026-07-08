# Workflow: World Setup

How to set up a story's world — characters, locations, items, relationships — so that the chain-of-history model works smoothly when scenes start landing changes. Use this guide BEFORE creating any scenes, OR when adding new world elements mid-story.

This is the "what you should know before you start" guide. The plot_planning workflow assumes you've read this.

---

## The chain-of-history model (read this first)

Every entity (character, location, item, faction, custom), every alias, every attribute, every relationship, every knowledge, and every awareness state has TWO things:

1. A **baseline** at its **origin** — "this is the entity's state as it begins in the narrative."
2. A **chain** of changes that happen at specific scenes — "this is what changed and where after that."

The "current value" at any point in the story depends on WHERE on the chain you are reading from. The walker resolves it by starting at the baseline and applying every change recorded up to (and including) the requested scene.

### Origin vs. scene-anchored writes

Every write tool that touches an entity / relationship / attribute / alias / knowledge / awareness takes an `at` arg:

- **`at` omitted / null / 'origin'** → BASELINE write. "This is how the entity has always been." Use when setting up the world OR correcting a baseline mistake.
- **`at=<scene UUID or title>`** → SCENE-ANCHORED change. "This is what changed at this scene." The change propagates forward to every downstream scene. Use when something happens in the story.

The decision tree: **did this fact change because of something that happened in a scene?** If yes → scene-anchored. If no (it was always true, you just hadn't recorded it yet) → origin.

### Why this matters

The wrong choice silently corrupts the chain:

- **Writing scene-anchored when you meant origin** = downstream review flags fire on the change; the baseline stays wrong.
- **Writing origin when you meant scene-anchored** = the change applies to EVERY scene including ones before the change happened. A character's hair-colour change at scene 7 would make them have the new colour at scene 1 too if written at origin.

When in doubt, ask: "is this what the character / location / etc. has been THE WHOLE TIME, or did it become this way at a specific moment?" That answer determines `at`.

---

## Attributes vs. description

Both can hold information. They're for different things.

### Use ATTRIBUTES for:

- **Structured facts** that have a clear name + value shape: age, profession, height, eye colour, species, faction membership.
- **Values that might change** at a scene: a character's mood, their current job, their alignment, what they're wearing.
- **Numeric values**: age (number type), gold pieces, health, etc.
- **Lists**: aliases (use the dedicated alias tools though), tags, skills, abilities.
- **Preset values** drawn from a shared list (Gender from a Gender preset list, Class from a Class preset list).
- **Files**: profile images, voice recordings, reference art.
- **Circumstances** and **motivators**: first-class structured types for situational state and inner drives. Each has a name, description, and an OPTIONAL intensity (a five-level scale Faint / Mild / Moderate / Strong / Intense, plus an unset `null`; the full scale and accepted values are in `get_tool_help('intensity')`). The unset state (`null`) is distinct from `'Faint'`: null means "no level committed" (use when the relative weight doesn't matter narratively), `'Faint'` means the lowest real tier IS pinned (use when that's the actual narrative state).
- **Perspectives** — first-class structured type for what an entity thinks / feels / believes about ANOTHER object. Distinct from a circumstance ("they're tired") or a motivator ("they want revenge") — a perspective is always ABOUT something else in the story. Each perspective carries a **target** (one of: another character, location, item, faction, custom entity, knowledge, or relationship) plus a **description** (the body — the host's view on the target). No intensity, no name — the target IS the perspective's identity, and the body text IS the content. Use perspectives when the writer wants to record: a character's opinion of another character; how a character feels about a place / item / faction; how a character interprets a piece of knowledge they're aware of; how a character reads a relationship between others. Authored via `add_perspectives(entity=<host>, perspectives=[{ description, target: { kind, ref } }], at?)`. When the target object is later deleted, the perspective's description survives but its target goes to `null` — the host is flagged via `list_alerts(type='orphaned_perspective_target')` so the writer can rewire or remove.

### Character physical characteristics — capture as attributes

For CHARACTERS specifically, physical traits are a high-value attribute set. They're what the prose-writing workflow leans on for description / blocking, AND they're often the things that change downstream via a chain entry (a haircut, a scar, a transformation, weight loss / gain, ageing, dye job, surgery). Common physical attributes to set up at origin:

- `Age` (number)
- `Gender` (often a preset, drawn from a shared Gender preset list)
- `Hair colour`, `Hair style`, `Hair length`
- `Eye colour`
- `Skin tone`
- `Height` (number; pick a unit that fits the setting — cm, inches, hands)
- `Build` / `Body type`
- `Bust` / `Chest`
- `Distinguishing marks` (scars, tattoos, birthmarks — often a `text_list`)
- `Voice` (timbre / accent / cadence notes)

Tailor the set to the story: a regency romance might care about `Bust` and `Hair style` per character but not `Build`; a fantasy adventure might add `Species`, `Eye colour glows-when` (text), `Magical aura colour`, or `Distinguishing scars`. Pick the attributes the writer would actually want to query or change downstream — don't fill the entity with every conceivable physical trait "just in case."

### Use DESCRIPTION for:

- **Free-form prose framing** — the kind of paragraph a writer would put on a character sheet's "About" section.
- **Voice / tone notes** that don't have structured shape: "speaks in clipped sentences when nervous", "always sits with their back to a wall".
- **Background info** that's narrative rather than factual: "Grew up on the wrong side of the tracks, but doesn't talk about it."

### The test

When you're about to put a fact in description, ask:

1. Does this fact have a clear NAME and VALUE? (age = 32; profession = blacksmith)
2. Would the AI ever want to query this fact directly? ("how old is Marcus?")
3. Could this change at some specific point in the story?

If yes to any → attribute.

### Example: bad vs. good

**Bad (everything in description):**
```
Marcus Thorne. A 32-year-old blacksmith working at his forge.
Tall and broad-shouldered with dark brown hair cropped short
and a thin scar across his left forearm. Eli is his apprentice.
His sister Hannah runs the bakery across the square. He's been
the village's only smith for 8 years.
```

**Good (structured):**
```
description: "Quiet, sturdy. Lets his work speak for him."
attributes:
  Age: 32
  Profession: "Blacksmith"
  Years in Profession: 8
  Gender: "Male"               (preset)
  Hair colour: "Dark brown"
  Hair style: "Cropped short"
  Eye colour: "Hazel"
  Height: 187                  (number, cm)
  Build: "Broad-shouldered"
  Distinguishing marks: ["Thin scar across left forearm"]   (text_list)
relationships:
  Eli (Apprentice / Master)
  Hannah (Sibling)
```

The good version lets the AI ask "who's a blacksmith?" or "what changes about Marcus at scene 5?" and get clean answers. The bad version forces every query through prose parsing.

---

## Entity setup checklist

For each entity you create, the batch shape of `create_entity` lets you land the full origin in ONE call:

1. **`create_entity(type=..., name=..., colour=..., description=..., attributes=[{name, attribute_type, value? / number_value? / file_ref? / preset_list? / values? / description? / intensity?}, ...], aliases=[{value: 'Marc'}, {value: 'M.T.'}, ...])`** — baseline + all starting attributes + all starting aliases in one shot. Both `attributes` and `aliases` are optional batch args; omit them when there's nothing to add yet. Single-attribute / single-alias case is still a list: `attributes=[{...}]`, `aliases=[{value: 'Marc'}]`. Bare strings (`aliases=['Marc']`) are accepted as shorthand and auto-promoted, but the object form is preferred for shape-consistency with `attributes`. Use a meaningful colour (it propagates through chips, sub-chips, badges, etc.).
2. If you need to add MORE attributes or aliases later (after deciding the character has additional structured facts): **`add_attributes(entity=..., attributes=[...])`** and **`add_aliases(entity=..., aliases=[{value: ...}, ...])`** — same batch shape, one call regardless of count.
3. For baseline circumstances and motivators (situational states / inner drives true from origin): **`add_circumstances(target=<entity>, circumstances=[...])`** and **`add_motivators(entity=<entity>, motivators=[...])`** — both take a list of `{name, description, intensity?}` items. Skip when the entity has no baseline of either.
4. For baseline perspectives (what THIS entity thinks / feels / believes about other story objects from origin): **`add_perspectives(entity=<entity>, perspectives=[{ description, target: { kind, ref } }, ...])`** — `target.kind` is one of character / location / item / faction / custom / knowledge / relationship; `target.ref` is the target's UUID or exact name. The target must already exist at the perspective's anchor — perspectives can't introduce a forward reference to an object that doesn't exist yet. Skip when the entity has no baseline opinion of anything else worth recording.
5. **`create_relationship(name=..., participants=['entity1', 'entity2'], roles={'entity1': 'Mentor', 'entity2': 'Apprentice'})`** for each baseline connection to other entities. `participants` and `roles` are also batched into the create call.
6. Done. Don't pre-populate values that might "happen" later in the story — those are scene-anchored changes.

### Factions and their membership

A faction entity (`type='faction'`) is a group / organisation / collective: a frat house, a guild, a noble court, a crew, a band, a generation of students. Creating a faction is a single call:

**`create_entity(type='faction', name='<Faction Name>', colour=..., description=..., attributes=[...])`**

This automatically creates a paired **membership relationship** named `"<Faction Name> Members"` whose `membership_of` field points back to the faction. The faction itself is NOT a participant of its own membership relationship — only real members are. The membership relationship is how the chain model represents "X is a member of this faction" and it carries the chain-tracked history of joiners and leavers.

To add members, treat the membership relationship like any other and use the standard relationship tools:

- **`add_participants(relationship='<Faction Name> Members', participants=[{entity:'<member>', role?:'<role within faction>'}, ...])`** — adds members at baseline (origin of the membership relationship, which is the faction's origin). One call for any number of new members.
- **`add_participants(relationship='<Faction Name> Members', participants=[...], at='<scene>')`** — records new members joining at a specific scene. The chain reflects the join event from that scene forward.
- **`remove_participants(relationship='<Faction Name> Members', participants=['<member>'], at='<scene>')`** — records a member leaving at a specific scene.
- **`set_participant(relationship='<Faction Name> Members', entity='<member>', role='<new role>', at='<scene>')`** — changes a member's role within the faction at a scene.

Faction membership composes with the awareness layer's group-projection feature: setting awareness on a Knowledge / entity / etc with the faction's membership relationship as an awareness SOURCE projects that level to every current member of the faction at the chain anchor (see the awareness section of `plot_planning` for the projection pattern).

---

## Story-level setup: seeds, preset lists, custom categories

These are project-wide structures that make repeated patterns smoother.

### Preset lists

A named shared list of values that multiple entities can pull from. Use when several entities have the same enum-like field.

Example: a Gender preset list `["Male", "Female", "Non-binary"]`. Multiple characters reference it via a `preset`-type attribute.

- **`create_preset_list(name='Gender', values=['Male', 'Female', 'Non-binary'])`**
- Then per character, fold the attribute into the entity's `create_entity` call: **`create_entity(type='character', name='Mira', attributes=[{name: 'Gender', attribute_type: 'preset', preset_list: 'Gender', value: 'Female'}])`**. For existing entities, **`add_attributes(entity=..., attributes=[{name: 'Gender', attribute_type: 'preset', preset_list: 'Gender', value: 'Female'}])`**.

### Story seeds

Auto-attach attributes to NEWLY-CREATED entities of a given type. Saves repetition.

Example: every Character in the story has a "Gender" preset attribute. Add a seed so you don't have to manually attach it to every new character.

- **`add_story_seed(entity_type='character', name='Gender', attribute_type='preset', preset_list='Gender')`**
- Subsequent `create_entity(type='character', ...)` calls auto-attach the Gender attribute. Set the value via the `attributes` batch arg on the `create_entity` call itself (the seed adds the attribute shape; you provide the value), or after creation via **`update_attributes(entity=..., updates=[{attribute: 'Gender', value: 'Female'}])`**.
- **Seeds only apply going forward.** They don't retroactively populate entities that already exist.

### Custom categories

For "I have lots of these and they're fungible" entity types. Different from regular entity types — multiple Custom entities can share a category.

Example: a story with many generic Goblins, or many "Ancient Oak Trees" — none of which need a fully unique entity but you want to track them as distinct objects.

- **`create_custom_category(name='Goblin', description='Small green humanoid...')`** — defines the category.
- **`create_entity(type='custom', name='Snub', category='Goblin')`** per individual.

Custom entities behave like other entities — they can have attributes, aliases, appear in scenes, etc. The category is just metadata about what KIND of custom thing they are.

---

## When to defer entity creation

Don't try to populate the entire cast upfront. Define only:

1. Entities present in or near the opening scene.
2. Entities mentioned by name in the opening scene (even if off-screen).
3. Story-critical entities the writer has explicitly listed as part of the premise.

Everything else: add the moment they're first needed in a scene. The plot_planning workflow covers this cadence.

---

## Common setup mistakes

1. **Treating description as a "everything-bucket"** — narrative-content facts that have structure go in attributes; description is for prose flavour.
2. **Setting up future state at origin** — "Marcus will become Marisol later" → DON'T write female-Marisol values at origin. Marcus's origin is who he STARTS as. The transformation is a scene-anchored update.
3. **Creating duplicate entities for "different versions" of the same character** — male Marcus and female Marisol are the same entity. Use `update_entity(entity='Marcus', at='<transformation scene>', name='Marisol', colour='#...')`.
4. **Skipping seeds when several entities will share a field** — seeds save you from manually attaching the same attribute shape N times. Cost is one extra call up front; benefit scales with entity count.
5. **Putting the same value as a description fragment in every entity's description** — that's what attributes are for.
