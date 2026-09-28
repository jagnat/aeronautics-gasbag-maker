import { type Path, type Vec, bounds, cubic, sample, segment, segmentCount, splitSegment } from './bezier';
import type { Projection } from './voxelize';

export interface EditorOptions {
  title: string;
  // open half path mirrored across the axis, endpoints locked to it
  mirror: boolean;
  getPath(): Path;
  getOverlay(): Projection | null;
  // world position of any block corner, for aligning grid lines
  getCellOrigin(): Vec;
  // unit x positions to mark with guide lines
  getGuides(): number[];
  // endpoints can't move lengthwise
  lockEndsX(): boolean;
  onChange(final: boolean): void;
}

type Hit = { kind: 'anchor' | 'hin' | 'hout'; i: number };

type Drag =
  | { kind: 'anchor'; i: number; off: Vec }
  | { kind: 'hin' | 'hout'; i: number }
  | { kind: 'pan'; last: Vec };

const ANCHOR_R = 6;
const HANDLE_R = 4.5;
const HIT_R = 9;
const PAD = 36;

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// horizontal zoom and pan shared by all editors so side and top stay aligned
export class SharedView {
  zoom = 1;
  camX = 0;
  autoFit = true;
  // world x under the pointer in any editor
  cursorX: number | null = null;
  readonly editors: BezierEditor[] = [];

  constructor(public getScale: () => number) {}

  fit() {
    this.autoFit = true;
    for (const e of this.editors) e.captureFitBox();
    this.redraw();
  }

  applyFit() {
    if (!this.autoFit || !this.editors.length) return;
    const s = this.getScale();
    let x0 = Infinity, x1 = -Infinity, zoom = Infinity;
    for (const e of this.editors) {
      const b = e.fitBox;
      x0 = Math.min(x0, b.x0 * s);
      x1 = Math.max(x1, b.x1 * s);
    }
    for (const e of this.editors) {
      const b = e.fitBox;
      const zx = (e.cw - PAD * 2) / Math.max(1e-6, (x1 - x0));
      const zy = (e.ch - PAD * 2 - 16) / Math.max(1e-6, (b.y1 - b.y0) * s);
      zoom = Math.min(zoom, zx, zy);
    }
    this.zoom = Math.max(0.01, zoom);
    this.camX = (x0 + x1) / 2;
    for (const e of this.editors) e.camY = ((e.fitBox.y0 + e.fitBox.y1) / 2) * s;
  }

  redraw() {
    for (const e of this.editors) e.redraw();
  }
}

export class BezierEditor {
  cw = 0;
  ch = 0;
  camY = 0;
  fitBox = { x0: 0, x1: 1, y0: -0.5, y1: 0.5 };
  private ctx: CanvasRenderingContext2D;
  private selected = -1;
  private hover: Hit | null = null;
  private drag: Drag | null = null;
  private moved = false;
  private cursor: Vec | null = null;
  private pending = false;

