"""
FaultZero backend.

Run from the project folder:
    uvicorn backend.main:app --reload --port 8000
Then open http://localhost:8000
"""
import asyncio
import json
import threading
import time
from pathlib import Path
from typing import Optional

import os

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

try:  # load NVIDIA_API_KEY from .env
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from backend.agent import AgentRun
from backend.cascade import project
from backend.fake_sim import ACTIONS, FAILURE_KINDS, FakeFacility, load_assets

ROOT = Path(__file__).resolve().parent.parent
TICK_SECONDS = 1.0  # one simulated minute per real second

app = FastAPI(title="FaultZero")
ASSETS = load_assets()
state = {"facility": FakeFacility(ASSETS), "latest": None, "future": None, "agent": None}
DECISIONS = ROOT / "data" / "decisions.jsonl"


def refresh_cascade(snap: dict) -> dict:
    """Project the facility 60 minutes ahead whenever something has broken."""
    fac = state["facility"]
    if any(e["type"] == "failure" for e in fac.events):
        result = project(fac)
        snap["cascade"] = result["chain"]
        snap["roots"] = result["roots"]
        state["future"] = {"from_minute": snap["minute"], "frames": result["frames"]}
    else:
        snap["cascade"], snap["roots"], state["future"] = [], [], None
    st = state["agent"].state if state["agent"] else None
    # copy so the agent thread can keep appending while this snapshot is sent
    snap["agent"] = {**st, "steps": list(st["steps"]), "plans": list(st["plans"])} if st else None
    return snap


def start_agent():
    """Investigate the current incident in the background."""
    run = AgentRun(state["facility"])
    run.pace = 0.45  # the scripted planner is instant; pace its steps so people can follow them
    state["agent"] = run
    threading.Thread(target=run.run, daemon=True).start()


async def ticker():
    while True:
        state["latest"] = refresh_cascade(state["facility"].step())
        await asyncio.sleep(TICK_SECONDS)


@app.on_event("startup")
async def start_ticker():
    state["latest"] = refresh_cascade(state["facility"].snapshot())
    asyncio.create_task(ticker())


# ---------- read ----------
@app.get("/api/assets")
def get_assets():
    return {"assets": ASSETS}


@app.get("/api/state")
def get_state():
    return state["latest"]


@app.get("/api/cascade")
def get_cascade():
    snap = state["latest"] or {}
    return {"roots": snap.get("roots", []), "chain": snap.get("cascade", [])}


@app.get("/api/future")
def get_future(plan: Optional[int] = None):
    """Minute-by-minute projection of the next 60 minutes (for the time scrubber).
    With ?plan=N, the agent's plan N is applied to a copy first, so you can compare futures."""
    fac = state["facility"]
    if plan is None:
        result = project(fac)
        label = "Do nothing"
    else:
        run = state["agent"]
        if not run or plan >= len(run.state["plans"]):
            raise HTTPException(400, "That plan is not available.")
        p = run.state["plans"][plan]
        twin = fac.copy()
        for a in p["actions"]:
            twin.apply(a["action"], a.get("asset"))
        result = project(twin)
        label = p["name"]
    hot = [sum(1 for k, v in f["assets"].items() if k.startswith("RACK-") and (v.get("inlet_temp_c") or 0) >= 27)
           for f in result["frames"]]
    return {"from_minute": fac.minute, "label": label, "frames": result["frames"], "hot": hot}


@app.get("/api/stream")
async def stream():
    """Server-Sent Events: the browser gets the latest state every tick."""
    async def gen():
        last = -1
        while True:
            snap = state["latest"]
            if snap and snap["minute"] != last:
                last = snap["minute"]
                yield f"data: {json.dumps(snap)}\n\n"
            await asyncio.sleep(0.2)
    return StreamingResponse(gen(), media_type="text/event-stream")


# ---------- write ----------
class InjectRequest(BaseModel):
    kind: str
    asset: Optional[str] = None
    severity: float = 1.0


