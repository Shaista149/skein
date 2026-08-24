import * as THREE from 'three';
import { TYPE_LABEL } from '../lib/color.js';
import {
  canvas, scene, camera, orbit, lastGraph, lastPos, currentMesh,
  currentRowGroup, rowsOn, startDotOn,
} from './state.js';
import { roundLabel, setStatus } from './viewToggles.js';
import { openColorPicker } from './colorPicker.js';

// Same slider element viewToggles.js/colorPicker.js/solver.js each keep
// their own reference to - see the comment in solver.js.
const yarnOpt = document.getElementById('opt-yarn');

// PLACE MARKER
// Click-to-place stitch markers on the solved mesh. Positions are found by
// raycasting against the actual physics-solved geometry, then snapping to
// the nearest node so the marker panel can report a real round/stitch
// location. Purely additive, reads from lastGraph/lastPos but never writes
// to them.
const MARKER_COLORS = ['#000000','#ff6b6b','#ff9f43','#ffd93d','#6bcb77','#48dbfb','#4d96ff','#c77dff','#ff6b9d','#ffffff'];
// Every placed marker is one of these four shapes now - 'pin' was dropped
// as redundant (a plain ball reads the same as a small eye). There's no
// separate "marker type" vs "nose shape" distinction anymore either: a
// marker's shape IS its type, so the panel's own free-text shape field
// (see MARKER_SHAPE_LABEL/parseShapeInput below) is the only place a
// shape gets chosen, both at first placement (defaults to 'eye') and
// afterward (typing a new word in that field re-shapes the marker in
// place, no rebuild-from-scratch dialog needed).
const MARKER_SHAPE_LABEL = { eye: 'Eye', oval: 'Oval', 'oval-thin-h': 'Thin oval (horizontal)', 'oval-thin-v': 'Thin oval (vertical)', heart: 'Heart', 'heart-flip': 'Heart (flip)' };
const DEFAULT_MARKER_SHAPE = 'eye';
// Parses whatever the person typed in a marker's shape field into one of
// MARKER_SHAPE_LABEL's canonical ids. Deliberately loose: "nose" has no
// shape of its own anymore (a nose is just whichever shape - oval/
// heart/etc - someone picks for that spot), so "nose" on its own falls
// back to plain oval, the most nose-like default. "Thin oval" alone (no
// orientation word) defaults to horizontal, matching the reference photo's
// side-lying thin oval. "heart flip"/"heart upside down"/"heart inverted"
// gives the point-up variant; plain "heart" is point-down. "tri"/
// "triangle" is still accepted as an alias for "heart" so older saved
// patterns that typed the old shape name keep resolving correctly.
// Returns null for anything unrecognized, so the caller can leave the
// marker's existing shape alone and flag the input rather than silently
// guessing.
function parseShapeInput(raw) {
  const s = (raw || '').trim().toLowerCase();
  if (!s) return DEFAULT_MARKER_SHAPE;
  const hasThin  = /\bthin|slim|skinny|narrow/.test(s);
  const hasOval  = /\boval|nose\b/.test(s);
  const hasHeart = /\bheart|\btri/.test(s);
  const hasFlip  = /\bflip|upside|inverted|invert|reverse/.test(s);
  const hasEye   = /\beye/.test(s);
  if (hasHeart) return hasFlip ? 'heart-flip' : 'heart';
  if (hasThin && hasOval) return /\bvert|tall|up/.test(s) ? 'oval-thin-v' : 'oval-thin-h';
  if (hasThin) return /\bvert|tall|up/.test(s) ? 'oval-thin-v' : 'oval-thin-h';
  if (hasOval) return 'oval';
  if (hasEye) return 'eye';
  return null;
}
let markerMode = false;
let markers    = [];
let markerId   = 0;
// Set by a saved-preset load click (see renderSavedPresets); consumed by
// the next successful solve in run() or autobuildStep(), since restoring a
// marker needs real node positions from a finished solve, not just the
// round/stitch indices saved alongside the pattern.
let pendingMarkerRestore = [];
export function setPendingMarkerRestore(markers) { pendingMarkerRestore = markers; }
export const markerGroup = new THREE.Group();
// scene/canvas (imported from state.js) are still null at this point in
// module evaluation - state.js only gets real values once main.js's own
// top-level code calls setSceneObjects(), which happens AFTER every module
// main.js imports (this one included) has already finished evaluating. So
// none of this file's actual scene.add()/canvas.addEventListener() calls
// can run here directly - they're collected into initMarkerScene() below,
// which main.js calls right after setSceneObjects().

