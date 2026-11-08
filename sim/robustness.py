"""
Robustness: what if the real building does not behave the way the twin thinks?

The "real" facility gets different physics constants (racks heat faster, cooling responds
slower, a failed chiller hurts more), while both twins keep assuming the nominal values.
We rerun the same random incidents and check how much warning survives the model error.

Run:  python sim/robustness.py        (a few minutes)
Writes sim/robustness_results.json
"""
import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "sim"))

import evaluate_twin as ev  # noqa: E402
from backend.fake_sim import NOMINAL_PHYSICS  # noqa: E402

N = 120
SCENARIOS = {
    "matches the twin": {},
    "racks heat 30% faster": {"rack_rate": NOMINAL_PHYSICS["rack_rate"] * 1.3},
    "cooling 30% slower": {"air_rate": NOMINAL_PHYSICS["air_rate"] * 0.7},
    "chiller failures 30% worse": {"chill_loss": NOMINAL_PHYSICS["chill_loss"] * 1.3},
    "all three at once": {"rack_rate": NOMINAL_PHYSICS["rack_rate"] * 1.3,
                          "air_rate": NOMINAL_PHYSICS["air_rate"] * 0.7,
                          "chill_loss": NOMINAL_PHYSICS["chill_loss"] * 1.3},
}


def main():
    rng = random.Random(2027)
    incidents = []
    while len(incidents) < N:
        k, a, s = ev.random_incident(rng)
        if k in ("chiller_trip", "fan_degradation", "grid_loss"):
            incidents.append((k, a, s))
    out = {"incidents": N, "note": "both twins assume nominal physics; only the simulated building changes",
           "scenarios": {}}
    for name, phys in SCENARIOS.items():
        rows = [ev.run_incident(3000 + i, k, a, s, physics=phys) for i, (k, a, s) in enumerate(incidents)]
        out["scenarios"][name] = {
            "physics": phys,
            "fixed_alarm": ev.score(rows, "fixed"),
            "straight_line_forecast": ev.score(rows, "line"),
            "faultzero_twin": ev.score(rows, "twin"),
            "faultzero_self_calibrating_twin": ev.score(rows, "calib"),
        }
        sc = out["scenarios"][name]
        print(f"{name:28s} overheated={sc['fixed_alarm']['incidents_that_really_overheated']:3d}  "
              f"median warning: alarm {sc['fixed_alarm']['median_minutes_of_warning']:4} | "
              f"line {sc['straight_line_forecast']['median_minutes_of_warning']:4} | "
              f"twin {sc['faultzero_twin']['median_minutes_of_warning']:4} | "
              f"calibrated {sc['faultzero_self_calibrating_twin']['median_minutes_of_warning']:4}  "
              f"(twin early {sc['faultzero_twin']['warned_before_overheating']}, calib early "
              f"{sc['faultzero_self_calibrating_twin']['warned_before_overheating']})", flush=True)
    (ROOT / "sim" / "robustness_results.json").write_text(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
