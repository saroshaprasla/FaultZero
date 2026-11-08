# FaultZero

**See the chain before it breaks.** FaultZero predicts how a data center failure will spread over the next hour, tests fixes in a live digital twin, and lets an operator approve the one that works.

HackUTD 2026: Zero Day · Tracks: NMC², CBRE, NVIDIA, HackUTD Design

Team: Sarosha, Binitha, Naomi

**Live app:** coming soon

Demo video: coming soon · Devpost: coming soon

| ⏱ 12 min | 🚨 141 / 141 | 🛡 15 / 15 | 💰 $10,200 → $0 | ⚡ ~9 ms |
| :---: | :---: | :---: | :---: | :---: |
| median head start over the facility alarm | overheating incidents warned in advance (alarm: 0) | hidden sensor attacks caught (alarm: 0) | exposure removed by one approved fix | to simulate the next 60 minutes |

---

## Why we built this

Data center outages are expensive and getting more so. In Uptime Institute's latest outage analysis, **57% of operators said their most recent major outage cost more than $100,000, and 1 in 5 said it cost over $1 million** ([Uptime Institute, 2026](https://www.businesswire.com/news/home/20260513289344/en/Uptime-Announces-Annual-Outage-Analysis-Report-2026)). **Power and cooling problems caused about two-thirds of impactful outages** (54% power, 13% cooling) ([DCD, 2024](https://www.datacenterdynamics.com/en/news/uptime-institute-outages-in-2024-less-frequent-and-severe-but-more-expensive/)).

Most of these outages aren't one failure. They're a chain: a chiller trips, cooling units warm up, racks overheat. The alarm fires only after a temperature limit is crossed, so the operator is always reacting. We wanted to give operators a head start.

## What it does

1. Watches a live data hall: utility power, generator, UPS, PDUs, chillers, cooling units and 24 server racks
2. The moment something fails, a **digital twin** plays the next 60 minutes forward and shows what fails next, when, and why
3. An **NVIDIA Nemotron agent** investigates the incident and tests fixes in the twin
4. Every proposed plan is **re-verified by the twin** before an operator sees it: racks saved and illustrative dollars at risk
5. The operator **approves or dismisses**; an approval creates a work order with a team, technician, ETA and spare part
6. A **time scrubber** plays the next hour with or without the fix
7. A **tamper check** catches sensors that were hacked to hide a hot rack
8. **End shift** writes a handoff for the next operator
9. Judges can **break it from their phone** with a QR code

## How it works

```
facility simulator -> digital twin (next 60 min) -> cascade + root cause -> control room
                                  |
                       Nemotron agent -> plans -> twin re-verifies -> operator approves -> work order
```

## Pages

| Page | Path | What it is |
| --- | --- | --- |
| Story | `/` | Scroll-driven intro: one night in a data hall going wrong |
| Control room | `/control` | 3D twin, cascade timeline, agent plans, time scrubber, shift handoff |
| Break my data center | `/break` | Phone page from the QR code that injects failures |

## The simulated facility

| Part | Count | Fails as |
| --- | --- | --- |
| Utility feed + backup generator | 1 + 1 | Grid loss |
| UPS units, PDUs | 2, 4 | Battery runs out when the grid and generator are down |
| Chillers | 3 (1 standby) | Trip, or partial loss of capacity |
| Cooling units (CRAH) | 6 | Fan wearing out |
| Server racks | 24 (rows A to D) | Overheat above 27°C (warning) and 32°C (critical) |
| Rack sensors | 24 | Go silent, or get spoofed to hide heat |

Failures have an adjustable **severity** (30% to 100%). Operators can start the backup chiller, raise fan speeds, start the generator, shift load off a row, or isolate a rack.

## The AI

| Part | What it does | Why it's trustworthy |
| --- | --- | --- |
| Digital twin | Copies the facility and steps it 60 minutes ahead | Reads the cause (broken equipment), not just rising temperatures |
| Cascade engine | Records the first limit crossing per asset and walks the dependency graph for the root cause | Every prediction says *because X failed* |
| NVIDIA Nemotron agent | Uses 6 tools: incident, forecast, asset, mitigations, simulate plan, submit plans | Never reports its own numbers; every plan is re-simulated and ranked by the twin |
| Scripted planner | Runs the same tools if the NVIDIA API is unreachable | The demo never breaks |

## Results

200 random failures (random equipment, severity 30% to 100%). We compared three ways of warning an operator. To keep the twin honest, its random noise was reseeded and it mis-estimated each failure's severity by up to 30%.

