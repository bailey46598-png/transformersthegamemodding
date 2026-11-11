// Binary readers for Transformers: The Game (PC, NU2 engine): .GHG models and .GSC level scenes.
// Ported from mods/ghg_tools (ghg_lib.py, ghg_scene.py) and mods/wii_tools/pcgsc_check.py.
// Format notes: GHG_FORMAT.md and PC_GSC_FORMAT.md in the game folder.

const TAGS = ['HEAD', 'NTBL', 'MS00', 'SST0', 'INID', 'FDNS', 'BNDS', 'CDAT', 'DISP', 'TAS0', 'PORT',
  'TREF', 'TST0', 'VBIB', 'SALI', 'DNO2', 'GSNH', 'PNTR'];

// ---------------------------------------------------------------- container (shared by GHG and GSC)
export class Container {
  constructor(buffer) {
    this.buf = buffer;
    this.u8 = new Uint8Array(buffer);
    const dv = this.dv = new DataView(buffer);
    this.modelOffset = dv.getUint32(0, true);
    this.slotCount = dv.getUint16(4, true);
    let o = 6;
    this.textures = [];
    for (;;) {
      const w = dv.getInt32(o, true), h = dv.getInt32(o + 4, true), mips = dv.getInt32(o + 8, true);
      const fmt = dv.getInt32(o + 12, true), z = dv.getInt32(o + 16, true), size = dv.getUint32(o + 20, true);
      const isDDS = this.u8[o + 24] === 0x44 && this.u8[o + 25] === 0x44 && this.u8[o + 26] === 0x53 && this.u8[o + 27] === 0x20;
      const empty = size === 0 && z === 0 && ((w > 0 && w <= 4096) || (w < 0 && w >= -4096)) && h > 0 && h <= 4096;
      if (!(isDDS || empty)) break;
      this.textures.push({ w, h, mips, fmt, offset: o + 24, size, cube: w < 0 });
      o += 24 + size;
    }
    this.vbs = []; this.ibs = [];
    let n = dv.getUint16(o, true); o += 2;
    for (let i = 0; i < n; i++) { const s = dv.getUint32(o, true); this.vbs.push({ offset: o + 4, size: s }); o += 4 + s; }
    n = dv.getUint16(o, true); o += 2;
    for (let i = 0; i < n; i++) { const s = dv.getUint32(o, true); this.ibs.push({ offset: o + 4, size: s }); o += 4 + s; }
    this.base = this.modelOffset + 4;
    if (String.fromCharCode(...this.u8.subarray(this.base, this.base + 4)) !== 'NU20') throw new Error('No NU20 block at modelOffset+4');
    this.findChunks();
  }

  findChunks() {
    // Walk the chunk chain; fall back to scanning for tags nested inside other chunks (GHG: DISP sits in CDAT).
    const T = this.T = {};
    const u8 = this.u8, B = this.base, end = this.buf.byteLength;
    let p = B + 0x10;
    while (p + 8 <= end) {
      const tag = String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
      const size = this.dv.getUint32(p + 4, true);
      if (!TAGS.includes(tag) || size < 8) break;
      if (!(tag in T)) T[tag] = p - B;
      p += size;
    }
    const want = TAGS.filter(t => !(t in T));
    if (want.length) {
      const codes = want.map(t => [...t].map(c => c.charCodeAt(0)));
      for (let a = B; a + 4 <= end && codes.length; a += 4) {
        for (let k = 0; k < codes.length; k++) {
          const c = codes[k];
          if (u8[a] === c[0] && u8[a + 1] === c[1] && u8[a + 2] === c[2] && u8[a + 3] === c[3]) {
            T[want[k]] = a - B; codes.splice(k, 1); want.splice(k, 1); break;
          }
        }
      }
    }
  }

  // NU20-relative helpers
  i32(a) { return this.dv.getInt32(this.base + a, true); }
  u32(a) { return this.dv.getUint32(this.base + a, true); }
  u16(a) { return this.dv.getUint16(this.base + a, true); }
  f32(a) { return this.dv.getFloat32(this.base + a, true); }
  byte(a) { return this.u8[this.base + a]; }
  ptr(a) { const v = this.i32(a); return v === 0 ? null : a + v; }
  str(a) { let e = this.base + a; while (this.u8[e]) e++; return new TextDecoder('latin1').decode(this.u8.subarray(this.base + a, e)); }
  mat(a) { const m = new Float64Array(16); for (let i = 0; i < 16; i++) m[i] = this.f32(a + 4 * i); return m; }

