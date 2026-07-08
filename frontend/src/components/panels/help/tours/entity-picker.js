// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: entity-picker. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "entity-picker",
  category: "chat",
  tier: "base",
  parent: "detail-relationship",
  order: 0,
  title: "Entity Picker",
  intro: "A small popover for choosing one of your story's entities. It appears wherever an entity needs to be named: adding a participant to a relationship, attaching a reference, or pointing one entity at another. Narrow the list by type and by name, then click the one you want. Picking a row leaves the popover open so you can add several in a row.",
  screenshotFile: "entity-picker.webp",
  screenshotAlt: "Entity Picker screenshot.",
  sections: [
    { id: "popover", label: "Entity picker", region: { x: 94.65, y: 74.02, w: 5.35, h: 21.62 }, body: "The whole picker. Everything you have created as a character, location, item, faction, or custom entity can be reached from here, filtered down to just what fits the place you are adding it." },
    { id: "type_tabs", label: "Type tabs", region: { x: 94.69, y: 74.1, w: 5.31, h: 2.96 }, body: "Limit the list to one kind of entity at a time, or show every kind together. Useful when you know you want a location, say, and do not want characters and items cluttering the results." },
    { id: "search", label: "Search", region: { x: 95, y: 77.64, w: 5, h: 2.49 }, body: "Type part of a name to jump straight to it. Filtering by name works alongside the type tabs, so you can narrow on both at once when your cast is large." },
    { id: "entity_row", label: "Row", region: { x: 95, y: 92, w: 5, h: 1.95 }, body: "One entity you can choose, shown with its colour, name, and type icon. Click it to add it where the picker was opened; the picker stays open so you can keep adding more." },
    { id: "close", label: "Close", region: { x: 95, y: 93.67, w: 5, h: 1.31 }, body: "Dismiss the picker when you are finished choosing. Use this once you have added everything you wanted, since selecting a row does not close it on its own." },
  ],
}
