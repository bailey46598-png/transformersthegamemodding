// Game recordings for the Script cutscenes panel: what the game really did, recorded by the DebugTrainer's cutscene
// recorder (F9, or "Record every level start") into <game>\CutsceneRecordings\<LEVEL>_<date>.tsv.
//
// Format (tab-separated, one block per frame; see mods\DebugTrainer\src\DebugTrainer.cpp, "cutscene recorder"):
//   # TFRecording 1 / # level <name> / …                       header
//   F frame t  m0..m15  proj11 proj22 vpW vpH                   render camera world matrix (rows right, up, forward,
//                                                              position) and the device projection terms
//   C ptr type player x y z fx fy fz                           each character near the camera
//
// With a recording loaded, the panel:
//   - aligns it to the selected sequence: each shot starts where the game camera reaches that shot's first camera
//     point, which gives the real shot times, the lead-in, and any frames of gameplay camera between shots;
//   - compares the game camera with the preview's, frame by frame (position and aim error per shot);
//   - matches recorded characters to the preview's actors (same type, nearest the spawn point) and either plays their
//     recorded motion or fits the preview's motion model (start delay, acceleration, top speed) to it;
//   - can look through the game camera itself (its field of view when the device reports a projection).
import * as THREE from 'three';
import { $, esc, fmt, status, api, joinPath } from './common.js';
import { pathOf, atDistance } from './shot_layer.js';

export function parseRecording(text, name = 'recording') {
  const frames = [], meta = { name };
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    if (line[0] === '#') { const m = /^#\s*(\w+)\s+(.*)$/.exec(line); if (m) meta[m[1].toLowerCase()] = m[2].trim(); continue; }
    const f = line.split('\t');
    if (f[0] === 'F') {
      const m = f.slice(3, 19).map(Number);
      cur = { i: +f[1], t: +f[2], m, pos: [m[12], m[13], m[14]], fwd: [m[8], m[9], m[10]], up: [m[4], m[5], m[6]],
        p11: +f[19], p22: +f[20], vw: +f[21], vh: +f[22], chars: [] };
      frames.push(cur);
    } else if (f[0] === 'C' && cur) {
      cur.chars.push({ ptr: f[1], type: f[2], player: f[3] === '1', pos: [+f[4], +f[5], +f[6]], fwd: [+f[7], +f[8], +f[9]] });
    }
  }
  if (!frames.length) throw new Error('no frames in this file (not a TF Studio recording?)');
  // per character: its track
  const tracks = new Map();
  frames.forEach((fr, k) => {
    for (const c of fr.chars) {
      if (!tracks.has(c.ptr)) tracks.set(c.ptr, { ptr: c.ptr, type: c.type, player: c.player, pts: [] });
      const tr = tracks.get(c.ptr); tr.player ||= c.player;
      tr.pts.push({ t: fr.t, k, pos: c.pos, fwd: c.fwd });
    }
  });
  // field of view and aspect per frame, when the device has a projection (an identity matrix means unknown).
  // First recording (Airbase, gameplay camera): vertical 43° at aspect 4:3 on a 16:9 screen, so the game stretches.
  for (const f of frames) {
    const ok = f.p22 > 0.2 && f.p22 < 10 && Math.abs(f.p22 - 1) > 1e-3 && f.p11 > 0.1;
    f.fov = ok ? 2 * Math.atan(1 / f.p22) * 180 / Math.PI : null;
    f.aspect = ok ? f.p22 / f.p11 : null;
  }
  const fovs = frames.map(f => f.fov).filter(x => x).sort((a, b) => a - b);
  const fov = fovs.length ? fovs[fovs.length >> 1] : null;
  return { meta, frames, tracks: [...tracks.values()], fov, duration: frames[frames.length - 1].t - frames[0].t };
}

// index of the last frame at or before time t
function frameAt(R, t) {
  const F = R.frames; let lo = 0, hi = F.length - 1;
  if (t <= F[0].t) return 0;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (F[mid].t <= t) lo = mid; else hi = mid - 1; }
  return lo;
}
const V = a => new THREE.Vector3(a[0], a[1], a[2]);
function lerpArr(a, b, k) { return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]; }
// a track's position at time t (null outside it)
function trackAt(tr, t) {
  const P = tr.pts; if (!P.length || t < P[0].t - 0.05 || t > P[P.length - 1].t + 0.05) return null;
  let lo = 0, hi = P.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (P[mid].t <= t) lo = mid; else hi = mid - 1; }
  const a = P[lo], b = P[Math.min(lo + 1, P.length - 1)], k = b.t > a.t ? Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t))) : 0;
  return { pos: lerpArr(a.pos, b.pos, k), fwd: lerpArr(a.fwd, b.fwd, k) };
}

