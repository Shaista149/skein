// Pattern parsing: turns raw pattern text into structured round/op data
// ready for graph.js's compileGraph. Pure - no DOM, no graph/geometry logic.

// Every graft: token in a pattern gets its own unique id here, regardless
// of how many times the same piece name is used - two separate "graft:ear"
// tokens (e.g. one per leg) are two independent placements, not one shared
// attachment. Without this, compileGraph's graftGroups (keyed by name)
// would silently merge both occurrences' anchor stitches into a single
// combined group, as if they were one attachment ring split across two
// unrelated spots.
let graftInstanceCounter = 0;
export function bumpGraftInstanceCounter() {
  return graftInstanceCounter++;
}

// TOKENIZER / PARSER

function normalizeStr(s) {
  return s.trim()
    .replace(/[×x\*✕]/g,'x')
    .replace(/[–—]/g,'-')
    .replace(/\s+/g,' ')
    .replace(/\s*,\s*/g,',')
    .replace(/\s*:\s*/g,':')
    .toLowerCase();
}

// Returns array of ops: {op, stitch?, count?, color?, base?, legs?}
export function parseLine(raw) {
  const s = normalizeStr(raw);
  if (!s || s==='fo' || s==='fasten off') return [{op:'fo'}];

  // pull closed - standalone directive, same placeholder treatment as fo/turn:
  // threads the tail through every live stitch of the round just worked and
  // draws them together to a single point. This fires regardless of whether 
  // that round decreased - real yarn can be gathered shut from any stitch count, 
  // it's an explicit action the pattern is asking for.
  if (s==='pull closed') return [{op:'pullClosed'}];

  // mount:name,rN:S / mount:name,rN:S@angle / mount:name,rN:S!flat!flip -
  // a standalone directive line (never mixed with stitch ops on the same
  // line, unlike attach:/fuse: which are prefixes). Unlike graft:, this
  // doesn't produce or consume any stitches of its own and isn't part of
  // any round's ops - it just says "take saved piece `name` and attach it,
  // centered on round N's stitch S of THIS piece." N and S are both
  // resolved later (parsePattern has the rounds-so-far needed for real
  // gutter numbers and stitch counts; parseLine has neither, so it only
  // extracts the literal numbers typed). !flat/!tube force the orientation
  // mode instead of auto-detecting it from fold/scclose; !flip adds a
  // half-turn to whichever spin the auto-resolve settles on, for the cases
  // where it picks the wrong of the two valid orientations. `@` is still
  // accepted as the name/round separator too (mount:name@rN:S), so older
  // lines don't break.
  //
  // mount:name,rN:S-rM:T - a SPAN mount instead of a single point: the
  // piece's own closing seam (a fold/scclose row - see the isFoldSeam
  // requirement enforced in parsePattern below) is laid out diagonally
  // across the body, its first seam stitch pinned to round N's stitch S
  // and its last seam stitch pinned to round M's stitch T. Both ends must
  // be given exactly (row AND stitch) - a row alone (mount:name,rN:S-rM)
  // is deliberately not supported: the same stitch-count seam can reach
  // two entirely different stitches on a later row (picture a diagonal
  // line crossing that row on its way past vs. curling back into it), and
  // there's no way to tell which one is meant without the person just
  // saying so. The actual reachability check (does the body's real
  // shortest path between these two exact points have the same number of
  // hops as the seam has stitches) happens later in compileGraph, once
  // the body's own stitch graph exists to check against - here we only
  // extract the literal numbers typed, same as the single-point form.
  const mountM = s.match(/^mount:([a-z0-9_-]+)[,@]r(\d+):(\d+)(?:-r(\d+):(\d+))?(?:@(-?\d+(?:\.\d+)?))?((?:!(?:flat|tube|flip))*)$/i);
  if (mountM) {
    const flagsStr = (mountM[7]||'').toLowerCase();
    const flags = new Set(flagsStr.match(/!(\w+)/g)?.map(f => f.slice(1)) || []);
    return [{op:'mount', mountName: mountM[1].toLowerCase(), mountDisplayNum: parseInt(mountM[2],10), mountStitchIdx: parseInt(mountM[3],10),
      mountEndDisplayNum: mountM[4]!==undefined ? parseInt(mountM[4],10) : null, mountEndStitchIdx: mountM[5]!==undefined ? parseInt(mountM[5],10) : null,
      mountAngle: mountM[6]!==undefined ? parseFloat(mountM[6]) : null,
      mountFlagFlat: flags.has('flat'), mountFlagTube: flags.has('tube'), mountFlip: flags.has('flip')}];
  }

  // Strip trailing stitch count: (12) or {12}
  const cleaned = s.replace(/[\(\{]\s*\d+\s*[\)\}]\s*$/, '').trim();

  // Reattach prefix: attach:r3-flo, ... / attach:r3-blo, ...
  // Lets this round start from an EARLIER round's un-worked loop instead of
  // the round immediately before it - e.g. working a second color into the
  // front loops a flo round left open several rounds back. "r3" is the
  // number shown in the gutter, NOT a raw line position - a standalone CC:
  // line or an earlier attach: round doesn't get its own gutter number, so
  // resolving this against raw array position would drift as soon as
  // either of those appears before the target. The actual round is
  // resolved back in parsePattern (attachDisplayNum below), which has the
  // rounds-so-far needed to compute real gutter numbers; parseLine itself
  // has no access to prior rounds so it can only pass the literal number
  // the user wrote straight through.
  let attachTo = null;
  const attachM = cleaned.match(/^attach:r(\d+)-(blo|flo)\s*,\s*/i);
  let body2 = cleaned;
  if (attachM) {
    attachTo = { attachDisplayNum: parseInt(attachM[1]), loop: attachM[2].toLowerCase() };
    body2 = cleaned.slice(attachM[0].length);
  }

  // Fuse prefix: fuse:leg1+ch2:bridge+leg2, 36sc
  // Same idea as attach: - it says what this round's BASE is, before its
  // own ops (36sc, incs, whatever) run - except the base isn't an earlier
  // round of THIS piece, it's stitched together out of another saved
  // piece's live last round plus a few bridging chain stitches. This is
  // real crochet's "legs left unfinished, then worked into as one round
  // with the body" technique - a piece never gets a "join" step, it just
  // keeps being the base for the next round, exactly like MR or a normal
  // previous round already are. A piece segment is a bare piece name or
  // name.last (both mean the same thing: that piece's actual last round -
  // there's no name.rN selector for an arbitrary round, since "which round
  // is Nth" isn't stable once a piece can contain non-row lines like a
  // standalone CC:color). A chain segment is ch3, or ch2:bridge to NAME
  // it - naming it lets a later bare "bridge" re-cross those exact same
  // chain stitches instead of making a new one, which is what really
  // happens: one short chain sits in the gap between two pieces and the
  // round passes it twice (leaving one piece, and again closing back into
  // the first), so each of those chain stitches ends up with 2 stitches
  // worked into it total, same as any inc. An unnamed ch3 behaves the
  // same way automatically - the name is only for when you need to place
  // that second crossing somewhere other than the end, or need to tell
  // two DIFFERENT bridges apart. A bridge can carry more than one color:
  // ch3+CC:coral+ch3 (or ch3:bridge+CC:coral+ch3:bridge, if it's named)
  // makes one 6-stitch chain, the first half in whatever color was
  // already running and the second half in coral - a CC:color token
  // inside a fuse spec just sets the color for whatever chain stitches
  // follow it, the same way it would mid-row anywhere else.
  let fuseSpec = null;
  if (!attachTo) {
    const tokenPat = '(?:ch\\d+(?::[a-z0-9_]+)?|cc:[a-z0-9#_-]+|[a-z0-9_]+(?:\\.last)?)';
    const fuseM = body2.match(new RegExp(`^fuse:(${tokenPat}(?:\\+${tokenPat})*)\\s*,\\s*`, 'i'));
    if (fuseM) {
      const segStrs = fuseM[1].split('+');
      const declaredBridges = new Set();
      // Keyed by bridgeName - INCLUDING the literal value null for the (at
      // most one) unnamed bridge in this fuse round, so repeated or
      // anonymous ch declarations extend one combined chain instead of
      // each starting an independent one.
      const chainByKey = new Map();
      let runningColor = null; // last CC:color seen while walking the spec
      fuseSpec = [];
      for (const seg of segStrs) {
        const ccM = seg.match(/^cc:([a-z0-9#_-]+)$/i);
        if (ccM) { runningColor = ccM[1].toLowerCase(); continue; }
        const chM = seg.match(/^ch(\d+)(?::([a-z0-9_]+))?$/i);
        if (chM) {
          const n = parseInt(chM[1]);
          const bridgeName = chM[2] ? chM[2].toLowerCase() : null;
          declaredBridges.add(bridgeName);
          let chain = chainByKey.get(bridgeName);
          if (!chain) { chain = { kind:'chain', n:0, bridgeName, colorRuns:[] }; chainByKey.set(bridgeName, chain); fuseSpec.push(chain); }
          chain.n += n;
          chain.colorRuns.push({ n, color: runningColor });
          continue;
        }
        const pieceM = seg.match(/^([a-z0-9_]+)(?:\.(last))?$/i);
        const nm = pieceM[1].toLowerCase();
        // A bare piece name and name.last mean the same thing (that piece's
        // own last round) - the explicit .rN round selector was dropped:
        // it depended on "topmost row" numbering that doesn't hold up once
        // a piece can contain non-row lines (standalone CC, etc), so a
        // fuse segment only ever targets a piece's actual last round now.
        if (!pieceM[2] && declaredBridges.has(nm)) { fuseSpec.push({ kind:'chainRef', bridgeName: nm }); continue; }
        fuseSpec.push({ kind:'piece', name: nm, round: 'last' });
      }
      // A CC:color token inside the fuse spec (e.g. the pink half of a
      // bridge chain) is meant to keep running forward past the fuse spec
      // itself, the same way any mid-row CC: keeps running forward until
      // the next one - see "Color change prefix" below, which picks this
      // up when the round has no explicit CC: of its own right after the
      // fuse. Without capturing it here, that trailing color was silently
      // dropped: the round's own stitches (19sc, say) defaulted back to
      // whatever color was active BEFORE the fuse round even started,
      // instead of the color the fuse spec actually ended on.
      fuseSpec.trailingColor = runningColor;
      // A declared bridge (ch2:bridge, or an unnamed ch2) has to be
      // crossed TWICE to actually close the ring - once where it's
      // declared, once more later, written as a bare "bridge" token.
      // Requiring that second token explicitly was redundant for the
      // common case of exactly one bridge between exactly two pieces:
      // there's only one place left for it to go (right before the ring
      // wraps back around to the start), so if a bridge was declared but
      // never referenced again, assume that's what's meant and add the
      // re-crossing automatically. A pattern that genuinely needs the
      // crossing somewhere else (more than 2 pieces, multiple bridges)
      // can still write "bridge" explicitly wherever it belongs, or name
      // its second bridge something else - this only fills in the gap
      // when nothing else claimed it.
      for (const bridgeName of declaredBridges) {
        const alreadyReferenced = fuseSpec.some(s => s.kind === 'chainRef' && s.bridgeName === bridgeName);
        if (!alreadyReferenced) fuseSpec.push({ kind:'chainRef', bridgeName });
      }
      // Real crochet convention: the FIRST-named piece in the spec is the
      // one whose stitches are already live (still on the hook from making
      // it) - you work the bridge chain, then cross INTO the last-named
      // piece, and continue back around into the first piece's own
      // remaining stitches. Physically that puts the first-named piece on
      // the RIGHT (it's the working end you start from) and the last-
      // named piece on the LEFT (the one you cross over into) - the
      // opposite of naive left-to-right reading order. Rather than teach
      // the placement/facing logic below about this, it's simpler to fix
      // it right here: swap the piece segments into their mirrored slots
      // (first <-> last, and so on inward) so that logic can stay exactly
      // as simple as "first segment = left, last segment = right" and
      // just be handed an already-corrected order. Chain/chainRef entries
      // keep their original positions - only which PIECE occupies each
      // piece-shaped slot changes.
      const pieceSlots = [];
      for (let i = 0; i < fuseSpec.length; i++) if (fuseSpec[i].kind === 'piece') pieceSlots.push(i);
      const pieces = pieceSlots.map(i => fuseSpec[i]);
      for (let k = 0; k < pieceSlots.length; k++) fuseSpec[pieceSlots[k]] = pieces[pieces.length - 1 - k];
      // A chain's own color runs were written relative to which piece
      // used to be on which side BEFORE the swap above - e.g. "ch3+CC:
      // pink+ch3" means "stay default until you're near the piece that
      // was written last, then go pink", which only reads correctly
      // adjacent to that same piece. Since that piece just moved to the
      // opposite side, the chain's run order needs to flip right along
      // with it, or the color would end up trailing toward the wrong
      // piece now.
      if (pieceSlots.length >= 2) {
        for (const s of fuseSpec) {
          if (s.kind === 'chain' && s.colorRuns.length > 1) s.colorRuns.reverse();
        }
      }
      body2 = body2.slice(fuseM[0].length);
    }
  }

  // Check for modifier prefix: blo, flo (skipped if this round already
  // has an attach directive - the attach's own loop already says which
  // side is being worked into, a second blo/flo here would be redundant)
  let modifier = null;
  let body = body2;
  if (!attachTo) {
    const modM = body2.match(/^(blo|flo)\s*,\s*/);
    if (modM) { modifier = modM[1]; body = body2.slice(modM[0].length); }
  }

  // Color change prefix
  let color = null;
  const ccM = body.match(/^cc:([a-z0-9#_-]+)\s*,?\s*/i);
  if (ccM) { color = ccM[1]; body = body.slice(ccM[0].length); }
  else if (fuseSpec && fuseSpec.trailingColor) { color = fuseSpec.trailingColor; }

  // Standalone color change: a line that's ONLY "CC:color" and nothing
  // else. Sets the working color forward the same as an inline "CC:color,"
  // prefix would, but this line has no stitches of its own, so it isn't a
  // round/row - see parsePattern's isColorOnly handling, which threads the
  // color through without pushing a real stitch round (same treatment as
  // 'turn'/'fo'). Only counts as standalone if nothing else claimed this
  // line first (no attach/fuse/blo/flo).
  if (ccM && body === '' && !attachTo && !fuseSpec && !modifier) {
    return [{op:'colorOnly', color}];
  }

  // Turn
  if (body === 'turn') return [{op:'turn'}];
  // Sew closed (shorthand: fold): closes the most recent ring by creasing it
  // flat and whip-stitching each mirror-opposite pair of stitches together
  // (the "ch 1, fold in half, sc across both sides" technique used to
  // flatten and shut an ear/arm/leg tip). See parsePattern/compileGraph for
  // the actual pairing logic.
  if (body === 'sew closed' || body === 'fold') return [{op:'fold'}];
  // Sc closed (shorthand: scclose): like sew closed (mirrored-pair closure
  // of the last ring), but instead of a flush whip-stitched seam this
  // actually single crochets a brand new round through both paired layers -
  // a real round with its own stitch height/texture, not a flattened join.
  // See parsePattern/compileGraph for the shared pairing logic and where
  // the two diverge.
  if (body === 'sc closed' || body === 'scclose') return [{op:'scclose'}];
  if (body === 'join' || body === 'slst' || body === 'ss' || body === 'sl') return [{op:'slst',count:1,modifier}];

  // MR: magic ring
  const mrM = body.match(/^mr:(\d+)$/);
  if (mrM) return [{op:'mr', count:parseInt(mrM[1]), color}];

  // CHR: chain bent into a ring - same N-stitch ring shape as MR:N (closed
  // loop, same lateral spacing) but NO center hub/cinch point. A magic ring
  // is real fiber pulled snug around a shared center; a chain ring is just
  // a chain of links whose two ends are joined with a slip stitch - nothing
  // pulls the middle inward. See parsePattern/compileGraph for how this
  // diverges from mr (isChr instead of isMR, no addHub call).
  const chrM = body.match(/^chr:(\d+)$/);
  if (chrM) return [{op:'chr', count:parseInt(chrM[1]), color}];

  // ch:N - foundation chain, starts a FLAT piece (open rows, no ring-closing
  // edge) instead of a tube. The colon is required - a bare "ch21" isn't a
  // recognized token; a full round of chain stitches with no colon is
  // chr:N (chain ring) instead.
  const chFoundM = body.match(/^ch:(\d+)$/);
  if (chFoundM) return [{op:'chainFoundation', count:parseInt(chFoundM[1]), color}];

  // Expand repeat groups: [sc,inc] x 6
  const expanded = expandRepeats(body);
  if (!expanded) return null;

  const tokens = expanded.split(',').map(t=>t.trim()).filter(Boolean);
  const ops = [];
  let runningColor = color;
  // graft:name - the shared attach point where a separately-solved,
  // already-closed piece (an arm, sewn shut with fold/scclose) gets glued
  // onto this round - e.g. "2sc, graft:arm1, 2sc" mirrors the real crochet
  // instruction "sc 4 through both the arm and the body", except the
  // stitch count isn't written out here at all - it's resolved from
  // arm1's own closing-seam stitch count in parsePattern. Unlike fuse: (a
  // whole round built FROM another piece's live stitches, solved together
  // as one graph), graft's piece is fully solved and closed on its own
  // beforehand and never shares graph edges with this piece at all - it's
  // positioned afterward by a rigid best-fit transform plus a lean (see
  // reattachFusedPiecesFromSolo and its call in solveGraph). An optional
  // @angle (e.g. graft:arm1@225) forces a specific lean in degrees instead
  // of DEFAULT_GRAFT_ANGLE_DEG.
  for (const tok of tokens) {
    const ccTokM = tok.match(/^cc:([a-z0-9#_-]+)$/i);
    if (ccTokM) { runningColor = ccTokM[1].toLowerCase(); continue; }
    const graftTokM = tok.match(/^graft:([a-z0-9_-]+)(?:@(-?\d+(?:\.\d+)?))?$/i);
    if (graftTokM) { ops.push({op:'graftAuto', graftName: graftTokM[1].toLowerCase(), graftAngle: graftTokM[2]!==undefined ? parseFloat(graftTokM[2]) : null, graftInstanceId: bumpGraftInstanceCounter(), color: runningColor}); continue; }
    const op = parseToken(tok, modifier, runningColor);
    if (op) ops.push(op);
  }
  if (!ops.length) return null;
  if (attachTo) ops.unshift({op:'attach', attachDisplayNum:attachTo.attachDisplayNum, loop:attachTo.loop});
  if (fuseSpec) ops.unshift({op:'fuse', segments:fuseSpec});
  return ops;
}

function expandRepeats(s) {
  // Handle [...] x N and (...) x N  (can be nested once)
  let result = s;
  const re = /[\[\(]([^\[\]\(\)]+)[\]\)]\s*x\s*(\d+)/g;
  let m;
  let limit = 20;
  while ((m = re.exec(result)) !== null && limit-- > 0) {
    const inner = m[1];
    const times = parseInt(m[2]);
    const expanded = Array(times).fill(inner).join(',');
    result = result.slice(0,m.index) + expanded + result.slice(m.index+m[0].length);
    re.lastIndex = 0; // restart
  }
  return result;
}

function parseToken(tok, modifier, color) {
  // bobble / puff / popcorn
  let bm;
  bm = tok.match(/^(?:(dc|hdc|tr)(\d+))?bobble$/);
  if (bm) return {op:'bobble', base:bm[1]||'dc', legs:bm[2]?parseInt(bm[2]):5, count:1, modifier, color};
  bm = tok.match(/^(?:(hdc|dc)(\d+))?puff(?:st)?$/);
  if (bm) return {op:'puff', base:bm[1]||'hdc', legs:bm[2]?parseInt(bm[2]):3, count:1, modifier, color};
  bm = tok.match(/^(?:(dc)(\d+))?(?:popcorn|pop)$/);
  if (bm) return {op:'popcorn', base:bm[1]||'dc', legs:bm[2]?parseInt(bm[2]):4, count:1, modifier, color};

  // fan: N separate full stitches all worked into the SAME one base stitch
  // (e.g. "3 hdc in each stitch around" -> hdc3fan). Different from bobble
  // (which gathers partial legs at one shared top) and different from a
  // plain count like "3hdc" (which is 3 separate stitches consuming 3
  // base stitches, not a multiply-increase into one).
  bm = tok.match(/^(sc|hdc|dc|tr|dtr)(\d+)fan$/);
  if (bm) return {op:'stitch', stitch:'fan', base:bm[1], fanCount:parseInt(bm[2]), count:1, modifier, color};

  // skip
  if (/^sk(?:ip)?$/.test(tok)) return {op:'sk', count:1};
  if (/^sk(?:ip)?(\d+)$/.test(tok)) { const m=tok.match(/\d+/); return {op:'sk', count:parseInt(m[0])}; }

  // slst
  if (/^(?:slst|ss|sl)$/.test(tok)) return {op:'stitch', stitch:'slst', count:1, modifier, color};

  // inc / dec bare
  if (tok==='inc') return {op:'stitch', stitch:'inc', count:1, modifier, color};
  if (tok==='dec') return {op:'stitch', stitch:'dec', count:1, modifier, color};

  // N stitch (e.g. 6sc, 6inc, 6dec, 3hdc)
  let m = tok.match(/^(\d+)(sc|hdc|dc|tr|dtr|trtr|inc|dec|slst)$/);
  if (m) return {op:'stitch', stitch:m[2], count:parseInt(m[1]), modifier, color};

  // stitch N (e.g. sc6, inc6, dec6)
  m = tok.match(/^(sc|hdc|dc|tr|dtr|trtr|inc|dec|slst)(\d+)$/)
  if (m) return {op:'stitch', stitch:m[1], count:parseInt(m[2]), modifier, color};

  // bare stitch (sc, hdc, dc, tr)
  m = tok.match(/^(sc|hdc|dc|tr|dtr|trtr)$/);
  if (m) return {op:'stitch', stitch:m[1], count:1, modifier, color};

  return null;
}

// Parse full pattern from lines array, returns {rounds:[{ops, stitchCount, color, error}]}
// Resolves one fuse: piece-segment against the saved-piece library: parses
// that piece's own lines (recursively, so a fused piece can itself contain
// a fuse - guarded against cycles via `visiting`), finds the target round
// (its last stitch round by default, or an explicit .rN), and returns its
// stitch count plus its index among that piece's OWN valid stitch rounds -
// which is exactly the index compileGraph's roundNodes will use for it,
// since compileGraph filters rounds the same way (isFO/isTurn/stitchCount<=0
// dropped) that `validRounds` does here.
// fuse: piece names are lowercased during parsing (same as every other
// token) so LEGA/lega/LegA all refer to the same reference in pattern text
// - but the library object itself is keyed by the pattern's saved name
// exactly as typed in the UI ("LegA"), which is case-sensitive. A naive
// library[name] lookup after lowercasing fails on any saved name that
// isn't already all-lowercase, even though the piece is right there in the
// list - reported confusingly as "no saved piece named X". This does a
// case-insensitive match against the library's real keys instead.
function libGetEntry(library, name) {
  if (!library) return undefined;
  if (library[name] !== undefined) return library[name];
  const target = name.toLowerCase();
  for (const k in library) {
    if (k.toLowerCase() === target) return library[k];
  }
  return undefined;
}

// Saved pieces used to be stored as a bare lines array; now they're
// {lines, markers} so a piece's markers travel with it (see saveCurrentPattern).
// Both libGet and libGetMarkers unwrap through libGetEntry and fall back
// gracefully on the old bare-array shape so existing localStorage data
// (or a hand-authored library) keeps working with no migration step.
export function libGet(library, name) {
  const entry = libGetEntry(library, name);
  if (entry === undefined) return undefined;
  return Array.isArray(entry) ? entry : entry.lines;
}
function libGetMarkers(library, name) {
  const entry = libGetEntry(library, name);
  if (!entry || Array.isArray(entry)) return [];
  return entry.markers || [];
}

// The crochet-facing round number shown in the gutter for each round in
// `rounds`, plus the count of real numbered rows overall. A standalone CC:
// line, a 'turn', a 'fo', and an attach:rN round are all genuine entries in
// `rounds` (so error highlighting and attach:rN targeting still have
// something to point at) but none is a "row" in the pattern-reading sense -
// CC only sets a color and produces no stitches, turn/fo are instructions
// rather than rounds of stitches, and attach works back into an EARLIER
// row's spare loop rather than starting a new row of its own - so none of
// them gets a number, and none bumps the count for whatever comes after it.
// Used both to render the editor gutter and, during parsing, to resolve
// what round an attach:rN in the pattern actually means (the number the
// user sees, not raw array position - those two only happen to coincide
// when nothing before the target hid its own number).
// A fuse: round is a special case - it isn't picking up where THIS piece's
// own numbering left off, it's continuing the same working thread the
// fused piece(s) were already on, so its round object carries
// fuseBaseDisplayNum (the largest last-row number among whatever it fuses,
// see the fuse segment loop below) and the counter jumps forward to match
// before numbering the fuse round itself.
export function computeDisplayNumbers(rounds) {
  const displayNums = [];
  let counter = 0;
  for (let i = 0; i < rounds.length; i++) {
    const rnd = rounds[i];
    if (rnd.isColorOnly || rnd.attachTo || rnd.isFO || rnd.isPullClosed || rnd.isTurn || rnd.isMountOnly) {
      displayNums[i] = '';
    } else {
      if (rnd.fuseBaseDisplayNum != null) counter = Math.max(counter, rnd.fuseBaseDisplayNum);
      counter++;
      displayNums[i] = String(counter);
    }
  }
  return { displayNums, count: counter };
}

export function resolveLibraryRound(name, roundSel, library, visiting) {
  if (visiting.has(name)) return { error: `fuse: circular reference through "${name}"` };
  const libLines = libGet(library, name);
  if (!libLines) return { error: `fuse: no saved piece named "${name}"` };
  const sub = parsePattern(libLines, { library, visiting: new Set([...visiting, name]) });
  if (sub.rounds.some(r => r.error)) return { error: `fuse: "${name}" has its own unresolved pattern errors` };
  const validRounds = sub.rounds.filter(r => r.stitchCount > 0 && !r.isFO && !r.isPullClosed && !r.isTurn && !r.isColorOnly);
  if (!validRounds.length) return { error: `fuse: "${name}" has no stitch rounds yet` };

  // An attach:rN-blo/flo row (see parseLine) is a side branch - it works
  // back into an EARLIER round's skipped loop rather than building upward,
  // so it (and anything built sequentially on top of IT) should never be
  // mistaken for "the top of the piece". Without this, an unqualified
  // fuse:name (roundSel === 'last') could resolve to something like an
  // ear or arm tacked on after the main body, instead of the main body's
  // actual last row - propagate main-body-ness the same way roundAttachTo
  // continuation is tracked elsewhere (see continuedFrom in compileGraph):
  // a round starts a new branch if it has its own attachTo, otherwise it
  // inherits whatever the immediately previous round was.
  const isMainBody = [];
  for (let i = 0; i < sub.rounds.length; i++) {
    isMainBody[i] = sub.rounds[i].attachTo ? false : (i === 0 ? true : isMainBody[i-1]);
  }
  const mainBodyRounds = validRounds.filter(r => isMainBody[sub.rounds.indexOf(r)]);

  const target = roundSel === 'last'
    ? (mainBodyRounds.length ? mainBodyRounds[mainBodyRounds.length - 1] : validRounds[validRounds.length - 1])
    : (sub.rounds[roundSel] && sub.rounds[roundSel].stitchCount > 0 ? sub.rounds[roundSel] : null);
  if (!target) return { error: `fuse: "${name}" has no round r${roundSel==='last' ? '' : roundSel+1}` };
  const targetDisplayNum = parseInt(computeDisplayNumbers(sub.rounds).displayNums[sub.rounds.indexOf(target)], 10) || 0;
  return { count: target.stitchCount, validIndex: validRounds.indexOf(target), displayNum: targetDisplayNum, isFold: !!target.isFold, isScClose: !!target.isScClose };
}

export function parsePattern(lines, opts) {
  const library = (opts && opts.library) || {};
  const visiting = (opts && opts.visiting) || new Set();
  const rounds = [];
  // Pre-scan: does 'turn' appear ANYWHERE in this pattern? A piece worked
  // flat (back and forth in rows) always turns between rows somewhere -
  // but not necessarily right after the foundation chain itself (a real
  // pattern's first row after ch:N never has a turn before it either way,
  // flat or not - the turn shows up between row 1 and row 2). So this has
  // to be a whole-pattern lookahead, not a check on the very next line.
  // Used below to tell a flat first row apart from a chain worked IN THE
  // ROUND (oval base), without any new notation - see the chainInRound
  // detection further down.
  let hasTurnAnywhere = false;
  for (const rawLine of lines) {
    const stripped = rawLine.replace(/^(?:rnd|r(?:ow)?|round)\s*\d+\s*[:\-]?\s*/i,'').trim();
    if (!stripped) continue;
    const probeOps = parseLine(stripped);
    if (probeOps && probeOps.length===1 && probeOps[0].op==='turn') { hasTurnAnywhere = true; break; }
  }
  // Tracks which loop of each round has already been worked into, so a
  // later round (whether a normal next round, a blo/flo round, or an
  // explicit attach:) can't claim a loop that's already spoken for. A
  // normal (unmodified) attachment claims BOTH loops at once - real
  // crochet doesn't leave anything free behind it.
  const loopUsage = []; // parallel to `rounds`: {front, back, both}
  let prevCount = 0;
  let currentColor = 'default';
  let hasMR = false;
  // null while the working yarn is live; 'fo' or 'pullClosed' once it's been
  // cut - by an explicit 'fo', or by 'pull closed' (gathering the tip shut
  // is itself a finishing action, the tail doing the gathering IS the
  // fasten-off tail - there's no real scenario where you cinch a tip closed
  // and then keep stitching into it). 
  let yarnCutBy = null;
  // rounds.length-1 isn't safe to use as "the previous round" on its own -
  // turn/fo lines get pushed as placeholder entries with no real stitch
  // tops, so a normal round right after one of those would end up
  // checking loop-usage against the placeholder instead of the actual
  // last round of stitches.
  let lastStitchRoundIdx = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/^(?:rnd|r(?:ow)?|round)\s*\d+\s*[:\-]?\s*/i,'').trim();
    if (!raw) continue;

    let ops = parseLine(raw);
    if (!ops || ops.length===0) {
      rounds.push({index:rounds.length, ops:[], stitchCount:0, error:'Could not parse: '+raw});
      loopUsage.push({front:false, back:false, both:false});
      continue;
    }

    // fo
    if (ops[0].op==='fo') {
      rounds.push({index:rounds.length, ops, stitchCount:0, isFO:true, color:currentColor});
      loopUsage.push({front:true, back:true, both:true});
      yarnCutBy = 'fo';
      continue;
    }
    // pull closed
    if (ops[0].op==='pullClosed') {
      rounds.push({index:rounds.length, ops, stitchCount:0, isPullClosed:true, color:currentColor});
      loopUsage.push({front:true, back:true, both:true});
      yarnCutBy = 'pullClosed';
      continue;
    }
    // turn
    if (ops[0].op==='turn') {
      rounds.push({index:rounds.length, ops, stitchCount:0, isTurn:true});
      loopUsage.push({front:true, back:true, both:true});
      continue;
    }
    // colorOnly: standalone "CC:color" line - carries the working color
    // forward (same as any inline CC prefix would) but produces no
    // stitches, so it's not a real row. Treated like turn/fo: it still
    // gets its own entry in `rounds` (keeps 1:1 alignment with textarea
    // lines for the gutter and for attach:rN targeting), just never
    // becomes lastStitchRoundIdx and is excluded downstream anywhere
    // stitchCount>0 is required (compileGraph, resolveLibraryRound's
    // validRounds, etc).
    if (ops[0].op==='colorOnly') {
      currentColor = ops[0].color;
      rounds.push({index:rounds.length, ops, stitchCount:0, isColorOnly:true, color:currentColor});
      loopUsage.push({front:true, back:true, both:true});
      continue;
    }
    // mount:name@rN:S - resolve N against the same display numbering
    // attach:rN uses (rounds built so far, real gutter numbers), then
    // validate S actually falls within that round's stitch count and that
    // `name` is a real saved piece. Produces no stitches of its own (like
    // attach:/colorOnly/fo/turn) - never becomes lastStitchRoundIdx, never
    // counted anywhere stitchCount>0 is required (compileGraph's own-round
    // loop, resolveLibraryRound's validRounds, etc all already filter on
    // that, so no separate exclusion is needed there).
    if (ops[0].op==='mount') {
      const requestedNum = ops[0].mountDisplayNum;
      const { displayNums: soFarDisplayNums } = computeDisplayNumbers(rounds);
      const target = soFarDisplayNums.indexOf(String(requestedNum));
      let mountError = null;
      let endTarget = null;
      const isSpan = ops[0].mountEndDisplayNum != null;
      if (target < 0) {
        mountError = `mount:${ops[0].mountName}@r${requestedNum} refers to a round that doesn't exist yet`;
      } else if (rounds[target].isMR || rounds[target].isFO || rounds[target].isPullClosed || rounds[target].isTurn || rounds[target].isChainFoundation || rounds[target].isFold || rounds[target].isScClose || rounds[target].isColorOnly || rounds[target].isChr || rounds[target].isMountOnly) {
        mountError = `Round ${requestedNum} has no stitch tops to mount onto`;
      } else if (ops[0].mountStitchIdx < 1 || ops[0].mountStitchIdx > rounds[target].stitchCount) {
        mountError = `mount:${ops[0].mountName}@r${requestedNum}:${ops[0].mountStitchIdx} - stitch ${ops[0].mountStitchIdx} doesn't exist in round ${requestedNum} (has ${rounds[target].stitchCount})`;
      } else if (!libGet(library, ops[0].mountName)) {
        mountError = `mount: no saved piece named "${ops[0].mountName}"`;
      } else if (ops[0].mountFlagFlat && ops[0].mountFlagTube) {
        mountError = `mount: cannot be both !flat and !tube`;
      } else if (isSpan) {
        // Span mount: mount:name,rN:S-rM:T - the piece's own closing seam
        // (a straight open row of stitches, see resolveLibraryRound below)
        // gets laid diagonally across the body from (N,S) to (M,T) instead
        // of protruding/lying flat from a single point. Both ends already
        // got their literal numbers extracted in parseLine; here we
        // validate the END point exactly the same way the start point
        // (target/requestedNum, just above) already was - same three
        // checks, same error shape - plus one requirement that's unique
        // to span mode: the piece has to actually END in a fold/scclose
        // seam, since a span only makes sense for a piece whose "far end"
        // is a straight line of stitches with a real first/last stitch to
        // pin down, not a full closed ring (see the conversation this
        // feature came out of - graft's exact-seam-match placement was
        // ruled out for the same underlying reason, a diagonal span isn't
        // a "round"). Real distance/reachability (does the body's actual
        // shortest path between these two exact points have as many hops
        // as the seam has stitches) can't be checked yet here - that
        // needs the body's own compiled stitch graph, which doesn't exist
        // until compileGraph - so that check happens there instead; see
        // mountPieceGroups in compileGraph.
        const endNum = ops[0].mountEndDisplayNum;
        endTarget = soFarDisplayNums.indexOf(String(endNum));
        if (endTarget < 0) {
          mountError = `mount:${ops[0].mountName}@r${requestedNum}:${ops[0].mountStitchIdx}-r${endNum} refers to a round that doesn't exist yet`;
        } else if (endTarget === target) {
          mountError = `mount: span needs two different rows (both ends were r${requestedNum})`;
        } else if (rounds[endTarget].isMR || rounds[endTarget].isFO || rounds[endTarget].isPullClosed || rounds[endTarget].isTurn || rounds[endTarget].isChainFoundation || rounds[endTarget].isFold || rounds[endTarget].isScClose || rounds[endTarget].isColorOnly || rounds[endTarget].isChr || rounds[endTarget].isMountOnly) {
          mountError = `Round ${endNum} has no stitch tops to mount onto`;
        } else if (ops[0].mountEndStitchIdx < 1 || ops[0].mountEndStitchIdx > rounds[endTarget].stitchCount) {
          mountError = `mount:${ops[0].mountName}@r${requestedNum}:${ops[0].mountStitchIdx}-r${endNum}:${ops[0].mountEndStitchIdx} - stitch ${ops[0].mountEndStitchIdx} doesn't exist in round ${endNum} (has ${rounds[endTarget].stitchCount})`;
        } else {
          const resolved = resolveLibraryRound(ops[0].mountName, 'last', library, visiting);
          if (resolved.error) {
            mountError = resolved.error.replace(/^fuse:/, 'mount:');
          } else if (!resolved.isFold && !resolved.isScClose) {
            mountError = `mount: a span (r${requestedNum}:${ops[0].mountStitchIdx}-r${endNum}:${ops[0].mountEndStitchIdx}) needs "${ops[0].mountName}" to end in a sew closed / sc closed round - a single point (mount:${ops[0].mountName}@r${requestedNum}:${ops[0].mountStitchIdx}) works for any piece, but a span needs a real seam with its own first/last stitch to lay across the gap`;
          }
        }
      }
      rounds.push({index:rounds.length, ops, stitchCount:0, isMountOnly:true, color:currentColor,
        mountSpec: {name: ops[0].mountName, round: target, stitchIdx: ops[0].mountStitchIdx, angleOverride: ops[0].mountAngle,
          endRound: isSpan ? endTarget : null, endStitchIdx: isSpan ? ops[0].mountEndStitchIdx : null,
          modeOverride: ops[0].mountFlagFlat ? 'flat' : ops[0].mountFlagTube ? 'tube' : null, flip: ops[0].mountFlip},
        error: mountError});
      loopUsage.push({front:true, back:true, both:true});
      continue;
    }
    // fold: creases the most recent ring flat along an axis that runs
    // BETWEEN two pairs of opposite stitches (not through any stitch) -
    // pairs stitch i with stitch (n-1-i) all the way around, so every
    // single stitch has a mirror partner and none sit unpaired on the
    // crease itself. Needs an even stitch count so the pairing comes out
    // exact. Produces a new open row of exactly prevCount/2 sts: one new
    // seam stitch per pair, no leftover crease-point stitches.
    if (ops[0].op==='fold') {
      const prevN = prevCount;
      let foldError = null;
      if (lastStitchRoundIdx == null || prevN < 4) {
        foldError = 'sew closed needs a previous round of at least 4 sts to close';
      } else if (prevN % 2 !== 0) {
        foldError = `sew closed needs an even stitch count to pair opposite sides (round has ${prevN})`;
      }
      const stitchCount = foldError ? 0 : (prevN/2);
      rounds.push({index:rounds.length, ops, stitchCount, consumedCount:prevN, isFold:true, color:currentColor, error:foldError});
      loopUsage.push({front:true, back:true, both:true});
      if (!foldError) { prevCount = stitchCount; lastStitchRoundIdx = rounds.length - 1; }
      continue;
    }
    // scclose: same mirrored-pair topology as fold (needs an even stitch
    // count, produces exactly prevCount/2 new sts, no leftover crease-point
    // stitches), but a genuinely separate round of real sc stitches rather
    // than a flush whip-stitched seam - see compileGraph for how the two
    // diverge once nodes/edges are built.
    if (ops[0].op==='scclose') {
      const prevN = prevCount;
      let scCloseError = null;
      if (lastStitchRoundIdx == null || prevN < 4) {
        scCloseError = 'sc closed needs a previous round of at least 4 sts to close';
      } else if (prevN % 2 !== 0) {
        scCloseError = `sc closed needs an even stitch count to pair opposite sides (round has ${prevN})`;
      }
      const stitchCount = scCloseError ? 0 : (prevN/2);
      rounds.push({index:rounds.length, ops, stitchCount, consumedCount:prevN, isScClose:true, color:currentColor, error:scCloseError});
      loopUsage.push({front:true, back:true, both:true});
      if (!scCloseError) { prevCount = stitchCount; lastStitchRoundIdx = rounds.length - 1; }
      continue;
    }
    // mr
    if (ops[0].op==='mr') {
      // A magic ring is THE foundation ring for a piece - there's only ever
      // one. A second MR: later in the same pattern used to be treated as a
      // deliberate second, disconnected piece - but that's exactly what
      // separate saved components joined with mount:/fuse: are for now, so
      // a repeat MR: here is flagged instead of silently starting a second
      // unconnected ring.
      if (rounds.length !== 0) {
        rounds.push({index:rounds.length, ops, stitchCount:0, error:`A second magic ring isn't allowed in one pattern - each piece has exactly one starting ring; build the rest as a separate component and join with mount:/fuse:`});
        loopUsage.push({front:false, back:false, both:false});
        yarnCutBy = null; // the specific error is already shown right here - don't also flag the next line with the generic "continues after" message
        continue;
      }
      const startColor = currentColor;
      const count = ops[0].count;
      if (ops[0].color) currentColor = ops[0].color;
      hasMR = true;
      yarnCutBy = null; // fresh foundation - a new length of yarn, whatever came before is irrelevant
      rounds.push({index:rounds.length, ops, stitchCount:count, isMR:true, color:currentColor, startColor});
      loopUsage.push({front:false, back:false, both:false});
      prevCount = count;
      lastStitchRoundIdx = rounds.length - 1;
      continue;
    }
    // chr: chain ring - same closed-ring shape as mr but no hub (see notes
    // at the chr: token parser above). Same one-ring-per-piece restriction
    // as mr: above, for the same reason.
    if (ops[0].op==='chr') {
      if (rounds.length !== 0) {
        rounds.push({index:rounds.length, ops, stitchCount:0, error:`A second chain ring isn't allowed in one pattern - each piece has exactly one starting ring; build the rest as a separate component and join with mount:/fuse:`});
        loopUsage.push({front:false, back:false, both:false});
        yarnCutBy = null; // the specific error is already shown right here - don't also flag the next line with the generic "continues after" message
        continue;
      }
      const startColor = currentColor;
      const count = ops[0].count;
      if (ops[0].color) currentColor = ops[0].color;
      hasMR = true;
      yarnCutBy = null; // fresh foundation - a new length of yarn, whatever came before is irrelevant
      rounds.push({index:rounds.length, ops, stitchCount:count, isChr:true, color:currentColor, startColor});
      loopUsage.push({front:false, back:false, both:false});
      prevCount = count;
      lastStitchRoundIdx = rounds.length - 1;
      continue;
    }
    // ch:N foundation chain - starts a FLAT piece (open rows, no wraparound
    // edge) instead of a tube built from a magic ring. Unlike mr:/chr:, a
    // later ch: is still allowed - a flat piece worked in pieces.
    if (ops[0].op==='chainFoundation') {
      if (yarnCutBy === 'pullClosed') {
        rounds.push({index:rounds.length, ops, stitchCount:0, error:`A new ch: can't follow 'pull closed' - the piece was just gathered shut; build the rest as a separate component and join with mount:/fuse:`});
        loopUsage.push({front:false, back:false, both:false});
        yarnCutBy = null; // the specific error is already shown right here - don't also flag the next line with the generic "continues after" message
        continue;
      }
      const startColor = currentColor;
      const count = ops[0].count;
      if (ops[0].color) currentColor = ops[0].color;
      hasMR = true; // reuse the same "foundation already exists" bookkeeping
      yarnCutBy = null; // fresh foundation - a new length of yarn, whatever came before is irrelevant
      rounds.push({index:rounds.length, ops, stitchCount:count, isChainFoundation:true, color:currentColor, startColor});
      loopUsage.push({front:false, back:false, both:false});
      prevCount = count;
      lastStitchRoundIdx = rounds.length - 1;
      continue;
    }
    // Reattach directive: attach:rN-flo/blo - pull it off the front of ops
    // and validate the target round exists and comes before this one. "N"
    // is the number shown in the gutter, so resolve it against the same
    // display numbering the editor renders (rounds built so far are enough
    // - attach can only ever target something earlier).
    let attachTo = null;
    let attachError = null;
    if (ops[0].op==='attach') {
      const requestedNum = ops[0].attachDisplayNum;
      const { displayNums: soFarDisplayNums } = computeDisplayNumbers(rounds);
      const target = soFarDisplayNums.indexOf(String(requestedNum));
      attachTo = {round: target, loop: ops[0].loop};
      ops = ops.slice(1);
      if (target < 0) {
        attachError = `attach:r${requestedNum}-${attachTo.loop} refers to a round that doesn't exist yet`;
      } else if (rounds[target].isMR || rounds[target].isFO || rounds[target].isPullClosed || rounds[target].isTurn || rounds[target].isChainFoundation || rounds[target].isFold || rounds[target].isScClose || rounds[target].isColorOnly || rounds[target].isMountOnly) {
        attachError = `Round ${requestedNum} has no stitch tops to attach into`;
      }
    }

    // Fuse directive: fuse:legA.last+ch2+legb.last+ch2 - pull it off the
    // front of ops and resolve every segment against the saved-piece
    // library right now, so a bad piece name or a not-yet-consistent
    // referenced piece shows up as a normal round error, same as any other
    // mistake, rather than surfacing later during compile/solve.
    let fuseTo = null;
    let fuseError = null;
    let fuseBaseCount = 0;
    let fuseBaseDisplayNum = 0; // largest last-row number among fused pieces - see computeDisplayNumbers
    if (ops[0].op==='fuse') {
      fuseTo = ops[0].segments.map(seg => ({...seg}));
      ops = ops.slice(1);
      if (rounds.length !== 0) {
        fuseError = `fuse: can only be the very first line of a pattern (round ${rounds.length + 1} isn't the start)`;
      } else
      // v1 scope: the left/right mirroring (see the pieceSlots swap in
      // parseLine) and the placement math in ringPlacement both assume
      // exactly two pieces facing each other across the bridge - a third
      // piece doesn't error, it just silently mis-places, so reject it
      // outright rather than producing a broken shape. Lifting this to N
      // pieces later means generalizing that placement geometry, not just
      // removing this check.
      if (fuseTo.filter(s => s.kind === 'piece').length > 2) {
        fuseError = `fuse: only 2 pieces can be fused together at once (this round names ${fuseTo.filter(s => s.kind === 'piece').length})`;
      }
      for (const seg of fuseTo) {
        if (fuseError) break;
        if (seg.kind === 'chain') { fuseBaseCount += seg.n; continue; }
        if (seg.kind === 'chainRef') {
          const declared = fuseTo.find(s => s.kind==='chain' && s.bridgeName===seg.bridgeName);
          if (!declared) { fuseError = `fuse: bridge "${seg.bridgeName}" was never declared (use ch2:${seg.bridgeName} first)`; break; }
          seg.n = declared.n;
          fuseBaseCount += declared.n;
          continue;
        }
        const resolved = resolveLibraryRound(seg.name, seg.round, library, visiting);
        if (resolved.error) { fuseError = resolved.error; break; }
        seg.count = resolved.count;
        seg.validIndex = resolved.validIndex;
        fuseBaseCount += resolved.count;
        fuseBaseDisplayNum = Math.max(fuseBaseDisplayNum, resolved.displayNum || 0);
      }
    }

    // Normal round: count consumed and produced stitches
    const startColor = currentColor;
    let consumedCount = 0;
    let producedCount = 0;
    let roundColor = currentColor;
    let graftError = null;
    for (const op of ops) {
      if (!op.op) continue;
      // graft:name resolves against the same saved-piece library fuse:
      // uses, right now (not deferred to compile) - this is also where
      // its stitch count comes from, so the pattern itself never repeats
      // a number that could drift out of sync with the piece it names.
      if (op.op === 'graftAuto') {
        if (!graftError) {
          try {
            const resolved = resolveLibraryRound(op.graftName, 'last', library, visiting);
            if (resolved.error) {
              graftError = resolved.error.replace(/^fuse:/, 'graft:');
            } else if (!resolved.isFold && !resolved.isScClose) {
              graftError = `graft: "${op.graftName}" must end with a sew closed / sc closed round before it can be grafted on`;
            } else {
              op.op = 'stitch'; op.stitch = 'sc'; op.modifier = null;
              op.count = resolved.count; op.graftCount = resolved.count;
            }
          } catch (e) {
            graftError = `graft: couldn't resolve "${op.graftName}" (${e.message})`;
          }
        }
        if (op.op === 'graftAuto') continue; // still unresolved (errored) - don't count it as a stitch
      }
      if (op.op==='sk') { consumedCount += op.count||1; continue; }
      if (op.op==='slst') continue;
      if (op.op==='stitch') {
        const s = op.stitch;
        const n = op.count||1;
        if (s==='inc') { consumedCount+=n; producedCount+=n*2; }
        else if (s==='fan') { consumedCount+=n; producedCount+=n*(op.fanCount||3); }
        else if (s==='dec') { consumedCount+=n*2; producedCount+=n; }
        else if (s==='slst') { producedCount+=n; }
        else { consumedCount+=n; producedCount+=n; }
      } else if (['bobble','puff','popcorn'].includes(op.op)) {
        consumedCount+=op.count||1; producedCount+=op.count||1;
      }
      if (op.color) roundColor = op.color;
    }
    // An attach:rN round is its own side branch (see the lastStitchRoundIdx
    // note below) - a CC: change written inside it (e.g. "attach:r4-flo,
    // CC:gold, ...") should color THAT branch, not bleed into the trunk's
    // running color for whatever bare round comes next. Only a non-attach
    // round's color change carries forward.
    if (!attachTo) currentColor = roundColor;

    // The base to validate against: the attach target's stitch count if this
    // round reattaches elsewhere, the combined fused-pieces-plus-chains
    // count if it's a fuse round, otherwise the normal sequential prevCount.
    const baseCount = attachTo ? (rounds[attachTo.round]?.stitchCount ?? 0) : fuseTo ? fuseBaseCount : prevCount;

    // Chain worked IN THE ROUND (oval base): a foundation chain (ch:N) has
    // N physical links, but each link has two loops - real crochet works up
    // the front loops, turns at the tip, then back down the back loops, so
    // the very next round can legitimately consume MORE than N base
    // positions (up to 2N, one per loop per link). No new notation needed -
    // this is inferred purely from: (a) the round right before this one is
    // a plain chain foundation, (b) this round consumes more than that
    // chain's own link count, and (c) 'turn' never shows up anywhere in the
    // pattern (a real flat, back-and-forth piece always turns somewhere,
    // even if not immediately after the chain - see hasTurnAnywhere above).
    const prevRound = rounds[rounds.length - 1];
    const isFollowingChain = !attachTo && prevRound && prevRound.isChainFoundation;
    let isChainInRound = false;

    let error = attachError || fuseError || graftError;
    if (error) {
      // already set
    } else if (!attachTo && !fuseTo && yarnCutBy) {
      // The trunk was already fastened off (or gathered pull-closed, which
      // cuts the yarn just the same) and nothing since then re-founded it
      // (MR:, ch:, chr:) or explicitly re-threaded a new length into an old
      // loop (attach:/fuse:) - this round would silently be built on yarn
      // that's already been cut.
      error = `Pattern continues after ${yarnCutBy === 'pullClosed' ? "'pull closed'" : "'fo'"} - nothing can be built here without a new foundation (MR:, ch:, chr:) or an explicit attach:/fuse:`;
      yarnCutBy = null;
    } else if (!attachTo && !fuseTo && !hasMR && rounds.length===0) {
      // first round without MR - that's fine for flat pieces
    } else if (isFollowingChain && !hasTurnAnywhere && consumedCount > baseCount) {
      if (consumedCount > baseCount * 2) {
        error = `Used ${consumedCount} sts, the ${baseCount}-chain only offers ${baseCount*2}`;
      } else {
        isChainInRound = true;
      }
    } else if (baseCount>0 && consumedCount>baseCount) {
      // Partial consumption is allowed now - a round doesn't have to fully
      // consume its base (attach is optional, not the only way to work
      // into just part of a round). The only real error left is claiming
      // MORE stitches than the base actually has.
      const soFarNums = computeDisplayNumbers(rounds).displayNums;
      error = attachTo
        ? `Used ${consumedCount} sts, round ${soFarNums[attachTo.round]} only has ${baseCount}`
        : fuseTo
        ? `Used ${consumedCount} sts, fused base (${fuseTo.map(s=>s.kind==='chain'?'ch'+s.n+(s.bridgeName?':'+s.bridgeName:''):s.kind==='chainRef'?(s.bridgeName||'bridge')+' (reused, '+s.n+')':s.name+' '+s.count).join(' + ')}) only has ${baseCount}`
        : `Used ${consumedCount} sts, only ${baseCount} available`;
    }

    // Loop-claim check: which round is this attaching to, and which of its
    // loops (front, back, or both) does it claim? A round with no modifier
    // of its own takes both loops at once - nothing is left free behind it.
    let targetIdx = null;
    if (attachTo) targetIdx = attachTo.round;
    else if (!fuseTo) targetIdx = lastStitchRoundIdx;
    const claimedModifier = attachTo ? attachTo.loop : (ops[0]?.modifier || null);
    const loopSide = claimedModifier === 'blo' ? 'back' : claimedModifier === 'flo' ? 'front' : (consumedCount>0 ? 'both' : null);

    // A round that only claims part of its base (fewer stitches than the
    // base round/attach-target/fuse actually offers) is a straight open
    // arc, not a closed ring - it doesn't loop back around to meet its own
    // start the way a round working the base's FULL stitch count does.
    // compileGraph uses this to decide whether this round's own lateral
    // edges wrap around or stay open, same idea as a flat piece's rows.
    const isPartial = !error && !isChainInRound && baseCount>0 && consumedCount>0 && consumedCount < baseCount;
    // A round built directly on top of a partial round (e.g. a second
    // round worked back across just part of the first) is just as much an
    // open, non-wrapping row as its base was, even though IT fully
    // consumes ITS OWN base and so isn't itself `isPartial`.
    const isFlap = isPartial || (targetIdx != null && rounds[targetIdx] && rounds[targetIdx].isFlap);

    if (!error && targetIdx != null && loopSide && loopUsage[targetIdx]) {
      const lu = loopUsage[targetIdx];
      const targetNum = computeDisplayNumbers(rounds).displayNums[targetIdx];
      if (lu.both) {
        error = `Round ${targetNum} is already fully worked into (both loops) - nothing left to attach into`;
      } else if (loopSide === 'both' && (lu.front || lu.back)) {
        error = `Round ${targetNum}'s ${lu.front ? 'front' : 'back'} loop is already worked into - can't work into both loops now`;
      } else if (loopSide === 'back' && lu.back) {
        error = `Round ${targetNum}'s back loop is already worked into`;
      } else if (loopSide === 'front' && lu.front) {
        error = `Round ${targetNum}'s front loop is already worked into`;
      }
    }

    if (!error && targetIdx != null && loopSide && loopUsage[targetIdx]) {
      const lu = loopUsage[targetIdx];
      if (loopSide === 'both') { lu.front = true; lu.back = true; lu.both = true; }
      else if (loopSide === 'back') lu.back = true;
      else if (loopSide === 'front') lu.front = true;
    }

    rounds.push({index:rounds.length, ops, stitchCount:producedCount, consumedCount, color:roundColor, startColor, error, attachTo, fuseTo, fuseBaseDisplayNum: (fuseTo && fuseBaseDisplayNum > 0) ? fuseBaseDisplayNum : undefined, isChainInRound, isPartial, isFlap});
    loopUsage.push({front:false, back:false, both:false});
    // An attach:rN round works back into an EARLIER round's spare loop -
    // it's a side branch, not a continuation of the main body. A bare
    // round with no attach/fuse of its own always means "keep building the
    // trunk", so the trunk pointers must skip right over an attach round
    // and keep pointing at whatever the real last body round was, or the
    // very next bare round would silently start building on top of the
    // branch instead of the trunk (wrong stitch base, wrong graph parent).
    if (!attachTo) {
      lastStitchRoundIdx = rounds.length - 1;
      prevCount = producedCount;
      // A successful fuse: round is a fresh re-threading of the trunk (new
      // yarn joining onto other pieces' live rims) - it becomes the new
      // trunk baseline, so it clears any earlier cut just like MR/ch/chr do.
      if (fuseTo && !error) yarnCutBy = null;
    }
  }

  return {rounds};
}