  dds(t) { return this.buf.slice(t.offset, t.offset + t.size); }
  ib(i) { const b = this.ibs[i]; return new Uint16Array(this.buf, b.offset, b.size >> 1); }
}

// ---------------------------------------------------------------- row-vector 4x4 matrix helpers (D3D style)
// Matrices are Float64Array(16), row-major, translation in the last row: world = local x parentWorld.
export const M4 = {
  mul(a, b, o = new Float64Array(16)) {
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
      o[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + a[r * 4 + 3] * b[12 + c];
    }
    return o;
  },
  identity() { const m = new Float64Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; },
  // local matrix from animation channels: translation, rotation (radians, Z*Y*X as stored), scale
  compose(t, r, s, o = new Float64Array(16)) {
    const cx = Math.cos(r[0]), sx = Math.sin(r[0]), cy = Math.cos(r[1]), sy = Math.sin(r[1]), cz = Math.cos(r[2]), sz = Math.sin(r[2]);
    // D3D convention: row-form local = Rx * Ry * Rz (X applied first), i.e. the transpose of the column-vector
    // product Rz*Ry*Rx built below. Verified: with it, planted feet stay put through the idle clips of
    // Bumblebee, Megatron and Jazz (drift ~0.002 units) and the toes rest at the bind height.
    const R = [
      cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
      sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
      -sy, cy * sx, cy * cx];
    for (let i = 0; i < 3; i++) {
      o[i * 4] = R[i] * s[i]; o[i * 4 + 1] = R[3 + i] * s[i]; o[i * 4 + 2] = R[6 + i] * s[i]; o[i * 4 + 3] = 0;
    }
    o[12] = t[0]; o[13] = t[1]; o[14] = t[2]; o[15] = 1;
    return o;
  },
  invert3x4(m) { // inverse of an affine row-form matrix
    const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], i = m[10];
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C || 1e-12;
    const o = new Float64Array(16);
    o[0] = A / det; o[1] = -(b * i - c * h) / det; o[2] = (b * f - c * e) / det;
    o[4] = B / det; o[5] = (a * i - c * g) / det; o[6] = -(a * f - c * d) / det;
    o[8] = C / det; o[9] = -(a * h - b * g) / det; o[10] = (a * e - b * d) / det;
    const tx = m[12], ty = m[13], tz = m[14];
    o[12] = -(tx * o[0] + ty * o[4] + tz * o[8]);
    o[13] = -(tx * o[1] + ty * o[5] + tz * o[9]);
    o[14] = -(tx * o[2] + ty * o[6] + tz * o[10]);
    o[15] = 1;
    return o;
  },
};

// ---------------------------------------------------------------- vertex layouts
// GHG: by stride. GSC: from the material's vertex-format bits (+0x1F0), falling back to stride.
export function layoutForStride(stride) {
  if (stride >= 28) return { pos: 0, nrm: 12, col: 16, uv: 20, wts: stride >= 36 ? 28 : -1, idx: stride >= 36 ? 32 : -1 };
  if (stride === 24) return { pos: 0, nrm: -1, col: 12, uv: 16, wts: -1, idx: -1 };
  if (stride === 20) return { pos: 0, nrm: -1, col: 12, uv: -1, wts: -1, idx: -1 };
  return { pos: 0, nrm: -1, col: -1, uv: -1, wts: -1, idx: -1 };
}
export function layoutForFormat(fmt, stride) {
  const L = { pos: -1, nrm: -1, col: -1, uv: -1, wts: -1, idx: -1 };
  let o = 0;
  const parts = [[0x01, 'pos', 12], [0x08, 'nrm', 4], [0x100, 'col', 4], [0x200, null, 4], [0x400, null, 4], [0x800, 'uv', 8], [0x1000, 'uv2', 16]];
  for (const [bit, name, size] of parts) {
    if (fmt & bit) { if (name === 'uv2') { if (L.uv < 0) L.uv = o; } else if (name) L[name] = o; o += size; }
  }
  if (o !== stride || L.pos !== 0) return layoutForStride(stride);
  return L;
}