// the preview's motion model: from rest after `delay`, accelerate at `accel` up to `speed`
export function modelDistance(t, { delay = 0, accel, speed }) {
  const u = t - delay; if (u <= 0) return 0;
  const tv = speed / accel;
  return u < tv ? 0.5 * accel * u * u : 0.5 * speed * tv + speed * (u - tv);
}

export class RecordingLayer {
  constructor(shots) {
    this.S = shots; shots.rec = this;
    this.R = null; this.opts = { show: true, lookGame: false, useTracks: false };
    this.group = null; this.ghosts = [];
    shots.vp.onFrame.push(() => this.frame());
  }
  get view() { return this.S.view; }
  level() { return (this.view.dir || '').split('/').pop().toUpperCase(); }

  // ------------------------------------------------------------ files
  async list() {
    try { return (await api.list('CutsceneRecordings')).files.filter(f => /\.tsv$/i.test(f.name)).map(f => f.name).sort().reverse(); }
    catch { return []; }
  }
  async open(name) { this.use(parseRecording(await api.text(joinPath('CutsceneRecordings', name)), name)); }
  use(R) {
    this.R = R; this.align(); this.build();
    status(`Recording ${R.meta.name}: ${R.frames.length} frames, ${fmt(R.duration, 1)} s, ${R.tracks.length} characters.`);
    this.S.show(); this.renderPanel();
  }
  close() { this.R = null; this.A = null; this.clear(); this.S.show(); this.renderPanel(); }

  // ------------------------------------------------------------ alignment to the selected sequence
  // Each shot starts at the first frame (after the previous shot) where the game camera is within 1.5 units of the
  // shot's first camera point and then moves along its path.
  align() {
    const S = this.S, seq = S.cur, R = this.R;
    this.A = null;
    if (!R || !seq) return;
    const shots = [];
    let from = 0;
    for (const shot of seq.shots) {
      const P = S.splineByName(shot.pos); if (!P?.points.length) { shots.push(null); continue; }
      const p0 = V(P.points[0]), path = pathOf(P.points, S.opts.smooth);
      let best = -1, bd = Infinity;
      for (let i = from; i < R.frames.length; i++) {
        const d = V(R.frames[i].pos).distanceTo(p0);
        if (d < bd) { bd = d; best = i; }
        if (d < 1.5) { best = i; bd = d; break; }
      }
      if (best < 0 || bd > 25) { shots.push(null); continue; }
      // the shot runs while the camera stays within 3 units of the camera path
      // distance from the camera to the shot's path (its segments: a straight path has only its corner points)
      const near = i => {
        const q = V(R.frames[i].pos); let m = Infinity;
        for (let j = 0; j + 1 < path.S.length; j++) {
          const a = path.S[j], ab = path.S[j + 1].clone().sub(a), k = Math.max(0, Math.min(1, q.clone().sub(a).dot(ab) / (ab.lengthSq() || 1)));
          m = Math.min(m, a.clone().addScaledVector(ab, k).distanceTo(q));
        }
        return path.S.length > 1 ? m : path.S[0].distanceTo(q);
      };
      let end = best;
      while (end + 1 < R.frames.length && near(end + 1) < 3) end++;
      // a camera holding its last frame isn't part of the shot: stop where it stops moving
      while (end > best && V(R.frames[end].pos).distanceTo(V(R.frames[end - 1].pos)) < 1e-3) end--;
      const sh = { start: best, end, t0: R.frames[best].t, t1: R.frames[end].t, startDist: bd };
      sh.t0 = this.refineStart(shot, sh);
      shots.push(sh);
      from = end + 1;
    }
    const first = shots.find(Boolean);
    if (!first) { this.A = { shots, ok: false }; return; }
    const k0 = shots.indexOf(first);
    const before = seq.shots.slice(0, k0).reduce((a, s) => a + S.shotLen(s), 0);
    const r0 = first.t0 - seq.lead.time - before; // recording time of sequence time 0
    // frames between consecutive shots on neither camera = the gameplay camera showing
    const gaps = [];
    for (let k = 1; k < shots.length; k++) if (shots[k] && shots[k - 1]) gaps.push(Math.max(0, shots[k].start - shots[k - 1].end - 1));
    this.A = { shots, r0, ok: true, gaps };
    this.matchActors();
    this.compareCamera();
  }
  // the shot's start time to the millisecond: the one that puts the preview camera closest to the game's over the
  // shot's first second (frames only give it to a frame)
  refineStart(shot, sh) {
    const R = this.R, S = this.S;
    const err = t0 => {
      let e = 0, n = 0;
      for (let i = sh.start; i <= sh.end && R.frames[i].t - sh.t0 < 1; i++) {
        const u = (R.frames[i].t - t0) / (S.camTime(shot) || 1); if (u < 0) continue;
        const c = S.camAt(shot, Math.min(1, u)); if (!c) continue;
        e += V(R.frames[i].pos).distanceToSquared(c.pos); n++;
      }
      return n ? e / n : Infinity;
    };
    let best = sh.t0, be = err(best);
    for (let d = -0.1; d <= 0.1; d += 0.001) { const e = err(sh.t0 + d); if (e < be) { be = e; best = sh.t0 + d; } }
    return best;
  }
  // recording time for sequence time t: lined up with the sequence, or else from the recording's own start
  recTime(t) { return this.A?.ok ? this.A.r0 + t : this.R ? this.R.frames[0].t + t : null; }

