import { DEFAULT_GRAFT_ANGLE_DEG, RADIUS_FLARE_DECAY_ROUNDS, FLATTEN_CURL_FACTOR, FLATTEN_CURL_SMOOTH_WINDOW } from './constants.js';
import { dijkstra } from './graph.js';

// LAYOUT SOLVER - Stress Majorization (original implementation)
//
// Algorithm: Gansner, E.R., Koren, Y. & North, S. (2004).
//   "Graph Drawing by Stress Majorization."
//   Proc. 12th Int'l Symp. Graph Drawing, LNCS 3383, pp. 239-250.
//
// Weight formula w_ij = d_ij^{−alpha}:
//   Brandes, U. & Pich, C. (2006). "Eigensolver Methods for Progressive
//   Multidimensional Scaling of Large Data." GD 2006 LNCS 4372, pp. 42-53.
//
// Shortest paths: Dijkstra, E.W. (1959). "A note on two problems in
//   connexion with graphs." Numerische Mathematik 1(1), pp. 269-271.
//
// All algorithms used here are published academic methods in the public domain.
// This implementation is written independently from first principles.
export async function mdsLayout(N, adjList, {
  iterations    = 200,   // stress majorization steps (converges quickly with good init)
  alpha         = 2,     // weight exponent: w_ij = d_ij^{-alpha}
  onProgress, onPhase, signal,
  roundNodes    = null,  // optional round structure for smart initialization
  roundAttachTo = null,  // optional per-round attach target (see compileGraph) - seeds a reattached round near its real target instead of its sequential position
  chainDepth      = null, // optional per-round attach-chain depth (see compileGraph)
  chainTargetBase = null, // optional per-round attach-chain fork point (see compileGraph)
  isFlatPiece   = false, // true for pieces grown from a chain (ch:N)
  chainFoundationRound = null, // round index whose OWN seeding stays a straight line even if isFlatPiece is false downstream (chain worked in the round / oval base - see compileGraph)
  chainOvalRound = null, // round index of the ring worked around a chain-in-round foundation (oval base) - seeded coplanar with chainFoundationRound instead of one height layer above it, and hard-flattened onto a single plane after solving (see flattenChainOvalBase below) - a chain and the row worked directly around it genuinely can't have any 3D relief, they're flat by construction
  foldRounds    = null,  // optional Set of round indices that are 'fold' OR 'scclose' seams (see compileGraph) - seeded as a straight line, same as a flat-piece row, since a folded/creased or sc-closed seam is a flat open row by construction, not a ring
  flapRounds    = null,  // optional Set of round indices that only claim part of their base (rnd.isFlap - see parsePattern/compileGraph) - seeded as a straight line, same as a flat-piece row, since a partial round is an open arc, not a ring that meets itself
  nodeData      = null,  // optional node metadata, used to seed bulgeLeg/loop aux nodes (see seedAuxNodes)
  hubOf         = null,  // optional round index -> hub node id map (see compileGraph) - seeds each hub at its own ring's center height instead of leaving it at the origin
  warmStartPos  = null,  // optional Map<nodeId, [x,y,z]> - see Phase 2c below (autobuild row-by-row reveal)
  fuseRoundIndices = null, // optional Set of round indices founded on fuse: (see compileGraph) - seeded one stitch-height above a fixed external Y=0 base instead of this piece's own sequential slot
  hardPinnedPos = null, // optional Map<nodeId, [x,y,z]> - TRUE pinning, not a warm-start hint: these nodes are seeded at this exact position AND never moved by majorization (Phase 3) or spring relaxation (Phase 4). Distinct from warmStartPos (a starting guess the solver is still free to move). An earlier attempt at this ran hard-pinning as a SEPARATE SECOND majorization pass with a fresh re-seed, which threw away "which way is up" from the first pass and caused flips - this version pins from the very first iteration of the ONE solve instead, so there's no second re-seeding step to lose orientation in.
  distanceCache = null, // optional {N: prevN, D: prevD (array of Float64Array/Array, prevN entries, each length prevN), adjList: prevAdjList} from a PRIOR mdsLayout call on a strict node-prefix of this graph (autobuild appending rounds one/several at a time). When present AND safe (see safety check below), Phase 1 skips full Dijkstra and only computes rows for the NEW nodes, reusing old-old distances unchanged. Verified equivalent to full recompute for both plain appends and fuse/graft joins via harness_distance_cache.mjs before shipping.
  distanceCacheOut = null, // optional {} - if given, Phase 1 writes {N, D, adjList} onto it so the caller can pass it back in as distanceCache on the NEXT incremental step, without this function needing to change its return type.
} = {}) {

  if (N === 0) return new Float64Array(0);

  // Phase 1: All-pairs shortest paths via Dijkstra
  if (onPhase) onPhase('Computing shortest paths...');
  // Incremental-safe iff: (a) we have a previous D for a strict prefix of
  // this graph's node ids (nodes 0..prevN-1 are the same ids, same
  // semantics - true for a clean autobuild append per compileGraph's
  // deterministic id counter), AND (b) no edge in the NEW adjacency
  // connects two nodes that both already existed in the old graph. (b) is
  // the fuse/graft danger case: a bridge/graft round can shortcut two
  // previously-unconnected old nodes, which can only ever SHORTEN an
  // old-old distance - Dijkstra distances never increase when edges are
  // added - so reusing the old (now stale, too-long) old-old distance
  // would silently under-connect the majorization solve exactly where a
  // fuse/graft join needs it tightest. When (b) fails, fall through to a
  // full recompute below, same as if there were no cache at all.
  let safe = false;
  if (distanceCache && distanceCache.D && distanceCache.N > 0 && distanceCache.N <= N) {
    safe = true;
    const prevN = distanceCache.N;
    const prevAdj = distanceCache.adjList;
    outer:
    for (let u = 0; u < prevN; u++) {
      const prevNbrs = new Set((prevAdj && prevAdj[u] ? prevAdj[u] : []).map(([v]) => v));
      for (const [v] of adjList[u]) {
        if (v < prevN && !prevNbrs.has(v)) { safe = false; break outer; }
      }
    }
  }
  const D = [];
  if (safe) {
    const prevN = distanceCache.N;
    const prevD = distanceCache.D;
    // Old nodes: reuse their row for old-old entries unchanged (proven safe
    // above); new-node columns get filled in below from the new nodes' own
    // fresh rows via symmetry (this graph is undirected - every edge weight
    // applies equally in both directions - so d(i,j) === d(j,i) always).
    for (let i = 0; i < prevN; i++) {
      const row = new Float64Array(N).fill(Infinity);
      row.set(prevD[i].subarray ? prevD[i].subarray(0, prevN) : prevD[i].slice(0, prevN));
      D.push(row);
    }
    // New nodes: full fresh Dijkstra - their rows are entirely new
    // information a prefix solve couldn't have had.
    for (let i = prevN; i < N; i++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      D.push(dijkstra(N, adjList, i));
      if ((i - prevN) % 20 === 0) {
        if (onProgress) onProgress((i - prevN) / Math.max(1, N - prevN) * 0.35);
        await new Promise(r => setTimeout(r, 0));
      }
    }
    for (let i = prevN; i < N; i++) {
      for (let j = 0; j < prevN; j++) D[j][i] = D[i][j];
    }
  } else {
    for (let i = 0; i < N; i++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      D.push(dijkstra(N, adjList, i));
      if (i % 20 === 0) {
        if (onProgress) onProgress(i / N * 0.35);
        await new Promise(r => setTimeout(r, 0));
      }
    }
  }
  if (distanceCacheOut) { distanceCacheOut.N = N; distanceCacheOut.D = D; distanceCacheOut.adjList = adjList; }

  // Precompute weights w_ij = d_ij^{-alpha} and row sums
  // Pairs where d_ij is infinite (disconnected) or zero are excluded.
  const W    = new Float64Array(N * N);
  const sumW = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      if (i === j) continue;
      const d = D[i][j];
      if (!isFinite(d) || d < 1e-10) continue;
      const w = Math.pow(d, -alpha);
      W[i * N + j] = w;
      sumW[i]      += w;
    }
  }

  // Phase 2: Initialize positions
  const pos = new Float64Array(N * 3);

  if (roundNodes && roundNodes.length > 0) {
    // Round-aware initialization: place each round on a circle whose radius
    // equals n/(2π) so that adjacent stitches are spaced ~1 unit apart.
    // This gives the solver a warm start and greatly reduces iterations needed.
    const UNIT = 1.0;
    let totalH = (roundNodes.length - 1) * UNIT;
    const midH = totalH / 2;
    for (let ri = 0; ri < roundNodes.length; ri++) {
      const ring = roundNodes[ri];
      const n    = ring.length;
      const R    = (n * UNIT) / (2 * Math.PI);
      // A reattached round (attach:rN-flo/blo) physically starts at an
      // earlier round, not at its own sequential position - seed its height
      // there so the solver doesn't have to drag it all the way from where
      // a normal round ri would sit. This has to apply to the WHOLE chain,
      // not just the round with the attach: directive - a continuation
      // round's raw sequential index (ri) can be numerically far from
      // where its branch actually lives (it might be the 11th line in the
      // pattern despite forking from round 3), so seeding it at "ri" was
      // dragging it toward a height that had nothing to do with its actual
      // neighbors, which is what caused a later round in a chain to seed
      // in the wrong direction entirely.
      let targetRi = (chainDepth && chainDepth[ri] != null && chainTargetBase)
        ? chainTargetBase[ri] + chainDepth[ri]
        : ((roundAttachTo && roundAttachTo[ri] != null) ? roundAttachTo[ri] : ri);
      // The ring worked directly around a chain-in-round foundation (oval
      // base) sits in the SAME plane as the chain, not a height layer above
      // it - a chain and the row worked into both its loops lie flat on top
      // of each other, same physical spot, and only the round AFTER this
      // one starts actually gaining height. Without this, that round seeded
      // (and often stayed) a full stitch-height above the chain, which is
      // what read as a raised cone/point instead of a flat oval.
      if (chainOvalRound != null) {
        if (ri === chainOvalRound) targetRi = chainFoundationRound;
        else if (ri > chainOvalRound) targetRi -= 1;
      }
      let h = targetRi * UNIT - midH;
      // A fuse round isn't a fresh root the way MR is, even though it has
      // no chainDepth/roundAttachTo of its own: it's new material growing
      // on top of OTHER pieces' live stitches, and ringPlacement has
      // already recentered whichever rim it references to exactly Y=0 in
      // world space (see ringPlacement/buildFuseBase in compileGraph).
      // Falling through to the generic sequential-index formula above
      // seeds it at effectively the same slot MR occupies (h≈0) - the SAME
      // height as the rim it's meant to rise above, so majorization starts
      // with zero signal to lift it off that plane. One stitch-height
      // above that fixed, known-zero base is the right seed regardless of
      // how many rounds end up in the graph, since totalH/midH scale with
      // roundNodes.length but this override is applied after midH is
      // already folded in above, cancelling that dependency out.
      if (fuseRoundIndices && fuseRoundIndices.has(ri)) h = UNIT;
      if (hubOf && hubOf.get(ri) != null) {
        // The ring's own points are seeded symmetrically around (0,h,0),
        // so that's exactly where their centroid - and hence the hub -
        // should start too, whether it's flat-piece or ring geometry.
        const hubId = hubOf.get(ri);
        pos[hubId * 3] = 0; pos[hubId * 3 + 1] = h; pos[hubId * 3 + 2] = 0;
      }
      if (isFlatPiece || ri === chainFoundationRound || (foldRounds && foldRounds.has(ri)) || (flapRounds && flapRounds.has(ri))) {
        // Straight line along X, centered, alternating rows stacked in Y -
        // there's no ring here, just a strip growing row by row. Also
        // applies to round 0 alone when it's a chain worked in the round
        // (oval base) - the chain itself is physically straight even
        // though everything built on top of it closes into rings.
        for (let k = 0; k < n; k++) {
          const nid = ring[k];
          pos[nid * 3]     = (k - (n-1)/2) * UNIT;
          pos[nid * 3 + 1] = h;
          pos[nid * 3 + 2] = 0;
        }
      } else if (ri === chainOvalRound) {
        // An oval-base ring isn't a circular tube cross-section - it's a
        // flat racetrack (two straight sides flanking the chain, capped by
        // rounded ends where the increases/fan turn the corner), elongated
        // along the chain's own X extent rather than a plain circle. This is
        // still only a warm-start seed (the flatten pass below is what
        // actually guarantees the result), but starting from a shape closer
        // to the real one gives the solver a much better local minimum to
        // settle into instead of a coned circle.
        const chainLen = (roundNodes[chainFoundationRound] ? roundNodes[chainFoundationRound].length : n) - 1;
        const ovalA = Math.max(chainLen * UNIT / 2, UNIT * 0.5) + UNIT * 0.5;
        const ovalB = UNIT * 0.7;
        for (let k = 0; k < n; k++) {
          const angle      = (2 * Math.PI * k) / n;
          const nid        = ring[k];
          pos[nid * 3]     = ovalA * Math.cos(angle);
          pos[nid * 3 + 1] = h;
          pos[nid * 3 + 2] = ovalB * Math.sin(angle);
        }
      } else {
        for (let k = 0; k < n; k++) {
          const angle      = (2 * Math.PI * k) / n;
          const nid        = ring[k];
          pos[nid * 3]     = R * Math.cos(angle);
          pos[nid * 3 + 1] = h;
          pos[nid * 3 + 2] = R * Math.sin(angle);
        }
      }
    }
  } else {
    // Fallback: Fibonacci sphere surface distribution
    const rng    = mulberry32(42);
    const golden = Math.PI * (3 - Math.sqrt(5));
    const R0     = Math.max(Math.sqrt(N) * 0.5, 1.0);
    for (let i = 0; i < N; i++) {
      const y  = 1 - (i / Math.max(N - 1, 1)) * 2;
      const rr = Math.sqrt(Math.max(0, 1 - y * y));
      const th = golden * i;
      const R  = R0 + (rng() - 0.5) * 0.4;
      pos[i * 3]     = Math.cos(th) * rr * R;
      pos[i * 3 + 1] = y * R;
      pos[i * 3 + 2] = Math.sin(th) * rr * R;
    }
  }

  // Phase 2c: Warm-start overwrite for already-solved nodes
  // Autobuild (row-by-row reveal) calls this same function again every time
  // a new round is added, on the growing-but-still-partial pattern. Without
  // this, every one of those calls would re-seed already-revealed rounds
  // back onto a fresh circle and majorization would have to re-settle them
  // from scratch each time - cheap computationally, but it reads as the
  // whole piece jittering every time a row is added. Stress majorization is
  // a fixed-point iteration: given the same graph, it converges to the same
  // geometry regardless of where it started, so overwriting already-solved
  // nodes with their previous final position here doesn't change WHERE
  // Phase 3 below ends up - it just starts closer, converges faster, and
  // leaves already-built rounds visually settled instead of popping back to
  // a seed shape every keystroke. Runs after the round-circle seed above
  // (so it wins over that fallback) and before Phase 2b (so aux nodes like
  // loop/bulgeLeg children, which seed relative to their parent's position,
  // see the REAL previous position rather than a fresh guess). Brand-new
  // nodes (not in the map) are untouched here and keep whatever seed the
  // blocks above already gave them.
  if (warmStartPos) {
    for (const [id, p] of warmStartPos) {
      if (id < N) { pos[id*3] = p[0]; pos[id*3+1] = p[1]; pos[id*3+2] = p[2]; }
    }
  }

  // Phase 2d: Hard-pin seeding
  // Runs after the warm-start overwrite so it wins over it - these
  // positions aren't just a starting guess, they're authoritative and never
  // move again (see Phase 3 and Phase 4 below).
  const pinnedMask = hardPinnedPos && hardPinnedPos.size ? new Uint8Array(N) : null;
  if (hardPinnedPos) {
    for (const [id, p] of hardPinnedPos) {
      if (id < N) { pos[id*3] = p[0]; pos[id*3+1] = p[1]; pos[id*3+2] = p[2]; pinnedMask[id] = 1; }
    }
  }

  // Phase 2b: Seed auxiliary nodes (bobble/puff/popcorn legs, blo/flo loops)
  // bulgeLeg and loop nodes aren't part of any round's ring, so the pass
  // above never touches them - they'd otherwise all sit stacked exactly on
  // the origin. Stress majorization's update rule treats exactly-coincident
  // points as already-agreeing (it snaps their target to each other, not
  // apart), so graph-symmetric siblings that start coincident stay
  // coincident forever regardless of what their edges actually want. This
  // is a pure warm-start seed - it doesn't encode the final shape, it just
  // gives every sibling leg/loop a distinct starting point so majorization
  // has something to refine instead of a locked degenerate tie.
  // Determines which way a fuse-bridge dup stitch should lean by looking at
  // its own real ring neighbor - whichever adjacent stitch ISN'T itself part
  // of the bridge chain (isFuseBridge, or another dupBase stitch) - and
  // matching that neighbor's side. This replaces the old dupSide-based sign
  // (0=-X, 1=+X), which only encodes visit ORDER (first vs second time a
  // given base was touched) and does not reliably track which side of the
  // bridge a link is on once the bridge has more than one link: two
  // different links' "first" (outbound) visits both got dupSide 0 even
  // though they sit on opposite sides. Falls back to `fallbackSign` if no
  // usable neighbor is found (e.g. a single-stitch ring - shouldn't happen
  // in practice but keeps this from ever throwing).
  function bridgeLeanSign(nodeId, baseX, fallbackSign) {
    const nd2 = nodeData[nodeId];
    const ring = nd2 && roundNodes ? roundNodes[nd2.round] : null;
    if (!ring || !ring.length) return fallbackSign;
    const idx = nd2.indexInRound;
    const isBridgeish = (id) => {
      const n = nodeData[id];
      return n && (n.isFuseBridge || n.dupBase != null);
    };
    const leftNb  = ring[(idx - 1 + ring.length) % ring.length];
    const rightNb = ring[(idx + 1) % ring.length];
    const dirNb = isBridgeish(leftNb) ? rightNb : leftNb;
    if (dirNb == null || dirNb === nodeId) return fallbackSign;
    const nx = pos[dirNb*3];
    if (nx == null || !isFinite(nx)) return fallbackSign;
    return nx >= baseX ? 1 : -1;
  }

  if (nodeData) {
    for (let i = 0; i < N; i++) {
      const nd = nodeData[i];
      if (!nd) continue;
      // A hard-pinned node (fused-in from a solo-solved piece) already has
      // its correct, final position from Phase 2d. This block runs AFTER
      // that and, for dupBase/fanBase/bulgeLeg/loop kinds, unconditionally
      // overwrote pos[i] with a generic formulaic seed - it never checked
      // pinnedMask. Since Phase 3/4 hold a pinned node at whatever's
      // currently in pos[i], that overwrite became permanent: every fan
      // stitch (ruffle) in an imported leg was silently replaced by this
      // generic seed instead of its real, already-solved shape. That's the
      // actual cause of the ruffle looking wrong after fuse - not a
      // rotation/viewing-angle effect.
      if (pinnedMask && pinnedMask[i]) continue;
      if (nd.dupBase != null) {
        // Two tops sharing one reused base (a fuse bridge chain stitch
        // touched twice - once going out, once coming back).
        // MODEL CORRECTED against the actual written pattern: this is a
        // real "sc in the side of the chain" technique, worked once from
        // each side of every chain link (not two flat parallel rails sitting
        // to either side of the chain in Z). Each side's stitch rises up
        // from the chain (real stitch height) and leans back along the
        // chain's own run axis (X) toward whichever leg it was worked
        // right after - the outbound pass (dupSide 0) happens immediately
        // after leg1's stitches, so it leans toward leg1; the return pass
        // (dupSide 1) happens immediately after leg2's, so it leans toward
        // leg2. That gives the "V"/trough cross-section from the side
        // (leaning apart in X while both rising in Y), not a sideways
        // twin-rail split in Z.
        const bId = nd.dupBase;
        const bx = pos[bId*3], by = pos[bId*3+1], bz = pos[bId*3+2];
        // FIX: was `nd.dupSide === 0 ? -1 : 1` - dupSide is visit order per
        // base, not side. Lean toward this stitch's own real ring neighbor
        // instead (see bridgeLeanSign above).
        const sign = bridgeLeanSign(i, bx, nd.dupSide === 0 ? -1 : 1);
        pos[i*3]   = bx + sign * 0.35;
        pos[i*3+1] = by + 0.8;
        pos[i*3+2] = bz;
      } else if (nd.fanBase != null) {
        // Fan siblings (e.g. "3 hdc in each stitch around") all connect to
        // the same one base stitch and to each other at the same short
        // distance - graph-symmetric, same issue as bulgeLeg/loop above.
        // They DO get a round-circle seed already (they're normal 'top'
        // nodes), but consecutive fan siblings sit only a few degrees
        // apart in a large ring, and that's not enough separation to
        // survive majorization's pull toward their shared position -
        // needs the same deliberate spread as bulgeLeg legs.
        const bId = nd.fanBase;
        const bx = pos[bId*3], by = pos[bId*3+1], bz = pos[bId*3+2];
        // Use the base's own radial direction (out from the tube axis) as
        // the reference plane, same technique as the loop-node fix below.
        let rx = bx, rz = bz;
        let rlen = Math.hypot(rx, rz);
        if (rlen < 1e-6) { rx = 1; rz = 0; rlen = 1; }
        rx /= rlen; rz /= rlen;
        // perpendicular (tangential) direction in the XZ plane
        const tx = -rz, tz = rx;
        // This is a WARM-START SEED ONLY, same as every other block in this
        // Phase 2b section - it breaks the graph symmetry (all siblings have
        // identical edges to the same base and to each other, so they'd
        // otherwise start and stay coincident) and then gets out of the way.
        // Nothing here is copied back after the solve; Phase 3/4 (stress
        // majorization + spring relaxation) are what actually decide where
        // each leg ends up, driven by the real edges: distance to the shared
        // base (fanH), short cohesion to its neighbors, and - the part a
        // fixed formula can never see - each leg's own onward edges into the
        // NEXT round. Those onward edges are what should pull the middle leg
        // one way and the outer legs another; letting the solver own that is
        // what makes the splay follow the actual pattern instead of an
        // authored angle that looks the same no matter what surrounds it.
        // The arc used to break symmetry is deliberately modest (not a full
        // 2*PI/n spread around the tube) because a fan splays forward off
        // the surface, it doesn't ring the whole circumference - a full-
        // circle seed was the earlier bug that put one leg's warm start
        // pointing backward into the work.
        const nFan = Math.max(nd.fanN||1, 1);
        const FAN_ARC = Math.PI * 0.65;
        const angle = nFan > 1 ? -FAN_ARC/2 + FAN_ARC * (nd.fanIndex||0) / (nFan-1) : 0;
        // Scaled to THIS stitch's own height (fanH), not a flat constant -
        // a tr3fan and an sc3fan seed at their own proportions instead of
        // both assuming the same generic stitch size.
        const fh = nd.fanH || 1.0;
        const spread = fh * 0.6;
        pos[i*3]   = bx + spread*(Math.cos(angle)*rx + Math.sin(angle)*tx);
        pos[i*3+1] = by + fh * 0.9;
        pos[i*3+2] = bz + spread*(Math.cos(angle)*rz + Math.sin(angle)*tz);
      } else if (nd.kind === 'bulgeLeg') {
        const bId = nd.botId, tId = nd.topId;
        const bx = pos[bId*3], by = pos[bId*3+1], bz = pos[bId*3+2];
        const tx = pos[tId*3], ty = pos[tId*3+1], tz = pos[tId*3+2];
        let ax = tx-bx, ay = ty-by, az = tz-bz;
        const alen = Math.hypot(ax,ay,az) || 1;
        ax/=alen; ay/=alen; az/=alen;
        // Arbitrary vector not parallel to the bot->top axis, to build a
        // stable perpendicular basis via cross products.
        let ux = -az, uy = 0, uz = ax;
        let ulen = Math.hypot(ux,uy,uz);
        if (ulen < 1e-6) { ux=1; uy=0; uz=0; ulen=1; }
        ux/=ulen; uy/=ulen; uz/=ulen;
        const vx = ay*uz-az*uy, vy = az*ux-ax*uz, vz = ax*uy-ay*ux;
        const nLegs = Math.max(nd.legs||1, 1);
        const angle = (2*Math.PI*(nd.legIndex||0)) / nLegs;
        const frac  = nd.stage===1 ? 0.35 : 0.65;
        const spread = Math.max(alen*0.3, 0.15);
        pos[i*3]   = bx + (tx-bx)*frac + spread*(Math.cos(angle)*ux + Math.sin(angle)*vx);
        pos[i*3+1] = by + (ty-by)*frac + spread*(Math.cos(angle)*uy + Math.sin(angle)*vy);
        pos[i*3+2] = bz + (tz-bz)*frac + spread*(Math.cos(angle)*uz + Math.sin(angle)*vz);
      } else if (nd.kind === 'loop') {
        const pId = nd.parentTop;
        const sign = nd.side === 'front' ? 1 : -1;
        // Seed along the parent's own true radial direction (out from the
        // tube's vertical axis), not a fixed world-space vector - a fixed
        // vector has no relationship to which side of the fabric front vs
        // back actually sit on, which is the root of the blo/flo mixup.
        let rx = pos[pId*3], rz = pos[pId*3+2];
        let rlen = Math.hypot(rx, rz);
        if (rlen < 1e-6) { rx = 1; rz = 0; rlen = 1; }
        rx /= rlen; rz /= rlen;
        pos[i*3]   = pos[pId*3]   + sign*0.4*rx;
        pos[i*3+1] = pos[pId*3+1] + sign*0.06;
        pos[i*3+2] = pos[pId*3+2] + sign*0.4*rz;
      }
    }
  }

  // Phase 3: Stress majorization
  // Each iteration updates every node position to the weighted centroid of
  // its "target" positions given all other nodes:
  //
  //   x_i^{t+1} = (Σ_{j≠i} w_ij · [x_j^t + d_ij/r_ij · (x_i^t − x_j^t)])
  //                              Σ_{j≠i} w_ij
  //
  // where r_ij = ||x_i^t − x_j^t||. When r_ij ≈ 0, we use x_j as target.
  // This update provably decreases the weighted stress function each iteration.
  if (onPhase) onPhase('Stress majorization...');
  const newPos = new Float64Array(N * 3);
  // Diagnostic only: tracks which iteration the solve actually settled on,
  // so "does the quality slider do anything" is measurable instead of
  // guessed. Read window.__lastMajorizationStats after a solve.
  const CONVERGE_EPS = 1e-5; // max per-node displacement, in stitch-spacing units
  let convergedAt = null;

  for (let iter = 0; iter < iterations; iter++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (iter % 20 === 0) {
      await new Promise(r => setTimeout(r, 0));
      if (onProgress) onProgress(0.35 + (iter / iterations) * 0.55);
    }

    newPos.fill(0);
    for (let i = 0; i < N; i++) {
      if (pinnedMask && pinnedMask[i]) {
        newPos[i * 3] = pos[i * 3]; newPos[i * 3 + 1] = pos[i * 3 + 1]; newPos[i * 3 + 2] = pos[i * 3 + 2];
        continue;
      }
      const swi = sumW[i];
      if (swi < 1e-15) continue;
      let sx = 0, sy = 0, sz = 0;

      for (let j = 0; j < N; j++) {
        if (i === j) continue;
        const w = W[i * N + j];
        if (w < 1e-15) continue;

        const dx = pos[i * 3]     - pos[j * 3];
        const dy = pos[i * 3 + 1] - pos[j * 3 + 1];
        const dz = pos[i * 3 + 2] - pos[j * 3 + 2];
        const r2 = dx * dx + dy * dy + dz * dz;

        if (r2 < 1e-12) {
          // Nearly coincident: target is simply x_j
          sx += w * pos[j * 3];
          sy += w * pos[j * 3 + 1];
          sz += w * pos[j * 3 + 2];
        } else {
          const scale = D[i][j] / Math.sqrt(r2);
          sx += w * (pos[j * 3]     + scale * dx);
          sy += w * (pos[j * 3 + 1] + scale * dy);
          sz += w * (pos[j * 3 + 2] + scale * dz);
        }
      }
      newPos[i * 3]     = sx / swi;
      newPos[i * 3 + 1] = sy / swi;
      newPos[i * 3 + 2] = sz / swi;
    }

    // Max per-node displacement this step, checked BEFORE overwriting pos.
    let maxDelta = 0;
    for (let i = 0; i < N; i++) {
      const dx = newPos[i * 3]     - pos[i * 3];
      const dy = newPos[i * 3 + 1] - pos[i * 3 + 1];
      const dz = newPos[i * 3 + 2] - pos[i * 3 + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > maxDelta) maxDelta = d;
    }

    pos.set(newPos);

    if (maxDelta < CONVERGE_EPS) {
      convergedAt = iter + 1;
      break;
    }
  }

  window.__lastMajorizationStats = {
    N, iterationsAllowed: iterations,
    convergedAt: convergedAt ?? iterations,
    stoppedEarly: convergedAt !== null
  };
  console.log(`[mdsLayout] stress majorization: N=${window.__lastMajorizationStats.N} iterationsAllowed=${window.__lastMajorizationStats.iterationsAllowed} convergedAt=${window.__lastMajorizationStats.convergedAt} stoppedEarly=${window.__lastMajorizationStats.stoppedEarly}`);

  // Phase 4: Spring relaxation over direct edges
  // Hooke's law: F_ij = k·(r − L)/r · (p_j − p_i)
  // Applies only to direct graph edges (immediate stitch connections).
  // Simple Euler integration with velocity damping - refines local geometry.
  if (onPhase) onPhase('Spring refinement...');
  const vel    = new Float64Array(N * 3);
  const forces = new Float64Array(N * 3);
  const kSpring = 0.20, damping = 0.82, dt = 0.08;

  for (let iter = 0; iter < 30; iter++) {
    forces.fill(0);
    for (let i = 0; i < N; i++) {
      for (const [j, L] of adjList[i]) {
        if (j <= i) continue;
        const dx = pos[j * 3]     - pos[i * 3];
        const dy = pos[j * 3 + 1] - pos[i * 3 + 1];
        const dz = pos[j * 3 + 2] - pos[i * 3 + 2];
        const r  = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (r < 1e-10) continue;
        const f = kSpring * (r - L) / r;
        forces[i * 3]     += f * dx;  forces[j * 3]     -= f * dx;
        forces[i * 3 + 1] += f * dy;  forces[j * 3 + 1] -= f * dy;
        forces[i * 3 + 2] += f * dz;  forces[j * 3 + 2] -= f * dz;
      }
    }
    for (let i = 0; i < N; i++) {
      if (pinnedMask && pinnedMask[i]) { vel[i*3]=vel[i*3+1]=vel[i*3+2]=0; continue; }
      vel[i * 3]     = vel[i * 3]     * damping + forces[i * 3]     * dt;
      vel[i * 3 + 1] = vel[i * 3 + 1] * damping + forces[i * 3 + 1] * dt;
      vel[i * 3 + 2] = vel[i * 3 + 2] * damping + forces[i * 3 + 2] * dt;
      pos[i * 3]     += vel[i * 3];
      pos[i * 3 + 1] += vel[i * 3 + 1];
      pos[i * 3 + 2] += vel[i * 3 + 2];
    }
  }

  // Phase 4b: Enforce front/back loop radial side
  // Stress majorization only ever sees graph topology, and a front/back loop
  // pair is topologically symmetric - same edge length to their shared top,
  // same edge length to each other - except for which one happens to be the
  // worked attach point. Nothing in that graph ties "front" to the outward,
  // visible side of the fabric and "back" to the inward, hidden side, so the
  // unworked loop of a blo round and the unworked loop of a flo round settle
  // into the same kind of position: this is why the two ridge presets read
  // as identical. We fix that here by forcing every solved loop pair onto
  // the real local outward direction from its round's own centroid (the
  // same technique buildRowMarkerGroup uses below for its clearance ring) -
  // front pushed to the outside of the tube where it reads as a visible
  // ridge, back pushed toward the interior where it recedes, matching what
  // blo/flo actually do to a stitch in real crochet.
  if (nodeData && roundNodes) {
    const roundCentroid = new Map(); // round index -> {cx,cy,cz}
    const getCentroid = (ri) => {
      let c = roundCentroid.get(ri);
      if (c) return c;
      const ring = roundNodes[ri];
      c = {cx:0, cy:0, cz:0};
      if (ring && ring.length) {
        ring.forEach(id => { c.cx += pos[id*3]; c.cy += pos[id*3+1]; c.cz += pos[id*3+2]; });
        c.cx /= ring.length; c.cy /= ring.length; c.cz /= ring.length;
      }
      roundCentroid.set(ri, c);
      return c;
    };
    const seenPair = new Set();
    for (let i = 0; i < N; i++) {
      const nd = nodeData[i];
      if (!nd || nd.kind !== 'loop' || nd.side !== 'front') continue;
      const pId = nd.parentTop;
      if (seenPair.has(pId)) continue;
      let backId = null;
      for (const [j] of adjList[pId]) {
        const nj = nodeData[j];
        if (nj && nj.kind === 'loop' && nj.side === 'back' && nj.parentTop === pId) { backId = j; break; }
      }
      if (backId == null) continue;
      seenPair.add(pId);

      const c = getCentroid(nd.round);
      let rx = pos[pId*3] - c.cx, rz = pos[pId*3+2] - c.cz;
      let rlen = Math.hypot(rx, rz);
      if (rlen < 1e-6) { rx = 1; rz = 0; rlen = 1; }
      rx /= rlen; rz /= rlen;

      // Ring's own average distance from its centroid, so the push stays
      // proportional whether it's a tiny near-MR round or a wide one.
      let avgR = 0;
      const ring = roundNodes[nd.round];
      if (ring && ring.length) {
        ring.forEach(id => { avgR += Math.hypot(pos[id*3]-c.cx, pos[id*3+2]-c.cz); });
        avgR /= ring.length;
      }
      const pushDist = Math.min(0.42, Math.max(avgR * 0.35, 0.14));

      pos[i*3]        = pos[pId*3]   + rx*pushDist;
      pos[i*3+2]       = pos[pId*3+2] + rz*pushDist;
      pos[i*3+1]       = pos[pId*3+1] + 0.06;

      pos[backId*3]    = pos[pId*3]   - rx*pushDist;
      pos[backId*3+2]  = pos[pId*3+2] - rz*pushDist;
      pos[backId*3+1]  = pos[pId*3+1] - 0.06;
    }
  }

  // Phase 4b-2: Force apart dupBase pairs (reused fuse-bridge stitches)
  // A fuse bridge chain link touched twice (once outbound, once on the way
  // back) gets two new tops worked into it - same edge to the shared base,
  // same cohesion edge to each other. This was found to be the SAME class
  // of problem as the front/back loop pair just above: seeding them apart
  // (mdsLayout's Phase 2b) was NOT enough on its own - verified directly,
  // 400 iterations of majorization pulled them back to the exact same
  // point (distance 0.000) regardless of seed, because fusing a piece to
  // an identical piece (e.g. two matching legs) makes the two occurrences
  // genuinely graph-symmetric, and majorization's real optimum has them
  // coincident. Same fix as the loop pair: force them apart AFTER the
  // solve rather than trusting the solve to find separation on its own.
  if (nodeData) {
    const seenDup = new Set();
    for (let i = 0; i < N; i++) {
      const nd = nodeData[i];
      if (!nd || nd.dupBase == null || nd.dupSide !== 0) continue;
      const bId = nd.dupBase;
      if (seenDup.has(bId)) continue;
      let otherId = null;
      for (const [j] of adjList[i]) {
        const nj = nodeData[j];
        if (nj && nj.dupBase === bId && nj.dupSide === 1) { otherId = j; break; }
      }
      if (otherId == null) continue;
      seenDup.add(bId);

      // MODEL CORRECTED: leans toward each stitch's own adjacent leg along
      // the chain's run axis (X). FIX: previously assumed `i` (dupSide 0)
      // always goes -X and `otherId` (dupSide 1) always goes +X - true only
      // for a single-link bridge. With 2+ links, dupSide is just visit
      // order per-base and doesn't track which side of the bridge a given
      // link is on, so this was forcing some stitches away from their real
      // neighbors. Derive each one's own sign from bridgeLeanSign instead,
      // still giving the real "sc in the side of the chain, both sides"
      // V-splay, just on the correct side each time.
      const pushDist = 0.5;
      const signI     = bridgeLeanSign(i, pos[bId*3], -1);
      const signOther = bridgeLeanSign(otherId, pos[bId*3], 1);
      pos[i*3]        = pos[bId*3] + signI * pushDist;
      pos[otherId*3]   = pos[bId*3] + signOther * pushDist;
    }
  }

  // Phase 4c: Hug reattached rounds to their real anchor position
  // A reattached round (attach:rN-flo/blo) is seeded at the SAME height as
  // its target round (see targetRi above), so its own ring is competing
  // for the same slice of 3D space that round's real ring already fills.
  // Stress majorization's only way to resolve that collision is to shove
  // the whole new ring outward, regardless of whether it's rooted in a
  // front loop (fine, that's meant to sit proud) or a back loop (wrong -
  // that should read as recessed, tucked against the tube, same as any
  // other back-loop ridge, not ballooned past it). We fix that by pulling
  // each reattached round back to hug the actual solved position of its
  // own anchor nodes: same radius direction as the anchor (with a small
  // outward nudge so it reads as its own layer) AND the same HEIGHT as the
  // anchor - it's a branch worked directly into that row's free loop, not
  // a new round stacked a stitch-height above it.
  if (nodeData && roundNodes && roundAttachTo) {
    const roundCentroid2 = new Map();
    const getCentroid2 = (ri) => {
      let c = roundCentroid2.get(ri);
      if (c) return c;
      const ring = roundNodes[ri];
      c = {cx:0, cy:0, cz:0};
      if (ring && ring.length) {
        ring.forEach(id => { c.cx += pos[id*3]; c.cy += pos[id*3+1]; c.cz += pos[id*3+2]; });
        c.cx /= ring.length; c.cy /= ring.length; c.cz /= ring.length;
      }
      roundCentroid2.set(ri, c);
      return c;
    };
    for (let ri = 0; ri < roundNodes.length; ri++) {
      if (roundAttachTo[ri] == null) continue;
      const ring = roundNodes[ri];
      if (!ring || !ring.length) continue;

      // Fan siblings sharing one base need to move TOGETHER, as a group, not
      // each get snapped individually onto their shared anchor. This bug was
      // already here before the fan rewrite above, it was just invisible:
      // every top's "direct anchor" (its one neighbor from an earlier round)
      // is the shared base stitch for ALL of a fan's siblings, so the old
      // per-node version below was pinning every leg of a fan to the exact
      // same radius, angle, and height, collapsing a 3-stitch ruffle back
      // down to one point. The removed Phase 4d used to run AFTER this and
      // paper back over the collapse with its own fixed formula, which is
      // why the flattening never showed up until that override was removed.
      // The fix here is the same idea Phase 4d was reaching for, just done
      // as a group correction instead of an authored shape: compute where
      // the fan's shared anchor says the GROUP should sit (same radius/
      // height logic as any other reattached stitch), then move every leg
      // in that group by that same offset, preserving whatever spread the
      // real physics (fanH edge to the base, cohesion to its neighbor leg,
      // and the ring's own lateral edges) already worked out between them.
      const seenFanBase = new Set();
      for (const id of ring) {
        const nd = nodeData[id];
        if (nd && nd.fanBase != null) {
          const anchorId = nd.fanBase;
          if (seenFanBase.has(anchorId)) continue;
          seenFanBase.add(anchorId);
          const siblings = ring.filter(sid => nodeData[sid].fanBase === anchorId);
          if (!siblings.length) continue;

          let gcx = 0, gcy = 0, gcz = 0;
          siblings.forEach(sid => { gcx += pos[sid*3]; gcy += pos[sid*3+1]; gcz += pos[sid*3+2]; });
          gcx /= siblings.length; gcy /= siblings.length; gcz /= siblings.length;

          const rd = nodeData[anchorId];
          const c  = getCentroid2(rd.round);
          let rx = pos[anchorId*3] - c.cx, rz = pos[anchorId*3+2] - c.cz;
          let rlen = Math.hypot(rx, rz);
          if (rlen < 1e-6) { rx = 1; rz = 0; rlen = 1; }
          rx /= rlen; rz /= rlen;
          const grow = 0.12;
          const targetCx = c.cx + (rlen + grow) * rx;
          const targetCz = c.cz + (rlen + grow) * rz;
          const targetCy = pos[anchorId*3+1];

          const dx = targetCx - gcx, dy = targetCy - gcy, dz = targetCz - gcz;
          siblings.forEach(sid => {
            pos[sid*3]   += dx;
            pos[sid*3+1] += dy;
            pos[sid*3+2] += dz;
          });
          continue;
        }

        // Find this top's direct anchor: the neighbor from an earlier round.
        let anchorId = null;
        for (const [j] of adjList[id]) {
          const nj = nodeData[j];
          if (nj && nj.round < nodeData[id].round) { anchorId = j; break; }
        }
        if (anchorId == null) continue;
        const rd = nodeData[anchorId];
        const c  = getCentroid2(rd.round);
        let rx = pos[anchorId*3] - c.cx, rz = pos[anchorId*3+2] - c.cz;
        let rlen = Math.hypot(rx, rz);
        if (rlen < 1e-6) { rx = 1; rz = 0; rlen = 1; }
        rx /= rlen; rz /= rlen;
        const grow = 0.12; // just enough to read as its own layer, not a flare
        pos[id*3]   = c.cx + (rlen + grow) * rx;
        pos[id*3+2] = c.cz + (rlen + grow) * rz;
        // Flush with the anchor row's own height - this new loop is worked
        // directly into that row's free loop, it's a branch off that same
        // row, not a fresh layer stacked a full stitch-height above it.
        pos[id*3+1] = pos[anchorId*3+1];
      }
    }

    // Continuation rounds (chainDepth > 0, no attachTo of their own) need
    // their height fixed too, but NOT the same way as the attach round
    // itself - they're normal rounds, meant to stand up above whatever
    // came before them in their own chain, not sit flush with it.
    //
    // The previous approach computed how far the depth-0 round moved when
    // snapped above, and applied that SAME shift to every deeper round in
    // its chain. That assumes the pre-snap spacing between chain rounds
    // was already correct and just needed translating - but the pre-snap
    // spacing came out of the same solve that got the depth-0 round's
    // position wrong in the first place, so the shift could easily
    // overshoot. That's exactly what was happening: a chain whose anchor
    // needed a big downward correction dragged its continuation rounds
    // down along with it, past the anchor itself, instead of leaving them
    // standing above it.
    //
    // Fixed by re-anchoring each depth explicitly, in increasing depth
    // order, so every round is positioned relative to the round before it
    // AFTER that one has already been corrected - never off a stale,
    // pre-correction position.
    if (chainDepth) {
      const STITCH_H = 1.0;
      let maxDepth = 0;
      for (let ri = 0; ri < roundNodes.length; ri++) {
        if (chainDepth[ri] != null && chainDepth[ri] > maxDepth) maxDepth = chainDepth[ri];
      }
      for (let depth = 1; depth <= maxDepth; depth++) {
        for (let ri = 0; ri < roundNodes.length; ri++) {
          if (chainDepth[ri] !== depth) continue;
          const ring = roundNodes[ri];
          if (!ring || !ring.length) continue;
          for (const id of ring) {
            let anchorId = null;
            for (const [j] of adjList[id]) {
              const nj = nodeData[j];
              if (nj && nj.round < nodeData[id].round) { anchorId = j; break; }
            }
            if (anchorId == null) continue;
            // Stand up normally above the anchor - a continuation round is
            // an ordinary round, not another flush reattachment.
            pos[id*3+1] = pos[anchorId*3+1] + STITCH_H;
          }
        }
      }
    }
  }

  // Fan-stitch siblings are NOT re-authored here
  // An earlier version of this function had a "Phase 4d" here that threw
  // away whatever position the solver found for every fan sibling and wrote
  // a fixed angle/height formula over it instead. That's exactly backwards
  // for a graph-physics tool: it meant the fan's visible shape was actually
  // coming from a constant in this file, not from the pattern, and it could
  // never respond to what a specific fan's own onward stitches (the next
  // round attached to it) were pulling it toward - every fan of the same
  // size looked identical regardless of context, and the formula's fixed
  // numbers implicitly assumed every stitch was the same height.
  //
  // Fan siblings are graph-symmetric right after compileGraph (same edge to
  // their shared base, same short edge to their neighbor(s)) - that's a
  // real problem, but it's a SEEDING problem, not a final-position problem,
  // and it's already solved correctly: Phase 2b above gives each sibling a
  // distinct, proportionally-scaled starting point purely to break that tie.
  // From there, Phase 3 (stress majorization) and Phase 4 (spring
  // relaxation) are trusted to do the same job they already do for bobble/
  // puff/popcorn legs with no post-hoc override at all - pull every node to
  // satisfy its real edges: distance to the shared base, cohesion to its
  // fan neighbors, AND its own onward edges into the next round. That last
  // part is exactly the information a fixed formula can never have, and
  // it's what lets two fans in the same pattern end up with genuinely
  // different, pattern-driven splay instead of an identical stamped shape.

  // Center on origin
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < N; i++) { cx += pos[i*3]; cy += pos[i*3+1]; cz += pos[i*3+2]; }
  cx /= N; cy /= N; cz /= N;
  for (let i = 0; i < N; i++) { pos[i*3] -= cx; pos[i*3+1] -= cy; pos[i*3+2] -= cz; }

  if (onProgress) onProgress(1.0);
  return pos;
}

