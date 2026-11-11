// Character models shared by the model tab and the cutscene player: textured meshes from a .GHG, CPU skinning,
// and bone poses from .AN3-style channel values.
import * as THREE from 'three';
import { GHGModel, M4 } from './formats.js';
import { readCreatureConfig, modelFileName } from './text_formats.js';
import { api, joinPath, dirOf, ddsTexture } from './common.js';

// Load a character from its config: its model plus the DEPENDS parents that lend it textures.
// charByName: lower-case CHARACTER name -> {cfg, ...} (the model tab's index).
export async function loadCharacter(entry, charByName) {
  const cfg = await readCreatureConfig(entry.cfg, p => api.text(p));
  const ch = cfg.characters.find(x => x.name.toLowerCase() === entry.name.toLowerCase()) || cfg.characters[0];
  const modelPath = joinPath(ch.path, modelFileName(ch.object));
  const parents = [];
  for (const dep of ch.depends) {
    const pc = charByName.get(dep.toLowerCase());
    if (pc) parents.push(joinPath(pc.path, modelFileName(pc.object)));
  }
  return { ch, modelPath, parents, anims: ch.anims.map(a => ({ ...a, path: joinPath(ch.path, a.file) })) };
}

export async function loadModel(path, parents = []) {
  const model = new GHGModel(await api.bytes(path));
  model.path = path;
  model.parentModels = [];
  for (const p of parents) { try { model.parentModels.push(new GHGModel(await api.bytes(p))); } catch (e) { console.warn('parent', p, e); } }
  return model;
}

// Another .GHG in the same folder with exactly `bones` bones (e.g. a transforming model), or null.
export async function siblingWithBones(path, bones) {
  const dir = dirOf(path);
  const L = await api.list(dir);
  for (const f of L.files) {
    if (!/\.ghg$/i.test(f.name) || joinPath(dir, f.name).toLowerCase() === path.toLowerCase()) continue;
    try { const m = new GHGModel(await api.bytes(joinPath(dir, f.name))); if (m.bones.length === bones) return joinPath(dir, f.name); } catch {}
  }
  return null;
}

export function textureFor(model, m) {
  const t = model.textureForMaterial(m);
  model._tex ??= new Map();
  const key = `${t.kind}:${t.tex ?? t.slot}`;
  if (model._tex.has(key)) return model._tex.get(key);
  const dds = ddsFor(model, m);
  const tex = dds ? ddsTexture(dds) : null;
  model._tex.set(key, tex);
  return tex;
}

// the DDS bytes behind a material's texture (its own, or borrowed from a DEPENDS parent), or null
export function ddsFor(model, m) {
  const t = model.textureForMaterial(m);
  if (t.kind === 'own') return model.dds(model.textures[t.tex]);
  if (t.kind === 'parent') {
    // match the borrowed slot's texture hash in the DEPENDS models; else count slots across them in order
    let hit = null;
    if (t.hash && !/^0+$/.test(t.hash)) for (const p of model.parentModels) {
      const sl = p.slots.find(x => x.hash === t.hash && x.tex != null && !x.borrowed);
      if (sl) { hit = [p, sl]; break; }
    }
    if (!hit) {
      let s = t.slot;
      for (const p of model.parentModels) {
        if (s < p.slotCount) { const sl = p.slots[s]; if (sl?.tex != null && !sl.borrowed) hit = [p, sl]; break; }
        s -= p.slotCount;
      }
    }
    if (hit) return hit[0].dds(hit[0].textures[hit[1].tex]);
  }
  return null;
}