function nearestNodeInfo(localPoint, graph) {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < graph.nodeData.length; i++) {
    if (graph.nodeData[i].kind !== 'top') continue;
    const dx = lastPos[i*3]   - localPoint.x;
    const dy = lastPos[i*3+1] - localPoint.y;
    const dz = lastPos[i*3+2] - localPoint.z;
    const d = dx*dx + dy*dy + dz*dz;
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best === -1) return null;
  const nd   = graph.nodeData[best];
  const ring = graph.roundNodes[nd.round] || [];
  return {
    round: nd.round,
    indexInRound: nd.indexInRound,
    count: ring.length,
    type: graph.roundTypes[nd.round] || 'flat',
  };
}

const markerModeBtn = document.getElementById('marker-mode-btn');
const markerPanel    = document.getElementById('marker-panel');
const markerTooltip  = document.getElementById('marker-tooltip');

export function toggleMarkerMode() {
  if (!lastGraph) { setStatus('Visualize a pattern first.', false); return; }
  markerMode = !markerMode;
  markerModeBtn.textContent = markerMode ? 'x exit marker mode' : '+ place marker';
  markerModeBtn.classList.toggle('active', markerMode);
  if (markerMode) {
    if (markers.length > 0) markerPanel.style.display = 'block';
  } else {
    markerTooltip.style.display = 'none';
    canvas.style.cursor = 'default';
    markerPanel.style.display = 'none';
  }
}
markerModeBtn.addEventListener('click', toggleMarkerMode);

// Orients a marker mesh so its local +z (the axis every marker geometry is
// built along) points out along the surface normal - same as before - but
// for shapes that aren't radially symmetric around that axis (heart
// nose), also corrects the ROLL around the normal. setFromUnitVectors only
// picks the shortest rotation that lands +z on the normal; it leaves
// however much spin comes along for the ride unconstrained, which was fine
// for a symmetric ball or oval dome but would leave a heart's point
// facing a different, arbitrary direction on every piece. This adds a
// second rotation, around the normal itself, that pulls the shape's local
// "down" (-y) as close as it can get to world-down projected flat onto the
// surface - so the heart's point reads as pointing toward the chin, not
// sideways or up, however the piece happens to be angled.
function orientNoseMesh(mesh, normal, needsRollCorrection) {
  if (!normal || normal.lengthSq() < 1e-8) return;
  const n = normal.clone().normalize();
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1), n);
  if (!needsRollCorrection) return;
  const localDown = new THREE.Vector3(0,-1,0).applyQuaternion(mesh.quaternion);
  const worldDown = new THREE.Vector3(0,-1,0);
  const targetDown = worldDown.clone().sub(n.clone().multiplyScalar(worldDown.dot(n)));
  if (targetDown.lengthSq() < 1e-6) return; // normal is itself ~straight down/up - no well-defined "down" to roll toward
  targetDown.normalize();
  if (localDown.lengthSq() < 1e-8) return;
  localDown.normalize();
  const rollQuat = new THREE.Quaternion().setFromUnitVectors(localDown, targetDown);
  mesh.quaternion.premultiply(rollQuat);
}

// Skews a sphere's vertices into a rounded, upside-down-teardrop silhouette
// (wide rounded top, tapering toward a point at the bottom) by scaling each
// vertex's distance from the z axis based on its angle - bigger radius near
// the top (+y), smaller near the bottom (-y). Cheap way to get a proper
// non-radially-symmetric nose shape out of a sphere without hand-building a
// custom BufferGeometry. Must run BEFORE orientNoseMesh, while local +y
// still means "top" and local +z still means "toward the viewer/surface
// normal" - orientNoseMesh's roll correction is what keeps that meaning
// true once the mesh gets rotated onto the actual piece. This is the
// "heart" marker shape - a soft, rounded point-down teardrop rather than a
// notched two-lobe heart, which reads better at marker scale and matches
// what a "heart" safety-nose shape actually looks like once crocheted.
// The taper itself is eased with a power curve rather than a single sine
// lobe, so the top stays broad and rounded for longer before curving in,
// and the last stretch into the bottom point narrows faster - a soft
// rounded point rather than a hard corner.
function taperToHeart(geo) {
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    // t: 1 at the very top (+y), -1 at the very bottom (-y), 0 at the equator.
    const r0 = Math.hypot(v.x, v.y) || 1e-6;
    const t = v.y / r0;
    // Eased radial scale: broad/rounded through the top and equator, then
    // curves inward increasingly quickly toward the bottom tip. Using t^3
    // (instead of sine) keeps the top two-thirds much closer to a true
    // round dome, only pinching in hard over the last third.
    const taper = t > 0 ? (1 + 0.30 * t) : (1 + 0.62 * t * t * t);
    pos.setX(i, v.x * taper);
    pos.setY(i, v.y * taper);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
}

