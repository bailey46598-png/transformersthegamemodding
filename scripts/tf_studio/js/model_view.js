// Model & animation viewer: .GHG models, posed by .AN3 clips, labelled from the creature configs.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { AN3 } from './an3.js';
import { api, $, status, esc, fmt, joinPath, dirOf, Viewport, download } from './common.js';
import { loadCharacter, loadModel, textureFor, buildMeshes, poseBones, skinMeshes } from './rig.js';

const CH = ['tx', 'ty', 'tz', 'rx', 'ry', 'rz', 'sx', 'sy', 'sz'];
// RATE 0.000001 in the configs means "hold this pose" (e.g. strafe_idle). Preview those at 30 fps.
const isHeld = a => Math.abs(a.rate) < 0.5;
const playRate = a => (isHeld(a) ? 30 : a.rate) || 30;

export class ModelView {
  constructor() {
    this.vp = new Viewport($('m-canvas'));
    this.grid = new THREE.GridHelper(20, 20, 0x555b66, 0x30343d);
    this.vp.scene.add(this.grid);
    this.vp.onFrame.push(dt => this.tick(dt));
    this.characters = null; this.files = null;
    this.model = null; this.clip = null; this.entry = null;
    this.time = 0; this.playing = false; this.selBone = -1;
    this.layerOn = [];
    this.bindUI();
  }

  // ------------------------------------------------------------ browser
  async init() {
    status('Indexing character configs…');
    const all = await api.find('.cfg');
    const cfgs = all.filter(p => /^CHARS\/[^/]+\.CFG$/i.test(p));
    const chars = [];
    await Promise.all(cfgs.map(async p => {
      try {
        const text = await api.text(p);
        // Light scan here (no INCLUDEs); the full parse happens when a character is opened.
        let cur = null;
        for (const raw of text.split(/\r?\n/)) {
          const l = raw.split(';')[0].trim(), t = l.split(/\s+/);
          const kw = (t[0] || '').toUpperCase();
          if (kw === 'CHARACTER') { cur = { name: t[1], cfg: p, path: '', object: null }; chars.push(cur); }
          else if (cur && kw === 'PATH') cur.path = t.slice(1).join(' ');
          else if (cur && kw === 'OBJECT') cur.object = t[1];
        }
      } catch (e) { console.warn(p, e); }
    }));
    this.characters = chars.filter(c => c.object).sort((a, b) => a.name.localeCompare(b.name));
    // DEPENDS lookups by name: prefer the config named after the character (BUMBLEBEE.CFG over ORIGBUMBLEBEE.CFG)
    this.charByName = new Map();
    for (const c of this.characters) {
      const k = c.name.toLowerCase(), own = c.cfg.split('/').pop().toLowerCase().replace(/\.cfg$/, '') === k;
      if (!this.charByName.has(k) || own) this.charByName.set(k, c);
    }
    this.renderList();
    status(`${this.characters.length} characters found.`);
  }

  async renderList() {
    const src = $('m-source').value, q = $('m-filter').value.toLowerCase(), L = $('m-list');
    if (src === 'files' && !this.files) {
      L.innerHTML = '<div class="hint" style="padding:10px">Scanning for models…</div>';
      this.files = (await api.find('.ghg')).sort();
    }
    let html = '';
    if (src === 'chars') {
      let lastGroup = null;
      (this.characters || []).forEach((c, ci) => {
        const label = `${c.name} ${c.object} ${c.path} ${c.cfg}`.toLowerCase();
        if (q && !label.includes(q)) return;
        const grp = c.path.split(/[\\/]/).pop() || 'CHARS';
        if (grp !== lastGroup) { html += `<div class="grp">${esc(grp)}</div>`; lastGroup = grp; }
        const dup = this.characters.filter(x => x.name.toLowerCase() === c.name.toLowerCase()).length > 1;
        html += `<div class="item" data-ci="${ci}" title="${esc(c.cfg)}">${esc(c.name)}<span class="sub">${esc(c.object)}${dup ? ' · ' + esc(c.cfg.split('/').pop()) : ''}</span></div>`;
      });
    } else {
      let lastDir = null;
      for (const f of this.files || []) {
        if (q && !f.toLowerCase().includes(q)) continue;
        const d = dirOf(f);
        if (d !== lastDir) { html += `<div class="grp">${esc(d)}</div>`; lastDir = d; }
        html += `<div class="item" data-file="${esc(f)}">${esc(f.split('/').pop())}</div>`;
      }
    }
    L.innerHTML = html || '<div class="hint" style="padding:10px">No matches.</div>';
  }

