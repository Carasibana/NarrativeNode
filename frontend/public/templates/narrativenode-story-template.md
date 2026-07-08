# NarrativeNode Story Template

<!--
================================================================
NarrativeNode Import Template Guidelines
================================================================

  You are filling in a NarrativeNode story template. The grammar is
  strict: exact section headings, exact field names. Do not rename
  sections, do not invent new ones, do not skip required fields.

  This file is a FORMATTING REFERENCE, not a narrative example. The
  example entries ("Example A", "Example B", etc.) are deliberately
  generic placeholders that demonstrate the SYNTAX. Do NOT model your
  story on them. Invent your own narrative freely — your own genre,
  characters, settings, themes, plot, voice. The template's job is
  to teach you the FORMAT, not to constrain your imagination.

  Process:
    1. Read the entire template once before writing anything.
    2. If the user has not given you the story brief in detail, ask
       focused questions: premise, main characters, settings, key plot
       beats, narrative voice, time-tracking style.
    3. REPLACE the example entries entirely with your own content.
       Do not leave "Example A" or "The Setting" in your output.
       Names must be unique within their type and stay consistent
       across all references (chip lists, attributes, Changes blocks,
       relationships, knowledge).
    4. Fill in every section. Leave a section's body empty (heading
       only) if the story has nothing of that kind. Do not delete
       the heading.
    5. Scenes appear in narrative (POV) order. Each scene's Changes
       block describes only mutations that occur AT this scene;
       baselines belong in the entity / relationship / knowledge
       sections at the top.
    6. ONE ENTITY PER REAL-WORLD THING. A single character / location
       / item / faction / custom is declared ONCE. If that thing
       changes during the story — a character transforms, takes a new
       name, gains a wound, swaps allegiance, ages, reveals a hidden
       trait, anything — those changes go in the relevant scene's
       Changes block as mutations on the SAME entry (rename, change
       description, change colour, modify attribute, add / remove
       attribute, add alias, etc.). Do NOT create a second
       `### Character:` (or other) entry for the changed form. The
       same character through their whole arc is one entity; the
       chain of scene changes records how they evolve.
    7. When done, output the populated template ONLY (no commentary,
       no wrapping fence). Save it as a .md file.
-->


<!--
================================================================
NOTATION REFERENCE — types and value formats used throughout
================================================================

  hex colour         A colour in `#rrggbb` form (or `#rgb`).
                     Example: #4488ff

  comma-list         Comma-separated list of values.
                     Example: tag1, tag2, tag3

  intensity          A descriptive word inside square brackets.
                     Allowed: faint, mild, moderate, strong, intense
                     Example: [strong]
                     Omit the brackets to leave intensity unset.

  awareness level    A descriptive word for how much an observer
                     knows about something.
                     Allowed: unaware, name-only, partial, aware,
                              knows-self
                       unaware    — the observer explicitly doesn't know
                       name-only  — has heard the name, no link to anything
                       partial    — knows it's a label for something,
                                    but not what
                       aware      — knows the linkage / fact
                       knows-self — used in place of `aware` when the
                                    observer IS the subject of the
                                    knowledge entry

  awareness scale    `binary` (the default) — only `unaware` and
                                              `aware` are usable.
                     `full`                 — all five level words
                                              are usable.

  fenced block       A block of multi-line content opened and closed
                     with three backticks on their own lines. Used
                     for scene prose. Indentation inside the fence
                     is preserved verbatim.
-->


## Story

<!--
WHAT IT IS
  Top-level metadata for the entire story.

FIELDS
  title                   string                          required
  author                  string                          optional
  genre                   string (freeform)               optional
  tense                   past | present                  optional
  pov_default             string (freeform)               optional, e.g. "3rd Person Limited"
  language                string (freeform)               optional
  tags                    comma-list of strings           optional
  chapter_label           string                          optional, default "Chapter"
  act_label               string                          optional, default "Act"
  time_tracking           on | off                        optional, default off
  time_format             12h | 24h                       optional, default 12h
  week_start              sunday | monday                 optional, default sunday

FORMAT
  ## Story
  title: <title>
  author: <author>
  ...

EXAMPLE (illustrative — replace with your own)
-->

title: <your story's title>
author: <author name, or leave blank>
genre: <freeform — e.g. literary fiction, mystery, fantasy>
tense: past
pov_default: 3rd Person Limited
language: English
tags: <comma-separated tags>
chapter_label: Chapter
act_label: Act
time_tracking: on
time_format: 12h
week_start: monday


## Preset Lists

<!--
WHAT IT IS
  Named lists of values. Used by `preset`-typed attributes elsewhere
  in the story so an attribute can pick a value from a fixed set
  rather than freeform text. For example, a "Species" list with
  values like Human / Elf / Dwarf, referenced by a character's
  Species attribute. or a "Gender" list with values like Male / Female. 

