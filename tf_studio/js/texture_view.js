// Texture editor: paint a .GHG model's textures on the 3D model or on the flat texture, then save them back into
// the .GHG (DXT re-encoded block by block; untouched blocks stay byte-identical). Works on the game's models and on
// the hi-res set (HIRES/...).
//
// 3D brush: a stamp is a sphere around the hit point on the model. Every triangle that uses the texture and comes
// within the sphere is rasterised in texture space, and each texel is weighted by how far its point ON THE MODEL is
// from the centre. So a stroke follows the surface across UV seams and never leaks into a neighbouring UV island.
// Within one stroke, colour does not build up: each texel takes the strongest coverage it has seen (like an
// airbrush with "build-up" off), blended over the texture as it was when the stroke started.
import * as THREE from 'three';
import { api, $, status, esc, joinPath, Viewport, download } from './common.js';
import { loadCharacter, loadModel, buildMeshes, restPose, skinMeshes, disposeGroup } from './rig.js';
import { decodeDDS } from './mesh_io.js';
import { encodeLike } from './dxt_encode.js';
import { loadHires, hiresAvailable, forDetail, normalPath, isHires, detailTag } from './hires.js';

const UNDO_LIMIT = 40;
const TOOLS = { brush: 'Brush', recolor: 'Recolour', restore: 'Restore', fill: 'Fill', pick: 'Pick colour' };
const KEYS = { b: 'brush', r: 'recolor', e: 'restore', g: 'fill', i: 'pick' };

// ---------------------------------------------------------------- colour helpers
const hex2rgb = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const rgb2hex = (r, g, b) => '#' + [r, g, b].map(x => Math.round(x).toString(16).padStart(2, '0')).join('');
function rgb2hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-6) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, mx ? d / mx : 0, mx];
}
function hsv2rgb(h, s, v) {
  h = ((h % 360) + 360) % 360 / 60;
  const c = v * s, x = c * (1 - Math.abs(h % 2 - 1)), m = v - c, k = Math.floor(h) % 6;
  const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][k];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}
const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
const smooth = (x, lo, hi) => { const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo))); return t * t * (3 - 2 * t); };

// Paint `to` onto a pixel but keep its light and shade: the target's hue and saturation, and its brightness scaled
// by how bright the pixel is compared to the reference `from` brightness.
function shadeKeep(r, g, b, to, fromV) {
  const [, s, v] = rgb2hsv(r, g, b);
  const [th, ts, tv] = to;
  const k = fromV > 0.02 ? v / fromV : v;
  return hsv2rgb(th, Math.min(1, ts * (0.35 + 0.65 * Math.min(1, s / 0.35))), Math.min(1, tv * k));
}

