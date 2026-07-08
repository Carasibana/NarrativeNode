// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: add-nodes-menu. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "add-nodes-menu",
  category: "",
  tier: "modal",
  parent: "canvas-overview",
  order: 2,
  title: "Add Nodes Menu",
  intro: "This is where you place new things on the canvas. The list spans the whole vocabulary of a story: scenes and flashbacks, the five entity types, knowledge, relationships, a way to record a mid-story change, reference material kept to one side, and grouping boxes. It also offers an Add POV Start action that places the origin marker for the point-of-view path, the path that sets reading order; this action appears only until one exists. Pick an item and the matching node drops onto the canvas, ready to wire into your narrative.",
  screenshotFile: "add-nodes-menu.webp",
  screenshotAlt: "Add Nodes Menu screenshot.",
  sections: [
    { id: "scene", label: "Scene", region: { x: 2.86, y: 1.46, w: 94.29, h: 6.8 }, body: "A scene is the basic building block of your story: one beat or moment. You wire scenes together to set the order events happen in, and the characters, places, and items present at that moment appear inside the scene as chips." },
    { id: "flashback", label: "Flashback", region: { x: 2.86, y: 8.25, w: 94.29, h: 6.8 }, body: "A flashback is a scene the reader meets out of layout order: it sits at one point in time but is told at another. It behaves like any other scene, but is marked so the tool knows its place in the reading sequence differs from where it falls on the canvas." },
    { id: "character", label: "Character", region: { x: 2.86, y: 17.23, w: 94.29, h: 6.8 }, body: "Adds a character: a person or being in your story. Characters are the only entities that can carry the point of view, and the details you set here are the starting state that carries forward until you change it at a later scene.", link: "entity-modal" },
    { id: "location", label: "Location", region: { x: 2.86, y: 24.03, w: 94.29, h: 6.8 }, body: "Adds a location: a place or setting. Locations can be nested inside one another to capture where things sit, such as a room within a building within a city, and that arrangement can shift over the course of the story.", link: "entity-modal" },
    { id: "item", label: "Item", region: { x: 2.86, y: 30.83, w: 94.29, h: 6.8 }, body: "Adds an item: an object that matters to the story. Like every entity, an item has a starting state defined here that you can change at any scene it appears in, with the change carried forward from that point on.", link: "entity-modal" },
    { id: "faction", label: "Faction", region: { x: 2.86, y: 37.62, w: 94.29, h: 6.8 }, body: "Adds a faction: a group, order, or organisation. A faction tracks its membership as a relationship, so characters and other entities can join or leave it as the story unfolds.", link: "entity-modal" },
    { id: "custom", label: "Custom", region: { x: 2.86, y: 44.42, w: 94.29, h: 6.8 }, body: "Adds a custom entity: your own entity type for anything the five built-in types do not cover. Each custom entity belongs to a category you define, so you can keep many of the same kind, such as creatures or vehicles, consistent with one another.", link: "entity-modal" },
    { id: "knowledge", label: "Knowledge", region: { x: 2.86, y: 53.4, w: 94.29, h: 6.8 }, body: "Adds a piece of knowledge: a fact, secret, or revelation you want to track. Knowledge comes into its own with awareness, letting you record who knows it and who does not at each point in the story.", link: "knowledge-modal" },
    { id: "relationship", label: "Relationship", region: { x: 2.86, y: 60.19, w: 94.29, h: 6.8 }, body: "Adds a relationship: a connection between two or more entities, such as a friendship, rivalry, or bond. It starts empty so you can wire the participants in, and each participant can hold their own view of what that connection is." },
    { id: "modifier", label: "Modifier", region: { x: 2.86, y: 66.99, w: 94.29, h: 6.8 }, body: "Adds a node that records a change to an entity on its own, apart from any scene. Use it when something about a character, place, or item shifts between beats and you want that change carried forward without tying it to a particular scene." },
    { id: "reference_note", label: "Reference note", region: { x: 2.86, y: 75.97, w: 94.29, h: 6.8 }, body: "Adds a free-text note kept beside your story on the canvas. It holds no story data of its own: it is a spot for reminders, research, or jottings that sit alongside the narrative without becoming part of it." },
    { id: "reference_media", label: "Reference media", region: { x: 2.86, y: 82.77, w: 94.29, h: 6.8 }, body: "Adds an image or file kept beside your story for reference, such as a map, mood board, or character sketch. Like a reference note, it is supporting material on the canvas and does not feed into the story itself." },
    { id: "group", label: "Group", region: { x: 2.86, y: 91.75, w: 94.29, h: 6.8 }, body: "Adds a labelled box you can drop nodes into to keep the canvas tidy: gather the scenes of an act together, or pen related entities in one place. Its position is purely organisational and carries no story meaning of its own." },
  ],
}