PER ENTRY
  Heading shape:        ### List: <list name>
  Body:                 a bulleted list of values, one per line

FORMAT
  ### List: <name>
  - <value>
  - <value>

EXAMPLE (illustrative — replace with your own)
-->

### List: Example List
- value 1
- value 2
- value 3

### List: Another Example List
- another value 1
- another value 2


## Custom Categories

<!--
WHAT IT IS
  Templates for "Custom" entities. Each Custom entity (declared in
  `## Customs` below) must reference a category declared here.

  CUSTOMS IS A FALLBACK TYPE. Reach for it ONLY when none of
  Characters / Locations / Items / Factions cleanly applies. If
  the thing fits as a Character (one specific person), a Location
  (one specific place), an Item (one specific object), or a Faction
  (a structured group with members) — use that type instead.

  VALID USES of Customs include:

    - MOB CLASSES — recurring groups of generic, interchangeable
      figures the story references but doesn't track as individual
      Characters. Examples: "Goblins", "Stormtroopers", "Cultists
      of the Black Sun", "Imperial Couriers".

    - NAMED PHENOMENA — recurring weather / magical / natural events
      with story significance. Examples: "The Roaring" (a named
      storm that returns through the story), "The Blight" (a
      spreading disease), "The Stillness" (a magical quieting that
      falls over the land at certain times).

    - CULTURAL EVENTS — recurring festivals, ceremonies, rituals,
      or holidays. Examples: "The Solstice Hunt", "The Naming Day",
      "The Long March".

    - OBJECT CLASSES (NOT INDIVIDUAL ITEMS) — when the story
      references a TYPE of thing rather than a specific instance.
      Examples: "Vials of the Black Tide" (the consumable class),
      "TIE Fighters" (the vehicle class), "Heirloom Daggers" (a
      family of cursed blades). A specific instance of one of
      those classes that the story tracks individually is still
      an Item; the class itself is a Custom.

    - TITLES / OFFICES — named positions or honorifics the story
      cares about. Examples: "The Eternal Crown", "Wardens of the
      Coast", "First Voice".

  Each Custom belongs to a CATEGORY declared here — categories are
  templates. "Goblins" / "Trolls" / "Hobgoblins" might all belong
  to a `Mob` category. "The Roaring" / "The Blight" might belong
  to a `Phenomena` category.

PER ENTRY
  Heading shape:        ### Category: <category name>

FIELDS
  description           string                          optional
  colour                hex colour                      optional, default #888888

EXAMPLE (illustrative — replace with your own)
-->

### Category: Example Category
description: <what kinds of things go in this category>
colour: #888888

### Category: Another Example Category
description: <a different category covering a different kind of story-specific entity>


## Chapters

<!--
WHAT IT IS
  Named chapters in narrative sequence — the order the reader will
  encounter them. Scenes assign themselves to a chapter via the
  scene's `chapter:` field. List chapters here in the order they
  occur in the story.

PER ENTRY
  Heading shape:        ### Chapter: <chapter title>

FIELDS
  colour                hex colour                      optional

EXAMPLE (illustrative — replace with your own)
-->

### Chapter: Beginnings

### Chapter: The Long Night
colour: #6688aa

### Chapter: Homecoming


## Acts

<!--
WHAT IT IS
  Groups of contiguous chapters into acts. Each act spans a continuous
  run of chapters listed in declaration order — gaps are not allowed.

PER ENTRY
  Heading shape:        ### Act: <act title>

FIELDS
  chapters              comma-list of chapter names     required, must be contiguous
  colour                hex colour                      optional

EXAMPLE (illustrative — replace with your own)
-->

### Act: Setup
chapters: Beginnings, The Long Night

### Act: Resolution
chapters: Homecoming
colour: #aa6644


## Characters

<!--
WHAT IT IS
  People (or person-like beings) in your story.

  ONE CHARACTER = ONE ENTRY for the entire story, even if the
  character changes substantially during it. A protagonist who
  transforms, ages, takes a new identity, loses a hand, swaps
  allegiance, gets cursed, recovers, etc. is STILL one character
  here. The starting state goes in this section; every later
  change is recorded in the relevant scene's Changes block on the
  SAME character entry (using `rename to`, `change description to`,
  `change colour to`, `add alias`, `modify attribute`, `add
  attribute`, `remove attribute`, etc.). Do NOT declare a second
  `### Character:` entry for "the transformed form" or "the
  alternate persona" — that breaks the chain history and
  fragments the character into two unrelated people.

PER ENTRY
  Heading shape:        ### Character: <character name>