// SPIRAL SEAM OFFSET
// Real amigurumi worked "in the round" without joining/turning drifts into a
// diagonal seam, because each round's start creeps slightly relative to the
// round below it. The stress-majorization solve above has no notion of this
// drift (it only knows distances, not which way is "around"), so we add it
// as a separate, purely cosmetic step: a rigid rotation of each already-solved
// round about the model's vertical (Y) axis. Rotating a whole ring together
// changes none of the distances the physics solved for, so the solve result
// itself is left completely untouched - this only changes how each ring is
// aimed.
//
// Each round advances by a SMALL fraction (1/4 stitch) of its own stitch
// spacing, matching the seam-drift convention used in the profile-based
// visualizer: small enough to stay subtle, large enough to read as a visible
// diagonal seam. Negative = CCW, the standard crochet round direction.
export function applySpiralOffset(pos, roundNodes, nodeData, isFlatPiece, excludeIds=null) {
  if (!roundNodes || roundNodes.length === 0) return pos;
  if (isFlatPiece) return pos; // spiral seam is a tube-only cosmetic effect

  // Cumulative angle per round, derived from each round's ACTUAL stitch count
  // (roundNodes[ri].length), so the offset always matches the real pattern -
  // not an assumed or stale count.
  const roundAngle = [0];
  for (let ri = 1; ri < roundNodes.length; ri++) {
    const prevCount = roundNodes[ri - 1].length || 1;
    roundAngle.push(roundAngle[ri - 1] - (2 * Math.PI / prevCount) * 0.25);
  }

  // Rotate every node belonging to round ri by roundAngle[ri]. Bulge (bobble/
  // puff/popcorn) nodes carry the same `round` index as the ring they sit on
  // (see compileGraph), so they rotate in lockstep with their host stitch
  // instead of drifting away from the surface.
  //
  // excludeIds is every node imported whole from an already-solved fused-in
  // piece (see graph.fusedPinnedIds) - that piece went through this exact
  // pass once already, during its own solo solve, and that twist is baked
  // into the positions it was copied in with verbatim. Rotating it again
  // here would apply a SECOND spiral, keyed to wherever its rounds happen
  // to land in THIS piece's round ordering, which has nothing to do with
  // the angle it was originally twisted by - every ring of the fused piece
  // would end up rotated a different, wrong extra amount relative to its
  // neighbor, reading as exactly the kind of smear/warp this guard exists
  // to prevent. New rounds built on top of the fuse (the bridge round and
  // anything after) are NOT in excludeIds, so they still spiral normally.
  for (let i = 0; i < nodeData.length; i++) {
    if (excludeIds && excludeIds.has(i)) continue;
    const ri = nodeData[i].round;
    const a = roundAngle[ri];
    if (!a) continue;
    const x = pos[i * 3], z = pos[i * 3 + 2];
    const c = Math.cos(a), s = Math.sin(a);
    pos[i * 3]     = x * c - z * s;
    pos[i * 3 + 2] = x * s + z * c;
  }
  return pos;
}

