// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: scene-node. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "scene-node",
  category: "Concepts",
  tier: "base",
  parent: "canvas-overview",
  order: 3,
  title: "Scene Node",
  intro: "A scene is the basic building block of your story on the canvas: a single beat or moment. It gathers everything that matters at that point, the title, a short description, the characters and other entities present, and any knowledge in play. Scenes connect to one another by wires, and the path those wires trace is how your story moves forward.",
  screenshotFile: "main-app.webp",
  screenshotAlt: "Scene Node screenshot.",
  sections: [
    { id: "node", label: "Scene", region: { x: 68.38, y: 44.39, w: 11.42, h: 45.19 }, body: "The scene as a whole. Everything inside it belongs to this one moment in the story. Where the scene sits on the canvas is just for your own layout; what actually orders your story is the wires running between scenes, not their position.", target: {"type":"surface","ref":"detail-scene"} },
    { id: "header", label: "Title bar", region: { x: 68.42, y: 44.62, w: 11.34, h: 5.79 }, body: "Names the scene and is where you select it. The title is what you will recognise it by elsewhere, in the table of contents and the timeline, so a short, telling name helps. This bar also carries the buttons to open the scene in the text editor and to remove it." },
    { id: "description", label: "Description", region: { x: 68.42, y: 50.41, w: 11.34, h: 10.23 }, body: "A short summary of what happens here, shown right on the canvas so you can read the gist without opening anything. The full prose for the scene lives in the editor; this is the at-a-glance version that keeps the canvas readable as your story grows." },
    { id: "entities", label: "Entities", region: { x: 68.42, y: 63.32, w: 11.34, h: 19.33 }, body: "The characters, locations, items, and factions taking part in this scene, each shown as a chip. A chip displays the entity not as it was first defined but as it stands at this point in the story, with any changes carried forward from earlier scenes already applied. Any relationship in effect at this scene appears as a chip here too, alongside the entity and knowledge chips." },
    { id: "knowledge", label: "Knowledge", region: { x: 68.42, y: 82.65, w: 11.34, h: 6.85 }, body: "The pieces of knowledge in play at this scene: facts, secrets, or revelations that characters may or may not be aware of here. Tracking knowledge per scene lets you keep straight who knows what, and when they came to know it, as the story unfolds." },
  ],
}
