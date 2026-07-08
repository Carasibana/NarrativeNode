// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: canvas-controls. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "canvas-controls",
  category: "Canvas & Toolbar",
  tier: "element-detail",
  parent: "canvas-overview",
  order: 1,
  title: "Canvas Controls",
  intro: "These controls sit in the corner of the canvas and govern how you view and arrange your story rather than what it contains. Use them to zoom, frame the whole narrative, lock the layout while you read, choose which connecting wires are drawn, tidy node positions, and toggle the overview map. Nothing here changes the story itself, only how you look at it.",
  screenshotFile: "canvas-controls.webp",
  screenshotAlt: "Canvas Controls screenshot.",
  sections: [
    { id: "zoom_in", label: "Zoom in", region: { x: 15.79, y: 2.73, w: 68.42, h: 11.82 }, body: "Move the view closer so you can read a single scene or entity and its wires in detail." },
    { id: "zoom_out", label: "Zoom out", region: { x: 15.79, y: 14.55, w: 68.42, h: 11.82 }, body: "Pull the view back to take in more of the story at once, useful for seeing how scenes flow across chapters." },
    { id: "fit_view", label: "Fit view", region: { x: 15.79, y: 26.36, w: 68.42, h: 11.82 }, body: "Frame the entire story on screen at once, bringing every scene and entity into view. A quick way to get your bearings after panning far into one corner." },
    { id: "interactivity", label: "Lock canvas", region: { x: 15.79, y: 38.18, w: 68.42, h: 11.82 }, body: "Lock the canvas so nodes stay put while you read or review. With it unlocked, you can drag nodes freely; locking prevents accidentally nudging your layout out of place." },
    { id: "wire_visibility", label: "Wire visibility", region: { x: 15.79, y: 50, w: 68.42, h: 11.82 }, body: "Choose which connecting wires are drawn. Show every wire, hide them all, or pick one of two in-between modes, chosen kinds only, or the current selection's wires plus chosen kinds, then tick which wire kinds to include: point of view, narrative, or concept. On a busy canvas this lets you trace one thread without the rest crowding the view.", target: {"type":"surface","ref":"wire-visibility"}, link: "wire-visibility" },
    { id: "snap_to_grid", label: "Snap to grid", region: { x: 15.79, y: 61.82, w: 68.42, h: 11.82 }, body: "When on, nodes align to an invisible grid as you drag, keeping scenes and entities neatly squared up. Ctrl+clicking the button instead snaps every existing node to the grid at once. Since a node's position is for your own clarity and does not affect the story, this is purely about a tidy workspace." },
    { id: "reorganize", label: "Reorganise", region: { x: 15.79, y: 73.64, w: 68.42, h: 11.82 }, body: "Automatically tidy the whole canvas: scenes are packed into their chapter columns and each entity's starting node is placed near where it first appears. A fast reset when the layout has drifted into a tangle." },
    { id: "minimap_toggle", label: "Minimap toggle", region: { x: 15.79, y: 85.45, w: 68.42, h: 11.82 }, body: "Show or hide the minimap, the small overview that maps the entire canvas and shows where your current view sits within it. Handy for jumping around a large story." },
  ],
}
