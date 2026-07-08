// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: story-scope. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "story-scope",
  category: "",
  tier: "element-detail",
  parent: "conversation",
  order: 3,
  title: "Story Scope",
  intro: "Story scope decides how much of your story rides along with a chat message so the AI can answer with the narrative in mind. You can send a slim outline, the full prose, just the scenes on either side of the one you are working in, or a handful you pick by hand. The more you send the more the AI knows, but longer context costs more to process, so these controls let you choose the right amount for each question.",
  screenshotFile: "story-scope.webp",
  screenshotAlt: "Story Scope screenshot.",
  sections: [
    { id: "controls", label: "Scope controls", region: { x: 94.44, y: 55.47, w: 5.56, h: 40.56 }, body: "The full set of choices for how much of your story travels with the next message. Each group below is independent, so you can combine an outline with a couple of hand-picked scenes, or send nothing extra at all." },
    { id: "table_of_contents", label: "Table of contents", region: { x: 94.75, y: 55.47, w: 5.25, h: 5.36 }, body: "Attaches a nested outline of your acts, chapters, and scenes, with a marker on the scene you are currently working in. It gives the AI a map of where everything sits without the weight of the actual prose." },
    { id: "whole_story", label: "Whole story", region: { x: 94.75, y: 61.61, w: 5.25, h: 15.11 }, body: "Sends every scene at the level of detail you choose: short descriptions alone, descriptions plus the changes recorded at each scene, or the complete written content of the whole story. Fuller settings tell the AI more but use far more context, so reach for them only when the answer truly needs the whole book." },
    { id: "scene_neighbours", label: "Nearby scenes", region: { x: 94.75, y: 77.5, w: 5.25, h: 5.74 }, body: "Adds the scene just before and the scene just after the one you are working in, so the AI sees how this moment leads in and out. These are anchored to the active scene, so they are unavailable until you have one selected." },
    { id: "scope", label: "Chosen scenes", region: { x: 94.75, y: 84.02, w: 5.25, h: 11.62 }, body: "Narrows the story to exactly the scenes you care about: a whole chapter, a whole act, or a specific set you pick one by one. Each chosen scene becomes a chip in the composer below, where you can adjust its level of detail or drop it." },
  ],
}
