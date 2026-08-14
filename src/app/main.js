import { initScene, initOrbit } from './scene.js';
import '../style.css';
import { parsePattern } from '../lib/parser.js';
import { compileGraph } from '../lib/graph.js';
import { disposeMesh } from '../lib/mesh.js';
import {
  roundsNeedPieceLibrary, roundsNeedIncrementalFuseSolve,
  solveFusedPieces, solveFusedPiecesCached, solveFusedIncrementally, solveGraph,
} from './solver.js';
import { getFramingPos, setStatus, setProgress, abort } from './viewToggles.js';
import { rebuildDisplay } from './colorPicker.js';
import { clearMarkers, restorePendingMarkers, initMarkerScene } from './markers.js';
import { renderPatternEditor, loadPieceLibrary, patternLines } from './patternEditor.js';
import { PRESETS } from './presets.js';
import {
  setSceneObjects, setLastSolve, setCurrentMesh, setCurrentRowGroup,
  invalidateFlattenedPosCache, setAbortCtrl, currentMesh, currentRowGroup, lastGraph,
} from './state.js';
import { setAutobuild, autobuildOn } from './autobuild.js'

// SCENE / CANVAS SETUP
const canvas   = document.getElementById('three-canvas');
const {scene, camera, start} = initScene(canvas);
const orbit    = initOrbit(camera, canvas);
setSceneObjects(scene, camera, orbit, canvas);
initMarkerScene();
start();

const statusEl  = document.getElementById('status');
const overlay   = document.getElementById('solve-overlay');
const subEl     = document.getElementById('solve-sub');
const ringCircle= document.getElementById('ring-circle');
const progBar   = document.getElementById('progress-bar');
const vizBtn    = document.getElementById('btn-visualize');

// OPTIONS (yarn thickness slider)

// Options
const yarnOpt = document.getElementById('opt-yarn');
// mm display conversion: this app's internal geometry is unitless, with
// 1 UNIT defined (see mdsLayout/compileGraph) as one stitch's own
// width/height. A real single crochet worked at a typical gauge is roughly
// 8mm tall/wide, so UNIT_TO_MM anchors the sliders' physical-looking mm
// labels to that same real-world stitch size - it's a display-only
// conversion, purely cosmetic, and never touches the solve or geometry
// itself (still driven by the raw 0-1-scale slider value underneath).
const UNIT_TO_MM = 8;
function formatMM(unitVal) { return (unitVal * UNIT_TO_MM).toFixed(1) + 'mm'; }
// Yarn thickness never touches the solve itself (see getDisplayPos/
// rebuildDisplay below) - it only feeds the post-solve flatten pass and the
// mesh's tube radius - so dragging this slider can rebuild live off the
// already-solved lastPos instead of forcing a full re-solve. rebuildDisplay
// is a function declaration (hoisted), so it's safe to reference here even
// though it's defined further down the file. Throttled to at most one
// rebuild per animation frame so a fast drag doesn't queue up dozens of
// redundant mesh rebuilds; the label updates immediately regardless.
let yarnRebuildQueued = false;
yarnOpt.addEventListener('input', () => {
  document.getElementById('yarn-val').textContent = formatMM(parseFloat(yarnOpt.value));
  if (!lastGraph || yarnRebuildQueued) return;
  yarnRebuildQueued = true;
  requestAnimationFrame(() => { yarnRebuildQueued = false; rebuildDisplay(); });
});