  // ------------------------------------------------------------ actors: recorded tracks for the preview's actors
  matchActors() {
    const S = this.S, R = this.R, r0 = this.A.r0, used = new Set();
    for (const act of S.actors) {
      act.track = null; act.fitErr = null;
      const cands = R.tracks.filter(tr => !tr.player && !used.has(tr) && tr.type.toLowerCase() === act.type.toLowerCase());
      let best = null, bd = Infinity;
      for (const tr of cands) {
        // where it is when it first shows after the sequence starts
        const p = tr.pts.find(q => q.t >= r0 - 0.5) || tr.pts[0];
        const d = V(p.pos).distanceTo(act.start);
        if (d < bd) { bd = d; best = tr; }
      }
      if (best && bd < 60) { act.track = best; used.add(best); }
    }
  }
  // the preview's motion model fitted to each matched actor's recorded track (least squares on distance along its path)
  fitActors() {
    const S = this.S, r0 = this.A.r0, out = [];
    for (const act of S.actors) {
      if (!act.track) continue;
      const samples = [];
      for (const q of act.track.pts) {
        const t = q.t - r0; if (t < 0 || t > S.duration() + 1) continue;
        samples.push([t, this.alongPath(act.path, V(q.pos))]);
      }
      if (samples.length < 5) continue;
      const cost = (delay, accel, speed) => { let e = 0; for (const [t, s] of samples) { const d = modelDistance(t, { delay, accel, speed }) - s; e += d * d; } return e; };
      let best = null;
      // coarse grid, then a finer one around the best
      for (let delay = -0.5; delay <= 2.0001; delay += 0.1)
        for (const accel of [3, 4, 5, 6, 8, 10, 12, 15, 18, 22, 27, 33, 40, 50, 65, 80])
          for (let speed = 5; speed <= 70; speed += 1) { const e = cost(delay, accel, speed); if (!best || e < best.e) best = { e, delay, accel, speed }; }
      const c = { ...best };
      for (let delay = c.delay - 0.35; delay <= c.delay + 0.35; delay += 0.01)
        for (let accel = c.accel * 0.7; accel <= c.accel * 1.45; accel += c.accel * 0.02)
          for (let speed = c.speed - 1.5; speed <= c.speed + 1.5; speed += 0.1) { const e = cost(delay, accel, speed); if (e < best.e) best = { e, delay, accel, speed }; }
      act.fit = { delay: +best.delay.toFixed(2), accel: +best.accel.toFixed(1), speed: +best.speed.toFixed(1), rms: Math.sqrt(best.e / samples.length) };
      out.push(act);
    }
    this.saveFits();
    return out;
  }
  // distance along a path of the point on it nearest q (every segment is tried)
  alongPath(path, q) {
    let best = 0, bd = Infinity;
    for (let i = 0; i + 1 < path.S.length; i++) {
      const a = path.S[i], ab = path.S[i + 1].clone().sub(a), len2 = ab.lengthSq() || 1;
      const k = Math.max(0, Math.min(1, q.clone().sub(a).dot(ab) / len2));
      const d = a.clone().addScaledVector(ab, k).distanceToSquared(q);
      if (d < bd) { bd = d; best = path.L[i] + k * Math.sqrt(len2); }
    }
    return best;
  }
  fitKey() { return `tfstudio.actorfit.${this.level()}.${this.S.cur?.name || ''}`; }
  saveFits() { try { localStorage.setItem(this.fitKey(), JSON.stringify(this.S.actors.map(a => a.fit || null))); } catch { /* not kept */ } }
  loadFits() {
    try { const F = JSON.parse(localStorage.getItem(this.fitKey()) || '[]'); this.S.actors.forEach((a, i) => { if (F[i]) a.fit = F[i]; }); } catch { /* none */ }
  }
  clearFits() { for (const a of this.S.actors) a.fit = null; this.saveFits(); this.S.show(); this.renderPanel(); }

