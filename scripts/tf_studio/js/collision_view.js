// Collision (DNO2) in the level editor: overlay, which collision belongs to a scene object, and making the
// world collision follow moved / hidden objects when the level is saved.
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { M4, transformPoints, stripToTriangles } from './formats.js';
import { readDNO2, buildTree, checkTree, writeGeom, polyTriangles } from './dno2.js';

// A world collision polygon belongs to an object when all its corners are within TOL of the object's surface, or
// within LOOSE of it, inside its box, and not flat ground at its base. (Collision walls are a simplified shell that
// can sit ~1.5 units off the drawn walls; the ground under a building sits about as close.)
const TOL = 0.35, LOOSE = 2.0, GROUND_NY = 0.8, GROUND_ABOVE_BASE = 1.5;
const DROP = 1000;         // hidden objects with a physics body: the body is moved this far down
// surface colours (by the surface table's type byte); kept away from the orange/red used for selections
const SURF_COLORS = [0x4caf50, 0x2196f3, 0x9c27b0, 0x00bcd4, 0xcddc39, 0x795548, 0x607d8b, 0x3f51b5, 0x8bc34a, 0x009688, 0x673ab7, 0x9e9e9e];

export class CollisionLayer {
  constructor(view) {
    this.view = view;
    this.group = null;
    this.highlight = null;
  }

  // Called after a level loads. Keeps the load-time collision and instance matrices: every save rebuilds from these.
  load(S) {
    this.dispose();
    this.D0 = null; this.claims = new Map(); this.error = null;
    try { this.D0 = readDNO2(S); } catch (e) { this.error = e.message; console.warn('DNO2', e); }
    this.inst0 = S.instances.map(i => i.matrix.slice());
    this.inst20 = S.instances.map(i => i.matrix2.slice());
    this.rebuilt = false;
  }
  get available() { return !!this.D0 && this.D0.geoms.length > 0; }
  summary() {
    const D = this.D0; if (!D) return this.error ? `unreadable (${this.error})` : 'none';
    const wp = D.staticGeoms.reduce((n, g) => n + g.nt, 0);
    return `${wp.toLocaleString()} world polygons, ${D.bodies.length} bodies, ${D.shapes.length} shapes`;
  }
  dispose() {
    for (const o of [this.group, this.highlight]) if (o) { this.view.vp.root.remove(o); o.traverse(x => { x.geometry?.dispose(); x.material?.dispose?.(); }); }
    this.group = this.highlight = null;
  }

  // ---------------------------------------------------------------- overlay
  setVisible(on) {
    if (on && !this.group && this.available) this.buildOverlay();
    if (this.group) this.group.visible = on;
    this.updateHighlight();
  }
  get visible() { return !!this.group?.visible; }

  shapeMatrix(s, D = this.D0) { // world matrix of a body or placed shape (row form); null for world-space geoms
    let M = s.xf >= 0 && D.xforms[s.xf] ? D.xforms[s.xf] : null;
    if (s.body >= 0) {
      const ins = this.view.gsc.instances[D.bodies[s.body]?.instance];
      if (!ins) return M || M4.identity();
      M = M ? M4.mul(M, ins.matrix) : ins.matrix;
    }
    return M;
  }

