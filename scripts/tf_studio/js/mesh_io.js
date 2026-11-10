// Level meshes to and from Blender (.glb).
//
// Export: one scene object -> a .glb with one Blender object per draw, named "draw_<id>", textured (the DDS
// textures are decoded to PNG), in the object's own space (its instance matrix is the origin).
// Import: the edited .glb -> new vertices and triangle strips for those draws, written into a GSCFile:
//   - each draw keeps its draw record (the game only prepares records it already knows), so a mesh shared by
//     several draws (the same house placed many times) changes everywhere it is used;
//   - new vertices are appended to the draw's vertex buffer, the strip to index buffer 0, and the record's
//     prims (+4), base (+0x10), count (+0x14) and start (+0x18) point at them;
//   - every vertex starts as a copy of the nearest original vertex (keeps the format's unknown fields), then gets
//     the new position, normal, UV and (if the .glb has one) colour;
//   - the object's culling bounds (BNDS) and its instances' bounds are recomputed.
// Vertex formats (Tranquility 2): position f32 x3 at 0; normal (bit 0x08) 4 bytes x, y, z = (n + 1) * 127.5, 0;
// colour BGRA (0x7F = 1.0); UV f32 x2. Triangles: the record's strip (type 6), faces wound so that
// (b - a) x (c - a) points out.
// Blender/glTF is right-handed: Z is mirrored both ways and triangles are re-wound to match.
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { M4, stripToTriangles } from './formats.js';

// ------------------------------------------------------------------ DDS (DXT1 / DXT5) -> RGBA, top mip
export function decodeDDS(dds) {
  if (dds instanceof ArrayBuffer) dds = new Uint8Array(dds);
  const dv = new DataView(dds.buffer, dds.byteOffset, dds.byteLength);
  if (dds.length < 128 || dv.getUint32(0, true) !== 0x20534444) return null;
  const h = dv.getUint32(12, true), w = dv.getUint32(16, true);
  const cc = String.fromCharCode(dds[84], dds[85], dds[86], dds[87]);
  if (cc !== 'DXT1' && cc !== 'DXT3' && cc !== 'DXT5') return null;
  const bs = cc === 'DXT1' ? 8 : 16, out = new Uint8ClampedArray(w * h * 4);
  const bw = Math.max(1, (w + 3) >> 2), bh = Math.max(1, (h + 3) >> 2);
  const c565 = v => [((v >> 11) & 31) * 255 / 31, ((v >> 5) & 63) * 255 / 63, (v & 31) * 255 / 31];
  let p = 128;
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++, p += bs) {
    if (p + bs > dds.length) return null;
    const alpha = new Uint8Array(16).fill(255);
    let cp = p;
    if (cc === 'DXT5') {
      const a0 = dds[p], a1 = dds[p + 1], pal = [a0, a1];
      if (a0 > a1) for (let i = 1; i < 7; i++) pal.push(((7 - i) * a0 + i * a1) / 7);
      else { for (let i = 1; i < 5; i++) pal.push(((5 - i) * a0 + i * a1) / 5); pal.push(0, 255); }
      let bits = 0n;
      for (let i = 0; i < 6; i++) bits |= BigInt(dds[p + 2 + i]) << BigInt(8 * i);
      for (let i = 0; i < 16; i++) alpha[i] = pal[Number((bits >> BigInt(3 * i)) & 7n)];
      cp = p + 8;
    } else if (cc === 'DXT3') {
      for (let i = 0; i < 16; i++) alpha[i] = ((dds[p + (i >> 1)] >> ((i & 1) * 4)) & 15) * 17;
      cp = p + 8;
    }
    const v0 = dds[cp] | (dds[cp + 1] << 8), v1 = dds[cp + 2] | (dds[cp + 3] << 8);
    const c0 = c565(v0), c1 = c565(v1), pal = [c0, c1];
    if (v0 > v1 || cc !== 'DXT1') { pal.push(c0.map((x, i) => (2 * x + c1[i]) / 3), c0.map((x, i) => (x + 2 * c1[i]) / 3)); }
    else { pal.push(c0.map((x, i) => (x + c1[i]) / 2), [0, 0, 0]); }
    const idx = dds[cp + 4] | (dds[cp + 5] << 8) | (dds[cp + 6] << 16) | (dds[cp + 7] << 24);
    for (let i = 0; i < 16; i++) {
      const x = bx * 4 + (i & 3), y = by * 4 + (i >> 2);
      if (x >= w || y >= h) continue;
      const k = (idx >>> (2 * i)) & 3, o = (y * w + x) * 4, c = pal[k];
      out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2];
      out[o + 3] = cc === 'DXT1' ? (v0 <= v1 && k === 3 ? 0 : 255) : alpha[i];
    }
  }
  return { w, h, rgba: out, alpha: cc !== 'DXT1' };
}

