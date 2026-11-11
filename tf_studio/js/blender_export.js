// Characters, animations and whole cutscenes to Blender (.glb).
//
// glTF is right-handed and the game is left-handed (D3D), so everything is mirrored in Z on the way out:
// a game matrix M (row form) becomes S·M·S with S = diag(1, 1, -1), positions get z = -z and triangles are
// re-wound. Game cameras look along their +Z; after the mirror that is -Z, which is how glTF cameras look.
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { M4 } from './formats.js';
import { localBones, ddsFor } from './rig.js';
import { decodeDDS } from './mesh_io.js';
import { blockPose, objectVisible, poseMatrix } from './cu2.js';

// S·M·S for a row-form matrix: negate the entries where exactly one of row and column is the Z axis
export function mirror(m) {
  const o = Array.from(m);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if ((r === 2) !== (c === 2)) o[r * 4 + c] = -o[r * 4 + c];
  return o;
}
export const safeName = n => String(n).replace(/[\[\].:\/\s]+/g, '_');
// row form (v' = v·M) -> three.js Matrix4 (column vectors): the same 16 numbers read column-major
const toThree = m => new THREE.Matrix4().fromArray(m);

const texCache = new WeakMap();
function canvasTexture(dds) {
  const img = dds ? decodeDDS(dds) : null;
  if (!img) return null;
  const cv = document.createElement('canvas'); cv.width = img.w; cv.height = img.h;
  cv.getContext('2d').putImageData(new ImageData(img.rgba, img.w, img.h), 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.userData.alpha = img.alpha;
  return t;
}

// ------------------------------------------------------------------ character rig
// -> { root: Group holding the bones and the skinned meshes, bones: [THREE.Bone] }
export function buildRig(model, name = 'character') {
  const nb = model.bones.length;
  // animation tracks address nodes by name: names must be unique and free of . : [ ] / and spaces
  const seen = new Set();
  const bones = model.bones.map(b => {
    const x = new THREE.Bone();
    let n = safeName(b.name || `bone${b.index}`), k = n, i = 1;
    while (seen.has(k)) k = `${n}_${i++}`;
    seen.add(k); x.name = k;
    return x;
  });
  const root = new THREE.Group();
  root.name = name;
  model.bones.forEach((b, i) => {
    toThree(mirror(model.local[i])).decompose(bones[i].position, bones[i].quaternion, bones[i].scale);
    (b.parent >= 0 ? bones[b.parent] : root).add(bones[i]);
  });
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones, model.bones.map((_, i) => toThree(mirror(model.invBind[i]))));
  // materials, one per (layer, material) like the viewer
  let mats = texCache.get(model);
  if (!mats) texCache.set(model, mats = new Map());
  const matFor = m => {
    if (!mats.has(m)) {
      const t = canvasTexture(ddsFor(model, m));
      const mt = new THREE.MeshStandardMaterial({ name: `${name}_mat${m}`, map: t, roughness: 0.8, metalness: 0 });
      if (t?.userData.alpha) mt.alphaTest = 0.4;
      mats.set(m, mt);
    }
    return mats.get(m);
  };
  const groups = new Map();
  model.parts.forEach(part => {
    const g = model.partGeometry(part);
    if (!g || !g.tris.length) return;
    const key = `${part.layer}:${part.material}`;
    if (!groups.has(key)) groups.set(key, { layer: part.layer, material: part.material, chunks: [] });
    groups.get(key).chunks.push(g);
  });
  for (const grp of groups.values()) {
    let nv = 0, nt = 0;
    for (const g of grp.chunks) { nv += g.P.length / 3; nt += g.tris.length; }
    const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), UV = new Float32Array(nv * 2);
    const J = new Uint16Array(nv * 4), W = new Float32Array(nv * 4), I = new Uint32Array(nt);
    let v = 0, t = 0;
    for (const g of grp.chunks) {
      const n = g.P.length / 3;
      for (let i = 0; i < n; i++) {
        let x = g.P[i * 3], y = g.P[i * 3 + 1], z = g.P[i * 3 + 2], nx = g.N[i * 3], ny = g.N[i * 3 + 1], nz = g.N[i * 3 + 2];
        const k = (v + i) * 4;
        if (!g.W) {
          const m = model.world[g.rigidBone] || M4.identity();
          [x, y, z] = [x * m[0] + y * m[4] + z * m[8] + m[12], x * m[1] + y * m[5] + z * m[9] + m[13], x * m[2] + y * m[6] + z * m[10] + m[14]];
          [nx, ny, nz] = [nx * m[0] + ny * m[4] + nz * m[8], nx * m[1] + ny * m[5] + nz * m[9], nx * m[2] + ny * m[6] + nz * m[10]];
          J[k] = Math.min(g.rigidBone, nb - 1); W[k] = 1;
        } else {
          let s = 0;
          for (let q = 0; q < 3; q++) { J[k + q] = Math.min(g.J[i * 3 + q], nb - 1); W[k + q] = g.W[i * 3 + q]; s += W[k + q]; }
          if (s > 0) for (let q = 0; q < 3; q++) W[k + q] /= s; else W[k] = 1;
        }
        P.set([x, y, -z], (v + i) * 3);
        const l = Math.hypot(nx, ny, nz) || 1;
        N.set([nx / l, ny / l, -nz / l], (v + i) * 3);
        UV.set([g.UV[i * 2], g.UV[i * 2 + 1]], (v + i) * 2);
      }
      for (let q = 0; q < g.tris.length; q += 3) { I[t + q] = g.tris[q] + v; I[t + q + 1] = g.tris[q + 2] + v; I[t + q + 2] = g.tris[q + 1] + v; }
      v += n; t += g.tris.length;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(UV, 2));
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(J, 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(W, 4));
    geo.setIndex(new THREE.BufferAttribute(I, 1));
    const mesh = new THREE.SkinnedMesh(geo, matFor(grp.material));
    mesh.name = `${name}_${model.layers[grp.layer] || 'layer' + grp.layer}_m${grp.material}`;
    mesh.bind(skeleton, new THREE.Matrix4());
    root.add(mesh);
  }
  return { root, bones };
}