// Expand one draw record's triangle strip (u16 indices relative to the base vertex) into a triangle list.
export function stripToTriangles(ib, start, prims, vcount) {
  const out = [];
  for (let j = 0; j < prims; j++) {
    let a = ib[start + j], b = ib[start + j + 1]; const c = ib[start + j + 2];
    if (a === b || b === c || a === c || a >= vcount || b >= vcount || c >= vcount) continue;
    if (j & 1) { const t = a; a = b; b = t; }
    out.push(a, b, c);
  }
  return out;
}

// ---------------------------------------------------------------- GHG model
export class GHGModel extends Container {
  constructor(buffer) {
    super(buffer);
    const C = this.T.CDAT, D = this.T.DISP, G = this.T.GSNH;
    if (C == null || D == null || G == null) throw new Error('Missing CDAT/DISP/GSNH chunk');
    let sk = null;
    for (let a = G; a < G + this.i32(G + 4) - 16; a += 4) {
      const n = this.i32(a);
      if (n > 0 && n < 256 && this.ptr(a + 4) === C + 0x10) { sk = a; break; }
    }
    if (sk == null) throw new Error('Skeleton header not found');
    const nb = this.i32(sk);
    this.bones = [];
    for (let b = 0; b < nb; b++) {
      const r = C + 8 + b * 0x60;
      const p = this.byte(r + 0x58);
      this.bones.push({ index: b, name: this.str(this.ptr(r + 0x54)), parent: p === 0xFF ? -1 : p });
    }
    const mats = C + 8 + nb * 0x60 + 8;
    this.local = []; this.invBind = []; this.world = [];
    for (let b = 0; b < nb; b++) {
      this.local.push(this.mat(mats + b * 64));
      this.invBind.push(this.mat(mats + (nb + b) * 64));
    }
    for (let b = 0; b < nb; b++) {
      const p = this.bones[b].parent;
      this.world.push(p < 0 ? this.local[b] : M4.mul(this.local[b], this.world[p]));
    }
    // layers -> rigid bone lists and skin refs -> instance -> object -> draw records
    const cmd = this.ptr(D + 0x10);
    const nl = this.i32(sk + 0x28), lt = this.ptr(sk + 0x2C);
    this.layers = []; this.parts = [];
    const seen = new Set();
    const addInstance = (ref, bone, layer) => {
      const inst = this.ptr(ref + 8);
      if (inst == null || seen.has(inst)) return;
      seen.add(inst);
      const obj = this.ptr(inst + 0xB0);
      const cnt = this.i32(obj), mp = this.ptr(obj + 4), ip = this.ptr(obj + 8);
      for (let k = 0; k < cnt; k++) {
        const e = this.i32(ip + 4 * k);
        if (this.i32(cmd + 16 * e) !== 130) continue;
        const rec = this.ptr(cmd + 16 * e + 4);
        const pal = [];
        for (let i = 0; i < 8; i++) { const x = this.byte(rec + 8 + i); if (x !== 0xFF) pal.push(x); }
        const ibi = this.u32(rec + 0x1C);
        this.parts.push({
          layer, bone, material: mp ? this.i32(mp + 4 * k) : -1,
          prims: this.u16(rec + 4), stride: this.u16(rec + 6), palette: pal,
          base: this.u32(rec + 0x10), count: this.u32(rec + 0x14), start: this.u32(rec + 0x18),
          ib: ibi < this.ibs.length ? ibi : 0, vb: this.i32(rec + 0x24),
        });
      }
    };
    for (let s = 0; s < Math.max(nl, 0); s++) {
      const r = lt + 20 * s;
      const nm = this.ptr(r);
      const name = nm ? this.str(nm) : `layer${s}`;
      this.layers.push(name);
      const bl = this.ptr(r + 4), skin = this.ptr(r + 8);
      if (bl) for (let b = 0; b < nb; b++) { const ref = this.ptr(bl + 4 * b); if (ref) addInstance(ref, b, s); }
      if (skin) addInstance(skin, -1, s);
    }
    this.readMaterials();
  }

