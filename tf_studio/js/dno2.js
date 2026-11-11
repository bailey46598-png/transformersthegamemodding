// DNO2: the level's collision ("Dyno" physics scene). Reader, KD-tree builder and geom writer.
// Layout (PC_GSC_FORMAT.md / WII_HOOVEREXT_NOTES.md; checked on every stock PC level):
//   header (chunk body): +04 version 15, +08/+0C bodies (32 B), +18/+1C shapes (20 B), +38/+3C transforms (64 B),
//                        +40/+44 geoms (48 B), +4C -> per-geom pointer list (-> 2 B per polygon)
//   body:  {f32 mass, 0, 0, u32 link (instance << 16 | kind), ...}   kind 0x10 = building piece, 0x11 = prop
//   shape: {s8 type (5 = KD terrain, 3 = box with half sizes, 2 = another primitive), u8, s16 body (-1 = static world), s16 transform, s16 geom, 3 f32}
//   geom:  {u32 4, nv, nn, npoly, nleaf, ->verts f32x3, ->polys u16x5, ->nodes, ->leaves, u32 nsurf, ->surf u32, ->u8 per poly}
//          polygon = quad a b c d (triangle when d == c) + one u16 kept as is
//          node = {f32 a, f32 b, u16 child, u8 axis, u8 0}; axis 3 = leaf (child = leaf index). Otherwise the
//                 "high" child is the next node (all its values >= b) and the "low" child is node `child` (<= a).
//          leaf = {f32 min[3], u32 count, f32 max[3], u32 first polygon}; leaves in depth-first order, contiguous.
//   Arrays of one geom sit together in the order verts, polys, per-poly, nodes, leaves, surf, then the 2 B/poly block.
// Static geoms are world space. A body's geom is local: world = shape transform x instance matrix (row vectors).

export function readDNO2(S) {
  if (!('DNO2' in S.T)) return null;
  const c0 = S.T.DNO2, b = c0 + 8, size = S.u32(c0 + 4);
  const out = { body: b, bodies: [], shapes: [], xforms: [], geoms: [] };
  // PS3 scenes are big-endian: S.i32/u32/f32 already read them right; raw arrays are swapped below
  const i16 = a => S.dv.getInt16(S.base + a, !S.ps3);
  const swap = (u, w) => { if (S.ps3) for (let i = 0; i + w <= u.length; i += w) u.subarray(i, i + w).reverse(); return u; };
  if (size < 0x70) return out;
  const nb = S.i32(b + 8), bp = S.ptr(b + 0xC);
  for (let k = 0; k < nb; k++) {
    const r = bp + 32 * k, link = S.u32(r + 12);
    // PC: instance << 16 | kind; PS3 (like Wii): kind << 24 | instance
    out.bodies.push(S.ps3 ? { mass: S.f32(r), instance: link & 0xFFFF, kind: link >>> 24 } : { mass: S.f32(r), instance: link >>> 16, kind: link & 0xFFFF });
  }
  const ns = S.i32(b + 0x18), sp = S.ptr(b + 0x1C);
  for (let k = 0; k < ns; k++) {
    const r = sp + 20 * k;
    out.shapes.push({ type: (S.byte(r) << 24) >> 24, body: i16(r + 2), xf: i16(r + 4),
      geom: i16(r + 6), dims: [S.f32(r + 8), S.f32(r + 12), S.f32(r + 16)] });
  }
  const nx = S.i32(b + 0x38), xp = S.ptr(b + 0x3C);
  for (let k = 0; k < nx; k++) out.xforms.push(S.mat(xp + 64 * k));
  const ng = S.i32(b + 0x40), gp = S.ptr(b + 0x44), lp = S.ptr(b + 0x4C);
  for (let k = 0; k < ng; k++) {
    const g = gp + 48 * k;
    const nv = S.u32(g + 4), nn = S.u32(g + 8), nt = S.u32(g + 12), nl = S.u32(g + 16), nsf = S.u32(g + 0x24);
    const at = { V: S.ptr(g + 0x14), Q: S.ptr(g + 0x18), P: S.ptr(g + 0x2C), N: S.ptr(g + 0x1C), L: S.ptr(g + 0x20), S: S.ptr(g + 0x28), G: lp != null ? S.ptr(lp + 4 * k) : null };
    const bytes = (a, n) => a == null ? new Uint8Array(n) : S.u8.slice(S.base + a, S.base + a + n);
    const vb = swap(bytes(at.V, nv * 12), 4), qb = swap(bytes(at.Q, nt * 10), 2);
    out.geoms.push({
      id: k, rec: g, at, nv, nn, nt, nl, nsurf: nsf,
      V: new Float32Array(vb.buffer), Q: new Uint16Array(qb.buffer),
      P: bytes(at.P, nt), G: bytes(at.G, nt * 2), surf: bytes(at.S, nsf * 4),
      nodes: bytes(at.N, nn * 12), leaves: bytes(at.L, nl * 32),
    });
  }
  // World-space geoms: KD terrain with no body and no transform. (Static shapes with a transform reuse a local
  // geom, e.g. Qatar places one 13 times; those geoms are not world space and are left alone.)
  const world = new Set(), local = new Set();
  for (const s of out.shapes) if (s.type === 5 && s.geom >= 0) (s.body < 0 && s.xf < 0 ? world : local).add(s.geom);
  out.staticGeoms = [...world].filter(k => !local.has(k)).map(k => out.geoms[k]).filter(Boolean);
  return out;
}

