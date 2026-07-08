// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: awareness-display. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "awareness-display",
  category: "",
  tier: "element-detail",
  parent: "awareness",
  order: 0,
  title: "Awareness Display",
  intro: "This part of a detail view shows awareness from two directions at the point in the story you are viewing. One direction is who knows about this object; the other is everything its holder is aware of. Reading both together tells you what each character understands at this moment, which often drives the tension in a scene.",
  screenshotFile: "awareness-display.webp",
  screenshotAlt: "Awareness Display screenshot.",
  sections: [
    { id: "known_by", label: "Known by", region: { x: 1.56, y: 1.02, w: 96.89, h: 9.56 }, body: "Shows who is aware of this object at the point in the story you are viewing, and how fully each of them knows it. This is the side that answers who is in on this. Open it to set or change who knows.", target: {"type":"surface","ref":"awareness"} },
    { id: "aware_of", label: "Aware of", region: { x: 1.56, y: 18.49, w: 96.89, h: 80.49 }, body: "Shows everything this entity knows about at the point in the story you are viewing, grouped by how fully they know it. This is the other side of awareness: not who knows about them, but what is in their own head right now." },
  ],
}