  bindUI() {
    $('m-source').onchange = () => this.renderList();
    $('m-filter').oninput = () => this.renderList();
    $('m-list').onclick = e => {
      const it = e.target.closest('.item'); if (!it) return;
      for (const x of $('m-list').querySelectorAll('.item.on')) x.classList.remove('on');
      it.classList.add('on');
      if (it.dataset.ci != null) this.openCharacter(this.characters[+it.dataset.ci]);
      else this.openFile(it.dataset.file);
    };
    $('m-anims').onclick = e => { const it = e.target.closest('.item'); if (it) this.selectClip(+it.dataset.i); };
    $('m-afilter').oninput = () => this.renderAnims();
    $('m-play').onclick = () => this.setPlaying(!this.playing);
    $('m-scrub').oninput = e => { this.time = +e.target.value; this.setPlaying(false); this.applyPose(); };
    for (const id of ['m-skel', 'm-labels', 'm-mesh', 'm-wire', 'm-tex']) $(id).onchange = () => this.applyToggles();
    $('m-gamelayers').onchange = () => this.applyLayers();
    $('m-inplace').onchange = () => this.applyPose();
    $('m-frame').onclick = () => this.frame();
    $('m-shot').onclick = () => this.vp.screenshot(`${this.model?.title || 'model'}${this.entry ? '_' + this.entry.name : ''}.png`);
    $('m-bonesel').onchange = e => this.selectBone(+e.target.value);
    $('m-glb').onclick = () => this.exportGLB().catch(e => { console.error(e); status(`Export failed: ${e.message}`, true); });
    $('m-layers').onchange = e => {
      if (e.target.dataset.layer == null) return;
      this.layerOn[+e.target.dataset.layer] = e.target.checked; this.applyLayers();
    };
    window.addEventListener('keydown', e => {
      if ($('tab-model').classList.contains('hidden') || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.code === 'Space') { e.preventDefault(); this.setPlaying(!this.playing); }
      if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') { this.step(e.code === 'ArrowRight' ? 1 : -1); }
    });
  }

  // ------------------------------------------------------------ loading
  async openCharacter(c) {
    try {
      status(`Loading ${c.name}…`);
      const { ch, modelPath, parents, anims } = await loadCharacter(c, this.charByName);
      await this.load(modelPath, { title: ch.name, anims, parents, cfg: c.cfg });
    } catch (e) { console.error(e); status(`${c.name}: ${e.message}`, true); }
  }

  async openFile(path) {
    try {
      status(`Loading ${path}…`);
      const dir = dirOf(path);
      const listing = await api.list(dir);
      const anims = listing.files.filter(f => /\.an3$/i.test(f.name))
        .map(f => ({ name: f.name.replace(/\.an3$/i, '').toLowerCase(), file: f.name, path: joinPath(dir, f.name), rate: 30, layers: null, flags: [] }));
      await this.load(path, { title: path.split('/').pop(), anims, parents: [], cfg: null });
    } catch (e) { console.error(e); status(`${path}: ${e.message}`, true); }
  }