FIELDS
  colour                  hex colour                    optional, default #888888
  description             string                        optional
  aliases                 comma-list of strings         optional, other names
                                                        the character is known by
  notes                   string                        optional, author's
                                                        private notes (not shown
                                                        to readers)
  awareness_scale         binary | full                 optional, default binary
                                                        (controls existence-
                                                        awareness levels)
  name_awareness_scale    binary | full                 optional, default full
                                                        (controls awareness-of-
                                                        canonical-name levels)

  #### Attributes (subsection)
WHAT IT IS
  Per-character values you want to track (age, occupation, mood,
  goals, hair colour, etc.). Each attribute is a single bullet line.

ATTRIBUTE BULLET SHAPES (one per line)
  - text: <attr name> = "<value>"
  - preset: <attr name> = "<value>" (from "<list name>")
  - number: <attr name> = <numeric value>
  - text_list: <attr name> = ["<item>", "<item>", ...]
  - entity_list: <attr name> = [<entity name>, <entity name>, ...]
  - circumstance: "<attr name>" [<intensity word>] : "<description>"
  - motivator: "<attr name>" [<intensity word>] : "<description>"

  text             freeform text value
  preset           value picked from a Preset List declared above
  number           a numeric value (integer or decimal)
  text_list        ordered list of strings
  entity_list      ordered list of names referencing other entities
  circumstance     A state-of-being condition the character is in
                   (wounded, exiled, recovering, distrusted by the
                   guards, etc.). Declared here when the condition
                   is true at the start of the story. Otherwise it
                   can be ADDED at a scene later (`add attribute
                   (circumstance) ...` in the scene's Changes block)
                   and REMOVED at a scene where it ends (`remove
                   attribute "<name>"`). Lifecycle is fully under
                   the writer's control — ongoing until explicitly
                   removed. Intensity, description, and value can
                   all be modified at any later scene.
                   EITHER name OR description may be empty (not both).
  motivator        A goal or drive (find his family, survive the
                   winter, prove herself, hide the secret, etc.).
                   Same lifecycle as circumstance: declared here when
                   present at story start, otherwise added/removed/
                   modified at scenes. Use this when the motivator
                   is a thread you want to track explicitly across
                   the story.
                   EITHER name OR description may be empty (not both).
  intensity word   one of: faint, mild, moderate, strong, intense.
                   Brackets are optional — omit them to leave the
                   intensity unset.

EXAMPLE (illustrative — replace with your own)
-->

### Character: Character A
colour: #4488ff
description: <one or two sentences>
aliases: <comma-list, optional>
notes: <author's private notes, optional>
awareness_scale: binary
name_awareness_scale: full

#### Attributes
- text: Example Text Attr = "<value>"
- preset: Example Preset Attr = "value 1" (from "Example List")
- number: Example Number = 0
- text_list: Example Text List = ["item 1", "item 2"]
- entity_list: Example Entity List = [Character B]
- circumstance: "Example Condition" [moderate] : "<a state the character is in at the start of the story (e.g. wounded, exiled). Add / remove / modify at scenes via the scene Changes block.>"
- motivator: "Example Drive" [strong] : "<a goal or drive the character has at the start (e.g. find his sister). Add / remove / modify at scenes as the goal evolves.>"

### Character: Character B
colour: #ff4488
description: <one or two sentences>
aliases: <comma-list of nicknames or alternate names this character is called>
notes: <author's private notes — backstory hints, voice cues, anything that won't be shown to readers>

#### Attributes
- text: Example Text Attr = "<a different value>"
- circumstance: "Example Condition" [mild] : "<a starting condition different in flavour from Character A's>"

### Character: Character C
colour: #44aa66
description: <a third character whose presence in the story is more peripheral — lighter on attributes>
notes: <even minimal characters can carry an attribute or two if it's narratively load-bearing>


## Locations

<!--
WHAT IT IS
  Places in your story.

PER ENTRY
  Heading shape:        ### Location: <location name>

FIELDS
  colour                hex colour                      optional, default #888888
  description           string                          optional
  parent                location name                   optional, for nested places
                                                        (a room inside a building,
                                                         a building inside a city)
  aliases               comma-list of strings           optional
  notes                 string                          optional
  awareness_scale       binary | full                   optional, default binary
  name_awareness_scale  binary | full                   optional, default full

  #### Attributes (subsection)
  Same shapes as for Characters (see above).

EXAMPLE (illustrative — replace with your own)
-->

### Location: The Setting
colour: #8888aa
description: <one or two sentences>

### Location: A Sub-Location
colour: #6677aa
description: <a place nested inside The Setting — e.g. a specific room inside the building, or a clearing inside the forest>
parent: The Setting


## Items

<!--
WHAT IT IS
  Objects of narrative significance.

PER ENTRY
  Heading shape:        ### Item: <item name>

FIELDS
  Same as for Characters (above), minus `name_awareness_scale`.

EXAMPLE (illustrative — replace with your own)
-->

### Item: An Object
colour: #aabb88
description: <one or two sentences>

### Item: Another Object
colour: #bbaa66
description: <a 2nd item — useful when items have meaningful attributes or backstory>

#### Attributes
- text: Example Text Attr = "<a property of this item, e.g. its material or origin>"


## Factions

<!--
WHAT IT IS
  Groups, organisations, alliances, factions in the story.
  Leave the section body empty (heading only) if your story has
  no factions.

  MEMBERSHIP — a faction's MEMBERS (the characters / entities that
  belong to it) are NOT listed here. They are tracked by declaring
  a Relationship in the `## Relationships` section with the
  `membership_of:` field set to this faction's name. The
  participants of that relationship ARE the faction's members.
  When a character JOINS or LEAVES the faction during the story,
  use the standard `relationship "<membership name>": <character>
  joins as "<role>"` / `<character> leaves` verbs in the
  scene's Changes block. See the "Relationships" section below
  for the membership relationship pattern.