// A foundation chain and the row of stitches worked directly around both its
// loops (an oval base: snout, sole, body base) are physically flat - real
// crochet never gives them any 3D relief, since nothing has increased them
// out of the plane yet. Stress majorization only ever sees graph topology
// though, and the small chain/loop edges (see getAttachNode) combined with
// the differing increase shapes at each end (a multi-stitch fan at the tip,
// a plain inc at the near end) give it just enough asymmetric pull to settle
// into a slight dome/twist instead of a true flat plane, even with the
// coplanar seeding above. This pass makes flatness exact rather than
// approximate: fit the best plane through the chain + its loop nodes + the
// oval ring's own stitches, then project every one of those points onto it,
// preserving whatever in-plane layout the solver worked out (the racetrack
// shape, relative stitch spacing, etc) and only removing the out-of-plane
// component. The projection itself only moves these two rounds; a short
// pinned spring-relaxation pass afterward (see below) lets anything built on
// top of the oval base resettle around the corrected, now-flat foundation
// instead of staying stretched toward the base's old position.
// Fits the best-fit plane through a set of node ids (PCA via a 3x3 Jacobi
// eigenvalue solve - the plane's normal is the covariance matrix's
// smallest-eigenvalue eigenvector, i.e. the direction the points vary LEAST
// along) and projects every one of those points onto it, IN PLACE, removing
// only their out-of-plane component so whatever in-plane layout the solver
// already worked out (relative spacing, curvature, etc) is preserved.
// Shared by every flatten pass below (oval base, fold seams, whole-model
// flatten toggle) - "find the plane these points are already closest to and
// squash them onto it" is the same operation regardless of which points.
// Same best-fit-plane eigensolve as projectOntoBestFitPlane above, but reports
// the centroid and normal instead of moving anything - used to find a fused-
// in piece's own connecting-round plane and axis so it can be ROTATED into
// the right facing before placement, without touching its actual positions
// (those come from the shared solvedLibrary and must never be mutated in
// place, since the same solved piece may be referenced by more than one
// fuse: segment with different placements).
export function bestFitNormal(pos, ids) {
  let cx = 0, cy = 0, cz = 0;
  for (const id of ids) { cx += pos[id*3]; cy += pos[id*3+1]; cz += pos[id*3+2]; }
  cx /= ids.length; cy /= ids.length; cz /= ids.length;

  let xx=0,xy=0,xz=0,yy=0,yz=0,zz=0;
  for (const id of ids) {
    const dx = pos[id*3]-cx, dy = pos[id*3+1]-cy, dz = pos[id*3+2]-cz;
    xx += dx*dx; xy += dx*dy; xz += dx*dz;
    yy += dy*dy; yz += dy*dz; zz += dz*dz;
  }
  xx/=ids.length; xy/=ids.length; xz/=ids.length; yy/=ids.length; yz/=ids.length; zz/=ids.length;

  let a = [[xx,xy,xz],[xy,yy,yz],[xz,yz,zz]];
  let V = [[1,0,0],[0,1,0],[0,0,1]];
  for (let iter = 0; iter < 60; iter++) {
    let p = 0, q = 1, maxv = Math.abs(a[0][1]);
    if (Math.abs(a[0][2]) > maxv) { maxv = Math.abs(a[0][2]); p = 0; q = 2; }
    if (Math.abs(a[1][2]) > maxv) { maxv = Math.abs(a[1][2]); p = 1; q = 2; }
    if (maxv < 1e-12) break;
    const app = a[p][p], aqq = a[q][q], apq = a[p][q];
    const phi = 0.5 * Math.atan2(2*apq, aqq-app);
    const c = Math.cos(phi), s = Math.sin(phi);
    a[p][p] = c*c*app - 2*s*c*apq + s*s*aqq;
    a[q][q] = s*s*app + 2*s*c*apq + c*c*aqq;
    a[p][q] = 0; a[q][p] = 0;
    for (let i = 0; i < 3; i++) {
      if (i !== p && i !== q) {
        const aip = a[i][p], aiq = a[i][q];
        a[i][p] = c*aip - s*aiq; a[p][i] = a[i][p];
        a[i][q] = s*aip + c*aiq; a[q][i] = a[i][q];
      }
    }
    for (let i = 0; i < 3; i++) {
      const vip = V[i][p], viq = V[i][q];
      V[i][p] = c*vip - s*viq;
      V[i][q] = s*vip + c*viq;
    }
  }
  const vals = [a[0][0], a[1][1], a[2][2]];
  let minIdx = 0;
  if (vals[1] < vals[minIdx]) minIdx = 1;
  if (vals[2] < vals[minIdx]) minIdx = 2;
  let nx = V[0][minIdx], ny = V[1][minIdx], nz = V[2][minIdx];
  const nlen = Math.hypot(nx, ny, nz) || 1;
  nx /= nlen; ny /= nlen; nz /= nlen;
  return {cx, cy, cz, nx, ny, nz};
}

// Fits a best-fit 3D line through a set of points via PCA (returns the
// covariance matrix's LARGEST-eigenvalue eigenvector, i.e. the axis the
// points are most spread out along) - used by ringPlacement to find a
// fused-in piece's own true growth axis, traced through its ROUND CENTROIDS
// rather than its raw stitch points so a wide/narrow ring shape at any one
// round can't skew the direction, independently of that piece's connecting
// round's own plane (which can itself be slightly tilted if the piece has
// any residual lean baked in from its own solo solve). Same eigensolve as
// bestFitNormal just above, but the LARGEST eigenvalue's eigenvector
// instead of the smallest's - a line of best fit is the axis points vary
// along MOST, not least (least-variance axis is a plane's normal, which is
// what bestFitNormal wants instead).
function bestFitAxisDirection(points) {
  const n = points.length;
  if (n < 2) return [0, 1, 0];
  let cx=0, cy=0, cz=0;
  for (const p of points) { cx+=p[0]; cy+=p[1]; cz+=p[2]; }
  cx/=n; cy/=n; cz/=n;
  let xx=0,xy=0,xz=0,yy=0,yz=0,zz=0;
  for (const p of points) {
    const dx=p[0]-cx, dy=p[1]-cy, dz=p[2]-cz;
    xx+=dx*dx; xy+=dx*dy; xz+=dx*dz; yy+=dy*dy; yz+=dy*dz; zz+=dz*dz;
  }
  xx/=n; xy/=n; xz/=n; yy/=n; yz/=n; zz/=n;
  let a = [[xx,xy,xz],[xy,yy,yz],[xz,yz,zz]];
  let V = [[1,0,0],[0,1,0],[0,0,1]];
  for (let iter = 0; iter < 60; iter++) {
    let p = 0, q = 1, maxv = Math.abs(a[0][1]);
    if (Math.abs(a[0][2]) > maxv) { maxv = Math.abs(a[0][2]); p = 0; q = 2; }
    if (Math.abs(a[1][2]) > maxv) { maxv = Math.abs(a[1][2]); p = 1; q = 2; }
    if (maxv < 1e-12) break;
    const app = a[p][p], aqq = a[q][q], apq = a[p][q];
    const phi = 0.5 * Math.atan2(2*apq, aqq-app);
    const c = Math.cos(phi), s = Math.sin(phi);
    a[p][p] = c*c*app - 2*s*c*apq + s*s*aqq;
    a[q][q] = s*s*app + 2*s*c*apq + c*c*aqq;
    a[p][q] = 0; a[q][p] = 0;
    for (let i = 0; i < 3; i++) {
      if (i !== p && i !== q) {
        const aip = a[i][p], aiq = a[i][q];
        a[i][p] = c*aip - s*aiq; a[p][i] = a[i][p];
        a[i][q] = s*aip + c*aiq; a[q][i] = a[i][q];
      }
    }
    for (let i = 0; i < 3; i++) {
      const vip = V[i][p], viq = V[i][q];
      V[i][p] = c*vip - s*viq;
      V[i][q] = s*vip + c*viq;
    }
  }
  const vals = [a[0][0], a[1][1], a[2][2]];
  let maxIdx = 0;
  if (vals[1] > vals[maxIdx]) maxIdx = 1;
  if (vals[2] > vals[maxIdx]) maxIdx = 2;
  let nx = V[0][maxIdx], ny = V[1][maxIdx], nz = V[2][maxIdx];
  const nlen = Math.hypot(nx, ny, nz) || 1;
  return [nx/nlen, ny/nlen, nz/nlen];
}

// Rotates every point in `pos` (Float64Array, xyz-interleaved, mutated in
// place) about `pivot` so that unit vector `fromDir` maps onto unit vector
// `toDir` - a generic axis-angle (Rodrigues) rotation between two arbitrary
// directions, unlike the fixed-axis spin used elsewhere in ringPlacement.
// Only ever called on a fresh per-placement clone of a solvedLibrary piece
// (see ringPlacement's workPos below), never on the shared cached solve
// itself - that copy may be referenced by more than one fuse: segment with
// a different placement each time.
// Same Rodrigues rotation as rotateAxisOnto, but for a single free direction
// vector rather than a point cloud around a pivot (no translation - a
// direction has no position). Used to carry a normal/axis THROUGH a rotation
// that's already been decided elsewhere, instead of recomputing it from
// scratch on already-rotated geometry - see the mount face-normal fix below
// for why that recomputation is unsafe.
function rotateVectorOnto(v, fromDir, toDir) {
  let ax = fromDir[1]*toDir[2]-fromDir[2]*toDir[1];
  let ay = fromDir[2]*toDir[0]-fromDir[0]*toDir[2];
  let az = fromDir[0]*toDir[1]-fromDir[1]*toDir[0];
  const alen = Math.hypot(ax, ay, az);
  const cosT = fromDir[0]*toDir[0]+fromDir[1]*toDir[1]+fromDir[2]*toDir[2];
  if (alen < 1e-9) {
    if (cosT > 0) return v;
    ax = 1; ay = 0; az = 0;
    if (Math.abs(fromDir[0]) > 0.9) { ax = 0; ay = 1; az = 0; }
  } else {
    ax/=alen; ay/=alen; az/=alen;
  }
  const theta = Math.atan2(alen, cosT);
  const ct = Math.cos(theta), st = Math.sin(theta);
  const [x, y, z] = v;
  const ndotp = ax*x+ay*y+az*z;
  const crossx = ay*z-az*y, crossy = az*x-ax*z, crossz = ax*y-ay*x;
  return [x*ct + crossx*st + ax*ndotp*(1-ct), y*ct + crossy*st + ay*ndotp*(1-ct), z*ct + crossz*st + az*ndotp*(1-ct)];
}

export function rotateAxisOnto(pos, pivot, fromDir, toDir) {
  const [px, py, pz] = pivot;
  let ax = fromDir[1]*toDir[2]-fromDir[2]*toDir[1];
  let ay = fromDir[2]*toDir[0]-fromDir[0]*toDir[2];
  let az = fromDir[0]*toDir[1]-fromDir[1]*toDir[0];
  const alen = Math.hypot(ax, ay, az);
  const cosT = fromDir[0]*toDir[0]+fromDir[1]*toDir[1]+fromDir[2]*toDir[2];
  if (alen < 1e-9) {
    if (cosT > 0) return pos; // already aligned, nothing to do
    // Exactly 180 degrees apart - any axis perpendicular to fromDir works.
    ax = 1; ay = 0; az = 0;
    if (Math.abs(fromDir[0]) > 0.9) { ax = 0; ay = 1; az = 0; }
  } else {
    ax/=alen; ay/=alen; az/=alen;
  }
  const theta = Math.atan2(alen, cosT);
  const ct = Math.cos(theta), st = Math.sin(theta);
  const n = pos.length / 3;
  for (let i = 0; i < n; i++) {
    const x = pos[i*3]-px, y = pos[i*3+1]-py, z = pos[i*3+2]-pz;
    const ndotp = ax*x+ay*y+az*z;
    const crossx = ay*z-az*y, crossy = az*x-ax*z, crossz = ax*y-ay*x;
    pos[i*3]   = x*ct + crossx*st + ax*ndotp*(1-ct) + px;
    pos[i*3+1] = y*ct + crossy*st + ay*ndotp*(1-ct) + py;
    pos[i*3+2] = z*ct + crossz*st + az*ndotp*(1-ct) + pz;
  }
  return pos;
}

