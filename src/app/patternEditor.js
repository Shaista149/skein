import { parsePattern, computeDisplayNumbers } from '../lib/parser.js';
import { PRESETS } from './presets.js';
import { markersToSaveData, setPendingMarkerRestore, clearMarkers } from './markers.js';
import { autobuildStep } from './autobuild.js';

// PATTERN EDITOR UI
const patternEditorWrap = document.getElementById('pattern-editor-wrap');
const gutterNums    = document.getElementById('pattern-gutter-nums');
const gutterBadges  = document.getElementById('pattern-gutter-badges');
export const textarea      = document.getElementById('pattern-textarea');
const measureEl     = document.getElementById('pattern-measure');
const errorBox      = document.getElementById('error-box');
export let patternLines  = [];
let pendingValidate = null;
const LINE_HEIGHT = 20; // px - must match .pattern-textarea/.pattern-measure line-height

// Row "identity" here is just array position, same as the old per-input
// version (nothing downstream - parsePattern, save/load, run() - ever
// tracked rows by anything other than index). Splitting the textarea's
// value on '\n' reconstructs patternLines exactly, so there's no separate
// ID system to maintain.
function resizeTextarea() {
  textarea.style.height = 'auto';
  textarea.style.height = textarea.scrollHeight + 'px';
}

// A run-on line only wraps at whitespace (CSS overflow-wrap:normal, never
// mid-token), and this notation's only whitespace is the space right after
// a comma - so this measures how many visual rows a single line takes up
// once the browser wraps it, using a hidden twin of the textarea with
// identical font/padding/width. Used to size that line's gutter cells to
// match, since a wrapped line is taller than 20px.
function countWrappedRows(text) {
  measureEl.style.width = textarea.clientWidth + 'px';
  measureEl.textContent = text.length ? text : ' ';
  return Math.max(1, Math.round(measureEl.scrollHeight / LINE_HEIGHT));
}

function updateGutterHeights() {
  const numEls = gutterNums.children;
  const badgeEls = gutterBadges.children;
  patternLines.forEach((line, i) => {
    const h = (countWrappedRows(line) * LINE_HEIGHT) + 'px';
    if (numEls[i])   numEls[i].style.height = h;
    if (badgeEls[i]) badgeEls[i].style.height = h;
  });
}

// Rebuilds the two gutters to match the current number of lines. Cheap
// (just number spans + a badge/delete button per row), so it's safe to run
// on every keystroke - that's what keeps the gutters glued to the textarea
// as rows are added/removed/pasted-over, without re-touching the textarea
// itself (which would blow away cursor position and native undo history).
// Always follows up with updateGutterHeights(), since a line's wrapped
// height can change even when the row count doesn't (e.g. typing more text
// into a round makes it wrap to a second visual row).
function renderGutterSkeleton() {
  const n = patternLines.length;
  if (gutterNums.children.length !== n) {
    gutterNums.innerHTML = '';
    gutterBadges.innerHTML = '';
    for (let i=0; i<n; i++) {
      const num = document.createElement('div');
      num.className = 'pattern-gutter-line';
      num.textContent = `${i+1}`;
      gutterNums.appendChild(num);

      const badgeRow = document.createElement('div');
      badgeRow.className = 'pattern-gutter-line';
      const badge = document.createElement('span');
      badge.className = 'stitch-badge';
      const del = document.createElement('button');
      del.className = 'gutter-del';
      del.textContent = '×';
      del.title = 'Remove round';
      del.addEventListener('click', () => removeLine(i));
      badgeRow.appendChild(badge);
      badgeRow.appendChild(del);
      gutterBadges.appendChild(badgeRow);
    }
  }
  updateGutterHeights();
}

function removeLine(i) {
  if (patternLines.length <= 1) return;
  patternLines.splice(i,1);
  textarea.value = patternLines.join('\n');
  renderGutterSkeleton();
  resizeTextarea();
  validate();
  textarea.focus();
}

