// Structural scene edits on a GSCFile: add copies of existing scene objects.
//
// A copy is a new scene object (no scene instance) whose draws reuse the source draws' records (and so their
// vertex and index data) with their own matrix. Layout facts (PC_GSC_FORMAT.md, "Adding objects"; checked on every stock PC level):
//  - Command stream (DISP+08, 16 B per command, count at +04): material blocks
//    [0x185 skip -> next block][0x87][0x87][0x380 material][0x18B] then draw pairs [0x83 -> matrix][0x82 -> draw record].
//    A copy's pair goes right after the source's 0x82, in the same block, so it renders with the same state.
//    Only the per-object command-index lists (+20) store command numbers; they are remapped.
//  - Draw records (100 B) are shared between draws; the loader fills in their VB pointer. Matrices are 64 B
//    row-form, the last thing in DISP.
//  - Objects: "all" count at +10 (tables +14 {count, ->+24 materials, ->+20 commands} 12 B, +18 u16 draw count,
//    +1C u16 list start, +28 u32 runtime, +2C f32 draw distance, bitsets +30/+34 of 2*align8(ceil(n/8)) bytes),
//    "culled" count at +38/+3C/+84 plus INID, BNDS, GSNH+58/F0/F4 (+48 flags u8, FDNS 8 B, BNDS 32 B, +88 bitmask
//    of objects with an instance, INID u16 order list). Objects past the culled count (CITY, AIRBASE) have no
//    bounds, so a new object is inserted at index = culled count and later objects move up by one
//    (instance +C0 holds the object index).
import { M4, transformPoints } from './formats.js';

const DISP_HDR = { ncmd: 0x04, cmd: 0x08, fdns: 0x0C, nall: 0x10, obj: 0x14, cnt: 0x18, start: 0x1C, cmdList: 0x20, matList: 0x24,
  rt28: 0x28, dist: 0x2C, bits30: 0x30, bits34: 0x34, nvis1: 0x38, nvis2: 0x3C, flags: 0x48, ninst: 0x6C, inst: 0x70, nvis3: 0x84, mask: 0x88 };

class Body { // little helper over one chunk body of a GSCFile (re-fetches after inserts)
  constructor(F, tag) { this.F = F; this.tag = tag; }
  get b() { return this.F.body(this.tag); }
  dv() { const b = this.b; return new DataView(b.buffer, b.byteOffset, b.length); }
  u32(o) { return this.dv().getUint32(o, true); }
  i32(o) { return this.dv().getInt32(o, true); }
  u16(o) { return this.dv().getUint16(o, true); }
  setU32(o, v) { this.dv().setUint32(o, v >>> 0, true); }
  setU16(o, v) { this.dv().setUint16(o, v, true); }
  ptr(o) { const p = this.F.getPointer(this.tag, o); if (!p || p.raw != null) throw new Error(`${this.tag}+0x${o.toString(16)} is not a pointer`); return p.off; }
  bytes(o, n) { return this.b.slice(o, o + n); }
}

// Insert `count` entries of `size` bytes at entry `index` of a table holding `len` entries, then pad after the
// table's last entry so everything behind it moves by a multiple of 16 (keeps alignment).
function insertEntries(F, tag, tableOff, size, index, len, data) {
  const n = data.length;
  F.insert(tag, tableOff + size * index, data);
  const pad = (16 - n % 16) % 16;
  if (pad) F.insert(tag, tableOff + size * (len + n / size), new Uint8Array(pad));
}

// bytes until the next pointer target in the chunk (= the table's allocated size)
function regionSize(F, tag, off) {
  const c = F.chunkIndex(tag);
  let next = F.chunks[c].body.length;
  for (const fl of F.fields) if (fl.target && fl.target.c === c && fl.target.off > off && fl.target.off < next) next = fl.target.off;
  return next - off;
}
const bitsetBytes = n => 2 * (Math.ceil(Math.ceil(n / 8) / 8) * 8);

