// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: circumstance-motivator-form. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "circumstance-motivator-form",
  category: "",
  tier: "element-detail",
  parent: "character-chat-setup",
  order: 2,
  title: "Circumstance Motivator Form",
  intro: "The form for adding a circumstance or a motivator. A circumstance is something that is true right now, such as wounded or caught in a storm; a motivator is something pushing toward a goal, such as ambition or loyalty. You can also set an optional intensity, from Faint through Mild, Moderate, and Strong to Intense, grading how strongly the circumstance or motivator weighs on the character. When added at a point in the story it takes effect from there forward, capturing how a character's situation and drives shift scene by scene.",
  screenshotFile: "circumstance-motivator-form.webp",
  screenshotAlt: "Circumstance Motivator Form screenshot.",
  sections: [
    { id: "form", label: "Form", region: { x: 8.56, y: 64.15, w: 79.49, h: 27.79 }, body: "Gathers everything for one new circumstance or motivator before it is added. Together these entries build a picture of what is weighing on a character or driving them at this moment in the story." },
    { id: "type", label: "Type", region: { x: 12.29, y: 65.24, w: 72.03, h: 3.7 }, body: "Shows whether you are recording a circumstance, a condition that is simply true, or a motivator, a drive pushing toward a goal. The two are kept distinct because one describes a state and the other an intention." },
    { id: "name", label: "Name", region: { x: 12.29, y: 70.02, w: 72.03, h: 2.73 }, body: "A short label so the entry reads at a glance, such as Wounded or Revenge. It is optional; a description alone is enough, but a name keeps lists scannable." },
    { id: "description", label: "Description", region: { x: 12.29, y: 73.49, w: 72.03, h: 7.29 }, body: "The fuller account of the condition or the drive, where you say what it actually is and why it matters here. A name or a description is needed, and this is the place to give it real shape." },
    { id: "confirm", label: "Add", region: { x: 12.29, y: 87.89, w: 34.75, h: 2.96 }, body: "Records the circumstance or motivator. Added at a point in the story, it carries forward from there until something later changes it." },
    { id: "cancel", label: "Cancel", region: { x: 49.58, y: 87.89, w: 34.75, h: 2.96 }, body: "Closes the form without recording anything, leaving the entry you were drafting discarded." },
  ],
}
