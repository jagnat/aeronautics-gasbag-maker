import { type Node, type Path, bounds, sample } from './bezier';

export type EnvelopeMaterial = 'wool' | 'envelope';

// outlines share one unit, so proportions live in the curves and scale is blocks per unit
// side: closed outline in (x, y); plan: open half outline in (x, z) from nose to tail on the axis, mirrored
export interface Design {
  version: 2;
  name: string;
  side: Path;
  plan: Path;
  scale: number;
  // plan is stretched lengthwise to match the side outline's nose and tail
  linkTop: boolean;
  sectionTop: number;
  sectionBottom: number;
  hollow: boolean;
  shell: number;
  material: EnvelopeMaterial;
  color: string;
}

export const DATA_VERSION = 3955;

export const COLORS: Record<string, string> = {
  white: '#e9ecec',
  orange: '#f07613',
  magenta: '#bd44b3',
  light_blue: '#3aafd9',
  yellow: '#f8c527',
  lime: '#70b919',
  pink: '#ed8dac',
  gray: '#3e4447',
  light_gray: '#8e8e86',
  cyan: '#158991',
  purple: '#792aac',
  blue: '#35399d',
  brown: '#724728',
  green: '#546d1b',
  red: '#a12722',
  black: '#141519',
};

export function shapeBounds(d: Design) {
  // same sampling as voxelize so rounded sizes agree
  const sb = bounds(sample(d.side));
  const pb = bounds(sample(d.plan));
  return { x0: sb.x0, x1: sb.x1, y0: sb.y0, y1: sb.y1, z: Math.max(Math.abs(pb.y0), Math.abs(pb.y1)) };
}

// unit extents of the shape
export function extents(d: Design) {
  const b = shapeBounds(d);
  return { length: b.x1 - b.x0, width: b.z * 2, height: b.y1 - b.y0 };
}

export function dims(d: Design) {
  const e = extents(d);
  const r = (v: number) => Math.max(1, Math.round(v * d.scale));
  return { L: r(e.length), W: r(e.width), H: r(e.height) };
}

export function alignPlan(d: Design) {
  const sb = bounds(sample(d.side, 24));
  const nodes = d.plan.nodes;
  const p0 = nodes[0].x, p1 = nodes[nodes.length - 1].x;
  if (Math.abs(p1 - p0) < 1e-6) return;
  const k = (sb.x1 - sb.x0) / (p1 - p0);
  for (const n of nodes) {
    n.x = sb.x0 + (n.x - p0) * k;
    n.hin.x *= k;
    n.hout.x *= k;
  }
}

export function blockId(d: Design): string {
  return d.material === 'envelope' ? `aeronautics:${d.color}_envelope` : `minecraft:${d.color}_wool`;
}

function sn(x: number, y: number, tx: number, ty: number, li: number, lo = li): Node {
  const m = Math.hypot(tx, ty) || 1;
  tx /= m;
  ty /= m;
  return { x, y, hin: { x: -tx * li, y: -ty * li }, hout: { x: tx * lo, y: ty * lo }, smooth: true };
}

function cn(x: number, y: number, hin: [number, number], hout: [number, number]): Node {
  return { x, y, hin: { x: hin[0], y: hin[1] }, hout: { x: hout[0], y: hout[1] }, smooth: false };
}

const closed = (...nodes: Node[]): Path => ({ nodes, closed: true });
const open = (...nodes: Node[]): Path => ({ nodes, closed: false });

// presets are authored normalized: x in [0,1], y in [-0.5,0.5], stretched by length/width/height
type Preset = Pick<Design, 'name' | 'side' | 'plan' | 'sectionTop' | 'sectionBottom'> & {
  length: number;
  width: number;
  height: number;
};

