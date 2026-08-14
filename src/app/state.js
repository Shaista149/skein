// Shared mutable app state.

export let scene = null;
export let camera = null;
export let orbit = null;
export let canvas = null;
export function setSceneObjects(s, c, o, cv) {
  scene = s; camera = c; orbit = o; canvas = cv;
}

// Cache of the last physics-solved result, so the color picker and view
// toggles can rebuild/re-flip the mesh without re-running the solve.
export let lastGraph = null;
export let lastPos = null;
export function setLastSolve(graph, pos) {
  lastGraph = graph; lastPos = pos;
}

export let currentMesh = null;
export let currentRowGroup = null;
export function setCurrentMesh(mesh) { currentMesh = mesh; }
export function setCurrentRowGroup(group) { currentRowGroup = group; }

// View toggle flags (Flip / Flatten / Row markers / Row start dots).
export let flipOn = false;
export let rowsOn = false;
export let startDotOn = false;
export let flattenOn = false;
export function setFlipOn(v) { flipOn = v; }
export function setRowsOn(v) { rowsOn = v; }
export function setStartDotOn(v) { startDotOn = v; }
export function setFlattenOn(v) { flattenOn = v; }

// Lazily computed flattened-position cache (see viewToggles/index.js's
// getDisplayPos) - invalidated whenever a fresh solve lands or the yarn
// thickness slider changes.
export let flattenedPosCache = null;
export let flattenedPosCacheYarnR = null;
export function setFlattenedPosCache(pos, yarnR) {
  flattenedPosCache = pos; flattenedPosCacheYarnR = yarnR;
}
export function invalidateFlattenedPosCache() {
  flattenedPosCache = null; flattenedPosCacheYarnR = null;
}

// In-flight solve's AbortController, so a new Visualize/autobuild run can
// cancel a still-running previous one.
export let abortCtrl = null;
export function setAbortCtrl(ctrl) { abortCtrl = ctrl; }
