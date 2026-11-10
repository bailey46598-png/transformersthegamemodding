// PS3 level scenes (.GSC from the PS3 build, e.g. the Hoover Dam Edition's HOOVEREXT_*_PS3.GSC): a read-only reader
// with the same interface as GSCScene, so the level view can show them. Format: PS3_HOOVEREXT_NOTES.md.
//   container: u32 nu20Rel, u32 nTex, nTex x {u32 offset, u32 size}; offsets relative to T = 8 + 8*nTex; NU20 at T + nu20Rel
//   NU20 v0: big-endian, tags byte-reversed, chunks 16-aligned (size excludes padding)
//   DISP: PC header layout, 8-byte commands {u8 op, u8 sub, u16 0, i32 rel}; 0x80 material, 0x83 matrix, 0x82 draw
//   draw record: +04 RSX streams {u8 n, u8 type (2 f32, 3 f16, 4 u8), u8 stride, 0, u32 offset}, +88 index offset,
//                +8C index count (BE u16 triangle list, absolute into the streams)
//   streams: float3 position, u8x4 normal, u8x4 RGBA colour (0x7F = 1.0), ..., last half-float stream = UV
//   material +0x25C = diffuse TST0 record index; TST0 68 B records: w, h, +0x20 fmt (0x86 DXT1 / 0x88 DXT5),
//                +0x30 = 0x80000000 | container texture index. DXT data is the same bytes as PC DDS.
import { transformPoints } from './formats.js';

const TAGS = ['HEAD', 'NTBL', 'TREF', 'TST0', 'MS00', 'SST0', 'INID', 'BNDS', 'FDNS', 'DISP', 'IABL', 'TAS0', 'SALI',
  'ALA3', 'DNO2', 'GSNH', 'PNTR'];

// True when the bytes are a PS3 scene (the NU20 tag sits byte-reversed where the PS3 container says).
export function isPS3Scene(buffer) {
  if (buffer.byteLength < 16) return false;
  const dv = new DataView(buffer), n = dv.getUint32(4, false), T = 8 + 8 * n;
  if (n > 100000 || T + 4 > buffer.byteLength) return false;
  const b = T + dv.getUint32(0, false);
  return b + 4 <= buffer.byteLength && dv.getUint32(b, false) === 0x3032554E; // "02UN"
}

const halfToFloat = h => {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
};

export class PS3Scene {
  constructor(buffer) {
    this.buf = buffer; this.ps3 = true; this.readOnly = true;
    this.u8 = new Uint8Array(buffer);
    const dv = this.dv = new DataView(buffer);
    const ntex = dv.getUint32(4, false);
    this.T0 = 8 + 8 * ntex;
    this.texData = [];
    for (let i = 0; i < ntex; i++) this.texData.push({ offset: this.T0 + dv.getUint32(8 + 8 * i, false), size: dv.getUint32(12 + 8 * i, false) });
    this.base = this.T0 + dv.getUint32(0, false);
    this.vbs = []; this.ibs = [];
    // chunks (offsets relative to the NU20 block, pointing at the chunk header like GSCScene.T)
    this.T = {};
    const end = this.base - this.i32(4);
    for (let p = 0x10; p + 8 <= end;) {
      const tag = String.fromCharCode(this.u8[this.base + p + 3], this.u8[this.base + p + 2], this.u8[this.base + p + 1], this.u8[this.base + p]);
      if (!TAGS.includes(tag)) { p++; continue; }
      if (!(tag in this.T)) this.T[tag] = p;
      p += this.u32(p + 4);
    }
    for (const t of ['DISP', 'MS00', 'TST0']) if (!(t in this.T)) throw new Error(`PS3 scene without ${t}`);
    this.readTextures();
    const D = this.T.DISP + 8, ncmd = this.u32(D + 4), cs = this.ptr(D + 8);
    // materials in index order = their (single) 0x80 command targets sorted by address
    const matAt = [...new Set(Array.from({ length: ncmd }, (_, k) => this.u8[this.base + cs + 8 * k] === 0x80 ? this.ptr(cs + 8 * k + 4) : null)
      .filter(x => x != null))].sort((a, b) => a - b);
    this.nmat = matAt.length;
    const matIndex = new Map(matAt.map((a, k) => [a, k]));
    this.materials = matAt.map(r => {
      const ti = this.i32(r + 0x25C);
      return { tex: ti >= 0 && ti < this.textures.length ? ti : -1, fmt: 0, color: [1, 1, 1], at: r };
    });
    // command stream
    this.draws = []; this.cmdTypes = {};
    const drawByCmd = new Map();
    let mat = -1, mtx = null, mtxAt = -1;
    for (let k = 0; k < ncmd; k++) {
      const a = cs + 8 * k, op = this.u8[this.base + a], t = (this.u8[this.base + a + 1] << 8) | op;
      this.cmdTypes[t] = (this.cmdTypes[t] || 0) + 1;
      const p = this.ptr(a + 4);
      if (op === 0x80 && p != null) mat = matIndex.get(p) ?? -1;
      else if (op === 0x83 && p != null) { mtx = this.mat(p); mtxAt = p; }
      else if (op === 0x82 && p != null) {
        const d = this.drawRecord(p, k, mat, mtx, mtx ? mtxAt : -1);
        if (d) { drawByCmd.set(k, d.id); this.draws.push(d); }
      }
    }
    // per-object table and instances: same layout as PC (see GSCScene)
    this.objects = [];
    const nObj = this.i32(D + 0x10), ot = this.ptr(D + 0x14);
    for (let o = 0; o < nObj; o++) {
      const e = ot + 12 * o, cnt = this.i32(e), ml = this.ptr(e + 4), cl = this.ptr(e + 8), draws = [];
      if (cl != null && cnt > 0 && cnt < 10000) for (let k = 0; k < cnt; k++) {
        const di = drawByCmd.get(this.i32(cl + 4 * k));
        if (di == null) continue;
        draws.push(di); this.draws[di].object = o;
        const mi = ml != null ? this.i32(ml + 4 * k) : -1;
        if (mi >= 0 && mi < this.nmat) this.draws[di].material = mi;
      }
      this.objects.push({ id: o, draws });
    }
    for (const d of this.draws) if (d.object < 0) { d.object = this.objects.length; this.objects.push({ id: d.object, draws: [d.id], loose: true }); }
    this.instances = [];
    const ni = this.i32(D + 0x6C), wi = this.ptr(D + 0x70);
    for (let i = 0; i < ni && wi != null; i++) {
      const r = wi + 208 * i, op = this.ptr(r + 0xB0), np = this.ptr(r + 0xB4);
      const object = op != null ? (op - ot) / 12 : -1;
      this.instances.push({ id: i, at: r, matrix: this.mat(r), matrix2: this.mat(r + 0x40), flags: this.u32(r + 0xB8),
        object: Number.isInteger(object) ? object : -1, name: np != null ? this.str(np) : '' });
    }
    for (const o of this.objects) o.instances = [];
    for (const ins of this.instances) this.objects[ins.object]?.instances.push(ins.id);
  }