// triangles of a geom's polygons as index triples
export function polyTriangles(Q) {
  const out = [];
  for (let p = 0; p < Q.length / 5; p++) {
    const a = Q[p * 5], b = Q[p * 5 + 1], c = Q[p * 5 + 2], d = Q[p * 5 + 3];
    out.push(a, b, c);
    if (d !== c && d !== a) out.push(a, c, d);
  }
  return out;
}

// Build a KD tree (the engine's layout) over polygons. Input arrays are not changed.
// Returns { Q, P, G (reordered by leaf), nodes, leaves, nn, nl }.
export function buildTree(V, Q, P, G, maxLeaf = 24) {
  const n = Q.length / 5;
  const pmin = new Float32Array(n * 3), pmax = new Float32Array(n * 3), cen = new Float32Array(n * 3);
  for (let p = 0; p < n; p++) {
    for (let a = 0; a < 3; a++) { pmin[p * 3 + a] = Infinity; pmax[p * 3 + a] = -Infinity; }
    for (let k = 0; k < 4; k++) {
      const v = Q[p * 5 + k];
      for (let a = 0; a < 3; a++) { const x = V[v * 3 + a]; if (x < pmin[p * 3 + a]) pmin[p * 3 + a] = x; if (x > pmax[p * 3 + a]) pmax[p * 3 + a] = x; }
    }
    for (let a = 0; a < 3; a++) cen[p * 3 + a] = (pmin[p * 3 + a] + pmax[p * 3 + a]) / 2;
  }
  const ids = Array.from({ length: n }, (_, i) => i);
  const nodes = [], leaves = [], order = [];
  const box = (lo, hi) => {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let k = lo; k < hi; k++) { const p = ids[k]; for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], pmin[p * 3 + a]); mx[a] = Math.max(mx[a], pmax[p * 3 + a]); } }
    return { mn, mx };
  };
  const rec = (lo, hi) => {
    const j = nodes.length; nodes.push(null);
    if (hi - lo <= maxLeaf) {
      const bb = box(lo, hi);
      if (hi === lo) { bb.mn = [0, 0, 0]; bb.mx = [0, 0, 0]; }
      nodes[j] = { a: 0, b: 0, child: leaves.length, axis: 3 };
      leaves.push({ mn: bb.mn, mx: bb.mx, count: hi - lo, start: order.length });
      for (let k = lo; k < hi; k++) order.push(ids[k]);
      return bb;
    }
    // split the longest axis of the centroid bounds at the median
    const cmn = [Infinity, Infinity, Infinity], cmx = [-Infinity, -Infinity, -Infinity];
    for (let k = lo; k < hi; k++) { const p = ids[k]; for (let a = 0; a < 3; a++) { cmn[a] = Math.min(cmn[a], cen[p * 3 + a]); cmx[a] = Math.max(cmx[a], cen[p * 3 + a]); } }
    let axis = 0; for (let a = 1; a < 3; a++) if (cmx[a] - cmn[a] > cmx[axis] - cmn[axis]) axis = a;
    const part = ids.slice(lo, hi).sort((x, y) => cen[x * 3 + axis] - cen[y * 3 + axis]);
    for (let k = 0; k < part.length; k++) ids[lo + k] = part[k];
    const mid = (lo + hi) >> 1;
    const hb = rec(mid, hi);           // high child: the next node
    const child = nodes.length;
    const lb = rec(lo, mid);           // low child: node `child`
    nodes[j] = { a: lb.mx[axis], b: hb.mn[axis], child, axis };
    return { mn: lb.mn.map((v, a) => Math.min(v, hb.mn[a])), mx: lb.mx.map((v, a) => Math.max(v, hb.mx[a])) };
  };
  rec(0, n);
  if (nodes.length > 65535 || leaves.length > 65535) throw new Error('collision tree too large');
  const Q2 = new Uint16Array(n * 5), P2 = new Uint8Array(n), G2 = new Uint8Array(n * 2);
  order.forEach((p, k) => { Q2.set(Q.subarray(p * 5, p * 5 + 5), k * 5); P2[k] = P[p]; G2[k * 2] = G[p * 2]; G2[k * 2 + 1] = G[p * 2 + 1]; });
  const nb = new Uint8Array(nodes.length * 12), ndv = new DataView(nb.buffer);
  nodes.forEach((d, k) => { ndv.setFloat32(k * 12, d.a, true); ndv.setFloat32(k * 12 + 4, d.b, true); ndv.setUint16(k * 12 + 8, d.child, true); nb[k * 12 + 10] = d.axis; });
  const lb = new Uint8Array(leaves.length * 32), ldv = new DataView(lb.buffer);
  leaves.forEach((l, k) => {
    for (let a = 0; a < 3; a++) { ldv.setFloat32(k * 32 + 4 * a, l.mn[a], true); ldv.setFloat32(k * 32 + 16 + 4 * a, l.mx[a], true); }
    ldv.setUint32(k * 32 + 12, l.count, true); ldv.setUint32(k * 32 + 28, l.start, true);
  });
  return { Q: Q2, P: P2, G: G2, nodes: nb, leaves: lb, nn: nodes.length, nl: leaves.length };
}

