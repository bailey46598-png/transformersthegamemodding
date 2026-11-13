// Cameras tab: the player's vehicle cameras per character, for tuning CharacterCams.ini.
// - Draws the character's vehicle with the chase camera placed from the preset values (an estimate: the exact
//   chase-camera math isn't decoded), the camera's collision ray checked against the vehicle's own mesh, the
//   near/far limit at a chosen speed, and the R (front) camera.
// - Opens CharacterCams F8 dumps (CharacterCams_dump_*.bin) and shows what the game measured: live vs base
//   distance, pitch, heights, the aim point and the chase rig's position.
// - Reads CharacterCams_presets.bin (written by F8 since CharacterCams 0.9) for every preset's real values.
// - Edits a character's section of CharacterCams.ini; press F7 in game to load it.
// Background: CHARACTER_CAMERAS.md (Fresh Build).
import * as THREE from 'three';
import { api, $, status, esc, fmt, Viewport } from './common.js';
import { loadModel, buildMeshes, disposeGroup, restPose, skinMeshes } from './rig.js';

const UNITS = 65536 / 360;   // game angle units per degree
const DEFAULT_FOOT = 0x721B10;
// Every character the spawn switch (0x470A00..0x471740) knows: identity, INI section, vehicle profile, vehicle
// model, stock slot A (on foot) / slot B (vehicle), the game's own R view. Identities 15+ were past the camera table
// and got the default presets; CharacterCams 0.10 gives them table entries. Each drone type has two identities: even =
// plain, odd = "_a" (its section falls back to the plain drone's: alt). G1 skins are assumed to share their base
// character's identity (not checked).
const D = { a: DEFAULT_FOOT, b: 0x721DE0 };   // default presets
const CHARS = [
  { g: 'Autobots & Decepticons' },
  { id: 1, sec: 'Optimus', name: 'Optimus Prime', prof: 0, model: 'OPTIMUSPRIME/CAR_PC.GHG', a: 0x71AC80, b: 0x721C80, r: [1.5, 9] },
  { id: 2, sec: 'Brawl', name: 'Brawl', prof: 13, model: 'BRAWL/CAR_PC.GHG', a: 0x71AC80, b: 0x7219B0 },
  { id: 3, sec: 'Bumblebee', name: 'Bumblebee', prof: 1, model: 'BUMBLEBEE/CAR_PC.GHG', ...D, r: [1, 5], note: 'Qatar uses 0x71AF50' },
  { id: 4, sec: 'Bumblebee07', name: 'Bumblebee 07', prof: 2, model: 'BUMBLEBEE07/CAR_PC.GHG', ...D, r: [1, 5] },
  { id: 5, sec: 'Jazz', name: 'Jazz', prof: 3, model: 'JAZZ/CAR_PC.GHG', a: DEFAULT_FOOT, b: 0x71B4F0, r: [0.5, 4] },
  { id: 6, sec: 'Ratchet', name: 'Ratchet', prof: 5, model: 'RATCHET/CAR_PC.GHG', ...D },
  { id: 7, sec: 'Ironhide', name: 'Ironhide', prof: 5, model: 'IRONHIDE/CAR_PC.GHG', a: 0x71AC80, b: 0x7219B0, r: [1, 6.5] },
  { id: 8, sec: 'Megatron', name: 'Megatron', prof: 6, model: 'MEGATRON/CAR_PC.GHG', a: 0x71AC80, b: 0x71B210, air: true },
  { id: 9, sec: 'Starscream', name: 'Starscream', prof: 7, model: 'STARSCREAM/CAR_PC.GHG', a: 0x71B370, b: 0x71B650, air: true },
  { id: 10, sec: 'Blackout', name: 'Blackout', prof: 8, model: 'BLACKOUT/CAR_PC.GHG', a: 0x71A9A0, b: 0x71AF50, air: true },
  { id: 11, sec: 'Barricade', name: 'Barricade', prof: 9, model: 'BARRICADE/CAR_PC.GHG', a: 0x721F50, b: 0x71ADE0, r: [0.4, 5] },
  { id: 12, sec: 'Scorponok', name: 'Scorponok', prof: 10, model: 'SCORPONOK', a: 0x71B0B0, b: 0x71B0B0 },
  { id: 13, sec: 'Frenzy', name: 'Frenzy', prof: 11, model: 'FRENZY', ...D },
  { id: 14, sec: 'Bonecrusher', name: 'Bonecrusher', prof: 12, model: 'BONECRUSHER/CAR_PC.GHG', a: 0x71AC80, b: 0x7219B0 },
  { g: 'G1 skins (same identity assumed)' },
  { id: 1, sec: 'Optimus', name: 'Optimus Prime (G1 cab)', prof: 0, model: 'OPTIMUSPRIME/CAR_G1_PC.GHG', a: 0x71AC80, b: 0x721C80, r: [1.5, 9], skin: true },
  { id: 1, sec: 'Optimus', name: 'G1 Optimus Prime', prof: 0, model: 'OPTIMUSPRIME/G1_OPTIMUS_CAR_PC.GHG', a: 0x71AC80, b: 0x721C80, r: [1.5, 9], skin: true },
  { id: 5, sec: 'Jazz', name: 'Jazz (G1)', prof: 3, model: 'JAZZ/CAR_G1_PC.GHG', a: DEFAULT_FOOT, b: 0x71B4F0, r: [0.5, 4], skin: true },
  { id: 9, sec: 'Starscream', name: 'Starscream (G1)', prof: 7, model: 'STARSCREAM/CAR_G1_PC.GHG', a: 0x71B370, b: 0x71B650, air: true, skin: true },
  { g: 'TripleC and others' },
  { id: 15, sec: 'TripleC', name: 'TripleC (Shockwave)', prof: 14, model: 'TRIPLECHANGER/DRONE_CAR_PC.GHG', a: 0x71A9A0, b: 0x71AF50, air: true, note: 'CharacterCams gives him Blackout\'s cameras; CarCamera=Own tunes that flight camera' },
  { id: 16, sec: 'TripleCTurret', name: 'TripleC turret', prof: -1, model: 'TRIPLECHANGER/DRONE_TURRET_PC.GHG', ...D, novehicle: true },
  { id: 17, sec: 'EnergonDrone', name: 'Energon drone', prof: -1, model: 'ENERGONDRONE/ROBOT_PC.GHG', ...D, novehicle: true },
  { g: 'Drones (each section also covers its _a variant)' },
  { id: 18, sec: 'DroneDefault', name: 'Drone (default car)', prof: 19, model: 'DRONE/DRONE_CAR_PC.GHG', ...D },
  { id: 19, sec: 'DroneDefault_a', alt: 'DroneDefault', name: 'Drone (default car) _a', prof: 19, model: 'DRONE/DRONE_CAR_A_PC.GHG', ...D },
  { id: 20, sec: 'DroneForklift', name: 'Forklift drone', prof: 20, model: 'FORKLIFT/CAR_PC.GHG', ...D },
  { id: 21, sec: 'DroneForklift_a', alt: 'DroneForklift', name: 'Forklift drone _a', prof: 20, model: 'FORKLIFT/CAR_A_PC.GHG', ...D },
  { id: 22, sec: 'DroneMig', name: 'Mig drone', prof: 22, model: 'DRONEMIG/JET_PC.GHG', ...D, air: true },
  { id: 23, sec: 'DroneMig_a', alt: 'DroneMig', name: 'Mig drone _a', prof: 22, model: 'DRONEMIG/JET_A_PC.GHG', ...D, air: true },
  { id: 24, sec: 'DroneCement', name: 'Cement truck drone', prof: 21, model: 'CEMENTTRUCK/CAR_PC.GHG', ...D },
  { id: 25, sec: 'DroneCement_a', alt: 'DroneCement', name: 'Cement truck drone _a', prof: 21, model: 'CEMENTTRUCK/CAR_A_PC.GHG', ...D },
  { id: 26, sec: 'DronePickupTruck', name: 'Pickup truck drone', prof: 24, model: 'PICKUPTRUCK/CAR_PC.GHG', ...D },
  { id: 27, sec: 'DronePickupTruck_a', alt: 'DronePickupTruck', name: 'Pickup truck drone _a', prof: 24, model: 'PICKUPTRUCK/CAR_A_PC.GHG', ...D },
  { id: 28, sec: 'DroneArmouredCar', name: 'Armoured car drone', prof: 23, model: 'ARMOUREDCAR/CAR_PC.GHG', ...D },
  { id: 29, sec: 'DroneArmouredCar_a', alt: 'DroneArmouredCar', name: 'Armoured car drone _a', prof: 23, model: 'ARMOUREDCAR/CAR_A_PC.GHG', ...D },
  { id: 30, sec: 'DroneTowTruck', name: 'Tow truck drone', prof: 25, model: 'TOWTRUCK/CAR_PC.GHG', ...D },
  { id: 31, sec: 'DroneTowTruck_a', alt: 'DroneTowTruck', name: 'Tow truck drone _a', prof: 25, model: 'TOWTRUCK/CAR_A_PC.GHG', ...D },
];
const PRESET_NAMES = {
  0x7219B0: 'Truck', 0x721C80: 'Optimus', 0x721DE0: 'Bumblebee', 0x71B4F0: 'Jazz', 0x71B210: 'Megatron',
  0x71B650: 'Starscream', 0x71AF50: 'Blackout', 0x71ADE0: 'Barricade', 0x71B0B0: 'Scorponok',
  0x71AC80: 'big robot (on foot)', 0x721B10: 'default (on foot)', 0x71A9A0: 'Blackout (on foot)',
  0x71B370: 'Starscream (on foot)', 0x721F50: 'Barricade (on foot)',
};
const NAMED = ['Truck', 'Optimus', 'Bumblebee', 'Jazz', 'Barricade', 'Megatron', 'Starscream', 'Blackout', 'Scorponok'];
const NAME_TO_ADDR = Object.fromEntries(Object.entries(PRESET_NAMES).filter(([, n]) => NAMED.includes(n)).map(([a, n]) => [n.toLowerCase(), +a]));
// Used only until CharacterCams_presets.bin exists. From F8 dumps and the exe; "guess" marks values not measured.
const BUILTIN = {
  0x7219B0: { dist: 7.5, near: 12, far: -2, h: [-0.4, -0.5, -0.5], pitch: -6000, guess: 'heights' },
  0x721C80: { dist: 7.5, near: 12, far: 5, h: [-0.4, -0.5, -0.5], pitch: -6000 },
  0x721DE0: { dist: 7.5, near: 0.75, far: 20, h: [-0.3, -0.8, -0.842], pitch: -4000 },
  0x71AF50: { dist: 25, near: 6, far: 35, h: [6, 6, 6], pitch: -4000, guess: 'everything but distance' },
};
// CharacterCams' built-in defaults (used when a key is missing from the section)
const PLUGIN_DEFAULTS = {
  14: { CarCamera: 'Truck', CarDistance: 12, CarNearDistance: 12, CarFarDistance: 14, CarHeight: 0, CarPitchDegrees: 33, IgnoreRayHitsUnder: 6, RView: 'On', RViewHeight: 2, RViewForward: 10 },
  2: { CarCamera: 'Truck', CarDistance: 12, CarNearDistance: 12, CarFarDistance: 14, CarHeight: 0, CarPitchDegrees: 33, IgnoreRayHitsUnder: 6, RView: 'On', RViewHeight: 2, RViewForward: 11 },
};
const KEYS = ['CarCamera', 'CarDistance', 'CarNearDistance', 'CarFarDistance', 'CarHeight', 'CarPitchDegrees', 'IgnoreRayHitsUnder', 'RView', 'RViewHeight', 'RViewForward'];
const hex = a => '0x' + (a >>> 0).toString(16).toUpperCase();
const g2w = (x, y, z) => new THREE.Vector3(x, y, -z);   // game (left-handed) -> three.js world

