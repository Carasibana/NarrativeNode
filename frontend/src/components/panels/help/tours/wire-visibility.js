// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: wire-visibility. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "wire-visibility",
  category: "Canvas & Toolbar",
  tier: "element-detail",
  parent: "canvas-controls",
  order: 0,
  title: "Wire Visibility",
  intro: "Wires are the lines that connect your scenes and entities on the canvas: they carry the flow from one scene to the next, trace each character or object through the story, and link concept notes into a loose map. On a busy board those lines can crowd the view, so this control chooses how many are drawn at once. Show every wire, hide them all, or pick one of the two in-between modes and then tick which kinds of wire you want, point of view, narrative, or concept, so only the threads that matter right now are drawn.",
  screenshotFile: "wire-visibility.webp",
  screenshotAlt: "Wire Visibility screenshot.",
  sections: [
    { id: "mode_show_all", label: "Show all wires", region: { x: 15.77, y: 5.18, w: 80.65, h: 12.13 }, body: "Draws every wire at once: scene-to-scene flow, each entity's thread, the point-of-view path, relationships, and concept links. This is the default and gives you the complete picture of how everything is wired together." },
    { id: "mode_chosen", label: "Chosen only", region: { x: 15.77, y: 17.3, w: 80.65, h: 12.13 }, body: "Shows only the kinds of wire you tick in the boxes below and hides the rest. Use it to focus on one or two layers, for example just the point-of-view path, or just concept links, without the other lines getting in the way." },
    { id: "mode_selection_chosen", label: "Selection + chosen", region: { x: 15.77, y: 29.43, w: 80.65, h: 12.13 }, body: "Shows the wires touching whatever you currently have selected, a scene and its threads, or a single entity, relationship, or knowledge, and adds the ticked wire kinds on top. It combines a close look at one element with whichever layers you always want in view." },
    { id: "mode_hide_all", label: "Hide all wires", region: { x: 15.77, y: 41.56, w: 80.65, h: 12.13 }, body: "Hides every wire so only the nodes remain, leaving an uncluttered board for arranging or reviewing. A wire reappears only while you are actively drawing a new one." },
    { id: "type_pov", label: "POV", region: { x: 15.77, y: 65.73, w: 80.65, h: 9.7 }, body: "One of the wire-kind boxes shown under the two chosen modes. Tick it to include the point-of-view path: the wire that threads through the scenes told from a viewpoint character and so sets the order the story reads and exports. Untick it to drop that path from the view." },
    { id: "type_narrative", label: "Narrative", region: { x: 15.77, y: 75.43, w: 80.65, h: 9.7 }, body: "One of the wire-kind boxes shown under the two chosen modes. Tick it to include the narrative wires: the scene-to-scene flow, the threads tracing entities through the story, and the relationship links between them. Untick it to hide those while keeping the other kinds you have chosen." },
    { id: "type_concept", label: "Concept", region: { x: 15.77, y: 85.13, w: 80.65, h: 9.7 }, body: "One of the wire-kind boxes shown under the two chosen modes. Tick it to include the concept wires: the loose links between concept notes and groups that you use for brainstorming, kept separate from the story itself. Untick it to hide them." },
    { id: "wire_visibility_button", label: "Wire visibility", region: { x: 3.25, y: 86.26, w: 10.57, h: 10.51 }, body: "Opens this control and shows the mode in effect on its icon. Reach for it whenever the canvas feels crowded to dial the wires down to just the connections you want to focus on.", target: {"type":"surface","ref":"wire-visibility"} },
  ],
}
