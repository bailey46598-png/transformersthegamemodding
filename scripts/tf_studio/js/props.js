// Physics props (lamp posts, trees, bins, cars…): LEVELS\<level>\NEWPHYSOBJ.DAT (and _NG.DAT, used instead when
// the game's flag word 0x6FB1D0 has bit 0x200; what sets it isn't known yet). Each prop is a PHYSOBJTYPES.INI type
// (same order; PHYSOBJTYPES_NG.INI for the _NG file) placed at a position with a turn about Y. The type's
// SpecialName is a scene instance in the level .GSC that holds its model (and its physics body).
//
// File (checked on 9 levels; every parse ends exactly at the end of the file):
//   u32 0x06041D00, then u32 pairs (a schema: 3 12, 3 4, 4 2, 5 4, 2 2, 6 2, 7 4, 2 6, 8 4, 9 2, 10 4, 2), u32 cell count
//   cells:   per cell f32 x, y, z, f32 radius, u16 1                        (18 B)
//   u32 cell count again, then per cell u16 1, u16 number of props in it   (4 B)
//   u32 prop count, then the props grouped by cell, in cell order:         (12 B)
//     s16 x, y, z: offset from the cell centre in 1/100 units. The largest offsets in a cell equal its radius
//                  (37.5 -> 3,743, 56.25 -> 5,606 on Tranquility 2): the radius is a bounding sphere, not a scale
//     s16 qy, qw: the turn as a quaternion about Y (x 32767): (0, 1) = 0°, (0.7, 0.7) = 90°, (1, 0) = 180°
//     u8 type (index into PHYSOBJTYPES.INI), u8 0
export function readProps(buffer) {
  const dv = new DataView(buffer), u8 = new Uint8Array(buffer);
  if (dv.getUint32(0, true) !== 0x06041D00) throw new Error('not a NEWPHYSOBJ file (unknown header)');
  // the cell count is the u32 that appears again right after that many 18-byte cells, with the per-cell prop
  // counts adding up to the prop count and the props ending exactly at the end of the file
  let o = -1, nc = 0;
  for (let a = 4; a + 4 <= Math.min(u8.length, 512); a += 4) {
    const n = dv.getUint32(a, true), b = a + 4 + 18 * n;
    if (!(n > 0 && n < 100000 && b + 8 + 4 * n <= u8.length && dv.getUint32(b, true) === n)) continue;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += dv.getUint16(b + 4 + 4 * i + 2, true);
    const pc = b + 4 + 4 * n;
    if (dv.getUint32(pc, true) === sum && pc + 4 + 12 * sum === u8.length) { o = a + 4; nc = n; break; }
  }
  if (o < 0) throw new Error('header not understood');
  const schema = [];
  for (let a = 4; a < o - 4; a += 4) schema.push(dv.getUint32(a, true));
  const cells = [];
  for (let i = 0; i < nc; i++, o += 18) cells.push({ c: [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)], r: dv.getFloat32(o + 12, true), flag: dv.getUint16(o + 16, true) });
  if (dv.getUint32(o, true) !== nc) throw new Error('cell counts disagree');
  o += 4;
  const counts = [];
  for (let i = 0; i < nc; i++, o += 4) { cells[i].flag2 = dv.getUint16(o, true); counts.push(dv.getUint16(o + 2, true)); }
  const np = dv.getUint32(o, true); o += 4;
  if (o + 12 * np !== u8.length) throw new Error(`${np} props don't fill the file`);
  const props = [];
  let ci = 0, left = counts[0] ?? 0;
  for (let i = 0; i < np; i++, o += 12) {
    while (left === 0) { ci++; left = counts[ci]; }
    left--;
    const c = cells[ci], s = 0.01;
    const raw = [dv.getInt16(o, true), dv.getInt16(o + 2, true), dv.getInt16(o + 4, true)];
    const qy = dv.getInt16(o + 6, true), qw = dv.getInt16(o + 8, true);
    props.push({ cell: ci, raw, pos: [c.c[0] + raw[0] * s, c.c[1] + raw[1] * s, c.c[2] + raw[2] * s], qy, qw,
      yaw: 2 * Math.atan2(qy, qw), type: u8[o + 10], pad: u8[o + 11], dirty: false });
  }
  return { schema, cells, props };
}