class ActionRequest(BaseModel):
    action: str
    asset: Optional[str] = None


@app.post("/api/inject")
def inject(req: InjectRequest):
    try:
        ev = state["facility"].inject(req.kind, req.asset, req.severity)
    except ValueError as e:
        raise HTTPException(400, str(e))
    start_agent()
    state["latest"] = refresh_cascade(state["facility"].snapshot())
    return ev


@app.post("/api/action")
def action(req: ActionRequest):
    try:
        ev = state["facility"].apply(req.action, req.asset)
    except ValueError as e:
        raise HTTPException(400, str(e))
    state["latest"] = refresh_cascade(state["facility"].snapshot())
    return ev


@app.post("/api/reset")
def reset():
    state["facility"] = FakeFacility(ASSETS)
    state["agent"] = None
    state["latest"] = refresh_cascade(state["facility"].snapshot())
    return {"ok": True}


class PlanChoice(BaseModel):
    index: int
    reason: Optional[str] = None


def log_decision(entry: dict):
    DECISIONS.parent.mkdir(exist_ok=True)
    with open(DECISIONS, "a") as f:
        f.write(json.dumps(entry) + "\n")


@app.post("/api/agent/run")
def agent_run():
    if not any(e["type"] == "failure" for e in state["facility"].events):
        raise HTTPException(400, "Nothing is broken, so there is nothing to investigate.")
    start_agent()
    return {"ok": True}


@app.post("/api/agent/approve")
def agent_approve(choice: PlanChoice):
    run = state["agent"]
    if not run or choice.index >= len(run.state["plans"]):
        raise HTTPException(400, "That plan no longer exists.")
    plan = run.state["plans"][choice.index]
    fac = state["facility"]
    for a in plan["actions"]:
        fac.apply(a["action"], a.get("asset"))
    entry = {"time": time.time(), "facility_minute": fac.minute, "decision": "approved", "plan": plan["name"],
             "actions": plan["actions"], "predicted": plan["outcome"], "source": run.state["source"]}
    try:  # Naomi's dispatch creates the work order when it exists
        from business.dispatch import create_work_order  # type: ignore
        entry["work_order"] = create_work_order(plan, run.state)
    except Exception:
        entry["work_order"] = None
    log_decision(entry)
    run.state["decision"] = {"index": choice.index, "status": "approved", "minute": fac.minute,
                             "work_order": entry["work_order"]}
    state["latest"] = refresh_cascade(fac.snapshot())
    return entry


@app.post("/api/agent/dismiss")
def agent_dismiss(choice: PlanChoice):
    run = state["agent"]
    if not run or choice.index >= len(run.state["plans"]):
        raise HTTPException(400, "That plan no longer exists.")
    plan = run.state["plans"][choice.index]
    run.state.setdefault("dismissed", []).append(choice.index)
    log_decision({"time": time.time(), "facility_minute": state["facility"].minute, "decision": "dismissed",
                  "plan": plan["name"], "reason": choice.reason})
    return {"ok": True}


# ---------- shift handoff ----------
KIND_TEXT = {"chiller_trip": "tripped", "grid_loss": "lost utility power", "fan_degradation": "fan started wearing out",
             "sensor_silent": "sensor went silent", "sensor_spoof": "sensor was tampered with"}
ACTION_TEXT = {"start_backup_chiller": "Backup chiller started", "raise_fan_speed": "Fan speeds raised",
               "start_generator": "Generator started", "shift_load": "Load moved off a row", "isolate_rack": "Rack isolated for inspection"}
ACKS = ROOT / "data" / "handoff_acks.jsonl"


