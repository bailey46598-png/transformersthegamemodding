// Cut a circular region out of a level scene (.GSC) and make it a stand-alone map.
// Used to build the TestTranquility crater arena from the hi-res Tranquility_Main scene (2026-11-08).
//
// What it does, in the scene's own world coordinates (Y up, region is a circle in X/Z):
//   - Draws with no vertex inside the circle are hidden: their own 0x83 matrix is collapsed to a point
//     (every draw has its own matrix, so this never touches another draw). Huge backdrop draws that wrap the
//     region (sky dome, distant cards) are kept.
//   - Draws that cross the edge are trimmed triangle by triangle (kept when the triangle's centre is inside).
//     The kept triangles are written as a new strip at the end of the shared index buffer and the draw record is
//     pointed at it. Records shared with other draws are not trimmed; they are kept or hidden whole.
//   - World collision (static KD geoms) keeps only polygons whose centre is inside; a new tree is built and checked.
//   - Physics bodies of hidden objects are dropped 1000 units below (as the level editor does).
//
// Usage (in the browser, with the TF Studio server running):
//   const { cutRegion } = await import('/js/region_cut.js');
//   const { bytes, report } = cutRegion(arrayBuffer, { cx: 870, cz: 990, r: 480 });
import { GSCScene, transformPoints, stripToTriangles } from './formats.js';
import { GSCFile } from './gsc_writer.js';
import { readDNO2, buildTree, checkTree, writeGeom } from './dno2.js';

const DROP = 1000;

// Triangle list -> one strip with degenerate joins. Each triangle starts at an even strip position, so the
// engine's alternating winding leaves it exactly as given.
export function trianglesToStrip(tris) {
  const s = [];
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t], b = tris[t + 1], c = tris[t + 2];
    if (s.length) { s.push(s[s.length - 1], a); if ((s.length - 1) % 2) s.push(a); }
    s.push(a, b, c);
  }
  return s;
}