// Writes the file back. Untouched props keep their stored bytes. An edited or new prop goes into the cell
// whose sphere holds it (nearest centre); if none does, the nearest cell's radius grows to reach it.
export function writeProps(doc) {
  const { cells, props } = doc;
  for (const p of props) if (p.dirty || p.cell == null) {
    let best = -1, bd = Infinity;
    cells.forEach((c, i) => { const d = Math.hypot(p.pos[0] - c.c[0], p.pos[1] - c.c[1], p.pos[2] - c.c[2]); if (d <= c.r * 0.999 && d < bd) { bd = d; best = i; } });
    if (best < 0) {
      cells.forEach((c, i) => { const d = Math.hypot(p.pos[0] - c.c[0], p.pos[1] - c.c[1], p.pos[2] - c.c[2]); if (d < bd) { bd = d; best = i; } });
      if (best < 0) throw new Error('no cells in this file');
      if (bd > 320) throw new Error(`a prop is ${Math.round(bd)} units from the nearest prop cell (at most 320 fit)`);
      cells[best].r = Math.ceil(bd * 1.01 + 0.01);
    }
    p.cell = best;
  }
  const order = props.map((p, i) => i).sort((a, b) => props[a].cell - props[b].cell || a - b);
  const counts = new Array(cells.length).fill(0);
  for (const p of props) counts[p.cell]++;
  if (counts.some(n => n > 65535)) throw new Error('too many props in one cell');
  const size = 4 + 4 * (doc.schema.length + 1) + 18 * cells.length + 4 + 4 * cells.length + 4 + 12 * props.length;
  const out = new ArrayBuffer(size), dv = new DataView(out), u8 = new Uint8Array(out);
  let o = 0;
  dv.setUint32(o, 0x06041D00, true); o += 4;
  for (const w of doc.schema) { dv.setUint32(o, w, true); o += 4; }
  dv.setUint32(o, cells.length, true); o += 4;
  for (const c of cells) { dv.setFloat32(o, c.c[0], true); dv.setFloat32(o + 4, c.c[1], true); dv.setFloat32(o + 8, c.c[2], true); dv.setFloat32(o + 12, c.r, true); dv.setUint16(o + 16, c.flag ?? 1, true); o += 18; }
  dv.setUint32(o, cells.length, true); o += 4;
  cells.forEach((c, i) => { dv.setUint16(o, c.flag2 ?? 1, true); dv.setUint16(o + 2, counts[i], true); o += 4; });
  dv.setUint32(o, props.length, true); o += 4;
  const s16 = v => Math.max(-32768, Math.min(32767, Math.round(v)));
  for (const i of order) {
    const p = props[i], c = cells[p.cell];
    if (p.dirty) {
      p.raw = [0, 1, 2].map(a => s16((p.pos[a] - c.c[a]) * 100));
      p.qy = s16(Math.sin(p.yaw / 2) * 32767); p.qw = s16(Math.cos(p.yaw / 2) * 32767);
      p.dirty = false;
    }
    dv.setInt16(o, p.raw[0], true); dv.setInt16(o + 2, p.raw[1], true); dv.setInt16(o + 4, p.raw[2], true);
    dv.setInt16(o + 6, p.qy, true); dv.setInt16(o + 8, p.qw, true);
    u8[o + 10] = p.type; u8[o + 11] = p.pad || 0;
    o += 12;
  }
  // keep the in-memory order the same as the file's
  doc.props = order.map(i => props[i]);
  return out;
}

// PHYSOBJTYPES.INI: the types in file order -> [{ id: GlobalID, special, broken, fields }]
export function readPropTypes(text) {
  const out = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.split(';')[0].trim();
    if (/^PhysObjType\b/i.test(l)) { cur = { id: '', special: '', broken: '', fields: {} }; out.push(cur); continue; }
    const m = cur && /^(\w+)\s*=\s*"?([^"]*)"?/.exec(l);
    if (!m) continue;
    cur.fields[m[1]] = m[2];
    if (/^GlobalID$/i.test(m[1])) cur.id = m[2];
    if (/^SpecialName$/i.test(m[1])) cur.special = m[2];
    if (/^SpecialName_DM1$/i.test(m[1])) cur.broken = m[2];
  }
  return out;
}
