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
const RAMP = [[20, "3fa7d6"], [24, "3cc3a0"], [27, "f2b33d"], [30, "f0643a"], [32, "d92d55"]];
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
function shade(hex, f) { return mix(hex.replace("#", ""), f < 1 ? "0f1a2c" : "ffffff", Math.abs(1 - f)); }

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

  // asset colors (2D fallback map)
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

  // edges
  const gridDown = snap.assets.UTIL.status !== "ok";
  for (const ed of els.edges) {
    const s = snap.assets[ed.from];
    const broken = ["tripped", "down", "depleted", "no_power"].includes(s.status);
    const dead = s.status === "standby";
    ed.path.classList.toggle("broken", broken);
    ed.path.classList.toggle("dead", dead && !broken);
  }

  // new failure events → ripple
  const evs = snap.events || [];
  const fresh = evs.filter(e => e.minute >= 0).slice(lastEventCount > evs.length ? 0 : lastEventCount);
  fresh.forEach(e => {
    if (e.type !== "failure") return;
    ripple(e.asset);
    if (scene3d) scene3d.failure(e.asset);
    const f = $("screen-flash"); f.classList.remove("go"); void f.offsetWidth; f.classList.add("go");
  });
  lastEventCount = evs.length;

  const cascade = predict(snap);
  drawPulses(snap, cascade);
  if (scene3d) scene3d.update(snap, cascade);
  renderTimeline(cascade);
  renderSide(snap, cascade);

  const atRisk = new Set(cascade.filter(c => assets[c.id].type === "rack").map(c => c.id)).size;
  $("risk").textContent = atRisk;
  $("risk-wrap").classList.toggle("zero", atRisk === 0);
  document.body.style.setProperty("--danger", (Math.min(atRisk, 12) / 12 * 0.45).toFixed(2));
  const failed = evs.some(e => e.type === "failure");
  const contained = failed && atRisk === 0 && snap.agent && snap.agent.decision;
  $("status").textContent = contained ? "Contained, watching" : failed ? "Incident in progress" : "All systems normal";
  $("status").classList.toggle("incident", failed && !contained);
  $("status").classList.toggle("contained", !!contained);
  void gridDown;
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

function renderTimeline(cascade) {
  const track = $("track"), chain = $("chain");
  track.innerHTML = "";
  [0, 15, 30, 45, 60].forEach(m => {
    const t = document.createElement("span");
    t.className = "tick"; t.style.left = `${(m / 60) * 100}%`; t.textContent = m === 0 ? "now" : `+${m} min`;
    track.appendChild(t);
  });
  chain.innerHTML = "";
  cascade = groupRows(cascade);
  if (!cascade.length) {
    chain.innerHTML = `<div class="empty">No failures predicted. Use "Test the facility" to break something.</div>`;
    return;
  }
  cascade.slice(0, 16).forEach(c => {
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.left = `${Math.min(100, (c.minutes / 60) * 100)}%`;
    dot.style.background = c.tamper ? "#c58bff" : c.now ? "var(--crit)" : "var(--warm)";
    track.appendChild(dot);

    const card = document.createElement("button");
    card.className = "link" + (c.now ? " now" : "") + (c.tamper ? " tamper-link" : "");
    card.innerHTML = `<div class="when">${c.now ? "Now" : `In ${Math.round(c.minutes)} min`}</div><div class="what">${c.text}</div>${c.because ? `<div class="why">${c.because}</div>` : ""}`;
    card.onclick = () => select(c.id);
    chain.appendChild(card);
  });
}

