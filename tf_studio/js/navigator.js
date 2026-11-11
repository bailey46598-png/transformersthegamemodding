// Camera navigation for big scenes: fly keys, mouse-look, zoom to cursor, double-click fly-to,
// smooth focus, top view, bookmarks and a clickable minimap. Works on top of the Viewport's OrbitControls.
import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
const MOVE_KEYS = {
  KeyW: [0, 0, 1], ArrowUp: [0, 0, 1], KeyS: [0, 0, -1], ArrowDown: [0, 0, -1],
  KeyA: [-1, 0, 0], ArrowLeft: [-1, 0, 0], KeyD: [1, 0, 0], ArrowRight: [1, 0, 0],
  KeyE: [0, 1, 0], PageUp: [0, 1, 0], KeyQ: [0, -1, 0], PageDown: [0, -1, 0],
};

export class Navigator {
  /**
   * vp: Viewport. opts.pick(raycaster) -> world-space hit point or null. opts.active() -> is this view showing.
   * opts.bookmarkKey: localStorage key for this scene's bookmarks.
   */
  constructor(vp, opts) {
    this.vp = vp; this.opts = opts;
    this.speed = 40; // units per second
    this.keys = new Set();
    this.anim = null;
    this.looking = false;
    this.listeners = [];
    const c = vp.controls;
    c.enableZoom = false;   // our wheel handler zooms toward the cursor instead
    c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: null };
    c.screenSpacePanning = true;
    c.enableDamping = true; c.dampingFactor = 0.15;
    c.minDistance = 0.05; c.maxDistance = 50000;
    c.addEventListener('start', () => { this.anim = null; });
    const el = vp.renderer.domElement;
    el.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    el.addEventListener('dblclick', e => this.onDblClick(e));
    el.addEventListener('pointerdown', e => this.onDown(e));
    el.addEventListener('pointermove', e => this.onMove(e));
    el.addEventListener('pointerup', e => this.onUp(e));
    el.addEventListener('contextmenu', e => e.preventDefault());
    window.addEventListener('keydown', e => this.onKey(e, true));
    window.addEventListener('keyup', e => this.onKey(e, false));
    window.addEventListener('blur', () => this.keys.clear());
    vp.onFrame.push(dt => this.update(dt));
  }

  on(fn) { this.listeners.push(fn); }
  emit() { for (const f of this.listeners) f(this); }
  get cam() { return this.vp.camera; }
  get target() { return this.vp.controls.target; }
  typing(e) { return ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target?.tagName); }

  ndc(e) {
    const r = this.vp.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }
  rayAt(e) { const ray = new THREE.Raycaster(); ray.setFromCamera(this.ndc(e), this.cam); ray.firstHitOnly = true; return ray; }

  // ---------------------------------------------------------------- input
  onWheel(e) {
    e.preventDefault();
    this.anim = null;
    if (this.looking || e.altKey) { // right-drag + wheel (or Alt + wheel) changes fly speed
      this.setSpeed(this.speed * Math.pow(1.002, -e.deltaY));
      return;
    }
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    const s = Math.pow(1.0018, Math.max(-300, Math.min(300, dy))); // <1 zooms in
    const ray = this.rayAt(e);
    let P = this.opts.pick(ray);
    const camDist = this.cam.position.distanceTo(this.target);
    if (!P) P = ray.ray.at(Math.max(camDist, 5), new THREE.Vector3());
    // scale camera and orbit target about the point under the cursor, so that point stays put
    const toCam = this.cam.position.clone().sub(P), toTarget = this.target.clone().sub(P);
    if (s < 1 && toCam.length() * s < 0.25) return;
    if (s > 1 && toCam.length() * s > 40000) return;
    this.cam.position.copy(P).addScaledVector(toCam, s);
    this.target.copy(P).addScaledVector(toTarget, s);
    this.autoSpeed();
    this.emit();
  }

  onDblClick(e) {
    const P = this.opts.pick(this.rayAt(e));
    if (!P) return;
    const dir = this.cam.position.clone().sub(this.target).normalize();
    const d = Math.min(Math.max(this.cam.position.distanceTo(P) * 0.25, 6), 120);
    this.flyTo(P, P.clone().addScaledVector(dir, d));
  }

  onDown(e) {
    if (e.button !== 2) return;
    this.looking = true; this.anim = null;
    this.last = [e.clientX, e.clientY];
    try { e.target.setPointerCapture?.(e.pointerId); } catch {}
    this.vp.renderer.domElement.style.cursor = 'crosshair';
  }
  onMove(e) {
    if (!this.looking) return;
    const dx = e.clientX - this.last[0], dy = e.clientY - this.last[1];
    this.last = [e.clientX, e.clientY];
    this.look(-dx * 0.0035, -dy * 0.0035);
  }
  onUp(e) {
    if (e.button !== 2 || !this.looking) return;
    this.looking = false;
    this.vp.renderer.domElement.style.cursor = '';
  }

  onKey(e, down) {
    if (!this.opts.active() || this.typing(e)) return;
    if (e.ctrlKey || e.metaKey) {
      if (down && /^Digit[1-9]$/.test(e.code)) { e.preventDefault(); this.saveBookmark(+e.code.slice(5)); }
      return;
    }
    if (MOVE_KEYS[e.code]) {
      e.preventDefault();
      if (down) { this.keys.add(e.code); this.anim = null; } else this.keys.delete(e.code);
      return;
    }
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') { this.fast = down; return; }
    if (!down) return;
    if (/^Digit[1-9]$/.test(e.code)) this.gotoBookmark(+e.code.slice(5));
    else if (e.code === 'BracketRight' || e.code === 'Equal' || e.code === 'NumpadAdd') this.setSpeed(this.speed * 1.5);
    else if (e.code === 'BracketLeft' || e.code === 'Minus' || e.code === 'NumpadSubtract') this.setSpeed(this.speed / 1.5);
    else if (e.code === 'KeyT') this.topView();
  }

  // ---------------------------------------------------------------- motions
  look(yaw, pitch) {
    const cam = this.cam.position, dir = this.target.clone().sub(cam);
    const dist = dir.length() || 1;
    dir.normalize().applyAxisAngle(UP, yaw);
    const right = dir.clone().cross(UP).normalize();
    const nd = dir.clone().applyAxisAngle(right, pitch);
    if (Math.abs(nd.dot(UP)) < 0.995) dir.copy(nd);
    this.target.copy(cam).addScaledVector(dir, dist);
    this.emit();
  }

  update(dt) {
    let moved = false;
    if (this.keys.size) {
      const v = new THREE.Vector3();
      for (const k of this.keys) { const m = MOVE_KEYS[k]; v.x += m[0]; v.y += m[1]; v.z += m[2]; }
      if (v.lengthSq()) {
        const fwd = this.target.clone().sub(this.cam.position).normalize();
        const right = fwd.clone().cross(UP).normalize();
        const step = this.speed * (this.fast ? 4 : 1) * dt;
        const d = new THREE.Vector3().addScaledVector(fwd, v.z).addScaledVector(right, v.x).addScaledVector(UP, v.y).normalize().multiplyScalar(step);
        this.cam.position.add(d); this.target.add(d);
        moved = true;
      }
    }
    if (this.anim) {
      const a = this.anim;
      a.t = Math.min(1, a.t + dt / a.dur);
      const k = 1 - Math.pow(1 - a.t, 3); // ease out
      this.cam.position.lerpVectors(a.p0, a.p1, k);
      this.target.lerpVectors(a.t0, a.t1, k);
      if (a.t >= 1) { this.anim = null; this.autoSpeed(); }
      moved = true;
    }
    // keep depth precision good both up close and far away
    const dist = this.cam.position.distanceTo(this.target);
    const near = THREE.MathUtils.clamp(dist / 2000, 0.02, 2);
    if (Math.abs(near - this.cam.near) / this.cam.near > 0.2) { this.cam.near = near; this.cam.far = 30000; this.cam.updateProjectionMatrix(); }
    if (moved) this.emit();
  }

  flyTo(target, camPos, dur = 0.55) {
    this.anim = { p0: this.cam.position.clone(), p1: camPos.clone(), t0: this.target.clone(), t1: target.clone(), t: 0, dur };
  }

  // like Viewport.frameBox, but animated; box is in world space
  flyToBox(box, k = 1.4) {
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3()), r = box.getSize(new THREE.Vector3()).length() / 2 || 1;
    const dir = this.cam.position.clone().sub(this.target).normalize();
    if (!isFinite(dir.x) || dir.lengthSq() < 0.5) dir.set(0.5, 0.5, 0.7).normalize();
    if (dir.y < 0.25) { dir.y = 0.35; dir.normalize(); } // don't end up looking from under the floor
    this.flyTo(c, c.clone().addScaledVector(dir, Math.max(r * k / Math.tan(this.cam.fov * Math.PI / 360), 2)));
  }

  topView() {
    const t = this.target.clone(), h = Math.max(this.cam.position.distanceTo(t), 30);
    this.flyTo(t, t.clone().add(new THREE.Vector3(0, h, 0.001 * h)));
  }

  // fly speed follows how far away you are, unless you set it yourself
  autoSpeed() {
    if (this.manualSpeed) return;
    this.speed = THREE.MathUtils.clamp(this.cam.position.distanceTo(this.target) * 0.8, 4, 800);
    this.emit();
  }
  setSpeed(s) { this.manualSpeed = true; this.speed = THREE.MathUtils.clamp(s, 0.5, 5000); this.emit(); }
  resetSpeed() { this.manualSpeed = false; this.autoSpeed(); }

  // ---------------------------------------------------------------- bookmarks (per scene, in localStorage)
  bookmarks() { try { return JSON.parse(localStorage.getItem(this.opts.bookmarkKey()) || '{}'); } catch { return {}; } }
  saveBookmark(n) {
    const b = this.bookmarks();
    b[n] = { p: this.cam.position.toArray(), t: this.target.toArray() };
    try { localStorage.setItem(this.opts.bookmarkKey(), JSON.stringify(b)); } catch {}
    this.opts.notify?.(`Saved view ${n}. Press ${n} to come back.`);
    this.emit();
  }
  gotoBookmark(n) {
    const v = this.bookmarks()[n];
    if (!v) { this.opts.notify?.(`No view saved on ${n}. Ctrl+${n} saves the current view.`); return; }
    this.flyTo(new THREE.Vector3(...v.t), new THREE.Vector3(...v.p));
  }
}

