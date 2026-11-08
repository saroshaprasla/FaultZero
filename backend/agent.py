"""
FaultZero incident agent.

Nemotron investigates an incident with tools, tests fix plans in the digital
twin, and proposes ranked plans. A human approves every action.
If Nemotron is unavailable, a scripted planner runs the same tools so the
operator still gets plans (the UI says which one produced them).
"""
import itertools
import json
import os
import time
from typing import Callable, Dict, List, Optional

from backend.cascade import project

MODEL = os.environ.get("NEMOTRON_MODEL", "nvidia/nemotron-3.5-super-vl-120b-a12b")
BASE_URL = "https://integrate.api.nvidia.com/v1"
MAX_STEPS = 10
CALL_TIMEOUT = 30

ACTION_INFO = {
    "start_backup_chiller": "Start the standby chiller (CH-3) and switch the tripped chiller's cooling units onto it.",
    "raise_fan_speed": "Raise every working cooling unit's fans to 95% to move more air.",
    "start_generator": "Start the backup generator so chillers and UPS units have power during a utility outage.",
    "shift_load": "Move 40% of the compute load off one row (pass the row letter as asset, e.g. 'C').",
    "isolate_rack": "Migrate all workloads off one rack and lock it for a technician to inspect (pass the rack id as asset).",
}

SYSTEM = """You are FaultZero's incident agent for a data center night shift.
A failure is happening in Data Hall 1 (a simulated facility). Your job:
1. Investigate with the tools: what broke, what the cascade will hit, and when.
2. Build 2 or 3 candidate plans from the available actions and test EVERY plan with simulate_plan.
3. Call submit_plans with the plans ranked best first, using only numbers returned by simulate_plan.
Rules: you never act on the facility yourself; a human approves. Keep each reason to one plain sentence.
Prefer plans that keep the most racks safe; among equal plans, prefer fewer actions."""


def _tools_schema() -> List[dict]:
    def fn(name, desc, props=None, required=None):
        return {"type": "function", "function": {"name": name, "description": desc, "parameters": {
            "type": "object", "properties": props or {}, "required": required or []}}}
    action_item = {"type": "object", "properties": {
        "action": {"type": "string", "enum": list(ACTION_INFO)},
        "asset": {"type": "string", "description": "Optional target, e.g. row letter for shift_load"}},
        "required": ["action"]}
    return [
        fn("get_incident", "What failed, when, and the current facility time."),
        fn("get_cascade", "The digital twin's 60-minute prediction of what fails next and why."),
        fn("get_asset", "Live readings and dependencies for one asset id (e.g. CH-2, CRAH-4, RACK-C3).",
           {"asset_id": {"type": "string"}}, ["asset_id"]),
        fn("list_mitigations", "Actions the operator can approve."),
        fn("simulate_plan", "Run the twin 60 minutes ahead with these actions applied. Returns racks at risk.",
           {"name": {"type": "string"}, "actions": {"type": "array", "items": action_item}}, ["name", "actions"]),
        fn("submit_plans", "Final answer: 2-3 plans ranked best first.",
           {"plans": {"type": "array", "items": {"type": "object", "properties": {
               "name": {"type": "string"}, "actions": {"type": "array", "items": action_item},
               "reason": {"type": "string"}}, "required": ["name", "actions", "reason"]}}},
           ["plans"]),
    ]


