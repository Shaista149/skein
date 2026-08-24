// Graph compilation: turns a parsed pattern into a node/edge graph the
// solver can relax into 3D. Owns the stitch-lookup helpers.

import {
  STITCH_DEF, BOBBLE_LEG_RATIO, PUFF_LEG_RATIO,
  POPCORN_LEG_RATIO, POPCORN_RING_RATIO, POPCORN_GATHER_RATIO,
} from './constants.js';
import { bestFitNormal, rotateAxisOnto } from './geometry.js';
import { parsePattern, parseLine, resolveLibraryRound, computeDisplayNumbers } from './parser.js';

function getStitchDef(op) {
  if (op.op==='stitch') return STITCH_DEF[op.stitch]||STITCH_DEF.sc;
  if (['bobble','puff','popcorn'].includes(op.op)) {
    const base = STITCH_DEF[op.base||'dc']||STITCH_DEF.dc;
    return {...base, isBulge:true};
  }
  return STITCH_DEF.sc;
}

// GRAPH COMPILER
// Builds node/edge adjacency list for MDS
// Round type classifier
// Used for row-marker coloring and marker-tooltip labels only; has no effect
// on the physics graph or node positions.
function classifyRound(rnd, prevCount) {
  const ops = rnd.ops || [];
  if (rnd.isMR) return 'MR';
  if (rnd.isChr) return 'CHR';
  if (rnd.isFold) return 'fold';
  if (rnd.isScClose) return 'scclose';
  if (ops.some(o => o.color)) return 'cc';
  if (ops.some(o => ['bobble','puff','popcorn'].includes(o.op))) return 'bobble';
  if (ops.some(o => o.modifier === 'blo')) return 'blo';
  if (ops.some(o => o.modifier === 'flo')) return 'flo';
  if (ops.some(o => o.op==='stitch' && o.stitch==='slst')) return 'slst';
  if (ops.some(o => o.op==='stitch' && o.stitch==='tr')) return 'tr';
  if (ops.some(o => o.op==='stitch' && o.stitch==='dc')) return 'dc';
  if (ops.some(o => o.op==='stitch' && o.stitch==='hdc')) return 'hdc';
  if (prevCount == null) return 'flat';
  if (rnd.stitchCount > prevCount) return 'inc';
  if (rnd.stitchCount < prevCount) return 'dec';
  return 'flat';
}

