import { parsePattern } from '../lib/parser.js';
import { compileGraph } from '../lib/graph.js';
import { disposeMesh } from '../lib/mesh.js';
import {
  roundsNeedPieceLibrary, roundsNeedIncrementalFuseSolve,
  solveFusedPiecesCached, solveFusedIncrementally, solveGraph,
} from './solver.js';
import { getFramingPos, setStatus, abort } from './viewToggles.js';
import { rebuildDisplay } from './colorPicker.js';
import { clearMarkers, restorePendingMarkers } from './markers.js';
import { loadPieceLibrary, patternLines } from './patternEditor.js';
import {
  orbit, currentMesh, currentRowGroup,
  setLastSolve, setCurrentMesh, setCurrentRowGroup, invalidateFlattenedPosCache,
} from './state.js';

// AUTOBUILD: progressive row-by-row reveal
// Same solver, same solveGraph() post-process pipeline as a manual Visualize -
// just called again on the growing valid prefix of the pattern every time a
// new round becomes error-free, warm-started off the previous call's solved
// positions (see Phase 2c in mdsLayout) so already-revealed rounds settle
// into place instead of re-seeding from scratch on every keystroke. No new
// physics: this is purely a sequencing layer that decides WHEN to re-solve
// and WHAT to carry forward, Phase 3 (majorization) itself never changes.
export let autobuildOn        = false;
let autobuildRounds    = [];   // parsed.rounds prefix used for the last autobuild solve
let autobuildGraph     = null; // graph compiled from that prefix
let autobuildPos       = null; // solved positions for that graph
let autobuildDistanceCache = null; // {N, D, adjList} from that solve's mdsLayout Phase 1 - carried forward so the NEXT step's Phase 1 can skip re-running Dijkstra for every already-solved node (see mdsLayout's distanceCache param). Reset alongside autobuildGraph/autobuildPos whenever they reset, since a stale cache from an unrelated prefix would be a correctness hazard, not just a missed optimization.
let autobuildAbortCtrl = null;
let autobuildToken     = 0;    // bumped on every step so a stale in-flight solve can recognize it's been superseded and drop its result

function autobuildResetState() {
  autobuildRounds = [];
  autobuildGraph  = null;
  autobuildPos    = null;
  autobuildDistanceCache = null;
}

export function setAutobuild(on) {
  autobuildOn = on;
  autobuildBtn.textContent = `Autobuild: ${on ? 'on' : 'off'}`;
  autobuildBtn.classList.toggle('on', on);
  if (autobuildAbortCtrl) { autobuildAbortCtrl.abort(); autobuildAbortCtrl = null; }
  autobuildToken++;
  autobuildResetState();
  if (on) autobuildStep(parsePattern(patternLines, {library: loadPieceLibrary()})); // build against whatever's already typed, don't wait for the next keystroke - needs the library so any existing fuse: round resolves correctly
}

