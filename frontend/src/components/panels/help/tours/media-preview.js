// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: media-preview. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "media-preview",
  category: "Dialogs",
  tier: "base",
  parent: "canvas-overview",
  order: 14,
  title: "Media Preview",
  intro: "When you attach a picture, video, or sound to an entity or a reference, this floating panel lets you look at it up close without leaving the canvas. It opens over your work, can be dragged out of the way, and shows the file alongside what it is. For pictures and video you can drag the corner to resize it, and you can swap in a different file when the source is one you can edit.",
  screenshotFile: "media-preview.webp",
  screenshotAlt: "Media Preview screenshot.",
  sections: [
    { id: "metadata", label: "Details", region: { x: 1.78, y: 0.88, w: 68.38, h: 3.02 }, body: "Identifies the file you are looking at: its name and where in your story it is attached. This tells you at a glance which attachment this is, useful when several entities carry similar media." },
    { id: "preview", label: "Preview", region: { x: 0.2, y: 4.78, w: 99.6, h: 95.09 }, body: "Displays the attached file itself at a comfortable size: a picture, a video with playback controls, or a sound player. Only one piece of media plays at a time across the whole application, so starting this one quietly stops any other that was playing." },
  ],
}