export function compileGraph(pattern, opts) {
  const UNIT = 1.0; // sc width = sc height = 1 unit

  const nodeData = []; // {round, indexInRound, kind, color, stitch}
  const adjList = [];  // for each node: [[neighborId, edgeLen], ...]
  let nid = 0;

  function addNode(data) {
    const id = nid++;
    nodeData.push({id, ...data});
    adjList.push([]);
    return id;
  }

  function addEdge(a, b, len) {
    adjList[a].push([b, len]);
    adjList[b].push([a, len]);
  }

  // BLO / FLO: real front/back loop nodes
  // A crochet stitch top is really TWO loops sitting side by side (front and
  // back). Working "into both loops" (the default) attaches the next round
  // directly to the stitch top. Working BLO/FLO attaches only to one of the
  // two loops, leaving the other loop un-worked - which is what shows up as
  // a visible ridge on the surface. We model this literally: the first time
  // a stitch top is referenced with a modifier, we lazily create its two
  // loop nodes (edges to the top and to each other - long enough to clear
  // the main yarn tube's own radius, otherwise the unworked loop just gets
  // swallowed inside the ring tube it's sitting next to and is invisible),
  // and route the vertical edge
  // to the correct one. The unused loop stays connected only to its top and
  // sibling loop node, so the solver still gives it a stable position - it
  // just never grows a leg, so it reads as a bare ridge next to the worked
  // loop's leg. If no modifier is given, we attach straight to the shared
  // top as before (no extra nodes, no cost for patterns that don't use it).
  const loopPairCache = new Map(); // topId -> {front, back}
  function getAttachNode(topId, modifier) {
    if (modifier !== 'blo' && modifier !== 'flo') return topId;
    let pair = loopPairCache.get(topId);
    if (!pair) {
      const t = nodeData[topId];
      const front = addNode({round:t.round, indexInRound:t.indexInRound, kind:'loop', side:'front', color:t.color, parentTop:topId});
      const back  = addNode({round:t.round, indexInRound:t.indexInRound, kind:'loop', side:'back',  color:t.color, parentTop:topId});
      addEdge(topId, front, UNIT * 0.40);
      addEdge(topId, back,  UNIT * 0.40);
      addEdge(front, back,  UNIT * 0.50);
      pair = {front, back};
      loopPairCache.set(topId, pair);
    }
    return modifier === 'blo' ? pair.back : pair.front;
  }

  // Bobble / puff / popcorn: real per-leg physics nodes
  // See BOBBLE_LEG_RATIO / PUFF_LEG_RATIO / POPCORN_*_RATIO above for the
  // reasoning: each leg is a short chain of nodes whose combined length is
  // longer than the direct base->top edge, so the solver has to bow it
  // outward to satisfy both constraints - the fan shape emerges from the
  // solve, exactly like CrochetPARADE's dc5bobble / hdc3puff / dc3pc DEFs.
  function addBulgeStitch(bot, top, op, ri, idxInRound, color, h) {
    const N    = op.legs || (op.op==='puff' ? 3 : op.op==='popcorn' ? 4 : 5);
    const base = op.base || 'dc';

    if (op.op === 'popcorn') {
      const [r1, r2] = POPCORN_LEG_RATIO;
      const ringLen    = POPCORN_RING_RATIO * h;
      const gatherLen  = POPCORN_GATHER_RATIO * h;
      let prevFullTop = null, firstFullTop = null;
      for (let k = 0; k < N; k++) {
        const mid = addNode({round:ri, indexInRound:idxInRound, kind:'bulgeLeg', stage:1, color, stitch:op.op, base, legIndex:k, legs:N, topId:top, botId:bot});
        const fullTop = addNode({round:ri, indexInRound:idxInRound, kind:'bulgeLeg', stage:2, color, stitch:op.op, base, legIndex:k, legs:N, topId:top, botId:bot});
        addEdge(bot, mid, r1 * h);
        addEdge(mid, fullTop, r2 * h);
        addEdge(fullTop, top, gatherLen); // draws this leg's finished top in close to the closing point
        if (prevFullTop != null) addEdge(prevFullTop, fullTop, ringLen); // collar between adjacent leg tops
        else firstFullTop = fullTop;
        prevFullTop = fullTop;
      }
      if (N > 2 && prevFullTop != null) addEdge(prevFullTop, firstFullTop, ringLen); // close the collar
      return;
    }

    // bobble / puff: open fan of 2-segment bowed legs converging at the top
    const table = (op.op === 'puff') ? PUFF_LEG_RATIO : BOBBLE_LEG_RATIO;
    const [r1, r2, r3] = table[base] || table.dc || BOBBLE_LEG_RATIO.dc;
    for (let k = 0; k < N; k++) {
      const mid1 = addNode({round:ri, indexInRound:idxInRound, kind:'bulgeLeg', stage:1, color, stitch:op.op, base, legIndex:k, legs:N, topId:top, botId:bot});
      const mid2 = addNode({round:ri, indexInRound:idxInRound, kind:'bulgeLeg', stage:2, color, stitch:op.op, base, legIndex:k, legs:N, topId:top, botId:bot});
      addEdge(bot, mid1, r1 * h);
      addEdge(mid1, mid2, r2 * h);
      addEdge(mid2, top, r3 * h);
    }
  }

  const rnds = [];
  const patternToRndIdx = new Map(); // pattern.rounds index -> rnds/roundNodes index, for attach:rN lookups
  // Same display numbering the editor gutter shows (see computeDisplayNumbers)
  // re-indexed onto rnds/roundNodes position, so 3D tooltips agree with the
  // gutter - including a fuse round's continued numbering, which isn't just
  // "ri+1" the way a plain piece's numbering is.
  const { displayNums: patternDisplayNums } = computeDisplayNumbers(pattern.rounds);
  const ownRoundDisplayNums = [];
  const followedByPullClosed = []; // parallel to rnds - true only if an explicit 'pull closed'
                            // directive appears before any other real round of stitches. This
                            // is the ONE notation that actually says "gather this round's live
                            // stitches shut" - used below so a round only gets treated as a
                            // cinched closing cap when the pattern has actually asked for that,
                            // not inferred just because the round happens to decrease or happens
                            // to be the last one typed so far. Fires the same way regardless of
                            // whether the round decreased first - real yarn can be gathered
                            // closed from any stitch count, 'fo' itself never draws anything.
  pattern.rounds.forEach((r, pIdx) => {
    if (!r.isFO && !r.isPullClosed && !r.isTurn && !r.isColorOnly && r.stitchCount > 0) {
      patternToRndIdx.set(pIdx, rnds.length);
      ownRoundDisplayNums[rnds.length] = patternDisplayNums[pIdx];
      rnds.push(r);
      let followed = false;
      for (let j = pIdx + 1; j < pattern.rounds.length; j++) {
        const nr = pattern.rounds[j];
        if (nr.isPullClosed) { followed = true; break; }
        if (!nr.isTurn && !nr.isColorOnly && !nr.isMountOnly && !nr.isFO) break; // hit another real round before any 'pull closed' - not gathered shut here
      }
      followedByPullClosed.push(followed);
    }
  });
  if (rnds.length === 0) return {N:0, adjList:[], nodeData:[], roundNodes:[], roundTypes:[]};

  const roundNodes     = []; // roundNodes[ri]     = array of node ids
  const roundBobblesList = [[]]; // roundBobblesList[ri] = bobble angular fractions
  const roundTypes = []; // roundTypes[ri] = classified type string, for markers/tooltips

  // A piece starting from a foundation chain (ch:N) is normally FLAT - open
  // rows worked back and forth with turns, sewn into shape by hand
  // afterward - not a tube of closed rings grown from a magic ring. BUT a
  // chain can also be worked IN THE ROUND (an oval base: snout, sole, body
  // base) - real crochet works up the chain's front loops, turns at the
  // tip, then back down the back loops, closing into one ring instead of
  // staying open. rnds[1].isChainInRound (detected in parsePattern, purely
  // from stitch-count math and whether 'turn' appears anywhere - no new
  // notation) tells us which one this piece actually is. This flag decides
  // whether rounds from here on get a wraparound closing edge or stay open,
  // and whether layout seeds them on a circle or along a straight line.
  const r0 = rnds[0];
  const isChainWorkedInRound = !!(r0.isChainFoundation && rnds[1] && rnds[1].isChainInRound);
  const isFlatPiece = !!r0.isChainFoundation && !isChainWorkedInRound;

  // A piece can now start from a fuse: directive instead of MR/ch: - real
  // crochet legs-into-body has no foundation of its own at all, its very
  // first round is already someone else's live stitches plus bridging
  // chains. When that's the case, round 0 doesn't get the special
  // self-contained MR/chain treatment below at all - it's built by the
  // exact same generic round-building code every other round uses (see the
  // main loop just below), just starting at ri=0 instead of ri=1, because
  // a fuse round genuinely has a real "prev" to consume, same as any round.
  const library = (opts && opts.library) || {};
  const solvedLibrary = (opts && opts.solvedLibrary) || {};
  const warmStartPos = new Map(); // nodeId -> [x,y,z], for nodes imported from an already-solved saved piece via fuse:
  const fusedPinnedIds = []; // every node id imported via fuse: - these get frozen back to their rigid placement after the merged solve, see solveGraph

  if (!r0.fuseTo) {
    // Round 0 - the foundation chain itself is ALWAYS a plain open line of N
    // linked chain nodes (never a wraparound ring - a chain isn't a loop by
    // itself), regardless of whether the piece stays flat or closes into
    // rings starting from round 1. The doubling that makes an oval base
    // happen is round 1's job (see the chainInRound branch in the main round
    // loop below), not round 0's.
    let row0 = [];
    for (let i = 0; i < r0.stitchCount; i++) {
      row0.push(addNode({round:0, indexInRound:i, kind:'top', color:r0.startColor||r0.color||'default', stitch:'sc'}));
    }
    if (r0.isChainFoundation) {
      // Foundation chain: an open line of linked chain stitches, no
      // wraparound - the two ends of the chain are NOT next to each other.
      for (let i = 0; i < row0.length - 1; i++) {
        addEdge(row0[i], row0[i+1], UNIT);
      }
    } else {
      // Lateral ring edges in round 0
      for (let i = 0; i < row0.length; i++) {
        addEdge(row0[i], row0[(i+1)%row0.length], UNIT);
      }
    }
    roundTypes.push(classifyRound(r0, null));
    roundNodes.push(row0);
    var row0Ref = row0; // referenced just below for the hub check, outside this block's scope
  }

  // Hub nodes: a real center point for a magic ring or a decrease-to-
  // -a-point ending
  // A magic ring in real crochet is every stitch base pulled snug around
  // one shared point - the tail cinches them all together. That's a real
  // physical point, not a rendering trick, so give it a real graph node:
  // one hub per ring, wired with an actual edge to every stitch on that
  // ring. Stress majorization then pulls it into place exactly like any
  // other node, and the existing leg-tube renderer draws the spokes -
  // no separate disc, no faked texture coordinates, nothing preset-
  // specific. spokeLen is derived from the ring's own circumference
  // (n stitches, UNIT apart, so radius = n·UNIT/2π) rather than a fixed
  // constant, so it scales correctly for any stitch count.
  const hubOf = new Map(); // round index -> hub node id
  function addHub(ri, ring, color) {
    const hub = addNode({round: ri, kind:'hub', color: color||'default'});
    const n = ring.length;
    const spokeLen = (n * UNIT) / (2 * Math.PI);
    for (const nodeId of ring) addEdge(hub, nodeId, spokeLen);
    return hub;
  }
  if (!r0.fuseTo && r0.isMR) {
    hubOf.set(0, addHub(0, row0Ref, r0.startColor||r0.color));
  }

  // Process subsequent rounds (or, for a fuse-founded piece, ALL rounds -
  // the loop below starts at 0 instead of 1 in that case, see startRi).
  const roundAttachTo = r0.fuseTo ? [] : [null]; // round 0 (MR) never attaches elsewhere; a fuse round pushes its own entry via the loop below
  const mrRoundIndices = (!r0.fuseTo && r0.isMR) ? [0] : [];
  // Tracks how many rounds deep into a reattached branch we are (0 = the
  // round with the actual attach:rN directive, 1 = the round after it, etc)
  // and which round each branch forked from. A continuation round's raw
  // sequential position (ri) can be numerically far from where its branch
  // actually lives (e.g. it forked from round 3, but is the 11th line in
  // the pattern) - chainTargetBase + chainDepth gives its TRUE position
  // in the branch instead, which is what the seeding step below needs.
  const chainDepth = r0.fuseTo ? [] : [null];
  const chainTargetBase = r0.fuseTo ? [] : [null];
  const roundDecreased = r0.fuseTo ? [] : [false]; // round 0 never "decreases" - it's the start
  const graftGroups = new Map(); // graftInstanceId -> {name, anchorMergedIds:[], ringIds:[]} - keyed per OCCURRENCE, not per name, so two graft:ear tokens (e.g. one per leg) produce two independent groups instead of merging into one
  const fuseRoundIndices = new Set(); // round indices founded on fuse: - populated below (loop covers round 0 too when r0.fuseTo) - see mdsLayout seeding
  const fuseRoundLift = new Map(); // roundIndex -> {anchorIds, liftIds} - see solveGraph's post-relax height correction
  const fuseRoundSegments = new Map(); // roundIndex -> boundary indices (see buildMesh) - assumes the round's own stitches are plain 1:1 (no inc/dec ON the fuse round itself, which is the common case: shaping happens on rounds built on top, not the join round) so prev-space boundaries line up with this round's own currRow indices directly
  const flapRoundSet = new Set(); // indices (into roundNodes/rnds) of rounds that only claim
                                   // part of their base (rnd.isFlap - see parsePattern) - open
                                   // arcs, not closed rings, so mdsLayout seeds them as a
                                   // straight line same as a flat-piece row instead of a circle.
  const foldRoundSet = new Set(); // indices (into roundNodes/rnds) of 'fold' AND 'scclose' rounds -
                                   // both are open seam rows, not closed rings, closed by their own
                                   // seam structure rather than the fan-hub closing-cap logic below.
                                   // Kept as one set since every consumer here (seeding, hub-skip,
                                   // "closed" flag for row markers/mesh) treats the two identically -
                                   // only the run()-time hard-flatten pass needs to tell them apart
                                   // (see sewClosedRoundSet just below).
  const sewClosedRoundSet = new Set(); // indices of TRUE 'fold' (sew-closed/whip-stitch) rounds only -
                                        // these get hard-pressed flush in flattenFoldRounds. 'scclose'
                                        // rounds are a real extra round of sc stitches and keep
                                        // whatever height the solver naturally gives them.

  // Fuse: import an already-solved saved piece's full node/edge graph
  // wholesale into THIS graph, carrying its solved local shape over as a
  // warm-start hint (not a hard transform - the merged solve is free to
  // move it, this just spares it from starting flattened at the origin).
  // Imported once per name per compile even if referenced by more than one
  // fuse: segment. Registration into roundNodes/hubOf/etc (needed for
  // rendering + so the imported rounds get a round-aware seed too) happens
  // in one batch after the main loop, appended at the end - this keeps
  // every index this piece's OWN rounds use (patternToRndIdx, attach:
  // targets, ...) exactly as if fuse didn't exist at all, zero risk to the
  // single-piece path.
  const fuseImportCache = new Map(); // name -> import info
  const importedPieceInfos = [];
  const fusedPieceGroups = [];
  // transform is {rotatedPos: Float64Array (same length as solved.pos, already
  // rotated+translated into final placement)} - computed once by ringPlacement
  // below, which knows both the rotation (to face the piece's anchor stitch
  // toward its neighbor) and the translation (to sit it beside that neighbor
  // without overlapping).
  function importSolvedPiece(name, transform) {
    const cacheKey = name + '@' + transform.cacheKey;
    if (fuseImportCache.has(cacheKey)) return fuseImportCache.get(cacheKey);
    const solved = solvedLibrary[name];
    if (!solved) throw new Error(`fuse: "${name}" wasn't pre-solved before compiling this piece`);
    const sub = solved.graph;
    const idMap = new Map();
    for (let i = 0; i < sub.nodeData.length; i++) {
      const {id:_drop, ...rest} = sub.nodeData[i];
      const newId = addNode(rest); // round gets corrected to its real position once registered, just below
      idMap.set(i, newId);
      warmStartPos.set(newId, [transform.rotatedPos[i*3], transform.rotatedPos[i*3+1], transform.rotatedPos[i*3+2]]);
      fusedPinnedIds.push(newId);
    }
    for (let i = 0; i < sub.adjList.length; i++) {
      for (const [nb, len] of sub.adjList[i]) {
        if (nb > i) addEdge(idMap.get(i), idMap.get(nb), len);
      }
    }
    for (let i = 0; i < sub.nodeData.length; i++) {
      const nd = nodeData[idMap.get(i)];
      if (nd.topId != null) nd.topId = idMap.get(nd.topId);
      if (nd.botId != null) nd.botId = idMap.get(nd.botId);
      if (nd.parentTop != null) nd.parentTop = idMap.get(nd.parentTop);
      // fanBase was missed here - a fan stitch's anchor id was left pointing
      // at its ORIGINAL local id from the solo-solved piece instead of the
      // freshly-imported node. That local id happens to also exist in
      // THIS graph (every piece starts numbering from small ids), just as
      // some unrelated node belonging to whichever piece got imported
      // first - so leg2's ruffle fans silently anchored themselves to
      // leg1's nodes instead of leg2's own, collapsing the two ruffles
      // onto exactly the same position (see Phase 2b aux-node seeding).
      if (nd.fanBase != null) nd.fanBase = idMap.get(nd.fanBase);
    }
    const info = {
      name, idMap,
      roundIdMaps: sub.roundNodes.map(ring => ring.map(localId => idMap.get(localId))),
      hubOf: sub.hubOf, roundTypes: sub.roundTypes, roundBobbles: sub.roundBobbles,
      mrRoundIndices: sub.mrRoundIndices || [], foldRounds: sub.foldRounds, flapRounds: sub.flapRounds, hardFlattenRounds: sub.hardFlattenRounds,
      roundAttachTo: sub.roundAttachTo || [],
    };
    fuseImportCache.set(cacheKey, info);
    importedPieceInfos.push(info);
    return info;
  }

  // A piece being fused in is already a fully-solved, correct shape - the
  // LAST thing it needs is stress majorization on the merged graph nudging
  // its own stitches around too. What it needs is a real starting place
  // next to whatever it's fusing alongside, not left wherever its own solo
  // solve happened to put it (which, for two legs made from the same saved
  // pattern, is the SAME spot - hence the overlap).
  //
  // Placement is TWO things, not one: a translation (side by side along X,
  // sized off each piece's own footprint so nothing overlaps - unchanged
  // from before) AND a rotation, which is the piece missing until now. The
  // seam edges in buildFuseBase only ever connect ONE specific stitch on
  // each piece (the round's own first/last stitch, where it starts/closes)
  // to the bridge - a translate-only placement leaves that stitch facing
  // whatever arbitrary direction the piece's solo solve happened to leave
  // it in, which is almost never "toward the neighboring piece". When it
  // isn't, majorization has no way to satisfy that seam's short (2-chain)
  // edge length except by stretching the bridge itself across however much
  // of the piece's full diameter separates the two actual anchor points -
  // exactly the long stretched "handle" artifact this fixes. Rotating each
  // piece around its OWN connecting round's normal (its natural tube axis)
  // so the anchor stitch points at its neighbor costs nothing structurally
  // (rotation about a piece's own axis doesn't distort it) and means the
  // bridge only ever has to span the small real gap it was written to span.
  let ringCursorX = 0;
  // The gap between two fused pieces should reflect how long the bridge
  // between them actually is - a ch6 bridge needs to span more real
  // distance than a ch2 one, and a direct 0-chain join should sit close to
  // touching, not the same fixed gap regardless. Each chain stitch is
  // roughly one UNIT of physical length; +0.3 UNIT is just enough margin
  // that a 0-chain direct join still gets a small real gap instead of
  // exactly zero (which risks coincident seed points). This is still only
  // a SEED - majorization is free to adjust from here.
  function ringPlacement(name, validIndex, faceDir, chainLen) {
    const gap = (chainLen||0) * UNIT + UNIT * 0.3;
    const solved = solvedLibrary[name];
    const ids = solved.graph.roundNodes[validIndex];

    // LEAN FIX: a solo-solved piece's own stress-majorization result is
    // almost never perfectly axisymmetric - increases, bobbles, and uneven
    // stitch counts all pull it very slightly off true vertical, so some
    // small residual lean is baked into every solo shape. The faceDir
    // rotation below only spins the piece about the CONNECTING ROUND's own
    // normal - it can't correct a lean that isn't already aligned with that
    // axis. Left uncorrected, two copies of the EXACT SAME piece - one
    // rotated to face +X, the other rotated ~180 degrees further to face
    // -X - carry that identical baked-in lean off in two different absolute
    // directions once placed side by side, which is exactly what read as
    // one leg looking straight and the other showing a visible diagonal
    // lean even though both started identical. Fix: straighten the piece's
    // own growth axis (traced through its round centroids, not any single
    // round's shape) onto true vertical FIRST, on a private clone of the
    // solved positions (never the shared solvedLibrary copy - other fuse:
    // segments may reference the same piece with a different placement),
    // so the faceDir rotation afterward only ever has to spin an
    // already-straight piece.
    const workPos = new Float64Array(solved.pos);
    {
      // CORRECTED LEAN FIX (v1 straightened onto a separately-fit whole-body
      // PCA axis - verified in an isolated Node harness to actually make the
      // two copies' tilt MAGNITUDES diverge further, not converge, because
      // that axis doesn't generally coincide with the connecting ring's own
      // normal n, so the theta spin below - which rotates around n, not
      // around the PCA axis - still drags the residual misalignment by a
      // different amount for each copy's own theta. Straightening onto n
      // ITSELF (the exact axis theta spins around) fixes this structurally:
      // spinning around an axis can never change that same axis's own
      // alignment, so once n is exactly vertical, theta - whatever value it
      // ends up being for a given faceDir - can only rotate the piece's
      // residual bend around Y, never tilt it further off Y. Verified: two
      // copies of the same piece (facing +X and -X) now land within 0.01
      // degrees of the same tilt MAGNITUDE (a true mirror image through the
      // seam, not a mismatched lean) across chain lengths 0/2/6 and across
      // two genuinely different pieces, not just identical ones.
      const pre = bestFitNormal(workPos, ids);
      let axisDir = [pre.nx, pre.ny, pre.nz];
      // Sign-correct: n should point from round 0 (the piece's own start)
      // toward the connecting round, not the arbitrary sign the eigensolve
      // happens to return.
      const round0 = solved.graph.roundNodes[0];
      let r0x=0, r0y=0, r0z=0;
      for (const id of round0) { r0x+=workPos[id*3]; r0y+=workPos[id*3+1]; r0z+=workPos[id*3+2]; }
      r0x/=round0.length; r0y/=round0.length; r0z/=round0.length;
      const gx=pre.cx-r0x, gy=pre.cy-r0y, gz=pre.cz-r0z;
      if (axisDir[0]*gx+axisDir[1]*gy+axisDir[2]*gz < 0) {
        axisDir = [-axisDir[0], -axisDir[1], -axisDir[2]];
      }
      rotateAxisOnto(workPos, [pre.cx, pre.cy, pre.cz], axisDir, [0, 1, 0]);
    }

    const {cx, cy, cz, nx, ny, nz} = bestFitNormal(workPos, ids);

    // Rotation angle: bring the anchor stitch (this round's own first node -
    // see buildFuseBase, that's the one every seam edge actually attaches
    // to) from wherever it naturally sits around the ring to face faceDir,
    // rotating about the ring's own normal so the piece's real shape is
    // never touched, only spun in place.
    let theta = 0;
    if (faceDir) {
      const anchorId = ids[0];
      const fdot = faceDir[0]*nx + faceDir[1]*ny + faceDir[2]*nz;
      let tx = faceDir[0]-fdot*nx, ty = faceDir[1]-fdot*ny, tz = faceDir[2]-fdot*nz;
      const tlen = Math.hypot(tx,ty,tz) || 1; tx/=tlen; ty/=tlen; tz/=tlen;
      let vx = workPos[anchorId*3]-cx, vy = workPos[anchorId*3+1]-cy, vz = workPos[anchorId*3+2]-cz;
      const vdot = vx*nx+vy*ny+vz*nz;
      vx -= vdot*nx; vy -= vdot*ny; vz -= vdot*nz;
      const vlen = Math.hypot(vx,vy,vz) || 1; vx/=vlen; vy/=vlen; vz/=vlen;
      const crossX = vy*tz - vz*ty, crossY = vz*tx - vx*tz, crossZ = vx*ty - vy*tx;
      const sinTheta = crossX*nx + crossY*ny + crossZ*nz;
      const cosTheta = vx*tx + vy*ty + vz*tz;
      theta = Math.atan2(sinTheta, cosTheta);
    }
    const ct = Math.cos(theta), st = Math.sin(theta);

    // Rotate every node (Rodrigues' formula about axis n through the ring's
    // own centroid), producing the piece's final-facing shape before we
    // measure it for placement - so the footprint radius below reflects the
    // ROTATED piece, not the pre-rotation one (rotating about the ring's own
    // roughly-vertical axis doesn't change this radius in practice, but
    // measuring after rotation rather than assuming so keeps this correct
    // even when a piece's connecting round isn't perfectly upright).
    const N = solved.graph.N;
    const rotatedPos = new Float64Array(N*3);
    for (let i = 0; i < N; i++) {
      const px = workPos[i*3]-cx, py = workPos[i*3+1]-cy, pz = workPos[i*3+2]-cz;
      if (theta === 0) {
        rotatedPos[i*3]=px+cx; rotatedPos[i*3+1]=py+cy; rotatedPos[i*3+2]=pz+cz;
      } else {
        const ndotp = nx*px+ny*py+nz*pz;
        const crossx = ny*pz-nz*py, crossy = nz*px-nx*pz, crossz = nx*py-ny*px;
        rotatedPos[i*3]   = px*ct + crossx*st + nx*ndotp*(1-ct) + cx;
        rotatedPos[i*3+1] = py*ct + crossy*st + ny*ndotp*(1-ct) + cy;
        rotatedPos[i*3+2] = pz*ct + crossz*st + nz*ndotp*(1-ct) + cz;
      }
    }

    // Spacing is measured off the CONNECTING ROUND's own radius only, not
    // the whole piece's footprint. A wider part elsewhere on the piece (a
    // ruffle, a flared base) has nothing to do with this join - the bridge
    // only spans the actual seam, so the seam is what should sit close.
    // Real crochet works the same way: two amigurumi legs joined by a short
    // 2-chain sit with their TOP openings snug together; whatever's below
    // (a ruffle, the rest of the leg) just follows along, however close or
    // loosely-touching that ends up looking - it was never the thing being
    // measured for the join in the first place.
    let rcx=0, rcy=0, rcz=0;
    for (const id of ids) { rcx+=rotatedPos[id*3]; rcy+=rotatedPos[id*3+1]; rcz+=rotatedPos[id*3+2]; }
    rcx/=ids.length; rcy/=ids.length; rcz/=ids.length;
    let radius = 0;
    for (const id of ids) {
      const dx=rotatedPos[id*3]-rcx, dz=rotatedPos[id*3+2]-rcz;
      radius = Math.max(radius, Math.sqrt(dx*dx+dz*dz));
    }
    const ox = ringCursorX + radius - rcx, oy = -rcy, oz = -rcz;
    ringCursorX += 2*radius + gap;
    for (let i = 0; i < N; i++) {
      rotatedPos[i*3] += ox; rotatedPos[i*3+1] += oy; rotatedPos[i*3+2] += oz;
    }
    return { rotatedPos, cacheKey: `${validIndex}|${theta.toFixed(4)}|${ox.toFixed(3)},${oy.toFixed(3)},${oz.toFixed(3)}` };
  }

  // Builds this round's composite base ring out of fuse: segments - other
  // pieces' live last (or explicit) round, plus fresh bridging chain
  // stitches - in the order they're written, closing the ring at the seams
  // BETWEEN segments only (each segment's own internal ring/lateral edges
  // already exist, imported or built as part of the segment itself).
  function buildFuseBase(segments, ri, color) {
    const ring = [];
    const boundaries = []; // index into `ring` where each new segment starts
    const bridgeNodes = new Map(); // bridgeName -> its node ids, scoped to this one round's base
    // Which piece segments need which facing: the first piece segment in
    // the line faces +X (toward whatever comes next), the last faces -X
    // (toward whatever came before) - exactly right for the common 2-piece
    // case (leg + bridge + leg). A single lone piece segment has no
    // neighbor to face, so it isn't rotated at all. Three or more piece
    // segments in one fuse round is a real limitation for now: only the
    // first and last get a facing rotation, middle ones are left as-is.
    //
    // Which physical piece ends up in which slot (left vs right) is
    // decided earlier, at parse time, by swapping the PIECE segments'
    // positions in the spec array itself (see parseLine's fuse-spec
    // handling) - the placement/facing logic here is plain left-to-right
    // in array order and doesn't need to know or care about that swap.
    // An earlier version tried to do the swap here instead (walking
    // pieceSegs in reverse for cursor placement while flipping faceDir)
    // and that rotated each piece a full 180deg in place rather than just
    // relocating it, since faceDir controls a piece's own orientation, not
    // just which slot it lands in.
    const pieceSegs = segments.filter(s => s.kind === 'piece');
    const totalChainLen = segments.filter(s => s.kind === 'chain').reduce((a,s) => a + s.n, 0);
    const chainGroups = []; // {nodes, leftAnchor, rightAnchor, segIndex} - one entry per independent chain segment, so each can be pinned along its own straight line instead of all chains being conflated into a single line
    const pieceTransform = new Map(); // piece segment -> {info, transform}
    for (const seg of pieceSegs) {
      const rank = pieceSegs.indexOf(seg);
      let faceDir = null;
      if (pieceSegs.length >= 2) {
        if (rank === 0) faceDir = [1, 0, 0];
        else if (rank === pieceSegs.length - 1) faceDir = [-1, 0, 0];
      }
      const transform = ringPlacement(seg.name, seg.validIndex, faceDir, totalChainLen);
      const info = importSolvedPiece(seg.name, transform);
      pieceTransform.set(seg, {info, transform});
    }

    for (let si = 0; si < segments.length; si++) {
      const seg = segments[si];
      boundaries.push(ring.length);
      if (seg.kind === 'chain') {
        const leftAnchor = ring.length > 0 ? ring[ring.length - 1] : null;
        const nodes = [];
        let prevNode = null;
        // Walk this chain's color runs (sub-spans written between
        // CC:color tokens inside the fuse spec, e.g. "ch3+CC:coral+ch3")
        // instead of a single uniform color - a run with no color of its
        // own (nothing set CC: before it) just falls back to this round's
        // overall color, same as a plain undivided chain always did.
        const runs = seg.colorRuns && seg.colorRuns.length ? seg.colorRuns : [{n: seg.n, color: null}];
        let runIdx = 0, runRemaining = runs[0].n, stitchColor = runs[0].color || color;
        for (let k = 0; k < seg.n; k++) {
          while (runRemaining <= 0 && runIdx < runs.length - 1) {
            runIdx++;
            runRemaining = runs[runIdx].n;
            stitchColor = runs[runIdx].color || color;
          }
          const cn = addNode({round:ri, indexInRound:ring.length, kind:'top', color: stitchColor, stitch:'ch', isFuseBridge:true});
          if (prevNode != null) addEdge(prevNode, cn, UNIT);
          prevNode = cn;
          nodes.push(cn);
          ring.push(cn);
          runRemaining--;
        }
        bridgeNodes.set(seg.bridgeName, nodes);
        chainGroups.push({nodes, leftAnchor, segIndex: si});
      } else if (seg.kind === 'chainRef') {
        // Same physical chain stitches as the earlier declaration, not a
        // new pair - crossing it here means each of those stitches is
        // about to get a second stitch worked into it (see the round-
        // building loop below, which just connects one new top per ring
        // slot regardless of whether the id repeats - exactly an inc).
        // REVERSED: the chain was built once in one direction (link0,
        // link1, ..., linkN-1 - from this segment's near side toward its
        // far side). Reusing it here closes the ring back the OTHER way -
        // physically the same links, but traversed in the opposite
        // direction. Pushing them in the same forward order made the ring
        // visit link0-then-link1 on the way out AND link0-then-link1
        // again on the way back, instead of link1-then-link0 on the way
        // back - a real topological crossing (each link's two visits
        // ended up ~N ring-positions apart with the ring's own sequential
        // edges never running between them cleanly), not just a bad seed
        // position. Reversing here makes the return pass a genuine
        // hairpin turn instead of a repeat lap.
        const revNodes = bridgeNodes.get(seg.bridgeName).slice().reverse();
        for (const id of revNodes) ring.push(id);
      } else {
        const {info, transform} = pieceTransform.get(seg);
        const targetRing = info.roundIdMaps[seg.validIndex];
        for (const id of targetRing) ring.push(id);
        if (!info.registeredForStraighten) {
          info.registeredForStraighten = true;
          const solved = solvedLibrary[seg.name];
          fusedPieceGroups.push({
            idMap: info.idMap, // local (solo-solved) id -> merged id, every node of this piece
            soloPos: transform.rotatedPos, // ringPlacement's already-correctly-facing copy, NOT raw solo pos - fitting from here only needs a small corrective rotation, sidestepping the flip ambiguity a large arbitrary-orientation fit is prone to
            anchorLocalIds: solved.graph.roundNodes[seg.validIndex], // local ids of the fused round, in order
            anchorMergedIds: info.roundIdMaps[seg.validIndex], // same round's merged ids, same order - point i is the same physical stitch in both
            soloFarLocalIds: solved.graph.roundNodes[0], // the piece's opposite end (round 0) - used only to sanity-check which way the fit ended up facing
          });
        }
      }
    }
    // Seam edges between consecutive segments, and the closing seam from
    // the last segment back to the first - the only edges genuinely
    // missing, since everything WITHIN a segment is already wired.
    for (let s = 0; s < boundaries.length; s++) {
      const endIdx = (s+1 < boundaries.length) ? boundaries[s+1] - 1 : ring.length - 1;
      const nextStartIdx = (s+1 < boundaries.length) ? boundaries[s+1] : 0;
      addEdge(ring[endIdx], ring[nextStartIdx], UNIT);
    }
    // Now that the whole ring (and its wraparound) is known, resolve each
    // chain group's rightAnchor (and leftAnchor, for the edge case of a
    // chain being segment 0, whose "left" neighbor is the wraparound tail).
    for (const g of chainGroups) {
      const segStart = boundaries[g.segIndex];
      if (g.leftAnchor == null) g.leftAnchor = ring[(segStart - 1 + ring.length) % ring.length];
      g.rightAnchor = ring[(segStart + g.nodes.length) % ring.length];
    }
    ring.segmentBoundaries = boundaries; // see fuseRoundSegments below - lets the renderer split the tube per segment instead of sweeping one smooth curve through a figure-8's sharp reversal
    ring.chainGroups = chainGroups;
    return ring;
  }

  for (let ri = (r0.fuseTo ? 0 : 1); ri < rnds.length; ri++) {
    const rnd = rnds[ri];
    roundAttachTo.push(rnd.attachTo ? (patternToRndIdx.get(rnd.attachTo.round) ?? null) : null);
    if (rnd.attachTo) {
      chainDepth.push(0);
      chainTargetBase.push(patternToRndIdx.get(rnd.attachTo.round) ?? null);
    } else if (rnd.fuseTo) {
      // A fuse round has no chainDepth/chainTargetBase of its own - it
      // isn't reattaching to an earlier round of THIS piece, it's growing
      // on top of other pieces entirely. But it is NOT a fresh root the
      // way MR is either: ringPlacement has already recentered whichever
      // rim it references to exactly Y=0, so it needs seeding one stitch-
      // height above that fixed, known base - see fuseRoundIndices, used
      // by mdsLayout's seeding step below instead of the generic
      // sequential-height fallback.
      chainDepth.push(null);
      chainTargetBase.push(null);
      fuseRoundIndices.add(ri);
    } else if (ri > 0 && chainDepth[ri-1] != null) {
      chainDepth.push(chainDepth[ri-1] + 1);
      chainTargetBase.push(chainTargetBase[ri-1]);
    } else {
      chainDepth.push(null);
      chainTargetBase.push(null);
    }

    // Normally a round attaches to the round immediately before it. A round
    // with an attach directive (attach:rN-flo/blo) instead attaches to an
    // EARLIER round's un-worked loop nodes - e.g. coming back with a new
    // color to work into the front loops a flo round left open several
    // rounds ago. getAttachNode lazily creates that round's loop pair if it
    // doesn't exist yet (it doesn't care whether the target round used a
    // modifier itself when IT was created - the split is independent of that).
    let prev;
    if (rnd.fuseTo) {
      prev = buildFuseBase(rnd.fuseTo, ri, rnd.startColor || rnd.color || 'default');
      // Record this round's true fixed anchor (the frozen rim stitches it
      // was worked into) separately from its own new material (bridge
      // chain stitches, also part of `prev` but themselves unpinned).
      // solveGraph uses this after the physics solve to lift the round
      // (bridge + its own new tops) a fixed height above the anchor's
      // real, frozen position - neither majorization nor relaxAroundPinned
      // have any built-in preference for "up" over "sideways" at a fuse
      // join, so the height has to be restored explicitly, once, as the
      // last word on this round's Y - see solveGraph.
      const pinnedSet = new Set(fusedPinnedIds);
      const anchorIds = prev.filter(id => pinnedSet.has(id));
      const liftIds = [...new Set(prev.filter(id => !pinnedSet.has(id)))];
      fuseRoundLift.set(ri, {anchorIds, liftIds, chainGroups: prev.chainGroups});
      // Only safe to reuse prev-space boundaries as currRow-space boundaries
      // when every op in this round is a plain 1:1 stitch (see the note on
      // fuseRoundSegments above) - inc/dec/fan on the join round itself
      // would desync prevCursor from currCursor and point the render split
      // at the wrong indices, so skip it rather than guess wrong.
      const fuseOpsAllPlain = rnd.ops.every(o => !['inc','dec','fan'].includes(o.stitch));
      if (fuseOpsAllPlain && prev.segmentBoundaries && prev.segmentBoundaries.length > 1) {
        fuseRoundSegments.set(ri, prev.segmentBoundaries);
      }
    } else if (rnd.attachTo) {
      const targetRndIdx = patternToRndIdx.get(rnd.attachTo.round);
      // Should already be caught by parsePattern's validation, but guard
      // here too in case the target round produced no stitch tops (e.g.
      // was itself an isFO/isTurn line that slipped through).
      const targetRing = (targetRndIdx != null) ? roundNodes[targetRndIdx] : null;
      prev = targetRing ? targetRing.map(topId => getAttachNode(topId, rnd.attachTo.loop)) : roundNodes[ri-1];
    } else if (rnd.isChainInRound) {
      // Chain worked IN THE ROUND (oval base): round 0 is a foundation
      // chain of N physical links, each with its own front and back loop -
      // real crochet works up the front loops, turns at the tip, then back
      // down the back loops, so THIS round's actual base is the combined
      // perimeter of both loops (length up to 2N), not the bare chain
      // nodes themselves. Same front/back loop-splitting machinery BLO/FLO
      // already uses elsewhere - a chain link genuinely has two loops,
      // same as a stitch top does.
      const chainNodes = roundNodes[ri-1];
      const n = chainNodes.length;
      const perimeter = [];
      for (let i = 0; i < n; i++) perimeter.push(getAttachNode(chainNodes[i], 'flo'));
      for (let i = n - 1; i >= 0; i--) perimeter.push(getAttachNode(chainNodes[i], 'blo'));
      // Ring edges around the combined perimeter - UNIT apart, EXCEPT the
      // two seams where a single chain link's own front and back loop meet
      // (the tip turn, and the closing seam back to the start). Those are
      // already wired by getAttachNode itself at the correct short
      // same-stitch distance the first time a chain link's pair is
      // created - adding a second, longer edge on top would just fight it.
      for (let i = 0; i < perimeter.length; i++) {
        const j = (i + 1) % perimeter.length;
        if (i === n - 1 || i === perimeter.length - 1) continue; // the two seams
        addEdge(perimeter[i], perimeter[j], UNIT);
      }
      prev = perimeter;
    } else {
      // Default: this round continues the main body from wherever it last
      // left off. That's normally just ri-1, but an attach:rN round is a
      // side branch off an EARLIER round, not a new link in the trunk - if
      // one or more attach rounds sit immediately before this one, walk
      // back past all of them to the real last trunk round, same rule
      // parsePattern's lastStitchRoundIdx already applies at parse time.
      let trunkRi = ri - 1;
      while (trunkRi > 0 && rnds[trunkRi].attachTo) trunkRi--;
      prev = roundNodes[trunkRi];
    }
    const prevCount = prev.length;
    roundDecreased.push(rnd.stitchCount < prevCount);

    // Fold: crease the ring flat, sc mirrored pairs together
    // Handled as its own special case (like MR/chainFoundation elsewhere)
    // instead of going through the generic per-op vertical-edge builder
    // below, because it isn't a sequential cursor-consumption pattern -
    // it pairs stitch i with its MIRROR opposite (n-1-i), not its neighbor.
    // The fold axis runs BETWEEN two pairs of stitches on opposite sides of
    // the ring (never through a stitch), so every one of the ring's n nodes
    // has an exact mirror partner - none are left sitting unpaired on the
    // crease. Every pair gets one new seam node, sc'd to both of its two
    // bases, with a short direct edge between those two bases pulling the
    // (former) two sides of the tube together - that's what makes the
    // solver actually flatten it, the same generic "let a short edge pull
    // two points together" trick 'dec' already uses, just applied across
    // the ring instead of between neighbors. Two exceptions: the pairs
    // closest to EACH end of the fold axis - ring[0]/ring[n-1] at one gap,
    // ring[half-1]/ring[half] at the other - are already directly linked by
    // the ring's own real edges (see the currRow closing-edge loop
    // elsewhere) at full UNIT length. Adding a second, shorter pinch edge
    // between either of those same two nodes would fight its real edge
    // instead of complementing it, buckling both corners even before any
    // flatten pass runs. So those two pairs rely on their existing ring
    // edges alone; every pair strictly between them still gets its own
    // pinch edge as usual.
    if (rnd.isFold || rnd.isScClose) {
      const ring = prev;
      const n = ring.length;
      const half = n / 2;
      const foldColor = rnd.color || nodeData[ring[0]]?.color || 'default';
      const foldRow = [];
      for (let i = 0; i < half; i++) {
        const bot1 = ring[i];
        const bot2 = ring[n - 1 - i];
        const seam = addNode({round:ri, indexInRound:i, kind:'top', color:foldColor, stitch:'sc', isFoldSeam: rnd.isFold, isScCloseSeam: rnd.isScClose});
        addEdge(bot1, seam, UNIT);
        addEdge(bot2, seam, UNIT);
        // Every pair gets the pinch edge, including the two pairs closest to
        // each fold gap. Those two ARE also linked by the ring's own real
        // UNIT-length edge, but measuring the actual solved geometry showed
        // that edge alone does NOT pull them close - they settled a full
        // stitch-width apart (wider than any other pair) once their
        // dedicated pinch edge was removed, which produced a splayed-open,
        // twisted-looking corner instead of a flat fold. A second edge on
        // the same pair doesn't "fight" and buckle it the way it might seem
        // - the solver just averages the two rest lengths, same as any
        // other pair with competing constraints - so there's no reason to
        // special-case these two pairs.
        addEdge(bot1, bot2, UNIT * 0.3); // pulls the two paired layers toward each other
        foldRow.push(seam);
      }
      // The seam itself: a straight open line of new seam stitches, one
      // stitch apart, same as any other open row's lateral edges. Unlike
      // the through-stitch version, both ends are new seam nodes too (no
      // reused ring node caps it), since the fold axis never lands on an
      // existing stitch.
      for (let i = 0; i < foldRow.length - 1; i++) addEdge(foldRow[i], foldRow[i+1], UNIT);

      roundNodes.push(foldRow);
      roundTypes.push(rnd.isFold ? 'fold' : 'scclose');
      roundBobblesList.push([]);
      foldRoundSet.add(ri);
      if (rnd.isFold) sewClosedRoundSet.add(ri); // only true sew-closed rounds get hard-flattened
      continue;
    }

    // Create tops for this round. Colors are seeded to this round's START
    // color (before any mid-round cc: token); the ops loop just below
    // overwrites individual node colors as it walks through cc: tokens,
    // so a round like "6sc, cc:red, 6sc" produces two differently-colored
    // halves instead of one flat round-wide color.
    const currRow = [];
    roundTypes.push(classifyRound(rnd, prevCount));
    const roundStartColor = rnd.startColor || rnd.color || 'default';
    for (let i = 0; i < rnd.stitchCount; i++) {
      currRow.push(addNode({round:ri, indexInRound:i, kind:'top', color:roundStartColor, stitch:'sc'}));
    }
    roundNodes.push(currRow);

    // Lateral edges within this round - closed ring for a tube, open line
    // (no wraparound) for a flat piece worked back and forth, or for a
    // round that only claims part of its base (isFlap - see parsePattern)
    // and so is a straight arc rather than a ring that meets itself again.
    const lastIdx = (isFlatPiece || rnd.isFlap) ? currRow.length - 1 : currRow.length;
    for (let i = 0; i < lastIdx; i++) {
      addEdge(currRow[i], currRow[(i+1)%currRow.length], UNIT);
    }
    if (rnd.isFlap && !isFlatPiece) flapRoundSet.add(ri);

    // Every real piece has exactly one MR: (see parsePattern - a second MR:
    // anywhere else in the same pattern is now rejected at parse time, a
    // separate piece belongs in its own component, joined with mount:/
    // fuse: instead). This just gives round 0's ring its real hub node.
    if (rnd.isMR) {
      hubOf.set(ri, addHub(ri, currRow, roundStartColor));
      mrRoundIndices.push(ri);
    }

    const roundBobblePositions = []; // angular fraction [0,1] of each bobble in this round

    // Vertical edges from ops
    const ops = rnd.ops.filter(o => !['cc','turn','join','fo','mr'].includes(o.op));
    let prevCursor = 0;
    let currCursor = 0;
    // A fuse round's bridge stitches get worked into twice (chainRef re-
    // crossing the same chain nodes) - the only way a *plain* 1:1 stitch
    // can hit the same `prev` id twice in one round, since a normal
    // previous round's own ids are always freshly-created and unique.
    // Tracks bot-id -> the first top that consumed it, so the second visit
    // can add the same short cohesion edge inc/dec/fan already get for
    // sharing a base - see the "Normal stitch: 1:1" branch below.
    const basesSeenThisRound = new Map();
    // Tracks the active color as we walk through this round's ops in
    // order - a mid-round "cc:xxx" token (see parseLine) updates an op's
    // own `.color`, and every op from that point on in the SAME round
    // carries that color forward until the next cc: token or round end.
    // This lets one round genuinely contain two (or more) colors, instead
    // of the round-wide flat color every node used to get stamped with.
    let runningColor = roundStartColor;

    for (const op of ops) {
      if (op.color) runningColor = op.color;
      const def = getStitchDef(op);
      const h = (def.height||1.0) * UNIT;
      const count = op.count||1;

      if (op.op==='sk') {
        prevCursor += count;
        continue;
      }
      if (op.op==='stitch' && op.stitch==='slst') {
        // slst: connects but doesn't consume a 'slot' in the pattern
        for (let k = 0; k < count; k++) {
          const bot = getAttachNode(prev[prevCursor % prevCount], op.modifier);
          const top = currRow[currCursor % currRow.length];
          nodeData[top].color = runningColor;
          addEdge(bot, top, UNIT * 0.1);
          prevCursor++;
          currCursor++;
        }
        continue;
      }
      if (op.op==='stitch' && op.stitch==='inc') {
        for (let k = 0; k < count; k++) {
          const bot = getAttachNode(prev[prevCursor % prevCount], op.modifier);
          const top1 = currRow[currCursor % currRow.length];
          const top2 = currRow[(currCursor+1) % currRow.length];
          nodeData[top1].color = runningColor;
          nodeData[top2].color = runningColor;
          addEdge(bot, top1, h);
          addEdge(bot, top2, h);
          // inc creates a tight V: tops are close to each other
          addEdge(top1, top2, UNIT * 0.6);
          prevCursor++;
          currCursor += 2;
        }
      } else if (op.op==='stitch' && op.stitch==='fan') {
        const n = op.fanCount || 3;
        const fanDef = STITCH_DEF[op.base||'hdc'] || STITCH_DEF.hdc;
        const fanH = (fanDef.height||1.0) * UNIT;
        for (let k = 0; k < count; k++) {
          const bot = getAttachNode(prev[prevCursor % prevCount], op.modifier);
          const tops = [];
          for (let f = 0; f < n; f++) {
            const t = currRow[(currCursor+f) % currRow.length];
            nodeData[t].color = runningColor;
            addEdge(bot, t, fanH);
            tops.push(t);
            // Tag so mdsLayout can seed these apart - siblings from the same
            // base are graph-symmetric (same edges to the base and to each
            // other) and would otherwise start and stay perfectly coincident.
            nodeData[t].fanBase  = bot;
            nodeData[t].fanIndex = f;
            nodeData[t].fanN     = n;
            nodeData[t].fanH     = fanH; // real height of THIS stitch type, not a flat constant
          }
          // Fan stitches worked into the same base sit close together, same
          // idea as inc's tight V, just with more legs sharing one root. This
          // is an OPEN fan (like umbrella ribs splayed from one point) - only
          // adjacent siblings get a short cohesion edge. Closing the last
          // sibling back to the first (as an earlier version did) turns the
          // fan into a closed triangle/polygon instead, which yanks its two
          // outermost legs - the ones that should end up FARTHEST apart in
          // the open spread - into a short, tight edge. That false chord is
          // what forced every fan group to pinch and fold back on itself,
          // producing a tangled, kinked strip instead of a smooth ruffle.
          for (let f = 0; f < tops.length - 1; f++) {
            addEdge(tops[f], tops[f+1], UNIT * 0.5);
          }
          prevCursor++;
          currCursor += n;
        }
      } else if (op.op==='stitch' && op.stitch==='dec') {
        for (let k = 0; k < count; k++) {
          const bot1 = getAttachNode(prev[prevCursor % prevCount], op.modifier);
          const bot2 = getAttachNode(prev[(prevCursor+1) % prevCount], op.modifier);
          const top = currRow[currCursor % currRow.length];
          nodeData[top].color = runningColor;
          addEdge(bot1, top, h);
          addEdge(bot2, top, h);
          // dec gathers two bases: short edge between them
          addEdge(bot1, bot2, UNIT * 0.5);
          prevCursor += 2;
          currCursor++;
        }
      } else {
        // Normal stitch: 1:1
        for (let k = 0; k < count; k++) {
          const bot = getAttachNode(prev[prevCursor % prevCount], op.modifier);
          const top = currRow[currCursor % currRow.length];
          nodeData[top].color = runningColor;
          addEdge(bot, top, h);

          // graft: this stitch also doubles as one of the shared points
          // where a separately-solved, already-closed piece gets rigidly
          // glued on afterward. Order matters: these ids are later paired
          // index-for-index against the named piece's own closing-seam
          // round, in that round's own natural order.
          if (op.graftName) {
            if (!graftGroups.has(op.graftInstanceId)) graftGroups.set(op.graftInstanceId, {name: op.graftName, angleOverride: op.graftAngle, anchorMergedIds:[], ringIds:currRow});
            graftGroups.get(op.graftInstanceId).anchorMergedIds.push(top);
          }

          // See basesSeenThisRound above: a fuse round's two bridge chain
          // stitches are each worked into once going out, once coming back
          // - two separate NEW tops sharing one base, exactly the shape
          // inc already gives a short cohesion edge (UNIT*0.6 below). Without
          // it, the two tops are only linked 2 hops apart via the shared
          // base rather than directly, which is precisely the missing
          // "pinch" a figure-8 needs right at its crossing point.
          if (basesSeenThisRound.has(bot)) {
            const firstTop = basesSeenThisRound.get(bot);
            addEdge(firstTop, top, UNIT * 0.6);
            // SEED-BREAKING FIX (verified in isolated harness before
            // shipping): these two tops have IDENTICAL topology (same
            // base, same cohesion edge to each other, same lateral ring
            // neighbors on their own sides) - stress majorization treats
            // exactly-coincident points as already agreeing, so without an
            // explicit seed offset (same category of issue fan siblings
            // and bulge legs already get in mdsLayout's Phase 2b) these two
            // genuinely distinct stitches were found to converge onto the
            // exact same 3D point instead of sitting side by side. Tag both
            // with dupBase/dupSide so mdsLayout can seed them apart.
            nodeData[firstTop].dupBase = bot;
            nodeData[firstTop].dupSide = 0;
            nodeData[top].dupBase = bot;
            nodeData[top].dupSide = 1;
          } else {
            basesSeenThisRound.set(bot, top);
          }

          // Bobble/puff/popcorn: real per-leg physics nodes (see addBulgeStitch)
          if (def.isBulge) {
            addBulgeStitch(bot, top, op, ri, currCursor, runningColor, h);
            roundBobblePositions.push(currCursor / rnd.stitchCount);
          }

          prevCursor++;
          currCursor++;
        }
      }
    }
    roundBobblesList.push(roundBobblePositions);

    // Most of a fuse round's own new stitches (currRow) are worked around
    // the imported leg rims and don't need any special handling - only the
    // handful actually attached to the bridge chain (liftIds) need the
    // extra height correction in solveGraph, since majorization has no
    // built-in "up" preference at a join. Find them by real adjacency
    // (every top is already wired to the exact base node it's worked
    // into), not by assuming a fixed stitch count.
    if (rnd.fuseTo) {
      const lift = fuseRoundLift.get(ri);
      if (lift) {
        const liftSet = new Set(lift.liftIds);
        lift.bridgeTops = currRow.filter(id => adjList[id].some(([nb]) => liftSet.has(nb)));
      }
    }
  }

  // Closing caps (pull-closed point)
  // Mirror of mrRoundIndices, but for the OTHER end of a piece: a round
  // that nothing else attaches to (no round continues from it, sequentially
  // or via attach:rN), AND that was explicitly gathered shut with a 'pull
  // closed' directive (see followedByPullClosed above) - the tail threaded
  // through every live stitch and drawn tight, same technique real crochet
  // uses to close an amigurumi tip or seal a stuffed opening. This now
  // fires regardless of whether the round decreased first - gathering is an
  // explicit action the pattern asked for, not something inferred from
  // stitch math, so a wide flat round can be pulled closed too (it'll
  // pucker, same as real yarn would). A round with no continuation and no
  // 'pull closed' (e.g. a flat-topped cylinder end, or a live edge meant to
  // be sewn/left open) is deliberately left uncapped - capping it would be
  // inventing closure the pattern never asked for. 'fo' alone never draws
  // anything, it's just the tail being cut.
  const continuedFrom = new Set();
  for (let rj = 1; rj < rnds.length; rj++) {
    if (rnds[rj].isMR || rnds[rj].isChr) continue; // defensive only - parsePattern now rejects
                                  // any MR:/chr: that isn't round 0, so this
                                  // can't actually be hit for rj>=1 anymore,
                                  // left in case that ever changes
    continuedFrom.add(roundAttachTo[rj] != null ? roundAttachTo[rj] : rj - 1);
  }
  const closingRoundIndices = [];
  if (!isFlatPiece) {
    for (let ri = 0; ri < rnds.length; ri++) {
      if (continuedFrom.has(ri)) continue;       // something else builds on top of it
      if (mrRoundIndices.includes(ri)) continue; // a lone MR round already has its own hub
      if (rnds[ri].isChr) continue;              // a chr foundation ring has no hub and isn't a gather-to-a-point tip
      if (foldRoundSet.has(ri)) continue;        // fold rounds close via their own seam, not a hub
      if (!followedByPullClosed[ri]) continue;   // not explicitly gathered shut - don't guess the ending
      closingRoundIndices.push(ri);
      hubOf.set(ri, addHub(ri, roundNodes[ri], nodeData[roundNodes[ri][0]]?.color));
    }
  }

  const chainFoundationRound = r0.isChainFoundation ? 0 : null;
  // Round index of the ring worked directly around a chain-in-round
  // foundation (oval base) - the round immediately after the chain itself
  // when isChainWorkedInRound is true. mdsLayout needs this to know that
  // THIS round is not a normal next-height-layer round: real crochet keeps
  // it in the same flat plane as the chain (see the seeding/flatten logic
  // in mdsLayout), only starting to gain height from the round after this.
  const chainOvalRound = isChainWorkedInRound ? 1 : null;

  const ownRoundCount = roundNodes.length;

  // Graft: import each named piece once
  // Unlike a fuse: piece (shares real graph edges with the body, solved
  // together), a grafted piece shares NO edges with anything here -
  // importSolvedPiece only ever copies a piece's own internal edges, so
  // nothing here pulls on it during the main solve, and nothing needs to.
  // It's imported now purely so its nodes exist and render (the seed
  // position is irrelevant - every imported node is pinned via
  // fusedPinnedIds, see importSolvedPiece). Where it actually ends up is
  // decided entirely AFTER the main solve, by reattachFusedPiecesFromSolo,
  // once the graft stitches this piece is glued to have real final
  // positions - see its call in solveGraph.
  const graftPieceGroups = [];
  for (const [instanceId, group] of graftGroups) {
    const name = group.name;
    const solved = solvedLibrary[name];
    if (!solved) throw new Error(`graft: "${name}" wasn't pre-solved before compiling this piece`);
    const seedTransform = { rotatedPos: solved.pos, cacheKey: `graft-${name}-${instanceId}` };
    const info = importSolvedPiece(name, seedTransform);
    // Same round resolution fuse:'s ringPlacement uses (validIndex into
    // this piece's OWN roundNodes) - parsePattern already validated this
    // is a fold/scclose round with a matching stitch count.
    const resolved = resolveLibraryRound(name, 'last', library, new Set());
    const seamLocalIds = solved.graph.roundNodes[resolved.validIndex];
    // The round immediately before the seam in this piece's own solo
    // structure - "the row right next to the attachment" - computed
    // directly from the piece's own round indexing rather than inferred
    // later from graph adjacency, which depends on exactly how a given
    // piece's internal edges happen to be wired.
    const nearSeamLocalIds = resolved.validIndex > 0 ? solved.graph.roundNodes[resolved.validIndex - 1] : [];
    // The piece's own opposite end (its very first round - typically the
    // MR/tip furthest from the closing seam) breaks the same near-mirror-
    // symmetry ambiguity a fuse leg's toe does: the seam correspondence
    // alone can't always tell which way the rest of the piece should hang.
    const farLocalIds = solved.graph.roundNodes[0];
    graftPieceGroups.push({
      name,
      idMap: info.idMap,
      soloPos: solved.pos,
      anchorLocalIds: seamLocalIds,
      nearSeamLocalIds,
      anchorMergedIds: group.anchorMergedIds,
      angleOverride: group.angleOverride,
      ringIds: group.ringIds,
      soloFarLocalIds: farLocalIds,
    });
  }

  // Mount: import each named piece once per mount: directive - a purely
  // decorative attachment (an eye, ear, or limb sewn on after the body is
  // otherwise finished), never contributing to THIS piece's own stitch count
  // or row numbering, and unlike graft: there's no shared seam correspondence
  // to fit against at all - just one target stitch on an already-built round.
  // Where it actually ends up (orientation, curvature-conforming placement)
  // is decided entirely AFTER the main solve by reattachMountedPiecesFromSolo,
  // same as graft's own post-solve placement - this loop only registers the
  // piece's nodes so they exist and render.
  const mountPieceGroups = [];
  for (let pIdx = 0; pIdx < pattern.rounds.length; pIdx++) {
    const mrnd = pattern.rounds[pIdx];
    if (!mrnd.isMountOnly || mrnd.error) continue;
    const spec = mrnd.mountSpec;
    const solved = solvedLibrary[spec.name];
    if (!solved) throw new Error(`mount: "${spec.name}" wasn't pre-solved before compiling this piece`);
    // spec.round is an index into THIS piece's own pattern.rounds - resolve it
    // into the merged roundNodes index the same way attach:rN targets do.
    const targetRi = patternToRndIdx.get(spec.round);
    if (targetRi == null) continue; // shouldn't happen once parsePattern's own validation passed
    const anchorMergedId = roundNodes[targetRi][spec.stitchIdx - 1];
    if (anchorMergedId == null) continue;
    const seedTransform = { rotatedPos: solved.pos, cacheKey: `mount-${spec.name}-${pIdx}` };
    const info = importSolvedPiece(spec.name, seedTransform);
    // Mount doesn't require a fold/scclose ending the way graft does (a
    // mounted piece's own "top" - a leg's open ring, an ear's sc-closed tip -
    // varies per piece and isn't a shared seam either way) - just whatever
    // this piece's own actual last round is.
    const resolved = resolveLibraryRound(spec.name, 'last', library, new Set());
    const attachLocalIds = solved.graph.roundNodes[resolved.validIndex];
    // If this piece's own attach round is itself a fold/scclose round (an
    // sc-closed limb tip, a whip-stitched-flat ear tip - see foldRoundSet),
    // it's already an open seam row by construction, same structural shape
    // graft's own seam is - not a plain closed ring. Treat it the same way
    // graft treats its seam rather than forcing it through the flat/tube
    // orient-and-spin pipeline built for an ordinary ring: nearSeamLocalIds
    // (the round just inside the piece from that seam) is graft's own
    // "row right next to the attachment" concept, needed below so @angle
    // can lean the piece around the seam's own hinge line, graft-style,
    // instead of spinning the whole piece rigidly from a single point.
    const isFoldSeam = solved.graph.foldRounds && solved.graph.foldRounds.has(resolved.validIndex);
    const nearSeamLocalIds = resolved.validIndex > 0 ? solved.graph.roundNodes[resolved.validIndex - 1] : [];

    // Span mount (mount:name,rN:S-rM:T - parsePattern already confirmed
    // this piece ends in a fold/scclose seam): the seam's stitches - a
    // straight open row, first stitch to last - get pinned one-for-one
    // onto the body's actual shortest path between the two given anchor
    // points, instead of the piece hanging/lying flat off a single point.
    // "Actual shortest path" is a real BFS over the BODY's own compiled
    // stitch graph (own rounds only - graph.adjList/roundNodes at this
    // point in compileGraph cover exactly that, nothing imported yet), not
    // a guess: hop count from anchorMergedId to every other body node is
    // computed once, and the reachability check is just "does the body's
    // real distance to the given endpoint equal the seam's own stitch
    // count minus one" - the same number of hops a straight row of that
    // many stitches would need to cover. A mismatch throws with the real
    // valid stitch numbers on that end round attached, computed from the
    // very same BFS pass, so a rejection is never a dead end.
    let spanPathIds = null;
    if (spec.endRound != null) {
      const endTargetRi = patternToRndIdx.get(spec.endRound);
      const endMergedId = (endTargetRi != null) ? roundNodes[endTargetRi][spec.endStitchIdx - 1] : null;
      const startLabel = `r${patternDisplayNums[spec.round]}:${spec.stitchIdx}`;
      const endLabel = `r${patternDisplayNums[spec.endRound]}:${spec.endStitchIdx}`;
      if (endMergedId == null) throw new Error(`mount: "${spec.name}" span's end point (${endLabel}) couldn't be resolved`);
      const requiredHops = attachLocalIds.length - 1;

      const isBodyNode = (id) => { const nd = nodeData[id]; return nd && nd.kind === 'top' && nd.round != null && nd.round < ownRoundCount; };
      const hopDist = new Map([[anchorMergedId, 0]]);
      const prev = new Map();
      const queue = [anchorMergedId];
      for (let qi = 0; qi < queue.length; qi++) {
        const cur = queue[qi];
        for (const [nb] of adjList[cur]) {
          if (!isBodyNode(nb) || hopDist.has(nb)) continue;
          hopDist.set(nb, hopDist.get(cur) + 1);
          prev.set(nb, cur);
          queue.push(nb);
        }
      }
      const foundHops = hopDist.has(endMergedId) ? hopDist.get(endMergedId) : null;

      if (foundHops == null || foundHops !== requiredHops) {
        const endNum = patternDisplayNums[spec.endRound];
        const endRing = roundNodes[endTargetRi] || [];
        const matchStitches = [];
        const rowHops = [];
        endRing.forEach((id, idx) => {
          const h = hopDist.get(id);
          if (h != null) { rowHops.push(h); if (h === requiredHops) matchStitches.push(idx + 1); }
        });

        // Close call: the requested ROW can actually reach, just not at
        // that exact stitch - the fix is a one-word swap, so just say
        // that and nothing else.
        if (matchStitches.length) {
          throw new Error(`on r${endNum}, try stitch ${matchStitches.join(' or ')} instead`);
        }

        // Genuinely impossible on that row - explain why (same detail as
        // before), then scan every OTHER row on the body for one that
        // does have a reachable stitch at the required distance, so an
        // "impossible" rejection still comes with a real next step
        // instead of just a dead end. Capped at a handful of examples so
        // a body with many valid rows doesn't produce a wall of text.
        let msg = foundHops == null
          ? `mount: "${spec.name}" span - ${endLabel} isn't reachable from ${startLabel} on this body`
          : `mount: "${spec.name}"'s seam needs ${requiredHops} hop${requiredHops===1?'':'s'} (${attachLocalIds.length} stitches), but ${startLabel} to ${endLabel} is ${foundHops} hop${foundHops===1?'':'s'}`;
        if (rowHops.length) {
          msg += ` (r${endNum}'s stitches range from ${Math.min(...rowHops)} to ${Math.max(...rowHops)} hops away from ${startLabel})`;
        }
        const rowSuggestions = [];
        for (let ri = 0; ri < ownRoundCount && rowSuggestions.length < 6; ri++) {
          if (ri === targetRi || ri === endTargetRi) continue;
          const ring = roundNodes[ri];
          if (!ring) continue;
          for (let k = 0; k < ring.length; k++) {
            if (hopDist.get(ring[k]) === requiredHops) { rowSuggestions.push(`r${ownRoundDisplayNums[ri]}:${k+1}`); break; }
          }
        }
        if (rowSuggestions.length) msg += ` - try ${rowSuggestions.join(' or ')} instead`;
        throw new Error(msg);
      }

      const path = [endMergedId];
      for (let cur = endMergedId; cur !== anchorMergedId; ) { cur = prev.get(cur); path.push(cur); }
      path.reverse();
      spanPathIds = path; // length === attachLocalIds.length, in seam order (first stitch -> last stitch)
    }

    mountPieceGroups.push({
      name: spec.name,
      idMap: info.idMap,
      soloPos: solved.pos,
      soloGraph: solved.graph,
      attachLocalIds,
      attachRoundIdx: resolved.validIndex,
      isFoldSeam,
      nearSeamLocalIds,
      angleOverride: spec.angleOverride,
      modeOverride: spec.modeOverride,
      flip: spec.flip,
      anchorMergedId,
      targetRi,
      targetStitchIdx: spec.stitchIdx - 1,
      spanPathIds,
    });
  }

  // Register every fused-in piece's rounds now, appended after this
  // pattern's own - purely for rendering (roundNodes needs an entry to draw
  // a ring at all) and a round-aware seed. Appending at the end means none
  // of the indices anything above (patternToRndIdx, attach: targets,
  // closingRoundIndices...) already computed for THIS piece's own rounds
  // shift by even one - fuse is additive on top of an unmodified pipeline.
  // roundAttachTo (used below) now correctly carries an imported piece's
  // own attach:rN rows - needed for its row markers to merge/relabel
  // correctly (see buildRowMarkerGroup). But feeding that into the
  // SOLVER's seeding formula (mdsLayout, see targetRi) changes where an
  // imported piece's reattached round gets seeded during the PARENT
  // graph's own majorization pass, which can pull its final settled shape
  // slightly away from matching that same piece's own standalone solve -
  // exactly the kind of "looks different when fused vs standalone"
  // inconsistency that should never happen for an already-solved,
  // supposedly pinned-in piece. roundAttachToSeed mirrors roundAttachTo
  // for this pattern's OWN rounds (that path was never wrong) but keeps
  // null for every imported round, same as before this fix, so solving
  // stays byte-for-byte consistent with the piece's standalone shape;
  // only the rendering/label code (which reads roundAttachTo, not this)
  // sees the corrected attach mapping.
  const roundAttachToSeed = roundAttachTo.slice();
  const importedRoundRanges = []; // {name, startRi, count} - see roundLabel, keeps an imported piece's own rounds from being mislabeled as if they were this piece's next rows
  for (const info of importedPieceInfos) {
    const baseRi = roundNodes.length; // this piece's local round k lands at merged index baseRi+k, since all its rounds are appended contiguously and in order right here
    importedRoundRanges.push({name: info.name, startRi: baseRi, count: info.roundIdMaps.length});
    for (let k = 0; k < info.roundIdMaps.length; k++) {
      const newRi = roundNodes.length;
      const ids = info.roundIdMaps[k];
      roundNodes.push(ids);
      roundTypes.push(info.roundTypes?.[k] || 'plain');
      roundBobblesList.push(info.roundBobbles?.[k] || []);
      // Was unconditionally null - which silently dropped this piece's own
      // attach:rN rows (e.g. an ear built off its leg's round 4). Remap
      // the LEG's own local target index into this merged graph's index
      // space the same way node ids are remapped via idMap, just for round
      // indices instead of node ids - both were appended contiguously
      // starting at baseRi, in the same order, so local index j becomes
      // merged index baseRi+j.
      const localAttach = info.roundAttachTo && info.roundAttachTo[k];
      roundAttachTo.push(localAttach != null ? baseRi + localAttach : null);
      roundAttachToSeed.push(null);
      chainDepth.push(null);
      chainTargetBase.push(null);
      if (info.hubOf && info.hubOf.get(k) != null) hubOf.set(newRi, info.idMap.get(info.hubOf.get(k)));
      if (info.mrRoundIndices.includes(k)) mrRoundIndices.push(newRi);
      if (info.foldRounds && info.foldRounds.has(k)) foldRoundSet.add(newRi);
      if (info.flapRounds && info.flapRounds.has(k)) flapRoundSet.add(newRi);
      if (info.hardFlattenRounds && info.hardFlattenRounds.has(k)) sewClosedRoundSet.add(newRi);
      for (const id of ids) nodeData[id].round = newRi;
    }
  }

  // The pass above only corrects 'top'-kind ids (the only kind roundNodes
  // ever tracks). Loop nodes (blo/flo) and bulgeLeg nodes were copied
  // verbatim from the solo-solved piece in importSolvedPiece and so still
  // carry their OLD solo-piece round number - never touched by anything
  // above. That's mostly inert, except the blo/flo ridge-push pass later
  // looks up getCentroid(nd.round) to decide which direction is "outward"
  // for a loop node; fed a stale round number, it centroids against
  // whatever unrelated round happens to sit at that index in the merged
  // graph and pushes the stitch out in a bogus direction - the actual
  // cause of the floating bead / misaligned ridge on fused-in pieces.
  // Fix: give every aux node the ALREADY-CORRECTED round of whichever top
  // node it's actually attached to.
  for (const info of importedPieceInfos) {
    for (const newId of info.idMap.values()) {
      const nd = nodeData[newId];
      if (nd.kind === 'top' || nd.kind === 'hub') continue;
      const parentId = nd.parentTop ?? nd.topId ?? nd.botId;
      if (parentId != null && nodeData[parentId]) nd.round = nodeData[parentId].round;
    }
  }

  return {N: nid, adjList, nodeData, roundNodes, roundBobbles: roundBobblesList, roundTypes, roundAttachTo, roundAttachToSeed, chainDepth, chainTargetBase, isFlatPiece, chainFoundationRound, chainOvalRound, mrRoundIndices, closingRoundIndices, hubOf, foldRounds: foldRoundSet, flapRounds: flapRoundSet, hardFlattenRounds: sewClosedRoundSet, warmStartPos, fusedPinnedIds, fuseRoundIndices, fuseRoundLift, fuseRoundSegments, fusedPieceGroups, graftPieceGroups, mountPieceGroups, ownRoundCount, importedRoundRanges, ownRoundDisplayNums};
}