// ------------------------------------------------------------ file formats
const PRESET_BYTES = 0x160;
function presetFields(dv, o) {
  const f = k => dv.getFloat32(o + k, true);
  return {
    live: f(0x40), dist: f(0x48), near: f(0x130), far: f(0x134), h: [f(0x4C), f(0x50), f(0x54)],
    pitchLive: f(0x7C), pitch: f(0xBC), pitchMin: f(0x80), pitchMax: f(0x84),
    rig: [f(0x30), f(0x34), f(0x38)], fwd: [f(0x20), f(0x24), f(0x28)],
  };
}
function parsePresets(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x53504354) throw new Error('not a CharacterCams_presets.bin');
  const n = dv.getUint32(4, true), size = dv.getUint32(8, true), game = new Map(), built = new Map();
  for (let i = 0, o = 16; i < n; i++, o += 8 + size) {
    const addr = dv.getUint32(o, true), id = dv.getUint32(o + 4, true), p = presetFields(dv, o + 8);
    (id ? built : game).set(id || addr, p);
  }
  return { game, built };
}
const DUMP_SIZES = [['profile', 0x80], ['aircraft', 0xA90], ['preset', 0x160], ['car', 0x7F0], ['cam', 0x400], ['render', 0x100]];
function parseDump(buf, name) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x32464354) throw new Error(`${name}: not a CharacterCams F8 dump`);
  const off = {}; let o = 64;
  for (const [k, n] of DUMP_SIZES) { off[k] = o; o += n; }
  const v3 = p => [dv.getFloat32(p, true), dv.getFloat32(p + 4, true), dv.getFloat32(p + 8, true)];
  const d = {
    name, id: dv.getUint32(4, true), presetAddr: dv.getUint32(16, true), car: dv.getUint32(32, true),
    rHeld: dv.getUint32(44, true) === 1, preset: presetFields(dv, off.preset), aim: v3(off.cam + 0x220),
  };
  if (d.car) {   // car block +0x40: rows right / up / forward / position
    const c = off.car;
    d.frame = { R: v3(c + 0x40), U: v3(c + 0x50), F: v3(c + 0x60), P: v3(c + 0x70) };
  }
  return d;
}
// world point -> the vehicle's own frame (x right, y up, z forward), from the car block's rows. The chase rig
// sits ~10 along -row 3 while driving, so row 3 is taken as the driving direction (the visual front).
function toLocal(fr, p) {
  const r = [p[0] - fr.P[0], p[1] - fr.P[1], p[2] - fr.P[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return [dot(r, fr.R), dot(r, fr.U), dot(r, fr.F)];
}

// ------------------------------------------------------------ INI
function iniSection(text, sec) {
  const out = {}; let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    const m = /^\[([^\]]+)\]/.exec(l);
    if (m) { cur = m[1].trim().toLowerCase(); continue; }
    if (cur !== sec.toLowerCase() || !l || l[0] === ';') continue;
    const e = l.indexOf('=');
    if (e > 0) out[l.slice(0, e).trim()] = l.slice(e + 1).split(';')[0].trim();
  }
  return out;
}
// Sets keys in [sec], keeping comments and other sections; appends the section if missing.
function iniWrite(text, sec, kv) {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/), todo = new Map(Object.entries(kv));
  let start = -1, end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*\[([^\]]+)\]/.exec(lines[i]);
    if (!m) continue;
    if (start >= 0) { end = i; break; }
    if (m[1].trim().toLowerCase() === sec.toLowerCase()) start = i;
  }
  if (start < 0) {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push('', `[${sec}]`, ...[...todo].map(([k, v]) => `${k}=${v}`), '');
    return lines.join(nl);
  }
  let last = start;
  for (let i = start + 1; i < end; i++) {
    const l = lines[i].trim();
    if (!l || l[0] === ';') continue;
    const e = l.indexOf('='); if (e < 0) continue;
    const k = l.slice(0, e).trim();
    last = i;
    const hit = [...todo.keys()].find(x => x.toLowerCase() === k.toLowerCase());
    if (hit != null) { lines[i] = `${k}=${todo.get(hit)}`; todo.delete(hit); }
  }
  if (todo.size) lines.splice(last + 1, 0, ...[...todo].map(([k, v]) => `${k}=${v}`));
  return lines.join(nl);
}

