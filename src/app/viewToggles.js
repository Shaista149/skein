// VIEW TOGGLES: flip, row markers, row starts, flatten - plus the small
// shared UI-status helpers (setStatus, setProgress, abort) and the
// display-position helpers (getDisplayPos, getFramingPos, roundLabel)
// that these toggles and the solve pipeline both depend on.

import { flattenHorizontal } from '../lib/geometry.js';
import { markerGroup, clearMarkers } from './markers.js';
import { rebuildDisplay } from './colorPicker.js';
import {
  flipOn, rowsOn, startDotOn, flattenOn,
  setFlipOn, setRowsOn, setStartDotOn, setFlattenOn,
  currentMesh, currentRowGroup, lastGraph, lastPos, orbit, abortCtrl,
  flattenedPosCache, flattenedPosCacheYarnR, setFlattenedPosCache,
} from './state.js';

const yarnOpt = document.getElementById('opt-yarn');

const statusEl   = document.getElementById('status');
const ringCircle = document.getElementById('ring-circle');
const progBar    = document.getElementById('progress-bar');

export function setStatus(msg, ok = null) {
  statusEl.textContent = msg;
  statusEl.style.color = ok === true ? '#7a9a78' : ok === false ? '#c44' : null;
}

export function setProgress(f) {
  const p = Math.round(f * 100);
  progBar.style.width = p + '%';
  const circ = 163.4;
  ringCircle.style.strokeDashoffset = circ * (1 - f);
}

export function abort() {
  if (abortCtrl) { abortCtrl.abort(); }
}

// Human-facing round label for tooltips/marker labels, including the "R"
// prefix. Internal round index 0 IS round "1" for every normal piece (MR
// or a plain first row), so the label is just "R"+(index+1) - but for a
// chain-worked-in-the-round piece, internal index 0 is the foundation
// chain itself (never a real, numbered row in a written pattern - it's
// what round 1 gets worked INTO, not round 1 itself). So for those pieces
// every real stitch round sits one internal index ahead of its
// pattern-facing number: internal index 1 is the round worked into the
// chain, and that's what a pattern would call "Round 1" - meaning label
// uses index alone (not index+1), once we're past the chain. The chain
// round itself never reaches this function in practice (it has no
// marker/geometry to hover), so its own label doesn't matter.
// A fuse: round's imported piece brings its OWN rounds along too (see
// importedRoundRanges, appended after this piece's own in compileGraph) -
// those aren't a continuation of THIS piece's numbering at all (hovering
// leg1's own magic-ring shouldn't claim to be "this piece's round 8"), so
// they get labeled with the source piece's name and ITS own row number
// instead.
export function roundLabel(ri, graph) {
  const g = graph || lastGraph;
  const ownCount = g ? (g.ownRoundCount ?? g.roundNodes.length) : Infinity;
  if (ri >= ownCount && g && g.importedRoundRanges) {
    const range = g.importedRoundRanges.find(r => ri >= r.startRi && ri < r.startRi + r.count);
    if (range) return `${range.name} R${ri - range.startRi + 1}`;
  }
  if (ri < ownCount && g && g.ownRoundDisplayNums && g.ownRoundDisplayNums[ri]) return `R${g.ownRoundDisplayNums[ri]}`;
  if (g && g.chainFoundationRound != null && ri > g.chainFoundationRound) return `R${ri}`;
  return `R${ri + 1}`;
}

// The position array actually handed to buildMesh/buildRowMarkerGroup right
// now: the real solved positions, or - if Flatten is toggled on - a
// lazily-computed, cached, pressed-flat copy of them (see
// flattenHorizontal). Toggling Flatten off always falls back to lastPos
// exactly, unchanged - the flatten toggle never touches the real solve.
export function getDisplayPos() {
  if (!flattenOn || !lastPos || !lastGraph) return lastPos;
  const yarnR = parseFloat(yarnOpt.value) || 0.38;
  if (!flattenedPosCache || flattenedPosCacheYarnR !== yarnR) {
    const newCache = flattenHorizontal(lastPos, lastGraph.roundNodes, lastGraph.isFlatPiece, lastGraph.chainFoundationRound, lastGraph.chainOvalRound, lastGraph.foldRounds, yarnR, lastGraph.adjList, lastGraph.N, lastGraph.hubOf, lastGraph.flapRounds);
    setFlattenedPosCache(newCache, yarnR);
    return newCache;
  }
  return flattenedPosCache;
}

// What the camera should actually frame right now - getDisplayPos(), but
// with Y mirrored to match flip's own effect IF flip is on. Flip itself
// is applied as a pure scale.y=-1 on the mesh GROUP (see applyFlip) around
// the group's own local origin - which lines up with world origin only
// because mdsLayout centers the raw solve there BEFORE any mount/graft
// piece gets rigidly repositioned onto its real anchor. A mounted piece
// (ears, limbs...) is placed AFTER that centering step, so the finished
// model - body plus wherever its attachments actually stick out - is
// generally NOT symmetric around y=0 any more. A plain Y-flip of geometry
// that isn't centered on the axis it's flipping around doesn't just mirror
// in place, it relocates the model's real bounding box - which is exactly
// why toggling flip could send the whole model sailing off toward one
// edge of the screen with nothing correcting the camera afterward. Rather
// than try to re-center the solve itself (which would need to happen
// AFTER mount/graft placement, and would shift where every existing
// pattern's "up" ends up pointing), this just gives every fitTo call site
// the SAME flipped-or-not point cloud flip visually produces, so framing
// always matches what's actually on screen.
export function getFramingPos() {
  const p = getDisplayPos();
  if (!p || !flipOn) return p;
  const flipped = new Float64Array(p);
  for (let i = 1; i < flipped.length; i += 3) flipped[i] = -flipped[i];
  return flipped;
}

export function applyFlip() {
  const s = flipOn ? -1 : 1;
  if (currentMesh)     currentMesh.scale.y = s;
  if (currentRowGroup) currentRowGroup.scale.y = s;
  markerGroup.scale.y = s;
}

const flipBtn     = document.getElementById('btn-flip');
const flattenBtn  = document.getElementById('btn-flatten');
const rowsBtn     = document.getElementById('btn-rows');
const startDotBtn = document.getElementById('btn-startdot');

flipBtn.addEventListener('click', () => {
  setFlipOn(!flipOn);
  flipBtn.textContent = `Flip: ${flipOn ? 'on' : 'off'}`;
  flipBtn.classList.toggle('on', flipOn);
  applyFlip();
  if (lastGraph) orbit.fitTo(getFramingPos());
});
flattenBtn.addEventListener('click', () => {
  if (!lastGraph) return;
  setFlattenOn(!flattenOn);
  flattenBtn.textContent = `Flatten: ${flattenOn ? 'on' : 'off'}`;
  flattenBtn.classList.toggle('on', flattenOn);
  clearMarkers();
  rebuildDisplay();
  orbit.fitTo(getFramingPos());
});
rowsBtn.addEventListener('click', () => {
  setRowsOn(!rowsOn);
  rowsBtn.textContent = `Row markers: ${rowsOn ? 'on' : 'off'}`;
  rowsBtn.classList.toggle('on', rowsOn);
  if (currentRowGroup) currentRowGroup._lineGrp.visible = rowsOn;
});
startDotBtn.addEventListener('click', () => {
  setStartDotOn(!startDotOn);
  startDotBtn.textContent = `Row starts: ${startDotOn ? 'on' : 'off'}`;
  startDotBtn.classList.toggle('on', startDotOn);
  if (currentRowGroup) currentRowGroup._startDotGrp.visible = startDotOn;
});