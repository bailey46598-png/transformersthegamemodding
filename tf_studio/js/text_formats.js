// Text and small binary map formats: creature .CFG, block .INI (PLACEMENTS, TRIGGERS), SPLINE.DAT.

// ---------------------------------------------------------------- creature configs
// Collects CHARACTER blocks: PATH, OBJECT, DEPENDS, and ANIMGROUP/ANIMENTRY tables (following INCLUDEs).
export async function readCreatureConfig(path, fetchText, seen = new Set()) {
  const out = { characters: [], includes: [] };
  const state = { char: null, entry: null, group: null };
  await walk(path, out, state, fetchText, seen);
  return out;
}

async function walk(path, out, state, fetchText, seen) {
  const key = path.toLowerCase().replace(/\\/g, '/');
  if (seen.has(key)) return;
  seen.add(key);
  let text;
  try { text = await fetchText(path); } catch { out.includes.push({ path, missing: true }); return; }
  out.includes.push({ path });
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split(';')[0].trim();
    if (!line) continue;
    const tok = line.split(/\s+/), kw = tok[0].toUpperCase();
    if (kw === 'CHARACTER') {
      state.char = { name: tok[1], path: '', object: null, depends: [], anims: [], cfg: path };
      out.characters.push(state.char);
    } else if (kw === 'ENDCHARACTER') { /* attributes after ENDCHARACTER still belong to the creature */ }
    else if (kw === 'INCLUDE' && tok[1]) await walk(tok[1].replace(/"/g, ''), out, state, fetchText, seen);
    else if (!state.char) continue;
    else if (kw === 'PATH') state.char.path = tok.slice(1).join(' ').replace(/"/g, '');
    else if (kw === 'OBJECT') state.char.object = tok[1];
    else if (kw === 'DEPENDS') state.char.depends.push(tok[1]);
    else if (kw === 'ANIMGROUP') state.group = tok[1];
    else if (kw === 'ANIMENTRY' && tok[2] && /\.an3$/i.test(tok[2])) {
      state.entry = { group: state.group, name: tok[1], file: tok[2], rate: 30, layers: null, flags: [] };
      state.char.anims.push(state.entry);
    } else if (kw === 'RATE' && state.entry) state.entry.rate = parseFloat(tok[1]);
    else if (kw === 'ACTIVELAYERSMASKON' && state.entry) state.entry.layers = tok.slice(3).map(Number).filter(n => !isNaN(n));
    else if (['HOLD', 'TRACKROOT', 'LOOP', 'NOLOOP'].includes(kw) && state.entry) state.entry.flags.push(kw);
    else if (kw === 'ENDANIMENTRY') state.entry = null;
  }
}

export function modelFileName(object) { // "ROBOT.ghg" -> "ROBOT_PC.GHG"
  return object.replace(/\.ghg$/i, '') + '_PC.GHG';
}

// ---------------------------------------------------------------- block INI (Placement { Key = Value })
export function parseBlockIni(text) {
  const blocks = [], lines = text.split(/\r?\n/);
  let cur = null, pendingType = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('//')) continue;
    if (line === '{' || (!cur && line.endsWith('{'))) {
      cur = { type: line === '{' ? (pendingType || 'Block') : line.slice(0, -1).trim(), fields: [] }; continue;
    }
    if (line === '}') { if (cur) blocks.push(cur); cur = null; pendingType = null; continue; }
    const m = line.match(/^([^=]+?)\s*=\s*(.*)$/);
    if (cur && m) cur.fields.push([m[1].trim(), m[2].trim()]);
    else if (!cur) pendingType = line;
  }
  return { blocks, crlf: /\r\n/.test(text) };
}

export function writeBlockIni(doc) {
  const nl = doc.crlf ? '\r\n' : '\n';
  return doc.blocks.map(b => [b.type, '{', ...b.fields.map(([k, v]) => `\t${k} = ${v}`), '}'].join(nl)).join(nl) + nl;
}

export const iniGet = (b, k) => { const f = b.fields.find(f => f[0].toLowerCase() === k.toLowerCase()); return f ? f[1] : undefined; };
export const iniNum = (b, k, d = 0) => { const v = parseFloat(iniGet(b, k)); return isNaN(v) ? d : v; };
export function iniSet(b, k, v) {
  const f = b.fields.find(f => f[0].toLowerCase() === k.toLowerCase());
  if (f) f[1] = String(v); else b.fields.push([k, String(v)]);
}
export const unquote = s => (s || '').replace(/^"(.*)"$/, '$1');

// ---------------------------------------------------------------- SPLINE.DAT
// u32 count, then per spline: char[32] name (NUL, then 0xCD fill), u32 points, float3[points].
export function parseSplineDat(buffer) {
  const dv = new DataView(buffer), u8 = new Uint8Array(buffer);
  const n = dv.getUint32(0, true), splines = [];
  let o = 4;
  for (let i = 0; i < n; i++) {
    const nameBytes = u8.slice(o, o + 32);
    let e = 0; while (e < 32 && nameBytes[e]) e++;
    const name = new TextDecoder('latin1').decode(nameBytes.subarray(0, e));
    const c = dv.getUint32(o + 32, true); o += 36;
    const pts = [];
    for (let j = 0; j < c; j++) pts.push([dv.getFloat32(o + 12 * j, true), dv.getFloat32(o + 12 * j + 4, true), dv.getFloat32(o + 12 * j + 8, true)]);
    o += 12 * c;
    splines.push({ name, nameBytes, points: pts });
  }
  if (o !== buffer.byteLength) throw new Error(`SPLINE.DAT: parsed ${o} of ${buffer.byteLength} bytes`);
  return splines;
}

export function writeSplineDat(splines) {
  const size = 4 + splines.reduce((s, sp) => s + 36 + 12 * sp.points.length, 0);
  const buf = new ArrayBuffer(size), dv = new DataView(buf), u8 = new Uint8Array(buf);
  dv.setUint32(0, splines.length, true);
  let o = 4;
  for (const sp of splines) {
    const nb = sp.nameBytes ? sp.nameBytes.slice() : new Uint8Array(32).fill(0xCD);
    const enc = new TextEncoder().encode(sp.name).slice(0, 31);
    const orig = sp.nameBytes ? new TextDecoder('latin1').decode(sp.nameBytes.subarray(0, sp.nameBytes.indexOf(0))) : null;
    if (orig !== sp.name) { nb.fill(0xCD); nb.set(enc); nb[enc.length] = 0; }
    u8.set(nb, o);
    dv.setUint32(o + 32, sp.points.length, true); o += 36;
    for (const p of sp.points) { dv.setFloat32(o, p[0], true); dv.setFloat32(o + 4, p[1], true); dv.setFloat32(o + 8, p[2], true); o += 12; }
  }
  return buf;
}
