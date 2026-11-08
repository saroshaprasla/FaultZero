"""The self-calibrating twin recovers hidden failure severity from readings alone."""
import pytest

from backend import calibrate
from backend.fake_sim import FakeFacility, load_assets

ASSETS = load_assets()


@pytest.mark.parametrize("severity", [0.3, 0.5, 0.75, 0.9])
def test_estimates_chiller_capacity(severity):
    f = FakeFacility(ASSETS, seed=3)
    for _ in range(5):
        f.step()
    f.inject("chiller_trip", "CH-2", severity=severity)
    f.step()
    prev = f.snapshot()
    f.step()
    est = calibrate.estimate(prev, f.snapshot())["CH-2"]
    assert est["param"] == "capacity" and est["readings"] == 2
    assert est["estimate"] == pytest.approx(1 - severity, abs=0.05)


def test_estimates_fan_wear():
    f = FakeFacility(ASSETS, seed=3)
    f.inject("fan_degradation", "CRAH-4", severity=0.6)
    f.step()
    prev = f.snapshot()
    f.step()
    est = calibrate.estimate(prev, f.snapshot())["CRAH-4"]
    assert est["estimate"] == pytest.approx(2.5 * 0.6, abs=0.02)


def test_uses_a_cautious_prior_without_evidence():
    f = FakeFacility(ASSETS, seed=3)
    f.inject("chiller_trip", "CH-1", severity=0.4)
    est = calibrate.estimate(None, f.snapshot())["CH-1"]
    assert est["readings"] == 0 and est["estimate"] == calibrate.PRIOR_CAPACITY


def test_calm_facility_needs_no_calibration():
    f = FakeFacility(ASSETS, seed=3)
    f.step()
    prev = f.snapshot()
    f.step()
    assert calibrate.estimate(prev, f.snapshot()) == {}
