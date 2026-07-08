// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: hierarchy-tree. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "hierarchy-tree",
  category: "",
  tier: "element-detail",
  parent: "detail-location",
  order: 1,
  title: "Hierarchy Tree",
  intro: "This is a tree view of how entities of one kind nest inside one another, with each child indented under its parent: a location sitting inside a wider region, or members ranked under whoever leads them. It reads top to bottom as an outline of the structure, and you reshape that structure by dragging rows around. Use it to keep a clear picture of who or what sits where, separate from the order events happen in.",
  screenshotFile: "hierarchy-tree.webp",
  screenshotAlt: "Hierarchy Tree screenshot.",
  sections: [
    { id: "tree", label: "Tree", region: { x: 2.71, y: 5.48, w: 94.58, h: 89.04 }, body: "The whole hierarchy shown as nested rows, parents above and children indented beneath them, with connecting lines tracing each branch. Top-level entities sit flush left, and everything that belongs inside them folds underneath." },
    { id: "row", label: "Row", region: { x: 2.71, y: 8.9, w: 94.58, h: 27.4 }, body: "One entity at its place in the structure, showing its colour, picture or type icon, and name. Drag it onto another row to nest it inside that entity, or onto the canvas to place it there; use the triangle to fold its children away, and the row's buttons to locate, tag, or remove it. A warning mark flags an entity caught in a circular parent loop that you will need to drag somewhere valid." },
  ],
}