// one clip from a function giving each frame's local bone matrices (row form, game space)
function bakeClip(name, bones, frames, fps, localsAt, extra = []) {
  const n = bones.length, times = new Float32Array(frames);
  const pos = bones.map(() => new Float32Array(frames * 3)), rot = bones.map(() => new Float32Array(frames * 4)), scl = bones.map(() => new Float32Array(frames * 3));
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(), prev = bones.map(() => null);
  for (let f = 0; f < frames; f++) {
    times[f] = f / fps;
    const L = localsAt(f);
    for (let b = 0; b < n; b++) {
      toThree(mirror(L[b])).decompose(p, q, s);
      if (prev[b] && prev[b].dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w); // shortest way round
      prev[b] = q.clone();
      pos[b].set([p.x, p.y, p.z], f * 3); rot[b].set([q.x, q.y, q.z, q.w], f * 4); scl[b].set([s.x, s.y, s.z], f * 3);
    }
  }
  const tracks = [];
  bones.forEach((bone, b) => {
    tracks.push(new THREE.VectorKeyframeTrack(`${bone.name}.position`, times, pos[b]));
    tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, rot[b]));
    tracks.push(new THREE.VectorKeyframeTrack(`${bone.name}.scale`, times, scl[b]));
  });
  return new THREE.AnimationClip(name, frames / fps, [...tracks, ...extra]);
}

async function toGLB(scene, animations) {
  return new GLTFExporter().parseAsync(scene, { binary: true, animations, onlyVisible: false });
}

// ------------------------------------------------------------------ model tab: a character with its clips
// clips: [{ name, clip: AN3, rate }]. Bone names must be unique for the animation tracks: duplicates get a suffix.
export async function exportCharacterGLB(model, name, clips) {
  name = safeName(name);
  const { root, bones } = buildRig(model, name);
  const scene = new THREE.Scene(); scene.add(root);
  const anims = [];
  for (const a of clips) {
    const c = a.clip, rate = Math.abs(a.rate) >= 0.5 ? Math.abs(a.rate) : 30;
    if (!c || c.bones > model.bones.length + 8) continue;
    const frames = Math.max(1, Math.round(c.sourceFrames));
    const rev = a.rate < 0;
    anims.push(bakeClip(a.name, bones, frames, rate, f => localBones(model, c.pose(rev ? frames - 1 - f : f), c.channels, Math.min(c.bones, model.bones.length))));
  }
  return { glb: await toGLB(scene, anims), clips: anims.length };
}