| Of 141 equipment failures that overheated a rack | Fixed alarm | Trend-line forecast | FaultZero twin |
| --- | --- | --- | --- |
| Warned before overheating | 0 | 141 | 141 |
| Median warning time | 0 min | 9 min | **12 min** |
| Warned 10+ minutes ahead | 0 | 68 | **101** |
| Warned the minute the equipment failed | 0 | 0 | **94** |

- The twin warned earlier than the trend line in **133 of 141** cases
- Hacked or silent sensors: the alarm and trend line caught **0**; the tamper check flagged **all 15** that overheated a rack
- **No false alarms** in 100 calm runs

Reproduce: `python sim/evaluate_twin.py` (writes `sim/twin_results.json`).

We also trained a machine-learning forecaster (`sim/evaluate.py`). It did worse than a simple trend line, because it only sees temperatures after they start rising. That result is why FaultZero models the cause instead of forecasting the symptom.

**Honest limitation:** all data is simulated, and the twin uses the same physics as the simulated facility. In a real building, the twin would first need to be calibrated against the building's sensor data. That's our next step.

## The hard parts we solved

- **Predicting a chain, not a number.** The twin deep-copies the whole facility and steps it 60 minutes ahead in ~9 ms, so it can run on every live update and inside every plan the agent tests.
- **Root cause, not just symptoms.** Every predicted failure walks the power and cooling dependency graph back to what started it, so the operator reads *"Row C passes 32°C in 11 min, because Chiller 2 tripped"*.
- **An agent you can trust.** Nemotron proposes plans through tool calls, but the numbers on every card come from re-simulating the plan in the twin. If its explanation quotes different numbers, we replace it with the verified one.
- **Never a dead demo.** If the NVIDIA API is unreachable, a scripted planner runs the same tools and the same verification.
- **Seeing what sensors hide.** A spoofed sensor reads "fine" while its rack overheats. We flag it from the power draw jump against a flat temperature reading.
- **One live stream for everything.** Server-Sent Events push each simulated minute, the cascade and every agent step to the 3D view, timeline and plan cards at once.
- **Honest evaluation.** We tested against two baselines on 200 incidents, handicapped our own twin, and reported where our ML model lost.

## Responsible design

- A human approves every action, and every decision is logged
- It doesn't control any real equipment; all incidents are simulated
- Agent numbers are always verified by the twin, never taken from the model's text
- Dollar figures are labeled illustrative ($1,000 per rack-hour above 27°C)
- The judge page has a cooldown, so one person can't spam failures

## Repo layout

| Folder | What's in it |
| --- | --- |
| `backend/` | Facility simulator, digital twin and cascade engine, Nemotron agent, FastAPI server |
| `business/` | Dollars at risk, work-order dispatch, shift handoff |
| `frontend/` | 3D control room (three.js) and story page |
| `phone/` | Judge "break my data center" page |
| `sim/` | Evaluation, trend-line baseline, ML experiment |
| `data/` | Facility layout and decision logs |
| `docs/` | Data formats, API and architecture diagram |

## How to run

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

Open http://localhost:8000. Optional `.env` settings:

```
NVIDIA_API_KEY=your-key         # use Nemotron; without it the scripted planner runs
PUBLIC_URL=https://your.domain  # QR code points to your public address
```

## Team

- **Sarosha:** digital twin, cascade engine, Nemotron agent, server, 3D control room and story page
- **Binitha:** forecasting baseline, model evaluation, presentation
- **Naomi:** business impact, work-order dispatch, judge phone page, domain

## What's next

- Calibrate the twin against real building telemetry (BACnet / Modbus)
- Real weather and IT load forecasts feeding the twin
- Send work orders straight to maintenance systems
- Multiple data halls and sites

## Open-source resources

- [FastAPI](https://fastapi.tiangolo.com/) · [Uvicorn](https://www.uvicorn.org/)
- [three.js](https://threejs.org/)
- [NVIDIA API catalog (Nemotron)](https://build.nvidia.com/) · [OpenAI Python client](https://github.com/openai/openai-python)
- [NumPy](https://numpy.org/) · [scikit-learn](https://scikit-learn.org/)
- [python-qrcode](https://github.com/lincolnloop/python-qrcode)

## Sources

- [Uptime Institute Annual Outage Analysis 2026 (Business Wire)](https://www.businesswire.com/news/home/20260513289344/en/Uptime-Announces-Annual-Outage-Analysis-Report-2026)
- [Uptime Institute outages in 2024 (DatacenterDynamics)](https://www.datacenterdynamics.com/en/news/uptime-institute-outages-in-2024-less-frequent-and-severe-but-more-expensive/)
