export type Vec = { x: number; y: number };

// handles are offsets relative to the anchor
export type Node = { x: number; y: number; hin: Vec; hout: Vec; smooth: boolean };

export type Path = { nodes: Node[]; closed: boolean };

export type Seg = [Vec, Vec, Vec, Vec];

export function segmentCount(p: Path): number {
  return p.closed ? p.nodes.length : p.nodes.length - 1;
}

export function segment(p: Path, i: number): Seg {
  const a = p.nodes[i];
  const b = p.nodes[(i + 1) % p.nodes.length];
  return [
    { x: a.x, y: a.y },
    { x: a.x + a.hout.x, y: a.y + a.hout.y },
    { x: b.x + b.hin.x, y: b.y + b.hin.y },
    { x: b.x, y: b.y },
  ];
}

export function cubic(s: Seg, t: number): Vec {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return {
    x: a * s[0].x + b * s[1].x + c * s[2].x + d * s[3].x,
    y: a * s[0].y + b * s[1].y + c * s[2].y + d * s[3].y,
  };
}

export function sample(p: Path, perSeg = 48): Vec[] {
  const out: Vec[] = [];
  const n = segmentCount(p);
  for (let i = 0; i < n; i++) {
    const s = segment(p, i);
    for (let k = 0; k < perSeg; k++) out.push(cubic(s, k / perSeg));
  }
  if (!p.closed && p.nodes.length) {
    const last = p.nodes[p.nodes.length - 1];
    out.push({ x: last.x, y: last.y });
  }
  return out;
}

// even-odd spans of a closed polygon along the vertical line at x
export function intervalsAt(poly: Vec[], x: number): [number, number][] {
  const ys: number[] = [];
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    if ((a.x <= x) !== (b.x <= x)) {
      const t = (x - a.x) / (b.x - a.x);
      ys.push(a.y + t * (b.y - a.y));
    }
  }
  ys.sort((p, q) => p - q);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < ys.length; i += 2) out.push([ys[i], ys[i + 1]]);
  return out;
}

export function bounds(pts: Vec[]) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, x1, y0, y1 };
}

// de casteljau split of segment i at t, inserting a new smooth node
export function splitSegment(p: Path, i: number, t: number): number {
  const [p0, p1, p2, p3] = segment(p, i);
  const lerp = (a: Vec, b: Vec): Vec => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const p01 = lerp(p0, p1), p12 = lerp(p1, p2), p23 = lerp(p2, p3);
  const p012 = lerp(p01, p12), p123 = lerp(p12, p23);
  const m = lerp(p012, p123);
  const a = p.nodes[i];
  const bi = (i + 1) % p.nodes.length;
  const b = p.nodes[bi];
  a.hout = { x: p01.x - p0.x, y: p01.y - p0.y };
  b.hin = { x: p23.x - p3.x, y: p23.y - p3.y };
  const node: Node = {
    x: m.x,
    y: m.y,
    hin: { x: p012.x - m.x, y: p012.y - m.y },
    hout: { x: p123.x - m.x, y: p123.y - m.y },
    smooth: true,
  };
  p.nodes.splice(i + 1, 0, node);
  return i + 1;
}

export function clonePath(p: Path): Path {
  return JSON.parse(JSON.stringify(p));
}