// Check a geom's tree against the rules above. Returns a list of problems (empty = fine).
export function checkTree(V, Q, nodes, leaves) {
  const errs = [], nn = nodes.length / 12, nl = leaves.length / 32, np = Q.length / 5;
  const ndv = new DataView(nodes.buffer, nodes.byteOffset, nodes.length), ldv = new DataView(leaves.buffer, leaves.byteOffset, leaves.length);
  const leafBox = k => ({ mn: [0, 1, 2].map(a => ldv.getFloat32(k * 32 + 4 * a, true)), mx: [0, 1, 2].map(a => ldv.getFloat32(k * 32 + 16 + 4 * a, true)) });
  let next = 0, seen = 0;
  for (let k = 0; k < nl; k++) {
    const cnt = ldv.getUint32(k * 32 + 12, true), st = ldv.getUint32(k * 32 + 28, true), bb = leafBox(k);
    if (st !== next) errs.push(`leaf ${k} starts at ${st}, expected ${next}`);
    next = st + cnt; seen += cnt;
    for (let p = st; p < st + cnt && errs.length < 20; p++) for (let c = 0; c < 4; c++) {
      const v = Q[p * 5 + c]; if (v * 3 >= V.length) { errs.push(`poly ${p} vertex ${v} out of range`); continue; }
      for (let a = 0; a < 3; a++) { const x = V[v * 3 + a]; if (x < bb.mn[a] - 1e-3 || x > bb.mx[a] + 1e-3) errs.push(`poly ${p} outside leaf ${k}`); }
    }
  }
  if (seen !== np) errs.push(`leaves cover ${seen} of ${np} polygons`);
  const walk = j => {
    const a = ndv.getFloat32(j * 12, true), b = ndv.getFloat32(j * 12 + 4, true), ch = ndv.getUint16(j * 12 + 8, true), ax = nodes[j * 12 + 10];
    if (ax === 3) return leafBox(ch);
    if (ch <= j || ch >= nn) { errs.push(`node ${j} child ${ch}`); return leafBox(0); }
    const hi = walk(j + 1), lo = walk(ch);
    if (lo.mx[ax] > a + 1e-3) errs.push(`node ${j}: low side exceeds a`);
    if (hi.mn[ax] < b - 1e-3) errs.push(`node ${j}: high side below b`);
    return { mn: lo.mn.map((v, k) => Math.min(v, hi.mn[k])), mx: lo.mx.map((v, k) => Math.max(v, hi.mx[k])) };
  };
  if (nn) walk(0);
  return errs.slice(0, 20);
}

