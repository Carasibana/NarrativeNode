// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: scene-changes. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "scene-changes",
  category: undefined,
  tier: "element-detail",
  parent: "detail-scene",
  order: 1,
  title: "Scene Changes",
  intro: "The Changes view gathers everything that actually shifts at this scene into one place. Because state in your story is carried forward from scene to scene, most details simply continue unchanged; this view shows only what is newly added, altered, or dropped here. Each card groups the changes by what they belong to, whether a character, a location, an item, a relationship, or a piece of tracked knowledge. It is your at-a-glance answer to the question, what happens at this point in the story.",
  screenshotFile: "scene-changes.webp",
  screenshotAlt: "Scene Changes screenshot.",
  sections: [
    { id: "header", label: "Header", region: { x: 1.5, y: 8.8, w: 96, h: 7 }, body: "Names the scene you are looking at and stays put as you move between its sub-tabs, so you always know which point in the story the panel is describing." },
    { id: "details_tab", label: "Details tab", region: { x: 2, y: 16.6, w: 22, h: 2.5 }, body: "Switches to the Details view, which covers the scene's own description, timing, and the cast of entities and relationships present here.", link: "detail-scene" },
    { id: "circumstances_tab", label: "Circumstances tab", region: { x: 30, y: 16.6, w: 38, h: 2.5 }, body: "Switches to the Circumstances view, which lists the conditions and pressures in play at this scene, both those set on the scene itself and those each entity brings to it.", link: "scene-circumstances" },
    { id: "changes_tab", label: "Changes tab", region: { x: 75, y: 16.6, w: 23, h: 2.5 }, body: "The view you are on. It collects every change recorded at this scene into a single digest rather than spreading them across each entity's own panel." },
    { id: "content", label: "Content", region: { x: 1.5, y: 19, w: 96, h: 78.2 }, body: "One card per source: each character, relationship, or knowledge that changes here, with the specific changes listed beneath. A green mark means something was added at this scene, red that it was removed, and amber that it was altered. Click a card's header to open that source in its own detail view at this point in the story." },
  ],
}
