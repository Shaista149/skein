import { parsePattern, computeDisplayNumbers } from '../lib/parser.js';
import { PRESETS } from './presets.js';
import { markersToSaveData, setPendingMarkerRestore, clearMarkers } from './markers.js';
import { autobuildStep } from './autobuild.js';
import {
  getComponentNames, getActiveComponentName, getComponent,
  setActiveComponentContent, setActiveComponent, addComponent,
  renameComponent, removeComponent, resetToSingleComponent,
  serializeComponents, loadComponentsFromSaved,
} from './components.js';

// PATTERN EDITOR UI
const patternEditorWrap = document.getElementById('pattern-editor-wrap');
const gutterNums    = document.getElementById('pattern-gutter-nums');
const gutterBadges  = document.getElementById('pattern-gutter-badges');
export const textarea      = document.getElementById('pattern-textarea');
const measureEl     = document.getElementById('pattern-measure');
const errorBox      = document.getElementById('error-box');
export let patternLines  = [];
let pendingValidate = null;
const componentTabsEl = document.getElementById('component-tabs');
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
      if (rnd.isFO || rnd.isPullClosed || rnd.isTurn || rnd.isColorOnly || rnd.isMountOnly) { badge.textContent = ''; }
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

// COMPONENT TABS: 
// Whichever tab is in focus is what's loaded in the textarea/visualizer
// below - switching tabs stashes whatever's currently on screen into the
// component being left (so nothing typed gets lost) before loading the
// target's own content the same way loading a saved preset already does.

function loadComponentIntoEditor(name) {
  const c = getComponent(name);
  if (!c) return;
  patternLines = [...c.lines];
  clearMarkers();
  setPendingMarkerRestore(c.markers);
  renderPatternEditor();
}

function switchToComponent(name) {
  if (name === getActiveComponentName()) return;
  setActiveComponentContent(patternLines, markersToSaveData());
  if (!setActiveComponent(name)) return;
  loadComponentIntoEditor(name);
  renderComponentTabs();
}

function isMultiComponentEntry(entry) {
  return !!(entry && typeof entry === 'object' && !Array.isArray(entry) && entry.components && typeof entry.components === 'object');
}

// Loads ANY preset/saved entry (built-in PRESETS or one of your own saved
// patterns) into the editor - ALWAYS replacing the current tab strip with
// exactly that entry's own tabs (one 'main' tab for a plain single-pattern
// entry, or however many components a multi-component entry carries).
function loadPresetEntry(entry) {
  if (isMultiComponentEntry(entry)) {
    loadComponentsFromSaved(entry);
  } else {
    const { lines, markers } = normalizeSavedEntry(entry);
    resetToSingleComponent(lines, markers);
  }
  loadComponentIntoEditor(getActiveComponentName());
  renderComponentTabs();
}

function nextComponentName() {
  // Numbered off how many tabs exist right now, not a fixed search from 2
  // every time - so with main+leg+arm+ear already open (4 tabs), the next
  // one is part_5.
  let n = getComponentNames().length + 1;
  while (getComponentNames().includes(`part_${n}`)) n++;
  return `part_${n}`;
}

function addComponentTab() {
  setActiveComponentContent(patternLines, markersToSaveData());
  const name = nextComponentName();
  addComponent(name);
  loadComponentIntoEditor(name);
  renderComponentTabs();
  // Drop straight into rename mode for the new tab - "part_2" is a
  // placeholder, not a name anyone actually wants to keep, so skip the
  // extra double-click and let it be renamed immediately.
  const newTabEl = componentTabsEl.querySelector(`[data-name="${CSS.escape(name)}"]`);
  if (newTabEl) startComponentRename(newTabEl, name);
}

// Inline rename, same pattern as the saved-preset sidebar's double-click
// rename - a text input + small confirm button right where the tab was,
// rather than routing through some separate name field elsewhere.
function startComponentRename(tabEl, oldName) {
  const input = document.createElement('input');
  input.className = 'component-tab-rename-input';
  input.type = 'text';
  input.value = oldName;
  input.spellcheck = false;
  input.autocomplete = 'off';

  function commit() {
    const newName = input.value.trim().replace(/\s+/g, '_');
    if (!newName || newName === oldName) { renderComponentTabs(); return; }
    if (getComponentNames().includes(newName)) {
      if (!confirm(`A component named "${newName}" already exists - pick a different name, or cancel to keep "${oldName}".`)) { renderComponentTabs(); return; }
      input.focus();
      return;
    }
    renameComponent(oldName, newName);
    renderComponentTabs();
  }
  function cancel() { renderComponentTabs(); }

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') cancel();
  });
  input.addEventListener('blur', () => {
    // Same deferred-cancel trick as the saved-preset rename input - a
    // click elsewhere blurs the input a moment before that click's own
    // handler fires, so this needs to wait rather than cancel immediately.
    setTimeout(() => { if (document.body.contains(input)) cancel(); }, 150);
  });

  tabEl.innerHTML = '';
  tabEl.appendChild(input);
  input.focus();
  input.select();
}

