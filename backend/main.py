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

from fastapi import FastAPI, HTTPException
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
def get_future():
    """Minute-by-minute projection of the next 60 minutes (for the time scrubber)."""
    return state["future"] or {"from_minute": None, "frames": []}


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


class ActionRequest(BaseModel):
    action: str
    asset: Optional[str] = None


@app.post("/api/inject")
def inject(req: InjectRequest):
    try:
        ev = state["facility"].inject(req.kind, req.asset)
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


@app.get("/api/options")
def options():
    return {"failures": FAILURE_KINDS, "actions": ACTIONS}


# ---------- story (scroll-driven intro) ----------
def _frame(fac) -> dict:
    keep = ("status", "inlet_temp_c", "supply_temp_c", "supply_air_c", "battery_min", "fan_pct", "load_pct", "power_kw")
    return {"minute": fac.minute, "assets": {k: {x: v[x] for x in keep if x in v} for k, v in fac.snapshot()["assets"].items()}}


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