// Builds the actual mesh for a marker, shaped and finished per shape id
// (see MARKER_SHAPE_LABEL/parseShapeInput above - 'eye', 'oval',
// 'oval-thin-h', 'oval-thin-v', 'heart', or 'heart-flip'). Every non-eye
// shape uses the glossy plastic look (low roughness, real metalness) that
// reads as "safety nose" against yarn; eye stays a small ball, slightly
// less glossy so it doesn't compete with a nose as the shiniest point on
// the face. oval-thin-h/oval-thin-v are the same narrow-oval squash, just
// swapped between x and z so the long axis runs sideways vs top-to-bottom
// on the piece. heart-flip uses a rounder, more domed base before the
// eased taperToHeart - a wide rounded top curving smoothly down into a
// soft rounded point (point down). heart is the same geometry rotated
// 180deg around the protrusion axis, so the point sits at the top
// instead of the bottom (upside down). Every shape except eye (radially
// symmetric, no orientation needed) gets the roll-corrected orientation
// from orientNoseMesh. size is a uniform post-build scale multiplier,
// defaulting to 1.
function buildMarkerMesh(shape, color, normal, size) {
  const r = Math.max((parseFloat(yarnOpt.value)||0.38) * 1.1, 0.15);
  let mesh;
  if (shape === 'eye') {
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness:0.3, metalness:0.25 });
    const geo = new THREE.SphereGeometry(r * 0.85, 16, 12);
    mesh = new THREE.Mesh(geo, mat);
  } else {
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness:0.12, metalness:0.45 });
    const geo = new THREE.SphereGeometry(r * 1.25, 24, 16);
    if (shape === 'heart' || shape === 'heart-flip') {
      geo.scale(1.05, 1.05, 0.58); // rounder, more domed base before tapering - taper alone forms the point, the base needs to read as a soft dome first
      taperToHeart(geo);
      if (shape === 'heart') geo.rotateZ(Math.PI); // spin the whole shape 180deg around the protrusion axis - a real rotation, not a mirror, so face winding/normals stay correct
    } else if (shape === 'oval-thin-v') {
      geo.scale(0.62, 1.05, 0.42); // narrow oval, long axis running top-to-bottom
    } else if (shape === 'oval-thin-h') {
      geo.scale(1.05, 0.62, 0.42); // same narrow oval, rotated 90deg so the long axis runs sideways
    } else {
      geo.scale(1.0, 0.82, 0.48); // plain oval - skinnier than the last pass, matches the old v6 proportions
    }
    mesh = new THREE.Mesh(geo, mat);
    orientNoseMesh(mesh, normal, shape === 'heart' || shape === 'heart-flip');
  }
  mesh.scale.multiplyScalar(size || 1);
  return mesh;
}

function placeMarker(localPoint, info, color, shape, normal, size, forcePanel = true) {
  const id = ++markerId;
  color = color || MARKER_COLORS[0];
  shape = parseShapeInput(shape) || DEFAULT_MARKER_SHAPE;
  size = size || 1;
  const mesh = buildMarkerMesh(shape, color, normal, size);
  mesh.position.copy(localPoint);
  markerGroup.add(mesh);
  markers.push({ id, mesh, color, shape, size, normal: (normal && normal.lengthSq()>1e-8) ? normal.clone().normalize() : null, ...info });
  syncMarkerPanel(forcePanel);
  return markers[markers.length - 1];
}

