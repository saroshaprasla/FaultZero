// FaultZero main UI: 3D data hall (2D fallback), live heat, cascade prediction.
import { Scene3D, webglAvailable } from "./scene3d.js";
const NS = "http://www.w3.org/2000/svg";
const TW = 76, TH = 38;          // isometric tile width / height in px
const HISTORY = 30;             // minutes of history kept per asset

const FAILURES = [
  ["chiller_trip", "Trip Chiller 2"],
  ["fan_degradation", "Wear out cooling unit 4's fan"],
  ["grid_loss", "Cut utility power"],
  ["sensor_silent", "Silence rack C3's sensor"],
  ["sensor_spoof", "Hack rack C4's sensor"],
];
const ACTIONS = [
  ["start_backup_chiller", "Start backup chiller"],
  ["raise_fan_speed", "Raise all fan speeds"],
  ["start_generator", "Start generator"],
  ["shift_load", "Move load off row C"],
];
const METRIC = { rack: "inlet_temp_c", chiller: "supply_temp_c", crah: "supply_air_c", ups: "battery_min", pdu: "load_pct" };
const UNIT = { inlet_temp_c: "°C", supply_temp_c: "°C", supply_air_c: "°C", battery_min: " min", load_pct: "%", fan_pct: "%", power_kw: " kW", load_kw: " kW" };
const NICE = {
  inlet_temp_c: "Inlet air", supply_temp_c: "Water out", supply_air_c: "Air out", battery_min: "Battery left",
  load_pct: "Load", fan_pct: "Fan speed", power_kw: "Power draw", load_kw: "Load", on_battery: "On battery",
};
const BAD = new Set(["tripped", "down", "depleted", "offline", "no_power", "critical", "degrading", "on_battery"]);
const SIZE = { // footprint w, d (tiles) and height px
  utility: [0.8, 0.8, 46], generator: [1.1, 0.8, 26], ups: [0.9, 0.9, 30], pdu: [0.6, 0.6, 24],
  chiller: [1.4, 0.85, 26], crah: [0.75, 0.75, 34], rack: [0.62, 0.7, 30],
};

let assets = {}, children = {}, parents = {};
let scene3d = null;
let latest = null, selected = null, lastEventCount = 0;
const hist = {};
const els = {};

// ---------- helpers ----------
const $ = id => document.getElementById(id);
const iso = (x, y) => [(x - y) * TW / 2, (x + y) * TH / 2];
function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}
const pts = arr => arr.map(p => p.join(",")).join(" ");
const fmt = (v, unit = "") => (v === null || v === undefined ? "no data" : typeof v === "number" ? `${v.toFixed(1)}${unit}` : String(v));

function mix(a, b, t) {
  const pa = a.match(/\w\w/g).map(h => parseInt(h, 16)), pb = b.match(/\w\w/g).map(h => parseInt(h, 16));
  return "#" + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, "0")).join("");
}
const RAMP = [[20, "1fb6ff"], [24, "19f5b0"], [27, "ffb21e"], [30, "ff6a2b"], [32, "ff2e63"]];
function heat(t) {
  if (t === null || t === undefined) return "#56627a";
  if (t <= RAMP[0][0]) return "#" + RAMP[0][1];
  for (let i = 1; i < RAMP.length; i++) {
    if (t <= RAMP[i][0]) {
      const [t0, c0] = RAMP[i - 1], [t1, c1] = RAMP[i];
      return mix(c0, c1, (t - t0) / (t1 - t0));
    }
  }
  return "#" + RAMP[RAMP.length - 1][1];
}
function shade(hex, f) { return mix(hex.replace("#", ""), f < 1 ? "060b16" : "ffffff", Math.abs(1 - f)); }

function equipColor(a, s) {
  if (!s) return "#2c4060";
  if (s.status === "standby") return "#2c4060";
  if (BAD.has(s.status)) return s.status === "degrading" || s.status === "on_battery" ? "#f2b33d" : "#d92d55";
  if (a.type === "crah") return heat(s.supply_air_c + 5);
  if (a.type === "chiller") return s.supply_temp_c > 10 ? "#f2b33d" : "#3a7fb8";
  return "#3a6a8f";
}

// ---------- build the map ----------
function buildMap() {
  const svg = $("svg");
  svg.innerHTML = "";
  const all = Object.values(assets);
  const xs = [], ys = [];
  all.forEach(a => { const [px, py] = iso(a.x, a.y); xs.push(px); ys.push(py); });
  const pad = 110;
  svg.setAttribute("viewBox", `${Math.min(...xs) - pad} ${Math.min(...ys) - pad} ${Math.max(...xs) - Math.min(...xs) + pad * 2} ${Math.max(...ys) - Math.min(...ys) + pad * 2}`);

  // floor grid
  const floor = el("g", {}, svg);
  const maxX = Math.ceil(Math.max(...all.map(a => a.x))) + 1, maxY = Math.ceil(Math.max(...all.map(a => a.y))) + 1;
  for (let x = -1; x <= maxX; x++) el("polyline", { class: "floor", points: pts([iso(x, -1), iso(x, maxY)]) }, floor);
  for (let y = -1; y <= maxY; y++) el("polyline", { class: "floor", points: pts([iso(-1, y), iso(maxX, y)]) }, floor);

  // edges: draw to the first rack of a row instead of to every rack
  const edgeLayer = el("g", {}, svg);
  els.edges = [];
  const seen = new Set();
  for (const a of all) {
    for (const c of a.feeds) {
      const child = assets[c];
      let target = child;
      if (child.type === "rack") target = assets[`RACK-${c[5]}1`];
      const key = a.id + ">" + target.id;
      if (seen.has(key)) continue;
      seen.add(key);
      const kind = a.type === "chiller" || a.type === "crah" ? "water" : "power";
      const [x1, y1] = iso(a.x, a.y), [x2, y2] = iso(target.x, target.y);
      const mid = iso(target.x, a.y);
      const path = el("path", { class: `edge ${kind}`, d: `M${x1},${y1} L${mid[0]},${mid[1]} L${x2},${y2}` }, edgeLayer);
      els.edges.push({ from: a.id, to: target.id, row: child.type === "rack" ? c[5] : null, kind, path });
    }
  }

  // row labels
  "ABCD".split("").forEach((r, i) => {
    const [px, py] = iso(maxX + 0.2, i * 2);
    const t = el("text", { class: "row-label", x: px, y: py + 4 }, svg);
    t.textContent = `Row ${r}`;
  });

  // assets, painter's order
  const assetLayer = el("g", {}, svg);
  els.fx = el("g", {}, svg);
  const labelLayer = el("g", {}, svg);
  const labels = [];
  els.assets = {};
  all.sort((a, b) => (a.x + a.y) - (b.x + b.y) || a.x - b.x).forEach(a => {
    const [w, d, h] = SIZE[a.type] || [0.7, 0.7, 26];
    const g = el("g", { class: "asset", tabindex: 0, role: "button", "aria-label": a.name }, assetLayer);
    const x0 = a.x - w / 2, y0 = a.y - d / 2, x1 = a.x + w / 2, y1 = a.y + d / 2;
    const up = p => [p[0], p[1] - h];
    const A = iso(x0, y0), B = iso(x1, y0), C = iso(x1, y1), D = iso(x0, y1);
    const left = el("polygon", { class: "face", points: pts([D, C, up(C), up(D)]) }, g);
    const right = el("polygon", { class: "face", points: pts([C, B, up(B), up(C)]) }, g);
    const top = el("polygon", { class: "face top-face", points: pts([up(A), up(B), up(C), up(D)]) }, g);
    if (a.type !== "rack") {
      const [lx, ly] = iso(a.x, a.y);
      labels.push([lx, ly - h - TH * d / 2 - 6, a.id]);
    }
    g.addEventListener("click", () => select(a.id));
    g.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(a.id); } });
    const [cx, cy] = iso(a.x, a.y);
    els.assets[a.id] = { g, top, left, right, center: [cx, cy - h / 2] };
  });
  // labels on top of everything so boxes never hide them
  labels.forEach(([x, y, txt]) => {
    const t = el("text", { class: "asset-label", x, y, "text-anchor": "middle" }, labelLayer);
    t.textContent = txt;
  });
}

