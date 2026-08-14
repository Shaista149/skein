import * as THREE from 'three';
import { resolveColor, ROW_MARKER_RING_COLOR, ROW_MARKER_OUTLINE_COLOR, ROW_START_DOT_COLOR } from './color.js';

// Row marker overlay (round rings + start-of-round dots)
// Purely cosmetic overlay group built from the already-solved node positions.
// Never touches `pos`, so it has no effect on the physics result.
//
// Placement note: earlier this pushed each ring point outward from its own
// (possibly bumpy/irregular) raw position by a small fixed amount, which
// wasn't enough clearance once stitch-texture bumps and shear-artifact
// spikes are accounted for - the ring ended up buried inside the yarn
// surface and depth-occluded, so the toggle did nothing visible. This
// version instead follows v9's approach: place the ring on a clean circle
// at (max radius from the round's own centroid) + yarnR, which reliably
// clears the surface regardless of local bumpiness.
//
// Sizing note: the ring/dot's own visual size uses a small base size plus a
// SHALLOW partial scale with yarnR (see ringTubeR/dotR below) - not the
// original full 1:1 scale (which ballooned into oversized shapes on chunky
// yarn) and not a pure fixed constant either (which then read as too thin
// and got lost against chunky yarn's own bigger stitch-texture bumps). The
// CLEARANCE offset (torusR = avgR + yarnR, and the dot's equivalent) is
// separate and still scales fully with yarn thickness, because that
// offset's job is to clear the actual yarn surface, which really does get
// physically bigger with chunkier yarn.
export function buildRowMarkerGroup(nodeData, roundNodes, roundTypes, pos, yarnR, isFlatPiece, chainFoundationRound, foldRounds, roundAttachTo, flapRounds) {
  // attach:rN-blo/flo rows don't build a new layer - they work back into a
  // loop an earlier round already left unclaimed, so they sit at
  // essentially the same position as that earlier round. Left alone this
  // drew TWO markers stacked right on top of each other (one for the
  // original round, one for the attach row reattached into it) - visually
  // redundant and confusing about which ring is "row N". Fix: skip drawing
  // the original target round's own marker whenever something later
  // reattaches into it (the attach row's marker, drawn below, effectively
  // stands in for that position instead), and label the attach row's own
  // marker with its TARGET's round number rather than its own sequential
  // index - since semantically "this loop is still row 4", it never
  // becomes a new row of its own just by being revisited.
  const attachTargets = new Set();
  if (roundAttachTo) {
    for (let i = 0; i < roundAttachTo.length; i++) {
      if (roundAttachTo[i] != null) attachTargets.add(roundAttachTo[i]);
    }
  }
  const group = new THREE.Group();
  const lineGrp = new THREE.Group();
  const startDotGrp = new THREE.Group();
  
  // Ring/dot own visual size: a small BASE plus a PARTIAL fraction of
  // yarnR - not a pure constant (that read as too thin/lost against chunky
  // yarn's own bigger stitch-texture bumps), and not a full 1:1 scale with
  // yarnR either (that was the original bug: at yarnR=0.65 the old
  // yarnR*0.75 dot came out to ~0.49, nearly as big as the yarn tube
  // itself, which is what looked oversized/bad). This lands in between:
  // it grows for chunky yarn so it stays clearly visible, but the slope is
  // shallow enough that it never approaches the yarn's own scale.
  const ringTubeR = 0.05 + yarnR * 0.12;
  const dotR = 0.09 + yarnR * 0.20;

  // Overall-model centroid (every node, not just one round's) - used as the
  // "outward" reference point specifically for OPEN rows (foundation
  // chains, flat-piece rows). A round's own centroid works fine for a
  // closed ring (every point sits roughly equidistant from it), but a
  // straight open row runs THROUGH its own centroid - points near the
  // middle of the line sit almost exactly on top of it, and scaling a
  // point outward "from" a reference point it's already sitting on blows
  // up (dividing by a near-zero radius). The whole-model centroid is a
  // stable point no single row's line of points is likely to pass through,
  // so it gives a sane, non-degenerate outward direction for open rows.
  let modelCx=0, modelCy=0, modelCz=0, modelN=0;
  roundNodes.forEach(ring => {
    if (!ring) return;
    ring.forEach(id => { modelCx+=pos[id*3]; modelCy+=pos[id*3+1]; modelCz+=pos[id*3+2]; modelN++; });
  });
  if (modelN > 0) { modelCx/=modelN; modelCy/=modelN; modelCz/=modelN; }

  for (let ri = 0; ri < roundNodes.length; ri++) {
    const ring = roundNodes[ri];
    if (!ring || ring.length < 3) continue;
    // This round's own loop gets picked up again later via attach: - skip
    // its marker here, the attach row (drawn when we reach its own ri,
    // below) represents this same position instead.
    if (attachTargets.has(ri)) continue;

    // Centroid of this round's nodes - used for the ring's HEIGHT (cy) and
    // as the radial reference point for CLOSED rings only (see below).
    let cx=0, cy=0, cz=0;
    ring.forEach(id => { cx+=pos[id*3]; cy+=pos[id*3+1]; cz+=pos[id*3+2]; });
    cx/=ring.length; cy/=ring.length; cz/=ring.length;

    const type  = roundTypes[ri] || 'flat';
    // An attach row doesn't count as a new row of its own - it's still
    // working into whichever round it reattached into, so its label uses
    // THAT round's number instead of its own sequential index.
    const displayRi = (roundAttachTo && roundAttachTo[ri] != null) ? roundAttachTo[ri] : ri;
    const hoverData = { round: displayRi, type };

    // A round is only a closed loop if the piece isn't flat AND this isn't
    // the foundation-chain round itself - same logic buildMesh uses for the
    // real yarn tube (a chain-worked-in-the-round base is physically a
    // straight line even when every round built on top of it closes into a
    // ring).
    const closed = (ri === chainFoundationRound || (foldRounds && foldRounds.has(ri)) || (flapRounds && flapRounds.has(ri))) ? false : !isFlatPiece;

    // Skip near-degenerate rings (MR/FO) where there's essentially no real
    // radius to speak of. For open rows this check doesn't mean much - use
    // the round's own extent either way, it's only deciding whether to
    // bother drawing at all.
    let maxR = 0, sumR = 0;
    ring.forEach(id => {
      const dx=pos[id*3]-cx, dz=pos[id*3+2]-cz;
      const r = Math.sqrt(dx*dx+dz*dz);
      if (r > maxR) maxR = r;
      sumR += r;
    });
    const avgR = sumR / ring.length;
    if (maxR < yarnR * 0.5) continue;

    const TRACE_CLEARANCE = 0.28 + yarnR * 0.65;
    const offsetDist = yarnR + TRACE_CLEARANCE;

    // TRACE the round's own real shape instead of fitting one circle to it.
    // Every earlier attempt at a single "safe radius" for a whole round
    // (average, max, max+spread, bigger flat margins) was the wrong shape
    // of fix, because how much a round wobbles isn't constant - tight near
    // the poles, can balloon at the equator or on any asymmetric shape.
    //
    // For a CLOSED ring, pushing each point radially outward from the
    // round's own centroid by a fixed absolute distance works well - every
    // point in a real ring sits roughly equidistant from that centroid, so
    // "radially outward from here" is a stable, meaningful direction.
    //
    // For an OPEN row (a foundation chain, or any flat-piece row), that
    // same radial approach breaks down: a nearly-straight line runs right
    // past its own centroid, so points near the middle can have a tiny
    // local radius while the ends have a large one - scaling each point
    // by (radius+offset)/radius blows that tiny-radius point's relative
    // expansion up hugely compared to its neighbors, distorting the whole
    // curve into an unusable kinked shape instead of a clean parallel
    // offset (confirmed directly: a real foundation chain's per-point
    // radius from ANY single reference point varied from 0.4 to 2.9 within
    // one six-stitch row). The correct technique for an open path is a
    // proper offset curve: push each point along its own LOCAL normal
    // (perpendicular to the tangent formed by its neighbors), by a fixed
    // absolute distance - this is stable regardless of how the row curves
    // or how close to any single "center" a given point happens to sit.
    // For an OPEN row (a foundation chain, or any flat-piece row), the
    // radial-from-centroid approach breaks down: a nearly-straight line
    // runs right past its own centroid, so points near the middle can have
    // a tiny local radius while the ends have a large one - scaling each
    // point by (radius+offset)/radius blows that tiny-radius point's
    // relative expansion up hugely compared to its neighbors, distorting
    // the whole curve (confirmed directly: a real foundation chain's
    // per-point radius from a single reference point varied from 0.4 to
    // 2.9 within one six-stitch row). The correct technique for an open
    // path is a proper offset curve: push each point along its own LOCAL
    // normal (perpendicular to the tangent formed by its neighbors).
    //
    // The normal's SIGN has to be picked carefully too: deciding it
    // independently at each point (e.g. "whichever side points away from
    // the model's centroid") can disagree between neighboring points on a
    // curved line - imagine a bent row where the centroid sits near the
    // concave side partway along; points before and after that bend can
    // get opposite signs, creating a self-crossing, kinked offset instead
    // of a clean parallel line. So the sign is decided ONCE, for the first
    // point only (via that same "away from centroid" heuristic, which is
    // fine as a single starting choice), and then PROPAGATED along the row
    // by keeping each subsequent normal consistent with its neighbor
    // (parallel transport) rather than re-deciding independently - this is
    // what actually guarantees a continuous, non-crossing offset curve
    // regardless of how the row bends.
    let openNormals = null;
    if (!closed) {
      openNormals = [];
      for (let i = 0; i < ring.length; i++) {
        const prevId = ring[Math.max(i-1,0)];
        const nextId = ring[Math.min(i+1,ring.length-1)];
        let tx = pos[nextId*3]-pos[prevId*3], tz = pos[nextId*3+2]-pos[prevId*3+2];
        let tlen = Math.sqrt(tx*tx+tz*tz);
        if (tlen < 1e-6) { tx=1; tz=0; tlen=1; }
        tx/=tlen; tz/=tlen;
        let nx = -tz, nz = tx;
        if (i === 0) {
          const x = pos[ring[0]*3], z = pos[ring[0]*3+2];
          const toPtX = x-modelCx, toPtZ = z-modelCz;
          if (nx*toPtX + nz*toPtZ < 0) { nx=-nx; nz=-nz; }
        } else {
          const prevN = openNormals[i-1];
          if (nx*prevN.x + nz*prevN.z < 0) { nx=-nx; nz=-nz; }
        }
        openNormals.push({x:nx, z:nz});
      }
    }

    function toolAtIndex(i, extra) {
      extra = extra || 0;
      const id = ring[i];
      const x = pos[id*3], y = pos[id*3+1], z = pos[id*3+2];
      const dist = offsetDist + extra;
      if (closed) {
        const dx = x-cx, dz = z-cz;
        const localR = Math.sqrt(dx*dx+dz*dz);
        const scale = (localR + dist) / Math.max(localR, 1e-6);
        return {x: cx + dx*scale, y, z: cz + dz*scale};
      }
      const nrm = openNormals[i];
      return {x: x + nrm.x*dist, y, z: z + nrm.z*dist};
    }
    const tracedPts = ring.map((_, i) => { const p = toolAtIndex(i); return new THREE.Vector3(p.x, p.y, p.z); });
    if (tracedPts.length < (closed ? 3 : 2)) continue;

    // The foundation chain isn't a ring or an edge - it's just a line of
    // anchor points the next round works into on both sides. There's no
    // real boundary to trace, and after several attempts at a small
    // anchor-dot-only marker for it (each with its own placement issue),
    // it's just skipped entirely - no line, no dot, nothing drawn for it.
    if (ri === chainFoundationRound) continue;

    try {
      const curve = new THREE.CatmullRomCurve3(tracedPts, closed, 'catmullrom', 0.5);
      const tubeSeg = Math.max(ring.length * 4, 24);
      const rGeo = new THREE.TubeGeometry(curve, tubeSeg, ringTubeR, 8, closed);
      const rMat = new THREE.MeshStandardMaterial({
        color: ROW_MARKER_RING_COLOR, roughness:0.3, metalness:0.2, transparent:true, opacity:0.85, depthWrite:false,
      });
      const rMesh = new THREE.Mesh(rGeo, rMat);
      rMesh.renderOrder = 10;
      rMesh.userData = hoverData;
      lineGrp.add(rMesh);

      // Cream outline traced the same way, just a touch further out again
      // for legibility against busy textures.
      const outlinePts = ring.map((_, i) => { const p = toolAtIndex(i, ringTubeR*0.6); return new THREE.Vector3(p.x, p.y, p.z); });
      const outlineCurve = new THREE.CatmullRomCurve3(outlinePts, closed, 'catmullrom', 0.5);
      const outlineGeoPts = outlineCurve.getPoints(80);
      const outline = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(outlineGeoPts),
        new THREE.LineBasicMaterial({ color: ROW_MARKER_OUTLINE_COLOR, transparent: true, opacity: 0.45, depthWrite: false })
      );
      outline.renderOrder = 11;
      lineGrp.add(outline);
    } catch(e) {}

    // Row-start dot: traced the exact same way as the ring, using just the
    // FIRST node's own offset - it's one specific point, so it only ever
    // needs to clear itself.
    try {
      const p = toolAtIndex(0, dotR);
      const sdGeo = new THREE.SphereGeometry(dotR, 10, 8);
      const sdMat = new THREE.MeshStandardMaterial({
        color: ROW_START_DOT_COLOR, roughness:0.3, metalness:0.25,
      });
      const sd = new THREE.Mesh(sdGeo, sdMat);
      sd.position.set(p.x, p.y, p.z);
      sd.renderOrder = 12;
      sd.userData = hoverData;
      startDotGrp.add(sd);
    } catch(e) {}
  }


  lineGrp.visible = false;
  startDotGrp.visible = false;
  group.add(lineGrp);
  group.add(startDotGrp);
  group._lineGrp = lineGrp;
  group._startDotGrp = startDotGrp;
  return group;
}