// Parses the current patternLines and updates stitch-count badges + error
// styling. Debounced on keystrokes (parsePattern isn't free), but run
// immediately after any structural change (add/remove/load).
export function validate() {
  const library = loadPieceLibrary();
  const parsed = parsePattern(patternLines, {library});
  const numRows = gutterNums.children;
  const badgeRows = gutterBadges.children;
  let hasErrors = false;
  const { displayNums } = computeDisplayNumbers(parsed.rounds);
  parsed.rounds.forEach((rnd, i) => {
    const numEl = numRows[i];
    const badgeRow = badgeRows[i];
    if (!numEl || !badgeRow) return;
    const badge = badgeRow.querySelector('.stitch-badge');

    // Gutter number: a standalone CC line isn't a row at all, so it shows
    // no number - and neither is an attach:rN line, which works back into
    // an EARLIER round's spare loop rather than starting a new row of its
    // own (see computeDisplayNumbers).
    const displayNum = displayNums[i];
    numEl.textContent = displayNum;

    if (rnd.error) {
      numEl.classList.add('err');
      badge.textContent = '!';
      badge.classList.add('err');
      badge.title = rnd.error;
      numEl.title = rnd.error;
      hasErrors = true;
    } else {
      numEl.classList.remove('err');
      badge.classList.remove('err');
      badge.removeAttribute('title');
      numEl.removeAttribute('title');
      if (rnd.isFO || rnd.isTurn || rnd.isColorOnly || rnd.isMountOnly) { badge.textContent = ''; }
      else { badge.textContent = rnd.stitchCount||''; }
    }
  });
  patternEditorWrap.classList.toggle('err', hasErrors);
  errorBox.style.display = 'none';

  // Not awaited - validate() stays synchronous (gutter/badge updates should
  // never wait on a physics solve), autobuildStep manages its own async
  // solve + abort/token lifecycle independently. autobuildStep is defined
  // further down the file but hoisting makes it safe to reference here.
  if (typeof autobuildStep === 'function') autobuildStep(parsed);
}

export function scheduleValidate() {
  clearTimeout(pendingValidate);
  pendingValidate = setTimeout(validate, 250);
}

// Full reload of the editor's contents - used when loading a preset/saved
// pattern or on first load. Setting textarea.value here is fine (unlike on
// every keystroke) because these are discrete user actions, not something
// that should preserve cursor position or fold into undo history.
export function renderPatternEditor() {
  textarea.value = patternLines.join('\n');
  renderGutterSkeleton();
  resizeTextarea();
  validate();
}

// Everything below is native textarea behavior: Enter inserts a newline
// (= new round), Backspace at line-start merges into the previous line
// (= deletes an empty round), multi-line select+type replaces rows, and
// Ctrl/Cmd+C/X/V/Z/Y all work exactly as they do in any text field. None of
// that needs custom keydown handling anymore.
textarea.addEventListener('input', () => {
  patternLines = textarea.value.split('\n');
  renderGutterSkeleton();
  resizeTextarea();
  scheduleValidate();
});
textarea.addEventListener('scroll', () => {
  // the textarea auto-grows to fit its (wrapped) content, so it shouldn't
  // scroll internally - this is just a safety net in case it ever does
  gutterNums.scrollTop = textarea.scrollTop;
  gutterBadges.scrollTop = textarea.scrollTop;
});
// DM Mono loads async over the network; row-wrap measurements taken before
// it's ready use the fallback monospace font and can be a pixel or two off
// once it swaps in. Recompute once it's actually loaded.
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => { renderGutterSkeleton(); resizeTextarea(); });
}

document.querySelectorAll('.pbtn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.pbtn').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.saved-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    patternLines = [...PRESETS[btn.dataset.preset]||[]];
    clearMarkers();
    renderPatternEditor();
  });
});

// SAVED (USER) PATTERNS
// Persisted to localStorage under one key, as {name: linesArray}. This is a
// plain standalone HTML file people open directly in their own browser (not
// a sandboxed Claude artifact), so ordinary localStorage works normally here
// - it isn't the browser-storage restriction that applies to in-chat
// artifacts. Save/load/delete are pure operations on patternLines, same
// shape as loading a built-in preset - a saved pattern is just a preset that
// lives in the browser instead of in this file's PRESETS constant.
const SAVED_PRESETS_KEY = 'crochetviz_savedPresets_v1';
let savedPresetsAvailable = true;