// The object's origin for Blender: its instance's matrix when it has exactly one, else its first draw's matrix.
export function objectPivot(S, o) {
  const so = S.objects[o];
  if (so?.instances?.length === 1) return S.instances[so.instances[0]].matrix;
  const d = so?.draws.map(i => S.draws[i]).find(d => d.matrix);
  return d ? d.matrix : M4.identity();
}

const rot3 = (m, x, y, z) => [x * m[0] + y * m[4] + z * m[8], x * m[1] + y * m[5] + z * m[9], x * m[2] + y * m[6] + z * m[10]];
const xf = (m, x, y, z) => [x * m[0] + y * m[4] + z * m[8] + m[12], x * m[1] + y * m[5] + z * m[9] + m[13], x * m[2] + y * m[6] + z * m[10] + m[14]];

// ------------------------------------------------------------------ export
export async function exportObjectGLB(S, o, { name = `object_${o}`, level = '' } = {}) {
  const so = S.objects[o];
  if (!so) throw new Error(`no object ${o}`);
  const pivot = objectPivot(S, o), inv = M4.invert3x4(pivot);
  const root = new THREE.Group();
  root.name = name;
  root.userData = { tfstudio: { level, object: o, draws: so.draws, pivot: Array.from(pivot) } };
  const mats = new Map();
  const material = (tex, alpha) => {
    const key = `${tex}`;
    if (mats.has(key)) return mats.get(key);
    const m = new THREE.MeshStandardMaterial({ name: tex >= 0 ? `tex${tex}` : 'untextured', roughness: 1, metalness: 0 });
    const t = tex >= 0 ? S.textures[tex] : null;
    const img = t && t.size && !t.cube ? decodeDDS(S.dds(t)) : null;
    if (img) {
      const cv = document.createElement('canvas'); cv.width = img.w; cv.height = img.h;
      cv.getContext('2d').putImageData(new ImageData(img.rgba, img.w, img.h), 0, 0);
      const ct = new THREE.CanvasTexture(cv);
      ct.flipY = false; // D3D and glTF both put v = 0 at the top of the image
      ct.colorSpace = THREE.SRGBColorSpace;
      ct.wrapS = ct.wrapT = THREE.RepeatWrapping;
      m.map = ct;
      if (img.alpha) m.alphaTest = 0.5;
    }
    mats.set(key, m);
    return m;
  };
  for (const di of so.draws) {
    const d = S.draws[di], L = S.layout(d), n = d.count;
    const world = d.matrix || M4.identity();
    const P = new Float32Array(n * 3), N = new Float32Array(n * 3), UV = new Float32Array(n * 2), C = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const o2 = S.vertexOffset(d, i);
      const lx = S.dv.getFloat32(o2, true), ly = S.dv.getFloat32(o2 + 4, true), lz = S.dv.getFloat32(o2 + 8, true);
      const w = xf(world, lx, ly, lz), p = xf(inv, ...w);
      P.set([p[0], p[1], -p[2]], i * 3);
      if (L.nrm >= 0) {
        const b = S.u8.subarray(o2 + L.nrm, o2 + L.nrm + 3);
        const nl = [b[0] / 127.5 - 1, b[1] / 127.5 - 1, b[2] / 127.5 - 1];
        const nw = rot3(inv, ...rot3(world, ...nl)), len = Math.hypot(...nw) || 1;
        N.set([nw[0] / len, nw[1] / len, -nw[2] / len], i * 3);
      }
      if (L.uv >= 0) UV.set([S.dv.getFloat32(o2 + L.uv, true), S.dv.getFloat32(o2 + L.uv + 4, true)], i * 2);
      if (L.col >= 0) C.set([S.u8[o2 + L.col + 2] / 255, S.u8[o2 + L.col + 1] / 255, S.u8[o2 + L.col] / 255, S.u8[o2 + L.col + 3] / 255], i * 4);
    }
    const t = stripToTriangles(S.ib(0), d.start, d.prims, n);
    const idx = new Uint32Array(t.length);
    for (let k = 0; k < t.length; k += 3) { idx[k] = t[k]; idx[k + 1] = t[k + 2]; idx[k + 2] = t[k + 1]; } // mirrored: re-wind
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(P, 3));
    if (L.nrm >= 0) g.setAttribute('normal', new THREE.BufferAttribute(N, 3)); else { g.setIndex(new THREE.BufferAttribute(idx, 1)); g.computeVertexNormals(); }
    if (L.uv >= 0) g.setAttribute('uv', new THREE.BufferAttribute(UV, 2));
    // raw colour bytes / 255 (0x7F = 1.0 in game), so they come back exactly
    if (L.col >= 0) g.setAttribute('color', new THREE.BufferAttribute(C, 4));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    const tex = S.materials[d.material]?.tex ?? -1;
    const mesh = new THREE.Mesh(g, material(tex));
    mesh.name = `draw_${di}`;
    root.add(mesh);
  }
  const scene = new THREE.Scene();
  scene.add(root);
  return new GLTFExporter().parseAsync(scene, { binary: true });
}