  // ------------------------------------------------------------ camera comparison
  compareCamera() {
    const S = this.S, seq = S.cur, A = this.A, R = this.R;
    A.cam = seq.shots.map((shot, k) => {
      const sh = A.shots[k]; if (!sh) return null;
      let pe = 0, pm = 0, ae = 0, am = 0, n = 0;
      for (let i = sh.start; i <= sh.end; i++) {
        const fr = R.frames[i], T = S.camTime(shot), u = T > 0 ? (fr.t - sh.t0) / T : 1;
        const c = S.camAt(shot, Math.max(0, Math.min(1, u))); if (!c) continue;
        const dp = V(fr.pos).distanceTo(c.pos);
        const want = c.foc.clone().sub(c.pos).normalize(), got = V(fr.fwd).normalize();
        const da = Math.acos(Math.max(-1, Math.min(1, want.dot(got)))) * 180 / Math.PI;
        pe += dp; pm = Math.max(pm, dp); ae += da; am = Math.max(am, da); n++;
      }
      const fv = R.frames.slice(sh.start, sh.end + 1).filter(f => f.fov), mid = a => a.sort((x, y) => x - y)[a.length >> 1];
      const proj = fv.length ? { fov: mid(fv.map(f => f.fov)), aspect: mid(fv.map(f => f.aspect)) } : null;
      return n ? { pos: pe / n, posMax: pm, ang: ae / n, angMax: am, n, length: sh.t1 - sh.t0, proj } : null;
    });
  }

  // ------------------------------------------------------------ hooks used by the shot layer
  // the game camera at sequence time t (world space), when looking through it
  gameCam(t) {
    if (!this.R || !this.opts.lookGame) return null;
    const r = this.recTime(t); if (r == null) return null;
    const F = this.R.frames, i = frameAt(this.R, r), a = F[i], b = F[Math.min(i + 1, F.length - 1)];
    const k = b.t > a.t ? Math.max(0, Math.min(1, (r - a.t) / (b.t - a.t))) : 0;
    const W = v => this.view.toWorld(V(v));
    const pos = lerpArr(a.pos, b.pos, k), fwd = lerpArr(a.fwd, b.fwd, k), up = lerpArr(a.up, b.up, k);
    const P = W(pos), T = W([pos[0] + fwd[0] * 10, pos[1] + fwd[1] * 10, pos[2] + fwd[2] * 10]);
    const U = W([pos[0] + up[0], pos[1] + up[1], pos[2] + up[2]]).sub(P).normalize();
    return { pos: P, target: T, up: U, fov: a.fov || this.R.fov, aspect: a.aspect };
  }
  // actors at sequence time t: their recorded positions, when asked to
  applyActors(t) {
    if (!this.R || !this.opts.useTracks || !this.A?.ok) return;
    const r = this.recTime(t);
    for (const act of this.S.actors) {
      if (!act.track) continue;
      const q = trackAt(act.track, r);
      act.g.visible = !!q; if (!q) continue;
      act.g.position.set(...q.pos);
      if (q.fwd[0] || q.fwd[2]) act.g.rotation.y = Math.atan2(q.fwd[0], q.fwd[2]);
    }
  }
  onSequence() { if (this.R) { this.align(); this.build(); } this.loadFits(); this.renderPanel(); }