// Replace geom `g` (from readDNO2 of the same file) in a GSCFile with new contents {V, Q, P, G, nodes, leaves, nn, nl}.
// Offsets come from the file as read, so when replacing several geoms, do the highest-addressed one first.
export function writeGeom(F, dno, g, nu) {
  const body0 = dno.body; // NU20 address of the DNO2 body == chunk body offset 0
  const off = a => a - body0;
  const arr = [['V', g.at.V, g.nv * 12], ['Q', g.at.Q, g.nt * 10], ['P', g.at.P, g.nt], ['N', g.at.N, g.nn * 12], ['L', g.at.L, g.nl * 32], ['S', g.at.S, g.nsurf * 4], ['G', g.at.G, g.nt * 2]];
  if (arr.some(([, a]) => a == null)) throw new Error('collision geom has a missing array');
  const at = Math.min(...arr.map(([, a]) => off(a)));
  let end = Math.max(...arr.map(([, a, n]) => off(a) + n));
  // alignment is of NU20 addresses; a chunk body starts 8 bytes into a 16-aligned chunk
  end += (16 - (end + 8) % 16) % 16;
  if ((at + 8) % 16) throw new Error('collision arrays are not 16-aligned');
  // new block, same order, each array 16-aligned
  const parts = { V: new Uint8Array(nu.V.buffer, nu.V.byteOffset, nu.V.byteLength), Q: new Uint8Array(nu.Q.buffer, nu.Q.byteOffset, nu.Q.byteLength), P: nu.P, N: nu.nodes, L: nu.leaves, S: g.surf, G: nu.G };
  const layout = new Map(); let size = 0;
  for (const [k] of arr) { layout.set(k, size); size += parts[k].length; size += (16 - size % 16) % 16; }
  const block = new Uint8Array(size);
  for (const [k] of arr) block.set(parts[k], layout.get(k));
  const retarget = new Map(arr.map(([k, a]) => [off(a), layout.get(k)]));
  F.replaceRegion('DNO2', at, end - at, block, retarget);
  // counts in the geom record (it sits before the arrays; shift it anyway if it does not)
  let r = off(g.rec); if (r >= end) r += block.length - (end - at);
  const body = F.body('DNO2'), dv = new DataView(body.buffer, body.byteOffset, body.length);
  dv.setUint32(r + 4, nu.V.length / 3, true); dv.setUint32(r + 8, nu.nn, true); dv.setUint32(r + 12, nu.Q.length / 5, true); dv.setUint32(r + 16, nu.nl, true);
}