// hide: extra draw ids to hide even when inside (e.g. the crater's water surface, to get a dry bowl).
export function cutRegion(buffer, { cx, cz, r, keepBackdrop = 3000, hide: hideIds = [] }) {
  const S = new GSCScene(buffer.slice(0));
  const inside = (x, z) => (x - cx) * (x - cx) + (z - cz) * (z - cz) <= r * r;
  const report = { kept: 0, hidden: 0, trimmed: 0, backdrop: 0, sharedWhole: 0, triKept: 0, triDropped: 0, bodiesDropped: 0, collision: [] };

  // which draw records are used by more than one draw
  const cmd0 = S.ptr(S.T.DISP + 8 + 8);
  const recOf = d => S.ptr(cmd0 + 16 * d.cmd + 4);
  const recUse = new Map();
  for (const d of S.draws) { const k = recOf(d); recUse.set(k, (recUse.get(k) || 0) + 1); }

  const ib = S.ib(0);
  const extra = []; // new strips, appended after the existing index buffer
  const ibLen = ib.length;
  const hiddenDraw = new Set();
  const hide = d => {
    const m = d.matrix.slice();
    for (let i = 0; i < 12; i++) m[i] = 0; // keep translation, scale to nothing
    S.writeMatrix(d, m);
    hiddenDraw.add(d.id);
  };

  const forced = new Set(hideIds);
  for (const d of S.draws) {
    if (forced.has(d.id)) { hide(d); report.hidden++; report.forced = (report.forced || 0) + 1; continue; }
    const P = S.readPositions(d);
    if (d.matrix) transformPoints(P, d.matrix);
    const n = d.count;
    let nin = 0, mn = [Infinity, Infinity], mx = [-Infinity, -Infinity];
    for (let i = 0; i < n; i++) {
      const x = P[i * 3], z = P[i * 3 + 2];
      if (inside(x, z)) nin++;
      mn = [Math.min(mn[0], x), Math.min(mn[1], z)]; mx = [Math.max(mx[0], x), Math.max(mx[1], z)];
    }
    const wraps = mn[0] < cx - r && mx[0] > cx + r && mn[1] < cz - r && mx[1] > cz + r;
    const diag = Math.hypot(mx[0] - mn[0], mx[1] - mn[1]);
    if (nin === n) { report.kept++; continue; }
    if (wraps && diag >= keepBackdrop && nin <= n * 0.05) { report.backdrop++; continue; } // sky dome, far cards
    if (nin === 0) { hide(d); report.hidden++; continue; }
    // crosses the edge: trim by triangle centre
    const tris = stripToTriangles(d.ib ? S.ib(d.ib) : ib, d.start, d.prims, n);
    const keep = [];
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
      if (inside((P[a] + P[b] + P[c]) / 3, (P[a + 2] + P[b + 2] + P[c + 2]) / 3)) keep.push(tris[t], tris[t + 1], tris[t + 2]);
    }
    if (recUse.get(recOf(d)) > 1) { // shared record: all or nothing
      report.sharedWhole++;
      if (keep.length * 2 < tris.length) { hide(d); report.hidden++; } else report.kept++;
      continue;
    }
    if (!keep.length) { hide(d); report.hidden++; continue; }
    const strip = trianglesToStrip(keep);
    if (strip.length - 2 > 0xFFFF) { report.kept++; continue; } // too long for the u16 count: keep whole
    const rec = recOf(d);
    S.dv.setUint16(S.base + rec + 4, strip.length - 2, true);
    S.dv.setUint32(S.base + rec + 0x18, ibLen + extra.length, true);
    S.dv.setUint32(S.base + rec + 0x1C, 0, true); // the new strip goes into index buffer 0 (hi-res City has two)
    for (const v of strip) extra.push(v);
    report.trimmed++; report.triKept += keep.length / 3; report.triDropped += (tris.length - keep.length) / 3;
  }

  // physics bodies whose object is now hidden: drop them out of the way
  const D0 = readDNO2(S);
  if (D0) {
    const hiddenObj = new Set();
    for (const o of S.objects) if (o.draws.length && o.draws.every(di => hiddenDraw.has(di))) hiddenObj.add(o.id);
    const dropped = new Set();
    for (const b of D0.bodies) {
      const ins = S.instances[b.instance];
      if (!ins || dropped.has(ins.id)) continue;
      const t = ins.matrix;
      if (hiddenObj.has(ins.object) || !inside(t[12], t[14])) {
        const m = t.slice(); m[13] -= DROP; S.writeInstanceMatrix(ins, m); dropped.add(ins.id);
      }
    }
    report.bodiesDropped = dropped.size;
  }

  // rebuild through the writer: grow the index buffer, then crop the world collision
  const F = GSCFile.fromBuffer(S.buf);
  if (extra.length) {
    const old = F.ibs[0], nb = new Uint8Array(old.length + extra.length * 2);
    nb.set(old); new Uint16Array(nb.buffer, old.length, extra.length).set(extra);
    F.ibs[0] = nb;
  }
  const Dcur = readDNO2(S);
  if (Dcur) {
    const jobs = [];
    for (const g of Dcur.staticGeoms) {
      const keepP = [];
      for (let p = 0; p < g.nt; p++) {
        let sx = 0, sz = 0;
        for (let k = 0; k < 4; k++) { const v = g.Q[p * 5 + k]; sx += g.V[v * 3]; sz += g.V[v * 3 + 2]; }
        if (inside(sx / 4, sz / 4)) keepP.push(p);
      }
      // compact: only the vertices still used
      const remap = new Map(), V = [], Q = [], Pp = [], G = [];
      for (const p of keepP) {
        for (let k = 0; k < 5; k++) {
          if (k === 4) { Q.push(g.Q[p * 5 + 4]); continue; }
          const v = g.Q[p * 5 + k];
          if (!remap.has(v)) { remap.set(v, V.length / 3); V.push(g.V[v * 3], g.V[v * 3 + 1], g.V[v * 3 + 2]); }
          Q.push(remap.get(v));
        }
        Pp.push(g.P[p]); G.push(g.G[p * 2], g.G[p * 2 + 1]);
      }
      if (!keepP.length) { // an empty geom would need an empty tree; keep one tiny polygon far below instead
        V.push(cx, -DROP, cz, cx + 1, -DROP, cz, cx, -DROP, cz + 1); Q.push(0, 1, 2, 2, g.Q[4]); Pp.push(g.P[0]); G.push(g.G[0], g.G[1]);
      }
      const Vf = Float32Array.from(V);
      const nu = buildTree(Vf, Uint16Array.from(Q), Uint8Array.from(Pp), Uint8Array.from(G));
      const errs = checkTree(Vf, nu.Q, nu.nodes, nu.leaves);
      if (errs.length) throw new Error(`collision geom ${g.id}: ${errs[0]}`);
      report.collision.push({ geom: g.id, before: g.nt, after: nu.Q.length / 5, verts: Vf.length / 3 });
      jobs.push([g, { ...nu, V: Vf }]);
    }
    jobs.sort((a, b) => b[0].at.V - a[0].at.V);
    for (const [g, nu] of jobs) writeGeom(F, Dcur, g, nu);
  }
  const bytes = F.build();
  return { bytes, report };
}

