// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: inline-prompt-block. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "inline-prompt-block",
  category: "",
  tier: "base",
  parent: "editor-panel",
  order: 1,
  title: "Inline Prompt Block",
  intro: "An inline prompt block is a small floating control that drops right into a scene's prose, at the exact spot where you want new text. Instead of switching to a separate chat, you type what you want written and the AI drafts it in place, picking up from the surrounding sentences. It carries the context of where it sits, so the draft fits the moment you placed it at. Move it, dismiss it, or send it without leaving the page you are writing on.",
  screenshotFile: "inline-prompt-block.webp",
  screenshotAlt: "Inline Prompt Block screenshot.",
  sections: [
    { id: "dismiss", label: "Dismiss", region: { x: 94.38, y: 6.12, w: 4.17, h: 40.82 }, body: "Closes the prompt block and clears it from the prose without writing anything. If the AI is mid-draft you stop the stream first, then dismiss, so you never lose text by accident." },
    { id: "drag_handle", label: "Drag handle", region: { x: 1.46, y: 8.16, w: 3.33, h: 36.73 }, body: "Grab here to slide the prompt block to a different point in the text, retargeting where the draft will be inserted. The block follows your pointer through the prose so you can drop it exactly where the new writing should begin." },
  ],
}