export function renderComponentTabs() {
  componentTabsEl.innerHTML = '';
  const names = getComponentNames();
  const active = getActiveComponentName();

  names.forEach(name => {
    const tab = document.createElement('div');
    tab.className = 'component-tab' + (name === active ? ' active' : '');
    tab.dataset.name = name;
    tab.title = `${name} (double-click to rename)`;

    const label = document.createElement('span');
    label.className = 'component-tab-label';
    label.textContent = name;
    tab.appendChild(label);

    // Only one component ever means there's nothing to switch to and
    // nothing that should be closable - same "always at least one panel
    // open" rule removeComponent itself already enforces.
    if (names.length > 1) {
      const close = document.createElement('button');
      close.className = 'component-tab-close';
      close.textContent = '×';
      close.title = `Remove "${name}"`;
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirm(`Remove component "${name}"? Its pattern text will be lost.`)) return;
        const wasActive = name === active;
        removeComponent(name);
        if (wasActive) loadComponentIntoEditor(getActiveComponentName());
        renderComponentTabs();
      });
      tab.appendChild(close);
    }

    tab.addEventListener('click', () => switchToComponent(name));
    tab.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startComponentRename(tab, name);
    });
    componentTabsEl.appendChild(tab);
  });

  const addBtn = document.createElement('button');
  addBtn.className = 'component-tab-add';
  addBtn.title = 'Add component';
  addBtn.textContent = '+';
  addBtn.addEventListener('click', addComponentTab);
  componentTabsEl.appendChild(addBtn);
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
    // Loading any preset always replaces the whole tab strip with that
    // preset's own tabs - see loadPresetEntry above.
    loadPresetEntry(PRESETS[btn.dataset.preset]);
    setLoadedSavedContext(null);
    saveNameInput.value = '';
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
// saved patterns, the built-in presets (Ball, Bunny body, etc), AND every
// component tab currently open, all merged into one lookup so an assembly
// operation can reference any of them by name. Kept separate from
// loadSavedPresets() itself, since that one also backs the "Your patterns"
// sidebar list and save/delete - merging PRESETS in there would make
// built-ins show up as fake saved/deletable entries. Precedence, lowest to
// highest: built-in presets, then saved patterns, then whatever's live in
// the other component tabs right now - so if a tab happens to share a name
// with something already saved, the live in-progress version wins, since
// that's almost certainly what "leg" means when it's referenced from
// another tab you're actively building alongside it.
export function loadPieceLibrary() {
  const active = getActiveComponentName();
  const liveComponents = {};
  for (const cname of getComponentNames()) {
    // The active tab's own entry is built from `patternLines` directly -
    // the literal, as-you-type content - rather than whatever's last
    // stored in components.js for it, since that only gets synced at
    // tab-switch time and would otherwise be one edit behind what's
    // actually on screen right now.
    liveComponents[cname] = cname === active
      ? { lines: patternLines, markers: markersToSaveData() }
      : { lines: getComponent(cname).lines, markers: getComponent(cname).markers };
  }
  return { ...PRESETS, ...loadSavedPresets(), ...liveComponents };
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
// Which saved entry (if any) is currently "open" for editing - set when a
// saved pattern is loaded from the sidebar, or right after a fresh save.
// Lets saveCurrentPattern() below tell "update the thing I already have
// open" apart from "save under a name that happens to collide with
// something else", so editing a saved preset's pattern (and optionally its
// name) and hitting Save again just updates it in place, no repeated
// overwrite confirmation for your own pattern.
let currentlyLoadedSavedName = null;

// A saved-preset entry is either the old bare lines array, or the current
// {lines, markers} shape - this normalizes either into {lines, markers} so
// every reader below only has to handle one case.
function normalizeSavedEntry(entry) {
  if (Array.isArray(entry)) return { lines: entry, markers: [] };
  return { lines: entry.lines || [], markers: entry.markers || [] };
}

// True rename, in place: the old key is genuinely removed, not left behind
// as an orphaned duplicate. Swaps the row's own name button for a small text 
// input + confirm button, right where you double-clicked.
function startInlineRename(row, btn, del, oldName) {
  const input = document.createElement('input');
  input.className = 'save-input saved-rename-input';
  input.type = 'text';
  input.value = oldName;
  input.spellcheck = false;
  input.autocomplete = 'off';

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'save-btn saved-rename-confirm';
  confirmBtn.textContent = 'Save';

  function commit() {
    const newName = input.value.trim().replace(/\s+/g, '_');
    if (!newName || newName === oldName) { renderSavedPresets(); return; } // no real change - just cancel back to normal
    const cur = loadSavedPresets();
    if (cur[newName] && !confirm(`"${newName}" already exists - overwrite it?`)) return;
    cur[newName] = cur[oldName];
    delete cur[oldName];
    persistSavedPresets(cur);
    // Keep the bottom save context pointed at the right entry if the one
    // just renamed is the one currently open for editing.
    if (currentlyLoadedSavedName === oldName) {
      setLoadedSavedContext(newName);
    }
    renderSavedPresets();
  }
  function cancel() { renderSavedPresets(); }

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') cancel();
  });
  input.addEventListener('blur', () => {
    // A click on the confirm button also blurs the input a moment before
    // its own click fires - deferred so commit() (triggered by that click)
    // gets to run first instead of blur immediately cancelling it out.
    setTimeout(() => { if (document.body.contains(input)) cancel(); }, 150);
  });
  confirmBtn.addEventListener('mousedown', e => e.preventDefault()); // keep focus on input so the deferred blur-cancel above doesn't race the click
  confirmBtn.addEventListener('click', commit);

  row.innerHTML = '';
  row.appendChild(input);
  row.appendChild(confirmBtn);
  input.focus();
  input.select();
}

