# Help Screenshot Inventory

Tracking doc for every screenshot landed under `docs/help/`. The
checklist [Phase 1.27 - Help Screenshot Checklist.md](../../planning/Phase%201.27%20-%20Help%20Screenshot%20Checklist.md)
defines the *target spec* (what shots the help system needs); this
inventory records the *actual captured assets* — each row says which
file ended up where and what's actually in it. New shots get appended
here as they're sorted out of `.Tools/help-screenshots/unsorted screenshots/`.

## Conventions

- **Filename** — kebab-case `.webp`, matches the checklist's output
  basename when the shot fits a checklist row. Bonus / non-checklist
  shots use their own descriptive kebab-case names.
- **Location** — path under `docs/help/`, mirroring the topic folder
  in the checklist (e.g. `nodes/scene/img/scene-node.webp`).
- **Description** — one or two sentences. What's in frame, what the
  notable state is (selected? draft? error visible? specific value
  pinned?). Disambiguate near-duplicates explicitly — if two shots
  show the same surface in different states, the description must
  call out the difference.

## Status legend

- `Captured` — file is in place under `docs/help/…/img/` and the
  description is filled.
- `Unidentified` — file was found in `unsorted screenshots/` but
  couldn't be matched confidently; sits in
  `.Tools/help-screenshots/unsorted screenshots/unidentified/` with
  a best-guess description.

---

## Captured shots

