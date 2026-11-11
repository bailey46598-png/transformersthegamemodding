// Cutscene player: plays CUT\*.CU2 in its level with its characters, cameras and moving set pieces.
// What each cutscene loads comes from its CUT\<name>.CFG (CUT, SCENE, CHAR and INCLUDE lines).
import * as THREE from 'three';
import { GSCScene, M4 } from './formats.js';
import { openScene } from './ps3_scene.js';
import { LevelView } from './level_view.js';
import { Cutscene, blockPose, objectVisible, poseMatrix } from './cu2.js';
import { loadCharacter, loadModel, siblingWithBones, buildMeshes, poseBones, skinMeshes, disposeGroup } from './rig.js';
import { api, $, status, esc, joinPath, Viewport, ddsTexture, download } from './common.js';
import { Navigator } from './navigator.js';

const DEFAULT_FOV = 50; // vertical degrees. NOT stored in the files (assumed; adjustable)

// ------------------------------------------------------------------ CUT\*.CFG
// Lines: CUT <file> [fps], SCENE <gsc> [flags], CHAR <cfg>, INCLUDE <cfg>; ';' starts a comment.
export async function readCutConfig(path, readText, seen = new Set()) {
  const out = { cut: null, fps: null, scenes: [], chars: [], settings: {} };
  const key = path.toLowerCase();
  if (seen.has(key)) return out;
  seen.add(key);
  let text;
  try { text = await readText(path); } catch { out.missing = [path]; return out; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split(';')[0].trim();
    if (!line) continue;
    const t = line.split(/\s+/), kw = t[0].toUpperCase(), arg = (t[1] || '').replace(/\\/g, '/');
    if (kw === 'CUT') { out.cut = arg; if (t[2]) out.fps = +t[2]; }
    else if (kw === 'SCENE') out.scenes.push({ path: arg, flags: t.slice(2).map(x => x.toUpperCase()) });
    else if (kw === 'CHAR') out.chars.push(arg);
    else if (kw === 'INCLUDE') {
      const sub = await readCutConfig(arg, readText, seen);
      out.scenes.push(...sub.scenes); out.chars.push(...sub.chars); Object.assign(out.settings, sub.settings);
      if (sub.missing) (out.missing ??= []).push(...sub.missing);
    } else out.settings[kw] = t.slice(1).join(' ');
  }
  return out;
}

