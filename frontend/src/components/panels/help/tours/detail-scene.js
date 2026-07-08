// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: detail-scene. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "detail-scene",
  category: "Detail Panel",
  tier: "element-detail",
  parent: "scene-node",
  order: 5,
  title: "Detail Scene",
  intro: "The detail panel for a scene, the single beat of your story you have selected on the canvas. It gathers everything in play at that moment: a short description of what happens, the entities present, the relationships between them, and any knowledge that is in circulation. Each item listed is a doorway you can step through to see and edit its own state as it stands at this scene.",
  screenshotFile: "detail-scene.webp",
  screenshotAlt: "Detail Scene screenshot.",
  sections: [
    { id: "details_tab", label: "Details tab", region: { x: 2, y: 16.6, w: 22, h: 2.5 }, body: "The overview of the scene, currently shown. It holds the scene's description and the lists of what is present here: entities, relationships, and knowledge." },
    { id: "circumstances_tab", label: "Circumstances tab", region: { x: 30, y: 16.6, w: 38, h: 2.5 }, body: "Switches to the conditions colouring this scene, such as the weather, mood, or pressures acting on the characters. These set the backdrop without recording a change to any entity.", link: "scene-circumstances" },
    { id: "changes_tab", label: "Changes tab", region: { x: 75, y: 16.6, w: 23, h: 2.5 }, body: "Switches to a summary of everything that changes at this scene: the new values, additions, and removals first recorded here. It is a single place to review what this beat does to your story before the effects carry forward.", link: "scene-changes" },
    { id: "details_description", label: "Description", region: { x: 1.5, y: 19.8, w: 96, h: 10.4 }, body: "A short summary of what happens in this scene, separate from the full prose you write in the editor. It is the at-a-glance note shown on the scene's card on the canvas, useful for keeping the beat clear while you plan.", target: {"type":"surface","ref":"scene-node"} },
    { id: "details_entities", label: "Entities", region: { x: 1.5, y: 30.7, w: 96, h: 18.3 }, body: "The characters, locations, items, and other entities present in this scene, grouped by type. Select one to step into its detail and see or edit its state as it stands at this point in the story." },
    { id: "details_relationships", label: "Relationships", region: { x: 1.5, y: 49.6, w: 96, h: 9.1 }, body: "The relationships in play here, drawn from the entities present in this scene. Select one to open its detail at this point, or add a relationship to record a new connection forming at this beat." },
    { id: "details_knowledge", label: "Knowledge", region: { x: 1.5, y: 59.1, w: 96, h: 8 }, body: "The pieces of knowledge circulating at this scene: secrets, facts, or revelations you are tracking. Select one to see its detail here, or anchor a piece of knowledge to mark where it comes into play in the story." },
  ],
}