// Re-shapes an already-placed marker in place from the panel's free-text
// shape field - rebuilds its geometry/material (buildMarkerMesh is cheap,
// no reason to try to mutate an existing BufferGeometry in place) but
// keeps the same position/normal/size. Returns false without changing
// anything if the typed text doesn't parse to a known shape, so the caller
// can flag the input as unrecognized instead of silently guessing.
function updateMarkerShape(id, rawShape) {
  const m = markers.find(m => m.id === id);
  if (!m) return false;
  const shape = parseShapeInput(rawShape);
  if (!shape) return false;
  m.shape = shape;
  const oldMesh = m.mesh;
  const newMesh = buildMarkerMesh(shape, m.color, m.normal, m.size);
  newMesh.position.copy(oldMesh.position);
  markerGroup.remove(oldMesh);
  oldMesh.geometry.dispose();
  oldMesh.material.dispose();
  markerGroup.add(newMesh);
  m.mesh = newMesh;
  return true;
}
window.updateMarkerShape = updateMarkerShape;

// Rescales a placed marker's mesh in place - no geometry rebuild needed,
// size is just a uniform scale on top of whatever shape/orientation the
// mesh already has. Takes a PERCENT value straight from the panel's size
// input (100 = normal size, matching m.size's own 1 = normal convention
// internally) so the panel can work in the same percent units the person
// types, without every other call site needing to know about the *100/100
// conversion.
function updateMarkerSize(id, percent) {
  const m = markers.find(m => m.id === id);
  if (!m) return;
  const pct = Math.max(10, parseFloat(percent) || 100);
  const s = pct / 100;
  m.size = s;
  m.mesh.scale.setScalar(s);
  return pct;
}
window.updateMarkerSize = updateMarkerSize;

// Serializes the placed-marker list down to what saveCurrentPattern stores
// alongside a preset's lines. Stores the EXACT position/normal from
// placement time (mesh.position / m.normal) rather than just round +
// indexInRound - a fresh solve of the same pattern can converge to a
// very slightly different arrangement (stress majorization has no
// absolute reference frame), so re-deriving a marker's spot from
// round/stitch on restore could drift from where it was actually clicked.
// round/indexInRound are still saved alongside for the panel's
// descriptive label ("R7, stitch 13 of 30") and as a fallback for
// restoring older saves that predate this field. color/shape/size are
// small enough, and travel with the marker regardless of position, so
// there's no reason to recompute those either.
export function markersToSaveData() {
  return markers.map(m => ({
    round: m.round,
    indexInRound: m.indexInRound,
    color: m.color,
    shape: m.shape || DEFAULT_MARKER_SHAPE,
    size: m.size || 1,
    pos: m.mesh.position.toArray(),
    normal: m.normal ? m.normal.toArray() : null,
  }));
}

// Rough per-node outward direction for markers restored without a raycast
// hit to read a real face normal from (see restoreMarker) - the vector from
// the whole piece's centroid to the node reads as "outward" well enough for
// a typical amigurumi round/tube shape to orient a restored nose sensibly.
// Used as a fallback when a marker's own round is degenerate (see
// computeRingCentroid below, which is the primary method now).
function computeGraphCentroid(graph) {
  let x=0,y=0,z=0,n=0;
  for (let i=0;i<graph.nodeData.length;i++) {
    if (graph.nodeData[i].kind !== 'top') continue;
    x+=lastPos[i*3]; y+=lastPos[i*3+1]; z+=lastPos[i*3+2]; n++;
  }
  if (!n) return new THREE.Vector3(0,0,0);
  return new THREE.Vector3(x/n, y/n, z/n);
}

// Rough per-node outward direction for markers restored without a raycast
// hit to read a real face normal from (see restoreMarker) - uses that
// node's own ROUND's centroid, not the whole piece's, since a nose/ear
// round sits off to one side of the body's overall center. Using the
// whole-graph centroid there points "outward" toward the piece's general
// middle rather than away from that round's own local surface, which is
// what was rotating/nudging restored nose and ear markers relative to
// where they were originally clicked.
function computeRingCentroid(graph, round) {
  const ring = graph.roundNodes && graph.roundNodes[round];
  if (!ring || !ring.length) return null;
  let x=0,y=0,z=0;
  ring.forEach(id => { x+=lastPos[id*3]; y+=lastPos[id*3+1]; z+=lastPos[id*3+2]; });
  return new THREE.Vector3(x/ring.length, y/ring.length, z/ring.length);
}