// ------------------------------------------------------------ view
export class CameraView {
  constructor() {
    this.vp = new Viewport($('k-canvas'), { far: 2000 });
    this.vp.camera.position.set(14, 9, -16);
    this.grid = new THREE.GridHelper(60, 60, 0x555b66, 0x30343d);
    this.vp.scene.add(this.grid);
    this.gameCam = new THREE.PerspectiveCamera(55, 4 / 3, 0.1, 2000);
    this.rCam = new THREE.PerspectiveCamera(55, 4 / 3, 0.1, 2000);
    // the helpers draw short stand-in cameras (far 2) so the frustum lines don't cross the whole view
    this.gameProxy = new THREE.PerspectiveCamera(55, 4 / 3, 0.1, 2);
    this.rProxy = new THREE.PerspectiveCamera(55, 4 / 3, 0.1, 2);
    this.gameHelper = new THREE.CameraHelper(this.gameProxy);
    this.rHelper = new THREE.CameraHelper(this.rProxy);
    this.gameHelper.setColors?.(new THREE.Color(0xe8a33d), new THREE.Color(0xe8a33d), new THREE.Color(0xe8a33d), new THREE.Color(0xe8a33d), new THREE.Color(0xe8a33d));
    this.rHelper.setColors?.(new THREE.Color(0xb57edc), new THREE.Color(0xb57edc), new THREE.Color(0xb57edc), new THREE.Color(0xb57edc), new THREE.Color(0xb57edc));
    this.vp.scene.add(this.gameHelper, this.rHelper);
    this.marks = new THREE.Group(); this.vp.scene.add(this.marks);
    this.vehicle = null; this.ch = null; this.dump = null; this.presets = null; this.ini = null; this.iniPath = null;
    this.vp.afterRender.push(() => this.renderInset());
    this.bindUI();
  }

