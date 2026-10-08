import { type Path, bounds, sample } from './bezier';
import { BezierEditor, SharedView } from './editor2d';
import { COLORS, type Design, PRESETS, alignPlan, blockId, designFromPreset, dims, extents, parseDesign } from './model';
import { exportStructure } from './nbt';
import { Preview } from './preview3d';
import { renderViews } from './views';
import { type Grid, type Projection, projectPlan, projectSide, voxelize } from './voxelize';

const STORAGE_KEY = 'gasbag-maker:design';
// autosave key from before the rename
const LEGACY_STORAGE_KEY = 'envelope-shaper:design';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let design: Design = loadStored() ?? designFromPreset(PRESETS[0]);
let committed = JSON.stringify(design);
const undoStack: string[] = [];
const redoStack: string[] = [];

let grid: Grid | undefined;
let sideProj: Projection | null = null;
let planProj: Projection | null = null;

function loadStored(): Design | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    return raw ? parseDesign(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function store() {
  try {
    localStorage.setItem(STORAGE_KEY, committed);
  } catch {
    // storage unavailable
  }
}

function commit() {
  const s = JSON.stringify(design);
  if (s === committed) return;
  undoStack.push(committed);
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  committed = s;
  store();
  syncHistory();
}

function restore(s: string) {
  design = JSON.parse(s);
  committed = s;
  store();
  syncUI();
  syncHistory();
  regen();
}

function undo() {
  commit();
  const s = undoStack.pop();
  if (!s) return;
  redoStack.push(committed);
  restore(s);
}

function redo() {
  const s = redoStack.pop();
  if (!s) return;
  undoStack.push(committed);
  restore(s);
}

function syncHistory() {
  $<HTMLButtonElement>('undo').disabled = !undoStack.length;
  $<HTMLButtonElement>('redo').disabled = !redoStack.length;
}

function xExtent(p: Path): number[] {
  const b = bounds(sample(p, 16));
  return [b.x0, b.x1];
}

const overlayOn = () => $<HTMLInputElement>('overlay').checked;

const view = new SharedView(() => design.scale);

new BezierEditor($('side'), view, {
  title: () => 'Side',
  mirror: false,
  getPath: () => design.side,
  getOverlay: () => (overlayOn() ? sideProj : null),
  getCellOrigin: () => ({ x: grid?.ox ?? 0, y: grid?.oy ?? 0 }),
  getGuides: () => (design.linkTop ? [] : xExtent(design.plan)),
  lockEndsX: () => false,
  onChange: (final) => {
    if (design.linkTop) alignPlan(design);
    edited(final);
  },
});

new BezierEditor($('plan'), view, {
  title: () => (design.build === 'stack' ? 'Top slice (mirrored)' : 'Top (mirrored)'),
  mirror: true,
  getPath: () => design.plan,
  getOverlay: () => (overlayOn() ? planProj : null),
  getCellOrigin: () => ({ x: grid?.ox ?? 0, y: grid?.oz ?? 0 }),
  getGuides: () => (design.linkTop ? [] : xExtent(design.side)),
  lockEndsX: () => design.linkTop,
  onChange: edited,
});

const preview = new Preview($('view3d'));
preview.setBackground(getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());

function edited(final: boolean) {
  regen();
  if (final) commit();
}

let regenPending = false;
function regen() {
  if (regenPending) return;
  regenPending = true;
  requestAnimationFrame(() => {
    regenPending = false;
    grid = voxelize(design);
    sideProj = projectSide(grid);
    planProj = projectPlan(grid);
    preview.update(grid, {
      color: COLORS[design.color] ?? '#ffffff',
      cutaway: $<HTMLInputElement>('cutaway').checked,
      player: $<HTMLInputElement>('player').checked,
    });
    view.redraw();
    syncSize(document.activeElement as HTMLInputElement);
    $('stats').textContent =
      `size  ${grid.sx} × ${grid.sz} × ${grid.sy}  (L×W×H)\n` +
      `blocks ${grid.blocks.toLocaleString()}\n` +
      (design.hollow ? `inside ${grid.interior.toLocaleString()} air` : '');
  });
}

// numeric range + number pairs

type SizeKey = 'length' | 'width' | 'height' | 'scale';
type NumKey = SizeKey | 'sectionTop' | 'sectionBottom' | 'shell';
const numInputs = {} as Record<NumKey, { range: HTMLInputElement; num: HTMLInputElement }>;

function setNum(key: NumKey, v: number, skip?: HTMLInputElement) {
  const { range, num } = numInputs[key];
  if (range !== skip) range.value = String(v);
  if (num !== skip) num.value = String(v);
}

// any size field drives the single scale, the others follow
function applyNum(key: NumKey, v: number) {
  if (key === 'scale') {
    design.scale = Math.max(0.01, v);
  } else if (key === 'length' || key === 'width' || key === 'height') {
    const e = extents(design)[key];
    if (e > 1e-6) design.scale = Math.max(0.01, v / e);
  } else {
    design[key] = v;
  }
}

function syncSize(skip?: HTMLInputElement) {
  const d = dims(design);
  setNum('length', d.L, skip);
  setNum('width', d.W, skip);
  setNum('height', d.H, skip);
  setNum('scale', Math.round(design.scale * 100) / 100, skip);
}

for (const el of document.querySelectorAll<HTMLElement>('.num')) {
  const key = el.dataset.key as NumKey;
  const range = document.createElement('input');
  const num = document.createElement('input');
  range.type = 'range';
  num.type = 'number';
  for (const i of [range, num]) {
    i.min = el.dataset.min!;
    i.max = el.dataset.max!;
    i.step = el.dataset.step!;
    i.setAttribute('aria-label', key);
  }
  // typed values may exceed the slider range
  num.removeAttribute('max');
  el.append(range, num);
  numInputs[key] = { range, num };
  for (const input of [range, num]) {
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      if (!Number.isFinite(v)) return;
      applyNum(key, v);
      if (key in { length: 1, width: 1, height: 1, scale: 1 }) syncSize(input);
      else setNum(key, v, input);
      regen();
    });
    input.addEventListener('change', () => {
      commit();
      syncUI();
    });
  }
}