// Canvas-based stitch texture (from v6)
function makeStitchTexture(hexColor) {
  const SIZE = 256;
  const c = document.createElement('canvas');
  c.width = SIZE; c.height = SIZE;
  const ctx = c.getContext('2d');

  // Parse hex to rgb
  const r = (hexColor >> 16) & 0xff;
  const g = (hexColor >> 8)  & 0xff;
  const b =  hexColor        & 0xff;
  const base   = `rgb(${r},${g},${b})`;
  const dark   = `rgb(${Math.round(r*.68)},${Math.round(g*.68)},${Math.round(b*.68)})`;
  const light  = `rgb(${Math.min(255,Math.round(r*1.22))},${Math.min(255,Math.round(g*1.22))},${Math.min(255,Math.round(b*1.22))})`;
  const shadow = `rgba(0,0,0,0.18)`;

  ctx.fillStyle = base;
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Draw stitch V-shapes tiled across the texture
  const cols = 4, rows = 5;
  const cw = SIZE / cols, rh = SIZE / rows;

  for (let row = 0; row < rows + 1; row++) {
    for (let col = 0; col < cols; col++) {
      const ox = col * cw + (row % 2 === 0 ? 0 : cw * 0.5);
      const oy = row * rh;
      const vw = cw * 0.72, vh = rh * 0.58;
      const cx2 = ox + cw * 0.5, cy = oy + rh * 0.1;

      // Stitch body arc
      ctx.beginPath();
      ctx.moveTo(cx2 - vw/2, cy + vh * 0.2);
      ctx.quadraticCurveTo(cx2 - vw * 0.12, cy + vh * 0.55, cx2, cy + vh * 0.72);
      ctx.quadraticCurveTo(cx2 + vw * 0.12, cy + vh * 0.55, cx2 + vw/2, cy + vh * 0.2);
      ctx.strokeStyle = dark;
      ctx.lineWidth = cw * 0.22;
      ctx.lineCap = 'round';
      ctx.stroke();

      // Highlight on top
      ctx.beginPath();
      ctx.moveTo(cx2 - vw * 0.28, cy + vh * 0.25);
      ctx.quadraticCurveTo(cx2, cy + vh * 0.6, cx2 + vw * 0.28, cy + vh * 0.25);
      ctx.strokeStyle = light;
      ctx.lineWidth = cw * 0.09;
      ctx.stroke();

      // Subtle shadow below
      ctx.beginPath();
      ctx.moveTo(cx2 - vw * 0.4, cy + vh * 0.15);
      ctx.lineTo(cx2 + vw * 0.4, cy + vh * 0.15);
      ctx.strokeStyle = shadow;
      ctx.lineWidth = rh * 0.12;
      ctx.stroke();
    }
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 4);
  return tex;
}

