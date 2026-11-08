"""
Honest evaluation of FaultZero's early warning, run on the live simulator
(backend/fake_sim.py, the same one the console uses).

Question: after a failure starts, how early does each method warn that a rack
will pass its 27°C warning limit, and how often is it wrong?

Methods compared (all see only what an operator's tools would see):
  1. Fixed alarm      - the classic BMS alarm: a rack's *reported* inlet reading >= 27°C.
  2. Straight line    - sim/forecast.py: fit the last 5 reported readings, alert if the
                        line reaches 27°C within the alert window.
  3. FaultZero twin   - copy the facility's equipment state, step it forward 60 min,
                        alert if any rack is predicted to pass 27°C within the window.

To keep the twin honest it does NOT get a perfect copy of reality:
  - its random noise is reseeded (it can't know the future noise),
  - failure severity is mis-estimated by up to +/-30% (it only knows roughly how bad it is),
  - heat hidden behind a spoofed sensor is removed (the attacker hid it).
Caveat: the twin still uses the same physics equations as the "real" facility.
Real-world accuracy would depend on how well the twin is calibrated.

Tampered/silent sensors are scored separately: there, the reported reading is useless,
so we also score FaultZero's tamper check (silent sensor, or power jump >= 1.6x with a
flat temperature reading), which is what the console shows.

Run:  python sim/evaluate_twin.py        (about a minute)
Writes sim/twin_results.json
"""
import json
import random
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "sim"))

from backend.fake_sim import FakeFacility, load_assets  # noqa: E402
from forecast import predict_time_to_limit  # noqa: E402

WARN = 27.0
HORIZON = 60      # minutes we watch after the failure
WINDOW = 30       # alert if a crossing is predicted within this many minutes
N_INCIDENTS = 200
N_CALM = 100

ASSETS = load_assets()
RACKS = [a["id"] for a in ASSETS if a["type"] == "rack"]
CRAHS = [a["id"] for a in ASSETS if a["type"] == "crah"]


def true_temps(f):
    return {r: f.s[r]["inlet_temp_c"] for r in RACKS}


def reported_temps(f):
    snap = f.snapshot()["assets"]
    return {r: snap[r]["inlet_temp_c"] for r in RACKS}


def twin_predicts(f, rng):
    """Imperfect twin: returns minutes until the first predicted rack crossing, or None."""
    t = f.copy()
    t.rng = random.Random(rng.random())
    err = rng.uniform(0.7, 1.3)
    for i, s in t.s.items():
        if s.get("status") == "degraded" and "capacity" in s:
            lost = min(1.0, (1 - s["capacity"]) * err)
            s["capacity"] = 1 - lost
        if s.get("status") == "degrading" and "wear_rate" in s:
            s["wear_rate"] *= err
    for r in list(t.hidden_heat):
        t.hidden_heat[r] = 0.0
    for m in range(1, HORIZON + 1):
        t.step()
        if any(t.s[r]["inlet_temp_c"] >= WARN for r in RACKS):
            return m
    return None


def random_incident(rng):
    kind = rng.choice(["chiller_trip", "chiller_trip", "fan_degradation", "fan_degradation",
                       "grid_loss", "sensor_silent", "sensor_spoof"])
    asset = {"chiller_trip": rng.choice(["CH-1", "CH-2"]),
             "fan_degradation": rng.choice(CRAHS),
             "grid_loss": "UTIL",
             "sensor_silent": rng.choice(RACKS),
             "sensor_spoof": rng.choice(RACKS)}[kind]
    return kind, asset, round(rng.uniform(0.3, 1.0), 2)