  buildOverlay() {
    // draw the collision as it is in the current file (after a save it includes the edits)
    let D = this.D0;
    try { D = readDNO2(this.view.gsc) || D; } catch { }
    const g = new THREE.Group();
    const mat = (color, vc) => new THREE.MeshLambertMaterial({ color, vertexColors: vc, transparent: true, opacity: 0.5, depthWrite: false,
      side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    // world geoms, coloured by surface type
    for (const geo of D.staticGeoms) {
      const tris = polyTriangles(geo.Q), P = new Float32Array(tris.length * 3), C = new Float32Array(tris.length * 3);
      const col = new THREE.Color();
      let t = 0;
      for (let p = 0; p < geo.nt; p++) {
        const n = geo.Q[p * 5 + 3] !== geo.Q[p * 5 + 2] && geo.Q[p * 5 + 3] !== geo.Q[p * 5] ? 6 : 3;
        col.setHex(SURF_COLORS[geo.surf[geo.P[p] * 4] % SURF_COLORS.length]);
        for (let k = 0; k < n; k++, t++) { const v = tris[t]; P.set(geo.V.subarray(v * 3, v * 3 + 3), t * 3); C[t * 3] = col.r; C[t * 3 + 1] = col.g; C[t * 3 + 2] = col.b; }
      }
      const bg = new THREE.BufferGeometry();
      bg.setAttribute('position', new THREE.BufferAttribute(P, 3)); bg.setAttribute('color', new THREE.BufferAttribute(C, 3));
      bg.computeVertexNormals();
      g.add(new THREE.Mesh(bg, mat(0xffffff, true)));
    }
    // bodies and placed pieces
    const bodyP = [], placedP = [], prims = [];
    for (const s of D.shapes) {
      if (s.type === 5) {
        const geo = D.geoms[s.geom]; if (!geo || D.staticGeoms.includes(geo)) continue;
        const M = this.shapeMatrix(s, D), W = transformPoints(geo.V.slice(), M);
        for (const v of polyTriangles(geo.Q)) (s.body >= 0 ? bodyP : placedP).push(W[v * 3], W[v * 3 + 1], W[v * 3 + 2]);
      } else if (s.type === 2 || s.type === 3) prims.push(s);
    }
    for (const [arr, color] of [[bodyP, 0x42a5f5], [placedP, 0x26c6da]]) if (arr.length) {
      const bg = new THREE.BufferGeometry(); bg.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3)); bg.computeVertexNormals();
      g.add(new THREE.Mesh(bg, mat(color, false)));
    }
    // primitive shapes on props (type 3 = box with half sizes; type 2 drawn as an upright cylinder, approximate)
    const pm = mat(0xffca28, false);
    for (const s of prims) {
      const M = this.shapeMatrix(s, D); if (!M) continue;
      const [x, y, z] = s.dims.map(v => Math.max(Math.abs(v) || 0, 0.05));
      const geo = s.type === 3 ? new THREE.BoxGeometry(2 * x, 2 * y, 2 * z) : new THREE.CylinderGeometry(Math.max(x, z), Math.max(x, z), 2 * y, 10);
      const m = new THREE.Mesh(geo, pm);
      m.matrixAutoUpdate = false; m.matrix.fromArray(M); // row-form array == three's column-major
      g.add(m);
    }
    g.renderOrder = 5;
    this.group = g;
    this.view.vp.root.add(g);
  }

