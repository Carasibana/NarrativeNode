# Workflow: Knowledge Tracking

How to use NarrativeNode's Knowledge model to track WHAT each character knows, WHEN they learned it, and from WHOM. This is the layer that lets the AI (and the writer) reason about dramatic irony, secrets, lies, surprises, and the gap between what's true in the world and what each character believes.

Use this guide when your story has:
- Secrets some characters know and others don't (a hidden transformation, a parentage reveal, an affair, an alliance, a betrayal).
- Information that propagates at different rates between characters (A tells B who tells C, while D, E, F remain ignorant).
- Plot beats that hinge on what one character knows that another doesn't.
- Multiple characters whose actions depend on partial / wrong understanding.

If the story has none of those, you may not need Knowledge tracking at all — skip this workflow. Awareness tracking on entity / attribute / alias / relationship changes (the `set_*_awareness` tools) handles the simpler "this specific change isn't universally observed" cases without a dedicated Knowledge object.

---

## What a Knowledge is

A **Knowledge** is a first-class story object representing a discrete FACT or EVENT that characters in the story can be aware of, partially aware of, or unaware of. It has:

- A **name** ("Marcus is actually Marisol", "Hannah's secret affair", "The vault combination").
- A **description** (free-form prose explaining the fact).
- A **colour** (visual identity on the canvas).
- An **awareness scale** — either `'binary'` (Aware / Unaware) or `'full'` (Fully Aware / Partially Aware / Nominally Aware / Unaware, the same 4-level scale used elsewhere in NN).
- A **source_event** (optional) — a binding back to the chain event that created / caused this Knowledge (e.g. the `update_entity` call that transformed Marcus into Marisol). Lets the AI navigate from "what fact is this?" back to "what happened to make it true?"
- A **history** of awareness events — per-observer changes (who learned it, when, from whom) anchored at scenes.

A Knowledge is NOT a character's memory or an attribute. It's an OBJECT in the story-world, and each character (or other entity) has its own awareness level toward that object.

---

## Origin location: scene-born vs standalone

Like every NN object, a Knowledge has an origin. Two creation patterns:

### Scene-born Knowledge

Created at a specific scene; the scene IS its origin. Use this when the fact CAME INTO EXISTENCE at a specific scene — a transformation, a discovery, an event that happened.

- **`create_knowledge(name=..., description=..., colour=..., awareness_scale=..., scene='<the scene>')`** — origin anchors at the scene. The Knowledge is "alive" on the timeline from that scene forward.

Most narrative-event Knowledges are scene-born. The transformation Knowledge "Marcus is now Marisol" is born at the scene where Marcus transforms.

### Standalone Knowledge

Created on the canvas without a scene anchor. Use this for facts that exist in the story-world but aren't tied to a specific in-story event — backstory facts, ambient lore, secrets that pre-date the story's first scene.

- **`create_knowledge(name=..., description=..., colour=..., awareness_scale=...)`** with no `scene` arg — a fresh `KnowledgeOriginNode` is placed on the canvas; the Knowledge anchors there.

A backstory secret like "The old king had a third child no one knows about" might be standalone — it's true from before the story opens; there's no scene where it "happened."

### Source-event binding

For scene-born Knowledges, you usually also want to bind the Knowledge to the specific chain event that caused it. The `track_as_knowledge` arg on every chain-event-emitting tool does this in one shot — see the next section.

---

## The `track_as_knowledge` pattern (the easy path)

The most common Knowledge-tracking flow is "I'm about to record a chain event, and that event creates a fact other characters might or might not know about." Every chain-event-emitting tool — `update_entity(at=...)`, `update_attributes(at=...)`, `add_attributes(at=...)`, `update_relationship(at=...)`, `add_participants(at=...)`, `remove_participants(at=...)`, `set_participant(at=...)`, `add_circumstances(target=<entity>, at=...)`, `add_motivators(at=...)`, `add_aliases(at=...)`, `remove_attributes(at=...)`, `remove_aliases(at=...)`, `remove_circumstances(... at=...)`, `remove_motivators(... at=...)` — accepts an optional `track_as_knowledge` arg.

Two shapes:

1. **`track_as_knowledge={ name: 'Marcus transformed', description?, colour?, awareness_scale? }`** — creates a NEW Knowledge whose `source_event` baseline points at the chain event you just recorded. The Knowledge is scene-born at the same scene as the change.
2. **`track_as_knowledge='<existing Knowledge UUID or name>'`** — binds the chain event to an existing Knowledge. The Knowledge gets a `source_event_changes` entry pointing at the new event.

**The single-anchor rule:** a Knowledge anchors to ONE event. If you're using a batch tool (e.g. `update_attributes` with three updates), the batch must produce exactly one chain entry total. Multi-entry batches with `track_as_knowledge` reject cleanly with a "split into separate calls" error.

**This rule also applies to single-tool multi-field calls** — `update_entity(at=..., name=..., colour=..., description=...)` is THREE chain entries (one per scalar field), and passing `track_as_knowledge` on that call will reject too. Split the call into separate per-field updates, and pass `track_as_knowledge` on the ONE you want as the Knowledge's source event.

### Worked example

A character (Marcus) transforms into a woman (Marisol) at scene 5. The transformation is a secret — Eli, Hannah, the village in general don't know. The transformation touches name, colour, and description — three scalar fields. We bind the Knowledge to the NAME change as the canonical anchor (the rename is the most identifying part of the event), then record the colour + description changes separately without `track_as_knowledge`.

```
# 1a. Bind the Knowledge to the name change (single field on this call):
update_entity(
  entity='Marcus',
  at='Transformation scene',
  name='Marisol',
  track_as_knowledge={
    name: 'Marcus is now Marisol',
    description: 'Marcus transformed into a woman at the loft.',
    colour: '#7a5fa3',
    awareness_scale: 'binary',
  },
)
# → response includes `tracking_knowledge_id: <new Knowledge id>`

# 1b. Now record the colour change at the same scene (no track_as_knowledge):
update_entity(
  entity='Marcus',
  at='Transformation scene',
  colour='#b87a9a',
)

# 1c. And the description change at the same scene (no track_as_knowledge):
update_entity(
  entity='Marcus',
  at='Transformation scene',
  description='A woman in her late twenties, orange hair and blue eyes.',
)
```

If you call update_entity with multiple scalar fields AND track_as_knowledge in ONE call, you'll get a clear error telling you which fields conflicted and to split into separate calls. The split pattern above is the recovery shape the error points at.

Now the Knowledge exists, bound to the transformation event. **There is no default awareness — the Knowledge starts with NOTHING pinned on any observer.** No entity is auto-Aware (not even the one the change happened to), no entity is auto-Unaware. Every awareness pin is an explicit author decision (see the Relevance Gate in the next section). The chain walker resolving the awareness map at any scene returns `{}` until you make pins. You then pin awareness only for observers whose specific level is narratively relevant — typically the entity at the centre of the event (because their being Aware drives their internal experience in downstream scenes) plus any other observer whose Aware-ness or Unaware-ness drives plot.

---

## Setting awareness

`set_knowledge_awareness(knowledge, entries=[{...}])` sets one or more observers' awareness of one Knowledge in a single call.

Pin an observer at the anchor where their awareness level becomes meaningful to the story:
- `Fully Aware` (or `Aware` on binary scale) — the observer knows the fact. Pin them at the scene where they learn it, or at the Knowledge's origin if they've known all along. Drives "this character can act on this information" downstream.
- `Partially Aware` / `Nominally Aware` — the observer knows incomplete pieces or knows but isn't really thinking about it. Pin at the scene where they pick up the partial knowledge.
- `Unaware` — the observer specifically does NOT know the fact, and their not-knowing shapes how they read situations going forward (asks questions a knower wouldn't, treats the secret-bearer at face value, would react differently if they knew). Pin at the scene where they're first present in proximity to the fact.

The pin sticks: the chain walker carries it forward to every downstream scene until you change it. When an observer's level shifts (they learn, they forget, they're deliberately misled), pin the new level at the scene of the shift.

Args:

