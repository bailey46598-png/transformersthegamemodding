// The level tab's physics props (NEWPHYSOBJ.DAT): every prop drawn with its type's model, selectable, movable,
// turnable, retyped, duplicated, deleted or added, and written back on save. Format: js/props.js.
import * as THREE from 'three';
import { readProps, writeProps, readPropTypes } from './props.js';
import { api, $, esc, fmt, joinPath } from './common.js';
import { M4, transformPoints } from './formats.js';

const VARIANTS = { normal: ['NEWPHYSOBJ.DAT', 'PHYSOBJTYPES.INI'], ng: ['NEWPHYSOBJ_NG.DAT', 'PHYSOBJTYPES_NG.INI'] };

export class PropLayer {
  constructor(view) {
    this.view = view;
    this.doc = null; this.group = null; this.meshes = [];
  }
  get root() { return this.view.vp.root; }

  async load(dir, files) {
    this.dispose();
    this.dir = dir;
    const has = n => files.find(f => f.toLowerCase() === n.toLowerCase());
    const variant = $('l-propfile').value;
    const [dat, ini] = VARIANTS[variant];
    $('l-propfile').disabled = !has(VARIANTS.ng[0]);
    if (!has(dat)) { this.doc = null; return; }
    try {
      this.path = joinPath(dir, has(dat));
      this.doc = readProps(await api.bytes(this.path));
      this.types = has(ini) ? readPropTypes(await api.text(joinPath(dir, has(ini)))) : [];
      this.build();
    } catch (e) { console.warn('props', e); this.doc = null; this.error = e.message; }
  }

  dispose() {
    if (this.group) { this.root.remove(this.group); this.group.traverse(x => { x.geometry?.dispose(); if (x.material) x.material.dispose?.(); }); }
    if (this.box) { this.root.remove(this.box); this.box = null; }
    this.group = null; this.meshes = []; this.doc = null; this.error = null;
  }

  typeName(t) { const x = this.types?.[t]; return x ? x.id.replace(/^PHYSOBJTYPE_/, '') : `type ${t}`; }

