// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: knowledge-chain. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "knowledge-chain",
  category: "Concepts",
  tier: "base",
  parent: "knowledge-origin",
  order: 0,
  title: "Knowledge Chain",
  intro: "A piece of knowledge is a fact in your story, and awareness is the record of who has learned it and how fully. Both move with the story: once a fact is established or someone learns it at a scene, that stays true from there onward until a later scene changes it. This is what lets you track a secret spreading, or one character knowing something another does not, scene by scene rather than all at once.",
  screenshotFile: "knowledge-chain.webp",
  screenshotAlt: "Knowledge Chain screenshot.",
  sections: [
    { id: "awareness", label: "Awareness", region: { x: 8.7, y: 58.76, w: 82.61, h: 2.6 }, body: "An awareness indicator shows who is aware of a fact at this point in the story and how fully, carried forward from the scene where they first learned it. Each character's understanding is tracked on its own, so different people can know different amounts at the same moment." },
    { id: "knowledge", label: "Knowledge", region: { x: 8.3, y: 95.66, w: 85.38, h: 2.46 }, body: "A piece of knowledge is a fact in the story that characters can come to learn, such as a secret, a discovery, or a rumour. It exists in its own right, and awareness of it is recorded separately for each character as the story moves forward." },
  ],
}
