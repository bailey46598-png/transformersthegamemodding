// Which .GSC files the game loads for a level, from its LEVEL.CFG.
//   PATH Levels/Tranquility2
//   PLATFORM CURRGEN  SCENE Tranquility                                   (Normal detail: one scene)
//   PLATFORM NEXTGEN  SCENE Tranquility_Main / _Buildings / _Vehicles / _POs (High Detail: all loaded together)
//                     DEFAULTSCENE Tranquility   (used when the NEXTGEN scenes are missing)
//                     BUILDINGSCENE Tranquility_Buildings (the destructible buildings; it is in the SCENE list too)
// A scene name N is the file <PATH>/N_PC.GSC. In High Detail the game reads it from Transformers_Hi.DAT, i.e. the
// hi-res set (HIRES/...), so that is looked at first, then the game folder (loose files with new names load too).
import { api, joinPath } from './common.js';
import { HIRES, hiresAvailable, loadHires } from './hires.js';

export function parseLevelCfg(text) {
  const out = { path: null, platforms: {} };
  let plat = null;
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.split(';')[0].trim().split(/\s+/);
    const kw = (t[0] || '').toUpperCase(), arg = t[1];
    if (!kw) continue;
    if (kw === 'PLATFORM') { plat = (arg || '').toUpperCase(); out.platforms[plat] ??= { scenes: [], defaultScene: null, buildingScene: null }; continue; }
    if (kw === 'ENDPLATFORM') { plat = null; continue; }
    if (kw === 'PATH' && arg && !out.path) out.path = arg.replace(/\\/g, '/');
    if (!plat || !arg) continue;
    const P = out.platforms[plat];
    if (kw === 'SCENE') P.scenes.push(arg);
    if (kw === 'DEFAULTSCENE') P.defaultScene = arg;
    if (kw === 'BUILDINGSCENE') P.buildingScene = arg;
  }
  return out;
}

// { path, parts: [{ name, path, size, hires, building }], missing: [names], fallback: bool } or null (no NEXTGEN list).
// parts are in LEVEL.CFG order. When none of the scenes exist the game falls back to DEFAULTSCENE: then that is the
// one part and fallback is true.
export async function nextgenScenes(dir) {
  let cfg;
  try { cfg = parseLevelCfg(await api.text(joinPath(dir, 'LEVEL.CFG'))); } catch { return null; }
  const NG = cfg.platforms.NEXTGEN;
  if (!NG?.scenes.length) return null;
  const path = cfg.path || dir;
  await loadHires();
  const listings = new Map();
  const listing = async d => {
    if (!listings.has(d)) { try { listings.set(d, (await api.list(d)).files); } catch { listings.set(d, []); } }
    return listings.get(d);
  };
  const find = async name => {
    const want = `${name}_pc.gsc`.toLowerCase();
    for (const [d, hires] of [...(hiresAvailable() ? [[HIRES + path, true]] : []), [path, false]]) {
      const f = (await listing(d)).find(x => x.name.toLowerCase() === want);
      if (f) return { name, path: joinPath(d, f.name), size: f.size, hires };
    }
    return null;
  };
  const parts = [], missing = [];
  for (const n of NG.scenes) {
    const f = await find(n);
    if (f) parts.push({ ...f, building: !!NG.buildingScene && n.toLowerCase() === NG.buildingScene.toLowerCase() });
    else missing.push(n);
  }
  if (!parts.length && NG.defaultScene) {
    const f = await find(NG.defaultScene);
    if (f) return { path, parts: [{ ...f, building: false }], missing, fallback: true };
  }
  return parts.length ? { path, parts, missing, fallback: false } : null;
}