- `knowledge` — UUID or exact name of the Knowledge (shared across every entry in the batch).
- `entries` — non-empty list of `{ observer, level, at? }` objects. Pass a one-element list for the single-target case; pass more to set several observers in one call. Per-item:
  - `observer` — UUID or exact name/alias of the entity whose awareness is being set.
  - `level` — either int 0-3 OR canonical name string: `'Unaware'`, `'Nominally Aware'` / `'Nominally'`, `'Partially Aware'` / `'Partially'`, `'Fully Aware'` / `'Fully'` / `'Aware'`. The binary scale collapses to `Unaware` / `Aware` ({0, 3}).
  - `at` — omit / null / `'origin'` for baseline awareness (the observer has known to this degree from the Knowledge's origin onward). Scene UUID or title for scene-anchored awareness change (the observer learned / forgot at this scene).

**Awareness is chain-tracked** — once you set an observer's level at a scene, that level propagates forward to every downstream scene until you change it again. You do NOT need to re-set the same observer at every subsequent scene they appear in. Pin awareness at the scene where it CHANGES (first revelation, learning, forgetting, deliberate misleading), and the chain walker resolves the cumulative state at any later read.

### Worked example continued

```
# 2. Eli walks in on Marisol at scene 6 and learns the truth.
#    Hannah learns from Eli at scene 8. The village gossip starts
#    spreading at scene 10 — most villagers are only Partially Aware.
#    All three writes in one call:
set_knowledge_awareness(
  knowledge='Marcus is now Marisol',
  entries=[
    {observer: 'Eli',            level: 'Fully Aware',     at: 'Morning, A Stranger'},
    {observer: 'Hannah',         level: 'Fully Aware',     at: "Hannah's Storefront"},
    {observer: 'Village gossip', level: 'Partially Aware', at: 'Market Day'},
  ],
)
```

The batch shape is for when several observers' awareness shifts in the SAME scene and each shift matters narratively — one call per Knowledge with one entry per observer-whose-awareness-matters. **It is not for "set every present participant to a state."** Most scenes will only have entries for the one or two observers whose learning / not-knowing is plot-relevant at that anchor; everyone else's awareness is intentionally left unpinned.

---

## Reading awareness — what does each character know at a scene?

`get_knowledge(knowledge=..., at='<scene>')` returns the scene-resolved awareness state via two parallel fields:

- **`awareness`** — a nested object `{ levels, provenance }` carrying both the resolved awareness state and the per-observer provenance:
  - **`awareness.levels`** — dict keyed by observer entity id with their resolved awareness level at that scene. Use this for the simple "what level does X have?" lookup: `awareness.levels[<observer_id>]`.
  - **`awareness.provenance`** — per-observer record of WHERE each level came from. Only observers whose level was INHERITED from a group projection (via `sources` on `set_*_awareness`) appear here; observers with direct pins are omitted (their absence means "direct entry"). Each entry: `{ via: 'inherited', inherited_from: [{ kind: 'relationship', relationship_id, relationship_name, level, level_name }, ...] }`. The list contains every source whose projection contributed to the resolved level (ties at the max-level show all contributors).

The prose-writing workflow uses these constantly: before writing dialogue or action for a character, query their awareness of every Knowledge relevant to the scene. A character who's `Unaware` of a Knowledge can't reference it directly; one who's `Partially Aware` might allude cautiously; one who's `Fully Aware` can act openly. The provenance answers the SECOND question: "is this Unaware-ness a deliberate pin on this character, or do they inherit it from a group they're a member of?" — which matters because removing them from the group later would shift their awareness automatically.

```
get_knowledge(knowledge='Marcus is now Marisol', at='Hannah\'s Storefront')
# → {
#     ...,
#     awareness: {
#       levels: {
#         <marisol_id>: 'Fully Aware',   # Marisol knows herself
#         <eli_id>:     'Fully Aware',   # Eli learned at scene 6
#         <hannah_id>:  'Fully Aware',   # Hannah just learned this scene
#         <bram_id>:    'Unaware',       # village member, doesn't know
#         <ada_id>:     'Unaware',       # village member, doesn't know
#       },
#       provenance: {
#         # marisol / eli / hannah omitted → direct pins
#         <bram_id>: { via: 'inherited', inherited_from: [
#           { kind: 'relationship', relationship_id: '...',
#             relationship_name: 'Villagers', level: 0, level_name: 'Unaware' }
#         ]},
#         <ada_id>:  { via: 'inherited', inherited_from: [
#           { kind: 'relationship', relationship_id: '...',
#             relationship_name: 'Villagers', level: 0, level_name: 'Unaware' }
#         ]},
#       },
#     },
#   }
```

In this example a downstream reader can see that Bram and Ada are Unaware specifically because they're members of the `Villagers` relationship (which projects `Unaware` on this Knowledge), while Marisol / Eli / Hannah have their awareness pinned directly. If Ada leaves the `Villagers` group at a later scene via `remove_participants`, her Unaware-ness lifts automatically from that scene forward (no manual awareness call needed); Bram's stays put unless his membership also changes.

---

## Common Knowledge patterns

### Transformation reveals (the canonical case)

A character changes (identity, alignment, secret history). Knowledge tracks who has been let in. Pattern: scene-born Knowledge bound to the `update_entity` / `update_attributes` call that recorded the change via `track_as_knowledge`. Then `set_knowledge_awareness` per character as they learn / fail to learn / are deliberately misled.

### Secrets and lies

A character knows something is true but tells others it isn't. Pattern: two Knowledges — one for the truth ("Hannah is having an affair"), one for the lie ("Hannah said she's working late"). The character has `Fully Aware` on the truth; others have `Fully Aware` on the lie. The gap drives dramatic irony.

### Discovered facts

A pre-existing fact (standalone Knowledge) gets discovered by characters over time. Pattern: standalone `create_knowledge(...)` (no `scene` arg) sets the baseline (typically nobody is aware). Then `set_knowledge_awareness` per discovery scene.

### Plot deadlines / countdowns

"The summit is in 7 days" is a Knowledge that characters discover at different times and treat with different urgency. Same as discovered facts; the awareness level can map to how seriously they're taking it (`Nominally Aware` = "yeah, vaguely aware"; `Fully Aware` = "deeply preoccupied with").

---

## Awareness scale: binary vs full — which to pick

When creating a Knowledge, choose based on whether partial / nominal awareness is narratively meaningful for THIS specific fact:

- **`binary`** — Aware or Unaware, no middle ground. Use for hard facts: "The vault combination is 4-7-3-9", "Marcus is Marisol", "Hannah's password is BlueRose1837". You either know it or you don't.
- **`full`** — Fully / Partially / Nominally / Unaware (4 levels). Use for facts that have meaningful partial knowledge: "The Hartwood Conspiracy" (full = knows every detail; partial = knows there's a conspiracy but not who; nominal = heard a rumour). Reputation, ongoing alliances, gradual reveals.

Default to `binary` when in doubt. Upgrade to `full` only when you have a specific need for partial awareness levels to drive prose / decisions.

---

## Anti-patterns

1. **Creating a Knowledge for every fact.** Knowledge is a TRACKED object — it costs project complexity. Use it for facts where who-knows-what matters narratively. Don't create a Knowledge for "the sky is blue" or "Mira works at the forge" (the latter is just an attribute on Mira; everyone in the village can see it).
2. **Forgetting to bind to source events.** A scene-born Knowledge with no source-event link is reachable via the Knowledge object but not navigable from the entity / scene side. Use `track_as_knowledge` on the chain event whenever there's a clean 1:1 mapping.
3. **Mixing scene-born and standalone for the same fact.** Pick one. A transformation is scene-born (it happened at a scene). A backstory fact is standalone (it pre-dates the story). Don't oscillate.
4. **Using Knowledge when entity / attribute / relationship awareness would do.** If the only thing that varies between observers is a single entity's name (Marcus / Marisol per observer), that's `set_entity_awareness` territory — observer-perspective resolution of an existing chain change. Knowledge is the bigger, named, narratively-significant fact-as-object. Use the right granularity.
5. **Not reading awareness during prose writing.** A character who shouldn't know something but appears to know it in dialogue is the most common breakage of dramatic irony. Always query awareness for every relevant Knowledge before writing the scene's dialogue.

---

## Quick reference

| Operation | Tool |
|---|---|
| Create a Knowledge | `create_knowledge(name, ..., scene?, awareness_scale?)` |
| List all Knowledges | `list_knowledges()` |
| Read a Knowledge at a scene | `get_knowledge(knowledge, at=<scene>)` |
| Update a Knowledge's metadata | `update_knowledge(knowledge, name?, description?, colour?, profile_image_ref?, notes?, awareness_scale?, at?)` |
| Set one or more observers' awareness | `set_knowledge_awareness(knowledge, entries=[{observer, level, at?}, ...])` |
| Bind to a chain event | `track_as_knowledge={name, ...}` or `track_as_knowledge='<name>'` on any chain-event tool |
| Delete a Knowledge | `delete_knowledge(knowledge)` (destructive, gated) |