  // NU20-relative big-endian helpers (same names as Container's)
  i32(a) { return this.dv.getInt32(this.base + a, false); }
  u32(a) { return this.dv.getUint32(this.base + a, false); }
  u16(a) { return this.dv.getUint16(this.base + a, false); }
  i16(a) { return this.dv.getInt16(this.base + a, false); }
  f32(a) { return this.dv.getFloat32(this.base + a, false); }
  byte(a) { return this.u8[this.base + a]; }
  ptr(a) { const v = this.i32(a); return v === 0 ? null : a + v; }
  str(a) { let e = this.base + a; while (this.u8[e]) e++; return new TextDecoder('latin1').decode(this.u8.subarray(this.base + a, e)); }
  mat(a) { const m = new Float64Array(16); for (let i = 0; i < 16; i++) m[i] = this.f32(a + 4 * i); return m; }

  // textures[] is indexed like the materials' texture field (TST0 record index); records without data have size 0
  readTextures() {
    const o = this.T.TST0, n = Math.floor((this.u32(o + 4) - 8) / 68);
    this.textures = [];
    for (let k = 0; k < n; k++) {
      const q = o + 8 + 68 * k, w = this.u32(q), h = this.u32(q + 4), f = this.byte(q + 0x20), ref = this.u32(q + 0x30);
      const src = ref & 0x80000000 ? this.texData[ref & 0x7FFFFFFF] : null;
      const ok = src && (f === 0x86 || f === 0x88);
      this.textures.push({ w, h, mips: 1, fmt: f === 0x86 ? 12 : 15, ps3fmt: f, offset: ok ? src.offset : 0, size: ok ? src.size : 0, cube: false });
    }
  }
  // A PC DDS file for texture t: header + the PS3 data as is. Mip chains that stop early (at 4x4/8x8) aren't
  // complete for WebGL, so those give just the top level.
  dds(t) {
    const bs = t.ps3fmt === 0x86 ? 8 : 16, lvl = (w, h) => Math.max(1, (w + 3) >> 2) * Math.max(1, (h + 3) >> 2) * bs;
    let n = 0, tot = 0, w = t.w, h = t.h, full = 0, fw = t.w, fh = t.h;
    while (tot < t.size) { tot += lvl(w, h); n++; w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); }
    for (;;) { full++; if (fw === 1 && fh === 1) break; fw = Math.max(1, fw >> 1); fh = Math.max(1, fh >> 1); }
    const mips = n === full && tot === t.size ? n : 1, size = mips === 1 ? lvl(t.w, t.h) : t.size;
    const out = new Uint8Array(128 + size), hv = new DataView(out.buffer);
    out.set([0x44, 0x44, 0x53, 0x20]);
    hv.setUint32(4, 124, true); hv.setUint32(8, 0x1 | 0x2 | 0x4 | 0x1000 | 0x80000 | (mips > 1 ? 0x20000 : 0), true);
    hv.setUint32(12, t.h, true); hv.setUint32(16, t.w, true); hv.setUint32(20, lvl(t.w, t.h), true); hv.setUint32(28, mips, true);
    hv.setUint32(76, 32, true); hv.setUint32(80, 0x4, true);
    out.set(t.ps3fmt === 0x86 ? [0x44, 0x58, 0x54, 0x31] : [0x44, 0x58, 0x54, 0x35], 84);
    hv.setUint32(108, 0x1000 | (mips > 1 ? 0x400008 : 0), true);
    out.set(this.u8.subarray(t.offset, t.offset + size), 128);
    return out.buffer;
  }

  drawRecord(r, cmd, material, matrix, matrixAt) {
    const streams = [];
    for (let s = 0; s < 8; s++) {
      const a = r + 4 + 8 * s, n = this.byte(a);
      if (!n) break;
      streams.push({ n, type: this.byte(a + 1), stride: this.byte(a + 2), offset: this.T0 + this.u32(a + 4) });
    }
    const cnt = this.u32(r + 0x8C), io = this.T0 + this.u32(r + 0x88);
    if (!streams.length || streams[0].type !== 2 || !cnt || cnt % 3 || io + 2 * cnt > this.base) return null;
    let lo = 65535, hi = 0;
    for (let i = 0; i < cnt; i++) { const v = this.dv.getUint16(io + 2 * i, false); if (v < lo) lo = v; if (v > hi) hi = v; }
    const count = hi - lo + 1;
    const uvS = streams.findLastIndex(s => s.type === 3);
    return { id: this.draws.length, cmd, cmdRec: r, material, matrix, matrixAt, streams, io, nidx: cnt,
      prims: cnt, stride: streams[0].stride, vb: streams[0].offset, base: lo, count, start: 0, object: -1,
      col: this.colourStream(streams, lo), uv: uvS };
  }
  // The vertex colour is a u8x4 stream after the position; a normal (when present) comes first and has w = 0.
  colourStream(streams, lo) {
    const u8s = [1, 2].filter(k => streams[k]?.type === 4 && streams[k].n === 4);
    for (const k of u8s) if (this.u8[streams[k].offset + streams[k].stride * lo + 3] !== 0) return k;
    return u8s.length ? u8s[u8s.length - 1] : -1;
  }
  vertexAt(d, s, i) { const st = d.streams[s]; return st.offset + st.stride * (d.base + i); }
  readPositions(d) {
    const P = new Float32Array(d.count * 3);
    for (let i = 0; i < d.count; i++) {
      const o = this.vertexAt(d, 0, i);
      P[i * 3] = this.dv.getFloat32(o, false); P[i * 3 + 1] = this.dv.getFloat32(o + 4, false); P[i * 3 + 2] = this.dv.getFloat32(o + 8, false);
    }
    return P;
  }
  // edits stay in memory (PS3 scenes are view-only: Save refuses them)
  writePositions(d, P) {
    for (let i = 0; i < d.count; i++) {
      const o = this.vertexAt(d, 0, i);
      this.dv.setFloat32(o, P[i * 3], false); this.dv.setFloat32(o + 4, P[i * 3 + 1], false); this.dv.setFloat32(o + 8, P[i * 3 + 2], false);
    }
  }
  writeMatrix(d, m) {
    for (let i = 0; i < 16; i++) this.dv.setFloat32(this.base + d.matrixAt + 4 * i, m[i], false);
    d.matrix = this.mat(d.matrixAt);
  }
  writeInstanceMatrix(ins, m, m2 = null) {
    for (let i = 0; i < 16; i++) this.dv.setFloat32(this.base + ins.at + 4 * i, m[i], false);
    ins.matrix = this.mat(ins.at);
    if (m2) { for (let i = 0; i < 16; i++) this.dv.setFloat32(this.base + ins.at + 0x40 + 4 * i, m2[i], false); ins.matrix2 = this.mat(ins.at + 0x40); }
  }
  drawGeometry(d) {
    const n = d.count, P = this.readPositions(d);
    if (d.matrix) transformPoints(P, d.matrix);
    const UV = new Float32Array(n * 2), C = new Float32Array(n * 3).fill(1);
    for (let i = 0; i < n; i++) {
      if (d.uv >= 0) {
        const o = this.vertexAt(d, d.uv, i);
        UV[i * 2] = halfToFloat(this.dv.getUint16(o, false)); UV[i * 2 + 1] = halfToFloat(this.dv.getUint16(o + 2, false));
      }
      if (d.col >= 0) { // RGBA, 0x7F = 1.0
        const o = this.vertexAt(d, d.col, i);
        C[i * 3] = Math.min(this.u8[o] / 127, 2); C[i * 3 + 1] = Math.min(this.u8[o + 1] / 127, 2); C[i * 3 + 2] = Math.min(this.u8[o + 2] / 127, 2);
      }
    }
    const tris = new Array(d.nidx);
    for (let i = 0; i < d.nidx; i++) tris[i] = this.dv.getUint16(d.io + 2 * i, false) - d.base;
    return { P, UV, C, tris };
  }
}

// Open a scene file of either platform.
export function openScene(buffer, GSCScene) {
  return isPS3Scene(buffer) ? new PS3Scene(buffer) : new GSCScene(buffer);
}