// ------------------------------------------------------------------ cutscene
// view: the CutsceneView (its loaded cutscene, characters, set pieces and level scene).
// opts: { level: radius around the action (0 = no level), fov }
export async function exportCutsceneGLB(view, { radius = 150, fov = 50 } = {}) {
  const cut = view.cut, fps = cut.fps, frames = cut.frames;
  const scene = new THREE.Scene(), anims = [];
  const tracks = [];
  const times = Float32Array.from({ length: frames }, (_, f) => f / fps);
  // the camera: one camera that follows whichever cutscene camera is cut to (cuts are hard jumps)
  if (cut.cameras.length) {
    const cam = new THREE.PerspectiveCamera(fov, 16 / 9, 0.05, 30000);
    cam.name = 'CutsceneCamera';
    const node = new THREE.Object3D(); node.name = 'CutsceneCamera_rig'; node.add(cam); scene.add(node);
    const P = new Float32Array(frames * 3), Q = new Float32Array(frames * 4);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    let prev = null;
    for (let f = 0; f < frames; f++) {
      view.frame = f;
      const W = view.cameraMatrix() || cut.cameras[0].matrix;
      toThree(mirror(W)).decompose(p, q, s);
      if (prev && prev.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
      prev = q.clone();
      P.set([p.x, p.y, p.z], f * 3); Q.set([q.x, q.y, q.z, q.w], f * 4);
    }
    tracks.push(new THREE.VectorKeyframeTrack('CutsceneCamera_rig.position', times, P));
    tracks.push(new THREE.QuaternionKeyframeTrack('CutsceneCamera_rig.quaternion', times, Q));
  }
  // characters: a rig each, placed by its root track, hidden (scale 0) outside its frames
  const used = new Map();
  const box = new THREE.Box3();
  for (const r of view.chars) {
    if (!r.model) continue;
    const k = (used.get(r.c.name) || 0) + 1; used.set(r.c.name, k);
    const name = safeName(`${r.c.name}_${k}`);
    const holder = new THREE.Object3D(); holder.name = name;
    const { root, bones } = buildRig(r.model, `${name}_rig`);
    holder.add(root); scene.add(holder);
    // bone tracks need names unique in the whole file
    bones.forEach(b => { b.name = `${name}__${b.name}`; });
    const HP = new Float32Array(frames * 3), HQ = new Float32Array(frames * 4), HS = new Float32Array(frames * 3);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    for (let f = 0; f < frames; f++) {
      const rp = blockPose(r.c.root, f, 0, true);
      const R = rp ? poseMatrix(M4, rp, false) : r.c.matrix;
      toThree(mirror(R)).decompose(p, q, s);
      const on = f >= r.c.from && f < r.c.to ? 1 : 0;
      HP.set([p.x, p.y, p.z], f * 3); HQ.set([q.x, q.y, q.z, q.w], f * 4); HS.set([on, on, on], f * 3);
      if (on) box.expandByPoint(p.clone());
    }
    tracks.push(new THREE.VectorKeyframeTrack(`${name}.position`, times, HP));
    tracks.push(new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, times, HQ));
    tracks.push(new THREE.VectorKeyframeTrack(`${name}.scale`, times, HS, THREE.InterpolateDiscrete));
    const sk = r.posed ? r.c.skeleton : null;
    const clip = bakeClip('tmp', bones, frames, fps, f => {
      const vals = sk ? sk.pose(Math.max(0, Math.min(f - sk.start, sk.sourceFrames - 1))) : null;
      return localBones(r.model, vals, 9, vals ? r.nPose : 0, { relative: true });
    });
    tracks.push(...clip.tracks);
  }
  // set pieces the cutscene moves: their own meshes, animated
  const S = view.sceneCache?.S;
  if (S) {
    view.objs.forEach((r, i) => {
      if (!r.draws.length) return;
      const name = safeName(`piece_${r.o.name || i}_${i}`);
      const mesh = levelMesh(S, r.draws.map(di => S.draws[di]), name, view);
      if (!mesh) return;
      // geometry is in world space (mirrored); the node carries the move relative to the stored matrix
      const T = new Float32Array(frames * 3), Q = new Float32Array(frames * 4), Sc = new Float32Array(frames * 3);
      const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
      for (let f = 0; f < frames; f++) {
        let M = r.M0;
        const pb = r.o.block ? blockPose(r.o.block, f, 0, true) : null;
        if (pb) {
          const m0 = r.M0, sc = [0, 1, 2].map(a => Math.hypot(m0[a * 4], m0[a * 4 + 1], m0[a * 4 + 2]));
          M = M4.compose([m0[12] + pb[0], m0[13] + pb[1], m0[14] - pb[2]], [-pb[3], -pb[4], pb[5]], [pb[6] * sc[0], pb[7] * sc[1], pb[8] * sc[2]]);
        }
        toThree(mirror(M4.mul(r.inv0, M))).decompose(p, q, s);
        const on = objectVisible(r.o, f) ? 1 : 0;
        T.set([p.x, p.y, p.z], f * 3); Q.set([q.x, q.y, q.z, q.w], f * 4); Sc.set([s.x * on, s.y * on, s.z * on], f * 3);
      }
      scene.add(mesh);
      tracks.push(new THREE.VectorKeyframeTrack(`${name}.position`, times, T));
      tracks.push(new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, times, Q));
      tracks.push(new THREE.VectorKeyframeTrack(`${name}.scale`, times, Sc));
    });
    // the level around the action: every other draw whose centre lies within `radius` of the characters
    if (radius > 0) {
      if (box.isEmpty() && cut.cameraBlock) for (const c of cut.cameras) { const p = blockPose(cut.cameraBlock, 0, c.node, true); if (p) box.expandByPoint(new THREE.Vector3(p[0], p[1], p[2])); }
      if (!box.isEmpty()) {
        const ctr = box.getCenter(new THREE.Vector3()), R = box.getSize(new THREE.Vector3()).length() / 2 + radius;
        const moving = new Set(view.objs.flatMap(r => r.draws));
        // draw origins in mirrored space: (x, y, -z)
        const near = S.draws.filter(d => !moving.has(d.id) && d.matrix
          && Math.hypot(d.matrix[12] - ctr.x, d.matrix[13] - ctr.y, -d.matrix[14] - ctr.z) < R);
        const byTex = new Map();
        for (const d of near) { const t = S.materials[d.material]?.tex ?? -1; if (!byTex.has(t)) byTex.set(t, []); byTex.get(t).push(d); }
        const lvl = new THREE.Group(); lvl.name = 'level';
        for (const [t, ds] of byTex) { const m = levelMesh(S, ds, `level_tex${t}`, view); if (m) lvl.add(m); }
        scene.add(lvl);
      }
    }
  }
  if (tracks.length) anims.push(new THREE.AnimationClip(view.entry?.name || 'cutscene', frames / fps, tracks));
  scene.updateMatrixWorld(true);
  return toGLB(scene, anims);
}

