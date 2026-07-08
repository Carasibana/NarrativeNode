// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: dock-menu. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "dock-menu",
  category: "Canvas",
  tier: "element-detail",
  parent: "dock",
  order: 0,
  title: "Dock Menu",
  intro: "Right-click a panel's toggle button to choose where that panel sits. The Editor and the chat panel can each live in the right sidebar or along a strip below the canvas, and either beside the other panel or sharing the same spot. This menu lets you move a panel without dragging it, so you can lay out your workspace to suit how you write.",
  screenshotFile: "dock-menu.webp",
  screenshotAlt: "Dock Menu screenshot.",
  sections: [
    { id: "menu", label: "Dock menu", region: { x: 9.2, y: 19.8, w: 81.8, h: 72.8 }, body: "Lists every spot the panel can move to. The spot it already occupies is left off the list, so the choices here are always somewhere new." },
    { id: "dock_option", label: "Dock option", region: { x: 9.5, y: 23.5, w: 81.3, h: 21.6 }, body: "Sends the panel to this spot. A plain option places it beside the other panel; a \"stacked\" option has the two panels share the same area instead of sitting side by side." },
  ],
}
