# Workflow: Prose Writing

How to write prose into a scene's `main_content` using the full chain-resolved context. This guide is for when the plot is laid out and you're filling in the actual prose — character dialogue, action, description — that the reader sees.

This workflow assumes scenes already exist with their participants, time pins, circumstances, etc. set. If you're still planning the plot, start with the plot_planning workflow.

---

## Read phase — assemble the scene's reality

Before writing a single word of prose, gather the COMPLETE picture of what the world looks like at this scene. The chain-of-history model means this is non-trivial — character names, perceptions, relationships, and even attributes may have changed at upstream scenes. The walker resolves this for you; you just have to ask the right questions.

### 1. The scene itself

**`get_scene(scene='<scene title>')`** — returns:
- `title`, `description`, `main_content` (current state if you're revising)
- `pov_entity_id` (the POV character)
- `participants_by_type` (every entity present in the scene, with names walked to this scene)
- `circumstances` (scene-level situational state — weather, ambient mood, etc.)
- `time` block: pinned time-of-day / weekday / season / date / duration / gap_extension PLUS `time.derived` with walker-computed effective start ("Day 6 · Late Morning") and "time since prior scene" phrasing ("3 hours later" / "the next day").

**`get_scene_context(scene='<scene title>')`** — neighbours on the POV chain (`pov_prev`, `pov_next`), plus predecessors / successors on the entity-flow graph. Use this to know what the reader has just read (pov_prev's title) and what's coming next.

### 2. The POV character at this scene

**`get_entity(entity='<pov character>', at='<this scene>')`** — chain-resolved:
- `name` — what the character is CALLED at this scene (might differ from origin name)
- `description` — what they ARE at this scene
- `attributes` — values walked to this scene
- `aliases` — every alias that exists at this scene (including ones added at prior scenes)
- `notes` — free-form author notes (origin only)

The POV character's voice / perspective should reflect what THEY know and how THEY perceive the world AT THIS SCENE — not their origin baseline.

### 3. Every other participant at this scene

For each entry in `participants_by_type`: **`get_entity(entity=..., at='<this scene>')`** — same shape. You need their resolved name (they might be called something different now), their current attributes, their current description.

### 4. Active relationships involving these participants

**`list_relationships()`** to see which relationships exist, then for each relevant one: **`get_relationship(relationship=..., at='<this scene>')`**. This gives you:
- `participants` — who's currently a member
- `participant_roles` per entity (e.g. one is "Husband", the other "Wife")
- `participant_perceptions` — how each participant currently sees the other(s)
- `participant_alias_overrides` — the names they use for each other inside this relationship (e.g. Marcus calls his sister "Han"; she calls him "M")
- `status` — active or ended

Perception and alias-overrides especially matter for dialogue: if Eli's perception of Marcus shifted at scene 5 from "Trusted mentor" to "Stranger I don't recognise", that needs to be in Eli's voice at scene 6.

### 5. Knowledge that's relevant

For each Knowledge object: **`get_knowledge(knowledge=..., at='<this scene>')`** — returns:
- `name`, `description`, `colour`, `awareness_scale`
- `awareness` — a nested object `{ levels, provenance }`:
  - `awareness.levels` — dict keyed by observer entity id → their awareness level (`"Fully Aware"` / `"Partially Aware"` / `"Nominally Aware"` / `"Unaware"`) at this scene. Read as `awareness.levels[<observer_id>]` for the simple "what level does X have?" lookup.
  - `awareness.provenance` — per-observer record of WHERE each level came from. Observers whose level was inherited from a group projection appear here as `{ via: 'inherited', inherited_from: [{ kind: 'relationship', relationship_name, level_name, ... }, ...] }`. Observers with direct pins are omitted (their absence means "direct entry"). Use this when the scene has multiple characters from the same group (a faction, a court, a crew) — it tells you whether each character's awareness is a deliberate pin on them individually or a side-effect of their group membership, which informs how confidently you can lean on that awareness state in voice / behaviour.

This tells you what each character knows. CRITICAL for dialogue: a character who's `"Unaware"` of a Knowledge can't reference it directly; one who's `"Nominally Aware"` might allude to it cautiously; one who's `"Fully Aware"` can act on it openly.

**Unaware-in-the-same-scene is the engine of dramatic irony — render it deliberately.** A character who is in this scene AND unaware of a secret aspect of it (a hidden identity, a concealed alliance, a lie they don't know is a lie) is the most important narrative-state combination to get right in prose. The READER sees both the truth and the unaware character's reactions; the unaware character sees only the surface. Use it:

- **Word choice + perspective**: an unaware Eli looking at a transformed-but-disguised Marcus calls them by the new name, treats them as a stranger, describes only what's visible to him — never lets slip "Marcus's eyes" or any prior-state knowledge.
- **Misread interpretation**: the unaware character infers wrong things from accurate observations. "She seems nervous" when in fact the disguised protagonist is panicking about being recognised.
- **The reader-character gap**: small details the reader connects (a familiar gesture, a moment of fluster the unaware character ignores) build dramatic tension precisely because the unaware character DOESN'T connect them.

Always read awareness at THIS scene for EVERY character present, against EVERY relevant Knowledge / entity-change / relationship secret. If `set_*_awareness` was set to `Unaware` explicitly in plot-planning, you have a clear signal. If the awareness state is missing or implicit, treat it as a structural gap and either: (a) write the prose conservatively (don't put plot-critical info through this character's mouth or perspective) and surface the gap back to the structured layer afterwards, or (b) pause and ask the writer / set the awareness explicitly before continuing. Implicit-awareness leaks are the single most common way prose contradicts plot.

### 6. Circumstances and motivators — the engine of character behaviour

Circumstances and motivators are not background flavour. They're the structured reasons WHY characters act and feel the way they do at this scene. Read every relevant one and let them drive the prose. Without them, your characters become flat plot-pieces moving through their actions; with them, every line of dialogue and every gesture has motivated weight.

**Where to read them — three circumstance scopes, one motivator scope:**

- **Scene-level circumstances** — `get_scene(...).circumstances`. The state of the SCENE itself, affecting everyone present. "Pouring rain", "tense silence", "power's out". These shape ambient mood, what's possible (you can't whisper in a thunderstorm), what's distracting (the rain hammering the roof).
- **Entity-temporary circumstances** — `get_scene(...)` returns `entity_temporary_circumstances` per scene; these are one-off entity states that apply ONLY at this scene. "Soaked from the rain: Strong" on the character who just walked in. Use them for moment-specific framing (sodden clothes, dripping hair, shivering through dialogue).
- **Entity-chain circumstances** — `get_entity(entity=..., at='<this scene>').attributes`, filtered to `type='circumstance'`. Started at some prior scene and still in effect at this one. "Heartbroken: Strong", "Exiled: Moderate", "Sleep-deprived: Intense". These are the character's CURRENT durable inner state — they should colour everything from posture to word choice to which thoughts the character keeps coming back to.
- **Motivators** — `get_entity(entity=..., at='<this scene>').attributes`, filtered to `type='motivator'`. Inner drives — what the character WANTS, at this scene, with this intensity. "Wants Hannah to forgive him: Intense", "Wants to keep the secret: Strong", "Wants out of this conversation: Moderate". These are the engine that pushes the character to ACT — initiate the conversation, change the subject, leave the room, take the risk.
- **Perspectives** — `get_entity(entity=..., at='<this scene>').attributes`, filtered to `type='perspective'`. Each perspective carries a `target` (`{kind, id, name}` — another character, location, item, faction, custom entity, knowledge, or relationship) plus a `description` (the host's view on the target). These are what the character THINKS about specific other things in the story — their opinion of another character, their interpretation of a piece of knowledge, their read on a relationship. No intensity (perspectives are description-only). Critical for: dialogue subtext (when Marcus speaks TO Hannah, his perspective on Hannah colours every word he picks); internal narration in POV scenes (the POV character's perspective on whoever they're observing tints how the prose describes them); reaction shots (a non-POV character reacting to someone they have a strong perspective on reacts AS THAT PERSPECTIVE, not as a generic neutral observer). When a perspective's `target` is `null` (orphaned by a cascade-delete of the target object), the description body still carries narrative content — render it as the character's residual feeling about something that's now gone.

**Each has a 5-level intensity** returned as a canonical name string. May also be unset (null / absent) when no level has been pinned — distinct from `'Faint'` (the lowest real tier, which IS pinned):

| Intensity | Weight | Prose translation |
|---|---|---|
| `null` / unset | 0/5 | No level pinned. The circumstance / motivator is in effect but the writer didn't commit to a relative weight. Render at whatever weight the scene's other signals suggest. |
| `Faint` | 1/5 | Background hum. Character is mostly aware they're tired / wants something, doesn't drive behaviour visibly. A quiet sigh, a hesitation, a moment of distraction. |
| `Mild` | 2/5 | Noticeable but manageable. Surfaces in pacing, word choice, small physical tells. The character keeps going but with friction. |
| `Moderate` | 3/5 | Actively shaping behaviour. Influences major decisions in the scene. The character is making different choices than they would without it. |
| `Strong` | 4/5 | Dominates. The character is fighting it (or surrendering to it). Most lines of dialogue and most actions trace back to this state. |
| `Intense` | 5/5 | Overwhelming. The character may act against their own interests, fail at routine tasks, or do something they would normally never do. This is the scene's emotional centre. |

**How they combine — read the whole stack, not just the loudest item.** At any scene a character has a STACK of these, all in effect simultaneously. The loudest typically tints the prose most, weaker ones tint at the edges, AND items pulling in opposite directions matter as much as items pulling in the same direction. Intensities are a GUIDE, not a strict greater-than/less-than decider — two `Moderate` items pulling the same way easily out-tint one `Strong` item pulling the other way, especially when a third `Mild` circumstance frames the moment. A character with `Heartbroken: Strong` + `Exhausted: Moderate` + `Wants reconciliation: Intense` reads as: dragging through the scene physically, snapping at small things, but every line of dialogue circles toward whatever might fix things with the person they hurt — even when it makes them sound desperate.

**Conflicting items in the stack are an INVITATION, not a problem.** When a character has two active motivators or circumstances pulling in opposite directions, the most interesting prose surfaces the friction itself. Don't write a flat "she did X because [winning motivator] won" — render the cost: the half-second hesitation, the line of dialogue that comes out slightly too clipped, the over-correction, the physical tell that betrays the suppressed side. A character with two motivators of comparable weight pulling opposite directions makes for richer prose when the prose shows BOTH simultaneously — the chosen action AND the visible tell of the part they suppressed to take it (a held smile that doesn't reach the eyes, a hand that tightens on a glass, a sentence that lands a beat late). The structured layer captured both items deliberately so the prose can render both, not so the prose can collapse them into an outcome.

**Read every present character's stack, not just the POV character's.** Non-POV characters drive the scene through their own active stacks. The POV character is reacting to FORCES the scene's other characters are generating — a side character whose stack includes a strong motivator pushing toward some outcome actively pursues that outcome regardless of what the POV character feels about it, and the prose should let them do it (lean in, push the conversation, withhold, escalate, offer, demand — whatever their motivators point at). Non-POV stacks make the scene's pressure REAL rather than imposed by the writer; the POV character's experience is what it FEELS like to be on the receiving end of the other characters' agency.

**A worked example.** Eli (POV, age 24, blacksmith's apprentice) at Scene 7. Reads:

- Scene-level: `Pouring rain: Moderate` on the scene.
- Eli entity-chain: `Confused: Strong` (started at scene 6 when he found a stranger in his master's loft), `Loyal to Marcus: Intense` (baseline from origin).
- Eli motivators: `Wants to find out what happened to Marcus: Intense`, `Wants this stranger out of Marcus's house: Strong`.

The naive prose:
> "Who are you?" Eli asked. The woman didn't answer.

The motivated prose:
> Eli's hand went to the doorframe, gripping it. The rain on the roof was loud enough that he had to raise his voice. "Who are you." It wasn't a question, not really. He couldn't make himself believe what he was seeing, and the woman in Marcus's shirt only looked back at him like she was waiting for him to say something else.

The second version uses: the rain (scene-level), his white-knuckled grip (Confused: Strong), the demand-not-question (Wants stranger out: Strong), the inability-to-process (Loyal to Marcus + Confused interacting), the visible waiting from the woman (a beat of motivation tension). Every detail traces to a structured input from the read phase.

---

## Plan phase — decide the scene's arc

Before writing, sketch:

- What's the scene's PURPOSE in the larger plot? (the writer's intent — often hinted by `description`)
- What changes from start to end of this scene? (look at scene-anchored writes recorded at this scene via `get_entity(at='<this scene>')` vs `get_entity(at='<prior scene>')`)
- What does the POV character want? (their motivators)
- What stands in the way? (relationships, circumstances, knowledge gaps)
- How does the scene OPEN — what's the first beat the reader sees?
- How does it CLOSE — what's the last beat?

The opening and closing beats are usually the most important. Anchor them, then write the middle.

---

## Write phase — fill main_content

**`update_scene(scene=..., main_content='<TipTap HTML>')`** overwrites the scene's prose entirely (not append).

### Supported HTML

- `<p>` paragraphs
- `<h1>` – `<h6>` headings
- `<strong>` / `<em>` / `<u>` / `<s>` (bold / italic / underline / strikethrough)
- `<ul>` / `<ol>` / `<li>` lists
- `<blockquote>`
- `<code>` / `<pre><code>` (inline / block code)
- `<mark>` highlights (optional `style="background-color: ..."`)
- `<span style="color: ...; font-size: ...; font-family: ...">` for text styling
- `<br>` line breaks

NOT supported: `<a>` links, `<img>` images, scripts, arbitrary attributes — they're stripped on load by the editor.

### Prose conventions

- **Use the chain-resolved name** for each character when you reference them, not their origin name. If Marcus has been called Marisol since scene 4, references to her at scene 6 should say Marisol (or whichever alias the POV character uses for her — see participant_alias_overrides on active relationships).
- **Tie dialogue and action to what each character KNOWS.** A character unaware of Knowledge X cannot reference X — not by name, not by implication, not via a knowing glance at the X-bearing person. A character partially aware of X might dance around the subject without naming it directly. When you spot an `Unaware` observer present in the scene with an X they don't know about, render the dramatic-irony gap deliberately (see Read Phase Step 5): use the unaware character's perspective + word choice to show only what they can see, and let the gap between their interpretation and the reader's knowledge carry the tension.
- **Drive the prose with circumstances and motivators, don't decorate around them.** These are the structured ANSWER to "why is this character acting this way at this scene." Read every relevant circumstance + motivator first (see "Read phase" Step 6); the strongest ones should be visible in the prose. A character with `Exhausted: Strong` doesn't just feel tired — they move slower, snap easier, make poorer choices, miss details a sharper version of them would catch. A character with `Wants reconciliation: Intense` doesn't just hope; they steer every conversation toward it (or, if they're proud, actively avoid it in a way that's just as visible). When you find yourself writing a line that doesn't trace back to a structured input (circumstance, motivator, relationship perception, awareness state, time pin), pause and check — usually there's a chain-resolved fact that should be shaping it.
- **Respect the time pin.** A scene pinned for Midnight should READ like midnight (quieter, darker, fewer characters around). A scene pinned for Late Morning should feel bright, busy.
- **Use the relationship's perception**, not the character's neutral view. If Eli currently perceives Marcus as "Stranger I don't recognise", Eli's narration should treat Marcus that way — even if from an omniscient view they're old friends.

### After writing

The scene's `main_content` is the prose for THAT scene. If the prose introduces a fact that downstream scenes should know about (e.g. a new Knowledge was learned, a relationship perception shifted), go back and record those as scene-anchored writes. Prose is the FACE of the change; structured tools are the BACKBONE.

---

## Editing pass

When revising:

1. Pull the current prose: `get_scene(scene=...)` → `main_content` field.
2. Read the scene again with chain-resolved context (the "Read phase" above) — make sure your edits don't contradict an upstream chain change you forgot about.
3. Edit + send the new prose via `update_scene(main_content=...)`.

If you find the prose contradicts an upstream truth (e.g. you wrote "Eli grins at Marcus" but at scene 4 Eli's perception of Marcus shifted to "Stranger I don't recognise"), choose:
- Update the prose to match the chain truth, OR
- Update the chain truth (via `set_participant(... perception=...)` at the appropriate scene anchor, or the entity / attribute / awareness setters) to match your prose intent.

Either is valid — but the two need to agree.

---

## Common mistakes

1. **Writing prose with the character's ORIGIN values** when the chain has updated them. The reader sees what the chain resolves to at THIS scene, not the baseline. Always read `get_entity(at='<this scene>')`, not `get_entity()` alone.
2. **Letting a character reference Knowledge they're not aware of yet — or worse, letting their narration leak it.** Check awareness at the scene before putting plot-critical info in their dialogue. The leak is often subtle: an unaware character calling someone by their pre-transformation name, recognising a "familiar" gesture they shouldn't recognise, "noticing" a detail that only the reader (or an aware character) should be tracking. Treat every `Unaware` observer present in a scene as a contract: that character's entire perspective in the prose stays inside what they can actually see and infer.
3. **Ignoring relationship perception drift.** Two characters who used to be friends but are now estranged should read as estranged — their dialogue, body language, what they say about each other in narration.
4. **Skipping the time-pin context.** "Day 6 · Late Morning" is information the prose should use — light, atmosphere, who else is likely awake / present.
5. **Treating each scene as a standalone short story.** The chain-of-history model means scenes COMPOUND — what's in scene 7's prose has to honour everything that happened in scenes 1-6.