// Places one marker back from saved data. Prefers the EXACT saved
// position/normal (entry.pos/entry.normal) when present, replaying them
// as-is with no recomputation - this is what makes a restored marker land
// on the precise spot it was originally clicked, rather than wherever
// round+indexInRound happens to resolve to on THIS solve. Falls back to
// reconstructing a position from round/indexInRound (against the
// just-finished solve's lastPos, using the round's own centroid to
// approximate a normal) only for older saves made before pos/normal were
// stored - a genuinely edited pattern can also outdate a saved marker's
// round/stitch entirely, in which case it's silently skipped rather than
// erroring over one stray marker. entry.markerType/entry.noseShape are
// read as a further fallback for markers saved before the shape system
// was unified, so older saved patterns still restore sensibly instead of
// silently losing their shape.
function restoreMarker(entry) {
  if (!lastGraph || !lastPos) return;
  const ring = lastGraph.roundNodes && lastGraph.roundNodes[entry.round];
  // info is purely descriptive (the "R7, stitch 13 of 30" label in the
  // panel) - computed from the CURRENT graph when possible so it reflects
  // the piece as it stands now, but its absence doesn't block placement
  // when exact saved coordinates are available to fall back on.
  let info = null;
  if (ring && ring.length && entry.indexInRound != null && entry.indexInRound < ring.length) {
    info = {
      round: entry.round,
      indexInRound: entry.indexInRound,
      count: ring.length,
      type: (lastGraph.roundTypes && lastGraph.roundTypes[entry.round]) || 'flat',
    };
  }

  if (entry.pos) {
    // Exact position (and, if saved, exact normal) from the original
    // placement - no re-derivation, returns to the precise spot it was
    // clicked regardless of how this solve happened to come out.
    const p = new THREE.Vector3().fromArray(entry.pos);
    const normal = entry.normal ? new THREE.Vector3().fromArray(entry.normal) : null;
    const legacyShape = entry.markerType === 'pin' ? 'eye' : (entry.markerType === 'nose' ? entry.noseShape : entry.markerType);
    placeMarker(p, info || { round: entry.round, indexInRound: entry.indexInRound, count: entry.count||0, type: entry.type||'flat' }, entry.color, entry.shape || legacyShape, normal, entry.size);
    return;
  }

  // Fallback for older saves with no stored pos/normal.
  if (!info) return; // round/stitch no longer exists in this solve, and no exact fallback position either
  const nodeId = ring[entry.indexInRound];
  const p = new THREE.Vector3(lastPos[nodeId*3], lastPos[nodeId*3+1], lastPos[nodeId*3+2]);
  const ringCentroid = computeRingCentroid(lastGraph, entry.round);
  let normal = ringCentroid ? p.clone().sub(ringCentroid) : null;
  if (!normal || normal.lengthSq() < 1e-6) {
    normal = p.clone().sub(computeGraphCentroid(lastGraph));
  }
  if (normal.lengthSq() > 1e-8) {
    const yarnR = parseFloat(yarnOpt.value) || 0.38;
    p.addScaledVector(normal.clone().normalize(), yarnR);
  }
  const legacyShape = entry.markerType === 'pin' ? 'eye' : (entry.markerType === 'nose' ? entry.noseShape : entry.markerType);
  placeMarker(p, info, entry.color, entry.shape || legacyShape, normal, entry.size, false);
}

// Drains pendingMarkerRestore against whatever was just solved. Called
// from both run() and autobuildStep()'s success paths so a saved preset's
// markers reappear whichever way the pattern first gets solved after
// loading it.
export function restorePendingMarkers() {
  if (!pendingMarkerRestore.length) return;
  const toRestore = pendingMarkerRestore;
  pendingMarkerRestore = [];
  toRestore.forEach(e => restoreMarker(e));
  if (toRestore.length) syncMarkerPanel();
}

function deleteMarker(id) {
  const idx = markers.findIndex(m => m.id === id);
  if (idx === -1) return;
  markerGroup.remove(markers[idx].mesh);
  markers[idx].mesh.geometry.dispose();
  markers[idx].mesh.material.dispose();
  markers.splice(idx, 1);
  syncMarkerPanel();
}