// BNDS record (world space): centre xyz, radius (= length of the half extents), half extents xyz, 1.
// Checked against the drawn geometry of stock objects.
function boundsRecord(S, draws) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const x of draws) {
    const P = transformPoints(S.readPositions(x.sd), x.world);
    for (let i = 0; i < P.length; i += 3) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], P[i + a]); mx[a] = Math.max(mx[a], P[i + a]); }
  }
  const rec = new Uint8Array(32), dv = new DataView(rec.buffer);
  const e = [0, 1, 2].map(a => (mx[a] - mn[a]) / 2);
  for (let a = 0; a < 3; a++) { dv.setFloat32(4 * a, (mn[a] + mx[a]) / 2, true); dv.setFloat32(16 + 4 * a, e[a], true); }
  dv.setFloat32(12, Math.hypot(...e), true); dv.setFloat32(28, 1, true);
  return rec;
}

// copies: [{ src: object index in S, T: row-form 4x4 (source placement at load -> copy placement), baseMats: Map draw id -> matrix }]
// S = GSCScene of the same buffer F was made from. Returns { objects: [new indices], draws }.
export function addObjectCopies(F, S, copies) {
  if (!copies.length) return { objects: [], draws: 0 };
  const DB = S.T.DISP + 8, off = a => a - DB; // NU20 address -> DISP body offset (F matches S's layout)
  const d = new Body(F, 'DISP');
  const H = DISP_HDR;
  const A = d.i32(H.nall), V = d.i32(H.nvis1), ninst = d.i32(H.ninst);
  if (d.i32(H.nvis2) !== V || d.i32(H.nvis3) !== V) throw new Error('object counts disagree; not a stock layout');
  const k = copies.length;
  const ncmd0 = d.i32(H.ncmd);

  // ---- per-draw plan
  const draws = []; // { copy, srcDraw, insertAt (old command index), material }
  copies.forEach((cp, ci) => {
    const o = S.objects[cp.src];
    if (!o || o.loose) throw new Error(`object ${cp.src} is not in the object table`);
    for (const di of o.draws) {
      const sd = S.draws[di];
      if (sd.matrixAt < 0) throw new Error(`object ${cp.src} has a draw without a matrix`);
      draws.push({ ci, sd, insertAt: sd.cmd + 1, material: sd.material, world: M4.mul(cp.baseMats?.get(di) || sd.matrix, cp.T) });
    }
  });
  if (!draws.length) throw new Error('nothing to copy');

  // ---- 1. command pairs (insert from the back so old indices stay valid)
  const cmdOff = d.ptr(H.cmd);
  const pair = new Uint8Array(32); new DataView(pair.buffer).setInt32(0, 0x83, true); new DataView(pair.buffer).setInt32(16, 0x82, true);
  const order = draws.map((x, i) => i).sort((a, b) => draws[b].insertAt - draws[a].insertAt);
  for (const i of order) F.insert('DISP', cmdOff + 16 * draws[i].insertAt, pair);
  const pos = draws.map(x => x.insertAt).sort((a, b) => a - b);
  const shiftOf = c => { let lo = 0, hi = pos.length; while (lo < hi) { const m = (lo + hi) >> 1; if (pos[m] <= c) lo = m + 1; else hi = m; } return 2 * lo; };
  // final index of each new pair: its insert position + 2 per pair inserted before (ties keep draw order)
  const asc = draws.map((x, i) => i).sort((a, b) => draws[a].insertAt - draws[b].insertAt || a - b);
  asc.forEach((i, j) => { draws[i].newCmd = draws[i].insertAt + 2 * j; });
  d.setU32(H.ncmd, ncmd0 + 2 * draws.length);

  // ---- 2. remap the command-index list (+20); its length is the sum of object draw counts
  const objTab = () => d.ptr(H.obj);
  let L = 0;
  for (let o = 0; o < A; o++) L += d.u32(objTab() + 12 * o);
  { const cl = d.ptr(H.cmdList), dv = d.dv(); for (let i = 0; i < L; i++) dv.setUint32(cl + 4 * i, dv.getUint32(cl + 4 * i, true) + shiftOf(dv.getUint32(cl + 4 * i, true)), true); }

  // ---- 3. new matrices; the copy's 0x82 points at the SOURCE's draw record
  // Draw records are shared between draws in stock files (Cybertron: 561 draws, 253 records). The loader turns
  // each record's VB index (+24) into a D3D vertex buffer pointer, but only for records it finds itself: a copied
  // record kept its raw index and crashed SetStreamSource (lab test 4). Sharing the source's record avoids that.
  // Matrices are the last thing in DISP in stock files, so new ones go right after them with no gap.
  let matEnd = -1; // end of the last stock matrix, as a current DISP offset
  { const c = F.chunkIndex('DISP'); let best = -1;
    for (const fl of F.fields) if (fl.c === c && fl.target && fl.target.c === c && fl.off >= d.ptr(H.cmd) && fl.off < d.ptr(H.cmd) + 16 * d.i32(H.ncmd)
      && (fl.off - d.ptr(H.cmd)) % 16 === 4 && d.i32(fl.off - 4) === 0x83) best = Math.max(best, fl.target.off);
    matEnd = best + 64; }
  for (const x of draws) {
    const m = x.world, mb = new Uint8Array(64), mdv = new DataView(mb.buffer);
    for (let i = 0; i < 16; i++) mdv.setFloat32(4 * i, m[i], true);
    let mat;
    if (matEnd > 0 && matEnd <= d.b.length) { F.insert('DISP', matEnd, mb); mat = matEnd; matEnd += 64; } else mat = F.append('DISP', mb, 4);
    const cmds = d.ptr(H.cmd), c0 = cmds + 16 * x.newCmd;
    const src = F.getPointer('DISP', cmds + 16 * (x.sd.cmd + shiftOf(x.sd.cmd)) + 4);
    if (!src || src.tag !== 'DISP') throw new Error('source draw command has no record');
    F.setPointer('DISP', c0 + 4, 'DISP', mat);
    F.setPointer('DISP', c0 + 16 + 4, 'DISP', src.off);
  }

  // ---- 4. append the new objects' entries to the +20 / +24 lists
  const perCopy = copies.map((_, ci) => draws.filter(x => x.ci === ci));
  const cmdVals = new Uint8Array(4 * draws.length), matVals = new Uint8Array(4 * draws.length);
  { const cv = new DataView(cmdVals.buffer), mv = new DataView(matVals.buffer); let j = 0;
    for (const list of perCopy) for (const x of list) { cv.setUint32(4 * j, x.newCmd + 1, true); mv.setUint32(4 * j, x.material, true); j++; } } // the 0x82 of the pair
  insertEntries(F, 'DISP', d.ptr(H.cmdList), 4, L, L, cmdVals);
  insertEntries(F, 'DISP', d.ptr(H.matList), 4, L, L, matVals);
  if (L + draws.length > 65535) throw new Error('too many draws for the u16 list starts');

  // ---- 5. "all objects" tables: insert at index V
  const srcRow = (tableOff, size, o) => d.bytes(tableOff + size * o, size);
  {
    const t = new Uint8Array(12 * k);
    insertEntries(F, 'DISP', objTab(), 12, V, A, t);
    let start = L;
    perCopy.forEach((list, ci) => {
      const e = objTab() + 12 * (V + ci);
      d.setU32(e, list.length);
      F.setPointer('DISP', e + 4, 'DISP', d.ptr(H.matList) + 4 * start);
      F.setPointer('DISP', e + 8, 'DISP', d.ptr(H.cmdList) + 4 * start);
      start += list.length;
    });
  }
  {
    const cnt = new Uint8Array(2 * k), st = new Uint8Array(2 * k), cdv = new DataView(cnt.buffer), sdv = new DataView(st.buffer);
    let start = L;
    perCopy.forEach((list, ci) => { cdv.setUint16(2 * ci, list.length, true); sdv.setUint16(2 * ci, start, true); start += list.length; });
    insertEntries(F, 'DISP', d.ptr(H.cnt), 2, V, A, cnt);
    insertEntries(F, 'DISP', d.ptr(H.start), 2, V, A, st);
  }
  insertEntries(F, 'DISP', d.ptr(H.rt28), 4, V, A, new Uint8Array(4 * k));
  {
    const dist = new Uint8Array(4 * k);
    copies.forEach((cp, ci) => dist.set(srcRow(d.ptr(H.dist), 4, cp.src), 4 * ci));
    insertEntries(F, 'DISP', d.ptr(H.dist), 4, V, A, dist);
  }
  for (const h of [H.bits30, H.bits34]) { // runtime bitsets: grow if needed
    const o = d.ptr(h), need = bitsetBytes(A + k), have = regionSize(F, 'DISP', o);
    if (need > have) F.insert('DISP', o + have, new Uint8Array(Math.ceil((need - have) / 16) * 16));
  }

  // ---- 6. "culled objects" tables: append at index V
  {
    const fl = new Uint8Array(k);
    copies.forEach((cp, ci) => { fl[ci] = cp.src < V ? d.b[d.ptr(H.flags) + cp.src] : 4; });
    insertEntries(F, 'DISP', d.ptr(H.flags), 1, V, V, fl);
  }
  { // instance bitmask: one bit per culled object; the copies have no instance, so their bits are 0
    const o = d.ptr(H.mask), need = 4 * (Math.floor((V + k) / 32) + 1), have = regionSize(F, 'DISP', o);
    if (need > have) F.insert('DISP', o + have, new Uint8Array(Math.ceil((need - have) / 16) * 16));
    const b = d.b; for (let i = V; i < V + k; i++) b[o + (i >> 3)] &= ~(1 << (i & 7));
  }
  // INID: u32 count, u32, u16 order list
  { const I = new Body(F, 'INID'), n = I.u32(0); if (n !== V) throw new Error('INID count differs');
    const v = new Uint8Array(2 * k), dv = new DataView(v.buffer); for (let i = 0; i < k; i++) dv.setUint16(2 * i, V + i, true);
    insertEntries(F, 'INID', 8, 2, V, V, v); I.setU32(0, V + k); }
  // FDNS: 8 B per culled object (fade distances)
  { const fdOff = d.ptr(H.fdns), Fd = new Body(F, 'FDNS'), v = new Uint8Array(8 * k);
    copies.forEach((cp, ci) => { if (cp.src < V) v.set(Fd.bytes(fdOff + 8 * cp.src, 8), 8 * ci); });
    insertEntries(F, 'FDNS', fdOff, 8, V, V, v); }
  // BNDS: u32 flags, u32 count, 32 B bounds per culled object
  { const B = new Body(F, 'BNDS'); if (B.u32(4) !== V) throw new Error('BNDS count differs');
    const v = new Uint8Array(32 * k);
    perCopy.forEach((list, ci) => v.set(boundsRecord(S, list), 32 * ci));
    insertEntries(F, 'BNDS', 8, 32, V, V, v); B.setU32(4, V + k); }

  // ---- 7. counts, and object indices held by instances
  d.setU32(H.nall, A + k); d.setU32(H.nvis1, V + k); d.setU32(H.nvis2, V + k); d.setU32(H.nvis3, V + k);
  { const G = new Body(F, 'GSNH'); for (const o of [0x58, 0xF0, 0xF4]) if (G.u32(o) === V) G.setU32(o, V + k); }
  if (A > V) { const wi = d.ptr(H.inst), dv = d.dv(); for (let i = 0; i < ninst; i++) { const a = wi + 208 * i + 0xC0, v = dv.getUint32(a, true); if (v >= V) dv.setUint32(a, v + k, true); } }

  // ---- 8. scene instances (names) for copies that ask for one
  const named = copies.map((cp, ci) => ({ cp, ci, list: perCopy[ci] })).filter(x => x.cp.name);
  if (named.length) addInstances(F, S, d, named, V, ninst);

  // ---- 9. physics bodies (lamp posts, trees, breakable building pieces) for named copies of objects that have one
  let bodies = 0;
  if (named.length && S.T.DNO2 != null) {
    const pairs = named.map(({ cp }, j) => ({ src: S.objects[cp.src].instances?.[0], dst: ninst + j })).filter(p => p.src != null);
    if (pairs.length) bodies = addBodyCopies(F, S, pairs);
  }

  return { objects: copies.map((_, ci) => V + ci), draws: draws.length, instances: named.map((x, j) => ninst + j), bodies };
}