PER ENTRY
  Heading shape:        ### Faction: <faction name>

FIELDS
  Same as for Characters (above), minus `name_awareness_scale`.

EXAMPLE (illustrative — replace with your own)
-->

### Faction: A Faction
colour: #886655
description: <a group, organisation, or alliance the story cares about. Its members are declared in a membership Relationship (see the Relationships section below).>

### Faction: Another Faction
colour: #557788
description: <a 2nd faction — useful when the story has rivalries or alliances between groups>


## Customs

<!--
WHAT IT IS
  Individual Custom entities, each tied to a Custom Category declared
  above. See the `## Custom Categories` section above for the full
  list of valid Custom use cases (mob classes, named phenomena,
  cultural events, object classes, titles, etc.).

  CUSTOMS IS A FALLBACK — only declare something here if it does NOT
  cleanly fit as a Character, Location, Item, or Faction. Don't
  duplicate an entity across types — pick the single most appropriate
  type for each entity.

  Quick disambiguation: a SPECIFIC named instance the story tracks
  individually is the type that fits its kind (Character, Location,
  Item, Faction); a CLASS of instances the story references as a
  category, or a recurring named non-individual thing, is a Custom.

PER ENTRY
  Heading shape:        ### Custom: <custom entity name>

FIELDS
  category              custom category name            REQUIRED — must
                                                        match a category
                                                        declared in
                                                        `## Custom Categories`
  label                 string                          optional, a short
                                                        distinguishing label
  colour                hex colour                      optional, default #888888
  description           string                          optional
  aliases               comma-list of strings           optional
  notes                 string                          optional

  #### Attributes (subsection)
  Same shapes as for Characters (see above).

EXAMPLE (illustrative — replace with your own)
-->

### Custom: An Example Custom
category: Example Category
colour: #888888
description: <one or two sentences>

### Custom: Another Example Custom
category: Another Example Category
colour: #aa9977
description: <a 2nd custom entity — note this one references the 2nd Custom Category declared above>
label: Variant


## Relationships

<!--
WHAT IT IS
  Ties that connect two or more entities together — friendships,
  alliances, family ties, rivalries, contracts, ownership, curses,
  feuds, anything the story cares about as a multi-entity
  connection. Two-way is the common case; THREE OR MORE is fully
  supported. Participants can be ANY mix of declared entity types
  (Characters, Locations, Items, Factions, Customs) — relationships
  are not restricted to characters.

PER ENTRY
  Heading shape:        ### Relationship: <relationship name>

  The name after `### Relationship:` is the relationship's name.
  Pick anything that fits the story — "The Old Pact", "The Council
  of Three", "Marriage of Jess and Tom", "The Heirloom Curse",
  "Tenants of the Glass Tower". The name is your label for it; it
  does not have to be derived from the participants.

FIELDS
  description           string                          optional
  participants          bulleted list                   required (see below)
  hierarchy             sub-block (mode + tree, or       optional, creates
                        legacy root + order)             parent/child structure
                                                         among participants or
                                                         among role values
  awareness_scale       binary | full                   optional, default binary
  membership_of         entity name                     optional, marks this
                                                        relationship as the
                                                        canonical membership
                                                        record for an entity
                                                        (typically a faction)

PARTICIPANTS BULLET SHAPE (one per line per participant)
  - <entity name>: perception "<text>"; role "<text>"

  Each participant is referenced by its declared entity name (any
  type — Character, Location, Item, Faction, Custom). `perception`
  is how the participant views the relationship; `role` is what the
  participant IS in this relationship. Both are individually
  optional — leave the value empty (`perception ""`) when a
  participant doesn't have a meaningful perception (e.g. inanimate
  items, locations).