// Replace the world collision of `target` (a .GSC as bytes) with the world collision of `source`, merged into one
// geom. Used to give the low-detail crater (low-res visuals, which render in Low Detail mode) the hi-res collision.
// Surface types are matched by their 4-byte surface-table entry; unmatched ones fall back to the same type byte,
// then to entry 0. Returns { bytes, report }.
export function graftCollision(target, source) {
  const T = new GSCScene(target.buffer.slice(target.byteOffset, target.byteOffset + target.byteLength));
  const Sx = new GSCScene(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength));
  const Dt = readDNO2(T), Ds = readDNO2(Sx);
  if (!Dt?.staticGeoms.length || !Ds?.staticGeoms.length) throw new Error('both files need world collision');
  const tg = Dt.staticGeoms.reduce((a, b) => (b.nt > a.nt ? b : a)); // the target geom that receives everything
  const key = (surf, i) => surf[i * 4] | (surf[i * 4 + 1] << 8) | (surf[i * 4 + 2] << 16) | (surf[i * 4 + 3] << 24);
  const tKeys = new Map(), tType = new Map();
  for (let i = 0; i < tg.nsurf; i++) { const k = key(tg.surf, i); if (!tKeys.has(k)) tKeys.set(k, i); if (!tType.has(tg.surf[i * 4])) tType.set(tg.surf[i * 4], i); }
  const report = { polys: 0, exact: 0, byType: 0, fallback: 0 };
  const V = [], Q = [], P = [], G = [];
  for (const g of Ds.staticGeoms) {
    const base = V.length / 3;
    for (let i = 0; i < g.V.length; i++) V.push(g.V[i]);
    for (let p = 0; p < g.nt; p++) {
      for (let k = 0; k < 4; k++) Q.push(g.Q[p * 5 + k] + base);
      Q.push(g.Q[p * 5 + 4]);
      const si = g.P[p], k = key(g.surf, si);
      let ti = tKeys.get(k);
      if (ti != null) report.exact++;
      else if ((ti = tType.get(g.surf[si * 4])) != null) report.byType++;
      else { ti = 0; report.fallback++; }
      P.push(ti); G.push(g.G[p * 2], g.G[p * 2 + 1]);
    }
  }
  if (V.length / 3 > 65535) throw new Error('too many collision vertices');
  // every other target world geom is emptied to one tiny polygon far below
  const F = GSCFile.fromBuffer(T.buf);
  const jobs = [];
  for (const g of Dt.staticGeoms) {
    let Vf, Qa, Pa, Ga;
    if (g === tg) { Vf = Float32Array.from(V); Qa = Uint16Array.from(Q); Pa = Uint8Array.from(P); Ga = Uint8Array.from(G); }
    else { Vf = Float32Array.of(0, -DROP, 0, 1, -DROP, 0, 0, -DROP, 1); Qa = Uint16Array.of(0, 1, 2, 2, g.Q[4]); Pa = Uint8Array.of(g.P[0]); Ga = Uint8Array.of(g.G[0], g.G[1]); }
    const nu = buildTree(Vf, Qa, Pa, Ga);
    const errs = checkTree(Vf, nu.Q, nu.nodes, nu.leaves);
    if (errs.length) throw new Error(`collision geom ${g.id}: ${errs[0]}`);
    jobs.push([g, { ...nu, V: Vf }]);
  }
  jobs.sort((a, b) => b[0].at.V - a[0].at.V);
  for (const [g, nu] of jobs) writeGeom(F, Dt, g, nu);
  report.polys = Q.length / 5;
  return { bytes: F.build(), report };
}