  // a type's model: its SpecialName instance's draws, in that instance's own space (by texture)
  template(t) {
    this._tpl ??= new Map();
    if (this._tpl.has(t)) return this._tpl.get(t);
    const S = this.view.gsc, name = this.types?.[t]?.special?.toLowerCase();
    let out = null;
    const ins = name && S?.instances.find(i => i.name.toLowerCase() === name);
    if (ins && S.objects[ins.object]) {
      const inv = M4.invert3x4(ins.matrix);
      const byTex = new Map();
      for (const di of S.objects[ins.object].draws) {
        const d = S.draws[di], g = S.drawGeometry(d);
        if (!g.tris.length) continue;
        transformPoints(g.P, inv);
        const tex = S.materials[d.material]?.tex ?? -1;
        if (!byTex.has(tex)) byTex.set(tex, []);
        byTex.get(tex).push(g);
      }
      out = [...byTex].map(([tex, gs]) => {
        let nv = 0, nt = 0;
        for (const g of gs) { nv += g.P.length / 3; nt += g.tris.length; }
        const P = new Float32Array(nv * 3), UV = new Float32Array(nv * 2), C = new Float32Array(nv * 3), I = new Uint32Array(nt);
        let v = 0, k = 0;
        for (const g of gs) { P.set(g.P, v * 3); UV.set(g.UV, v * 2); C.set(g.C, v * 3); for (const x of g.tris) I[k++] = x + v; v += g.P.length / 3; }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(P, 3)); geo.setAttribute('uv', new THREE.BufferAttribute(UV, 2)); geo.setAttribute('color', new THREE.BufferAttribute(C, 3));
        geo.setIndex(new THREE.BufferAttribute(I, 1)); geo.computeBoundingBox(); geo.computeBoundingSphere();
        return { tex, geo };
      });
      if (!out.length) out = null;
    }
    this._tpl.set(t, out);
    return out;
  }

  // Props are full of cut-out cards (tree foliage, fences) in DXT1 with 1-bit alpha: read DXT1 with its alpha,
  // or the cards draw as solid boards. (Kept to props: on level surfaces a 3-colour DXT1 block isn't always a hole.)
  cutout(i) {
    const base = this.view.texture(i);
    if (!base || base.format !== THREE.RGB_S3TC_DXT1_Format) return base;
    this._cut ??= new Map();
    if (!this._cut.has(i)) {
      const t = base.clone(); t.format = THREE.RGBA_S3TC_DXT1_Format; t.userData = { ...base.userData, hasAlpha: true }; t.needsUpdate = true;
      this._cut.set(i, t);
    }
    return this._cut.get(i);
  }

  matrixOf(p, m = new THREE.Matrix4()) {
    // game space (the root's local space); the yaw is a turn about Y (D3D quaternion (0, qy, 0, qw))
    return m.makeRotationY(p.yaw).setPosition(p.pos[0], p.pos[1], p.pos[2]);
  }

  build() {
    if (this.group) { this.root.remove(this.group); this.group.traverse(x => x.geometry?.dispose()); }
    this._tpl = new Map();
    this.group = new THREE.Group(); this.group.name = 'props';
    this.meshes = [];
    const props = this.doc.props;
    const byType = new Map();
    props.forEach((p, i) => { if (!byType.has(p.type)) byType.set(p.type, []); byType.get(p.type).push(i); });
    const marker = new THREE.BoxGeometry(0.8, 2, 0.8).translate(0, 1, 0);
    const m = new THREE.Matrix4();
    for (const [t, idx] of byType) {
      const parts = this.template(t) || [{ tex: null, geo: marker, marker: true }];
      for (const part of parts) {
        const map = part.marker ? null : this.cutout(part.tex);
        const mat = part.marker ? new THREE.MeshBasicMaterial({ color: 0xffa040 })
          : new THREE.MeshBasicMaterial({ map, vertexColors: true, side: THREE.DoubleSide, alphaTest: map?.userData.hasAlpha ? 0.5 : 0 });
        const im = new THREE.InstancedMesh(part.geo, mat, idx.length);
        idx.forEach((pi, k) => im.setMatrixAt(k, this.matrixOf(props[pi], m)));
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
        im.userData.propIndex = idx; // instanceId -> prop index
        im.frustumCulled = false;
        this.group.add(im); this.meshes.push(im);
      }
    }
    this.slot = new Map(); // prop index -> [[mesh, instanceId]]
    for (const im of this.meshes) im.userData.propIndex.forEach((pi, k) => { if (!this.slot.has(pi)) this.slot.set(pi, []); this.slot.get(pi).push([im, k]); });
    this.root.add(this.group);
    this.setVisible($('l-props').checked);
  }

  setVisible(v) { if (this.group) this.group.visible = v; }

  // after moving or turning prop i
  update(i) {
    const m = this.matrixOf(this.doc.props[i]);
    for (const [im, k] of this.slot.get(i) || []) { im.setMatrixAt(k, m); im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere(); }
    this.highlight(i);
  }

  highlight(i) {
    if (this.box) { this.root.remove(this.box); this.box = null; }
    if (i == null || !this.doc?.props[i]) return;
    const p = this.doc.props[i], b = this.boxOf(i);
    this.box = new THREE.Box3Helper(b, 0xffd24a);
    this.root.add(this.box);
    void p;
  }

  boxOf(i) {
    const p = this.doc.props[i], parts = this.template(p.type), m = this.matrixOf(p), b = new THREE.Box3();
    if (parts) for (const x of parts) b.union(x.geo.boundingBox.clone().applyMatrix4(m));
    if (b.isEmpty()) b.setFromCenterAndSize(new THREE.Vector3(p.pos[0], p.pos[1] + 1, p.pos[2]), new THREE.Vector3(1, 2, 1));
    return b;
  }

  // picking: the nearest prop hit by the ray, or null
  pick(ray) {
    if (!this.group?.visible) return null;
    const h = ray.intersectObjects(this.meshes, false)[0];
    return h && h.instanceId != null ? { hit: h, i: h.object.userData.propIndex[h.instanceId] } : null;
  }

  // ------------------------------------------------------------ edits (the caller marks 'props' dirty)
  add(type, pos, yaw = 0) {
    this.doc.props.push({ cell: null, raw: [0, 0, 0], pos: [...pos], qy: 0, qw: 32767, yaw, type, pad: 0, dirty: true });
    this.build();
    return this.doc.props.length - 1;
  }
  remove(i) { this.doc.props.splice(i, 1); this.build(); }
  setType(i, t) { this.doc.props[i].type = t; this.doc.props[i].dirty = true; this.build(); }
  move(i, pos, yaw) { const p = this.doc.props[i]; p.pos = [...pos]; if (yaw != null) p.yaw = yaw; p.dirty = true; this.update(i); }

  write() { const buf = writeProps(this.doc); this.build(); return buf; }

  panel(i) {
    const p = this.doc.props[i], t = this.types?.[p.type];
    const opts = (this.types || []).map((x, k) => `<option value="${k}" ${k === p.type ? 'selected' : ''}>${k}: ${esc(x.id.replace(/^PHYSOBJTYPE_/, ''))}</option>`).join('');
    const deg = ((p.yaw * 180 / Math.PI) % 360 + 360) % 360;
    return `<table class="kv">
      <tr><td>Prop</td><td>#${i} <span class="hint">in ${esc(this.path.split('/').pop())}</span></td></tr>
      <tr><td>Model</td><td class="mono">${esc(t?.special || '?')}${this.template(p.type) ? '' : ' <span class="warn">(not in this scene: shown as a box)</span>'}</td></tr>
      ${t?.broken ? `<tr><td>Broken</td><td class="mono">${esc(t.broken)}</td></tr>` : ''}
      ${t?.fields.Mass ? `<tr><td>Mass</td><td>${esc(t.fields.Mass)}</td></tr>` : ''}
    </table>
    <div class="fields" style="margin-top:6px">
      <label>Type</label><select id="lp-type">${opts}</select>
      <label>X</label><input type="number" step="0.1" id="lp-x" value="${fmt(p.pos[0], 2)}">
      <label>Y</label><input type="number" step="0.1" id="lp-y" value="${fmt(p.pos[1], 2)}">
      <label>Z</label><input type="number" step="0.1" id="lp-z" value="${fmt(p.pos[2], 2)}">
      <label>Turn°</label><input type="number" step="5" id="lp-yaw" value="${fmt(deg, 1)}">
    </div>
    <div class="row" style="margin-top:6px"><button class="b" id="lp-dup">Duplicate</button><button class="b" id="lp-del">Delete</button><button class="b" id="lp-focus">Focus</button></div>
    <p class="hint">G moves it, R turns it. The game spawns these from <span class="mono">${esc(this.path.split('/').pop())}</span>; its <span class="mono">_NG</span> twin is used instead in one of the game's detail modes (choose which file in the toolbar). Positions are stored to 0.01 units.</p>`;
  }
}
