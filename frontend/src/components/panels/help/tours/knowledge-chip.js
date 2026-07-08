// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: knowledge-chip. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "knowledge-chip",
  category: "",
  tier: "element-detail",
  parent: "scene-node",
  order: 2,
  title: "Knowledge Chip",
  intro: "A knowledge chip marks a piece of knowledge that is in play at this scene, whether it first comes to light here or simply matters at this moment. It shows the fact as it stands at this point in the story, and any change you make to the fact here, such as renaming it, carries forward to later scenes. Click it to open the full detail panel for this fact at this scene.",
  screenshotFile: "knowledge-chip.webp",
  screenshotAlt: "Knowledge Chip screenshot.",
  sections: [
    { id: "chip", label: "Knowledge chip", region: { x: 0, y: 0, w: 100, h: 100 }, body: "A piece of knowledge present at this scene, shown with the name and colour it has at this point in the story. Click it to open its detail panel here, where you can edit the fact or record who is aware of it; hover to add it to a conversation or remove it from this scene. The chip also carries an output port: drag from it onto a character or a scene to grant awareness of this knowledge from that point in the story forward.", target: {"type":"surface","ref":"detail-knowledge"} },
  ],
}
