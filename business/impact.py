
"""FaultZero business impact estimates for simulated facility snapshots."""

from typing import Any

DEFAULT_COST_PER_RACK_HOUR = 1000.0
WARNING_TEMP_C = 27.0
CRITICAL_TEMP_C = 32.0


def calculate_impact(
    snapshot: dict[str, Any],
    cost_per_rack_hour: float = DEFAULT_COST_PER_RACK_HOUR,
    exposure_hours: float = 1.0,
) -> dict[str, Any]:
    """Estimate rack risk and illustrative financial exposure.

    This is a scenario estimate, not an actual downtime loss.
    """
    if cost_per_rack_hour < 0 or exposure_hours < 0:
        raise ValueError("Cost and exposure hours must be non-negative")

    assets = snapshot.get("assets", {})
    racks = {
        asset_id: state
        for asset_id, state in assets.items()
        if asset_id.startswith("RACK-")
    }

    warning = []
    critical = []
    offline = []
    unknown = []

    for rack_id, state in racks.items():
        status = state.get("status", "unknown")
        temp = state.get("inlet_temp_c")

        if status == "offline":
            offline.append(rack_id)
        elif status == "critical":
            critical.append(rack_id)
        elif status == "warning":
            warning.append(rack_id)
        elif temp is None:
            unknown.append(rack_id)
        elif temp >= CRITICAL_TEMP_C:
            critical.append(rack_id)
        elif temp >= WARNING_TEMP_C:
            warning.append(rack_id)

    affected = sorted(set(warning + critical + offline))

    if offline or critical:
        severity = "critical"
    elif warning:
        severity = "high"
    elif unknown:
        severity = "unknown"
    else:
        severity = "low"

    estimated_exposure = (
        len(affected) * cost_per_rack_hour * exposure_hours
    )

    return {
        "facility": "FaultZero Data Hall 1",
        "simulated": True,
        "minute": snapshot.get("minute", 0),
        "total_racks": len(racks),
        "affected_racks": len(affected),
        "warning_racks": warning,
        "critical_racks": critical,
        "offline_racks": offline,
        "unknown_sensor_racks": unknown,
        "severity": severity,
        "estimated_exposure_usd": round(estimated_exposure, 2),
        "cost_per_rack_hour_usd": cost_per_rack_hour,
        "exposure_hours": exposure_hours,
        "disclaimer": (
            "Illustrative exposure based on current rack conditions. "
            "Not a forecast or verified financial loss."
        ),
    }
