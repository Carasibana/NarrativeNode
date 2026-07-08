// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: editor-section. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "editor-section",
  category: "",
  tier: "base",
  parent: "editor-panel",
  order: 0,
  title: "Editor Section",
  intro: "A section is a labelled, bordered block within a scene's prose, a working zone you can mark out and treat as a unit. Use it to break a long scene into named parts you can write, revise, or hand to the AI on their own. Each section keeps its own label, its own controls for stepping back and forward through changes, and a built-in prompt block for asking the AI to draft text just for this block.",
  screenshotFile: "editor-section.webp",
  screenshotAlt: "Editor Section screenshot.",
  sections: [
    { id: "name_bar", label: "Label", region: { x: 0.27, y: 0.24, w: 99.47, h: 6.89 }, body: "The section's name, alongside a handle for dragging the whole block to a new spot in the scene. Click the name to rename it, so you can call a section what it is to you, for instance an opening beat or a key exchange." },
    { id: "prompt_block", label: "Prompt block", region: { x: 0.27, y: 7.12, w: 99.47, h: 6.65 }, body: "A prompt block built into the section for asking the AI to draft or rework the text here. It is collapsed until you open it; the AI sees this section's current text as context and its reply replaces the section's content. Distinct from the editor's free-floating prompt block, this one always belongs to its section.", link: "prompt-block-form" },
    { id: "toolbar", label: "Controls", region: { x: 0.27, y: 13.77, w: 99.47, h: 7.36 }, body: "The section's own controls: step back and step forward through the changes made to this block during your session, attach the section to a chat conversation as live context, and the two ways to remove it. Dissolve strips the border but keeps the prose in place; Delete removes the section and its text together. Both can be undone with Ctrl+Z." },
    { id: "content", label: "Text", region: { x: 0.27, y: 21.13, w: 99.47, h: 78.63 }, body: "The prose that lives inside this section, the actual words of the scene within this block. It is part of the scene's narrative text and saves automatically as you write; the section's label and controls simply wrap it so you can target this passage on its own." },
  ],
}
