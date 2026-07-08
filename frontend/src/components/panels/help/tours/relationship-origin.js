// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: relationship-origin. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "relationship-origin",
  category: "Nodes",
  tier: "base",
  parent: "canvas-overview",
  order: 5,
  title: "Relationship Origin",
  intro: "A relationship node is where a relationship begins: it names the bond, gives it a colour, and gathers the entities it connects. This is its starting point, the state every later scene inherits and builds on. From here the relationship's story is followed forward as participants join, leave, take on roles, or come to see one another differently at the scenes where those changes happen.",
  screenshotFile: "relationship-origin.webp",
  screenshotAlt: "Relationship Origin screenshot.",
  sections: [
    { id: "header", label: "Name and colour", region: { x: 2.22, y: 34.57, w: 97.22, h: 40.43 }, body: "The relationship's name and colour, which set how it reads on the canvas and in the chips that mark it at each scene. If you leave the name blank, a label is built automatically from the participants taking part.", target: {"type":"surface","ref":"relationship-chip"} },
    { id: "participants", label: "Participants", region: { x: 2.22, y: 75, w: 97.22, h: 25 }, body: "The entities bound together in this relationship, shown as small avatars, in their starting arrangement. This is the relationship's beginning; later comings and goings are recorded at the scenes where they occur rather than changed here." },
  ],
}