// ------------------------------------------------------------------ import
// -> { parts: Map(drawId -> {P, N, UV, C, tris} in world game space), extras: [{material name, geometry}], notes }
export async function readEditedGLB(buffer, S, o) {
  const gltf = await new GLTFLoader().parseAsync(buffer, '');
  const so = S.objects[o];
  const pivot = objectPivot(S, o);
  const mine = new Set(so.draws);
  const parts = new Map(), extras = [], notes = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse(m => {
    if (!m.isMesh) return;
    let id = null;
    for (let x = m; x && id == null; x = x.parent) { const k = /draw_(\d+)/.exec(x.name || ''); if (k) id = +k[1]; }
    const geo = readGeometry(m, pivot);
    if (!geo.tris.length) return;
    if (id != null && mine.has(id)) {
      if (!parts.has(id)) parts.set(id, geo); else parts.set(id, mergeGeo(parts.get(id), geo));
    } else if (id != null) notes.push(`draw_${id} is not part of this object: skipped`);
    else extras.push({ name: m.name, material: [].concat(m.material)[0]?.name || '', geo });
  });
  // new pieces (no draw_ name): join them to a draw of this object that uses the same texture ("tex<i>" material)
  for (const e of extras) {
    const t = /tex(\d+)/.exec(e.material);
    const host = t && so.draws.find(di => (S.materials[S.draws[di].material]?.tex ?? -1) === +t[1]);
    if (host == null) { notes.push(`"${e.name}" has no draw_ name and no tex<n> material of this object: skipped`); continue; }
    const base = parts.get(host) || drawWorldGeometry(S, S.draws[host]);
    parts.set(host, mergeGeo(base, e.geo));
    notes.push(`"${e.name}" joined to draw_${host} (same texture)`);
  }
  const missing = so.draws.filter(di => !parts.has(di));
  if (missing.length) notes.push(`${missing.length} part(s) not in the file, left as they are: draw_${missing.slice(0, 5).join(', draw_')}`);
  return { parts, notes };
}

function readGeometry(m, pivot) {
  const g = m.geometry, P0 = g.attributes.position, n = P0.count;
  const N0 = g.attributes.normal, UV0 = g.attributes.uv, C0 = g.attributes.color;
  const mw = m.matrixWorld, nm = new THREE.Matrix3().getNormalMatrix(mw);
  const P = new Float32Array(n * 3), N = new Float32Array(n * 3), UV = new Float32Array(n * 2), C = C0 ? new Float32Array(n * 4) : null;
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(P0, i).applyMatrix4(mw);
    const w = xf(pivot, v.x, v.y, -v.z); // Blender/glTF -> object space -> game world
    P.set(w, i * 3);
    if (N0) {
      v.fromBufferAttribute(N0, i).applyMatrix3(nm);
      const r = rot3(pivot, v.x, v.y, -v.z), len = Math.hypot(...r) || 1;
      N.set([r[0] / len, r[1] / len, r[2] / len], i * 3);
    }
    if (UV0) UV.set([UV0.getX(i), UV0.getY(i)], i * 2);
    if (C) C.set([C0.getX(i), C0.getY(i), C0.getZ(i), C0.itemSize > 3 ? C0.getW(i) : 0.5], i * 4);
  }
  const I = g.index ? g.index.array : Array.from({ length: n }, (_, i) => i);
  const tris = [];
  for (let k = 0; k + 2 < I.length; k += 3) tris.push(I[k], I[k + 2], I[k + 1]); // mirrored back: re-wind
  return { P, N: N0 ? N : null, UV: UV0 ? UV : null, C, tris };
}

// A side without normals, UVs or colours is filled with NaN: applyMeshEdits then computes the normal from the
// faces, uses UV 0, and takes the part's average original colour.
function mergeGeo(a, b) {
  const na = a.P.length / 3, nb = b.P.length / 3;
  const cat = (x, y, k) => { const o = new Float32Array((na + nb) * k).fill(NaN); if (x) o.set(x); if (y) o.set(y, na * k); return o; };
  return {
    P: cat(a.P, b.P, 3), N: a.N || b.N ? cat(a.N, b.N, 3) : null, UV: a.UV || b.UV ? cat(a.UV, b.UV, 2) : null,
    C: a.C || b.C ? cat(a.C, b.C, 4) : null, tris: [...a.tris, ...b.tris.map(t => t + na)],
  };
}

// a draw's current mesh in world space (for joining new pieces to an untouched draw)
function drawWorldGeometry(S, d) {
  const L = S.layout(d), n = d.count, world = d.matrix || M4.identity();
  const P = new Float32Array(n * 3), UV = new Float32Array(n * 2), N = L.nrm >= 0 ? new Float32Array(n * 3) : null;
  for (let i = 0; i < n; i++) {
    const o = S.vertexOffset(d, i);
    P.set(xf(world, S.dv.getFloat32(o, true), S.dv.getFloat32(o + 4, true), S.dv.getFloat32(o + 8, true)), i * 3);
    if (L.uv >= 0) UV.set([S.dv.getFloat32(o + L.uv, true), S.dv.getFloat32(o + L.uv + 4, true)], i * 2);
    if (N) { const b = S.u8.subarray(o + L.nrm, o + L.nrm + 3); const r = rot3(world, b[0] / 127.5 - 1, b[1] / 127.5 - 1, b[2] / 127.5 - 1); const l = Math.hypot(...r) || 1; N.set(r.map(x => x / l), i * 3); }
  }
  return { P, N, UV, C: null, tris: stripToTriangles(S.ib(0), d.start, d.prims, n) };
}

// triangle list -> one strip joined with degenerate triangles; each triangle starts on an even position so the
// strip's odd/even flip leaves its winding as given
export function trianglesToStrip(tris) {
  const s = [];
  for (let k = 0; k < tris.length; k += 3) {
    const a = tris[k], b = tris[k + 1], c = tris[k + 2];
    if (a === b || b === c || a === c) continue;
    if (s.length) { s.push(s[s.length - 1], a); if (s.length & 1) s.push(a); }
    s.push(a, b, c);
  }
  return s;
}

// ------------------------------------------------------------------ write into the file
// edits: Map(drawId -> world-space geometry from readEditedGLB). F: GSCFile of S's buffer. Returns a report.
export function applyMeshEdits(F, S, edits) {
  const DB = S.T.DISP + 8;
  const disp = () => { const b = F.body('DISP'); return new DataView(b.buffer, b.byteOffset, b.length); };
  // draws that share a record share the mesh: one write per record
  const byRec = new Map();
  for (const [di, geo] of edits) {
    const d = S.draws[di];
    if (byRec.has(d.cmdRec)) continue;
    byRec.set(d.cmdRec, { d, geo });
  }
  const users = new Map(); // record -> every draw using it
  for (const d of S.draws) if (byRec.has(d.cmdRec)) { if (!users.has(d.cmdRec)) users.set(d.cmdRec, []); users.get(d.cmdRec).push(d); }
  const newLocal = new Map(); // record -> new local positions
  let verts = 0, tris = 0;
  for (const [rec, { d, geo }] of byRec) {
    const L = S.layout(d), stride = d.stride, n = geo.P.length / 3;
    if (n > 65535) throw new Error(`draw_${d.id}: ${n} vertices; one part can have at most 65,535`);
    const inv = d.matrix ? M4.invert3x4(d.matrix) : M4.identity();
    // original vertices (local) for templates
    const P0 = S.readPositions(d);
    // stand-ins for what the .glb lacks: face normals, and the part's average colour
    const faceN = new Float32Array(n * 3);
    for (let k = 0; k < geo.tris.length; k += 3) {
      const [a, b, c] = [geo.tris[k], geo.tris[k + 1], geo.tris[k + 2]];
      const u = [0, 1, 2].map(q => geo.P[b * 3 + q] - geo.P[a * 3 + q]), w = [0, 1, 2].map(q => geo.P[c * 3 + q] - geo.P[a * 3 + q]);
      const fn = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      for (const v of [a, b, c]) for (let q = 0; q < 3; q++) faceN[v * 3 + q] += fn[q];
    }
    const avgCol = [0, 0, 0, 0];
    if (L.col >= 0 && d.count) {
      for (let j = 0; j < d.count; j++) { const o = S.vertexOffset(d, j) + L.col; for (let q = 0; q < 4; q++) avgCol[q] += S.u8[o + q]; }
      for (let q = 0; q < 4; q++) avgCol[q] = Math.round(avgCol[q] / d.count);
    }
    const out = new Uint8Array(n * stride), odv = new DataView(out.buffer);
    const loc = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const p = xf(inv, geo.P[i * 3], geo.P[i * 3 + 1], geo.P[i * 3 + 2]);
      loc.set(p, i * 3);
      let best = 0, bd = Infinity;
      for (let j = 0; j < d.count; j++) { const dx = P0[j * 3] - p[0], dy = P0[j * 3 + 1] - p[1], dz = P0[j * 3 + 2] - p[2], q = dx * dx + dy * dy + dz * dz; if (q < bd) { bd = q; best = j; } }
      const src = S.vertexOffset(d, best);
      out.set(S.u8.subarray(src, src + stride), i * stride);
      const o = i * stride;
      odv.setFloat32(o, p[0], true); odv.setFloat32(o + 4, p[1], true); odv.setFloat32(o + 8, p[2], true);
      if (L.nrm >= 0) {
        const src = geo.N && !isNaN(geo.N[i * 3]) ? geo.N : faceN;
        const r = rot3(inv, src[i * 3], src[i * 3 + 1], src[i * 3 + 2]), l = Math.hypot(...r) || 1;
        for (let k = 0; k < 3; k++) out[o + L.nrm + k] = Math.max(0, Math.min(255, Math.round((r[k] / l + 1) * 127.5)));
      }
      if (L.uv >= 0) {
        const ok = geo.UV && !isNaN(geo.UV[i * 2]);
        odv.setFloat32(o + L.uv, ok ? geo.UV[i * 2] : 0, true); odv.setFloat32(o + L.uv + 4, ok ? geo.UV[i * 2 + 1] : 0, true);
      }
      if (L.col >= 0) {
        if (geo.C && !isNaN(geo.C[i * 4])) {
          const c = k => Math.max(0, Math.min(255, Math.round(geo.C[i * 4 + k] * 255)));
          out[o + L.col] = c(2); out[o + L.col + 1] = c(1); out[o + L.col + 2] = c(0); out[o + L.col + 3] = c(3);
        } else for (let q = 0; q < 4; q++) out[o + L.col + q] = avgCol[q];
      }
    }
    const strip = trianglesToStrip(geo.tris);
    if (strip.length < 3) throw new Error(`draw_${d.id}: no triangles left (delete the part in Blender only if you also hide it here)`);
    if (strip.length - 2 > 65535) throw new Error(`draw_${d.id}: ${geo.tris.length / 3} triangles is too many for one part`);
    // append vertices (aligned to the stride) and the strip
    const vb = F.vbs[d.vb];
    const base = Math.ceil(vb.length / stride);
    const nvb = new Uint8Array(base * stride + out.length);
    nvb.set(vb); nvb.set(out, base * stride);
    F.vbs[d.vb] = nvb;
    const ib = F.ibs[0], start = ib.length >> 1;
    const nib = new Uint8Array(ib.length + strip.length * 2), idv = new DataView(nib.buffer);
    nib.set(ib);
    strip.forEach((v, k) => idv.setUint16(ib.length + 2 * k, v, true));
    F.ibs[0] = nib;
    const r = rec - DB, dv = disp();
    dv.setUint16(r + 4, strip.length - 2, true);
    dv.setUint32(r + 0x10, base, true);
    dv.setUint32(r + 0x14, n, true);
    dv.setUint32(r + 0x18, start, true);
    newLocal.set(rec, loc);
    verts += n; tris += geo.tris.length / 3;
  }
  // bounds of every object that uses a changed mesh
  const objs = new Set();
  for (const ds of users.values()) for (const d of ds) objs.add(d.object);
  const V = disp().getInt32(0x38, true);
  const bnds = F.body('BNDS'), bdv = new DataView(bnds.buffer, bnds.byteOffset, bnds.length);
  const boxOf = o => {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const di of S.objects[o].draws) {
      const d = S.draws[di], world = d.matrix || M4.identity();
      const P = newLocal.get(d.cmdRec) || S.readPositions(d);
      for (let i = 0; i < P.length; i += 3) { const w = xf(world, P[i], P[i + 1], P[i + 2]); for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], w[a]); mx[a] = Math.max(mx[a], w[a]); } }
    }
    return { mn, mx };
  };
  for (const o of objs) {
    const { mn, mx } = boxOf(o);
    if (!isFinite(mn[0])) continue;
    const e = [0, 1, 2].map(a => (mx[a] - mn[a]) / 2), c = [0, 1, 2].map(a => (mn[a] + mx[a]) / 2);
    if (o < V && 8 + 32 * o + 32 <= bnds.length) {
      const at = 8 + 32 * o;
      for (let a = 0; a < 3; a++) { bdv.setFloat32(at + 4 * a, c[a], true); bdv.setFloat32(at + 16 + 4 * a, e[a], true); }
      bdv.setFloat32(at + 12, Math.hypot(...e), true);
    }
    for (const ii of S.objects[o].instances || []) {
      const at = S.instances[ii].at - DB, dv = disp();
      for (let a = 0; a < 3; a++) { dv.setFloat32(at + 0x80 + 4 * a, mn[a], true); dv.setFloat32(at + 0x90 + 4 * a, mx[a], true); dv.setFloat32(at + 0xA0 + 4 * a, c[a], true); }
      dv.setFloat32(at + 0xAC, Math.hypot(...e), true);
    }
  }
  const sharedWith = [];
  for (const [rec, ds] of users) {
    const own = new Set(ds.map(d => d.object));
    if (own.size > 1) sharedWith.push(...[...own].filter(x => !ds.some(d => edits.has(d.id) && d.object === x)));
  }
  return { parts: byRec.size, verts, tris, objects: [...objs], alsoChanged: [...new Set(sharedWith)] };
}