// Replace the world collision of `target` with the visible triangles of its own draws that use one of `texIds`
// (e.g. the ground textures), so the collision is exactly the ground you see. Surface entry and the per-polygon
// 2-byte value are copied from `like` = {surf (index into the target's surface table), g: [b0, b1], q4 (polygon's 5th u16)}.
export function collisionFromGround(target, texIds, like) {
  const S = new GSCScene(target.buffer.slice(target.byteOffset, target.byteOffset + target.byteLength));
  const D = readDNO2(S);
  const tg = D.staticGeoms.reduce((a, b) => (b.nt > a.nt ? b : a));
  const want = new Set(texIds), V = [], Q = [], P = [], G = [], vid = new Map();
  const vert = (x, y, z) => {
    const k = `${Math.round(x * 100)},${Math.round(y * 100)},${Math.round(z * 100)}`;
    if (!vid.has(k)) { vid.set(k, V.length / 3); V.push(x, y, z); }
    return vid.get(k);
  };
  let draws = 0;
  for (const d of S.draws) {
    const m = d.matrix;
    if (m && m[0] === 0 && m[5] === 0 && m[10] === 0) continue; // hidden
    if (!want.has(S.materials[d.material]?.tex)) continue;
    const g = S.drawGeometry(d); draws++;
    for (let t = 0; t < g.tris.length; t += 3) {
      const ids = [0, 1, 2].map(k => { const i = g.tris[t + k] * 3; return vert(g.P[i], g.P[i + 1], g.P[i + 2]); });
      if (ids[0] === ids[1] || ids[1] === ids[2] || ids[0] === ids[2]) continue;
      // Collision is one-sided. Stock ground polygons wind so that (b-a) x (c-a) has a negative Y; draw strips
      // alternate, so flip any triangle that winds the other way (in game, wrong-way ones were holes).
      const p0 = ids.map(i => [V[i * 3], V[i * 3 + 1], V[i * 3 + 2]]);
      const ny = (p0[1][2] - p0[0][2]) * (p0[2][0] - p0[0][0]) - (p0[1][0] - p0[0][0]) * (p0[2][2] - p0[0][2]);
      if (ny > 0) { const t2 = ids[1]; ids[1] = ids[2]; ids[2] = t2; }
      Q.push(ids[0], ids[1], ids[2], ids[2], like.q4 ?? 0); P.push(like.surf); G.push(like.g[0], like.g[1]);
    }
  }
  if (!Q.length) throw new Error('no ground triangles found');
  if (V.length / 3 > 65535) throw new Error('too many collision vertices');
  const F = GSCFile.fromBuffer(S.buf), jobs = [];
  for (const g of D.staticGeoms) {
    let Vf, Qa, Pa, Ga;
    if (g === tg) { Vf = Float32Array.from(V); Qa = Uint16Array.from(Q); Pa = Uint8Array.from(P); Ga = Uint8Array.from(G); }
    else { Vf = Float32Array.of(0, -DROP, 0, 1, -DROP, 0, 0, -DROP, 1); Qa = Uint16Array.of(0, 1, 2, 2, g.Q[4]); Pa = Uint8Array.of(g.P[0]); Ga = Uint8Array.of(g.G[0], g.G[1]); }
    const nu = buildTree(Vf, Qa, Pa, Ga);
    const errs = checkTree(Vf, nu.Q, nu.nodes, nu.leaves);
    if (errs.length) throw new Error(`collision geom ${g.id}: ${errs[0]}`);
    jobs.push([g, { ...nu, V: Vf }]);
  }
  jobs.sort((a, b) => b[0].at.V - a[0].at.V);
  for (const [g, nu] of jobs) writeGeom(F, D, g, nu);
  return { bytes: F.build(), report: { draws, polys: Q.length / 5, verts: V.length / 3 } };
}

// Read the result back and check it: scene parses, every draw's strip is inside the index buffer, collision trees pass.
export function verifyCut(bytes) {
  const S = new GSCScene(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const errs = [];
  const cmd0 = S.ptr(S.T.DISP + 8 + 8);
  for (const d of S.draws) {
    const rec = S.ptr(cmd0 + 16 * d.cmd + 4);
    const start = S.u32(rec + 0x18), prims = S.u16(rec + 4);
    if (start + prims + 2 > S.ibs[d.ib ?? 0].size / 2) errs.push(`draw ${d.id} strip past index buffer ${d.ib ?? 0}`);
  }
  const D = readDNO2(S);
  for (const g of D?.staticGeoms || []) {
    const e = checkTree(g.V, g.Q, g.nodes, g.leaves);
    if (e.length) errs.push(`geom ${g.id}: ${e[0]}`);
  }
  return { draws: S.draws.length, collisionPolys: (D?.staticGeoms || []).map(g => g.nt), errors: errs.slice(0, 20) };
}
