// Cutscene (.CU2) reader for Transformers: The Game PC (versions 517 and 519).
// Layout from the MIT-licensed notes in github.com/Snufflebox/TTGames-Workshop (formats/classic-pc/tools/cu2.py),
// re-checked here on all 64 cutscenes in CUT\.
//
// The file is a memory image: pointers are absolute, the load address is the u32 at 4 (again at 0x28).
//   0x00 u32 version   0x08 f32 length in frames   0x0C -> names (1-based offsets elsewhere)
//   0x10 -> cameras    0x14 -> objects   0x18 -> characters   0x1C -> effects (not read)   0x5C f32 fps (0 = 30)
// cameras:    u32 count, -> camera array (0x50 each), -> animation block (one node per camera), -> cut table,
//             u8 starting camera.  camera: 4x4 matrix, u8 animated, u8 id, u8 node in the block, u8 ?
// cut table:  u16 count, u16 length, -> f32 frames, -> u8 camera index (255 = none)
// objects:    -> array (0x5C each), u32 count.  object: matrix, u32 name, 2 x u32, -> animation block
// characters: -> array (0x64 each), u32 count.  character: matrix, u32 name, -> root block (1 node: where the
//             character is), -> skeleton block (one node per bone), -> a third track (not read)
// Animation blocks are .AN3 clips (tag "4INA") embedded in the file; the u16 at 14 is the cutscene frame the
// block starts on, so a block only covers [start, start + frames).
import { AN3 } from './an3.js';

export const NO_CAMERA = 255;

export class Cutscene {
  constructor(buffer, name = '') {
    this.buffer = buffer;
    const dv = this.dv = new DataView(buffer), u8 = this.u8 = new Uint8Array(buffer);
    this.name = name;
    this.version = dv.getUint32(0, true);
    this.base = dv.getUint32(4, true);
    if (![516, 517, 519, 520].includes(this.version)) throw new Error(`cutscene version ${this.version} is not supported`);
    this.frames = Math.round(dv.getFloat32(8, true));
    const fps = dv.getFloat32(0x5C, true);
    this.fps = fps > 0 && fps <= 240 ? fps : 30;
    this.notes = [];
    this.blocks = new Map();
    const P = o => this.ptr(o);
    this.namesAt = P(0x0C);

    // cameras
    this.cameras = []; this.cuts = []; this.cameraBlock = null; this.startCamera = 0;
    const c = P(0x10);
    if (c) {
      const n = dv.getUint32(c, true), arr = P(c + 4), blk = P(c + 8), cut = P(c + 12);
      this.startCamera = u8[c + 16];
      for (let i = 0; i < n && arr; i++) {
        const o = arr + i * 0x50;
        this.cameras.push({ index: i, matrix: this.mat(o), animated: u8[o + 0x40], id: u8[o + 0x41], node: u8[o + 0x42], extra: u8[o + 0x43],
          raw: [dv.getFloat32(o + 0x44, true), dv.getFloat32(o + 0x48, true), dv.getFloat32(o + 0x4C, true)] });
      }
      this.cameraBlock = this.block(blk);
      if (cut) {
        const k = dv.getUint16(cut, true), fa = P(cut + 4), ca = P(cut + 8);
        for (let i = 0; i < k && fa && ca; i++) this.cuts.push({ frame: dv.getFloat32(fa + 4 * i, true), camera: u8[ca + i] });
      }
    }
    // objects (pieces of the level scene that the cutscene moves)
    this.objects = [];
    const ob = P(0x14);
    if (ob) {
      const arr = P(ob), n = dv.getUint32(ob + 4, true);
      for (let i = 0; i < n && arr; i++) {
        const o = arr + i * 0x5C;
        this.objects.push({ index: i, name: this.str(dv.getUint32(o + 0x40, true)), matrix: this.mat(o), block: this.block(P(o + 0x4C)),
          visibility: this.switches(P(o + 0x50)) });
      }
    }
    // characters
    this.characters = [];
    const ch = P(0x18);
    if (ch) {
      const arr = P(ch), n = dv.getUint32(ch + 4, true);
      for (let i = 0; i < n && arr; i++) {
        const o = arr + i * 0x64;
        const root = this.block(P(o + 0x44)), skeleton = this.block(P(o + 0x48));
        if (root) trimRootConstants(root);
        // On screen from the root block's first frame to the end of the longer of its two blocks (assumed: a
        // skeleton block that starts before the root block, like a car's 1-frame pose at 0, doesn't count)
        const from = root ? root.start : skeleton ? skeleton.start : 0;
        let to = root ? root.start + root.sourceFrames : from;
        if (skeleton && skeleton.start >= from) to = Math.max(to, skeleton.start + skeleton.sourceFrames);
        // 1-frame tracks (standing extras, e.g. A5_CH1_OUTRO's energon drones): assumed to stay to the end
        if (to - from <= 1) to = this.frames;
        this.characters.push({ index: i, name: this.str(dv.getUint32(o + 0x40, true)), matrix: this.mat(o), root, skeleton, from, to });
      }
    }
  }

