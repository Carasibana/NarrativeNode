// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: pov-chip. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "pov-chip",
  category: "",
  tier: "element-detail",
  parent: "scene-node",
  order: 1,
  title: "Pov Chip",
  intro: "The point-of-view marker sits atop a character chip to show that the scene is told through that character's eyes. Beyond labelling the viewpoint, it places the scene on the narrative path: the order in which point-of-view scenes are linked is the order a reader would actually read them, which can differ from how the scenes are laid out in time on the canvas.",
  screenshotFile: "pov-chip.webp",
  screenshotAlt: "Pov Chip screenshot.",
  sections: [
    { id: "badge", label: "Point-of-view badge", region: { x: 0, y: 0, w: 100, h: 100 }, body: "Marks which character carries the point of view in this scene, so it reads as told through them. Only one character holds the viewpoint per scene; you reassign it by dragging this marker onto a different character. A scene with no point-of-view marker is treated as happening off the page.", target: {"type":"surface","ref":"pov-chain"} },
  ],
}