export const PRESETS: Preset[] = [
  {
    name: 'Classic Blimp',
    length: 40, width: 16, height: 16, sectionTop: 2, sectionBottom: 2,
    side: closed(
      sn(0, 0, 0, 1, 0.276),
      sn(0.5, 0.5, 1, 0, 0.276),
      sn(1, 0, 0, -1, 0.276),
      sn(0.5, -0.5, -1, 0, 0.276),
    ),
    plan: open(sn(0, 0, 0, 1, 0.276), sn(0.5, 0.5, 1, 0, 0.276), sn(1, 0, 0, -1, 0.276)),
  },
  {
    name: 'Zeppelin',
    length: 64, width: 14, height: 14, sectionTop: 2, sectionBottom: 2,
    side: closed(
      sn(0, 0, 0, 1, 0.12),
      sn(0.4, 0.5, 1, 0, 0.3, 0.35),
      cn(1, 0, [-0.25, 0.08], [-0.25, -0.08]),
      sn(0.4, -0.5, -1, 0, 0.35, 0.3),
    ),
    plan: open(sn(0, 0, 0, 1, 0.12), sn(0.4, 0.5, 1, 0, 0.3, 0.35), cn(1, 0, [-0.25, 0.08], [0, 0])),
  },
  {
    name: 'Sky Whale',
    length: 56, width: 20, height: 20, sectionTop: 2, sectionBottom: 2.4,
    side: closed(
      sn(0, 0.02, 0, 1, 0.16),
      sn(0.3, 0.5, 1, 0, 0.17, 0.24),
      sn(0.84, 0.13, 1, -0.3, 0.16, 0.06),
      cn(1, 0.1, [-0.05, 0.02], [-0.05, -0.03]),
      sn(0.84, -0.03, -1, -0.35, 0.06, 0.18),
      sn(0.36, -0.46, -1, 0, 0.2, 0.22),
    ),
    plan: open(
      sn(0, 0, 0, 1, 0.16),
      sn(0.32, 0.5, 1, 0, 0.18, 0.24),
      sn(0.84, 0.09, 1, -0.2, 0.15, 0.05),
      cn(1, 0, [-0.05, 0.03], [0, 0]),
    ),
  },
  {
    name: 'Crescent',
    length: 72, width: 18, height: 26, sectionTop: 2, sectionBottom: 2,
    side: closed(
      sn(0, 0.2, 0, 1, 0.08),
      sn(0.12, 0.38, 1, -0.15, 0.07, 0.15),
      sn(0.5, 0.12, 1, 0, 0.2, 0.2),
      cn(1, 0.5, [-0.15, -0.15], [-0.05, -0.2]),
      sn(0.55, -0.45, -1, 0, 0.28, 0.25),
      sn(0.1, 0, -0.6, 0.8, 0.1, 0.06),
    ),
    plan: open(sn(0, 0, 0, 1, 0.1), sn(0.45, 0.5, 1, 0, 0.3), cn(1, 0, [-0.2, 0.1], [0, 0])),
  },
  {
    name: 'Lobed Ark',
    length: 60, width: 22, height: 24, sectionTop: 2.2, sectionBottom: 2,
    side: closed(
      sn(0, 0, 0, 1, 0.12),
      sn(0.22, 0.44, 1, 0, 0.08),
      cn(0.38, 0.34, [-0.05, 0.04], [0.05, 0.04]),
      sn(0.55, 0.46, 1, 0, 0.08),
      cn(0.71, 0.34, [-0.05, 0.04], [0.05, 0.04]),
      sn(0.85, 0.42, 1, 0, 0.06),
      sn(1, 0.05, 0, -1, 0.15),
      sn(0.5, -0.5, -1, 0, 0.3),
    ),
    plan: open(
      sn(0, 0, 0, 1, 0.12),
      sn(0.22, 0.46, 1, 0, 0.08),
      cn(0.38, 0.36, [-0.05, 0.04], [0.05, 0.04]),
      sn(0.55, 0.5, 1, 0, 0.08),
      cn(0.71, 0.36, [-0.05, 0.04], [0.05, 0.04]),
      sn(0.85, 0.44, 1, 0, 0.06),
      sn(1, 0, 0, -1, 0.2),
    ),
  },
];

function stretch(p: Path, kx: number, ky: number) {
  for (const n of p.nodes) {
    n.x *= kx;
    n.y *= ky;
    n.hin = { x: n.hin.x * kx, y: n.hin.y * ky };
    n.hout = { x: n.hout.x * kx, y: n.hout.y * ky };
  }
}

export function designFromPreset(p: Preset, base?: Design): Design {
  const c = JSON.parse(JSON.stringify(p)) as Preset;
  stretch(c.side, c.length, c.height);
  stretch(c.plan, c.length, c.width);
  return {
    version: 2,
    name: c.name,
    side: c.side,
    plan: c.plan,
    scale: 1,
    linkTop: base?.linkTop ?? true,
    sectionTop: c.sectionTop,
    sectionBottom: c.sectionBottom,
    hollow: base?.hollow ?? true,
    shell: base?.shell ?? 1,
    material: base?.material ?? 'envelope',
    color: base?.color ?? 'white',
  };
}

export function parseDesign(v: unknown): Design | null {
  const d = v as Record<string, any>;
  if (!d || typeof d !== 'object' || !d.side?.nodes || !d.plan?.nodes) return null;
  if (d.version === 1) {
    // v1 stored normalized outlines plus separate length/width/height
    stretch(d.side, d.length, d.height);
    stretch(d.plan, d.length, d.width);
    for (const k of ['length', 'width', 'height']) delete d[k];
    d.version = 2;
    d.linkTop = false;
  }
  if (d.version !== 2 || typeof d.scale !== 'number') return null;
  return d as Design;
}
