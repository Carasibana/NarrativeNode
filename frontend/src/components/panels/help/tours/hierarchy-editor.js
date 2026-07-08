// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: hierarchy-editor. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "hierarchy-editor",
  category: "Library & Editor",
  tier: "base",
  parent: "detail-location",
  order: 0,
  title: "Hierarchy Editor",
  intro: "The hierarchy editor is where you arrange entities of one kind into a parent-and-child tree, so the story can track nested structure like a town inside a region, or a captain above the soldiers who report to them. It opens for a single entity type at a time, either locations or factions, and shows every entity of that type with its current nesting. Setting a parent here is the same as recording that one entity belongs inside or under another, which the rest of the app then reflects wherever that entity appears.",
  screenshotFile: "hierarchy-editor.webp",
  screenshotAlt: "Hierarchy Editor screenshot.",
  sections: [
    { id: "tree", label: "Tree", region: { x: 0.31, y: 28.08, w: 99.38, h: 71.23 }, body: "This is the full hierarchy laid out as indented rows, each entity sitting beneath its parent. Drag any entity onto another to make it a child of that one, or drag it out to the top level to detach it. Click an entity to jump to its place on the canvas and review it in detail." },
  ],
}