  readMaterials() {
    const M = this.T.MS00, T = this.T.TST0;
    const cnt = this.i32(M + 8);
    this.materials = [];
    for (let m = 0; m < cnt; m++) {
      const v = this.i32(M + 12 + 628 * m + 120);
      this.materials.push(v < 0 || (v & 0xFFFF) === 0xFFFF ? null : { slot: v & 0x3FFF, fromParent: !!(v & 0x4000) });
    }
    this.slots = [];
    if (T != null) {
      const base = T + 8 + 4 * this.slotCount;
      let ti = 0;
      for (let k = 0; k < this.slotCount; k++) {
        const r = base + 0x28 * k;
        const w = this.i32(r), h = this.i32(r + 4);
        const filled = !(w === 0 && h === 0);
        const tex = filled && ti < this.textures.length ? ti : null;
        let hash = '';
        for (let i = 8; i < 24; i++) hash += this.byte(r + i).toString(16).padStart(2, '0');
        this.slots.push({ w, h, tex, hash, borrowed: tex != null && this.textures[tex].size === 0 });
        if (filled) ti++;
      }
    }
  }

  // Raw per-part vertex data in the space the file stores it (rigid: bone bind space; skinned: model space).
  partGeometry(part) {
    const vb = this.vbs[part.vb];
    if (!vb) return null;
    const L = layoutForStride(part.stride);
    const n = part.count, dv = this.dv, s = part.stride;
    if ((part.base + n) * s > vb.size) return null;
    const P = new Float32Array(n * 3), N = new Float32Array(n * 3), UV = new Float32Array(n * 2);
    const W = part.palette.length && L.wts >= 0 ? new Float32Array(n * 3) : null;
    const J = W ? new Uint8Array(n * 3) : null;
    for (let i = 0; i < n; i++) {
      const o = vb.offset + (part.base + i) * s;
      P[i * 3] = dv.getFloat32(o, true); P[i * 3 + 1] = dv.getFloat32(o + 4, true); P[i * 3 + 2] = dv.getFloat32(o + 8, true);
      if (L.nrm >= 0) for (let k = 0; k < 3; k++) N[i * 3 + k] = (this.u8[o + L.nrm + k] - 128) / 127;
      if (L.uv >= 0) { UV[i * 2] = dv.getFloat32(o + L.uv, true); UV[i * 2 + 1] = dv.getFloat32(o + L.uv + 4, true); }
      if (W) {
        let sum = 0;
        for (let k = 0; k < 3; k++) {
          const w = this.u8[o + L.wts + k] / 255, j = this.u8[o + L.idx + k];
          const ok = w > 0 && j < part.palette.length;
          W[i * 3 + k] = ok ? w : 0; J[i * 3 + k] = ok ? part.palette[j] : 0; sum += ok ? w : 0;
        }
        if (sum <= 0) { W[i * 3] = 1; J[i * 3] = part.palette[0]; }
        else for (let k = 0; k < 3; k++) W[i * 3 + k] /= sum;
      }
    }
    const tris = stripToTriangles(this.ib(part.ib), part.start, part.prims, n);
    let rigidBone = -1;
    if (!W) rigidBone = part.bone >= 0 && !part.palette.length ? part.bone : (part.palette[0] ?? Math.max(part.bone, 0));
    // Only a bone-list part without a palette is stored in bone space; any other unweighted part is in model
    // space (as ghg_scene.mesh() treats it), so convert it to its bone's bind space.
    if (!W && !(part.bone >= 0 && !part.palette.length)) {
      const ib = this.invBind[rigidBone];
      for (let i = 0; i < n; i++) {
        const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
        P[i * 3] = x * ib[0] + y * ib[4] + z * ib[8] + ib[12];
        P[i * 3 + 1] = x * ib[1] + y * ib[5] + z * ib[9] + ib[13];
        P[i * 3 + 2] = x * ib[2] + y * ib[6] + z * ib[10] + ib[14];
      }
    }
    return { P, N, UV, W, J, tris: new Uint32Array(tris), rigidBone };
  }

