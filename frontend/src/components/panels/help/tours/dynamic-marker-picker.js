// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: dynamic-marker-picker. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "dynamic-marker-picker",
  category: "",
  tier: "element-detail",
  parent: "conversation",
  order: 2,
  title: "Dynamic Marker Picker",
  intro: "A dynamic marker is a placeholder you drop into a message to the AI in place of context you would otherwise copy in by hand. Instead of pasting a fixed snapshot, the marker fills itself in with the latest state when the message is sent, so things like the current scene, the chapter title, or your story's point of view stay accurate even as your story keeps changing. This picker is where you choose which marker to insert.",
  screenshotFile: "dynamic-marker-picker.webp",
  screenshotAlt: "Dynamic Marker Picker screenshot.",
  sections: [
    { id: "panel", label: "Picker", region: { x: 94.44, y: 67.96, w: 5.56, h: 28.07 }, body: "The full set of markers you can drop into a message, grouped by what they pull in: story scope, the scenes around the one you are on, the current scene's prose, story details, and live values. Each one resolves to the latest state at the moment you send." },
    { id: "filter", label: "Filter", region: { x: 94.44, y: 67.96, w: 5.56, h: 2.39 }, body: "Type here to narrow the list to markers whose name matches what you type. Useful when you know roughly what you want and would rather not scroll the whole set." },
    { id: "marker_list", label: "Markers", region: { x: 94.44, y: 70.74, w: 5.56, h: 25.29 }, body: "The markers themselves, each adding one piece of live story context to your message. Pick one to insert it; a marker already added to this message shows struck through so you do not add it twice." },
  ],
}