// Rotating the piece AS MAJORIZATION LEFT IT (an earlier approach) only
// ever fixes the two endpoints - it says nothing about every round in
// between, so any bend majorization introduced along the way survives the
// rotation intact; you're re-aiming a bent piece, not straightening it.
// And because the anchor round's own individual stitches were part of
// that same rigid rotation, they'd swing to new positions around their
// (unmoved) centroid too - detaching them from whatever the bridge/other
// piece expected to find there. Both problems (leg body visibly bowed, the
// join looking wrong) trace back to the same cause: trusting the merged
// solve's shape for a piece that already had a perfectly good shape before
// it was ever fused in.
// So: don't use majorization's (possibly warped) copy of this piece at all.
// Use the ORIGINAL solo-solved shape (solvedLibrary[name].pos, computed
// once per piece before fusing even starts - straight and correct, exactly
// what a standalone "leg with ruffle" preset looks like on its own) and
// rigidly place THAT - via a real best-fit rotation+translation from the
// anchor round's known point-for-point correspondence (solo stitch i really
// is merged stitch i, same physical round) - so its own anchor ring lines
// up with wherever the merged solve actually put the join. Every round
// below the anchor comes along for the ride, still perfectly undistorted,
// because it's a rigid copy of a shape that was already correct. The anchor
// ring itself is left exactly as the merged solve positioned it (not
// overwritten) since that's the one place this piece has to stay in exact
// agreement with the bridge/other piece/body - only everything below it is
// replaced.
// reattachFusedPiecesFromSolo moves each piece's whole body (everything
// below the anchor ring) - but the anchor ring itself, the bridge chain
// between two pieces, and this round's own new stitches worked into all of
// that were positioned during the ORIGINAL merged solve, before pieces got
// corrected. Two things can be left stale relative to the now-correct
// anchor rings: the chain's own path (nothing constrains it to be straight
// - it's built purely out of graph edges, which majorization can satisfy
// with a bulged or curved path just as well as a straight one), and this
// round's own new stitches (each one is a vertical post rising off ONE
// specific base point - if that base moved, the stitch needs to move with
// it, or the edge between them stretches to however far the base moved).
export function fixupFuseJoinGeometry(pos, graph) {
  if (!graph.fuseRoundLift || !graph.fuseRoundLift.size) return;
  const UNIT = 1.0;
  const groups = graph.fusedPieceGroups;
  const centroidOf = ids => {
    let x=0,y=0,z=0;
    for (const id of ids) { x+=pos[id*3]; y+=pos[id*3+1]; z+=pos[id*3+2]; }
    return [x/ids.length, y/ids.length, z/ids.length];
  };

  for (const [ri, info] of graph.fuseRoundLift) {
    const liftIds = info.liftIds || [];
    if (!groups || groups.length !== 2) continue;
    const liftSet = new Set(liftIds);
    const seamIdsFor = (g, otherG) => {
      if (!g.anchorMergedIds) return [];
      const otherSet = otherG && otherG.anchorMergedIds ? new Set(otherG.anchorMergedIds) : null;
      const found = g.anchorMergedIds.filter(id =>
        (liftIds.length && graph.adjList[id].some(([nb]) => liftSet.has(nb))) ||
        (otherSet && graph.adjList[id].some(([nb]) => otherSet.has(nb)))
      );
      return found;
    };
    const seamIds0 = seamIdsFor(groups[0], groups[1]);
    const seamIds1 = seamIdsFor(groups[1], groups[0]);
    if (!seamIds0.length || !seamIds1.length) continue;

    // Enforce the actual physical gap a chain of this length implies -
    // the solve alone converges to roughly the same seam-to-seam distance
    // regardless of chain length (confirmed directly: ch2/ch6/ch10 all
    // landed within a hair of each other), so this has to be set
    // explicitly rather than trusted to emerge on its own. chainLen links,
    // each a UNIT-length edge, plus one UNIT-length seam edge on each end.
    const chainLen = liftIds.length;
    const targetGap = (chainLen + 1) * UNIT;
    let p0 = centroidOf(seamIds0), p1 = centroidOf(seamIds1);
    let dx = p1[0]-p0[0], dy = p1[1]-p0[1], dz = p1[2]-p0[2];
    const curGap = Math.hypot(dx,dy,dz);
    if (curGap > 1e-6) {
      dx/=curGap; dy/=curGap; dz/=curGap;
      const delta = targetGap - curGap;
      for (const mergedId of groups[0].idMap.values()) { pos[mergedId*3]-=dx*delta/2; pos[mergedId*3+1]-=dy*delta/2; pos[mergedId*3+2]-=dz*delta/2; }
      for (const mergedId of groups[1].idMap.values()) { pos[mergedId*3]+=dx*delta/2; pos[mergedId*3+1]+=dy*delta/2; pos[mergedId*3+2]+=dz*delta/2; }
      p0 = centroidOf(seamIds0); p1 = centroidOf(seamIds1);
    }

    // Chain: place it on a straight, level line between the two pieces'
    // now-corrected seam points (goal 3 - no weird curve/bulge; works for
    // any chain length). Skipped when there's no chain at all - the two
    // rims just seam directly together as buildFuseBase already wired
    // them, nothing to place on a line.
    if (chainLen > 0) {
      const lineY = (p0[1]+p1[1])/2;
      for (let i = 0; i < chainLen; i++) {
        const t = (i+1)/(chainLen+1);
        const id = liftIds[i];
        pos[id*3]   = p0[0] + t*(p1[0]-p0[0]);
        pos[id*3+1] = lineY;
        pos[id*3+2] = p0[2] + t*(p1[2]-p0[2]);
      }
    }

    // This round's own new stitches: reattach every one to wherever its
    // real base (an anchor-ring stitch, or now a corrected chain link)
    // actually ended up, one stitch-height above it - the same rule every
    // ordinary round in this app already follows.
    const tops = graph.roundNodes[ri];
    if (!tops || !tops.length) continue;
    const topSet = new Set(tops);
    for (const id of tops) {
      const bases = graph.adjList[id].map(([nb]) => nb).filter(nb => !topSet.has(nb));
      if (!bases.length) continue;
      let bx=0, by=0, bz=0;
      for (const nb of bases) { bx+=pos[nb*3]; by+=pos[nb*3+1]; bz+=pos[nb*3+2]; }
      bx/=bases.length; by/=bases.length; bz/=bases.length;
      pos[id*3] = bx; pos[id*3+1] = by + UNIT; pos[id*3+2] = bz;
    }
  }
}

// Relaxes just ONE imported piece's own nodes (via its own internal edges
// only) around a pinned subset, without touching anything else in the
// graph - relaxAroundPinned itself walks every node 0..N, which would be
// pure wasted work here (and needlessly re-simulates the whole body, which
// has no edges to this piece anyway) if called directly on the full graph.
// Builds a compact local index space just for this piece, relaxes that,
// then copies the result back.
function relaxPieceAroundPinned(pos, graph, pieceNodeIds, pinnedMergedIds, iterations) {
  const idxOf = new Map();
  pieceNodeIds.forEach((id,i)=>idxOf.set(id,i));
  const n = pieceNodeIds.length;
  const localAdj = Array.from({length:n}, () => []);
  for (let i = 0; i < n; i++) {
    for (const [nb, L] of graph.adjList[pieceNodeIds[i]]) {
      const j = idxOf.get(nb);
      if (j !== undefined) localAdj[i].push([j, L]);
    }
  }
  const localPos = new Float64Array(n*3);
  for (let i = 0; i < n; i++) { localPos[i*3]=pos[pieceNodeIds[i]*3]; localPos[i*3+1]=pos[pieceNodeIds[i]*3+1]; localPos[i*3+2]=pos[pieceNodeIds[i]*3+2]; }
  const localPinned = [];
  for (const mid of pinnedMergedIds) { const j = idxOf.get(mid); if (j !== undefined) localPinned.push(j); }
  relaxAroundPinned(localPos, localAdj, n, localPinned, iterations);
  for (let i = 0; i < n; i++) { pos[pieceNodeIds[i]*3]=localPos[i*3]; pos[pieceNodeIds[i]*3+1]=localPos[i*3+1]; pos[pieceNodeIds[i]*3+2]=localPos[i*3+2]; }
}

// Rotates a single point by `theta` radians around the axis through `pivot`
// with direction `axis` (unit vector) - Rodrigues' rotation formula, used
// below to lean a grafted piece around its own seam/hinge line without
// ever moving that line itself (anything ON the axis is a fixed point of
// the rotation, which is exactly what "the connection point doesn't move"
// needs).
function rotatePointAroundAxis(p, pivot, axis, theta) {
  const vx = p[0]-pivot[0], vy = p[1]-pivot[1], vz = p[2]-pivot[2];
  const [ax, ay, az] = axis;
  const dot = ax*vx + ay*vy + az*vz;
  const crossx = ay*vz - az*vy, crossy = az*vx - ax*vz, crossz = ax*vy - ay*vx;
  const ct = Math.cos(theta), st = Math.sin(theta);
  return [
    pivot[0] + vx*ct + crossx*st + ax*dot*(1-ct),
    pivot[1] + vy*ct + crossy*st + ay*dot*(1-ct),
    pivot[2] + vz*ct + crossz*st + az*dot*(1-ct),
  ];
}

export function reattachFusedPiecesFromSolo(pos, groups, graph) {
  if (!groups || !groups.length) return;
  for (const g of groups) {
    if (!g.anchorLocalIds || !g.anchorLocalIds.length || !g.idMap) continue;

    // Graft pieces (have ringIds - the full body round the anchor
    // stitches sit in) get a fundamentally different placement than a
    // fuse leg: NO forced far-point translation at all. Instead:
    // 1. Fit using ONLY the real seam correspondence, so the piece keeps
    //    whatever its own natural angle relative to the seam already is -
    //    the point of connection stays exactly as-is, nothing forced on
    //    top of it beyond a deliberate lean (below).
    // 2. A fold seam is a straight line, so fitting ONLY that
    //    correspondence barely constrains one whole rotational degree of
    //    freedom: spinning the piece around its own hinge line leaves
    //    those seam points in almost the same place either way. Fix that
    //    free spin explicitly: apply a lean of DEFAULT_GRAFT_ANGLE_DEG
    //    (or graft:name@angle if given) around the hinge, away from
    //    straight-down. A geometry-driven clearance search was tried here
    //    and removed - it was technically correct but could demand a very
    //    large, worse-looking rotation just to guarantee strict clearance
    //    along a piece's ENTIRE length near crowded geometry, which isn't
    //    the same thing as "looks naturally attached." A fixed default
    //    plus a manual per-graft override is simpler and more predictable.
    if (g.ringIds && g.ringIds.length) {
      const srcPts = g.anchorLocalIds.map(id => [g.soloPos[id*3], g.soloPos[id*3+1], g.soloPos[id*3+2]]);
      const dstPts = g.anchorMergedIds.map(id => [pos[id*3], pos[id*3+1], pos[id*3+2]]);
      const t = bestFitRigidTransform(srcPts, dstPts);
      if (!t) continue;

      const pieceLocalIds = [...g.idMap.keys()];
      let piecePos = pieceLocalIds.map(localId => applyRigidTransform(g.soloPos[localId*3], g.soloPos[localId*3+1], g.soloPos[localId*3+2], t));

      const pivot = [pos[g.anchorMergedIds[0]*3], pos[g.anchorMergedIds[0]*3+1], pos[g.anchorMergedIds[0]*3+2]];
      const otherEnd = g.anchorMergedIds[g.anchorMergedIds.length-1];
      let ax = pos[otherEnd*3]-pivot[0], ay = pos[otherEnd*3+1]-pivot[1], az = pos[otherEnd*3+2]-pivot[2];
      const alen = Math.hypot(ax,ay,az) || 1;
      ax/=alen; ay/=alen; az/=alen;

      // Point the piece's own far end (soloFarLocalIds - its tip, opposite
      // the seam) straight down (-Y) first, same convention a fuse leg
      // hangs by - this resolves the free-spin ambiguity above
      // deterministically before the lean is applied on top of it. Only
      // the component of "down" and of the far end's current direction
      // that's perpendicular to the hinge axis matters - spinning around
      // the axis can't change how far along the axis itself anything
      // sits, only how it's arranged around it.
      if (g.soloFarLocalIds && g.soloFarLocalIds.length) {
        const idxOfLocal = new Map(pieceLocalIds.map((id,i)=>[id,i]));
        let fx=0, fy=0, fz=0, fCount=0;
        for (const localId of g.soloFarLocalIds) {
          const i = idxOfLocal.get(localId);
          if (i === undefined) continue;
          fx += piecePos[i][0]; fy += piecePos[i][1]; fz += piecePos[i][2]; fCount++;
        }
        if (fCount) {
          fx/=fCount; fy/=fCount; fz/=fCount;
          let vx = fx-pivot[0], vy = fy-pivot[1], vz = fz-pivot[2];
          const vAxisDot = vx*ax+vy*ay+vz*az;
          let vpx = vx-vAxisDot*ax, vpy = vy-vAxisDot*ay, vpz = vz-vAxisDot*az;
          const vpLen = Math.hypot(vpx,vpy,vpz);
          const downAxisDot = -ay; // (0,-1,0)·axis
          let dpx = -downAxisDot*ax, dpy = -1-downAxisDot*ay, dpz = -downAxisDot*az;
          const dpLen = Math.hypot(dpx,dpy,dpz);
          if (vpLen > 1e-6 && dpLen > 1e-6) {
            vpx/=vpLen; vpy/=vpLen; vpz/=vpLen;
            dpx/=dpLen; dpy/=dpLen; dpz/=dpLen;
            const cosA = vpx*dpx+vpy*dpy+vpz*dpz;
            const crossx = vpy*dpz-vpz*dpy, crossy = vpz*dpx-vpx*dpz, crossz = vpx*dpy-vpy*dpx;
            const sinA = crossx*ax+crossy*ay+crossz*az;
            const hangAngle = Math.atan2(sinA, cosA);
            piecePos = piecePos.map(p => rotatePointAroundAxis(p, pivot, [ax,ay,az], hangAngle));
          }
        }
      }

      // This round comes straight from the piece's own solo round
      // structure (graftPieceGroups' nearSeamLocalIds, set alongside the
      // seam itself in compileGraph) - the row right next to the
      // attachment sits close to the body by construction, the same way
      // a real crocheted join's very next row naturally hugs close to
      // whatever it's sewn onto.
      const nearSeamLocalSet = new Set(g.nearSeamLocalIds || []);
      // The bend shouldn't pivot the whole piece rigidly from an axis
      // sitting right at the attachment (that reads as a stiff hinge
      // kinking right at the base) - only the piece BEYOND this row
      // actually leans; this row stays put and the curvature-conform
      // relax afterward bridges the two smoothly.
      const rotateExceptNearSeam = (pts, theta) => pts.map((p, i) => {
        const localId = pieceLocalIds[i];
        if (localId != null && nearSeamLocalSet.has(localId)) return p;
        return rotatePointAroundAxis(p, pivot, [ax,ay,az], theta);
      });

      const angleDeg = g.angleOverride != null ? g.angleOverride : DEFAULT_GRAFT_ANGLE_DEG;
      const theta = angleDeg * Math.PI / 180;
      if (theta !== 0) piecePos = rotateExceptNearSeam(piecePos, theta);

      for (let i = 0; i < pieceLocalIds.length; i++) {
        const mergedId = g.idMap.get(pieceLocalIds[i]);
        pos[mergedId*3] = piecePos[i][0]; pos[mergedId*3+1] = piecePos[i][1]; pos[mergedId*3+2] = piecePos[i][2];
      }

      // Curvature-conform: pin the seam nodes to the body's exact stitch
      // positions (the fit above is only best-effort - the piece's own
      // closing seam and the body's real stitches here are rarely
      // perfectly isometric) and let ONLY the single round immediately
      // touching the seam relax to accommodate that mismatch - pinning
      // everything else in the piece (not just its two ends) matters,
      // since otherwise the interior rounds are still free to sag toward
      // whatever low-energy shape the springs prefer, which can swing
      // back through the body despite both ends being individually
      // correct. (With this fold-axis scheme every seam node is its own
      // new point rather than reused from the ring, so the seam's own ids
      // and the near-seam round no longer overlap in practice - but the
      // filter below stays generic, so any shared points would still stay
      // exactly where they were just snapped to.)
      if (graph) {
        const pinnedMergedIds = [];
        const ownSeamMergedIdSet = new Set();
        for (let i = 0; i < g.anchorLocalIds.length; i++) {
          const mergedId = g.idMap.get(g.anchorLocalIds[i]);
          const bodyId = g.anchorMergedIds[i];
          pos[mergedId*3] = pos[bodyId*3]; pos[mergedId*3+1] = pos[bodyId*3+1]; pos[mergedId*3+2] = pos[bodyId*3+2];
          pinnedMergedIds.push(mergedId);
          ownSeamMergedIdSet.add(mergedId);
        }
        const allPieceMergedIds = [...g.idMap.values()];
        const nearSeamMergedIds = new Set();
        for (const localId of nearSeamLocalSet) { const mid = g.idMap.get(localId); if (mid != null) nearSeamMergedIds.add(mid); }
        const trulyFreeToRelax = new Set([...nearSeamMergedIds].filter(id => !ownSeamMergedIdSet.has(id)));
        const finalPinned = allPieceMergedIds.filter(id => !trulyFreeToRelax.has(id));
        relaxPieceAroundPinned(pos, graph, allPieceMergedIds, finalPinned, 60);
      }
      continue;
    }

    // The 16 ring points alone don't fully pin down the fit: a flat, close
    // to regular ring has an approximate mirror symmetry through its own
    // plane, so a rotation that flips which way the rest of the piece
    // extends can fit those 16 correspondences almost as well as the
    // correct one. Fixing this needs one more correspondence: the piece's
    // own far end (e.g. a leg's toe) matched to wherever majorization
    // already left it. A point that far from the ring carries a large
    // lever arm in the least-squares fit, so even an approximate hint from
    // it is enough to break the tie in favor of the correct orientation,
    // while the 16 exact ring correspondences still dominate the fit's
    // actual precision.
    let farSrc = null, farDst = null;
    if (g.soloFarLocalIds && g.soloFarLocalIds.length) {
      let sx=0,sy=0,sz=0;
      for (const id of g.soloFarLocalIds) { sx+=g.soloPos[id*3]; sy+=g.soloPos[id*3+1]; sz+=g.soloPos[id*3+2]; }
      const m = g.soloFarLocalIds.length;
      sx/=m; sy/=m; sz/=m;
      let rcx=0, rcy=0, rcz=0;
      for (const id of g.anchorLocalIds) { rcx+=g.soloPos[id*3]; rcy+=g.soloPos[id*3+1]; rcz+=g.soloPos[id*3+2]; }
      rcx/=g.anchorLocalIds.length; rcy/=g.anchorLocalIds.length; rcz/=g.anchorLocalIds.length;
      const hangDist = Math.abs(sy - rcy) || 1;
      let mrcx=0, mrcy=0, mrcz=0;
      for (const id of g.anchorMergedIds) { mrcx+=pos[id*3]; mrcy+=pos[id*3+1]; mrcz+=pos[id*3+2]; }
      mrcx/=g.anchorMergedIds.length; mrcy/=g.anchorMergedIds.length; mrcz/=g.anchorMergedIds.length;
      farSrc = Array(24).fill([sx,sy,sz]);
      farDst = Array(24).fill([mrcx, mrcy - hangDist, mrcz]);
    }
    const srcPts = g.anchorLocalIds.map(id => [g.soloPos[id*3], g.soloPos[id*3+1], g.soloPos[id*3+2]]);
    const dstPts = g.anchorMergedIds.map(id => [pos[id*3], pos[id*3+1], pos[id*3+2]]);
    if (farSrc) { for (let k=0;k<farSrc.length;k++){ srcPts.push(farSrc[k]); dstPts.push(farDst[k]); } }
    let t = bestFitRigidTransform(srcPts, dstPts);
    if (!t) continue;

    const anchorSet = new Set(g.anchorMergedIds);
    for (const [localId, mergedId] of g.idMap) {
      if (anchorSet.has(mergedId)) continue;
      const [x, y, z] = applyRigidTransform(g.soloPos[localId*3], g.soloPos[localId*3+1], g.soloPos[localId*3+2], t);
      pos[mergedId*3] = x; pos[mergedId*3+1] = y; pos[mergedId*3+2] = z;
    }
  }
}

// MOUNT: post-solve placement for mount: directives (see compileGraph's
// mountPieceGroups) - eyes, ears, limbs sewn onto an existing stitch after
// the body is otherwise finished. Structurally closer to graft than fuse (a
// fully-solved, closed piece positioned rigidly and never sharing graph
// edges with the body) but graft's placement math assumes a whole SHARED
// SEAM (two rounds of matching stitch counts, a real hinge line). Mount has
// no such correspondence - just a single named stitch - so it needs its own
// three-part pipeline: (1) orient the piece by its own growth axis against
// either the body's outward surface normal there (a protruding piece - a
// limb) or the local row-tangent direction (a flat piece - an ear/patch,
// detected the same way the rest of this app already tells flat pieces
// apart: they end in a fold/scclose round); (2) resolve the one rotational
// degree of freedom that orienting alone can't fix (same free-spin problem
// graft's hang-down correction solves, just with a different target vector
// per mode); (3) walk the piece's attach-ring points out from the anchor,
// each one sampling the body's local surface near wherever its already-
// placed neighbor just landed, so curvature genuinely propagates around the
// ring instead of every point independently guessing at the same patch -
// then hand the resulting pinned ring to relaxPieceAroundPinned (identical
// cleanup step graft's own seam gets) to settle the rest of the piece.

