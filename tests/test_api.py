"""The live server: end to end through the HTTP API."""
import time

from fastapi.testclient import TestClient

from backend.main import app


def wait_for_plans(client, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        ag = client.get("/api/state").json().get("agent")
        if ag and ag.get("status") == "done" and ag.get("plans"):
            return ag
        time.sleep(0.3)
    raise AssertionError("agent never finished")


def test_pages_load():
    with TestClient(app) as c:
        for path in ("/", "/control", "/break"):
            assert c.get(path).status_code == 200


def test_break_predict_approve_flow():
    with TestClient(app) as c:
        assert c.post("/api/reset").json()["ok"]
        assert c.post("/api/inject", json={"kind": "chiller_trip", "asset": "CH-2"}).status_code == 200
        ag = wait_for_plans(c)
        assert ag["plans"][0]["outcome"]["racks_at_risk"] == 0
        approved = c.post("/api/agent/approve", json={"index": 0}).json()
        assert approved["decision"] == "approved"
        handoff = c.get("/api/handoff").json()
        assert handoff


def test_unknown_failure_is_rejected():
    with TestClient(app) as c:
        assert c.post("/api/inject", json={"kind": "meteor", "asset": "CH-2"}).status_code == 400


def test_qr_points_to_the_public_domain():
    with TestClient(app) as c:
        assert c.get("/api/qr").json()["url"] == "https://faultzero.test/break"


def test_history_is_optional():
    with TestClient(app) as c:
        assert c.get("/api/tiger").json()["enabled"] is False
        assert c.get("/api/history", params={"asset": "RACK-C3"}).json() == {"enabled": False}
        assert c.get("/api/history", params={"asset": "NOPE"}).status_code == 404