// ---------- live update ----------
function update(snap) {
  latest = snap;
  for (const [id, s] of Object.entries(snap.assets)) {
    (hist[id] ||= []).push({ m: snap.minute, ...s });
    if (hist[id].length > HISTORY) hist[id].shift();
  }

  const hh = snap.t.slice(11, 16);
  $("clock").textContent = hh;
  $("outdoor").textContent = `${snap.outdoor_temp_c.toFixed(0)}°C`;

  paintMap(previewSnap(snap));

  // new failure events → ripple
  const evs = snap.events || [];
  const fresh = evs.filter(e => e.minute >= 0).slice(lastEventCount > evs.length ? 0 : lastEventCount);
  fresh.forEach(e => {
    if (e.type !== "failure") return;
    if (!$("qr-modal").hidden) $("qr-modal").hidden = true;
    ripple(e.asset);
    if (scene3d) scene3d.failure(e.asset);
    const f = $("screen-flash"); f.classList.remove("go"); void f.offsetWidth; f.classList.add("go");
  });
  lastEventCount = evs.length;

  const cascade = predict(snap);
  drawPulses(snap, cascade);
  if (scene3d) scene3d.update(previewSnap(snap), cascade);
  syncScrubber(snap);
  renderTimeline(cascade);
  renderSide(snap, cascade);
  finishUpdate(snap, cascade);
}

function paintMap(snap) {
  for (const [id, a] of Object.entries(assets)) {
    const s = snap.assets[id], e = els.assets[id];
    const base = a.type === "rack"
      ? (s.status === "offline" ? "#2a3446" : heat(s.inlet_temp_c))
      : equipColor(a, s);
    e.top.setAttribute("fill", base);
    e.left.setAttribute("fill", shade(base, 0.55));
    e.right.setAttribute("fill", shade(base, 0.72));
    e.g.classList.toggle("failed", BAD.has(s.status) && a.type !== "rack");
  }

  for (const ed of els.edges) {
    const s = snap.assets[ed.from];
    const broken = ["tripped", "down", "depleted", "no_power"].includes(s.status);
    const dead = s.status === "standby";
    ed.path.classList.toggle("broken", broken);
    ed.path.classList.toggle("dead", dead && !broken);
  }
}

function finishUpdate(snap, cascade) {
  const evs = snap.events || [];
  const atRisk = new Set(cascade.filter(c => assets[c.id].type === "rack").map(c => c.id)).size;
  $("risk").textContent = atRisk;
  $("risk-wrap").classList.toggle("zero", atRisk === 0);
  if (!preview.minute) document.body.style.setProperty("--danger", (Math.min(atRisk, 12) / 12 * 0.45).toFixed(2));
  const failed = evs.some(e => e.type === "failure");
  const contained = failed && atRisk === 0 && snap.agent && snap.agent.decision;
  $("status").textContent = contained ? "Contained, watching" : failed ? "Incident in progress" : "All systems normal";
  $("status").classList.toggle("incident", failed && !contained);
  $("status").classList.toggle("contained", !!contained);
}

// ---------- time scrubber: drag into the predicted future ----------
const preview = { minute: 0, plan: null, data: null, loading: false, ticks: 0, playing: false };

function previewSnap(snap) {
  if (!preview.minute || !preview.data || !preview.data.frames.length) return snap;
  const f = preview.data.frames[Math.min(preview.minute, preview.data.frames.length) - 1];
  return { ...snap, assets: f.assets };
}

async function loadFuture() {
  if (preview.loading) return;
  preview.loading = true;
  try {
    const q = preview.plan === null ? "" : `?plan=${preview.plan}`;
    const r = await fetch(`/api/future${q}`);
    preview.data = r.ok ? await r.json() : null;
  } finally { preview.loading = false; }
  repaintPreview();
}

function repaintPreview() {
  if (!latest) return;
  const snap = previewSnap(latest);
  paintMap(snap);
  if (scene3d) scene3d.update(snap, []);
  const m = preview.minute, on = m > 0 && preview.data;
  $("map").classList.toggle("future", !!on);
  $("fut-back").hidden = !m;
  const hot = on ? preview.data.hot[Math.min(m, preview.data.hot.length) - 1] : null;
  const t = latest.t ? new Date(latest.t) : null;
  const when = t ? new Date(t.getTime() + m * 60000).toTimeString().slice(0, 5) : "";
  $("fut-label").textContent = m ? `+${m} min (${when})` : "Now";
  $("fut-badge").innerHTML = on
    ? `<span>Predicted, ${m} min from now</span><b>${hot} rack${hot === 1 ? "" : "s"} over 27°C</b><span>${preview.plan === null ? "if nothing is done" : esc(preview.data.label)}</span>`
    : "";
  if (on) document.body.style.setProperty("--danger", (Math.min(hot, 12) / 12 * 0.45).toFixed(2));
}