// BFS out from `startId` along real graph edges, up to `hops` rings,
// collecting body node ids only (round < graph.ownRoundCount - so an
// already-placed graft/mount piece's own nodes, or a LATER mount's, never
// leak into this patch; each mount's own nodes aren't part of "the body"
// for this purpose regardless of processing order). Cheap stand-in for a
// real spatial index - the body mesh is already a graph, so "nearby on the
// surface" is just "nearby in hops" here.
function bfsBodyPatch(graph, startId, hops) {
  const seen = new Set([startId]);
  let frontier = [startId];
  const ownLimit = graph.ownRoundCount;
  const isBody = (id) => {
    const nd = graph.nodeData[id];
    return nd && nd.kind === 'top' && nd.round != null && nd.round < ownLimit;
  };
  for (let h = 0; h < hops && frontier.length; h++) {
    const next = [];
    for (const id of frontier) {
      for (const [nb] of graph.adjList[id]) {
        if (seen.has(nb) || !isBody(nb)) continue;
        seen.add(nb); next.push(nb);
      }
    }
    frontier = next;
  }
  return [...seen];
}

// The body's own local outward-facing normal near a mount anchor: best-fit
// plane through the surrounding patch, sign-corrected to point away from
// the anchor's OWN ROUND's centroid (not the whole body's centroid, and not
// a wide BFS patch - see below).
function bodyOutwardNormalAt(pos, anchorId, patchIds, graph) {
  const {cx, cy, cz, nx, ny, nz} = bestFitNormal(pos, patchIds);
  // Two things were tried here before and both were wrong in opposite
  // directions. Sign-disambiguating against the WHOLE body's centroid only
  // works for a body that's genuinely one blob around its own middle - the
  // moment there's a neck, a waist, or any other pinch between two lobes, it
  // breaks down right at that pinch, because the global average sits
  // wherever the two lobes' combined mass happens to land, not anywhere on
  // the surface itself. Growing a WIDE patch (many hops) out from the
  // anchor along the mesh was the next attempt, reasoning that a BFS walk
  // can't shortcut across a narrow neck the way a straight line to a
  // far-off centroid can - true, but on a dense round (a mount stitch every
  // single position) even a modest hop count spreads sideways fast enough
  // to wander into neighboring rows or across the ring's own curvature,
  // making the "center" it lands on just as arbitrary and noisy as the
  // global centroid was, for a different reason.
  //
  // The actual fix needs no walk and no hop count at all: the anchor stitch
  // already belongs to a specific round, and that round's own centroid IS
  // the true local center of the tube at that exact height - it can't cross
  // a pinch (it never includes another round) and it isn't diluted by mesh
  // density (it's always exactly one ring's worth of points, regardless of
  // how many mounts are attached along it).
  const anchorRound = graph.nodeData[anchorId].round;
  const ring = (anchorRound != null && graph.roundNodes[anchorRound]) ? graph.roundNodes[anchorRound] : patchIds;
  let rx=0, ry=0, rz=0;
  for (const id of ring) { rx+=pos[id*3]; ry+=pos[id*3+1]; rz+=pos[id*3+2]; }
  rx/=ring.length; ry/=ring.length; rz/=ring.length;
  const vx = pos[anchorId*3]-rx, vy = pos[anchorId*3+1]-ry, vz = pos[anchorId*3+2]-rz;
  const dot = nx*vx+ny*vy+nz*vz;
  return dot < 0 ? [-nx,-ny,-nz] : [nx,ny,nz];
}

function computeBodyCentroid(pos, graph) {
  let sx=0, sy=0, sz=0, n=0;
  for (let ri = 0; ri < graph.ownRoundCount; ri++) {
    for (const id of graph.roundNodes[ri]) { sx+=pos[id*3]; sy+=pos[id*3+1]; sz+=pos[id*3+2]; n++; }
  }
  return n ? [sx/n, sy/n, sz/n] : [0,0,0];
}

// The direction a flat mount (an ear, a patch) should lay its own long axis
// along - the body's row direction right at the anchor stitch, so a flat
// piece's spine follows the same curve a real row of stitches there does,
// rather than an arbitrary in-plane direction.
function rowTangentAt(pos, graph, targetRi, stitchIdx) {
  const ring = graph.roundNodes[targetRi];
  const n = ring.length;
  const prevId = ring[(stitchIdx - 1 + n) % n];
  const nextId = ring[(stitchIdx + 1) % n];
  const dx = pos[nextId*3]-pos[prevId*3], dy = pos[nextId*3+1]-pos[prevId*3+1], dz = pos[nextId*3+2]-pos[prevId*3+2];
  const len = Math.hypot(dx,dy,dz) || 1;
  return [dx/len, dy/len, dz/len];
}

// A mounted piece's own growth axis, in its own solo/local coordinate space:
// best-fit plane through its attach ring (the round it's mounted BY),
// sign-corrected so the axis points FROM that ring TOWARD the piece's own
// far tip (round 0 - typically its MR start). This is the opposite sign
// convention from ringPlacement's fuse-leg axis (which wants round0 -> the
// connecting round, "climbing into the join") because mount cares which way
// the piece PROTRUDES away from its attachment, not which way it climbs
// toward it.
function pieceProtrusionAxis(soloPos, soloGraph, attachLocalIds) {
  const pre = bestFitNormal(soloPos, attachLocalIds);
  let axisDir = [pre.nx, pre.ny, pre.nz];
  const round0 = soloGraph.roundNodes[0];
  let r0x=0, r0y=0, r0z=0;
  for (const id of round0) { r0x+=soloPos[id*3]; r0y+=soloPos[id*3+1]; r0z+=soloPos[id*3+2]; }
  r0x/=round0.length; r0y/=round0.length; r0z/=round0.length;
  const gx = r0x-pre.cx, gy = r0y-pre.cy, gz = r0z-pre.cz;
  if (axisDir[0]*gx+axisDir[1]*gy+axisDir[2]*gz < 0) axisDir = [-axisDir[0],-axisDir[1],-axisDir[2]];
  return {axisDir, centroid: [pre.cx, pre.cy, pre.cz]};
}

// A FLAT mounted piece's own long axis - unlike pieceProtrusionAxis (which
// uses the attach ring's own plane-normal - correct for a tube, where the
// ring is a cross-section and the tube runs perpendicular to it), a
// flattened piece's length runs WITHIN its own flattened plane, not
// perpendicular to it. Once flattenHorizontal has pinched the attach ring
// down to a near-line, its "plane normal" barely means anything as a
// direction toward the tip anymore. The actual spine direction is just
// straight from the (flattened) attach ring's centroid to the (flattened)
// round 0/tip's centroid - simpler, and it's what's actually true of a
// pressed-flat piece's shape.
function pieceFlatAxis(flatPos, soloGraph, attachLocalIds) {
  let cx=0, cy=0, cz=0;
  for (const id of attachLocalIds) { cx+=flatPos[id*3]; cy+=flatPos[id*3+1]; cz+=flatPos[id*3+2]; }
  cx/=attachLocalIds.length; cy/=attachLocalIds.length; cz/=attachLocalIds.length;
  const round0 = soloGraph.roundNodes[0];
  let tx=0, ty=0, tz=0;
  for (const id of round0) { tx+=flatPos[id*3]; ty+=flatPos[id*3+1]; tz+=flatPos[id*3+2]; }
  tx/=round0.length; ty/=round0.length; tz/=round0.length;
  const dx=tx-cx, dy=ty-cy, dz=tz-cz;
  const len = Math.hypot(dx,dy,dz) || 1;
  return {axisDir: [dx/len, dy/len, dz/len], centroid: [cx, cy, cz]};
}

// Signed rotation angle (radians) around `axis` that takes `curVec` onto
// `targetVec`, measured only in the plane perpendicular to axis (same math
// reattachFusedPiecesFromSolo's hang-down correction uses, generalized to an
// arbitrary target instead of always "straight down") - used below both for
// a tube mount's hang-down and a flat mount's face-normal alignment, since
// both are really the same problem: one remaining spin needs to match one
// vector onto another around a fixed axis.
function spinAngleBetween(axis, curVec, targetVec) {
  const [ax, ay, az] = axis;
  let [vx, vy, vz] = curVec;
  const vAxisDot = vx*ax+vy*ay+vz*az;
  let vpx = vx-vAxisDot*ax, vpy = vy-vAxisDot*ay, vpz = vz-vAxisDot*az;
  const vpLen = Math.hypot(vpx,vpy,vpz);
  let [tx, ty, tz] = targetVec;
  const tAxisDot = tx*ax+ty*ay+tz*az;
  let tpx = tx-tAxisDot*ax, tpy = ty-tAxisDot*ay, tpz = tz-tAxisDot*az;
  const tpLen = Math.hypot(tpx,tpy,tpz);
  if (vpLen < 1e-6 || tpLen < 1e-6) return 0;
  vpx/=vpLen; vpy/=vpLen; vpz/=vpLen;
  tpx/=tpLen; tpy/=tpLen; tpz/=tpLen;
  const cosA = vpx*tpx+vpy*tpy+vpz*tpz;
  const crossx = vpy*tpz-vpz*tpy, crossy = vpz*tpx-vpx*tpz, crossz = vpx*tpy-vpy*tpx;
  const sinA = crossx*ax+crossy*ay+crossz*az;
  return Math.atan2(sinA, cosA);
}

