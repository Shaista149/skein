export const CSS_COLOR = {
  red:0xff4444, blue:0x4488ff, green:0x44aa44, yellow:0xffee44,
  orange:0xff8800, purple:0xaa44cc, pink:0xff88aa, white:0xffeedd,
  black:0x222222, coral:0xff6b6b, teal:0x44aaaa, brown:0x885533,
  cream:0xf7f2eb, gray:0x888888, grey:0x888888, lavender:0xb088cc,
  mint:0x88ddaa, peach:0xffb899, gold:0xffd700, navy:0x224488,
  beige:0xe8d5b0, rose:0xe87880, sage:0x7a9a78, mustard:0xc8a030,
  rust:0xb84a22, forest:0x3a6a3a, sky:0x80b8e0, lilac:0xcc99ee,
  steelblue:0x4682b4, violet:0xee82ee, maroon:0x802020, olive:0x808020,
};
// Fills the notation guide's inline color-name list straight from
// CSS_COLOR's own keys, so the docs can't drift out of sync with what
// resolveColor actually accepts if a name is ever added/removed here.
(function fillNotationColorNames() {
  const el = document.getElementById('notation-color-names');
  if (el) el.textContent = Object.keys(CSS_COLOR).sort().join(', ');
})();
export const STITCH_COLOR = {
  sc:0xd4b896, hdc:0xf7d070, dc:0xf7a840, tr:0xf77830,
  inc:0x8aba8a, dec:0xcc5a3a, bobble:0xbba070, puff:0xbba070,
  popcorn:0x9040c0, slst:0xaaaaaa, ch:0xddddbb, default:0xd4b896,
};


// Base yarn color (MC) picker
// When set (via the color-row swatches in the viewport), this overrides the
// per-stitch-type default palette above with a single flat MC color, EXCEPT
// for rows with an explicit CC: color change in the pattern, which always
// win, mirroring how a real project has one main color plus deliberate color
// changes.
let baseColorHex = null;
// baseColorHex is module-local on purpose (resolveColor below is the only
// reader) - other modules that need to SET it (the color-picker swatches)
// can't just assign it directly (a `let` can only be reassigned by the
// module that declared it), so they go through this setter instead.
export function setBaseColorHex(hex) { baseColorHex = hex; }
export const COLORS = [
  {name:'Blush',hex:'#e8a598',n:0xe8a598},{name:'Peach',hex:'#f2c4a0',n:0xf2c4a0},
  {name:'Butter',hex:'#e8d890',n:0xe8d890},{name:'Sage',hex:'#9ab89a',n:0x9ab89a},
  {name:'Sky',hex:'#8aacc8',n:0x8aacc8},{name:'Lavender',hex:'#b8a8c8',n:0xb8a8c8},
  {name:'Cocoa',hex:'#b89070',n:0xb89070},{name:'Ivory',hex:'#f0e8d8',n:0xf0e8d8},
];

export function resolveColor(colorStr, stitch) {
  if (colorStr && colorStr!=='default') {
    const lo = colorStr.toLowerCase();
    if (CSS_COLOR[lo] !== undefined) return CSS_COLOR[lo];
    if (/^#[0-9a-f]{3,8}$/i.test(colorStr)) return parseInt(colorStr.slice(1),16);
    // Compact "rgb{r}-{g}-{b}" form, e.g. CC:rgb255-40-0 - lets someone
    // type plain 0-255 numbers straight from any other color tool without
    // converting to hex themselves. Deliberately dash-separated rather than
    // the usual rgb(r,g,b) syntax: the pattern tokenizer already splits a
    // round's stitches on commas (see parseLine's tokens.split(',')), so a
    // literal comma-and-parens form would need its own escaping pass
    // through that tokenizer. This fits the color token's existing
    // [a-z0-9#_-] character set with no tokenizer changes at all.
    const rgbM = lo.match(/^rgb(\d{1,3})-(\d{1,3})-(\d{1,3})$/);
    if (rgbM) {
      const clamp = n => Math.max(0, Math.min(255, parseInt(n)));
      const r = clamp(rgbM[1]), g = clamp(rgbM[2]), b = clamp(rgbM[3]);
      return (r << 16) | (g << 8) | b;
    }
  }
  if (baseColorHex != null) return baseColorHex;
  // One flat default for the whole piece when nothing has actually been
  // colored - NOT STITCH_COLOR[stitch]. That used to vary by stitch type
  // (sc vs hdc vs dc vs a bobble's internal leg-base stitch), so an
  // uncolored bobble built on a 'dc' base rendered orange/tan while the
  // uncolored 'sc' fabric around it rendered beige - two different
  // "no color set" defaults quietly disagreeing. Real yarn doesn't change 
  // shade because of which stitch happens to be worked at that point.
  return STITCH_COLOR.default;
}

// Row-type palette, shared by the marker-mode tooltip and marker panel
// TYPE_COL is kept only as reference data (maps round-type -> a color), no 
// longer used to color the row-marker rings themselves - see ROW_MARKER_COLOR /
// ROW_START_COLOR below. A rainbow-per-type ring turned out to be more
// visual noise than information once you're looking at a real model instead
// of a legend, so the rings/dots are now one flat, consistent color each;
// TYPE_LABEL still supplies the human-readable round-type text for hover
// tooltips and the marker panel, which is where that information is
// actually useful.
export const TYPE_COL = {
  MR:0xaa88ff, inc:0x44dd88, dec:0xff5544, flat:0xbb88ff, cc:0xffaa44,
  bobble:0xee44ee, blo:0x44ddff, flo:0xffb84d, slst:0xaaaaaa,
  hdc:0xf7d070, dc:0xf7a840, tr:0xf77830,
};
export const TYPE_LABEL = {
  MR:'magic ring', inc:'increase row', dec:'decrease row', flat:'straight row',
  cc:'color-change row', bobble:'bobble/puff/popcorn row', blo:'BLO row', flo:'FLO row',
  slst:'slip-stitch row', hdc:'hdc row', dc:'dc row', tr:'tr row', fold:'sew-closed seam',
  scclose:'sc-closed seam',
};

// Row-marker palette - one consistent color for every ring, 
// one consistent color for every start dot, rather than coding round
// type into color (old version).
export const ROW_MARKER_RING_COLOR  = 0x5C6E5A; // sage-dark
export const ROW_MARKER_OUTLINE_COLOR = 0xFFFDF8; // cream
export const ROW_START_DOT_COLOR    = 0x8B4F58; // dark-pink