  textureForMaterial(m) {
    const mt = this.materials[m];
    if (!mt) return { kind: 'none' };
    const s = this.slots[mt.slot];
    // Borrowed slots hold the parent texture's hash and size but no pixels; the parent model has the DDS.
    if (mt.fromParent || s?.borrowed) return { kind: 'parent', slot: mt.slot, hash: s?.hash };
    if (!s || s.tex == null) return { kind: 'missing', slot: mt.slot };
    return { kind: 'own', tex: s.tex };
  }
}

// ---------------------------------------------------------------- GSC level scene
export class GSCScene extends Container {
  constructor(buffer) {
    super(buffer);
    const D = this.T.DISP + 8, M = this.T.MS00;
    this.ms0 = M + 0x10;
    this.nmat = this.u32(M + 8);
    this.materials = [];
    for (let k = 0; k < this.nmat; k++) {
      const r = this.ms0 + 628 * k;
      this.materials.push({
        tex: this.i32(r + 0xB8), fmt: this.u32(r + 0x1F0),
        color: [this.f32(r + 0x54), this.f32(r + 0x58), this.f32(r + 0x5C)],
      });
    }
    const ncmd = this.i32(D + 4), a = this.ptr(D + 8);
    this.draws = []; this.cmdTypes = {};
    const drawByCmd = new Map();
    let mat = -1, mtx = null, mtxAt = -1;
    for (let k = 0; k < ncmd; k++) {
      const t = this.i32(a + 16 * k);
      this.cmdTypes[t] = (this.cmdTypes[t] || 0) + 1;
      const p = this.ptr(a + 16 * k + 4);
      if (t === 896 && p != null) { const q = (p - this.ms0) / 628; mat = Number.isInteger(q) && q >= 0 && q < this.nmat ? q : -1; }
      else if (t === 131 && p != null) { mtx = this.mat(p); mtxAt = p; }
      else if (t === 130 && p != null) {
        const r = p;
        const d = {
          id: this.draws.length, cmd: k, cmdRec: r, material: mat, matrix: mtx, matrixAt: mtx ? mtxAt : -1,
          prims: this.u16(r + 4), stride: this.u16(r + 6),
          base: this.u32(r + 0x10), count: this.u32(r + 0x14), start: this.u32(r + 0x18), vb: this.u32(r + 0x24),
          object: -1,
        };
        if (d.vb < this.vbs.length && (d.base + d.count) * d.stride <= this.vbs[d.vb].size) {
          drawByCmd.set(k, d.id); this.draws.push(d);
        }
      }
    }
    // Per-object table (DISP+0x14): {count, -> material index list, -> command index list}, nObj entries.
    this.objects = [];
    try {
      const nObj = this.i32(D + 0x10), ot = this.ptr(D + 0x14);
      for (let o = 0; o < nObj; o++) {
        const e = ot + 12 * o, cnt = this.i32(e), ml = this.ptr(e + 4), cl = this.ptr(e + 8);
        const draws = [];
        if (cl != null && cnt > 0 && cnt < 10000) for (let k = 0; k < cnt; k++) {
          const di = drawByCmd.get(this.i32(cl + 4 * k));
          if (di == null) continue;
          draws.push(di); this.draws[di].object = o;
          // The object's material list is authoritative: the "current material" from walking the stream is wrong
          // for ~40% of CITY's draws (they come after the last 0x380 command).
          const mi = ml != null ? this.i32(ml + 4 * k) : -1;
          if (mi >= 0 && mi < this.nmat) this.draws[di].material = mi;
        }
        this.objects.push({ id: o, draws });
      }
    } catch (e) { console.warn('object table', e); }
    for (const d of this.draws) if (d.object < 0) { d.object = this.objects.length; this.objects.push({ id: d.object, draws: [d.id], loose: true }); }
    // Scene instances (DISP+0x6C count, +0x70 -> 208-byte records): own world matrix at +0 (separate from the
    // draw matrices), +0xB0 -> object table entry, +0xB4 -> name. Physics bodies in DNO2 link to these.
    this.instances = [];
    try {
      const ni = this.i32(D + 0x6C), wi = this.ptr(D + 0x70), ot = this.ptr(D + 0x14);
      for (let i = 0; i < ni && wi != null; i++) {
        const r = wi + 208 * i, op = this.ptr(r + 0xB0), np = this.ptr(r + 0xB4);
        const object = op != null ? (op - ot) / 12 : -1;
        this.instances.push({ id: i, at: r, matrix: this.mat(r), matrix2: this.mat(r + 0x40), flags: this.u32(r + 0xB8),
          object: Number.isInteger(object) ? object : -1, name: np != null ? this.str(np) : '' });
      }
      for (const o of this.objects) o.instances = [];
      for (const ins of this.instances) this.objects[ins.object]?.instances.push(ins.id);
    } catch (e) { console.warn('instances', e); }
  }
  // +00 is the instance's world matrix; +40 is normally the same matrix (1,987 of 2,228 in Tranquility)
  writeInstanceMatrix(ins, m, m2 = null) {
    for (let i = 0; i < 16; i++) this.dv.setFloat32(this.base + ins.at + 4 * i, m[i], true);
    ins.matrix = this.mat(ins.at);
    if (m2) { for (let i = 0; i < 16; i++) this.dv.setFloat32(this.base + ins.at + 0x40 + 4 * i, m2[i], true); ins.matrix2 = this.mat(ins.at + 0x40); }
  }