HIERARCHY SUB-BLOCK
  Two equivalent shapes are supported. The richer nested-bullet form
  expresses any tree (multi-root, multi-level) and works for both
  `participants` mode (tree-node names = entity names) and `roles`
  mode (tree-node names = role-value strings):

  hierarchy:
    mode: participants            — optional, default `participants`;
                                    the other value is `roles`
    tree:                          — nested bullets; indentation = nesting
      - <name>
        - <child>
          - <grandchild>
        - <child>
      - <other root>

  The legacy flat form is still accepted; it compiles to a single-root
  participants-mode tree:

  hierarchy:
    root: <entity name>           — the structural top of the hierarchy
    order: <comma-list of names>  — must include the root, lists every
                                    participant in structural order

FACTION MEMBERSHIP PATTERN
  A faction's members are tracked by declaring a Relationship with
  `membership_of:` set to the faction's name. The participants of
  that relationship are the faction's members. When a character
  joins or leaves the faction during the story, use the change
  verbs in the scene's Changes block:

    relationship "<membership name>": <character> joins as "<role>"
    relationship "<membership name>": <character> joins
    relationship "<membership name>": <character> leaves

  See "Faction Membership" in the examples below.

EXAMPLE (illustrative — replace with your own)
-->

### Relationship: A Pact
description: <a 3-way relationship of mixed entity types — two characters and an item are bound together by the pact>
participants:
  - Character A: perception "<A's view of the pact>"; role "<A's role>"
  - Character B: perception "<B's view of the pact>"; role "<B's role>"
  - An Object: perception ""; role "<the object's part in the pact>"

### Relationship: A Mentorship
description: <a 2-way hierarchical relationship — e.g. mentor and apprentice, parent and child, captain and recruit>
participants:
  - Character A: perception "<the senior's view>"; role "Mentor"
  - Character C: perception "<the junior's view>"; role "Apprentice"
hierarchy:
  root: Character A
  order: Character A, Character C

### Relationship: Faction Membership
description: <the membership record for a faction. Participants are the members; the `membership_of:` field below ties this relationship to the faction it tracks.>
participants:
  - Character A: perception ""; role "<A's role inside the faction, e.g. Captain, Founder>"
  - Character B: perception ""; role "<B's role inside the faction, e.g. Member, Lieutenant>"
membership_of: A Faction


## Knowledge

<!--
WHAT IT IS
  A discrete piece of story information you want to track per-
  character — a secret, a reveal, an abstract fact. Has a name,
  description, and per-observer awareness levels.

PER ENTRY
  Heading shape:        ### Knowledge: <knowledge name>

FIELDS
  colour                hex colour                      optional, default #888888
  description           string                          optional
  notes                 string                          optional
  awareness_scale       binary | full                   optional, default full
  awareness             bulleted list                   optional (see below)

