import { DATA_VERSION } from './model';
import { type Grid, idx } from './voxelize';

const END = 0, INT = 3, STRING = 8, LIST = 9, COMPOUND = 10;

class Writer {
  private buf = new Uint8Array(1 << 16);
  private view = new DataView(this.buf.buffer);
  private len = 0;
  private enc = new TextEncoder();

  private ensure(n: number) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number) {
    this.ensure(1);
    this.view.setUint8(this.len, v);
    this.len += 1;
  }

  i32(v: number) {
    this.ensure(4);
    this.view.setInt32(this.len, v);
    this.len += 4;
  }

  str(s: string) {
    const b = this.enc.encode(s);
    this.ensure(2 + b.length);
    this.view.setUint16(this.len, b.length);
    this.buf.set(b, this.len + 2);
    this.len += 2 + b.length;
  }

  tag(type: number, name: string) {
    this.u8(type);
    this.str(name);
  }

  // structure files need TAG_List of TAG_Int, not TAG_Int_Array
  intList(name: string, values: number[]) {
    this.tag(LIST, name);
    this.u8(INT);
    this.i32(values.length);
    for (const v of values) this.i32(v);
  }

  bytes() {
    return this.buf.slice(0, this.len);
  }
}

// vanilla structure format, readable by create's schematic table
export async function exportStructure(g: Grid, blockName: string): Promise<Uint8Array> {
  const w = new Writer();
  w.tag(COMPOUND, '');

  w.tag(INT, 'DataVersion');
  w.i32(DATA_VERSION);
  w.intList('size', [g.sx, g.sy, g.sz]);

  w.tag(LIST, 'palette');
  w.u8(COMPOUND);
  w.i32(1);
  w.tag(STRING, 'Name');
  w.str(blockName);
  w.u8(END);

  w.tag(LIST, 'blocks');
  w.u8(COMPOUND);
  w.i32(g.blocks);
  for (let k = 0; k < g.sz; k++)
    for (let j = 0; j < g.sy; j++)
      for (let i = 0; i < g.sx; i++) {
        if (!g.data[idx(g, i, j, k)]) continue;
        w.intList('pos', [i, j, k]);
        w.tag(INT, 'state');
        w.i32(0);
        w.u8(END);
      }

  w.tag(LIST, 'entities');
  w.u8(END);
  w.i32(0);

  w.u8(END);
  return gzip(w.bytes());
}

async function gzip(raw: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
