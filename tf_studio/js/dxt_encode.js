// DXT1 / DXT5 encoder for the texture editor (top mip only; the game's character textures have one mip).
// encodeLike() re-encodes only the 4x4 blocks whose pixels changed and keeps every other byte of the original
// DDS, so an untouched area stays bit-identical and only painted areas are re-compressed.
//
// The game's own DXT1 blocks are nearly all in 3-colour mode (c0 <= c1), where index 3 = transparent black.
// A changed block with transparent texels is written in that mode again so cut-outs survive; others use the
// 4-colour mode. DXT5 blocks keep their alpha half unless the alpha itself changed.

const to565 = (r, g, b) => ((Math.round(r * 31 / 255) & 31) << 11) | ((Math.round(g * 63 / 255) & 63) << 5) | (Math.round(b * 31 / 255) & 31);
const from565 = c => [((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31];
const clamp = v => (v < 0 ? 0 : v > 255 ? 255 : v);

// endpoints along the block's main colour axis (power iteration on the covariance), then one least-squares refit
function endpoints(px, n, use) {
  let mr = 0, mg = 0, mb = 0, k = 0;
  for (let i = 0; i < n; i++) if (use[i]) { mr += px[i * 3]; mg += px[i * 3 + 1]; mb += px[i * 3 + 2]; k++; }
  if (!k) return [[0, 0, 0], [0, 0, 0]];
  mr /= k; mg /= k; mb /= k;
  let c00 = 0, c01 = 0, c02 = 0, c11 = 0, c12 = 0, c22 = 0;
  for (let i = 0; i < n; i++) if (use[i]) {
    const r = px[i * 3] - mr, g = px[i * 3 + 1] - mg, b = px[i * 3 + 2] - mb;
    c00 += r * r; c01 += r * g; c02 += r * b; c11 += g * g; c12 += g * b; c22 += b * b;
  }
  let vr = 1, vg = 1, vb = 1;
  for (let it = 0; it < 8; it++) {
    const r = c00 * vr + c01 * vg + c02 * vb, g = c01 * vr + c11 * vg + c12 * vb, b = c02 * vr + c12 * vg + c22 * vb;
    const l = Math.hypot(r, g, b) || 1; vr = r / l; vg = g / l; vb = b / l;
  }
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) if (use[i]) {
    const t = (px[i * 3] - mr) * vr + (px[i * 3 + 1] - mg) * vg + (px[i * 3 + 2] - mb) * vb;
    if (t < lo) lo = t; if (t > hi) hi = t;
  }
  return [[mr + vr * hi, mg + vg * hi, mb + vb * hi], [mr + vr * lo, mg + vg * lo, mb + vb * lo]];
}

function nearest(px, i, pal, count) {
  let best = 0, bd = Infinity;
  for (let k = 0; k < count; k++) {
    const dr = px[i * 3] - pal[k][0], dg = px[i * 3 + 1] - pal[k][1], db = px[i * 3 + 2] - pal[k][2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bd) { bd = d; best = k; }
  }
  return best;
}

// px: 16 RGB triples (Float32Array 48), transparent: bool[16] or null. four: force 4-colour mode (DXT5 colour half).
function colourBlock(px, transparent, four, out, o) {
  const use = new Uint8Array(16).fill(1);
  if (transparent) for (let i = 0; i < 16; i++) if (transparent[i]) use[i] = 0;
  const three = !four && transparent && transparent.some(Boolean);
  let [a, b] = endpoints(px, 16, use);
  let c0, c1, pal, idx = new Uint8Array(16);
  const build = () => {
    c0 = to565(clamp(a[0]), clamp(a[1]), clamp(a[2])); c1 = to565(clamp(b[0]), clamp(b[1]), clamp(b[2]));
    if (three) { if (c0 > c1) [c0, c1] = [c1, c0]; }
    else { if (c0 < c1) [c0, c1] = [c1, c0]; if (c0 === c1) { if (c1 > 0) c1--; else c0++; } }
    const p0 = from565(c0), p1 = from565(c1);
    pal = three ? [p0, p1, p0.map((x, j) => (x + p1[j]) / 2)]
      : [p0, p1, p0.map((x, j) => (2 * x + p1[j]) / 3), p0.map((x, j) => (x + 2 * p1[j]) / 3)];
    for (let i = 0; i < 16; i++) idx[i] = use[i] ? nearest(px, i, pal, pal.length) : 3;
  };
  build();
  if (!three) {
    // least-squares refit of the two endpoints for the chosen indices (4-colour weights 1, 0, 2/3, 1/3)
    const wt = [1, 0, 2 / 3, 1 / 3];
    let aa = 0, bb = 0, ab = 0; const ax = [0, 0, 0], bx = [0, 0, 0];
    for (let i = 0; i < 16; i++) {
      const w = wt[idx[i]], v = 1 - w;
      aa += w * w; bb += v * v; ab += w * v;
      for (let j = 0; j < 3; j++) { ax[j] += w * px[i * 3 + j]; bx[j] += v * px[i * 3 + j]; }
    }
    const det = aa * bb - ab * ab;
    if (Math.abs(det) > 1e-6) {
      a = ax.map((x, j) => (x * bb - bx[j] * ab) / det);
      b = bx.map((x, j) => (x * aa - ax[j] * ab) / det);
      build();
    }
  }
  out[o] = c0 & 255; out[o + 1] = c0 >> 8; out[o + 2] = c1 & 255; out[o + 3] = c1 >> 8;
  let bits = 0;
  for (let i = 0; i < 16; i++) bits |= idx[i] << (2 * i);
  out[o + 4] = bits & 255; out[o + 5] = (bits >>> 8) & 255; out[o + 6] = (bits >>> 16) & 255; out[o + 7] = (bits >>> 24) & 255;
}

function alphaBlock(al, out, o) {
  let lo = 255, hi = 0;
  for (let i = 0; i < 16; i++) { if (al[i] < lo) lo = al[i]; if (al[i] > hi) hi = al[i]; }
  if (hi === lo) { out[o] = hi; out[o + 1] = lo; for (let k = 2; k < 8; k++) out[o + k] = 0; return; }
  const pal = [hi, lo]; for (let i = 1; i < 7; i++) pal.push(((7 - i) * hi + i * lo) / 7);
  out[o] = hi; out[o + 1] = lo;
  let bits = 0n;
  for (let i = 0; i < 16; i++) {
    let best = 0, bd = Infinity;
    for (let k = 0; k < 8; k++) { const d = Math.abs(al[i] - pal[k]); if (d < bd) { bd = d; best = k; } }
    bits |= BigInt(best) << BigInt(3 * i);
  }
  for (let k = 0; k < 6; k++) out[o + 2 + k] = Number((bits >> BigInt(8 * k)) & 255n);
}

// orig: original DDS bytes (Uint8Array). before: its decoded RGBA. after: the edited RGBA (same size).
// Returns new DDS bytes of the same length and format, plus how many blocks were re-encoded.
export function encodeLike(orig, before, after, w, h) {
  const cc = String.fromCharCode(orig[84], orig[85], orig[86], orig[87]);
  if (cc !== 'DXT1' && cc !== 'DXT5') throw new Error(`can't write ${cc} textures`);
  const bs = cc === 'DXT1' ? 8 : 16;
  const out = orig.slice();
  const px = new Float32Array(48), al = new Uint8Array(16), tr = new Array(16);
  let changed = 0;
  const bw = w >> 2, bh = h >> 2;
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    let diff = false, adiff = false;
    for (let i = 0; i < 16 && !(diff && adiff); i++) {
      const p = ((by * 4 + (i >> 2)) * w + bx * 4 + (i & 3)) * 4;
      if (after[p] !== before[p] || after[p + 1] !== before[p + 1] || after[p + 2] !== before[p + 2]) diff = true;
      if (after[p + 3] !== before[p + 3]) adiff = true;
    }
    if (!diff && !adiff) continue;
    changed++;
    for (let i = 0; i < 16; i++) {
      const p = ((by * 4 + (i >> 2)) * w + bx * 4 + (i & 3)) * 4;
      px[i * 3] = after[p]; px[i * 3 + 1] = after[p + 1]; px[i * 3 + 2] = after[p + 2];
      al[i] = after[p + 3]; tr[i] = after[p + 3] < 128;
    }
    const o = 128 + (by * bw + bx) * bs;
    if (bs === 8) colourBlock(px, tr, false, out, o);
    else { if (adiff) alphaBlock(al, out, o); colourBlock(px, null, true, out, o + 8); }
  }
  return { dds: out, changed };
}
