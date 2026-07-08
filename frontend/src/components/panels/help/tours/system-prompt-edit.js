// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: system-prompt-edit. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "system-prompt-edit",
  category: "",
  tier: "modal",
  parent: "settings",
  order: 0,
  title: "System Prompt Edit",
  intro: "A system prompt is the standing instruction the AI reads before every reply, setting its job, tone, and ground rules. Here you write that instruction, file it under a category, decide how its replies are displayed, and choose where it switches itself on by default. You can also seed it with example exchanges and attach extra context so the AI starts each conversation already prepared.",
  screenshotFile: "system-prompt-edit.webp",
  screenshotAlt: "System Prompt Edit screenshot.",
  sections: [
    { id: "name", label: "Name", region: { x: 1.98, y: 1.2, w: 61.36, h: 3.7 }, body: "The label this prompt shows in the picker and lists. Give it something you will recognize at a glance, since it is how you will find and choose it later." },
    { id: "close", label: "Close", region: { x: 94.77, y: 1.52, w: 3.26, h: 3.04 }, body: "Closes the editor. If you have unsaved edits you will be asked first, so this will not quietly throw away your work." },
    { id: "category", label: "Category", region: { x: 64.27, y: 1.63, w: 15.7, h: 2.83 }, body: "The folder this prompt is filed under, which groups it with related prompts in the picker. Changing it here moves the prompt into the chosen category when you save." },
    { id: "persona_toggle", label: "Persona", region: { x: 80.9, y: 1.68, w: 8.05, h: 2.72 }, body: "Marks this prompt as a persona, meaning it is written to speak as a character rather than as a general assistant. Flagging it makes the prompt available as a voice when you set up a character chat." },
    { id: "render_mode", label: "Render mode", region: { x: 89.88, y: 1.68, w: 3.95, h: 2.72 }, body: "Flips the whole editor between showing formatted text and showing the raw markdown behind it. It only changes how things look while you edit; individual messages can still be flipped on their own." },
    { id: "tab_strip", label: "Tabs", region: { x: 0.12, y: 6.09, w: 99.77, h: 4.24 }, body: "Switches between composing the prompt and previewing it. Compose is where you write the instruction and add history and context; Preview shows the assembled result the AI will actually receive." },
    { id: "prompt_body", label: "Prompt text", region: { x: 1.98, y: 12.07, w: 96.05, h: 8.53 }, body: "The core instruction the AI follows. It is sent at the very start of every conversation that uses this prompt, so this is where you set its role, voice, and the rules it should keep to." },
    { id: "message_history", label: "Message history", region: { x: 1.98, y: 22.34, w: 96.05, h: 10.84 }, body: "Optional example exchanges that are sent as if the conversation had already begun. By showing the AI a few model turns up front you can steer its tone, style, and formatting before you ask your real question." },
    { id: "additional_context", label: "Added context", region: { x: 1.98, y: 34.92, w: 96.05, h: 10.84 }, body: "Extra material that attaches itself to the conversation whenever a writer picks this prompt, such as reusable context cues or dynamic story details. It saves having to add the same background by hand each time." },
    { id: "surface_defaults", label: "Defaults", region: { x: 1.98, y: 47.5, w: 96.05, h: 14.4 }, body: "Sets where this prompt has an opinion about the surrounding context across the AI surfaces, such as pulling in scene context or the words before and after where you are writing. A pill left untouched stays silent and leaves your current settings alone; switching one on makes the prompt turn that option on for you when it is picked." },
    { id: "footer", label: "Footer", region: { x: 0.12, y: 94.35, w: 99.77, h: 5.54 }, body: "Saves your changes or discards them. Nothing you have edited here takes effect until you save." },
  ],
}