// static level draws as one mesh (world space, mirrored), textured
const levelMats = new Map();
function levelMesh(S, draws, name, view) {
  let nv = 0, nt = 0;
  const geos = draws.map(d => S.drawGeometry(d));
  for (const g of geos) { nv += g.P.length / 3; nt += g.tris.length; }
  if (!nt) return null;
  const P = new Float32Array(nv * 3), UV = new Float32Array(nv * 2), C = new Float32Array(nv * 4), I = new Uint32Array(nt);
  let v = 0, t = 0;
  geos.forEach(g => {
    const n = g.P.length / 3;
    for (let i = 0; i < n; i++) {
      P.set([g.P[i * 3], g.P[i * 3 + 1], -g.P[i * 3 + 2]], (v + i) * 3);
      C.set([Math.min(g.C[i * 3] / 2, 1), Math.min(g.C[i * 3 + 1] / 2, 1), Math.min(g.C[i * 3 + 2] / 2, 1), 1], (v + i) * 4);
    }
    UV.set(g.UV, v * 2);
    for (let q = 0; q < g.tris.length; q += 3) { I[t + q] = g.tris[q] + v; I[t + q + 1] = g.tris[q + 2] + v; I[t + q + 2] = g.tris[q + 1] + v; }
    v += n; t += g.tris.length;
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(UV, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(C, 4));
  geo.setIndex(new THREE.BufferAttribute(I, 1));
  geo.computeVertexNormals();
  const tex = S.materials[draws[0].material]?.tex ?? -1;
  const key = `${view.scenePath}:${tex}`;
  if (!levelMats.has(key)) {
    const tx = tex >= 0 && S.textures[tex]?.size && !S.textures[tex].cube ? canvasTexture(new Uint8Array(S.dds(S.textures[tex]))) : null;
    const m = new THREE.MeshStandardMaterial({ name: `tex${tex}`, map: tx, roughness: 1, metalness: 0 });
    if (tx?.userData.alpha) m.alphaTest = 0.5;
    levelMats.set(key, m);
  }
  const mesh = new THREE.Mesh(geo, levelMats.get(key));
  mesh.name = name;
  return mesh;
}
