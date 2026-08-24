// Multi-component pattern state.
//
// A "pattern" isn't necessarily one piece anymore - it's a name -> {lines,
// markers} map of every component tab currently open, plus which one is
// "active" (in focus, the one the editor/visualizer shows). Tab clicks in
// patternEditor.js call setActiveComponent() to switch focus; saving/
// loading a whole multi-part preset goes through serializeComponents()/
// loadComponentsFromSaved() at the bottom.
//
// Every mutator below returns a plain success flag (true/false) rather
// than throwing - callers can just check it and skip the state change
// rather than needing try/catch for what are really just "that name's not
// available" cases, same pattern already used for the saved-preset
// rename/delete flow in patternEditor.js.

const DEFAULT_COMPONENT_NAME = 'main';

function emptyComponent() {
  return { lines: [], markers: [] };
}

// name -> { lines: string[], markers: array (same shape markersToSaveData() produces) }
let components = { [DEFAULT_COMPONENT_NAME]: emptyComponent() };
let activeComponentName = DEFAULT_COMPONENT_NAME;

export function getComponentNames() {
  return Object.keys(components);
}

export function getActiveComponentName() {
  return activeComponentName;
}

export function getComponent(name) {
  return components[name] || null;
}

export function getActiveComponent() {
  return components[activeComponentName];
}

// Overwrites the ACTIVE component's content in place - patternEditor.js
// calls this right before switching tabs, to stash whatever's currently
// on screen against the component being left. markers defaults to keeping
// whatever was already there if not provided, since most callers (every
// textarea edit) only ever touch the pattern text, not the marker list.
export function setActiveComponentContent(lines, markers) {
  const prev = components[activeComponentName];
  components[activeComponentName] = {
    lines: [...lines],
    markers: markers !== undefined ? [...markers] : (prev ? [...prev.markers] : []),
  };
}

// Switches which component is "in focus". Returns its content so the
// caller can load it into the editor/visualizer in one step, or null if
// that name doesn't exist - no silent fallback, since landing on the
// wrong component without the caller noticing is worse than doing
// nothing (see addComponent for how a name actually gets created first).
export function setActiveComponent(name) {
  if (!components[name]) return null;
  activeComponentName = name;
  return components[name];
}

// Adds a new, empty component and makes it active. Refuses a name that's
// already taken rather than silently clobbering existing work - same
// collision-avoidance already used for saved-preset rename/save in
// patternEditor.js.
export function addComponent(name) {
  if (!name || components[name]) return false;
  components[name] = emptyComponent();
  activeComponentName = name;
  return true;
}

// True rename: the old key is genuinely gone afterward, nothing left
// behind as an orphaned duplicate - same rename semantics as the saved
// preset sidebar's double-click rename.
export function renameComponent(oldName, newName) {
  if (!newName || oldName === newName) return false;
  if (!components[oldName] || components[newName]) return false;
  components[newName] = components[oldName];
  delete components[oldName];
  if (activeComponentName === oldName) activeComponentName = newName;
  return true;
}

// Removing the LAST remaining component isn't allowed - there's always at
// least one panel open to edit, the same way a saved preset always has
// SOME pattern text (even if it's blank) rather than zero panels and
// nothing to click into.
export function removeComponent(name) {
  const names = Object.keys(components);
  if (names.length <= 1) return false;
  if (!components[name]) return false;
  delete components[name];
  if (activeComponentName === name) {
    activeComponentName = Object.keys(components)[0];
  }
  return true;
}

// Resets back to a single default component. Used when loading a plain
// single-pattern entry (a built-in preset, or a saved pattern that was
// never multi-component) - see loadPresetEntry in patternEditor.js - so
// it lands as one clean component rather than leaving whatever components
// were open before still sitting around underneath it.
export function resetToSingleComponent(lines, markers, name = DEFAULT_COMPONENT_NAME) {
  components = { [name]: { lines: [...lines], markers: markers ? [...markers] : [] } };
  activeComponentName = name;
}

// Save-format helpers: 
// Converts the in-memory component map to/from the shape a saved preset
// holds on disk: { components: { name: {lines, markers} }, activeComponent
// }. Legacy single-pattern saves ({lines, markers}, or the older bare
// lines array) are a different, older shape - detecting/normalizing those
// stays in patternEditor.js's normalizeSavedEntry, so the two formats
// don't get tangled into one function trying to branch on both at once.

export function serializeComponents() {
  return {
    components: Object.fromEntries(
      Object.entries(components).map(([name, c]) => [name, { lines: [...c.lines], markers: [...c.markers] }])
    ),
    activeComponent: activeComponentName,
  };
}

// Returns true if `saved` actually had multi-component data and it got
// loaded; false (with the in-memory state left untouched) if `saved`
// doesn't look like a multi-component save at all - callers fall back to
// their own legacy-shape handling in that case.
export function loadComponentsFromSaved(saved) {
  if (!saved || !saved.components) return false;
  const names = Object.keys(saved.components);
  if (names.length === 0) return false;
  components = Object.fromEntries(
    names.map(name => {
      const c = saved.components[name] || {};
      return [name, { lines: [...(c.lines || [])], markers: [...(c.markers || [])] }];
    })
  );
  activeComponentName = (saved.activeComponent && components[saved.activeComponent])
    ? saved.activeComponent
    : names[0];
  return true;
}