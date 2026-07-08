// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: knowledge-awareness. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "knowledge-awareness",
  category: undefined,
  tier: "element-detail",
  parent: "detail-knowledge",
  order: 0,
  title: "Knowledge Awareness",
  intro: "The Awareness tab of a piece of knowledge shows who has learned this fact, and how fully, at the point in the story you are currently viewing. Awareness travels along with the rest of the story: once someone learns the fact at a scene, that stays true going forward until a later scene changes it. Step through the scenes with the panel's navigation to watch the cast's understanding of this fact build up over the narrative.",
  screenshotFile: "knowledge-awareness.webp",
  screenshotAlt: "Knowledge Awareness screenshot.",
  sections: [
    { id: "header", label: "Header", region: { x: 1.5, y: 8.8, w: 96, h: 7 }, body: "The name and colour of the piece of knowledge, shown the same way across both of its tabs so you always know which fact you are looking at." },
    { id: "details_tab", label: "Details tab", region: { x: 0, y: 16.6, w: 43.6, h: 2.5 }, body: "Switches back to the Details tab, where you set what the fact actually is and how it is tagged.", link: "detail-knowledge" },
    { id: "awareness_tab", label: "Awareness tab", region: { x: 43.6, y: 16.6, w: 56.1, h: 2.5 }, body: "The tab you are on now, where you record who is aware of this fact rather than what the fact says." },
    { id: "content", label: "Content", region: { x: 1.5, y: 19, w: 96, h: 78.2 }, body: "Turn on tracking to record who knows this fact, then set each character's level of awareness, from never having heard of it through to fully knowing it. What you set here holds true from this scene onward, so stepping forward through the story shows understanding spreading as more characters learn the fact." },
  ],
}
