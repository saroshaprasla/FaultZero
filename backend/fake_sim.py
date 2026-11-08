"""
Fake facility for building the backend and UI before the real simulator is ready.

It produces data in exactly the agreed format (see docs/FORMATS.md), so swapping
in sim/simulator.py later only changes one import in main.py.
One call to step() = one simulated minute.
"""
import copy
import json
import math
import random
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional

DATA = Path(__file__).resolve().parent.parent / "data"

FAILURE_KINDS = ["chiller_trip", "fan_degradation", "grid_loss", "sensor_silent", "sensor_spoof"]
ACTIONS = ["start_backup_chiller", "raise_fan_speed", "start_generator", "shift_load", "isolate_rack"]


NOMINAL_PHYSICS = {
    "rack_rate": 0.15,    # how fast a rack's inlet air follows its cooling (per minute)
    "rack_offset": 4.5,   # rack inlet above supply air at zero load (degC)
    "air_rate": 0.25,     # how fast a cooling unit's supply air follows chilled water
    "chill_loss": 15.0,   # how much warmer chilled water settles when a chiller loses all capacity
}


def load_assets(path: Path = DATA / "assets.json") -> List[dict]:
    with open(path) as f:
        return json.load(f)["assets"]


class FakeFacility:
    def __init__(self, assets: List[dict], seed: int = 7):
        self.rng = random.Random(seed)
        self.assets = {a["id"]: a for a in assets}
        self.minute = 0
        self.start = datetime(2026, 8, 14, 21, 0)  # a hot August evening in Dallas
        self.events: List[dict] = []

        # who feeds whom (reverse lookups)
        self.fed_by: Dict[str, List[str]] = {i: [] for i in self.assets}
        for a in assets:
            for child in a["feeds"]:
                self.fed_by[child].append(a["id"])

        # live state per asset
        self.s: Dict[str, dict] = {}
        for i, a in self.assets.items():
            t = a["type"]
            if t == "utility":
                self.s[i] = {"status": "ok"}
            elif t == "generator":
                self.s[i] = {"status": "standby"}
            elif t == "ups":
                self.s[i] = {"status": "ok", "on_battery": False, "battery_min": 12.0, "load_kw": 0.0}
            elif t == "pdu":
                self.s[i] = {"status": "ok", "load_pct": 0.0}
            elif t == "chiller":
                standby = a.get("standby", False)
                self.s[i] = {"status": "standby" if standby else "ok", "load_pct": 0.0 if standby else 70.0,
                             "supply_temp_c": 7.0}
            elif t == "crah":
                self.s[i] = {"status": "ok", "fan_pct": 70.0, "supply_air_c": 18.0}
            elif t == "rack":
                self.s[i] = {"status": "ok", "power_kw": round(self.rng.uniform(6, 12), 1), "inlet_temp_c": 22.5,
                             "sensor": "ok"}
        self.reported: Dict[str, Optional[float]] = {}
        self.base_power = {i: v["power_kw"] for i, v in self.s.items() if self.assets[i]["type"] == "rack"}
        self.hidden_heat: Dict[str, float] = {}  # extra heat an attacker hides behind a spoofed sensor
        # physics constants. The "real" building can differ from what the twin assumes;
        # sim/robustness.py perturbs these to test how wrong the twin can be and still warn early.
        self.physics: Dict[str, float] = dict(NOMINAL_PHYSICS)

    # ---------- failures and actions ----------
    def inject(self, kind: str, asset: Optional[str] = None, severity: float = 1.0) -> dict:
        """severity 0-1: how bad the failure is. 1.0 (default) = complete failure.
        chiller_trip     -> fraction of cooling capacity lost (0.5 = half; 1.0 = tripped)
        fan_degradation  -> how fast the fan wears out (1.0 = 2.5% of speed lost per minute)
        sensor_spoof     -> how much extra load the attacker hides
        grid_loss, sensor_silent -> all-or-nothing, severity is ignored"""
        severity = max(0.05, min(1.0, float(severity)))
        if kind not in FAILURE_KINDS:
            raise ValueError(f"unknown failure kind: {kind}")
        if asset is None:
            asset = {"chiller_trip": "CH-2", "fan_degradation": "CRAH-4", "grid_loss": "UTIL",
                     "sensor_silent": "RACK-C3", "sensor_spoof": "RACK-C4"}[kind]
        if asset not in self.assets:
            raise ValueError(f"unknown asset: {asset}")
        if kind == "chiller_trip":
            self.s[asset]["status"] = "tripped" if severity >= 0.99 else "degraded"
            self.s[asset]["capacity"] = round(1 - severity, 2)
        elif kind == "fan_degradation":
            self.s[asset]["status"] = "degrading"
            self.s[asset]["wear_rate"] = round(2.5 * severity, 2)
        elif kind == "grid_loss":
            self.s["UTIL"]["status"] = "down"
        elif kind == "sensor_silent":
            self.s[asset]["sensor"] = "silent"
        elif kind == "sensor_spoof":
            # zero-day style attack: the sensor is frozen at an "all good" value while the
            # attacker overloads the rack, so the real temperature climbs where nobody sees it
            self.s[asset]["sensor"] = "spoofed"
            self.reported[asset] = self.s[asset]["inlet_temp_c"]
            self.s[asset]["power_kw"] = round(self.s[asset]["power_kw"] * (1 + 1.3 * severity), 1)
            self.hidden_heat[asset] = 6.0 * severity
        ev = {"minute": self.minute, "type": "failure", "kind": kind, "asset": asset, "severity": severity}
        self.events.append(ev)
        return ev

    def apply(self, action: str, asset: Optional[str] = None) -> dict:
        if action == "start_backup_chiller":
            self.s["CH-3"].update(status="ok", load_pct=80.0)
            for i, a in self.assets.items():  # backup takes over the CRAHs of any tripped chiller
                if a["type"] == "chiller" and self.s[i]["status"] in ("tripped", "degraded"):
                    for crah in a["feeds"]:
                        self.fed_by[crah] = ["CH-3"]
        elif action == "raise_fan_speed":
            for i, a in self.assets.items():
                if a["type"] == "crah" and self.s[i]["status"] == "ok":
                    self.s[i]["fan_pct"] = 95.0
        elif action == "start_generator":
            self.s["GEN-1"]["status"] = "ok"
        elif action == "isolate_rack":
            rack = asset or next((i for i, v in self.s.items() if v.get("sensor") in ("spoofed", "silent")), None)
            if rack and rack in self.s:
                self.s[rack]["power_kw"] = 0.5          # workloads migrated, rack locked for inspection
                self.hidden_heat.pop(rack, None)
                self.base_power[rack] = 0.5
                asset = rack
        elif action == "shift_load":
            row = asset or "C"
            for i, a in self.assets.items():
                if a["type"] == "rack" and i.startswith(f"RACK-{row}"):
                    self.s[i]["power_kw"] = round(self.s[i]["power_kw"] * 0.6, 1)
                    self.base_power[i] = self.s[i]["power_kw"]
        else:
            raise ValueError(f"unknown action: {action}")
        ev = {"minute": self.minute, "type": "action", "action": action, "asset": asset}
        self.events.append(ev)
        return ev

    def copy(self) -> "FakeFacility":
        """Independent copy, used to run 'what if' futures forward."""
        return copy.deepcopy(self)

    # ---------- physics (simple and fake on purpose) ----------
    def outdoor_temp_c(self) -> float:
        return round(31 + 4 * math.sin(self.minute / 180), 1)

    def step(self) -> dict:
        self.minute += 1
        s, rng = self.s, self.rng

        grid_ok = s["UTIL"]["status"] == "ok"
        gen_ok = s["GEN-1"]["status"] == "ok"

        # chillers
        for i, a in self.assets.items():
            if a["type"] != "chiller":
                continue
            c = s[i]
            if c["status"] == "ok" and not grid_ok and not gen_ok:
                c["status"] = "no_power"
            elif c["status"] == "no_power" and (grid_ok or gen_ok):
                c["status"] = "ok"
            if c["status"] == "ok":
                c["supply_temp_c"] += (7.0 - c["supply_temp_c"]) * 0.3
                c["load_pct"] = round(min(100, 65 + (self.outdoor_temp_c() - 30) * 3 + rng.uniform(-2, 2)), 1)
            elif c["status"] == "degraded":  # partial capacity: water settles warmer the more capacity is lost
                target = 7.0 + (1 - c.get("capacity", 1.0)) * self.physics["chill_loss"]
                c["supply_temp_c"] += (target - c["supply_temp_c"]) * 0.15
                c["load_pct"] = 100.0
            elif c["status"] in ("tripped", "no_power"):
                c["supply_temp_c"] = min(22.0, c["supply_temp_c"] + 1.2)
                c["load_pct"] = 0.0
            c["supply_temp_c"] = round(c["supply_temp_c"], 2)

        # cooling units
        for i, a in self.assets.items():
            if a["type"] != "crah":
                continue
            u = s[i]
            if u["status"] == "degrading":
                u["fan_pct"] = max(10.0, u["fan_pct"] - u.get("wear_rate", 2.5))
            chillers = [c for c in self.fed_by[i] if self.assets[c]["type"] == "chiller"]
            water = min(s[c]["supply_temp_c"] for c in chillers) if chillers else 22.0
            power = 1.0 if (grid_ok or gen_ok) else 0.0
            target = water + 11 + (70 - u["fan_pct"]) * 0.16 + (1 - power) * 8
            u["supply_air_c"] = round(u["supply_air_c"] + (target - u["supply_air_c"]) * self.physics["air_rate"], 2)

        # power
        for i, a in self.assets.items():
            if a["type"] == "ups":
                u = s[i]
                load = sum(s[r]["power_kw"] for p in a["feeds"] for r in self.assets[p]["feeds"])
                u["load_kw"] = round(load, 1)
                u["on_battery"] = not grid_ok and not gen_ok
                if u["on_battery"]:
                    u["battery_min"] = max(0.0, round(u["battery_min"] - 1.0, 1))
                    u["status"] = "on_battery" if u["battery_min"] > 0 else "depleted"
                else:
                    u["status"] = "ok"
            elif a["type"] == "pdu":
                load = sum(s[r]["power_kw"] for r in a["feeds"])
                s[i]["load_pct"] = round(load / 80 * 100, 1)

        # racks
        for i, a in self.assets.items():
            if a["type"] != "rack":
                continue
            r = s[i]
            pdu = next(p for p in self.fed_by[i] if self.assets[p]["type"] == "pdu")
            ups = self.fed_by[pdu][0]
            if s[ups]["status"] == "depleted":
                r["status"], r["power_kw"] = "offline", 0.0
            elif r["status"] == "offline":
                r["status"], r["power_kw"] = "ok", self.base_power[i]
            crahs = [c for c in self.fed_by[i] if self.assets[c]["type"] == "crah"]
            air = sum(s[c]["supply_air_c"] for c in crahs) / len(crahs)
            target = air + self.physics["rack_offset"] + r["power_kw"] * 0.05 + self.hidden_heat.get(i, 0.0)
            r["inlet_temp_c"] = round(r["inlet_temp_c"] + (target - r["inlet_temp_c"]) * self.physics["rack_rate"] + rng.uniform(-0.05, 0.05), 2)
            if r["status"] != "offline":
                lim = a["limit"]
                r["status"] = ("critical" if r["inlet_temp_c"] >= lim["max"]
                               else "warning" if r["inlet_temp_c"] >= lim["warn"] else "ok")
        return self.snapshot()

    # ---------- output in the agreed format ----------
    def snapshot(self) -> dict:
        out = {}
        for i, v in self.s.items():
            d = dict(v)
            if self.assets[i]["type"] == "rack":
                if d["sensor"] == "silent":
                    d["inlet_temp_c"] = None
                elif d["sensor"] == "spoofed":
                    d["inlet_temp_c"] = self.reported[i]
                    d["status"] = "ok"  # the tampered sensor says everything is fine
                d.pop("sensor")
            out[i] = d
        return {
            "t": (self.start + timedelta(minutes=self.minute)).isoformat(),
            "minute": self.minute,
            "outdoor_temp_c": self.outdoor_temp_c(),
            "assets": out,
            "events": self.events[-20:],
        }
