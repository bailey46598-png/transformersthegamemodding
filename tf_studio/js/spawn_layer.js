// The level tab's character spawns. Characters aren't placed in a level file: the mission scripts
// (LEVELS\<level>\AI\*.SCP) start them with lines like
//   CreateModule "#Creature" "#CreatureWaveA" "#Spline=A2C2SpawnA" "#count=4" "#maxalive=4" "#Type=DroneDefault" …
// which spawn `count` of that character (at most `maxalive` at once) along the named spline in SPLINE.DAT.
// This layer lists every such line, shows the character at its spline, edits Type / count / maxalive / Spline,
// turns a line on or off (a leading ';'), duplicates it, and writes the script back. Where a spawn appears is
// its spline's points: select the spline to move them.
import * as THREE from 'three';
import { api, $, esc, fmt, joinPath } from './common.js';
import { loadCharacter, loadModel, buildMeshes, poseBones, skinMeshes, restPose } from './rig.js';

const CREATE = /^(\s*)(;?)(\s*)CreateModule\s+"#Creature"\s+(.*)$/i;

function parseLine(text) {
  const m = CREATE.exec(text);
  if (!m) return null;
  const args = [...m[4].matchAll(/"([^"]*)"/g)].map(x => x[1]);
  const get = k => { const a = args.find(x => x.toLowerCase().startsWith(`#${k.toLowerCase()}=`)); return a ? a.slice(a.indexOf('=') + 1) : ''; };
  return { off: !!m[2], name: (args[0] || '').replace(/^#/, ''), type: get('Type'), spline: get('Spline'), count: get('count'), maxalive: get('maxalive'), args };
}

// replace (or add) "#key=value" in a CreateModule line, keeping the key's spelling and everything else as written
function setArg(text, key, value) {
  const re = new RegExp(`"#${key}=[^"]*"`, 'i');
  if (re.test(text)) return text.replace(re, m => `"${m.slice(1, m.indexOf('=') + 1)}${value}"`);
  return text.replace(/\s*$/, '') + ` "#${key}=${value}"`;
}

export class SpawnLayer {
  constructor(view) { this.view = view; this.spawns = []; this.files = new Map(); this.group = null; this.models = new Map(); }
  get root() { return this.view.vp.root; }

  async load(dir) {
    this.dispose();
    this.dir = dir;
    let L;
    try { L = await api.list(joinPath(dir, 'AI')); } catch { return; }
    for (const f of L.files.filter(f => /\.scp$/i.test(f.name))) {
      const path = joinPath(dir, 'AI', f.name), text = await api.text(path);
      const eol = text.includes('\r\n') ? '\r\n' : '\n', lines = text.split(/\r?\n/);
      this.files.set(path, { lines, eol, dirty: false });
      lines.forEach((t, li) => { const s = parseLine(t); if (s) this.spawns.push({ path, line: li, ...s }); });
    }
    // the level's characters (CREATURES.CFG INCLUDEs)
    this.types = [];
    try {
      const cfg = await api.text(joinPath(dir, 'CREATURES.CFG'));
      for (const m of cfg.matchAll(/^\s*INCLUDE\s+\S*?([^\\/\s]+)\.cfg/gim)) this.types.push(m[1]);
    } catch {}
    this.build();
  }

  dispose() {
    if (this.group) { this.root.remove(this.group); this.group.traverse(x => { x.geometry?.dispose(); if (x.isCSS2DObject) x.element.remove(); }); }
    this.group = null; this.spawns = []; this.files = new Map(); this.box = null;
  }

  splineOf(s) { return this.view.splines?.list.find(x => x.name.toLowerCase() === (s.spline || '').toLowerCase()) || null; }
  where(s) { const sp = this.splineOf(s); return sp?.points.length ? new THREE.Vector3(...sp.points[0]) : null; }

  // a marker per spawn at the first point of its spline, plus the character's model (bind pose) when it loads
  build() {
    if (this.group) { this.root.remove(this.group); this.group.traverse(x => x.geometry?.dispose()); }
    this.group = new THREE.Group(); this.group.name = 'spawns';
    this.pickables = [];
    this.spawns.forEach((s, i) => {
      const at = this.where(s);
      if (!at) return;
      const g = new THREE.Group(); g.position.copy(at);
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 0.15, 24), new THREE.MeshBasicMaterial({ color: s.off ? 0x777777 : 0xd04ad0, transparent: true, opacity: 0.8 }));
      ring.userData.sel = { kind: 'spawn', i };
      g.add(ring); this.pickables.push(ring);
      g.userData.spawn = i;
      this.group.add(g);
      this.attachModel(s, g, i);
    });
    this.root.add(this.group);
    this.setVisible($('l-spawns').checked);
  }

  async attachModel(s, g, i) {
    const mv = window.tfstudio?.model;
    if (!mv?.charByName || !s.type) return;
    const key = s.type.toLowerCase();
    if (!this.models.has(key)) this.models.set(key, (async () => {
      const e = mv.charByName.get(key); if (!e) return null;
      try {
        const { modelPath, parents } = await loadCharacter(e, mv.charByName);
        const model = await loadModel(modelPath, parents);
        model.rest = await restPose(model);
        return model;
      } catch { return null; }
    })());
    const model = await this.models.get(key);
    if (!model || g.parent !== this.group) return;
    const { group, meshes } = buildMeshes(model);
    skinMeshes(model, meshes, model.rest || poseBones(model, null));
    for (const m of meshes) { m.material = m.material.clone(); m.material.transparent = true; m.material.opacity = s.off ? 0.35 : 0.85; m.userData.sel = { kind: 'spawn', i }; this.pickables.push(m); }
    g.add(group);
  }

  setVisible(v) { if (this.group) this.group.visible = v; }

  pick(ray) {
    if (!this.group?.visible) return null;
    const h = ray.intersectObjects(this.pickables, false)[0];
    return h ? { hit: h, i: h.object.userData.sel.i } : null;
  }

  // ------------------------------------------------------------ edits
  setLine(i, text) {
    const s = this.spawns[i], f = this.files.get(s.path);
    f.lines[s.line] = text; f.dirty = true;
    Object.assign(s, parseLine(text));
  }
  set(i, key, value) {
    const s = this.spawns[i], f = this.files.get(s.path);
    if (key === 'off') {
      const t = f.lines[s.line];
      this.setLine(i, value ? t.replace(/^(\s*)/, '$1;') : t.replace(/^(\s*);\s*/, '$1'));
    } else this.setLine(i, setArg(f.lines[s.line], key, value));
    this.build();
  }
  // a second copy of the line right after it, under a new module name
  duplicate(i) {
    const s = this.spawns[i], f = this.files.get(s.path);
    const taken = new Set(this.spawns.map(x => x.name.toLowerCase()));
    let n = 2, name;
    do name = `${s.name}${n++}`; while (taken.has(name.toLowerCase()));
    const text = f.lines[s.line].replace(`"#${s.name}"`, `"#${name}"`);
    f.lines.splice(s.line + 1, 0, text); f.dirty = true;
    for (const x of this.spawns) if (x.path === s.path && x.line > s.line) x.line++;
    this.spawns.splice(i + 1, 0, { path: s.path, line: s.line + 1, ...parseLine(text) });
    this.build();
    return i + 1;
  }
  dirtyFiles() { return [...this.files].filter(([, f]) => f.dirty).map(([p]) => p); }
  text(path) { const f = this.files.get(path); return f.lines.join(f.eol); }
  saved(path) { this.files.get(path).dirty = false; }

  panel(i) {
    const s = this.spawns[i], sp = this.splineOf(s);
    const types = [...new Set([...this.types, s.type].filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const splines = (this.view.splines?.list || []).map(x => x.name);
    return `<table class="kv">
      <tr><td>Spawn</td><td class="mono">${esc(s.name)}${s.off ? ' <span class="tag">off</span>' : ''}</td></tr>
      <tr><td>Script</td><td class="mono">${esc(s.path.split('/').pop())} line ${s.line + 1}</td></tr>
      <tr><td>Where</td><td>${sp ? `spline <span class="mono">${esc(sp.name)}</span> (${sp.points.length} points)` : s.spline ? `<span class="warn">spline "${esc(s.spline)}" not in SPLINE.DAT</span>` : '<span class="hint">no #Spline: the script places it some other way (not shown in the view)</span>'}</td></tr>
    </table>
    <div class="fields" style="margin-top:6px">
      <label>Character</label><select id="ls-sptype">${types.map(t => `<option ${t === s.type ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
      <label>Count</label><input type="text" id="ls-spcount" value="${esc(s.count)}" title="How many in total (3000 = keep coming)">
      <label>Max alive</label><input type="text" id="ls-spmax" value="${esc(s.maxalive)}">
      <label>Spline</label><select id="ls-spspline">${[...new Set([s.spline, ...splines])].map(n => `<option ${n === s.spline ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
    </div>
    <label style="display:block;margin-top:6px"><input type="checkbox" id="ls-spon" ${s.off ? '' : 'checked'}> Active (unticked = the line is commented out)</label>
    <div class="row" style="margin-top:6px"><button class="b" id="ls-spfocus">Focus</button><button class="b" id="ls-spedit" ${sp ? '' : 'disabled'}>Move it (edit spline)</button><button class="b" id="ls-spdup">Duplicate</button></div>
    <p class="hint">The script runs this line in one of its mission states; a duplicate runs in the same state. Characters must be in the level's CREATURES.CFG to spawn.</p>
    <pre class="mono hint" style="white-space:pre-wrap;font-size:11px">${esc(this.files.get(s.path).lines[s.line].trim())}</pre>`;
  }
}