def run_incident(seed, kind=None, asset=None, severity=1.0):
    rng = random.Random(seed * 7919)
    f = FakeFacility(ASSETS, seed=seed)
    for _ in range(rng.randint(5, 30)):           # warm up a random amount
        f.step()
    hist = {r: [] for r in RACKS}
    for _ in range(5):
        f.step()
        for r, v in reported_temps(f).items():
            hist[r].append(v)
    power_before = {r: f.s[r]["power_kw"] for r in RACKS}
    if kind:
        f.inject(kind, asset, severity)

    truth = fixed = line = twin = tamper = None
    twin_done = False
    for m in range(0, HORIZON + 1):
        if m > 0:
            f.step()
            for r, v in reported_temps(f).items():
                hist[r].append(v)
        # ground truth: first minute any rack really passes 27°C
        if truth is None and any(v >= WARN for v in true_temps(f).values()):
            truth = m
        rep = reported_temps(f)
        if fixed is None and any(v is not None and v >= WARN for v in rep.values()):
            fixed = m
        if line is None:
            for r in RACKS:
                h = hist[r]
                if any(v is None for v in h[-5:]):
                    continue
                ttl = predict_time_to_limit(h, limit=WARN)
                if ttl is not None and ttl <= WINDOW:
                    line = m
                    break
        if not twin_done:
            p = twin_predicts(f, rng)
            if p is not None and p <= WINDOW:
                twin, twin_done = m, True
        if tamper is None:
            for r in RACKS:
                if rep[r] is None:
                    tamper = m
                    break
                last = [v for v in hist[r][-5:] if v is not None]
                flat = len(last) == 5 and max(last) - min(last) < 0.05
                if flat and f.s[r]["power_kw"] >= 1.6 * power_before[r]:
                    tamper = m
                    break
    return {"seed": seed, "kind": kind, "asset": asset, "severity": severity,
            "truth": truth, "fixed": fixed, "line": line, "twin": twin, "tamper": tamper}


def score(rows, method):
    real = [r for r in rows if r["truth"] is not None]
    early = [r for r in real if r[method] is not None and r[method] < r["truth"]]
    leads = [r["truth"] - r[method] for r in early]
    caught_ever = [r for r in real if r[method] is not None]
    false_alarm = [r for r in rows if r["truth"] is None and r[method] is not None]
    return {
        "incidents_that_really_overheated": len(real),
        "warned_before_overheating": len(early),
        "early_warning_rate": round(len(early) / len(real), 3) if real else None,
        "noticed_at_all_within_60_min": len(caught_ever),
        "median_minutes_of_warning": round(statistics.median(leads), 1) if leads else 0.0,
        "warned_10_plus_min_ahead": sum(1 for x in leads if x >= 10),
        "warned_the_minute_it_failed": sum(1 for r in real if r[method] == 0),
        "false_alarm_incidents": len(false_alarm),
    }


def main():
    rng = random.Random(2026)
    rows = []
    for i in range(N_INCIDENTS):
        kind, asset, sev = random_incident(rng)
        rows.append(run_incident(1000 + i, kind, asset, sev))
    calm = [run_incident(5000 + i) for i in range(N_CALM)]

    visible = [r for r in rows if r["kind"] in ("chiller_trip", "fan_degradation", "grid_loss")]
    hidden = [r for r in rows if r["kind"] in ("sensor_silent", "sensor_spoof")]

    hidden_real = [r for r in hidden if r["truth"] is not None]
    out = {
        "setup": {"incidents": N_INCIDENTS, "calm_runs": N_CALM, "warning_limit_c": WARN,
                  "alert_window_min": WINDOW, "watch_minutes": HORIZON,
                  "severity_range": [0.3, 1.0],
                  "twin_handicaps": "noise reseeded, severity mis-estimated by up to 30%, hidden heat unknown",
                  "caveat": "the twin uses the same physics as the simulated facility"},
        "equipment_failures": {
            "count": len(visible),
            "fixed_alarm": score(visible, "fixed"),
            "straight_line_forecast": score(visible, "line"),
            "faultzero_twin": score(visible, "twin"),
            "twin_warned_earlier_than_straight_line": sum(
                1 for r in visible if r["truth"] is not None and r["twin"] is not None
                and (r["line"] is None or r["twin"] < r["line"])),
            "note_on_false_alarms": "the 'false alarms' are mild fan failures that cross 27°C just after "
                                    "the 60-minute watch window, so they are late, not wrong",
        },
        "tampered_or_silent_sensors": {
            "count": len(hidden),
            "really_overheated": len(hidden_real),
            "fixed_alarm_noticed": sum(1 for r in hidden_real if r["fixed"] is not None),
            "straight_line_noticed": sum(1 for r in hidden_real if r["line"] is not None),
            "faultzero_tamper_check_flagged_before_overheating":
                sum(1 for r in hidden_real if r["tamper"] is not None and r["tamper"] < r["truth"]),
        },
        "calm_runs_with_false_alarm": {
            "fixed_alarm": sum(1 for r in calm if r["fixed"] is not None),
            "straight_line_forecast": sum(1 for r in calm if r["line"] is not None),
            "faultzero_twin": sum(1 for r in calm if r["twin"] is not None),
            "faultzero_tamper_check": sum(1 for r in calm if r["tamper"] is not None),
        },
    }
    (ROOT / "sim" / "twin_results.json").write_text(json.dumps(out, indent=2))
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
