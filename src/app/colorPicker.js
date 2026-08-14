import { COLORS, setBaseColorHex } from '../lib/color.js';
import { buildMesh, disposeMesh, buildRowMarkerGroup } from '../lib/mesh.js';
import {
  lastGraph, scene, canvas, currentMesh, currentRowGroup,
  setCurrentMesh, setCurrentRowGroup, rowsOn, startDotOn,
} from './state.js';
import { getDisplayPos, applyFlip } from './viewToggles.js';
import { textarea } from './patternEditor.js';

// Same slider element viewToggles.js/markers.js/solver.js each keep their
// own reference to - see the comment in solver.js.
const yarnOpt = document.getElementById('opt-yarn');

// COLOR PICKER
// Sets the base/MC yarn color for rounds without an explicit CC: color
// change. Rebuilds the mesh from the cached last solve, so no re-solving
// of the physics happens; it's a pure recolor.
const colorRowEl = document.getElementById('color-row');
COLORS.forEach(c => {
  const sw = document.createElement('div');
  sw.className = 'swatch';
  sw.style.background = c.hex;
  sw.title = c.name;
  sw.addEventListener('click', () => {
    document.querySelectorAll('.swatch').forEach(x => x.classList.remove('on'));
    sw.classList.add('on');
    setBaseColorHex(c.n);
    rebuildMeshFromCache();
  });
  colorRowEl.appendChild(sw);
});

// Custom-color trigger: opens the full wheel/hex/rgb/eyedropper popover.
// Once a custom color has been picked it becomes this swatch's own color
// (like a foreground-color swatch), so re-clicking it re-opens the picker
// on whatever was last chosen rather than always starting from scratch.
const customSwatch = document.createElement('div');
customSwatch.className = 'swatch swatch-custom';
customSwatch.title = 'Custom color...';
let customSwatchHex = null;
customSwatch.addEventListener('click', () => {
  openColorPicker({
    anchorEl: customSwatch,
    initialHex: customSwatchHex || '#e8a598',
    live: (hex) => {
      setBaseColorHex(parseInt(hex.slice(1), 16));
      rebuildMeshFromCache();
    },
    onCommit: (hex) => {
      customSwatchHex = hex;
      customSwatch.style.setProperty('--_cc', hex);
      customSwatch.classList.add('has-color');
      document.querySelectorAll('.swatch').forEach(x => x.classList.remove('on'));
      customSwatch.classList.add('on');
    },
  });
});
colorRowEl.appendChild(customSwatch);

