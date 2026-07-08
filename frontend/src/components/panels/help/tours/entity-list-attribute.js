// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: entity-list-attribute. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "entity-list-attribute",
  category: "entity",
  tier: "base",
  parent: "entity-modal",
  order: 2,
  title: "Entity List Attribute",
  intro: "An entity-list attribute holds a list of other entities rather than plain text, for a detail that is really a set of links: a character's allies, the members of a faction, the items in a room. Each entity you add shows as a small linked chip, and the chip reflects that entity's name and colour as they stand at this point in the story. Because it lives on the chain like any other value, the list you set here carries forward to every later scene until a scene changes it.",
  screenshotFile: "entity-list-attribute.webp",
  screenshotAlt: "Entity List Attribute screenshot.",
  sections: [
    { id: "editor", label: "List", region: { x: 1.21, y: 66.52, w: 11.54, h: 3.65 }, body: "The list itself, shown as a row of linked entity chips. Each chip displays the linked entity's current name and colour at this point in the story, and clicking it takes the detail panel across to that entity." },
    { id: "add_button", label: "Add", region: { x: 8.15, y: 67.18, w: 4.59, h: 2.31 }, body: "Adds another entity to the list. It opens a picker of your entities to choose from, and you can also drag an entity straight onto the list from the Entity Library." },
  ],
}