const colorSel = $<HTMLSelectElement>('color');
for (const c of Object.keys(COLORS)) colorSel.add(new Option(c.replace('_', ' '), c));

const presetSel = $<HTMLSelectElement>('preset');
PRESETS.forEach((p, i) => presetSel.add(new Option(p.name, String(i))));
presetSel.addEventListener('change', () => {
  const p = PRESETS[Number(presetSel.value)];
  presetSel.value = '';
  if (!p) return;
  design = designFromPreset(p, design);
  if (design.linkTop) alignPlan(design);
  commit();
  syncUI();
  regen();
  fitViews();
});

function syncUI() {
  syncSize();
  setNum('sectionTop', design.sectionTop);
  setNum('sectionBottom', design.sectionBottom);
  setNum('shell', design.shell);
  $<HTMLInputElement>('name').value = design.name;
  $<HTMLInputElement>('hollow').checked = design.hollow;
  $<HTMLInputElement>('linkTop').checked = design.linkTop;
  $<HTMLSelectElement>('build').value = design.build;
  // stack takes its section from the top outline
  const stack = design.build === 'stack';
  for (const key of ['sectionTop', 'sectionBottom'] as const) {
    numInputs[key].range.disabled = stack;
    numInputs[key].num.disabled = stack;
  }
  $('section-hint').textContent = stack
    ? 'Not used when stacking. The top outline is the slice shape.'
    : '2 is round. Higher is boxier, lower comes to a ridge.';
  $<HTMLSelectElement>('material').value = design.material;
  colorSel.value = design.color;
}

$<HTMLInputElement>('name').addEventListener('change', (e) => {
  design.name = (e.target as HTMLInputElement).value;
  commit();
});

$<HTMLInputElement>('hollow').addEventListener('change', (e) => {
  design.hollow = (e.target as HTMLInputElement).checked;
  commit();
  regen();
});