export function reattachMountedPiecesFromSolo(pos, groups, graph, yarnR = 0.38) {
  if (!groups || !groups.length) return;
  // yarnR: same source flattenHorizontal's own call sites already use
  for (const g of groups) {
    const soloGraph = g.soloGraph;
    // No more auto-detection of FLATNESS: "ends in fold/scclose" turned out
    // to be an unreliable signal for that in both directions (a limb's tip
    // is routinely scclosed just to sew it shut - nothing to do with
    // flatness; a small rounded piece like this one also often ends that
    // way just to close it off). Flat vs tube is explicit now - !flat/
    // !tube, tube by default.
    //
    // Fold-seam pieces are a separate question from flat-vs-tube, though:
    // if the attach round ITSELF is a fold/scclose round, that's not a
    // guess about the piece's overall shape - it's a structural fact about
    // this one round (it's an open seam row, built and solved that way,
    // same as graft's own seam - see foldRoundSet). A piece attached by
    // such a round should be placed the way graft places its seam: hinge
    // it, don't spin it rigidly from a single point.
    const isFoldSeam = !!g.isFoldSeam;
    // isFlat used to be forced false whenever isFoldSeam was true, on the
    // reasoning that a fold/scclose piece is "already flat" at its seam.
    // That's true of the seam ROUND itself (foldRounds/hardFlattenRounds
    // already presses that one ring flat, both here and at solve time via
    // flattenFoldRounds), but it says nothing about the REST of the piece -
    // an ear2-style piece's rounds before the fold are still an ordinary
    // round lump, exactly like arm2's are, and stay that way unless
    // flattenHorizontal actually runs on them too. So !flat now means the
    // same thing for every piece: run the ring-pinching pass. isFoldSeam is
    // now purely about which PLACEMENT pipeline runs (seam-axis vs
    // protrusion-axis / flat-axis), completely independent of whether
    // flattening happened - the two questions were conflated by sharing one
    // flag before, but they're orthogonal: a fold-seam piece can mount via
    // its seam axis AND still have its body pressed flat if asked.
    const isFlat = g.modeOverride === 'flat';
    // Flat mode means what the Flatten VIEW toggle means: actually press the
    // piece's own rounds flat (flattenHorizontal - pinch every plain ring
    // ring-by-ring, preserving the spine's own curve) rather than just
    // orienting the piece differently. Without this, forcing !flat on an
    // ordinary round piece (no fold:/scclose of its own) only changes which
    // way it points, not whether it's actually flat - it'd still read as a
    // stubby 3D lump, just tilted. Rounds already flat by construction
    // (fold/scclose/chain-foundation) are left alone by flattenHorizontal
    // itself, so this is safe to run even on a piece that's already partly
    // flat. Tube mode never touches this - the raw solo geometry is exactly
    // what should protrude. Fold-seam pieces CAN combine with this now too:
    // isFoldSeam still controls placement (seam-axis, hinge-lean), but if
    // !flat is also set, the piece's own body rounds get pressed flat first,
    // same as any other piece - the two are independent (see note above).
    const basePos = isFlat
      ? flattenHorizontal(g.soloPos, soloGraph.roundNodes, soloGraph.isFlatPiece, soloGraph.chainFoundationRound, soloGraph.chainOvalRound, soloGraph.foldRounds, yarnR, soloGraph.adjList, soloGraph.N, soloGraph.hubOf, soloGraph.flapRounds)
      : g.soloPos;

    // Span mount (mount:name,rN:S-rM:T)
    // The piece's own seam has a real point-for-point correspondence to
    // lay against (its N seam stitches, in order, onto the N body nodes
    // compileGraph's BFS found along the shortest path between the two
    // given anchors - see spanPathIds), so the fit itself is a rigid
    // Horn's-quaternion fit, same technique graft already uses for its
    // own exact seam match.
    //
    // But that fit alone isn't fully determined, and this was the actual
    // bug: a fold/scclose seam is a nearly-STRAIGHT line of stitches (see
    // flattenFoldRounds - that's the whole point of pressing it flat), and
    // Horn's method has no real leverage on the rotation AROUND that
    // line's own axis when the correspondence points are this close to
    // collinear - it's the same "one remaining spin ambiguity" every other
    // placement in this file already has to resolve explicitly (graft's
    // hang-down correction, single-point mount's face-match spin), just
    // arrived at from a different direction here. Left unresolved, that
    // spin comes out however tiny numerical noise happens to land it -
    // which is exactly why the piece's own body (everything beyond the
    // seam) was flying off in an uncontrolled direction, @angle appeared
    // to do nothing, and flip (previously implemented as reversing which
    // end of the seam maps to which anchor - a totally different,
    // correspondence-changing operation) looked like a random lurch
    // instead of a clean swap.
    //
    // Fixed the same way as everywhere else: resolve that leftover spin
    // deterministically first (piece's own far tip - its round 0 - faces
    // the body's local outward normal at the seam, same "protrude away
    // from the surface" default tube mode already uses), THEN let @angle
    // lean further around that same seam axis (same convention single-
    // point fold-seam mount already uses via nearSeamLocalIds), and make
    // flip an actual mirror - reflecting across the plane spanned by the
    // seam axis and the outward normal, through the seam - so it swaps
    // which face of the piece touches the body without touching the
    // seam's own path correspondence at all.
    if (g.spanPathIds) {
      const seamOrder = g.attachLocalIds; // correspondence is fixed - flip no longer reverses it, see above
      const srcPts = seamOrder.map(id => [basePos[id*3], basePos[id*3+1], basePos[id*3+2]]);
      const dstPts = g.spanPathIds.map(id => [pos[id*3], pos[id*3+1], pos[id*3+2]]);
      const t = bestFitRigidTransform(srcPts, dstPts);
      if (!t) continue;
      const pieceLocalIds = [...g.idMap.keys()];
      let piecePos = new Float64Array(pieceLocalIds.length * 3);
      const idxOfLocal = new Map(pieceLocalIds.map((id,i)=>[id,i]));
      for (const localId of pieceLocalIds) {
        const i = idxOfLocal.get(localId);
        const [x, y, z] = applyRigidTransform(basePos[localId*3], basePos[localId*3+1], basePos[localId*3+2], t);
        piecePos[i*3]=x; piecePos[i*3+1]=y; piecePos[i*3+2]=z;
      }

      // Seam axis: the straight line the (near-collinear) seam runs along,
      // taken directly from the path's own two ends in the already-solved
      // body - this is the axis the leftover spin/lean/flip all pivot
      // around.
      const pivot = [pos[g.spanPathIds[0]*3], pos[g.spanPathIds[0]*3+1], pos[g.spanPathIds[0]*3+2]];
      const farEnd = [pos[g.spanPathIds[g.spanPathIds.length-1]*3], pos[g.spanPathIds[g.spanPathIds.length-1]*3+1], pos[g.spanPathIds[g.spanPathIds.length-1]*3+2]];
      let ax = farEnd[0]-pivot[0], ay = farEnd[1]-pivot[1], az = farEnd[2]-pivot[2];
      const alen = Math.hypot(ax,ay,az) || 1;
      ax/=alen; ay/=alen; az/=alen;

      // Default facing: point the piece's own far tip (round 0) outward
      // from the body's local surface at the seam, same reference tube
      // mode already uses for a single-point mount.
      let patchIds2 = bfsBodyPatch(graph, g.anchorMergedId, 4);
      if (patchIds2.length < 6) patchIds2 = [...new Set([...patchIds2, ...g.spanPathIds])];
      const outward2 = bodyOutwardNormalAt(pos, g.anchorMergedId, patchIds2, graph);

      if (soloGraph.roundNodes[0] && soloGraph.roundNodes[0].length) {
        let fx=0, fy=0, fz=0, fCount=0;
        for (const localId of soloGraph.roundNodes[0]) {
          const i = idxOfLocal.get(localId);
          if (i === undefined) continue;
          fx += piecePos[i*3]; fy += piecePos[i*3+1]; fz += piecePos[i*3+2]; fCount++;
        }
        if (fCount) {
          fx/=fCount; fy/=fCount; fz/=fCount;
          const curVec = [fx-pivot[0], fy-pivot[1], fz-pivot[2]];
          const theta = spinAngleBetween([ax,ay,az], curVec, outward2);
          if (theta) {
            for (let i = 0; i < pieceLocalIds.length; i++) {
              const p = rotatePointAroundAxis([piecePos[i*3],piecePos[i*3+1],piecePos[i*3+2]], pivot, [ax,ay,az], theta);
              piecePos[i*3]=p[0]; piecePos[i*3+1]=p[1]; piecePos[i*3+2]=p[2];
            }
          }
        }
      }

      // @angle: an additional lean around the same seam axis, on top of
      // the outward-facing default - identical convention to single-point
      // fold-seam mount's own lean (see canLean/leanTheta further down),
      // just reusing this branch's own axis/pivot instead of recomputing
      // them. The round right next to the seam (nearSeamLocalIds) is left
      // out of the rotation so the lean starts a little way into the
      // piece rather than kinking right at the attachment.
      if (g.angleOverride != null && g.nearSeamLocalIds && g.nearSeamLocalIds.length) {
        const leanTheta = g.angleOverride * Math.PI / 180;
        if (leanTheta) {
          const nearSeamSet = new Set(g.nearSeamLocalIds);
          for (let i = 0; i < pieceLocalIds.length; i++) {
            if (nearSeamSet.has(pieceLocalIds[i])) continue;
            const p = rotatePointAroundAxis([piecePos[i*3],piecePos[i*3+1],piecePos[i*3+2]], pivot, [ax,ay,az], leanTheta);
            piecePos[i*3]=p[0]; piecePos[i*3+1]=p[1]; piecePos[i*3+2]=p[2];
          }
        }
      }

      // Flip: a genuine mirror now, not a correspondence reversal - swaps
      // which face of the (nearly-flat) piece touches the body vs faces
      // out, same reflection graft/single-point flat-mode flip already
      // use: across the plane spanned by the seam axis and the outward
      // normal, through the seam. The seam's own path correspondence
      // never changes, so this can't introduce the kind of large,
      // uncontrolled reorientation the old reverse-correspondence version did.
      if (g.flip) {
        let sx = ay*outward2[2]-az*outward2[1];
        let sy = az*outward2[0]-ax*outward2[2];
        let sz = ax*outward2[1]-ay*outward2[0];
        const sLen = Math.hypot(sx,sy,sz) || 1;
        sx/=sLen; sy/=sLen; sz/=sLen;
        for (let i = 0; i < pieceLocalIds.length; i++) {
          const dx = piecePos[i*3]-pivot[0], dy = piecePos[i*3+1]-pivot[1], dz = piecePos[i*3+2]-pivot[2];
          const d = dx*sx+dy*sy+dz*sz;
          piecePos[i*3]   -= 2*d*sx;
          piecePos[i*3+1] -= 2*d*sy;
          piecePos[i*3+2] -= 2*d*sz;
        }
      }

      for (const localId of pieceLocalIds) {
        const i = idxOfLocal.get(localId);
        const mergedId = g.idMap.get(localId);
        pos[mergedId*3]=piecePos[i*3]; pos[mergedId*3+1]=piecePos[i*3+1]; pos[mergedId*3+2]=piecePos[i*3+2];
      }

      // The rigid fit (and every rotation/reflection above) is least-
      // squares/best-effort, not exact - pin the seam stitches to their
      // real path counterparts exactly (same reasoning graft's own seam
      // pinning uses) and let the rest of the piece relax around that.
      const pinnedMergedIds = [];
      for (let i = 0; i < seamOrder.length; i++) {
        const mergedId = g.idMap.get(seamOrder[i]);
        const dst = g.spanPathIds[i];
        pos[mergedId*3] = pos[dst*3]; pos[mergedId*3+1] = pos[dst*3+1]; pos[mergedId*3+2] = pos[dst*3+2];
        pinnedMergedIds.push(mergedId);
      }
      relaxPieceAroundPinned(pos, graph, pieceLocalIds.map(l => g.idMap.get(l)), pinnedMergedIds, 60);
      continue;
    }

    let patchIds = bfsBodyPatch(graph, g.anchorMergedId, 4);
    if (patchIds.length < 6) patchIds = [...new Set([...patchIds, ...graph.roundNodes[g.targetRi]])]; // safety net for a sparse/small piece
    const outward = bodyOutwardNormalAt(pos, g.anchorMergedId, patchIds, graph);
    // A fold-seam piece's own seam line should follow the body's row
    // direction at the anchor, same reasoning as flat mode's spine (a real
    // sewn-on seam follows a row of stitches, not an arbitrary in-plane
    // direction).
    const targetDir = (isFlat || isFoldSeam) ? rowTangentAt(pos, graph, g.targetRi, g.targetStitchIdx) : outward;

    let axisDir, centroid;
    if (isFoldSeam) {
      // The seam round's own long axis, found directly from its points
      // rather than guessed from centroid-to-tip (pieceFlatAxis) or the
      // ring's plane-normal (pieceProtrusionAxis) - a fold/scclose round is
      // already collapsed to a near-line by construction (mirrored halves
      // meeting at a center), so its dominant PCA axis in local space IS
      // that line, robustly, regardless of how the rest of the piece
      // happens to be shaped.
      const attachPts = g.attachLocalIds.map(id => [basePos[id*3], basePos[id*3+1], basePos[id*3+2]]);
      const pca = pcaLargestAxis(attachPts);
      axisDir = pca.axis;
      centroid = [pca.cx, pca.cy, pca.cz];
      // pcaLargestAxis has no notion of "toward the body" vs "away from
      // it" - it just returns whichever of the axis's two directions its
      // eigensolve happens to settle on for this exact input, which is not
      // a stable convention: a tiny numerical nudge to the input (e.g. the
      // small drift flattenHorizontal's relax pass gives these seam nodes
      // even though it's not meant to move them - see the basePos comment
      // above) can flip it. rotateAxisOnto below aligns THIS axis onto
      // targetDir, so a flipped sign here doesn't just spin the piece
      // around targetDir (harmless) - it rotates the piece close to 180
      // degrees around a DIFFERENT axis, misorienting which way the body
      // actually hangs off the seam, before flip or @angle even apply.
      // Same fix pieceProtrusionAxis already uses for the same class of
      // ambiguity: pin the sign to something physically meaningful and
      // deterministic - here, "toward the rest of the piece", i.e. the
      // round just inside the seam (nearSeamLocalIds), falling back to the
      // piece's own far end (round 0) if that's ever unavailable.
      const bodyRef = (g.nearSeamLocalIds && g.nearSeamLocalIds.length) ? g.nearSeamLocalIds : soloGraph.roundNodes[0];
      let bx=0, by=0, bz=0;
      for (const id of bodyRef) { bx+=basePos[id*3]; by+=basePos[id*3+1]; bz+=basePos[id*3+2]; }
      bx/=bodyRef.length; by/=bodyRef.length; bz/=bodyRef.length;
      const gx = bx-pca.cx, gy = by-pca.cy, gz = bz-pca.cz;
      if (axisDir[0]*gx+axisDir[1]*gy+axisDir[2]*gz < 0) axisDir = [-axisDir[0],-axisDir[1],-axisDir[2]];
    } else if (isFlat) {
      ({axisDir, centroid} = pieceFlatAxis(basePos, soloGraph, g.attachLocalIds));
    } else {
      ({axisDir, centroid} = pieceProtrusionAxis(basePos, soloGraph, g.attachLocalIds));
    }

    // Rigid orientation: rotate a FRESH clone of the piece's (possibly now
    // flattened) shape - basePos is either the shared solvedLibrary copy
    // (tube mode) or a fresh array flattenHorizontal already returned
    // (flat mode), but either way it must never be mutated in place, since
    // the same piece could be mounted more than once, each at a different
    // spot - about its own attach-ring centroid so its protrusion axis lines
    // up with targetDir, then slide that same centroid onto the real anchor
    // stitch already sitting in the solved body.
    const piecePos = new Float64Array(basePos);
    rotateAxisOnto(piecePos, centroid, axisDir, targetDir);
    const anchorWorld = [pos[g.anchorMergedId*3], pos[g.anchorMergedId*3+1], pos[g.anchorMergedId*3+2]];
    const shiftX = anchorWorld[0]-centroid[0], shiftY = anchorWorld[1]-centroid[1], shiftZ = anchorWorld[2]-centroid[2];
    const pieceN = piecePos.length/3;
    for (let i = 0; i < pieceN; i++) { piecePos[i*3]+=shiftX; piecePos[i*3+1]+=shiftY; piecePos[i*3+2]+=shiftZ; }

    // Free spin around targetDir (through anchorWorld) - same ambiguity
    // graft's hang-down correction resolves, just a different target vector
    // per mode. Tube (a limb): hang the piece's own far tip (round 0) toward
    // -Y, same convention as a graft/fuse leg. Flat (an ear/patch): the long
    // axis is already fixed along the row tangent, so what's left is which
    // FACE points out - spin so the piece's own flat-normal (fit through
    // ALL its points, not just the attach ring) best matches the body's
    // true outward normal there.
    //
    // bestFitNormal's returned sign is whatever its Jacobi eigensolve
    // happens to settle on for that specific point cloud - not a stable
    // geometric convention, and NOT guaranteed to vary smoothly with small
    // changes to the input. Calling it here on piecePos (i.e. AFTER this
    // mount's own rotateAxisOnto has already turned the piece to face this
    // particular anchor) reruns that unstable eigensolve on a slightly
    // different point cloud at every single mount, so its sign can - and
    // did - flip unpredictably from one stitch to the next, flipping the
    // whole ear face-up vs face-down with no visible pattern (this is what
    // produced the up/down flips even after the earlier outward-normal fix,
    // which only ever affected the OTHER rotation, the one aiming the
    // piece's spine outward, not this one).
    //
    // The fix: call bestFitNormal exactly ONCE per piece, on g.soloPos -
    // the piece's own raw, never-flattened solved geometry, shared and
    // never mutated in place - so its sign is decided a single time and
    // can't vary between stitches, AND can't vary depending on whether
    // !flat happens to be set either. It has to be g.soloPos specifically,
    // not basePos: basePos IS the flattened copy when !flat is set, and a
    // flattened piece's own overall point cloud is a genuinely different
    // shape from its unflattened one - fitting a face-normal to each
    // separately answers "which way should this face" with two honestly
    // different vectors, which is exactly why toggling !flat kept visibly
    // re-orienting the piece even after the seam-round pinning fix above:
    // that fix made the SEAM's own position invariant, but this face-match
    // spin was still being computed from the WHOLE piece's shape, which
    // still isn't invariant. Flattening is meant to be a pure "press this
    // flat in place" operation, not a re-orientation - so the reference
    // this spin measures against has to come from the one shape that
    // never changes regardless of !flat: the piece's original solo solve.
    let theta = 0;
    if (isFlat || isFoldSeam) {
      const allIds = [...g.idMap.keys()];
      const localFace = bestFitNormal(g.soloPos, allIds);
      const face = rotateVectorOnto([localFace.nx, localFace.ny, localFace.nz], axisDir, targetDir);
      theta = spinAngleBetween(targetDir, face, outward);
    } else {
      const round0 = soloGraph.roundNodes[0];
      let fx=0, fy=0, fz=0;
      for (const id of round0) { fx+=piecePos[id*3]; fy+=piecePos[id*3+1]; fz+=piecePos[id*3+2]; }
      fx/=round0.length; fy/=round0.length; fz/=round0.length;
      const vx = fx-anchorWorld[0], vy = fy-anchorWorld[1], vz = fz-anchorWorld[2];
      theta = spinAngleBetween(targetDir, [vx,vy,vz], [0,-1,0]);
    }
    // For BOTH a fold-seam piece and a plain tube, @angle is now a
    // graft-style LEAN around a hinge (applied below), not a rigid spin of
    // the whole piece here - so it's kept out of theta entirely. For a
    // fold-seam this was already true (the seam's own hinge line IS
    // targetDir, so spinning theta around targetDir could never show the
    // lean anyway). For a tube it's newly true: targetDir there is the
    // piece's own long axis, and spinning a round tube around its own
    // length is invisible regardless of angle (see pieceProtrusionAxis) -
    // so a tube's @angle needs a hinge PERPENDICULAR to targetDir instead
    // (a real kick-forward/kick-back), not more of this same spin.
    // Tube mode still spins for flip - a limb has no spine/outward split to
    // mirror across (see below), so a 180 spin around targetDir (its own
    // long axis) remains the right "turn it over" move there.
    if (g.flip && !isFlat && !isFoldSeam) theta += Math.PI;
    if (theta !== 0) {
      for (let i = 0; i < pieceN; i++) {
        const p = rotatePointAroundAxis([piecePos[i*3],piecePos[i*3+1],piecePos[i*3+2]], anchorWorld, targetDir, theta);
        piecePos[i*3]=p[0]; piecePos[i*3+1]=p[1]; piecePos[i*3+2]=p[2];
      }
    }

    // Flip, for flat/fold-seam pieces, mirrors the piece across the plane
    // PERPENDICULAR to outward - through anchorWorld - which swaps the
    // two pinched layers a flattened fold/scclose piece is actually made
    // of (see flattenHorizontal/flattenFoldRounds: a folded round is two
    // layers pressed together and held ~2*yarnR apart). That's the real
    // "which face touches the body vs which faces away" swap - the thing
    // actually being asked for is "attach the OTHER layer instead", not a
    // left-right mirror of the piece's footprint. Mirroring across the
    // (targetDir, outward) plane instead (an earlier version of this) flips
    // left-right within the surface - a genuinely different operation that
    // also happens to move the footprint, which is why it looked like the
    // whole piece's position/orientation was changing rather than just
    // which side was attached. Reflecting across a plane that CONTAINS
    // targetDir and the piece's own sideways extent, with outward as the
    // mirror's normal, leaves the footprint exactly where it was and only
    // swaps inner/outer. Tube mode is untouched here: targetDir IS outward
    // there, so there's no separate "which layer" question - a round tube
    // has no inner/outer to swap, tube keeps the spin-based flip above.
    if (g.flip && (isFlat || isFoldSeam)) {
      for (let i = 0; i < pieceN; i++) {
        const dx = piecePos[i*3]-anchorWorld[0], dy = piecePos[i*3+1]-anchorWorld[1], dz = piecePos[i*3+2]-anchorWorld[2];
        const d = dx*outward[0]+dy*outward[1]+dz*outward[2];
        piecePos[i*3]   -= 2*d*outward[0];
        piecePos[i*3+1] -= 2*d*outward[1];
        piecePos[i*3+2] -= 2*d*outward[2];
      }
    }

    // Graft-style lean: pivot the piece around a hinge line through
    // anchorWorld by @angle, but leave the round right next to the
    // attachment (nearSeamLocalIds) UNROTATED - same reasoning as
    // reattachFusedPiecesFromSolo's rotateExceptNearSeam: pivoting the whole
    // piece rigidly from an axis sitting right at the attachment reads as a
    // stiff kink right at the base, whereas leaving the immediate next row
    // planted and letting the curvature-conform relax afterward bridge the
    // gap reads as a real lean starting a little way into the piece, the
    // same way a real sewn-on ear or limb would give at the seam itself.
    //
    // Which hinge axis depends on the piece's mode:
    //  - Fold-seam: the seam's own hinge line, targetDir - this is a real
    //    structural line (the seam round is already collapsed to it), so
    //    leaning around it is exactly right, same as before.
    //  - Tube: targetDir here is the limb's own LONG axis (tube mode sets
    //    targetDir = outward, see above), not a hinge - leaning "around" it
    //    would just be the same invisible pencil-spin theta already skips
    //    (see note above). A tube limb needs a hinge PERPENDICULAR to its
    //    own length instead, the way a real shoulder/hip joint bends a limb
    //    sideways rather than twisting it. Since targetDir===outward here,
    //    targetDir x outward is always the zero vector - can't use that.
    //    Need a genuinely different second direction: the body's own row
    //    tangent at the anchor stitch (same helper rowTangentAt already
    //    supplies for flat mode's spine) is perpendicular-ish to outward by
    //    construction (it runs ALONG the surface, not away from it), so
    //    targetDir x rowTangent gives a stable, real hinge line to kick
    //    around - 0deg leans the limb toward/away along the row direction,
    //    90deg swings it across it, all genuinely visible on a round tube.
    let leanAxis = targetDir;
    if (!isFoldSeam && !isFlat) {
      const rowTan = rowTangentAt(pos, graph, g.targetRi, g.targetStitchIdx);
      let hx = targetDir[1]*rowTan[2]-targetDir[2]*rowTan[1];
      let hy = targetDir[2]*rowTan[0]-targetDir[0]*rowTan[2];
      let hz = targetDir[0]*rowTan[1]-targetDir[1]*rowTan[0];
      const hLen = Math.hypot(hx,hy,hz);
      if (hLen > 1e-6) { hx/=hLen; hy/=hLen; hz/=hLen; leanAxis = [hx,hy,hz]; }
      // Degenerate case (targetDir ~parallel to the row tangent - rare):
      // fall back to spinning around targetDir rather than dividing by ~0;
      // better than doing nothing.
    }
    const canLean = isFoldSeam || !isFlat; // flat pieces keep their existing face-match handling, unaffected
    if (canLean && g.angleOverride != null && g.nearSeamLocalIds && g.nearSeamLocalIds.length) {
      const leanTheta = g.angleOverride * Math.PI / 180;
      if (leanTheta !== 0) {
        const nearSeamSet = new Set(g.nearSeamLocalIds);
        for (let i = 0; i < pieceN; i++) {
          if (nearSeamSet.has(i)) continue;
          const p = rotatePointAroundAxis([piecePos[i*3],piecePos[i*3+1],piecePos[i*3+2]], anchorWorld, leanAxis, leanTheta);
          piecePos[i*3]=p[0]; piecePos[i*3+1]=p[1]; piecePos[i*3+2]=p[2];
        }
      }
    }

    // Copy this piece's rigidly-placed shape into the real graph.
    const pieceLocalIds = [...g.idMap.keys()];
    for (const localId of pieceLocalIds) {
      const mergedId = g.idMap.get(localId);
      pos[mergedId*3]=piecePos[localId*3]; pos[mergedId*3+1]=piecePos[localId*3+1]; pos[mergedId*3+2]=piecePos[localId*3+2];
    }

    // Curvature-conform walk: start at the attach-ring point nearest the
    // anchor, then walk outward alternating both directions around the ring
    // (unzipping from the center, not marching one way) - each point's pin
    // target is an inverse-distance-weighted blend of the nearest few body
    // patch points to wherever its already-placed neighbor just landed, so
    // curvature genuinely accumulates around the ring instead of every point
    // independently sampling the same fixed neighborhood. Blended rather
    // than snapped outright, so the ring keeps its own real shape/spacing
    // instead of collapsing onto whichever body stitch happens to be
    // nearest. relaxPieceAroundPinned then settles everything BEHIND the
    // attach ring around these curved pins - identical cleanup step graft's
    // own seam gets.
    const attachMergedIds = g.attachLocalIds.map(localId => g.idMap.get(localId));
    const ringN = attachMergedIds.length;
    let startI = 0, bestD = Infinity;
    for (let i = 0; i < ringN; i++) {
      const id = attachMergedIds[i];
      const dx = pos[id*3]-anchorWorld[0], dy = pos[id*3+1]-anchorWorld[1], dz = pos[id*3+2]-anchorWorld[2];
      const d = dx*dx+dy*dy+dz*dz;
      if (d < bestD) { bestD = d; startI = i; }
    }
    const order = [startI];
    let lo = startI, hi = startI;
    for (let step = 1; step < ringN; step++) {
      if (step % 2 === 1) { hi = (hi+1) % ringN; order.push(hi); }
      else { lo = (lo-1+ringN) % ringN; order.push(lo); }
    }
    const pinnedMergedIds = [];
    let prevWorld = anchorWorld;
    for (const i of order) {
      const id = attachMergedIds[i];
      const cand = patchIds
        .map(pid => ({pid, d: Math.hypot(pos[pid*3]-prevWorld[0], pos[pid*3+1]-prevWorld[1], pos[pid*3+2]-prevWorld[2])}))
        .sort((a,b) => a.d-b.d).slice(0, 6);
      let wx=0, wy=0, wz=0, wsum=0;
      for (const c of cand) {
        const w = 1/(c.d+1e-4);
        wx += pos[c.pid*3]*w; wy += pos[c.pid*3+1]*w; wz += pos[c.pid*3+2]*w; wsum += w;
      }
      if (wsum > 0) {
        const blend = 0.6; // keeps the ring's own real spacing rather than collapsing onto the nearest body stitch outright
        pos[id*3]   = pos[id*3]  *(1-blend) + (wx/wsum)*blend;
        pos[id*3+1] = pos[id*3+1]*(1-blend) + (wy/wsum)*blend;
        pos[id*3+2] = pos[id*3+2]*(1-blend) + (wz/wsum)*blend;
      }
      pinnedMergedIds.push(id);
      prevWorld = [pos[id*3], pos[id*3+1], pos[id*3+2]];
    }

    relaxPieceAroundPinned(pos, graph, pieceLocalIds.map(l => g.idMap.get(l)), pinnedMergedIds, 60);
  }
}

// Least-squares rigid rotation+translation mapping srcPts onto dstPts given
// known point-for-point correspondence (Horn's closed-form quaternion
// method) - an exact solve for the best proper rotation (no reflection)
// given the pairing is already known. Power iteration on the 4x4 symmetric
// key matrix converges to its dominant eigenvector; Horn's method needs the
// MOST POSITIVE eigenvalue specifically (that's the one corresponding to a
// real rotation), so the matrix is shifted up by its Gershgorin bound first
// - shifting doesn't change eigenvectors, only guarantees the eigenvalue we
// want is now also the largest one, which is what plain power iteration
// actually finds.
function bestFitRigidTransform(srcPts, dstPts) {
  const n = srcPts.length;
  if (n < 3) return null;
  let scx=0,scy=0,scz=0, dcx=0,dcy=0,dcz=0;
  for (let i=0;i<n;i++){ scx+=srcPts[i][0]; scy+=srcPts[i][1]; scz+=srcPts[i][2]; dcx+=dstPts[i][0]; dcy+=dstPts[i][1]; dcz+=dstPts[i][2]; }
  scx/=n; scy/=n; scz/=n; dcx/=n; dcy/=n; dcz/=n;
  let Sxx=0,Sxy=0,Sxz=0,Syx=0,Syy=0,Syz=0,Szx=0,Szy=0,Szz=0;
  for (let i=0;i<n;i++) {
    const sx=srcPts[i][0]-scx, sy=srcPts[i][1]-scy, sz=srcPts[i][2]-scz;
    const dx=dstPts[i][0]-dcx, dy=dstPts[i][1]-dcy, dz=dstPts[i][2]-dcz;
    Sxx+=sx*dx; Sxy+=sx*dy; Sxz+=sx*dz;
    Syx+=sy*dx; Syy+=sy*dy; Syz+=sy*dz;
    Szx+=sz*dx; Szy+=sz*dy; Szz+=sz*dz;
  }
  const N = [
    [Sxx+Syy+Szz, Syz-Szy,      Szx-Sxz,      Sxy-Syx],
    [Syz-Szy,     Sxx-Syy-Szz,  Sxy+Syx,      Szx+Sxz],
    [Szx-Sxz,     Sxy+Syx,      -Sxx+Syy-Szz, Syz+Szy],
    [Sxy-Syx,     Szx+Sxz,      Syz+Szy,      -Sxx-Syy+Szz],
  ];
  let shift = 0;
  for (let i=0;i<4;i++) { let s=0; for (let j=0;j<4;j++) s+=Math.abs(N[i][j]); shift=Math.max(shift,s); }
  for (let i=0;i<4;i++) N[i][i]+=shift;
  let q = [1,0.37,0.19,0.11];
  for (let iter=0; iter<300; iter++) {
    const nq = [0,0,0,0];
    for (let i=0;i<4;i++) for (let j=0;j<4;j++) nq[i]+=N[i][j]*q[j];
    const len = Math.hypot(...nq) || 1;
    q = nq.map(v=>v/len);
  }
  const [w,x,y,z] = q;
  const R = [
    [1-2*(y*y+z*z), 2*(x*y-w*z),   2*(x*z+w*y)],
    [2*(x*y+w*z),   1-2*(x*x+z*z), 2*(y*z-w*x)],
    [2*(x*z-w*y),   2*(y*z+w*x),   1-2*(x*x+y*y)],
  ];
  return {R, srcCentroid:[scx,scy,scz], dstCentroid:[dcx,dcy,dcz]};
}
function applyRigidTransform(px, py, pz, t) {
  const {R, srcCentroid:sc, dstCentroid:dc} = t;
  const x=px-sc[0], y=py-sc[1], z=pz-sc[2];
  return [
    R[0][0]*x+R[0][1]*y+R[0][2]*z + dc[0],
    R[1][0]*x+R[1][1]*y+R[1][2]*z + dc[1],
    R[2][0]*x+R[2][1]*y+R[2][2]*z + dc[2],
  ];
}