// silent=true skips the full panel re-render - used by the color-wheel
// live callback (openMarkerColorWheel), which can fire many times a
// second while dragging the wheel. Rebuilding marker-list's whole innerHTML
// on every one of those ticks would reflow the panel and lose any in-
// progress interaction (e.g. focus in a shape text field) for no benefit,
// since only this marker's own dot/mesh color actually needs to move
// during the drag - the swatch row's active-state and the rest of the
// panel only need a real refresh once the picker closes.
function updateMarkerColor(id, color, silent) {
  const m = markers.find(m => m.id === id);
  if (!m) return;
  m.color = color;
  m.mesh.material.color.set(color);
  if (silent) {
    const item = document.querySelector(`.marker-item[data-marker-id="${id}"]`);
    if (item) {
      const dot = item.querySelector('.marker-dot');
      if (dot) dot.style.background = color;
    }
    return;
  }
  syncMarkerPanel();
}

export function clearMarkers() {
  markers.forEach(m => {
    markerGroup.remove(m.mesh);
    m.mesh.geometry.dispose();
    m.mesh.material.dispose();
  });
  markers = [];
  syncMarkerPanel();
}

window.deleteMarker = deleteMarker;
window.updateMarkerColor = updateMarkerColor;

// Handles the shape text field losing focus (blur) or Enter being pressed -
// tries to parse and apply whatever's currently typed, and marks the field
// as unrecognized (a red border, see .marker-label-input.unrecognized) if
// it doesn't parse rather than silently reverting it, so the person can see
// their text wasn't understood and try different wording. A successful
// parse re-syncs the whole panel (the field's own placeholder/value should
// reflect the canonical label, e.g. typing "olval" or "triangl-ish" either
// snaps to a real label or stays flagged, never lingers as a half-applied
// guess) and does not need to force the marker panel open since it's
// already open for the person to be typing in it.
function commitMarkerShapeInput(id, inputEl) {
  const ok = updateMarkerShape(id, inputEl.value);
  if (ok) { syncMarkerPanel(); return; }
  inputEl.classList.toggle('unrecognized', inputEl.value.trim() !== '');
}
window.commitMarkerShapeInput = commitMarkerShapeInput;

function syncMarkerPanel(forceShow) {
  const list = document.getElementById('marker-list');
  if (markers.length === 0) {
    markerPanel.style.display = 'none';
    list.innerHTML = '';
    return;
  }
  if (forceShow) {
    markerPanel.style.display = 'block';
  }
  list.innerHTML = markers.map(m => {
    const typeLabel = TYPE_LABEL[m.type] || m.type || '';
    const shapeLabel = MARKER_SHAPE_LABEL[m.shape] || MARKER_SHAPE_LABEL[DEFAULT_MARKER_SHAPE];
    const swatches = MARKER_COLORS.map(c =>
      `<div class="marker-color-swatch${m.color===c?' active':''}" style="background:${c}" onclick="updateMarkerColor(${m.id},'${c}')"></div>`
    ).join('');
    const sizePct = Math.round((m.size||1)*100);
    return `<div class="marker-item" data-marker-id="${m.id}">
      <div class="marker-item-top">
        <div class="marker-dot" style="background:${m.color}"></div>
        <input type="text" class="marker-label-input" placeholder="eye..." value="${shapeLabel}"
          onkeydown="if(event.key==='Enter'){this.blur();}"
          onblur="commitMarkerShapeInput(${m.id}, this);">
        <button class="marker-del" onclick="deleteMarker(${m.id})">&times;</button>
      </div>
      <div class="marker-item-meta">${roundLabel(m.round)} ${typeLabel} &middot; stitch ${m.indexInRound+1} of ${m.count}</div>
      <div class="marker-size-row">
        <label for="marker-size-${m.id}">size</label>
        <input type="range" id="marker-size-${m.id}" class="marker-size-slider" min="10" max="400" step="5" value="${sizePct}"
          oninput="document.getElementById('marker-size-val-${m.id}').textContent = updateMarkerSize(${m.id}, this.value) + '%';">
        <span class="marker-size-value" id="marker-size-val-${m.id}">${sizePct}%</span>
      </div>
      <div class="marker-color-section">
        <div class="marker-color-section-label">colour</div>
        <div class="marker-color-row">${swatches}
          <div class="marker-color-swatch marker-color-wheel${MARKER_COLORS.includes(m.color)?'':' has-color'}" style="--_cc:${m.color}" title="Custom color..." onclick="openMarkerColorWheel(${m.id}, this)"></div>
        </div>
      </div>
    </div>`;
  }).join('');
}