// True if this compiled graph joined in another piece via fuse:/graft:/
// mount:. flattenHorizontal only knows how to project a single connected 
// stress-majorization result, so it has nothing consistent to do with a 
// piece that was positioned afterward, separately, by a different process. 
// Flatten is disallowed on anything built this way rather than producing 
// a plausible-looking but physically meaningless flattened shape.
export function usesAssembly(graph) {
  return !!(graph && (
    (graph.fuseRoundIndices && graph.fuseRoundIndices.size > 0) ||
    (graph.mountPieceGroups && graph.mountPieceGroups.length > 0) ||
    (graph.graftPieceGroups && graph.graftPieceGroups.length > 0)
  ));
}

// DIJKSTRA (min-heap priority queue)
class MinHeap {
  constructor() { this.h = []; }
  push(dist, node) {
    this.h.push([dist, node]);
    this._bubbleUp(this.h.length-1);
  }
  pop() {
    const top = this.h[0];
    const last = this.h.pop();
    if (this.h.length > 0) { this.h[0]=last; this._siftDown(0); }
    return top;
  }
  _bubbleUp(i) {
    while (i>0) {
      const p=(i-1)>>1;
      if (this.h[p][0]<=this.h[i][0]) break;
      [this.h[p],this.h[i]]=[this.h[i],this.h[p]];
      i=p;
    }
  }
  _siftDown(i) {
    const n=this.h.length;
    while (true) {
      let m=i, l=2*i+1, r=2*i+2;
      if (l<n&&this.h[l][0]<this.h[m][0]) m=l;
      if (r<n&&this.h[r][0]<this.h[m][0]) m=r;
      if (m===i) break;
      [this.h[m],this.h[i]]=[this.h[i],this.h[m]];
      i=m;
    }
  }
  get size() { return this.h.length; }
}

export function dijkstra(N, adjList, source) {
  const dist = new Float64Array(N).fill(Infinity);
  dist[source] = 0;
  const visited = new Uint8Array(N);
  const pq = new MinHeap();
  pq.push(0, source);

  while (pq.size > 0) {
    const [d, u] = pq.pop();
    if (visited[u]) continue;
    visited[u] = 1;
    for (const [v, w] of adjList[u]) {
      const nd = d + w;
      if (nd < dist[v]) {
        dist[v] = nd;
        pq.push(nd, v);
      }
    }
  }
  return dist;
}