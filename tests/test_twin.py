"""The facility model, the digital twin and the cascade engine."""
from backend.cascade import project
from backend.fake_sim import FakeFacility, load_assets

ASSETS = load_assets()
RACKS = [a["id"] for a in ASSETS if a["type"] == "rack"]


def warmed(seed=7, minutes=5):
    f = FakeFacility(ASSETS, seed=seed)
    for _ in range(minutes):
        f.step()
    return f


def test_same_seed_same_world():
    a, b = warmed(seed=11, minutes=20), warmed(seed=11, minutes=20)
    assert a.snapshot()["assets"] == b.snapshot()["assets"]


def test_calm_facility_predicts_nothing():
    res = project(warmed())
    assert not [c for c in res["chain"] if c["id"] in RACKS]


def test_chiller_trip_predicts_overheating_racks():
    f = warmed()
    f.inject("chiller_trip", "CH-2")
    res = project(f)
    racks = {c["id"] for c in res["chain"] if c["id"] in RACKS}
    assert len(racks) >= 6
    assert len(res["frames"]) >= 60


def test_predictions_name_the_root_cause():
    f = warmed()
    f.inject("chiller_trip", "CH-2")
    res = project(f)
    assert "CH-2" in res["roots"]
    rack_events = [c for c in res["chain"] if c["id"] in RACKS]
    assert all("Chiller 2" in c["because"] for c in rack_events)


def test_projection_does_not_change_the_real_facility():
    f = warmed()
    f.inject("chiller_trip", "CH-2")
    before = f.snapshot()
    project(f)
    assert f.snapshot() == before


def test_twin_prediction_comes_true():
    """What the twin predicts at minute 0 actually happens in the facility."""
    f = warmed()
    f.inject("chiller_trip", "CH-2")
    predicted = {c["id"] for c in project(f)["chain"] if c["id"] in RACKS and c["level"] in ("warning", "critical")}
    for _ in range(60):
        f.step()
    hot = {r for r in RACKS if f.s[r]["inlet_temp_c"] >= 27}
    assert predicted and len(predicted & hot) / len(predicted) >= 0.9


def test_backup_chiller_stops_the_chain():
    f = warmed()
    f.inject("chiller_trip", "CH-2")
    f.apply("start_backup_chiller")
    for _ in range(60):
        f.step()
    assert max(f.s[r]["inlet_temp_c"] for r in RACKS) < 27


def test_spoofed_sensor_hides_heat_from_the_snapshot():
    f = warmed()
    f.inject("sensor_spoof", "RACK-C4")
    for _ in range(30):
        f.step()
    shown = f.snapshot()["assets"]["RACK-C4"]
    assert shown["status"] == "ok"
    assert f.s["RACK-C4"]["inlet_temp_c"] > shown["inlet_temp_c"] + 2


def test_silent_sensor_reports_nothing():
    f = warmed()
    f.inject("sensor_silent", "RACK-C3")
    f.step()
    assert f.snapshot()["assets"]["RACK-C3"]["inlet_temp_c"] is None


def test_severity_controls_how_bad_it_gets():
    def peak(sev):
        f = warmed()
        f.inject("chiller_trip", "CH-2", severity=sev)
        for _ in range(45):
            f.step()
        return max(f.s[r]["inlet_temp_c"] for r in RACKS)
    assert peak(0.3) < peak(0.7) < peak(1.0)
