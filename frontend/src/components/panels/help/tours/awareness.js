// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: awareness. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "awareness",
  category: "Dialogs",
  tier: "base",
  parent: "detail-panel",
  order: 1,
  title: "Awareness",
  intro: "Awareness is how NarrativeNode tracks who knows what, and how fully they know it, as the story unfolds. This view focuses on one thing being known about, such as a piece of knowledge, a name, an attribute, or a relationship, and lets you set each observer's level of awareness at the point in the story you are viewing. What you set here carries forward through later scenes until you change it again.",
  screenshotFile: "awareness.webp",
  screenshotAlt: "Awareness screenshot.",
  sections: [
    { id: "header", label: "Header", region: { x: 0.16, y: 0.13, w: 99.69, h: 5.42 }, body: "Names what this awareness is about and at which point in the story you are editing it, so you always know whose knowledge of what you are recording, and when.", target: {"type":"surface","ref":"awareness-display"} },
    { id: "item_list", label: "What's tracked", region: { x: 0.16, y: 5.56, w: 28.12, h: 87.17 }, body: "Lists the things you can record awareness for: the entity's name and each of its aliases, or each of its attributes. Pick one here, then set who is aware of it on the right." },
    { id: "picker", label: "Picker", region: { x: 28.28, y: 5.56, w: 71.56, h: 87.17 }, body: "Set how aware the chosen observer is, from not knowing at all through to fully knowing. Each level captures a different shade of what someone understands, which is what lets a scene hinge on who is in the dark and who is not.", link: "awareness-picker" },
  ],
}
