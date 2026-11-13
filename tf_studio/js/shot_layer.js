// Script cutscenes: the level scripts' #SplineCamera shots, previewed and edited in the level view.
//
// A mission script plays an in-game camera move with
//   CreateModule "#SplineCamera" "#SplineCamera" "#SetPosition=<spline>" "#SetFocus=<spline>" ["#CreatureMove=<spline>"] "#SetTime=<s>"
// The camera travels along the SetPosition spline while looking at the matching point of the SetFocus spline, over
// SetTime seconds. Shots follow each other through the script's states (a state waits for
// `SplineCamera GetPercentageComplete == 1.0` and goes to the next), so this layer follows those links to put shots
// into sequences. The actors are the #Creature lines in the state that leads into a sequence's first shot (with
// #FollowSpline: they spawn along #Spline and drive the route).
//
// How the game moves along a spline isn't known from the files: the preview offers smooth (Catmull-Rom by arc length)
// or straight lines, a field of view, and an actor speed. Compare with a recording and set them (see the README).
//
// Editing: a shot's time is written back into its CreateModule line; keys (camera point k + focus point k) are set
// from the current view and saved with SPLINE.DAT.
import * as THREE from 'three';
import { $, esc, fmt, status } from './common.js';
import { loadCharacter, loadModel, buildMeshes, poseBones, skinMeshes, restPose } from './rig.js';

const SPLINECAM = /CreateModule\s+"#SplineCamera"/i;
const STATE = /^\s*state\s+(\w+)/i;
const args = text => [...text.matchAll(/"#(\w+)=([^"]*)"/g)].reduce((o, m) => (o[m[1].toLowerCase()] = m[2], o), {});

// ------------------------------------------------------------ path sampling
// Dense samples of a spline (smooth or straight) with cumulative length, to read a point at a fraction of the length.
export function pathOf(points, smooth = true) {
  const P = points.map(p => new THREE.Vector3(...p));
  let S;
  if (P.length < 2) S = P.length ? [P[0].clone(), P[0].clone()] : [new THREE.Vector3(), new THREE.Vector3()];
  else if (smooth && P.length > 2) S = new THREE.CatmullRomCurve3(P, false, 'centripetal').getSpacedPoints(Math.max(64, P.length * 32));
  else S = P;
  const L = [0];
  for (let i = 1; i < S.length; i++) L.push(L[i - 1] + S[i].distanceTo(S[i - 1]));
  return { S, L, length: L[L.length - 1] };
}
// point (and direction) at distance d along a path
export function atDistance(path, d, out = new THREE.Vector3(), dir = null) {
  const { S, L } = path;
  d = Math.max(0, Math.min(d, path.length));
  let i = 1;
  while (i < L.length - 1 && L[i] < d) i++;
  const seg = L[i] - L[i - 1] || 1, k = (d - L[i - 1]) / seg;
  out.lerpVectors(S[i - 1], S[i], Math.max(0, Math.min(1, k)));
  if (dir) dir.subVectors(S[i], S[i - 1]).normalize();
  return out;
}

