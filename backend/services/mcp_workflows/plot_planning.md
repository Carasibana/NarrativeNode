# Workflow: Plot Planning

A scene-by-scene approach for building out a story with NarrativeNode. The core idea: **scenes build on prior context**, so plan them in order, reading the chain-resolved state of what's there before adding what's new.

This is the natural workflow for: outlining a new story; turning a premise into a plot; building on top of an existing story.

A note on vocabulary: when this guide says "cast" or "starting set", it covers EVERY entity type — characters, locations, items, factions, and custom entities. The chain-of-history model applies uniformly: a location's atmosphere can change at a scene the same way a character's name can; an item can pass from one owner to another via a scene-anchored attribute update. Don't restrict your mental model to characters.

---

## Foundational principle: RELEVANCE OVER COMPLETENESS

Every tool in this surface is available to you when its data matters narratively. **No tool is a checkbox to be ticked.** Specifically:

- **Don't pin a `time_of_day` / `weekday` / `date` / `duration` / `gap` value because the field exists.** Pin it because the time / day / span is narratively load-bearing (a Sunday brunch scene, a heist that hinges on midnight, a flashback dated five years earlier). For most scenes most of these fields should be left UNSET. The derived display gracefully shows whatever precision you committed to (`Day 6 · Night`, or just `Day 6`, or just `Week 2`) — leaving fields unset is the SYSTEM HONOURING YOUR LACK OF COMMITMENT, not data missing. Pinning values you don't actually care about commits the writer to specifics they didn't decide on and produces spurious chain-time alerts when adjacent scenes shift.
- **Pin awareness when an observer's specific level shapes the narrative** — their not-knowing creates dramatic irony, their knowing drives a future scene, their learning is itself a plot beat. `Unaware` and `Fully Aware` are equally concrete declarations, both used by the chain walker to resolve scene-from-perspective reads. `Unaware` is the right pin whenever an observer is present at or downstream of a secret-bearing change and their continued not-knowing materially shapes how they read the situation. "No awareness pinned" is also a valid state — it means the observer's awareness of this object has no bearing on the story. See Step F / Step G of Phase 3 for usage.
- **Don't fill in motivators / circumstances / attributes / aliases for "completeness."** Each one is a narrative commitment that will shape every downstream scene's read. Add only what the story needs. A character with three real motivators is more useful than a character with ten generic ones.
- **Don't `add_circumstances` at scene-level for every scene.** Scene-level circumstances are for environmental states that meaningfully affect the scene's mood / action / character behaviour ("Pouring rain", "Tense silence after the argument", "Power's out"). Most scenes have none and that's correct.

**The general test before any write: "Why does this specific value at this specific anchor matter to the story?"** If the answer is "it doesn't, I'm just being thorough" — don't write it. Empty / unset fields are not gaps to be filled; they are explicit "this doesn't matter narratively" declarations.

The structured-data layer's job is to capture what the writer has committed to, not to produce a fully-populated grid of every queryable field. Over-population produces noise on the chain, false signal for downstream readers (every pin reads as deliberate), and constrains the writer's future flexibility.

---

## What "origin" means (read this before Phase 1)

Every entity, relationship, knowledge, attribute, alias, and awareness state has TWO things: a **baseline at its origin** ("this is the entity's state as it begins in the narrative") and a **chain of changes** at specific scenes ("this is what changed and where after that"). Every write tool that touches one of those takes an `at` arg that picks which one you're writing:

- **`at` omitted, `at=null`, or `at='origin'`** → **BASELINE write**. You're saying "this is the entity's state as it begins in the narrative." Use when setting up the world during Phase 1 / Phase 2, OR when correcting a baseline mistake you made earlier.
- **`at='<scene UUID or scene title>'`** → **SCENE-ANCHORED write**. You're saying "this changed AT this scene." The change propagates forward to every downstream scene from that anchor. Use when something happens in the story to change the prior state.

Read tools take the SAME `at` arg to control which view you see:

- **`get_entity(entity=...)`** with no `at` → returns the origin baseline (the starting state).
- **`get_entity(entity=..., at='<scene>')`** → returns the chain-resolved state AT that scene (baseline + every change up to and including that scene).

The decision tree before any write: **did this fact change because of something that happened in a scene?** If yes → scene-anchored. If no (it was true from the entity's introduction onward, you just hadn't recorded it yet) → origin. Picking wrong silently corrupts the chain: a hair-colour change written at origin instead of at scene 7 would make the character have the new colour at scene 1 too — the chain treats origin as the entity's STARTING state, so anything written there is the value before any scene plays out.

Phase 1 / Phase 2 below are origin work (no `at`). Phase 3's per-scene loop is mostly scene-anchored work (`at=<this scene>`). The cadence flips at Phase 3 — keep an eye on it.

---

## MCP session lifecycle

Write tools require an active MCP session; read tools don't. Call `request_mcp_session(purpose=...)` before the first write, and `end_mcp_session(summary=...)` (summary REQUIRED, non-empty) when done , the user reviews that summary alongside the tool-call log before returning to idle. Full arg detail is in those two tool descriptions.

---

## Phase 1 — Story shell

Before any scenes, get the project oriented. **Only create what you need.** Skip any sub-step that doesn't apply.

1. **`get_project_summary()`** — see what's in the project (counts, story seeds). Empty project = fresh start; populated = working on an existing story.
   - **If the project is populated, also call `list_alerts()`** to triage outstanding workflow issues (uninstantiated entities, orphaned perspectives, POV chain gaps, awareness contradictions, etc.) before authoring , clean obvious orphans so they don't compound, or note them for the writer. Read-only, no session required. The full kind-filter list, return shape, and per-alert payload are in the `list_alerts` tool description; drill into any alert with `get_entity(at=...)` / `get_knowledge(at=...)` / `get_relationship(at=...)`.
