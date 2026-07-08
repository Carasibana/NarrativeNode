// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: perspective-target-picker. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "perspective-target-picker",
  category: "",
  tier: "element-detail",
  parent: "detail-relationship",
  order: 2,
  title: "Perspective Target Picker",
  intro: "A perspective records one character's view of something else in your story: a person they see as a rival, a place they think of as home, a secret they hold. This picker chooses what that view is aimed at. You can point it at any entity, at a relationship between entities, or at a piece of tracked knowledge, so the perspective always names a real thing in your story rather than free text.",
  screenshotFile: "perspective-target-picker.webp",
  screenshotAlt: "Perspective Target Picker screenshot.",
  sections: [
    { id: "picker", label: "Picker", region: { x: 11.53, y: 58.55, w: 73.56, h: 30.16 }, body: "The full picker for choosing what a character's perspective is about. Pick a kind across the top, narrow the list by typing, then click a row to set the target." },
    { id: "kind_tabs", label: "Kind", region: { x: 11.86, y: 58.64, w: 72.88, h: 3.5 }, body: "Filters the list by what kind of thing the perspective is on: any of the entity types (character, location, item, faction, custom), a relationship, a piece of knowledge, or all kinds at once. Choosing a kind keeps the list short when your story has many entities." },
    { id: "search", label: "Search", region: { x: 14.41, y: 62.91, w: 67.8, h: 2.95 }, body: "Type to find the target by name. The list narrows as you type, so you can reach the right person, place, relationship, or knowledge without scrolling." },
    { id: "results", label: "Results", region: { x: 14.41, y: 66.32, w: 67.8, h: 18.39 }, body: "The matching targets you can choose from, each with its name and a small icon showing its kind. Click one to make it the subject of the perspective." },
  ],
}
