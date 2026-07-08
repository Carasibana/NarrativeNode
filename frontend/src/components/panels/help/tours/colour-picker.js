// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: colour-picker. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "colour-picker",
  category: "",
  tier: "modal",
  parent: "entity-modal",
  order: 0,
  title: "Colour Picker",
  intro: "Colours are how NarrativeNode keeps story elements visually distinct: every entity, scene, and other coloured element carries one, so you can tell threads apart at a glance on the canvas and in the sidebars. This picker is where you set that colour. Choose a ready-made preset from the honeycomb, dial in anything you like on the spectrum, or type an exact value. Your change is staged until you confirm it, so nothing is altered until you apply.",
  screenshotFile: "colour-picker.webp",
  screenshotAlt: "Colour Picker screenshot.",
  sections: [
    { id: "presets", label: "Presets", region: { x: 3.45, y: 5.72, w: 40.4, h: 67.11 }, body: "A curated set of distinct, legible colours, laid out as a honeycomb so you can give each story element its own easily-told-apart colour without fiddling with the spectrum. Hovering a preset reveals a small ring of related shades for quick fine-tuning." },
    { id: "honeycomb", label: "Honeycomb", region: { x: 3.45, y: 5.72, w: 40.4, h: 67.11 }, body: "The hexagon grid of preset colours. Click one to choose it; the currently chosen colour is shown with a highlighted outline so you can see which preset is in play. Hover a hexagon to fan out lighter, darker, and shifted variants of that colour." },
    { id: "spectrum", label: "Spectrum", region: { x: 47.9, y: 5.72, w: 48.65, h: 68.69 }, body: "The full colour range, for when no preset is quite right. Pick a hue along the slider, then drag in the square above it to set how vivid and how light the colour is. Useful for matching a colour you have in mind exactly rather than choosing from the set." },
    { id: "swatch", label: "Current colour", region: { x: 19.19, y: 32.87, w: 8.92, h: 12.83 }, body: "A live preview of the colour you have chosen so far. It updates as you click presets, move around the spectrum, or type a value, so you can confirm the result before applying it." },
    { id: "hex_input", label: "Colour value", region: { x: 12.37, y: 82.58, w: 58.38, h: 11.28 }, body: "Enter an exact colour as a hex value when you already know the one you want, for instance to match a colour used elsewhere. The picker accepts shorthand and fills in the rest, and reverts to the last valid colour if the entry is not a real value." },
    { id: "ok", label: "Apply", region: { x: 72.36, y: 82.91, w: 9.19, h: 10.61 }, body: "Commit the colour you have chosen and close the picker. Until you apply, the element keeps its existing colour, so you can explore freely without changing anything." },
    { id: "cancel", label: "Cancel", region: { x: 83.18, y: 82.91, w: 13.38, h: 10.61 }, body: "Close the picker without changing anything; the element keeps the colour it had before you opened it. Pressing Escape or clicking outside does the same." },
  ],
}
