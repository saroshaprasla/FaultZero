
"""FaultZero simulated maintenance dispatch and work-order management."""

import json
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DECISIONS_FILE = DATA_DIR / "workorders.jsonl"

TECHNICIANS = [
    {"id": "TECH-01", "name": "Alex", "skill": "mechanical", "on_shift": True},
    {"id": "TECH-02", "name": "Jordan", "skill": "mechanical", "on_shift": True},
    {"id": "TECH-03", "name": "Sam", "skill": "electrical", "on_shift": True},
    {"id": "TECH-04", "name": "Taylor", "skill": "electrical", "on_shift": True},
    {"id": "TECH-05", "name": "Casey", "skill": "controls", "on_shift": True},
    {"id": "TECH-06", "name": "Morgan", "skill": "controls", "on_shift": True},
    {"id": "TECH-07", "name": "Riley", "skill": "mechanical", "on_shift": False},
    {"id": "TECH-08", "name": "Jamie", "skill": "electrical", "on_shift": False},
]

SPARE_PARTS = {
    "fan_motor": {"quantity": 3, "location": "Storage A"},
    "compressor_part": {"quantity": 2, "location": "Storage B"},
    "ups_battery": {"quantity": 4, "location": "Storage C"},
}

WORK_ORDERS = []


def get_asset_history(asset):
    """Return work orders for an asset in this simulation session."""
    return [order for order in WORK_ORDERS if order["asset"] == asset]



def create_work_order(plan: dict, agent_state: dict) -> dict:
    """Create a simulated work order for an approved recovery plan."""
    try:
        if not isinstance(plan, dict):
            raise ValueError("plan must be a dictionary")

        if not isinstance(agent_state, dict):
            raise ValueError("agent_state must be a dictionary")

        actions = plan.get("actions", [])
        if not isinstance(actions, list):
            actions = []

        first_action = actions[0] if actions and isinstance(actions[0], dict) else {}

        action = str(
            first_action.get("action")
            or plan.get("action")
            or plan.get("name")
            or "inspect"
        ).lower()

        asset = str(
            first_action.get("asset")
            or plan.get("asset")
            or "unknown"
        )

        if any(word in action for word in ("fan", "cool", "chiller")):
            skill = "mechanical"
            part = "compressor_part" if "chiller" in action else "fan_motor"
        elif any(word in action for word in ("ups", "power", "generator")):
            skill, part = "electrical", "ups_battery"
        else:
            skill, part = "controls", None

        technician = next(
            (t for t in TECHNICIANS if t["on_shift"] and t["skill"] == skill),
            None,
        )

        available = part is None or SPARE_PARTS[part]["quantity"] > 0
        status = "assigned" if technician and available else "pending_resources"

        if status == "assigned" and part is not None:
            SPARE_PARTS[part]["quantity"] -= 1

        created = datetime.now(timezone.utc).isoformat()

        order = {
            "id": f"WO-{uuid4().hex[:8].upper()}",
            "priority": plan.get("priority", "high"),
            "team": skill,
            "title": str(plan.get("name") or action),
            "steps": actions or [{"action": action, "asset": asset}],
            "created": created,
            "created_at": created,
            "asset": asset,
            "action": action,
            "technician": technician["id"] if technician else None,
            "required_skill": skill,
            "reserved_part": part if status == "assigned" else None,
            "spare_location": (
                SPARE_PARTS[part]["location"]
                if part and status == "assigned"
                else None
            ),
            "eta_minutes": 30 if status == "assigned" else None,
            "status": status,
            "simulated": True,
        }

        DATA_DIR.mkdir(parents=True, exist_ok=True)

        with DECISIONS_FILE.open("a", encoding="utf-8") as file:
            file.write(json.dumps(order) + "\n")

        WORK_ORDERS.append(order)
        return order

    except Exception as exc:
        return {
            "id": None,
            "priority": "unknown",
            "team": "unassigned",
            "title": "Dispatch unavailable",
            "steps": [],
            "created": datetime.now(timezone.utc).isoformat(),
            "status": "error",
            "error": str(exc),
            "simulated": True,
        }


if __name__ == "__main__":
    example = create_work_order(
        {
            "name": "Repair Chiller 2",
            "actions": [
                {"action": "repair chiller", "asset": "CH-2"}
            ],
            "priority": "critical",
        },
        {"status": "completed", "plans": []},
    )
    print(json.dumps(example, indent=2))