function setMinute(m) {
  preview.minute = m;
  $("fut-range").value = m;
  if (m && !preview.data) loadFuture(); else repaintPreview();
}

function syncScrubber(snap) {
  const incident = (snap.events || []).some(e => e.type === "failure") && (snap.cascade || []).length;
  $("future-bar").classList.toggle("off", !incident);
  $("fut-range").disabled = !incident;
  $("fut-play").disabled = !incident;
  if (!incident && preview.minute) { preview.minute = 0; preview.data = null; preview.plan = null; repaintPreview(); }
  // plan chips: "Do nothing" plus each plan the agent proposed
  const plans = (snap.agent && !snap.agent.decision && snap.agent.plans) || [];
  // two futures side by side: doing nothing vs the agent's recommended plan
  const chips = [`<button data-plan="" aria-pressed="${preview.plan === null}">Do nothing</button>`]
    .concat(plans.slice(0, 1).map((p, i) => `<button data-plan="${i}" aria-pressed="${preview.plan === i}" title="${esc(p.name)}">With the fix</button>`)).join("");
  if ($("fut-plans").dataset.html !== chips) { $("fut-plans").innerHTML = chips; $("fut-plans").dataset.html = chips; }
  if (preview.plan !== null && !plans.length) { preview.plan = null; preview.data = null; }
  // keep the preview current as live time moves on
  if (preview.minute && ++preview.ticks % 3 === 0) loadFuture();
}

function playFuture() {
  if (preview.playing) return;
  preview.playing = true;
  const start = performance.now(), from = preview.minute >= 60 ? 0 : preview.minute, dur = 6000 * (60 - from) / 60;
  if (!preview.data) loadFuture();
  const step = now => {
    const t = Math.min(1, (now - start) / Math.max(dur, 1));
    setMinute(Math.round(from + (60 - from) * t));
    if (t < 1 && preview.playing) requestAnimationFrame(step); else preview.playing = false;
  };
  requestAnimationFrame(step);
}

function setupScrubber() {
  $("fut-range").addEventListener("input", e => { preview.playing = false; setMinute(Number(e.target.value)); });
  $("fut-play").onclick = playFuture;
  $("fut-back").onclick = () => { preview.playing = false; setMinute(0); };
  $("fut-plans").addEventListener("click", e => {
    const b = e.target.closest("[data-plan]");
    if (!b) return;
    preview.plan = b.dataset.plan === "" ? null : Number(b.dataset.plan);
    $("fut-plans").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    if (scene3d && latest && latest.roots && latest.roots[0]) (preview.plan === null ? scene3d.failure : scene3d.recover).call(scene3d, latest.roots[0]);
    preview.data = null;
    if (!preview.minute) setMinute(30); else loadFuture();
  });
}

// ---------- cascade: digital-twin projection from the backend + tamper checks ----------
function predict(snap) {
  const out = (snap.cascade || []).map(c => ({
    id: c.id, minutes: c.minutes, now: c.minutes === 0, text: c.text, because: c.because, level: c.level,
  }));
  for (const [id, a] of Object.entries(assets)) {
    if (a.type !== "rack") continue;
    const s = snap.assets[id];
    if (s.inlet_temp_c === null) {
      out.unshift({ id, minutes: 0, now: true, tamper: true, text: `${a.name} sensor went silent`, because: "no readings for this rack" });
      continue;
    }
    const h = hist[id] || [];
    if (h.length < 6) continue;
    const vals = h.slice(-6).map(p => p.inlet_temp_c);
    if (vals.some(v => v === null)) continue;
    const flat = Math.max(...vals) - Math.min(...vals) < 0.05;
    if (!flat) continue;
    // 1) the reading is frozen while the rest of its row heats up
    const row = Object.keys(assets).filter(r => r !== id && r.startsWith(`RACK-${id[5]}`));
    const rowMean = row.reduce((t, r) => t + (snap.assets[r].inlet_temp_c ?? 0), 0) / row.length;
    // 2) the rack suddenly draws far more power but its temperature never moves
    const p0 = Math.min(...h.map(p => p.power_kw)), p1 = s.power_kw;
    const now = vals[vals.length - 1];
    if (rowMean - now > 3) {
      out.unshift({ id, minutes: 0, now: true, tamper: true, text: `${a.name} sensor reads ${now.toFixed(1)}°C, its row is ${rowMean.toFixed(1)}°C`, because: "possible tampering" });
    } else if (p1 > p0 * 1.6) {
      out.unshift({ id, minutes: 0, now: true, tamper: true, text: `${a.name} power jumped ${p0.toFixed(0)} → ${p1.toFixed(0)} kW, temperature never moved`, because: "possible tampering" });
    }
  }
  return out;
}

// ---------- effects ----------
function ripple(id) {
  const e = els.assets[id];
  if (!e) return;
  const [cx, cy] = e.center;
  el("ellipse", { class: "ripple", cx, cy, rx: 30, ry: 15 }, els.fx);
  setTimeout(() => els.fx.querySelector(".ripple")?.remove(), 1500);
}
function drawPulses(snap, cascade) {
  els.fx.querySelectorAll(".pulse, .tamper").forEach(n => n.remove());
  cascade.filter(c => c.now).slice(0, 12).forEach(c => {
    const [cx, cy] = els.assets[c.id].center;
    el("ellipse", { class: c.tamper ? "tamper" : "pulse", cx, cy, rx: 24, ry: 12 }, els.fx);
  });
}

// ---------- timeline ----------
// Racks in the same row with the same kind of problem become one card.
function groupRows(cascade) {
  const out = [], rows = {};
  for (const c of cascade) {
    const a = assets[c.id];
    if (a.type !== "rack" || c.tamper) { out.push(c); continue; }
    (rows[c.id[5] + "|" + c.level] ||= []).push(c);
  }
  for (const [key, list] of Object.entries(rows)) {
    if (list.length === 1) { out.push(list[0]); continue; }
    const [row, level] = key.split("|");
    const verb = { warning: "pass 27°C", critical: "pass 32°C", failed: "shut down" }[level] || "are at risk";
    const minutes = Math.min(...list.map(c => c.minutes));
    out.push({ id: list[0].id, minutes, now: minutes === 0, text: `Row ${row}: ${list.length} racks ${verb}`, because: list[0].because, level });
  }
  return out.sort((a, b) => a.minutes - b.minutes || (b.tamper ? 1 : 0) - (a.tamper ? 1 : 0));
}