class IncidentTools:
    """Tool implementations. They read a snapshot of the live facility and never change it."""

    def __init__(self, facility):
        self.f = facility
        self.sim_cache: Dict[str, dict] = {}

    def get_incident(self) -> dict:
        seen, fails = set(), []
        for e in self.f.events:
            if e["type"] == "failure" and (e["asset"], e["kind"]) not in seen:
                seen.add((e["asset"], e["kind"]))
                fails.append(e)
        return {"facility_minute": self.f.minute,
                "failures": [{"asset": e["asset"], "name": self.f.assets[e["asset"]]["name"], "kind": e["kind"],
                              "minutes_ago": self.f.minute - e["minute"]} for e in fails],
                "actions_already_taken": [e for e in self.f.events if e["type"] == "action"]}

    def get_cascade(self) -> dict:
        chain = project(self.f)["chain"]
        racks = sorted({c["id"] for c in chain if c["type"] == "rack"})
        steps = [f'+{c["minutes"]} min: {c["text"]}' + (f' ({c["because"]})' if c["because"] else "")
                 for c in chain if c["type"] != "rack"][:10]
        rows = {}
        for c in chain:
            if c["type"] == "rack" and c["level"] == "warning":
                rows.setdefault(c["id"][5], []).append(c["minutes"])
        rack_lines = [f"+{min(v)} min: Row {r}, {_racks(len(v))} pass 27°C" for r, v in sorted(rows.items())]
        return {"racks_at_risk": len(racks), "equipment_chain": steps, "rack_chain": rack_lines}

    def get_asset(self, asset_id: str) -> dict:
        a = self.f.assets.get(asset_id)
        if not a:
            return {"error": f"unknown asset {asset_id}"}
        return {"id": asset_id, "name": a["name"], "type": a["type"], "readings": self.f.s[asset_id],
                "depends_on": self.f.fed_by.get(asset_id, []), "feeds": a["feeds"][:8], "limit": a.get("limit")}

    def list_mitigations(self) -> dict:
        return {"actions": [{"action": k, "what_it_does": v} for k, v in ACTION_INFO.items()]}

    def simulate_plan(self, name: str, actions: List[dict]) -> dict:
        key = json.dumps(sorted((x["action"], x.get("asset") or "") for x in actions))
        if key in self.sim_cache:
            return self.sim_cache[key]
        twin = self.f.copy()
        applied = []
        for x in actions:
            if x.get("action") not in ACTION_INFO:
                return {"error": f"unknown action {x.get('action')}"}
            twin.apply(x["action"], x.get("asset"))
            applied.append(x["action"])
        out = _outcome(twin)
        out["plan"] = name
        self.sim_cache[key] = out
        return out


def _outcome(twin) -> dict:
    res = project(twin)
    chain = res["chain"]
    warn = [c for c in chain if c["type"] == "rack" and c["level"] in ("warning", "critical", "failed")]
    racks = sorted({c["id"] for c in warn})
    crit = sorted({c["id"] for c in chain if c["type"] == "rack" and c["level"] in ("critical", "failed")})
    over_minutes = 0  # rack-minutes above 27°C across the hour: a proxy for SLA exposure
    for fr in res["frames"]:
        for k, v in fr["assets"].items():
            if k.startswith("RACK-") and (v.get("inlet_temp_c") or 0) >= 27:
                over_minutes += 1
    first = min((c["minutes"] for c in warn), default=None)
    return {"racks_at_risk": len(racks), "racks_critical": len(crit), "rack_minutes_over_27c": over_minutes,
            "first_rack_warning_in_min": first, "usd_at_risk": _usd_at_risk(res["frames"])}


def _usd_at_risk(frames) -> Optional[int]:
    """Illustrative $ exposure over the predicted hour, using business/impact.py on every
    future minute (each frame counts as 1/60 of an hour)."""
    try:
        from business.impact import calculate_impact
    except Exception:
        return None
    total = 0.0
    for fr in frames:
        total += calculate_impact(fr, exposure_hours=1 / 60)["estimated_exposure_usd"]
    return int(round(total, -1))


def baseline(facility) -> dict:
    return _outcome(facility.copy())


