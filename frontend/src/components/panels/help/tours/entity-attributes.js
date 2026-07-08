// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: entity-attributes. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "entity-attributes",
  category: "Detail Panel",
  tier: "element-detail",
  parent: "detail-character",
  order: 0,
  title: "Entity Attributes",
  intro: "The Attributes sub-tab of a character's detail panel. It gathers what the character carries at the point in the story you are viewing: their attributes, plus the circumstances, motivators, and perspectives in play here. Every value is shown as it stands at this point, whether it was set here or carried forward from earlier, and anything you add or change takes effect from this point onward.",
  screenshotFile: "entity-attributes.webp",
  screenshotAlt: "Entity Attributes screenshot.",
  sections: [
    { id: "header", label: "Identity", region: { x: 1.5, y: 8.8, w: 96, h: 7 }, body: "The character's name and identity, shared across all four detail sub-tabs so you always know whose state you are looking at." },
    { id: "details_tab", label: "Details tab", region: { x: 0, y: 16.6, w: 17.9, h: 2.5 }, body: "Switches to the Details sub-tab, where the character's description, aliases, and tags live.", link: "detail-character" },
    { id: "attributes_tab", label: "Attributes tab", region: { x: 17.9, y: 16.6, w: 25.7, h: 2.5 }, body: "The Attributes sub-tab, currently shown: the character's attributes, circumstances, motivators, and perspectives as they stand at this point in the story." },
    { id: "relationships_tab", label: "Relationships tab", region: { x: 43.6, y: 16.6, w: 33.2, h: 2.5 }, body: "Switches to the Relationships sub-tab, which shows who this character is connected to and how those ties stand here.", link: "entity-relationships" },
    { id: "awareness_tab", label: "Awareness tab", region: { x: 76.8, y: 16.6, w: 22.9, h: 2.5 }, body: "Switches to the Awareness sub-tab, which shows who is aware of this character and what they are aware of at this point.", link: "entity-awareness" },
    { id: "attributes", label: "Attributes", region: { x: 5.34, y: 20.15, w: 88.7, h: 19.93 }, body: "The character's attributes as they stand at this point: lasting facts about them such as age, rank, or appearance. Each row is one attribute, showing its name, a type badge, and its current value below; a value set earlier in the story carries forward here unless it was changed." },
    { id: "attributes_awareness", label: "Manage awareness", region: { x: 62.3, y: 20.49, w: 10.68, h: 2.03 }, body: "Opens the awareness panel for these attributes, where you set who knows about them and to what degree at this point in the story. Use it when a character is hiding a trait or others have not yet learned it." },
    { id: "attributes_add", label: "Add attribute", region: { x: 74.1, y: 20.49, w: 18.16, h: 2.03 }, body: "Adds a new attribute to the character from this point forward. The value you give it carries on through later scenes until you change it again." },
    { id: "attribute_type", label: "Type badge", region: { x: 56.6, y: 23.94, w: 10.33, h: 1.49 }, body: "The attribute's type. It can be text for free text, preset for a value chosen from one of your shared lists, media or file for an attached image, audio, or video, number for a numeric value, text list for several plain-text entries, or entity list for links to other entities." },
    { id: "attribute_change", label: "Change indicator", region: { x: 68.7, y: 24.08, w: 17.45, h: 1.15 }, body: "Marks that this attribute was changed at the point you are viewing rather than carried forward unchanged from earlier: green for added, amber for modified, red for removed. It is how you tell, at a glance, what happened to the character here." },
    { id: "attribute_remove", label: "Remove", region: { x: 87.96, y: 24.08, w: 3.2, h: 1.15 }, body: "Removes this attribute from this point onward. It still exists earlier in the story where it was present; only its presence from here forward is dropped." },
    { id: "circumstances", label: "Circumstances", region: { x: 5.34, y: 41.09, w: 88.7, h: 3.8 }, body: "The circumstances the character is in at this point: their situation or condition, such as wounded, in hiding, or newly wealthy. These describe the moment rather than lasting facts, which is what sets them apart from ordinary attributes." },
    { id: "circumstances_add", label: "Add circumstance", region: { x: 66.95, y: 42.52, w: 25.28, h: 2.03 }, body: "Adds a circumstance that carries forward from this point. When you are viewing a scene, a second button adds a temporary one that applies only at that scene and does not carry into later scenes." },
    { id: "motivators", label: "Motivators", region: { x: 5.34, y: 45.91, w: 88.7, h: 9.69 }, body: "What is driving the character at this point: their goals, fears, or needs in play here. Each motivator can carry an intensity so you can note how strongly it weighs on them." },
    { id: "motivators_add", label: "Add motivator", region: { x: 66.95, y: 47.33, w: 25.28, h: 2.03 }, body: "Adds a motivator that carries forward from this point. When you are viewing a scene, a second button adds a temporary one that applies only at that scene and does not carry into later scenes." },
    { id: "motivator_intensity", label: "Intensity", region: { x: 6.41, y: 52.55, w: 86.5, h: 2.44 }, body: "How strongly the motivator weighs on the character, on a five-step scale from Faint to Intense, shown with its coloured marker. Leaving it unset records the motivator without committing to a strength." },
    { id: "perspectives", label: "Perspectives", region: { x: 5.34, y: 56.62, w: 88.7, h: 3.8 }, body: "The character's perspectives at this point: how they see things, what they believe, or the stance they hold here. Like circumstances and motivators, a perspective belongs to the character at this point and carries forward until changed." },
    { id: "perspectives_add", label: "Add perspective", region: { x: 66.95, y: 58.04, w: 25.28, h: 2.03 }, body: "Adds a perspective to the character from this point forward." },
  ],
}
