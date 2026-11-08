"""
Probabilistic forecast: run many possible futures instead of one.

The twin never knows exactly how bad a failure is or what the sensor noise will do.
So we run an ensemble: K copies of the (calibrated) facility, each with the failure
severity perturbed within a plausible range and its own random noise, all stepped
60 minutes ahead. For the first rack to pass 32°C (and 27°C), we report:

  - p50: the median minute it happens
  - p10 / p90: an 80% range
  - probability that it happens within the hour at all

sim/evaluate_ensemble.py checks that these ranges are honest (how often the real
outcome lands inside them).
"""
import random
import statistics
from typing import Dict, List, Optional

K = 24
HORIZON = 60
SPREAD = 0.25  # each run assumes the failure is up to 25% milder or worse than estimated


def _quantile(xs: List[float], q: float) -> float:
    xs = sorted(xs)
    i = (len(xs) - 1) * q
    lo, hi = int(i), min(int(i) + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (i - lo)


def _perturb(twin, rng: random.Random):
    for s in twin.s.values():
        if s.get("status") == "degraded" and "capacity" in s:
            lost = (1 - s["capacity"]) * rng.uniform(1 - SPREAD, 1 + SPREAD)
            s["capacity"] = max(0.0, min(1.0, 1 - lost))
        if s.get("status") == "degrading" and "wear_rate" in s:
            s["wear_rate"] *= rng.uniform(1 - SPREAD, 1 + SPREAD)


def first_crossings(twin, racks: List[str], horizon: int = HORIZON) -> Dict[str, Optional[int]]:
    out = {"warn": None, "crit": None}
    for m in range(1, horizon + 1):
        twin.step()
        hot = max(twin.s[r]["inlet_temp_c"] for r in racks)
        if out["warn"] is None and hot >= 27:
            out["warn"] = m
        if hot >= 32:
            out["crit"] = m
            break
    return out


def forecast(facility, k: int = K, seed: int = 0, horizon: int = HORIZON) -> dict:
    racks = [a for a, s in facility.s.items() if facility.assets[a]["type"] == "rack"]
    rng = random.Random(seed)
    runs = []
    for _ in range(k):
        twin = facility.copy()
        twin.rng = random.Random(rng.random())
        for r in list(twin.hidden_heat):
            twin.hidden_heat[r] = 0.0
        _perturb(twin, rng)
        runs.append(first_crossings(twin, racks, horizon))
    out = {"runs": k}
    for key in ("warn", "crit"):
        hits = [r[key] for r in runs if r[key] is not None]
        p = len(hits) / k
        out[key] = {"probability": round(p, 2)}
        if len(hits) >= max(3, k // 4):
            out[key].update({"p10": round(_quantile(hits, 0.1), 1), "p50": round(statistics.median(hits), 1),
                             "p90": round(_quantile(hits, 0.9), 1)})
    return out
