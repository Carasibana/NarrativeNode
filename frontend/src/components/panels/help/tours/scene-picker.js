// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: scene-picker. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "scene-picker",
  category: "chat",
  tier: "base",
  parent: "conversation",
  order: 1,
  title: "Scene Picker",
  intro: "A small popover for choosing one scene from your story. It appears wherever you need to point to a particular scene, such as attaching a scene's content as context for the assistant. Type to narrow the list, then click the scene you want.",
  screenshotFile: "scene-picker.webp",
  screenshotAlt: "Scene Picker screenshot.",
  sections: [
    { id: "popover", label: "Scene picker", region: { x: 95, y: 80.79, w: 5, h: 14.58 }, body: "The picker that lists your story's scenes so you can choose one. It stays open after you pick, so you can select several in a row before closing it." },
    { id: "search", label: "Search", region: { x: 95.35, y: 81.45, w: 4.65, h: 2.49 }, body: "Filters the list by scene title as you type, so you can find the scene you want without scrolling through every one in a long story." },
    { id: "scene_row", label: "Row", region: { x: 95.35, y: 90.75, w: 4.65, h: 1.95 }, body: "One scene in the list. Click it to choose that scene; the row shows its title, and hovering reveals its description." },
    { id: "close", label: "Close", region: { x: 95.35, y: 93.39, w: 4.65, h: 1.31 }, body: "Dismisses the picker without affecting any scenes you already chose." },
  ],
}
