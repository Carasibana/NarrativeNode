// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: scene-circumstances. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "scene-circumstances",
  category: undefined,
  tier: "element-detail",
  parent: "detail-scene",
  order: 0,
  title: "Scene Circumstances",
  intro: "The Circumstances view shows the conditions and pressures shaping this scene. Some apply to the scene as a whole, such as a storm raging outside or a loud, crowded room, and these you set and edit right here. Others are carried by the individual characters and entities present, the states they are in and the drives pushing them, gathered up from each one's own history so you can read the whole emotional and situational weather of the moment in one place.",
  screenshotFile: "scene-circumstances.webp",
  screenshotAlt: "Scene Circumstances screenshot.",
  sections: [
    { id: "header", label: "Header", region: { x: 1.5, y: 8.8, w: 96, h: 7 }, body: "Names the scene you are looking at and stays put as you move between its sub-tabs, so you always know which point in the story the panel is describing." },
    { id: "details_tab", label: "Details tab", region: { x: 2, y: 16.6, w: 22, h: 2.5 }, body: "Switches to the Details view, which covers the scene's own description, timing, and the cast of entities and relationships present here.", link: "detail-scene" },
    { id: "circumstances_tab", label: "Circumstances tab", region: { x: 30, y: 16.6, w: 38, h: 2.5 }, body: "The view you are on. It separates the conditions belonging to the scene itself from those each entity brings into it." },
    { id: "changes_tab", label: "Changes tab", region: { x: 75, y: 16.6, w: 23, h: 2.5 }, body: "Switches to the Changes view, which collects everything that is newly added, altered, or dropped at this scene into a single digest.", link: "scene-changes" },
    { id: "content", label: "Content", region: { x: 1.5, y: 19, w: 96, h: 78.2 }, body: "Two parts. The scene-level section is an editable list of conditions that colour the whole scene for everyone in it, where you add, adjust, or remove them. The per-entity section is a read-only roll-up of the states and drives each present character or entity carries at this point, shown with their intensity; click an entity to open and edit those on its own panel." },
  ],
}