function globalRealignFusedStructure(pos, graph) {
  if (!graph.fuseRoundLift || !graph.fuseRoundLift.size) return;
  const ownCount = graph.ownRoundCount ?? graph.roundNodes.length;
  if (ownCount < 2) return; // nothing built on top of the join yet - nothing to realign against
  const fuseRi = Math.min(...graph.fuseRoundLift.keys());
  const pivotIds = graph.roundNodes[fuseRi];
  const topIds = graph.roundNodes[ownCount - 1];
  if (!pivotIds || !pivotIds.length || !topIds || !topIds.length || pivotIds === topIds) return;

  let px=0, py=0, pz=0;
  for (const id of pivotIds) { px+=pos[id*3]; py+=pos[id*3+1]; pz+=pos[id*3+2]; }
  px/=pivotIds.length; py/=pivotIds.length; pz/=pivotIds.length;
  let tx=0, ty=0, tz=0;
  for (const id of topIds) { tx+=pos[id*3]; ty+=pos[id*3+1]; tz+=pos[id*3+2]; }
  tx/=topIds.length; ty/=topIds.length; tz/=topIds.length;

  let dx=tx-px, dy=ty-py, dz=tz-pz;
  const dlen = Math.hypot(dx,dy,dz);
  if (dlen < 1e-6) return;
  dx/=dlen; dy/=dlen; dz/=dlen;
  const targetX=0, targetY=1, targetZ=0;

  let ax = dy*targetZ - dz*targetY;
  let ay = dz*targetX - dx*targetZ;
  let az = dx*targetY - dy*targetX;
  const alen = Math.hypot(ax,ay,az);
  const cosT = dx*targetX + dy*targetY + dz*targetZ;
  if (alen < 1e-9) return;
  ax/=alen; ay/=alen; az/=alen;
  const theta = Math.atan2(alen, cosT);
  const ct = Math.cos(theta), st = Math.sin(theta);
  for (let id = 0; id < graph.N; id++) {
    const x = pos[id*3]-px, y = pos[id*3+1]-py, z = pos[id*3+2]-pz;
    const ndotp = ax*x+ay*y+az*z;
    const crossx = ay*z-az*y, crossy = az*x-ax*z, crossz = ax*y-ay*x;
    pos[id*3]   = x*ct + crossx*st + ax*ndotp*(1-ct) + px;
    pos[id*3+1] = y*ct + crossy*st + ay*ndotp*(1-ct) + py;
    pos[id*3+2] = z*ct + crossz*st + az*ndotp*(1-ct) + pz;
  }
}

export function projectOntoBestFitPlane(pos, ids, writeIds = ids) {
  // writeIds defaults to ids (fit-and-move every id, the original behavior).
  // Callers with a mix of free and hard-pinned nodes in `ids` (e.g. a fuse
  // join round, which is partly made of the imported legs' own rim tops)
  // should pass writeIds as ids minus the pinned subset - the plane is
  // still fit using every node's real position (so it isn't skewed by
  // excluding the pinned half), but only the free nodes actually get
  // written to. Without this split, this function silently overwrote
  // "pinned" nodes' positions itself, before the caller's own
  // relaxAroundPinned pinning step ever ran - which read as pinned legs
  // drifting by several units (see conversation: drift test on
  // fusedPinnedIds showed 242/242 nodes moved, max drift 8.08).
  if (!ids || ids.length < 3) return pos;

  let cx = 0, cy = 0, cz = 0;
  for (const id of ids) { cx += pos[id*3]; cy += pos[id*3+1]; cz += pos[id*3+2]; }
  cx /= ids.length; cy /= ids.length; cz /= ids.length;

  let xx=0,xy=0,xz=0,yy=0,yz=0,zz=0;
  for (const id of ids) {
    const dx = pos[id*3]-cx, dy = pos[id*3+1]-cy, dz = pos[id*3+2]-cz;
    xx += dx*dx; xy += dx*dy; xz += dx*dz;
    yy += dy*dy; yz += dy*dz; zz += dz*dz;
  }
  xx/=ids.length; xy/=ids.length; xz/=ids.length; yy/=ids.length; yz/=ids.length; zz/=ids.length;

  let a = [[xx,xy,xz],[xy,yy,yz],[xz,yz,zz]];
  let V = [[1,0,0],[0,1,0],[0,0,1]];
  for (let iter = 0; iter < 60; iter++) {
    let p = 0, q = 1, maxv = Math.abs(a[0][1]);
    if (Math.abs(a[0][2]) > maxv) { maxv = Math.abs(a[0][2]); p = 0; q = 2; }
    if (Math.abs(a[1][2]) > maxv) { maxv = Math.abs(a[1][2]); p = 1; q = 2; }
    if (maxv < 1e-12) break;
    const app = a[p][p], aqq = a[q][q], apq = a[p][q];
    const phi = 0.5 * Math.atan2(2*apq, aqq-app);
    const c = Math.cos(phi), s = Math.sin(phi);
    a[p][p] = c*c*app - 2*s*c*apq + s*s*aqq;
    a[q][q] = s*s*app + 2*s*c*apq + c*c*aqq;
    a[p][q] = 0; a[q][p] = 0;
    for (let i = 0; i < 3; i++) {
      if (i !== p && i !== q) {
        const aip = a[i][p], aiq = a[i][q];
        a[i][p] = c*aip - s*aiq; a[p][i] = a[i][p];
        a[i][q] = s*aip + c*aiq; a[q][i] = a[i][q];
      }
    }
    for (let i = 0; i < 3; i++) {
      const vip = V[i][p], viq = V[i][q];
      V[i][p] = c*vip - s*viq;
      V[i][q] = s*vip + c*viq;
    }
  }
  const vals = [a[0][0], a[1][1], a[2][2]];
  let minIdx = 0;
  if (vals[1] < vals[minIdx]) minIdx = 1;
  if (vals[2] < vals[minIdx]) minIdx = 2;
  let nx = V[0][minIdx], ny = V[1][minIdx], nz = V[2][minIdx];
  const nlen = Math.hypot(nx, ny, nz) || 1;
  nx /= nlen; ny /= nlen; nz /= nlen;

  for (const id of writeIds) {
    const dx = pos[id*3]-cx, dy = pos[id*3+1]-cy, dz = pos[id*3+2]-cz;
    const proj = dx*nx + dy*ny + dz*nz;
    pos[id*3]   -= proj*nx;
    pos[id*3+1] -= proj*ny;
    pos[id*3+2] -= proj*nz;
  }
  return pos;
}

// RADIUS-FLARE FIX (see conversation): a fused base is a dumbbell/oval, not
// a circle, right at the join round itself - that's physically correct and
// must NOT be forced circular (round 0 really is two leg rims stitched
// together, an actual figure-8 in cross-section). But the raw solve was
// found to carry an echo of that ovalness upward with almost no decay of
// its own - measured directly on a 3-round test piece: round 2's radius
// swung from 0.6 to 7.8 around a single ring, the same two-lobe shape as
// round 0, barely faded at all. The existing twist-fix pass above already
// corrects TILT (each round's plane) but was deliberately scoped to leave
// this - a separate, still-open problem - alone (see its own comment).
//
// Fix: for every own round above the join, blend each stitch's in-plane
// radius toward that ring's own average radius, with the blend weight
// ramping from 0 at the join itself (no correction - the ovalness there is
// real) up to 1 over RADIUS_FLARE_DECAY_ROUNDS rounds. That ramp constant
// mirrors the decay window already measured empirically earlier in this
// conversation for the same boundary effect on a DIFFERENT metric
// (y-amplitude fell from 0.19 to 0.07 over rounds 0-4) - reusing it here
// keeps both corrections fading out over one consistent, physically
// motivated span instead of inventing a second unrelated constant.
//
// Same fit-vs-write split as the pin-drift fix above: the ring's centroid,
// plane, and average radius are all computed from EVERY node in the ring
// (so pinned leg/bridge nodes still contribute to what "average" and
// "in-plane" mean), but only free (non-pinned) ids actually get moved.

export function circularizeRingRadius(pos, ring, writeIds, blendWeight) {
  if (!ring || ring.length < 4 || blendWeight <= 0) return pos;
  const n = ring.length;

  let cx=0, cy=0, cz=0;
  for (const id of ring) { cx+=pos[id*3]; cy+=pos[id*3+1]; cz+=pos[id*3+2]; }
  cx/=n; cy/=n; cz/=n;

  // Best-fit plane normal, same PCA approach as projectOntoBestFitPlane -
  // duplicated rather than shared since this needs the full basis (two
  // in-plane axes), not just the normal.
  let xx=0,xy=0,xz=0,yy=0,yz=0,zz=0;
  for (const id of ring) {
    const dx=pos[id*3]-cx, dy=pos[id*3+1]-cy, dz=pos[id*3+2]-cz;
    xx+=dx*dx; xy+=dx*dy; xz+=dx*dz; yy+=dy*dy; yz+=dy*dz; zz+=dz*dz;
  }
  xx/=n; xy/=n; xz/=n; yy/=n; yz/=n; zz/=n;
  let a = [[xx,xy,xz],[xy,yy,yz],[xz,yz,zz]];
  let V = [[1,0,0],[0,1,0],[0,0,1]];
  for (let iter=0; iter<60; iter++) {
    let p=0,q=1,maxv=Math.abs(a[0][1]);
    if (Math.abs(a[0][2])>maxv){maxv=Math.abs(a[0][2]);p=0;q=2;}
    if (Math.abs(a[1][2])>maxv){maxv=Math.abs(a[1][2]);p=1;q=2;}
    if (maxv<1e-12) break;
    const app=a[p][p],aqq=a[q][q],apq=a[p][q];
    const phi=0.5*Math.atan2(2*apq, aqq-app);
    const c=Math.cos(phi), s=Math.sin(phi);
    a[p][p]=c*c*app-2*s*c*apq+s*s*aqq;
    a[q][q]=s*s*app+2*s*c*apq+c*c*aqq;
    a[p][q]=0; a[q][p]=0;
    for (let i=0;i<3;i++){ if(i!==p&&i!==q){ const aip=a[i][p],aiq=a[i][q];
      a[i][p]=c*aip-s*aiq; a[p][i]=a[i][p]; a[i][q]=s*aip+c*aiq; a[q][i]=a[i][q]; } }
    for (let i=0;i<3;i++){ const vip=V[i][p],viq=V[i][q];
      V[i][p]=c*vip-s*viq; V[i][q]=s*vip+c*viq; }
  }
  const vals = [a[0][0], a[1][1], a[2][2]];
  let minIdx = 0;
  if (vals[1] < vals[minIdx]) minIdx = 1;
  if (vals[2] < vals[minIdx]) minIdx = 2;
  let nx = V[0][minIdx], ny = V[1][minIdx], nz = V[2][minIdx];
  const nlen = Math.hypot(nx,ny,nz) || 1;
  nx/=nlen; ny/=nlen; nz/=nlen;

  // Any in-plane axis orthogonal to the normal works as a reference for
  // angle - pick a helper vector not parallel to the normal, then build an
  // orthonormal pair (ux,uy,uz) and (vx,vy,vz) spanning the plane.
  let hx=1, hy=0, hz=0;
  if (Math.abs(nx) > 0.9) { hx=0; hy=1; hz=0; }
  let ux = hy*nz - hz*ny, uy = hz*nx - hx*nz, uz = hx*ny - hy*nx;
  const ulen = Math.hypot(ux,uy,uz) || 1;
  ux/=ulen; uy/=ulen; uz/=ulen;
  const vx = ny*uz - nz*uy, vy = nz*ux - nx*uz, vz = nx*uy - ny*ux;

  let sumR = 0;
  const polar = new Map(); // id -> {u, v, off} (off = out-of-plane component, preserved)
  for (const id of ring) {
    const dx=pos[id*3]-cx, dy=pos[id*3+1]-cy, dz=pos[id*3+2]-cz;
    const pu = dx*ux + dy*uy + dz*uz;
    const pv = dx*vx + dy*vy + dz*vz;
    const off = dx*nx + dy*ny + dz*nz;
    const r = Math.hypot(pu, pv);
    sumR += r;
    polar.set(id, {pu, pv, off, r});
  }
  const avgR = sumR / n;

  const writeSet = new Set(writeIds);
  for (const id of ring) {
    if (!writeSet.has(id)) continue;
    const {pu, pv, off, r} = polar.get(id);
    if (r < 1e-9) continue; // degenerate (dead center) - nothing to scale toward
    const newR = r + (avgR - r) * blendWeight;
    const scale = newR / r;
    pos[id*3]   = cx + pu*scale*ux + pv*scale*vx + off*nx;
    pos[id*3+1] = cy + pu*scale*uy + pv*scale*vy + off*ny;
    pos[id*3+2] = cz + pu*scale*uz + pv*scale*vz + off*nz;
  }
  return pos;
}


// relaxation over the graph's real edges so everything ELSE resettles around
// it - used right after projectOntoBestFitPlane moves a subset of nodes onto
// a plane, since their connecting edges to the rest of the piece are now
// stretched relative to wherever the solver originally put them.
export function relaxAroundPinned(pos, adjList, N, pinnedIds, iterations=80) {
  if (!adjList || !N || !pinnedIds || pinnedIds.length===0) return pos;
  const pinned = new Uint8Array(N);
  for (const id of pinnedIds) pinned[id] = 1;
  const vel = new Float64Array(N * 3);
  const force = new Float64Array(N * 3);
  const kSpring = 0.20, damping = 0.82, dt = 0.08;
  for (let iter = 0; iter < iterations; iter++) {
    force.fill(0);
    for (let i = 0; i < N; i++) {
      for (const [j, L] of adjList[i]) {
        if (j <= i) continue;
        const dx = pos[j*3]-pos[i*3], dy = pos[j*3+1]-pos[i*3+1], dz = pos[j*3+2]-pos[i*3+2];
        const r = Math.sqrt(dx*dx + dy*dy + dz*dz);
        if (r < 1e-10) continue;
        const f = kSpring * (r - L) / r;
        force[i*3]   += f*dx; force[j*3]   -= f*dx;
        force[i*3+1] += f*dy; force[j*3+1] -= f*dy;
        force[i*3+2] += f*dz; force[j*3+2] -= f*dz;
      }
    }
    for (let i = 0; i < N; i++) {
      if (pinned[i]) { vel[i*3] = vel[i*3+1] = vel[i*3+2] = 0; continue; }
      vel[i*3]   = vel[i*3]*damping   + force[i*3]*dt;
      vel[i*3+1] = vel[i*3+1]*damping + force[i*3+1]*dt;
      vel[i*3+2] = vel[i*3+2]*damping + force[i*3+2]*dt;
      pos[i*3]   += vel[i*3];
      pos[i*3+1] += vel[i*3+1];
      pos[i*3+2] += vel[i*3+2];
    }
  }
  return pos;
}

// Precomputes chain/bridge positions and gap correction entirely from
// already-known pinned leg data (graph.warmStartPos), the same math
// fixupFuseJoinGeometry already uses post-solve, just run BEFORE the solve
// so the chain can be hard-pinned too instead of left for majorization to
// guess at. Returns a NEW Map, doesn't mutate graph.warmStartPos.
export function precomputeChainAndGapFix(graph) {
  const wp = new Map(graph.warmStartPos);
  if (!graph.fuseRoundLift || !graph.fuseRoundLift.size) return wp;
  const groups = graph.fusedPieceGroups;
  const UNIT = 1.0;
  const centroidOf = ids => {
    let x=0,y=0,z=0;
    for (const id of ids) { const p = wp.get(id); x+=p[0]; y+=p[1]; z+=p[2]; }
    return [x/ids.length, y/ids.length, z/ids.length];
  };
  for (const [ri, info] of graph.fuseRoundLift) {
    const liftIds = info.liftIds || [];
    if (!groups || groups.length !== 2) continue;
    const chainGroups = info.chainGroups && info.chainGroups.length ? info.chainGroups : null;

    // Figure out the overall gap sizing/centering exactly as before, but
    // when we have real per-chain anchor data (the normal case now that
    // "+bridge" makes its own chain), size and center off the FIRST
    // declared chain specifically rather than a combined centroid of every
    // lift id - with two independent bridges there are two genuinely
    // different gaps (near side and far side of the join), and only the
    // first one's own endpoints are the right reference for how far apart
    // the two pieces themselves should sit.
    let p0, p1, chainLenForGap, seamIds0, seamIds1;
    const liftSet = new Set(liftIds);
    const seamIdsFor = (g, otherG) => {
      if (!g.anchorMergedIds) return [];
      const otherSet = otherG && otherG.anchorMergedIds ? new Set(otherG.anchorMergedIds) : null;
      return g.anchorMergedIds.filter(id =>
        (liftIds.length && graph.adjList[id].some(([nb]) => liftSet.has(nb))) ||
        (otherSet && graph.adjList[id].some(([nb]) => otherSet.has(nb)))
      );
    };
    if (chainGroups) {
      chainLenForGap = chainGroups[0].nodes.length;
      p0 = wp.get(chainGroups[0].leftAnchor);
      p1 = wp.get(chainGroups[0].rightAnchor);
    } else {
      seamIds0 = seamIdsFor(groups[0], groups[1]);
      seamIds1 = seamIdsFor(groups[1], groups[0]);
      if (!seamIds0.length || !seamIds1.length) continue;
      chainLenForGap = liftIds.length;
      p0 = centroidOf(seamIds0); p1 = centroidOf(seamIds1);
    }
    let dx = p1[0]-p0[0], dy = p1[1]-p0[1], dz = p1[2]-p0[2];
    const curGap = Math.hypot(dx,dy,dz);
    const targetGap = (chainLenForGap + 1) * UNIT;
    if (curGap > 1e-6) {
      dx/=curGap; dy/=curGap; dz/=curGap;
      const delta = targetGap - curGap;
      for (const mergedId of groups[0].idMap.values()) { const p=wp.get(mergedId); wp.set(mergedId, [p[0]-dx*delta/2, p[1]-dy*delta/2, p[2]-dz*delta/2]); }
      for (const mergedId of groups[1].idMap.values()) { const p=wp.get(mergedId); wp.set(mergedId, [p[0]+dx*delta/2, p[1]+dy*delta/2, p[2]+dz*delta/2]); }
    }

    // Now pin every chain group along ITS OWN anchor pair, re-read after
    // the group separation above moved the pieces (and their anchors).
    if (chainGroups) {
      for (const g of chainGroups) {
        const n = g.nodes.length;
        if (!n) continue;
        const gp0 = wp.get(g.leftAnchor), gp1 = wp.get(g.rightAnchor);
        const lineY = (gp0[1]+gp1[1])/2;
        for (let i = 0; i < n; i++) {
          const t = (i+1)/(n+1);
          wp.set(g.nodes[i], [gp0[0] + t*(gp1[0]-gp0[0]), lineY, gp0[2] + t*(gp1[2]-gp0[2])]);
        }
      }
    } else if (chainLenForGap > 0) {
      p0 = centroidOf(seamIds0); p1 = centroidOf(seamIds1);
      const lineY = (p0[1]+p1[1])/2;
      for (let i = 0; i < chainLenForGap; i++) {
        const t = (i+1)/(chainLenForGap+1);
        const id = liftIds[i];
        wp.set(id, [p0[0] + t*(p1[0]-p0[0]), lineY, p0[2] + t*(p1[2]-p0[2])]);
      }
    }
  }
  return wp;
}

