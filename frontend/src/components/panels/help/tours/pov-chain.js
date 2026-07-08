// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: pov-chain. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "pov-chain",
  category: "Concepts",
  tier: "base",
  parent: "pov-origin-node",
  order: 0,
  title: "Pov Chain",
  intro: "The point-of-view chain is the order your story is actually read in, which can differ from how the scenes are arranged on the canvas. Whenever a character carries the point of view at a scene, that scene joins the reading path. The dashed point-of-view wire threads through those scenes in order, so following it from start to finish gives you the told sequence of your manuscript. Scenes with no point-of-view character sit aside as part of the world but outside that reading order.",
  screenshotFile: "pov-chain.webp",
  screenshotAlt: "Pov Chain screenshot.",
  sections: [
    { id: "pov_first", label: "First point-of-view scene", region: { x: 2.86, y: 2.15, w: 10.13, h: 58.89 }, body: "The opening scene of the reading path. The dashed point-of-view wire begins here and runs forward to the next scene a character is seen through, setting where your story starts being told." },
    { id: "pov_second", label: "Next on the path", region: { x: 38.25, y: 2.15, w: 10.13, h: 96.05 }, body: "The next scene a character carries the point of view in, so it is read at this position in the story. Its place in the told order comes from the dashed wire, not from where it sits on the canvas." },
    { id: "pov_third", label: "Later on the path", region: { x: 87.34, y: 2.15, w: 10.13, h: 76.48 }, body: "A scene further along the reading path. Tracing the dashed wire from one point-of-view scene to the next, all the way to here, lays out the full order your manuscript is read in." },
    { id: "off_path", label: "Off-path scene", region: { x: 50.13, y: 9.87, w: 10.13, h: 50.09 }, body: "A scene where no character carries the point of view, so the dashed wire skips past it. It still belongs to your world, but it has no fixed place in the told reading order until a character is seen through it." },
  ],
}