  async load(path, meta) {
    // parent models supply textures for slots flagged 0x4000 (transform-sequence models)
    const model = await loadModel(path, meta.parents);
    Object.assign(model, meta);
    this.clear();
    this.model = model;
    this.layerOn = model.layers.map(() => true);
    this.buildMesh();
    this.buildSkeleton();
    $('m-empty').classList.add('hidden');
    this.entry = null; this.clip = null; this.time = 0;
    this.renderInfo();
    this.renderLayers();
    $('m-bonesel').innerHTML = '<option value="-1">(none)</option>' + model.bones.map(b => `<option value="${b.index}">${b.index}: ${esc(b.name)}</option>`).join('');
    this.selectBone(-1);
    this.applyPose();
    this.applyToggles();
    this.frame();
    status(`${meta.title}: ${model.bones.length} bones, ${model.parts.length} parts. Reading ${meta.anims.length} clips…`);
    // read every clip's header so the list can show bone-count mismatches and lengths
    const anims = meta.anims;
    await Promise.all(anims.map(async a => {
      try { a.clip = new AN3(await api.bytes(a.path), a.file); }
      catch (e) { a.error = e.message; }
    }));
    if (this.model !== model) return;
    this.anims = anims;
    this.renderAnims();
    const ok = anims.filter(a => a.clip && a.clip.bones === model.bones.length).length;
    status(`${meta.title}: ${model.bones.length} bones · ${anims.length} clips (${ok} match the skeleton).`);
    const idle = anims.findIndex(a => a.clip && a.clip.bones === model.bones.length && /^idle$/i.test(a.name));
    if (idle >= 0) this.selectClip(idle);
  }

  clear() {
    for (const o of [this.meshGroup, this.skelGroup]) if (o) { this.vp.root.remove(o); o.traverse(x => { x.geometry?.dispose(); if (x.isCSS2DObject) x.element.remove(); }); }
    this.meshes = []; this.anims = [];
  }

  textureFor(model, m) { return textureFor(model, m); }

  buildMesh() {
    const { group, meshes } = buildMeshes(this.model);
    this.meshGroup = group; this.meshes = meshes;
    this.vp.root.add(this.meshGroup);
  }