// The PC build has one combined scene per level folder (e.g. TRANQUILITY_PC.GSC) where the configs name the
// console's split scenes (tranquility_main.gsc, _pos, _buildings): use the level folder's own .GSC.
async function resolveLevelScene(scenes) {
  const lvl = scenes.find(s => /^levels\//i.test(s.path) && !s.flags.includes('NORENDER')) || scenes.find(s => /^levels\//i.test(s.path));
  if (!lvl) return null;
  const dir = lvl.path.split('/').slice(0, 2).join('/');
  let L;
  try { L = await api.list(dir); } catch { return null; }
  const g = L.files.filter(f => /\.gsc$/i.test(f.name));
  const pick = g.find(f => /_pc\.gsc$/i.test(f.name)) || g.sort((a, b) => b.size - a.size)[0];
  return pick ? joinPath(dir, pick.name) : null;
}

// A level folder's scene: its LEVEL.CFG names it (PATH Levels/Tranquility2 + SCENE Tranquility ->
// TRANQUILITY_PC.GSC; BARRICADETRANQUILITY and HOOVERDAM have no scene of their own). Else the folder's own .GSC.
async function levelFolderScene(dir) {
  const pickIn = async (d, scene) => {
    let L;
    try { L = await api.list(d); } catch { return null; }
    const g = L.files.filter(f => /\.gsc$/i.test(f.name));
    const want = scene && g.find(f => f.name.toLowerCase() === `${scene.toLowerCase()}_pc.gsc`);
    const pick = want || g.find(f => /_pc\.gsc$/i.test(f.name) && !/_fre_/i.test(f.name)) || g.sort((a, b) => b.size - a.size)[0];
    return pick ? joinPath(d, pick.name) : null;
  };
  try {
    const text = await api.text(joinPath(dir, 'LEVEL.CFG'));
    const lines = kw => text.split(/\r?\n/).map(l => l.split(';')[0].trim()).filter(l => new RegExp(`^${kw}\\s`, 'i').test(l)).map(l => l.split(/\s+/)[1]);
    const path = lines('PATH')[0];
    // FRONTEND lists FrontEnd_Fre (French) before FrontEnd: prefer the plain one
    const scenes = lines('SCENE').sort((a, b) => /_fre$/i.test(a) - /_fre$/i.test(b));
    if (path) { const hit = await pickIn(path.replace(/\\/g, '/'), scenes[0]); if (hit) return hit; }
  } catch {}
  return pickIn(dir, null);
}

// ------------------------------------------------------------------ the tab
export class CutsceneView {
  constructor(modelView) {
    this.mv = modelView;
    this.vp = new Viewport($('c-canvas'), { far: 30000 });
    this.vp.scene.background = new THREE.Color(0x1b1e25);
    this.vp.camera.layers.enable(2);
    this.nav = new Navigator(this.vp, {
      pick: ray => { if (!this.levelMeshes?.length) return null; ray.firstHitOnly = true; return ray.intersectObjects(this.levelMeshes, false)[0]?.point || null; },
      active: () => !$('tab-cut').classList.contains('hidden') && !this.camMode(),
      bookmarkKey: () => 'tfstudio.cutviews.' + (this.entry?.name || ''),
      notify: m => status(m),
    });
    this.frame = 0; this.playing = false;
    this.sceneCache = { path: null, S: null };
    this.texCache = new Map();
    this.chars = []; this.objs = [];
    // the soundtrack, taken from the game's video of this cutscene (see tools/extract_cutscene_audio.py)
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.sound = null;
    this.vp.onFrame.push(dt => this.tick(dt));
    this.bindUI();
  }

  camMode() { return $('c-camera').checked && !!this.cut?.cameras.length; }

  async init() {
    status('Reading cutscene configs…');
    const L = await api.list('CUT');
    const cfgs = L.files.filter(f => /\.cfg$/i.test(f.name));
    const cu2 = new Map(L.files.filter(f => /\.cu2$/i.test(f.name)).map(f => [f.name.toLowerCase().replace(/\.cu2$/, ''), f.name]));
    const list = [];
    await Promise.all(cfgs.map(async f => {
      const text = await api.text('CUT/' + f.name);
      const m = text.match(/^\s*CUT\s+(\S+)/im);
      if (!m) return; // shared settings (GENERAL.CFG, level setups)
      const base = m[1].replace(/\\/g, '/').split('/').pop().replace(/\.[^.]*$/, '').toLowerCase();
      const inc = [...text.matchAll(/^\s*INCLUDE\s+(\S+)/gim)].map(x => x[1].replace(/\\/g, '/').split('/').pop().replace(/\.cfg$/i, '').toUpperCase()).filter(x => x !== 'GENERAL');
      list.push({ name: f.name.replace(/\.cfg$/i, ''), cfg: 'CUT/' + f.name, cu2: cu2.has(base) ? 'CUT/' + cu2.get(base) : null, group: inc[0] || 'OTHER' });
    }));
    // CU2 files with no config of their own
    // (DECEPT2_CH2_MIDTRO2 etc. look like older copies of DCPT2_...: borrow that config's level and characters)
    for (const [k, n] of cu2) if (!list.some(e => e.cu2?.toLowerCase() === ('cut/' + n).toLowerCase())) {
      const twin = list.find(e => e.name.toLowerCase() === k.replace(/^decept/, 'dcpt'));
      list.push({ name: n.replace(/\.cu2$/i, ''), cfg: twin?.cfg || null, cu2: 'CUT/' + n, group: twin ? twin.group : 'NO CONFIG', borrowed: twin?.name });
    }
    const story = list.length;
    // Cutscenes kept in the level folders (LEVELS\<level>\CUTSCENES, FRONTEND\CUTSCENE): in-level animations (Hoover
    // Dam's doors and generators), front-end menu moves, and short story stand-ins. They play in that level's scene.
    const levels = await api.list('LEVELS');
    await Promise.all(levels.dirs.filter(d => !d.toUpperCase().startsWith('PS3_')).map(async d => {
      let sub;
      try { sub = await api.list(joinPath('LEVELS', d)); } catch { return; }
      for (const cd of sub.dirs.filter(x => /^cutscenes?$/i.test(x))) {
        const L2 = await api.list(joinPath('LEVELS', d, cd));
        for (const f of L2.files.filter(x => /\.cu2$/i.test(x.name)))
          list.push({ name: f.name.replace(/\.cu2$/i, ''), cfg: null, cu2: joinPath('LEVELS', d, cd, f.name), level: joinPath('LEVELS', d), group: `${d.toUpperCase()} · level folder` });
      }
    }));
    const isLevel = e => e.level ? 1 : 0;
    this.list = list.sort((a, b) => isLevel(a) - isLevel(b) || a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
    this.renderList();
    status(`${story} cutscenes in CUT, ${list.length - story} in level folders.`);
  }

  renderList() {
    const q = $('c-filter').value.toLowerCase();
    let html = '', last = null;
    (this.list || []).forEach((e, i) => {
      if (q && !`${e.name} ${e.group}`.toLowerCase().includes(q)) return;
      if (e.group !== last) { html += `<div class="grp">${esc(e.group)}</div>`; last = e.group; }
      html += `<div class="item ${this.entry === e ? 'on' : ''}" data-i="${i}" title="${esc(e.cu2 || 'no .CU2 file')}">${esc(e.name)}${e.cu2 ? '' : ' <span class="sub warn">no .CU2</span>'}</div>`;
    });
    $('c-list').innerHTML = html || '<div class="hint" style="padding:10px">No matches.</div>';
  }

  bindUI() {
    $('c-filter').oninput = () => this.renderList();
    $('c-list').onclick = e => { const it = e.target.closest('.item'); if (it) this.open(this.list[+it.dataset.i]); };
    $('c-play').onclick = () => this.setPlaying(!this.playing);
    $('c-scrub').oninput = e => { this.setPlaying(false); this.seek(+e.target.value); };
    $('c-prev').onclick = () => this.jumpShot(-1);
    $('c-next').onclick = () => this.jumpShot(1);
    $('c-camera').onchange = () => { this.applyCameraMode(); this.update(); };
    for (const id of ['c-level', 'c-chars', 'c-objs', 'c-paths', 'c-bars']) $(id).onchange = () => this.applyToggles();
    $('c-fov').oninput = () => { $('c-fovv').textContent = $('c-fov').value + '°'; this.update(); };
    $('c-glb').onclick = () => this.exportGLB().catch(e => { console.error(e); status(`Export failed: ${e.message}`, true); });
    $('c-ogg').onclick = () => {
      if (!this.sound || !this.audioUrl) { status('This cutscene has no sound.', true); return; }
      const a = document.createElement('a'); a.href = this.audioUrl; a.download = `${this.entry.name}.ogg`; a.click();
    };
    $('c-sound').onchange = () => { this.applyVolume(); this.syncAudio(); };
    $('c-vol').oninput = () => this.applyVolume();
    $('c-speed').onchange = () => this.syncAudio();
    try { const v = localStorage.getItem('tfstudio.cutvol'); if (v != null) $('c-vol').value = v; } catch {}
    this.applyVolume();
    $('c-shot').onclick = () => this.vp.screenshot(`${this.entry?.name || 'cutscene'}_f${Math.round(this.frame)}.png`);
    $('c-shots').onclick = e => { const it = e.target.closest('[data-from]'); if (it) { this.setPlaying(false); this.seek(+it.dataset.from); } };
    $('c-charlist').onclick = e => { const it = e.target.closest('[data-from]'); if (it) { this.setPlaying(false); this.seek(+it.dataset.from); } };
    window.addEventListener('keydown', e => {
      if ($('tab-cut').classList.contains('hidden') || ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
      if (e.code === 'Space') { e.preventDefault(); this.setPlaying(!this.playing); }
      else if (e.code === 'Comma' || e.code === 'Period') { this.setPlaying(false); this.seek(Math.round(this.frame) + (e.code === 'Period' ? 1 : -1)); }
      else if (e.code === 'KeyC') { $('c-camera').checked = !$('c-camera').checked; this.applyCameraMode(); this.update(); }
      else if (e.code === 'PageDown' || e.code === 'PageUp') { e.preventDefault(); this.jumpShot(e.code === 'PageDown' ? 1 : -1); }
      else if (e.code === 'Home') this.seek(0);
    });
  }

  // ------------------------------------------------------------ loading
  async open(entry) {
    if (!entry.cu2) { status(`${entry.name}: there is no .CU2 file for this config.`, true); return; }
    const token = this.loading = {};
    this.setPlaying(false);
    this.entry = entry; this.renderList();
    try {
      status(`Reading ${entry.cu2}…`);
      const cut = new Cutscene(await api.bytes(entry.cu2), entry.name);
      const cfg = entry.cfg ? await readCutConfig(entry.cfg, p => api.text(p)) : { scenes: [], chars: [], settings: {} };
      if (this.loading !== token) return;
      this.clear();
      this.cut = cut; this.cfg = cfg;
      if (cfg.fps) cut.fps = cfg.fps;
      this.warnings = [...cut.notes];
      if (entry.level) this.warnings.push('From the level folder: an in-level or menu animation, or an early stand-in. The game\'s story cutscenes are the ones in CUT\\.');
      await this.loadSound(entry, cut);
      if (entry.borrowed) this.warnings.push(`No config of its own: the level and characters come from ${entry.borrowed}.CFG (assumed to be the same cutscene).`);
      // level
      this.scenePath = entry.level ? await levelFolderScene(entry.level) : await resolveLevelScene(cfg.scenes);
      if (this.scenePath) {
        let S = this.sceneCache.path === this.scenePath ? this.sceneCache.S : null;
        if (!S) {
          status(`Reading ${this.scenePath}…`);
          S = openScene(await api.bytes(this.scenePath), GSCScene);
          this.sceneCache = { path: this.scenePath, S };
          this.texCache = new Map();
        }
        if (this.loading !== token) return;
        status(`Building ${this.scenePath.split('/').pop()}…`);
        await new Promise(r => setTimeout(r, 0));
        this.buildLevel(S);
        if (cut.objects.length && !this.objs.length && this.objMissing.length === cut.objects.length)
          this.warnings.push(`None of the ${cut.objects.length} pieces it moves (${[...new Set(this.objMissing)].slice(0, 3).join(', ')}…) are in this scene, so nothing moves. Hoover Dam's door and generator animations are like this: their CUTSCENE lines in LEVEL.CFG are commented out.`);
      } else if (cfg.scenes.length) this.warnings.push(`its scene (${cfg.scenes[0].path}) is not in this game folder: no level shown`);
      // characters
      status(`Loading ${cut.characters.length} characters…`);
      await this.buildCharacters(token);
      if (this.loading !== token) return;
      this.buildCameraPaths();
      $('c-empty').classList.add('hidden');
      $('c-scrub').max = Math.max(cut.frames - 1, 1);
      this.renderMarks(); this.renderInfo();
      this.applyCameraMode(); this.applyToggles();
      this.seek(0);
      if (!this.camMode()) this.frameAll();
      const missing = this.chars.filter(c => !c.model).length;
      status(`${entry.name}: ${cut.frames} frames (${cut.seconds.toFixed(1)} s), ${cut.shots.length} shots, ${cut.characters.length} characters${missing ? ` (${missing} not shown)` : ''}.`);
      this.setPlaying(true);
    } catch (e) { console.error(e); status(`${entry.name}: ${e.message}`, true); }
  }

  clear() {
    for (const g of [this.levelGroup, this.objGroup, this.charGroup, this.pathGroup]) if (g) { this.vp.root.remove(g); disposeGroup(g); }
    this.levelGroup = this.objGroup = this.charGroup = this.pathGroup = null;
    this.levelMeshes = []; this.chars = []; this.objs = []; this.cut = null;
  }

  // Level geometry, built by the level tab's builder. Draws of the set pieces this cutscene moves are built as
  // their own groups so they can follow their tracks.
  buildLevel(S) {
    const cut = this.cut;
    const byName = new Map();
    for (const ins of S.instances || []) if (ins.name) { const k = ins.name.toLowerCase(); if (!byName.has(k)) byName.set(k, ins); }
    const moving = new Map(); // draw id -> object index in this.objs
    this.objs = [];
    this.objMissing = [];
    for (const o of cut.objects) {
      const ins = byName.get(o.name.toLowerCase());
      if (!ins) { this.objMissing.push(o.name); continue; }
      const so = S.objects[ins.object];
      if (!so) { this.objMissing.push(o.name); continue; }
      // an object with several instances: its draws for this one sit at this instance's matrix
      let draws = so.draws;
      if ((so.instances?.length || 0) > 1) draws = draws.filter(di => { const m = S.draws[di].matrix; return m && Math.hypot(m[12] - ins.matrix[12], m[13] - ins.matrix[13], m[14] - ins.matrix[14]) < 0.01; });
      draws = draws.filter(di => !moving.has(di));
      if (!o.block && !o.visibility?.length) continue; // listed but never moves or switches: stays in the level
      const rec = { o, ins, draws, M0: ins.matrix, inv0: M4.invert3x4(ins.matrix), group: null };
      for (const di of draws) moving.set(di, this.objs.length);
      this.objs.push(rec);
    }
    const build = draws => {
      // a mirrored root like the Viewport's, so the builder's boxes (sky, framing) are in the same space
      const root = new THREE.Group();
      root.scale.z = -1;
      const host = { gsc: Object.create(S, { draws: { value: draws } }), vp: { root }, texture: i => this.texture(S, i) };
      LevelView.prototype.buildGeometry.call(host);
      root.remove(host.geoGroup);
      return host;
    };
    const stat = build(S.draws.filter(d => !moving.has(d.id)));
    this.levelGroup = stat.geoGroup;
    this.levelMeshes = stat.levelMeshes;
    this.playBox = stat.playBox;
    this.vp.root.add(this.levelGroup);
    // the sky dome hides everything from outside: draw it only while the camera is inside it
    this.skyMeshes = this.levelMeshes.filter(m => m.userData.sky);
    this.objGroup = new THREE.Group();
    for (const r of this.objs) {
      if (!r.draws.length) continue;
      const h = build(r.draws.map(di => S.draws[di]));
      for (const m of h.levelMeshes) { m.layers.set(0); m.userData.sky = false; }
      r.group = h.geoGroup;
      r.group.matrixAutoUpdate = false;
      this.objGroup.add(r.group);
    }
    this.vp.root.add(this.objGroup);
  }

  texture(S, i) {
    if (this.texCache.has(i)) return this.texCache.get(i);
    const t = S.textures[i];
    const tex = t && t.size && !t.cube ? ddsTexture(S.dds(t)) : null;
    if (tex && S.ps3 && tex.format === THREE.RGB_S3TC_DXT1_Format) { tex.format = THREE.RGBA_S3TC_DXT1_Format; tex.userData.hasAlpha = true; }
    this.texCache.set(i, tex);
    return tex;
  }

  async buildCharacters(token) {
    const cut = this.cut, mv = this.mv;
    if (!mv.charByName) await (mv.ready || mv.init());
    this.charGroup = new THREE.Group();
    this.vp.root.add(this.charGroup);
    const models = new Map(); // "name:bones" -> Promise<{model, note}>
    const get = (name, bones) => {
      const key = `${name.toLowerCase()}:${bones}`;
      if (!models.has(key)) models.set(key, (async () => {
        const entry = mv.charByName.get(name.toLowerCase());
        if (!entry) return { note: 'no character config with this name' };
        try {
          const { modelPath, parents } = await loadCharacter(entry, mv.charByName);
          let path = modelPath, note = '';
          let model = await loadModel(path, parents);
          if (bones && model.bones.length !== bones) {
            const alt = await siblingWithBones(path, bones);
            if (alt) { model = await loadModel(alt, parents); path = alt; note = `uses ${alt.split('/').pop()} (its skeleton matches)`; }
          }
          return { model, path, note };
        } catch (e) { return { note: e.message }; }
      })());
      return models.get(key);
    };
    const loaded = await Promise.all(cut.characters.map(c => get(c.name, c.skeleton?.bones || 0)));
    if (this.loading !== token) return;
    cut.characters.forEach((c, i) => {
      const { model, path } = loaded[i];
      let note = loaded[i].note;
      const rec = { c, model, path, note, meshes: [], group: null, posed: false, nPose: 0 };
      if (model && c.skeleton) {
        const sk = c.skeleton, n = Math.min(sk.bones, model.bones.length);
        if (sk.bones === model.bones.length) { rec.posed = true; rec.nPose = n; }
        else {
          // a track with a few bones more or fewer than the model: the shared bones line up by index when their
          // offsets equal the model's bind offsets (Barricade 76 of 128, Bumblebee 46 of 48, Optimus 45 of 46)
          const v = sk.pose(0);
          let match = 0;
          for (let b = 0; b < n; b++) { const L = model.local[b]; if (Math.hypot(v[b * 9] - L[12], v[b * 9 + 1] - L[13], -v[b * 9 + 2] - L[14]) < 0.02) match++; }
          const file = path.split('/').pop();
          if (match >= 0.8 * n) { rec.posed = true; rec.nPose = n; rec.note = `track has ${sk.bones} bones, ${file} has ${model.bones.length}: the first ${n} are posed`; }
          else rec.note = `track has ${sk.bones} bones, ${file} has ${model.bones.length} and they don't line up: shown in bind pose`;
        }
      }
      if (model) {
        const { group, meshes } = buildMeshes(model);
        rec.group = group; rec.meshes = meshes;
        this.charGroup.add(group);
      }
      this.chars.push(rec);
    });
  }

  // a line through each camera's positions over the shots it is used in
  buildCameraPaths() {
    const cut = this.cut, b = cut.cameraBlock;
    this.pathGroup = new THREE.Group();
    if (b) for (const s of cut.shots) {
      if (s.camera == null) continue;
      const node = cut.cameras[s.camera].node, pts = [];
      for (let f = s.from; f <= s.to; f += 2) { const p = blockPose(b, f, node, true); if (p) pts.push(new THREE.Vector3(p[0], p[1], -p[2])); }
      if (pts.length < 2) continue;
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x5aa9e6 }));
      this.pathGroup.add(line);
    }
    this.camMarker = new THREE.Mesh(new THREE.ConeGeometry(0.4, 1.2, 4), new THREE.MeshBasicMaterial({ color: 0xe8a33d, wireframe: true }));
    this.camMarker.geometry.rotateX(Math.PI / 2); // cone tip along +Z (the camera's view direction)
    this.camMarker.matrixAutoUpdate = false;
    this.pathGroup.add(this.camMarker);
    this.vp.root.add(this.pathGroup);
  }

  // ------------------------------------------------------------ playback
  setPlaying(p) {
    this.playing = p && !!this.cut;
    $('c-play').textContent = this.playing ? '❚❚' : '▶';
    this.syncAudio();
  }

  // ------------------------------------------------------------ sound
  // The game's video of a cutscene: A5_CH3_OUTRO -> AUTO5_CH3_OUTRO, D5_.. / DECEPT6_.. -> DCPT5_.. / DCPT6_..,
  // ..._2 (alternate take) -> the main take, TTIDENT -> TT_LOGO. Same rule as tools/extract_cutscene_audio.py.
  static videoName(name) {
    let n = name.toLowerCase().replace(/^a(\d)_/, 'auto$1_').replace(/^d(\d)_/, 'dcpt$1_').replace(/^decept/, 'dcpt').replace(/_2$/, '');
    if (n === 'ttident') n = 'tt_logo';
    return n.toUpperCase();
  }

  async loadSound(entry, cut) {
    if (!this.soundIndex) {
      try { const r = await fetch('cutscene_audio/index.json'); this.soundIndex = r.ok ? await r.json() : {}; }
      catch { this.soundIndex = {}; }
    }
    this.audio.pause();
    const s = this.soundIndex[CutsceneView.videoName(entry.name)] || null;
    this.sound = s;
    if (this.audioUrl) { URL.revokeObjectURL(this.audioUrl); this.audioUrl = null; }
    if (s) {
      // loaded whole and played from memory: the local server has no range requests, and without them the
      // browser can neither seek in the file nor read its length (it guessed 8.7 s for a 12.9 s track)
      try {
        const r = await fetch('cutscene_audio/' + encodeURIComponent(s.file));
        if (!r.ok) throw new Error(r.statusText);
        this.audioUrl = URL.createObjectURL(await r.blob());
        this.audio.src = this.audioUrl;
        this.audio.load();
      } catch (e) { this.sound = null; this.warnings.push(`Could not load the sound (${s.file}): ${e.message}`); }
    }
    if (this.sound) {
      const d = s.seconds - cut.seconds;
      if (Math.abs(d) > 0.3) this.warnings.push(`The video's soundtrack (${s.source}) is ${Math.abs(d).toFixed(2)} s ${d > 0 ? 'longer' : 'shorter'} than this cutscene: it may be a different edit, so the sound can drift out of sync.`);
    } else if (!s) {
      this.audio.removeAttribute('src');
      this.audio.load();
      this.warnings.push(Object.keys(this.soundIndex).length
        ? (entry.level ? 'No sound: level-folder cutscenes play in the level with its normal sound, not from a video.'
          : `No sound: the game has no video named ${CutsceneView.videoName(entry.name).toLowerCase()}.bik (AUTO4 and DCPT4 were never rendered).`)
        : 'No sound yet: run "Extract cutscene audio.bat" (in mods\\tf_studio) once to pull the soundtracks from the game\'s fmv videos.');
    }
    $('c-sound').disabled = !this.sound;
  }

  applyVolume() {
    this.audio.volume = +$('c-vol').value;
    this.audio.muted = !$('c-sound').checked;
    try { localStorage.setItem('tfstudio.cutvol', $('c-vol').value); } catch {}
  }

  // the audio follows the timeline: playing, position and speed
  syncAudio() {
    const a = this.audio;
    if (!this.sound || !this.cut || !a.src) return;
    const t = this.frame / this.cut.fps;
    const want = this.playing && $('c-sound').checked && t < (a.duration || this.sound.seconds);
    a.playbackRate = +$('c-speed').value;
    if (!want) { if (!a.paused) a.pause(); return; }
    if (Math.abs(a.currentTime - t) > 0.05) a.currentTime = t;
    if (a.paused) a.play().catch(() => status('The browser blocked the sound: click the page once, then play again.', true));
  }

  tick(dt) {
    // the sky dome: visible only from inside
    for (const m of this.skyMeshes || []) m.visible = m.userData.skyBox.containsPoint(this.vp.camera.position);
    if (this.camMode()) this.placeCamera();
    if (!this.playing || !this.cut) return;
    let f = this.frame + dt * this.cut.fps * +$('c-speed').value;
    // while the sound plays it is the clock (the browser's audio clock and the frame timer drift apart)
    const a = this.audio;
    if (this.sound && !a.paused && !a.ended && a.currentTime > 0) {
      const af = a.currentTime * this.cut.fps;
      if (Math.abs(af - f) > 2) f = af;
    }
    if (f >= this.cut.frames - 1) {
      if ($('c-loop').checked) { this.seek(0); this.syncAudio(); return; }
      f = this.cut.frames - 1; this.setPlaying(false);
    }
    this.frame = Math.max(0, Math.min(f, this.cut.frames - 1));
    this.update();
  }

  // a jump made by the user (scrub, shot list, keys): the sound follows
  seek(f) {
    if (!this.cut) return;
    this.frame = Math.max(0, Math.min(f, this.cut.frames - 1));
    this.update();
    this.syncAudio();
  }

  jumpShot(d) {
    if (!this.cut) return;
    const s = this.cut.shots, i = s.indexOf(this.cut.shotAt(this.frame));
    const j = Math.max(0, Math.min(s.length - 1, i + d));
    if (s[j]) { this.setPlaying(false); this.seek(s[j].from); }
  }

  update() {
    const cut = this.cut;
    if (!cut) return;
    const f = this.frame;
    // characters
    for (const r of this.chars) {
      if (!r.group) continue;
      const on = f >= r.c.from && f < r.c.to;
      r.group.visible = on && $('c-chars').checked;
      if (!on) continue;
      const rp = blockPose(r.c.root, f, 0, true);
      const root = rp ? poseMatrix(M4, rp, false) : r.c.matrix;
      const sk = r.posed ? r.c.skeleton : null;
      const vals = sk ? sk.pose(Math.max(0, Math.min(f - sk.start, sk.sourceFrames - 1))) : null;
      skinMeshes(r.model, r.meshes, poseBones(r.model, vals, 9, vals ? r.nPose : 0, { root, relative: true }));
    }
    // set pieces
    for (const r of this.objs) {
      if (!r.group) continue;
      r.group.visible = objectVisible(r.o, f) && $('c-objs').checked;
      let M = r.M0;
      const p = r.o.block ? blockPose(r.o.block, f, 0, true) : null;
      if (p) {
        // rotation and scale are absolute; translation is an offset from the object's stored position
        const m0 = r.M0, sc = [0, 1, 2].map(i => Math.hypot(m0[i * 4], m0[i * 4 + 1], m0[i * 4 + 2]));
        M = M4.compose([m0[12] + p[0], m0[13] + p[1], m0[14] - p[2]], [-p[3], -p[4], p[5]], [p[6] * sc[0], p[7] * sc[1], p[8] * sc[2]]);
      }
      r.group.matrix.fromArray(M4.mul(r.inv0, M));
      r.group.matrixWorldNeedsUpdate = true;
    }
    if (this.camMode()) this.placeCamera(); else this.placeCamMarker();
    this.renderTime();
  }

  // the cutscene camera's game-space matrix at the current frame, or null
  cameraMatrix() {
    const cut = this.cut, shot = cut?.shotAt(this.frame);
    if (!shot || shot.camera == null || !cut.cameraBlock) return null;
    const p = blockPose(cut.cameraBlock, this.frame, cut.cameras[shot.camera].node, true);
    return p ? poseMatrix(M4, p, false) : cut.cameras[shot.camera].matrix;
  }

  placeCamera() {
    const W = this.cameraMatrix();
    const cam = this.vp.camera;
    const fov = +$('c-fov').value;
    if (cam.fov !== fov) { cam.fov = fov; cam.updateProjectionMatrix(); }
    if (cam.near !== 0.05) { cam.near = 0.05; cam.far = 30000; cam.updateProjectionMatrix(); }
    if (this.pathGroup) this.camMarker.visible = false;
    if (!W) return;
    // game space is mirrored in Z on screen (see Viewport.root)
    const eye = new THREE.Vector3(W[12], W[13], -W[14]);
    const fwd = new THREE.Vector3(W[8], W[9], -W[10]).normalize();
    cam.up.set(W[4], W[5], -W[6]).normalize();
    cam.position.copy(eye);
    this.vp.controls.target.copy(eye).addScaledVector(fwd, 10);
    cam.lookAt(this.vp.controls.target);
  }

  placeCamMarker() {
    if (!this.camMarker) return;
    const W = this.cameraMatrix();
    this.camMarker.visible = !!W && $('c-paths').checked;
    if (W) { this.camMarker.matrix.fromArray(W); this.camMarker.matrixWorldNeedsUpdate = true; }
  }

  applyCameraMode() {
    const on = this.camMode();
    this.vp.controls.enabled = !on;
    if (!on) {
      this.vp.camera.up.set(0, 1, 0);
      const t = this.vp.controls.target;
      this.vp.camera.fov = 45; this.vp.camera.updateProjectionMatrix();
      if (!t || !isFinite(t.x)) this.frameAll();
    }
    $('c-bars').disabled = !on;
    this.applyToggles();
  }

  applyToggles() {
    if (this.levelGroup) this.levelGroup.visible = $('c-level').checked;
    if (this.objGroup) this.objGroup.visible = $('c-level').checked;
    if (this.pathGroup) this.pathGroup.visible = $('c-paths').checked && !this.camMode();
    $('c-letterbox').classList.toggle('hidden', !($('c-bars').checked && this.camMode()));
    this.update();
  }

  frameAll() {
    const box = new THREE.Box3();
    // world space (the root mirrors Z, and the stored tz is already mirrored: game z = -tz, world z = tz)
    for (const r of this.chars) if (r.group) { const p = blockPose(r.c.root, r.c.from, 0, true); if (p) box.expandByPoint(new THREE.Vector3(p[0], p[1], p[2])); }
    const b = this.cut?.cameraBlock;
    if (b) for (const c of this.cut.cameras) { const p = blockPose(b, b.start, c.node, true); if (p) box.expandByPoint(new THREE.Vector3(p[0], p[1], p[2])); }
    // set pieces (door and menu animations have no cameras or characters): their stored positions, game -> world
    if (box.isEmpty()) for (const r of this.objs) if (r.group) box.expandByPoint(new THREE.Vector3(r.M0[12], r.M0[13], -r.M0[14]));
    if (box.isEmpty() && this.playBox) box.copy(this.playBox);
    if (box.isEmpty()) return;
    box.expandByScalar(5);
    this.vp.root.updateMatrixWorld();
    this.vp.frameBox(box, 1.2);
  }

  // the whole cutscene for Blender: characters, the cut camera, set pieces and the level around them
  async exportGLB() {
    if (!this.cut) { status('Open a cutscene first.', true); return; }
    const was = this.frame, playing = this.playing;
    this.setPlaying(false);
    status(`Exporting ${this.entry.name}…`);
    await new Promise(r => setTimeout(r, 0));
    const { exportCutsceneGLB } = await import('./blender_export.js');
    try {
      const glb = await exportCutsceneGLB(this, { radius: +$('c-glbrad').value, fov: +$('c-fov').value });
      download(new Blob([glb], { type: 'model/gltf-binary' }), `${this.entry.name}.glb`);
      status(`Exported ${this.entry.name}.glb (${(glb.byteLength / 1048576).toFixed(1)} MB, ${this.cut.frames} frames at ${this.cut.fps} fps). In Blender set the scene to ${this.cut.fps} fps.`);
    } finally { this.seek(was); this.setPlaying(playing); }
  }

  // ------------------------------------------------------------ panels
  renderTime() {
    const cut = this.cut, f = this.frame, s = cut.shotAt(f);
    $('c-scrub').value = f;
    $('c-time').textContent = `frame ${Math.floor(f).toString().padStart(3)} / ${cut.frames - 1} · ${(f / cut.fps).toFixed(2)} s · shot ${cut.shots.indexOf(s) + 1}/${cut.shots.length}${s?.camera != null ? ` (camera ${s.camera})` : ''}`;
    for (const el of $('c-shots').querySelectorAll('[data-from]')) el.classList.toggle('on', +el.dataset.from === s?.from);
  }

  renderMarks() {
    const cut = this.cut, n = Math.max(cut.frames - 1, 1);
    $('c-marks').innerHTML = cut.shots.map((s, i) => `<div class="mark" style="left:${(s.from / n) * 100}%" title="shot ${i + 1}: frame ${s.from}"></div>`).join('');
  }

  renderInfo() {
    const cut = this.cut, cfg = this.cfg;
    const found = this.objs.length, listed = cut.objects.length;
    $('c-info').innerHTML = `<table class="kv">
      <tr><td>Cutscene</td><td>${esc(this.entry.name)}</td></tr>
      <tr><td>File</td><td class="mono">${esc(this.entry.cu2)}</td></tr>
      <tr><td>Length</td><td>${cut.frames} frames @ ${cut.fps} fps = ${cut.seconds.toFixed(1)} s</td></tr>
      <tr><td>Version</td><td>${cut.version}</td></tr>
      <tr><td>Level</td><td class="mono">${esc(this.scenePath || '(none)')}</td></tr>
      <tr><td>Sound</td><td>${this.sound ? `<span class="mono">${esc(this.sound.source)}</span> (${this.sound.seconds.toFixed(1)} s)` : '<span class="hint">none</span>'}</td></tr>
      <tr><td>Set pieces</td><td>${listed} listed · ${found} move or switch here${this.objMissing.length ? ` · <span class="warn" title="${esc([...new Set(this.objMissing)].join(', '))}">${this.objMissing.length} not in this scene</span>` : ''}</td></tr>
    </table>`;
    $('c-shots').innerHTML = cut.shots.map((s, i) => `<div class="item" data-from="${s.from}">Shot ${i + 1}<span class="sub">frames ${s.from}–${s.to - 1} · ${s.camera == null ? 'no camera' : 'camera ' + s.camera}</span></div>`).join('') || '<div class="hint">No cameras.</div>';
    $('c-charlist').innerHTML = this.chars.map(r => `<div class="item" data-from="${r.c.from}" title="${esc(r.path || '')}">${esc(r.c.name)}<span class="sub">${r.c.from}–${r.c.to - 1}${r.model ? '' : ' · <span class="warn">not shown</span>'}</span>${r.note ? `<div class="hint ${r.model ? '' : 'warn'}" style="white-space:normal">${esc(r.note)}</div>` : ''}</div>`).join('') || '<div class="hint">No characters.</div>';
    const notes = [...this.warnings, `Field of view isn't stored in the files: ${DEFAULT_FOV}° is assumed (slider).`,
      'Not shown: particles and effects, lights.'];
    $('c-notes').innerHTML = notes.map(n => `<div>${esc(n)}</div>`).join('');
  }
}
