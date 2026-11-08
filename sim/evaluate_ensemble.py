"""
Are FaultZero's forecast ranges honest?

For 150 random equipment failures, the self-calibrating twin forecasts (from sensor
readings only) when the first rack will pass 32°C, as an 80% range (p10-p90) and a
probability of it happening within the hour. Then the real facility runs and we check:

  - coverage: how often the real minute landed inside the 80% range (honest = about 80%)
  - Brier score of the "within the hour" probability (0 = perfect, 0.25 = coin flip)

Run:  python sim/evaluate_ensemble.py      (about a minute)
Writes sim/ensemble_results.json
"""
import json
import random
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import calibrate  # noqa: E402
from backend.ensemble import forecast  # noqa: E402
from backend.fake_sim import NOMINAL_PHYSICS, FakeFacility, load_assets  # noqa: E402

ASSETS = load_assets()
RACKS = [a["id"] for a in ASSETS if a["type"] == "rack"]
CRAHS = [a["id"] for a in ASSETS if a["type"] == "crah"]
N = 150


def run(physics=None):
    rng = random.Random(99)
    rows = []
    for i in range(N):
        kind = rng.choice(["chiller_trip", "chiller_trip", "fan_degradation", "fan_degradation", "grid_loss"])
        asset = {"chiller_trip": rng.choice(["CH-1", "CH-2"]), "fan_degradation": rng.choice(CRAHS),
                 "grid_loss": "UTIL"}[kind]
        sev = round(rng.uniform(0.3, 1.0), 2)
        f = FakeFacility(ASSETS, seed=8000 + i)
        if physics:
            f.physics.update(physics)  # the real building differs from the twin's model
        for _ in range(rng.randint(5, 30)):
            f.step()
        f.inject(kind, asset, sev)
        f.step()
        prev = f.snapshot()
        f.step()
        twin = f.copy()
        twin.physics = dict(NOMINAL_PHYSICS)
        calibrate.apply(twin, calibrate.estimate(prev, f.snapshot()))  # severity from sensors only
        fc = forecast(twin, seed=i)["crit"]
        truth = None
        for m in range(1, 61):
            f.step()
            if max(f.s[r]["inlet_temp_c"] for r in RACKS) >= 32:
                truth = m
                break
        rows.append({"kind": kind, "severity": sev, "forecast": fc, "truth_minute": truth})

    ranged = [r for r in rows if "p10" in r["forecast"] and r["truth_minute"] is not None]
    inside = [r for r in ranged if r["forecast"]["p10"] - 0.5 <= r["truth_minute"] <= r["forecast"]["p90"] + 0.5]
    brier = statistics.mean((r["forecast"]["probability"] - (1 if r["truth_minute"] else 0)) ** 2 for r in rows)
    errs = [abs(r["forecast"]["p50"] - r["truth_minute"]) for r in ranged]
    widths = [r["forecast"]["p90"] - r["forecast"]["p10"] for r in ranged]
    confident = [r for r in rows if r["forecast"]["probability"] >= 0.9]
    unlikely = [r for r in rows if r["forecast"]["probability"] <= 0.1]
    out = {
        "incidents": N,
        "reached_32c_within_hour": sum(1 for r in rows if r["truth_minute"]),
        "forecasts_with_a_range": len(ranged),
        "coverage_of_80pct_range": round(len(inside) / len(ranged), 3) if ranged else None,
        "median_abs_error_of_p50_min": round(statistics.median(errs), 1) if errs else None,
        "median_range_width_min": round(statistics.median(widths), 1) if widths else None,
        "brier_score_within_hour": round(brier, 3),
        "said_90pct_plus": {"count": len(confident), "came_true": sum(1 for r in confident if r["truth_minute"])},
        "said_10pct_or_less": {"count": len(unlikely), "came_true": sum(1 for r in unlikely if r["truth_minute"])},
    }
    return out


def main():
    res = {"physics_matches_twin": run(),
           "real_building_30pct_worse": run({"rack_rate": NOMINAL_PHYSICS["rack_rate"] * 1.3,
                                             "chill_loss": NOMINAL_PHYSICS["chill_loss"] * 1.3})}
    (ROOT / "sim" / "ensemble_results.json").write_text(json.dumps(res, indent=2))
    print(json.dumps(res, indent=2))


if __name__ == "__main__":
    main()