// DNO2 bodies of a source instance, copied for a new instance (the copy's own named instance).
//   body (32 B): f32 mass, 0, 0, u32 link = instance << 16 | kind, then 0xFFFF and zeros
//   shape (20 B): s8 type, u8, s16 body, s16 transform, s16 geom, 3 f32. Each shape has its own transform
//   (64 B, body-local), and its geom (body-local too) is shared, so a copy needs no new geometry.
// Bodies, shapes and transforms are appended at the ends of their tables (each padded to 16 bytes so everything
// behind keeps its alignment); the body physics is placed by the instance matrix, which the copy already has.
function addBodyCopies(F, S, pairs) {
  const D = new Body(F, 'DNO2');
  if (D.b.length < 0x50) return 0;
  const nb = D.i32(0x08), ns = D.i32(0x18), nx = D.i32(0x38);
  const bodyAt = D.ptr(0x0C), shapeAt = D.ptr(0x1C), xfAt = D.ptr(0x3C);
  const newBodies = [], newShapes = [], newXf = [];
  for (const { src, dst } of pairs) {
    for (let k = 0; k < nb; k++) {

      const rec = D.bytes(bodyAt + 32 * k, 32), rdv = new DataView(rec.buffer);
      if (rdv.getUint32(12, true) >>> 16 !== src) continue;
      const bi = nb + newBodies.length;
      rdv.setUint32(12, ((dst << 16) | (rdv.getUint32(12, true) & 0xFFFF)) >>> 0, true);
      newBodies.push(rec);
      for (let j = 0; j < ns; j++) {
        const s = D.bytes(shapeAt + 20 * j, 20), sdv = new DataView(s.buffer);
        if (sdv.getInt16(2, true) !== k) continue;
        sdv.setInt16(2, bi, true);
        const xf = sdv.getInt16(4, true);
        if (xf >= 0) { sdv.setInt16(4, nx + newXf.length, true); newXf.push(D.bytes(xfAt + 64 * xf, 64)); }
        newShapes.push(s);
      }
    }
  }
  if (!newBodies.length) return 0;
  if (nb + newBodies.length > 32767 || ns + newShapes.length > 32767 || nx + newXf.length > 32767) throw new Error('too many collision bodies');
  const cat = list => { const o = new Uint8Array(list.reduce((a, x) => a + x.length, 0)); let p = 0; for (const x of list) { o.set(x, p); p += x.length; } return o; };
  // each insert re-reads the table pointers, which GSCFile.insert keeps up to date
  if (newXf.length) insertEntries(F, 'DNO2', D.ptr(0x3C), 64, nx, nx, cat(newXf));
  insertEntries(F, 'DNO2', D.ptr(0x1C), 20, ns, ns, cat(newShapes));
  insertEntries(F, 'DNO2', D.ptr(0x0C), 32, nb, nb, cat(newBodies));
  D.setU32(0x08, nb + newBodies.length); D.setU32(0x18, ns + newShapes.length); D.setU32(0x38, nx + newXf.length);
  return newBodies.length;
}