$<HTMLInputElement>('linkTop').addEventListener('change', (e) => {
  design.linkTop = (e.target as HTMLInputElement).checked;
  if (design.linkTop) alignPlan(design);
  commit();
  regen();
});

$<HTMLSelectElement>('build').addEventListener('change', (e) => {
  design.build = (e.target as HTMLSelectElement).value as Design['build'];
  commit();
  syncUI();
  regen();
  fitViews();
});

$<HTMLSelectElement>('material').addEventListener('change', (e) => {
  design.material = (e.target as HTMLSelectElement).value as Design['material'];
  commit();
});

colorSel.addEventListener('change', () => {
  design.color = colorSel.value;
  commit();
  regen();
});

for (const id of ['cutaway', 'overlay', 'player']) $(id).addEventListener('change', regen);

function fitViews() {
  view.fit();
  preview.fit(grid ?? voxelize(design));
}

$('fit-view').addEventListener('click', fitViews);

$('export').addEventListener('click', async () => {
  const g = voxelize(design);
  const bytes = await exportStructure(g, blockId(design));
  download(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }), `${slug(design.name)}.nbt`);
});

$('export-views').addEventListener('click', () => {
  const px = Number($<HTMLSelectElement>('views-px').value);
  const canvas = renderViews(voxelize(design), COLORS[design.color] ?? '#ffffff', px);
  canvas.toBlob((blob) => blob && download(blob, `${slug(design.name)}_views.png`));
});

$('save').addEventListener('click', () => {
  download(new Blob([JSON.stringify(design, null, 2)], { type: 'application/json' }), `${slug(design.name)}.json`);
});

const loadFile = $<HTMLInputElement>('load-file');
$('load').addEventListener('click', () => loadFile.click());
loadFile.addEventListener('change', async () => {
  const f = loadFile.files?.[0];
  loadFile.value = '';
  if (!f) return;
  try {
    const d = parseDesign(JSON.parse(await f.text()));
    if (!d) throw new Error('not a design file');
    design = d;
    commit();
    syncUI();
    regen();
    fitViews();
  } catch (err) {
    alert(`Could not open design: ${(err as Error).message}`);
  }
});

$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);

window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t.tagName === 'INPUT' || t.tagName === 'SELECT') return;
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey) undo();
  else if ((k === 'z' && e.shiftKey) || k === 'y') redo();
  else return;
  e.preventDefault();
});

// draggable divider between the outline editors and the 3d preview

const SPLIT_KEY = 'gasbag-maker:split';
const mainEl = document.querySelector<HTMLElement>('main')!;
const splitter = $('splitter');

function setSplit(f: number | null) {
  if (f === null) mainEl.style.removeProperty('--split');
  else mainEl.style.setProperty('--split', `${(f * 100).toFixed(2)}%`);
  try {
    if (f === null) localStorage.removeItem(SPLIT_KEY);
    else localStorage.setItem(SPLIT_KEY, String(f));
  } catch {
    // storage unavailable
  }
}

splitter.addEventListener('pointerdown', (e) => {
  splitter.setPointerCapture(e.pointerId);
  splitter.classList.add('dragging');
  e.preventDefault();
});
splitter.addEventListener('pointermove', (e) => {
  if (!splitter.hasPointerCapture(e.pointerId)) return;
  const r = mainEl.getBoundingClientRect();
  setSplit(Math.min(0.85, Math.max(0.15, (e.clientX - r.left) / r.width)));
});
splitter.addEventListener('pointerup', () => splitter.classList.remove('dragging'));
splitter.addEventListener('dblclick', () => setSplit(null));

try {
  const f = parseFloat(localStorage.getItem(SPLIT_KEY) ?? '');
  if (Number.isFinite(f)) setSplit(f);
} catch {
  // storage unavailable
}

function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function slug(s: string) {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'gasbag';
}

if (design.linkTop) alignPlan(design);
syncUI();
syncHistory();
regen();
fitViews();