def build_handoff() -> dict:
    """Everything the next shift needs. Uses Naomi's business/handoff.py when it exists."""
    try:
        from business.handoff import build_handoff as custom  # type: ignore
        return custom(state)
    except Exception:
        pass
    fac, snap = state["facility"], state["latest"] or {}
    clock = lambda m: (fac.start.replace(second=0) + __import__("datetime").timedelta(minutes=m)).strftime("%H:%M")
    timeline, seen = [], set()
    for e in fac.events:
        if e["type"] == "failure":
            if (e["asset"], e["kind"]) in seen:
                continue
            seen.add((e["asset"], e["kind"]))
            timeline.append({"minute": e["minute"], "time": clock(e["minute"]), "kind": "failure",
                             "text": f'{fac.assets[e["asset"]]["name"]} {KIND_TEXT.get(e["kind"], e["kind"])}'})
        else:
            timeline.append({"minute": e["minute"], "time": clock(e["minute"]), "kind": "action",
                             "text": ACTION_TEXT.get(e["action"], e["action"]) + " (approved by operator)"})
    run = state["agent"]
    if run:
        st = run.state
        first = next((x for x in timeline if x["kind"] == "failure"), None)
        m = st.get("started_minute", first["minute"] if first else 0)
        sims = [x for x in st["steps"] if x["kind"] == "sim"]
        src = "Nemotron" if st.get("source") == "nemotron" else "The scripted planner"
        timeline.append({"minute": m, "time": clock(m), "kind": "agent",
                         "text": f'{src} investigated in {len(st["steps"])} steps and tested {len(sims)} plans in the twin'})
        if st.get("plans"):
            p0 = st["plans"][0]
            timeline.append({"minute": m, "time": clock(m), "kind": "agent",
                             "text": f'Recommended “{p0["name"]}”: {p0["outcome"]["racks_at_risk"]} racks at risk vs {st["baseline"]["racks_at_risk"]} if nothing was done'
                                 + (f' (about ${st["baseline"]["usd_at_risk"] - p0["outcome"]["usd_at_risk"]:,} of illustrative exposure avoided)'
                                    if (st["baseline"].get("usd_at_risk") or 0) > (p0["outcome"].get("usd_at_risk") or 0) else '')})
    timeline.sort(key=lambda x: (x["minute"], {"failure": 0, "agent": 1, "action": 2}[x["kind"]]))

    still_down = [f'{a["name"]} is {fac.s[i]["status"].replace("_", " ")} and needs a technician' for i, a in fac.assets.items()
                  if fac.s[i].get("status") in ("tripped", "down", "depleted", "no_power", "degrading", "offline")]
    tampered = [f'{fac.assets[i]["name"]} sensor needs inspection' for i, v in fac.s.items() if v.get("sensor") in ("spoofed", "silent")]
    chain = snap.get("cascade", [])
    racks = sorted({c["id"] for c in chain if c["type"] == "rack"})
    watch = [f'+{c["minutes"]} min: {c["text"]}' for c in chain if c["minutes"] > 0][:4]
    decisions = []
    if DECISIONS.exists():
        for line in DECISIONS.read_text().splitlines()[-5:]:
            try:
                d = json.loads(line)
                decisions.append(f'{d["decision"].capitalize()}: {d["plan"]}')
            except Exception:
                continue
    status = ("No racks at risk in the next hour." if not racks
              else f"{len(racks)} racks at risk in the next hour.")
    return {
        "shift_ends": clock(fac.minute),
        "status": status,
        "racks_at_risk": len(racks),
        "timeline": timeline,
        "open_items": still_down + tampered or ["Nothing open"],
        "watch_next": watch or ["Nothing predicted in the next hour"],
        "decisions": decisions or ["No decisions this shift"],
        "summary": (f"{len(seen)} failure{'s' if len(seen) != 1 else ''} this shift. "
                    + (f"{len(decisions)} plan{'s' if len(decisions) != 1 else ''} approved. " if decisions else "No fixes approved yet. ")
                    + status),
    }


class Ack(BaseModel):
    name: str


@app.get("/api/handoff")
def handoff():
    return build_handoff()


