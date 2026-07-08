// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: awareness-picker. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "awareness-picker",
  category: "",
  tier: "element-detail",
  parent: "awareness",
  order: 1,
  title: "Awareness Picker",
  intro: "The picker is where you decide who knows about something and how fully. It lists the people who could be aware, and a track switch decides whether this is followed through the story at all. Once tracking is on, anything you set here applies from this point forward until a later scene changes it.",
  screenshotFile: "awareness-picker.webp",
  screenshotAlt: "Awareness Picker screenshot.",
  sections: [
    { id: "picker", label: "Picker", region: { x: 0.88, y: 13.11, w: 98.24, h: 73.77 }, body: "Choose which observers know about this and set each one's level, from never having heard of it to knowing the whole picture. The available levels depend on what is being tracked: some things are simply known or not, while names and pieces of knowledge can be understood in degrees." },
    { id: "track_toggle", label: "Track", region: { x: 0.88, y: 13.11, w: 98.24, h: 73.77 }, body: "Turns awareness tracking on or off for this object. Leave it off when knowledge of this never matters to the story; turn it on when you want to follow who knows it and how that spreads or changes as the story goes on." },
  ],
}
