// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: timeline-navigator. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "timeline-navigator",
  category: "Dialogs",
  tier: "base",
  parent: "menu-bar",
  order: 2,
  title: "Timeline Navigator",
  intro: "The timeline navigator lays your whole story out as a grid: each entity (and each relationship) gets a row down the side, and each scene becomes a column in story order. A coloured dot wherever a row meets a column shows you that entity is present in that scene, so you can scan at a glance who appears where and follow a thread across the book. Selecting any header, cell, or dot jumps the canvas and detail panel to that exact point in the story. Filter by type and search by name to find what you want in a long story quickly.",
  screenshotFile: "timeline-navigator.webp",
  screenshotAlt: "Timeline Navigator screenshot.",
  sections: [
    { id: "pin", label: "Pin", region: { x: 95.89, y: 1.96, w: 2.67, h: 3.91 }, body: "Keeps the navigator open while you work elsewhere, instead of letting it close when focus moves away. Useful when you are stepping through several scenes in a row and want the overview to stay put.", order: 0 },
    { id: "bookend_column", label: "Bookend column", region: { x: 20, y: 15.4, w: 5.8, h: 10.9 }, body: "The two fixed columns that frame the grid: one marks each entity's starting point and the other marks where the story leaves off. They stay pinned at the edges as the scene columns scroll, giving you a stable anchor for the beginning and end of every row.", order: 1, extras: [{"x":93.1,"y":15.4,"w":5.8,"h":10.9}] },
    { id: "scene_header", label: "Scene header", region: { x: 25.9, y: 7.6, w: 67, h: 18.7 }, body: "The column heading for one scene, carrying its title and its place in the running order. Selecting it focuses that scene on the canvas, so the grid doubles as a way to jump straight to any beat in the story.", target: {"type":"surface","ref":"scene-time"}, order: 2 },
    { id: "identity_cell", label: "Identity cell", region: { x: 0.2, y: 25.8, w: 19.8, h: 74.2 }, body: "The label at the head of a row, naming the entity or relationship that row tracks across the story. Clicking it takes you to that entity's starting point and opens its detail, a quick way to see where it begins before following its thread along the row.", order: 3 },
    { id: "entity_dot", label: "Entity dot", region: { x: 33.6, y: 28.6, w: 1.5, h: 2.9 }, body: "A coloured marker placed where a row crosses a scene column, meaning that entity is present in that scene. Its colour reflects the entity's appearance at that point in the story, and clicking it opens that entity's detail as it stands in that scene.", order: 4, extras: [{"x":50.3,"y":28.6,"w":1.5,"h":2.9},{"x":83.9,"y":28.6,"w":1.5,"h":2.9},{"x":50.4,"y":36.5,"w":1.5,"h":2.9},{"x":83.9,"y":44.2,"w":1.5,"h":2.9},{"x":33.6,"y":60,"w":1.5,"h":2.9},{"x":50.4,"y":59.9,"w":1.5,"h":2.9},{"x":83.9,"y":67.8,"w":1.5,"h":2.9},{"x":50.4,"y":75.5,"w":1.5,"h":2.9},{"x":33.6,"y":83.4,"w":1.5,"h":2.9},{"x":83.9,"y":75.5,"w":1.5,"h":2.9}] },
    { id: "filters", label: "Filters", region: { x: 0.11, y: 7.83, w: 19.89, h: 6.85 }, body: "Limits the rows to a single kind of entity, so you can look at just characters, or just locations, without the rest crowding the grid. Helpful for tracing one type of thread through a busy story." },
    { id: "search", label: "Search", region: { x: 0.78, y: 17.83, w: 15.34, h: 4.89 }, body: "Filters the rows by name so only matching entities stay on the grid. The fastest way to find one character or place in a story with a long cast." },
  ],
}
