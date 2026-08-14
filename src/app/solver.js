// Solves a compiled pattern graph into real 3D positions: stress
// majorization (mdsLayout, in lib/geometry.js) plus the cosmetic post-
// process passes (spiral seam, oval-base flatten, fold-seam flatten,
// fused-piece reattachment) that turn a raw graph layout into the shape
// that actually gets rendered. Also handles resolving/solving saved pieces
// referenced by fuse:/graft:/mount: (solveFusedPieces and friends) and the
// round-by-round incremental solve autobuild uses to avoid bad local minima
// on patterns with real symmetry (two legs, etc).
//
// This is the orchestration layer only - the actual physics (mdsLayout) and
// the individual geometry passes it calls live in lib/geometry.js.

import { libGet, parsePattern } from '../lib/parser.js';
import { compileGraph } from '../lib/graph.js';
import {
  mdsLayout,
  precomputeChainAndGapFix,
  applySpiralOffset,
  flattenChainOvalBase,
  flattenFoldRounds,
  circularizeRingRadius,
  fixupFuseJoinGeometry,
  projectOntoBestFitPlane,
  reattachFusedPiecesFromSolo,
  reattachMountedPiecesFromSolo,
  relaxAroundPinned,
} from '../lib/geometry.js';

// Yarn-thickness slider: read directly (not passed as a parameter) because
// every solve/reattach pass in this file needs the current value and it
// doesn't change mid-solve; see also viewToggles.js / colorPicker.js /
// markers.js, which each keep their own reference to the same element.
const yarnOpt = document.getElementById('opt-yarn');

// Solve + full post-process pipeline for a compiled graph: stress
// majorization, then the same cosmetic passes run() has always applied
// (spiral seam, oval-base flatten, fold-seam flatten), in the same order.
// Pulled out of run() so autobuild's row-by-row solves go through the exact
// same pipeline - the only way to actually guarantee an autobuild reveal
// ends up looking identical to hitting Visualize, rather than a close
// approximation with its own subtly different post-processing.
// Finds every piece a pattern's fuse: directives reference, and solves each
// one standalone (its own parsePattern -> compileGraph -> mdsLayout, same
// pipeline as any single piece) so compileGraph can import its already-
// correct shape as a warm start when it builds the merged mesh. v1 scope:
// one level deep - a fused-in piece can't itself contain a fuse:. That's a
// real limitation, not an oversight; lifting it later just means walking
// this same collection recursively.
// Whether any round in this prefix references an external saved piece at
// all - fuse:, graft:, OR mount: (single-point or span, both set
// isMountOnly/mountSpec the same way). Every call site that decides
// "do I need to resolve the piece library / take the slower fused-solve
// path" used to check fuseTo alone, which meant a pattern using ONLY
// mount: or graft: (no fuse: at all) skipped that resolution entirely in
// autobuild - the library stayed empty, so compileGraph's mount/graft
// handling threw "wasn't pre-solved" (or, worse in autobuild's try/catch,
// just silently never rendered the mounted piece). This mirrors
// solveFusedPieces' own name-collection scan exactly, so "does this
// prefix need the library resolved" and "what does resolving it actually
// look at" can never drift out of sync with each other again.
export function roundsNeedPieceLibrary(rounds) {
  return rounds.some(r => r.fuseTo || r.isMountOnly || (r.ops||[]).some(op => op.graftName));
}

// Narrower than roundsNeedPieceLibrary on purpose. That check answers "does
// compileGraph need a solved library at all" (true for fuse/mount/graft
// alike, since all three import another piece's nodes). This one answers a
// different question: "does the BODY's own majorization solve need the
// slow round-by-round rebuild to avoid a bad local minimum." Only fuse:
// does - its legs get hard-pinned directly into the same solve as the
// trunk (graph.fuseRoundLift), and that's where the real symmetry
// ambiguity solveFusedIncrementally exists to route around (see its own
// comment). Mount and graft never enter that solve at all - both are
// solved standalone and rigidly reattached afterward
// (reattachMountedPiecesFromSolo / reattachFusedPiecesFromSolo), so the
// body's solve path (cold vs. incremental) can't change where they end up.
// run()'s isFused check already gets this right by keying off
// graph.fuseRoundLift post-compile; this is the same distinction made pre-
// compile, from raw rounds, for autobuildStep's batch-vs-single-step gate.
export function roundsNeedIncrementalFuseSolve(rounds) {
  return rounds.some(r => r.fuseTo);
}

