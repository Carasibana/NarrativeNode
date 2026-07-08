// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: knowledge-modal. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "knowledge-modal",
  category: "Library & Editor",
  tier: "modal",
  parent: "entity-library",
  order: 10,
  title: "Knowledge Modal",
  intro: "Knowledge is a fact in your story that you want to track: a secret, a rumour, a revelation. This dialog defines a new piece of knowledge, just as you would define a character or a location. Give it a name, a colour, and a description, then set who already knows it as the story opens. Once created it lives in your library and can be anchored to the scenes where it comes into play, with each character's awareness of it tracked separately from that point forward.",
  screenshotFile: "knowledge-modal.webp",
  screenshotAlt: "Knowledge Modal screenshot.",
  sections: [
    { id: "header", label: "Header", region: { x: 0.21, y: 0.2, w: 99.58, h: 9.6 }, body: "Names this as the dialog for creating a new piece of knowledge. The close control here dismisses it without creating anything." },
    { id: "name", label: "Name", region: { x: 3.54, y: 28.6, w: 92.92, h: 11.36 }, body: "The label for this fact, used wherever the knowledge appears: in the library, on the canvas, and in the scenes you anchor it to. A short identifying phrase works best, since the fuller account goes in the description below." },
    { id: "colour", label: "Colour", region: { x: 3.54, y: 43.1, w: 92.92, h: 11.36 }, body: "The identifying colour for this knowledge, so it reads at a glance wherever it shows up alongside your characters and other story elements. Pick from the swatches or type a hex value directly.", link: "colour-picker" },
    { id: "description", label: "Description", region: { x: 3.54, y: 57.59, w: 92.92, h: 20.37 }, body: "What the fact actually is: the secret, the truth, or the information itself. This is the defining account that travels with the knowledge throughout the story." },
    { id: "awareness", label: "Awareness", region: { x: 3.54, y: 81.1, w: 92.92, h: 4.41 }, body: "Sets who is aware of this fact as the story begins, which is the starting state that is carried forward until a later scene changes it. Awareness is recorded per observer, so each character can know the fact to a different degree, and you can choose a finer four-level scale or a simpler aware-or-not scale to match how much nuance the secret needs.", link: "awareness-picker" },
  ],
}