  layout(d) {
    const m = this.materials[d.material];
    return m ? layoutForFormat(m.fmt, d.stride) : layoutForStride(d.stride);
  }
  vertexOffset(d, i) { return this.vbs[d.vb].offset + (d.base + i) * d.stride; }
  readPositions(d) { // local (pre-matrix) positions
    const P = new Float32Array(d.count * 3);
    for (let i = 0; i < d.count; i++) {
      const o = this.vertexOffset(d, i);
      P[i * 3] = this.dv.getFloat32(o, true); P[i * 3 + 1] = this.dv.getFloat32(o + 4, true); P[i * 3 + 2] = this.dv.getFloat32(o + 8, true);
    }
    return P;
  }
  writePositions(d, P) {
    for (let i = 0; i < d.count; i++) {
      const o = this.vertexOffset(d, i);
      this.dv.setFloat32(o, P[i * 3], true); this.dv.setFloat32(o + 4, P[i * 3 + 1], true); this.dv.setFloat32(o + 8, P[i * 3 + 2], true);
    }
  }
  writeMatrix(d, m) { // every draw in the shipped levels has its own matrix (none shared), so this moves one instance
    for (let i = 0; i < 16; i++) this.dv.setFloat32(this.base + d.matrixAt + 4 * i, m[i], true);
    d.matrix = this.mat(d.matrixAt);
  }
  drawGeometry(d) {
    const L = this.layout(d), n = d.count;
    const P = this.readPositions(d);
    if (d.matrix) transformPoints(P, d.matrix);
    const UV = new Float32Array(n * 2), C = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const o = this.vertexOffset(d, i);
      if (L.uv >= 0) { UV[i * 2] = this.dv.getFloat32(o + L.uv, true); UV[i * 2 + 1] = this.dv.getFloat32(o + L.uv + 4, true); }
      if (L.col >= 0) { // stored BGRA, 0x7F = 1.0
        C[i * 3] = Math.min(this.u8[o + L.col + 2] / 127, 2); C[i * 3 + 1] = Math.min(this.u8[o + L.col + 1] / 127, 2); C[i * 3 + 2] = Math.min(this.u8[o + L.col] / 127, 2);
      } else { C[i * 3] = C[i * 3 + 1] = C[i * 3 + 2] = 1; }
    }
    const tris = stripToTriangles(this.ib(0), d.start, d.prims, n);
    return { P, UV, C, tris };
  }
}

export function transformPoints(P, m) {
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i], y = P[i + 1], z = P[i + 2];
    P[i] = x * m[0] + y * m[4] + z * m[8] + m[12];
    P[i + 1] = x * m[1] + y * m[5] + z * m[9] + m[13];
    P[i + 2] = x * m[2] + y * m[6] + z * m[10] + m[14];
  }
  return P;
}
