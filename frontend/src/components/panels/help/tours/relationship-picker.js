// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: relationship-picker. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "relationship-picker",
  category: "chat",
  tier: "base",
  parent: "detail-relationship",
  order: 1,
  title: "Relationship Picker",
  intro: "A small chooser for picking one relationship from your story. It appears wherever you attach a relationship as context, such as when you hand the chat assistant something specific to work with. Type to narrow a long list, then click the one you mean. Relationships you have already added are left out so you only see what is still available to pick.",
  screenshotFile: "relationship-picker.webp",
  screenshotAlt: "Relationship Picker screenshot.",
  sections: [
    { id: "popover", label: "Relationship picker", region: { x: 94.65, y: 85.22, w: 5.35, h: 10.42 }, body: "The chooser itself. Each row is a relationship between two or more of your story's people, places, or things, named however you labelled it or, if unnamed, by its participants. Picking one attaches it where you opened the picker." },
    { id: "search", label: "Search", region: { x: 95, y: 85.89, w: 5, h: 2.49 }, body: "Filters the list as you type, matching against each relationship's name or its participants. Handy once you have more relationships than fit comfortably in view." },
    { id: "relationship_row", label: "Row", region: { x: 95, y: 90.96, w: 5, h: 2 }, body: "One relationship you can choose. Click it to select that relationship and close the picker. The little badge shows the relationship's label so you can tell apart who is involved." },
    { id: "close", label: "Close", region: { x: 95, y: 93.67, w: 5, h: 1.31 }, body: "Dismisses the picker without choosing anything, leaving your context unchanged." },
  ],
}
