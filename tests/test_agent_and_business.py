"""Agent plans are verified by the twin; business rules turn them into money and work orders."""
from backend.agent import AgentRun, baseline
from backend.fake_sim import FakeFacility, load_assets
from business.impact import calculate_impact

ASSETS = load_assets()


def incident():
    f = FakeFacility(ASSETS, seed=7)
    for _ in range(5):
        f.step()
    f.inject("chiller_trip", "CH-2")
    return f


def test_baseline_counts_racks_and_dollars():
    b = baseline(incident())
    assert b["racks_at_risk"] >= 6
    assert b["usd_at_risk"] > 0


def test_scripted_agent_finds_a_plan_that_saves_every_rack():
    run = AgentRun(incident())
    run.pace = 0
    run.run()
    st = run.state
    assert st["status"] == "done" and st["plans"]
    best = st["plans"][0]["outcome"]
    assert best["racks_at_risk"] == 0
    assert best["usd_at_risk"] <= st["baseline"]["usd_at_risk"]


def test_plans_are_ranked_by_verified_outcome():
    run = AgentRun(incident())
    run.pace = 0
    run.run()
    racks = [p["outcome"]["racks_at_risk"] for p in run.state["plans"]]
    assert racks == sorted(racks)


def test_agent_does_not_touch_the_real_facility():
    f = incident()
    before = f.snapshot()
    run = AgentRun(f)
    run.pace = 0
    run.run()
    assert f.snapshot() == before


def test_impact_is_zero_when_everything_is_cool():
    f = FakeFacility(ASSETS, seed=7)
    f.step()
    assert calculate_impact(f.snapshot())["estimated_exposure_usd"] == 0
