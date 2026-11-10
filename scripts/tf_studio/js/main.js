import { ModelView } from './model_view.js';
import { LevelView } from './level_view.js';
import { CutsceneView } from './cutscene_view.js';
import { $, status } from './common.js';

const TABS = ['model', 'level', 'cut'];
const views = {};
const started = {};

function show(tab) {
  if (!TABS.includes(tab)) tab = 'model';
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('on', b.dataset.tab === tab);
  for (const t of TABS) { $(`tab-${t}`).classList.toggle('hidden', t !== tab); views[t].vp.active = t === tab; }
  views[tab].vp.resize();
  if (tab !== 'cut') views.cut.setPlaying(false); // stops its sound too
  if (tab !== 'model' && !started[tab]) started[tab] = views[tab].init().catch(e => status(e.message, true));
  try { localStorage.setItem('tfstudio.tab', tab); } catch {}
}

try {
  views.model = new ModelView();
  views.level = new LevelView();
  views.cut = new CutsceneView(views.model);
  for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => show(b.dataset.tab);
  let tab = 'model';
  try { tab = localStorage.getItem('tfstudio.tab') || 'model'; } catch {}
  // the model tab's character index is shared with the cutscene player
  views.model.ready = views.model.init().catch(e => status(`Could not reach the server: ${e.message}`, true));
  show(tab);
} catch (e) { console.error(e); status(e.message, true); }
window.tfstudio = views;