  async init() {
    this.renderChars();
    await Promise.all([this.loadIni(), this.loadPresets(), this.scanDumps()]);
    this.ghgs = await api.find('.ghg').catch(() => []);
    this.select(CHARS.find(c => c.id === 2));
  }

  bindUI() {
    $('k-chars').onclick = e => { const it = e.target.closest('.item'); if (it) this.select(CHARS[+it.dataset.i]); };
    $('k-dumps').onclick = e => { const it = e.target.closest('.item'); if (it) this.openDump(it.dataset.f); };
    $('k-dumpfile').onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      try { this.dump = parseDump(await f.arrayBuffer(), f.name); this.afterDump(); } catch (x) { status(x.message, true); }
      e.target.value = '';
    };
    $('k-presetfile').onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      try { this.presets = parsePresets(await f.arrayBuffer()); this.presetSrc = f.name; this.update(); } catch (x) { status(x.message, true); }
      e.target.value = '';
    };
    $('k-rescan').onclick = () => Promise.all([this.loadIni(), this.loadPresets(), this.scanDumps()]).then(() => this.select(this.ch));
    for (const id of ['k-speed', 'k-fov', 'k-look', 'k-inset', 'k-rlook']) $(id).oninput = () => this.update();
    $('k-form').oninput = () => { this.dirty = true; this.update(); };
    $('k-save').onclick = () => this.save().catch(e => status(`Save failed: ${e.message}`, true));
    $('k-revert').onclick = () => { this.fillForm(); this.update(); };
    $('k-shot').onclick = () => this.vp.screenshot(`camera_${this.ch?.sec || 'view'}.png`);
  }

  renderChars() {
    $('k-chars').innerHTML = CHARS.map((c, i) => c.g ? `<div class="grp">${esc(c.g)}</div>`
      : `<div class="item" data-i="${i}" title="[${esc(c.sec)}]">${esc(c.name)}<span class="sub">id ${c.id}${c.prof >= 0 ? ` · profile ${c.prof}` : ''}</span></div>`).join('');
  }

  // ---------------------------------------------------------- data sources
  async loadIni() {
    for (const p of ['CharacterCams.ini', 'mods/CharacterCams/CharacterCams.ini']) {
      try { this.ini = await api.text(p); this.iniPath = p; break; } catch { this.ini = null; }
    }
    $('k-inipath').textContent = this.iniPath ? this.iniPath : 'no CharacterCams.ini found (Save creates one in this folder)';
    if (!this.ini) { this.ini = ''; this.iniPath = 'CharacterCams.ini'; }
  }
  async loadPresets() {
    try { this.presets = parsePresets(await api.bytes('CharacterCams_presets.bin')); this.presetSrc = 'CharacterCams_presets.bin'; }
    catch { this.presets = null; this.presetSrc = null; }
  }
  async scanDumps() {
    try { this.dumpFiles = (await api.list('')).files.map(f => f.name).filter(n => /^CharacterCams_dump_id\d+_\d+(_R)?\.bin$/i.test(n)); }
    catch { this.dumpFiles = []; }
  }
  renderDumps() {
    const mine = this.dumpFiles.filter(n => new RegExp(`_id${this.ch.id}_`, 'i').test(n));
    $('k-dumps').innerHTML = mine.length ? mine.map(n => `<div class="item${this.dump?.name === n ? ' on' : ''}" data-f="${esc(n)}">${esc(n.replace(/^CharacterCams_dump_/i, ''))}</div>`).join('')
      : `<div class="hint" style="padding:6px 10px">No F8 dumps for ${esc(this.ch.name)} in this folder. In game, drive as ${esc(this.ch.name)} and press F8 (hold R for the R view).</div>`;
    $('k-presetsrc').innerHTML = this.presetSrc ? `Preset values: <b>${esc(this.presetSrc)}</b>`
      : '<span class="warn">No CharacterCams_presets.bin yet</span>: preset values are partly built in (see "Base preset"). Press F8 once in game with CharacterCams 0.9 to write it.';
  }
  async openDump(n) {
    try { this.dump = parseDump(await api.bytes(n), n); this.afterDump(); } catch (e) { status(e.message, true); }
  }
  afterDump() {
    if (this.dump.id !== this.ch.id) { const c = CHARS.find(x => x.id === this.dump.id && !x.skin); if (c) { this.select(c, true); return; } }
    this.renderDumps(); this.update();
    status(`Dump ${this.dump.name}: identity ${this.dump.id}${this.dump.rHeld ? ', R held' : ''}`);
  }

  basePreset(addr) {
    if (this.presets?.game.has(addr)) return { ...this.presets.game.get(addr), src: 'measured' };
    if (BUILTIN[addr]) return { ...BUILTIN[addr], h: [...BUILTIN[addr].h], src: BUILTIN[addr].guess ? `built in (${BUILTIN[addr].guess} guessed)` : 'built in' };
    return null;
  }

  // ---------------------------------------------------------- character
  async select(c, keepDump = false) {
    this.ch = c;
    for (const it of $('k-chars').querySelectorAll('.item')) it.classList.toggle('on', CHARS[+it.dataset.i] === c);
    if (!keepDump || this.dump?.id !== c.id) this.dump = null;
    this.renderDumps();
    this.fillForm();
    if (this.vehicle) { this.vp.root.remove(this.vehicle.group); disposeGroup(this.vehicle.group); this.vehicle = null; }
    this.box = null;
    try {
      status(`Loading ${c.name}'s vehicle…`);
      const path = this.modelPath(c);
      if (!path) throw new Error(`${c.name} has no vehicle model in this game folder (camera numbers still shown)`);
      const model = await loadModel(path);
      const rest = await restPose(model);
      if (this.ch !== c) return;
      if (this.vehicle) { this.vp.root.remove(this.vehicle.group); disposeGroup(this.vehicle.group); }
      this.vehicle = buildMeshes(model);
      if (rest) skinMeshes(model, this.vehicle.meshes, rest);   // the pickup truck's bind pose lies on its side
      // The vehicle models face -z (Optimus's cab, Brawl's barrel). Turn them round so this tab's vehicle frame is
      // x right, y up, +z = the visual front, and "behind" is behind the visual rear.
      this.vehicle.group.rotation.y = Math.PI;
      this.vp.root.add(this.vehicle.group);
      this.vp.root.updateMatrixWorld(true);
      const mb = new THREE.Box3();
      for (const m of this.vehicle.meshes) { m.geometry.computeBoundingBox(); mb.union(m.geometry.boundingBox); }
      this.box = new THREE.Box3(new THREE.Vector3(-mb.max.x, mb.min.y, -mb.max.z), new THREE.Vector3(-mb.min.x, mb.max.y, -mb.min.z));
      this.modelPathShown = path;
      status(`${c.name}: ${path}`);
    } catch (e) { this.box = null; status(e.message, true); }
    this.update();
  }
  modelPath(c) {
    const want = `CHARS/${c.model}`.toUpperCase();
    const all = this.ghgs || [];
    let hit = all.find(p => p.toUpperCase() === want);
    if (!hit) { // folder only, or unusual name: a CAR* model in a folder named like the character
      const k = c.model.split('/')[0].toUpperCase();
      hit = all.find(p => p.toUpperCase().startsWith(`CHARS/${k}`) && /\/CAR[^/]*\.GHG$/i.test(p)) ||
            all.find(p => p.toUpperCase().includes(k) && /CAR[^/]*\.GHG$/i.test(p));
    }
    return hit || null;
  }

  // ---------------------------------------------------------- form
  fillForm() {
    const c = this.ch, own = iniSection(this.ini || '', c.sec);
    // a drone "_a" without its own section uses (and saves to) the plain drone's section, like the plugin
    this.saveSec = c.alt && !Object.keys(own).length ? c.alt : c.sec;
    const kv = { ...(PLUGIN_DEFAULTS[c.id] || {}), ...(c.alt ? iniSection(this.ini || '', c.alt) : {}), ...own };
    const sel = $('k-cam');
    sel.innerHTML = ['Default', 'Own', ...NAMED].map(n => `<option>${n}</option>`).join('');
    const cam = kv.CarCamera || 'Default';
    if (![...sel.options].some(o => o.value.toLowerCase() === cam.toLowerCase())) sel.insertAdjacentHTML('beforeend', `<option>${esc(cam)}</option>`);
    sel.value = [...sel.options].find(o => o.value.toLowerCase() === cam.toLowerCase()).value;
    const set = (id, k) => { $(id).value = kv[k] ?? ''; };
    set('k-dist', 'CarDistance'); set('k-near', 'CarNearDistance'); set('k-far', 'CarFarDistance');
    set('k-height', 'CarHeight'); set('k-pitch', 'CarPitchDegrees'); set('k-ignore', 'IgnoreRayHitsUnder');
    $('k-rview').value = /^on$/i.test(kv.RView || '') ? 'On' : 'Off';
    set('k-rh', 'RViewHeight'); set('k-rf', 'RViewForward');
    $('k-sec').textContent = this.saveSec === c.sec ? `[${c.sec}]` : `[${this.saveSec}] (shared with ${c.sec})`;
    if (c.novehicle) { $('k-stock').innerHTML = '<span class="warn">No vehicle form: the vehicle camera settings do nothing for this character.</span>'; this.dirty = false; return; }
    $('k-stock').innerHTML = (c.id >= 16 ? 'Past the game\'s camera table: CharacterCams 0.10+ needed for these settings to apply. ' : '') + `Stock: vehicle camera <b>${hex(c.b)}</b> (${esc(PRESET_NAMES[c.b] || '?')}), on foot ${hex(c.a)} (${esc(PRESET_NAMES[c.a] || '?')}).` +
      (c.r ? ` R view ${c.r[0]} / ${c.r[1]}.` : ' <span class="warn">No R view of its own: the camera ends up inside the vehicle.</span>') +
      (c.note ? ` ${esc(c.note)}.` : '') + (c.air ? ' <span class="warn">Aircraft: heli/jet steering reads the camera pitch.</span>' : '');
    this.dirty = false;
  }
  formValues() {
    const num = id => { const v = $(id).value.trim(); return v === '' ? null : +v; };
    return {
      cam: $('k-cam').value, dist: num('k-dist'), near: num('k-near'), far: num('k-far'), height: num('k-height') ?? 0,
      pitchDeg: num('k-pitch'), ignore: num('k-ignore') ?? 0, r: $('k-rview').value === 'On', rh: num('k-rh') ?? 1.5, rf: num('k-rf') ?? 9,
    };
  }
  async save() {
    const v = this.formValues(), s = x => (x == null ? '' : String(+x.toFixed(3)));
    const kv = {
      CarCamera: v.cam, CarDistance: s(v.dist), CarNearDistance: s(v.near), CarFarDistance: s(v.far), CarHeight: s(v.height),
      CarPitchDegrees: s(v.pitchDeg), IgnoreRayHitsUnder: s(v.ignore), RView: v.r ? 'On' : 'Off', RViewHeight: s(v.rh), RViewForward: s(v.rf),
    };
    // re-read first so edits made elsewhere (other sections) survive
    try { this.ini = await api.text(this.iniPath); } catch {}
    this.ini = iniWrite(this.ini || '', this.saveSec || this.ch.sec, kv);
    await api.save(this.iniPath, new TextEncoder().encode(this.ini));
    this.dirty = false;
    status(`Saved [${this.saveSec || this.ch.sec}] to ${this.iniPath}. In game: press F7 (a new CarCamera also needs a transform, respawn or swap).`);
    this.update();
  }

  // ---------------------------------------------------------- the camera model
  // Effective preset: the base preset with the form's fields on top, like CharacterCams' BuildVehiclePreset.
  effective() {
    const c = this.ch, v = this.formValues();
    let baseAddr = c.b;
    if (v.cam.toLowerCase() === 'default' || v.cam.toLowerCase() === 'own') baseAddr = c.b;
    else baseAddr = NAME_TO_ADDR[v.cam.toLowerCase()] ?? (/^0x/i.test(v.cam) ? parseInt(v.cam, 16) : c.b);
    const base = this.basePreset(baseAddr);
    const e = { baseAddr, base, fixed: v.cam.toLowerCase() !== 'default', ...v };
    if (!base) return { ...e, unknown: true };
    e.dist = base.dist; e.near = base.near; e.far = base.far; e.h = [...base.h]; e.pitch = base.pitch;
    if (e.fixed) {
      if (v.dist != null) e.dist = v.dist;
      if (v.near != null) e.near = v.near;
      if (v.far != null) e.far = v.far;
      e.h = e.h.map(x => x + v.height);
      if (v.pitchDeg != null) e.pitch = -Math.min(49, Math.max(17, Math.abs(v.pitchDeg))) * UNITS;
    }
    return e;
  }

  update() {
    if (!this.ch) return;
    this.marks.clear();
    const e = this.effective(), lines = [], warn = [];
    const t = +$('k-speed').value;
    $('k-speedv').textContent = t === 0 ? 'stopped' : t === 1 ? 'full speed' : `${Math.round(t * 100)}%`;
    const fov = +$('k-fov').value; $('k-fovv').textContent = `${fov}°`;
    this.gameCam.fov = this.rCam.fov = fov; this.gameCam.updateProjectionMatrix(); this.rCam.updateProjectionMatrix();
    const meshes = this.vehicle?.meshes || [];
    const ray = new THREE.Raycaster();
    const sphere = (p, color, r = 0.15) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), new THREE.MeshBasicMaterial({ color, depthTest: false })); m.position.copy(p); m.renderOrder = 5; this.marks.add(m); return m; };
    const line = (a, b, color) => { const g = new THREE.BufferGeometry().setFromPoints([a, b]); const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color, depthTest: false })); l.renderOrder = 4; this.marks.add(l); };

    if (e.unknown) {
      warn.push(`Preset ${hex(e.baseAddr)} has no values here yet. Press F8 in game (CharacterCams 0.9) to write CharacterCams_presets.bin, then Rescan.`);
      this.gameHelper.visible = this.rHelper.visible = false;
    } else {
      // Aim point: F8 dumps put it at the vehicle's origin (0 to 0.2 up), i.e. low inside a big body.
      const aim = new THREE.Vector3(0, 0.1, 0);
      const pitchRad = Math.abs(e.pitch) / UNITS * Math.PI / 180;
      const maxD = e.near + (e.far - e.near) * t;
      let d = Math.min(e.dist, maxD), why = maxD < e.dist ? `near/far limit at this speed (${fmt(maxD, 2)})` : 'base distance';
      if (d < 0.5) { d = 0.5; why = `near/far limit (${fmt(maxD, 2)}, clamped)`; }
      const dir = new THREE.Vector3(0, Math.sin(pitchRad), -Math.cos(pitchRad));   // game frame: up and behind
      // ray against the vehicle's own mesh (the game uses collision geometry; the drawn mesh is a stand-in)
      const aimW = g2w(aim.x, aim.y, aim.z), dirW = g2w(dir.x, dir.y, dir.z).normalize();
      ray.set(aimW, dirW); ray.far = d;
      const hit = meshes.length ? ray.intersectObjects(meshes, false)[0] : null;
      const lastHit = hit ? (() => { ray.far = d; const all = ray.intersectObjects(meshes, false); return all[all.length - 1]; })() : null;
      // The game casts against collision shapes, not this drawn mesh, and small cars (Bumblebee) don't hit
      // themselves in game, so this is a guide only: Bonecrusher measured a hit at 5.56 with a 4.8 tail.
      let rayTxt = 'leaves the drawn model without touching it';
      let rayBad = false;
      if (hit) {
        const out = lastHit.distance;   // where the ray finally leaves the drawn body
        if (e.ignore > 0 && out + 1 <= e.ignore) rayTxt = `leaves the drawn model at ${fmt(out, 2)}: <span class="ok">covered</span> by IgnoreRayHitsUnder ${fmt(e.ignore, 2)}`;
        else {
          rayBad = e.ignore > 0;
          rayTxt = `leaves the drawn model at ${fmt(out, 2)}. ` + (e.ignore > 0
            ? `<span class="warn">IgnoreRayHitsUnder ${fmt(e.ignore, 2)} leaves under 1 unit of margin</span>; try ${Math.ceil(out + 1.5)}`
            : `If the camera sits on his back in game (live distance below base in an F8 dump), set IgnoreRayHitsUnder to ~${Math.ceil(out + 1.5)}`);
        }
        sphere(lastHit.point, 0xff8844, 0.12);
      }
      const eye = aim.clone().addScaledVector(dir, d);
      eye.y += e.h[0];   // the height offsets move the camera, not the aim point
      const eyeW = g2w(eye.x, eye.y, eye.z);
      this.gameCam.position.copy(eyeW); this.gameCam.up.set(0, 1, 0); this.gameCam.lookAt(aimW);
      this.gameCam.updateMatrixWorld(); this.syncHelper(this.gameCam, this.gameProxy, this.gameHelper);
      sphere(aimW, 0xffe14d, 0.12);
      line(aimW, eyeW, rayBad ? 0xe0605a : 0x6cc07a);
      this.marks.visible = !$('k-look').checked;
      if (e.ignore > 0) { // ring: hits inside it are ignored
        const ring = new THREE.Mesh(new THREE.RingGeometry(e.ignore - 0.03, e.ignore + 0.03, 64), new THREE.MeshBasicMaterial({ color: 0x6cc07a, side: THREE.DoubleSide, transparent: true, opacity: 0.6, depthTest: false }));
        ring.rotation.x = -Math.PI / 2; ring.position.copy(aimW); this.marks.add(ring);
      }
      const above = eye.y - aim.y, behind = -eye.z;
      lines.push(['Base preset', `${hex(e.baseAddr)} ${esc(PRESET_NAMES[e.baseAddr] || '')} <span class="hint">(${esc(e.base.src)})</span>`]);
      lines.push(['Distance', `${fmt(e.dist, 2)} base · near ${fmt(e.near, 2)} → far ${fmt(e.far, 2)}${e.far < e.near ? ' <span class="warn">(zooms in as you speed up)</span>' : ''}`]);
      lines.push([`At ${$('k-speedv').textContent}`, `${fmt(d, 2)} <span class="hint">(${why})</span>`]);
      lines.push(['Pitch', `${fmt(Math.abs(e.pitch) / UNITS, 1)}° down <span class="hint">(${Math.round(e.pitch)} units)</span>`]);
      lines.push(['Heights', e.h.map(x => fmt(x, 2)).join(' / ')]);
      lines.push(['Camera (estimate)', `${fmt(behind, 2)} behind, ${fmt(above, 2)} above the aim point`]);
      lines.push(['Collision ray', rayTxt]);
      if (this.box && eye.y < this.box.max.y && behind > 0 && -this.box.min.z > behind - 0.5) warn.push('Camera is level with or below the roof while close behind: likely sitting against the back.');

      // R view: camera in front, looking back at the vehicle
      const [rh, rf] = e.r ? [e.rh, e.rf] : (this.ch.r || [0, -2.5]);
      const rEye = g2w(0, rh, rf);
      this.rLook = g2w(0, rh * 0.5, 0); this.aimW = aimW;
      this.rCam.position.copy(rEye); this.rCam.up.set(0, 1, 0); this.rCam.lookAt(this.rLook);
      this.rCam.updateMatrixWorld(); this.syncHelper(this.rCam, this.rProxy, this.rHelper);
      const rInside = this.box && this.box.containsPoint(new THREE.Vector3(0, rh, rf));
      lines.push(['R view', `${fmt(rh, 2)} high, ${fmt(rf, 2)} in front ${e.r ? '<span class="hint">(INI)</span>' : this.ch.r ? '<span class="hint">(game)</span>' : '<span class="hint">(game fallback)</span>'}` +
        (this.box ? ` · front of model ${fmt(this.box.max.z, 2)}` : '') + (rInside ? ' <span class="warn">inside the vehicle</span>' : '')]);
      if (rInside) warn.push('R view camera is inside the vehicle model.');
    }
    if (this.box) lines.push(['Vehicle', `${fmt(this.box.max.x - this.box.min.x, 2)} wide, ${fmt(this.box.max.y - this.box.min.y, 2)} tall, ${fmt(this.box.max.z - this.box.min.z, 2)} long · front ${fmt(this.box.max.z, 2)}, back ${fmt(-this.box.min.z, 2)} from centre`]);
    $('k-result').innerHTML = `<table class="kv">${lines.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('')}</table>` +
      (warn.length ? `<div class="warn" style="margin-top:6px">${warn.map(esc).join('<br>')}</div>` : '');
    this.showDump(sphere, line);
    // main view through the game camera?
    const look = $('k-look').checked && !e.unknown, C = this.vp.camera, ctl = this.vp.controls;
    if (look) {
      if (!this.orbitSaved) this.orbitSaved = { pos: C.position.clone(), target: ctl.target.clone() };
      const r = $('k-rlook').checked, cam = r ? this.rCam : this.gameCam;
      C.position.copy(cam.position); ctl.target.copy(r ? this.rLook : this.aimW);
      C.fov = fov; ctl.enabled = false;
    } else {
      if (this.orbitSaved) { C.position.copy(this.orbitSaved.pos); ctl.target.copy(this.orbitSaved.target); this.orbitSaved = null; }
      C.fov = 45; ctl.enabled = true;
    }
    C.updateProjectionMatrix(); C.lookAt(ctl.target);
    $('k-save').classList.toggle('primary', !!this.dirty);
  }

  syncHelper(cam, proxy, helper) {
    proxy.position.copy(cam.position); proxy.quaternion.copy(cam.quaternion); proxy.fov = cam.fov;
    proxy.updateProjectionMatrix(); proxy.updateMatrixWorld(); helper.update();
    helper.visible = !$('k-look').checked;
  }

  showDump(sphere, line) {
    const d = this.dump;
    if (!d) { $('k-dump').innerHTML = '<span class="hint">Pick a dump on the left, or open a .bin.</span>'; return; }
    const p = d.preset, rows = [];
    rows.push(['File', esc(d.name) + (d.rHeld ? ' <span class="tag">R held</span>' : '')]);
    rows.push(['Active preset', `${hex(d.presetAddr)} ${esc(PRESET_NAMES[d.presetAddr] || (d.presetAddr > 0x10000000 ? 'CharacterCams copy' : ''))}`]);
    rows.push(['Distance', `live <b>${fmt(p.live, 2)}</b> · base ${fmt(p.dist, 2)} · near ${fmt(p.near, 2)} → far ${fmt(p.far, 2)}`]);
    rows.push(['Pitch', `live ${fmt(Math.abs(p.pitchLive) / UNITS, 1)}° · default ${fmt(Math.abs(p.pitch) / UNITS, 1)}°`]);
    rows.push(['Heights', p.h.map(x => fmt(x, 2)).join(' / ')]);
    const notes = [];
    if (p.live < p.dist - 0.25) notes.push(`Live distance ${fmt(p.live, 2)} is below the base ${fmt(p.dist, 2)}: something is pulling the camera in (the near/far limit or the collision ray; CHARACTER_CAMERAS.md section 4).`);
    if (p.far < p.near) notes.push('Far is smaller than near: the camera zooms in as the vehicle speeds up.');
    if (d.frame) {
      const aim = toLocal(d.frame, d.aim), rig = toLocal(d.frame, p.rig);
      rows.push(['Aim point', `${fmt(aim[2], 2)} forward, ${fmt(aim[1], 2)} up, ${fmt(aim[0], 2)} right of the vehicle's origin`]);
      rows.push(['Chase rig', `${fmt(-rig[2], 2)} behind, ${fmt(rig[1], 2)} up, ${fmt(rig[0], 2)} right <span class="hint">(preset +0x30; not the R view)</span>`]);
      const aW = g2w(aim[0], aim[1], aim[2]), rW = g2w(rig[0], rig[1], rig[2]);
      sphere(aW, 0xffffff, 0.1); sphere(rW, 0x5aa9e6, 0.22); line(aW, rW, 0x5aa9e6);
    } else rows.push(['Vehicle', '<span class="hint">no car block (aircraft or on foot): positions not shown</span>']);
    $('k-dump').innerHTML = `<table class="kv">${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('')}</table>` +
      (notes.length ? `<div class="warn" style="margin-top:6px">${notes.map(esc).join('<br>')}</div>` : '');
  }

  // picture-in-picture: what the game camera (estimate) and R camera see
  renderInset() {
    if (!$('k-inset').checked || !this.ch || $('k-look').checked) return;
    const r = this.vp.renderer, W = r.domElement.clientWidth, H = r.domElement.clientHeight;
    const w = Math.min(320, W * 0.3), h = w * 3 / 4;
    const hide = [this.gameHelper, this.rHelper, this.grid].map(o => [o, o.visible]);
    this.gameHelper.visible = this.rHelper.visible = false;
    r.autoClear = false; r.setScissorTest(true);
    for (const [cam, k] of [[this.gameCam, 0], [this.rCam, 1]]) {
      const x = W - w - 12, y = 12 + k * (h + 8);
      r.setViewport(x, y, w, h); r.setScissor(x, y, w, h); r.clear();
      r.render(this.vp.scene, cam);
    }
    r.setScissorTest(false); r.setViewport(0, 0, W, H); r.autoClear = true;
    for (const [o, v] of hide) o.visible = v;
  }
}