// RUN / AUTOBUILD
async function run() {
  abort();
  if (autobuildOn) setAutobuild(false); // manual solve takes over the display; see setAutobuild

  const library = loadPieceLibrary(); // fuse:/graft:/mount: segments resolve against your saved patterns AND the built-in presets
  const parsed = parsePattern(patternLines, {library});
  const hasErrors = parsed.rounds.some(r=>r.error);
  if (hasErrors) { setStatus('Fix pattern errors first.',false); return; }

  let solvedLibrary;
  try {
    setStatus('Solving fused pieces...');
    solvedLibrary = await solveFusedPieces(parsed, library);
  } catch(e) {
    setStatus('Error: '+e.message, false);
    return;
  }

  let graph;
  try {
    graph = compileGraph(parsed, {library, solvedLibrary});
  } catch(e) {
    setStatus('Error: '+e.message, false);
    return;
  }
  if (graph.N === 0) { setStatus('No stitches to visualize.',false); return; }

  // Solve quality used to be a user-facing slider (100-600). Testing showed
  // the solver reliably self-terminates well before that range regardless
  // of pattern size for an ORDINARY piece (e.g. a 1442-node stress test
  // converged at iteration 113 every time), so the slider changed nothing
  // visible. Replaced with a fixed safety cap comfortably above observed
  // convergence points; the early-exit in the majorization loop means most
  // patterns finish far earlier than this in practice.
  //
  // A fuse: round is a different story. The fused-in piece(s) are hard-
  // pinned - frozen from the first iteration, so their own shape can never
  // be at fault - but that leaves the new trunk rows built on top of the
  // fuse doing all the work of settling around two already-rigid, already-
  // positioned chunks, and that measurably takes far longer to converge: a
  // real repro (two legs, 736 nodes total) was still visibly moving at 400
  // AND at 1200 iterations, not stuck, just slow, and didn't actually
  // settle until iteration 2667. Bumping the general cap that high "just in
  // case" would be wasteful for the common case, so only fused patterns get
  // the taller ceiling - everything else still exits at its natural,
  // already-fast convergence point same as before.
  const FULL_QUALITY_ITER_CAP = 400;
  const isFused = graph.fuseRoundLift && graph.fuseRoundLift.size;
  const ac = new AbortController();
  setAbortCtrl(ac);

  overlay.style.display = 'flex';
  vizBtn.disabled = true;
  setProgress(0);
  setStatus(`Solving (${graph.N} nodes)...`);

  try {
    let finalGraph, pos, iters;
    if (isFused) {
      // Fuse patterns solve round-by-round instead of one cold solve of
      // the whole graph - see solveFusedIncrementally for why. This is
      // the same solving strategy autobuild already uses, now shared
      // instead of two separately-behaving code paths.
      const result = await solveFusedIncrementally(parsed.rounds, library, {
        solveFusedFn: solveFusedPiecesCached,
        signal: ac.signal,
        onStep: (len, total, stepGraph) => {
          setStatus(`Solving (round ${len} of ${total}, ${stepGraph.N} nodes)...`);
          setProgress(len / total);
        },
      });
      finalGraph = result.graph; pos = result.pos; iters = result.iters;
    } else {
      iters = FULL_QUALITY_ITER_CAP;
      finalGraph = graph;
      pos = await solveGraph(graph, {
        iterations: iters,
        warmStartPos: graph.warmStartPos,
        onProgress: setProgress,
        onPhase: msg => { subEl.textContent = msg; },
        signal: ac.signal,
      });
    }

    // Cache for the color picker / flip / flatten toggles, and clear
    // markers from the previous solve since node positions have moved.
    setLastSolve(finalGraph, pos);
    invalidateFlattenedPosCache();
    clearMarkers();
    rebuildDisplay();
    restorePendingMarkers();

    orbit.fitTo(getFramingPos());
    setStatus(`Done. ${finalGraph.N} nodes, ${iters} iterations.`, true);
  } catch(e) {
    if (e.name!=='AbortError') {
      setStatus('Error: '+e.message, false);
    }
  } finally {
    overlay.style.display = 'none';
    vizBtn.disabled = false;
  }
}

vizBtn.addEventListener('click', () => run());

// INIT
patternLines.length = 0;
patternLines.push(...PRESETS.ball);
document.querySelector('.pbtn[data-preset="ball"]').classList.add('active');
renderPatternEditor();
setStatus(`Ready. ${PRESETS.ball.length} rounds loaded.`, true);