// A foundation chain and the row of stitches worked directly around both its
// loops (an oval base: snout, sole, body base) are physically flat - real
// crochet never gives them any 3D relief, since nothing has increased them
// out of the plane yet. Stress majorization only ever sees graph topology
// though, and the small chain/loop edges (see getAttachNode) combined with
// the differing increase shapes at each end (a multi-stitch fan at the tip,
// a plain inc at the near end) give it just enough asymmetric pull to settle
// into a slight dome/twist instead of a true flat plane, even with the
// coplanar seeding above. This pass makes flatness exact rather than
// approximate: fit the best plane through the chain + its loop nodes + the
// oval ring's own stitches, then project every one of those points onto it,
// preserving whatever in-plane layout the solver worked out (the racetrack
// shape, relative stitch spacing, etc) and only removing the out-of-plane
// component. The projection itself only moves these two rounds; a short
// pinned spring-relaxation pass afterward lets anything built on top of the
// oval base resettle around the corrected, now-flat foundation instead of
// staying stretched toward the base's old position.
export function flattenChainOvalBase(pos, roundNodes, nodeData, chainFoundationRound, chainOvalRound, adjList, N, extraPinnedIds=null) {
  if (chainFoundationRound == null || chainOvalRound == null) return pos;
  if (!roundNodes || !roundNodes[chainFoundationRound] || !roundNodes[chainOvalRound]) return pos;

  const ids = [];
  for (const nid of roundNodes[chainFoundationRound]) ids.push(nid);
  for (const nid of roundNodes[chainOvalRound]) ids.push(nid);
  if (nodeData) {
    for (let i = 0; i < nodeData.length; i++) {
      const nd = nodeData[i];
      if (nd && nd.kind === 'loop') {
        const p = nodeData[nd.parentTop];
        if (p && p.round === chainFoundationRound) ids.push(i);
      }
    }
  }
  if (ids.length < 3) return pos;

  projectOntoBestFitPlane(pos, ids);
  // extraPinnedIds (fused-in piece nodes, already frozen) are pinned here too
  // so this pass's relax step never drags them off their correct positions
  // just because they happen to sit somewhere in the same connected graph.
  const pinned = extraPinnedIds && extraPinnedIds.length ? ids.concat(extraPinnedIds) : ids;
  relaxAroundPinned(pos, adjList, N, pinned);
  return pos;
}

// A folded round (see 'fold' in compileGraph) is, physically, the SAME move
// as the oval-base case above: real crochet can't give a creased, sc'd-flat
// seam any 3D relief either, once it's pinched shut it's flat by
// construction, sitting flush against the rim it closes - not one more
// stitch-height layer above it. Stress majorization only sees the fold's
// short "pinch" edges as ONE MORE preference to satisfy alongside every
// other edge in the graph though, not a hard constraint, and on their own
// they aren't enough to fully collapse the seam down onto the ring: fitting
// a single joint plane through ring+seam together (an earlier version of
// this pass) doesn't fix it either, since that joint plane is free to sit
// at any tilt and still leave the seam offset a full stitch-height away
// from the ring, just along a diagonal instead of straight up - which is
// exactly what read as an extra tapered "neck" rather than a flat cap.
// The fix that actually removes the offset: fit the plane from the RING's
// OWN points only (it's already close to planar - it's a normal round of
// a tube), then place each seam stitch exactly at the midpoint between the
// two ring stitches it pinched together, AFTER those are themselves
// projected onto that same ring plane. That's the literal geometry of the
// technique - the seam stitch sits physically between its two folded-
// together bases, on their own plane, not floating above it.
export function flattenFoldRounds(pos, roundNodes, foldRounds, adjList, N, yarnR=0.38, extraPinnedIds=null) {
  if (!foldRounds || foldRounds.size === 0 || !roundNodes) return pos;
  const fusedSet = extraPinnedIds && extraPinnedIds.length ? new Set(extraPinnedIds) : null;
  for (const ri of foldRounds) {
    const ring = roundNodes[ri - 1];
    const seam = roundNodes[ri]; // [seam0, seam1, seam2, ..., seamHalf-1] - all new nodes
    if (!ring || !seam || ring.length < 4 || seam.length < 3) continue;
    // A fold round belonging to an already-solved fused-in piece was already
    // pinched flat once, during its own solo solve, and its position was
    // copied in verbatim (see graph.fusedPinnedIds) - reprocessing it here
    // is at best redundant and at worst re-derives its seam midpoints from
    // whatever state its neighbors are in NOW rather than leaving the
    // frozen piece untouched. Skip it entirely rather than trust it's a
    // no-op.
    if (fusedSet && fusedSet.has(ring[0])) continue;

    // Snap the ring itself flat onto its own best-fit plane first - it's
    // already close (it's an ordinary tube round), this just removes the
    // last bit of jitter so the seam's midpoints land exactly on-plane too.
    projectOntoBestFitPlane(pos, ring);

    const n = ring.length;
    const half = n / 2;
    // The fold axis runs BETWEEN stitches, not through any of them (see
    // compileGraph), so there are no hinge points reused as-is this time -
    // every seam[i] is a genuine new node, and every ring[i] pinches
    // together with its mirror ring[n-1-i]. Every pair, including the two
    // closest to each end of the fold axis (ring[0]/ring[n-1], and
    // ring[half-1]/ring[half]), gets nudged to SEP apart as a good initial
    // guess, then left free to relax like normal ring nodes, the same way
    // the general Flatten pass treats every other ring in the piece. Those
    // two end pairs are ALSO linked by the ring's own real UNIT-length
    // edge, but that edge alone doesn't pull them close - measuring the
    // actual solved geometry showed they settle a full stitch-width apart
    // (wider than any other pair) if this nudge is skipped for them, which
    // reads as a splayed-open, twisted corner instead of a flat fold. So no
    // special-casing here either - every pair gets the same treatment. SEP
    // is tied to the actual yarn radius (real double thickness of yarn)
    // rather than a fixed magic number - you're squashing the STRUCTURE
    // flat, not the yarn strand itself down to zero thickness, so the two
    // layers should read as about one yarn diameter apart.
    const SEP = Math.max(0.06, yarnR * 2);
    for (let i = 0; i < half; i++) {
      const bot1 = ring[i], bot2 = ring[n - 1 - i], seamNode = seam[i];
      const mx = (pos[bot1*3]+pos[bot2*3])/2, my = (pos[bot1*3+1]+pos[bot2*3+1])/2, mz = (pos[bot1*3+2]+pos[bot2*3+2])/2;
      let dx = pos[bot2*3]-pos[bot1*3], dy = pos[bot2*3+1]-pos[bot1*3+1], dz = pos[bot2*3+2]-pos[bot1*3+2];
      const dlen = Math.hypot(dx,dy,dz) || 1;
      dx/=dlen; dy/=dlen; dz/=dlen;
      pos[bot1*3]   = mx - dx*SEP/2; pos[bot1*3+1] = my - dy*SEP/2; pos[bot1*3+2] = mz - dz*SEP/2;
      pos[bot2*3]   = mx + dx*SEP/2; pos[bot2*3+1] = my + dy*SEP/2; pos[bot2*3+2] = mz + dz*SEP/2;
      pos[seamNode*3] = mx; pos[seamNode*3+1] = my; pos[seamNode*3+2] = mz;
    }

    const pinned = fusedSet ? seam.concat(extraPinnedIds) : seam;
    relaxAroundPinned(pos, adjList, N, pinned, 40);
  }
  return pos;
}

// Small standalone PCA helper for an arbitrary list of 3D points (NOT node
// ids into a shared position buffer - used for the flatten spine-curl pass
// below, which works with ring centroids it computes itself, not raw nodes).
// Returns the centroid and the axis of LARGEST variance (the direction the
// points are most spread out along) - same Jacobi eigensolve as
// projectOntoBestFitPlane above, just picking the opposite end of the
// spectrum (most-variance axis instead of least-variance normal).
function pcaLargestAxis(points) {
  const n = points.length;
  let cx=0,cy=0,cz=0;
  for (const p of points) { cx+=p[0]; cy+=p[1]; cz+=p[2]; }
  cx/=n; cy/=n; cz/=n;
  let xx=0,xy=0,xz=0,yy=0,yz=0,zz=0;
  for (const p of points) {
    const dx=p[0]-cx, dy=p[1]-cy, dz=p[2]-cz;
    xx+=dx*dx; xy+=dx*dy; xz+=dx*dz; yy+=dy*dy; yz+=dy*dz; zz+=dz*dz;
  }
  xx/=n; xy/=n; xz/=n; yy/=n; yz/=n; zz/=n;
  let a=[[xx,xy,xz],[xy,yy,yz],[xz,yz,zz]];
  let V=[[1,0,0],[0,1,0],[0,0,1]];
  for (let iter=0; iter<60; iter++) {
    let p=0,q=1,maxv=Math.abs(a[0][1]);
    if (Math.abs(a[0][2])>maxv) { maxv=Math.abs(a[0][2]); p=0; q=2; }
    if (Math.abs(a[1][2])>maxv) { maxv=Math.abs(a[1][2]); p=1; q=2; }
    if (maxv<1e-12) break;
    const app=a[p][p], aqq=a[q][q], apq=a[p][q];
    const phi=0.5*Math.atan2(2*apq, aqq-app);
    const c=Math.cos(phi), s=Math.sin(phi);
    a[p][p]=c*c*app-2*s*c*apq+s*s*aqq; a[q][q]=s*s*app+2*s*c*apq+c*c*aqq;
    a[p][q]=0; a[q][p]=0;
    for (let i=0;i<3;i++) if (i!==p && i!==q) {
      const aip=a[i][p], aiq=a[i][q];
      a[i][p]=c*aip-s*aiq; a[p][i]=a[i][p];
      a[i][q]=s*aip+c*aiq; a[q][i]=a[i][q];
    }
    for (let i=0;i<3;i++) { const vip=V[i][p], viq=V[i][q]; V[i][p]=c*vip-s*viq; V[i][q]=s*vip+c*viq; }
  }
  const vals=[a[0][0],a[1][1],a[2][2]];
  let maxIdx=0;
  if (vals[1]>vals[maxIdx]) maxIdx=1;
  if (vals[2]>vals[maxIdx]) maxIdx=2;
  let ax=V[0][maxIdx], ay=V[1][maxIdx], az=V[2][maxIdx];
  const alen=Math.hypot(ax,ay,az)||1; ax/=alen; ay/=alen; az/=alen;
  return {cx,cy,cz,axis:[ax,ay,az]};
}

// Whole-model "flatten" preview (see the Flatten view toggle).
//
// The first version of this pressed every node onto ONE global best-fit
// plane - technically "flat" but it also flattened away the piece's own
// natural lengthwise curve (a floppy ear's characteristic bend), since a
// single global plane can't bend. That's not how pressing a real
// crocheted tube flat actually looks: you're squashing its own
// circumference shut at every point along its length, not ironing out
// whatever bend the tube has as a whole.
//
// This version does it the way 'fold'/'scclose' already do for a single
// closing round (see flattenFoldRounds above), just repeated for EVERY
// ordinary ring in the piece instead of one: each round's own points get
// settled onto that round's own local best-fit plane, then paired by
// mirror-opposite index (ring[i] with ring[n-i], same pairing fold/scclose
// use) and pulled toward their shared midpoint - collapsing that round's
// circle down to a flat line (its own diameter) instead of leaving it
// round. Doing this ring-by-ring rather than globally is exactly what
// preserves the spine's curve: each ring's own centroid - and hence its
// position along the piece's length/bend - is untouched, only its
// circumference collapses. Rounds that are already flat by construction
// (flat-piece rows, the chain/oval base, existing fold/scclose seams) are
// left alone; they have nothing to fold and doing so would double up on
// (or fight with) the flatten passes already made specifically for them.
//
// The two collapsed layers are kept `2 * yarnR` apart rather than
// coincident, so the result reads as a real double thickness of yarn
// (like a pressed-flat "pringle") instead of a single zero-thickness
// sheet - it's the structure being squashed, not the yarn strand itself.
//
// Two things this pass does beyond the ring pinch itself:
//
// 1. RELAX pass over the whole graph. Pinching each ring only repositions
// that ring's own top nodes - anything hanging off a top node with its own
// separate position (a BLO/FLO loop-split node, a bobble/puff/popcorn leg,
// a fan-stitch leg, etc.) doesn't move with it, so it's left stretched
// between its old position and the top node's new, much-closer-together
// one - which is exactly the radiating-spikes artifact seen when
// flattening a BLO-ridge piece. Fixing this the same way
// flattenChainOvalBase/flattenFoldRounds already do for their own smaller
// passes: pin every node this function actually moved, then run one spring
// relaxation over the real graph edges so everything else resettles around
// the new pinched positions instead of staying stretched toward the old
// ones.
//
// 2. Spine-curl exaggeration. A symmetric pattern (even increases spread
// evenly around each round) has very little inherent sideways bend for the
// solver to find - real yarn curls more than the idealized physics graph
// does, so the flattened result can look nearly straight from above even
// though a real crocheted piece would show a visible curve. This pass
// fits a straight reference line through the sequence of ring centroids,
// measures each ring's small sideways deviation from that line, smooths
// that deviation along the piece's length (so noise doesn't turn into a
// jagged zigzag), and exaggerates it by CURL_FACTOR - shifting each ring
// rigidly (not distorting its own flattened shape) toward a gentler,
// more visible "C" bend. With CURL_FACTOR = 1 this step is a no-op.
//
// Pure display transform, same as before: recomputed from lastPos on
// demand, never touches the real solved positions, toggling off always
// returns to the exact original result.


export function flattenHorizontal(pos, roundNodes, isFlatPiece, chainFoundationRound, chainOvalRound, foldRounds, yarnR, adjList, N, hubOf, flapRounds) {
  const flat = new Float64Array(pos);
  if (!roundNodes) return flat;
  const SEP_TARGET = Math.max(0.06, yarnR * 2);
  const processedRis = [];
  const pinnedIds = [];
  // Fold/scclose rounds are already flat by construction and never get
  // pinched by the loop below (see the `continue` just below) - but
  // skipping them there ALSO meant they never made it into pinnedIds,
  // so the relax pass at the end of this function (which moves every
  // non-pinned node to settle around whatever the loop DID pinch) treated
  // them as free nodes and nudged them slightly to satisfy their springs
  // to their now-repositioned neighboring round. That tiny, silent drift
  // is exactly what let a mount's seam axis come out differently (even a
  // different SIGN, in the fold-seam PCA case - see reattachMountedPiecesFromSolo)
  // depending on whether flattenHorizontal ran at all, which is why
  // toggling !flat could visibly change a mounted piece's orientation
  // instead of only its flatness. Pinning these rounds up front, before
  // the relax pass runs, keeps them exactly where they already were -
  // "already flat, leave alone" should mean genuinely untouched, not just
  // "not re-projected."
  if (foldRounds) {
    for (const ri of foldRounds) {
      if (isFlatPiece || ri === chainFoundationRound || ri === chainOvalRound) continue;
      for (const id of roundNodes[ri]) pinnedIds.push(id);
    }
  }
  for (let ri = 0; ri < roundNodes.length; ri++) {
    if (isFlatPiece) continue;                          // rows already flat/open by construction
    if (ri === chainFoundationRound || ri === chainOvalRound) continue; // handled by flattenChainOvalBase
    if (foldRounds && foldRounds.has(ri)) continue;      // already a fold/scclose seam, not a plain ring - pinned above instead
    if (flapRounds && flapRounds.has(ri)) continue;      // an open arc (partial round), not a plain ring
    const ring = roundNodes[ri];
    const n = ring.length;
    if (n < 4) continue; // nothing meaningful to fold shut (e.g. a bare MR hub)

    projectOntoBestFitPlane(flat, ring); // settle this ring onto its own local plane first

    // A fixed real-yarn-thickness separation is right for an ordinary-size
    // ring, but a small ring (like a 6-st magic ring right at the tip) can
    // be barely wider than that to begin with - forcing the full 2*yarnR
    // gap onto it then leaves it looking disproportionately puffy/bulged
    // instead of tapering to a point the way the rest of the piece does.
    // Clamp the gap to a fraction of THIS ring's own original diameter so
    // small rings taper down properly instead of staying artificially fat.
    let ringDiam = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i+1; j < n; j++) {
        const d = Math.hypot(flat[ring[i]*3]-flat[ring[j]*3], flat[ring[i]*3+1]-flat[ring[j]*3+1], flat[ring[i]*3+2]-flat[ring[j]*3+2]);
        if (d > ringDiam) ringDiam = d;
      }
    }
    const SEP = Math.min(SEP_TARGET, ringDiam * 0.6);

    const half = Math.floor(n / 2);
    for (let i = 1; i < half; i++) {
      const bot1 = ring[i], bot2 = ring[n - i];
      const mx = (flat[bot1*3]+flat[bot2*3])/2, my = (flat[bot1*3+1]+flat[bot2*3+1])/2, mz = (flat[bot1*3+2]+flat[bot2*3+2])/2;
      let dx = flat[bot2*3]-flat[bot1*3], dy = flat[bot2*3+1]-flat[bot1*3+1], dz = flat[bot2*3+2]-flat[bot1*3+2];
      const dlen = Math.hypot(dx,dy,dz) || 1;
      dx/=dlen; dy/=dlen; dz/=dlen;
      flat[bot1*3]   = mx - dx*SEP/2; flat[bot1*3+1] = my - dy*SEP/2; flat[bot1*3+2] = mz - dz*SEP/2;
      flat[bot2*3]   = mx + dx*SEP/2; flat[bot2*3+1] = my + dy*SEP/2; flat[bot2*3+2] = mz + dz*SEP/2;
    }

    // Close the magic-ring/hub gap: a hub node (see addHub in compileGraph)
    // sits equidistant from every stitch in its ring by design - once the
    // ring itself is squashed flat, that equidistant point isn't
    // necessarily exactly ON the fold line any more (a real cinched-tight
    // magic ring pulls to a single point; the spring relaxation below can
    // leave a small residual gap instead). Snap it directly to the ring's
    // own centroid - a real pulled-tight ring center - and pin it there.
    if (hubOf && hubOf.get(ri) != null) {
      const hubId = hubOf.get(ri);
      let cx=0,cy=0,cz=0;
      for (const id of ring) { cx+=flat[id*3]; cy+=flat[id*3+1]; cz+=flat[id*3+2]; }
      flat[hubId*3]=cx/n; flat[hubId*3+1]=cy/n; flat[hubId*3+2]=cz/n;
      pinnedIds.push(hubId);
    }

    processedRis.push(ri);
    for (const id of ring) pinnedIds.push(id);
  }

  // Spine-curl exaggeration
  if (processedRis.length >= 3) {
    const centroids = processedRis.map(ri => {
      const ring = roundNodes[ri];
      let cx=0,cy=0,cz=0;
      for (const id of ring) { cx+=flat[id*3]; cy+=flat[id*3+1]; cz+=flat[id*3+2]; }
      cx/=ring.length; cy/=ring.length; cz/=ring.length;
      return [cx,cy,cz];
    });
    const {cx,cy,cz,axis} = pcaLargestAxis(centroids);
    const [ax,ay,az] = axis;
    // Raw perpendicular offset of each ring centroid from the straight
    // reference line through the whole spine.
    const offsets = centroids.map(([x,y,z]) => {
      const dx=x-cx, dy=y-cy, dz=z-cz;
      const t = dx*ax+dy*ay+dz*az;
      return [dx-t*ax, dy-t*ay, dz-t*az]; // perpendicular component only
    });
    // Smooth along the sequence (simple moving average) so amplification
    // exaggerates a genuine gentle bend, not per-ring solver jitter.
    const w = FLATTEN_CURL_SMOOTH_WINDOW;
    const smoothed = offsets.map((_, i) => {
      let sx=0,sy=0,sz=0,cnt=0;
      for (let k=Math.max(0,i-w); k<=Math.min(offsets.length-1,i+w); k++) {
        sx+=offsets[k][0]; sy+=offsets[k][1]; sz+=offsets[k][2]; cnt++;
      }
      return [sx/cnt, sy/cnt, sz/cnt];
    });
    processedRis.forEach((ri, i) => {
      const [ox,oy,oz] = offsets[i];
      const [sx,sy,sz] = smoothed[i];
      // delta = (smoothed * CURL_FACTOR) - raw, i.e. move from the ring's
      // actual position to the smoothed+exaggerated one.
      const ddx = sx*FLATTEN_CURL_FACTOR - ox;
      const ddy = sy*FLATTEN_CURL_FACTOR - oy;
      const ddz = sz*FLATTEN_CURL_FACTOR - oz;
      for (const id of roundNodes[ri]) {
        flat[id*3]   += ddx;
        flat[id*3+1] += ddy;
        flat[id*3+2] += ddz;
      }
    });
  }

  // Relax everything else (loop-split nodes, bobble/fan legs, etc.)
  // around the now-pinched-and-curled ring nodes above.
  if (adjList && N && pinnedIds.length) relaxAroundPinned(flat, adjList, N, pinnedIds, 80);

  return flat;
}

// Simple seeded RNG
function mulberry32(seed) {
  let s = seed|0;
  return function() {
    s += 0x6D2B79F5;
    let t = Math.imul(s^s>>>15, 1|s);
    t = t + Math.imul(t^t>>>7, 61|t);
    return ((t^t>>>14)>>>0) / 4294967296;
  };
}