let tlCache = "";
function renderTimeline(cascade) {
  const items = groupRows(cascade).slice(0, 24);
  const now = items.filter(c => c.now), later = items.filter(c => !c.now);

  // left: everything happening right now, stacked
  const nowHtml = now.length
    ? `<div class="tl-now-head"><b>Now</b><span>${now.length} active</span></div>
       <ul>${now.slice(0, 4).map(c => `<li class="${c.tamper ? "tam" : ""}" data-id="${c.id}">${esc(c.text)}</li>`).join("")}</ul>
       ${now.length > 4 ? `<div class="tl-more">and ${now.length - 4} more</div>` : ""}`
    : `<div class="tl-now-head calm"><b>Now</b><span>All clear</span></div><p>Nothing failing. Use “Test the facility” to break something.</p>`;

  // right: future failures pinned at their minute on the track (2-minute buckets)
  const buckets = {};
  later.forEach(c => { const k = Math.max(1, Math.round(c.minutes / 4) * 4); (buckets[k] ||= []).push(c); });
  const keys = Object.keys(buckets).map(Number).sort((a, b) => a - b);
  const ticks = [0, 15, 30, 45, 60].map(m => `<span class="tl-tick" style="left:${(m / 60) * 100}%">${m === 0 ? "Now" : `+${m}`}</span>`).join("");
  const tags = keys.map((k, i) => {
    const list = buckets[k], first = list[0];
    const left = Math.min(96, Math.max(2, (k / 60) * 100));
    void i;
    return `<button class="tl-pin" style="left:${left}%" data-pct="${left}" data-id="${first.id}">
      <span class="tl-stem"></span>
      <span class="tl-tag chamfer"><b>+${Math.round(first.minutes)} min</b><span>${esc(first.text)}${list.length > 1 ? ` <em>+${list.length - 1}</em>` : ""}</span></span>
    </button>`;
  }).join("");
  const trackHtml = `<div class="tl-axis">${ticks}</div>${tags || `<div class="tl-empty">${now.length ? "Nothing else predicted in the next hour." : ""}</div>`}`;

  const html = nowHtml + "|" + trackHtml;
  if (html === tlCache) return;
  tlCache = html;
  $("tl-now").innerHTML = nowHtml;
  $("tl-now").classList.toggle("hot", now.length > 0);
  $("tl-track").innerHTML = trackHtml;
  layoutPins();
}

// place each tag above or below the axis so no two tags overlap
function layoutPins() {
  const track = $("tl-track"), W = track.clientWidth, TAG = 178, GAP = 8;
  const lanes = { high: -Infinity, low: -Infinity };
  track.querySelectorAll(".tl-pin").forEach(pin => {
    const x = (Number(pin.dataset.pct) / 100) * W;
    const tag = pin.querySelector(".tl-tag");
    let lane = lanes.high <= lanes.low ? "high" : "low";
    let start = Math.max(x - 4, lanes[lane] + GAP);
    const other = lane === "high" ? "low" : "high";
    if (start > x + 40 && Math.max(x - 4, lanes[other] + GAP) < start) { lane = other; start = Math.max(x - 4, lanes[other] + GAP); }
    start = Math.min(start, W - TAG);
    pin.classList.remove("high", "low");
    pin.classList.add(lane);
    tag.style.left = `${start - x}px`;
    tag.style.right = "auto";
    lanes[lane] = start + TAG;
  });
}
window.addEventListener("resize", () => { if ($("tl-track")) layoutPins(); });

// ---------- side panel ----------
function select(id) {
  selected = selected === id ? null : id;
  $("tip").hidden = true;
  if (scene3d) scene3d.select(selected);
  Object.entries(els.assets).forEach(([k, e]) => e.g.classList.toggle("selected", k === selected));
  if (latest) renderSide(latest, predict(latest));
}