// Instance record (208 B, DISP+70, count +6C):
//   +00 world matrix, +40 same matrix again (normally), +80 min xyz 1, +90 max xyz 1, +A0 centre xyz radius
//   (world bounds of the object), +B0 -> object table entry, +B4 -> name (NTBL), +B8 flags (4/6/0x804/0x806),
//   +BC -> its own u32 slot in the table right after the records, +C0 object index, +C4..+CC runtime (0).
// Names live in NTBL: u32 byte count, then NUL-terminated strings. The +88 bitmask has a bit per culled object
// that has an instance.
function addInstances(F, S, d, named, V, ninst) {
  const H = DISP_HDR;
  const taken = new Set(S.instances.map(i => i.name.toLowerCase()));
  for (const { cp } of named) {
    if (!/^[\x21-\x7e]{1,63}$/.test(cp.name)) throw new Error(`instance name "${cp.name}": use 1-63 plain characters, no spaces`);
    if (taken.has(cp.name.toLowerCase())) throw new Error(`instance name "${cp.name}" is already used in this level`);
    taken.add(cp.name.toLowerCase());
  }
  // names: append to NTBL and fix its byte count
  const N = new Body(F, 'NTBL');
  const nameAt = [];
  for (const { cp } of named) {
    const size = N.u32(0), bytes = new TextEncoder().encode(cp.name + '\0');
    F.insert('NTBL', 4 + size, bytes);
    nameAt.push(4 + size);
    N.setU32(0, size + bytes.length);
  }
  // records: copy of the source object's first instance, or a plain one (flags 6: drawn by the instance loop)
  const recs = new Uint8Array(208 * named.length), rdv = new DataView(recs.buffer);
  named.forEach(({ cp, list }, j) => {
    const o = 208 * j;
    const si = S.objects[cp.src].instances?.[0];
    if (si != null) recs.set(S.u8.slice(S.base + S.instances[si].at, S.base + S.instances[si].at + 208), o);
    const base = si != null ? S.instances[si].matrix : M4.identity();
    const base2 = si != null ? S.instances[si].matrix2 : base;
    const m = M4.mul(base, cp.T), m2 = M4.mul(base2, cp.T);
    for (let i = 0; i < 16; i++) { rdv.setFloat32(o + 4 * i, m[i], true); rdv.setFloat32(o + 0x40 + 4 * i, m2[i], true); }
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const x of list) { const P = transformPoints(S.readPositions(x.sd), x.world); for (let i = 0; i < P.length; i += 3) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], P[i + a]); mx[a] = Math.max(mx[a], P[i + a]); } }
    for (let a = 0; a < 3; a++) { rdv.setFloat32(o + 0x80 + 4 * a, mn[a], true); rdv.setFloat32(o + 0x90 + 4 * a, mx[a], true); rdv.setFloat32(o + 0xA0 + 4 * a, (mn[a] + mx[a]) / 2, true); }
    rdv.setFloat32(o + 0x8C, 1, true); rdv.setFloat32(o + 0x9C, 1, true);
    rdv.setFloat32(o + 0xAC, Math.hypot(...[0, 1, 2].map(a => (mx[a] - mn[a]) / 2)), true);
    if (si == null) rdv.setUint32(o + 0xB8, 6, true);
    for (const f of [0xB0, 0xB4, 0xBC, 0xC4, 0xC8, 0xCC]) rdv.setUint32(o + f, 0, true);
  });
  named.forEach(({ ci }, j) => rdv.setUint32(208 * j + 0xC0, V + ci, true));
  const wi = d.ptr(H.inst), tail = wi + 208 * ninst;
  F.insert('DISP', tail, recs); // 208 = 13 x 16: alignment kept; the slot table behind moves with its pointers
  const slots = d.ptr(H.inst) + 208 * (ninst + named.length);
  insertEntries(F, 'DISP', slots, 4, ninst, ninst, new Uint8Array(4 * named.length));
  const wi2 = d.ptr(H.inst), slots2 = wi2 + 208 * (ninst + named.length), ot = d.ptr(H.obj);
  named.forEach(({ ci }, j) => {
    const r = wi2 + 208 * (ninst + j);
    F.setPointer('DISP', r + 0xB0, 'DISP', ot + 12 * (V + ci));
    F.setPointer('DISP', r + 0xB4, 'NTBL', nameAt[j]);
    F.setPointer('DISP', r + 0xBC, 'DISP', slots2 + 4 * (ninst + j));
    F.setPointer('DISP', r + 0xC4, null); F.setPointer('DISP', r + 0xCC, null);
  });
  d.setU32(H.ninst, ninst + named.length);
  // the copies now have an instance: set their bits in the +88 bitmask
  const mask = d.ptr(H.mask), b = d.b;
  for (const { ci } of named) b[mask + ((V + ci) >> 3)] |= 1 << ((V + ci) & 7);
}