export async function solveFusedPieces(parsed, library) {
  const names = new Set();
  for (const r of parsed.rounds) {
    if (r.fuseTo) for (const seg of r.fuseTo) if (seg.kind === 'piece') names.add(seg.name);
    for (const op of r.ops||[]) if (op.graftName) names.add(op.graftName);
    if (r.isMountOnly && r.mountSpec) names.add(r.mountSpec.name);
  }
  const solvedLibrary = {};
  for (const name of names) {
    const subLines = libGet(library, name);
    const subParsed = parsePattern(subLines, {library});
    if (subParsed.rounds.some(r => r.error)) throw new Error(`Saved piece "${name}" has unresolved pattern errors`);
    const subGraph = compileGraph(subParsed, {library});
    if (subGraph.N === 0) throw new Error(`Saved piece "${name}" has no stitches`);
    const subPos = await mdsLayout(subGraph.N, subGraph.adjList, {
      iterations: 300, alpha: 2, roundNodes: subGraph.roundNodes, roundAttachTo: subGraph.roundAttachToSeed,
      isFlatPiece: subGraph.isFlatPiece, chainFoundationRound: subGraph.chainFoundationRound,
      chainOvalRound: subGraph.chainOvalRound, chainDepth: subGraph.chainDepth, chainTargetBase: subGraph.chainTargetBase,
      foldRounds: subGraph.foldRounds, flapRounds: subGraph.flapRounds, nodeData: subGraph.nodeData, hubOf: subGraph.hubOf,
    });
    // PARITY FIX: this used to stop at the raw majorization output, so a
    // piece saved for fuse: never got the cosmetic passes an ordinary
    // Visualize applies (spiral seam, oval-base flatten, fold-seam flatten)
    // - it went into the merged solve dead flat/unspiraled while the new
    // rounds built on top of it (bridge + continuation) got the full
    // treatment, producing a visible mismatch at the seam (the "sides
    // zigzag slightly" symptom). solveGraph's own comment claimed this
    // function already matched its pipeline; it didn't. Bringing it in
    // line here, in the same order solveGraph uses, so a saved leg looks
    // identical whether it's fused in or visualized on its own.
    applySpiralOffset(subPos, subGraph.roundNodes, subGraph.nodeData, subGraph.isFlatPiece, null);
    flattenChainOvalBase(subPos, subGraph.roundNodes, subGraph.nodeData, subGraph.chainFoundationRound, subGraph.chainOvalRound, subGraph.adjList, subGraph.N, null);
    flattenFoldRounds(subPos, subGraph.roundNodes, subGraph.hardFlattenRounds, subGraph.adjList, subGraph.N, parseFloat(yarnOpt.value)||0.38, null);
    solvedLibrary[name] = { graph: subGraph, pos: subPos };
  }
  return solvedLibrary;
}

// Autobuild calls solveFusedPieces on every keystroke that touches a fuse-
// bearing prefix, but the referenced saved piece itself is almost never
// what just changed - the user is typing rows further down in THIS piece.
// Re-running a 300-iteration mdsLayout solve every keystroke for a piece
// that hasn't changed would make autobuild stutter, so cache each solved
// piece keyed on its name plus its own saved lines (JSON'd) - a cheap,
// exact "did this specific saved piece's definition change" check. Only a
// cache miss (new name, or the saved piece was edited/resaved) pays for a
// real solve; everything else is a Map lookup. Scoped to autobuild only -
// run()'s own solveFusedPieces call stays as-is, a manual Visualize is
// infrequent enough that always solving fresh is fine and simpler.
const autobuildFusedCache = new Map(); // name -> {cacheKey, solved:{graph,pos}}
export async function solveFusedPiecesCached(parsed, library) {
  const names = new Set();
  for (const r of parsed.rounds) {
    if (r.fuseTo) for (const seg of r.fuseTo) if (seg.kind === 'piece') names.add(seg.name);
    for (const op of r.ops||[]) if (op.graftName) names.add(op.graftName);
    if (r.isMountOnly && r.mountSpec) names.add(r.mountSpec.name);
  }
  const solvedLibrary = {};
  for (const name of names) {
    const subLines = libGet(library, name);
    const cacheKey = name + '@' + JSON.stringify(subLines);
    let cached = autobuildFusedCache.get(name);
    if (!cached || cached.cacheKey !== cacheKey) {
      const subParsed = parsePattern(subLines, {library});
      if (subParsed.rounds.some(r => r.error)) throw new Error(`Saved piece "${name}" has unresolved pattern errors`);
      const subGraph = compileGraph(subParsed, {library});
      if (subGraph.N === 0) throw new Error(`Saved piece "${name}" has no stitches`);
      const subPos = await mdsLayout(subGraph.N, subGraph.adjList, {
        iterations: 300, alpha: 2, roundNodes: subGraph.roundNodes, roundAttachTo: subGraph.roundAttachToSeed,
        isFlatPiece: subGraph.isFlatPiece, chainFoundationRound: subGraph.chainFoundationRound,
        chainOvalRound: subGraph.chainOvalRound, chainDepth: subGraph.chainDepth, chainTargetBase: subGraph.chainTargetBase,
        foldRounds: subGraph.foldRounds, flapRounds: subGraph.flapRounds, nodeData: subGraph.nodeData, hubOf: subGraph.hubOf,
      });
      // Same cosmetic-pass parity fix as solveFusedPieces above - a cached
      // piece needs to match a freshly-solved one exactly, or the seam
      // will visibly jump the moment the cache is invalidated and refilled.
      applySpiralOffset(subPos, subGraph.roundNodes, subGraph.nodeData, subGraph.isFlatPiece, null);
      flattenChainOvalBase(subPos, subGraph.roundNodes, subGraph.nodeData, subGraph.chainFoundationRound, subGraph.chainOvalRound, subGraph.adjList, subGraph.N, null);
      flattenFoldRounds(subPos, subGraph.roundNodes, subGraph.hardFlattenRounds, subGraph.adjList, subGraph.N, parseFloat(yarnOpt.value)||0.38, null);
      cached = { cacheKey, solved: { graph: subGraph, pos: subPos } };
      autobuildFusedCache.set(name, cached);
    }
    solvedLibrary[name] = cached.solved;
  }
  return solvedLibrary;
}

