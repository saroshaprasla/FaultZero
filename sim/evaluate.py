
import json
from pathlib import Path

import joblib
import numpy as np
import matplotlib.pyplot as plt

from sim.simulator import Facility, load_assets

ROOT = Path(__file__).resolve().parent.parent
assets = load_assets()
saved = joblib.load(ROOT / "sim/model.joblib")
model = saved["model"]
features = saved["features"]

LIMIT = 32.0
WARNING_HORIZON = 15

# (failure type, affected equipment, rack to monitor)
scenarios = [
    ("chiller_trip", "CH-1", "RACK-A3"),
    ("chiller_trip", "CH-2", "RACK-C3"),
    ("fan_degradation", "CRAH-1", "RACK-A3"),
    ("fan_degradation", "CRAH-5", "RACK-D3"),
    ("grid_loss", "UTIL", "RACK-C3"),
    ("normal", None, "RACK-C3"),
]

def predict(history, rack):
    if len(history) < 11:
        return None

    state = history[-1]
    current = state["assets"][rack]["inlet_temp_c"]

    if current is None or current >= LIMIT:
        return None

    previous_5 = history[-6]["assets"][rack]["inlet_temp_c"]
    previous_10 = history[-11]["assets"][rack]["inlet_temp_c"]

    values = {
        "current_temp": current,
        "delta_5": current - previous_5,
        "delta_10": current - previous_10,
        "power_kw": state["assets"][rack]["power_kw"],
        "outdoor_temp": state["outdoor_temp_c"],
        "chiller_tripped": int(
            state["assets"]["CH-2"]["status"] == "tripped"
        ),
        "fan_degrading": int(
            state["assets"]["CRAH-4"]["status"] == "degrading"
        ),
        "grid_down": int(
            state["assets"]["UTIL"]["status"] == "down"
        ),
    }

    import pandas as pd
    X = pd.DataFrame([values])[features]

    ml_eta = float(np.clip(model.predict(X)[0], 0, 60))

    slope = (current - previous_5) / 5
    linear_eta = (
        float(np.clip((LIMIT-current)/slope, 0, 60))
        if slope > 0 else 60.0
    )

    return ml_eta, linear_eta


results = []
N = 200

for incident_id in range(N):
    kind, asset, rack = scenarios[incident_id % len(scenarios)]

    facility = Facility(assets, seed=10000 + incident_id)

    for _ in range(30):
        facility.step()

    if kind != "normal":
        facility.inject(kind, asset)

    history = []
    ml_alerts = []
    linear_alerts = []
    crossing = None

    for minute in range(1, 121):
        state = facility.step()
        history.append(state)

        temp = state["assets"][rack]["inlet_temp_c"]

        if temp is not None and temp >= LIMIT:
            if crossing is None:
                crossing = minute
            continue

        prediction = predict(history, rack)

        if prediction is None:
            continue

        ml_eta, linear_eta = prediction

        if ml_eta <= WARNING_HORIZON:
            ml_alerts.append(minute)

        if linear_eta <= WARNING_HORIZON:
            linear_alerts.append(minute)

    def warning_lead(alerts):
        if crossing is None:
            return None

        # Count only warnings within the 15-minute horizon
        valid = [
            crossing - a for a in alerts
            if 0 < crossing - a <= WARNING_HORIZON
        ]
        return max(valid) if valid else None

    results.append({
        "incident_id": incident_id,
        "kind": kind,
        "asset": asset,
        "rack": rack,
        "crossed": crossing is not None,
        "crossing_minute": crossing,
        "ml_warning_min": warning_lead(ml_alerts),
        "linear_warning_min": warning_lead(linear_alerts),
        "ml_false_alert": crossing is None and bool(ml_alerts),
        "linear_false_alert": crossing is None and bool(linear_alerts),
    })

crossings = [r for r in results if r["crossed"]]
ml_detected = [r["ml_warning_min"] for r in crossings
               if r["ml_warning_min"] is not None]
linear_detected = [r["linear_warning_min"] for r in crossings
                   if r["linear_warning_min"] is not None]

summary = {
    "incidents": N,
    "actual_crossings": len(crossings),
    "ml_detected_early": len(ml_detected),
    "linear_detected_early": len(linear_detected),
    "ml_detection_rate": (
        len(ml_detected)/len(crossings) if crossings else None
    ),
    "linear_detection_rate": (
        len(linear_detected)/len(crossings) if crossings else None
    ),
    "ml_median_warning_min": (
        float(np.median(ml_detected)) if ml_detected else None
    ),
    "linear_median_warning_min": (
        float(np.median(linear_detected)) if linear_detected else None
    ),
    "ml_false_alert_incidents": sum(
        r["ml_false_alert"] for r in results
    ),
    "linear_false_alert_incidents": sum(
        r["linear_false_alert"] for r in results
    ),
}

(ROOT / "sim/results.json").write_text(
    json.dumps(summary, indent=2)
)

print(json.dumps(summary, indent=2))

# Comparison chart
labels = ["Fixed threshold", "Linear", "ML"]

values = [
    0,
    summary["linear_median_warning_min"] or 0,
    summary["ml_median_warning_min"] or 0,
]

plt.figure(figsize=(8, 4))
plt.bar(labels, values)
plt.ylabel("Median advance warning (minutes)")
plt.title("FaultZero: Warning Lead Time on Simulated Incidents")
plt.savefig(
    ROOT / "plots/evaluation.png",
    dpi=200,
    bbox_inches="tight"
)
plt.show()

print("Saved: sim/results.json")
print("Saved: plots/evaluation.png")