  constructor(private canvas: HTMLCanvasElement, private view: SharedView, private o: EditorOptions) {
    this.ctx = canvas.getContext('2d')!;
    view.editors.push(this);
    this.captureFitBox();
    canvas.tabIndex = 0;
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement!);
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointerleave', () => {
      this.cursor = null;
      this.view.cursorX = null;
      this.view.redraw();
    });
    canvas.addEventListener('dblclick', (e) => this.dbl(e));
    canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('keydown', (e) => this.key(e));
    this.resize();
  }

  captureFitBox() {
    const b = bounds(sample(this.o.getPath(), 24));
    if (this.o.mirror) {
      const z = Math.max(Math.abs(b.y0), Math.abs(b.y1));
      this.fitBox = { x0: b.x0, x1: b.x1, y0: -z, y1: z };
    } else {
      this.fitBox = b;
    }
  }

  redraw() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.draw();
    });
  }

  private resize() {
    const r = this.canvas.parentElement!.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.cw = r.width;
    this.ch = r.height;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.canvas.style.width = `${r.width}px`;
    this.canvas.style.height = `${r.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.view.redraw();
  }

  // unit coords <-> world blocks <-> screen

  private worldToScreen(x: number, y: number): Vec {
    const v = this.view;
    return { x: this.cw / 2 + (x - v.camX) * v.zoom, y: this.ch / 2 - (y - this.camY) * v.zoom };
  }

  private screenToWorld(s: Vec): Vec {
    const v = this.view;
    return { x: (s.x - this.cw / 2) / v.zoom + v.camX, y: -(s.y - this.ch / 2) / v.zoom + this.camY };
  }

  private toScreen(p: Vec): Vec {
    const s = this.view.getScale();
    return this.worldToScreen(p.x * s, p.y * s);
  }

  private toUnit(p: Vec): Vec {
    const s = this.view.getScale();
    const w = this.screenToWorld(p);
    return { x: w.x / s, y: w.y / s };
  }

  private pos(e: PointerEvent | MouseEvent | WheelEvent): Vec {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private hitTest(s: Vec): Hit | null {
    const nodes = this.o.getPath().nodes;
    const near = (p: Vec) => Math.hypot(p.x - s.x, p.y - s.y) <= HIT_R;
    for (let i = nodes.length - 1; i >= 0; i--) if (near(this.toScreen(nodes[i]))) return { kind: 'anchor', i };
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (this.showHandle(i, 'hout') && near(this.toScreen({ x: n.x + n.hout.x, y: n.y + n.hout.y })))
        return { kind: 'hout', i };
      if (this.showHandle(i, 'hin') && near(this.toScreen({ x: n.x + n.hin.x, y: n.y + n.hin.y })))
        return { kind: 'hin', i };
    }
    return null;
  }

  private showHandle(i: number, which: 'hin' | 'hout'): boolean {
    const p = this.o.getPath();
    if (!p.closed && which === 'hin' && i === 0) return false;
    if (!p.closed && which === 'hout' && i === p.nodes.length - 1) return false;
    const h = p.nodes[i][which];
    return h.x !== 0 || h.y !== 0;
  }

  private nearestOnCurve(s: Vec) {
    const p = this.o.getPath();
    let best = { seg: -1, t: 0, d: Infinity };
    for (let i = 0; i < segmentCount(p); i++) {
      const sg = segment(p, i);
      for (let k = 1; k < 64; k++) {
        const t = k / 64;
        const q = this.toScreen(cubic(sg, t));
        const d = Math.hypot(q.x - s.x, q.y - s.y);
        if (d < best.d) best = { seg: i, t, d };
      }
    }
    return best;
  }

  private isEnd(i: number): boolean {
    const n = this.o.getPath().nodes.length;
    return this.o.mirror && (i === 0 || i === n - 1);
  }

  private down(e: PointerEvent) {
    this.canvas.focus();
    this.canvas.setPointerCapture(e.pointerId);
    const s = this.pos(e);
    this.moved = false;
    if (e.button === 1 || e.button === 2) {
      this.drag = { kind: 'pan', last: s };
      return;
    }
    const hit = this.hitTest(s);
    if (!hit) {
      this.selected = -1;
      this.redraw();
      return;
    }
    this.selected = hit.i;
    const node = this.o.getPath().nodes[hit.i];
    if (hit.kind === 'anchor' && e.altKey) {
      node.smooth = true;
      this.drag = { kind: 'hout', i: hit.i };
    } else if (hit.kind === 'anchor') {
      const n = this.toUnit(s);
      this.drag = { kind: 'anchor', i: hit.i, off: { x: node.x - n.x, y: node.y - n.y } };
    } else {
      if (e.altKey) node.smooth = false;
      this.drag = { kind: hit.kind, i: hit.i };
    }
    this.redraw();
  }

  private move(e: PointerEvent) {
    const s = this.pos(e);
    this.cursor = s;
    this.view.cursorX = this.screenToWorld(s).x;
    const d = this.drag;
    if (!d) {
      const h = this.hitTest(s);
      this.hover = h;
      this.canvas.style.cursor = h ? 'pointer' : 'crosshair';
      this.view.redraw();
      return;
    }
    if (d.kind === 'pan') {
      this.view.autoFit = false;
      this.view.camX -= (s.x - d.last.x) / this.view.zoom;
      this.camY += (s.y - d.last.y) / this.view.zoom;
      d.last = s;
      this.view.redraw();
      return;
    }
    this.moved = true;
    const node = this.o.getPath().nodes[d.i];
    const n = this.toUnit(s);
    if (d.kind === 'anchor') {
      const end = this.isEnd(d.i);
      if (!(end && this.o.lockEndsX())) node.x = n.x + d.off.x;
      node.y = end ? 0 : n.y + d.off.y;
    } else {
      const other = d.kind === 'hout' ? 'hin' : 'hout';
      const h = { x: n.x - node.x, y: n.y - node.y };
      node[d.kind] = h;
      if (node.smooth) {
        const len = Math.hypot(h.x, h.y) || 1;
        const olen = Math.hypot(node[other].x, node[other].y) || len;
        node[other] = { x: (-h.x / len) * olen, y: (-h.y / len) * olen };
      }
    }
    this.o.onChange(false);
    this.view.redraw();
  }

  private up(e: PointerEvent) {
    this.canvas.releasePointerCapture(e.pointerId);
    const wasEdit = this.drag && this.drag.kind !== 'pan' && this.moved;
    this.drag = null;
    if (wasEdit) this.o.onChange(true);
  }

  private dbl(e: MouseEvent) {
    const s = this.pos(e);
    const p = this.o.getPath();
    const hit = this.hitTest(s);
    if (hit?.kind === 'anchor') {
      const n = p.nodes[hit.i];
      n.smooth = !n.smooth;
      if (n.smooth) {
        const dx = n.hout.x - n.hin.x, dy = n.hout.y - n.hin.y;
        const len = Math.hypot(dx, dy);
        if (len > 0) {
          const lo = Math.hypot(n.hout.x, n.hout.y), li = Math.hypot(n.hin.x, n.hin.y);
          n.hout = { x: (dx / len) * lo, y: (dy / len) * lo };
          n.hin = { x: (-dx / len) * li, y: (-dy / len) * li };
        }
      }
      this.o.onChange(true);
      this.view.redraw();
      return;
    }
    const best = this.nearestOnCurve(s);
    if (best.d <= HIT_R) {
      this.selected = splitSegment(p, best.seg, best.t);
      this.o.onChange(true);
      this.view.redraw();
    }
  }

  private wheel(e: WheelEvent) {
    e.preventDefault();
    const v = this.view;
    v.autoFit = false;
    const s = this.pos(e);
    const w = this.screenToWorld(s);
    v.zoom *= Math.pow(1.0015, -e.deltaY);
    v.camX = w.x - (s.x - this.cw / 2) / v.zoom;
    this.camY = w.y + (s.y - this.ch / 2) / v.zoom;
    v.redraw();
  }

  private key(e: KeyboardEvent) {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    const p = this.o.getPath();
    const i = this.selected;
    if (i < 0 || this.isEnd(i)) return;
    if (p.nodes.length <= (p.closed ? 3 : 2)) return;
    p.nodes.splice(i, 1);
    this.selected = -1;
    this.o.onChange(true);
    this.view.redraw();
    e.preventDefault();
  }

  private tracePath(ctx: CanvasRenderingContext2D, p: Path, flip: boolean) {
    const m = (v: Vec) => this.toScreen(flip ? { x: v.x, y: -v.y } : v);
    if (!p.nodes.length) return;
    const start = m(p.nodes[0]);
    ctx.moveTo(start.x, start.y);
    for (let i = 0; i < segmentCount(p); i++) {
      const [, c1, c2, e] = segment(p, i);
      const a = m(c1), b = m(c2), c = m(e);
      ctx.bezierCurveTo(a.x, a.y, b.x, b.y, c.x, c.y);
    }
    if (p.closed) ctx.closePath();
  }

  private draw() {
    const ctx = this.ctx;
    const { cw, ch } = this;
    const v = this.view;
    v.applyFit();
    const p = this.o.getPath();
    const scale = v.getScale();
    const accent = css('--accent');
    const muted = css('--muted');

    ctx.fillStyle = css('--canvas');
    ctx.fillRect(0, 0, cw, ch);

    // block grid
    if (v.zoom >= 5) {
      ctx.strokeStyle = css('--grid');
      ctx.lineWidth = 1;
      ctx.beginPath();
      const tl = this.screenToWorld({ x: 0, y: 0 }), br = this.screenToWorld({ x: cw, y: ch });
      const o = this.o.getCellOrigin();
      const fx = o.x - Math.floor(o.x), fy = o.y - Math.floor(o.y);
      for (let x = Math.floor(tl.x) - 1; x <= Math.ceil(br.x); x++) {
        const sx = Math.round(this.worldToScreen(x + fx, 0).x) + 0.5;
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, ch);
      }
      for (let y = Math.floor(br.y) - 1; y <= Math.ceil(tl.y); y++) {
        const sy = Math.round(this.worldToScreen(0, y + fy).y) + 0.5;
        ctx.moveTo(0, sy);
        ctx.lineTo(cw, sy);
      }
      ctx.stroke();
    }

    const ov = this.o.getOverlay();
    if (ov) {
      ctx.fillStyle = css('--cells');
      const gap = v.zoom >= 6 ? 1 : 0;
      for (let j = 0; j < ov.h; j++)
        for (let i = 0; i < ov.w; i++) {
          if (!ov.cells[j * ov.w + i]) continue;
          const a = this.worldToScreen(ov.ox + i, ov.oy + j + 1);
          const b = this.worldToScreen(ov.ox + i + 1, ov.oy + j);
          ctx.fillRect(a.x, a.y, b.x - a.x - gap, b.y - a.y - gap);
        }
    }

    // bounding box and axis
    const b = bounds(sample(p, 24));
    if (this.o.mirror) {
      const z = Math.max(Math.abs(b.y0), Math.abs(b.y1));
      b.y0 = -z;
      b.y1 = z;
    }
    const tl = this.toScreen({ x: b.x0, y: b.y1 });
    const br = this.toScreen({ x: b.x1, y: b.y0 });
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = muted;
    ctx.lineWidth = 1;
    ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    if (this.o.mirror) {
      const ay = this.worldToScreen(0, 0).y;
      ctx.beginPath();
      ctx.moveTo(0, ay);
      ctx.lineTo(cw, ay);
      ctx.stroke();
    }

    ctx.strokeStyle = css('--guide');
    for (const gx of this.o.getGuides()) {
      const sx = this.toScreen({ x: gx, y: 0 }).x;
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, ch);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    if (v.cursorX !== null) {
      const sx = Math.round(this.worldToScreen(v.cursorX, 0).x) + 0.5;
      ctx.strokeStyle = css('--cursor');
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, ch);
      ctx.stroke();
    }

    // outline
    ctx.lineWidth = 2;
    ctx.strokeStyle = accent;
    ctx.fillStyle = css('--fill');
    if (this.o.mirror) {
      for (const flip of [false, true]) {
        ctx.beginPath();
        this.tracePath(ctx, p, flip);
        ctx.closePath();
        ctx.fill();
      }
      ctx.beginPath();
      this.tracePath(ctx, p, false);
      ctx.stroke();
      ctx.setLineDash([5, 4]);
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      this.tracePath(ctx, p, true);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
    } else {
      ctx.beginPath();
      this.tracePath(ctx, p, false);
      ctx.fill();
      ctx.stroke();
    }

    // handles
    ctx.lineWidth = 1;
    p.nodes.forEach((n, i) => {
      const a = this.toScreen(n);
      for (const which of ['hin', 'hout'] as const) {
        if (!this.showHandle(i, which)) continue;
        const h = this.toScreen({ x: n.x + n[which].x, y: n.y + n[which].y });
        ctx.strokeStyle = muted;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(h.x, h.y);
        ctx.stroke();
        const hot = this.hover?.i === i && this.hover.kind === which;
        ctx.fillStyle = hot ? accent : css('--handle');
        ctx.beginPath();
        ctx.arc(h.x, h.y, HANDLE_R, 0, Math.PI * 2);
        ctx.fill();
      }
    });

    p.nodes.forEach((n, i) => {
      const a = this.toScreen(n);
      const sel = i === this.selected;
      const hot = this.hover?.i === i && this.hover.kind === 'anchor';
      ctx.fillStyle = sel ? accent : css('--canvas');
      ctx.strokeStyle = sel || hot ? accent : css('--text');
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (n.smooth) ctx.arc(a.x, a.y, ANCHOR_R, 0, Math.PI * 2);
      else ctx.rect(a.x - ANCHOR_R + 1, a.y - ANCHOR_R + 1, (ANCHOR_R - 1) * 2, (ANCHOR_R - 1) * 2);
      ctx.fill();
      ctx.stroke();
    });

    // labels
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.fillStyle = css('--text');
    ctx.fillText(this.o.title, 12, 20);
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillStyle = muted;
    const dimLabel = `${Math.round((b.x1 - b.x0) * scale)} × ${Math.round((b.y1 - b.y0) * scale)} blocks`;
    ctx.fillText(dimLabel, cw - ctx.measureText(dimLabel).width - 12, 20);
    const hint = 'dbl-click line: add · dbl-click point: smooth/corner · Del: remove';
    ctx.fillText(hint, cw - ctx.measureText(hint).width - 12, ch - 10);
    if (this.cursor) {
      const w = this.screenToWorld(this.cursor);
      ctx.fillText(`x ${w.x.toFixed(1)}  ${this.o.mirror ? 'z' : 'y'} ${w.y.toFixed(1)}`, 12, ch - 10);
    }
  }
}