  buildSkeleton() {
    const model = this.model, nb = model.bones.length;
    this.skelGroup = new THREE.Group();
    const pairs = model.bones.filter(b => b.parent >= 0).length;
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pairs * 6), 3));
    this.skelLines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0xe8a33d, depthTest: false, transparent: true }));
    this.skelLines.renderOrder = 10;
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nb * 3), 3));
    pg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(nb * 3).fill(1), 3));
    this.skelPoints = new THREE.Points(pg, new THREE.PointsMaterial({ size: 6, sizeAttenuation: false, vertexColors: true, depthTest: false, transparent: true }));
    this.skelPoints.renderOrder = 11;
    this.skelGroup.add(this.skelLines, this.skelPoints);
    this.boneLabels = model.bones.map(b => {
      const el = document.createElement('div');
      el.className = 'label bone'; el.textContent = b.name;
      el.onclick = () => this.selectBone(b.index);
      const o = new CSS2DObject(el);
      this.skelGroup.add(o);
      return o;
    });
    this.vp.root.add(this.skelGroup);
  }

  // ------------------------------------------------------------ animation
  renderAnims() {
    const q = $('m-afilter').value.toLowerCase(), nb = this.model?.bones.length;
    let html = '', lastGroup = null;
    (this.anims || []).forEach((a, i) => {
      if (q && !`${a.name} ${a.file} ${a.group || ''}`.toLowerCase().includes(q)) return;
      if (a.group && a.group !== lastGroup && a.group !== a.name) { html += `<div class="grp">${esc(a.group)}</div>`; }
      lastGroup = a.group;
      let sub, cls = '';
      if (a.error) { sub = `<span class="warn">${esc(a.error)}</span>`; }
      else if (!a.clip) sub = '…';
      else {
        const secs = a.clip.sourceFrames / Math.abs(playRate(a));
        sub = isHeld(a) ? 'held pose' : `${secs.toFixed(2)}s`;
        if (a.clip.bones !== nb) { sub += ` <span class="warn">${a.clip.bones} bones</span>`; cls = 'style="opacity:.55"'; }
        if (a.rate < 0) sub += ' reversed';
      }
      html += `<div class="item ${this.entry === a ? 'on' : ''}" data-i="${i}" ${cls} title="${esc(a.path)}">${esc(a.name)}<span class="sub">${sub}</span></div>`;
    });
    $('m-anims').innerHTML = html || '<div class="hint">No clips.</div>';
  }

  selectClip(i) {
    const a = this.anims[i];
    if (!a?.clip) { status(a?.error || 'Clip not loaded', true); return; }
    this.entry = a; this.clip = a.clip;
    this.time = a.rate < 0 ? a.clip.sourceFrames - 1 : 0;
    $('m-scrub').max = Math.max(a.clip.sourceFrames - 1, 0.01);
    this.renderAnims();
    this.renderClip();
    this.applyLayers();
    this.applyPose();
    this.setPlaying(true);
  }

  setPlaying(p) { this.playing = p && !!this.clip; $('m-play').textContent = this.playing ? '❚❚' : '▶'; }
  step(d) { if (!this.clip) return; this.setPlaying(false); this.time = Math.max(0, Math.min(this.clip.sourceFrames - 1, Math.round(this.time) + d)); this.applyPose(); }

  tick(dt) {
    if (!this.playing || !this.clip) return;
    const len = Math.max(this.clip.sourceFrames - 1, 1);
    this.time += dt * playRate(this.entry) * +$('m-speed').value;
    if (this.time > len || this.time < 0) {
      if ($('m-loop').checked) this.time = ((this.time % len) + len) % len;
      else { this.time = Math.max(0, Math.min(len, this.time)); this.setPlaying(false); }
    }
    this.applyPose();
  }

  // posed world matrices (row form) for every bone
  computePose() {
    const clip = this.clip;
    const vals = this.poseVals = clip ? clip.pose(this.time) : null;
    return poseBones(this.model, vals, clip?.channels, clip?.bones, { pin: $('m-inplace').checked });
  }

  applyPose() {
    if (!this.model) return;
    const model = this.model, nb = model.bones.length;
    const world = this.world = this.computePose();
    skinMeshes(model, this.meshes, world);
    // skeleton
    const LP = this.skelLines.geometry.attributes.position.array, PP = this.skelPoints.geometry.attributes.position.array;
    let k = 0;
    for (let b = 0; b < nb; b++) {
      const w = world[b];
      PP[b * 3] = w[12]; PP[b * 3 + 1] = w[13]; PP[b * 3 + 2] = w[14];
      this.boneLabels[b].position.set(w[12], w[13], w[14]);
      const p = model.bones[b].parent;
      if (p >= 0) { const q = world[p]; LP.set([q[12], q[13], q[14], w[12], w[13], w[14]], k); k += 6; }
    }
    this.skelLines.geometry.attributes.position.needsUpdate = true;
    this.skelPoints.geometry.attributes.position.needsUpdate = true;
    // timeline
    if (this.clip) {
      $('m-scrub').value = this.time;
      const r = Math.abs(playRate(this.entry));
      $('m-time').textContent = `frame ${this.time.toFixed(1).padStart(5)} / ${this.clip.sourceFrames - 1}  ·  ${(this.time / r).toFixed(2)}s`;
    } else $('m-time').textContent = 'bind pose';
    if (this.selBone >= 0) this.renderBone();
  }

  // ------------------------------------------------------------ display toggles / layers
  applyToggles() {
    if (!this.model) return;
    this.skelGroup.visible = $('m-skel').checked || $('m-labels').checked;
    this.skelLines.visible = this.skelPoints.visible = $('m-skel').checked;
    this.boneLabels.forEach((l, b) => { l.visible = $('m-labels').checked || b === this.selBone; });
    this.meshGroup.visible = $('m-mesh').checked;
    for (const m of this.meshes) {
      m.material.wireframe = $('m-wire').checked;
      const t = $('m-tex').checked ? m.material.userData.tex : null;
      if (m.material.map !== t) { m.material.map = t; m.material.color.set(t ? 0xffffff : 0x9aa3b5); m.material.needsUpdate = true; }
    }
  }

  applyLayers() {
    if (!this.model) return;
    const mask = $('m-gamelayers').checked && this.entry?.layers?.length ? new Set(this.entry.layers) : null;
    for (const m of this.meshes) m.visible = this.layerOn[m.userData.layer] && (!mask || mask.has(m.userData.layer));
    this.renderLayers(mask);
  }

  renderLayers(mask = null) {
    const model = this.model;
    const counts = model.layers.map((_, i) => model.parts.filter(p => p.layer === i).length);
    $('m-layers').innerHTML = model.layers.map((n, i) => {
      const masked = mask && !mask.has(i);
      return `<label class="row" style="${masked ? 'opacity:.5' : ''}"><input type="checkbox" data-layer="${i}" ${this.layerOn[i] ? 'checked' : ''}> ${i}: ${esc(n)} <span class="tag">${counts[i]} parts</span>${masked ? ' <span class="tag">off in this clip</span>' : ''}</label>`;
    }).join('') || '–';
  }

  // ------------------------------------------------------------ inspectors
  renderInfo() {
    const m = this.model;
    const tris = this.meshes.reduce((s, x) => s + x.geometry.index.count / 3, 0);
    const skinned = m.parts.filter(p => p.palette.length && p.stride >= 36).length;
    const tex = m.textures.filter(t => t.size).length;
    const missingTex = m.materials.filter((_, i) => this.textureFor(m, i) == null && m.materials[i]).length;
    $('m-info').innerHTML = `<table class="kv">
      <tr><td>Name</td><td>${esc(m.title)}</td></tr>
      <tr><td>File</td><td class="mono">${esc(m.path)}</td></tr>
      ${m.cfg ? `<tr><td>Config</td><td class="mono">${esc(m.cfg)}</td></tr>` : ''}
      <tr><td>Bones</td><td>${m.bones.length}</td></tr>
      <tr><td>Parts</td><td>${m.parts.length} (${skinned} skinned)</td></tr>
      <tr><td>Triangles</td><td>${tris.toLocaleString()}</td></tr>
      <tr><td>Materials</td><td>${m.materials.length}${missingTex ? ` <span class="hint">(${missingTex} untextured)</span>` : ''}</td></tr>
      <tr><td>Textures</td><td>${tex} in file${m.parentModels.length ? `, + ${m.parentModels.length} parent model(s)` : ''}</td></tr>
    </table>`;
  }

  renderClip() {
    const a = this.entry, c = this.clip;
    const nb = this.model.bones.length;
    const mismatch = c.bones !== nb;
    $('m-clip').innerHTML = `<table class="kv">
      <tr><td>Name</td><td>${esc(a.name)}${a.group && a.group !== a.name ? ` <span class="tag">${esc(a.group)}</span>` : ''}</td></tr>
      <tr><td>File</td><td class="mono">${esc(a.path)}</td></tr>
      <tr><td>Bones</td><td class="${mismatch ? 'warn' : 'ok'}">${c.bones}${mismatch ? ` (model has ${nb}: extra bones are ignored, missing ones stay in bind pose)` : ' ✓'}</td></tr>
      <tr><td>Length</td><td>${isHeld(a)
        ? `${c.sourceFrames} frames. RATE ${a.rate}: the game holds this as a still pose (previewed here at 30 fps)`
        : `${c.sourceFrames} frames @ ${a.rate} fps = ${(c.sourceFrames / Math.abs(playRate(a))).toFixed(2)} s`}</td></tr>
      <tr><td>Stored samples</td><td>${c.samples} (${c.animatedChannels} animated channels)</td></tr>
      ${a.layers ? `<tr><td>Layer mask</td><td>${a.layers.join(', ')}</td></tr>` : ''}
      ${a.flags.length ? `<tr><td>Flags</td><td>${a.flags.join(', ')}</td></tr>` : ''}
      ${c.warnings.length ? `<tr><td>Warnings</td><td class="warn">${c.warnings.map(esc).join('<br>')}</td></tr>` : ''}
    </table>`;
  }

  selectBone(b) {
    this.selBone = b;
    $('m-bonesel').value = b;
    if (this.boneLabels) this.boneLabels.forEach((l, i) => l.element.classList.toggle('sel', i === b));
    if (this.skelPoints) {
      const C = this.skelPoints.geometry.attributes.color.array;
      for (let i = 0; i < C.length / 3; i++) C.set(i === b ? [0.35, 0.66, 0.9] : [1, 1, 1], i * 3);
      this.skelPoints.geometry.attributes.color.needsUpdate = true;
    }
    this.applyToggles();
    this.renderBone();
  }

  renderBone() {
    const b = this.selBone, m = this.model;
    if (!m || b < 0) { $('m-bone').innerHTML = 'Click a bone name (turn on "Bone names") or pick one here.'; return; }
    const bone = m.bones[b], w = this.world?.[b] || m.world[b];
    const kids = m.bones.filter(x => x.parent === b).map(x => esc(x.name));
    const parts = m.parts.filter(p => p.bone === b).length;
    let chans = '';
    if (this.clip && this.poseVals && b < this.clip.bones) {
      const o = b * this.clip.channels;
      chans = '<table class="kv mono">' + [0, 3, 6].map(g => `<tr><td>${['translate', 'rotate°', 'scale'][g / 3]}</td><td>${[0, 1, 2].map(k => {
        const v = this.poseVals[o + g + k] * ([2, 3, 4].includes(g + k) ? -1 : 1); // in model space (see computePose)
        const shown = g === 3 ? fmt(v * 180 / Math.PI, 1) : fmt(v);
        return this.clip.isAnimated(b, g + k) ? `<span class="tag anim" title="${CH[g + k]} animated">${shown}</span>` : `<span title="${CH[g + k]} constant">${shown}</span>`;
      }).join(' ')}</td></tr>`).join('') + '</table><p class="hint">Highlighted values are keyframed; the rest are constant for this clip.</p>';
    }
    $('m-bone').innerHTML = `<table class="kv">
      <tr><td>Bone</td><td>${b}: <b>${esc(bone.name)}</b></td></tr>
      <tr><td>Parent</td><td>${bone.parent >= 0 ? `${bone.parent}: ${esc(m.bones[bone.parent].name)}` : '(root)'}</td></tr>
      <tr><td>Children</td><td>${kids.join(', ') || '–'}</td></tr>
      <tr><td>Rigid parts</td><td>${parts}</td></tr>
      <tr><td>World pos</td><td class="mono">${fmt(w[12])}, ${fmt(w[13])}, ${fmt(w[14])}</td></tr>
    </table>${chans}`;
  }

  // the model, its skeleton and textures, and this clip (or every clip that fits the skeleton) for Blender
  async exportGLB() {
    if (!this.model) { status('Open a model first.', true); return; }
    const nb = this.model.bones.length;
    const all = $('m-glball').checked;
    const clips = (all ? (this.anims || []) : this.entry ? [this.entry] : [])
      .filter(a => a.clip && a.clip.bones <= nb + 8) // clips for a different skeleton would scramble it
      .map(a => ({ name: a.name, clip: a.clip, rate: isHeld(a) ? 30 : a.rate }));
    status(`Exporting ${this.model.title} with ${clips.length} clip${clips.length === 1 ? '' : 's'}…`);
    await new Promise(r => setTimeout(r, 0));
    const { exportCharacterGLB } = await import('./blender_export.js');
    const { glb, clips: n } = await exportCharacterGLB(this.model, this.model.title, clips);
    const name = `${this.model.title}${all ? '_all' : this.entry ? '_' + this.entry.name : ''}.glb`.replace(/[^\w.-]+/g, '_');
    download(new Blob([glb], { type: 'model/gltf-binary' }), name);
    status(`Exported ${name}: ${nb} bones, ${n} animation${n === 1 ? '' : 's'}.`);
  }

  frame() {
    if (!this.model) return;
    const box = new THREE.Box3();
    for (const m of this.meshes) { m.geometry.computeBoundingBox(); box.union(m.geometry.boundingBox); }
    if (box.isEmpty()) for (const w of this.model.world) box.expandByPoint(new THREE.Vector3(w[12], w[13], w[14]));
    this.vp.root.updateMatrixWorld();
    box.applyMatrix4(this.vp.root.matrixWorld);
    this.vp.frameBox(box, 1.1);
    const s = box.getSize(new THREE.Vector3());
    this.grid.scale.setScalar(Math.max(s.x, s.y, s.z) / 10 || 1);
  }
}