  // ---------------------------------------------------------------- collision that belongs to an object
  // { world: [{geom, polys: Int32Array}], bodies: [body index], polyCount }
  claimsOf(o) {
    if (this.claims.has(o)) return this.claims.get(o);
    const res = { world: [], bodies: [], polyCount: 0 };
    const D = this.D0, S = this.view.gsc, obj = S.objects[o];
    if (!D || !obj) return res;
    const insts = new Set(obj.instances || []);
    D.bodies.forEach((b, k) => { if (insts.has(b.instance)) res.bodies.push(k); });
    // the object's load-time surface
    const pos = [], idx = [];
    for (const di of obj.draws) {
      const d = S.draws[di];
      const M = this.view.origMats.get(di) || d.matrix;
      const P = S.readPositions(d); if (M) transformPoints(P, M);
      const base = pos.length / 3;
      for (let i = 0; i < P.length; i++) pos.push(P[i]);
      for (const t of stripToTriangles(S.ib(0), d.start, d.prims, d.count)) idx.push(t + base);
    }
    if (idx.length) {
      const bg = new THREE.BufferGeometry();
      bg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); bg.setIndex(idx);
      const bvh = new MeshBVH(bg);
      bg.computeBoundingBox();
      const ob = bg.boundingBox, box = ob.clone().expandByScalar(LOOSE), tight = ob.clone().expandByScalar(TOL);
      const v = new THREE.Vector3(), hit = {}, c = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
      const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
      for (const geo of D.staticGeoms) {
        const out = [];
        for (let p = 0; p < geo.nt; p++) {
          let inBox = true, inTight = true, far = 0, ymax = -Infinity;
          for (let k = 0; k < 4 && inBox; k++) {
            const i = geo.Q[p * 5 + k] * 3; c[k].set(geo.V[i], geo.V[i + 1], geo.V[i + 2]);
            inBox = box.containsPoint(c[k]); inTight = inTight && tight.containsPoint(c[k]); ymax = Math.max(ymax, c[k].y);
          }
          if (!inBox) continue;
          for (let k = 0; k < 4 && far <= LOOSE; k++) {
            const h = bvh.closestPointToPoint(c[k], hit, 0, LOOSE + 1e-3);
            far = Math.max(far, h ? h.distance : Infinity);
          }
          if (far <= TOL && inTight) { out.push(p); continue; }
          if (far > LOOSE) continue;
          const n = e1.subVectors(c[1], c[0]).cross(e2.subVectors(c[2], c[0]));
          const flat = n.lengthSq() > 0 && Math.abs(n.normalize().y) > GROUND_NY;
          if (flat && ymax <= ob.min.y + GROUND_ABOVE_BASE) continue; // ground at the object's base
          out.push(p);
        }
        if (out.length) { res.world.push({ geom: geo.id, polys: Int32Array.from(out) }); res.polyCount += out.length; }
      }
      bg.dispose(); bvh.geometry?.dispose?.();
    }
    this.claims.set(o, res);
    return res;
  }

  // edit of object o since load: { T (row-form, load -> now), hidden } or null if unchanged
  editOf(o) {
    const V = this.view, S = V.gsc, obj = S.objects[o];
    if (V.hidden.has(o)) return { T: null, hidden: true };
    for (const di of obj.draws) {
      const M0 = V.origMats.get(di), d = S.draws[di];
      if (!M0 || !d.matrix) continue;
      const T = M4.mul(M4.invert3x4(M0), d.matrix);
      const I = M4.identity();
      if (T.some((x, k) => Math.abs(x - I[k]) > 1e-6)) return { T, hidden: false };
      return null;
    }
    return null;
  }

  // orange copy of the selected object's collision, where it will be after saving
  updateHighlight() {
    if (this.highlight) { this.view.vp.root.remove(this.highlight); this.highlight.traverse(x => { x.geometry?.dispose(); }); this.highlight = null; }
    const s = this.view.sel;
    if (!this.visible || !s || (s.kind !== 'object' && s.kind !== 'copy')) return;
    const cp = s.kind === 'copy' ? this.view.copies[s.i] : null;
    const c = this.claimsOf(cp ? cp.src : s.i), e = cp ? { T: cp.T } : this.editOf(s.i), D = this.D0;
    const pts = [];
    for (const { geom, polys } of c.world) {
      const geo = D.geoms[geom];
      for (const p of polys) {
        const q = geo.Q.subarray(p * 5, p * 5 + 4), tri = q[3] !== q[2] && q[3] !== q[0] ? [0, 1, 2, 0, 2, 3] : [0, 1, 2];
        for (const k of tri) pts.push(geo.V[q[k] * 3], geo.V[q[k] * 3 + 1], geo.V[q[k] * 3 + 2]);
      }
    }
    if (!pts.length || e?.hidden) return;
    const P = Float32Array.from(pts); if (e?.T) transformPoints(P, e.T);
    const E = new Float32Array(P.length * 2); // triangle edges as line segments
    for (let t = 0, o = 0; t < P.length; t += 9) for (const [a, b] of [[0, 3], [3, 6], [6, 0]]) { E.set(P.subarray(t + a, t + a + 3), o); E.set(P.subarray(t + b, t + b + 3), o + 3); o += 6; }
    const bg = new THREE.BufferGeometry(); bg.setAttribute('position', new THREE.BufferAttribute(E, 3));
    this.highlight = new THREE.LineSegments(bg, new THREE.LineBasicMaterial({ color: 0xff3d00, depthTest: false, transparent: true, opacity: 0.95 }));
    this.highlight.renderOrder = 21;
    this.view.vp.root.add(this.highlight);
  }

  // ---------------------------------------------------------------- saving
  // Writes instance matrices into S (current scene) for every edited object. Returns the edited object list.
  applyInstanceMatrices(S) {
    const V = this.view, edited = [];
    S.instances.forEach((ins, i) => { const m0 = this.inst0[i]; if (m0) S.writeInstanceMatrix(ins, m0, this.inst20[i]); });
    for (let o = 0; o < S.objects.length; o++) {
      const e = this.editOf(o); if (!e) continue;
      edited.push([o, e]);
      for (const i of S.objects[o].instances || []) {
        const m0 = this.inst0[i], m20 = this.inst20[i];
        const same = m20.every((x, k) => Math.abs(x - m0[k]) < 1e-4); // +40 mirrors +00: keep it that way
        if (e.hidden) {
          if (this.D0?.bodies.some(b => b.instance === i)) { const m = m0.slice(); m[13] -= DROP; S.writeInstanceMatrix(S.instances[i], m, same ? m : null); }
        } else { const m = M4.mul(m0, e.T); S.writeInstanceMatrix(S.instances[i], m, same ? m : null); }
      }
    }
    return edited;
  }

  // Rebuild the world collision from the load-time copy plus edits. F = GSCFile of the current buffer,
  // Dcur = readDNO2 of the current buffer (for offsets). Returns a short report, or null when nothing to do.
  // copies: [{ src, T }] new objects; each gets a copy of its source's world collision, moved by T.
  rebuildWorld(F, Dcur, edited, copies = []) {
    const D = this.D0;
    if (!D?.staticGeoms.length) return null;
    const extra = copies.map(cp => ({ T: cp.T, world: this.claimsOf(cp.src).world })).filter(x => x.world.length);
    // which polygons each edited object owns (first owner wins)
    const owner = new Map(); // geom -> Int32Array poly -> edited index (-1 none)
    let claimed = 0;
    edited.forEach(([o], ei) => {
      for (const { geom, polys } of this.claimsOf(o).world) {
        if (!owner.has(geom)) owner.set(geom, new Int32Array(D.geoms[geom].nt).fill(-1));
        const ow = owner.get(geom);
        for (const p of polys) if (ow[p] < 0) { ow[p] = ei; claimed++; }
      }
    });
    if (!claimed && !extra.length && !this.rebuilt) return null;
    const report = { moved: 0, removed: 0, added: 0, polys: 0 };
    const jobs = [];
    for (const g0 of D.staticGeoms) {
      const ow = owner.get(g0.id);
      const V = Array.from(g0.V), Q = [], P = [], G = [];
      const remap = new Map();
      for (let p = 0; p < g0.nt; p++) {
        const ei = ow ? ow[p] : -1;
        const e = ei >= 0 ? edited[ei][1] : null;
        if (e?.hidden) { report.removed++; continue; }
        const q = Array.from(g0.Q.subarray(p * 5, p * 5 + 5));
        if (e?.T) {
          for (let k = 0; k < 4; k++) {
            const key = ei * 65536 + q[k];
            if (!remap.has(key)) {
              const w = transformPoints(Float32Array.from(g0.V.subarray(q[k] * 3, q[k] * 3 + 3)), e.T);
              remap.set(key, V.length / 3); V.push(w[0], w[1], w[2]);
            }
            q[k] = remap.get(key);
          }
          report.moved++;
        }
        Q.push(...q); P.push(g0.P[p]); G.push(g0.G[p * 2], g0.G[p * 2 + 1]);
      }
      // copies of claimed polygons for new objects (each with its own vertices)
      for (const x of extra) for (const { geom, polys } of x.world) {
        if (geom !== g0.id) continue;
        const local = new Map();
        for (const p of polys) {
          const q = Array.from(g0.Q.subarray(p * 5, p * 5 + 5));
          for (let k = 0; k < 4; k++) {
            if (!local.has(q[k])) {
              const w = transformPoints(Float32Array.from(g0.V.subarray(q[k] * 3, q[k] * 3 + 3)), x.T);
              local.set(q[k], V.length / 3); V.push(w[0], w[1], w[2]);
            }
            q[k] = local.get(q[k]);
          }
          Q.push(...q); P.push(g0.P[p]); G.push(g0.G[p * 2], g0.G[p * 2 + 1]);
          report.added++;
        }
      }
      if (V.length / 3 > 65535) throw new Error('too many collision vertices after the edit');
      const nu = buildTree(Float32Array.from(V), Uint16Array.from(Q), Uint8Array.from(P), Uint8Array.from(G));
      const Vf = Float32Array.from(V);
      const errs = checkTree(Vf, nu.Q, nu.nodes, nu.leaves);
      if (errs.length) throw new Error('collision tree check failed: ' + errs[0]);
      report.polys += nu.Q.length / 5;
      jobs.push([Dcur.geoms[g0.id], { ...nu, V: Vf }]);
    }
    jobs.sort((a, b) => b[0].at.V - a[0].at.V);
    for (const [g, nu] of jobs) writeGeom(F, Dcur, g, nu);
    this.rebuilt = true;
    return report;
  }
}
