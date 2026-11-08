"""
Self-calibrating twin: estimate how bad a failure is from sensor readings alone.

A real operator never sees "Chiller 2 lost 62% of its capacity". They see the chilled-water
temperature start drifting. This module inverts the twin's physics to recover the hidden
severity from the last two readings, so the twin can run without being told the answer.

- Degraded chiller: its supply water moves a fixed fraction of the way toward a settling
  temperature each minute: x1 = x0 + (target - x0) * k. With two readings,
  target = x0 + (x1 - x0) / k, and capacity = 1 - (target - 7) / chill_loss.
- Wearing fan: fan speed drops by wear_rate per minute, so wear = previous - current.

Until two readings exist after the failure, a cautious prior is used (assume half capacity).
"""
from typing import Dict, Optional

from backend.fake_sim import NOMINAL_PHYSICS

CHILLER_RATE = 0.15          # matches the degraded-chiller response in fake_sim.step
PRIOR_CAPACITY = 0.5         # cautious guess before there is any evidence
PRIOR_WEAR = 2.5


def estimate(prev: Optional[dict], snap: dict, physics: Dict[str, float] = NOMINAL_PHYSICS) -> Dict[str, dict]:
    """Return {asset_id: {"param", "estimate", "readings"}} for every failure whose severity is hidden."""
    out: Dict[str, dict] = {}
    now = snap["assets"]
    before = prev["assets"] if prev else {}
    for aid, s in now.items():
        st = s.get("status")
        if st == "degraded" and "supply_temp_c" in s:
            p = before.get(aid)
            if p and p.get("status") == "degraded":
                x0, x1 = p["supply_temp_c"], s["supply_temp_c"]
                target = x0 + (x1 - x0) / CHILLER_RATE
                cap = 1 - (target - 7.0) / physics["chill_loss"]
                out[aid] = {"param": "capacity", "estimate": round(min(1.0, max(0.0, cap)), 2), "readings": 2}
            else:
                out[aid] = {"param": "capacity", "estimate": PRIOR_CAPACITY, "readings": 0}
        elif st == "degrading" and "fan_pct" in s:
            p = before.get(aid)
            if p and p.get("status") == "degrading" and s["fan_pct"] > 10.0:
                wear = round(max(0.0, p["fan_pct"] - s["fan_pct"]), 2)
                out[aid] = {"param": "wear_rate", "estimate": wear, "readings": 2}
            else:
                out[aid] = {"param": "wear_rate", "estimate": PRIOR_WEAR, "readings": 0}
    return out


def apply(twin, estimates: Dict[str, dict]):
    """Overwrite the twin's hidden failure parameters with the sensor-based estimates."""
    for aid, e in estimates.items():
        twin.s[aid][e["param"]] = e["estimate"]
    return twin