// ---------- side panel ----------
function select(id) {
  selected = selected === id ? null : id;
  $("tip").hidden = true;
  if (scene3d) scene3d.select(selected);
  Object.entries(els.assets).forEach(([k, e]) => e.g.classList.toggle("selected", k === selected));
  if (latest) renderSide(latest, predict(latest));
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
    inc = `<div class="card ${racks ? "alert" : "calm"}"><h2>${esc(a ? a.name : first.asset)} ${KIND[first.kind] || first.kind}</h2>
      <p>Started ${snap.minute - first.minute} min ago${failures.length > 1 ? `, plus ${failures.length - 1} more failure${failures.length > 2 ? "s" : ""}` : ""}.</p>
      <dl class="facts"><dt>Next</dt><dd class="txt">${next ? `${esc(next.text)}, in ${Math.round(next.minutes)} min` : "Nothing else predicted"}</dd>
      <dt>Racks at risk</dt><dd>${racks} within the hour</dd></dl></div>`;
  }
  setSlot("slot-incident", inc);

  // agent card
  setSlot("slot-agent", agentCard(snap.agent, failures.length));

  // selected equipment card
  let html = "";
  if (selected) {
    const a = assets[selected], s = snap.assets[selected];
    const facts = Object.entries(s).filter(([k]) => k !== "status")
      .map(([k, v]) => `<dt>${NICE[k] || k}</dt><dd>${typeof v === "boolean" ? (v ? "yes" : "no") : fmt(v, UNIT[k] || "")}</dd>`).join("");
    const names = ids => ids.map(i => assets[i]?.name || i).join(", ");
    const feeds = a.feeds.length ? `<p>Feeds ${a.feeds.length > 4 ? a.feeds.length + " pieces of equipment" : names(a.feeds)}.</p>` : "";
    const fedBy = parents[selected]?.length ? `<p>Depends on ${names(parents[selected])}.</p>` : "";
    html = `<div class="card"><h2>${esc(a.name)}</h2><p>Status: ${s.status.replace("_", " ")}</p>
      <dl class="facts">${facts}</dl>${METRIC[a.type] ? sparkline(selected, METRIC[a.type]) : ""}${fedBy}${feeds}</div>`;
  } else if (!failures.length) {
    html = `<div class="card"><h2>Select any equipment</h2><p>Click a rack, chiller or cooling unit on the map to see its live readings and what it depends on.</p></div>`;
  }
  // the sparkline changes every tick; keep the asset card live but separate from the buttons above
  $("slot-asset").innerHTML = html;
}

function agentCard(ag, hasIncident) {
  if (!ag) {
    return `<div class="card agent"><div class="agent-head"><h2>Agent</h2></div>
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
    return `<div class="plan${i === 0 ? " best" : ""}${chosen ? " chosen" : ""}${other ? " faded" : ""}">
      <div class="plan-tag">${chosen ? "Approved" : i === 0 ? "Recommended" : `Option ${i + 1}`}</div>
      <h3>${esc(p.name)}</h3>
      <div class="compare" aria-label="${n} racks at risk with this plan, ${base} if nothing is done">
        <div class="cmp-row"><span>This plan</span><div class="bar"><i style="width:${Math.max(pct, 2)}%" class="${n ? "warn" : "ok"}"></i></div><b>${n}</b></div>
        <div class="cmp-row"><span>Do nothing</span><div class="bar"><i style="width:100%" class="bad"></i></div><b>${base}</b></div>
        <small>racks overheating in the next hour</small>
      </div>
      <p>${esc(p.reason)}</p>
      ${ag.decision ? (chosen ? `<p class="ok-note">Approved at minute ${ag.decision.minute}. Logged for the next shift${ag.decision.work_order ? " and a work order was created" : ""}.</p>` : "")
        : `<div class="plan-btns"><button class="btn approve" data-approve="${i}">Approve</button><button class="btn ghost" data-dismiss="${i}">Dismiss</button></div>`}
    </div>`;
  }).join("");

  const rerun = ag.status !== "running" ? `<button class="btn ghost small" data-rerun>Investigate again</button>` : "";
  const others = ag.decision ? (ag.plans.length - 1) : 0;
  const head = `<div class="card agent"><div class="agent-head"><h2>Agent</h2>${badge}</div><p class="agent-status">${status}</p>`;
  if (ag.status === "running" || !ag.plans.length) return `${head}<ol class="steps">${steps}</ol>${rerun}</div>`;
  // plans first once they are ready; the investigation folds away underneath
  return `${head}${plans}${others ? `<p class="muted-note">${others} other option${others > 1 ? "s" : ""} not chosen.</p>` : ""}
    <details class="how" ${stepsOpen ? "open" : ""}><summary>How the agent got here (${ag.steps.length} steps)</summary><ol class="steps">${steps}</ol></details>${rerun}</div>`;
}

// ---------- agent buttons ----------
function setupAgentButtons() {
  $("side").addEventListener("toggle", e => { if (e.target.matches("details.how")) stepsOpen = e.target.open; }, true);
  $("side").addEventListener("click", async e => {
    const ap = e.target.closest("[data-approve]"), di = e.target.closest("[data-dismiss]"), re = e.target.closest("[data-rerun]");
    if (ap) {
      ap.disabled = true; ap.textContent = "Approving…";
      await post("/api/agent/approve", { index: Number(ap.dataset.approve) });
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
  const es = new EventSource("/api/stream");
  es.onmessage = e => update(JSON.parse(e.data));
})();