// FULL COLOR PICKER POPOVER
// Self-contained wheel/square + hue slider + hex + rgb + eyedropper + preset
// swatches, reused by both the base/MC swatch row above (live recolor of the
// cached mesh, no re-solve) and the "insert color" button next to the
// pattern editor (which just types `CC:#hexcode` into the pattern text at
// the cursor - the parser/resolveColor path already understands that token,
// so this needs no solver or mesh-building changes at all).
function hsvToRgb(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
  let r=0,g=0,b=0;
  if (h < 60)      { r=c; g=x; b=0; }
  else if (h < 120){ r=x; g=c; b=0; }
  else if (h < 180){ r=0; g=c; b=x; }
  else if (h < 240){ r=0; g=x; b=c; }
  else if (h < 300){ r=x; g=0; b=c; }
  else             { r=c; g=0; b=x; }
  return { r: Math.round((r+m)*255), g: Math.round((g+m)*255), b: Math.round((b+m)*255) };
}
function rgbToHsv(r, g, b) {
  r/=255; g/=255; b/=255;
  const max=Math.max(r,g,b), min=Math.min(r,g,b), d=max-min;
  let h=0;
  if (d!==0) {
    if (max===r) h = 60 * (((g-b)/d) % 6);
    else if (max===g) h = 60 * ((b-r)/d + 2);
    else h = 60 * ((r-g)/d + 4);
  }
  if (h<0) h+=360;
  const s = max===0 ? 0 : d/max;
  return { h, s, v: max };
}
function rgbToHex(r,g,b) {
  return '#' + [r,g,b].map(n => Math.max(0,Math.min(255,Math.round(n))).toString(16).padStart(2,'0')).join('');
}
function hexToRgb(hex) {
  let h = hex.replace('#','').trim();
  if (h.length===3) h = h.split('').map(c=>c+c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return { r: parseInt(h.slice(0,2),16), g: parseInt(h.slice(2,4),16), b: parseInt(h.slice(4,6),16) };
}

const CP_EYEDROP_ICON = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" style="vertical-align:-2px;margin-right:4px;"><path d="M19.4 4.6a2.7 2.7 0 0 0-3.8 0l-2.3 2.3-1-.9-1.5 1.5 1 1-8 8V20h3.5l8-8 1 1 1.5-1.5-.9-1 2.3-2.3a2.7 2.7 0 0 0 0-3.8z" fill="currentColor"/></svg>Eyedrop';
let cpPopoverEl = null, cpSVCanvas, cpHueCanvas, cpSVCursor, cpHueCursor,
    cpPreviewEl, cpHexInput, cpRInput, cpGInput, cpBInput, cpSwatchesEl, cpEyedropBtn;
let cpState = { h: 0, s: 1, v: 1 };
let cpLiveCb = null, cpCommitCb = null;
let cpRecent = []; // recently-picked custom hexes, most-recent first
let cpPalette = []; // user-named custom swatches: {name, hex}[], newest first
let cpPaletteSwatchesEl;
const CP_PALETTE_KEY = 'skein-custom-palette';

// Persisted via the artifact's window.storage where available (so a named
// palette survives a reload), but this is optional polish, not a
// requirement - outside that runtime (or if storage errors for any
// reason) the palette still works fine for the current session, it just
// won't be there next time.
async function loadPalette() {
  try {
    if (window.storage) {
      const res = await window.storage.get(CP_PALETTE_KEY);
      if (res && res.value) cpPalette = JSON.parse(res.value);
    }
  } catch (e) { /* nothing saved yet, or storage unavailable - start empty */ }
  renderPaletteSwatches();
}
async function savePaletteToStorage() {
  try {
    if (window.storage) await window.storage.set(CP_PALETTE_KEY, JSON.stringify(cpPalette));
  } catch (e) { /* storage unavailable outside the artifact runtime - palette still works this session */ }
}
function renderPaletteSwatches() {
  if (!cpPaletteSwatchesEl) return;
  const label = cpPopoverEl.querySelector('#cp-palette-label');
  label.style.display = cpPalette.length ? '' : 'none';
  cpPaletteSwatchesEl.innerHTML = '';
  cpPalette.forEach((item, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'cp-palette-swatch';
    const sw = document.createElement('div');
    sw.className = 'cp-mini-swatch';
    sw.style.background = item.hex;
    sw.title = `${item.name} (${item.hex})`;
    sw.addEventListener('click', () => setColorFromHex(item.hex, true));
    const del = document.createElement('div');
    del.className = 'cp-palette-del';
    del.textContent = '\u00d7';
    del.title = `Remove "${item.name}" from your palette`;
    del.addEventListener('click', e => {
      e.stopPropagation();
      cpPalette.splice(i, 1);
      renderPaletteSwatches();
      savePaletteToStorage();
    });
    wrap.appendChild(sw);
    wrap.appendChild(del);
    cpPaletteSwatchesEl.appendChild(wrap);
  });
}
const CP_SAMPLING_HINT = document.createElement('div');
CP_SAMPLING_HINT.className = 'cp-sampling-hint';
CP_SAMPLING_HINT.textContent = 'Click anywhere on the model to sample its color';
document.body.appendChild(CP_SAMPLING_HINT);

function buildColorPickerDOM() {
  if (cpPopoverEl) return;
  cpPopoverEl = document.createElement('div');
  cpPopoverEl.className = 'cp-popover';
  cpPopoverEl.innerHTML = `
    <div class="cp-svbox-wrap" id="cp-svbox-wrap">
      <canvas id="cp-svbox" width="192" height="120"></canvas>
      <div class="cp-svbox-cursor" id="cp-svbox-cursor"></div>
    </div>
    <div class="cp-hue-wrap" id="cp-hue-wrap">
      <canvas id="cp-hue" width="192" height="14"></canvas>
      <div class="cp-hue-cursor" id="cp-hue-cursor"></div>
    </div>
    <div class="cp-row">
      <div class="cp-preview" id="cp-preview"></div>
      <input class="cp-input" id="cp-hex" maxlength="7" placeholder="#rrggbb">
    </div>
    <div class="cp-rgb-row">
      <div><input class="cp-input cp-rgb-input" id="cp-r" type="number" min="0" max="255"><div class="cp-rgb-label">R</div></div>
      <div><input class="cp-input cp-rgb-input" id="cp-g" type="number" min="0" max="255"><div class="cp-rgb-label">G</div></div>
      <div><input class="cp-input cp-rgb-input" id="cp-b" type="number" min="0" max="255"><div class="cp-rgb-label">B</div></div>
    </div>
    <div class="cp-row" style="margin-top:9px;">
      <button class="cp-eyedrop-btn" id="cp-eyedrop"></button>
      <button class="cp-add-btn" id="cp-add-palette" title="Save this color to your own named palette">&#9733; Save</button>
    </div>
    <div class="cp-row cp-name-row" id="cp-name-row">
      <input class="cp-input cp-name-input" id="cp-name-input" placeholder="Name this color...">
      <button class="cp-name-confirm" id="cp-name-confirm" title="Save">&#10003;</button>
    </div>
    <div class="cp-section-label">Presets</div>
    <div class="cp-swatches-row" id="cp-preset-swatches"></div>
    <div class="cp-section-label" id="cp-palette-label" style="display:none;">My palette</div>
    <div class="cp-swatches-row" id="cp-palette-swatches"></div>
    <div class="cp-section-label" id="cp-recent-label" style="display:none;">Recently used</div>
    <div class="cp-swatches-row" id="cp-recent-swatches"></div>
  `;
  document.body.appendChild(cpPopoverEl);

  cpSVCanvas = cpPopoverEl.querySelector('#cp-svbox');
  cpHueCanvas = cpPopoverEl.querySelector('#cp-hue');
  cpSVCursor = cpPopoverEl.querySelector('#cp-svbox-cursor');
  cpHueCursor = cpPopoverEl.querySelector('#cp-hue-cursor');
  cpPreviewEl = cpPopoverEl.querySelector('#cp-preview');
  cpHexInput = cpPopoverEl.querySelector('#cp-hex');
  cpRInput = cpPopoverEl.querySelector('#cp-r');
  cpGInput = cpPopoverEl.querySelector('#cp-g');
  cpBInput = cpPopoverEl.querySelector('#cp-b');
  cpEyedropBtn = cpPopoverEl.querySelector('#cp-eyedrop');
  cpEyedropBtn.innerHTML = CP_EYEDROP_ICON;

  const cpAddBtn = cpPopoverEl.querySelector('#cp-add-palette');
  const cpNameRow = cpPopoverEl.querySelector('#cp-name-row');
  const cpNameInput = cpPopoverEl.querySelector('#cp-name-input');
  const cpNameConfirm = cpPopoverEl.querySelector('#cp-name-confirm');
  cpPaletteSwatchesEl = cpPopoverEl.querySelector('#cp-palette-swatches');
  cpAddBtn.addEventListener('click', () => {
    cpNameRow.classList.add('open');
    cpNameInput.value = '';
    cpNameInput.placeholder = currentCpHex();
    cpNameInput.focus();
  });
  function confirmAddToPalette() {
    const hex = currentCpHex();
    const name = cpNameInput.value.trim() || hex;
    // Newest first, and re-saving a hex you already have just moves/renames
    // it rather than leaving a duplicate swatch sitting in the list.
    cpPalette = [{ name, hex }, ...cpPalette.filter(p => p.hex.toLowerCase() !== hex.toLowerCase())].slice(0, 30);
    renderPaletteSwatches();
    savePaletteToStorage();
    cpNameRow.classList.remove('open');
  }
  cpNameConfirm.addEventListener('click', confirmAddToPalette);
  cpNameInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') confirmAddToPalette();
    if (e.key === 'Escape') { e.stopPropagation(); cpNameRow.classList.remove('open'); }
  });
  loadPalette();

  const presetRow = cpPopoverEl.querySelector('#cp-preset-swatches');
  COLORS.forEach(c => {
    const sw = document.createElement('div');
    sw.className = 'cp-mini-swatch';
    sw.style.background = c.hex;
    sw.title = c.name;
    sw.addEventListener('click', () => setColorFromHex(c.hex, true));
    presetRow.appendChild(sw);
  });
  cpSwatchesEl = cpPopoverEl.querySelector('#cp-recent-swatches');

  drawHueStrip();
  redrawSVBox();

  function pickFromSVEvent(e) {
    const rect = cpSVCanvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    cpState.s = x; cpState.v = 1 - y;
    updateFromState();
  }
  function pickFromHueEvent(e) {
    const rect = cpHueCanvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    cpState.h = x * 360;
    redrawSVBox();
    updateFromState();
  }
  function dragTrack(moveFn) {
    function onMove(e) { moveFn(e); }
    function onUp() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }
  cpSVCanvas.parentElement.addEventListener('pointerdown', e => { pickFromSVEvent(e); dragTrack(pickFromSVEvent); });
  cpHueCanvas.parentElement.addEventListener('pointerdown', e => { pickFromHueEvent(e); dragTrack(pickFromHueEvent); });

  cpHexInput.addEventListener('change', () => {
    let v = cpHexInput.value.trim();
    if (v && v[0] !== '#') v = '#' + v;
    if (hexToRgb(v)) setColorFromHex(v, true);
    else cpHexInput.value = rgbToHex(...Object.values(hsvToRgb(cpState.h, cpState.s, cpState.v)));
  });
  [cpRInput, cpGInput, cpBInput].forEach(inp => {
    inp.addEventListener('change', () => {
      const r = Math.max(0, Math.min(255, parseInt(cpRInput.value) || 0));
      const g = Math.max(0, Math.min(255, parseInt(cpGInput.value) || 0));
      const b = Math.max(0, Math.min(255, parseInt(cpBInput.value) || 0));
      setColorFromHex(rgbToHex(r,g,b), true);
    });
  });

  cpEyedropBtn.addEventListener('click', startEyedrop);
}