2. **`update_story(title="...")`** — set the story title.
3. If the story uses recurring shared values across multiple entities (e.g. a "Gender" preset reused on every character), set those up now:
   - **`create_preset_list(name=..., values=[...])`** for each shared list.
   - **`add_story_seed(entity_type='character', name='Gender', attribute_type='preset', preset_list='Gender')`** to auto-attach the attribute to every future character.
   - Two flavours of seed:
     - **Attribute-only seed** — auto-attaches the attribute shape (name + type + optional preset list ref) but leaves the value blank. The AI fills it in per entity. Use when the value genuinely varies per entity (every character has a Gender attribute but the value differs).
     - **Attribute-with-default seed** — same as above but also pre-populates a default value. The AI overrides per entity only when needed. Use when there's a common default that most entities will keep (e.g. every character defaults to "Alive" status; transformations / deaths override).
   - Seeds only apply going FORWARD. They don't retroactively populate entities that already exist.
4. If the story has fungible templates (e.g. lots of generic Goblins, lots of "Ancient Oak Trees"), create the categories:
   - **`create_custom_category(name='Goblin')`** then later `create_entity(type='custom', name='Snub', category='Goblin')`.

## Phase 1.5 — Optional: chapters and acts

Skip this phase if the story doesn't benefit from chapter/act structure (a short scene-cluster, a draft, a one-act play). Use it when the story has natural divisions the writer wants to track — a novel, a multi-arc narrative, anything where act/chapter boundaries matter for pacing or reader navigation.

Skip Acts if only Chapters are beneficial. 

When using chapters/acts, scaffold them BEFORE building scenes so scenes can be assigned to them as they're created:

1. **`create_act(title=..., chapters=[...])`** per act, rough draft. Acts group consecutive chapters; the `chapters` arg is required (an act with no chapters isn't meaningful), so create the chapters first.
2. **`create_chapter(title=...)`** per chapter inside each act, rough draft. Title can be a working title — you'll likely refine as the plot crystallises.
3. Don't lock yourself in: as the plot evolves, freely **`update_chapter(...)`** / **`update_act(...)`** to rename / re-colour / re-bound, and **`create_chapter(before=...)`** / **`create_chapter(after=...)`** to insert chapters between existing ones (every downstream chapter renumbers, scenes shift to preserve their original chapter membership).

The rule of thumb: act/chapter structure is scaffolding. It serves the narrative, not the other way around. If you're three scenes into Chapter 2 and realise the act break should have been after scene 2 instead of scene 4, just move it.

## Phase 2 — Initial cast

Define the entities present at the very start of the story. **Only the ones who appear in or shortly after the opening scene** — don't try to pre-populate every entity you might ever need. New entities should be added the moment they're first relevant, not earlier.

"Cast" here covers every entity type: starting characters, starting locations, starting items in someone's possession, starting factions / groups, starting custom entities.

For each initial entity, you can set up the full origin state in just a few calls thanks to the batch tools:

1. **`create_entity(type=..., name=..., description=..., colour=..., attributes=[{name, attribute_type, value? / number_value? / file_ref? / preset_list? / values? / description? / intensity?}, ...], aliases=[{value: 'Marc'}, {value: 'M.T.'}, ...])`** — sets baseline AND all starting attributes AND all starting aliases in ONE call. Each attribute object inside the `attributes` list carries the same per-attribute fields the singular tool used to take. Aliases are objects `{value: <string>}` (same per-item-object shape as `attributes`). Bare strings (`aliases=['Marc']`) are accepted as shorthand and auto-promoted, but prefer the object form for shape-consistency. Both batch args are optional — omit them when there's nothing to add yet. Single-attribute or single-alias case is still a list: `attributes=[{...}]`, `aliases=[{value: 'Marc'}]`.

   **For CHARACTERS specifically, include physical characteristics as attributes.** These are the per-character details that the prose-writing workflow (and the reader, indirectly) will rely on — and they're often the things that CHANGE downstream via a chain entry (a haircut, a scar, a transformation, weight loss / gain, ageing). Common physical attributes to set up at origin: `Age` (number), `Gender`, `Hair colour`, `Hair style`, `Hair length`, `Eye colour`, `Skin tone`, `Height` (number, with whatever unit fits the setting), `Build` / `Body type`, `Bust` / `Chest`, `Distinguishing marks` (scars, tattoos, birthmarks — often a `text_list`), `Voice`. Tailor the set to the story: a regency romance might care about `Bust` and `Hair style` per character but not `Build`; a fantasy adventure might add `Species`, `Eye colour glows-when` (text), or `Magical aura colour`. Pick the attributes the writer would actually want to query or change — don't fill the entity with every conceivable attribute "just in case."
2. If you need to add more attributes / aliases to an existing entity later (e.g. after deciding the character has another structured fact), use **`add_attributes(entity=..., attributes=[...])`** and **`add_aliases(entity=..., aliases=[{value: ...}, ...])`** — same batch shape, one call regardless of count.
3. If two entities have a baseline connection from the start (siblings, married, employer / employee, member of a faction, owner of an item, contained-in for nested locations), create it now:
   - **`create_relationship(name=..., participants=['entity1', 'entity2', ...], roles={'entity1': 'Mentor', 'entity2': 'Apprentice'})`** — establishes the baseline with participants and roles in one call. Both args are optional; you can also add participants later via **`add_participants(relationship=..., participants=[{entity, role?}, ...])`**.
4. If an entity has BASELINE circumstances or motivators — situational state or inner drives true from the story's opening onward — add them at origin:
   - **`add_circumstances(target=<entity>, circumstances=[{name, description, intensity?}, ...])`** for situational states (e.g. a character is `Exiled: Strong` from the story's start, or a location is `Cursed: Mild` as backstory). This baseline form is chain-tracked and propagates forward from the entity's origin; other circumstance scopes (scene-level, entity-temporary, entity-chain-added-at-a-scene) are covered in Phase 3 Step D.
   - **`add_motivators(entity=<entity>, motivators=[{name, description, intensity?}, ...])`** for inner drives a character has from the start (e.g. `Wants to escape the village: Strong`). Motivators are character-only.
   - Baseline circumstances and motivators are NOT just background flavour. During Phase 3 they become the primary structured input for deciding what each character WOULD plausibly do at each scene. A character with strong starting motivators is a character who drives scenes; a character with strong starting circumstances is a character whose behaviour is shaped by their condition before the story even begins. Put real thought into these — they're the engine that makes scenes happen.
   - **Apply this to NON-POV / secondary characters too.** It is tempting to thin out side-character motivator stacks (e.g. one-line "wants to help") and reserve the rich stacks for the POV character. Resist this. Side characters whose stacks are skeletal become props the POV character moves through; side characters whose stacks are real generate the FORCES in the scene that the POV character has to react to. Whenever the writer's premise calls for the POV character to be pursued, set up, escalated against, opposed, helped, manipulated, mentored, or simply pressured — those events arrive organically when the OTHER characters in the scene have real motivators of their own driving the behaviour. Secondary-character stacks are how the writer's intended events surface *plausibly* through other-character agency rather than feeling imposed by authorial fiat. Spend the call cost: every character present in a scene that matters deserves a real stack.
5. If an entity has BASELINE perspectives — opinions / feelings / interpretations it holds about OTHER objects in the story from the opening onward — add them at origin:
   - **`add_perspectives(entity=<entity>, perspectives=[{ description, target: { kind, ref } }, ...])`** — `target.kind` is one of character / location / item / faction / custom / knowledge / relationship; `target.ref` is the target's UUID or exact name. The target must already exist (create entities + knowledges + relationships first; perspectives reference them). Each entry needs a description (the perspective body — what the host thinks / feels / believes about the target). No intensity.
   - Where motivators and circumstances answer "what drives this character" and "what's their current situation", perspectives answer **"what's their opinion of <specific other thing in the story>"**. A character might motivator-want to escape, circumstance-be-trapped, and ALSO have a strongly-felt perspective on the warden ("Cruel but professional — won't snap unless pushed; pushed-hard means lethal"). The three feed the AI different inputs at scene-write time.
   - Like motivators / circumstances, this matters for non-POV characters too. Secondary characters with real opinions of the POV character (and of each other) make scenes feel populated by agents whose internal states differ from the POV's. Otherwise side characters' reactions read as authorial echo of the POV's view.

**Typical call count per character**: 1 `create_entity` (with batch attributes + aliases) + 1 `add_circumstances` + 1 `add_motivators` + 0–1 `add_perspectives` = 3–4 calls to fully define a character with N attributes, M aliases, K circumstances, J motivators, P perspectives, regardless of how big N/M/K/J/P are. Add 1 more if the character has a baseline relationship that doesn't already exist (`create_relationship`).

### Attributes vs. description: the test

When you have a fact about an entity and you're deciding where to put it:

1. Does this fact have a clear NAME and VALUE? ("age = 32"; "profession = blacksmith")
2. Would the AI / writer ever want to query this fact directly? ("how old is Marcus?")
3. Could this fact change at a specific scene later? ("was a blacksmith, becomes a captain at scene 12")

If yes to ANY of these → use an attribute.

Use description for free-form prose framing that doesn't have structured shape: voice / tone notes ("speaks in clipped sentences when nervous"), background colour ("a quiet, sturdy man who lets his work speak for him"), atmosphere ("the kind of room that feels colder than it is").

**Don't write narrative-content facts into description.** Bad: "Marcus is a 32-year-old blacksmith with a sister named Hannah." Good: split into a `Profession: 'Blacksmith'` attribute, an `Age: 32` attribute, and a `Sibling` relationship with Hannah; description becomes "Quiet, sturdy. Lets his work speak for him."

## Phase 3 — Scene-by-scene loop

This is where most of the work happens. Build scenes ONE AT A TIME, in story order, and FINISH each scene before moving to the next: create it AND record everything that changes at it (Steps D-G: participant changes, circumstances, motivators, relationships, knowledge, awareness) before you start the next scene. Recording changes AS YOU GO is not just bookkeeping. The factors you note at scene N (a new motivator, a shifted relationship, a fresh circumstance) are exactly what Step A and Step B read to drive scene N+1's decisions. Building all the scenes first and backfilling the changes afterwards is not wrong, but it forfeits that benefit: the changes can no longer inform scene-planning that has already happened, so the narrative decisions end up made without them. Record each scene's changes at the scene where they happen, as you build forward.

For each scene N:

### Step A — Read prior context

Before writing scene N, read scene N-1's resolved state so you know where the world stands.

**The fast path: `get_scene(scene='<scene N-1>', verbose=true)`** — one call returns the full composite snapshot for the prior scene: participants with full chain-resolved entity state (chain-walked name + colour + aliases, grouped attributes / circumstances / motivators per participant, chain_resolution provenance), scene-level circumstances, entity-temporary circumstances scoped to that scene, active relationships at the scene (each scene-resolved), AND every knowledge with its cumulative awareness map (who knows what). This is the read you want for "tell me everything about the prior scene before I plan the next one" — it replaces several per-participant / per-relationship / per-knowledge calls with one round-trip.

If you need to navigate before reading (or you only need a thin slice), the granular reads are:

1. **`get_scene_context(scene='<scene N-1>')`** — neighbours, chapter, POV index.
2. **`get_scene(scene='<scene N-1>')`** — lean default state (participants list, time, scene-level circumstances, walker-derived chain position) — omit `verbose` when you don't need the chain-resolved per-participant deep state.
3. For one specific participant: **`get_entity(entity=..., at='<scene N-1>')`** — chain-resolved values (name, attributes, aliases, motivators, circumstances). CRITICAL: this is how you see scene-anchored changes that landed on a prior scene (e.g. a character renamed themselves at scene 3 — you'll see the new name at scene 4, not the origin name).
4. For one specific relationship: **`get_relationship(relationship=..., at='<scene N-1>')`** — perceptions, roles, aliases as they stood.
5. For one specific knowledge: **`get_knowledge(knowledge=..., at='<scene N-1>')`** — cumulative awareness at that scene.

**Default to `get_scene(..., verbose=true)` for the orient-yourself read.** Drop to the granular calls when you need targeted detail or want to navigate without the heavier composite payload.

### Step B — Plan the scene

Decide:

- **The premise** — what happens narratively at this scene? This goes into the scene's `description` field (not `main_content`, which is for prose). A scene's description is a short summary visible in list_scenes and get_scene_context — it's how the writer (and other AI calls) recognise the scene at a glance. One or two sentences capturing the beat.
- **Who would plausibly DO what — read EVERY character's active stack, not just the POV character's.** Circumstances and motivators are structured inputs for figuring out what each character would do at this scene. For each character present, read their full active stack: motivators (`get_entity(...).motivators`), entity-chain circumstances (`.circumstances`), plus any prior scene-level / entity-temporary state from Step A. The POV character's stack obviously matters; **non-POV characters' stacks matter just as much** — they're the ones generating the friction the POV character has to react to.

  **Read the WHOLE stack, not just the strongest item.** A character isn't driven by their single strongest motivator any more than a real person is. They're driven by the *interaction* of everything currently active: a baseline `Wants approval: Intense` reads completely differently when paired with `Tired and short-tempered: Strong` than when paired with `Sharp and ambitious: Strong`. Look at the stack as a whole and ask what KIND of choice it produces. Intensities are a guide for which items are loudest at this moment, not a strict greater-than/less-than decider — two `Moderate` motivators pulling in the same direction can easily outweigh one `Strong` motivator pulling the other way, especially if a third `Mild` circumstance tips the framing.

  **Conflicting motivators / circumstances are NARRATIVELY VALUABLE — render the conflict, not just the outcome.** When a character has two active items pulling in opposite directions, that's the most interesting thing about the scene. Don't collapse it into a flat "X won, here's what they did." Render HOW the conflict resolves: what gives way under pressure, what gets rationalised, what gets suppressed and (importantly) WILL SURFACE LATER as a new circumstance. A character who agrees to something against their grain because a different motivator outweighed their resistance is doing something more interesting than a character who agrees because they wanted to. Capture both sides explicitly — both motivators stay on the chain, the scene's `description` notes which one tipped the decision and at what cost, and the cost can land at the next scene as a new circumstance (`Regretting what she agreed to: Moderate`) that the chain will carry forward.

  **Non-POV characters PUSH the narrative through their own motivators — give them real ones.** It is tempting to give side characters thin motivator stacks (one-line "wants to help" / "is loyal") and treat them as scenery the POV character moves through. Don't. Every character who matters enough to be present in a scene benefits from a real motivator stack — what THEY want, with intensities, that they will pursue THROUGH the scene regardless of what the POV character is doing. The setups, pressures, helps, betrayals, escalations, and confrontations the writer intends to happen become *plausible* because the non-POV characters' stacks make them inevitable — the POV character is reacting to FORCES IN THE SCENE, not to a writer imposing beats. When the writer wants a particular outcome to arrive (an opportunity surfaces, a tension escalates, a confession lands, an offer is made), the way to make that outcome arrive *organically* is to put the motivators that push for it on the OTHER characters' stacks. Side characters with motivators in tension with each other (one ally pushing the POV character forward while another pulls them back) generate the richest scenes of all.

  **When the plot needs a character to act against their motivators, that itself is a scene-worthy moment** — make sure the reason is on the chain too (a new circumstance overriding, a new motivator added at this scene, an intensifying internal conflict the reader can see).

  **Worked example — internal conflict on a single decision:** the POV character at some scene has FOUR stack items active simultaneously, two pulling one direction, two pulling the other: motivator A `Wants thing X: Intense` and motivator B `Doesn't want consequence Y that getting X requires: Strong` (genuine internal tension on the POV character's own goal), plus circumstance C `Recently hurt by [past event]: Strong` (carry-forward from earlier scene) and scene-temporary D `Pressed for a decision in this moment: Strong` (the scene's immediate forcing function). Another character present has their own stack pushing for outcome X to happen. The interaction: the other character's stack is actively engineering the moment (their motivator drives the scene's external pressure). The POV character's decision isn't a flat "Intense beats Strong, X wins." It's: X happens *because* A is loudest right now under D's time pressure, *despite* B being a real ongoing objection, AND the choice generates a new chain-tracked circumstance (`Compromised to get X: Strong` or `Resenting having to pick: Moderate`) that surfaces at the next scene as the decision's residue. Both the four-item stack AND the new circumstance are visible in the data; the prose-writing pass downstream can render the internal friction because the structured layer captured both sides explicitly.

  **Modeling "external performance vs internal experience" — use NAMING and AWARENESS, not new tool primitives.** When a character is performing one thing externally while experiencing something different internally (acting enthusiastic to please someone, smiling through nervousness, faking confidence) the structured layer already supports the split — you just have to be deliberate. Two complementary patterns:
  - **Name the items so the split is obvious.** A scene-temporary circumstance `Externally: laughing along with the joke: Strong` paired with a scene-temporary `Internally: hoping they change the subject: Strong` reads to a downstream prose pass as a clear performance / experience pair. A motivator `Performing being into this to keep up the act: Strong` is unambiguous about what it represents. The names ARE the channel; the structured layer doesn't need an `internal: true` flag because the value's NAME carries the semantic.
  - **Use awareness to encode "who can see which side."** Set the internal circumstance's awareness so the POV character is `Fully Aware` (she knows she's faking it) and the other characters present are `Unaware` (they buy the performance). The external-performance circumstance gets the inverse: everyone reads the performance, the POV character knows it's a performance. Now a prose pass calling `get_entity(POV, at='<scene>')` for the protagonist's perspective AND `get_entity(POV, at='<scene>')` resolved through another character's awareness lens sees TWO different effective stacks: the protagonist's internal truth vs what the other character is reading from them. Only pin awareness on observers whose seeing-the-performance-vs-knowing-the-truth matters narratively (relevance gate still applies).

  Practical effect: the structured layer captures both the masked feeling and the mask itself, separately, in a way the prose pass can voice from either side without inventing new primitives. No `visibility: 'internal' | 'external'` flag needed — the naming convention plus the awareness layer already cover it.
- **Who's there** — every entity present in the scene (characters, locations the scene takes place in, items that matter, factions whose members are involved).
- **Where + when** — but with deliberate vagueness on details that don't matter. The time / date / weekday / season system is INTENTIONALLY granular-to-match-what-you-actually-set — derived displays use the same level of precision as the pins. If you only ever pin "Day" / "Night" the derived display shows `Day 6 · Night`; if you pin no time-of-day at all you get `Day 6`; if you pin nothing time-related you get `Week 2` or similar. **This is not a bug**, it's the system honouring the writer's level of specificity. Most narratives don't need precise times and benefit from leaving the pin level loose. **DO NOT pin specific times / dates / durations unless they are ACTUALLY RELEVANT to the story.** Over-pinning locks in details the writer hasn't committed to and produces spurious chain-time alerts when adjacent scenes shift. Under-pinning gives the writer freedom and the chain math degrades gracefully.
  - Pin each field ONLY when it's narratively load-bearing, at the loosest tier that carries the meaning: **time_of_day** (broad `'day'` / `'night'`, or one of the 15 labelled values, or exact `'HH:MM'` only when precision is the point), **weekday** (a Sunday brunch, a first-day-of-school Monday), **season** (visible Winter snow, Summer heat), **date** (a birthday, a deadline), **duration** (how long the scene runs; feeds the gap-to-next-scene math), **gap** (elapsed time since the prior scene, when "three days later" is deliberate). The exact accepted shapes , the 15 labelled time values, the `duration={kind, ...}` forms, `gap={unit, value}` , are all in the `create_scene` tool description; don't reprint them, just decide relevance. The principle: under-pinning gives the writer freedom and the chain math degrades gracefully; over-pinning locks in details that may need revising and triggers spurious chain-time alerts when adjacent scenes shift.
  - **Concrete duration footgun — read this.** Durations are not just labels; they FEED the chain math that computes the start time of the next scene. **Pin a duration only when the duration is narratively load-bearing** (the timer-based plot, the heist that takes exactly 90 minutes, the wedding that runs from 2pm to 11pm). If you pin a 4-hour duration on an evening scene "to be thorough" — and the next scene is pinned `Midnight` — the chain math correctly concludes you skipped one full day, because 4 hours after 23:30 is 03:30 the NEXT morning, so the next `Midnight` pin has to be the FOLLOWING night. The derived display will say "the next day" and it will be RIGHT given what you committed to. The fix is not to chase the display: **the fix is to not pin the duration in the first place** when it doesn't matter. The same applies to `gap` — only pin when the elapsed time between scenes is narratively load-bearing. Most scene-to-scene transitions don't need either; the walker's auto-floor handles them gracefully.
- **What CHANGES happen at this scene** that downstream scenes need to know about — a character learns something, a relationship forms or shifts, an item changes hands, a circumstance starts, a name / appearance change, etc. These are the scene-anchored writes that propagate forward.

### Step C — Create the scene

**`create_scene(title=..., description=..., pov_character=..., time_of_day=..., weekday=..., date={...}, duration={...}, ...)`** — pass every metadata field you decided on in Step B at once. The response includes `time.derived` showing the resulting chain-position context ("3 hours later", "the next day"), so you immediately see how the new scene relates to its predecessor.

Pass `pov_character` to put the scene on the POV chain (default-append). For non-default placement, use `pov_after` / `pov_before` / `off_screen`.

**Editing a scene after creation:** use **`update_scene(scene='<UUID or title>', <field>=<new value>, ...)`** to revise any metadata field — `title`, `description`, `main_content`, `is_flashback`, `chapter`, `pov_character` / `pov_after` / `pov_before` / `off_screen` (re-placement on the POV chain), `time_of_day`, `weekday`, `season`, `date`, `duration`, `gap`. Pass only the fields you want to change; everything else is preserved. To CLEAR a previously-pinned time field, pass `clear_pins=['time_of_day', 'weekday', ...]` with the names of the pins to drop — useful when you originally over-pinned and want to fall back to the chain-math defaults.

Leave `main_content` empty for now — that's the actual prose, and prose-writing is a separate workflow. The plot-planning workflow stops at scene structure + scene-anchored changes.

### Step D — Add participants and changes

For every entity that appears in the scene:

- If **already in the cast** AND **no change at this scene**: **`add_entity_to_scene(scene=..., entities=['Mira', 'Eli', ...])`** — pass a list (one or more); each chip is auto-wired into its entity's narrative chain from its last appearance. One call for any number of entities entering the scene together.
  - **Returning after several absent scenes? Pass `predecessor=` explicitly.** When an entity appears in scene A, is absent from scenes B / C / D, and returns at scene E, the auto-wire may not have a single clearly-preferred upstream candidate and will error with an ambiguity message. The recovery shape is `entities=[{entity: 'Mira', predecessor: '<title-of-the-prior-scene-she-was-actually-in>'}]` — naming the specific upstream scene tells the walker which chain stop to wire from. Bare-string entries `'Mira'` are fine for the common case (single clear predecessor); use the object form whenever the entity is returning after a gap.
- If **already in the cast** AND **something changes about them at this scene**: **`update_entity(entity=..., at='<this scene>', name=..., colour=..., description=..., aliases=...)`** — records the scalar changes at this scene; propagates forward.
   - For attribute value changes: **`update_attributes(entity=..., updates=[{attribute: 'Hair', value: 'Cropped short'}, {attribute: 'Mood', value: 'Withdrawn'}, ...], at='<this scene>')`** — one call for any number of attribute updates at this scene.
   - For new attributes at this scene: **`add_attributes(entity=..., attributes=[{name, attribute_type, value/...}], at='<this scene>')`** — same single-call shape.
- If **NEW** to the story: **`create_entity(...)`** first with batch attributes / aliases (this writes baseline at the entity's origin), then **`add_entity_to_scene(...)`** to put them in this scene. The natural cadence: new entities appear when first needed, not all upfront.

**Circumstances at scene time — pick the right scope.** Three distinct shapes; the `target` arg (scene vs entity) and the `is_temporary` / `at` flags pick between them. All three accept a list of circumstances per call:

- **Scene-level circumstance** — a state OF THE SCENE that affects EVERYONE present (e.g. "It's pouring rain", "The power's out", "Tense silence"). Apply via **`add_circumstances(target='<this scene>', circumstances=[{name, description, intensity?}, ...])`** — no `at` arg (the target IS a scene). Stays on the scene only; doesn't propagate to other scenes or attach to any specific entity. Use for a state that only applies AT THIS ONE SCENE.

  **If an environmental condition spans multiple scenes at the same LOCATION** (e.g. a multi-scene gathering, a storm passing through a town across several scenes, ongoing renovation noise in a building, a siege, a festival) — the right tool is NOT scene-level (which would mean copy-pasting per scene). It's an **entity-chain circumstance ON THE LOCATION entity** added at the first scene where the condition starts, AND REMEMBER to remove it at the scene where it ends. The location is an entity; its chain carries the circumstance forward through every subsequent scene until you remove it. The risk to watch for: if you don't remove it at the end-of-condition scene, the circumstance silently propagates to every future scene at that location forever — including scenes set days, weeks, or years later that should not inherit it. Pattern: `add_circumstances(target='<location>', at='<first scene of condition>', circumstances=[{name:'<condition>', intensity:'<level>'}])` at the start, then `remove_circumstances(target='<location>', at='<first scene after condition ends>', circumstances=['<condition>'])` at the cleanup scene. The cleanup `remove_circumstances` call is REQUIRED even if no later scene returns to the location — without it, any future scene set there inherits the state. The cleanup tool auto-chips the location to the cleanup scene and runs the upstream auto-wire, so you don't need to add the location as an explicit participant of the cleanup scene first — calling `remove_circumstances(target='<location>', at='<cleanup scene>', ...)` with the location absent from that scene is fine; the tool wires it in for you.
- **Entity-temporary circumstance** — a state on ONE entity at THIS scene only, NOT chain-tracked (downstream scenes don't inherit it). The state EXISTS for the duration of the scene it was added in and is automatically gone at the next scene — no manual cleanup needed, no `remove_circumstances` call required. Reach for this whenever the state belongs to ONE moment in the story and shouldn't carry over: "Soaked from the rain: Strong" (the character walked in from the storm; they're dry by the next scene), "Mid-sentence panic: Intense" (a flash of fear that passes), "Slightly buzzed: Mild" (one drink, this scene only — escalate per scene with NEW temporaries rather than chain-tracking and updating). The temporary scope is the safest default for in-the-moment moods and reactions; the chain-tracked scope below is for durable inner state. Apply via **`add_circumstances(target='<entity>', is_temporary=true, at='<this scene>', circumstances=[...])`**.
- **Entity-chain circumstance starting at this scene** — a circumstance that BEGINS at this scene on a specific entity and CARRIES FORWARD through the chain (e.g. "Heartbroken: Strong" begins at scene 5 and stays in effect until something updates it downstream). Apply via **`add_circumstances(target='<entity>', at='<this scene>', circumstances=[...])`** — no `is_temporary` flag. To later modify or remove an entity-chain circumstance at a downstream scene, use **`update_circumstance` / `remove_circumstances`** with `at='<downstream scene>'`.

Motivators work the same way but are entity-only (no scene-level motivators — motivators are inner drives, not environmental state). **`add_motivators(entity=..., at='<this scene>', motivators=[...])`** for chain-added; pass `is_temporary=true` for the temporary form.

**Perspectives at scene time.** When something happens at this scene that changes how an entity sees ANOTHER object (a character forms a new opinion of someone, a revelation reshapes how the protagonist reads a piece of knowledge, an event shifts how someone reads a relationship), record it as a perspective chain entry on the host entity at this scene. Perspectives are entity-only (no scene-level perspectives — they're inner opinion, not environmental state). No temporary scope — perspectives are durable inner state, not a moment's flicker. Apply via **`add_perspectives(entity='<host>', perspectives=[{ description, target: { kind, ref } }, ...], at='<this scene>')`**. To shift an existing perspective (rewire the target or rewrite the description) at a downstream scene: **`update_perspective(entity='<host>', perspective='<UUID or target name>', description=..., target?, at='<scene>')`**. To remove at a scene: **`remove_perspectives(entity='<host>', perspectives=['<ref>'], at='<scene>')`**. Same removing-and-updating-matters discipline as circumstances / motivators: if Marcus's opinion of his mentor was set at scene 3 as `"Stern but fair"` and a betrayal lands at scene 8, write a new `update_perspective(at='<scene 8>', description='Treacherous — I never knew him at all')` so downstream scenes see the post-betrayal reading.

**Removing and updating chain-tracked circumstances / motivators is as important as adding them.** An entity-chain circumstance or motivator persists FROM the scene it was added FORWARD through every downstream scene until something updates or removes it. That's the right default for genuinely durable states (heartbroken, exiled, in-love, sleep-deprived) but it's a trap for transient ones written at chain scope by mistake. Every time you write a chain-added circumstance / motivator, ask: "is this still in effect at the next scene, and the one after that, and the one after that?" If the answer is "no, it's a one-scene mood" → use `is_temporary=true` instead (the temporary scope auto-expires at the scene boundary; no removal call needed). If the answer is "yes, but it'll end at some specific scene downstream" → make a note to call `remove_circumstances(at='<that scene>')` or `update_circumstance(at='<that scene>')` once you reach it, anchored to the scene where the state actually resolves narratively. Stale circumstances and motivators silently shape downstream prose-writing and motivation analysis — a character still flagged "Wants to escape the village: Intense" two scenes after she actually left looks bizarrely fixated. Treat your chain-tracked circumstance / motivator stack at each new scene as ACTIVE bookkeeping: add what just started, update intensity if it shifted, remove what's resolved.

**Why no auto-expire on chain-tracked circumstances?** The temporary scope already handles "expires at this scene boundary" — that's exactly what it's for. Chain-tracked circumstances intentionally have no "expires after N scenes" or "expires at scene Y" pre-declaration because narrative state expiry is anchored to the SCENE where the state resolves in the story, not a pre-computed offset. If you declare "Heartbroken expires after 5 scenes" and then insert a new scene between, the expiry now lands at the wrong narrative point. Anchoring removal to the resolution scene by name keeps the expiry pinned to the story event that ends it.

### Step E — Relationships (if applicable)

If two entities start interacting at this scene and their relationship matters beyond this scene:

- If the relationship doesn't exist yet: **`create_relationship(name=..., participants=[...], scene='<this scene>')`** — origin at this scene means the relationship was BORN here.
- If it exists and shifts at this scene: **`update_relationship(...)`** for relationship-level fields, OR **`set_participant(relationship=..., entity=..., role?, perception?, alias_override?, at='<this scene>')`** for per-participant fields — pass any combination of `role` / `perception` / `alias_override` in one call (the singular `set_participant_role` / `_perception` / `_alias` tools were consolidated into `set_participant`).
- New participants joining an existing relationship: **`add_participants(relationship=..., participants=[{entity, role?}, ...], at='<this scene>')`** — one call for any number of joiners.

### Step F — Knowledge (if applicable)

When something HAPPENS at this scene that other characters might or might not know:

- **`create_knowledge(name=..., description=..., colour=..., awareness_scale=..., scene='<this scene>')`** to mint a standalone Knowledge anchored at this scene — represents the fact / event itself. (Use `awareness_scale='binary'` for yes/no facts; `'full'` for graded levels.)
- Set who's aware via **`set_knowledge_awareness(knowledge=..., entries=[{observer, level, at}, ...])`** — one entry per observer whose specific level shapes the narrative going forward. Pin an observer as `Unaware` whenever their not-knowing materially affects how they read subsequent scenes (a character who keeps using the old name, who walks past the secret-bearer without recognising what changed, who would behave differently if they knew). Pin `Fully Aware` when their knowing creates dramatic irony or drives a future scene. Pin a partial level when their understanding is incomplete in a way the story cares about. The pin sticks: the chain walker carries it forward through every downstream scene until you change it.

Or, for chain-event-bound knowledge: any `update_entity` / `update_relationship` / `add_attributes` / `update_attributes` / `add_aliases` / `add_circumstances` / `add_motivators` / `add_participants` / `set_participant` / etc. call at a scene accepts `track_as_knowledge=...` which can create a new Knowledge or bind an existing one to the change in one shot. The single-anchor rule applies: the call must produce exactly ONE chain entry, so for batch tools pass a one-element list when using `track_as_knowledge`. See the knowledge_tracking workflow guide for details.

### Step G — Awareness (if applicable)

When a scene-anchored CHANGE you just recorded in Step D / E / F is something not every other entity in the story would know about — a secret transformation, a hidden alliance, a private decision, a name change in a context where others still see the old name — set awareness on the affected value so the chain reflects each observer's perspective.

Awareness is a per-observer pin on a chain-tracked value. The chain walker uses it to resolve scene-from-perspective reads: `get_entity(entity=<secret-bearer>, at='<downstream scene>')` returns the post-change state by default, but the same call evaluated through an observer's awareness lens returns whichever earlier state that observer's pin says they still see. Awareness pins are how the structured layer captures the perspective gap between what HAPPENED and what each character KNOWS.

Two things to pin at the same anchor as the secret-bearing change:

1. **The observers who are present and DON'T know.** Pin them `Unaware`. Every observer at the scene whose continued not-knowing will shape their downstream behaviour gets a pin: the friend in the next room, the colleague who keeps using the old name, the bystander reading the room wrong. Each pin is what makes the prose-writing pass downstream surface the pre-change values when reading from that observer's perspective.
2. **The observers who DO know.** Pin them `Fully Aware` (or `'Partially'` / `'Nominally'` for incomplete understanding). Most often this is just the entity at the centre of the event itself, plus anyone present who's complicit or already in on it.

Example pattern: a character (Marcus) transforms into a woman (Marisol) at scene 5; the change is a secret known only to Marcus himself and one friend (Jake) who's in on it; Eli, Hannah, and the town don't know.

```
set_entity_awareness(entity='Marisol', entries=[
  {observer: 'Marisol', level: 'Fully Aware', at: '<scene 5>'},
  {observer: 'Jake',    level: 'Fully Aware', at: '<scene 5>'},
  {observer: 'Eli',     level: 'Unaware',     at: '<scene 5>'},
  {observer: 'Hannah',  level: 'Unaware',     at: '<scene 5>'},
])
```

**The pin sticks until you change it.** Awareness is chain-tracked: pin once at the scene-where-it-matters, and the chain walker carries that level forward through every downstream scene. When an observer learns the truth at a later scene, pin them `'Fully Aware'` / `'Partially'` / `'Nominally'` at THAT scene — you don't re-pin them at every scene in between.

**Where to anchor each pin.** Anchor the pin at the scene where the observer's level becomes that value. For observers who don't know from the start, that's the scene the secret-bearing change lands at — they're present but unaware from this point forward. For observers who join the story or enter the secret-bearer's orbit later, anchor at the first scene they're present in (their unaware-ness begins then, not earlier). For an observer who LEARNS the truth, anchor at the scene of the revelation.

There are five awareness setters, one per host type: `set_entity_awareness` (an entity's identity), `set_attribute_awareness` (an attribute's value), `set_alias_awareness` (an alias), `set_relationship_awareness` (that a relationship exists), `set_knowledge_awareness` (a Knowledge fact). All take the same `entries=[{observer, level, at}, ...]` batch shape, where `at` is the scene the awareness is set at. The accepted `level` formats and the shared shape are in `get_tool_help('awareness')`.

**On the read side**, `get_knowledge(knowledge=..., at='<scene>')` returns `awareness: { levels, provenance }` , `levels` is the resolved `{observer: level}` dict for the "what does X know?" lookup, and `provenance` flags which observers inherited their level from a group projection vs a direct pin. See the knowledge_tracking guide for a worked example and the full provenance shape.

**Group projections via `sources` — when an ENTIRE group shares an awareness level.** Alongside `entries` (per-observer direct pins), every awareness setter also accepts a `sources=[...]` arg that mutates GROUP PROJECTIONS. A projection says "every member of <relationship>, resolved at the chain anchor, inherits this level on this target." The chain walker resolves the relationship's membership at read time, so a single declaration scales as members join or leave the group: new joiners automatically inherit at downstream anchors; leavers stop inheriting. Direct entries always override projections for the same observer, so you can pin individual exceptions over a group default.

The canonical use case is faction-style group secrets. Every faction has an auto-created `"<Faction Name> Members"` membership relationship (see `world_setup` for the faction modeling pattern). Pass that relationship as a projection source and every current member inherits the level in one call:

```
set_knowledge_awareness(knowledge='The cursed inheritance', sources=[
  {action: 'add', source: 'House Wexler Members', level: 'Unaware', at: '<scene where the curse takes effect>'},
])
```

The `action` is `'add'` (introduce a projection), `'remove'` (drop one), or `'set_level'` (change one); `source` is the relationship UUID or name. The full per-item `sources` shape , including the context field that attribute / alias setters require on each source , is in `get_tool_help('awareness')`.

**When to reach for projections vs direct entries.** Use a projection when the group, as a group, shares an awareness state and you want new members joining the group later to inherit automatically (a guild, a faction, a generation of students, a crew, a court, a community). Use direct entries when an observer's level is specific to them as an individual — an outlier, a defector who learned independently, a member with a special role. Mix freely: project a base level for the group, then override the specific individuals whose state diverges. The combination scales much better than N+1 individual pins per scene as group composition shifts across the chain.

Skip Step G ONLY when the change is genuinely public / universally observable — most physical actions, environmental shifts, scene transitions. Use it whenever divergent perception matters narratively, and lean toward setting `Unaware` explicitly rather than relying on implicit defaults.

### Step H — Repeat for scene N+1

Move to the next scene. Repeat A-G.

## Phase 4 — Review

Periodically:

- **`list_scenes()`** — confirms scene order on the POV chain.
- **`get_scene(scene=...)`** at key milestones to verify the chain-position context looks right (time pin propagation, gap-to-prior phrasing, snap-forward indicators).
- **`get_entity(entity=..., at='<final scene>')`** to see each entity's resolved state at the story's end.
- If you used chapters/acts (Phase 1.5): **`list_chapters()`** / **`list_acts()`** to confirm the structure still serves the narrative. Revise freely.

## Anti-patterns to avoid

1. **Creating a "Marcus_Female" entity when Marcus transforms.** Use `update_entity(entity='Marcus', at='<transformation scene>', name='Marisol', colour='#...')` — the same entity continues across the transformation with chain-tracked changes. The narrative chain IS how NarrativeNode handles "this character is different now."
2. **Writing structured facts into description.** "Marcus is a 30-year-old blacksmith with a sister named Hannah" → use attributes for age + profession, and a relationship for the sister link.
3. **Pre-populating every entity before any scenes exist.** Define only the initial cast in Phase 2. Add entities in Phase 3 the moment they're first needed.
4. **Over-pinning time / date / weekday / season on every scene.** Pin only what's narratively relevant. Over-pinning locks in details that may need revising and triggers spurious chain-time alerts when adjacent scenes shift.
5. **Skipping the "read prior scene" step.** Without it you might miss a name change, a learned fact, or a relationship shift that already happened upstream.
6. **Calling `update_entity` at origin to "fix" a setup mistake when scenes already exist downstream.** That CAN be the right call (you're correcting the baseline). But verify: if the baseline was correct AT THE TIME but the entity has CHANGED since, the change belongs at the scene where it happened, not at origin. Origin = "always was this way." Scene-anchored = "started being this way at this scene."
7. **Forgetting awareness when a change is secret.** A scene-anchored change with no awareness adjustments is implicitly "everyone knows." If that's wrong narratively (Marcus's secret transformation), other characters' behaviour will read inconsistently downstream — they'll seem to ignore an obvious change. Use Step G whenever observers' knowledge of a change diverges.
8. **Locking chapter/act structure too early.** Scaffolding is meant to serve the narrative. If the plot evolves in a direction that breaks your chapter boundaries, move them.
9. **Building every scene first, then backfilling the entity changes afterwards.** Not incorrect, but it forfeits the main benefit of recording changes on the chain: the motivators, circumstances, relationship shifts, and knowledge you note at each scene are what Step A and Step B read to drive the NEXT scene's decisions. Complete each scene's Step D-G changes before moving on, so every scene is planned in light of what actually changed before it.