// Opens the shared color-wheel popover for one marker's own color, updating
// it live as the wheel/hue/hex/rgb inputs change (same real-time pattern
// the "insert color" button and base-color swatch already use) rather than
// only applying on close - dragging the wheel recolors the marker
// immediately, and whatever's showing when the popover is dismissed is
// what stays.
function openMarkerColorWheel(id, anchorEl) {
  const m = markers.find(m => m.id === id);
  if (!m) return;
  openColorPicker({
    anchorEl,
    initialHex: m.color,
    live: (hex) => updateMarkerColor(id, hex, true),
    onCommit: (hex) => updateMarkerColor(id, hex, false),
  });
}
window.openMarkerColorWheel = openMarkerColorWheel;

// Raycasting, canvas listeners (marker hover/click/drag), and the
// scene.add() for markerGroup all need the real scene/canvas objects,
// which aren't set yet at module-evaluation time (see the comment by
// markerGroup above) - so this whole cluster is deferred into
// initMarkerScene(), called by main.js right after setSceneObjects().
export function initMarkerScene() {
scene.add(markerGroup);

const raycaster = new THREE.Raycaster();
const mouseNDC  = new THREE.Vector2();

function getMouseNDC(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX-rect.left)/rect.width)*2-1,
    y: -((e.clientY-rect.top)/rect.height)*2+1,
    clientX: e.clientX, clientY: e.clientY, rect,
  };
}

canvas.addEventListener('mousemove', e => {
  if (draggingMarker) { markerTooltip.style.display = 'none'; return; } // dragging has its own live position feedback via the marker itself
  if (markerMode) {
    if (!currentMesh || !lastGraph) return;
    const {x,y,clientX,clientY,rect} = getMouseNDC(e);
    mouseNDC.set(x,y);
    raycaster.setFromCamera(mouseNDC, camera);
    const hits = raycaster.intersectObject(currentMesh, true);
    if (hits.length) {
      const local = currentMesh.worldToLocal(hits[0].point.clone());
      const info  = nearestNodeInfo(local, lastGraph);
      if (info) {
        document.getElementById('tt-row').textContent = `${roundLabel(info.round)}, ${TYPE_LABEL[info.type]||info.type}`;
        document.getElementById('tt-stitch').textContent = `stitch ${info.indexInRound+1} of ${info.count}`;
        document.getElementById('tt-hint').textContent = 'click to place marker';
        markerTooltip.style.display = 'block';
        markerTooltip.style.left = (clientX-rect.left+14)+'px';
        markerTooltip.style.top  = (clientY-rect.top-10)+'px';
        canvas.style.cursor = 'crosshair';
      }
    } else {
      markerTooltip.style.display = 'none';
      canvas.style.cursor = 'default';
    }
    return;
  }

  // Not in marker-placement mode: hover the row-marker rings / start dots
  // themselves (whichever overlay is currently toggled on) to see which
  // round they belong to, with no click-to-place behavior attached - this
  // works any time the overlay is visible, it doesn't require entering
  // marker mode first.
  if (!currentRowGroup || (!rowsOn && !startDotOn)) {
    markerTooltip.style.display = 'none';
    return;
  }
  const {x,y,clientX,clientY,rect} = getMouseNDC(e);
  mouseNDC.set(x,y);
  raycaster.setFromCamera(mouseNDC, camera);
  const hits = raycaster.intersectObject(currentRowGroup, true);
  const hit = hits.find(h => h.object && h.object.userData && h.object.userData.round != null);
  if (hit) {
    const {round, type} = hit.object.userData;
    document.getElementById('tt-row').textContent = `${roundLabel(round)}, ${TYPE_LABEL[type]||type}`;
    document.getElementById('tt-stitch').textContent = '';
    document.getElementById('tt-hint').textContent = '';
    markerTooltip.style.display = 'block';
    markerTooltip.style.left = (clientX-rect.left+14)+'px';
    markerTooltip.style.top  = (clientY-rect.top-10)+'px';
    canvas.style.cursor = 'pointer';
  } else {
    markerTooltip.style.display = 'none';
    canvas.style.cursor = 'default';
  }
});
canvas.addEventListener('mouseleave', () => { markerTooltip.style.display = 'none'; });

