// The High Detail ("hi-res") asset set: the server serves it as the virtual folder HIRES/ (see serve.py).
// It holds only CHARS/*/*.GHG and LEVELS/*/*.GSC (+ STUFF), in the same PC format as the game's own files, so every
// reader and writer here works on it unchanged. Animations, configs and level data always come from the game folder.
import { api } from './common.js';

export const HIRES = 'HIRES/';
const files = new Set();      // lower-case game-relative paths that have a hi-res copy
let root = null, loading = null;

export function loadHires() {
  loading ??= (async () => {
    try {
      root = (await api.info()).hires || null;
      if (root) for (const p of await api.find('.ghg,.gsc', true)) if (isHires(p)) files.add(normalPath(p).toLowerCase());
    } catch (e) { console.warn('hi-res set', e); }
    return root;
  })();
  return loading;
}

export const hiresAvailable = () => !!root && files.size > 0;
export const isHires = p => /^HIRES\//i.test(p || '');
export const normalPath = p => (p || '').replace(/^HIRES\//i, '');
// the hi-res copy of a game file, or null when the set has none
export const hiresOf = p => (p && files.has(normalPath(p).toLowerCase()) ? HIRES + normalPath(p) : null);
// pick the file for a detail level: 'high' uses the hi-res copy when there is one
export const forDetail = (p, detail) => (detail === 'high' && hiresOf(p)) || normalPath(p);
export const detailTag = p => (isHires(p) ? '<span class="tag hires" title="High Detail asset set">HI-RES</span>' : '');