function calibHtml(snap) {
  const cal = Object.entries(snap.calibration || {}).filter(([, e]) => e.readings >= 2);
  if (!cal.length) return "";
  const txt = cal.map(([id, e]) => e.param === "capacity"
    ? `${esc(assets[id]?.name || id)} at ~${Math.round(e.estimate * 100)}% capacity`
    : `${esc(assets[id]?.name || id)} fan losing ~${e.estimate.toFixed(1)}% per min`).join(" · ");
  return `<p class="calib" title="The twin is never told how bad the failure is. It infers it from the last two sensor readings.">Twin calibrated from sensors: <b>${txt}</b></p>`;
}
function sparkline(id, metric) {
  const h = (hist[id] || []).filter(p => typeof p[metric] === "number");
  if (h.length < 2) return "";
  const vals = h.map(p => p[metric]);
  const lo = Math.min(...vals), hi = Math.max(...vals) + 0.01;
  const W = 320, H = 56;
  const line = vals.map((v, i) => `${(i / (vals.length - 1)) * W},${H - 4 - ((v - lo) / (hi - lo)) * (H - 8)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline points="${line}" fill="none" stroke="#7fe3f0" stroke-width="2"/></svg>`;
}

// ---------- long-term history stored in Tiger Data (only when TIGER_URL is set on the server) ----------
const tigerHist = {};
let tigerOn = false;
fetch("/api/tiger").then(r => r.json()).then(t => { tigerOn = !!t.enabled; }).catch(() => {});
async function pollTiger() {
  if (tigerOn && selected && ["rack", "crah", "chiller"].includes(assets[selected]?.type)) {
    try {
      const d = await (await fetch(`/api/history?asset=${encodeURIComponent(selected)}&minutes=60&bucket=5`)).json();
      if (d.ok) tigerHist[selected] = d;
    } catch (e) { /* history is optional; never break the console */ }
  }
  setTimeout(pollTiger, 4000);
}
setTimeout(pollTiger, 1500);
function tigerBlock(id) {
  if (!tigerOn) return "";
  const d = tigerHist[id];
  if (!d || !d.points || d.points.length < 2) return `<div class="tiger"><span class="tg-h">Tiger Data history</span><span class="tg-sub">Collecting readings…</span></div>`;
  const pts = d.points.filter(p => p.max != null);
  const lo = Math.min(...pts.map(p => p.min)) - 0.3, hi = Math.max(...pts.map(p => p.max)) + 0.3;
  const W = 320, H = 70, bw = W / pts.length;
  const y = v => H - 4 - ((v - lo) / (hi - lo)) * (H - 10);
  const warn = assets[id]?.limit?.warn;
  const bars = pts.map((p, i) => {
    const hot = warn != null && p.max >= warn;
    return `<rect x="${i * bw + 2}" y="${y(p.max)}" width="${Math.max(2, bw - 4)}" height="${Math.max(2, y(p.min) - y(p.max))}" rx="1.5" fill="${hot ? "#ff6a2b" : "#22e9ff"}" opacity=".35"/>
      <rect x="${i * bw + 2}" y="${y(p.avg) - 1}" width="${Math.max(2, bw - 4)}" height="2.5" fill="${hot ? "#ff6a2b" : "#22e9ff"}"/>`;
  }).join("");
  const warnLine = warn != null && warn > lo && warn < hi ? `<line x1="0" x2="${W}" y1="${y(warn)}" y2="${y(warn)}" stroke="#ffb21e" stroke-dasharray="4 4" stroke-width="1"/>` : "";
  const last = pts[pts.length - 1];
  return `<div class="tiger"><span class="tg-h">Tiger Data history <em>· ${d.bucket_min}-min buckets · ${d.rows_this_run.toLocaleString()} rows this run</em></span>
    <svg class="tg-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Temperature history">${warnLine}${bars}</svg>
    <span class="tg-sub">Last bucket: avg ${last.avg}°C, max ${last.max}°C${warn != null ? ` · dashed line = ${warn}°C warning` : ""}</span></div>`;
}

const esc = t => String(t ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const slotCache = {};
function setSlot(id, html) {
  if (slotCache[id] === html) return;  // only touch the DOM when something changed, so buttons stay clickable
  slotCache[id] = html;
  $(id).innerHTML = html;
}
let stepsShown = 0, stepsOpen = false;

function renderSide(snap, cascade) {
  const failures = (snap.events || []).filter(e => e.type === "failure");
  const racks = new Set(cascade.filter(c => assets[c.id].type === "rack").map(c => c.id)).size;

  // incident card
  let inc = "";
  if (failures.length) {
    const first = failures[0], a = assets[first.asset];
    const KIND = { chiller_trip: "tripped", grid_loss: "lost utility power", fan_degradation: "fan is wearing out", sensor_silent: "sensor went silent", sensor_spoof: "sensor was hacked" };
    const next = cascade.find(c => c.minutes > 0);
    const uniq = new Set(failures.map(f => f.asset + f.kind)).size;
    inc = `<div class="card chamfer incident ${racks ? "alert" : "calm"}">
      <div class="inc-head"><span class="inc-dot"></span><h2>${esc(a ? a.name : first.asset)} ${KIND[first.kind] || first.kind}</h2></div>
      <p class="inc-sub">${snap.minute - first.minute} min ago${uniq > 1 ? `, plus ${uniq - 1} more failure${uniq > 2 ? "s" : ""}` : ""}</p>
      ${calibHtml(snap)}
      ${raceHtml(snap, first, cascade)}
      <div class="readouts2">
        <div><b class="${racks ? "hot" : ""}">${racks}</b><span>racks at risk this hour</span></div>
        <div><b>${next ? `+${Math.round(next.minutes)}` : "–"}<small>${next ? " min" : ""}</small></b><span>${next ? esc(next.text) : "nothing else predicted"}</span></div>
      </div></div>`;
  }
  setSlot("slot-incident", inc);

  // agent card
  setSlot("slot-agent", agentCard(snap.agent, failures.length));
  speakBriefing(snap, cascade);

  // selected equipment card
  let html = "";
  if (selected) {
    const a = assets[selected], s = snap.assets[selected];
    const facts = Object.entries(s).filter(([k]) => k !== "status")
      .map(([k, v]) => `<dt>${NICE[k] || k}</dt><dd>${typeof v === "boolean" ? (v ? "yes" : "no") : fmt(v, UNIT[k] || "")}</dd>`).join("");
    const names = ids => ids.map(i => assets[i]?.name || i).join(", ");
    const feeds = a.feeds.length ? `<p>Feeds ${a.feeds.length > 4 ? a.feeds.length + " pieces of equipment" : names(a.feeds)}.</p>` : "";
    const fedBy = parents[selected]?.length ? `<p>Depends on ${names(parents[selected])}.</p>` : "";
    html = `<div class="card chamfer"><h2>${esc(a.name)}</h2><p>Status: ${s.status.replace("_", " ")}</p>
      <dl class="facts">${facts}</dl>${METRIC[a.type] ? sparkline(selected, METRIC[a.type]) : ""}${tigerBlock(selected)}${fedBy}${feeds}</div>`;
  } else if (!failures.length) {
    html = `<div class="card chamfer"><h2>Select any equipment</h2><p>Click a rack, chiller or cooling unit on the map to see its live readings and what it depends on.</p></div>`;
  }
  // the sparkline changes every tick; keep the asset card live but separate from the buttons above
  $("slot-asset").innerHTML = html;
}

// ---------- head start: FaultZero vs the facility's own threshold alarms ----------
const race = { key: null, alarmAt: null };
function raceHtml(snap, first, cascade) {
  const key = `${first.asset}|${first.minute}`;
  if (race.key !== key) { race.key = key; race.alarmAt = null; }
  // a normal facility alarm fires when any rack *sensor reading* crosses 27°C (a lying sensor never alarms)
  const firing = Object.entries(snap.assets).some(([k, v]) => k.startsWith("RACK-") && (v.inlet_temp_c ?? 0) >= 27);
  if (firing && race.alarmAt === null) race.alarmAt = snap.minute;
  const warnedAt = first.minute;
  const clock = m => { const t = new Date(new Date(snap.t).getTime() - (snap.minute - m) * 60000); return t.toTimeString().slice(0, 5); };
  const fixed = snap.agent && snap.agent.decision;
  const nextAlarm = cascade.filter(c => assets[c.id].type === "rack" && c.minutes > 0 && !c.tamper).map(c => c.minutes);
  const spoof = (snap.events || []).some(e => e.kind === "sensor_spoof");
  let alarmText, lead, state;
  if (race.alarmAt !== null) {
    lead = race.alarmAt - warnedAt;
    alarmText = `fired at ${clock(race.alarmAt)}`;
    state = "fired";
  } else if (fixed && !nextAlarm.length) {
    lead = snap.minute - warnedAt;
    alarmText = "never fired. Fixed first";
    state = "beat";
  } else if (spoof && !nextAlarm.length) {
    lead = snap.minute - warnedAt;
    alarmText = "silent. The sensor is lying";
    state = "blind";
  } else {
    lead = snap.minute - warnedAt;
    alarmText = nextAlarm.length ? `silent, fires in ~${Math.round(Math.min(...nextAlarm))} min` : "silent";
    state = "waiting";
  }
  const verdict = state === "fired" ? `FaultZero warned <b>${lead} min</b> before the alarms`
    : state === "beat" ? `Fixed before any alarm. <b>${lead} min</b> head start`
    : state === "blind" ? `Alarms can't see this. FaultZero can`
    : `<b>${lead} min</b> head start and counting`;
  const pct = state === "fired" ? 100 : Math.min(92, 12 + lead * 6);
  return `<div class="race ${state}">
    <div class="race-row fz"><span class="who">FaultZero</span><span class="lane"><i style="width:100%"></i></span><span class="when">warned ${clock(warnedAt)}</span></div>
    <div class="race-row al"><span class="who">Alarms</span><span class="lane"><i style="width:${pct}%"></i></span><span class="when">${alarmText}</span></div>
    <div class="race-verdict">${verdict}</div>
  </div>`;
}

// ---------- voice briefing (browser speech, works offline) ----------
const voice = { on: true, said: new Set() };
try { voice.on = localStorage.getItem("fz-voice") !== "off"; } catch {}
function say(text, key) {
  if (!voice.on || !("speechSynthesis" in window) || voice.said.has(key)) return;
  voice.said.add(key);
  const u = new SpeechSynthesisUtterance(text);
  const v = speechSynthesis.getVoices().find(v => /en(-|_)US/i.test(v.lang) && /Samantha|Google US|Ava|Allison|Zira/i.test(v.name))
    || speechSynthesis.getVoices().find(v => /^en/i.test(v.lang));
  if (v) u.voice = v;
  u.rate = 1.04; u.pitch = 1;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}
function speakBriefing(snap, cascade) {
  const ag = snap.agent, failures = (snap.events || []).filter(e => e.type === "failure");
  if (!ag || !failures.length) return;
  const first = failures[0], a = assets[first.asset];
  const KIND = { chiller_trip: "tripped", grid_loss: "lost utility power", fan_degradation: "has a failing fan", sensor_silent: "sensor went silent", sensor_spoof: "sensor has been tampered with" };
  const key = `${first.asset}|${first.minute}`;
  if (ag.status === "done" && ag.plans.length && !ag.decision) {
    const p = ag.plans[0], base = ag.baseline.racks_at_risk, n = p.outcome.racks_at_risk;
    const firstMin = cascade.filter(c => assets[c.id].type === "rack" && c.minutes > 0).map(c => c.minutes);
    const name = p.name.replace(/^Plan [A-Z]:\s*/, "");
    say(`${a.name} ${KIND[first.kind] || ""}. ` +
        (base ? `${base} racks will overheat within the hour${firstMin.length ? `, the first in ${Math.round(Math.min(...firstMin))} minutes` : ""}. ` : "") +
        `I recommend: ${name}. ${n === 0 ? "It keeps every rack safe." : `It cuts that to ${n}.`} ` +
        (ag.baseline.usd_at_risk > p.outcome.usd_at_risk ? `That protects about ${Math.round((ag.baseline.usd_at_risk - p.outcome.usd_at_risk) / 1000)} thousand dollars this hour. ` : "") +
        `Approve when ready.`, "brief|" + key);
  }
  if (ag.decision) say("Plan approved. The chain is broken.", "done|" + key);
}
function setupVoice() {
  const b = $("voice-btn");
  const paint = () => { b.setAttribute("aria-pressed", String(voice.on)); b.textContent = voice.on ? "Voice on" : "Voice off"; };
  paint();
  b.onclick = () => {
    voice.on = !voice.on;
    try { localStorage.setItem("fz-voice", voice.on ? "on" : "off"); } catch {}
    if (!voice.on && "speechSynthesis" in window) speechSynthesis.cancel();
    paint();
  };
  if ("speechSynthesis" in window) speechSynthesis.getVoices();
}

const usd = n => "$" + Math.round(n).toLocaleString("en-US");
function workOrderHtml(wo) {
  if (!wo || !wo.id) return "";
  const team = String(wo.team || "").replace(/^./, c => c.toUpperCase());
  const who = wo.technician_name ? `${esc(wo.technician_name)} (${esc(wo.technician)})` : wo.technician ? esc(wo.technician) : "Waiting for a technician";
  const part = wo.reserved_part ? `${esc(String(wo.reserved_part).replace(/_/g, " "))} reserved from ${esc(wo.spare_location || "stores")}` : "";
  return `<div class="wo chamfer"><div class="wo-top"><span class="wo-id">${esc(wo.id)}</span><span class="wo-status ${wo.status === "assigned" ? "ok" : "warn"}">${wo.status === "assigned" ? "Dispatched" : "Waiting for parts or staff"}</span></div>
    <div class="wo-row"><span>Team</span><b>${esc(team)}</b></div>
    <div class="wo-row"><span>Technician</span><b>${who}</b></div>
    ${wo.eta_minutes ? `<div class="wo-row"><span>On site in</span><b>${esc(wo.eta_minutes)} min</b></div>` : ""}
    ${part ? `<div class="wo-row"><span>Part</span><b>${part}</b></div>` : ""}</div>`;
}
function moneyRow(from, to) {
  if (from == null || to == null || (!from && !to)) return "";
  const saved = Math.max(0, from - to);
  return `<div class="money" title="Illustrative: $1,000 per rack-hour above 27°C over the predicted hour. Not a verified loss.">
    <span class="m-from">${usd(from)}</span><span class="m-arrow" aria-hidden="true">→</span><span class="m-to ${to ? "warn" : "ok"}">${usd(to)}</span>
    <span class="m-lbl">at risk this hour${saved ? ` · <b>${usd(saved)} protected</b>` : ""}</span></div>`;
}
function agentCard(ag, hasIncident) {
  if (!ag) {
    return `<div class="card chamfer agent"><div class="agent-head"><h2>Agent</h2></div>
      <p>${hasIncident ? "Starting…" : "Standing by. When something breaks, the agent investigates, tests fixes in the digital twin and proposes plans for you to approve."}</p></div>`;
  }
  const badge = ag.source === "nemotron" ? `<span class="badge nv">Nemotron</span>`
    : ag.source === "scripted" ? `<span class="badge sc" title="Nemotron was unavailable, so a scripted planner ran the same tools">Scripted backup</span>` : "";
  const status = ag.status === "running" ? `<span class="live">Investigating</span>`
    : ag.decision ? "Plan approved" : ag.status === "done" ? "Plans ready for your decision" : "Something went wrong";
  const steps = ag.steps.map((st, i) =>
    `<li class="k-${st.kind}${i >= stepsShown ? " enter" : ""}">${esc(st.text)}</li>`).join("");
  stepsShown = ag.steps.length;

  const base = ag.baseline?.racks_at_risk ?? 0;
  const dismissed = new Set(ag.dismissed || []);
  const plans = (ag.plans || []).map((p, i) => {
    if (dismissed.has(i)) return "";
    if (ag.decision && ag.decision.index !== i) return "";
    const n = p.outcome.racks_at_risk;
    const chosen = ag.decision && ag.decision.index === i;
    const other = ag.decision && !chosen;
    const pct = base ? Math.round((n / base) * 100) : 0;
    void pct;
    return `<div class="plan chamfer${i === 0 ? " best" : ""}${chosen ? " chosen" : ""}${other ? " faded" : ""}">
      <div class="plan-top"><span class="plan-rank">${String(i + 1).padStart(2, "0")}</span><span class="plan-tag">${chosen ? "Approved" : i === 0 ? "Recommended" : "Alternative"}</span></div>
      <h3>${esc(p.name.replace(/^Plan [A-Z]:\s*/, ""))}</h3>
      ${base || n ? `<div class="delta2" aria-label="${n} racks overheat with this plan, ${base} if nothing is done">
        <div class="dcol"><span class="dnum from">${base}</span><span class="dlbl">Do nothing</span></div>
        <span class="d-arrow" aria-hidden="true"></span>
        <div class="dcol"><span class="dnum ${n ? "warn" : "ok"}">${n}</span><span class="dlbl">This plan</span></div>
        <div class="dcap">racks overheating<br>in the next hour</div>
      </div>` : `<div class="delta2 flat"><div class="dcol"><span class="dnum ok">0</span><span class="dlbl">at risk</span></div><div class="dcap">No racks at risk either way.<br>This plan restores the failed equipment.</div></div>`}
      ${moneyRow(ag.baseline?.usd_at_risk, p.outcome.usd_at_risk)}
      <p>${esc(p.reason)}</p>
      ${ag.decision ? (chosen ? `<p class="ok-note">Approved at minute ${ag.decision.minute}. Logged for the next shift.</p>${workOrderHtml(ag.decision.work_order)}` : "")
        : `<div class="plan-btns"><button class="btn approve cut" data-approve="${i}">Approve plan</button><button class="btn link-btn" data-dismiss="${i}">Dismiss</button></div>`}
    </div>`;
  }).join("");

  const rerun = ag.status !== "running" ? `<button class="btn ghost small" data-rerun>Investigate again</button>` : "";
  const others = ag.decision ? (ag.plans.length - 1) : 0;
  const head = `<div class="card chamfer agent"><div class="agent-head"><h2>Agent</h2>${badge}</div><p class="agent-status">${status}</p>`;
  if (ag.status === "running" || !ag.plans.length) return `${head}<ol class="steps">${steps}</ol>${rerun}</div>`;
  // plans first once they are ready; the investigation folds away underneath
  return `${head}${plans}${others ? `<p class="muted-note">${others} other option${others > 1 ? "s" : ""} not chosen.</p>` : ""}
    <details class="how" ${stepsOpen ? "open" : ""}><summary>How the agent got here (${ag.steps.length} steps)</summary><ol class="steps">${steps}</ol></details>${rerun}</div>`;
}

// ---------- shift handoff ----------
let lastFocus = null, replayTimer = null;
async function openHandoff() {
  lastFocus = document.activeElement;
  $("handoff").hidden = false;
  $("ho-acked").hidden = true;
  const h = await (await fetch("/api/handoff")).json();
  $("ho-sub").textContent = `Shift ending at ${h.shift_ends}. ${h.summary}`;
  $("ho-status").className = "ho-status " + (h.racks_at_risk ? "risk" : "stable");
  $("ho-status").innerHTML = `<b>${h.racks_at_risk ? "Needs attention" : "Stable"}</b><span>${esc(h.status)}</span>`;
  const li = list => list.map(x => `<li>${esc(x)}</li>`).join("");
  $("ho-open").innerHTML = li(h.open_items);
  $("ho-watch").innerHTML = li(h.watch_next);
  $("ho-dec").innerHTML = li(h.decisions);
  $("ho-timeline").innerHTML = h.timeline.length
    ? h.timeline.map(t => `<li class="k-${t.kind}"><time>${t.time}</time><span>${esc(t.text)}</span></li>`).join("")
    : `<li class="k-none"><span>A quiet shift. Nothing failed.</span></li>`;
  $("ho-close").focus();
  replay();
}
function replay() {
  clearTimeout(replayTimer);
  const items = [...$("ho-timeline").children];
  items.forEach(el => el.classList.remove("shown"));
  const reduced = document.body.classList.contains("calm") || matchMedia("(prefers-reduced-motion: reduce)").matches;
  items.forEach((el, i) => {
    if (reduced) { el.classList.add("shown"); return; }
    replayTimer = setTimeout(() => el.classList.add("shown"), 250 + i * 700);
  });
}
function closeHandoff() {
  clearTimeout(replayTimer);
  $("handoff").hidden = true;
  if (lastFocus) lastFocus.focus();
}
// ---------- QR for judges ----------
async function openQR() {
  $("qr-modal").hidden = false;
  $("qr-close").focus();
  try {
    const q = await (await fetch("/api/qr")).json();
    $("qr-code").innerHTML = q.svg.replace(/<\?xml[^>]*>/, "");
    $("qr-url").textContent = q.url.replace(/^https?:\/\//, "");
    $("qr-warn").hidden = !q.local_only;
    $("qr-warn").textContent = "This address only works on this laptop. Open the control room using your Wi-Fi IP or your domain so phones can reach it.";
  } catch {
    $("qr-code").textContent = "Couldn't make the QR code. Run: pip install qrcode";
  }
}
function setupQR() {
  $("qr-btn").onclick = openQR;
  $("qr-close").onclick = () => { $("qr-modal").hidden = true; $("qr-btn").focus(); };
  $("qr-modal").addEventListener("click", e => { if (e.target.id === "qr-modal") $("qr-modal").hidden = true; });
  document.addEventListener("keydown", e => { if (e.key === "Escape") $("qr-modal").hidden = true; });
}

function setupTimelineClicks() {
  $("tl").addEventListener("click", e => { const t = e.target.closest("[data-id]"); if (t) select(t.dataset.id); });
}

function setupHandoff() {
  $("handoff-btn").onclick = openHandoff;
  $("ho-close").onclick = closeHandoff;
  $("ho-play").onclick = replay;
  $("handoff").addEventListener("click", e => { if (e.target.id === "handoff") closeHandoff(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("handoff").hidden) closeHandoff(); });
  $("ho-ack").addEventListener("submit", async e => {
    e.preventDefault();
    const name = $("ho-name").value.trim();
    if (!name) return;
    const r = await post("/api/handoff/ack", { name });
    $("ho-acked").hidden = false;
    $("ho-acked").textContent = `Acknowledged by ${r.acknowledged_by}. The new shift has the full story.`;
  });
}

// ---------- agent buttons ----------
function setupAgentButtons() {
  $("side").addEventListener("toggle", e => { if (e.target.matches("details.how")) stepsOpen = e.target.open; }, true);
  $("side").addEventListener("click", async e => {
    const ap = e.target.closest("[data-approve]"), di = e.target.closest("[data-dismiss]"), re = e.target.closest("[data-rerun]");
    if (ap) {
      ap.disabled = true; ap.textContent = "Approving…";
      await post("/api/agent/approve", { index: Number(ap.dataset.approve) });
      preview.plan = null; preview.data = null; setMinute(0);
      const root = latest && (latest.roots || [])[0];
      if (scene3d && root) scene3d.recover(root);
    } else if (di) {
      await post("/api/agent/dismiss", { index: Number(di.dataset.dismiss) });
    } else if (re) {
      stepsShown = 0;
      await post("/api/agent/run");
    }
  });
}

// ---------- controls ----------
async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  return r.json();
}
function setupMenu() {
  const btn = $("menu-btn"), menu = $("menu");
  const close = () => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); };
  btn.onclick = () => { menu.hidden = !menu.hidden; btn.setAttribute("aria-expanded", String(!menu.hidden)); };
  document.addEventListener("click", e => { if (!e.target.closest(".menu-wrap")) close(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") close(); });
  const add = (parent, label, fn) => { const b = document.createElement("button"); b.textContent = label; b.onclick = () => { fn(); close(); }; $(parent).appendChild(b); };
  FAILURES.forEach(([k, label]) => add("menu-break", label, () => post("/api/inject", { kind: k })));
  ACTIONS.forEach(([k, label]) => add("menu-fix", label, () => post("/api/action", { action: k })));
  $("reset-btn").onclick = async () => {
    await post("/api/reset");
    Object.keys(hist).forEach(k => delete hist[k]);
    lastEventCount = 0; selected = null; stepsShown = 0; close();
    voice.said.clear(); race.key = null; if ("speechSynthesis" in window) speechSynthesis.cancel();
    preview.plan = null; preview.data = null; setMinute(0);
    if (scene3d) { scene3d.select(null); scene3d.resetView(); }
  };
  $("calm-btn").onclick = () => {
    document.body.classList.toggle("calm");
    if (scene3d) scene3d.setCalm(document.body.classList.contains("calm"));
    $("calm-btn").textContent = document.body.classList.contains("calm") ? "Turn on animations" : "Turn off animations";
  };
}

// ---------- 3D / 2D switch ----------
function setView(v) {
  const is3d = v === "3d";
  $("tip").hidden = true;
  $("three").hidden = !is3d;
  $("svg").style.display = is3d ? "none" : "";
  $("view-3d").setAttribute("aria-pressed", String(is3d));
  $("view-2d").setAttribute("aria-pressed", String(!is3d));
  $("view-reset").hidden = !is3d;
  $("view-hint").textContent = is3d ? "Drag to turn, scroll to zoom" : "Tab through equipment, Enter to select";
  if (scene3d) scene3d.setPaused(!is3d);
}

// ---------- start ----------
(async function start() {
  const data = await (await fetch("/api/assets")).json();
  data.assets.forEach(a => { assets[a.id] = a; children[a.id] = a.feeds; });
  data.assets.forEach(a => a.feeds.forEach(c => (parents[c] ||= []).push(a.id)));
  buildMap();
  if (webglAvailable()) {
    setView("3d");
    $("view-3d").onclick = () => setView("3d");
    $("view-2d").onclick = () => setView("2d");
    scene3d = new Scene3D($("three"), { heat, onSelect: id => select(id) });
    scene3d.build(assets);
    $("view-reset").onclick = () => scene3d.resetView();
    const tip = $("tip");
    $("three").addEventListener("hover3d", e => {
      const { id, x, y } = e.detail;
      if (!id || !latest) { tip.hidden = true; return; }
      const a = assets[id], s = latest.assets[id], m = METRIC[a.type];
      tip.hidden = false;
      tip.style.left = `${x + 16}px`; tip.style.top = `${y + 12}px`;
      tip.innerHTML = `<b>${a.name}</b>${m ? `${NICE[m]}: ${fmt(s[m], UNIT[m])}` : s.status}`;
    });
  } else {
    $("three").remove(); $("view-switch").remove(); $("view-reset").remove(); $("view-hint").remove();
  }
  setupMenu();
  setupAgentButtons();
  setupScrubber();
  setupHandoff();
  setupTimelineClicks();
  setupVoice();
  setupQR();
  const es = new EventSource("/api/stream");
  es.onmessage = e => update(JSON.parse(e.data));
})();
