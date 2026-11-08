"""
Agent benchmark: does Nemotron add value over a fixed playbook?

The same incidents are handled three ways:
  1. Do nothing               - the twin's baseline
  2. Scripted planner         - a fixed playbook using the same tools
  3. NVIDIA Nemotron agent    - plans its own investigation with tool calls

Every plan is re-simulated by the digital twin, so all numbers are verified outcomes,
never the model's own claims. Half the incidents are compound (two failures at once),
where a fixed playbook is most likely to miss the right combination.

Run on a machine with NVIDIA_API_KEY set (in .env):
    python sim/agent_benchmark.py            # 16 incidents, about 5 minutes
    python sim/agent_benchmark.py --n 8      # quicker
Writes sim/agent_benchmark_results.json
"""
import argparse
import json
import os
import random
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

try:
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env")
except Exception:
    pass

from backend.agent import AgentRun  # noqa: E402
from backend.fake_sim import FakeFacility, load_assets  # noqa: E402

ASSETS = load_assets()
RACKS = [a["id"] for a in ASSETS if a["type"] == "rack"]
CRAHS = [a["id"] for a in ASSETS if a["type"] == "crah"]


def make_incident(rng, compound):
    singles = [
        lambda: ("chiller_trip", rng.choice(["CH-1", "CH-2"]), round(rng.uniform(0.6, 1.0), 2)),
        lambda: ("fan_degradation", rng.choice(CRAHS), round(rng.uniform(0.6, 1.0), 2)),
        lambda: ("grid_loss", "UTIL", 1.0),
        lambda: ("sensor_spoof", rng.choice(RACKS), round(rng.uniform(0.6, 1.0), 2)),
    ]
    picks = rng.sample(singles, 2) if compound else [rng.choice(singles[:3])]
    return [p() for p in picks]


def build(seed, failures):
    f = FakeFacility(ASSETS, seed=seed)
    for _ in range(5):
        f.step()
    for kind, asset, sev in failures:
        f.inject(kind, asset, sev)
    return f


def run_agent(facility, use_nemotron):
    run = AgentRun(facility)
    t0 = time.time()
    if use_nemotron:
        ok = run.run_nemotron()
        if not ok:  # record the failure, then finish the way the product would
            run.state["plans"] = []
            run.run_scripted()
            source = "nemotron_fell_back"
        else:
            source = "nemotron"
    else:
        run.run_scripted()
        source = "scripted"
    best = run.state["plans"][0]["outcome"] if run.state["plans"] else None
    return {
        "source": source,
        "seconds": round(time.time() - t0, 1),
        "plans_tested_in_twin": sum(1 for s in run.state["steps"] if s["kind"] == "sim"),
        "tool_calls": sum(1 for s in run.state["steps"] if s["kind"] in ("tool", "sim")),
        "best_plan": run.state["plans"][0]["name"] if run.state["plans"] else None,
        "racks_at_risk": best["racks_at_risk"] if best else None,
        "rack_minutes_over_27c": best["rack_minutes_over_27c"] if best else None,
        "usd_at_risk": best.get("usd_at_risk") if best else None,
    }


def summarize(rows, key):
    got = [r[key] for r in rows if r[key]["racks_at_risk"] is not None]
    if not got:
        return {}
    return {
        "incidents": len(got),
        "all_racks_saved": sum(1 for g in got if g["racks_at_risk"] == 0),
        "mean_racks_at_risk": round(statistics.mean(g["racks_at_risk"] for g in got), 2),
        "mean_rack_minutes_over_27c": round(statistics.mean(g["rack_minutes_over_27c"] for g in got), 1),
        "total_usd_at_risk": sum(g["usd_at_risk"] or 0 for g in got),
        "median_seconds": statistics.median(g["seconds"] for g in got),
        "mean_plans_tested": round(statistics.mean(g["plans_tested_in_twin"] for g in got), 1),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=16)
    ap.add_argument("--pause", type=float, default=3.0, help="seconds between incidents (API rate limit)")
    args = ap.parse_args()
    if not os.environ.get("NVIDIA_API_KEY"):
        print("NVIDIA_API_KEY is not set. Add it to .env and run again.")
        sys.exit(1)

    rng = random.Random(42)
    rows = []
    for i in range(args.n):
        compound = i % 2 == 1
        failures = make_incident(rng, compound)
        seed = 7000 + i
        base = AgentRun(build(seed, failures)).base
        scripted = run_agent(build(seed, failures), use_nemotron=False)
        nemo = run_agent(build(seed, failures), use_nemotron=True)
        row = {"seed": seed, "compound": compound,
               "failures": [{"kind": k, "asset": a, "severity": s} for k, a, s in failures],
               "do_nothing": {"racks_at_risk": base["racks_at_risk"], "usd_at_risk": base.get("usd_at_risk"),
                              "rack_minutes_over_27c": base["rack_minutes_over_27c"]},
               "scripted": scripted, "nemotron": nemo}
        rows.append(row)
        label = " + ".join(f'{k}:{a}' for k, a, _ in failures)
        print(f"[{i + 1:2d}/{args.n}] {label:40s} nothing {base['racks_at_risk']:2d} racks | "
              f"scripted {scripted['racks_at_risk']} | nemotron {nemo['racks_at_risk']} ({nemo['source']}, "
              f"{nemo['plans_tested_in_twin']} plans tested, {nemo['seconds']}s)", flush=True)
        time.sleep(args.pause)

    def compare(subset):
        both = [r for r in subset if r["nemotron"]["source"] == "nemotron"
                and r["nemotron"]["racks_at_risk"] is not None and r["scripted"]["racks_at_risk"] is not None]
        key = lambda o: (o["racks_at_risk"], o["rack_minutes_over_27c"])  # noqa: E731
        return {
            "nemotron_answered_itself": len(both),
            "nemotron_better": sum(1 for r in both if key(r["nemotron"]) < key(r["scripted"])),
            "tie": sum(1 for r in both if key(r["nemotron"]) == key(r["scripted"])),
            "scripted_better": sum(1 for r in both if key(r["nemotron"]) > key(r["scripted"])),
        }

    out = {
        "incidents": len(rows),
        "note": "every plan is re-simulated by the twin; numbers are verified outcomes",
        "do_nothing": {"mean_racks_at_risk": round(statistics.mean(r["do_nothing"]["racks_at_risk"] for r in rows), 2),
                       "total_usd_at_risk": sum(r["do_nothing"]["usd_at_risk"] or 0 for r in rows)},
        "scripted": summarize(rows, "scripted"),
        "nemotron": summarize(rows, "nemotron"),
        "nemotron_fell_back": sum(1 for r in rows if r["nemotron"]["source"] != "nemotron"),
        "head_to_head_all": compare(rows),
        "head_to_head_compound": compare([r for r in rows if r["compound"]]),
        "rows": rows,
    }
    (ROOT / "sim" / "agent_benchmark_results.json").write_text(json.dumps(out, indent=2))
    print("\nSUMMARY")
    print(json.dumps({k: v for k, v in out.items() if k != "rows"}, indent=2))


if __name__ == "__main__":
    main()