@app.post("/api/handoff/ack")
def handoff_ack(ack: Ack):
    entry = {"time": time.time(), "facility_minute": state["facility"].minute, "acknowledged_by": ack.name.strip()[:60] or "Incoming operator"}
    ACKS.parent.mkdir(exist_ok=True)
    with open(ACKS, "a") as f:
        f.write(json.dumps(entry) + "\n")
    return entry


# ---------- QR code for judges' phones ----------
def break_url(request: Request) -> str:
    """PUBLIC_URL in .env wins (set it after deploying); otherwise use the address the page was opened from."""
    base = os.environ.get("PUBLIC_URL", "").rstrip("/") or str(request.base_url).rstrip("/")
    return f"{base}/break"


@app.get("/api/qr")
def qr(request: Request):
    url = break_url(request)
    try:
        import io
        import qrcode
        import qrcode.image.svg
        img = qrcode.make(url, image_factory=qrcode.image.svg.SvgPathImage, box_size=10, border=2)
        buf = io.BytesIO()
        img.save(buf)
        svg = buf.getvalue().decode()
    except ImportError:
        raise HTTPException(500, "Run: pip install qrcode")
    local = any(h in url for h in ("localhost", "127.0.0.1"))
    return {"url": url, "svg": svg, "local_only": local}


@app.get("/api/options")
def options():
    return {"failures": FAILURE_KINDS, "actions": ACTIONS}


# ---------- story (scroll-driven intro) ----------
def _frame(fac) -> dict:
    keep = ("status", "inlet_temp_c", "supply_temp_c", "supply_air_c", "battery_min", "fan_pct", "load_pct", "power_kw")
    return {"minute": fac.minute, "assets": {k: {x: v[x] for x in keep if x in v} for k, v in fac.snapshot()["assets"].items()}}


@app.get("/api/eval")
def eval_results():
    """Results of sim/evaluate_twin.py (200 simulated incidents)."""
    f = ROOT / "sim" / "twin_results.json"
    return json.loads(f.read_text()) if f.exists() else {}


@app.get("/api/story")
def story():
    """A recorded incident for the intro page: calm, chiller trip, cascade, and the fixed timeline."""
    fac = FakeFacility(ASSETS, seed=11)
    calm = [_frame(fac)]
    for _ in range(10):
        fac.step()
        calm.append(_frame(fac))
    fac.inject("chiller_trip", "CH-2")
    predicted = project(fac)["chain"]
    fixed_fac = fac.copy()
    broken = []
    for _ in range(36):
        fac.step()
        broken.append(_frame(fac))
    fixed_fac.apply("start_backup_chiller")
    fixed = []
    for _ in range(36):
        fixed_fac.step()
        fixed.append(_frame(fixed_fac))
    racks = sorted({c["id"] for c in predicted if c["type"] == "rack"})
    first_alarm = min((c["minutes"] for c in predicted if c["type"] == "rack" and c["level"] == "warning"), default=None)
    first_cooling = min((c["minutes"] for c in predicted if c["type"] == "crah"), default=None)
    return {"calm": calm, "broken": broken, "fixed": fixed, "racks_at_risk": len(racks),
            "first_rack_alarm_min": first_alarm, "first_cooling_min": first_cooling, "root": "CH-2"}


# ---------- pages ----------
@app.get("/")
def story_page():
    return FileResponse(ROOT / "frontend" / "story.html")


@app.get("/control")
def index():
    return FileResponse(ROOT / "frontend" / "index.html")


@app.get("/debug")
def debug():
    return FileResponse(ROOT / "frontend" / "debug.html")


@app.get("/break")
def break_page():
    page = ROOT / "phone" / "index.html"
    if not page.exists():
        raise HTTPException(404, "Phone page not built yet")
    return FileResponse(page)


app.mount("/static", StaticFiles(directory=ROOT / "frontend"), name="static")