AWARENESS BULLET SHAPE (one per line, declares one observer's level)
  - <entity name>: <awareness level word>

  Allowed level words: unaware, name-only, partial, aware, knows-self.
  See the notation reference at the top of this template for what
  each one means and which scale they're valid on.

EXAMPLE (illustrative — replace with your own)
-->

### Knowledge: A Secret
colour: #cc4488
description: <a piece of knowledge with a clean binary state at story start — A knows, B doesn't>
notes: <author's private notes>
awareness_scale: binary
awareness:
  - Character A: aware
  - Character B: unaware

### Knowledge: A Layered Truth
colour: #aa6688
description: <a piece of knowledge whose awareness varies in degree across characters at story start — some know fully, some have heard pieces, some haven't>
awareness_scale: full
awareness:
  - Character A: aware
  - Character B: name-only
  - Character C: partial


## Scenes

<!--
WHAT IT IS
  Scenes in narrative (POV) order. Each scene records: a SUMMARY of
  what happens (the `description` field), who's in it, when it
  happens, optionally the actual prose, and any state changes that
  occur during it.

  TWO USE MODES — pick whichever fits the brief:

    1. OUTLINE ONLY — fill in `description` (a paragraph
       summarising what happens in the scene), and leave the
       `content` field omitted. This is the right shape when the
       writer wants the story's STRUCTURE laid out — beats,
       sequence, who's where, what changes — but plans to write
       the prose themselves later. Frequently the more useful
       output: it gives the writer scaffolding to flesh out
       without overwriting their own voice.

    2. OUTLINE + PROSE — fill in `description` AND include a
       `content` block with the actual scene prose. Use this
       when the writer has explicitly asked for a fully-written
       draft.

  When in doubt, default to OUTLINE ONLY unless the writer's
  brief asks for the prose itself.

PER ENTRY
  Heading shape:        ### Scene: <scene title>

FIELDS
  chapter               chapter name                    recommended (must
                                                        match a chapter
                                                        declared above)
  description           string                          recommended — a short
                                                        summary / outline of
                                                        what the scene is
                                                        about. This is the
                                                        scene's beat, in plain
                                                        language, that the
                                                        writer reads when
                                                        navigating the story
                                                        structure.
  pov                   character name                  optional, who carries
                                                        the POV in this scene
                                                        (must appear in
                                                         `characters:` below)
  characters            comma-list of names             optional, characters
                                                        present in the scene
  locations             comma-list of names             optional
  items                 comma-list of names             optional
  factions              comma-list of names             optional
  customs               comma-list of names             optional
  time_of_day           see notation                    optional. Three forms:
                                                          broad:    day | night
                                                          labelled: dawn |
                                                                    early morning |
                                                                    morning |
                                                                    late morning |
                                                                    noon |
                                                                    early afternoon |
                                                                    afternoon |
                                                                    late afternoon |
                                                                    evening |
                                                                    night |
                                                                    late night |
                                                                    midnight
                                                          exact:    HH:MM (24h)
  weekday               weekday name                    optional (Sunday..Saturday)
  season                spring|summer|fall|winter       optional
  date                  see notation                    optional. Forms:
                                                          weekday alone (e.g. Tuesday)
                                                          <Month>           (e.g. March)
                                                          <Month> <day>     (e.g. March 15)
  duration              see notation                    optional. Forms:
                                                          ambiguous
                                                          <N> minutes
                                                          <N> hours
                                                          <N> days
                                                          all morning |
                                                          all afternoon |
                                                          all evening |
                                                          all night |
                                                          all noon
                                                          <period> to <period>
                                                          all day |
                                                          all night |
                                                          until next evening
  gap                   "<N> <unit>"                    optional, narrative time
                                                        elapsed since the previous
                                                        scene on the POV chain.
                                                        Units: minutes, hours,
                                                        days, weeks.
  content               fenced block                    OPTIONAL, the actual
                                                        prose for the scene.
                                                        Omit entirely when the
                                                        writer wants OUTLINE
                                                        ONLY (see "TWO USE
                                                        MODES" above) — the
                                                        `description` field
                                                        carries the summary
                                                        in that case.

  #### Circumstances (subsection)
WHAT IT IS
  Ambient context for the WHOLE SCENE — weather, room mood, time-
  of-day vibe. Applies to everyone in the scene equally. NOT carried
  forward to later scenes.

BULLET SHAPE (one per line)
  - "<name>" [<intensity word>] : "<description>"

  EITHER name OR description may be empty (not both). Intensity word
  is one of: faint, mild, moderate, strong, intense (or omit the
  brackets for unset).

  #### Changes at this scene (subsection)
WHAT IT IS
  Records what changes in the story AT this scene. Three flavors of
  "change" exist depending on whether the change persists or not.
  Pick the right flavor — picking the wrong one is the most common
  authoring mistake here.

THREE FLAVORS OF "CIRCUMSTANCE / MOTIVATOR"
  1. CHAIN-TRACKED ATTRIBUTE
       `<entity>: add attribute (circumstance) ...`   ← starts here
       `<entity>: remove attribute "<name>"`           ← ends here
       Applies to one entity. Begins at the scene where it's added
       and ENDS at the scene where it's removed (or carries to the
       end of the story if never removed). Intensity / description
       can be modified at any scene in between via
       `<entity>: modify attribute "<name>" intensity to ...`.
       Use this for conditions and drives that span more than one
       scene: "Wounded" picked up in scene 3 and healed in scene 7;
       "Hunting the killer" added when she takes the case and
       removed when she catches him; "Pregnant" through an arc.

  2. ENTITY-TEMPORARY
       `<entity>: add temporary circumstance ...`
       Applies to one entity, this scene ONLY. Vanishes by the next
       scene — no remove action needed. Use for IN-THE-MOMENT
       feelings: "Flustered at the party", "Tipsy at the wedding".
       Default choice for transient emotional states.

  3. SCENE-LEVEL
       Goes in the `#### Circumstances` block above (not the Changes
       block). Applies to the whole scene. Use for AMBIENT context:
       "Raining", "Loud and crowded", "After the squall".

LAYER CHANGES — A SINGLE BEAT OFTEN WARRANTS SEVERAL
  A single story moment (a transformation, a reveal, a betrayal,
  a wedding, an injury, a curse landing) commonly produces MANY
  change bullets all anchored at the same scene on the same
  character. They stack cleanly — none cancels another, none is
  "the right one" to the exclusion of the others. A character
  transforming into a different physical form, for example, might
  warrant ALL of these in the same scene's Changes block:
    - <entity>: rename to "<the new name they go by>"
    - <entity>: change description to "<the new visible appearance>"
    - <entity>: change colour to <new hex>
    - <entity>: add alias "<new name as an alternate>"
    - <entity>: modify attribute "<a relevant preset, e.g. Gender, Species>" value to "<new>"
    - <entity>: add temporary circumstance "<the in-the-moment feeling, e.g. Newly transformed>" [strong] : "..."
    - <entity>: add attribute (circumstance) "<a persistent state of being, e.g. In an altered body>" [strong] : "..."
  Reach for whatever combination the moment actually involves —
  don't try to pick "the one right verb" for a complex beat. The
  verbs are layers; layer them.

REVERSING A CHAIN CHANGE (TEMPORARY VS PERSISTENT)
  A change like `modify attribute "X" value to Y` or
  `<entity>: rename to "..."` propagates forward from this scene
  until something later changes it again. To make a change
  temporary (the protagonist's Gender flipping to Female for one
  night and back to Male in the morning; a name change that gets
  undone; a colour shift that reverts), simply add a SECOND
  matching change at the reversion scene that puts the value
  back. The chain history then records "Male pre-scene-3, Female
  from scene 3 to scene 7, Male again from scene 7 forward."
  Same pattern works for every chain-tracked scalar field: rename
  → rename back, change description → change back, change colour
  → change back, modify attribute value → modify back. Add /
  remove on the same chain-tracked-attribute (`add attribute (...) ...`
  paired with `remove attribute "..."`) is the matching pattern
  for circumstance / motivator attributes that come and go.

CHANGE BULLET SHAPES — entity changes
  Subject is an entity name from the chip lists above.

  - <entity>: rename to "<new name>"
  - <entity>: change description to "<new text>"
  - <entity>: change colour to <hex colour>
  - <entity>: add alias "<value>"
  - <entity>: replace aliases with "<value>", "<value>", ...
  - <entity>: add attribute (text) <name> = "<value>"
  - <entity>: add attribute (preset) <name> = "<value>" (from "<list>")
  - <entity>: add attribute (number) <name> = <numeric>
  - <entity>: add attribute (text_list) <name> = ["<item>", ...]
  - <entity>: add attribute (entity_list) <name> = [<entity>, ...]
  - <entity>: add attribute (circumstance) "<name>" [<intensity word>] : "<desc>"
  - <entity>: add attribute (motivator) "<name>" [<intensity word>] : "<desc>"
  - <entity>: add temporary circumstance "<name>" [<intensity word>] : "<desc>"
  - <entity>: add temporary motivator "<name>" [<intensity word>] : "<desc>"
  - <entity>: modify attribute "<name>" value to "<new value>"
  - <entity>: modify attribute "<name>" intensity to <intensity word or none>
  - <entity>: modify attribute "<name>" description to "<new description>"
  - <entity>: modify attribute "<name>" number to <numeric>
  - <entity>: rename attribute "<old name>" to "<new name>"
  - <entity>: remove attribute "<name>"
  - <entity>: append to attribute "<name>": "<item>"
  - <entity>: drop from attribute "<name>": "<item>"
  - <observer>: gains awareness of <target>
  - <observer>: gains awareness of <target> (<awareness level word>)
  - <observer>: loses awareness of <target>

  Awareness `<target>` can be:
    <entity name>                        — knowing this entity exists
    <entity name>'s name                 — knowing this entity's canonical name
    <entity name>'s alias "<value>"      — knowing a specific alias
    attribute "<owner>.<attr name>"      — knowing about a specific attribute
    relationship "<relationship name>"   — knowing about a relationship
    knowledge "<knowledge name>"         — knowing about a knowledge entry

CHANGE BULLET SHAPES — relationship changes
  Subject is `relationship "<name>"`.

  - relationship "<name>": activate
  - relationship "<name>": deactivate
  - relationship "<name>": <entity> joins as "<role>"
  - relationship "<name>": <entity> joins
  - relationship "<name>": <entity> leaves
  - relationship "<name>": <observer>'s perception of <target>: "<text>"
  - relationship "<name>": <entity>'s alias here is "<override>"
  - relationship "<name>": <entity>'s role becomes "<role>"
  - relationship "<name>": rename to "<new name>"
  - relationship "<name>": change description to "<text>"
  - relationship "<name>": set hierarchy root to <entity>, order: <entities>
  - relationship "<name>": clear hierarchy

  `activate` records the scene where the relationship first comes
  into existence DURING the narrative. Declaring a relationship in
  the `## Relationships` section above makes it KNOWN to the
  project; `activate` says "this is when it became real."
  `deactivate` records where the relationship ends.

  PRE-EXISTING RELATIONSHIPS DO NOT GET `activate`. If the
  relationship was already real before scene 1 (a long-running
  friendship, an established marriage, a guild membership the
  character had at the start), it's considered already-active at
  story start. Do NOT add an `activate` event for it at the first
  scene it appears in. Only use `activate` for relationships that
  COME INTO BEING during the story.

CHANGE BULLET SHAPES — knowledge changes
  Subject is `knowledge "<name>"`.

  - knowledge "<name>": activate
  - knowledge "<name>": rename to "<new name>"
  - knowledge "<name>": change description to "<text>"
  - knowledge "<name>": change colour to <hex colour>
  - knowledge "<name>": <observer> gains awareness (<awareness level word>)
  - knowledge "<name>": <observer> loses awareness
  - knowledge "<name>": tracking on (binary)
  - knowledge "<name>": tracking on (full)
  - knowledge "<name>": tracking off

  `activate` records the scene where the knowledge first comes
  into being DURING the narrative. Knowledge that ALREADY exists
  before scene 1 (an established secret characters carry from
  before the story starts, a fact baked into the world) is
  considered already-active at story start — do NOT add an
  `activate` event for it. Only `activate` knowledge that comes
  into being during the story.
  `tracking on` / `tracking off` start or stop awareness tracking
  from this scene forward.

EXAMPLE (illustrative — replace with your own)
-->

### Scene: Scene 1
chapter: Beginnings
description: <a paragraph summarising what happens in this scene — the beats, who does what, what changes. This is the scene's outline / synopsis the writer reads when navigating the story structure.>
pov: Character A
characters: Character A, Character B
locations: The Setting
items: An Object
time_of_day: morning
weekday: Monday
season: spring
date: March 1
duration: 1 hour

#### Circumstances
- "Example scene-level circumstance" [moderate] : "<ambient context, e.g. cold rain through the windows>"

<!--
content: (OPTIONAL)
  Include a fenced `content:` block ONLY if the writer asked you to
  generate the actual scene prose. If the brief is just for an
  outline / structure pass, OMIT the content block entirely — the
  `description` field above already carries the summary, and the
  writer will write the prose themselves.

  When you do include it, the shape is:

    content:
    ```
    <the prose for this scene>
    ```

  Markdown _italics_ and **bold** are honoured.
-->


#### Changes at this scene
- Character A: change description to "<updated description from this scene forward>"
- Character A: add attribute (circumstance) "Example Condition" [moderate] : "<a condition added at this scene that the character carries into later scenes (until removed)>"
- Character A: add temporary circumstance "Example transient feeling" [strong] : "<a feeling true RIGHT NOW that vanishes by the next scene>"
- Character B: gains awareness of Character A
- Character B: gains awareness of Character A's name
- relationship "A Pact": activate
- relationship "A Pact": Character A joins as "<A's role>"
- relationship "A Pact": Character B joins as "<B's role>"
- knowledge "A Secret": activate
- knowledge "A Secret": Character A gains awareness (aware)


### Scene: Scene 2
chapter: The Long Night
description: <a paragraph summarising what happens in this 2nd scene. This example demonstrates OUTLINE + PROSE mode — the same scene with the actual prose included in a content block below. Use this mode only when the writer asked for fully-written scene prose.>
pov: Character A
characters: Character A, Character C
locations: A Sub-Location
time_of_day: late evening
weekday: Tuesday
season: spring
date: March 2
duration: 30 minutes
gap: 14 hours

content:
```
<the prose for this scene goes here. Write a paragraph or two of
actual story text. Markdown _italics_ and **bold** are honoured.

Replace this entire block with your own scene prose when the brief
asks for fully-written scenes; otherwise omit the content block
entirely (as in Scene 1 above).>
```

#### Changes at this scene
- Character A: modify attribute "Example Condition" intensity to strong
- Character A: remove attribute "Example Condition"
- Character A: add alias "<a new alias the character picks up at this scene>"
- Character C: gains awareness of Character A
- Character C: gains awareness of Character A's name
- relationship "A Mentorship": activate
- relationship "A Mentorship": Character A joins as "Mentor"
- relationship "A Mentorship": Character C joins as "Apprentice"
- relationship "A Mentorship": Character C's perception of Character A: "<C's view of A from this scene forward>"
- relationship "Faction Membership": Character C joins as "<C's role inside the faction>"
- relationship "Faction Membership": Character B leaves
- knowledge "A Layered Truth": Character C gains awareness (aware)

### Scene: A Flashback to Earlier
flashback_of: Scene 2
description: <example flashback child scene. It is a re-visualisation of Scene 2's entity state, used for a flashback / dream / parallel moment. The flashback inherits all chips + chain-resolved state from its parent automatically — do NOT add `characters:` / `locations:` / `pov:` etc. on a flashback (they are ignored). Give the flashback its own description / content if the writer wants distinct author commentary.>
chapter: The Long Night
time_of_day: morning
