// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: dock. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "dock",
  category: "",
  tier: "element-detail",
  parent: "canvas-overview",
  order: 13,
  title: "Dock",
  intro: "These tabs sit at the edge of the canvas and show or hide the side panels that work alongside it. One opens the editor where you write a scene's prose, the other opens the chat for working through ideas with the AI. You can also drag a tab or right-click it to move that panel between the two dock zones: the right sidebar or a strip below the canvas.",
  screenshotFile: "dock.webp",
  screenshotAlt: "Dock screenshot.",
  sections: [
    { id: "editor_toggle", label: "Editor", region: { x: 15, y: 7.5, w: 70, h: 40 }, body: "Shows or hides the editor panel, where you write the full prose for the selected scene. The editor follows your selection, so the scene you click on the canvas is the one you write into.", link: "editor-panel" },
    { id: "chat_toggle", label: "Chat", region: { x: 15, y: 52.5, w: 70, h: 40 }, body: "Shows or hides the chat panel for working through your story with the AI. Keep it open alongside the canvas to talk things over while you plan, and closed when you want the room back for the canvas.", link: "chat-panel" },
  ],
}
