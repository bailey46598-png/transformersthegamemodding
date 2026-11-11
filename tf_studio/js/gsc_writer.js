// Rebuild a PC .GSC (or .GHG) file from its parts, so edits may change sizes and move things.
// Port of mods/wii_tools/pcnu20.py (split_pc / build_nu20 / build_gsc), extended for layout changes.
//
// File = container prefix + NU20 block:
//   u32 modelOffset; u16 slotCount; texture entries; u16 nVB {u32 size, bytes}; u16 nIB {u32 size, bytes};
//   zero padding so modelOffset ends in 0xC0; "NU20" at modelOffset + 4.
// NU20 = 16-byte header {NU20, -total, 1, 0}, then chunks {tag, u32 size, body}, then PNTR.
// Pointers are self-relative i32. PNTR lists every pointer field (as self-relative i32 too), except
// the first word of HEAD's body, which points at PNTR's count and is not listed.
//
// Here every listed pointer is held as (chunk, offset) -> (chunk, offset), so chunk bodies can grow
// or shrink and the writer recomputes every value. Pointer fields keep their PNTR order, so an
// unedited file rebuilds byte for byte.

const enc = s => [...s].map(c => c.charCodeAt(0));

export class GSCFile {
  static fromBuffer(buffer) {
    const f = new GSCFile();
    const u8 = new Uint8Array(buffer), dv = new DataView(buffer);
    f.slotCount = dv.getUint16(4, true);
    // container prefix: texture entries (kept as raw entries), vertex and index buffers
    let o = 6;
    f.textures = [];
    for (;;) {
      const w = dv.getInt32(o, true), h = dv.getInt32(o + 4, true), z = dv.getInt32(o + 16, true), size = dv.getUint32(o + 20, true);
      const isDDS = u8[o + 24] === 0x44 && u8[o + 25] === 0x44 && u8[o + 26] === 0x53 && u8[o + 27] === 0x20;
      const empty = size === 0 && z === 0 && ((w > 0 && w <= 4096) || (w < 0 && w >= -4096)) && h > 0 && h <= 4096;
      if (!(isDDS || empty)) break;
      f.textures.push({ head: u8.slice(o, o + 20), dds: u8.slice(o + 24, o + 24 + size) });
      o += 24 + size;
    }
    const buffers = () => {
      const n = dv.getUint16(o, true), out = []; o += 2;
      for (let i = 0; i < n; i++) { const s = dv.getUint32(o, true); out.push(u8.slice(o + 4, o + 4 + s)); o += 4 + s; }
      return out;
    };
    f.vbs = buffers(); f.ibs = buffers();
    f.prefixPad = u8.slice(o, dv.getUint32(0, true) + 4); // normally zeros
    const B = dv.getUint32(0, true) + 4;
    if (String.fromCharCode(...u8.subarray(B, B + 4)) !== 'NU20') throw new Error('No NU20 block');
    const nb = u8.subarray(B), ndv = new DataView(buffer, B);
    f.nuHeader = nb.slice(8, 16); // version 1, 0
    // chunks
    const spans = [];
    let p = 0x10, pntr = null;
    while (p + 8 <= nb.length) {
      const tag = String.fromCharCode(nb[p], nb[p + 1], nb[p + 2], nb[p + 3]), size = ndv.getUint32(p + 4, true);
      if (size < 8 || p + size > nb.length) throw new Error(`bad chunk ${tag} at 0x${p.toString(16)}`);
      if (tag === 'PNTR') { pntr = { p, size }; break; }
      spans.push({ tag, p, size });
      p += size;
    }
    if (!pntr) throw new Error('no PNTR chunk');
    f.pntrPad = pntr.size;
    f.chunks = spans.map(s => ({ tag: s.tag, body: nb.slice(s.p + 8, s.p + s.size) }));
    // where an NU20 address falls: [chunk, offset from body start]; a chunk's 8-byte header counts as offsets -8..-1
    const starts = spans.map(s => s.p);
    const locate = a => {
      let lo = 0, hi = spans.length - 1, k = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (starts[m] <= a) { k = m; lo = m + 1; } else hi = m - 1; }
      if (k < 0 || a >= spans[k].p + spans[k].size) return null;
      return [k, a - (spans[k].p + 8)];
    };
    const n = ndv.getInt32(pntr.p + 8, true);
    f.fields = new Array(n);
    for (let k = 0; k < n; k++) {
      const slot = pntr.p + 12 + 4 * k, fa = slot + ndv.getInt32(slot, true);
      const where = locate(fa);
      if (!where) throw new Error(`pointer field 0x${fa.toString(16)} is outside every chunk`);
      const v = ndv.getInt32(fa, true);
      let target = null;
      if (v !== 0) {
        const t = locate(fa + v);
        target = t ? { c: t[0], off: t[1] } : { raw: v }; // raw: runtime junk values the game overwrites; kept as stored
      }
      f.fields[k] = { c: where[0], off: where[1], target };
    }
    f.headIdx = f.chunks.findIndex(c => c.tag === 'HEAD');
    f.reindex();
    return f;
  }

  reindex() { this.byField = new Map(this.fields.map(fl => [fl.c + ':' + fl.off, fl])); }
  chunkIndex(tag) { const i = this.chunks.findIndex(c => c.tag === tag); if (i < 0) throw new Error(`no ${tag} chunk`); return i; }
  body(tag) { return this.chunks[this.chunkIndex(tag)].body; }

  // ---- editing primitives (offsets are chunk-body offsets) ----
  // Pointer at (tag, off): returns {tag, off} | null | {raw}
  getPointer(tag, off) {
    const fl = this.byField.get(this.chunkIndex(tag) + ':' + off);
    if (!fl || !fl.target) return null;
    return fl.target.raw != null ? { raw: fl.target.raw } : { tag: this.chunks[fl.target.c].tag, off: fl.target.off };
  }
  // Make (tag, off) a pointer to (ttag, toff), or null. New fields go at the end of PNTR.
  setPointer(tag, off, ttag, toff) {
    const c = this.chunkIndex(tag), key = c + ':' + off;
    const target = ttag == null ? null : { c: this.chunkIndex(ttag), off: toff };
    let fl = this.byField.get(key);
    if (!fl) { fl = { c, off, target }; this.fields.push(fl); this.byField.set(key, fl); } else fl.target = target;
  }
  // Insert bytes into a chunk body at `at`. Every pointer field and target at or after `at` in that chunk
  // moves with the data. (A pointer to exactly `at` keeps pointing at the old data, now at at + n.)
  insert(tag, at, bytes) {
    const c = this.chunkIndex(tag), ch = this.chunks[c];
    if (at < 0 || at > ch.body.length) throw new Error(`insert outside ${tag}`);
    const add = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const nb = new Uint8Array(ch.body.length + add.length);
    nb.set(ch.body.subarray(0, at)); nb.set(add, at); nb.set(ch.body.subarray(at), at + add.length);
    ch.body = nb;
    const n = add.length;
    for (const fl of this.fields) {
      if (fl.c === c && fl.off >= at) fl.off += n;
      if (fl.target && fl.target.c === c && fl.target.off >= at) fl.target.off += n;
    }
    this.reindex();
    return at;
  }
  // Append bytes (aligned) to the end of a chunk body; nothing else moves. Returns the offset.
  append(tag, bytes, align = 16) {
    const ch = this.chunks[this.chunkIndex(tag)];
    const at = ch.body.length + ((-ch.body.length) % align + align) % align;
    const add = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const nb = new Uint8Array(at + add.length);
    nb.set(ch.body); nb.set(add, at);
    ch.body = nb;
    return at;
  }
  // Remove bytes [at, at+n) from a chunk. Pointer fields inside the range are dropped; targets inside it
  // are an error (something still uses that data).
  remove(tag, at, n) {
    const c = this.chunkIndex(tag), ch = this.chunks[c];
    for (const fl of this.fields) if (fl.target && fl.target.c === c && fl.target.off >= at && fl.target.off < at + n && !(fl.c === c && fl.off >= at && fl.off < at + n))
      throw new Error(`${tag}+0x${fl.target.off.toString(16)} is still pointed to`);
    this.fields = this.fields.filter(fl => !(fl.c === c && fl.off >= at && fl.off < at + n));
    for (const fl of this.fields) {
      if (fl.c === c && fl.off >= at + n) fl.off -= n;
      if (fl.target && fl.target.c === c && fl.target.off >= at + n) fl.target.off -= n;
    }
    const nb = new Uint8Array(ch.body.length - n);
    nb.set(ch.body.subarray(0, at)); nb.set(ch.body.subarray(at + n), at);
    ch.body = nb;
    this.reindex();
  }

  // Replace bytes [at, at+len) of a chunk with new bytes of any length. Every pointer into the old range must be
  // listed in `retarget` (old chunk offset -> offset inside the new bytes); anything else pointing in is an error.
  replaceRegion(tag, at, len, bytes, retarget) {
    const c = this.chunkIndex(tag), moved = [];
    for (const fl of this.fields) {
      if (!fl.target || fl.target.c !== c || fl.target.off < at || fl.target.off >= at + len) continue;
      if (!retarget.has(fl.target.off)) throw new Error(`${tag}+0x${fl.target.off.toString(16)} is pointed to but not retargeted`);
      moved.push([fl, retarget.get(fl.target.off)]);
      fl.target = null;
    }
    this.remove(tag, at, len);
    this.insert(tag, at, bytes);
    for (const [fl, o] of moved) fl.target = { c, off: at + o };
  }

  // ---- build ----
  buildNU20() {
    const addr = [];
    let p = 0x10;
    const sizes = this.chunks.map(ch => { const s = 8 + ch.body.length; return s + ((-s) % 16 + 16) % 16; });
    for (let i = 0; i < this.chunks.length; i++) { addr.push(p + 8); p += sizes[i]; }
    const pntrAt = p, n = this.fields.length;
    let pntrSize = 12 + 4 * n; pntrSize += ((-pntrSize) % 16 + 16) % 16;
    if (this.pntrPad >= pntrSize && this.pntrPad - pntrSize < 16) pntrSize = this.pntrPad; // keep the game's padding
    const total = pntrAt + pntrSize;
    const out = new Uint8Array(total), dv = new DataView(out.buffer);
    out.set(enc('NU20'), 0); dv.setInt32(4, -total, true); out.set(this.nuHeader, 8);
    this.chunks.forEach((ch, i) => {
      const a = addr[i] - 8;
      out.set(enc(ch.tag), a); dv.setUint32(a + 4, sizes[i], true); out.set(ch.body, a + 8);
    });
    out.set(enc('PNTR'), pntrAt); dv.setUint32(pntrAt + 4, pntrSize, true); dv.setInt32(pntrAt + 8, n, true);
    this.fields.forEach((fl, k) => {
      const fa = addr[fl.c] + fl.off;
      let v = 0;
      if (fl.target) v = fl.target.raw != null ? fl.target.raw : addr[fl.target.c] + fl.target.off - fa;
      dv.setInt32(fa, v, true);
      const slot = pntrAt + 12 + 4 * k;
      dv.setInt32(slot, fa - slot, true);
    });
    if (this.headIdx >= 0) { const fa = addr[this.headIdx]; dv.setInt32(fa, pntrAt + 8 - fa, true); } // HEAD body+0 -> PNTR count
    return out;
  }

  build() {
    const nu = this.buildNU20();
    let size = 6;
    for (const t of this.textures) size += 24 + t.dds.length;
    size += 2; for (const v of this.vbs) size += 4 + v.length;
    size += 2; for (const v of this.ibs) size += 4 + v.length;
    const mo = size + ((0xC0 - size) % 0x100 + 0x100) % 0x100;
    const out = new Uint8Array(mo + 4 + nu.length), dv = new DataView(out.buffer);
    dv.setUint32(0, mo, true); dv.setUint16(4, this.slotCount, true);
    let o = 6;
    for (const t of this.textures) { out.set(t.head, o); dv.setUint32(o + 20, t.dds.length, true); out.set(t.dds, o + 24); o += 24 + t.dds.length; }
    for (const list of [this.vbs, this.ibs]) {
      dv.setUint16(o, list.length, true); o += 2;
      for (const v of list) { dv.setUint32(o, v.length, true); out.set(v, o + 4); o += 4 + v.length; }
    }
    if (this.prefixPad.length === mo + 4 - o) out.set(this.prefixPad, o); // else zeros
    out.set(nu, mo + 4);
    return out;
  }
}