function drawHueStrip() {
  const ctx = cpHueCanvas.getContext('2d');
  const w = cpHueCanvas.width, h = cpHueCanvas.height;
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  for (let i = 0; i <= 360; i += 30) grad.addColorStop(i/360, `hsl(${i},100%,50%)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
}

function redrawSVBox() {
  const ctx = cpSVCanvas.getContext('2d');
  const w = cpSVCanvas.width, h = cpSVCanvas.height;
  const hue = hsvToRgb(cpState.h, 1, 1);
  ctx.fillStyle = `rgb(${hue.r},${hue.g},${hue.b})`;
  ctx.fillRect(0, 0, w, h);
  const white = ctx.createLinearGradient(0, 0, w, 0);
  white.addColorStop(0, 'rgba(255,255,255,1)');
  white.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = white; ctx.fillRect(0, 0, w, h);
  const black = ctx.createLinearGradient(0, 0, 0, h);
  black.addColorStop(0, 'rgba(0,0,0,0)');
  black.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.fillStyle = black; ctx.fillRect(0, 0, w, h);
}

// Pushes the current cpState (h/s/v) out to every UI element and, if `fire`
// is true, calls the live callback for the picker's current open session -
// used for drag/slider moves where the caller wants continuous feedback.
function updateFromState(fire = true) {
  const rgb = hsvToRgb(cpState.h, cpState.s, cpState.v);
  const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
  cpPreviewEl.style.background = hex;
  cpHexInput.value = hex;
  cpRInput.value = rgb.r; cpGInput.value = rgb.g; cpBInput.value = rgb.b;
  const svRect = cpSVCanvas.getBoundingClientRect();
  cpSVCursor.style.left = (cpState.s * (svRect.width || 192)) + 'px';
  cpSVCursor.style.top = ((1 - cpState.v) * (svRect.height || 120)) + 'px';
  const hueRect = cpHueCanvas.getBoundingClientRect();
  cpHueCursor.style.left = ((cpState.h / 360) * (hueRect.width || 192)) + 'px';
  if (fire && cpLiveCb) cpLiveCb(hex);
}

// Sets the picker to an explicit hex string (from a preset, hex/rgb input,
// or the eyedropper) rather than a wheel/square drag.
function setColorFromHex(hex, fire) {
  const rgb = hexToRgb(hex);
  if (!rgb) return;
  const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
  cpState = hsv;
  redrawSVBox();
  updateFromState(fire);
}

function currentCpHex() {
  const rgb = hsvToRgb(cpState.h, cpState.s, cpState.v);
  return rgbToHex(rgb.r, rgb.g, rgb.b);
}

function renderRecentSwatches() {
  cpSwatchesEl.innerHTML = '';
  const label = cpPopoverEl.querySelector('#cp-recent-label');
  label.style.display = cpRecent.length ? '' : 'none';
  cpRecent.forEach(hex => {
    const sw = document.createElement('div');
    sw.className = 'cp-mini-swatch';
    sw.style.background = hex;
    sw.title = hex;
    sw.addEventListener('click', () => setColorFromHex(hex, true));
    cpSwatchesEl.appendChild(sw);
  });
}

function rememberRecent(hex) {
  cpRecent = [hex, ...cpRecent.filter(h => h.toLowerCase() !== hex.toLowerCase())].slice(0, 8);
  renderRecentSwatches();
}

// Native EyeDropper API (Chrome/Edge) samples any pixel on screen, including
// the rendered yarn model itself - the ideal case. Where it's unavailable,
// fall back to sampling directly off the three.js canvas: click the model,
// read that pixel back out of the WebGL canvas (preserveDrawingBuffer keeps
// it readable) via a scratch 2D canvas.
async function startEyedrop() {
  if (window.EyeDropper) {
    try {
      const ed = new window.EyeDropper();
      const result = await ed.open();
      setColorFromHex(result.sRGBHex, true);
    } catch (e) { /* user cancelled the pick - leave color as-is */ }
    return;
  }
  cpEyedropBtn.classList.add('sampling');
  cpEyedropBtn.textContent = 'Click the model...';
  CP_SAMPLING_HINT.classList.add('on');
  const moveHint = e => { CP_SAMPLING_HINT.style.left = (e.clientX + 16) + 'px'; CP_SAMPLING_HINT.style.top = (e.clientY + 16) + 'px'; };
  window.addEventListener('pointermove', moveHint);
  function cleanup() {
    window.removeEventListener('pointermove', moveHint);
    CP_SAMPLING_HINT.classList.remove('on');
    cpEyedropBtn.classList.remove('sampling');
    cpEyedropBtn.innerHTML = CP_EYEDROP_ICON;
    canvas.removeEventListener('click', onClick, true);
  }
  function onClick(e) {
    e.preventDefault(); e.stopPropagation();
    try {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const cx = Math.round((e.clientX - rect.left) * (canvas.width / rect.width));
      const cy = Math.round((e.clientY - rect.top) * (canvas.height / rect.height));
      const scratch = document.createElement('canvas');
      scratch.width = canvas.width; scratch.height = canvas.height;
      const sctx = scratch.getContext('2d');
      sctx.drawImage(canvas, 0, 0);
      const px = sctx.getImageData(cx, cy, 1, 1).data;
      setColorFromHex(rgbToHex(px[0], px[1], px[2]), true);
    } catch (err) { /* sampling failed (e.g. tainted canvas) - ignore */ }
    cleanup();
  }
  canvas.addEventListener('click', onClick, true);
}

export function closeColorPicker() {
  if (!cpPopoverEl || !cpPopoverEl.classList.contains('open')) return;
  cpPopoverEl.classList.remove('open');
  if (cpCommitCb) {
    const hex = currentCpHex();
    rememberRecent(hex);
    cpCommitCb(hex);
  }
  cpLiveCb = null; cpCommitCb = null;
  document.removeEventListener('pointerdown', cpOutsideHandler, true);
  document.removeEventListener('keydown', cpKeyHandler, true);
}
function cpOutsideHandler(e) {
  if (cpPopoverEl && !cpPopoverEl.contains(e.target) && !e.target.closest('.swatch-custom, #btn-insert-color')) {
    closeColorPicker();
  }
}
function cpKeyHandler(e) { if (e.key === 'Escape') closeColorPicker(); }

// Opens the picker anchored below/near `anchorEl`.
// - live(hex): called on every drag/slider/hex/rgb change, for callers that
//   want continuous feedback (the base-color swatch recolors the cached
//   mesh live as you drag).
// - onCommit(hex): called exactly once, when the popover closes, for
//   callers that want a single final value (inserting one CC: token rather
//   than one per mouse-move).
export function openColorPicker({ anchorEl, initialHex, live, onCommit }) {
  buildColorPickerDOM();
  closeColorPicker(); // close any previous session first (fires its own commit)
  cpLiveCb = live || null;
  cpCommitCb = onCommit || null;
  setColorFromHex(initialHex || '#e8a598', false);
  cpPopoverEl.classList.add('open');
  const rect = anchorEl.getBoundingClientRect();
  const popW = 216, popH = 470;
  let left = rect.left;
  let top = rect.bottom + 8;
  if (left + popW > window.innerWidth - 10) left = window.innerWidth - popW - 10;
  if (top + popH > window.innerHeight - 10) top = Math.max(10, rect.top - popH - 8);
  cpPopoverEl.style.left = left + 'px';
  cpPopoverEl.style.top = top + 'px';
  // Recompute cursor positions once the popover is actually laid out and
  // has real dimensions (getBoundingClientRect on the canvases is 0 until
  // then, which would otherwise put both cursors at the top-left corner).
  requestAnimationFrame(() => updateFromState(false));
  setTimeout(() => {
    document.addEventListener('pointerdown', cpOutsideHandler, true);
    document.addEventListener('keydown', cpKeyHandler, true);
  }, 0);
}

// "Insert color" button next to the Pattern label: opens the same picker,
// but instead of typing a token once on close, it inserts a placeholder
// CC:#hexcode token the moment the picker opens and then keeps that exact
// token in sync on every wheel/slider/hex/rgb change (the `live` callback),
// the same way the base-color swatch keeps the cached mesh in sync live.
// Whatever the token reads when the picker is dismissed (click-out, Escape)
// is what stays in the pattern - there's no separate "commit" value, since
// commit here just means "stop updating", not "apply for the first time".
// Tracks the inserted token's own start/end offsets (not the cursor
// position) so a live update can find and replace exactly that span even
// if the person has since moved the cursor elsewhere by clicking around
// the textarea while the picker is open.
function insertAtCursor(text) {
  const start = textarea.selectionStart, end = textarea.selectionEnd;
  const val = textarea.value;
  textarea.value = val.slice(0, start) + text + val.slice(end);
  const newPos = start + text.length;
  textarea.setSelectionRange(newPos, newPos);
  textarea.dispatchEvent(new Event('input'));
  textarea.focus();
  return { start, end: start + text.length };
}
function replaceRange(range, text) {
  const val = textarea.value;
  textarea.value = val.slice(0, range.start) + text + val.slice(range.end);
  const newEnd = range.start + text.length;
  textarea.setSelectionRange(newEnd, newEnd);
  textarea.dispatchEvent(new Event('input'));
  return { start: range.start, end: newEnd };
}
const btnInsertColor = document.getElementById('btn-insert-color');
btnInsertColor.addEventListener('click', () => {
  let tokenRange = insertAtCursor(`CC:${customSwatchHex || '#e8a598'}`);
  openColorPicker({
    anchorEl: btnInsertColor,
    initialHex: customSwatchHex || '#e8a598',
    live: (hex) => { tokenRange = replaceRange(tokenRange, `CC:${hex}`); },
    onCommit: (hex) => { tokenRange = replaceRange(tokenRange, `CC:${hex}`); },
  });
});

// Rebuilds both the yarn mesh and the row-marker overlay from lastGraph +
// whatever getDisplayPos() currently returns (the real solve, or a
// pressed-flat copy of it if Flatten is on) - shared by the color picker,
// the flip/flatten/row-marker toggles, and the end of a fresh solve in
// run(). No re-solving of the physics happens here; it's a pure rebuild
// from already-known positions.
export function rebuildDisplay() {
  if (!lastGraph) return;
  const pos = getDisplayPos();
  if (!pos) return;
  const yarnR = parseFloat(yarnOpt.value)||0.38;
  disposeMesh(currentMesh);
  disposeMesh(currentRowGroup);
  setCurrentMesh(buildMesh(lastGraph.nodeData, lastGraph.adjList, pos, lastGraph.roundNodes, lastGraph.roundBobbles, {
    yarnRadius: yarnR,
    useTexture: true,
    isFlatPiece: lastGraph.isFlatPiece,
    chainFoundationRound: lastGraph.chainFoundationRound,
    mrRoundIndices: lastGraph.mrRoundIndices,
    closingRoundIndices: lastGraph.closingRoundIndices,
    foldRounds: lastGraph.foldRounds,
    flapRounds: lastGraph.flapRounds,
    fuseRoundSegments: lastGraph.fuseRoundSegments,
    fusedPinnedIds: lastGraph.fusedPinnedIds,
  }));
  scene.add(currentMesh);

  setCurrentRowGroup(buildRowMarkerGroup(lastGraph.nodeData, lastGraph.roundNodes, lastGraph.roundTypes, pos, yarnR, lastGraph.isFlatPiece, lastGraph.chainFoundationRound, lastGraph.foldRounds, lastGraph.roundAttachTo, lastGraph.flapRounds));
  currentRowGroup._lineGrp.visible = rowsOn;
  currentRowGroup._startDotGrp.visible = startDotOn;
  scene.add(currentRowGroup);

  applyFlip();
}
// Old name, kept as an alias - color swatches and other call sites already
// wired to it don't need to change.
export function rebuildMeshFromCache() { rebuildDisplay(); }