  // u16 count, u16 length, -> f32 frames, -> u8 values (the layout of the cut table): [{frame, value}]
  switches(at) {
    if (!at) return null;
    const n = this.dv.getUint16(at, true), fa = this.ptr(at + 4), va = this.ptr(at + 8), out = [];
    for (let i = 0; i < n && fa && va; i++) out.push({ frame: this.dv.getFloat32(fa + 4 * i, true), value: this.u8[va + i] });
    return out;
  }

  ptr(o) { const v = this.dv.getUint32(o, true); return v > this.base && v < this.base + this.u8.length ? v - this.base : 0; }
  mat(o) { const m = new Array(16); for (let i = 0; i < 16; i++) m[i] = this.dv.getFloat32(o + 4 * i, true); return m; }
  str(off) {
    if (!off || !this.namesAt) return '';
    let s = this.namesAt + off - 1, e = s;
    while (e < this.u8.length && this.u8[e]) e++;
    return new TextDecoder('latin1').decode(this.u8.subarray(s, e));
  }
  // an embedded clip, with its starting frame
  block(at) {
    if (!at) return null;
    if (this.blocks.has(at)) return this.blocks.get(at);
    let b = null;
    try {
      b = new AN3(this.buffer.slice(at), `${this.name}@${at.toString(16)}`);
      b.start = this.dv.getUint16(at + 14, true);
      b.at = at;
    } catch (e) { this.notes.push(`animation block at 0x${at.toString(16)}: ${e.message}`); }
    this.blocks.set(at, b);
    return b;
  }

  get seconds() { return this.frames / this.fps; }

  // the shots as played: [{from, to, camera}] within 0..frames (camera null = no cutscene camera)
  get shots() {
    if (this._shots) return this._shots;
    const out = [];
    if (!this.cuts.length) {
      if (this.cameras.length) out.push({ from: 0, to: this.frames, camera: Math.min(this.startCamera, this.cameras.length - 1) });
    } else {
      // cuts at or before frame 1 decide the camera at the start (some lie before 0)
      const early = this.cuts.filter(c => c.frame < 2);
      const marks = [{ frame: 0, camera: early.length ? early[early.length - 1].camera : this.cuts[0].camera }];
      for (const c of this.cuts) if (c.frame >= 2 && c.frame < this.frames) marks.push({ frame: Math.round(c.frame), camera: c.camera });
      marks.forEach((m, i) => {
        const to = i + 1 < marks.length ? marks[i + 1].frame : this.frames;
        if (to > m.frame) out.push({ from: m.frame, to, camera: m.camera === NO_CAMERA ? null : m.camera });
      });
    }
    return (this._shots = out);
  }
  shotAt(frame) {
    const s = this.shots;
    for (const x of s) if (frame >= x.from && frame < x.to) return x;
    return s[s.length - 1] || null;
  }
}

// A character's root block (12 channels) keeps extra values in front of its constant pool: the constants its
// key types use are the LAST ones before the key-type table. Checked on all 401 root blocks: where tx and tz are
// constants they then equal the character's stored position (80 of 82 within 0.05, the other 2 within 0.6).
// Camera, skeleton and object blocks don't have the extra values.
function trimRootConstants(b) {
  let mx = -1;
  for (const t of b.keyTypes) if (t >= 16) mx = Math.max(mx, t - 16);
  const extra = b.constants.length - (mx + 1);
  if (extra > 0) b.constants = b.constants.slice(extra);
}

// Object visibility: the table lists frames where it switches (1 = shown, 0 = hidden). Before the first switch it
// is assumed to be in the opposite state (pumps that appear when their animation starts, a screen border that is
// shown from frame 1 to 41).
export function objectVisible(o, frame) {
  const v = o.visibility;
  if (!v?.length) return true;
  let on = !v[0].value;
  for (const s of v) { if (frame >= s.frame) on = !!s.value; else break; }
  return on;
}

// Game-space row-form world matrix of a pose (tx ty tz rx ry rz sx sy sz) stored the way .AN3 clips are:
// mirrored in Z, so (tx, ty, -tz) and rotations (-rx, -ry, rz). Checked on cutscene cameras and character roots
// against their stored matrices.
export function poseMatrix(M4, p, scale = true) {
  return M4.compose([p[0], p[1], -p[2]], [-p[3], -p[4], p[5]], scale ? [p[6], p[7], p[8]] : [1, 1, 1]);
}

// value of one node's 9 (or more) channels from a block at a cutscene frame (null outside the block's range)
export function blockPose(b, frame, node = 0, clamp = false) {
  if (!b) return null;
  let f = frame - b.start;
  if (f < 0 || f > b.sourceFrames - 1) { if (!clamp) return null; f = Math.max(0, Math.min(f, b.sourceFrames - 1)); }
  const vals = b.pose(f);
  return vals.subarray(node * b.channels, (node + 1) * b.channels);
}
