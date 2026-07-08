// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: seeds-editor. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "seeds-editor",
  category: "Dialogs",
  tier: "element-detail",
  parent: "settings",
  order: 20,
  title: "Seeds Editor",
  intro: "A seed is the starting kit a new entity is born with. This editor sets which attributes each type of entity (character, location, item, faction, or custom) is created with already in place, and which preset lists travel with the project so those attributes have ready-made choices to draw from. Setting up seeds once spares you from re-adding the same fields every time you create an entity. These are starting points only: once an entity exists, its values are set and changed at each scene as the story unfolds.",
  screenshotFile: "seeds-editor.webp",
  screenshotAlt: "Seeds Editor screenshot.",
  sections: [
    { id: "editor", label: "Seeds editor", region: { x: 4.5, y: 3.1, w: 94.1, h: 95 }, body: "Defines what every new entity begins with: the default attributes pre-filled per entity type, and the preset lists bundled with the project for those attributes to choose from." },
    { id: "default_attributes", label: "Default attributes", region: { x: 4.5, y: 3.1, w: 94.1, h: 66.8 }, body: "The attributes each new entity is created with already in place, organised by entity type so a character and a location can start with different fields. These are just a head start; you can still add, change, or remove them on any individual entity later." },
    { id: "type_group", label: "Type group", region: { x: 4.5, y: 9.5, w: 94.1, h: 10.7 }, body: "The default attributes for one entity type: characters, locations, items, factions, or custom entities. Every new entity of this type inherits the attributes listed here." },
    { id: "add_stub", label: "Add attribute", region: { x: 89.5, y: 10.9, w: 7.8, h: 3.1 }, body: "Adds another default attribute to this entity type, so every new entity of this type will start with it." },
    { id: "stub_row", label: "Default attribute", region: { x: 6, y: 14.9, w: 91.2, h: 4 }, body: "One starting attribute: its name and the kind of value it holds (free text, a list of text, or a choice from a preset list). Preset attributes take their name from the list they point to." },
    { id: "bundled_preset_lists", label: "Bundled preset lists", region: { x: 4.5, y: 73.6, w: 94.1, h: 24.5 }, body: "The preset lists that travel with the project as part of its seeds. A preset list is a fixed set of choices (for example a list of species or ranks) that a preset-type attribute can pull its value from, keeping entries consistent across entities." },
    { id: "add_bundled_preset_list", label: "Add preset list", region: { x: 6, y: 84.2, w: 91.2, h: 3.7 }, body: "Creates a new preset list to bundle with the project, giving it a name and its set of choices. A default attribute can then reference this list by name even before the list exists elsewhere in the project." },
    { id: "bundled_preset_list_row", label: "Preset list", region: { x: 6, y: 89.1, w: 91.2, h: 7.4 }, body: "One bundled preset list, showing its name and its choices. Edit it to rename the list or change which values it offers." },
  ],
}
