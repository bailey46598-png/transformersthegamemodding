// .AN3 skeletal animation reader (tag "4INA").
// Curve decoding follows the MIT-licensed reader in github.com/Snufflebox/TTGames-Workshop (cu2.py Block),
// checked here against Transformers: The Game PC data:
//   header @4  u16 bones, u16 samples, u16 groupBytes (4 x animated curves), u16 sourceFrames, u16 channels (9), u16 start
//          @28 f32 constBase (-PI), f32 constScale (PI/32768)
//          @36 u32 -> curve params {f32 scale, f32 low}, @40 -> constant pool (u16), @44 -> key-type table (u16 per channel),
//          @48 -> keys (u32), @52 -> end of keys, @60 clip name
//   channels per bone: tx ty tz | rx ry rz (radians) | sx sy sz, stored mirrored in Z relative to the model:
//   use (tx, ty, -tz) and rotations (-rx, -ry, rz) in D3D order (X then Y then Z). Done in ModelView.computePose.
//   (checked: translations then equal the bind skeleton's offsets; feet stay planted through idle clips)
//   key type >= 16: constant pool[k-16]; 6: 8-bit anchor every 4 samples + 6-bit blend per sample (1 word);
//   7: 16-bit anchor + 12-bit blends (2 words); 8/10: one byte per sample.
//   The samples cover `sourceFrames` frames (the clip plays at the config's RATE, default 30 fps).

export class AN3 {
  constructor(buffer, name = '') {
    const dv = new DataView(buffer), u8 = new Uint8Array(buffer);
    const tag = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
    if (tag !== '4INA') throw new Error(`not an AN3 clip (tag ${tag})`);
    this.file = name;
    this.bones = dv.getUint16(4, true);
    this.samples = dv.getUint16(6, true);
    this.group = dv.getUint16(8, true);
    this.sourceFrames = dv.getUint16(10, true) || this.samples;
    this.channels = dv.getUint16(12, true);
    const cbase = dv.getFloat32(28, true), cscale = dv.getFloat32(32, true);
    const sm = dv.getUint32(36, true), cp = dv.getUint32(40, true), ktp = dv.getUint32(44, true);
    const kp = dv.getUint32(48, true), csf = dv.getUint32(52, true);
    let e = 60; while (e < Math.min(u8.length, 92) && u8[e]) e++;
    this.name = new TextDecoder('latin1').decode(u8.subarray(60, e));
    const nConst = Math.max(0, (ktp - cp) >> 1);
    this.constants = new Float32Array(nConst);
    for (let i = 0; i < nConst; i++) this.constants[i] = cbase + dv.getUint16(cp + 2 * i, true) * cscale;
    const nk = this.bones * this.channels;
    this.keyTypes = new Uint16Array(nk);
    for (let i = 0; i < nk; i++) this.keyTypes[i] = dv.getUint16(ktp + 2 * i, true);
    this.slots = this.group >> 2;
    this.segments = this.slots ? Math.floor(((csf - kp) >> 2) / this.slots) : 0;
    this.keys = new Uint32Array(this.slots * this.segments);
    for (let i = 0; i < this.keys.length; i++) this.keys[i] = dv.getUint32(kp + 4 * i, true);
    // assign key slots and curve params in key-type order
    this.slotOf = new Int32Array(nk).fill(-1);
    this.curveOf = new Int32Array(nk).fill(-1);
    this.params = [];
    let slot = 0, curve = 0;
    for (let i = 0; i < nk; i++) {
      const k = this.keyTypes[i];
      if (k >= 16) continue;
      this.slotOf[i] = slot;
      if (k === 6 || k === 7) {
        this.curveOf[i] = curve;
        this.params.push([dv.getFloat32(sm + 8 * curve, true), dv.getFloat32(sm + 8 * curve + 4, true)]);
        curve++;
        slot += k === 7 ? 2 : 1;
      } else slot += 1;
    }
    this.animatedChannels = curve;
    this.warnings = [];
    if (this.channels !== 9) this.warnings.push(`${this.channels} channels per bone (only 9 is verified)`);
    if (slot !== this.slots) this.warnings.push(`key slots ${slot} != header ${this.slots}`);
    for (let i = 0; i < nk; i++) { const k = this.keyTypes[i]; if (k < 16 && ![6, 7, 8, 10].includes(k)) { this.warnings.push(`unknown key type ${k}`); break; } }
    for (let i = 0; i < nk; i++) { const k = this.keyTypes[i]; if (k >= 16 && k - 16 >= nConst) { this.warnings.push('constant index past the pool'); break; } }
  }

  // value of one channel at an integer sample
  channelAt(i, f) {
    const k = this.keyTypes[i];
    if (k >= 16) return this.constants[k - 16] ?? 0;
    const segs = this.segments;
    if (!segs) return 0;
    const seg = Math.min(f >> 2, segs - 1), nxt = Math.min(seg + 1, segs - 1), slot = this.slotOf[i];
    const a = this.keys[seg * this.slots + slot];
    if (k === 8 || k === 10) return (a >>> (8 * (f & 3))) & 0xFF;
    const [scale, low] = this.params[this.curveOf[i]];
    let a0, a1, blend;
    if (k === 6) {
      a0 = a & 0xFF; a1 = this.keys[nxt * this.slots + slot] & 0xFF;
      blend = ((a >>> (8 + 6 * (f & 3))) & 63) / 63;
    } else {
      const b = this.keys[seg * this.slots + slot + 1];
      a0 = a & 0xFFFF; a1 = this.keys[nxt * this.slots + slot] & 0xFFFF;
      const bl = [(a >>> 16) & 0xFFF, b & 0xFFF, (b >>> 16) & 0xFFF, ((b >>> 28) << 8) | (((b >>> 12) & 0xF) << 4) | (a >>> 28)];
      blend = bl[f & 3] / 4095;
    }
    return low + scale * (a0 + (a1 - a0) * blend);
  }

  // Pose at a source frame (float). Returns Float32Array(bones*9), linear between samples.
  pose(frame, out = new Float32Array(this.bones * this.channels)) {
    const last = Math.max(this.samples - 1, 0);
    const s = this.sourceFrames > 0 ? frame * this.samples / this.sourceFrames : 0;
    const s0 = Math.max(0, Math.min(Math.floor(s), last)), s1 = Math.min(s0 + 1, last), t = Math.min(Math.max(s - s0, 0), 1);
    const n = this.bones * this.channels;
    for (let i = 0; i < n; i++) {
      const v0 = this.channelAt(i, s0);
      if (this.keyTypes[i] >= 16 || s1 === s0 || t === 0) { out[i] = v0; continue; }
      let v1 = this.channelAt(i, s1);
      const ch = i % this.channels;
      if (ch >= 3 && ch < 6) { // shortest way round for angles
        while (v1 - v0 > Math.PI) v1 -= 2 * Math.PI;
        while (v0 - v1 > Math.PI) v1 += 2 * Math.PI;
      }
      out[i] = v0 + (v1 - v0) * t;
    }
    return out;
  }

  isAnimated(bone, ch) { return this.keyTypes[bone * this.channels + ch] < 16; }
}