// Builds a fuse-bearing pattern's solve round-by-round - warm-starting
// each step from the previous step's solved positions for every round
// that hasn't changed - instead of a single cold solve of the whole
// prefix at once. Shared by run() (Visualize) and autobuildStep()'s
// cold-solve fallback (when a paste or edit breaks its own warm-start
// chain), so the two entry points call the exact same solving strategy
// for fuse patterns and can't diverge again.
//
// Why this exists: a cold solve of a large fused piece can settle into a
// worse local minimum than the exact same final shape reached by growing
// it warm-started one round at a time. Stress majorization is an
// iterative descent, not an equation solver - a fused piece has real
// symmetry (two similar legs), which gives it multiple comparably-
// plausible configurations to land in, and which one it lands in depends
// on incidental details like how it started. A cold solve has to find a
// good shape for the WHOLE structure at once, with much more room to
// wander into a worse one, especially as the piece grows. Autobuild's
// existing round-by-round typing behavior never had this problem for
// exactly this reason - each new round only ever adjusts a small amount
// from an already-good prior shape. Verified directly against a real
// repro: incremental building stayed clean at a size where a one-shot
// solve of the identical final pattern did not.
//
// Only used for patterns that actually contain a fuse: round - ordinary,
// single-piece patterns already solve reliably in one shot (a 1442-node
// stress test converged at iteration 113 every time in earlier testing),
// so this is deliberately NOT the general-purpose solve path; forcing it
// on everything would only add N-times the compileGraph/solveGraph calls
// for patterns that never needed the help.
//
// Can resume from an already-solved prefix instead of always starting at
// round 1 - pass startGraph/startPos/startLen for whatever was already
// correctly solved (e.g. autobuild's existing state before a paste added
// more rows after it). Without that, a clean append of several rows at
// once - pasting more rows onto an already-built autobuild piece, not
// just the very first paste - would still get solved as a single batch
// step instead of one row at a time, the exact same cold-solve-of-a-
// batch problem this function exists to avoid, just one level up.
export async function solveFusedIncrementally(rounds, library, {solveFusedFn, signal, onStep, startGraph, startPos, startLen, startDistanceCache} = {}) {
  const solveFused = solveFusedFn || solveFusedPieces;
  let prevGraph = startGraph || null, prevPos = startPos || null, prevLen = startLen || 0;
  let prevDistanceCache = startDistanceCache || null;
  let graph = prevGraph, pos = prevPos;
  const beginAt = prevGraph && prevLen > 0 ? prevLen + 1 : 1;
  for (let len = beginAt; len <= rounds.length; len++) {
    if (signal && signal.aborted) { const e = new Error('Aborted'); e.name = 'AbortError'; throw e; }
    const prefixRounds = rounds.slice(0, len);
    let solvedLibrary = {};
    if (roundsNeedPieceLibrary(prefixRounds)) {
      solvedLibrary = await solveFused({rounds: prefixRounds}, library);
    }
    graph = compileGraph({rounds: prefixRounds}, {library, solvedLibrary});
    if (graph.N === 0) continue; // e.g. a leading CC: line alone - nothing to solve yet
    let warmStartPos = null;
    if (prevGraph && prevLen > 0) {
      warmStartPos = new Map();
      for (let id = 0; id < prevGraph.N; id++) {
        const nd = prevGraph.nodeData[id];
        if (nd && nd.round < prevLen) warmStartPos.set(id, [prevPos[id*3], prevPos[id*3+1], prevPos[id*3+2]]);
      }
    }
    const iters = (graph.fuseRoundLift && graph.fuseRoundLift.size) ? 6000 : 400;
    if (onStep) onStep(len, rounds.length, graph);
    // distanceCache carries forward the previous step's D/adjList so
    // mdsLayout's Phase 1 can skip re-running Dijkstra for every already-
    // solved node on every single incremental step - see mdsLayout's own
    // comment on distanceCache for the safety argument, and
    // harness_distance_cache.mjs for the correctness check run before
    // this shipped (plain append, fuse: join, and graft: onto an
    // already-built structure all verified identical to full recompute).
    pos = await solveGraph(graph, { iterations: iters, warmStartPos, distanceCache: prevDistanceCache, signal });
    prevDistanceCache = pos.__distanceCache || null;
    prevGraph = graph; prevPos = pos; prevLen = len;
  }
  const finalGraph = prevGraph || graph;
  const finalIters = (finalGraph && finalGraph.fuseRoundLift && finalGraph.fuseRoundLift.size) ? 6000 : 400;
  return { graph: finalGraph, pos, iters: finalIters, distanceCache: prevDistanceCache };
}