export class ShotLayer {
  constructor(view) {
    this.view = view;
    this.shots = []; this.seqs = []; this.seq = -1; this.t = 0; this.playing = false;
    this.cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.3, 20000); // the shot camera, in world space
    this.helper = new THREE.CameraHelper(this.cam);
    this.helper.visible = false;
    this.view.vp.scene.add(this.helper);
    this.actors = []; this.models = new Map();
    this.view.vp.onFrame.push(dt => this.frame(dt));
    // FOV 50 matched the game in the Airbase test recordings; accel ~12 units/s² measured there (AI car from rest, tests 2-3);
    // top speed 30 is assumed
    // Measured with a DebugTrainer recording (Airbase 010227): the game's cutscene cameras use a projection 43° tall at
    // 4:3, stretched to the screen, and move along straight lines between spline points (camera error 0.2 units
    // straight vs 1.35 smooth).
    // The game also runs a shot camera over 97 % of its SetTime (3.0 -> 2.91 s, 4.2 -> 4.08 s; error 0.03 units).
    this.opts = { fov: 43, aspect: 4 / 3, smooth: false, camScale: 0.97, speed: 30, accel: 13, look: true };
    try { Object.assign(this.opts, JSON.parse(localStorage.getItem('tfstudio.shots') || '{}')); } catch { /* defaults */ }
  }
  get vp() { return this.view.vp; }
  saveOpts() { try { localStorage.setItem('tfstudio.shots', JSON.stringify(this.opts)); } catch { /* not kept */ } }

  // ------------------------------------------------------------ reading the scripts
  // Uses the spawn layer's copy of the AI scripts, so both edit the same lines and save together.
  load() {
    this.stop();
    this.shots = []; this.states = new Map();
    for (const [path, f] of this.view.spawnLayer.files) {
      let cur = null;
      f.lines.forEach((text, line) => {
        const m = STATE.exec(text);
        if (m) { cur = { name: m[1], path, line, next: [], creatures: [], shot: null }; this.states.set(m[1].toLowerCase(), cur); return; }
        if (!cur || /^\s*;/.test(text)) return;
        for (const g of text.matchAll(/goto\s+(\w+)/gi)) cur.next.push({ to: g[1], cond: text });
        // a shot left before its camera completes ("… GetPercentageComplete" > 0.97 goto …) ends there
        const pc = /GetPercentageComplete"\s*(>=?|==)\s*([\d.]+)/i.exec(text); if (pc) cur.cut = Math.min(cur.cut ?? 1, +pc[2]);
        // a shot left when an actor finishes its route (if module "GCBee Complete" == 1.0 goto …)
        const wc = /module\s+"(\w+)\s+Complete"\s*==\s*1/i.exec(text); if (wc && !cur.wait) cur.wait = wc[1];
        // a new route for an actor (SendToModule "#GCBee" "#DirectSpline=…")
        const sd = /SendToModule\s+"#(\w+)".*"#(?:DirectSpline|FollowSpline)=([^"]+)"/i.exec(text); if (sd) (cur.sends ||= []).push({ tag: sd[1], spline: sd[2] });
        const ss = /SetState\s+"?(\w+)"?/i.exec(text); if (ss) cur.next.push({ to: ss[1], cond: '' });
        if (SPLINECAM.test(text)) {
          const a = args(text);
          const shot = { path, line, state: cur.name, pos: a.setposition || '', focus: a.setfocus || '', move: a.creaturemove || '', time: parseFloat(a.settime) || 0, pause: !!a.pausegame };
          cur.shot = shot; this.shots.push(shot);
        }
        if (/CreateModule\s+"#(Creature|Goto)"/i.test(text)) cur.creatures.push(line);
      });
    }
    for (const st of this.states.values()) if (st.shot) Object.assign(st.shot, { cutAt: Math.max(0.05, Math.min(1, st.cut ?? 1)), waitFor: st.wait || '', sends: st.sends || [] });
    this.buildSeqs();
  }

  // Shots linked state to state (through states that only pass on, like a "Cut" state) form one sequence.
  buildSeqs() {
    const st = n => this.states.get((n || '').toLowerCase());
    const nextShot = s => {
      const seen = new Set();
      let frontier = s.next.filter(x => /PercentageComplete/i.test(x.cond) || !x.cond).map(x => x.to);
      for (let hop = 0; hop < 4 && frontier.length; hop++) {
        const nf = [];
        for (const n of frontier) {
          const x = st(n); if (!x || seen.has(x)) continue; seen.add(x);
          if (x.shot) return x;
          nf.push(...x.next.filter(y => !y.cond).map(y => y.to)); // a pass-on state: its SetState
        }
        frontier = nf;
      }
      return null;
    };
    const into = new Set();
    for (const s of this.states.values()) if (s.shot) { const n = nextShot(s); if (n) { s.after = n; into.add(n); } }
    this.seqs = [];
    for (const s of this.states.values()) {
      if (!s.shot || into.has(s)) continue;
      const list = []; let x = s;
      while (x && !list.includes(x.shot)) { list.push(x.shot); x = x.after; }
      // actors: creature lines of the state(s) that go straight into the first shot; the lead-in is its timer
      const lead = { time: 0, creatures: [] };
      for (const p of this.states.values()) {
        const link = p.next.find(y => y.to.toLowerCase() === s.name.toLowerCase());
        if (!link || p.shot) continue;
        const tm = /timer\s*>\s*([\d.]+)/i.exec(link.cond); if (tm) lead.time = Math.max(lead.time, +tm[1]);
        lead.creatures.push(...p.creatures.map(line => ({ path: p.path, line })));
      }
      this.seqs.push({ name: s.name.replace(/_?(Wide|Shot\w*|Camera\w*)$/i, '') || s.name, shots: list, lead, path: s.path });
    }
    this.seqs.sort((a, b) => a.path.localeCompare(b.path) || a.shots[0].line - b.shots[0].line);
  }

  // ------------------------------------------------------------ geometry
  splineByName(n) { return this.view.splines?.list.find(x => x.name.toLowerCase() === (n || '').toLowerCase()) || null; }
  get cur() { return this.seqs[this.seq] || null; }
  // A shot lasts its SetTime, or until its exit condition (cutAt), or until the actor it waits for finishes its
  // route (preview motion), whichever comes first.
  lens(seq = this.cur) {
    let t = seq.lead.time;
    return seq.shots.map(s => {
      let len = this.camTime(s) * (s.cutAt ?? 1);
      const act = seq === this.cur && s.waitFor ? this.actors.find(a => a.tag?.toLowerCase() === s.waitFor.toLowerCase()) : null;
      if (act?.run1) { const ta = this.arrival(act); if (ta != null) len = Math.min(len, Math.max(0.05, ta - t)); }
      t += len; return len;
    });
  }
  camTime(s) { return s.time * (this.opts.camScale || 1); } // how long the game's camera takes over the shot's path
  shotLen(s, seq = this.cur) { const k = seq.shots.indexOf(s); return k < 0 ? s.time * (s.cutAt ?? 1) : this.lens(seq)[k]; }
  duration(seq = this.cur) { return seq ? seq.lead.time + this.lens(seq).reduce((a, b) => a + b, 0) : 0; }
  // which shot is on at sequence time t, and how far into it (0..1). During the lead-in: shot -1.
  shotAt(t, seq = this.cur) {
    let rest = t - seq.lead.time;
    if (rest < 0) return { k: -1, u: 0 };
    const L = this.lens(seq);
    for (let k = 0; k < seq.shots.length; k++) {
      const T = this.camTime(seq.shots[k]), len = L[k];
      if (rest <= len || k === seq.shots.length - 1) return { k, u: T > 0 ? Math.min(1, rest / T) : 1 };
      rest -= len;
    }
  }
  // camera position and focus (game coords) for a shot at fraction u
  camAt(shot, u) {
    const P = this.splineByName(shot.pos), F = this.splineByName(shot.focus);
    if (!P?.points.length) return null;
    const pp = pathOf(P.points, this.opts.smooth), fp = F?.points.length ? pathOf(F.points, this.opts.smooth) : null;
    const pos = atDistance(pp, u * pp.length), foc = fp ? atDistance(fp, u * fp.length) : pos.clone().add(new THREE.Vector3(0, 0, 1));
    return { pos, foc };
  }

  // ------------------------------------------------------------ actors
  buildActors() {
    this.clearActors();
    const seq = this.cur; if (!seq) return;
    this.group = new THREE.Group(); this.group.name = 'shot actors';
    for (const { path, line } of seq.lead.creatures) {
      const text = this.view.spawnLayer.files.get(path)?.lines[line] || '';
      if (/^\s*;/.test(text)) continue;
      // #Creature: #Spline (spawn), #FollowSpline (route), #count. #Goto (one creature): #SpawnSpline, #DirectSpline, #Speed.
      const a = args(text), sp = this.splineByName(a.spline || a.spawnspline), route = this.splineByName(a.followspline || a.directspline);
      if (!sp?.points.length) continue;
      const n = /"#Goto"/i.test(text) ? 1 : Math.max(1, Math.min(parseInt(a.count) || 1, parseInt(a.maxalive) || 99, 8));
      // #Speed is mph (Airbase test 4: #Speed=40 drove ~14-18 units/s); 0 = the panel's actor speed
      const speed = (parseFloat(a.speed) || 0) * 0.447;
      // a spawn spline of point pairs (a point, then the point it faces) holds one spawn per pair
      const pairs = sp.points.length % 2 === 0 && sp.points.length >= 2;
      for (let j = 0; j < n; j++) {
        const at = pairs ? sp.points[(2 * j) % sp.points.length] : sp.points[j % sp.points.length];
        const face = pairs ? sp.points[(2 * j + 1) % sp.points.length] : null;
        // drive: from the spawn point to the route's first point, then along the route
        const pts = [at, ...(route?.points || [])];
        const tag = (/CreateModule\s+"#\w+"\s+"#(\w+)"/i.exec(text) || [])[1] || '';
        const run1 = route ? pathOf(pts, false).length - (parseFloat(a.range) || 0) : 0; // Complete within #Range of the end
        for (const sh of seq.shots) for (const snd of sh.sends || []) if (snd.tag.toLowerCase() === tag.toLowerCase()) {
          const r = this.splineByName(snd.spline); if (r) pts.push(...r.points);
        }
        const g = new THREE.Group();
        const box = new THREE.Mesh(new THREE.BoxGeometry(2, 1.4, 4.4), new THREE.MeshBasicMaterial({ color: /bumble/i.test(a.type) ? 0xf0c020 : 0x7a8a5a, transparent: true, opacity: 0.5 }));
        box.position.y = 0.7; g.add(box);
        this.group.add(g);
        const act = { type: a.type || '?', tag, run1, g, box, speed, path: pathOf(pts, false), face: face ? new THREE.Vector3(...face) : null, start: new THREE.Vector3(...at), moving: !!route };
        this.actors.push(act);
        this.attachModel(act);
      }
    }
    this.view.vp.root.add(this.group);
  }
  clearActors() {
    if (this.group) { this.view.vp.root.remove(this.group); this.group.traverse(x => x.geometry?.dispose()); }
    this.group = null; this.actors = [];
  }
  // the vehicle form of the character (…Car / …Veh), else the character itself
  async attachModel(act) {
    const mv = window.tfstudio?.model; if (!mv?.charByName) return;
    const base = act.type.toLowerCase(), key = ['car', 'veh', ''].map(s => base + s).find(k => mv.charByName.has(k));
    if (!key) return;
    if (!this.models.has(key)) this.models.set(key, (async () => {
      try {
        const { modelPath, parents } = await loadCharacter(mv.charByName.get(key), mv.charByName);
        const model = await loadModel(modelPath, parents); model.rest = await restPose(model); return model;
      } catch { return null; }
    })());
    const model = await this.models.get(key);
    if (!model || !this.actors.includes(act)) return;
    const { group, meshes } = buildMeshes(model);
    skinMeshes(model, meshes, model.rest || poseBones(model, null));
    act.g.add(group); act.box.visible = false;
  }
  // actors at time t (seconds since the sequence started): they accelerate to the set speed along their drive
  // how far an actor has driven at sequence time t: from rest after its delay, accelerating to its top speed.
  // A fit to a game recording (rec_layer.js) wins over the script's #Speed and the panel's values.
  actorDist(act, t) {
    if (!act.moving) return 0;
    const f = act.fit, a = f?.accel ?? this.opts.accel, v = f?.speed ?? (act.speed || this.opts.speed), u = t - (f?.delay ?? 0);
    const tv = v / a;
    return u <= 0 ? 0 : u < tv ? 0.5 * a * u * u : 0.5 * v * tv + v * (u - tv);
  }
  // when an actor finishes its first route (reports Complete), in sequence time
  arrival(act) {
    for (let t = 0; t < 60; t += 0.01) if (this.actorDist(act, t) >= act.run1) return t;
    return null;
  }
  placeActors(t) {
    const dir = new THREE.Vector3();
    for (const act of this.actors) {
      const d = this.actorDist(act, t);
      act.g.visible = true;
      atDistance(act.path, d, act.g.position, dir);
      if (d <= 0 && act.face) dir.subVectors(act.face, act.start).normalize();
      if (dir.lengthSq() > 0) act.g.rotation.y = Math.atan2(dir.x, dir.z); // models face +Z (game space)
    }
    this.rec?.applyActors(t); // or their recorded motion
  }

  // ------------------------------------------------------------ playback
  select(i) { this.stop(); this.seq = i; this.t = 0; this.buildActors(); this.rec?.onSequence(); this.show(); this.renderPanel(); }
  play() {
    if (!this.cur) return;
    if (this.t >= this.duration() - 1e-3) this.t = 0;
    this.playing = true; this.view.nav.anim = null; this.renderTransport();
  }
  pause() { this.playing = false; this.renderTransport(); }
  stop() { this.playing = false; this.helper.visible = false; this.view.vp.controls.enabled = true; }
  seek(t) { this.t = Math.max(0, Math.min(t, this.duration())); this.show(); this.renderTransport(); }
  frame(dt) {
    if (!this.cur || $('tab-level').classList.contains('hidden')) return;
    if (this.playing) {
      this.t += dt;
      if (this.t >= this.duration()) { this.t = this.duration(); this.playing = false; this.renderTransport(); }
      this.show(); this.renderTime();
    } else if (this.opts.look && this.locked) this.applyCam(); // hold the shot view while scrubbing
  }
  // set the shot camera (and the view, when looking through it) for the current time
  show() {
    const seq = this.cur; if (!seq) return;
    const { k, u } = this.shotAt(this.t);
    this.placeActors(this.t);
    const c = this.camAt(seq.shots[Math.max(k, 0)], Math.max(u, 0));
    if (!c) return;
    const W = v => this.view.toWorld(v);
    this.cam.fov = this.opts.fov; this.cam.aspect = this.opts.aspect || 16 / 9; this.cam.updateProjectionMatrix();
    this.cam.position.copy(W(c.pos)); this.cam.up.set(0, 1, 0); this.cam.lookAt(W(c.foc));
    this.camFoc = W(c.foc);
    // looking through the camera a game recording shows instead (rec_layer.js)
    const g = this.rec?.gameCam(this.t);
    if (g) { this.cam.position.copy(g.pos); this.cam.up.copy(g.up); this.cam.lookAt(g.target); this.camFoc = g.target; if (g.fov) { this.cam.fov = g.fov; if (g.aspect) this.cam.aspect = g.aspect; this.cam.updateProjectionMatrix(); } }
    // the projection's aspect, drawn stretched to the view like the game does (0 = the view's own aspect)
    this.stretch = !!(g?.aspect || this.opts.aspect);
    this.cam.updateMatrixWorld();
    this.helper.visible = !this.opts.look; this.helper.update();
    this.locked = this.opts.look;
    if (this.opts.look) this.applyCam();
  }
  // looking through the shot: only the level and the actors (markers, labels and spawn rings hidden)
  clean(on) {
    const v = this.view;
    if (v.markGroup) v.markGroup.visible = !on;
    if (v.spawnLayer.group) v.spawnLayer.group.visible = !on && $('l-spawns').checked;
    this.vp.labels.domElement.style.visibility = on ? 'hidden' : '';
  }
  applyCam() {
    const vc = this.vp.camera, ctl = this.vp.controls;
    this.clean(true);
    this.view.nav.anim = null; ctl.enabled = false;
    vc.position.copy(this.cam.position); ctl.target.copy(this.camFoc);
    const asp = this.stretch ? this.cam.aspect : this.vp.host.clientWidth / Math.max(1, this.vp.host.clientHeight);
    if (vc.fov !== this.cam.fov || Math.abs(vc.aspect - asp) > 1e-4) { vc.fov = this.cam.fov; vc.aspect = asp; vc.updateProjectionMatrix(); }
    vc.up.copy(this.cam.up); vc.lookAt(this.camFoc);
  }
  release() {
    this.locked = false; this.vp.controls.enabled = true; this.clean(false); this.vp.camera.up.set(0, 1, 0);
    this.stretch = false;
    if (this.vp.camera.fov !== 45) { this.vp.camera.fov = 45; this.vp.camera.updateProjectionMatrix(); }
    this.vp.resize?.(); // the view's own aspect again
  }

  // ------------------------------------------------------------ editing
  // the key under the playhead: the camera point of the current shot nearest the current position
  keyAt() {
    const seq = this.cur; if (!seq) return null;
    const { k, u } = this.shotAt(this.t), shot = seq.shots[Math.max(k, 0)];
    const P = this.splineByName(shot.pos); if (!P) return null;
    return { shot, k: Math.round(Math.max(u, 0) * (P.points.length - 1)) };
  }
  // camera point and focus point `key` of a shot from the current free view (the focus keeps its distance)
  setKey(shot, key, add = false) {
    const P = this.splineByName(shot.pos), F = this.splineByName(shot.focus);
    if (!P || !F) return status('This shot\'s splines are not in SPLINE.DAT.', true);
    const vc = this.vp.camera, pos = this.view.toGame(vc.position);
    const dir = this.view.toGame(vc.position.clone().add(vc.getWorldDirection(new THREE.Vector3()))).sub(pos).normalize();
    const old = F.points[Math.min(key, F.points.length - 1)], dist = old ? Math.max(5, pos.distanceTo(new THREE.Vector3(...old))) : 40;
    const foc = pos.clone().addScaledVector(dir, dist);
    if (add) { P.points.splice(key, 0, pos.toArray()); F.points.splice(Math.min(key, F.points.length), 0, foc.toArray()); }
    else { P.points[key] = pos.toArray(); if (F.points.length === P.points.length) F.points[key] = foc.toArray(); else F.points[Math.min(key, F.points.length - 1)] = foc.toArray(); }
    this.splinesChanged(P, F);
  }
  deleteKey(shot, key) {
    const P = this.splineByName(shot.pos), F = this.splineByName(shot.focus);
    if (!P || P.points.length <= 2) return status('A shot needs at least two keys.', true);
    P.points.splice(key, 1); if (F && F.points.length > 2) F.points.splice(Math.min(key, F.points.length - 1), 1);
    this.splinesChanged(P, F);
  }
  splinesChanged(...S) {
    const L = this.view.splines.list;
    for (const s of S) if (s) this.view.updateSpline(L.indexOf(s));
    this.view.markDirty('splines'); this.buildActors(); this.show(); this.renderPanel();
  }
  setTime(shot, v) {
    const f = this.view.spawnLayer.files.get(shot.path);
    f.lines[shot.line] = f.lines[shot.line].replace(/"#SetTime=[^"]*"/i, `"#SetTime=${v}"`); f.dirty = true;
    shot.time = v; this.view.markDirty('spawns'); this.renderPanel();
  }

  // ------------------------------------------------------------ panel (right sidebar, "Script cutscenes")
  renderPanel() {
    const E = $('l-shots'); if (!E) return;
    if (!this.seqs.length) { E.innerHTML = '<span class="hint">No #SplineCamera shots in this level\'s scripts.</span>'; return; }
    const seq = this.cur, o = this.opts;
    E.innerHTML = `<select id="ls-seq" style="width:100%">${['<option value="-1">Pick a camera sequence…</option>', ...this.seqs.map((s, i) =>
      `<option value="${i}" ${i === this.seq ? 'selected' : ''}>${esc(s.name)} · ${s.shots.length} shot${s.shots.length > 1 ? 's' : ''} · ${fmt(this.duration(s), 1)} s</option>`)].join('')}</select>
      ${seq ? `<div class="row" style="margin-top:6px"><button class="b primary" id="ls-play">Play</button><button class="b" id="ls-rew">⏮</button>
        <input type="range" id="ls-scrub" min="0" max="${this.duration()}" step="0.01" value="${this.t}" style="flex:1"><span class="mono" id="ls-time"></span></div>
      <div class="row" style="margin-top:4px"><label><input type="checkbox" id="ls-look" ${o.look ? 'checked' : ''}> Look through the shot camera</label>${this.locked ? '<button class="b" id="ls-free">Free view</button>' : ''}</div>
      <div class="fields" style="margin-top:6px">
        <label title="Not stored in the game files: assumed, set to match a recording">Field of view°</label><input type="number" id="ls-fov" value="${o.fov}" step="1" min="10" max="120">
        <label title="The game's projection aspect, stretched to the screen (recorded: 4:3). Off: the view's own aspect">Aspect</label><select id="ls-aspect"><option value="1.3333" ${Math.abs((o.aspect || 0) - 4 / 3) < 1e-3 ? 'selected' : ''}>4:3 stretched (game)</option><option value="1.7778" ${Math.abs((o.aspect || 0) - 16 / 9) < 1e-3 ? 'selected' : ''}>16:9</option><option value="0" ${o.aspect ? '' : 'selected'}>View</option></select>
        <label title="How the game travels along the camera and focus splines (recorded: straight)">Paths</label><select id="ls-smooth"><option value="0" ${o.smooth ? '' : 'selected'}>Straight (game)</option><option value="1" ${o.smooth ? 'selected' : ''}>Smooth</option></select>
        <label title="Actors' top speed (units/s) when the script gives none (#Goto's #Speed is used: mph, x 0.447)">Actor speed</label><input type="number" id="ls-speed" value="${o.speed}" step="1">
        <label title="Actors' acceleration (units/s²)">Acceleration</label><input type="number" id="ls-accel" value="${o.accel}" step="1">
      </div>
      <table class="kv" style="margin-top:6px">${seq.lead.time ? `<tr><td>Lead-in</td><td>${fmt(seq.lead.time, 2)} s (actors start)</td></tr>` : ''}
        ${seq.shots.map((s, i) => `<tr><td class="mono">${esc(s.state)}</td><td><input type="number" class="ls-st" data-i="${i}" value="${s.time}" step="0.1" style="width:60px"> s
          <span class="hint mono">${esc(s.pos)} → ${esc(s.focus)}${s.move ? ` · moves ${esc(s.move)}` : ''}${s.pause ? ' · pauses game' : ''}</span>
          ${this.splineByName(s.pos) ? '' : ' <span class="warn">camera spline missing</span>'}</td></tr>`).join('')}
        <tr><td>Actors</td><td>${this.actors.length ? [...new Set(this.actors.map(a => a.type))].map(t => `${esc(t)} ×${this.actors.filter(a => a.type === t).length}`).join(', ') : '<span class="hint">none</span>'}</td></tr>
      </table>
      <div class="row" style="margin-top:6px"><span class="hint" id="ls-keyinfo"></span></div>
      <div class="row"><button class="b" id="ls-goto" title="Look through the shot camera at this key">View key</button><button class="b" id="ls-setkey" title="Fly to a view (Free view), then set this key's camera and focus from it">Set key from view</button>
        <button class="b" id="ls-addkey" title="Insert a key here from the current view">Insert key</button><button class="b" id="ls-delkey">Delete key</button></div>
      <p class="hint">Keys are the shot's camera spline points (with the focus points of the same number). Splines save with SPLINE.DAT; shot times save into the AI script.</p>` : ''}`;
    const on = (id, ev, f) => { const el = $(id); if (el) el[ev] = f; };
    on('ls-seq', 'onchange', e => this.select(+e.target.value));
    if (!seq) return;
    on('ls-play', 'onclick', () => this.playing ? this.pause() : this.play());
    on('ls-rew', 'onclick', () => this.seek(0));
    on('ls-scrub', 'oninput', e => { this.pause(); this.seek(+e.target.value); });
    on('ls-look', 'onchange', e => { o.look = e.target.checked; this.saveOpts(); if (!o.look) this.release(); this.show(); this.renderPanel(); });
    on('ls-free', 'onclick', () => { o.look = false; this.saveOpts(); this.release(); this.show(); this.renderPanel(); });
    const num = (id, k, f = x => x) => on(id, 'onchange', e => { o[k] = f(e.target.value); this.saveOpts(); this.show(); });
    num('ls-fov', 'fov', Number); num('ls-aspect', 'aspect', Number); num('ls-speed', 'speed', Number); num('ls-accel', 'accel', Number); num('ls-smooth', 'smooth', v => v === '1');
    for (const el of E.querySelectorAll('.ls-st')) el.onchange = e => this.setTime(seq.shots[+e.target.dataset.i], Math.max(0.1, +e.target.value || 0.1));
    const key = () => this.keyAt();
    on('ls-goto', 'onclick', () => { const k = key(); if (!k) return; const P = this.splineByName(k.shot.pos); this.goToKey(k.shot, k.k, P.points.length); });
    on('ls-setkey', 'onclick', () => { const k = key(); if (k) this.setKey(k.shot, k.k); });
    on('ls-addkey', 'onclick', () => { const k = key(); if (k) this.setKey(k.shot, k.k + 1, true); });
    on('ls-delkey', 'onclick', () => { const k = key(); if (k) this.deleteKey(k.shot, k.k); });
    this.renderTransport();
  }
  // move the playhead to key k of a shot and look through the camera there
  goToKey(shot, k, n) {
    const seq = this.cur; let t = seq.lead.time;
    for (const s of seq.shots) { if (s === shot) break; t += this.shotLen(s); }
    this.opts.look = true; this.saveOpts();
    this.seek(t + (n > 1 ? k / (n - 1) : 0) * this.camTime(shot) - (k === n - 1 ? 1e-3 : 0));
    this.renderPanel();
  }
  renderTransport() {
    if ($('ls-play')) $('ls-play').textContent = this.playing ? 'Pause' : 'Play';
    this.renderTime();
  }
  renderTime() {
    const seq = this.cur; if (!seq || !$('ls-time')) return;
    $('ls-time').textContent = `${fmt(this.t, 2)} / ${fmt(this.duration(), 1)} s`;
    if ($('ls-scrub') && document.activeElement !== $('ls-scrub')) $('ls-scrub').value = this.t;
    const { k, u } = this.shotAt(this.t), kk = this.keyAt();
    if ($('ls-keyinfo')) $('ls-keyinfo').textContent = k < 0 ? 'Lead-in: actors set off, no shot camera yet.'
      : `${seq.shots[k].state} at ${Math.round(u * 100)}% · nearest key ${kk ? kk.k + 1 : '–'} of ${this.splineByName(seq.shots[k].pos)?.points.length || 0}`;
  }
}