export class TextureView {
  constructor(modelView) {
    this.mv = modelView;
    this.vp = new Viewport($('t-canvas'));
    this.vp.scene.background = new THREE.Color(0x2a2e37);
    const c = this.vp.controls;
    c.mouseButtons = { LEFT: -1, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    this.grid = new THREE.GridHelper(20, 20, 0x555b66, 0x30343d);
    this.vp.scene.add(this.grid);
    this.cursor = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false, side: THREE.DoubleSide }));
    this.cursor.renderOrder = 20; this.cursor.visible = false;
    this.cursorM = this.cursor.clone(); this.cursorM.material = this.cursor.material.clone(); this.cursorM.material.color.set(0x5aa9e6);
    this.vp.scene.add(this.cursor, this.cursorM);
    this.ray = new THREE.Raycaster();
    this.model = null; this.layers = []; this.layer = null; this.meshes = [];
    this.tool = 'brush'; this.undo = []; this.redo = [];
    this.view2d = { scale: 1, ox: 0, oy: 0 };
    this.bindUI();
  }

  // ------------------------------------------------------------ list
  async init() {
    await this.mv.ready;
    await loadHires();
    if (!hiresAvailable()) { const o = $('t-detail').options[1]; o.disabled = true; o.textContent += ' — not found'; }
    this.files = (await api.find('.ghg', true)).sort((a, b) => isHires(a) - isHires(b) || a.localeCompare(b));
    this.renderList();
    status(hiresAvailable() ? 'Textures: pick a model. The hi-res set is available (High detail).' : 'Textures: pick a model.');
  }

  renderList() {
    const src = $('t-source').value, q = $('t-filter').value.toLowerCase(), high = $('t-detail').value === 'high';
    let html = '';
    if (src === 'chars') {
      let last = null;
      (this.mv.characters || []).forEach((c, ci) => {
        if (q && !`${c.name} ${c.object} ${c.path}`.toLowerCase().includes(q)) return;
        const grp = c.path.split(/[\\/]/).pop() || 'CHARS';
        if (grp !== last) { html += `<div class="grp">${esc(grp)}</div>`; last = grp; }
        html += `<div class="item" data-ci="${ci}" title="${esc(c.cfg)}">${esc(c.name)}<span class="sub">${esc(c.object)}</span></div>`;
      });
    } else {
      let last = null;
      for (const f of this.files || []) {
        if (q && !f.toLowerCase().includes(q)) continue;
        if (isHires(f) && !high) continue;
        const d = f.replace(/\/[^/]*$/, '');
        if (d !== last) { html += `<div class="grp">${esc(d)}</div>`; last = d; }
        html += `<div class="item" data-file="${esc(f)}">${esc(f.split('/').pop())}</div>`;
      }
    }
    $('t-list').innerHTML = html || '<div class="hint" style="padding:10px">No matches.</div>';
  }

  // ------------------------------------------------------------ UI
  bindUI() {
    $('t-source').onchange = () => this.renderList();
    $('t-filter').oninput = () => this.renderList();
    $('t-detail').onchange = () => { this.renderList(); if (this.reopen && this.confirmDiscard()) this.reopen(); };
    $('t-list').onclick = e => {
      const it = e.target.closest('.item'); if (!it || !this.confirmDiscard()) return;
      for (const x of $('t-list').querySelectorAll('.item.on')) x.classList.remove('on');
      it.classList.add('on');
      if (it.dataset.ci != null) {
        const c = this.mv.characters[+it.dataset.ci];
        this.reopen = () => this.openCharacter(c);
      } else {
        const f = it.dataset.file;
        this.reopen = () => this.open($('t-detail').value === 'high' ? forDetail(f, 'high') : f, [], f.split('/').pop());
      }
      this.reopen();
    };
    $('t-tools').onclick = e => { const b = e.target.closest('[data-tool]'); if (b) this.setTool(b.dataset.tool); };
    $('t-texlist').onclick = e => { const it = e.target.closest('[data-layer]'); if (it) this.selectLayer(this.layers[+it.dataset.layer]); };
    $('t-undo').onclick = () => this.doUndo();
    $('t-redo').onclick = () => this.doRedo();
    $('t-save').onclick = () => this.save().catch(e => { console.error(e); status(`Save failed: ${e.message}`, true); });
    $('t-dl').onclick = () => this.downloadGHG();
    $('t-exppng').onclick = () => this.layer && this.layer.canvas.toBlob(b => download(b, `${this.fileStem()}_tex${this.layer.texIdx[0]}.png`));
    $('t-imppng').onclick = () => $('t-file').click();
    $('t-file').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) this.importImage(f); };
    $('t-revtex').onclick = () => this.revertLayer();
    $('t-swap').onclick = () => this.colourSwap();
    $('t-adjust').onclick = () => this.adjust();
    $('t-frame').onclick = () => this.frame();
    $('t-shot').onclick = () => this.vp.screenshot(`${this.fileStem()}_textures.png`);
    $('t-uv').onchange = () => this.draw2d();
    for (const id of ['t-size', 't-opacity', 't-hard']) $(id).oninput = () => this.showBrush();
    $('t-colour').oninput = () => this.showBrush();
    for (const sl of document.querySelectorAll('#tab-tex .slider')) {
      const inp = sl.querySelector('input'), out = sl.querySelector('span:last-child');
      if (out.id) continue;
      const show = () => { out.textContent = inp.value; };
      inp.addEventListener('input', show); show();
    }
    for (const b of document.querySelectorAll('[data-pickinto]')) b.onclick = () => { this.pickInto = b.dataset.pickinto; this.prevTool = this.tool; this.setTool('pick'); status('Click the model or the texture to pick the colour.'); };
    this.showBrush();

    // 3D: left paints, right orbits, middle pans; Alt+left orbits too
    const el = this.vp.renderer.domElement;
    el.addEventListener('pointerdown', e => {
      this.vp.controls.mouseButtons.LEFT = e.altKey || !this.model ? THREE.MOUSE.ROTATE : -1;
      if (e.button === 0 && !e.altKey && this.model) this.down3d(e);
    }, true);
    el.addEventListener('pointermove', e => this.move3d(e));
    el.addEventListener('pointerleave', () => { this.cursor.visible = this.cursorM.visible = false; });
    window.addEventListener('pointerup', () => this.endStroke());
    el.addEventListener('contextmenu', e => e.preventDefault());

    // 2D: left = tool, middle/right drag = pan, wheel = zoom
    const c2 = $('t-paper');
    c2.addEventListener('contextmenu', e => e.preventDefault());
    c2.addEventListener('wheel', e => {
      e.preventDefault();
      const r = c2.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top, v = this.view2d;
      const k = Math.exp(-e.deltaY * 0.0015), s = Math.min(64, Math.max(0.05, v.scale * k));
      v.ox = mx - (mx - v.ox) * s / v.scale; v.oy = my - (my - v.oy) * s / v.scale; v.scale = s;
      this.draw2d();
    }, { passive: false });
    c2.addEventListener('pointerdown', e => {
      c2.setPointerCapture(e.pointerId);
      if (e.button === 1 || e.button === 2) { this.pan = { x: e.clientX, y: e.clientY, ox: this.view2d.ox, oy: this.view2d.oy }; return; }
      if (e.button === 0) this.down2d(e);
    });
    c2.addEventListener('pointermove', e => {
      if (this.pan) { this.view2d.ox = this.pan.ox + e.clientX - this.pan.x; this.view2d.oy = this.pan.oy + e.clientY - this.pan.y; this.draw2d(); return; }
      this.move2d(e);
    });
    c2.addEventListener('pointerup', () => { this.pan = null; this.endStroke(); });
    c2.addEventListener('pointerleave', () => { this.hover2d = null; this.draw2d(); });
    new ResizeObserver(() => this.fit2d(false)).observe($('t-2d'));

    window.addEventListener('keydown', e => {
      if ($('tab-tex').classList.contains('hidden') || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? this.doRedo() : this.doUndo(); return; }
      if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); this.doRedo(); return; }
      if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); this.save().catch(err => status(`Save failed: ${err.message}`, true)); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (KEYS[k]) this.setTool(KEYS[k]);
      else if (k === '[' || k === ']') { const s = $('t-size'); s.value = Math.max(1, Math.min(256, Math.round(+s.value * (k === ']' ? 1.25 : 0.8)))); this.showBrush(); }
      else if (k === 'm') { $('t-mirror').checked = !$('t-mirror').checked; }
      else if (k === 'f') this.frame();
    });
    window.addEventListener('beforeunload', e => { if (this.layers.some(l => l.dirty)) { e.preventDefault(); e.returnValue = ''; } });
  }

  setTool(t) {
    this.tool = t;
    for (const b of $('t-tools').querySelectorAll('[data-tool]')) b.classList.toggle('primary', b.dataset.tool === t);
    $('t-brushopts').classList.toggle('hidden', t === 'fill' || t === 'pick');
    $('t-fillopts').classList.toggle('hidden', t !== 'fill');
  }

  showBrush() {
    $('t-sizev').textContent = `${$('t-size').value} px`;
    $('t-opv').textContent = `${$('t-opacity').value}%`;
    $('t-hardv').textContent = `${$('t-hard').value}%`;
    $('t-swatch').style.background = $('t-colour').value;
  }

  confirmDiscard() {
    return !this.layers.some(l => l.dirty) || confirm('Discard unsaved texture changes?');
  }

  // ------------------------------------------------------------ loading
  async openCharacter(c) {
    try {
      status(`Loading ${c.name}…`);
      const { ch, modelPath, parents } = await loadCharacter(c, this.mv.charByName);
      const d = $('t-detail').value;
      await this.open(forDetail(modelPath, d), parents.map(p => forDetail(p, d)), ch.name);
    } catch (e) { console.error(e); status(`${c.name}: ${e.message}`, true); }
  }

  async open(path, parents, title) {
    status(`Loading ${path}…`);
    const model = await loadModel(path, parents);
    model.title = title;
    this.clear();
    this.model = model;
    // one layer per distinct texture; identical copies (the hi-res set stores some twice) are linked
    const byBytes = new Map();
    model.textures.forEach((t, i) => {
      if (!t.size || t.cube) return;
      const dds = new Uint8Array(model.dds(t));
      const cc = String.fromCharCode(dds[84], dds[85], dds[86], dds[87]);
      if (cc !== 'DXT1' && cc !== 'DXT5') return;
      let key = '';
      for (let k = 128; k < dds.length; k += Math.max(1, dds.length >> 7)) key += dds[k].toString(36);
      key = `${dds.length}:${key}`;
      const same = byBytes.get(key);
      if (same && dds.every((x, k) => x === same.dds[k])) { same.texIdx.push(i); return; }
      const img = decodeDDS(dds);
      if (!img) return;
      const L = this.makeLayer(i, dds, cc, img);
      byBytes.set(key, L);
      this.layers.push(L);
    });
    // meshes in the rest pose, with each own texture swapped for its live canvas
    const { group, meshes } = buildMeshes(model);
    this.group = group; this.meshes = meshes;
    this.vp.root.add(group);
    const world = await restPose(model);
    if (world) skinMeshes(model, meshes, world);
    for (const mesh of meshes) {
      mesh.geometry.computeBoundingSphere(); mesh.geometry.computeBoundingBox();
      const t = model.textureForMaterial(mesh.userData.material ?? -1);
      mesh.userData.paint = null;
      if (t.kind === 'own') {
        const L = this.layers.find(l => l.texIdx.includes(t.tex));
        if (L) { mesh.userData.paint = L; L.meshes.push(mesh); mesh.material.map = L.tex; mesh.material.needsUpdate = true; }
      } else if (t.kind === 'parent') mesh.userData.borrowed = true;
      this.triInfo(mesh);
    }
    for (const L of this.layers) this.layerTexelDensity(L);
    $('t-empty').classList.add('hidden');
    this.renderTexList();
    this.selectLayer(this.layers.find(l => l.meshes.length) || this.layers[0] || null);
    this.renderInfo();
    this.frame();
    const borrowed = meshes.filter(m => m.userData.borrowed).length;
    status(`${title}: ${this.layers.length} textures${borrowed ? ` · ${borrowed} parts borrow textures from ${model.parentModels.map(p => (p.path || '').split('/').pop()).join(', ') || 'a parent'} (read-only here)` : ''}.`);
  }

  makeLayer(i, dds, cc, img) {
    const { w, h } = img;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const image = new ImageData(new Uint8ClampedArray(img.rgba), w, h);
    ctx.putImageData(image, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.flipY = false; tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    let cut = false;
    for (let k = 3; k < img.rgba.length; k += 4) if (img.rgba[k] < 128) { cut = true; break; }
    return {
      texIdx: [i], dds, cc, w, h, canvas, ctx, image, data: image.data, orig: new Uint8ClampedArray(img.rgba), tex,
      hasCut: cut, meshes: [], dirty: false, density: 0,
    };
  }

  clear() {
    if (this.group) { this.vp.root.remove(this.group); disposeGroup(this.group); }
    for (const L of this.layers) L.tex.dispose();
    this.group = null; this.meshes = []; this.layers = []; this.layer = null; this.undo = []; this.redo = [];
    this.model = null; this.uvPath = null;
    this.updateButtons();
  }

  frame() {
    if (!this.group) return;
    const box = new THREE.Box3().setFromObject(this.group);
    this.vp.frameBox(box, 1.1);
  }

  fileStem() { return (this.model?.path || 'texture').split('/').pop().replace(/\.ghg$/i, '') + (isHires(this.model?.path) ? '_hires' : ''); }

  // per triangle: centroid and bounding radius in model space (for the 3D brush's quick reject)
  triInfo(mesh) {
    const P = mesh.geometry.attributes.position.array, I = mesh.geometry.index.array, n = I.length / 3;
    const C = new Float32Array(n * 4);
    for (let t = 0; t < n; t++) {
      const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
      const cx = (P[a] + P[b] + P[c]) / 3, cy = (P[a + 1] + P[b + 1] + P[c + 1]) / 3, cz = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
      let r = 0;
      for (const v of [a, b, c]) r = Math.max(r, Math.hypot(P[v] - cx, P[v + 1] - cy, P[v + 2] - cz));
      C[t * 4] = cx; C[t * 4 + 1] = cy; C[t * 4 + 2] = cz; C[t * 4 + 3] = r;
    }
    mesh.userData.tri = C;
  }

  // median texels per model unit, so the brush size (in texels) maps to a radius on the model
  layerTexelDensity(L) {
    const ds = [];
    for (const mesh of L.meshes) {
      const P = mesh.geometry.attributes.position.array, U = mesh.geometry.attributes.uv.array, I = mesh.geometry.index.array;
      for (let t = 0; t < I.length / 3; t += Math.max(1, (I.length / 3 / 400) | 0)) {
        const d = this.density(P, U, I, t, L);
        if (d) ds.push(d);
      }
    }
    ds.sort((a, b) => a - b);
    L.density = ds.length ? ds[ds.length >> 1] : 100;
  }

  density(P, U, I, t, L) {
    const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
    const e1 = [P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]];
    const e2 = [P[c * 3] - P[a * 3], P[c * 3 + 1] - P[a * 3 + 1], P[c * 3 + 2] - P[a * 3 + 2]];
    const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const wa = Math.hypot(...cr);
    const ua = Math.abs((U[b * 2] - U[a * 2]) * L.w * (U[c * 2 + 1] - U[a * 2 + 1]) * L.h - (U[c * 2] - U[a * 2]) * L.w * (U[b * 2 + 1] - U[a * 2 + 1]) * L.h);
    return wa > 1e-10 && ua > 1e-6 ? Math.sqrt(ua / wa) : 0;
  }

  // ------------------------------------------------------------ panels
  renderTexList() {
    const html = this.layers.map((L, k) => {
      const used = L.meshes.length ? `${L.meshes.length} part${L.meshes.length > 1 ? 's' : ''}` : 'not on the model (normal/spec map?)';
      return `<div class="texitem ${L === this.layer ? 'on' : ''}" data-layer="${k}">
        <canvas width="48" height="48" data-thumb="${k}"></canvas>
        <div><b>tex ${L.texIdx.join(' = ')}</b>${L.dirty ? ' <span class="warn">●</span>' : ''}<br>
        <span class="hint">${L.w}×${L.h} ${L.cc}${L.hasCut ? ' · cut-outs' : ''}<br>${used}</span></div></div>`;
    }).join('');
    $('t-texlist').innerHTML = html || '<div class="hint">No editable textures (this model borrows all of them).</div>';
    this.layers.forEach((L, k) => this.drawThumb(L, k));
  }

  drawThumb(L, k = this.layers.indexOf(L)) {
    const c = $('t-texlist').querySelector(`[data-thumb="${k}"]`);
    if (c) { const x = c.getContext('2d'); x.clearRect(0, 0, 48, 48); x.drawImage(L.canvas, 0, 0, 48, 48); }
  }

  renderInfo() {
    const m = this.model;
    $('t-info').innerHTML = m ? `<table class="kv">
      <tr><td>Model</td><td>${esc(m.title)}</td></tr>
      <tr><td>File</td><td class="mono">${esc(m.path)} ${detailTag(m.path)}</td></tr>
      ${m.parentModels.length ? `<tr><td>Borrows from</td><td class="mono">${m.parentModels.map(p => esc((p.path || '?').split('/').pop())).join('<br>')}</td></tr>` : ''}
      <tr><td>Textures</td><td>${this.layers.length} editable${this.layers.some(l => l.texIdx.length > 1) ? ' (linked copies are saved together)' : ''}</td></tr></table>` : 'Nothing loaded.';
  }

  selectLayer(L) {
    this.layer = L;
    for (const el of $('t-texlist').querySelectorAll('.texitem')) el.classList.toggle('on', +el.dataset.layer === this.layers.indexOf(L));
    this.uvPath = null;
    if (L) {
      const p = new Path2D();
      for (const mesh of L.meshes) {
        const U = mesh.geometry.attributes.uv.array, I = mesh.geometry.index.array;
        for (let t = 0; t < I.length; t += 3) {
          const a = I[t] * 2, b = I[t + 1] * 2, c = I[t + 2] * 2;
          // UVs may lie outside 0..1 (the hi-res set's V runs -1..0) and wrap: move each triangle into the tile
          const su = Math.floor((U[a] + U[b] + U[c]) / 3), sv = Math.floor((U[a + 1] + U[b + 1] + U[c + 1]) / 3);
          p.moveTo((U[a] - su) * L.w, (U[a + 1] - sv) * L.h); p.lineTo((U[b] - su) * L.w, (U[b + 1] - sv) * L.h);
          p.lineTo((U[c] - su) * L.w, (U[c + 1] - sv) * L.h); p.closePath();
        }
      }
      this.uvPath = p;
    }
    $('t-texname').textContent = L ? `tex ${L.texIdx.join(' = ')} · ${L.w}×${L.h} ${L.cc}` : '–';
    this.fit2d(true);
    this.updateButtons();
  }

  updateButtons() {
    const dirty = this.layers.some(l => l.dirty);
    $('t-save').disabled = !dirty; $('t-dl').disabled = !this.model;
    $('t-undo').disabled = !this.undo.length; $('t-redo').disabled = !this.redo.length;
    for (const id of ['t-exppng', 't-imppng', 't-revtex', 't-swap', 't-adjust']) $(id).disabled = !this.layer;
    $('t-dirty').innerHTML = dirty ? `<span class="warn">Unsaved:</span> ${this.layers.filter(l => l.dirty).map(l => 'tex ' + l.texIdx[0]).join(', ')}` : (this.model ? '<span class="hint">No unsaved changes.</span>' : '');
  }

  // ------------------------------------------------------------ 2D view
  fit2d(force) {
    const host = $('t-2d'), c = $('t-paper');
    const W = host.clientWidth, H = host.clientHeight;
    if (!W || !H) return;
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; force = true; }
    if (force && this.layer) {
      const s = Math.min(W / this.layer.w, H / this.layer.h) * 0.96;
      this.view2d = { scale: s, ox: (W - this.layer.w * s) / 2, oy: (H - this.layer.h * s) / 2 };
    }
    this.draw2d();
  }

  draw2d() {
    const c = $('t-paper'), x = c.getContext('2d'), L = this.layer, v = this.view2d;
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.fillStyle = '#1b1d23'; x.fillRect(0, 0, c.width, c.height);
    if (!L) return;
    // checkerboard under transparent texels
    x.save(); x.beginPath(); x.rect(v.ox, v.oy, L.w * v.scale, L.h * v.scale); x.clip();
    x.fillStyle = '#3a3e48'; x.fillRect(v.ox, v.oy, L.w * v.scale, L.h * v.scale);
    x.fillStyle = '#2c2f37';
    const cs = 8;
    for (let yy = 0; yy < L.h * v.scale; yy += cs) for (let xx = (yy / cs) % 2 ? cs : 0; xx < L.w * v.scale; xx += cs * 2) x.fillRect(v.ox + xx, v.oy + yy, cs, cs);
    x.restore();
    x.imageSmoothingEnabled = v.scale < 1;
    x.drawImage(L.canvas, v.ox, v.oy, L.w * v.scale, L.h * v.scale);
    if ($('t-uv').checked && this.uvPath) {
      x.save(); x.setTransform(v.scale, 0, 0, v.scale, v.ox, v.oy);
      x.lineWidth = 1 / v.scale; x.strokeStyle = 'rgba(90,169,230,.55)'; x.stroke(this.uvPath); x.restore();
    }
    if (this.hover2d && (this.tool !== 'fill' && this.tool !== 'pick')) {
      const r = +$('t-size').value * v.scale;
      x.strokeStyle = '#fff'; x.lineWidth = 1; x.beginPath();
      x.arc(v.ox + this.hover2d[0] * v.scale, v.oy + this.hover2d[1] * v.scale, r, 0, Math.PI * 2); x.stroke();
    }
  }

  texelAt2d(e) {
    const r = $('t-paper').getBoundingClientRect(), v = this.view2d;
    return [(e.clientX - r.left - v.ox) / v.scale, (e.clientY - r.top - v.oy) / v.scale];
  }

  down2d(e) {
    const L = this.layer; if (!L) return;
    const [tx, ty] = this.texelAt2d(e);
    if (this.tool === 'pick') return this.pickColour(L, tx, ty);
    if (this.tool === 'fill') return this.fill(L, Math.floor(tx), Math.floor(ty));
    this.beginStroke(L);
    this.stroke.last2d = [tx, ty];
    this.stamp2d(tx, ty);
    this.flush();
  }

  move2d(e) {
    const L = this.layer; if (!L) return;
    const [tx, ty] = this.texelAt2d(e);
    this.hover2d = [tx, ty];
    const xi = Math.floor(tx), yi = Math.floor(ty);
    if (xi >= 0 && yi >= 0 && xi < L.w && yi < L.h) {
      const o = (yi * L.w + xi) * 4, d = L.data;
      $('t-readout').textContent = `tex ${L.texIdx[0]} · ${xi}, ${yi} · ${rgb2hex(d[o], d[o + 1], d[o + 2])}${d[o + 3] < 128 ? ' (cut-out)' : ''}`;
    }
    if (this.stroke?.last2d) {
      const [lx, ly] = this.stroke.last2d, r = +$('t-size').value;
      const dist = Math.hypot(tx - lx, ty - ly), step = Math.max(0.5, r * 0.25), n = Math.ceil(dist / step);
      for (let k = 1; k <= n; k++) this.stamp2d(lx + (tx - lx) * k / n, ly + (ty - ly) * k / n);
      this.stroke.last2d = [tx, ty];
      this.flush();
    } else this.draw2d();
  }

  stamp2d(cx, cy) {
    const L = this.stroke.layer, r = +$('t-size').value, M = this.stroke.mask;
    const op = +$('t-opacity').value / 100, hard = +$('t-hard').value / 100;
    const x0 = Math.floor(cx - r), x1 = Math.ceil(cx + r), y0 = Math.floor(cy - r), y1 = Math.ceil(cy + r);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (x < 0 || y < 0 || x >= L.w || y >= L.h) continue;
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / Math.max(r, 0.5);
      if (d >= 1) continue;
      const f = op * (d <= hard ? 1 : 1 - smooth(d, hard, 1));
      const i = y * L.w + x;
      if (f > M[i]) { M[i] = f; this.touch(x, y); }
    }
  }

  // ------------------------------------------------------------ 3D view
  hit3d(e) {
    const r = this.vp.renderer.domElement.getBoundingClientRect();
    const p = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(p, this.vp.camera);
    const hits = this.ray.intersectObjects(this.meshes.filter(m => m.visible), false);
    return hits[0] || null;
  }

  down3d(e) {
    const h = this.hit3d(e); if (!h) return;
    const L = h.object.userData.paint;
    if (!L) { status(h.object.userData.borrowed ? 'That part borrows its texture from another model: open that model to paint it.' : 'That part has no texture.', true); return; }
    if (L !== this.layer) { this.selectLayer(L); }
    const tx = h.uv.x * L.w, ty = h.uv.y * L.h;
    if (this.tool === 'pick') return this.pickColour(L, tx, ty);
    if (this.tool === 'fill') return this.fill(L, ((Math.floor(tx) % L.w) + L.w) % L.w, ((Math.floor(ty) % L.h) + L.h) % L.h);
    this.beginStroke(L);
    const pt = this.group.worldToLocal(h.point.clone());
    this.stroke.last3d = pt;
    this.stamp3d(pt, this.hitNormal(h));
    this.flush();
  }

  move3d(e) {
    const h = this.hit3d(e);
    const L = h?.object.userData.paint;
    if (!h || !L || this.tool === 'fill' || this.tool === 'pick') { this.cursor.visible = this.cursorM.visible = false; }
    if (h && L) {
      const tx = Math.floor(((h.uv.x % 1) + 1) % 1 * L.w), ty = Math.floor(((h.uv.y % 1) + 1) % 1 * L.h), o = (ty * L.w + tx) * 4;
      $('t-readout').textContent = `tex ${L.texIdx[0]} · ${tx}, ${ty} · ${rgb2hex(L.data[o], L.data[o + 1], L.data[o + 2])}`;
      if (this.tool !== 'fill' && this.tool !== 'pick') {
        const rad = this.radius3d(L);
        const n = h.face.normal.clone().transformDirection(h.object.matrixWorld);
        for (const [cur, pt] of [[this.cursor, h.point], [this.cursorM, $('t-mirror').checked ? this.mirrorWorld(h.point) : null]]) {
          cur.visible = !!pt;
          if (!pt) continue;
          cur.position.copy(pt);
          const nn = cur === this.cursorM ? n.clone().reflect(this.mirrorNormalWorld()) : n;
          cur.lookAt(pt.clone().add(nn));
          cur.scale.setScalar(rad * this.group.matrixWorld.getMaxScaleOnAxis());
        }
      }
    } else if (!h) $('t-readout').textContent = '–';
    if (this.stroke?.last3d && h && h.object.userData.paint === this.stroke.layer) {
      const pt = this.group.worldToLocal(h.point.clone()), last = this.stroke.last3d;
      const r = this.radius3d(this.stroke.layer), dist = pt.distanceTo(last);
      // big jumps (off an edge onto another part) start a new dab instead of smearing through the air
      const n = dist > r * 6 ? 1 : Math.ceil(dist / Math.max(r * 0.25, 1e-5));
      const nrm = this.hitNormal(h);
      for (let k = 1; k <= n; k++) this.stamp3d(dist > r * 6 ? pt : last.clone().lerp(pt, k / n), nrm);
      this.stroke.last3d = pt;
      this.flush();
    }
  }

  radius3d(L) { return +$('t-size').value / (L.density || 100); }

  // left/right mirror: the model's X axis (its local space under the viewport's root)
  mirrorLocal(p) { return new THREE.Vector3(-p.x, p.y, p.z); }
  mirrorWorld(pw) { return this.group.localToWorld(this.mirrorLocal(this.group.worldToLocal(pw.clone()))); }
  mirrorNormalWorld() { return new THREE.Vector3(1, 0, 0).transformDirection(this.group.matrixWorld); }

  // the surface normal at a hit (model space), from the mesh's own vertex normals
  hitNormal(h) {
    const N = h.object.geometry.attributes.normal.array, f = h.face, v = new THREE.Vector3();
    for (const i of [f.a, f.b, f.c]) v.x += N[i * 3], v.y += N[i * 3 + 1], v.z += N[i * 3 + 2];
    return v.normalize();
  }

  stamp3d(c, n) {
    this.stampSphere(c, n);
    if ($('t-mirror').checked) this.stampSphere(this.mirrorLocal(c), n && this.mirrorLocal(n));
  }

  // n: the hit surface's normal; triangles facing away from it (the back of a thin plate, the far side of a
  // limb) are skipped, so the ball doesn't paint through the model
  stampSphere(c, n) {
    const L = this.stroke.layer, R = this.radius3d(L), M = this.stroke.mask;
    const op = +$('t-opacity').value / 100, hard = +$('t-hard').value / 100;
    const W = L.w, H = L.h;
    for (const mesh of L.meshes) {
      const P = mesh.geometry.attributes.position.array, U = mesh.geometry.attributes.uv.array, I = mesh.geometry.index.array, T = mesh.userData.tri;
      for (let t = 0, n = I.length / 3; t < n; t++) {
        const dx = T[t * 4] - c.x, dy = T[t * 4 + 1] - c.y, dz = T[t * 4 + 2] - c.z, rr = R + T[t * 4 + 3];
        if (dx * dx + dy * dy + dz * dz > rr * rr) continue;
        const a = I[t * 3], b = I[t * 3 + 1], d = I[t * 3 + 2];
        if (n) {
          const NN = mesh.geometry.attributes.normal.array;
          const fx = NN[a * 3] + NN[b * 3] + NN[d * 3], fy = NN[a * 3 + 1] + NN[b * 3 + 1] + NN[d * 3 + 1], fz = NN[a * 3 + 2] + NN[b * 3 + 2] + NN[d * 3 + 2];
          if (fx * n.x + fy * n.y + fz * n.z < -0.05 * Math.hypot(fx, fy, fz)) continue;
        }
        const ax = U[a * 2] * W, ay = U[a * 2 + 1] * H, bx = U[b * 2] * W, by = U[b * 2 + 1] * H, cx = U[d * 2] * W, cy = U[d * 2 + 1] * H;
        const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
        if (Math.abs(den) < 1e-9) continue;
        // let edge texels in: a texel whose centre is within ~0.7 texel of the triangle counts (no seams)
        const la = Math.hypot(bx - cx, by - cy), lb = Math.hypot(cx - ax, cy - ay), lc = Math.hypot(ax - bx, ay - by);
        const A2 = Math.abs(den);
        const ea = 0.7 * la / A2, eb = 0.7 * lb / A2, ec = 0.7 * lc / A2;
        const x0 = Math.floor(Math.min(ax, bx, cx) - 1), x1 = Math.ceil(Math.max(ax, bx, cx) + 1);
        const y0 = Math.floor(Math.min(ay, by, cy) - 1), y1 = Math.ceil(Math.max(ay, by, cy) + 1);
        if ((x1 - x0) * (y1 - y0) > 4 * W * H) continue;
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const px = x + 0.5, py = y + 0.5;
          let l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den;
          let l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den;
          let l3 = 1 - l1 - l2;
          if (l1 < -ea || l2 < -eb || l3 < -ec) continue;
          l1 = Math.max(0, l1); l2 = Math.max(0, l2); l3 = Math.max(0, l3);
          const s = l1 + l2 + l3; l1 /= s; l2 /= s; l3 /= s;
          const wx = l1 * P[a * 3] + l2 * P[b * 3] + l3 * P[d * 3] - c.x;
          const wy = l1 * P[a * 3 + 1] + l2 * P[b * 3 + 1] + l3 * P[d * 3 + 1] - c.y;
          const wz = l1 * P[a * 3 + 2] + l2 * P[b * 3 + 2] + l3 * P[d * 3 + 2] - c.z;
          const dist = Math.sqrt(wx * wx + wy * wy + wz * wz) / R;
          if (dist >= 1) continue;
          const f = op * (dist <= hard ? 1 : 1 - smooth(dist, hard, 1));
          const xi = ((x % W) + W) % W, yi = ((y % H) + H) % H, i = yi * W + xi;
          if (f > M[i]) { M[i] = f; this.touch(xi, yi); }
        }
      }
    }
  }

  // ------------------------------------------------------------ strokes
  beginStroke(L) {
    const [cr, cg, cb] = hex2rgb($('t-colour').value);
    this.stroke = {
      layer: L, mask: new Float32Array(L.w * L.h), base: L.data.slice(),
      x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, fx0: Infinity, fy0: Infinity, fx1: -Infinity, fy1: -Infinity,
      colour: [cr, cg, cb], hsv: rgb2hsv(cr, cg, cb), tool: this.tool,
    };
    // the recolour brush keeps shading relative to the brightest paint under the first dab
    this.stroke.refV = null;
  }

  touch(x, y) {
    const s = this.stroke;
    if (x < s.x0) s.x0 = x; if (x > s.x1) s.x1 = x; if (y < s.y0) s.y0 = y; if (y > s.y1) s.y1 = y;
  }

  // composite the stroke's dirty rectangle: base -> target, weighted by the stroke mask
  flush() {
    const s = this.stroke; if (!s || s.x1 < s.x0) return;
    const L = s.layer, D = L.data, B = s.base, O = L.orig, M = s.mask, [cr, cg, cb] = s.colour;
    if (s.tool === 'recolor' && s.refV == null) {
      // reference brightness: the 90th percentile of what the first dab covers
      const vs = [];
      for (let y = s.y0; y <= s.y1; y++) for (let x = s.x0; x <= s.x1; x++) { const i = y * L.w + x; if (M[i] > 0) vs.push(Math.max(B[i * 4], B[i * 4 + 1], B[i * 4 + 2]) / 255); }
      vs.sort((a, b) => a - b);
      s.refV = vs.length ? vs[Math.floor(vs.length * 0.9)] : 1;
    }
    for (let y = s.y0; y <= s.y1; y++) for (let x = s.x0; x <= s.x1; x++) {
      const i = y * L.w + x, m = M[i];
      if (!m) continue;
      const o = i * 4;
      let tr, tg, tb, ta = B[o + 3];
      if (s.tool === 'restore') { tr = O[o]; tg = O[o + 1]; tb = O[o + 2]; ta = O[o + 3]; }
      else if (s.tool === 'recolor') [tr, tg, tb] = shadeKeep(B[o], B[o + 1], B[o + 2], s.hsv, s.refV);
      else { tr = cr; tg = cg; tb = cb; }
      D[o] = B[o] + (tr - B[o]) * m; D[o + 1] = B[o + 1] + (tg - B[o + 1]) * m; D[o + 2] = B[o + 2] + (tb - B[o + 2]) * m;
      D[o + 3] = m >= 0.5 ? ta : B[o + 3];
    }
    if (s.x0 < s.fx0) s.fx0 = s.x0; if (s.y0 < s.fy0) s.fy0 = s.y0; if (s.x1 > s.fx1) s.fx1 = s.x1; if (s.y1 > s.fy1) s.fy1 = s.y1;
    this.refresh(L, s.x0, s.y0, s.x1 - s.x0 + 1, s.y1 - s.y0 + 1);
    s.x0 = s.y0 = Infinity; s.x1 = s.y1 = -Infinity;
  }

  endStroke() {
    const s = this.stroke; if (!s) return;
    this.stroke = null;
    if (s.fx1 < s.fx0) return;
    this.pushUndo(s.layer, s.base);
  }

  refresh(L, x = 0, y = 0, w = L.w, h = L.h) {
    L.ctx.putImageData(L.image, 0, 0, x, y, w, h);
    L.tex.needsUpdate = true;
    if (L === this.layer) this.draw2d();
    clearTimeout(L.thumbT); L.thumbT = setTimeout(() => this.drawThumb(L), 150);
  }

  pushUndo(L, before) {
    this.undo.push({ L, data: before });
    if (this.undo.length > UNDO_LIMIT) this.undo.shift();
    this.redo = [];
    this.markDirty(L);
  }

  markDirty(L) {
    L.dirty = !L.data.every((v, k) => v === L.orig[k]);
    this.renderTexList(); this.updateButtons();
  }

  swapState(from, to) {
    const e = from.pop(); if (!e) return;
    to.push({ L: e.L, data: e.L.data.slice() });
    e.L.data.set(e.data);
    if (e.L !== this.layer) this.selectLayer(e.L);
    this.refresh(e.L); this.markDirty(e.L);
  }
  doUndo() { this.swapState(this.undo, this.redo); }
  doRedo() { this.swapState(this.redo, this.undo); }

  // ------------------------------------------------------------ one-shot tools
  pickColour(L, tx, ty) {
    const x = ((Math.floor(tx) % L.w) + L.w) % L.w, y = ((Math.floor(ty) % L.h) + L.h) % L.h, o = (y * L.w + x) * 4;
    const hex = rgb2hex(L.data[o], L.data[o + 1], L.data[o + 2]);
    $(this.pickInto || 't-colour').value = hex;
    status(`Picked ${hex}${this.pickInto ? ` for "${this.pickInto === 't-from' ? 'From' : 'To'}"` : ''}.`);
    // a From/To eyedropper is a one-off: go back to the tool that was in use
    if (this.pickInto) { this.pickInto = null; this.setTool(this.prevTool || 'brush'); }
    this.showBrush();
  }

  // flood fill (4-connected) from a texel, within a colour tolerance; "keep shading" recolours instead of flattening
  fill(L, sx, sy) {
    if (sx < 0 || sy < 0 || sx >= L.w || sy >= L.h) return;
    const before = L.data.slice(), D = L.data, W = L.w, H = L.h;
    const tol = +$('t-tol').value, tol2 = tol * tol * 3, keep = $('t-fillshade').checked;
    const o0 = (sy * W + sx) * 4, r0 = D[o0], g0 = D[o0 + 1], b0 = D[o0 + 2];
    const [cr, cg, cb] = hex2rgb($('t-colour').value), hsv = rgb2hsv(cr, cg, cb);
    const seen = new Uint8Array(W * H), stack = [sx + sy * W];
    const v0 = Math.max(r0, g0, b0) / 255;
    seen[sx + sy * W] = 1;
    let n = 0;
    while (stack.length) {
      const i = stack.pop(), x = i % W, y = (i / W) | 0, o = i * 4;
      if (keep) { const c = shadeKeep(before[o], before[o + 1], before[o + 2], hsv, v0); D[o] = c[0]; D[o + 1] = c[1]; D[o + 2] = c[2]; }
      else { D[o] = cr; D[o + 1] = cg; D[o + 2] = cb; }
      n++;
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) {
        if (j < 0 || seen[j]) continue;
        const q = j * 4, dr = before[q] - r0, dg = before[q + 1] - g0, db = before[q + 2] - b0;
        if (dr * dr + dg * dg + db * db <= tol2 && before[q + 3] >= 128) { seen[j] = 1; stack.push(j); }
      }
    }
    this.refresh(L); this.pushUndo(L, before);
    status(`Filled ${n.toLocaleString()} texels.`);
  }

  // every texel near the "from" hue takes the "to" colour, keeping its shading
  colourSwap() {
    const L = this.layer; if (!L) return;
    const before = L.data.slice(), D = L.data;
    const [fh, fs, fv] = rgb2hsv(...hex2rgb($('t-from').value));
    const to = rgb2hsv(...hex2rgb($('t-to').value));
    const tol = +$('t-htol').value, minS = +$('t-smin').value / 100;
    let n = 0;
    for (let o = 0; o < D.length; o += 4) {
      const [h, s] = rgb2hsv(D[o], D[o + 1], D[o + 2]);
      const w = (1 - smooth(hueDist(h, fh), tol * 0.7, tol)) * smooth(s, minS * 0.7, minS);
      if (w <= 0) continue;
      const c = shadeKeep(D[o], D[o + 1], D[o + 2], to, fv);
      for (let k = 0; k < 3; k++) D[o + k] = D[o + k] + (c[k] - D[o + k]) * w;
      n++;
    }
    this.refresh(L); this.pushUndo(L, before);
    status(`Colour swap changed ${n.toLocaleString()} texels.`);
  }

  // hue shift / saturation / brightness for the whole texture (or only near the "from" hue)
  adjust() {
    const L = this.layer; if (!L) return;
    const before = L.data.slice(), D = L.data;
    const dh = +$('t-ah').value, ks = +$('t-as').value / 100, kv = +$('t-av').value / 100;
    const only = $('t-aonly').checked, [fh] = rgb2hsv(...hex2rgb($('t-from').value)), tol = +$('t-htol').value;
    for (let o = 0; o < D.length; o += 4) {
      const [h, s, v] = rgb2hsv(D[o], D[o + 1], D[o + 2]);
      const w = only ? 1 - smooth(hueDist(h, fh), tol * 0.7, tol) : 1;
      if (w <= 0) continue;
      const c = hsv2rgb(h + dh, Math.min(1, s * ks), Math.min(1, v * kv));
      for (let k = 0; k < 3; k++) D[o + k] = D[o + k] + (c[k] - D[o + k]) * w;
    }
    this.refresh(L); this.pushUndo(L, before);
  }

  revertLayer() {
    const L = this.layer; if (!L) return;
    const before = L.data.slice();
    L.data.set(L.orig);
    this.refresh(L); this.pushUndo(L, before);
  }

  importImage(file) {
    const L = this.layer; if (!L) return;
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = L.w; c.height = L.h;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0, L.w, L.h);
      const before = L.data.slice();
      L.data.set(x.getImageData(0, 0, L.w, L.h).data);
      this.refresh(L); this.pushUndo(L, before);
      URL.revokeObjectURL(img.src);
      status(`Imported ${file.name}${img.width !== L.w || img.height !== L.h ? ` (scaled from ${img.width}×${img.height})` : ''}.`);
    };
    img.onerror = () => status(`Can't read ${file.name}`, true);
    img.src = URL.createObjectURL(file);
  }

  // ------------------------------------------------------------ saving
  buildFile() {
    const m = this.model, out = new Uint8Array(m.buf.slice(0));
    let blocks = 0;
    for (const L of this.layers) {
      if (!L.dirty) continue;
      const { dds, changed } = encodeLike(L.dds, L.orig, L.data, L.w, L.h);
      blocks += changed;
      for (const ti of L.texIdx) {
        const t = m.textures[ti];
        if (t.size !== dds.length) throw new Error(`tex ${ti}: size changed`);
        out.set(dds, t.offset);
      }
    }
    return { out, blocks };
  }

  async save() {
    if (!this.model || !this.layers.some(l => l.dirty)) return;
    const { out, blocks } = this.buildFile();
    const r = await api.save(this.model.path, out);
    // the saved file is the new baseline: what's on disk now is the "original" for Restore and the next save
    const m = this.model;
    m.buf = out.buffer; m.u8 = new Uint8Array(m.buf); m.dv = new DataView(m.buf);
    for (const L of this.layers) {
      if (!L.dirty) continue;
      L.dds = new Uint8Array(m.dds(m.textures[L.texIdx[0]]));
      const img = decodeDDS(L.dds);
      L.orig = new Uint8ClampedArray(img.rgba);
      L.data.set(img.rgba);   // show exactly what the game will see (after compression)
      this.refresh(L);
      L.dirty = false;
    }
    this.undo = []; this.redo = [];
    this.renderTexList(); this.updateButtons();
    status(`Saved ${this.model.path} (${blocks.toLocaleString()} blocks re-encoded)${r.backup ? `; the original is kept as ${r.backup}` : ''}.`);
  }

  downloadGHG() {
    if (!this.model) return;
    const { out } = this.buildFile();
    download(new Blob([out]), this.model.path.split('/').pop());
  }
}