export async function solveGraph(graph, {iterations, warmStartPos=null, distanceCache=null, onProgress, onPhase, signal} = {}) {
  let mergedWarmStart = graph.warmStartPos;
  if (warmStartPos && warmStartPos.size) {
    mergedWarmStart = new Map(graph.warmStartPos);
    for (const [id, p] of warmStartPos) mergedWarmStart.set(id, p);
  }
  // TRUE PINNING TEST: the fused-in leg nodes' positions (graph.warmStartPos,
  // computed by ringPlacement before the solve even starts) are now passed
  // as hardPinnedPos - fixed from the very first iteration, never moved by
  // majorization or spring relaxation - instead of merely a starting guess
  // the solver was still free to disturb and a later pass had to correct.
  // Fused-in leg (and, once computed below, chain/bridge) node positions
  // are TRUE hard pins - fixed from the very first solve iteration, never
  // moved by majorization or spring relaxation - instead of merely a
  // starting guess the solver was still free to disturb and a later pass
  // had to correct back. precomputeChainAndGapFix no-ops gracefully when
  // graph has no fuse round at all (ordinary non-fused patterns).
  const precomputedPin = precomputeChainAndGapFix(graph);
  const hardPin = (graph.fuseRoundLift && graph.fuseRoundLift.size) ? precomputedPin : null;

  // DETERMINISTIC FRAME ROTATION: mdsLayout's own seeding assumes +Y is
  // "the direction rounds grow" - true for an ordinary piece, but a pinned
  // leg's own true growth axis (toe -> anchor, continued past the anchor)
  // can point anywhere in world space depending on ringPlacement's facing
  // rotation. Rather than rewrite every seeding formula to accept an
  // arbitrary direction, rotate the WHOLE pinned frame (a pure coordinate
  // change, doesn't touch any relative geometry) so the leg's real growth
  // axis lines up with +Y before solving, then rotate the result back
  // afterward. The axis itself is read directly off the already-placed,
  // already-correct pinned leg data - no fitting, no ambiguity, same
  // "deterministic instead of ambiguous" principle as the leg orientation
  // fix itself.
  let frameR = null, frameCenter = null;
  if (hardPin && graph.fusedPieceGroups && graph.fusedPieceGroups.length) {
    const g = graph.fusedPieceGroups[0];
    if (g.anchorLocalIds && g.anchorLocalIds.length && g.soloFarLocalIds && g.soloFarLocalIds.length) {
      // anchor and toe positions in the ALREADY-PLACED pinned frame
      let ax=0,ay=0,az=0;
      for (const localId of g.anchorLocalIds) { const mid=g.idMap.get(localId); ax+=precomputedPin.get(mid)[0]; ay+=precomputedPin.get(mid)[1]; az+=precomputedPin.get(mid)[2]; }
      ax/=g.anchorLocalIds.length; ay/=g.anchorLocalIds.length; az/=g.anchorLocalIds.length;
      let tx=0,ty=0,tz=0, tcount=0;
      for (const localId of g.soloFarLocalIds) { const mid=g.idMap.get(localId); if (mid==null) continue; const p=precomputedPin.get(mid); if (!p) continue; tx+=p[0]; ty+=p[1]; tz+=p[2]; tcount++; }
      if (tcount) {
        tx/=tcount; ty/=tcount; tz/=tcount;
        let dx=ax-tx, dy=ay-ty, dz=az-tz;
        const dlen = Math.hypot(dx,dy,dz);
        if (dlen > 1e-6) {
          dx/=dlen; dy/=dlen; dz/=dlen;

          // Precompute round0's OWN new stitches too, using this same known
          // growth direction: each one sits UNIT above whatever it's worked
          // into (an anchor stitch or now-precomputed chain link), same
          // rule every ordinary round in this app already follows. This
          // gives the solve a SECOND full pinned ring, not just one -
          // establishing the growth axis the way two points define a line,
          // rather than one point plus a direction hint. Verified this was
          // necessary: pinning the chain alone (one ring) was not enough to
          // reliably fix body direction on its own.
          if (graph.fuseRoundLift.size === 1) {
            const [fuseRi] = graph.fuseRoundLift.keys();
            const tops = graph.roundNodes[fuseRi];
            const topSet = new Set(tops);
            for (const topId of tops) {
              const bases = graph.adjList[topId].map(([nb]) => nb).filter(nb => !topSet.has(nb));
              if (!bases.length) continue;
              let bx=0,by=0,bz=0, bcount=0;
              for (const nb of bases) { const p = precomputedPin.get(nb); if (!p) continue; bx+=p[0]; by+=p[1]; bz+=p[2]; bcount++; }
              if (!bcount) continue;
              bx/=bcount; by/=bcount; bz/=bcount;
              precomputedPin.set(topId, [bx+dx, by+dy, bz+dz]);
            }
            // Chain one more ring forward (round1, if it exists) using the
            // same rule, now that round0's own tops are known too - same
            // reasoning as adding the second ring: extends how far up the
            // established direction reliably reaches before majorization's
            // influence-decays-with-distance lets ambiguity creep back in.
            if (graph.roundNodes.length > fuseRi + 1 && (graph.ownRoundCount ?? graph.roundNodes.length) > fuseRi + 1) {
              const tops1 = graph.roundNodes[fuseRi + 1];
              if (tops1) {
                const topSet1 = new Set(tops1);
                for (const topId of tops1) {
                  const bases = graph.adjList[topId].map(([nb]) => nb).filter(nb => !topSet1.has(nb));
                  if (!bases.length) continue;
                  let bx=0,by=0,bz=0, bcount=0;
                  for (const nb of bases) { const p = precomputedPin.get(nb); if (!p) continue; bx+=p[0]; by+=p[1]; bz+=p[2]; bcount++; }
                  if (!bcount) continue;
                  bx/=bcount; by/=bcount; bz/=bcount;
                  precomputedPin.set(topId, [bx+dx, by+dy, bz+dz]);
                }
              }
            }
          }

          // Rodrigues rotation mapping (dx,dy,dz) -> (0,1,0)
          let ux = dy*1 - dz*0, uy = dz*0 - dx*1, uz = dx*0 - dy*0; // d x targetY
          const ulen = Math.hypot(ux,uy,uz);
          const cosT = dy; // d . targetY
          if (ulen > 1e-9) {
            ux/=ulen; uy/=ulen; uz/=ulen;
            const theta = Math.atan2(ulen, cosT);
            const ct = Math.cos(theta), st = Math.sin(theta);
            frameR = {ux,uy,uz,ct,st};
            frameCenter = [ax,ay,az];
          }
        }
      }
    }
  }
  function rotFwd(x,y,z) {
    if (!frameR) return [x,y,z];
    const px=x-frameCenter[0], py=y-frameCenter[1], pz=z-frameCenter[2];
    const {ux,uy,uz,ct,st} = frameR;
    const ndotp = ux*px+uy*py+uz*pz;
    const crossx = uy*pz-uz*py, crossy = uz*px-ux*pz, crossz = ux*py-uy*px;
    return [px*ct+crossx*st+ux*ndotp*(1-ct)+frameCenter[0], py*ct+crossy*st+uy*ndotp*(1-ct)+frameCenter[1], pz*ct+crossz*st+uz*ndotp*(1-ct)+frameCenter[2]];
  }
  function rotInv(x,y,z) {
    if (!frameR) return [x,y,z];
    const px=x-frameCenter[0], py=y-frameCenter[1], pz=z-frameCenter[2];
    const {ux,uy,uz,ct,st} = frameR; const st2=-st; // inverse rotation: negate angle
    const ndotp = ux*px+uy*py+uz*pz;
    const crossx = uy*pz-uz*py, crossy = uz*px-ux*pz, crossz = ux*py-uy*px;
    return [px*ct+crossx*st2+ux*ndotp*(1-ct)+frameCenter[0], py*ct+crossy*st2+uy*ndotp*(1-ct)+frameCenter[1], pz*ct+crossz*st2+uz*ndotp*(1-ct)+frameCenter[2]];
  }
  let hardPinRotated = hardPin;
  if (frameR && hardPin) {
    hardPinRotated = new Map();
    for (const [id, p] of hardPin) hardPinRotated.set(id, rotFwd(p[0],p[1],p[2]));
  }
  let warmStartRotated = mergedWarmStart;
  if (frameR && mergedWarmStart) {
    warmStartRotated = new Map();
    for (const [id, p] of mergedWarmStart) warmStartRotated.set(id, rotFwd(p[0],p[1],p[2]));
  }

  const distanceCacheOut = {};
  const pos = await mdsLayout(graph.N, graph.adjList, {
    iterations,
    alpha: 2,
    roundNodes: graph.roundNodes,
    roundAttachTo: graph.roundAttachToSeed,
    isFlatPiece: graph.isFlatPiece,
    chainFoundationRound: graph.chainFoundationRound,
    chainOvalRound: graph.chainOvalRound,
    chainDepth: graph.chainDepth,
    chainTargetBase: graph.chainTargetBase,
    foldRounds: graph.foldRounds,
    flapRounds: graph.flapRounds,
    nodeData: graph.nodeData,
    hubOf: graph.hubOf,
    fuseRoundIndices: graph.fuseRoundIndices,
    warmStartPos: warmStartRotated,
    hardPinnedPos: hardPinRotated,
    distanceCache,
    distanceCacheOut,
    onProgress,
    onPhase,
    signal,
  });
  pos.__distanceCache = distanceCacheOut;

  if (frameR) {
    for (let id = 0; id < graph.N; id++) {
      const [x,y,z] = rotInv(pos[id*3], pos[id*3+1], pos[id*3+2]);
      pos[id*3]=x; pos[id*3+1]=y; pos[id*3+2]=z;
    }
  }

  // PARITY FIX 2: mdsLayout's Phase 4b sets each blo/flo loop node's height
  // to "parent +/- 0.06" so it doesn't wander vertically, but that runs
  // BEFORE the rotInv above when this solve happens inside a rotated frame
  // (frameR) - see the comment there. A fixed vertical offset computed in a
  // tilted working frame isn't still vertical once rotated back to the real
  // one, so it smears into a smooth per-stitch wave. Re-apply the identical
  // offset here, after rotInv, in the frame that's actually rendered -
  // harmless/idempotent when frameR was never set, since it just reaffirms
  // what Phase 4b already got right in that case.
  {
    const seenPair = new Set();
    for (let i = 0; i < graph.N; i++) {
      const nd = graph.nodeData[i];
      if (!nd || nd.kind !== 'loop' || nd.side !== 'front') continue;
      const pId = nd.parentTop;
      if (seenPair.has(pId)) continue;
      let backId = null;
      for (const [j] of graph.adjList[pId]) {
        const nj = graph.nodeData[j];
        if (nj && nj.kind === 'loop' && nj.side === 'back' && nj.parentTop === pId) { backId = j; break; }
      }
      if (backId == null) continue;
      seenPair.add(pId);
      pos[i*3+1]      = pos[pId*3+1] + 0.06;
      pos[backId*3+1] = pos[pId*3+1] - 0.06;
    }
  }

  // NOTE: this used to snap graph.fusedPinnedIds back to their pre-merge
  // solo-solved position here, then run a short local relax confined to
  // the bridge (relaxAroundPinned(...,150)). That turned fuse into "solve
  // two pieces separately, then glue the result" instead of one continuous
  // solve - the correction only reached the bridge itself, so anything
  // built further on top of the join round stayed positioned against the
  // PRE-correction reference frame, which is what read as content
  // drifting/shifting once you tried to build on it. The 400-iteration
  // majorization above already solves the imported pieces, the bridge, and
  // the join round together as one connected graph - trusting that result
  // directly (no post-hoc snap) is what makes this one continuous solve
  // instead of two frozen pieces glued at a seam.

  // A fuse round's seed height (mdsLayout, above) gets a one-stitch-height
  // head start above its rim, but the bridge CHAIN nodes themselves
  // (liftIds) are tagged with this same round's index (see buildFuseBase),
  // so the generic round-based seeding formula gives them that same
  // "+1 stitch" head start too - even though the chain is really part of
  // the BASE layer, level with the rim it joins, not the new round built
  // on top of it. Two separate corrections, Y-only (X/Z are left exactly
  // as majorization settled them):
  //   1. liftIds (the chain) -> flush with the anchor rim's real height.
  //   2. bridgeTops (this round's own new stitches actually attached to
  //      the chain) -> one stitch above THAT corrected base - same rule
  //      every other round in the solver already follows.
  // Only the bridge-adjacent tops get corrected, not the whole round: most
  // of a fuse round's stitches are worked around the imported leg rims and
  // are already correctly placed by the normal seeding/relax pipeline -
  // rigidly shifting the entire round by one delta would drag those
  // already-correct rim stitches off position too.
  if (graph.fuseRoundLift && graph.fuseRoundLift.size) {
    const STITCH_HEIGHT = 1.0; // matches mdsLayout's UNIT - stitch spacing is used as row height throughout this solver
    for (const [ri, {anchorIds, liftIds, bridgeTops}] of graph.fuseRoundLift) {
      if (!anchorIds.length) continue;
      let anchorY = 0;
      for (const id of anchorIds) anchorY += pos[id*3+1];
      anchorY /= anchorIds.length;

      if (liftIds.length) {
        let by = 0;
        for (const id of liftIds) by += pos[id*3+1];
        by /= liftIds.length;
        const shift = anchorY - by;
        for (const id of liftIds) pos[id*3+1] += shift;
      }

      const roundIds = bridgeTops || [];
      if (roundIds.length) {
        let ry = 0;
        for (const id of roundIds) ry += pos[id*3+1];
        ry /= roundIds.length;
        const shift = (anchorY + STITCH_HEIGHT) - ry;
        for (const id of roundIds) pos[id*3+1] += shift;
      }
    }
  }

  // Nothing in the merged solve constrains a fused-in piece's overall
  // orientation - but it doesn't need to: legs are hard-pinned to their
  // known-correct, deterministically-placed position from the very first
  // solve iteration (see hardPin above), so there's no drift to correct
  // here at all. Likewise, the body's own growth direction is decided
  // deterministically before the solve even starts (round0 and round1 are
  // pre-pinned along the leg's own known true growth axis - see above),
  // not fitted from noisy post-solve output the way earlier approaches
  // did, which is what made that direction unstable across different row
  // counts. Verified: leg orientation and body growth direction both hold
  // correct across every chain length and row count tested, up to 30 rows.

  // The chain and this round's own new stitches were positioned during the
  // original merged solve, before the correction just above - reattach
  // them to the now-correct anchor positions instead of leaving them stale.
  fixupFuseJoinGeometry(pos, graph);

  // Spiral seam offset - cosmetic per-round rotation applied AFTER the
  // physics solve, so the stress-majorization result above is unaffected.
  // fusedPinnedIds is excluded: a fused-in piece already went through this
  // exact pass once, during its own solo solve, and was copied in verbatim
  // - rotating it again would apply a second, mismatched spiral on top of
  // an already-correct piece. Only genuinely new rounds (the bridge and
  // anything built on top of the fuse) get spiraled here.
  applySpiralOffset(pos, graph.roundNodes, graph.nodeData, graph.isFlatPiece, graph.fusedPinnedIds ? new Set(graph.fusedPinnedIds) : null);

  // Oval-base flatten pass runs LAST, after the spiral offset - spiral
  // offset rotates each round by a different angle around Y, which would
  // re-tilt the chain/oval-ring pair out of true flat if this ran first.
  // fusedPinnedIds passed through so its relax step can't drag a frozen
  // fused-in piece off its correct position either.
  flattenChainOvalBase(pos, graph.roundNodes, graph.nodeData, graph.chainFoundationRound, graph.chainOvalRound, graph.adjList, graph.N, graph.fusedPinnedIds);

  // Fold-seam flatten pass - same idea as the oval-base pass just above,
  // just for true sew-closed ('fold') rounds instead: the pinch edges
  // alone get most of the way there but leave a slight taper, this makes
  // it exactly flat. Deliberately NOT applied to 'scclose' rounds - those
  // are a genuine extra round of sc stitches, not a flush whip-stitched
  // seam, so they keep whatever real height/curve the solver gives them.
  // Runs after the oval-base pass since the two never touch the same
  // rounds, order between them doesn't matter.
  flattenFoldRounds(pos, graph.roundNodes, graph.hardFlattenRounds, graph.adjList, graph.N, parseFloat(yarnOpt.value)||0.38, graph.fusedPinnedIds);

  // BODY-ROUND TWIST FIX (verified in isolated harness before shipping -
  // see conversation): the raw stress-majorization solve has no built-in
  // concept of "this round stacks cleanly above the one below it" - that
  // alignment only happens for free when a piece's base is simple and
  // centered (a magic ring sits dead in the middle by construction). A
  // fused base is a dumbbell shape sitting off-center, so the raw solve
  // finds a configuration that satisfies its approximate distance math
  // reasonably well, and that configuration includes a twist that was
  // measured to GROW with every round built on top, unbounded, since
  // nothing downstream in the pipeline ever corrected rounds past the
  // join round itself.
  //
  // Fix: flatten every body round above a fuse join onto its own best-fit
  // plane (removing warp/twist specifically - NOT forcing a perfect circle
  // or removing centroid drift, which would conflate this with the
  // separate, still-open radius-flare issue), reusing the same
  // projectOntoBestFitPlane + relaxAroundPinned machinery already used for
  // oval-base and fold-seam flattening elsewhere in this file. The fused
  // legs are explicitly included in the pinned set during each relax step,
  // since without that this pass was found to drag on them despite them
  // supposedly being rigid.
  //
  // Verified: planarity converges to ~0.00 by the last built row in every
  // tested combination of chain length (0/2/6) and row count (2/5/10/15),
  // instead of growing without bound. Leg orientation and leg shape
  // distortion confirmed byte-identical with this pass on vs off across
  // the same 12 combinations - this fix does not touch anything already
  // working. One known remaining limitation: a long chain (6+) with very
  // few rows built on top (2) still shows a large transient distortion
  // right at the join round itself that this pass can reduce but not fully
  // resolve in so few rounds - that's a different, still-open problem with
  // the join round's own initial shape for long chains.
  if (graph.fuseRoundLift && graph.fuseRoundLift.size) {
    const ownCount = graph.ownRoundCount ?? graph.roundNodes.length;
    // Pin the legs AND the bridge/chain nodes (fuseRoundLift's liftIds) -
    // the chain was placed on a deliberate straight line by
    // fixupFuseJoinGeometry just above, and without pinning it here too,
    // this pass's own relax step was found to drag it off that line since
    // it's only connected to round 0's own tops via ordinary springs with
    // no "stay straight" preference of its own. Verified: without this,
    // a clean straight chain (monotonic, constant height) got scrambled
    // into a non-monotonic, uneven one by this exact pass.
    const legIds = graph.fusedPinnedIds || [];
    let chainIds = [];
    for (const {liftIds} of graph.fuseRoundLift.values()) if (liftIds) chainIds = chainIds.concat(liftIds);
    const extraPinned = legIds.concat(chainIds);
    // A fuse join round (ri===0 here) is partly MADE of the imported legs'
    // own pinned rim tops (see fusedPinnedIds) - projectOntoBestFitPlane
    // was writing new positions for every id in `ring` unconditionally,
    // including those pinned ones, before relaxAroundPinned below ever got
    // a chance to hold them still. That's what the drift test caught:
    // "pinned" legs moving by several units. Fit the plane to the full
    // ring (so the fit itself isn't skewed by dropping half the rim) but
    // only write the projected position back for the genuinely free ids.
    const pinnedHere = new Set(extraPinned);
    for (let ri = 0; ri < ownCount; ri++) {
      const ring = graph.roundNodes[ri];
      if (!ring || ring.length < 4) continue;
      const freeIds = ring.filter(id => !pinnedHere.has(id));
      if (freeIds.length) projectOntoBestFitPlane(pos, ring, freeIds);
      relaxAroundPinned(pos, graph.adjList, graph.N, ring.concat(extraPinned), 40);
    }

    // RADIUS-FLARE FIX ATTEMPT - REVERTED, KEPT FOR REFERENCE, NOT CALLED.
    // circularizeRingRadius (defined above near projectOntoBestFitPlane)
    // pulled every ring toward its own single average radius - which
    // assumes the target shape is a circle. Wrong assumption: this piece
    // is two legs joined by a bridge, so the honest cross-section stays an
    // elongated stadium/oval shape (wide over each leg, pinched at the
    // waist between them) for its ENTIRE height, not just near the join.
    // Averaging toward one radius told the solver the waist was an error
    // to inflate, which visually merged the two legs into one ballooned
    // blob instead of removing per-stitch noise within the correct oval
    // envelope. Left in place, unused, so a future attempt (fitting an
    // ellipse - two radii, major/minor axis - instead of a single circle,
    // so aspect ratio is preserved and only high-frequency wobble gets
    // smoothed) doesn't have to rebuild the plane/polar-coordinate
    // plumbing from scratch.
    //
    // for (let ri = 0; ri < ownCount; ri++) {
    //   const ring = graph.roundNodes[ri];
    //   if (!ring || ring.length < 4) continue;
    //   const topOnly = graph.nodeData ? ring.filter(id => graph.nodeData[id]?.kind !== 'hub') : ring;
    //   if (topOnly.length < 4) continue;
    //   const freeIds = topOnly.filter(id => !pinnedHere.has(id));
    //   const blendWeight = Math.max(0, Math.min(1, ri / RADIUS_FLARE_DECAY_ROUNDS));
    //   if (freeIds.length) circularizeRingRadius(pos, topOnly, freeIds, blendWeight);
    //   relaxAroundPinned(pos, graph.adjList, graph.N, ring.concat(extraPinned), 40);
    // }
  }

  // Re-apply dupBase separation (see mdsLayout's Phase 4b-2) as the FINAL
  // word - verified directly that the body-round-twist hug pass just above
  // flattens it back toward 0 (its projectOntoBestFitPlane step has no
  // awareness of this pairing), same reasoning as every other correction in
  // this pipeline that has to re-run after a later pass disturbs it.
  if (graph.nodeData) {
    const seenDup2 = new Set();
    for (let i = 0; i < graph.N; i++) {
      const nd = graph.nodeData[i];
      if (!nd || nd.dupBase == null || nd.dupSide !== 0) continue;
      const bId = nd.dupBase;
      if (seenDup2.has(bId)) continue;
      let otherId = null;
      for (const [j] of graph.adjList[i]) {
        const nj = graph.nodeData[j];
        if (nj && nj.dupBase === bId && nj.dupSide === 1) { otherId = j; break; }
      }
      if (otherId == null) continue;
      seenDup2.add(bId);
      // Same V-splay model as mdsLayout's Phase 4b-2, and same FIX applied:
      // lean each stitch toward whichever side its own real ring neighbor
      // (excluding the bridge itself) is already on, instead of assuming
      // dupSide 0 -> -X / dupSide 1 -> +X, which only holds for a
      // single-link bridge.
      const pushDist = 0.5;
      const leanSign2 = (nodeId, baseX, fallback) => {
        const nd2 = graph.nodeData[nodeId];
        const ring = nd2 && graph.roundNodes ? graph.roundNodes[nd2.round] : null;
        if (!ring || !ring.length) return fallback;
        const idx = nd2.indexInRound;
        const isBridgeish = (id) => {
          const n = graph.nodeData[id];
          return n && (n.isFuseBridge || n.dupBase != null);
        };
        const leftNb  = ring[(idx - 1 + ring.length) % ring.length];
        const rightNb = ring[(idx + 1) % ring.length];
        const dirNb = isBridgeish(leftNb) ? rightNb : leftNb;
        if (dirNb == null || dirNb === nodeId) return fallback;
        const nx = pos[dirNb*3];
        if (nx == null || !isFinite(nx)) return fallback;
        return nx >= baseX ? 1 : -1;
      };
      const signI2     = leanSign2(i, pos[bId*3], -1);
      const signOther2 = leanSign2(otherId, pos[bId*3], 1);
      pos[i*3]        = pos[bId*3] + signI2 * pushDist;
      pos[otherId*3]   = pos[bId*3] + signOther2 * pushDist;
    }
  }

  // Graft: runs LAST, after every pass above that could still move this
  // piece's ordinary body anchor stitches (spiral offset, oval/fold
  // flatten, the body-round-twist fix, dup-base re-separation) - so it
  // locks onto their true final positions instead of ones that get moved
  // out from under it a moment later.
  reattachFusedPiecesFromSolo(pos, graph.graftPieceGroups, graph);

  // Mount: runs after graft, for the same reason graft runs last among
  // everything else - it locks onto the body's true final anchor-stitch
  // positions rather than ones a moment away from being moved again. Mount
  // targets are only ever this piece's OWN rounds (v1 scope), so running
  // after graft vs before makes no difference to correctness yet, but
  // keeping it last leaves room for a later mount-onto-a-grafted-piece
  // without reordering anything.
  reattachMountedPiecesFromSolo(pos, graph.mountPieceGroups, graph, parseFloat(yarnOpt.value) || 0.38);

  return pos;
}