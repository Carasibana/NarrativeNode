// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: group-node. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "group-node",
  category: "Nodes",
  tier: "base",
  parent: "canvas-overview",
  order: 9,
  title: "Group Node",
  intro: "A group is a labelled box you draw around related nodes to tidy the canvas. As a container it is a purely visual aid: it does not change the order your story is told in or affect any entity's state, it just keeps clusters of scenes or entities together so a sprawling canvas stays readable and easy to move around. A group also carries concept ports, so the whole box can be wired into the concept map alongside concept notes.",
  screenshotFile: "group-node.webp",
  screenshotAlt: "Group Node screenshot.",
  sections: [
    { id: "ports", label: "Concept ports", region: { x: 1.61, y: 2.08, w: 5.05, h: 6.55 }, body: "The eight triangle ports a group carries for the concept map, one at each corner and one on the middle of each edge. Hidden until you hover or select the group, they let you wire the whole box to concept notes and to other groups, so a cluster can take part in your brainstorming links. They never affect the story, the reading order, or what the group contains.", parent: "group-node:node", extras: [{"x":47.48,"y":2.08,"w":5.05,"h":6.55},{"x":93.35,"y":2.08,"w":5.05,"h":6.55},{"x":93.35,"y":46.73,"w":5.05,"h":6.55},{"x":89.68,"y":86.61,"w":5.05,"h":6.55},{"x":47.48,"y":91.37,"w":5.05,"h":6.55},{"x":1.61,"y":91.37,"w":5.05,"h":6.55},{"x":1.61,"y":46.73,"w":5.05,"h":6.55}] },
    { id: "node", label: "Group node", region: { x: 4.13, y: 5.36, w: 91.74, h: 89.29 }, body: "The group box itself. Drag its header and everything currently sitting inside the box moves with it, so you can shift a whole cluster of scenes or entities at once without disturbing how they connect. Deleting the group leaves its contents on the canvas untouched." },
    { id: "header", label: "Group label", region: { x: 4.13, y: 5.36, w: 91.74, h: 7.74 }, body: "The coloured bar at the top, where you name the group and set its colour. A clear label marks what the enclosed nodes have in common, such as a chapter, an act, or a set of characters that belong together.", parent: "group-node:node" },
    { id: "body", label: "Grouped area", region: { x: 4.13, y: 13.1, w: 91.74, h: 81.55 }, body: "The translucent interior of the box. Whatever nodes you position inside its bounds count as part of the group and travel with it, but clicks pass straight through to those nodes so you can still select and edit them normally.", parent: "group-node:node" },
  ],
}
