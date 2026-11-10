// Level viewer & map editor: .GSC scene geometry plus PLACEMENTS.INI, TRIGGERS.INI and SPLINE.DAT overlays.
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { GSCScene, M4, transformPoints } from './formats.js';
import { GSCFile } from './gsc_writer.js';
import { readDNO2 } from './dno2.js';
import { openScene } from './ps3_scene.js';
import { CollisionLayer } from './collision_view.js';
import { addObjectCopies } from './scene_edit.js';
import { exportObjectGLB, readEditedGLB, applyMeshEdits } from './mesh_io.js';
import { PropLayer } from './prop_layer.js';
import { SpawnLayer } from './spawn_layer.js';
import { parseBlockIni, writeBlockIni, iniGet, iniNum, iniSet, unquote, parseSplineDat, writeSplineDat } from './text_formats.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { api, $, status, esc, fmt, joinPath, Viewport, ddsTexture } from './common.js';
import { Navigator, Minimap } from './navigator.js';

// BVH-accelerated raycasts: cursor zoom and clicking on a 500k-triangle level stay instant
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const TURN = 65536; // trigger Rotation units per full turn (assumed)

export class LevelView {
  constructor() {
    this.vp = new Viewport($('l-canvas'), { far: 20000 });
    this.vp.scene.background = new THREE.Color(0x1b1e25);
    this.gizmo = new TransformControls(this.vp.camera, this.vp.renderer.domElement);
    this.gizmo.addEventListener('dragging-changed', e => { this.vp.controls.enabled = !e.value; if (!e.value) this.endDrag(); });
    this.gizmo.addEventListener('objectChange', () => this.onGizmo());
    this.vp.scene.add(this.gizmo);
    this.proxy = new THREE.Object3D();
    this.vp.root.add(this.proxy);
    this.dirty = new Set();
    this.sel = null;
    this.nav = new Navigator(this.vp, {
      pick: (ray, o) => this.pickPoint(ray, o),
      active: () => !$('tab-level').classList.contains('hidden'),
      bookmarkKey: () => 'tfstudio.views.' + (this.gscPath || this.dir || ''),
      notify: m => status(m),
    });
    this.mini = new Minimap(this.vp, this.nav, $('l-canvas'));
    this.coll = new CollisionLayer(this);
    this.propLayer = new PropLayer(this);
    this.spawnLayer = new SpawnLayer(this);
    this.copies = [];
    this.nav.on(() => this.renderReadout());
    this.vp.camera.layers.enable(2);
    // from outside, the sky dome would hide the whole level: draw it only while the camera is inside
    this.vp.onFrame.push(() => {
      for (const m of this.levelMeshes || []) if (m.userData.sky) m.visible = m.userData.skyBox.containsPoint(this.vp.camera.position);
    });
    this.bindUI();
  }

  // first surface hit by a ray (world space). top: for "ground below this point", ignore the sky dome.
  pickPoint(ray, { top = false } = {}) {
    if (!this.levelMeshes?.length || !this.geoGroup?.visible) return null;
    ray.firstHitOnly = true;
    const meshes = top ? this.levelMeshes.filter(m => !m.userData.sky) : this.levelMeshes;
    return ray.intersectObjects(meshes, false)[0]?.point || null;
  }

  // game coordinates <-> three.js world (the root is mirrored in Z)
  toGame(v) { return this.vp.root.worldToLocal(v.clone()); }
  toWorld(v) { this.vp.root.updateMatrixWorld(); return this.vp.root.localToWorld(v.clone()); }

  renderReadout() {
    const now = performance.now();
    clearTimeout(this._roTimer);
    if (now - (this._ro || 0) < 80) { this._roTimer = setTimeout(() => this.renderReadout(), 90); return; }
    this._ro = now;
    const p = this.toGame(this.vp.camera.position), t = this.toGame(this.vp.controls.target);
    $('l-readout').textContent = `cam ${fmt(p.x, 1)}, ${fmt(p.y, 1)}, ${fmt(p.z, 1)}  →  ${fmt(t.x, 1)}, ${fmt(t.y, 1)}, ${fmt(t.z, 1)}`;
    $('l-speed').textContent = this.nav.speed < 10 ? this.nav.speed.toFixed(1) : Math.round(this.nav.speed);
    $('l-autospeed').classList.toggle('primary', !this.nav.manualSpeed);
  }

  goTo(text) {
    const nums = text.trim().split(/[\s,]+/).map(Number);
    if (nums.length >= 2 && nums.every(n => !isNaN(n))) {
      let g;
      if (nums.length === 2) { // x z: drop onto the ground there
        const w = this.toWorld(new THREE.Vector3(nums[0], 0, nums[1]));
        const y = this.mini.groundAt(w.x, w.z, this.vp.controls.target.y);
        g = this.toGame(new THREE.Vector3(w.x, y, w.z));
      } else g = new THREE.Vector3(nums[0], nums[1], nums[2]);
      const w = this.toWorld(g), off = this.vp.camera.position.clone().sub(this.vp.controls.target);
      if (off.length() > 150) off.setLength(60);
      this.nav.flyTo(w, w.clone().add(off));
      return;
    }
    const q = text.trim().toLowerCase(); if (!q) return;
    const items = [
      ...(this.placements?.doc.blocks || []).map((b, i) => [unquote(iniGet(b, 'TagString')), { kind: 'placement', i }]),
      ...(this.triggers?.doc.blocks || []).map((b, i) => [unquote(iniGet(b, 'TagString')), { kind: 'trigger', i }]),
      ...(this.splines?.list || []).map((s, i) => [s.name, { kind: 'spline', i, point: 0 }]),
    ];
    const hit = items.find(([n]) => (n || '').toLowerCase() === q) || items.find(([n]) => (n || '').toLowerCase().includes(q));
    if (!hit) return status(`Nothing called "${text}" here.`, true);
    this.select(hit[1]); this.focus();
  }

  async init() {
    const L = await api.list('LEVELS');
    $('l-level').innerHTML = L.dirs.map(d => `<option>${esc(d)}</option>`).join('');
    const pick = L.dirs.find(d => /^CITY$/i.test(d)) || L.dirs[0];
    $('l-level').value = pick;
    await this.listScenes();
  }

  async listScenes() {
    const dir = joinPath('LEVELS', $('l-level').value);
    const L = await api.list(dir);
    const g = L.files.filter(f => /\.gsc$/i.test(f.name));
    $('l-scene').innerHTML = g.map(f => `<option value="${esc(f.name)}">${esc(f.name)} (${(f.size / 1048576).toFixed(1)} MB)</option>`).join('') || '<option value="">(no .GSC here: maps only)</option>';
    this.levelFiles = L.files.map(f => f.name);
  }

