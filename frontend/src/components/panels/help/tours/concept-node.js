// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: concept-node. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "concept-node",
  category: "Nodes",
  tier: "base",
  parent: "canvas-overview",
  order: 11,
  title: "Concept Node",
  intro: "A concept node is a reference card built for brainstorming. Like any reference card it holds a title, a colour, and free text and stays entirely outside your story, but it also carries connection ports so you can wire concepts to one another and to groups. Use them to sketch how ideas, themes, or possibilities relate before any of it becomes a scene. The links are a loose map for your own planning; they never touch an entity's history, the reading order, or what gets exported.",
  screenshotFile: "concept-node.webp",
  screenshotAlt: "Concept Node screenshot.",
  sections: [
    { id: "ports", label: "Concept ports", region: { x: 2.75, y: 4.68, w: 8.65, h: 14.7 }, body: "Eight triangle ports, one at each corner and one on the middle of each edge. They stay hidden until you hover or select the node, or while a concept wire is being drawn, then appear so you can start or receive a link. Any port can connect to any other; a port points inward until you drag a wire out of it, when it turns to point outward. Every port behaves the same, so use whichever sits closest to where the wire should run.", parent: "concept-node:node", extras: [{"x":45.68,"y":4.68,"w":8.65,"h":14.7},{"x":88.6,"y":4.68,"w":8.65,"h":14.7},{"x":88.6,"y":42.65,"w":8.65,"h":14.7},{"x":82.31,"y":69.94,"w":8.65,"h":14.7},{"x":45.68,"y":80.63,"w":8.65,"h":14.7},{"x":2.75,"y":80.63,"w":8.65,"h":14.7},{"x":2.75,"y":42.65,"w":8.65,"h":14.7}] },
    { id: "node", label: "Concept node", region: { x: 6.76, y: 11.49, w: 86.48, h: 77.02 }, body: "The card itself: a title, a colour, and free text, the same as a plain note, but marked as a concept and fitted with connection ports. It lives outside the story and never affects any scene, entity, or export; it is purely a place to hold an idea while you map how it relates to others." },
    { id: "header", label: "Title and colour", region: { x: 7.08, y: 12.02, w: 85.85, h: 20.77 }, body: "The top bar: a colour chip, the concept badge, and the title. Set the colour to sort your concepts at a glance on the canvas, and name the idea in the title, which can stay blank while the concept is still just a placeholder.", parent: "concept-node:node" },
    { id: "tags", label: "Tags", region: { x: 7.08, y: 32.8, w: 85.85, h: 19.37 }, body: "Labels you attach to this concept so it can be grouped and filtered alongside other cards that share a tag. Useful for sorting a board full of loose ideas once it fills up.", parent: "concept-node:node" },
    { id: "body", label: "Notes", region: { x: 7.08, y: 52.17, w: 85.85, h: 35.81 }, body: "The concept's free text: jot down the idea, a question, or anything worth remembering about it. Like the rest of the card it stays outside the story and is never exported.", parent: "concept-node:node" },
  ],
}