// One mesh per (layer, material), vertices in model space with up to 3 bone weights each.
export function buildMeshes(model) {
  const nb = model.bones.length;
  const groups = new Map();
  model.parts.forEach((part, pi) => {
    const g = model.partGeometry(part);
    if (!g || !g.tris.length) return;
    const key = `${part.layer}:${part.material}`;
    if (!groups.has(key)) groups.set(key, { layer: part.layer, material: part.material, chunks: [] });
    groups.get(key).chunks.push({ g, part, pi });
  });
  const group = new THREE.Group(), meshes = [];
  for (const grp of groups.values()) {
    let nv = 0, nt = 0;
    for (const { g } of grp.chunks) { nv += g.P.length / 3; nt += g.tris.length; }
    const src = new Float32Array(nv * 3), srcN = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
    const J = new Uint8Array(nv * 3), W = new Float32Array(nv * 3), idx = new Uint32Array(nt);
    let v = 0, t = 0;
    for (const { g } of grp.chunks) {
      const n = g.P.length / 3;
      for (let i = 0; i < n; i++) {
        let x = g.P[i * 3], y = g.P[i * 3 + 1], z = g.P[i * 3 + 2], nx = g.N[i * 3], ny = g.N[i * 3 + 1], nz = g.N[i * 3 + 2];
        if (!g.W) { // rigid: bone bind space -> model space, so every vertex skins the same way
          const m = model.world[g.rigidBone] || M4.identity();
          [x, y, z] = [x * m[0] + y * m[4] + z * m[8] + m[12], x * m[1] + y * m[5] + z * m[9] + m[13], x * m[2] + y * m[6] + z * m[10] + m[14]];
          [nx, ny, nz] = [nx * m[0] + ny * m[4] + nz * m[8], nx * m[1] + ny * m[5] + nz * m[9], nx * m[2] + ny * m[6] + nz * m[10]];
          J[(v + i) * 3] = Math.min(g.rigidBone, nb - 1); W[(v + i) * 3] = 1;
        } else for (let k = 0; k < 3; k++) { J[(v + i) * 3 + k] = Math.min(g.J[i * 3 + k], nb - 1); W[(v + i) * 3 + k] = g.W[i * 3 + k]; }
        src.set([x, y, z], (v + i) * 3); srcN.set([nx, ny, nz], (v + i) * 3);
        uv[(v + i) * 2] = g.UV[i * 2]; uv[(v + i) * 2 + 1] = g.UV[i * 2 + 1];
      }
      for (let k = 0; k < g.tris.length; k++) idx[t + k] = g.tris[k] + v;
      v += n; t += g.tris.length;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(src.slice(), 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('normal', new THREE.BufferAttribute(srcN.slice(), 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const tex = textureFor(model, grp.material);
    const mat = new THREE.MeshStandardMaterial({ map: tex, color: tex ? 0xffffff : 0x9aa3b5, roughness: 0.75, metalness: 0.1, side: THREE.DoubleSide });
    mat.userData.tex = tex;
    if (tex?.userData.hasAlpha) mat.alphaTest = 0.4;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData = { src, srcN, J, W, layer: grp.layer };
    mesh.frustumCulled = false;
    group.add(mesh);
    meshes.push(mesh);
  }
  return { group, meshes };
}

// Bone world matrices (row form) from channel values laid out like an .AN3 pose (9 per bone, mirrored in Z:
// negate tz and the X and Y rotations). Bones past the clip keep their bind pose. root (optional): a row-form
// matrix every bone is placed by (a cutscene character's position). pin: keep bone 0 at the origin in X and Z.
// relative: the rotations turn the bone from its bind orientation (cutscene skeleton tracks: a car's track rotates
// 7 of its 104 bones where the bind pose rotates 81; read as absolute, the model falls apart). .AN3 clips are absolute.
export function poseBones(model, vals, channels = 9, nClip = 0, opts = {}) {
  const local = localBones(model, vals, channels, nClip, opts), root = opts.root || null;
  const world = new Array(local.length);
  for (let b = 0; b < local.length; b++) {
    const p = model.bones[b].parent;
    world[b] = p < 0 ? (root ? M4.mul(local[b], root) : local[b]) : M4.mul(local[b], world[p]);
  }
  return world;
}

// each bone's local matrix (row form, relative to its parent) for a pose; options as poseBones (root unused)
export function localBones(model, vals, channels = 9, nClip = 0, { pin = false, relative = false } = {}) {
  const nb = model.bones.length, out = new Array(nb);
  for (let b = 0; b < nb; b++) {
    let local = model.local[b];
    if (vals && b < nClip && channels >= 9) {
      const o = b * channels;
      const t = [vals[o], vals[o + 1], -vals[o + 2]];
      if (b === 0 && pin) { t[0] = 0; t[2] = 0; }
      if (relative) {
        // row form: the track's rotation first, then the bind orientation, then the track's offset
        const bind = Array.from(model.local[b]); bind[12] = bind[13] = bind[14] = 0;
        local = Array.from(M4.mul(M4.compose([0, 0, 0], [-vals[o + 3], -vals[o + 4], vals[o + 5]], [vals[o + 6], vals[o + 7], vals[o + 8]]), bind));
        local[12] = t[0]; local[13] = t[1]; local[14] = t[2];
      } else local = M4.compose(t, [-vals[o + 3], -vals[o + 4], vals[o + 5]], [vals[o + 6], vals[o + 7], vals[o + 8]]);
    }
    out[b] = local;
  }
  return out;
}

// Skin the meshes to bone world matrices (CPU).
export function skinMeshes(model, meshes, world) {
  const skin = world.map((w, b) => M4.mul(model.invBind[b], w));
  for (const mesh of meshes) {
    const { src, srcN, J, W } = mesh.userData;
    const P = mesh.geometry.attributes.position.array, N = mesh.geometry.attributes.normal.array;
    for (let i = 0, n = src.length / 3; i < n; i++) {
      const x = src[i * 3], y = src[i * 3 + 1], z = src[i * 3 + 2], nx = srcN[i * 3], ny = srcN[i * 3 + 1], nz = srcN[i * 3 + 2];
      let px = 0, py = 0, pz = 0, qx = 0, qy = 0, qz = 0;
      for (let k = 0; k < 3; k++) {
        const w = W[i * 3 + k]; if (!w) continue;
        const m = skin[J[i * 3 + k]];
        px += w * (x * m[0] + y * m[4] + z * m[8] + m[12]); py += w * (x * m[1] + y * m[5] + z * m[9] + m[13]); pz += w * (x * m[2] + y * m[6] + z * m[10] + m[14]);
        qx += w * (nx * m[0] + ny * m[4] + nz * m[8]); qy += w * (nx * m[1] + ny * m[5] + nz * m[9]); qz += w * (nx * m[2] + ny * m[6] + nz * m[10]);
      }
      P[i * 3] = px; P[i * 3 + 1] = py; P[i * 3 + 2] = pz; N[i * 3] = qx; N[i * 3 + 1] = qy; N[i * 3 + 2] = qz;
    }
    mesh.geometry.attributes.position.needsUpdate = true;
    mesh.geometry.attributes.normal.needsUpdate = true;
  }
}

export function disposeGroup(g) {
  g?.traverse(x => { x.geometry?.dispose(); if (x.material) for (const m of [].concat(x.material)) m.dispose(); });
}