| Filename | Location | Description |
|---|---|---|
| entity-origin.webp | nodes/entity/img/ | Close-up of a character-origin EntityNode for "Bob" with profile image, "NEW : CHARACTER" badge, and Gender = Male attribute chip. Close-affordance (×) visible top-right — selected state. |
| entity-origin-multiple-characters.webp | nodes/entity/img/ | Vertical strip of five character-origin EntityNodes (Alice, Bob, Carly, Dani, Eric) showing the per-entity colour stripe on each. |
| scene-cm-summary-popover.webp | nodes/scene/img/ | Scene-level CM summary popover showing scene-level "It's a rainy day…" + per-entity "Sleepy" on Alice. |
| scene-with-everything.webp | nodes/scene/img/ | Scene "They Meet at a coffee shop" fully filled: prose description, time pins, chip area (Bob, Alice with C·M counters, Cafe-Narra), Relationships section. |
| modifier-empty.webp | nodes/modifier/img/ | Brand-new Modifier node prompting "← Wire an entity to configure". |
| modifier-node.webp | nodes/modifier/img/ | Modifier node bound to the character "Carly" showing the orange MODIFIER : CHARACTER badge. |
| pov-origin.webp | nodes/pov-origin/img/ | Tight close-up of the POV Origin chip (the yellow POV badge with its output port). |
| pov-origin-wired.webp | nodes/pov-origin/img/ | Wider shot showing the POV Origin chip wired into a Scene's POV slot (yellow dashed wire). |
| reference-note-empty.webp | nodes/reference/img/ | An empty Reference Note with placeholder text "Type your notes here…". |
| reference-note.webp | nodes/reference/img/ | Reference Note titled "A Note!" with a populated body, in unselected state. |
| reference-note-collapsed.webp | nodes/reference/img/ | Reference Note collapsed to header-only ("NOTE A Note!"). |
| reference-note-formatting.webp | nodes/reference/img/ | Reference Note with rich-text formatting (bold "that thin", italic, underline) applied, with the Editor toolbar above. |
| reference-media-empty.webp | nodes/reference/img/ | Empty Reference Media node with central "Upload Media" call to action. |
| reference-media-image.webp | nodes/reference/img/ | Reference Media node displaying an image asset (waterfall illustration). |
| reference-media-audio.webp | nodes/reference/img/ | Reference Media node showing audio transport controls (play / scrubber / 0:02 / volume). |
| reference-media-collapsed-to-bar.webp | nodes/reference/img/ | Reference Media collapsed to its slim title-bar form — just the "REFERENCE : MEDIA" tag, drag dots, play / pause and close affordances. |
| reference-media-video.webp | nodes/reference/img/ | Reference Media node playing a video with full transport (play/pause, timer 0:10, volume, fullscreen). |
| reference-media-fullscreen.webp | nodes/reference/img/ | Reference Media in fullscreen / overlay mode displaying the silhouette image. |
| minimap.webp | ui/canvas-overview/img/ | Canvas minimap thumbnail: numbered scene rectangles (0, 1, 1, 2, 3) showing the project's node layout in miniature with the current-view rect frame around them. |
| pov-chain-fixture.webp | concepts/pov-chain/img/ | Wide canvas overview showing the POV chain (POV origin chip wired into a Scene, Alice + Narraville origin nodes feeding into it). |
| pov-character-handoff.webp | concepts/pov-chain/img/ | Two scenes side-by-side; second scene "They Meet at a coffee shop" carries POV = 2 with both Bob and Alice present (POV handoff illustrated). |
| scenes-with-time-progression.webp | concepts/story-order/img/ | Two scenes side-by-side with time pins: "Morning · Monday March 8 · Fall · until Morning" → "Still that morning · Late Morning"; demonstrates how scene-time progresses across the chain. |
| entity-chain-wire.webp | concepts/wire-kinds/img/ | Close-up of an entity-coloured chain wire connecting Alice's origin to a Scene's Alice chip; output port and in-port stub both visible. |
| chapter-columns.webp | concepts/chapters-and-acts/img/ | Canvas overview with a Chapter 1 header band at the top and an empty column body — shows the column-region overlay. |
| chapter-with-title.webp | concepts/chapters-and-acts/img/ | Canvas overview with Chapter 1 + its inline title "It all starts somewhere…" populated, contents below. |
| chapter-header.webp | concepts/chapters-and-acts/img/ | Same chapter header but in edit mode: inline title input with placeholder, blue square badge on left, red delete button on right. |
| chapter-resize-handles.webp | concepts/chapters-and-acts/img/ | Close-up of the right edge of a chapter column showing the vertical resize handle with the "Drag to resize" tooltip visible. |
| canvas-toolbar.webp | ui/canvas-overview/img/ | Close-up of the top-left canvas toolbar cluster: + Add menu button, Undo, Redo. |
| canvas-with-2scenes.webp | ui/canvas-overview/img/ | Wide canvas overview showing two scenes side-by-side ("The Beginning" and "They Meet at a coffee shop"), with Alice / Bob / Narraville character + location origins on the left, Cafe-Narra origin tucked below, and the POV chain wiring all of them. |
| canvas-with-chapter-header.webp | ui/canvas-overview/img/ | Canvas overview with the chapter header row visible at top (Chapter 1 column running the full canvas width). |
| add-nodes-menu.webp | ui/canvas-overview/img/ | The "+ Add" canvas menu open showing the full node-type palette (Scene, Flashback Scene, Character, Location, Item, Faction, Custom, Knowledge, Relationship, Modifier, Reference Note, Reference Media, Group). |
| canvas-controls.webp | ui/canvas-overview/img/ | Floating right-side canvas controls strip: zoom in, zoom out, fit-view, lock, snap, sidebar toggle. |
| library-characters.webp | ui/entity-library/img/ | Left sidebar Entity Library, Characters tab active, listing Alice / Bob / Carly / Dani / Eric with profile images. |
| library-locations.webp | ui/entity-library/img/ | Locations tab showing a 3-row hierarchy: Narraville › Narraville Library + Cafe-Narra (indented child). |
| library-relationships.webp | ui/entity-library/img/ | Relationships tab showing one entry "First Date / Bob & Alice" with side-by-side profile thumbnails. |
| library-preset-lists.webp | ui/entity-library/img/ | Preset Lists tab showing a "Gender" list with values Male / Female. |
| editor-overview.webp | ui/editor-panel/img/ | Right sidebar Editor Panel pinned to scene "They Meet at a coffee shop" with prose content and the TipTap formatting toolbar visible. |
| editor-entity-mention.webp | ui/editor-panel/img/ | Same editor view but with "Names" highlight mode on; Alice / Bob mentions in the prose render as coloured entity-mention chips. |
| editor-find-replace.webp | ui/editor-panel/img/ | Editor panel with the Find & Replace overlay open above the prose (empty Find / Replace fields, Scope: This Scene / All Scenes options). |
| story-settings-tab.webp | ui/settings/img/ | Settings modal, Story Settings tab — Story Metadata, Structure, Colours, Auto-save, Time Tracking sections visible. |
| story-settings-tab-scrolled.webp | ui/settings/img/ | Same tab scrolled down to reveal Time Tracking details + Awareness Checks heading at bottom. |
| story-seeds-tab.webp | ui/settings/img/ | Story Seeds tab — explanation block + default-attributes / bundled-preset-lists sections, Gender preset and Characters default attribute visible. |
| program-settings-tab.webp | ui/settings/img/ | Program Settings tab — Story Metadata, Structure, Colours, Auto-save, Awareness Checks, Time Tracking defaults sections. |
| program-settings-tab-scrolled.webp | ui/settings/img/ | Same tab scrolled to show Application, File-type association (Registered status), Seeds File sections. |
| default-seeds-tab.webp | ui/settings/img/ | Default Seeds tab — same UI as Story Seeds but in the program-defaults context. |
| about-tab.webp | ui/settings/img/ | About tab showing the N logo, "NarrativeNode" title, "loading version…" placeholder, tagline, Made by / with help from credits, GitHub link. |
| thanks-tab.webp | ui/settings/img/ | Thanks tab listing frontend + backend OSS dependencies with their license tags. |
| navigator-panel.webp | ui/timeline-navigator/img/ | Timeline Navigator panel open anchored under the menu bar, showing per-entity rows (Alice, Bob, Carly, Dani, Eric, Narraville, Narraville Library, Cafe-Narra) with origin / scene / final dots across the timeline. |
| toc-entity-filter.webp | ui/table-of-contents/img/ | TOC narrowed to scenes containing Cafe-Narra (entity-filter chip at the top, single matching scene below); left sidebar Detail Panel for Cafe-Narra also visible. |
| overview.webp | ui/detail-panel/scene/img/ | Scene Detail Panel showing scene "The Beginning" — Details sub-tab with description, time pins, Characters / Locations chip lists, Relationships and Knowledge empty-state sections. |
| circumstances-tab.webp | ui/detail-panel/scene/img/ | Same Scene Detail Panel on the Circumstances sub-tab: scene-level "It's a rainy day…" + per-entity Alice (Sleepy + Hungry) + Narraville (none) listing. |
| scene-nav-arrows.webp | ui/detail-panel/scene/img/ | Close-up of the prev/next scene navigation arrows in the Detail panel header (position 1/3, back arrows greyed out). |
| character-overview.webp | ui/detail-panel/entity-character/img/ | Character Detail Panel for Alice — POV-chain navigator at top, name + profile image, Details sub-tab with Description, Aliases (empty), Colour, Additions at this point. |
| character-with-alias-draft.webp | ui/detail-panel/entity-character/img/ | Same panel with a partially-typed alias "Ali" sitting in a draft chip ready to commit. |
| character-attributes-tab.webp | ui/detail-panel/entity-character/img/ | Character Detail Panel on Attributes sub-tab showing Gender = Female (preset, +ADDED), Circumstances + Motivators sub-headings empty with "+ Add" affordances. |
| character-add-attribute.webp | ui/detail-panel/entity-character/img/ | Same panel with the inline "Add attribute" form open, "Personality: Bubbly" already added below, and Unsaved indicator. |
| location-overview.webp | ui/detail-panel/entity-location/img/ | Location Detail Panel for Cafe-Narra — Details sub-tab with description "A cozy little coffee shop", Aliases (empty), Colour, Hierarchy (Narraville › Cafe-Narra). |
| location-overview-unsaved.webp | ui/detail-panel/entity-location/img/ | Same Location Detail Panel showing the "Unsaved" indicator next to the name (description edit in progress). |
| location-hierarchy.webp | ui/detail-panel/entity-location/img/ | Canvas-side hierarchy demonstration: two location-origin EntityNodes (parent Narraville + child Narraville Library) showing how parent_id is expressed at origin. |
| relationship-overview.webp | ui/detail-panel/relationship/img/ | Relationship Detail Panel for "Bob & Alice" with their two profile images, Description, Participants (2) collapsed, Changes at this scene = JOINED Bob / JOINED Alice. |
| relationship-by-participant.webp | ui/detail-panel/relationship/img/ | Same Relationship panel with one participant (Alice) expanded — view / alias / role inline edit form open. |
| relationship-with-name.webp | ui/detail-panel/relationship/img/ | Same panel after the relationship has been named "First Date" — name now appears above the auto pair label "Bob & Alice". |
| entity-awareness-known-by.webp | ui/detail-panel/knowledge/img/ | Entity Awareness sub-tab in empty state — "Known by…" header, Precision toggles, Aware (0) / Unaware (0) rows; "Aware of…" section showing the four awareness levels (Fully / Partially / Nominally / Unaware) with placeholder. |
| entity-awareness-known-by-populated.webp | ui/detail-panel/knowledge/img/ | Same Awareness sub-tab populated — Aware (2) with Alice + Bob chips. |
| scene-time-with-prior-context.webp | ui/scene-time/img/ | Full modal opened for a downstream scene — left column populated with "PREVIOUS SCENE" Morning / Mar 8 / Fall / Duration All, "Right after" label, "THIS SCENE / No time data pinned", and Set-this-scene-to-follow-the-previous-scene button. |
| scene-time-prior-context-close-up.webp | ui/scene-time/img/ | Close-up of the Prior Scene Context column: previous-scene chip, "Right after" label, this-scene chip, set-follow button, extra-time-since-last-scene controls. |
| scene-time-extra-time-detail.webp | ui/scene-time/img/ | Close-up of the extra-time-since-last controls explaining how the input snaps forward to the next day's Noon when the pin is earlier than the floor. |
| time-of-day-labelled.webp | ui/scene-time/img/ | Close-up of the Time of Day "Labelled" sub-tab with the day-cycle illustration; Morning is selected (highlighted circle). |
| season-selected.webp | ui/scene-time/img/ | Close-up of the Season row with the Fall icon highlighted in orange (selected). |
| date-weekday.webp | ui/scene-time/img/ | Close-up of the Date row with only Weekday toggle on; Sun–Sat day buttons visible. |
| duration-length.webp | ui/scene-time/img/ | Duration row in "Length" mode showing optional decimal input + hours/units dropdown. |
| new-circumstance-form.webp | ui/circumstances-motivators/img/ | Inline "New Circumstance" form on a Character detail panel — Name / Description fields empty, intensity scale visible (Unset selected), Add / Cancel buttons. |
| circumstance-added.webp | ui/circumstances-motivators/img/ | Same row after saving — "Sleepy (Moderate)" circumstance chip with the +ADDED indicator. |
| new-motivator-form.webp | ui/circumstances-motivators/img/ | Inline "New Motivator" form populated with name "Hungry", description "Alice is getting really hungry and wants something to eat", intensity = Strong. |
| motivator-added.webp | ui/circumstances-motivators/img/ | Same row after saving — "Hungry / Alice is getting really hungry and wants something to eat (Strong)" motivator chip with +ADDED indicator. |
| menu-bar.webp | ui/menu/img/ | Top app bar close-up showing the hamburger menu button, NarrativeNode logo + label, sidebar / dock buttons, search button, save state (orange dot), and project filename "Help_Fixture.nnz". |
| hamburger-menu.webp | ui/menu/img/ | Hamburger menu open showing the full application menu: New / Open… / recent files / Save / Save As… / Find… / Import / Export / Help / Settings. (Updated v0.1.27+ to include the new Help entry.) |
| alerts-panel-empty.webp | ui/alerts-panel/img/ | Alerts panel in empty state — "No active alerts" message, bell icon top-right with no count badge. |
| alerts-panel-orphan-alert.webp | ui/alerts-panel/img/ | Alerts panel with one alert: Alice in SCENE "They Meet at a coffee shop" — Orphaned: no incoming narrative-flow wire. |
| alerts-icon-badge.webp | ui/alerts-panel/img/ | Close-up of the alerts bell icon with an orange "1" count badge. |
| alerts-panel-review.webp | ui/alerts-panel/img/ | Alerts panel showing a chain re-flow review alert: Alice's "Personality" attribute changed upstream (Bubbly → Exuberant in Untitled Scene); downstream scene "They Meet at a coffee shop" has its own existing change (Bubbly → Outgoing) flagged for review. Approve checkmark visible. |
| scene-chip-pending-review.webp | nodes/scene/img/ | POV chip + Alice entity chip in a scene, with an attribute sub-chip in the pending-review state — "?" placeholder before the arrow, indicating the upstream value is ambiguous and needs the writer's confirmation. |
| entity-origin-location-generic.webp | nodes/entity/img/ | Generic placeholder Location origin "A Location" (default pin icon) — bare-minimum NEW : LOCATION node. |
| entity-origin-item-generic.webp | nodes/entity/img/ | Generic placeholder Item origin "An Item" (default backpack icon) — bare-minimum NEW : ITEM node. |
| entity-origin-faction-generic.webp | nodes/entity/img/ | Generic placeholder Faction origin "A Faction" with the auto-attached "A Faction Members" membership relationship chip "+ STARTED" beneath the node. |
| entity-origin-custom-generic.webp | nodes/entity/img/ | Generic placeholder Custom origin "Custom" with its "Custom Category" sub-label visible — bare-minimum NEW : CUSTOM node. |
| knowledge-origin.webp | nodes/knowledge-origin/img/ | Close-up of a Knowledge Origin node ("NEW : KNOWLEDGE" amber badge, book icon, "Knowledge" placeholder name) — the canvas-side anchor for a pre-story Knowledge. |
| relationship-origin-empty.webp | nodes/relationship-origin/img/ | Empty Relationship Origin node showing the placeholder name "Empty relationship" and the instructional prose "Wire a NEW : ___ node in to add a participant. (character, location, item, faction, custom, knowledge)". |
| group-node-empty.webp | nodes/group/img/ | Empty Generic Group node in unselected state — grey header bar with placeholder "Group" italic label and an empty dotted-grid body. |
| group-node-empty-selected.webp | nodes/group/img/ | Same empty Group node in selected state — purple header band with X close affordance and purple body border. |
| group-with-characters.webp | nodes/group/img/ | Generic Group node with two character origin nodes (Carly, Dani) placed inside it, both showing Gender = Female chips — demonstrates how a Group wraps a freeform cluster of nodes. |
| hamburger-menu-expanded.webp | ui/menu/img/ | Hamburger menu open showing New, Open with recent files (Help_Fixture.nnz, Help Fixture.nnz, TestFixture_001/026.nnz, Dracula.nnz), Save, Save As, Find, Import, Export, Help, Settings entries — full menu vertical strip. |
| import-entities-empty.webp | ui/import/img/ | Import Entities from Project File dialog in its initial empty state — "Choose project file…" button highlighted, "No file chosen" prompt, type-filter tab row empty, "Choose a project file above to load its entities." message in left rail, "Load a project file to begin." centred in the timeline grid. |
| import-entities-loaded.webp | ui/import/img/ | Import Entities dialog populated from Help_Fixture.nnz — 8 entities listed left (Alice, Bob, Carly, Dani, Eric, Narraville, Narraville Library, Cafe-Narra), timeline grid showing Origin → "The Beginning" → "They Meet at a coffee shop" → "Untitled Scene" → Final columns with chain dots for each entity; Cafe-Narra selected with detail footer ("A cozy little coffee shop"). |
| import-entities-entity-selected.webp | ui/import/img/ | Same dialog with Alice selected — Alice row highlighted across the timeline grid; bottom detail strip shows Alice at "The Beginning" with attributes (Gender = Female PRESET, Personality = Bubbly TEXT) and circumstance/motivator chips (Sleepy CIRCUMSTANCE, Hungry MOTIVATOR). |
| import-template-paste.webp | ui/import/img/ | Import from Template dialog, Paste-text tab active — explanatory copy, "Download story template (.md)" link, empty textarea ("Paste your populated template here…"), Mode radios (New project / Merge), Origin layout dropdown ("Place origins by first appearance"), Preview button disabled. |
| import-template-file-selected.webp | ui/import/img/ | Same dialog, Upload-file tab active with help-fixture.template.md selected next to the Browse button; Preview button enabled. |
| import-template-parsed.webp | ui/import/img/ | Import from Template summary step — "Parsed help-fixture.template.md in new mode." with a two-column count tile grid (Characters 3, Locations 3, Items 1, Factions 1, Customs 1, Relationships 2, Knowledge 2, Scenes 6, Chapters 3, Preset Lists 2, Custom Categories 1) and Back / Start new project actions. |
| export-dialog-presets.webp | ui/export/img/ | Export Story dialog at its top section — Preset rail (NarrativeNode native selected, Shunn manuscript, NovelCrafter format, Customize), preset description ("The writer's working copy. Includes Changes blocks at every scene…"), Format radios (Microsoft Word .docx selected; PDF, Markdown, HTML, Plain text), Page Size (A4 / Letter), Scope (Whole story / POV only / Selected scope), Entity-state-in-reference-sheets radios. |
| export-dialog-customize.webp | ui/export/img/ | Export Story dialog scrolled to the Customize panel — Entity context line detail dropdown ("Off"), and Header / Structure / Per-scene / Appendices / Media attributes / Appearance accordion sections with their individual checkboxes (Act headings, Chapter headings, Scene body, Changes block, Entity reference sheets, Knowledge appendix, etc.). |
| act-chapter-bands.webp | concepts/chapters-and-acts/img/ | Wide horizontal strip showing the canvas overlay header bands: "Act 1" running across the top, with "Chapter 1: It all starts somewhere..." and "Chapter 2: The Story Continues!" sitting beneath it side-by-side. Illustrates how acts span multiple chapters and chapters span multiple scene columns. |
| toc-panel-full-story.webp | ui/table-of-contents/img/ | Table of Contents panel showing the full Help_Fixture story — three acts, four chapters, and 11 scenes including a couple of unchaptered scenes at the bottom. POV filter inactive (greyed); search icon visible at the top right. |
| toc-pov-filter-active.webp | ui/table-of-contents/img/ | Same panel with the POV filter turned ON (yellow POV pill) — the unchaptered scenes that were not on the POV chain have dropped from the list, leaving the chaptered POV-included scenes only. |
| navigator-with-acts.webp | ui/timeline-navigator/img/ | Timeline Navigator with the act / chapter header bands enabled — "Act 1" spans "It all starts somewhere…" + "The Story Continues!", "Act 2" spans "A Resolution?!", "Act 3" spans "The End..?", with individual scene columns underneath. Five entity rows (Alice, Bob, Carly, Dani, Eric) plus their chain dots. |
| canvas-top-with-act-chapter-overlay.webp | ui/canvas-overview/img/ | Top edge of the canvas: title bar (hamburger / fit / find / save / Help_Fixture.nnz / project title / alerts pill on the right) above a full-width act overlay band (Act 1 / Act 2 / Act 3) and a chapter sub-band (Chapter 1 / 2 / 3 / 4 with their titles). |
| alias-awareness-empty.webp | concepts/awareness-model/img/ | Names & Aliases modal opened on Alice's alias "Ali" — empty Known by panel with the 4-level alias-precision bands (Fully aware / Partially aware / Nominally aware / Unaware) all at 0 entries; Track-who-knows toggle on. |
| alias-awareness-populated.webp | concepts/awareness-model/img/ | Same modal with the alias-awareness levels populated — Bob in Fully aware, Carly in Partially aware, Eric in Nominally aware, Dani in Unaware. Demonstrates the per-observer alias awareness scale in use. |
| character-awareness-tab.webp | ui/detail-panel/entity-character/img/ | Character Detail panel's Awareness tab for Bob — Known by section collapsed (Track-who-knows OFF), and "Aware of..." section underneath listing what Bob is aware of, grouped by awareness level. Fully aware contains the Cafe-Narra entity and Alice's "Ali" alias; lower levels empty. |
| character-awareness-precision-2level.webp | ui/detail-panel/entity-character/img/ | Same panel with Track-who-knows ON and Precision set to the 2-level scale (Aware / Unaware) — the Known-by section shows the simpler binary bands instead of the 4-level set. |
| character-awareness-precision-4level.webp | ui/detail-panel/entity-character/img/ | Same panel with Precision set to the 4-level scale (Fully aware / Partially aware / Nominally aware / Unaware) — the Known-by section shows all four bands, alongside the unchanged Aware-of section below. |
| relationship-wires-canvas.webp | concepts/wire-kinds/img/ | Canvas excerpt with two character origins (Bob, Alice) on the left and a "NEW : RELATIONSHIP" origin "Bob & Alice" on the right. Dashed magenta/pink relationship wires connect each participant's chip to the relationship origin, plus an additional dashed wire (off the top of Bob) running off-frame. Demonstrates the appearance and behaviour of relationship wires. |
| faction-origin-with-membership-relationship-wires.webp | nodes/entity/img/ | Canvas excerpt with two character origins (Bob, Alice) wired into a "NEW : FACTION" origin "A New Faction" on the right. The faction shows its auto-attached "A New Faction Members" membership relationship chip with green "+ STARTED" and two green "+ JOINED" entries (Bob, Alice). Dashed membership wires connect each character to the faction. |
| faction-relationships-tab.webp | ui/detail-panel/entity-faction/img/ | Faction Detail panel for "A New Faction" with the Relationships tab active. Shows the FACTION header / colour pill / flag icon, the tab strip (Details / Attributes / Relationships / Awareness), and a MEMBERSHIP card listing "A New Factio... · Bob & Alice · members" plus + Add Member and + Add Relationship buttons. |

<!-- Append captured rows here as screenshots are sorted out of unsorted/. -->

---

## Unidentified shots

| Filename | Current location | Best-guess description |
|---|---|---|
| Screenshot 2026-05-13 144226.webp | .Tools/help-screenshots/unsorted screenshots/unidentified/ | Empty Modifier node "← Wire an entity to configure" — visually equivalent to the already-captured `nodes/modifier/img/modifier-empty.webp` (minor selection-state framing differences only). Held for the user to decide whether it earns its own variant slot. |
| Screenshot 2026-05-13 144231.webp | .Tools/help-screenshots/unsorted screenshots/unidentified/ | Empty Reference Note "Type your notes here…" — visually equivalent to the already-captured `nodes/reference/img/reference-note-empty.webp`. Held for triage. |
| Screenshot 2026-05-13 144236.webp | .Tools/help-screenshots/unsorted screenshots/unidentified/ | Empty Reference Media with "Upload Media" CTA — visually equivalent to the already-captured `nodes/reference/img/reference-media-empty.webp`. Held for triage. |

<!-- Append unidentified rows here for the user to triage later. -->
