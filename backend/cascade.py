"""
Cascade engine: run a copy of the facility forward in time and report what
fails next, when, and why.

This is a digital-twin projection: we copy the current state, step it forward
minute by minute, and record the first minute each asset crosses its limit.
The dependency graph explains *why* (which upstream failure causes it).
"""
from typing import Dict, List, Optional

HORIZON = 60  # minutes to look ahead
FAILED = {"tripped", "down", "depleted", "no_power", "offline"}


def _crossing(asset: dict, state: dict) -> Optional[str]:
    """Which limit has this asset crossed right now? None if fine."""
    t = asset["type"]
    if state.get("status") in FAILED:
        return "failed"
    lim = asset.get("limit")
    if not lim:
        return None
    v = state.get(lim["metric"])
    if v is None:
        return None
    if "min" in lim and "max" not in lim:
        return "low" if v <= lim["min"] else None
    if t == "rack":
        if v >= lim["max"]:
            return "critical"
        if v >= lim["warn"]:
            return "warning"
        return None
    if v >= lim["max"]:
        return "high"
    return "degrading" if state.get("status") == "degrading" else None


def _describe(asset: dict, level: str, status: str = "") -> str:
    lim = asset.get("limit") or {}
    name = asset["name"]
    if level == "failed":
        if status == "tripped":
            return f"{name} trips"
        if status == "down":
            return f"{name} goes down"
        if status == "no_power":
            return f"{name} loses power"
        return {"rack": f"{name} shuts down", "ups": f"{name} battery runs out"}.get(asset["type"], f"{name} fails")
    if level == "degrading":
        return f"{name} fan is wearing out"
    if level == "warning":
        return f"{name} inlet air passes {lim['warn']}°C"
    if level == "critical":
        return f"{name} inlet air passes {lim['max']}°C"
    if level == "low":
        return f"{name} battery drops under {lim['min']} min"
    unit = "°C" if lim.get("metric", "").endswith("_c") else "%"
    label = {"supply_temp_c": "water out", "supply_air_c": "air out", "load_pct": "load"}.get(lim.get("metric"), lim.get("metric"))
    return f"{name} {label} passes {lim['max']}{unit}"


def root_causes(facility) -> List[dict]:
    """Failures that were injected and are still active."""
    return [e for e in facility.events if e["type"] == "failure"]


def why(asset_id: str, facility, roots: List[str]) -> List[str]:
    """Walk up the dependency graph to the nearest root failure."""
    seen, frontier, parent = {asset_id}, [asset_id], {}
    while frontier:
        nxt = []
        for node in frontier:
            for up in facility.fed_by.get(node, []):
                if up in seen:
                    continue
                seen.add(up)
                parent[up] = node
                if up in roots:
                    path, cur = [up], up
                    while cur != asset_id:
                        cur = parent[cur]
                        path.append(cur)
                    return path
                nxt.append(up)
        frontier = nxt
    return [asset_id]


def project(facility, horizon: int = HORIZON, frame_every: int = 1) -> Dict:
    """Run a copy forward. Returns the predicted chain and future frames."""
    twin = facility.copy()
    assets = twin.assets
    roots = list({e["asset"] for e in root_causes(facility)})
    root_said = {e["asset"]: {"chiller_trip": "tripped", "grid_loss": "is down", "fan_degradation": "is wearing out",
                              "sensor_silent": "went silent", "sensor_spoof": "was tampered with"}.get(e["kind"], "failed")
                 for e in root_causes(facility)}
    already = {}
    for i, a in assets.items():
        lvl = _crossing(a, twin.s[i])
        if lvl:
            already[(i, lvl)] = 0

    first: Dict[tuple, int] = dict(already)
    status_at: Dict[tuple, str] = {k: twin.s[k[0]].get("status", "") for k in already}
    frames = []
    for m in range(1, horizon + 1):
        snap = twin.step()
        if m % frame_every == 0:
            frames.append({"in": m, "assets": {k: _compact(v) for k, v in twin.s.items()}})
        for i, a in assets.items():
            lvl = _crossing(a, twin.s[i])
            if lvl and (i, lvl) not in first:
                first[(i, lvl)] = m
                status_at[(i, lvl)] = twin.s[i].get("status", "")

    chain = []
    for (i, lvl), m in first.items():
        a = assets[i]
        path = why(i, facility, roots) if roots else [i]
        cause = assets[path[0]]["name"] if len(path) > 1 else None
        spoofed = facility.s[i].get("sensor") == "spoofed"
        chain.append({
            "id": i, "type": a["type"], "level": lvl, "minutes": m,
            "text": _describe(a, lvl, status_at.get((i, lvl), "")),
            "because": ("its sensor is frozen, so only the twin sees this" if spoofed
                        else f"because {cause} {root_said.get(path[0], 'failed')}" if cause else None),
            "path": path,
        })
    # keep the most severe step per asset only once it matters: warning and critical both kept for racks
    chain.sort(key=lambda c: (c["minutes"], c["type"] != "chiller", c["id"]))
    return {"roots": roots, "chain": chain, "frames": frames}


def _compact(s: dict) -> dict:
    keep = ("status", "inlet_temp_c", "supply_temp_c", "supply_air_c", "battery_min", "fan_pct", "load_pct")
    return {k: (round(v, 2) if isinstance(v, float) else v) for k, v in s.items() if k in keep}