// ---------------------------------------------------------------- minimap: top-down orthographic overview
export class Minimap {
  constructor(vp, nav, host) {
    this.vp = vp; this.nav = nav;
    this.size = 220; this.zoom = 1; this.visible = true; this.follow = false;
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 100000);
    this.cam.up.set(0, 0, -1);
    this.cam.layers.enable(1);
    this.box = new THREE.Box3(new THREE.Vector3(-100, -10, -100), new THREE.Vector3(100, 10, 100));
    // camera marker, only visible to the minimap (layer 1)
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 1), new THREE.Vector3(-0.55, 0, -0.6), new THREE.Vector3(0.55, 0, -0.6)]);
    g.setIndex([0, 1, 2]);
    this.marker = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffd34d, side: THREE.DoubleSide, depthTest: false, transparent: true, opacity: 0.85 }));
    this.marker.renderOrder = 100;
    this.marker.layers.set(1);
    vp.scene.add(this.marker);
    this.el = document.createElement('div');
    this.el.className = 'minimap';
    this.el.title = 'Click or drag to move there · wheel to zoom the map';
    host.appendChild(this.el);
    let drag = false;
    const go = (e, animate) => {
      const r = this.el.getBoundingClientRect();
      const u = (e.clientX - r.left) / r.width * 2 - 1, v = -((e.clientY - r.top) / r.height * 2 - 1);
      const p = new THREE.Vector3(u, v, 0).unproject(this.cam);
      const t = nav.target, offset = nav.cam.position.clone().sub(t);
      const ground = this.groundAt(p.x, p.z, t.y);
      const nt = new THREE.Vector3(p.x, ground, p.z);
      if (animate) nav.flyTo(nt, nt.clone().add(offset)); else { nav.anim = null; t.copy(nt); nav.cam.position.copy(nt).add(offset); nav.emit(); }
    };
    this.el.addEventListener('pointerdown', e => { drag = true; try { this.el.setPointerCapture(e.pointerId); } catch {} go(e, true); });
    this.el.addEventListener('pointermove', e => { if (drag && e.buttons) go(e, false); });
    this.el.addEventListener('pointerup', () => { drag = false; });
    this.el.addEventListener('wheel', e => { e.preventDefault(); this.zoom = THREE.MathUtils.clamp(this.zoom * Math.pow(1.0015, e.deltaY), 0.02, 1.5); }, { passive: false });
    this.el.addEventListener('dblclick', () => { this.follow = !this.follow; this.el.classList.toggle('follow', this.follow); });
    vp.afterRender.push(() => this.render());
  }

  setBounds(box) { this.box.copy(box); this.zoom = 1; }
  groundAt(x, z, fallback) {
    const ray = new THREE.Raycaster(new THREE.Vector3(x, this.box.max.y + 10, z), new THREE.Vector3(0, -1, 0));
    ray.firstHitOnly = true;
    const p = this.nav.opts.pick(ray, { top: true });
    return p ? p.y : fallback;
  }

  render() {
    this.el.style.display = this.visible ? '' : 'none';
    if (!this.visible) return;
    const r = this.vp.renderer, host = this.vp.host;
    const W = host.clientWidth, H = host.clientHeight;
    const w = Math.round(THREE.MathUtils.clamp(Math.min(W * 0.3, H * 0.38), 110, 260)), h = w;
    if (W < 300 || H < 220) { this.el.style.display = 'none'; return; }
    if (this.size !== w || this._W !== W) {
      this.size = w; this._W = W;
      this.el.style.width = this.el.style.height = w + 'px';
      const bar = host.querySelector('.navbar');
      if (bar) bar.style.maxWidth = `${W - w - 34}px`;
    }
    const b = this.box, c = b.getCenter(new THREE.Vector3()), s = b.getSize(new THREE.Vector3());
    const half = Math.max(s.x, s.z) / 2 * this.zoom;
    const center = this.follow || this.zoom < 0.999 ? this.nav.target : c;
    this.cam.position.set(center.x, b.max.y + 50, center.z);
    this.cam.lookAt(center.x, b.min.y, center.z);
    this.cam.left = -half; this.cam.right = half; this.cam.top = half; this.cam.bottom = -half;
    this.cam.near = 1; this.cam.far = s.y + 200;
    this.cam.updateProjectionMatrix();
    // camera marker: at the camera, pointing along the view, sized to the map
    const p = this.nav.cam.position, d = this.nav.target.clone().sub(p);
    this.marker.position.set(p.x, b.max.y + 20, p.z);
    this.marker.rotation.set(0, Math.atan2(d.x, d.z), 0);
    this.marker.scale.setScalar(half * 0.09);
    r.setScissorTest(true);
    r.setViewport(W - w - 12, 12, w, h); r.setScissor(W - w - 12, 12, w, h);
    r.render(this.vp.scene, this.cam);
    r.setScissorTest(false);
    r.setViewport(0, 0, W, H);
  }
}
