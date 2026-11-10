import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { DDSLoader } from 'three/addons/loaders/DDSLoader.js';

// ---------------------------------------------------------------- server API
export const api = {
  async list(dir) { return json(await fetch(`/api/list?dir=${encodeURIComponent(dir)}`)); },
  async find(exts) { return json(await fetch(`/api/find?ext=${encodeURIComponent(exts)}`)); },
  async bytes(path) {
    const r = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
    if (!r.ok) throw new Error(`${path}: ${r.status === 404 ? 'not found' : r.statusText}`);
    return r.arrayBuffer();
  },
  async text(path) { return new TextDecoder('latin1').decode(await api.bytes(path)); },
  async save(path, data) {
    const r = await fetch(`/api/save?path=${encodeURIComponent(path)}`, { method: 'POST', body: data });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || r.statusText);
    return j;
  },
};
async function json(r) { const j = await r.json(); if (!r.ok || j.error) throw new Error(j.error || r.statusText); return j; }

export const $ = id => document.getElementById(id);
export function status(msg, bad = false) { const s = $('status'); s.textContent = msg; s.style.color = bad ? 'var(--bad)' : ''; }
export const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const fmt = (v, d = 3) => (Math.abs(v) < 1e-9 ? 0 : v).toFixed(d).replace(/\.?0+$/, '') || '0';
export const joinPath = (...p) => p.filter(Boolean).join('/').replace(/\\/g, '/').replace(/\/+/g, '/');
export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
export const dirOf = p => p.replace(/\\/g, '/').replace(/\/[^/]*$/, '');

// ---------------------------------------------------------------- textures
const dds = new DDSLoader();
export function ddsTexture(buffer) {
  try {
    const d = dds.parse(buffer, true);
    if (d.isCubemap || !d.mipmaps?.length) return null;
    const t = new THREE.CompressedTexture(d.mipmaps, d.width, d.height, d.format);
    t.minFilter = d.mipmaps.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    t.userData.hasAlpha = d.format !== THREE.RGB_S3TC_DXT1_Format;
    return t;
  } catch (e) { console.warn('DDS', e); return null; }
}

// ---------------------------------------------------------------- viewport
export class Viewport {
  constructor(host, { far = 5000 } = {}) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.prepend(this.renderer.domElement);
    this.labels = new CSS2DRenderer();
    // zIndex 1 gives the labels their own stacking context (CSS2DRenderer z-sorts each label), so toolbars
    // and panels with a higher z-index stay on top of them
    Object.assign(this.labels.domElement.style, { position: 'absolute', top: '0', left: '0', pointerEvents: 'none', zIndex: '1' });
    host.appendChild(this.labels.domElement);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x23262e);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, far);
    this.camera.position.set(6, 5, 9);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    // The game is D3D (left-handed, Y up). Mirroring Z shows it the right way round in three.js.
    this.root = new THREE.Group();
    this.root.scale.z = -1;
    this.scene.add(this.root);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(5, 10, 7);
    this.scene.add(sun);
    this.onFrame = [];
    this.afterRender = [];
    this.active = true;
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    const clock = new THREE.Clock();
    const loop = () => {
      requestAnimationFrame(loop);
      const dt = Math.min(clock.getDelta(), 0.1);
      if (!this.active) return;
      for (const f of this.onFrame) f(dt);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      for (const f of this.afterRender) f();
      this.labels.render(this.scene, this.camera);
    };
    loop();
  }
  resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
  frameBox(box, k = 1.4) {
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3()), r = box.getSize(new THREE.Vector3()).length() / 2 || 1;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (!isFinite(dir.x) || dir.lengthSq() < 0.5) dir.set(0.5, 0.4, 0.8).normalize();
    this.controls.target.copy(c);
    this.camera.position.copy(c).addScaledVector(dir, r * k / Math.tan(this.camera.fov * Math.PI / 360));
    this.camera.near = Math.max(r / 1000, 0.01);
    this.camera.far = Math.max(r * 20, 100);
    this.camera.updateProjectionMatrix();
  }
  screenshot(name) {
    this.renderer.render(this.scene, this.camera);
    const a = document.createElement('a');
    a.href = this.renderer.domElement.toDataURL('image/png');
    a.download = name;
    a.click();
  }
}
