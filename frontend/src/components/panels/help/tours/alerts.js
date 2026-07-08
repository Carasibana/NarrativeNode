// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: alerts. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "alerts",
  category: "",
  tier: "element-detail",
  parent: "menu-bar",
  order: 4,
  title: "Alerts",
  intro: "Alerts gathers the gentle nudges the application raises about your story in one place: review notes when a change upstream might affect a later one, warnings such as a scene left unconnected or a point of view with no character, and notices about time gaps between scenes. Nothing here blocks your work; it is a running list you can clear at your own pace, and the badge shows how many items are waiting.",
  screenshotFile: "alerts.webp",
  screenshotAlt: "Alerts screenshot.",
  sections: [
    { id: "header", label: "Header", region: { x: 0.17, y: 0.68, w: 99.65, h: 33.33 }, body: "Shows how many items are currently waiting and, when there are notes you can dismiss, a control to clear them all at once. The count rises and falls as you make changes and address what the tool flags." },
    { id: "empty_state", label: "All clear", region: { x: 0.17, y: 34.01, w: 99.65, h: 65.31 }, body: "Appears when nothing needs your attention: every review note has been seen and no warnings are outstanding. It is the resting state of a story the tool has no concerns about." },
  ],
}
