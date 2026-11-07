"""
FaultZero backend.

Run from the project folder:
    uvicorn backend.main:app --reload --port 8000
Then open http://localhost:8000
"""
import asyncio
import json
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from backend.fake_sim import ACTIONS, FAILURE_KINDS, FakeFacility, load_assets

ROOT = Path(__file__).resolve().parent.parent
TICK_SECONDS = 1.0  # one simulated minute per real second

app = FastAPI(title="FaultZero")
ASSETS = load_assets()
state = {"facility": FakeFacility(ASSETS), "latest": None}


async def ticker():
    while True:
        state["latest"] = state["facility"].step()
        await asyncio.sleep(TICK_SECONDS)


@app.on_event("startup")
async def start_ticker():
    state["latest"] = state["facility"].snapshot()
    asyncio.create_task(ticker())


# ---------- read ----------
@app.get("/api/assets")
def get_assets():
    return {"assets": ASSETS}


@app.get("/api/state")
def get_state():
    return state["latest"]


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
        return state["facility"].inject(req.kind, req.asset)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/action")
def action(req: ActionRequest):
    try:
        return state["facility"].apply(req.action, req.asset)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/reset")
def reset():
    state["facility"] = FakeFacility(ASSETS)
    state["latest"] = state["facility"].snapshot()
    return {"ok": True}


@app.get("/api/options")
def options():
    return {"failures": FAILURE_KINDS, "actions": ACTIONS}


# ---------- pages ----------
@app.get("/")
def index():
    return FileResponse(ROOT / "frontend" / "index.html")


@app.get("/break")
def break_page():
    page = ROOT / "phone" / "index.html"
    if not page.exists():
        raise HTTPException(404, "Phone page not built yet")
    return FileResponse(page)


app.mount("/static", StaticFiles(directory=ROOT / "frontend"), name="static")