  bindUI() {
    $('l-level').onchange = () => this.listScenes();
    $('l-load').onclick = () => this.load();
    $('l-filter').oninput = () => this.renderList();
    $('l-list').onclick = e => { const it = e.target.closest('.item'); if (it) { this.select(JSON.parse(it.dataset.sel)); this.focus(); } };
    for (const id of ['l-geo', 'l-tex', 'l-place', 'l-trig', 'l-spl', 'l-labels']) $(id).onchange = () => this.applyToggles();
    $('l-coll').onchange = e => { this.coll.setVisible(e.target.checked); if (e.target.checked && !this.coll.available && this.gsc) status(`No collision in this scene: ${this.coll.summary()}.`); };
    $('l-mode').onchange = () => this.attachGizmo();
    $('l-props').onchange = () => this.applyToggles();
    $('l-spawns').onchange = () => this.applyToggles();
    $('l-propfile').onchange = async () => {
      if (this.dirty.has('props') && !confirm('Discard unsaved prop changes?')) return;
      this.dirty.delete('props'); this.select(null);
      await this.propLayer.load(this.dir, this.levelFiles || []); this.renderList(); this.renderDirty(); this.renderInfo();
    };
    $('l-propadd').onclick = () => this.addProp();
    $('l-save').onclick = () => this.save();
    $('l-revert').onclick = () => { if (!this.dirty.size || confirm('Discard unsaved changes?')) this.load(); };
    const el = this.vp.renderer.domElement;
    let down = null;
    el.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
    el.addEventListener('pointerup', e => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || this.gizmo.dragging || e.button !== 0) return;
      this.pick(e);
    });
    $('l-home').onclick = () => this.frameAll(true);
    $('l-top').onclick = () => this.nav.topView();
    $('l-focusbtn').onclick = () => this.focus();
    $('l-mini').onchange = e => { this.mini.visible = e.target.checked; };
    $('l-slower').onclick = () => this.nav.setSpeed(this.nav.speed / 1.5);
    $('l-faster').onclick = () => this.nav.setSpeed(this.nav.speed * 1.5);
    $('l-autospeed').onclick = () => this.nav.resetSpeed();
    $('l-goto').onkeydown = e => { if (e.key === 'Enter') { this.goTo(e.target.value); e.target.blur(); } if (e.key === 'Escape') e.target.blur(); };
    const help = () => $('l-help').classList.toggle('hidden');
    $('l-helpbtn').onclick = help;
    $('l-help').onclick = help;
    window.addEventListener('keydown', e => {
      if ($('tab-level').classList.contains('hidden') || ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '?') { help(); return; }
      if (e.code === 'KeyH') this.frameAll(true);
      if (e.code === 'KeyM') { $('l-mini').checked = !$('l-mini').checked; this.mini.visible = $('l-mini').checked; }
      if (e.code === 'KeyF') this.focus();
      if (e.code === 'Escape') this.select(null);
      if (e.code === 'KeyG') { $('l-mode').value = 'translate'; this.attachGizmo(); }
      if (e.code === 'KeyR') { $('l-mode').value = 'rotate'; this.attachGizmo(); }
    });
    window.addEventListener('beforeunload', e => { if (this.dirty.size) { e.preventDefault(); e.returnValue = ''; } });
  }

  // ------------------------------------------------------------ loading
  async load() {
    if (this.dirty.size && !confirm('Discard unsaved changes and load?')) return;
    const dir = joinPath('LEVELS', $('l-level').value), scene = $('l-scene').value;
    this.clear();
    this.dir = dir;
    try {
      if (scene) {
        status(`Reading ${scene}…`);
        this.gscPath = joinPath(dir, scene);
        const t0 = performance.now();
        this.gsc = openScene(await api.bytes(this.gscPath), GSCScene);
        status(`Building ${this.gsc.draws.length.toLocaleString()} draws…`);
        await new Promise(r => setTimeout(r, 0));
        this.buildGeometry();
        this.coll.load(this.gsc);
        if ($('l-coll').checked) this.coll.setVisible(true);
        console.log('level built in', Math.round(performance.now() - t0), 'ms');
      }
      await this.loadMaps();
      $('l-empty').classList.add('hidden');
      this.renderInfo(); this.renderList(); this.renderDirty(); this.applyToggles();
      this.frameAll();
      status(`${$('l-level').value} loaded.`);
    } catch (e) { console.error(e); status(`${dir}: ${e.message}`, true); }
  }

  clear() {
    this.select(null);
    this.coll.dispose(); this.coll.D0 = null;
    this.propLayer.dispose();
    this.spawnLayer.dispose();
    for (const c of this.copies || []) this.removeCopyPreview(c);
    this.copies = [];
    for (const g of [this.geoGroup, this.markGroup]) if (g) {
      this.vp.root.remove(g);
      g.traverse(x => { x.geometry?.dispose(); if (x.isCSS2DObject) x.element.remove(); });
    }
    this.gsc = null; this.gscPath = null; this.geoGroup = null; this.markGroup = null;
    this.placements = this.triggers = this.splines = null;
    this.dirty.clear(); this.origVerts = new Map(); this.origMats = new Map(); this.hidden = new Set(); this.replacedTex = new Set();
  }

  buildGeometry() {
    const S = this.gsc;
    const byTex = new Map();
    this.rangeDraws = new Map(); // "vb:base:count" -> draw ids sharing those vertices
    for (const d of S.draws) {
      const key = `${d.vb}:${d.base}:${d.count}`;
      if (!this.rangeDraws.has(key)) this.rangeDraws.set(key, []);
      this.rangeDraws.get(key).push(d.id);
      d.key = key;
      const tex = S.materials[d.material]?.tex ?? -1;
      if (!byTex.has(tex)) byTex.set(tex, []);
      byTex.get(tex).push(d);
    }
    this.geoGroup = new THREE.Group();
    this.drawPlace = new Array(S.draws.length);
    this.texCache = new Map();
    this.levelMeshes = [];
    this.triCount = 0;
    for (const [tex, draws] of byTex) {
      const geos = draws.map(d => S.drawGeometry(d));
      let nv = 0, nt = 0;
      for (const g of geos) { nv += g.P.length / 3; nt += g.tris.length; }
      if (!nt) continue;
      const P = new Float32Array(nv * 3), UV = new Float32Array(nv * 2), C = new Float32Array(nv * 3), I = new Uint32Array(nt), faceDraw = new Int32Array(nt / 3);
      let v = 0, t = 0;
      const mesh = new THREE.Mesh();
      draws.forEach((d, k) => {
        const g = geos[k], n = g.P.length / 3;
        P.set(g.P, v * 3); UV.set(g.UV, v * 2); C.set(g.C, v * 3);
        for (let i = 0; i < g.tris.length; i++) I[t + i] = g.tris[i] + v;
        faceDraw.fill(d.id, t / 3, (t + g.tris.length) / 3);
        this.drawPlace[d.id] = { mesh, v, n, t, nt: g.tris.length };
        v += n; t += g.tris.length;
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(UV, 2));
      geo.setAttribute('color', new THREE.BufferAttribute(C, 3));
      geo.setIndex(new THREE.BufferAttribute(I, 1));
      geo.computeBoundingSphere();
      const map = tex >= 0 ? this.texture(tex) : null;
      const mat = new THREE.MeshBasicMaterial({ vertexColors: true, map, side: THREE.DoubleSide });
      mat.userData.tex = map;
      if (map?.userData.hasAlpha) mat.alphaTest = 0.5;
      mesh.geometry = geo; mesh.material = mat;
      mesh.userData = { faceDraw, tex };
      this.geoGroup.add(mesh);
      this.levelMeshes.push(mesh);
      this.triCount += nt / 3;
    }
    this.vp.root.add(this.geoGroup);
    this.vp.root.updateMatrixWorld(true);
    // the sky dome wraps everything: flag it so "ground below" lookups and the minimap framing skip it
    const all = new THREE.Box3().setFromObject(this.geoGroup), A = all.getSize(new THREE.Vector3());
    const xs = [], ys = [], zs = [], w = new THREE.Vector3();
    for (const m of this.levelMeshes) {
      m.geometry.computeBoundsTree();
      const b = new THREE.Box3().setFromObject(m), s = b.getSize(new THREE.Vector3());
      m.userData.sky = s.y > A.y * 0.45 && s.x > A.x * 0.5 && s.z > A.z * 0.5;
      if (m.userData.sky) {
        // layer 2: the main camera sees it (only while inside it), the minimap and raycasts don't
        m.layers.set(2); m.userData.skyBox = b;
        continue;
      }
      // sample vertices: the busy area, not the far-reaching water/ground planes, sets the framing
      const P = m.geometry.attributes.position, step = Math.max(1, Math.floor(P.count / 2000));
      for (let i = 0; i < P.count; i += step) { w.fromBufferAttribute(P, i).applyMatrix4(m.matrixWorld); xs.push(w.x); ys.push(w.y); zs.push(w.z); }
    }
    const q = (a, f) => { a.sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * f))]; };
    this.playBox = xs.length
      ? new THREE.Box3(new THREE.Vector3(q(xs, 0.01), q(ys, 0.01), q(zs, 0.01)), new THREE.Vector3(q(xs, 0.99), q(ys, 0.99), q(zs, 0.99)))
      : all;
    // Cloud layers (an alpha texture on a mesh that sits wholly above the level, e.g. Tranquility's 4,000-unit
    // sheet at 212-1,050 up) are blended in the game; drawn as cut-outs they look like floating camouflage
    for (const m of this.levelMeshes) {
      if (m.userData.sky || !m.material.map?.userData.hasAlpha) continue;
      const b = new THREE.Box3().setFromObject(m);
      if (b.min.y > this.playBox.max.y + 50) {
        Object.assign(m.material, { transparent: true, alphaTest: 0, depthWrite: false });
        m.material.needsUpdate = true;
        m.userData.cloud = true;
      }
    }
  }

  texture(i) {
    if (this.texCache.has(i)) return this.texCache.get(i);
    const t = this.gsc.textures[i];
    const tex = t && t.size && !t.cube ? ddsTexture(this.gsc.dds(t)) : null;
    // PS3 cut-outs (pylons, fences, foliage) are DXT1 with 1-bit alpha: keep it, so the holes aren't drawn black
    if (tex && this.gsc.ps3 && tex.format === THREE.RGB_S3TC_DXT1_Format) { tex.format = THREE.RGBA_S3TC_DXT1_Format; tex.userData.hasAlpha = true; }
    this.texCache.set(i, tex);
    return tex;
  }

  async loadMaps() {
    const has = n => this.levelFiles?.find(f => f.toLowerCase() === n.toLowerCase());
    this.markGroup = new THREE.Group();
    this.vp.root.add(this.markGroup);
    if (has('PLACEMENTS.INI')) { this.placements = { path: joinPath(this.dir, has('PLACEMENTS.INI')), doc: parseBlockIni(await api.text(joinPath(this.dir, has('PLACEMENTS.INI')))) }; }
    if (has('TRIGGERS.INI')) { this.triggers = { path: joinPath(this.dir, has('TRIGGERS.INI')), doc: parseBlockIni(await api.text(joinPath(this.dir, has('TRIGGERS.INI')))) }; }
    if (has('SPLINE.DAT')) {
      try { this.splines = { path: joinPath(this.dir, has('SPLINE.DAT')), list: parseSplineDat(await api.bytes(joinPath(this.dir, has('SPLINE.DAT')))) }; }
      catch (e) { status(e.message, true); }
    }
    this.buildMarkers();
    await this.propLayer.load(this.dir, this.levelFiles || []);
    await this.spawnLayer.load(this.dir);
  }

  // ------------------------------------------------------------ markers
  buildMarkers() {
    const G = this.markGroup;
    for (const c of [...G.children]) { G.remove(c); c.traverse(x => { x.geometry?.dispose(); if (x.isCSS2DObject) x.element.remove(); }); }
    this.pickables = [];
    const label = (text, cls, sel) => {
      const el = document.createElement('div');
      el.className = `label ${cls}`; el.textContent = text;
      el.onclick = () => this.select(sel);
      return new CSS2DObject(el);
    };
    this.placeObjs = []; this.trigObjs = []; this.splObjs = [];
    const pGeo = new THREE.OctahedronGeometry(1.2);
    (this.placements?.doc.blocks || []).forEach((b, i) => {
      const sel = { kind: 'placement', i };
      const m = new THREE.Mesh(pGeo, new THREE.MeshBasicMaterial({ color: 0x5aa9e6, depthTest: false, transparent: true, opacity: 0.9 }));
      m.renderOrder = 5; m.userData.sel = sel;
      const l = label(unquote(iniGet(b, 'TagString')) || `placement ${i}`, 'place', sel); l.position.y = 2;
      m.add(l);
      G.add(m); this.pickables.push(m); this.placeObjs.push(m);
      this.updatePlacement(i);
    });
    (this.triggers?.doc.blocks || []).forEach((b, i) => {
      const sel = { kind: 'trigger', i };
      const grp = new THREE.Group();
      const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xe0605a, transparent: true, opacity: 0.12, depthWrite: false }));
      box.userData.sel = sel;
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: 0xe0605a }));
      grp.add(box, edges);
      const l = label(unquote(iniGet(b, 'TagString')) || `trigger ${i}`, 'trig', sel);
      grp.add(l);
      grp.userData = { box, edges, label: l };
      G.add(grp); this.pickables.push(box); this.trigObjs.push(grp);
      this.updateTrigger(i);
    });
    (this.splines?.list || []).forEach((s, i) => {
      const grp = new THREE.Group();
      const line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x6cc07a }));
      const pts = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xb8f0b0, size: 6, sizeAttenuation: false, depthTest: false, transparent: true }));
      pts.renderOrder = 6; pts.userData.sel = { kind: 'spline', i };
      const l = label(s.name, 'spl', { kind: 'spline', i, point: 0 });
      grp.add(line, pts, l);
      grp.userData = { line, pts, label: l };
      G.add(grp); this.pickables.push(pts); this.splObjs.push(grp);
      this.updateSpline(i);
    });
    this.applyToggles();
  }

  placementPos(b) { const s = iniNum(b, 'Scale', 10) || 10; return new THREE.Vector3(iniNum(b, 'PosX') / s, iniNum(b, 'PosY') / s, iniNum(b, 'PosZ') / s); }
  updatePlacement(i) { const b = this.placements.doc.blocks[i]; this.placeObjs[i].position.copy(this.placementPos(b)); }
  updateTrigger(i) {
    const b = this.triggers.doc.blocks[i], g = this.trigObjs[i];
    g.position.set(iniNum(b, 'PosX'), iniNum(b, 'PosY'), iniNum(b, 'PosZ'));
    g.rotation.set(0, iniNum(b, 'Rotation') / TURN * Math.PI * 2, 0);
    const s = [Math.max(iniNum(b, 'BoxSizeX', 1), 0.1), Math.max(iniNum(b, 'BoxSizeY', 1), 0.1), Math.max(iniNum(b, 'BoxSizeZ', 1), 0.1)];
    g.userData.box.scale.set(...s); g.userData.edges.scale.set(...s);
    g.userData.label.position.set(0, s[1] / 2 + 1, 0);
  }
  updateSpline(i) {
    const s = this.splines.list[i], g = this.splObjs[i];
    const arr = new Float32Array(s.points.flat());
    g.userData.line.geometry.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    g.userData.pts.geometry.setAttribute('position', new THREE.BufferAttribute(arr.slice(), 3));
    g.userData.line.geometry.computeBoundingSphere(); g.userData.pts.geometry.computeBoundingSphere();
    if (s.points.length) g.userData.label.position.set(...s.points[0]).y += 2;
  }

  applyToggles() {
    if (this.geoGroup) this.geoGroup.visible = $('l-geo').checked;
    for (const m of this.levelMeshes || []) {
      const t = $('l-tex').checked ? m.material.userData.tex : null;
      if (m.material.map !== t) { m.material.map = t; m.material.needsUpdate = true; }
    }
    const lab = $('l-labels').checked;
    for (const o of this.placeObjs || []) { o.visible = $('l-place').checked; o.children[0].visible = lab && o.visible; }
    for (const o of this.trigObjs || []) { o.visible = $('l-trig').checked; o.userData.label.visible = lab && o.visible; }
    for (const o of this.splObjs || []) { o.visible = $('l-spl').checked; o.userData.label.visible = lab && o.visible; }
    this.propLayer.setVisible($('l-props').checked);
    this.spawnLayer.setVisible($('l-spawns').checked);
  }

  // ------------------------------------------------------------ list & selection
  renderList() {
    const q = $('l-filter').value.toLowerCase();
    let html = '';
    const sec = (title, items) => {
      const rows = items.filter(x => !q || x.name.toLowerCase().includes(q));
      if (!rows.length) return;
      html += `<div class="grp">${title} (${rows.length})</div>` + rows.map(x => `<div class="item ${this.isSel(x.sel) ? 'on' : ''}" data-sel='${JSON.stringify(x.sel)}'>${esc(x.name)}<span class="sub">${x.sub || ''}</span></div>`).join('');
    };
    sec('Placements', (this.placements?.doc.blocks || []).map((b, i) => ({ name: unquote(iniGet(b, 'TagString')) || `#${i}`, sel: { kind: 'placement', i } })));
    sec('Triggers', (this.triggers?.doc.blocks || []).map((b, i) => ({ name: unquote(iniGet(b, 'TagString')) || `#${i}`, sel: { kind: 'trigger', i } })));
    sec('Splines', (this.splines?.list || []).map((s, i) => ({ name: s.name, sub: `${s.points.length} pts`, sel: { kind: 'spline', i, point: 0 } })));
    if (this.spawnLayer.spawns.length) sec('Spawns', this.spawnLayer.spawns.map((x, i) => ({ name: `${x.type || '?'} · ${x.name}`, sub: `${x.off ? 'off · ' : ''}${x.path.split('/').pop()}`, sel: { kind: 'spawn', i } })));
    if (this.propLayer.doc) {
      const all = this.propLayer.doc.props.map((p, i) => ({ name: `${this.propLayer.typeName(p.type)} #${i}`, sub: `${fmt(p.pos[0], 0)}, ${fmt(p.pos[2], 0)}`, sel: { kind: 'prop', i } }));
      const shown = q ? all.filter(x => x.name.toLowerCase().includes(q)) : all;
      if (shown.length > 400) { html += `<div class="grp">Props (${shown.length})</div><div class="hint" style="padding:4px 10px">Type in the filter to list props by type (e.g. "lamppost"), or click one in the view.</div>`; }
      else sec('Props', shown);
    }
    if (this.gsc && !q) html += `<div class="grp">Geometry</div><div class="hint" style="padding:4px 10px">Click any surface in the view to select its object.</div>`;
    $('l-list').innerHTML = html || '<div class="hint" style="padding:10px">Nothing here.</div>';
  }
  isSel(s) { return this.sel && s && this.sel.kind === s.kind && this.sel.i === s.i; }

  pick(e) {
    const r = this.vp.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.vp.camera);
    ray.params.Points.threshold = 1;
    const vis = [...this.pickables, ...this.copies.flatMap(c => c.meshes)].filter(p => { let o = p; while (o) { if (!o.visible) return false; o = o.parent; } return true; });
    const hm = ray.intersectObjects(vis, false)[0];
    if (hm) {
      const s = { ...hm.object.userData.sel };
      if (s.kind === 'spline') s.point = hm.index ?? 0;
      return this.select(s);
    }
    const hs = this.spawnLayer.pick(ray);
    if (hs) return this.select({ kind: 'spawn', i: hs.i });
    const hp = this.propLayer.pick(ray);
    let hg = null;
    if (this.geoGroup?.visible) { ray.firstHitOnly = true; hg = ray.intersectObjects(this.levelMeshes, false)[0]; }
    if (hp && (!hg || hp.hit.distance <= hg.distance + 0.05)) return this.select({ kind: 'prop', i: hp.i });
    if (hg) return this.select({ kind: 'object', i: this.gsc.draws[hg.object.userData.faceDraw[hg.faceIndex]].object });
    this.select(null);
  }

  select(s) {
    this.sel = s;
    if (this.highlight) { this.vp.root.remove(this.highlight); this.highlight.geometry.dispose(); this.highlight = null; }
    for (const el of document.querySelectorAll('#l-canvas .label.sel')) el.classList.remove('sel');
    if (!s) { this.gizmo.detach(); this.propLayer.highlight(null); this.renderSel(); this.renderList(); this.coll.updateHighlight(); return; }
    if (s.kind === 'object') this.beginObject(s.i);
    if (s.kind === 'placement') this.placeObjs[s.i].children[0].element.classList.add('sel');
    if (s.kind === 'trigger') this.trigObjs[s.i].userData.label.element.classList.add('sel');
    if (s.kind === 'spline') this.splObjs[s.i].userData.label.element.classList.add('sel');
    this.propLayer.highlight(s.kind === 'prop' ? s.i : null);
    this.attachGizmo();
    this.renderSel(); this.renderList();
    this.coll.updateHighlight();
  }

  attachGizmo() {
    const s = this.sel;
    if (!s || s.kind === 'spawn') return this.gizmo.detach(); // a spawn moves with its spline
    const rot = $('l-mode').value === 'rotate' && (s.kind === 'object' || s.kind === 'trigger' || s.kind === 'copy' || s.kind === 'prop');
    this.gizmo.setMode(rot ? 'rotate' : 'translate');
    this.gizmo.showX = this.gizmo.showZ = !rot; this.gizmo.showY = true;
    this.proxy.rotation.set(0, 0, 0);
    if (s.kind === 'object') { this.proxy.position.copy(this.objPivot); this.dragStart = { pos: this.proxy.position.clone(), rot: 0 }; }
    if (s.kind === 'copy') { const c = this.copies[s.i]; this.proxy.position.copy(c.pos); this.proxy.rotation.y = c.rotY; }
    if (s.kind === 'placement') this.proxy.position.copy(this.placeObjs[s.i].position);
    if (s.kind === 'prop') { const p = this.propLayer.doc.props[s.i]; this.proxy.position.set(...p.pos); this.proxy.rotation.y = p.yaw; }
    if (s.kind === 'trigger') { this.proxy.position.copy(this.trigObjs[s.i].position); this.proxy.rotation.y = this.trigObjs[s.i].rotation.y; }
    if (s.kind === 'spline') { const p = this.splines.list[s.i].points[s.point ?? 0]; if (!p) return this.gizmo.detach(); this.proxy.position.set(...p); }
    this.proxy.updateMatrixWorld();
    this.gizmo.attach(this.proxy);
  }

  onGizmo() {
    const s = this.sel; if (!s) return;
    const p = this.proxy.position;
    if (s.kind === 'placement') {
      const b = this.placements.doc.blocks[s.i], sc = iniNum(b, 'Scale', 10) || 10;
      iniSet(b, 'PosX', fmt(p.x * sc, 2)); iniSet(b, 'PosY', fmt(p.y * sc, 2)); iniSet(b, 'PosZ', fmt(p.z * sc, 2));
      this.updatePlacement(s.i); this.markDirty('placements');
    } else if (s.kind === 'trigger') {
      const b = this.triggers.doc.blocks[s.i];
      iniSet(b, 'PosX', fmt(p.x, 6)); iniSet(b, 'PosY', fmt(p.y, 6)); iniSet(b, 'PosZ', fmt(p.z, 6));
      iniSet(b, 'Rotation', Math.round(((this.proxy.rotation.y / (2 * Math.PI)) * TURN % TURN + TURN) % TURN));
      this.updateTrigger(s.i); this.markDirty('triggers');
    } else if (s.kind === 'spline') {
      this.splines.list[s.i].points[s.point] = [p.x, p.y, p.z];
      this.updateSpline(s.i); this.markDirty('splines');
    } else if (s.kind === 'object') {
      this.moveObject(p.clone().sub(this.dragStart.pos), this.proxy.rotation.y);
      return;
    } else if (s.kind === 'copy') {
      const c = this.copies[s.i]; c.pos.copy(p); c.rotY = this.proxy.rotation.y; this.updateCopy(c);
      return;
    } else if (s.kind === 'prop') {
      this.propLayer.move(s.i, [p.x, p.y, p.z], this.proxy.rotation.y); this.markDirty('props');
      const P = this.propLayer.doc.props[s.i];
      for (const [id, v] of [['lp-x', P.pos[0]], ['lp-y', P.pos[1]], ['lp-z', P.pos[2]], ['lp-yaw', ((P.yaw * 180 / Math.PI) % 360 + 360) % 360]]) if ($(id)) $(id).value = fmt(v, id === 'lp-yaw' ? 1 : 2);
      return;
    }
    this.renderSelFields();
  }
  endDrag() {
    if (this.sel?.kind === 'object') { this.commitObject(); }
    if (this.sel?.kind === 'spline') this.spawnLayer.build(); // spawns stand at their spline's first point
    if (this.sel?.kind === 'copy') this.coll.updateHighlight();
    this.renderSel();
  }

  // ------------------------------------------------------------ new objects (copies of scene objects, added on save)
  // A copy is { src, pivot0 (source centre at load), pos (copy centre), rotY, T (row form: source at load -> copy), group, meshes }.
  loadTimeMatrix(di) { return this.origMats.get(di) || this.gsc.draws[di].matrix; }
  duplicateObject(o) {
    const S = this.gsc, obj = S.objects[o];
    if (!obj || obj.loose || !obj.draws.length || obj.draws.some(di => S.draws[di].matrixAt < 0)) return status('This object can\'t be copied (it is not a regular scene object).', true);
    // source box at load time
    const box = new THREE.Box3(), v = new THREE.Vector3();
    for (const di of obj.draws) { const P = transformPoints(S.readPositions(S.draws[di]), this.loadTimeMatrix(di)); for (let i = 0; i < P.length; i += 3) box.expandByPoint(v.set(P[i], P[i + 1], P[i + 2])); }
    const pivot0 = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    const c = { src: o, pivot0, pos: pivot0.clone().add(new THREE.Vector3(Math.max(size.x, 2) + 2, 0, 0)), rotY: 0, size };
    const srcName = (obj.instances || []).map(i => S.instances[i].name).find(Boolean);
    c.name = srcName ? this.uniqueInstanceName(srcName) : '';
    // preview: the source's draws at load time, placed by T
    c.group = new THREE.Group(); c.group.matrixAutoUpdate = false; c.meshes = [];
    for (const di of obj.draws) {
      const d = S.draws[di], g = S.drawGeometry(d);
      const P = transformPoints(S.readPositions(d), this.loadTimeMatrix(di));
      const bg = new THREE.BufferGeometry();
      bg.setAttribute('position', new THREE.BufferAttribute(P, 3)); bg.setAttribute('uv', new THREE.BufferAttribute(g.UV, 2)); bg.setAttribute('color', new THREE.BufferAttribute(g.C, 3));
      bg.setIndex(Array.from(g.tris));
      const map = this.texture(S.materials[d.material]?.tex ?? -1);
      const m = new THREE.Mesh(bg, new THREE.MeshBasicMaterial({ map, vertexColors: true, side: THREE.DoubleSide, alphaTest: map?.userData.hasAlpha ? 0.5 : 0 }));
      m.userData.sel = { kind: 'copy', i: this.copies.length };
      c.group.add(m); c.meshes.push(m);
    }
    this.vp.root.add(c.group);
    this.copies.push(c);
    this.updateCopy(c);
    this.markDirty('gsc');
    this.select({ kind: 'copy', i: this.copies.length - 1 });
    status(`Copy of object #${o} added. Move it with the gizmo; it is written into the level when you save.`);
  }
  // "Name_copy1", "Name_copy2"… not used by any instance or pending copy (63 characters at most)
  uniqueInstanceName(base) {
    const taken = new Set([...this.gsc.instances.map(i => i.name.toLowerCase()), ...this.copies.map(c => (c.name || '').toLowerCase())]);
    const stem = base.replace(/_copy\d+$/i, '');
    for (let n = 1; ; n++) { const s = `_copy${n}`, name = stem.slice(0, 63 - s.length) + s; if (!taken.has(name.toLowerCase())) return name; }
  }
  nameProblem(c) {
    if (!c.name) return '';
    if (!/^[\x21-\x7e]{1,63}$/.test(c.name)) return 'Use 1–63 plain characters, no spaces.';
    const low = c.name.toLowerCase();
    if (this.gsc.instances.some(i => i.name.toLowerCase() === low)) return 'Already used by an object in this level.';
    if (this.copies.filter(x => (x.name || '').toLowerCase() === low).length > 1) return 'Two new objects have this name.';
    return '';
  }
  updateCopy(c) {
    c.T = this.pivotTransform(c.pivot0, c.pos.clone().sub(c.pivot0), c.rotY);
    c.group.matrix.fromArray(c.T); c.group.matrixWorldNeedsUpdate = true;
  }
  copyBox(c) {
    const b = new THREE.Box3().setFromCenterAndSize(c.pos, c.size); return b;
  }
  removeCopyPreview(c) { this.vp.root.remove(c.group); for (const m of c.meshes) { m.geometry.dispose(); m.material.dispose(); } }
  removeCopy(i) {
    this.removeCopyPreview(this.copies[i]);
    this.copies.splice(i, 1);
    this.copies.forEach((c, k) => c.meshes.forEach(m => { m.userData.sel = { kind: 'copy', i: k }; }));
    this.select(null);
    if (!this.copies.length && !this.hasSceneEdits()) this.dirty.delete('gsc');
    this.renderDirty();
  }
  hasSceneEdits() {
    if (this.replacedTex.size || this.hidden.size) return true;
    for (const [di, m] of this.origMats) if (!sameArr(m, this.gsc.draws[di].matrix)) return true;
    return this.origVerts.size > 0;
  }

  // ------------------------------------------------------------ geometry objects (moving vertices in the VBs)
  objectRanges(o) {
    const S = this.gsc, keys = new Map();
    for (const di of S.objects[o].draws) { const d = S.draws[di]; if (!keys.has(d.key)) keys.set(d.key, d); }
    return keys; // key -> representative draw (its matrix converts world <-> stored vertex space)
  }

  beginObject(o) {
    const S = this.gsc;
    const box = new THREE.Box3();
    for (const di of S.objects[o].draws) {
      const pl = this.drawPlace[di]; if (!pl) continue;
      const P = pl.mesh.geometry.attributes.position.array;
      for (let i = pl.v; i < pl.v + pl.n; i++) box.expandByPoint(new THREE.Vector3(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]));
    }
    this.objBox = box;
    this.objPivot = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    // Snapshot the object's current state; every gizmo update is recomputed from this snapshot.
    // Draws with a matrix are moved by editing that matrix (one instance); others by rewriting vertices.
    this.objSnap = new Map(); this.objSnapM = new Map();
    for (const di of S.objects[o].draws) {
      const d = S.draws[di];
      if (d.matrixAt >= 0) {
        if (!this.origMats.has(di)) this.origMats.set(di, d.matrix.slice());
        this.objSnapM.set(di, d.matrix.slice());
      }
    }
    for (const [key, d] of this.objectRanges(o)) {
      if (d.matrixAt >= 0) continue;
      if (!this.origVerts.has(key)) this.origVerts.set(key, S.readPositions(d));
      this.objSnap.set(key, { d, P: S.readPositions(d) });
    }
    this.buildHighlight(o);
  }

  // row-form 4x4 for: world' = (world - c) * Ry(rotY) * scale + c + delta
  pivotTransform(c, delta, rotY, scale = 1) {
    const T = new THREE.Matrix4().makeTranslation(c.x + delta.x, c.y + delta.y, c.z + delta.z)
      .multiply(new THREE.Matrix4().makeRotationY(rotY))
      .multiply(new THREE.Matrix4().makeScale(scale, scale, scale))
      .multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
    return Float64Array.from(T.elements); // three's column-major array == the row-form matrix
  }

  refreshDraw(di) {
    const S = this.gsc, d = S.draws[di], pl = this.drawPlace[di]; if (!pl) return;
    const P = S.readPositions(d);
    if (d.matrix) transformPoints(P, d.matrix);
    pl.mesh.geometry.attributes.position.array.set(P, pl.v * 3);
    pl.mesh.geometry.attributes.position.needsUpdate = true;
  }

  buildHighlight(o) {
    if (this.highlight) { this.vp.root.remove(this.highlight); this.highlight.geometry.dispose(); }
    const S = this.gsc, pos = [], idx = [];
    for (const di of S.objects[o].draws) {
      const pl = this.drawPlace[di]; if (!pl) continue;
      const P = pl.mesh.geometry.attributes.position.array, I = pl.mesh.geometry.index.array, base = pos.length / 3;
      for (let i = pl.v; i < pl.v + pl.n; i++) pos.push(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
      for (let k = pl.t; k < pl.t + pl.nt; k++) idx.push(I[k] - pl.v + base);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    this.highlight = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xe8a33d, wireframe: true, depthTest: false, transparent: true, opacity: 0.6 }));
    this.highlight.renderOrder = 20;
    this.vp.root.add(this.highlight);
  }

  moveObject(delta, rotY) {
    const S = this.gsc, c = this.dragStart.pos;
    if (this.objSnapM.size) {
      const T = this.pivotTransform(c, delta, rotY);
      for (const [di, M] of this.objSnapM) { S.writeMatrix(S.draws[di], M4.mul(M, T)); this.refreshDraw(di); }
    }
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
    const v = new THREE.Vector3();
    for (const [key, { d, P }] of this.objSnap) {
      const W = P.slice();
      if (d.matrix) transformPoints(W, d.matrix);
      for (let i = 0; i < W.length; i += 3) {
        v.set(W[i], W[i + 1], W[i + 2]).sub(c).applyQuaternion(q).add(c).add(delta);
        W[i] = v.x; W[i + 1] = v.y; W[i + 2] = v.z;
      }
      const L = d.matrix ? transformPoints(W.slice(), M4.invert3x4(d.matrix)) : W;
      S.writePositions(d, L);
      this.refreshRange(key);
    }
    this.markDirty('gsc');
    this.buildHighlight(this.sel.i);
  }

  refreshRange(key) {
    const S = this.gsc;
    for (const di of this.rangeDraws.get(key)) {
      const d = S.draws[di], pl = this.drawPlace[di]; if (!pl) continue;
      const P = S.readPositions(d);
      if (d.matrix) transformPoints(P, d.matrix);
      pl.mesh.geometry.attributes.position.array.set(P, pl.v * 3);
      pl.mesh.geometry.attributes.position.needsUpdate = true;
    }
  }

  commitObject() {
    for (const m of this.levelMeshes) { m.geometry.computeBoundingSphere(); m.geometry.boundsTree?.refit(); }
    this.beginObject(this.sel.i);
    this.attachGizmo();
    this.coll.updateHighlight();
  }

  hideObject(o) {
    const S = this.gsc;
    // matrix draws: scale to a point at the object's centre (affects only this instance)
    const T = this.pivotTransform(this.objPivot, new THREE.Vector3(), 0, 0);
    for (const di of S.objects[o].draws) {
      const d = S.draws[di]; if (d.matrixAt < 0) continue;
      if (!this.origMats.has(di)) this.origMats.set(di, d.matrix.slice());
      S.writeMatrix(d, M4.mul(d.matrix, T)); this.refreshDraw(di);
    }
    for (const [key, d] of this.objectRanges(o)) {
      if (d.matrixAt >= 0) continue;
      if (!this.origVerts.has(key)) this.origVerts.set(key, S.readPositions(d));
      const P = S.readPositions(d);
      for (let i = 3; i < P.length; i += 3) { P[i] = P[0]; P[i + 1] = P[1]; P[i + 2] = P[2]; }
      S.writePositions(d, P);
      this.refreshRange(key);
    }
    this.hidden.add(o);
    this.markDirty('gsc');
    this.commitObject(); this.renderSel();
  }

  resetObject(o) {
    const S = this.gsc;
    for (const di of S.objects[o].draws) {
      const orig = this.origMats.get(di);
      if (orig) { S.writeMatrix(S.draws[di], orig); this.refreshDraw(di); }
    }
    for (const [key, d] of this.objectRanges(o)) {
      if (d.matrixAt >= 0) continue;
      const orig = this.origVerts.get(key);
      if (orig) { S.writePositions(d, orig); this.refreshRange(key); }
    }
    this.hidden.delete(o);
    this.markDirty('gsc');
    this.commitObject(); this.renderSel();
  }

  // ------------------------------------------------------------ textures (replaced through the rebuilding writer)
  textureInfo(i) {
    const t = this.gsc.textures[i], dv = this.gsc.dv, h = t.offset - 24;
    const fmtCode = this.gsc.ps3 ? t.fmt : dv.getInt32(h + 12, true);
    const users = this.gsc.materials.reduce((n, m) => n + (m.tex === i), 0);
    return { w: Math.abs(t.w), h: t.h, mips: t.mips, kind: { 12: 'DXT1', 14: 'DXT1', 15: 'DXT5' }[fmtCode] || `fmt ${fmtCode}`, cube: t.cube, users, size: t.size };
  }
  textureRow(i) {
    const k = this.textureInfo(i);
    return `<div style="display:flex;align-items:center;gap:6px;margin:3px 0;white-space:nowrap">
      <span class="mono" style="min-width:34px">#${i}</span>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis" title="${k.users} material(s) use it">${k.w}×${k.h} ${k.kind}${k.cube ? ' cube' : ''}${this.replacedTex.has(i) ? ' <span class="tag anim">new</span>' : ''}</span>
      <button class="b" data-texexp="${i}" title="Download this texture as .dds">Export</button><button class="b" data-texrep="${i}" ${k.cube ? 'disabled' : ''} title="Load a DXT1/DXT5 .dds of any power-of-two size">Replace…</button></div>`;
  }
  bindTextureRows(s) {
    const box = $('ls-texs'), file = $('ls-texfile');
    box.onclick = e => {
      const ex = e.target.dataset.texexp, rp = e.target.dataset.texrep;
      if (ex != null) this.exportTexture(+ex);
      if (rp != null) { file.dataset.tex = rp; file.value = ''; file.click(); }
    };
    file.onchange = async () => {
      const f = file.files[0]; if (!f) return;
      try { this.replaceTexture(+file.dataset.tex, new Uint8Array(await f.arrayBuffer())); this.select(s); }
      catch (e) { status(`Texture not replaced: ${e.message}`, true); }
    };
  }
  exportTexture(i) {
    const blob = new Blob([this.gsc.dds(this.gsc.textures[i])], { type: 'image/vnd-ms.dds' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${this.gscPath.split('/').pop().replace(/\.gsc$/i, '')}_tex${i}.dds`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  // Swap texture i for a DDS of any size (DXT1 or DXT5). The file is rebuilt, so sizes and offsets may change.
  replaceTexture(i, dds) {
    if (this.gsc.readOnly) throw new Error('PS3 scenes are view-only');
    const dv = new DataView(dds.buffer, dds.byteOffset, dds.byteLength);
    if (dds.length < 128 || String.fromCharCode(...dds.subarray(0, 4)) !== 'DDS ') throw new Error('not a DDS file');
    const cc = String.fromCharCode(...dds.subarray(84, 88));
    if (cc !== 'DXT1' && cc !== 'DXT5') throw new Error(`it is ${cc.replace(/\0/g, '') || 'uncompressed'}; save it as DXT1 (no alpha) or DXT5 (alpha)`);
    if (dv.getUint32(112, true) & 0x200) throw new Error('cube maps are not supported');
    const h = dv.getUint32(12, true), w = dv.getUint32(16, true), mips = Math.max(1, dv.getUint32(28, true));
    if (!w || !h || w > 4096 || h > 4096 || (w & (w - 1)) || (h & (h - 1))) throw new Error(`size ${w}×${h}: use powers of two up to 4096`);
    const F = GSCFile.fromBuffer(this.gsc.buf);
    const t = F.textures[i], hv = new DataView(t.head.buffer, t.head.byteOffset, 20);
    const old = hv.getInt32(12, true);
    hv.setInt32(0, w, true); hv.setInt32(4, h, true); hv.setInt32(8, mips, true);
    hv.setInt32(12, cc === 'DXT5' ? 15 : (old === 12 || old === 14 ? old : 12), true);
    t.dds = dds.slice();
    this.adoptBuffer(F.build().buffer);
    this.replacedTex.add(i);
    // refresh every level mesh drawn with this texture
    this.texCache.get(i)?.dispose(); this.texCache.delete(i);
    const map = this.texture(i);
    for (const m of this.levelMeshes) if (m.userData.tex === i) {
      m.material.map = map; m.material.userData.tex = map; m.material.alphaTest = map?.userData.hasAlpha ? 0.5 : 0; m.material.needsUpdate = true;
    }
    this.markDirty('gsc'); this.renderInfo();
    status(`Texture #${i} replaced (${w}×${h} ${cc}). Save to write the .GSC.`);
  }
  // a new prop (the selected prop's type, else type 0) on the ground under the point the camera orbits
  addProp() {
    const L = this.propLayer;
    if (!L.doc) { status(L.error ? `Props: ${L.error}` : 'This level has no prop file.', true); return; }
    const t = this.sel?.kind === 'prop' ? L.doc.props[this.sel.i].type : 0;
    const at = this.toGame(this.nav.target);
    const ray = new THREE.Raycaster(this.toWorld(at.clone().setY(at.y + 50)), new THREE.Vector3(0, -1, 0));
    const g = this.pickPoint(ray, { top: true });
    if (g) at.y = this.toGame(g).y;
    $('l-props').checked = true; this.applyToggles();
    const i = L.add(t, [at.x, at.y, at.z], 0);
    this.markDirty('props'); this.renderList(); this.select({ kind: 'prop', i });
    status(`Added a ${L.typeName(t)} at ${fmt(at.x, 1)}, ${fmt(at.y, 1)}, ${fmt(at.z, 1)}. Change its type in the panel; save writes ${L.path.split('/').pop()}.`);
  }

  // ------------------------------------------------------------ meshes to and from Blender
  // other objects drawn with one of this object's draw records (the same model placed again)
  meshSharers(o) {
    const S = this.gsc, recs = new Set(S.objects[o].draws.map(di => S.draws[di].cmdRec)), out = new Set();
    for (const d of S.draws) if (d.object !== o && recs.has(d.cmdRec)) out.add(d.object);
    return [...out];
  }

  async exportMesh(o) {
    status('Exporting…');
    const S = this.gsc, ins = (S.objects[o].instances || []).map(i => S.instances[i].name).find(Boolean);
    const name = `${$('l-level').value}_${ins || 'object' + o}`.replace(/[^\w.-]+/g, '_');
    const glb = await exportObjectGLB(S, o, { name, level: this.gscPath });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([glb], { type: 'model/gltf-binary' }));
    a.download = name + '.glb';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    status(`Exported object #${o} as ${name}.glb (${S.objects[o].draws.length} parts).`);
  }

  async importMesh(o, buffer, fileName = '') {
    if (this.gsc.readOnly) throw new Error('PS3 scenes are view-only');
    status(`Reading ${fileName}…`);
    const S = this.gsc;
    const { parts, notes } = await readEditedGLB(buffer, S, o);
    if (!parts.size) throw new Error(`no parts of object #${o} in ${fileName} (${notes.join('; ') || 'nothing named draw_…'})`);
    const F = GSCFile.fromBuffer(S.buf);
    const rep = applyMeshEdits(F, S, parts);
    this.adoptBuffer(F.build().buffer);
    this.rebuildGeometry();
    this.markDirty('gsc');
    this.select({ kind: 'object', i: o });
    status(`Imported ${fileName}: ${rep.parts} part${rep.parts === 1 ? '' : 's'}, ${rep.tris.toLocaleString()} triangles.`
      + (rep.alsoChanged.length ? ` Also changed (same model): #${rep.alsoChanged.join(', #')}.` : '')
      + (notes.length ? ` ${notes.join('; ')}.` : '') + ' Save to write the .GSC; Reload from disk undoes it.');
  }

  // rebuild every level mesh from the current scene (after vertex or index data changed size)
  rebuildGeometry() {
    const sel = this.sel;
    this.select(null);
    if (this.geoGroup) { this.vp.root.remove(this.geoGroup); this.geoGroup.traverse(x => { x.geometry?.disposeBoundsTree?.(); x.geometry?.dispose(); }); }
    this.buildGeometry();
    this.applyToggles();
    this.coll.dispose(); if ($('l-coll').checked) this.coll.setVisible(true);
    if (sel) this.select(sel);
  }

  // Re-read the scene from a rebuilt file. Draw and object numbering is unchanged, so the meshes stay.
  adoptBuffer(buf) {
    const S = new GSCScene(buf);
    if (S.draws.length !== this.gsc.draws.length) throw new Error('rebuilt scene does not match');
    for (const d of S.draws) d.key = `${d.vb}:${d.base}:${d.count}`;
    this.gsc = S;
  }

  collisionLine(o) {
    if (!this.coll.available) return '<span class="hint">no collision data</span>';
    const c = this.coll.claimsOf(o);
    const parts = [];
    if (c.polyCount) parts.push(`${c.polyCount.toLocaleString()} world polygon${c.polyCount === 1 ? '' : 's'}`);
    if (c.bodies.length) parts.push(`${c.bodies.length} physics bod${c.bodies.length === 1 ? 'y' : 'ies'}`);
    return parts.length ? parts.join(' · ') : '<span class="hint">none found (not solid, or simplified separately)</span>';
  }

  // ------------------------------------------------------------ inspector
  renderSel() {
    const s = this.sel, E = $('l-sel');
    if (!s) { E.innerHTML = '<span class="hint">Click geometry, a marker, or an item in the list.<br>G: move · R: rotate · F: focus · Esc: deselect</span>'; return; }
    if (s.kind === 'spawn') {
      const L = this.spawnLayer;
      E.innerHTML = L.panel(s.i);
      const edit = (k, v) => { L.set(s.i, k, v); this.markDirty('spawns'); this.renderList(); this.renderSel(); };
      $('ls-sptype').onchange = e => edit('Type', e.target.value);
      $('ls-spcount').onchange = e => edit('count', e.target.value.trim());
      $('ls-spmax').onchange = e => edit('maxalive', e.target.value.trim());
      $('ls-spspline').onchange = e => edit('Spline', e.target.value);
      $('ls-spon').onchange = e => edit('off', !e.target.checked);
      $('ls-spfocus').onclick = () => this.focus();
      $('ls-spedit').onclick = () => { const k = this.splines.list.indexOf(L.splineOf(L.spawns[s.i])); if (k >= 0) { $('l-spl').checked = true; this.applyToggles(); this.select({ kind: 'spline', i: k, point: 0 }); } };
      $('ls-spdup').onclick = () => { const i = L.duplicate(s.i); this.markDirty('spawns'); this.renderList(); this.select({ kind: 'spawn', i }); };
      return;
    }
    if (s.kind === 'prop') {
      const L = this.propLayer;
      E.innerHTML = L.panel(s.i);
      const num = id => +$(id).value;
      const apply = () => { L.move(s.i, [num('lp-x'), num('lp-y'), num('lp-z')], num('lp-yaw') * Math.PI / 180); this.markDirty('props'); this.attachGizmo(); };
      for (const id of ['lp-x', 'lp-y', 'lp-z', 'lp-yaw']) $(id).onchange = apply;
      $('lp-type').onchange = e => { L.setType(s.i, +e.target.value); this.markDirty('props'); this.select({ kind: 'prop', i: s.i }); };
      $('lp-dup').onclick = () => { const p = L.doc.props[s.i]; const i = L.add(p.type, [p.pos[0] + 2, p.pos[1], p.pos[2]], p.yaw); this.markDirty('props'); this.renderList(); this.select({ kind: 'prop', i }); };
      $('lp-del').onclick = () => { L.remove(s.i); this.markDirty('props'); this.select(null); this.renderList(); };
      $('lp-focus').onclick = () => this.focus();
      return;
    }
    if (s.kind === 'object') {
      const S = this.gsc, o = S.objects[s.i];
      const ranges = this.objectRanges(s.i);
      let shared = new Set();
      for (const [key, d] of ranges) if (d.matrixAt < 0) for (const di of this.rangeDraws.get(key)) if (S.draws[di].object !== s.i) shared.add(S.draws[di].object);
      const viaMatrix = o.draws.every(di => S.draws[di].matrixAt >= 0);
      const mats = [...new Set(o.draws.map(di => S.draws[di].material))];
      const texs = [...new Set(mats.map(m => S.materials[m]?.tex ?? -1))];
      const verts = [...ranges.values()].reduce((a, d) => a + d.count, 0);
      const tris = o.draws.reduce((a, di) => a + (this.drawPlace[di]?.nt || 0) / 3, 0);
      const sz = this.objBox.getSize(new THREE.Vector3());
      const moved = [...ranges.keys()].some(k => this.origVerts.has(k) && !sameArr(this.origVerts.get(k), S.readPositions(ranges.get(k))))
        || o.draws.some(di => this.origMats.has(di) && !sameArr(this.origMats.get(di), S.draws[di].matrix));
      E.innerHTML = `<table class="kv">
        <tr><td>Scene object</td><td>#${s.i}${o.loose ? ' <span class="tag">not in object table</span>' : ''}${this.hidden.has(s.i) ? ' <span class="tag">hidden</span>' : moved ? ' <span class="tag anim">edited</span>' : ''}</td></tr>
        <tr><td>Name</td><td class="mono">${(o.instances || []).map(i => esc(S.instances[i].name)).join(', ') || '<span class="hint">none (no scene instance)</span>'}</td></tr>
        <tr><td>Draws</td><td>${o.draws.length}</td></tr>
        <tr><td>Triangles / verts</td><td>${tris.toLocaleString()} / ${verts.toLocaleString()}</td></tr>
        <tr><td>Materials</td><td class="mono">${mats.join(', ')}</td></tr>
        <tr><td>Edited via</td><td>${viaMatrix ? 'its placement matrix (this copy only)' : 'vertex data'}</td></tr>
        <tr><td>Centre</td><td class="mono">${fmt(this.objPivot.x, 2)}, ${fmt(this.objPivot.y, 2)}, ${fmt(this.objPivot.z, 2)}</td></tr>
        <tr><td>Size</td><td class="mono">${fmt(sz.x, 2)} × ${fmt(sz.y, 2)} × ${fmt(sz.z, 2)}</td></tr>
        <tr><td>Collision</td><td>${this.collisionLine(s.i)}</td></tr>
      </table>
      ${shared.size ? `<p class="warn">Shares vertices with ${shared.size} other object(s); they move too.</p>` : ''}
      <div class="row" style="margin-top:6px"><button class="b" id="ls-hide">Hide</button><button class="b" id="ls-reset">Reset to original</button><button class="b" id="ls-focus">Focus</button>
        <button class="b" id="ls-dupobj" title="Add a copy of this object to the level (written when you save)" ${o.loose ? 'disabled' : ''}>Duplicate</button></div>
      <p class="hint">Moving or hiding rewrites this object's ${viaMatrix ? 'matrices' : 'vertices'} in the .GSC. With "Collision follows edits" on, saving also moves (or removes) the collision listed above. Turn on <b>Collision</b> in the toolbar to see it in orange.</p>
      <h3 style="margin:10px 0 4px">Mesh (Blender)</h3>
      <div class="row"><button class="b" id="ls-glbout" title="Download this object as a .glb for Blender">Export .glb</button>
        <button class="b" id="ls-glbin" title="Read an edited .glb back into this object" ${S.readOnly ? 'disabled' : ''}>Import .glb…</button></div>
      ${(() => { const n = this.meshSharers(s.i).length; return n ? `<p class="warn">Its mesh is also used by ${n} other object${n === 1 ? '' : 's'} (the same model placed again): an imported mesh changes ${n === 1 ? 'it' : 'them'} too.</p>` : ''; })()}
      <p class="hint">In Blender: File › Import › glTF, edit, then File › Export › glTF (.glb). Keep the parts' names (<span class="mono">draw_…</span>). A new piece joins the part with the same <span class="mono">tex…</span> material. Collision isn't changed by an import.</p>
      <input type="file" id="ls-glbfile" accept=".glb,.gltf" class="hidden">
      <h3 style="margin:10px 0 4px">Textures</h3>
      <div id="ls-texs">${texs.filter(t => t >= 0).map(t => this.textureRow(t)).join('') || '<span class="hint">none</span>'}</div>
      <p class="hint">A texture can be shared: replacing it changes every surface that uses it.</p>
      <input type="file" id="ls-texfile" accept=".dds" class="hidden">`;
      this.bindTextureRows(s);
      $('ls-dupobj').onclick = () => this.duplicateObject(s.i);
      $('ls-glbout').onclick = () => this.exportMesh(s.i).catch(e => { console.error(e); status(`Export failed: ${e.message}`, true); });
      $('ls-glbin').onclick = () => $('ls-glbfile').click();
      $('ls-glbfile').onchange = async e => {
        const f = e.target.files[0]; e.target.value = '';
        if (f) try { await this.importMesh(s.i, await f.arrayBuffer(), f.name); } catch (x) { console.error(x); status(`Import failed: ${x.message}`, true); }
      };
      $('ls-hide').onclick = () => this.hideObject(s.i);
      $('ls-reset').onclick = () => this.resetObject(s.i);
      $('ls-focus').onclick = () => this.focus();
      return;
    }
    if (s.kind === 'copy') {
      const c = this.copies[s.i], src = this.gsc.objects[c.src];
      const names = (src.instances || []).map(i => this.gsc.instances[i].name).filter(Boolean);
      E.innerHTML = `<table class="kv">
        <tr><td>New object</td><td>copy ${s.i + 1} of ${this.copies.length} <span class="tag anim">added on save</span></td></tr>
        <tr><td>Copy of</td><td>object #${c.src}${names.length ? ` <span class="mono">${esc(names[0])}</span>` : ''}</td></tr>
        <tr><td>Draws</td><td>${src.draws.length}</td></tr>
        <tr><td>Centre</td><td class="mono">${fmt(c.pos.x, 2)}, ${fmt(c.pos.y, 2)}, ${fmt(c.pos.z, 2)}</td></tr>
        <tr><td>Turn</td><td class="mono">${fmt(c.rotY * 180 / Math.PI, 1)}°</td></tr>
        <tr><td>Collision</td><td>${this.collisionLine(c.src)}</td></tr>
      </table>
      <div class="fields" style="margin-top:6px"><label title="Scene instance name. Scripts and props find objects by this name. Leave empty for plain scenery.">Name</label>
        <input type="text" id="ls-cname" maxlength="63" placeholder="(no name: scenery only)" value="${esc(c.name || '')}"></div>
      <p class="warn" id="ls-cnamewarn">${esc(this.nameProblem(c))}</p>
      <div class="row" style="margin-top:6px"><button class="b" id="ls-cfocus">Focus</button><button class="b" id="ls-cdup">Duplicate again</button><button class="b" id="ls-crem">Remove copy</button></div>
      <p class="hint">G moves it, R turns it. Saving adds it to the .GSC as a new scene object that reuses the source's
        mesh${this.coll.available ? ', with a copy of its collision when "Collision follows edits" is on' : ''}. The level reloads after saving.
        With a name it also gets its own scene instance (a copy of the source's, moved), so scripts can find it by that name.
        A physics body (a lamp post or tree that falls over, a building piece that breaks off) is copied too when the copy
        has a name, because the body hangs on the instance; without a name the copy is solid scenery only.</p>`;
      $('ls-cname').oninput = e => { c.name = e.target.value.trim(); $('ls-cnamewarn').textContent = this.nameProblem(c); };
      $('ls-cfocus').onclick = () => this.focus();
      $('ls-cdup').onclick = () => { this.duplicateObject(c.src); const n = this.copies[this.copies.length - 1]; if (c.name) n.name = this.uniqueInstanceName(c.name); n.pos.copy(c.pos).add(new THREE.Vector3(Math.max(c.size.x, 2) + 2, 0, 0)); n.rotY = c.rotY; this.updateCopy(n); this.attachGizmo(); this.renderSel(); };
      $('ls-crem').onclick = () => this.removeCopy(s.i);
      return;
    }
    if (s.kind === 'placement' || s.kind === 'trigger') {
      const doc = s.kind === 'placement' ? this.placements : this.triggers;
      E.innerHTML = `<div class="row" style="margin-bottom:6px"><b>${s.kind === 'placement' ? 'Placement' : 'Trigger'} #${s.i}</b>
        <button class="b" id="ls-dup">Duplicate</button><button class="b" id="ls-del">Delete</button><button class="b" id="ls-focus">Focus</button></div>
        <div class="fields" id="ls-fields"></div>
        <div class="row" style="margin-top:6px"><button class="b" id="ls-add">+ New ${s.kind} at view centre</button></div>
        <p class="hint">${s.kind === 'placement' ? 'Shown at Pos ÷ Scale (Scale is 10 in the shipped files, matching splines and triggers).' : 'Box drawn at full BoxSize; Rotation assumed 65536 per turn.'}</p>`;
      this.renderSelFields();
      $('ls-focus').onclick = () => this.focus();
      $('ls-del').onclick = () => { doc.doc.blocks.splice(s.i, 1); this.markDirty(s.kind === 'placement' ? 'placements' : 'triggers'); this.sel = null; this.buildMarkers(); this.select(null); };
      $('ls-dup').onclick = () => { const b = doc.doc.blocks[s.i]; const c = { type: b.type, fields: b.fields.map(f => [...f]) }; const n = iniGet(c, 'TagString'); if (n) iniSet(c, 'TagString', `"${unquote(n)}_copy"`); doc.doc.blocks.splice(s.i + 1, 0, c); this.afterAdd(s.kind, s.i + 1); };
      $('ls-add').onclick = () => this.addBlock(s.kind);
      return;
    }
    if (s.kind === 'spline') {
      const sp = this.splines.list[s.i];
      E.innerHTML = `<div class="row" style="margin-bottom:6px"><b>Spline</b> <span class="tag">${sp.points.length} points</span><button class="b" id="ls-focus">Focus</button></div>
        <div class="fields"><label>Name</label><input type="text" id="ls-name" maxlength="31" value="${esc(sp.name)}">
        <label>Point</label><select id="ls-pt">${sp.points.map((_, k) => `<option value="${k}" ${k === s.point ? 'selected' : ''}>${k}</option>`).join('')}</select></div>
        <div class="fields" id="ls-fields" style="margin-top:6px"></div>
        <div class="row" style="margin-top:6px"><button class="b" id="ls-ins">Insert point after</button><button class="b" id="ls-delpt" ${sp.points.length < 2 ? 'disabled' : ''}>Delete point</button></div>
        <p class="hint">Scripts refer to splines by name (FollowSpline, #KeyLocation…).</p>`;
      this.renderSelFields();
      $('ls-focus').onclick = () => this.focus();
      $('ls-name').onchange = e => { sp.name = e.target.value.slice(0, 31); this.splObjs[s.i].userData.label.element.textContent = sp.name; this.markDirty('splines'); this.renderList(); };
      $('ls-pt').onchange = e => { s.point = +e.target.value; this.attachGizmo(); this.renderSelFields(); };
      $('ls-ins').onclick = () => {
        const a = sp.points[s.point], b = sp.points[s.point + 1] || a.map((x, k) => x + (k === 0 ? 4 : 0));
        sp.points.splice(s.point + 1, 0, a.map((x, k) => (x + b[k]) / 2)); s.point++;
        this.updateSpline(s.i); this.markDirty('splines'); this.select(s);
      };
      $('ls-delpt').onclick = () => { sp.points.splice(s.point, 1); s.point = Math.max(0, s.point - 1); this.updateSpline(s.i); this.markDirty('splines'); this.select(s); };
    }
  }

  renderSelFields() {
    const s = this.sel, F = $('ls-fields'); if (!F || !s) return;
    if (s.kind === 'spline') {
      const p = this.splines.list[s.i].points[s.point] || [0, 0, 0];
      F.innerHTML = ['X', 'Y', 'Z'].map((a, k) => `<label>${a}</label><input type="number" step="0.1" data-k="${k}" value="${fmt(p[k], 3)}">`).join('');
      F.onchange = e => { const k = +e.target.dataset.k; this.splines.list[s.i].points[s.point][k] = parseFloat(e.target.value) || 0; this.updateSpline(s.i); this.attachGizmo(); this.markDirty('splines'); };
      return;
    }
    const doc = s.kind === 'placement' ? this.placements : this.triggers, b = doc.doc.blocks[s.i];
    F.innerHTML = b.fields.map(([k, v], j) => `<label>${esc(k)}</label><input type="text" data-j="${j}" value="${esc(v)}">`).join('');
    F.onchange = e => {
      const j = +e.target.dataset.j; b.fields[j][1] = e.target.value;
      if (s.kind === 'placement') { this.updatePlacement(s.i); this.placeObjs[s.i].children[0].element.textContent = unquote(iniGet(b, 'TagString')); }
      else { this.updateTrigger(s.i); this.trigObjs[s.i].userData.label.element.textContent = unquote(iniGet(b, 'TagString')); }
      this.attachGizmo(); this.markDirty(s.kind === 'placement' ? 'placements' : 'triggers'); this.renderList();
    };
  }

  addBlock(kind) {
    const t = this.vp.controls.target.clone();
    this.vp.root.worldToLocal(t);
    if (kind === 'placement') {
      const b = { type: 'Placement', fields: [['TagString', '"NewPlacement"'], ['PosX', fmt(t.x * 10, 2)], ['PosY', fmt(t.y * 10, 2)], ['PosZ', fmt(t.z * 10, 2)], ['RotX', '0'], ['RotY', '0'], ['RotZ', '0'], ['Scale', '10']] };
      this.placements.doc.blocks.push(b); this.afterAdd(kind, this.placements.doc.blocks.length - 1);
    } else {
      const b = { type: 'Trigger', fields: [['TagString', '"NewTrigger"'], ['Type', '0'], ['ActivatorCount', '1'], ['Layers', '0'], ['PosX', fmt(t.x, 6)], ['PosY', fmt(t.y, 6)], ['PosZ', fmt(t.z, 6)], ['Rotation', '0'], ['BoxSizeX', '10'], ['BoxSizeY', '5'], ['BoxSizeZ', '10']] };
      this.triggers.doc.blocks.push(b); this.afterAdd(kind, this.triggers.doc.blocks.length - 1);
    }
  }
  afterAdd(kind, i) { this.markDirty(kind === 'placement' ? 'placements' : 'triggers'); this.buildMarkers(); this.select({ kind, i }); }

  renderInfo() {
    const S = this.gsc;
    const cnt = k => this[k] ? (k === 'splines' ? this.splines.list.length : this[k].doc.blocks.length) : '–';
    $('l-info').innerHTML = `<table class="kv">
      <tr><td>Folder</td><td class="mono">${esc(this.dir)}</td></tr>
      ${S ? `<tr><td>Scene</td><td class="mono">${esc(this.gscPath.split('/').pop())}${S.ps3 ? ' <span class="tag anim">PS3 · view-only</span>' : ''}</td></tr>
      <tr><td>Draws / objects</td><td>${S.draws.length.toLocaleString()} / ${S.objects.length.toLocaleString()}</td></tr>
      <tr><td>Triangles</td><td>${Math.round(this.triCount).toLocaleString()}</td></tr>
      <tr><td>Materials / textures</td><td>${S.nmat} / ${S.textures.length}</td></tr>
      <tr><td>Vertex buffers</td><td>${S.vbs.length}</td></tr>
      <tr><td>Collision</td><td>${esc(this.coll.summary())}</td></tr>` : '<tr><td>Scene</td><td>none</td></tr>'}
      <tr><td>Placements</td><td>${cnt('placements')}</td></tr>
      <tr><td>Triggers</td><td>${cnt('triggers')}</td></tr>
      <tr><td>Splines</td><td>${cnt('splines')}</td></tr>
    </table>`;
  }

  focus() {
    const s = this.sel; if (!s) return this.frameAll(true);
    let box = new THREE.Box3();
    if (s.kind === 'object') box.copy(this.objBox);
    else if (s.kind === 'copy') box.copy(this.copyBox(this.copies[s.i]));
    else if (s.kind === 'placement') box.setFromCenterAndSize(this.placeObjs[s.i].position, new THREE.Vector3(12, 12, 12));
    else if (s.kind === 'prop') box.copy(this.propLayer.boxOf(s.i)).expandByScalar(6);
    else if (s.kind === 'spawn') { const at = this.spawnLayer.where(this.spawnLayer.spawns[s.i]); if (at) box.setFromCenterAndSize(at, new THREE.Vector3(14, 14, 14)); }
    else if (s.kind === 'trigger') { const b = this.triggers.doc.blocks[s.i]; box.setFromCenterAndSize(this.trigObjs[s.i].position, new THREE.Vector3(iniNum(b, 'BoxSizeX', 5), iniNum(b, 'BoxSizeY', 5), iniNum(b, 'BoxSizeZ', 5)).multiplyScalar(1.5)); }
    else if (s.kind === 'spline') for (const p of this.splines.list[s.i].points) box.expandByPoint(new THREE.Vector3(...p));
    if (box.isEmpty()) return;
    this.vp.root.updateMatrixWorld();
    box.applyMatrix4(this.vp.root.matrixWorld); // every box above is in game (root-local) space
    this.nav.flyToBox(box, 1.6);
  }

  // whole playable area (sky dome excluded); animate unless this is the first view after loading
  frameAll(animate = false) {
    // markers (placements, triggers, splines) show where play happens; geometry fills in when there are none
    const marks = new THREE.Box3();
    if (this.markGroup) {
      this.vp.root.updateMatrixWorld(true);
      this.markGroup.traverse(o => { if ((o.isMesh || o.isPoints) && o.geometry) { o.geometry.computeBoundingBox(); marks.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld)); } });
    }
    const geo = this.playBox?.clone() || new THREE.Box3();
    const box = !marks.isEmpty() ? marks.clone().expandByScalar(20) : geo;
    if (box.isEmpty()) return;
    this.mini.setBounds(geo.isEmpty() ? box : geo.clone().union(box));
    if (!animate) {
      const c = box.getCenter(new THREE.Vector3());
      this.vp.controls.target.copy(c);
      this.vp.camera.position.copy(c).add(new THREE.Vector3(0.45, 0.6, 0.65).normalize().multiplyScalar(box.getSize(new THREE.Vector3()).length() * 0.6));
      this.nav.anim = null; this.nav.autoSpeed();
    } else this.nav.flyToBox(box, 0.75);
  }

  // ------------------------------------------------------------ saving
  markDirty(what) {
    if (what === 'gsc' && this.gsc?.readOnly) { status('PS3 scenes are view-only: this change is only on screen and will not be saved.', true); return; }
    this.dirty.add(what); this.renderDirty();
  }
  renderDirty() {
    const names = { gsc: this.gscPath, placements: this.placements?.path, triggers: this.triggers?.path, splines: this.splines?.path, props: this.propLayer.path, spawns: 'AI scripts' };
    $('l-dirty').innerHTML = this.dirty.size ? [...this.dirty].map(k => `<span class="tag anim mono">${esc((names[k] || k).split('/').pop())}</span>`).join(' ')
      + (this.copies.length ? ` <span class="tag anim">${this.copies.length} new object${this.copies.length === 1 ? '' : 's'}</span>` : '') : '<span class="hint">No unsaved changes.</span>';
    $('l-save').disabled = !this.dirty.size;
    $('l-revert').disabled = !this.gscPath && !this.placements && !this.triggers && !this.splines;
  }

  // Before writing the .GSC: instance matrices and world collision follow the edited objects.
  // Returns { buf, note, reload }. New objects change object and draw numbering, so the level reloads after saving.
  prepareScene() {
    const follow = !!this.coll.D0 && $('l-collfollow').checked;
    const bad = this.copies.map(c => this.nameProblem(c)).find(Boolean);
    if (bad) throw new Error(`a new object's name: ${bad}`);
    const copies = this.copies.map(c => ({ src: c.src, T: c.T, baseMats: this.origMats, name: c.name || null }));
    let note = '';
    const edited = follow ? this.coll.applyInstanceMatrices(this.gsc) : [];
    const F = GSCFile.fromBuffer(this.gsc.buf);
    let changed = false;
    if (follow) {
      try {
        const rep = this.coll.rebuildWorld(F, readDNO2(this.gsc), edited, copies);
        if (rep) {
          changed = true;
          note += ` Collision rebuilt: ${rep.moved.toLocaleString()} polygons moved, ${rep.removed.toLocaleString()} removed${rep.added ? `, ${rep.added.toLocaleString()} added for new objects` : ''}.`;
        }
      } catch (e) { console.warn(e); note += ` Collision was not changed: ${e.message}.`; }
    }
    if (copies.length) {
      const r = addObjectCopies(F, this.gsc, copies); // throws: nothing is saved
      changed = true;
      note += ` Added ${r.objects.length} object${r.objects.length === 1 ? '' : 's'} (#${r.objects.join(', #')})${r.instances.length ? `, ${r.instances.length} named` : ''}${r.bodies ? `, ${r.bodies} physics bod${r.bodies === 1 ? 'y' : 'ies'}` : ''}.`;
    }
    if (!changed) return { buf: this.gsc.buf, note, reload: false };
    const buf = F.build().buffer;
    if (copies.length) return { buf, note, reload: true };
    this.adoptBuffer(buf);
    this.coll.dispose(); if ($('l-coll').checked) this.coll.setVisible(true);
    return { buf, note, reload: false };
  }

  async save() {
    const jobs = [];
    let note = '', reload = false;
    if (this.dirty.has('gsc')) {
      let r;
      try { r = this.prepareScene(); } catch (e) { console.error(e); status(`Save failed: ${e.message}`, true); return; }
      note = r.note; reload = r.reload;
      jobs.push(['gsc', this.gscPath, () => r.buf]);
    }
    if (this.dirty.has('placements')) jobs.push(['placements', this.placements.path, () => writeBlockIni(this.placements.doc)]);
    if (this.dirty.has('triggers')) jobs.push(['triggers', this.triggers.path, () => writeBlockIni(this.triggers.doc)]);
    if (this.dirty.has('splines')) jobs.push(['splines', this.splines.path, () => writeSplineDat(this.splines.list)]);
    if (this.dirty.has('spawns')) for (const path of this.spawnLayer.dirtyFiles()) jobs.push(['spawns', path, () => { const t = this.spawnLayer.text(path); this.spawnLayer.saved(path); return t; }]);
    if (this.dirty.has('props')) { if (this.sel?.kind === 'prop') this.select(null); jobs.push(['props', this.propLayer.path, () => this.propLayer.write()]); }
    const done = [];
    try {
      for (const [k, path, data] of jobs) {
        status(`Saving ${path}…`);
        const r = await api.save(path, data());
        this.dirty.delete(k);
        done.push(path.split('/').pop() + (r.backup ? ' (original kept as .studio.bak)' : ''));
      }
      status(`Saved ${done.join(', ')}.${note}`);
      if (reload && !this.dirty.size) {
        // numbering changed: read the saved level back, keeping the camera where it was
        const cam = this.vp.camera.position.clone(), tgt = this.nav.target.clone(), msg = $('status').textContent;
        await this.load();
        this.nav.anim = null; this.vp.camera.position.copy(cam); this.nav.target.copy(tgt); this.vp.controls.target.copy(tgt); this.vp.camera.lookAt(tgt);
        status(msg + ' Level reloaded.');
      }
    } catch (e) { status(`Save failed: ${e.message}`, true); }
    this.renderDirty();
  }
}

function sameArr(a, b) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }
