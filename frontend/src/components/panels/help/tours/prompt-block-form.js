// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: prompt-block-form. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "prompt-block-form",
  category: "",
  tier: "base",
  parent: "editor-section",
  order: 0,
  title: "Prompt Block Form",
  intro: "A prompt block lets you ask the AI for help drafting right inside a scene's prose, without leaving for the chat panel. You write an instruction, press Write, and the response lands in the editor: inserted where your cursor sits, or replacing the passage you selected. Each Write is a single, fresh request and reply, not an ongoing conversation, so you can adjust your instruction and try again as often as you like.",
  screenshotFile: "prompt-block-form.webp",
  screenshotAlt: "Prompt Block Form screenshot.",
  sections: [
    { id: "form", label: "Prompt block", region: { x: 0, y: 0, w: 100, h: 100 }, body: "Type what you want the AI to do with this part of the scene, then press Write to draft it in place. The response is inserted at your chosen point or overwrites the passage you anchored, and the gear lets you set the model and instructions used for the request." },
  ],
}
