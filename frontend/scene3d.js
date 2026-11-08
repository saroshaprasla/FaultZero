// FaultZero 3D data hall: line-art equipment, flowing pipes, heat glow, embers,
// shockwaves on failure, camera fly-to. Built on three.js (vendored in /static/vendor).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

const S = 1.45; // world units per layout unit
const DIMS = { // width, height, depth
  rack: [0.8, 1.7, 0.95], chiller: [2.0, 0.95, 1.25], crah: [0.95, 1.7, 0.95], ups: [1.15, 1.15, 1.15],
  pdu: [0.6, 1.05, 0.6], utility: [1.0, 2.6, 1.0], generator: [1.6, 0.95, 1.05],
};
const LINE_IDLE = new THREE.Color("#6f9fe8");
const SELECT = new THREE.Color("#22e9ff");
const BAD = new Set(["tripped", "down", "depleted", "no_power", "offline"]);
const ease = t => 1 - Math.pow(1 - t, 3);

export function webglAvailable() {
  try {
    const c = document.createElement("canvas");
    return !!(window.WebGL2RenderingContext && c.getContext("webgl2"));
  } catch { return false; }
}

export class Scene3D {
  constructor(container, { heat, onSelect, interactive = true }) {
    this.container = container;
    this.heat = heat;
    this.onSelect = onSelect;
    this.calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.objs = {};
    this.pipes = [];
    this.tweens = [];
    this.selected = null;
    this.hovered = null;
    this.userMoved = false;
    this.clock = new THREE.Clock(); // works in r187; Timer is the newer API

    const w = container.clientWidth, h = container.clientHeight;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.setClearColor(0x000000, 0);
    container.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.setSize(w, h);
    this.labels.domElement.className = "labels3d";
    container.appendChild(this.labels.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x060b16, 0.02);
    this.camera = new THREE.PerspectiveCamera(38, w / h, 0.1, 400);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.maxPolarAngle = 1.32;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 70;
    this.controls.autoRotateSpeed = 0.35;
    this.controls.addEventListener("start", () => { this.userMoved = true; this.controls.autoRotate = false; });
    this.interactive = interactive;
    if (!interactive) {  // story mode: the page scroll drives the camera, so the canvas ignores the mouse
      this.controls.enabled = false;
      this.userMoved = true;
      this.renderer.domElement.style.pointerEvents = "none";
    }

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 1.15, 0.6, 0.1);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.scene.add(new THREE.HemisphereLight(0x9cc3ff, 0x0b1322, 1.3));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(10, 20, 8);
    this.scene.add(key);
    this.alarmLight = new THREE.PointLight(0xff3355, 0, 18, 1.6);
    this.scene.add(this.alarmLight);

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    const el = this.renderer.domElement;
    el.addEventListener("pointermove", e => this.onPointer(e));
    el.addEventListener("click", () => { if (this.hovered) this.onSelect(this.hovered); });
    el.addEventListener("pointerleave", () => {
      this.hovered = null;
      this.container.dispatchEvent(new CustomEvent("hover3d", { detail: { id: null } }));
    });
    new ResizeObserver(() => this.resize()).observe(container);
  }

  // ---------- build ----------
  build(assets) {
    this.assets = assets;
    const list = Object.values(assets);
    const xs = list.map(a => a.x * S), zs = list.map(a => a.y * S);
    this.center = new THREE.Vector3((Math.min(...xs) + Math.max(...xs)) / 2, 0, (Math.min(...zs) + Math.max(...zs)) / 2);
    this.bounds = { x0: Math.min(...xs) - 3, x1: Math.max(...xs) + 3, z0: Math.min(...zs) - 3, z1: Math.max(...zs) + 3 };

    this.buildFloor();
    this.buildAir();
    list.forEach(a => this.buildAsset(a));
    this.buildPipes(list);
    this.buildEmbers();
    this.buildSparks();
    this.buildComets();
    this.buildRowLabels(list);

    this.home = { pos: this.center.clone().add(new THREE.Vector3(9, 15.5, 19)), target: this.center.clone().add(new THREE.Vector3(0.5, 0, 0)) };
    this.camera.position.copy(this.center).add(new THREE.Vector3(34, 46, 58));
    this.controls.target.copy(this.home.target);
    this.flyTo(this.home.pos, this.home.target, this.calm ? 0 : 2.6);
    this.intro(list);
    this.renderer.setAnimationLoop(() => this.frame());
  }

  pos(a) { return new THREE.Vector3(a.x * S, 0, a.y * S); }

  buildFloor() {
    const { x0, x1, z0, z1 } = this.bounds;
    const g = new THREE.Group();
    const mat = new THREE.LineBasicMaterial({ color: 0x173a66, transparent: true, opacity: 0.9 });
    const pts = [];
    for (let x = Math.floor(x0); x <= x1; x += S) pts.push(x, 0, z0, x, 0, z1);
    for (let z = Math.floor(z0); z <= z1; z += S) pts.push(x0, 0, z, x1, 0, z);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    g.add(new THREE.LineSegments(geo, mat));
    const slab = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0),
      new THREE.MeshStandardMaterial({ color: 0x070f1f, roughness: 0.95 }));
    slab.rotation.x = -Math.PI / 2;
    slab.position.set((x0 + x1) / 2, -0.01, (z0 + z1) / 2);
    g.add(slab);
    this.scene.add(g);
  }

  buildAir() {
    // faint cool-air particles drifting through the hall
    const { x0, x1, z0, z1 } = this.bounds, n = 260;
    this.air = { n, pos: new Float32Array(n * 3), speed: new Float32Array(n) };
    for (let i = 0; i < n; i++) {
      this.air.pos.set([x0 + Math.random() * (x1 - x0), 0.2 + Math.random() * 2.6, z0 + Math.random() * (z1 - z0)], i * 3);
      this.air.speed[i] = 0.25 + Math.random() * 0.45;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.air.pos, 3));
    this.airPoints = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0x3fb8ff, size: 0.055, transparent: true, opacity: 0.55, depthWrite: false,
    }));
    this.scene.add(this.airPoints);
  }

  buildAsset(a) {
    const [w, h, d] = DIMS[a.type] || [0.8, 1, 0.8];
    const group = new THREE.Group();
    group.position.copy(this.pos(a));
    const geo = new THREE.BoxGeometry(w, h, d);
    geo.translate(0, h / 2, 0);
    const body = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x0c1830, roughness: 0.55, metalness: 0.4, transparent: true, opacity: 0.94 }));
    body.userData.id = a.id;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: LINE_IDLE.clone() }));
    group.add(body, edges);

    let panel = null, glow = null;
    if (a.type === "rack" || a.type === "crah") {
      // glowing front panel shows heat, server LEDs as thin stripes
      panel = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.72, h * 0.8),
        new THREE.MeshBasicMaterial({ color: 0x3cc3a0, transparent: true, opacity: 0.55 }));
      panel.position.set(0, h * 0.5, d / 2 + 0.01);
      group.add(panel);
      for (let i = 0; i < 6; i++) {
        const stripe = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.62, 0.025), new THREE.MeshBasicMaterial({ color: 0x0f1a2c }));
        stripe.position.set(0, h * 0.18 + i * h * 0.12, d / 2 + 0.015);
        group.add(stripe);
      }
    }
    if (a.type === "rack") {
      glow = new THREE.Mesh(new THREE.CircleGeometry(1.0, 32),
        new THREE.MeshBasicMaterial({ color: 0x3cc3a0, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false }));
      glow.rotation.x = -Math.PI / 2;
      glow.position.y = 0.02;
      group.add(glow);
    }
    if (a.type === "chiller") { // fan rings on top
      for (const fx of [-w / 4, w / 4]) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.025, 6, 24), new THREE.MeshBasicMaterial({ color: 0x7f9fd0 }));
        ring.rotation.x = Math.PI / 2;
        ring.position.set(fx, h + 0.02, 0);
        group.add(ring);
      }
    }
    if (a.type !== "rack") {
      const div = document.createElement("div");
      div.className = "label3d";
      div.textContent = a.name.replace(" (backup)", "");
      const label = new CSS2DObject(div);
      label.position.set(0, h + 0.45, 0);
      group.add(label);
      this.pendingLabel = label;
    }
    this.scene.add(group);
    const minor = a.type === "pdu" || a.type === "crah";
    this.objs[a.id] = { a, group, body, edges, panel, glow, h, baseColor: LINE_IDLE.clone(), status: "ok",
      labelDiv: a.type !== "rack" ? this.pendingLabel : null, minor };
    if (minor && this.pendingLabel) this.pendingLabel.visible = false;
  }

  buildRowLabels(list) {
    "ABCD".split("").forEach(r => {
      const racks = list.filter(a => a.id.startsWith(`RACK-${r}`));
      if (!racks.length) return;
      const last = racks.reduce((m, a) => (a.x > m.x ? a : m));
      const div = document.createElement("div");
      div.className = "label3d row";
      div.textContent = `Row ${r}`;
      const l = new CSS2DObject(div);
      l.position.copy(this.pos(last)).add(new THREE.Vector3(1.4, 0.1, 0));
      this.scene.add(l);
    });
  }

  buildPipes(list) {
    const seen = new Set();
    const flowGeo = new THREE.SphereGeometry(0.07, 8, 8);
    const flows = [];
    for (const a of list) {
      for (const c of a.feeds) {
        const child = this.assets[c];
        const target = child.type === "rack" ? this.assets[`RACK-${c[5]}1`] : child;
        const key = a.id + ">" + target.id;
        if (seen.has(key)) continue;
        seen.add(key);
        const kind = a.type === "chiller" || a.type === "crah" ? "water" : "power";
        const y = kind === "water" ? 0.12 : 0.22;
        const p0 = this.pos(a).setY(y), p2 = this.pos(target).setY(y), p1 = new THREE.Vector3(p2.x, y, p0.z);
        const path = new THREE.CurvePath();
        path.add(new THREE.LineCurve3(p0, p1));
        path.add(new THREE.LineCurve3(p1, p2));
        const color = new THREE.Color(kind === "water" ? 0x1f6fd6 : 0xb07a12);
        const tube = new THREE.Mesh(new THREE.TubeGeometry(path, 40, 0.035, 6, false), new THREE.MeshBasicMaterial({ color }));
        this.scene.add(tube);
        const n = Math.max(2, Math.round(path.getLength() / 2.2));
        const pipe = { from: a.id, to: target.id, kind, path, tube, color, state: "ok", flows: [] };
        for (let i = 0; i < n; i++) flows.push({ pipe, t: i / n });
        this.pipes.push(pipe);
      }
    }
    this.flowMesh = new THREE.InstancedMesh(flowGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), flows.length);
    this.flowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.flows = flows;
    flows.forEach((f, i) => this.flowMesh.setColorAt(i, new THREE.Color(f.pipe.kind === "water" ? 0x4fd2ff : 0xffc23a)));
    this.scene.add(this.flowMesh);
  }

  buildEmbers() {
    const n = 500;
    this.embers = { n, pos: new Float32Array(n * 3), col: new Float32Array(n * 3), life: new Float32Array(n), vel: new Float32Array(n), next: 0 };
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.embers.pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(this.embers.col, 3));
    this.emberPoints = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.11, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.scene.add(this.emberPoints);
  }

  buildSparks() {
    const n = 900;
    this.sparks = { n, pos: new Float32Array(n * 3), col: new Float32Array(n * 3), vel: new Float32Array(n * 3), life: new Float32Array(n), next: 0 };
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.sparks.pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(this.sparks.col, 3));
    this.sparkPoints = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.09, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.sparkPoints.frustumCulled = false;
    this.scene.add(this.sparkPoints);
    this.sparks.pos.fill(-999);
  }

  burst(id, color = 0xff4a2b, count = 220) {
    // a shower of sparks out of the top of a machine
    const o = this.objs[id];
    if (!o || this.calm) return;
    const S = this.sparks, c = new THREE.Color(color), p = o.group.position;
    for (let k = 0; k < count; k++) {
      const i = S.next; S.next = (S.next + 1) % S.n;
      S.pos.set([p.x + (Math.random() - 0.5) * 0.6, o.h + 0.1, p.z + (Math.random() - 0.5) * 0.6], i * 3);
      const a = Math.random() * Math.PI * 2, sp = 1.5 + Math.random() * 4.5;
      S.vel.set([Math.cos(a) * sp, 3 + Math.random() * 6, Math.sin(a) * sp], i * 3);
      const w = 0.6 + Math.random() * 0.4;
      S.col.set([Math.min(1, c.r + 0.3) * w, c.g * w, c.b * w], i * 3);
      S.life[i] = 0.8 + Math.random() * 0.9;
    }
  }

  buildComets() {
    // bright pulses that travel through the pipes to show the chain spreading
    this.comets = [];
    const geo = new THREE.SphereGeometry(0.16, 12, 12);
    this.cometPool = [];
    for (let i = 0; i < 60; i++) {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xff2e63, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      m.visible = false;
      this.scene.add(m);
      this.cometPool.push(m);
    }
    // straight runs along each rack row so the chain visibly sweeps down the row
    this.rowRuns = {};
    "ABCD".split("").forEach(r => {
      const racks = Object.values(this.objs).filter(o => o.a.id.startsWith(`RACK-${r}`)).sort((a, b) => a.a.x - b.a.x);
      if (racks.length < 2) return;
      const y = 0.22, p0 = racks[0].group.position.clone().setY(y), p1 = racks[racks.length - 1].group.position.clone().setY(y);
      const path = new THREE.CurvePath(); path.add(new THREE.LineCurve3(p0, p1));
      this.rowRuns[racks[0].a.id] = { path, racks: racks.map(o => o.a.id) };
    });
  }

  pulseFrom(id, color = 0xff2e63, speed = 7, onHit) {
    // send a pulse down every pipe leaving this asset, then keep going downstream
    if (this.calm) return;
    const visited = new Set();
    const launch = (from, delay) => {
      for (const p of this.pipes) {
        if (p.from !== from || visited.has(p)) continue;
        visited.add(p);
        this.launchComet(p.path, color, speed, delay, () => {
          onHit && onHit(p.to);
          this.flashAsset(p.to, color);
          if (this.rowRuns[p.to]) {
            const run = this.rowRuns[p.to];
            this.launchComet(run.path, color, speed * 0.8, 0, null, t => {
              const idx = Math.min(run.racks.length - 1, Math.floor(t * run.racks.length));
              this.flashAsset(run.racks[idx], color);
            });
          }
          launch(p.to, 0);
        });
      }
    };
    launch(id, 0);
  }

  launchComet(path, color, speed, delay, done, onProgress) {
    const m = this.cometPool.find(c => !c.visible);
    if (!m) return;
    m.material.color.set(color);
    const len = path.getLength(), dur = Math.max(0.35, len / speed);
    m.visible = true;
    this.tween(dur, t => {
      m.position.copy(path.getPointAt(Math.min(1, t)));
      const s = 1 + Math.sin(t * Math.PI) * 0.6;
      m.scale.set(s, s, s);
      onProgress && onProgress(t);
    }, delay, () => { m.visible = false; done && done(); });
  }

  flashAsset(id, color) {
    const o = this.objs[id];
    if (!o) return;
    o.flash = { color: new THREE.Color(color), t: 1 };
  }

  powerOn(delay = 0.2) {
    // lights out, then every machine switches on in a sweep across the hall
    const list = Object.values(this.objs).sort((a, b) => (a.a.x + a.a.y * 0.4) - (b.a.x + b.a.y * 0.4));
    list.forEach(o => { o.lit = this.calm ? 1 : 0; });
    if (this.calm) return;
    list.forEach((o, k) => this.tween(0.5, t => { o.lit = ease(t); }, delay + k * 0.045));
  }

  slowMo(factor = 0.15, dur = 1.6) {
    if (this.calm) return;
    this.timeScale = factor;
    this.tween(dur, t => { this.timeScale = factor + (1 - factor) * ease(t); });
  }

  intro(list) {
    if (this.calm) return;
    const c = this.center;
    list.forEach(a => {
      const o = this.objs[a.id];
      const delay = 0.25 + o.group.position.distanceTo(c) * 0.06;
      o.group.scale.y = 0.001;
      this.tween(0.7, t => { o.group.scale.y = Math.max(0.001, ease(t)); }, delay);
    });
  }

  // ---------- live data ----------
  update(snap, cascade) {
    this.snap = snap;
    const tampered = new Set(cascade.filter(c => c.tamper).map(c => c.id));
    let alarmAt = null;
    for (const [id, s] of Object.entries(snap.assets)) {
      const o = this.objs[id];
      if (!o) continue;
      o.status = s.status;
      const a = o.a;
      let col;
      if (a.type === "rack") col = s.status === "offline" ? new THREE.Color(0x3a4458) : new THREE.Color(this.heat(s.inlet_temp_c));
      else if (BAD.has(s.status)) col = new THREE.Color(0xff2e63);
      else if (s.status === "degrading" || s.status === "on_battery") col = new THREE.Color(0xf2b33d);
      else if (s.status === "standby") col = new THREE.Color(0x46597a);
      else if (a.type === "crah") col = new THREE.Color(this.heat(s.supply_air_c + 5));
      else col = LINE_IDLE.clone();
      o.baseColor = col;
      o.temp = s.inlet_temp_c;
      if (o.panel) o.panel.material.color.copy(col);
      if (o.glow) {
        const t = s.inlet_temp_c ?? 22;
        o.glow.material.color.copy(col);
        o.glow.material.opacity = Math.min(0.55, Math.max(0, (t - 25) / 12));
      }
      o.tampered = tampered.has(id);
      if (BAD.has(s.status) && a.type !== "rack" && !alarmAt) alarmAt = o.group.position;
    }
    for (const p of this.pipes) {
      const s = snap.assets[p.from].status;
      p.state = BAD.has(s) ? "broken" : s === "standby" ? "dead" : "ok";
      p.tube.material.color.set(p.state === "broken" ? 0xff2e63 : p.state === "dead" ? 0x1a2740 : p.color.getHex());
    }
    if (alarmAt) { this.alarmLight.position.copy(alarmAt).setY(2.5); this.alarmOn = true; } else this.alarmOn = false;
    this.syncTamperRings();
  }

  syncTamperRings() {
    for (const o of Object.values(this.objs)) {
      if (o.tampered && !o.tamperRing) {
        o.tamperRing = new THREE.Mesh(new THREE.TorusGeometry(0.75, 0.04, 8, 40), new THREE.MeshBasicMaterial({ color: 0xc58bff }));
        o.tamperRing.rotation.x = Math.PI / 2;
        o.tamperRing.position.y = o.h + 0.5;
        o.group.add(o.tamperRing);
      } else if (!o.tampered && o.tamperRing) {
        o.group.remove(o.tamperRing);
        o.tamperRing = null;
      }
    }
  }

  failure(id) {
    const o = this.objs[id];
    if (!o) return;
    const at = o.group.position.clone();
    // shockwave across the floor
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 64),
      new THREE.MeshBasicMaterial({ color: 0xff2d55, transparent: true, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(at).setY(0.05);
    this.scene.add(ring);
    this.tween(this.calm ? 0.01 : 1.8, t => {
      const s = 1 + ease(t) * 16;
      ring.scale.set(s, s, s);
      ring.material.opacity = 1 - t;
    }, 0, () => { this.scene.remove(ring); ring.geometry.dispose(); });
    if (!this.calm) this.shake = 0.5;
    this.burst(id, 0xff4a2b, 260);
    this.slowMo(0.2, 1.8);
    this.pulseFrom(id, 0xff2e63, 6);
    // fly the camera to the failure, then back out a little so the cascade is visible
    const off = new THREE.Vector3(10, 13, 16);
    this.controls.autoRotate = false;
    this.flyTo(at.clone().add(off), at.clone().setY(0.8), this.calm ? 0 : 1.4);
  }

  recover(id) {
    // a cool wave rolls out from the fixed equipment, then the camera pulls back to show the whole hall
    const o = this.objs[id];
    const at = o ? o.group.position.clone() : this.center.clone();
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 64),
      new THREE.MeshBasicMaterial({ color: 0x22e9ff, transparent: true, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(at).setY(0.06);
    this.scene.add(ring);
    this.tween(this.calm ? 0.01 : 2.4, t => {
      const s = 1 + ease(t) * 22;
      ring.scale.set(s, s, s);
      ring.material.opacity = 1 - t;
    }, 0, () => { this.scene.remove(ring); ring.geometry.dispose(); });
    this.burst(id, 0x22e9ff, 160);
    this.pulseFrom(id, 0x22e9ff, 9);
    this.tween(0.01, () => this.resetView(), this.calm ? 0 : 1.2);
  }

  select(id) {
    this.selected = id;
  }

  lookAt(id, offset = [7, 9, 11], dur = 1.4) {
    const o = this.objs[id];
    if (!o) return;
    const at = o.group.position.clone();
    this.flyTo(at.clone().add(new THREE.Vector3(...offset)), at.clone().setY(0.8), this.calm ? 0 : dur);
  }

  lookAtRows(dur = 1.6) {
    const racks = Object.values(this.objs).filter(o => o.a.type === "rack").map(o => o.group.position);
    const c = racks.reduce((m, p) => m.add(p), new THREE.Vector3()).multiplyScalar(1 / racks.length);
    this.flyTo(c.clone().add(new THREE.Vector3(-6, 10, 13)), c.clone().setY(0.6), this.calm ? 0 : dur);
  }

  resetView() {
    this.flyTo(this.home.pos, this.home.target, this.calm ? 0 : 1.4);
  }

  setPaused(paused) {
    this.renderer.setAnimationLoop(paused ? null : () => this.frame());
    if (!paused) { this.clock.getDelta(); this.resize(); }
  }

  setCalm(calm) {
    this.calm = calm;
    if (calm) this.controls.autoRotate = false;
  }

  // ---------- interaction ----------
  onPointer(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(Object.values(this.objs).map(o => o.body))[0];
    this.hovered = hit ? hit.object.userData.id : null;
    this.renderer.domElement.style.cursor = this.hovered ? "pointer" : "grab";
    this.container.dispatchEvent(new CustomEvent("hover3d", { detail: { id: this.hovered, x: e.clientX - r.left, y: e.clientY - r.top } }));
  }

  // ---------- animation ----------
  tween(dur, fn, delay = 0, done) {
    this.tweens.push({ t0: this.clock.elapsedTime + delay, dur: Math.max(dur, 0.001), fn, done });
  }

  flyTo(pos, target, dur) {
    const p0 = this.camera.position.clone(), t0 = this.controls.target.clone();
    this.tween(dur, t => {
      const k = ease(t);
      this.camera.position.lerpVectors(p0, pos, k);
      this.controls.target.lerpVectors(t0, target, k);
    }, 0, () => { if (!this.userMoved && !this.calm && !this.alarmOn) this.controls.autoRotate = true; });
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.labels.setSize(w, h);
  }

  frame() {
    const rawDt = Math.min(this.clock.getDelta(), 0.05), now = this.clock.elapsedTime;
    const dt = rawDt * (this.timeScale ?? 1);

    this.tweens = this.tweens.filter(tw => {
      if (now < tw.t0) return true;
      const t = Math.min(1, (now - tw.t0) / tw.dur);
      tw.fn(t);
      if (t >= 1) { tw.done && tw.done(); return false; }
      return true;
    });

    // equipment colors, hover and selection, alarm pulse
    const pulse = 0.5 + 0.5 * Math.sin(now * 6);
    for (const [id, o] of Object.entries(this.objs)) {
      const target = id === this.selected || id === this.hovered ? SELECT
        : BAD.has(o.status) && o.a.type !== "rack" ? new THREE.Color(0xff2d55).multiplyScalar(0.6 + 0.8 * pulse)
        : o.baseColor;
      const lit = o.lit ?? 1;
      let want = target;
      if (o.flash && o.flash.t > 0) {
        want = target.clone().lerp(o.flash.color, o.flash.t);
        o.flash.t -= rawDt * 1.4;
      }
      o.edges.material.color.lerp(want.clone().multiplyScalar(0.12 + 0.88 * lit), 0.2);
      if (o.panel) o.panel.material.opacity = 0.55 * lit + (o.flash && o.flash.t > 0 ? o.flash.t * 0.4 : 0);
      if (o.minor && o.labelDiv) {
        const show = id === this.selected || id === this.hovered || BAD.has(o.status) || o.status === "degrading";
        o.labelDiv.visible = show;
      }
      if (o.tamperRing) { o.tamperRing.rotation.z += dt * 2; o.tamperRing.position.y = o.h + 0.5 + Math.sin(now * 3) * 0.08; }
      if (o.a.type === "chiller" && o.status === "ok") o.group.children.forEach(c => { if (c.geometry?.type === "TorusGeometry") c.rotation.z += dt * 4; });
    }
    this.alarmLight.intensity = this.alarmOn ? 18 + 14 * pulse : 0;

    // flowing particles in the pipes
    const m = new THREE.Matrix4(), hide = new THREE.Matrix4().makeScale(0, 0, 0);
    this.flows.forEach((f, i) => {
      if (f.pipe.state !== "ok") { this.flowMesh.setMatrixAt(i, hide); return; }
      if (!this.calm) f.t = (f.t + dt * (f.pipe.kind === "water" ? 0.08 : 0.12) * (12 / f.pipe.path.getLength())) % 1;
      m.makeTranslation(f.pipe.path.getPointAt(f.t));
      this.flowMesh.setMatrixAt(i, m);
    });
    this.flowMesh.instanceMatrix.needsUpdate = true;

    // embers rising from hot racks
    const E = this.embers;
    if (!this.calm) {
      for (const o of Object.values(this.objs)) {
        if (o.a.type !== "rack" || !(o.temp > 26.5)) continue;
        const rate = (o.temp - 26) * 0.9 * dt;
        if (Math.random() < rate) {
          const i = E.next; E.next = (E.next + 1) % E.n;
          const p = o.group.position;
          E.pos.set([p.x + (Math.random() - 0.5) * 0.7, o.h + 0.05, p.z + (Math.random() - 0.5) * 0.7], i * 3);
          const c = o.baseColor;
          E.col.set([c.r, c.g, c.b], i * 3);
          E.life[i] = 1; E.vel[i] = 0.6 + Math.random() * 0.8;
        }
      }
    }
    for (let i = 0; i < E.n; i++) {
      if (E.life[i] <= 0) continue;
      E.life[i] -= dt * 0.55;
      E.pos[i * 3 + 1] += E.vel[i] * dt;
      E.pos[i * 3] += Math.sin(now * 2 + i) * dt * 0.15;
      const k = Math.max(0, E.life[i]);
      E.col[i * 3] *= 0.985 + 0.015 * k; E.col[i * 3 + 1] *= 0.985 + 0.015 * k; E.col[i * 3 + 2] *= 0.985 + 0.015 * k;
      if (E.life[i] <= 0) E.pos[i * 3 + 1] = -50;
    }
    this.emberPoints.geometry.attributes.position.needsUpdate = true;
    this.emberPoints.geometry.attributes.color.needsUpdate = true;

    // drifting cool air
    if (!this.calm) {
      const A = this.air, { x0, x1 } = this.bounds;
      for (let i = 0; i < A.n; i++) {
        A.pos[i * 3] += A.speed[i] * dt;
        A.pos[i * 3 + 1] += Math.sin(now * 0.7 + i) * dt * 0.05;
        if (A.pos[i * 3] > x1) A.pos[i * 3] = x0;
      }
      this.airPoints.geometry.attributes.position.needsUpdate = true;
    }

    // sparks: fly out, fall, fade
    const SP = this.sparks;
    for (let i = 0; i < SP.n; i++) {
      if (SP.life[i] <= 0) continue;
      SP.life[i] -= dt;
      SP.vel[i * 3 + 1] -= 9.8 * dt;
      SP.pos[i * 3] += SP.vel[i * 3] * dt; SP.pos[i * 3 + 1] += SP.vel[i * 3 + 1] * dt; SP.pos[i * 3 + 2] += SP.vel[i * 3 + 2] * dt;
      if (SP.pos[i * 3 + 1] < 0.02) { SP.pos[i * 3 + 1] = 0.02; SP.vel[i * 3 + 1] *= -0.35; SP.vel[i * 3] *= 0.6; SP.vel[i * 3 + 2] *= 0.6; }
      const f = 0.965;
      SP.col[i * 3] *= f; SP.col[i * 3 + 1] *= f; SP.col[i * 3 + 2] *= f;
      if (SP.life[i] <= 0) SP.pos[i * 3 + 1] = -999;
    }
    this.sparkPoints.geometry.attributes.position.needsUpdate = true;
    this.sparkPoints.geometry.attributes.color.needsUpdate = true;

    // camera shake on failure
    if (this.shake > 0) {
      this.camera.position.x += (Math.random() - 0.5) * this.shake;
      this.camera.position.y += (Math.random() - 0.5) * this.shake;
      this.shake *= 0.88;
      if (this.shake < 0.01) this.shake = 0;
    }

    this.controls.update();
    this.composer.render();
    this.labels.render(this.scene, this.camera);
  }
}
