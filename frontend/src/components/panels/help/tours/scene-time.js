// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: scene-time. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "scene-time",
  category: "Dialogs",
  tier: "base",
  parent: "scene-time-row",
  order: 0,
  title: "Scene Time",
  intro: "This is where you place a scene in time: the moment it happens, how much time has passed since the previous scene, and how long it runs. Setting these lets the timeline work out the order and spacing of your story's events, so you can see at a glance how your narrative unfolds over hours, days, or seasons. You can fill in as much or as little as a scene needs.",
  screenshotFile: "scene-time.webp",
  screenshotAlt: "Scene Time screenshot.",
  sections: [
    { id: "when", label: "When", region: { x: 30.11, y: 5.37, w: 66.96, h: 69.68 }, body: "Sets when the scene takes place, by time of day, season, and date. Season here is background colour only and does not constrain when the scene can happen, since different parts of the world sit in different seasons at the same time of year." },
    { id: "gap", label: "Gap", region: { x: 1.85, y: 13.79, w: 24.67, h: 5.89 }, body: "Adds time between this scene and the one before it on the point-of-view path. Use it to stretch the interval when more time has passed than the bare dates imply, for example a long journey or a span of waiting." },
    { id: "duration", label: "Duration", region: { x: 30.11, y: 77.47, w: 66.96, h: 21.47 }, body: "Sets how long the scene itself lasts, from a brief exchange to a span of days. This feeds into where the following scene falls in time, since the next scene begins after this one ends." },
  ],
}