# ---------------------------------------------------------------------------
class AgentRun:
    """One investigation. Steps are appended live so the UI can stream them."""

    def __init__(self, facility, on_change: Callable[[], None] = lambda: None):
        self.tools = IncidentTools(facility.copy())
        self.base = baseline(facility)
        self.on_change = on_change
        self.state = {"status": "running", "source": None, "steps": [], "plans": [], "baseline": self.base,
                      "started_minute": facility.minute, "error": None}

    pace = 0.0  # seconds between scripted steps (set by the server for a readable live feed)

    def step(self, kind: str, text: str):
        self.state["steps"].append({"kind": kind, "text": text, "t": round(time.time(), 2)})
        self.on_change()
        if self.pace and self.state.get("source") == "scripted":
            time.sleep(self.pace)

    # ----- tool dispatch shared by Nemotron and the scripted planner -----
    def call_tool(self, name: str, args: dict):
        t = self.tools
        if name == "get_incident":
            r = t.get_incident()
            what = ", ".join(f'{x["name"]} ({x["kind"].replace("_", " ")})' for x in r["failures"]) or "nothing"
            self.step("tool", f"Checked the incident: {what}")
        elif name == "get_cascade":
            r = t.get_cascade()
            first = (r["equipment_chain"] + r["rack_chain"] + ["no further failures"])[0]
            self.step("tool", f"Read the twin's forecast: {_racks(r['racks_at_risk'])} at risk. First: {first}")
        elif name == "get_asset":
            r = t.get_asset(args.get("asset_id", ""))
            self.step("tool", f"Inspected {r.get('name', args.get('asset_id'))}: status {r.get('readings', {}).get('status', '?')}")
        elif name == "list_mitigations":
            r = t.list_mitigations()
            self.step("tool", f"Listed {len(r['actions'])} possible actions")
        elif name == "simulate_plan":
            r = t.simulate_plan(args.get("name", "Plan"), args.get("actions", []))
            if "error" not in r:
                self.step("sim", f"Tested “{args.get('name', 'Plan')}” in the twin: {_racks(r['racks_at_risk'])} at risk "
                                 f"(vs {self.base['racks_at_risk']} if nothing is done)")
        elif name == "submit_plans":
            r = self.finalize(args.get("plans", []))
        else:
            r = {"error": f"unknown tool {name}"}
        return r

    def finalize(self, plans: List[dict]) -> dict:
        ranked = []
        for p in plans[:3]:
            acts = [a for a in p.get("actions", []) if a.get("action") in ACTION_INFO]
            if not acts:
                continue
            outcome = self.tools.simulate_plan(p.get("name", "Plan"), acts)  # verified numbers, never the model's
            ranked.append({"name": p.get("name", "Plan"), "actions": acts, "reason": p.get("reason", ""), "outcome": outcome})
        ranked.sort(key=lambda p: (p["outcome"]["racks_at_risk"], p["outcome"]["rack_minutes_over_27c"], len(p["actions"])))
        self.state["plans"] = ranked
        self.state["status"] = "done" if ranked else "error"
        self.step("done", f"Proposed {len(ranked)} plans. Waiting for your approval." if ranked else "No valid plans found.")
        return {"accepted": len(ranked)}

    # ----- Nemotron -----
    def run_nemotron(self) -> bool:
        key = os.environ.get("NVIDIA_API_KEY")
        if not key:
            self.step("note", "No Nvidia API key found, using the scripted planner.")
            return False
        try:
            from openai import OpenAI
        except ImportError:
            return False
        client = OpenAI(base_url=BASE_URL, api_key=key, timeout=CALL_TIMEOUT)
        self.state["source"] = "nemotron"
        self.step("think", "Nemotron is investigating…")
        messages = [{"role": "system", "content": SYSTEM},
                    {"role": "user", "content": "An incident just started. Investigate and propose ranked plans."}]
        tools = _tools_schema()
        for _ in range(MAX_STEPS):
            try:
                resp = client.chat.completions.create(
                    model=MODEL, messages=messages, tools=tools, tool_choice="auto", temperature=0.2, max_tokens=900,
                    extra_body={"chat_template_kwargs": {"enable_thinking": False}})
            except Exception as e:  # network, rate limit, model error
                self.step("note", f"Nemotron did not answer ({type(e).__name__}), switching to the scripted planner.")
                return False
            msg = resp.choices[0].message
            calls = msg.tool_calls or []
            if msg.content and msg.content.strip():
                self.step("think", msg.content.strip()[:240])
            if not calls:
                messages.append({"role": "assistant", "content": msg.content or ""})
                messages.append({"role": "user", "content": "Use the tools, then call submit_plans."})
                continue
            messages.append({"role": "assistant", "content": msg.content or "", "tool_calls": [
                {"id": c.id, "type": "function", "function": {"name": c.function.name, "arguments": c.function.arguments}}
                for c in calls]})
            for c in calls:
                try:
                    args = json.loads(c.function.arguments or "{}")
                except json.JSONDecodeError:
                    args = {}
                result = self.call_tool(c.function.name, args)
                messages.append({"role": "tool", "tool_call_id": c.id, "content": json.dumps(result)[:4000]})
                if c.function.name == "submit_plans" and self.state["plans"]:
                    return True
        self.step("note", "Nemotron ran out of steps, finishing with the scripted planner.")
        return False

    # ----- scripted planner: same tools, fixed strategy -----
    def run_scripted(self):
        self.state["source"] = "scripted"
        inc = self.call_tool("get_incident", {})
        self.call_tool("get_cascade", {})
        for f in inc["failures"][:2]:
            self.call_tool("get_asset", {"asset_id": f["asset"]})
        self.call_tool("list_mitigations", {})
        kinds = {f["kind"] for f in inc["failures"]}
        singles = [{"action": "raise_fan_speed"}, {"action": "shift_load", "asset": "C"}]
        if "chiller_trip" in kinds:
            singles.insert(0, {"action": "start_backup_chiller"})
        if "grid_loss" in kinds:
            singles.insert(0, {"action": "start_generator"})
        for f in inc["failures"]:
            if f["kind"] in ("sensor_spoof", "sensor_silent"):
                singles.insert(0, {"action": "isolate_rack", "asset": f["asset"]})
        candidates = [[s] for s in singles] + [list(c) for c in itertools.combinations(singles[:3], 2)]
        named = []
        for acts in candidates[:5]:
            name = " + ".join(_short(a) for a in acts)
            out = self.call_tool("simulate_plan", {"name": name, "actions": acts})
            named.append((out["racks_at_risk"], out["rack_minutes_over_27c"], len(acts), name, acts))
        named.sort(key=lambda x: x[:3])
        plans = [{"name": n, "actions": a, "reason": _reason(a, r, self.base["racks_at_risk"])} for r, _, _, n, a in named[:3]]
        self.call_tool("submit_plans", {"plans": plans})

    def run(self):
        try:
            if not self.run_nemotron():
                self.run_scripted()
        except Exception as e:
            self.state["status"] = "error"
            self.state["error"] = str(e)
            self.step("note", f"Agent error: {e}")


def _short(a: dict) -> str:
    return {"start_backup_chiller": "Start backup chiller", "raise_fan_speed": "Raise fan speeds",
            "start_generator": "Start generator", "shift_load": f"Move load off row {a.get('asset') or 'C'}",
            "isolate_rack": f"Isolate {(a.get('asset') or 'the rack').replace('RACK-', 'rack ')}"}[a["action"]]


def _racks(n: int) -> str:
    return f"{n} rack" + ("" if n == 1 else "s")


def _reason(acts: List[dict], racks: int, base: int) -> str:
    if racks == 0:
        return f"Keeps every rack under 27°C for the next hour, instead of {_racks(base)} overheating."
    if racks < base:
        return f"Cuts racks at risk from {base} to {racks} within the hour."
    return f"Doesn't stop the overheating, but shortens how long racks run hot."
