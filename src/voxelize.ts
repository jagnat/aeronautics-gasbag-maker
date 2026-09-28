import { intervalsAt, sample } from './bezier';
import type { Design } from './model';

export interface Grid {
  sx: number;
  sy: number;
  sz: number;
  // world block coords of cell (0,0,0)
  ox: number;
  oy: number;
  oz: number;
  data: Uint8Array;
  blocks: number;
  interior: number;
}

export const idx = (g: Grid, i: number, j: number, k: number) => (k * g.sy + j) * g.sx + i;

type Span = [number, number];

function mirrorMerge(iv: Span[]): Span[] {
  const all = iv.concat(iv.map(([a, b]) => [-b, -a] as Span)).sort((p, q) => p[0] - q[0]);
  const out: Span[] = [];
  for (const [a, b] of all) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1e-9) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function widest(iv: Span[]): Span {
  return iv.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
}

// nearest cells to the span centers, both middle cells when the center falls on a boundary
function nearestCells(o: number, n: number, span: Span): number[] {
  const c = (span[0] + span[1]) / 2 - o - 0.5;
  const lo = Math.floor(c + 1e-6), hi = Math.ceil(c - 1e-6);
  const out = new Set([lo, hi].map((v) => Math.min(n - 1, Math.max(0, v))));
  return [...out];
}

function fillCore(g: Grid, i: number, ys: Span, zs: Span) {
  for (const j of nearestCells(g.oy, g.sy, ys))
    for (const k of nearestCells(g.oz, g.sz, zs)) g.data[idx(g, i, j, k)] = 1;
}

function find(iv: Span[], v: number): Span | null {
  for (const s of iv) if (v >= s[0] && v <= s[1]) return s;
  return null;
}

export const cells = (extent: number) => Math.max(1, Math.round(extent));

export function voxelize(d: Design): Grid {
  const s = d.scale;
  const side = sample(d.side).map((p) => ({ x: p.x * s, y: p.y * s }));
  const plan = sample(d.plan).map((p) => ({ x: p.x * s, y: p.y * s }));

  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z1 = 0;
  for (const p of side) {
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y);
    y1 = Math.max(y1, p.y);
  }
  for (const p of plan) z1 = Math.max(z1, Math.abs(p.y));

  // center n cells on each axis so the block count matches the rounded size,
  // odd counts put a block on the center line
  const sx = cells(x1 - x0), sy = cells(y1 - y0), sz = cells(z1 * 2);
  const ox = (x0 + x1 - sx) / 2, oy = (y0 + y1 - sy) / 2, oz = -sz / 2;
  const g: Grid = { sx, sy, sz, ox, oy, oz, data: new Uint8Array(sx * sy * sz), blocks: 0, interior: 0 };

  for (let i = 0; i < sx; i++) {
    const xc = ox + i + 0.5;
    const siv = intervalsAt(side, xc);
    if (!siv.length) continue;
    const piv = mirrorMerge(intervalsAt(plan, xc));
    if (!piv.length) continue;
    let any = false;
    for (let j = 0; j < sy; j++) {
      const yc = oy + j + 0.5;
      const sp = find(siv, yc);
      if (!sp) continue;
      const half = (sp[1] - sp[0]) / 2;
      const u = (yc - (sp[0] + sp[1]) / 2) / half;
      const e = u > 0 ? d.sectionTop : d.sectionBottom;
      const pu = Math.pow(Math.abs(u), e);
      for (let k = 0; k < sz; k++) {
        const zc = oz + k + 0.5;
        const p = find(piv, zc);
        if (!p) continue;
        const v = (zc - (p[0] + p[1]) / 2) / ((p[1] - p[0]) / 2);
        if (pu + Math.pow(Math.abs(v), e) <= 1) {
          g.data[idx(g, i, j, k)] = 1;
          any = true;
        }
      }
    }
    // slices thinner than a block keep a core so tips taper instead of vanishing
    if (!any) fillCore(g, i, widest(siv), widest(piv));
  }

  if (d.hollow) hollow(g, Math.max(1, d.shell));
  for (let n = 0; n < g.data.length; n++) if (g.data[n]) g.blocks++;
  return g;
}

const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

// keep only cells within `shell` steps of the outside
function hollow(g: Grid, shell: number) {
  const { sx, sy, sz, data } = g;
  const dist = new Uint8Array(data.length);
  let frontier: number[] = [];
  const filled = (i: number, j: number, k: number) =>
    i >= 0 && j >= 0 && k >= 0 && i < sx && j < sy && k < sz && data[idx(g, i, j, k)] === 1;

  for (let k = 0; k < sz; k++)
    for (let j = 0; j < sy; j++)
      for (let i = 0; i < sx; i++) {
        const n = idx(g, i, j, k);
        if (!data[n]) continue;
        if (DIRS.some(([a, b, c]) => !filled(i + a, j + b, k + c))) {
          dist[n] = 1;
          frontier.push(n);
        }
      }

  for (let layer = 2; layer <= shell; layer++) {
    const next: number[] = [];
    for (const n of frontier) {
      const i = n % sx, j = Math.floor(n / sx) % sy, k = Math.floor(n / (sx * sy));
      for (const [a, b, c] of DIRS) {
        if (!filled(i + a, j + b, k + c)) continue;
        const m = idx(g, i + a, j + b, k + c);
        if (dist[m]) continue;
        dist[m] = layer;
        next.push(m);
      }
    }
    frontier = next;
  }

  for (let n = 0; n < data.length; n++) {
    if (data[n] && !dist[n]) {
      data[n] = 0;
      g.interior++;
    }
  }
}

export interface Projection {
  ox: number;
  oy: number;
  w: number;
  h: number;
  cells: Uint8Array;
}

export function projectSide(g: Grid): Projection {
  const cells = new Uint8Array(g.sx * g.sy);
  for (let k = 0; k < g.sz; k++)
    for (let j = 0; j < g.sy; j++)
      for (let i = 0; i < g.sx; i++) if (g.data[idx(g, i, j, k)]) cells[j * g.sx + i] = 1;
  return { ox: g.ox, oy: g.oy, w: g.sx, h: g.sy, cells };
}

export function projectPlan(g: Grid): Projection {
  const cells = new Uint8Array(g.sx * g.sz);
  for (let k = 0; k < g.sz; k++)
    for (let j = 0; j < g.sy; j++)
      for (let i = 0; i < g.sx; i++) if (g.data[idx(g, i, j, k)]) cells[k * g.sx + i] = 1;
  return { ox: g.ox, oy: g.oz, w: g.sx, h: g.sz, cells };
}