export function loadSavedPresets() {
  try {
    const raw = localStorage.getItem(SAVED_PRESETS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch(e) {
    savedPresetsAvailable = false;
    return {};
  }
}

// fuse:/graft:/mount: resolve piece names against this - the user's own
// saved patterns PLUS the built-in presets (Ball, Bunny body, etc), so an
// assembly operation can reference either by name. Kept separate from
// loadSavedPresets() itself, since that one also backs the "Your patterns"
// sidebar list and save/delete - merging PRESETS in there would make
// built-ins show up as fake saved/deletable entries. A saved pattern wins
// over a built-in of the same name.
export function loadPieceLibrary() {
  return { ...PRESETS, ...loadSavedPresets() };
}
function persistSavedPresets(obj) {
  try {
    localStorage.setItem(SAVED_PRESETS_KEY, JSON.stringify(obj));
  } catch(e) {
    savedPresetsAvailable = false;
  }
}

const savedListEl   = document.getElementById('saved-presets-list');
const saveNameInput = document.getElementById('save-preset-name');
const saveBtn       = document.getElementById('btn-save-preset');

// A saved-preset entry is either the old bare lines array, or the current
// {lines, markers} shape - this normalizes either into {lines, markers} so
// every reader below only has to handle one case.
function normalizeSavedEntry(entry) {
  if (Array.isArray(entry)) return { lines: entry, markers: [] };
  return { lines: entry.lines || [], markers: entry.markers || [] };
}

function renderSavedPresets() {
  const saved = loadSavedPresets();
  const names = Object.keys(saved);
  savedListEl.innerHTML = '';

  if (!savedPresetsAvailable) {
    const msg = document.createElement('div');
    msg.className = 'saved-empty';
    msg.textContent = "Saving isn't available in this browser (private/incognito mode blocks it).";
    savedListEl.appendChild(msg);
    return;
  }
  if (names.length === 0) {
    const msg = document.createElement('div');
    msg.className = 'saved-empty';
    msg.textContent = 'No saved patterns yet.';
    savedListEl.appendChild(msg);
    return;
  }

  names.forEach(name => {
    const row = document.createElement('div');
    row.className = 'saved-row';

    const btn = document.createElement('button');
    btn.className = 'saved-btn';
    btn.textContent = name;
    btn.title = `Load "${name}"`;
    btn.addEventListener('click', () => {
      document.querySelectorAll('.pbtn').forEach(b=>b.classList.remove('active'));
      document.querySelectorAll('.saved-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      const { lines, markers: savedMarkers } = normalizeSavedEntry(saved[name]);
      patternLines = [...lines];
      // Clear whatever's currently on screen before queuing the saved
      // markers - otherwise they just pile on top of the old ones once
      // restorePendingMarkers() runs (this was the "markers double on
      // load" bug).
      clearMarkers();
      // Can't place these yet - restoring a marker needs a solved graph to
      // find each stitch's actual position, and loading a saved pattern
      // doesn't auto-visualize. Queued here, consumed by run()/autobuildStep()
      // the next time either produces a fresh solve (see restorePendingMarkers).
      setPendingMarkerRestore(savedMarkers);
      renderPatternEditor();
    });

    const del = document.createElement('button');
    del.className = 'saved-del';
    del.textContent = '×';
    del.title = 'Delete';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm(`Delete saved pattern "${name}"?`)) return;
      const cur = loadSavedPresets();
      delete cur[name];
      persistSavedPresets(cur);
      renderSavedPresets();
    });

    row.appendChild(btn);
    row.appendChild(del);
    savedListEl.appendChild(row);
  });
}

function saveCurrentPattern() {
  // Piece names typed into fuse:/graft:/mount: can't contain spaces (see
  // the mount/fuse/graft regexes in parser.js) - a saved name that could
  // is a name you can see in the sidebar but can never actually reference
  // from another pattern. Normalizing here keeps what's shown always equal
  // to what you'd type, same as the built-in preset button labels.
  const name = saveNameInput.value.trim().replace(/\s+/g, '_');
  if (!name) { saveNameInput.focus(); return; }
  const cur = loadSavedPresets();
  if (cur[name] && !confirm(`Overwrite existing saved pattern "${name}"?`)) return;
  // markers may not exist yet at parse time (defined further down the
  // file) - fine, this function is only ever called from a click/keydown
  // handler, long after the whole script has finished running once.
  cur[name] = { lines: [...patternLines], markers: markersToSaveData() };
  persistSavedPresets(cur);
  saveNameInput.value = '';
  renderSavedPresets();
}

saveBtn.addEventListener('click', saveCurrentPattern);
saveNameInput.addEventListener('keydown', e => { if (e.key === 'Enter') saveCurrentPattern(); });

renderSavedPresets();