function syncSaveButtonLabel() {
  const name = saveNameInput.value.trim().replace(/\s+/g, '_');
  const isNewName = currentlyLoadedSavedName != null && name !== '' && name !== currentlyLoadedSavedName;
  saveBtn.textContent = isNewName ? 'Save as new' : 'Save';
}

// Tracks which saved entry (if any) is open for editing, WITHOUT typing
// its name into the visible field - the field staying blank is what tells
// you "Save updates the pattern you already have open"; typing a name in
// is what tells you "Save creates/overwrites that specific name instead".
function setLoadedSavedContext(name) {
  currentlyLoadedSavedName = name;
  syncSaveButtonLabel();
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
    btn.title = `Load "${name}" (double-click to rename)`;
    btn.addEventListener('click', () => {
      document.querySelectorAll('.pbtn').forEach(b=>b.classList.remove('active'));
      document.querySelectorAll('.saved-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      // Loading any saved pattern always replaces the whole tab strip
      // with that pattern's own tabs - see loadPresetEntry above.
      loadPresetEntry(saved[name]);
      // Track this as the entry currently open for editing WITHOUT typing
      // its name into the visible field - editing the pattern and hitting
      // Save (field left blank) updates this same saved entry, no
      // retyping the name from scratch. Typing a name in creates/updates
      // that name instead (see saveCurrentPattern) - and that's still not
      // how you rename something; double-click the name itself below for
      // an actual rename.
      setLoadedSavedContext(name);
    });
    btn.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startInlineRename(row, btn, del, name);
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
      // If the entry being deleted is the one currently open for editing,
      // drop that link too - otherwise the next Save would silently
      // recreate the just-deleted entry under its old name.
      if (currentlyLoadedSavedName === name) {
        setLoadedSavedContext(null);
      }
      renderSavedPresets();
    });

    row.appendChild(btn);
    row.appendChild(del);
    savedListEl.appendChild(row);
  });
}

function saveCurrentPattern() {
  // Preset names can't have spaces (see fuse:/graft:/mount: parsing)
  const typed = saveNameInput.value.trim().replace(/\s+/g, '_');
  // blank field = update whatever's currently loaded
  const name = typed || currentlyLoadedSavedName;
  if (!name) { saveNameInput.focus(); return; }
  const cur = loadSavedPresets();
  const isUpdatingOwnEntry = currentlyLoadedSavedName != null && name === currentlyLoadedSavedName;
  if (cur[name] && !isUpdatingOwnEntry && !confirm(`Overwrite existing saved pattern "${name}"?`)) return;
  setActiveComponentContent(patternLines, markersToSaveData()); // flush active tab's latest edits first
  cur[name] = serializeComponents(); // saves every open tab, not just the active one
  persistSavedPresets(cur);
  saveNameInput.value = '';
  setLoadedSavedContext(name);
  renderSavedPresets();
  savedListEl.querySelectorAll('.saved-btn').forEach(b => {
    b.classList.toggle('active', b.textContent === name);
  });
}

saveBtn.addEventListener('click', saveCurrentPattern);
saveNameInput.addEventListener('keydown', e => { if (e.key === 'Enter') saveCurrentPattern(); });
saveNameInput.addEventListener('input', syncSaveButtonLabel);

renderSavedPresets();
renderComponentTabs();