  // ------------------------------------------------------------ 3D: recorded camera path, tracks, ghosts
  clear() {
    if (this.group) { this.view.vp.root.remove(this.group); this.group.traverse(x => { x.geometry?.dispose(); x.material?.dispose?.(); }); }
    this.group = null; this.ghosts = [];
  }
  build() {
    this.clear(); if (!this.R) return;
    const G = this.group = new THREE.Group(); G.name = 'recording';
    const line = (pts, color) => { const g = new THREE.BufferGeometry().setFromPoints(pts.map(V)); return new THREE.Line(g, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.85 })); };
    G.add(line(this.R.frames.map(f => f.pos), 0xff9a3c));
    for (const tr of this.R.tracks) G.add(line(tr.pts.map(p => p.pos), tr.player ? 0x6aa6ff : 0x39d0c8));
    // ghosts: every recorded character at the current time
    this.ghostGeo = new THREE.BoxGeometry(2, 1.6, 4.4);
    for (const tr of this.R.tracks) {
      const m = new THREE.Mesh(this.ghostGeo, new THREE.MeshBasicMaterial({ color: tr.player ? 0x6aa6ff : 0x39d0c8, wireframe: true }));
      m.userData.track = tr; G.add(m); this.ghosts.push(m);
    }
    this.view.vp.root.add(G);
  }
  frame() {
    if (!this.group) return;
    const S = this.S, looking = S.opts.look && S.locked;
    this.group.visible = this.opts.show;
    for (const c of this.group.children) if (c.isLine) c.visible = !looking;
    const r = this.recTime(S.t);
    for (const g of this.ghosts) {
      const q = r == null ? null : trackAt(g.userData.track, r);
      g.visible = !!q && !(this.opts.useTracks && S.actors.some(a => a.track === g.userData.track));
      if (q) { g.position.set(q.pos[0], q.pos[1] + 0.8, q.pos[2]); if (q.fwd[0] || q.fwd[2]) g.rotation.y = Math.atan2(q.fwd[0], q.fwd[2]); }
    }
    if (looking && this.opts.lookGame) this.renderLive();
  }
  renderLive() {
    const el = $('lr-live'); if (!el) return;
    const t = performance.now(); if (t - (this._lt || 0) < 150) return; this._lt = t;
    const r = this.recTime(this.S.t);
    el.textContent = r == null ? '' : `game camera at ${fmt(r, 2)} s in the recording`;
  }

  // ------------------------------------------------------------ panel ("Game recordings")
  async renderPanel() {
    const E = $('l-rec'); if (!E) return;
    const S = this.S, R = this.R, A = this.A, o = this.opts;
    const files = this._files || (this._files = await this.list());
    const shotRows = A?.ok ? S.cur.shots.map((s, k) => {
      const sh = A.shots[k], c = A.cam?.[k];
      if (!sh) return `<tr><td class="mono">${esc(s.state)}</td><td><span class="warn">not found in the recording</span></td></tr>`;
      return `<tr><td class="mono">${esc(s.state)}</td><td>${fmt(sh.t0 - A.r0, 2)} s → ${fmt(sh.t1 - A.r0, 2)} s (game ${fmt(sh.t1 - sh.t0, 2)} s, script ${fmt(S.shotLen(s), 2)} s)
        ${c ? `<br><span class="hint">camera off by ${fmt(c.pos, 2)} (max ${fmt(c.posMax, 2)}) units, aim ${fmt(c.ang, 1)}° (max ${fmt(c.angMax, 1)}°)${c.proj ? `; game projection ${fmt(c.proj.fov, 1)}° tall at ${fmt(c.proj.aspect, 3)}:1` : ''}</span>` : ''}</td></tr>`;
    }).join('') : '';
    const actRows = A?.ok ? S.actors.map((a, i) => `<tr><td>${esc(a.type)} ${i + 1}</td><td>${a.track ? `track <span class="mono">${esc(a.track.ptr)}</span>` : '<span class="warn">no match</span>'}
        ${a.fit ? `<br><span class="hint">fit: starts ${fmt(a.fit.delay, 2)} s, ${fmt(a.fit.accel, 0)} u/s², top ${fmt(a.fit.speed, 0)} u/s (±${fmt(a.fit.rms, 1)})</span>` : ''}</td></tr>`).join('') : '';
    E.innerHTML = `<div class="row"><select id="lr-file" style="flex:1"><option value="">Recordings in CutsceneRecordings…</option>${files.map(f => `<option ${R?.meta.name === f ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select>
        <button class="b" id="lr-refresh" title="List again">↻</button><label class="b" title="Open a recording from anywhere">Open…<input type="file" id="lr-pick" accept=".tsv" hidden></label></div>
      ${R ? `<table class="kv" style="margin-top:6px">
        <tr><td>Recording</td><td class="mono">${esc(R.meta.name)}${R.meta.level ? ` · ${esc(R.meta.level)}` : ''}</td></tr>
        <tr><td>Length</td><td>${R.frames.length} frames, ${fmt(R.duration, 1)} s (${fmt(R.frames.length / Math.max(R.duration, 1e-3), 0)} fps), ${R.tracks.length} characters</td></tr>
        <tr><td>Field of view</td><td>${R.fov ? `${fmt(R.fov, 1)}° from the game's projection <button class="b" id="lr-usefov">Use it</button>` : '<span class="hint">not reported by the game (the projection is set in shaders)</span>'}</td></tr>
        ${!S.cur ? '<tr><td></td><td class="hint">Pick a camera sequence above to line the recording up with it.</td></tr>'
          : A?.ok ? `<tr><td>Lined up</td><td>sequence starts at ${fmt(A.r0, 2)} s in the recording${A.gaps.some(g => g) ? `<br><span class="warn">gameplay camera between shots: ${A.gaps.map(g => `${g} frame${g === 1 ? '' : 's'}`).join(', ')}</span>` : ''}</td></tr>${shotRows}${actRows}`
          : '<tr><td></td><td class="warn">The game camera never reaches this sequence\'s first camera point: a different sequence, or the recording missed it.</td></tr>'}
      </table>
      <div class="row" style="margin-top:4px;flex-wrap:wrap">
        <label><input type="checkbox" id="lr-show" ${o.show ? 'checked' : ''}> Show paths & ghosts</label>
        <label title="Look through the camera the game used (instead of the preview's)"><input type="checkbox" id="lr-look" ${o.lookGame ? 'checked' : ''}> Game camera</label>
        <label title="The preview's actors follow their recorded tracks"><input type="checkbox" id="lr-tracks" ${o.useTracks ? 'checked' : ''}> Recorded actor motion</label>
      </div>
      <div class="row" style="margin-top:4px"><button class="b" id="lr-fit" ${A?.ok ? '' : 'disabled'} title="Fit each actor's start delay, acceleration and top speed to its recorded track">Fit actors to recording</button>
        <button class="b" id="lr-unfit">Clear fits</button><button class="b" id="lr-close">Close</button></div>
      <span class="hint" id="lr-live"></span>` : `<p class="hint">Record in game with the DebugTrainer (F9, or "Record every level start"), then pick the file here.
        The recording shows what the game really did: its camera and every character, frame by frame.</p>`}`;
    const on = (id, ev, f) => { const el = $(id); if (el) el[ev] = f; };
    on('lr-file', 'onchange', async e => { if (e.target.value) try { await this.open(e.target.value); } catch (err) { status(err.message, true); } });
    on('lr-refresh', 'onclick', async () => { this._files = null; this.renderPanel(); });
    on('lr-pick', 'onchange', async e => { const f = e.target.files[0]; if (f) try { this.use(parseRecording(await f.text(), f.name)); } catch (err) { status(err.message, true); } });
    on('lr-close', 'onclick', () => this.close());
    on('lr-show', 'onchange', e => { o.show = e.target.checked; });
    on('lr-look', 'onchange', e => { o.lookGame = e.target.checked; S.show(); });
    on('lr-tracks', 'onchange', e => { o.useTracks = e.target.checked; S.show(); });
    on('lr-usefov', 'onclick', () => { S.opts.fov = +R.fov.toFixed(1); S.saveOpts(); S.show(); S.renderPanel(); });
    on('lr-fit', 'onclick', () => { const n = this.fitActors().length; status(`Fitted ${n} actor${n === 1 ? '' : 's'} to the recording.`); S.show(); this.renderPanel(); });
    on('lr-unfit', 'onclick', () => this.clearFits());
  }
}
