# FaultZero data formats

Everyone builds against these formats. If you need to change one, post in the group first.

## 1. Facility layout: `data/assets.json` (Binitha owns)

```json
{"id": "CH-2", "type": "chiller", "name": "Chiller 2",
 "feeds": ["CRAH-4", "CRAH-5", "CRAH-6"],
 "limit": {"metric": "supply_temp_c", "max": 15},
 "x": 0, "y": 6}
```

- `type`: utility, generator, ups, pdu, chiller, crah, rack
- `feeds`: the assets that depend on this one (power or cooling)
- `limit`: the metric we watch, with `max` (or `min` for UPS battery). Racks also have `warn`.
- `x`, `y`: grid position for the floor map

## 2. Simulator output, one per simulated minute (Binitha → Sarosha)

```json
{"t": "2026-08-14T21:05:00", "minute": 5, "outdoor_temp_c": 31.2,
 "assets": {
   "CH-2":   {"status": "ok", "load_pct": 72.0, "supply_temp_c": 7.1},
   "CRAH-4": {"status": "ok", "fan_pct": 70.0, "supply_air_c": 18.2},
   "UPS-A":  {"status": "ok", "on_battery": false, "battery_min": 12.0, "load_kw": 104.3},
   "PDU-3":  {"status": "ok", "load_pct": 66.0},
   "RACK-C3": {"status": "ok", "power_kw": 9.8, "inlet_temp_c": 24.5}
 },
 "events": [{"minute": 3, "type": "failure", "kind": "chiller_trip", "asset": "CH-2"}]}
```

- `inlet_temp_c` is `null` when a sensor is silent.
- A spoofed sensor reports a normal-looking value. Only the true physics knows it's wrong.

## 3. Simulator functions (Binitha → Sarosha)

- `step()` → one simulated minute, returns the output above
- `inject(kind, asset)` → kinds: `chiller_trip`, `fan_degradation`, `grid_loss`, `sensor_silent`, `sensor_spoof`
- `apply(action, asset)` → actions: `start_backup_chiller`, `raise_fan_speed`, `start_generator`, `shift_load`
- `copy()` → independent copy for running "what if" futures

`backend/fake_sim.py` already follows this, so use it as the reference.

## 4. Tenant record (Naomi → Sarosha)

```json
{"tenant": "Northwind Bank", "racks": ["RACK-C1", "RACK-C2"],
 "sla_penalty_per_min": 1200, "tier": "critical"}
```

## 5. Live API (Sarosha)

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/api/assets` | Facility layout |
| GET | `/api/state` | Latest snapshot |
| GET | `/api/stream` | Live snapshots (Server-Sent Events), 1 per second |
| POST | `/api/inject` | `{"kind": "chiller_trip", "asset": "CH-2"}` (asset optional) |
| POST | `/api/action` | `{"action": "start_backup_chiller"}` |
| POST | `/api/reset` | Fresh facility |
| GET | `/break` | Naomi's phone page (`phone/index.html`) |

## Folders

- `backend/`: Sarosha (server, cascade engine, agent)
- `sim/`: Binitha (simulator, forecaster, evaluation)
- `business/`: Naomi (impact, dispatch, handoff)
- `phone/`: Naomi (phone page)
- `frontend/`: Sarosha (main UI)
- `data/`: shared data files

Stay in your own folder to avoid merge conflicts. Always `git pull` before you start and before you push.

## 6. Cascade engine (Sarosha)

When anything has failed, the backend copies the facility and runs it 60 minutes ahead (`backend/cascade.py`).

- Every snapshot from `/api/stream` now also has `cascade` (the predicted chain) and `roots` (what broke).
- `GET /api/cascade` → `{"roots": ["CH-2"], "chain": [{"id": "CRAH-4", "level": "high", "minutes": 8, "text": "Cooling unit 4 air out passes 24°C", "because": "because Chiller 2 tripped", "path": ["CH-2", "CRAH-4"]}]}`
- `GET /api/future` → `{"from_minute": 12, "frames": [{"in": 1, "assets": {...}}, ...]}` one frame per future minute (for the time scrubber).

Binitha: the projection works with any simulator that has `copy()`, `step()`, `assets`, `s`, `fed_by` and `events`, like `fake_sim.py`.
