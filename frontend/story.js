// FaultZero story: scrolling moves time in a recorded incident inside the 3D hall.
import { Scene3D, webglAvailable } from "./scene3d.js";

const $ = id => document.getElementById(id);
const RAMP = [[20, "3fa7d6"], [24, "3cc3a0"], [27, "f2b33d"], [30, "f0643a"], [32, "d92d55"]];
function mix(a, b, t) {
  const pa = a.match(/\w\w/g).map(h => parseInt(h, 16)), pb = b.match(/\w\w/g).map(h => parseInt(h, 16));
  return "#" + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, "0")).join("");
}
function heat(t) {
  if (t === null || t === undefined) return "#56627a";
  if (t <= RAMP[0][0]) return "#" + RAMP[0][1];
  for (let i = 1; i < RAMP.length; i++) {
    if (t <= RAMP[i][0]) { const [t0, c0] = RAMP[i - 1], [t1, c1] = RAMP[i]; return mix(c0, c1, (t - t0) / (t1 - t0)); }
  }
  return "#" + RAMP[RAMP.length - 1][1];
}

const beats = [...document.querySelectorAll(".beat")];
const rail = [...document.querySelectorAll(".rail a")];
let scene = null, story = null, current = -1, mode = "calm", rewinding = false, lastFrame = null;

function show(frame) {
  if (!frame) return;
  lastFrame = frame;
  if (scene) scene.update(frame, []);
  const hot = Object.entries(frame.assets).filter(([k, v]) => k.startsWith("RACK-") && (v.inlet_temp_c ?? 0) >= 27).length;
  const m = 21 * 60 + frame.minute;
  $("h-clock").textContent = `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  $("h-hot").textContent = hot;
  $("h-hot").classList.toggle("hot", hot > 0);
  $("h-alarm").textContent = hot > 0 ? "Firing" : "Quiet";
  $("h-alarm").classList.toggle("firing", hot > 0);
  document.body.style.setProperty("--danger", (Math.min(hot, 12) / 12 * 0.55).toFixed(2));
}

function pick(list, t) { return list[Math.max(0, Math.min(list.length - 1, Math.floor(t * (list.length - 1))))]; }

function flash(kind) {
  const f = $("flash");
  f.className = "flash";
  void f.offsetWidth;  // restart the animation
  f.className = `flash ${kind}`;
}

function rewind(then) {
  // play the broken night backwards quickly, with a scan sweeping the screen
  rewinding = true;
  $("stage").classList.add("rewind");
  flash("scan");
  const frames = story.broken, start = performance.now(), dur = 1300;
  const from = Math.max(0, frames.indexOf(lastFrame));
  const step = now => {
    const t = Math.min(1, (now - start) / dur);
    show(frames[Math.round(from * (1 - t))]);
    if (t < 1) requestAnimationFrame(step);
    else {
      $("stage").classList.remove("rewind");
      rewinding = false;
      then();
    }
  };
  requestAnimationFrame(step);
}

function enter(i, prev) {
  rail.forEach((a, k) => a.classList.toggle("on", k === i));
  beats.forEach((b, k) => b.classList.toggle("on", k === i));
  $("hud").classList.toggle("on", i >= 1 && i <= 3);
  if (!scene) return;
  if (i === 0) { mode = "calm"; scene.resetView(); $("h-fz").textContent = "Watching"; }
  if (i === 1) {
    mode = "broken";
    $("h-fz").textContent = `${story.racks_at_risk} racks at risk`;
    if (prev < 1) { show(story.broken[0]); scene.failure(story.root); flash("red"); }
    else scene.lookAt(story.root, [8, 10, 12]);
  }
  if (i === 2) {
    mode = "broken";
    scene.lookAtRows();
    if (prev < 2) scene.pulseFrom(story.root, 0xff3358, 5);
  }
  if (i === 3) {
    $("h-fz").textContent = "Fix approved";
    if (prev < 3) {
      rewind(() => { mode = "fixed"; show(story.fixed[0]); scene.recover(story.root); });
    } else mode = "fixed";
  }
  if (i === 4) { mode = "fixed"; show(story.fixed[story.fixed.length - 1]); scene.resetView(); document.body.style.setProperty("--danger", 0); }
}

function onScroll() {
  const vh = window.innerHeight;
  let i = 0;
  beats.forEach((b, k) => { if (b.getBoundingClientRect().top < vh * 0.55) i = k; });
  if (i !== current) { const prev = current; current = i; enter(i, prev); }
  if (!story || rewinding) return;
  const r = beats[i].getBoundingClientRect();
  const t = Math.max(0, Math.min(1, (vh * 0.55 - r.top) / Math.max(1, r.height - vh * 0.3)));
  if (i === 0) show(pick(story.calm, t));
  else if (i === 1) show(pick(story.broken.slice(0, 4), t));
  else if (i === 2) show(pick(story.broken.slice(3), t));
  else if (i === 3 && mode === "fixed") show(pick(story.fixed, t));
}

(async function start() {
  const [assetData, storyData] = await Promise.all([
    fetch("/api/assets").then(r => r.json()),
    fetch("/api/story").then(r => r.json()),
  ]);
  story = storyData;
  const lead = story.first_rack_alarm_min;
  $("chain-copy").textContent = `Cooling units 4 to 6 pass 24°C after ${story.first_cooling_min} minutes. ` +
    `Rows C and D cross 27°C after ${lead}, and only then do the facility's alarms fire. ${story.racks_at_risk} racks overheat.`;
  $("fix-copy").textContent = `It played the next hour forward in its digital twin and warned ${lead} minutes before the facility's alarms would have. ` +
    `It tested the fixes and recommended one: start the backup chiller. A person approved it, and the chain never happened.`;

  if (webglAvailable()) {
    const assets = {};
    assetData.assets.forEach(a => { assets[a.id] = a; });
    scene = new Scene3D($("stage"), { heat, onSelect: () => {}, interactive: false });
    scene.build(assets);
    scene.powerOn(0.9);
  }
  window.addEventListener("scroll", () => requestAnimationFrame(onScroll), { passive: true });
  onScroll();
})();