let _clickStartX = 0, _clickStartY = 0;
let _suppressNextMarkerClick = false;
canvas.addEventListener('mousedown', e => { _clickStartX = e.clientX; _clickStartY = e.clientY; });
canvas.addEventListener('click', e => {
  if (!markerMode || !currentMesh || !lastGraph) return;
  if (_suppressNextMarkerClick) { _suppressNextMarkerClick = false; return; } // this click ended a marker drag, not a placement
  if (Math.abs(e.clientX-_clickStartX)>4 || Math.abs(e.clientY-_clickStartY)>4) return; // was an orbit drag
  const {x,y} = getMouseNDC(e);
  mouseNDC.set(x,y);
  raycaster.setFromCamera(mouseNDC, camera);
  const hits = raycaster.intersectObject(currentMesh, true);
  if (!hits.length) return;
  const local = currentMesh.worldToLocal(hits[0].point.clone());
  const info  = nearestNodeInfo(local, lastGraph);
  if (!info) return;
  // face.normal from Raycaster is already in the intersected object's local
  // space - the same space worldToLocal just put `local` into above - so no
  // further transform is needed to keep the two consistent.
  const normal = hits[0].face ? hits[0].face.normal.clone() : null;
  // No pre-placement shape picker anymore - every click drops a default
  // 'eye' marker (see DEFAULT_MARKER_SHAPE), and the person retypes its
  // shape afterward in the panel's own text field if they want something
  // else (nose/oval/heart/etc - see parseShapeInput).
  placeMarker(local, info, null, DEFAULT_MARKER_SHAPE, normal);
});

// Marker drag-to-reposition
// Grabbing an already-placed marker and dragging it re-snaps it to whatever
// stitch is under the cursor as you move, same node-nearest-search placeMarker
// itself uses - so a drag ends exactly where a fresh placement there would
// have landed. Orbit's own mousedown (registered on this same canvas, well
// before this one) always fires first and sets its `dragging` flag - that
// can't be undone from here, so instead orbit.setSuspended(true) tells its
// OWN mousemove handler to skip rotating for the duration of this drag.
let draggingMarker = null;
let markerDragPanelQueued = false;

function markerAtScreenPoint(e) {
  const {x,y} = getMouseNDC(e);
  mouseNDC.set(x,y);
  raycaster.setFromCamera(mouseNDC, camera);
  const hits = raycaster.intersectObjects(markerGroup.children, false);
  if (!hits.length) return null;
  return markers.find(m => m.mesh === hits[0].object) || null;
}

canvas.addEventListener('mousedown', e => {
  if (!markerMode) return;
  const hit = markerAtScreenPoint(e);
  if (!hit) return;
  draggingMarker = hit;
  _suppressNextMarkerClick = true; // the matching click (drag or plain re-click) shouldn't also place a new marker
  orbit.setSuspended(true);
  canvas.style.cursor = 'grabbing';
});

window.addEventListener('mousemove', e => {
  if (!draggingMarker || !currentMesh || !lastGraph) return;
  const {x,y} = getMouseNDC(e);
  mouseNDC.set(x,y);
  raycaster.setFromCamera(mouseNDC, camera);
  const hits = raycaster.intersectObject(currentMesh, true);
  if (!hits.length) return;
  const local = currentMesh.worldToLocal(hits[0].point.clone());
  const info  = nearestNodeInfo(local, lastGraph);
  if (!info) return;
  draggingMarker.mesh.position.copy(local);
  if (hits[0].face && draggingMarker.shape !== 'eye') {
    const normal = hits[0].face.normal.clone();
    if (normal.lengthSq() > 1e-8) {
      orientNoseMesh(draggingMarker.mesh, normal, draggingMarker.shape === 'heart' || draggingMarker.shape === 'heart-flip');
      draggingMarker.normal = normal.normalize();
    }
  }
  draggingMarker.round = info.round;
  draggingMarker.indexInRound = info.indexInRound;
  draggingMarker.count = info.count;
  draggingMarker.type = info.type;
  if (!markerDragPanelQueued) {
    markerDragPanelQueued = true;
    requestAnimationFrame(() => { markerDragPanelQueued = false; syncMarkerPanel(); });
  }
});

window.addEventListener('mouseup', () => {
  if (!draggingMarker) return;
  draggingMarker = null;
  orbit.setSuspended(false);
  canvas.style.cursor = markerMode ? 'crosshair' : 'default';
});

} // end initMarkerScene()