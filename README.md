# FaultZero

**See the chain before it breaks.**

FaultZero is an operations console for a data center, built around a live digital twin. When equipment fails, it plays the next hour forward, shows what fails next and why, has an NVIDIA Nemotron agent test fixes in the twin, and waits for a human to approve one.

Built at HackUTD 2026: Zero Day by Sarosha, Binitha and Naomi.

---

## The problem

Most data center outages aren't one failure. They're a chain: a chiller trips, cooling units warm up, racks overheat, and the alarm only fires once a temperature limit is already crossed. By then the operator is reacting, not preventing.

## What FaultZero does

- **Predicts the chain.** The moment something breaks, the twin copies the facility and runs it 60 minutes ahead (about 9 ms). It shows what fails next, when, and the root cause, traced through the power and cooling dependency graph.
- **Tests fixes first.** An agent powered by NVIDIA Nemotron investigates with tools, tries candidate plans in the twin, and proposes the best ones.
- **Verified numbers only.** Every plan is re-simulated before an operator sees it: racks overheating with and without the fix, plus illustrative dollars at risk.
- **A human decides.** Nothing changes until an operator clicks Approve. Each approval creates a maintenance work order with a team, technician, ETA and reserved spare part.
- **Scrub the future.** A time slider plays the next hour on the 3D twin, with or without the fix.
- **Catches hacked sensors.** A tampered sensor can freeze at a safe value while its rack overheats. FaultZero flags it from the power draw.
- **Hands off the shift.** One click summarizes what broke, what was recommended, what was approved and what to watch next.
- **Break it yourself.** Judges scan a QR code and inject failures from their phone.

## Pages

| Page | Path | What it is |
| --- | --- | --- |
| Story | `/` | Scroll-driven intro: one night in a data hall going wrong |
| Control room | `/control` | 3D twin, cascade timeline, agent plans, time scrubber, shift handoff |
| Break my data center | `/break` | Phone page opened from the QR code to inject failures |

## Results

We ran 200 random failures (random equipment, severity 30 to 100%) and compared three ways of warning an operator. To keep the twin honest, its random noise was reseeded and it mis-estimated each failure's severity by up to 30%.

| Of 141 equipment failures that overheated a rack | Fixed alarm | Trend-line forecast | FaultZero twin |
| --- | --- | --- | --- |
| Warned before overheating | 0 | 141 | 141 |
| Median warning time | 0 min | 9 min | **12 min** |
| Warned 10+ minutes ahead | 0 | 68 | **101** |
| Warned the minute the equipment failed | 0 | 0 | **94** |

- The twin warned earlier than the trend line in 133 of 141 cases.
- Hacked or silent sensors: the alarm and trend line caught 0; the tamper check flagged all 15 that overheated a rack.
- No false alarms in 100 calm runs.

Reproduce with `python sim/evaluate_twin.py` (results in `sim/twin_results.json`).

**Limitations:** all data is simulated, and the twin uses the same physics as the simulated facility, so real-world accuracy depends on calibrating the twin to a real building's sensor data. Dollar figures are illustrative ($1,000 per rack-hour above 27°C).

We also trained a machine-learning forecaster (`sim/evaluate.py`). It did worse than the trend line, because it only sees temperatures after they start rising. That's why FaultZero models the cause instead of forecasting the symptom.

## How it's built

| Part | Files | What it does |
| --- | --- | --- |
| Facility model | `backend/fake_sim.py`, `data/assets.json` | Minute-by-minute model of utility power, generator, 2 UPS, 4 PDUs, 3 chillers, 6 cooling units and 24 racks; failures with severity; operator actions |
| Digital twin | `backend/cascade.py` | Copies the state, runs 60 minutes ahead, records the first limit crossing per asset and the root-cause path |
| Agent | `backend/agent.py` | Nemotron with tool calling (incident, forecast, asset, mitigations, simulate plan); plans re-verified and ranked by the twin; scripted fallback using the same tools |
| Server | `backend/main.py` | FastAPI, live updates over Server-Sent Events, approvals, decision log, shift handoff, QR code |
| Business | `business/impact.py`, `business/dispatch.py` | Dollars at risk from predicted temperatures; work orders for approved plans |
| Frontend | `frontend/` | three.js twin with bloom and animated power and water flow, console UI, story page |
| Judge page | `phone/index.html` | Mobile page that injects failures |
| Evaluation | `sim/evaluate_twin.py`, `sim/forecast.py` | The results above; trend-line baseline |

**Stack:** Python, FastAPI, Server-Sent Events, JavaScript, three.js, HTML/CSS, NVIDIA Nemotron (NVIDIA API), NumPy.

## Run it locally

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

Open http://localhost:8000.

Optional settings in a `.env` file:

```
NVIDIA_API_KEY=your-key        # use Nemotron; without it, the scripted planner runs
PUBLIC_URL=https://your.domain # makes the QR code point to your public address
```

## Team

- **Sarosha:** digital twin, cascade engine, Nemotron agent, server, 3D console and story page
- **Binitha:** forecasting baseline, model evaluation, presentation
- **Naomi:** business impact, work-order dispatch, judge phone page, domain

## What's next

- Calibrate the twin against real building telemetry (BACnet / Modbus)
- Real weather and load forecasts feeding the twin
- Send work orders straight to maintenance systems
- Multiple data halls and sites
