// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: knowledge-picker. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "knowledge-picker",
  category: "",
  tier: "modal",
  parent: "detail-knowledge",
  order: 0,
  title: "Knowledge Picker",
  intro: "This picker lets you choose an existing piece of knowledge to bring into a scene. Anchoring a fact to a scene marks the point where it comes into play, so its awareness can be tracked from there forward. Search or scroll to the fact you want, then select it.",
  screenshotFile: "knowledge-picker.webp",
  screenshotAlt: "Knowledge Picker screenshot.",
  sections: [
    { id: "search", label: "Search", region: { x: 3.41, y: 8.26, w: 93.17, h: 27.82 }, body: "Filters the list as you type, matching against each piece of knowledge by name. Useful once your story has gathered many facts to track." },
    { id: "knowledge_row", label: "Row", region: { x: 3.41, y: 40.43, w: 93.17, h: 21.74 }, body: "A single piece of knowledge you can select to anchor to the scene. The count beside it shows how many characters are currently aware of this fact, a quick read on how widely the secret has spread." },
    { id: "close", label: "Close", region: { x: 3.41, y: 76.08, w: 93.17, h: 14.68 }, body: "Dismisses the picker. The list stays open as you select so you can add several facts in one pass, and this closes it when you are done." },
  ],
}