// Bump map for surface relief
function makeStitchBump() {
  const SIZE = 128;
  const c = document.createElement('canvas');
  c.width = SIZE; c.height = SIZE;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#888';
  ctx.fillRect(0, 0, SIZE, SIZE);
  const cols = 4, rows = 5;
  const cw = SIZE/cols, rh = SIZE/rows;
  for (let row = 0; row < rows+1; row++) {
    for (let col = 0; col < cols; col++) {
      const ox = col*cw + (row%2===0 ? 0 : cw*0.5);
      const oy = row*rh;
      const cx2 = ox + cw*0.5, cy = oy + rh*0.1;
      const vw = cw*0.7, vh = rh*0.56;
      ctx.beginPath();
      ctx.moveTo(cx2-vw/2, cy+vh*0.2);
      ctx.quadraticCurveTo(cx2, cy+vh*0.72, cx2+vw/2, cy+vh*0.2);
      ctx.strokeStyle = '#ddd';
      ctx.lineWidth = cw*0.26;
      ctx.lineCap = 'round';
      ctx.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 4);
  return tex;
}

// Main mesh builder
export function buildMesh(nodeData, adjList, pos, roundNodes, roundBobbles, options={}) {
  const group = new THREE.Group();
  const yarnR = options.yarnRadius ?? 0.38;
  const useTexture = options.useTexture !== false;
  const isFlatPiece = options.isFlatPiece === true;
  const chainFoundationRound = options.chainFoundationRound ?? null;
  const foldRounds = options.foldRounds ?? null;
  const flapRounds = options.flapRounds ?? null;
  const fuseRoundSegments = options.fuseRoundSegments ?? null;
  // Node ids imported wholesale from an already-solved fuse: piece (see
  // graph.fusedPinnedIds) keep their ORIGINAL round number from that
  // piece's own solo pattern, not renumbered to fit this pattern's round
  // sequence - a leg with 11 rounds of its own can easily import a node
  // whose .round is a bigger number than the brand-new round being fused
  // onto it. The vertical-leg color tie-break below assumes a bigger round
  // number always means "later/newer", which breaks exactly at that seam.
  const fusedPinnedIds = options.fusedPinnedIds ? new Set(options.fusedPinnedIds) : null;
  const matCache = new Map();

  function getMat(hexColor, isBulge=false) {
    const k = `${hexColor}_${isBulge}`;
    if (matCache.has(k)) return matCache.get(k);

    let mat;
    if (useTexture && !isBulge) {
      const tex  = makeStitchTexture(hexColor);
      // makeStitchTexture paints with plain canvas 2D fillStyle/strokeStyle
      // colors, which the browser always renders as sRGB pixel data - it's
      // a color/diffuse map, not a data map. Left at the default
      // LinearEncoding, three.js would feed those sRGB texel values
      // straight into the (linear-space) lighting math unconverted, which
      // is the exact same "sRGB value used where linear was expected"
      // mismatch that can turn a picked red orange onscreen. Marking it
      // sRGBEncoding makes three.js decode each texel to linear before
      // lighting, so the resolved yarn color actually tracks the hex you
      // picked instead of drifting under a mismatched color space.
      tex.encoding = THREE.sRGBEncoding;
      const bump = makeStitchBump(); // a relief/data map, not color - stays LinearEncoding
      mat = new THREE.MeshStandardMaterial({
        map: tex,
        bumpMap: bump,
        bumpScale: 0.18,
        roughness: 0.88,
        metalness: 0.0,
      });
    } else {
      // Same sRGB->linear correction as the texture path above, for the
      // untextured fallback (bulge stitches, or useTexture:false).
      mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(hexColor).convertSRGBToLinear(),
        roughness: isBulge ? 0.70 : 0.86,
        metalness: 0.0,
      });
    }
    matCache.set(k, mat);
    return mat;
  }

  // Per-round tube rendering
  // For each round, extract node positions in order, build a closed
  // CatmullRomCurve3 through them, render as a TubeGeometry.
  // This gives smooth, continuous yarn instead of choppy edge cylinders.
  // BLO/FLO no longer touch this pass at all - the ridge they produce is a
  // real graph structure now (see getAttachNode / the loop-pair renderer
  // just below), so the ring tube itself is drawn exactly like any other.
  //
  // Per-round tubes now use a SINGLE color for the whole ring's mesh
  // (colors having genuinely changed mid-round only affects THIS ring's
  // vertical spine tubes and bulge stitches below, which each carry their
  // own resolved node color) - the lateral connective tube itself still
  // reads its color from the round's start, which is an acceptable
  // approximation for the ring surface immediately surrounding a color
  // change; the vertical legs are what makes a genuine two-color round
  // visually read correctly, since that's where the stitch tops actually
  // sit.
  if (roundNodes && roundNodes.length > 0) {
    for (let ri = 0; ri < roundNodes.length; ri++) {
      const ring = roundNodes[ri];
      if (!ring || ring.length < 2) continue;

      // Determine if this is a closed loop (tube) or open row (flat piece,
      // worked back and forth from a foundation chain) - a real flag from
      // compileGraph now, not a length guess. Round 0 stays open whenever
      // it's a chain foundation, even for a chain-worked-in-the-round
      // piece where every round after it closes into a ring - the chain
      // itself is a straight line, never a loop on its own.
      const closed = (ri === chainFoundationRound || (foldRounds && foldRounds.has(ri)) || (flapRounds && flapRounds.has(ri))) ? false : !isFlatPiece;

      // A fuse round with more than one piece/chain segment isn't a simple
      // ring - it's a figure-8 (or worse, with 3+ segments), and its own
      // points, taken in sequence, reverse direction sharply right at each
      // segment boundary (the whole point of "leave leg1, cross the bridge,
      // enter leg2" is a genuine direction reversal, not a smooth turn).
      // Sweeping ONE CatmullRom curve through that whole sequence forces a
      // smooth C1-continuous spline to interpolate through a sharp reversal
      // it was never meant for, which is exactly what a smooth spline does
      // by bulging/twisting outward rather than pinching - that bulge is
      // the visible "smear". Splitting into one open arc per segment (same
      // technique the color-run split above already uses, just keyed on
      // segment boundaries instead of color changes) keeps each arc smooth
      // over a run that's genuinely smooth in real crochet too, and lets
      // the segments simply meet at the crossing rather than forcing one
      // curve to smoothly pass through it twice.
      const fuseSegs = fuseRoundSegments && fuseRoundSegments.get(ri);
      if (fuseSegs && fuseSegs.length > 1 && closed) {
        const n = ring.length;
        for (let s = 0; s < fuseSegs.length; s++) {
          const start = fuseSegs[s];
          const end = (s+1 < fuseSegs.length) ? fuseSegs[s+1] - 1 : n - 1;
          const idxs = [];
          for (let k = start; k <= end; k++) idxs.push(k);
          if (!idxs.length) continue;
          // A single fuse segment can itself carry more than one color (a
          // color-split bridge chain, e.g. ch3+CC:coral+ch3) - group into
          // contiguous same-color runs WITHIN this segment (same technique
          // the plain mid-round color-change case below uses) instead of
          // sampling just the segment's first node for the whole thing.
          // Sampling only the first node silently flattened a split bridge
          // to one uniform color, and for the reused/reversed crossing of
          // that same bridge (a separate segment, walked back to front) it
          // painted the ENTIRE return pass in whatever color that first
          // (reversed) node happened to be, rather than reflecting the
          // real per-link colors - the "back side" showing up wrong.
          const colorOfIdx = k => resolveColor(nodeData[ring[k]]?.color, nodeData[ring[k]]?.stitch);
          const runs = [];
          let ri2 = 0;
          while (ri2 < idxs.length) {
            const c0 = colorOfIdx(idxs[ri2]);
            const runIdxs = [idxs[ri2]];
            let ri3 = ri2+1;
            while (ri3 < idxs.length && colorOfIdx(idxs[ri3]) === c0) { runIdxs.push(idxs[ri3]); ri3++; }
            runs.push({color:c0, idxs:runIdxs});
            ri2 = ri3;
          }
          for (const run of runs) {
            const rIdxs = run.idxs;
            // Extend only to the MIDPOINT of the boundary stitch on each
            // side (not the full neighboring node) - a full-node extension
            // means both this run and its neighbor separately claim the
            // ENTIRE boundary stitch in their own color, so the two tubes
            // fully overlap over a whole stitch's width at every color
            // change instead of just meeting there. Meeting at the shared
            // midpoint keeps the smooth spline continuation this extension
            // exists for, without the double coverage that reads as one
            // color "clipping" into the next.
            const prevNid = ring[(rIdxs[0]-1+n)%n], nextNid = ring[(rIdxs[rIdxs.length-1]+1)%n];
            const ownPts = rIdxs.map(k => new THREE.Vector3(pos[ring[k]*3], pos[ring[k]*3+1], pos[ring[k]*3+2]));
            const prevPt = new THREE.Vector3(pos[prevNid*3], pos[prevNid*3+1], pos[prevNid*3+2]);
            const nextPt = new THREE.Vector3(pos[nextNid*3], pos[nextNid*3+1], pos[nextNid*3+2]);
            const startPt = prevPt.clone().lerp(ownPts[0], 0.5);
            const endPt = nextPt.clone().lerp(ownPts[ownPts.length-1], 0.5);
            const segPts = [startPt, ...ownPts, endPt];
            const segCurve = new THREE.CatmullRomCurve3(segPts, false, 'catmullrom', 0.5);
            const tubeSeg = Math.max(segPts.length * 4, 12);
            try {
              const geo  = new THREE.TubeGeometry(segCurve, tubeSeg, yarnR, 7, false);
              const mesh = new THREE.Mesh(geo, getMat(run.color));
              mesh.castShadow = true;
              mesh.receiveShadow = true;
              group.add(mesh);
            } catch(e) {}
          }
        }
        continue;
      }

      // A round with a genuine mid-round color change needs its lateral
      // ring tube SPLIT into per-color segments (an open CatmullRom arc
      // per contiguous same-color run) rather than one single-color tube
      // for the whole ring - otherwise the connective yarn between two
      // differently-colored halves would silently render in whichever
      // color happened to be sampled from node 0, hiding the color
      // change on the lateral tube even though the vertical legs show it
      // correctly. Group consecutive same-color nodes (wrapping around
      // for a closed ring) and draw one tube per group.
      const colorOf = nid => resolveColor(nodeData[nid]?.color, nodeData[nid]?.stitch);
      const n = ring.length;
      const groups = [];
      if (closed) {
        // find a start index where color differs from its predecessor, so
        // we don't split a run that wraps the seam in two
        let startIdx = 0;
        for (let k = 0; k < n; k++) {
          if (colorOf(ring[k]) !== colorOf(ring[(k-1+n)%n])) { startIdx = k; break; }
        }
        let k = 0;
        while (k < n) {
          const c0 = colorOf(ring[(startIdx+k)%n]);
          const idxs = [(startIdx+k)%n];
          let k2 = k+1;
          while (k2 < n && colorOf(ring[(startIdx+k2)%n]) === c0) { idxs.push((startIdx+k2)%n); k2++; }
          groups.push({color:c0, idxs});
          k = k2;
        }
      } else {
        let k = 0;
        while (k < n) {
          const c0 = colorOf(ring[k]);
          const idxs = [k];
          let k2 = k+1;
          while (k2 < n && colorOf(ring[k2]) === c0) { idxs.push(k2); k2++; }
          groups.push({color:c0, idxs});
          k = k2;
        }
      }

      const singleColor = groups.length <= 1;

      if (singleColor) {
        const rawPts = ring.map(nid => new THREE.Vector3(pos[nid*3], pos[nid*3+1], pos[nid*3+2]));
        const hexColor = colorOf(ring[0]);
        const curve = new THREE.CatmullRomCurve3(rawPts, closed, 'catmullrom', 0.5);
        const tubeSeg = Math.max(ring.length * 4, 24);
        try {
          const geo  = new THREE.TubeGeometry(curve, tubeSeg, yarnR, 7, closed);
          const mesh = new THREE.Mesh(geo, getMat(hexColor));
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          group.add(mesh);
        } catch(e) {}
      } else {
        // Multiple color runs: draw each run as its own OPEN tube segment,
        // extending one extra node into the next group on each end so the
        // segments visually meet at the color-change stitch instead of
        // leaving a gap.
        for (const grp of groups) {
          const idxs = grp.idxs.slice();
          const firstI = idxs[0], lastI = idxs[idxs.length-1];
          const prevI = (firstI-1+n)%n, nextI = (lastI+1)%n;
          // Extend only to the MIDPOINT of the boundary stitch on each side
          // (not the full neighboring node) - a full-node extension means
          // both this run and its neighbor separately claim the ENTIRE
          // boundary stitch in their own color, so the two tubes fully
          // overlap over a whole stitch's width at every color change
          // instead of just meeting there. Meeting at the shared midpoint
          // keeps the smooth spline continuation this extension exists
          // for, without the double coverage that reads as one color
          // "clipping" into the next.
          const ownPts = idxs.map(k => {
            const nid = ring[k];
            return new THREE.Vector3(pos[nid*3], pos[nid*3+1], pos[nid*3+2]);
          });
          const prevNid = ring[prevI], nextNid = ring[nextI];
          const prevPt = new THREE.Vector3(pos[prevNid*3], pos[prevNid*3+1], pos[prevNid*3+2]);
          const nextPt = new THREE.Vector3(pos[nextNid*3], pos[nextNid*3+1], pos[nextNid*3+2]);
          const startPt = prevPt.clone().lerp(ownPts[0], 0.5);
          const endPt = nextPt.clone().lerp(ownPts[ownPts.length-1], 0.5);
          const segPts = [startPt, ...ownPts, endPt];
          const segCurve = new THREE.CatmullRomCurve3(segPts, false, 'catmullrom', 0.5);
          const tubeSeg = Math.max(segPts.length * 4, 12);
          try {
            const geo  = new THREE.TubeGeometry(segCurve, tubeSeg, yarnR, 7, false);
            const mesh = new THREE.Mesh(geo, getMat(grp.color));
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            group.add(mesh);
          } catch(e) {}
        }
      }

      // An open row (isFlatPiece row, chain foundation, fold seam, or a
      // partial-round patch tracked via flapRounds) has two REAL exposed
      // ends that nothing else is built onto. THREE.TubeGeometry never
      // caps its own ends regardless of the `closed` argument (that only
      // controls whether the tube's PATH loops back on itself, not
      // whether its cross-section is sealed) - so every open row has
      // always rendered as a hollow pipe at both ends, which reads as a
      // small dark notch/gap right where the row stops. A small sphere at
      // each end, sized to the yarn radius, caps it the way yarn actually
      // rounds off at a turn or a tied-off end.
      if (!closed) {
        try {
          const firstNid = ring[0], lastNid = ring[n-1];
          const capStart = new THREE.Mesh(new THREE.SphereGeometry(yarnR, 8, 6), getMat(colorOf(firstNid)));
          capStart.position.set(pos[firstNid*3], pos[firstNid*3+1], pos[firstNid*3+2]);
          capStart.castShadow = true;
          group.add(capStart);
          const capEnd = new THREE.Mesh(new THREE.SphereGeometry(yarnR, 8, 6), getMat(colorOf(lastNid)));
          capEnd.position.set(pos[lastNid*3], pos[lastNid*3+1], pos[lastNid*3+2]);
          capEnd.castShadow = true;
          group.add(capEnd);
        } catch(e) {}
      }
    }
  }

  // BLO / FLO loop-pair renderer
  // getAttachNode (in compileGraph) lazily splits a stitch top into a front
  // and back loop node whenever a later round attaches to only one of them.
  // The worked loop already grows a normal vertical "leg" tube via the
  // spine-tube pass below (it has a real cross-round edge, solved like any
  // other). Here we draw the small physical pair itself - a short tube
  // between the two solved loop positions plus a bead at each - so the
  // UNWORKED loop is actually visible sitting proud/tucked next to the
  // worked one, instead of being invented at render time.
  {
    const seenPair = new Set();
    for (let i = 0; i < nodeData.length; i++) {
      const nd = nodeData[i];
      if (nd.kind !== 'loop' || nd.side !== 'front') continue;
      // find the sibling back-loop node sharing the same parentTop
      let backId = null;
      for (const [j] of adjList[nd.parentTop]) {
        const nj = nodeData[j];
        if (nj.kind === 'loop' && nj.side === 'back' && nj.parentTop === nd.parentTop) { backId = j; break; }
      }
      if (backId == null || seenPair.has(nd.parentTop)) continue;
      seenPair.add(nd.parentTop);

      const F = new THREE.Vector3(pos[i*3], pos[i*3+1], pos[i*3+2]);
      const K = new THREE.Vector3(pos[backId*3], pos[backId*3+1], pos[backId*3+2]);
      const hexColor = resolveColor(nd.color, 'sc');
      const beadR = yarnR * 0.6; // same size for front and back - see conversation: no physical reason for BLO/FLO to differ in prominence, only in which side they sit on

      try {
        const curve = new THREE.CatmullRomCurve3([F, K], false, 'catmullrom', 0.5);
        const geo   = new THREE.TubeGeometry(curve, 6, yarnR * 0.45, 6, false);
        group.add(new THREE.Mesh(geo, getMat(hexColor)));
        const beadF = new THREE.Mesh(new THREE.SphereGeometry(beadR, 8, 6), getMat(hexColor));
        beadF.position.copy(F);
        const beadK = new THREE.Mesh(new THREE.SphereGeometry(beadR, 8, 6), getMat(hexColor));
        beadK.position.copy(K);
        group.add(beadF, beadK);
      } catch(e) {}
    }
  }

  // Magic-ring and closing-round caps are no longer a separate disc mesh
  // at all. compileGraph now adds a real "hub" node for each one, wired
  // with a real edge to every stitch on that ring (see addHub) - stress
  // majorization pulls it into place like any other node, and the
  // vertical-spine-tube pass just below draws those hub↔stitch edges as
  // ordinary leg tubes. That's the actual fix for "why can't I see
  // stitches here": there's no separate flat surface to fake texture on
  // anymore, it's the same tube geometry everything else is made of,
  // converging on a real point - exactly like a magic ring pulled snug.

  // Vertical spine tubes (connecting rounds)
  // For each node, draw a short tube to its parent(s) in the previous round.
  // These are the "legs" of stitches - short, fat, connecting adjacent rings.
  // We deduplicate and only draw inter-round edges (different round index).
  const edgeSeen = new Set();
  for (let i = 0; i < nodeData.length; i++) {
    const ni = nodeData[i];
    for (const [j, w] of adjList[i]) {
      if (j <= i) continue;
      const nj = nodeData[j];
      if (!ni || !nj) continue;
      // Only draw edges that cross rounds (vertical yarn) or connect to a
      // hub node - not lateral top-to-top ring edges, which the ring-tube
      // pass already owns. A hub's spokes sit at the SAME round index as
      // its ring (see addHub in compileGraph), so this can't just check
      // round equality - it has to specifically exempt hub edges too.
      // Hub spokes are exempted above because a hub sits at the SAME round
      // index as its own ring. A fuse round's bridge-chain nodes have the
      // exact same shape of problem: buildFuseBase labels a chain node
      // with the round it's built in (the fuse round itself, ri) - the
      // SAME round number the new stitches worked into it also get - so a
      // genuinely vertical edge (new stitch -> the chain link it was
      // worked into) looks, by round number alone, identical to a lateral
      // same-round ring edge and gets silently dropped here. That's every
      // stitch-leg that would visually drape over the bridge chain -
      // exactly the "V of sc sitting on the chain" that never renders.
      if (ni.round === nj.round && ni.kind !== 'hub' && nj.kind !== 'hub' && !ni.isFuseBridge && !nj.isFuseBridge) continue;

      const key = `${i}-${j}`;
      if (edgeSeen.has(key)) continue;
      edgeSeen.add(key);

      const ax=pos[i*3], ay=pos[i*3+1], az=pos[i*3+2];
      const bx=pos[j*3], by=pos[j*3+1], bz=pos[j*3+2];
      const len = Math.sqrt((bx-ax)**2+(by-ay)**2+(bz-az)**2);
      if (len < 0.01) continue;

      // Short tube between two points using a 2-point curve
      // Bulge-leg edges (bobble/puff/popcorn) get their own curved per-leg
      // tubes below, drawn through all their solved nodes at once - skip
      // them here so they aren't also drawn as a single straight segment.
      if (ni.kind==='bulgeLeg' || nj.kind==='bulgeLeg') continue;
      const isBulgeEdge = false;
      const r = yarnR;
      // Color the vertical leg from whichever endpoint is the ROUND-LATER
      // ("top") node - the leg is the new stitch growing upward into this
      // round, so it should carry the color that was active when THAT
      // stitch was worked, not whatever the earlier round's base color
      // happens to be. This is what makes a mid-round color change (or a
      // cc: at a round's very start) visible on the legs immediately,
      // rather than lagging a round behind.
      //
      // A bridge chain link and the stitch worked into it are a special
      // case of "equal round" (see the isFuseBridge exemption above -
      // buildFuseBase deliberately labels a chain node with the SAME round
      // it's built in, ri, and the stitches worked into it are also round
      // ri). Equal round numbers usually mean "no real up/down direction,
      // doesn't matter which we pick" - but here it very much does: the
      // chain link is always the base, the other node is always the new
      // stitch growing out of it. Left to the plain >= comparison, this
      // picked whichever node happened to come first in the adjacency
      // list, sometimes the chain's own baked-in color, sometimes the
      // stitch's - a patchwork with no actual logic to it. Explicitly
      // prefer the non-bridge side whenever the round numbers tie.
      //
      // A fused-in piece's own rim (imported via fuse:, see fusedPinnedIds
      // above) has the OPPOSITE problem: its .round number isn't tied at
      // all, and can easily be LARGER than the brand-new round being
      // fused onto it, so the plain >= comparison picks the piece's own
      // old rim color instead of the new stitch's color for every leg
      // crossing that seam - exactly the "still not coloring all of it"
      // rim seen in practice. A pinned/imported node is always the base
      // here, regardless of what its raw round number says, so check that
      // before trusting round numbers at all.
      let laterNode;
      if (fusedPinnedIds && fusedPinnedIds.has(i) && !fusedPinnedIds.has(j)) {
        laterNode = nj;
      } else if (fusedPinnedIds && fusedPinnedIds.has(j) && !fusedPinnedIds.has(i)) {
        laterNode = ni;
      } else if (ni.round == null || nj.round == null) {
        laterNode = ni;
      } else if (ni.round === nj.round) {
        if (ni.isFuseBridge && !nj.isFuseBridge) laterNode = nj;
        else if (nj.isFuseBridge && !ni.isFuseBridge) laterNode = ni;
        else laterNode = ni;
      } else {
        laterNode = ni.round >= nj.round ? ni : nj;
      }
      const hexColor = resolveColor(laterNode.color, laterNode.stitch);

      const pts = [
        new THREE.Vector3(ax, ay, az),
        new THREE.Vector3((ax+bx)/2, (ay+by)/2, (az+bz)/2),
        new THREE.Vector3(bx, by, bz),
      ];
      const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
      try {
        const geo  = new THREE.TubeGeometry(curve, 4, r, 7, false);
        const mesh = new THREE.Mesh(geo, getMat(hexColor, isBulgeEdge));
        mesh.castShadow = true;
        group.add(mesh);
      } catch(e) {}
    }
  }

  // Bobble / puff / popcorn renderer
  // Every leg is now a REAL physics node placed by the same stress-
  // majorization solve as everything else (see addBulgeStitch in
  // compileGraph). There is no analytic fan math here at all - we just
  // gather each stitch instance's leg nodes (grouped by their shared
  // topId/botId) and draw a tube straight through their solved positions.
  // Whatever shape the solver settled on IS the bobble.
  {
    const instances = new Map(); // `${topId}_${botId}` -> {stitch, base, color, topId, botId, legs:Map(legIndex -> {mid1,mid2})}
    for (let i = 0; i < nodeData.length; i++) {
      const nd = nodeData[i];
      if (nd.kind !== 'bulgeLeg') continue;
      const key = `${nd.topId}_${nd.botId}`;
      let inst = instances.get(key);
      if (!inst) {
        inst = { stitch: nd.stitch, base: nd.base, color: nd.color, topId: nd.topId, botId: nd.botId, legs: new Map() };
        instances.set(key, inst);
      }
      let leg = inst.legs.get(nd.legIndex);
      if (!leg) { leg = {}; inst.legs.set(nd.legIndex, leg); }
      if (nd.stage === 1) leg.mid1 = i; else leg.mid2 = i;
    }

    const V = id => new THREE.Vector3(pos[id*3], pos[id*3+1], pos[id*3+2]);

    for (const inst of instances.values()) {
      const B = V(inst.botId), T = V(inst.topId);
      const hexColor = resolveColor(inst.color, inst.base || 'dc');
      const legR = yarnR * (inst.stitch === 'popcorn' ? 0.78 : 0.85);
      const legTops = [];

      for (const leg of inst.legs.values()) {
        if (leg.mid1 == null || leg.mid2 == null) continue;
        const M1 = V(leg.mid1), M2 = V(leg.mid2);
        try {
          const legCurve = new THREE.CatmullRomCurve3([B, M1, M2, T], false, 'catmullrom', 0.5);
          const geo  = new THREE.TubeGeometry(legCurve, 14, legR, 6, false);
          const mesh = new THREE.Mesh(geo, getMat(hexColor));
          mesh.castShadow = true;
          group.add(mesh);
        } catch(e) {}
        legTops.push(M2);
      }
      if (legTops.length === 0) continue;

      const cen = new THREE.Vector3();
      legTops.forEach(p => cen.add(p));
      cen.divideScalar(legTops.length);

      if (inst.stitch === 'popcorn') {
        // Popcorn folds shut into a dome: draw the SOLVED collar ring
        // between the leg tops (real positions, not an assumed circle),
        // then a small dome at their gathered centroid.
        if (legTops.length >= 3) {
          try {
            const ringCurve = new THREE.CatmullRomCurve3(legTops, true, 'catmullrom', 0.5);
            const geo = new THREE.TubeGeometry(ringCurve, Math.max(legTops.length * 4, 16), legR * 0.85, 6, true);
            group.add(new THREE.Mesh(geo, getMat(hexColor)));
          } catch(e) {}
        }
        try {
          const domeR = Math.max(cen.distanceTo(T) * 0.9, yarnR * 1.1);
          const domeMesh = new THREE.Mesh(new THREE.SphereGeometry(domeR, 12, 10), getMat(hexColor));
          domeMesh.position.copy(cen);
          domeMesh.castShadow = true;
          group.add(domeMesh);
        } catch(e) {}
      } else {
        // Bobble/puff: small torus at the solved leg-top gather point,
        // oriented along the actual base→gather direction the solve found.
        try {
          const outward = cen.clone().sub(B).normalize();
          const ringR = Math.max(cen.distanceTo(B) * 0.12, yarnR * 0.9);
          const ringGeo  = new THREE.TorusGeometry(ringR, legR * 0.52, 8, Math.max(legTops.length + 4, 12));
          const ringMesh = new THREE.Mesh(ringGeo, getMat(hexColor));
          ringMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), outward);
          ringMesh.position.copy(cen);
          ringMesh.castShadow = true;
          group.add(ringMesh);
        } catch(e) {}
      }
    }
  }
  return group;
}

export function disposeMesh(group) {
  if (!group) return;
  group.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      if (Array.isArray(o.material)) o.material.forEach(m=>m.dispose());
      else o.material.dispose();
    }
  });
  if (group.parent) group.parent.remove(group);
}