// Called after every validate() pass. Finds the longest leading run of
// error-free rounds and, if that's grown (or changed) since the last call,
// re-solves just that prefix and reveals it.
export async function autobuildStep(parsed) {
  if (!autobuildOn) return;

  let validPrefixLen = 0;
  while (validPrefixLen < parsed.rounds.length && !parsed.rounds[validPrefixLen].error) validPrefixLen++;

  if (validPrefixLen === 0) {
    if (autobuildGraph) {
      autobuildResetState();
      setLastSolve(null, null);
      invalidateFlattenedPosCache();
      disposeMesh(currentMesh);     setCurrentMesh(null);
      disposeMesh(currentRowGroup); setCurrentRowGroup(null);
      clearMarkers();
      setStatus('Autobuild: waiting for a valid first round...');
    }
    return;
  }

  const prefixRounds = parsed.rounds.slice(0, validPrefixLen);

  // Claim this step and abort whatever's in flight BEFORE any (possibly
  // async) solving below, not after - otherwise a fuse-bearing prefix
  // would let a stale in-flight solve keep running through the whole
  // pre-solve window, and a superseding edit that arrives during it would
  // have nothing to check against until solveGraph.
  if (autobuildAbortCtrl) { autobuildAbortCtrl.abort(); autobuildAbortCtrl = null; }
  const myToken = ++autobuildToken;

  // A clean append onto the last autobuild solve: the shared leading rounds
  // are content-identical to last time, so compileGraph assigns those
  // rounds' nodes the exact same ids it did before (node ids are just a
  // deterministic counter over the rounds array - see the Phase 2c comment
  // in mdsLayout), and a single warm-started solve of just the new part is
  // enough. If an earlier round was edited rather than just appended to -
  // or this is a paste, or the very first step after turning autobuild on
  // with content already typed - that guarantee is gone. For an ordinary
  // pattern a cold solve of the current prefix is still fine either way.
  // For a FUSE pattern it isn't (see solveFusedIncrementally) - a cold
  // solve of a large fused prefix can settle into a worse local minimum
  // than the same shape reached by building it up warm-started one round
  // at a time, which is exactly the gap between "typing builds cleanly"
  // and "pasting the same rows doesn't."
  const sharedLen = Math.min(autobuildRounds.length, prefixRounds.length);
  let cleanAppend = autobuildGraph != null;
  for (let i = 0; i < sharedLen && cleanAppend; i++) {
    if (JSON.stringify(autobuildRounds[i]) !== JSON.stringify(prefixRounds[i])) cleanAppend = false;
  }

  const ac = new AbortController();
  autobuildAbortCtrl = ac;
  const library = loadPieceLibrary();
  const newRoundCount = prefixRounds.length - (cleanAppend ? sharedLen : 0);

  try {
    let graph, pos, iters, nextDistanceCache = null;

    // Either this isn't a clean append at all (paste, first turn-on with
    // content already typed, or an edit to an earlier round), or it is one
    // but more than a single new round arrived at once (pasting more rows
    // onto an already-built autobuild piece) - either way, more than one
    // new round needs solving in a single step, which is the same cold-
    // solve-of-a-batch problem this whole function exists to avoid, just
    // sometimes starting from round 1 and sometimes resuming from
    // wherever autobuild already got to.
    if (roundsNeedIncrementalFuseSolve(prefixRounds) && newRoundCount > 1) {
      setStatus('Autobuild: solving fused piece...');
      const result = await solveFusedIncrementally(prefixRounds, library, {
        solveFusedFn: solveFusedPiecesCached,
        signal: ac.signal,
        onStep: (len, total) => setStatus(`Autobuild: solving round ${len} of ${total}...`),
        startGraph: cleanAppend ? autobuildGraph : null,
        startPos: cleanAppend ? autobuildPos : null,
        startLen: cleanAppend ? sharedLen : 0,
        startDistanceCache: cleanAppend ? autobuildDistanceCache : null,
      });
      if (myToken !== autobuildToken || !autobuildOn) return; // superseded by a newer edit, or turned off mid-solve
      graph = result.graph; pos = result.pos; iters = result.iters;
      nextDistanceCache = result.distanceCache || null;
    } else {
      let solvedLibrary = {};
      if (roundsNeedPieceLibrary(prefixRounds)) {
        try {
          setStatus('Autobuild: solving fused piece...');
          solvedLibrary = await solveFusedPiecesCached({rounds: prefixRounds}, library);
        } catch (e) {
          if (myToken !== autobuildToken) return; // superseded while solving
          setStatus('Autobuild: '+e.message, false);
          return;
        }
        if (myToken !== autobuildToken || !autobuildOn) return; // superseded, or turned off, during the pre-solve
      }

      graph = compileGraph({rounds: prefixRounds}, {library, solvedLibrary});
      if (graph.N === 0) return;

      let warmStartPos = null;
      if (cleanAppend && sharedLen > 0) {
        warmStartPos = new Map();
        for (let id = 0; id < autobuildGraph.N; id++) {
          const nd = autobuildGraph.nodeData[id];
          if (nd && nd.round < sharedLen) {
            warmStartPos.set(id, [autobuildPos[id*3], autobuildPos[id*3+1], autobuildPos[id*3+2]]);
          }
        }
      }

      // Same reasoning as run()'s fused iteration cap: a fused piece's new
      // trunk rows converge correctly but much more slowly around the two
      // rigid, hard-pinned legs, and 400 iterations isn't enough to reach
      // that.
      iters = (graph.fuseRoundLift && graph.fuseRoundLift.size) ? 6000 : 400;
      pos = await solveGraph(graph, { iterations: iters, warmStartPos, distanceCache: cleanAppend ? autobuildDistanceCache : null, signal: ac.signal });
      if (myToken !== autobuildToken || !autobuildOn) return; // superseded by a newer edit, or turned off mid-solve
      nextDistanceCache = pos.__distanceCache || null;
    }

    autobuildRounds = prefixRounds;
    autobuildGraph  = graph;
    autobuildPos    = pos;
    autobuildDistanceCache = nextDistanceCache;

    setLastSolve(graph, pos);
    invalidateFlattenedPosCache();
    clearMarkers();
    rebuildDisplay();
    restorePendingMarkers();
    orbit.fitTo(getFramingPos());
    setStatus(`Autobuild: ${validPrefixLen} round${validPrefixLen===1?'':'s'}, ${graph.N} nodes.`, true);
  } catch (e) {
    if (e.name !== 'AbortError') setStatus('Autobuild error: '+e.message, false);
  }
}

const autobuildBtn = document.getElementById('btn-autobuild');
if (autobuildBtn) {
  autobuildBtn.addEventListener('click', () => setAutobuild(!autobuildOn));
} else {
  console.warn('[autobuild] #btn-autobuild not found in the DOM - autobuild toggle button is inert.');
}