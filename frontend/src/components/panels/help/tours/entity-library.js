// AUTO-GENERATED help tour (Phase 6.1) from the help capture manifest.
// Surface: entity-library. Regions are measured from the capture; prose merges from
// help-prose.json (Phase 6.2a) and falls back to placeholder where unauthored.
// The screenshot is referenced by FILENAME and resolved at runtime in
// helpTours.js, so a missing / renamed / retired image shows the placeholder
// instead of breaking the Vite build with an unresolved static import.

export const tour = {
  id: "entity-library",
  category: "Library & Editor",
  tier: "element-detail",
  parent: "canvas-overview",
  order: 12,
  title: "Entity Library",
  intro: "The entity library is the left sidebar's catalogue of everything in your story, grouped by type: characters, locations, items, factions, custom entities, knowledge, relationships, tags and lists, context cues, and references. It is where you create new objects and find existing ones, and it shows each object's starting state, the way it stood when first defined. To see how an object has changed at a particular point in the story you switch to the detail view, which reads the state at whatever you have selected on the canvas. Filter within a type, or switch types using the row of tabs.",
  screenshotFile: "main-app.webp",
  screenshotAlt: "Entity Library screenshot.",
  sections: [
    { id: "view_tabs", label: "Library or detail", region: { x: 0, y: 4.36, w: 14.5, h: 3.72 }, body: "Switch the left sidebar between the library, which lists everything in your story, and the detail view, which shows the selected object as it stands at the chosen point in the story." },
    { id: "tab_library_view", label: "Library view", region: { x: 0, y: 4.36, w: 6.4, h: 3.64 }, body: "Show the library: the catalogue of every object in your story, listed by type. This is where you browse, filter, and create." },
    { id: "library_panel", label: "Library panel", region: { x: 0, y: 4.36, w: 14.5, h: 95.6 }, body: "The whole library sidebar. Choose a type with the tabs across the top, narrow it with the filter, and work through the list below." },
    { id: "tab_details_view", label: "Detail view", region: { x: 6.4, y: 4.47, w: 6.4, h: 3.4 }, body: "Show the detail view for whatever is selected on the canvas. It reads the object's state at that point in the story, so it reflects changes made earlier in the chain rather than just the starting state shown in the library.", link: "detail-panel" },
    { id: "collapse", label: "Collapse", region: { x: 12.81, y: 4.47, w: 1.69, h: 3.4 }, body: "Tuck the sidebar away to give the canvas more room. Bring it back from the toolbar when you need it again." },
    { id: "tab_bar", label: "Type tabs", region: { x: 0, y: 8.07, w: 14.5, h: 3.78 }, body: "Choose which kind of object the list shows. Each tab is a separate catalogue: switching tabs changes both the list below and what the New button creates." },
    { id: "tab_character", label: "Characters", region: { x: 0, y: 8.07, w: 1.45, h: 3.7 }, body: "List the characters: the people and named beings in your story. Only characters can carry the point of view in a scene." },
    { id: "tab_location", label: "Locations", region: { x: 1.45, y: 8.07, w: 1.45, h: 3.7 }, body: "List the locations: the places and settings in your story. Locations can be nested, so one can sit inside another." },
    { id: "tab_item", label: "Items", region: { x: 2.9, y: 8.07, w: 1.45, h: 3.7 }, body: "List the items: the objects that matter to your story and that you want to track as they move and change." },
    { id: "tab_faction", label: "Factions", region: { x: 4.35, y: 8.07, w: 1.45, h: 3.7 }, body: "List the factions: the groups and organisations in your story. A faction keeps a membership record so you can track who belongs to it." },
    { id: "tab_custom", label: "Custom", region: { x: 5.8, y: 8.07, w: 1.45, h: 3.7 }, body: "List your custom entities: your own object types for anything the built-in kinds do not cover. Each one belongs to a category you name, so you can group many of the same sort together." },
    { id: "tab_knowledge", label: "Knowledge", region: { x: 7.25, y: 8.07, w: 1.45, h: 3.7 }, body: "List the pieces of knowledge in your story: facts, secrets, and information you want to track. Knowledge pairs with awareness, which records who knows it and how fully as the story moves on." },
    { id: "tab_relationships", label: "Relationships", region: { x: 8.7, y: 8.07, w: 1.45, h: 3.7 }, body: "List the relationships: the connections between entities, and how each side sees the other. A relationship can join two entities or many, and it changes over the course of the story like anything else." },
    { id: "tab_tags_and_lists", label: "Tags and lists", region: { x: 10.15, y: 8.07, w: 1.45, h: 3.7 }, body: "Manage your tags and your preset lists. Tags let you label and filter objects; preset lists give attributes a fixed set of values to choose from, such as a list of species or ranks.", link: "tags-and-lists" },
    { id: "tab_context_cues", label: "Context cues", region: { x: 11.6, y: 8.07, w: 1.45, h: 3.7 }, body: "Manage context cues: reusable notes you can hand to the AI as background. Keep them here so the same guidance is ready to attach whenever you need it.", link: "context-cue-library" },
    { id: "tab_references", label: "References", region: { x: 13.05, y: 8.07, w: 1.45, h: 3.7 }, body: "List your reference notes: loose notes and media you keep on the canvas for yourself, separate from your story's entities." },
    { id: "filter_input", label: "Filter", region: { x: 0.52, y: 12.72, w: 7.8, h: 3.07 }, body: "Narrow the current list to objects whose name matches what you type. It filters only the type you are viewing, so each tab keeps its own filter." },
    { id: "entity_rows", label: "List", region: { x: 0, y: 19.52, w: 14.5, h: 74.9 }, body: "Every object of the chosen type. Clicking a row opens its detail only when the object already has an origin node on the canvas; a row marked with the empty-set badge is not placed yet, so clicking it does nothing. Drag any row onto the canvas to bring it into a scene.", link: "detail-panel" },
    { id: "entity_row", label: "Row", region: { x: 0.26, y: 20, w: 13.98, h: 4.61 }, body: "A single object in the list. Click to see its detail, but only when it already has an origin node on the canvas: a row marked with the empty-set badge is not placed yet, so clicking it does nothing. You can still drag it onto the canvas to place it where you want it in the story.", link: "detail-panel" },
    { id: "new_entity_btn", label: "New", region: { x: 0.52, y: 95.47, w: 13.46, h: 3.56 }, body: "Create a new object of the type you are currently viewing. It opens a form to name and define the object, and it appears on the canvas ready to wire into your scenes.", link: "entity-modal" },
  ],
}
