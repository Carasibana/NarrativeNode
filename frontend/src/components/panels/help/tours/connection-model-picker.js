// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: connection-model-picker. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "connection-model-picker",
  category: "",
  tier: "element-detail",
  parent: "character-chat-setup",
  order: 0,
  title: "Connection Model Picker",
  intro: "NarrativeNode can talk to AI assistants you set up yourself, and each connection you configure may offer several models. This picker is where you choose which one answers right here. Rows are grouped under the connection they belong to, so you can switch both the connection and the model in one place, and a small star lets you mark a model as the default for this surface.",
  screenshotFile: "connection-model-picker.webp",
  screenshotAlt: "Connection Model Picker screenshot.",
  sections: [
    { id: "model_row", label: "Model", region: { x: 54.45, y: 71.48, w: 15.49, h: 2.38 }, body: "One model offered by one of your configured connections. Click it to make it the model that responds here; the active choice is marked with a dot. Small badges show what the model can do, and the star marks it as the default to fall back to." },
  ],
}
