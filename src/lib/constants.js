// Domain constants: stitch geometry, decorative-stitch leg ratios, and
// display-only tuning values. No logic here - see graph.js / geometry.js
// for the functions that consume these.

// Default lean (degrees, around the seam's own hinge line) for a graft:
// with no @angle given. Not a physically-derived value - just picked
// what looked like a reasonable resting position
export const DEFAULT_GRAFT_ANGLE_DEG = 40;

export const STITCH_DEF = {
  sc:   {height:1.00, inCount:1, outCount:1},
  hdc:  {height:1.25, inCount:1, outCount:1},
  dc:   {height:1.75, inCount:1, outCount:1},
  tr:   {height:2.50, inCount:1, outCount:1},
  dtr:  {height:3.25, inCount:1, outCount:1},
  trtr: {height:4.00, inCount:1, outCount:1},
  inc:  {height:1.00, inCount:1, outCount:2},
  dec:  {height:1.00, inCount:2, outCount:1},
  ch:   {height:0.00, inCount:0, outCount:1},
  slst: {height:0.10, inCount:1, outCount:1},
  sk:   {height:0.00, inCount:1, outCount:0},
};

// Bulge-stitch leg ratios (CrochetPARADE-style)
// A bobble/puff/popcorn is NOT a single decorative point - it is several
// partial stitches ("legs") worked into the same base stitch and gathered
// at a shared top. We model each leg as its own short chain of physics
// nodes whose edge lengths are LONGER than the direct base->top edge; the
// stress-majorization solver then has no choice but to bow each leg out
// into 3D space to satisfy both the long leg path and the short direct
// edge at once - the bulge "emerges" from the solve, it is never drawn.
// Ratios are fractions of the base stitch's own height `h`, carried over
// from CrochetPARADE's DEF strings (e.g. dc5bobble: B-0.7-C;C-0.8-D;D-0.7-A
// against a direct base->top edge of 1), rescaled to match own
// per-stitch heights so the proportions match CrochetPARADE exactly even
// though the absolute units differ.
export const BOBBLE_LEG_RATIO = { // [e1, e2, e3] - base->mid1->mid2->top
  dc:  [0.70, 0.80, 0.70],
  hdc: [0.60, 0.70, 0.60],
  tr:  [1.20, 0.80, 1.20],
  dtr: [1.40, 0.90, 1.40],
};
export const PUFF_LEG_RATIO = {
  hdc: [0.55, 0.55, 0.55],
  sc:  [0.45, 0.45, 0.45],
  dc:  [0.65, 0.75, 0.65],
};
// Popcorn legs are FULL stitches (base->mid->full-height top), then the leg
// tops are ring-connected to each other and drawn in tight to the shared
// top with a short "gather" edge - mirroring CrochetPARADE's dc3pc DEF
// (legs ~1.1-1.2x base height, collar ring ~0.8x, final gather ~0.33x).
export const POPCORN_LEG_RATIO    = [1.15, 1.15];
export const POPCORN_RING_RATIO   = 0.80;
export const POPCORN_GATHER_RATIO = 0.33;

export const RADIUS_FLARE_DECAY_ROUNDS = 4;

export const FLATTEN_CURL_FACTOR = 3.0;
export const FLATTEN_CURL_SMOOTH_WINDOW = 5;