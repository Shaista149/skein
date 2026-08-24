// PRESETS
export const PRESETS = {
  // Basic shapes
  ball: [
    'MR:6','6inc','[sc, inc] x 6','[2sc, inc] x 6',
    '24sc','24sc','24sc',
    '[2sc, dec] x 6','[sc, dec] x 6','6dec','pull closed'
  ],
  // Character / detail
  gummy_bear: [
    'MR:6','6inc',
    '3sc, bobble, 3inc, bobble, 4sc',
    '15sc',
    '7sc, bobble, 7sc',
    '[sc, dec] x 5','[sc, inc] x 5',
    '6sc, bobble, 3sc, bobble, 4sc',
    '15sc',
    '7sc, bobble, 2sc, bobble, 4sc',
    '[sc, dec] x 5','5dec','pull closed'
  ],
  striped: [
    'MR:6','6inc','[sc, inc] x 6','[2sc, inc] x 6',
    'CC:coral, 24sc','24sc',
    'CC:steelblue, 24sc','24sc',
    'CC:coral, [2sc, dec] x 6','[sc, dec] x 6','6dec','pull closed'
  ],
  // Demonstrates a genuine MID-ROUND color change: each round below
  // switches color partway through, on the same line, rather than only at
  // a round's start - e.g. "12sc, cc:blue, 12sc" changes color exactly at
  // stitch 13 of 24, splitting one round into two visible color blocks.
  cc_midrow_demo: [
    'MR:6','6inc','[sc, inc] x 6',
    '12sc, cc:coral, 6sc',
    '9sc, cc:steelblue, 9sc',
    'cc:coral, 9sc, cc:gold, 9sc',
    '[sc, dec] x 6','6dec','fo'
  ],
  // Same tube, but demonstrates attach:rN-blo/flo - after finishing the main
  // piece, come back with a new color and work into round 5's BACK loop,
  // which was left open when round 6 worked flo (front loop only) into it.
  loop_reattach_demo: [
    'MR:12','12sc','12sc',
    'blo, 12sc','12sc',
    'flo, 12sc','12sc',
    '12sc',
    'attach:r3-flo, CC:coral, 12sc',
    'attach:r5-blo, CC:coral, 12sc','fo'
  ],
  // R5 works BLO into R4, leaving R4's front loop open; the
  // ruffle then reattaches into that exact loop and works "3 hdc in each
  // stitch around" (hdc3fan) all the way round, then fastens off.
  leg_with_ruffle: [
    'MR:8','8inc','16sc','16sc',
    'blo, CC:coral, 16sc','16sc',
    'attach:r4-flo, CC:gold, [hdc3fan] x 16','fo'
  ],
  // Bunny (sweetpeaplush) - visualise each piece separately
  bunny_body: [
    'MR:6','6inc','[sc, inc] x 6','[2sc, inc] x 6','[3sc, inc] x 6',
    '30sc','30sc','30sc',
    '10sc, 3inc, 4sc, 3inc, 10sc',
    '36sc',
    '10sc, 3dec, 4sc, 3dec, 10sc',
    '[sc, dec] x 10',
    '10dec',
    '10inc',
    '[4sc, inc] x 4',
    '24sc','24sc','24sc','24sc','24sc','24sc',
    '[sc, dec] x 8',
    '[2sc, dec] x 4',
    '6dec','pull closed'
  ],
  bunny_ear: [
    'MR:8','8inc',
    '16sc','16sc','16sc','16sc',
    '[2sc, dec] x 4',
    '12sc','12sc','12sc',
    '[4sc, dec] x 2',
    '10sc',
    '[3sc, dec] x 2',
    '8sc',
    'sc closed','fo'
  ],
  bunny_leg: [
    'MR:12',
    '12sc','12sc','12sc','12sc','fo'
  ],
  bunny_arm: [
    'MR:8',
    '8sc','8sc','8sc','8sc','8sc','fo'
  ],
  // -- Snout: oval base worked around a foundation chain (both loops of
  // each chain link), same technique as the real "sc in 2nd ch from hook,
  // ... underside: ..." pattern this was built from. No special notation -
  // just a plain ch:N foundation followed by a round that naturally
  // consumes more stitches than the chain has links, which is enough on
  // its own to be recognized as worked in the round rather than flat (see
  // isChainInRound in parsePattern/compileGraph).
  //
  // Round 1 sets up two poles: the sc3fan tip (3 stitches, one end of the
  // oval) and the inc (2 stitches, the other end), with a plain 5sc side
  // on either side of them. Every round after that keeps BOTH 5sc sides
  // completely plain and puts ALL new increases into those same two pole
  // clusters - this is the actual real-pattern technique (its rnd2/rnd3
  // do the exact same thing: "3sc, 3inc" repeated, never spreading
  // increases into the straight sides). An earlier version of this preset
  // spread increases evenly all the way around instead ((4sc,inc)x3, then
  // (2sc,inc)x6) - which is genuinely the standard technique for growing a
  // flat CIRCLE, not an oval, and was why the piece solved into a warped,
  // coned shape instead of lying flat: an oval only stays flat and
  // elongated if its increases stay concentrated at the two tips while the
  // long sides stay straight, and evenly-distributed increases fight that
  // directly regardless of how good the physics solver's seeding is.
  snout: [
    'ch:6',
    '5sc, sc3fan, 5sc, inc',
    '5sc, 3inc, 5sc, 2inc',
    '5sc, [sc,inc]x3, 5sc, [sc,inc]x2',
    '25sc',
    '25sc','fo'
  ],

  bunny: {
    components: {
      main: {
        lines: [
          'MR:6',
          '6inc',
          '[sc, inc] x 6',
          '[2sc, inc] x 6',
          '[3sc, inc] x 6',
          '30sc',
          '30sc',
          '30sc',
          '10sc, 3inc, 4sc, 3inc, 10sc',
          '36sc',
          '10sc, 3dec, 4sc, 3dec, 10sc',
          '[sc, dec] x 10',
          '10dec',
          '10inc',
          '[4sc, inc] x 4',
          '24sc',
          '24sc',
          '24sc',
          '24sc',
          '24sc',
          '24sc',
          '[sc, dec] x 8',
          '[2sc, dec] x 4',
          '6dec',
          'pull closed',
          'mount:ear,r5:7@200!flat!flip',
          'mount:ear,r5:21@200!flat',
          'mount:leg,r20:11',
          'mount:leg,r20:19',
          'mount:arm,r15:10',
          'mount:arm,r15:17',
        ],
        markers: [],
      },
      ear: {
        lines: [
          'MR:8', '8inc',
          '16sc', '16sc', '16sc', '16sc',
          '[2sc, dec] x 4',
          '12sc', '12sc', '12sc',
          '[4sc, dec] x 2',
          '10sc',
          '[3sc, dec] x 2',
          '8sc',
          'sc closed', 'fo',
        ],
        markers: [],
      },
      leg: {
        lines: ['MR:12', '12sc', '12sc', '12sc', '12sc', 'fo'],
        markers: [],
      },
      arm: {
        lines: ['MR:8', '8sc', '8sc', '8sc', '8sc', '8sc', 'fo'],
        markers: [],
      },
    },
    activeComponent: 'main',
  },
}