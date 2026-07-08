// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: canvas-overview. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "canvas-overview",
  category: "Canvas & Toolbar",
  tier: "base",
  parent: null,
  order: 0,
  title: "Canvas Overview",
  intro: "This is the main NarrativeNode workspace and the map for the rest of this help. The canvas in the centre is where you lay out your story: scenes sit as nodes connected by wires, and the entities in them (characters, locations, items, factions) carry their changing state forward from one scene to the next. The menu bar and toolbar run along the top, the side panels hold your library, detail view, and text editor, and the corner controls and minimap help you navigate. Click any highlighted section to learn more about it.",
  screenshotFile: "main-app.webp",
  screenshotAlt: "Canvas Overview screenshot.",
  sections: [
    { id: "workspace", label: "Workspace", region: { x: 14.4, y: 4.3, w: 85.6, h: 95.7 }, body: "The open canvas where your whole story lives. Drag the background to pan, scroll to zoom, and place scenes and entities anywhere you like. Position is for your own clarity; reading order comes from how scenes are connected, not where they sit." },
    { id: "add_to_canvas", label: "Add to canvas", region: { x: 15.32, y: 9.71, w: 1.66, h: 3.11 }, body: "Open the menu to add something new: a scene, an entity such as a character or location, or another node type. This is the main starting point for building out your story.", link: "add-nodes-menu" },
    { id: "toolbar", label: "Toolbar", region: { x: 15.32, y: 9.71, w: 5.61, h: 7.39 }, body: "The canvas toolbar, gathering the everyday building actions: add a node, step back and forward through your edits, and switch how the canvas is laid out." },
    { id: "undo_redo", label: "Undo and redo", region: { x: 17.6, y: 10, w: 3.32, h: 2.53 }, body: "Step backward and forward through your recent canvas edits. Changes are tracked as you work, so you can confidently try a layout or a story change and reverse it if you change your mind." },
    { id: "layout_mode", label: "Layout mode", region: { x: 15.32, y: 13.99, w: 1.66, h: 3.11 }, body: "Switch between a single row of chapters and a wrapped multi-row arrangement. Multi-row becomes available once you have at least two chapters and helps a long story fit on screen by stacking chapter columns into rows." },
    { id: "canvas_controls", label: "Canvas controls", region: { x: 15.32, y: 78.31, w: 1.35, h: 20.23 }, body: "The cluster of view controls in the canvas corner: zoom, fit the whole story into view, lock the layout, choose which wires are shown, snap nodes to a grid, auto-tidy the arrangement, and toggle the minimap.", link: "canvas-controls" },
    { id: "minimap_resize", label: "Minimap resize", region: { x: 88.86, y: 83.95, w: 0.83, h: 1.56 }, body: "Drag this handle on the minimap's corner to make the overview larger or smaller. The size you choose is remembered for next time." },
    { id: "minimap", label: "Minimap", region: { x: 88.86, y: 83.95, w: 10.38, h: 14.59 }, body: "A small overview that maps the entire canvas and marks the part you are currently viewing, so you can keep your bearings and jump around a large story quickly. Drag its corner handle to resize it." },
  ],
}
