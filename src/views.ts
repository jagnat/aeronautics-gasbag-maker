import { type Grid, type Projection, projectFront, projectPlan, projectSide } from './voxelize';

const MARGIN = 1;
const GAP = 2;

// side top left, top view below it, front view to its right, so shared axes line up
export function renderViews(g: Grid, color: string, px: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = (MARGIN * 2 + g.sx + GAP + g.sz) * px;
  canvas.height = (MARGIN * 2 + g.sy + GAP + g.sz) * px;
  const ctx = canvas.getContext('2d')!;
  const [r, gr, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  ctx.fillStyle = r * 0.299 + gr * 0.587 + b * 0.114 > 128 ? '#1b1e24' : '#f2f2f2';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = color;

  const blit = (p: Projection, bx: number, by: number, flipY: boolean) => {
    for (let j = 0; j < p.h; j++)
      for (let i = 0; i < p.w; i++)
        if (p.cells[j * p.w + i]) ctx.fillRect((bx + i) * px, (by + (flipY ? p.h - 1 - j : j)) * px, px, px);
  };

  blit(projectSide(g), MARGIN, MARGIN, true);
  blit(projectPlan(g), MARGIN, MARGIN + g.sy + GAP, false);
  blit(projectFront(g), MARGIN + g.sx + GAP, MARGIN, true);
  return canvas;
}
