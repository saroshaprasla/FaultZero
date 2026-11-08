
"""FaultZero simulated shift-handoff summaries."""

import json
from datetime import datetime, timezone
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DECISIONS_FILE = DATA_DIR / "decisions.jsonl"


def read_work_orders():
    """Read simulated dispatch decisions from the JSONL log."""
    if not DECISIONS_FILE.exists():
        return []

    orders = []
    with DECISIONS_FILE.open("r", encoding="utf-8") as file:
        for line in file:
            if not line.strip():
                continue
            try:
                orders.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return orders


def generate_handoff(incidents=None, agent_findings=None):
    """Generate a shift brief from incident and dispatch records."""
    incidents = incidents or []
    agent_findings = agent_findings or []
    orders = read_work_orders()

    open_orders = [
        order for order in orders
        if order.get("status") not in ("completed", "cancelled")
    ]

    timeline = []

    for incident in incidents:
        timeline.append({
            "time": incident.get("time", ""),
            "type": "incident",
            "description": incident.get("description", ""),
            "asset": incident.get("asset"),
        })

    for order in orders:
        timeline.append({
            "time": order.get("created_at", ""),
            "type": "work_order",
            "description": (
                f"{order.get('action', 'Inspect')} "
                f"on {order.get('asset', 'unknown asset')}"
            ),
            "asset": order.get("asset"),
            "status": order.get("status"),
        })

    timeline.sort(key=lambda event: event["time"])

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "facility": "FaultZero simulated data center",
        "incident_count": len(incidents),
        "work_order_count": len(orders),
        "open_work_orders": open_orders,
        "agent_findings": agent_findings,
        "timeline": timeline,
        "summary": (
            f"{len(incidents)} incident(s) recorded. "
            f"{len(open_orders)} work order(s) still open."
        ),
        "simulated": True,
    }


if __name__ == "__main__":
    example = generate_handoff(
        incidents=[
            {
                "time": datetime.now(timezone.utc).isoformat(),
                "asset": "CH-2",
                "description": "Chiller 2 tripped during simulation",
            }
        ],
        agent_findings=[
            "Cooling capacity reduced; inspect CH-2."
        ],
    )
    print(json.dumps(example, indent=2))
