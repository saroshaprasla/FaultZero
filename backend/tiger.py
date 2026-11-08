"""
Facility history in Tiger Data (TimescaleDB on Postgres).

Every simulated minute, all 41 assets are written to a hypertable, plus one row per
incident, approval and work order. The console reads it back with time_bucket()
to draw a rack's temperature history.

Off by default: set TIGER_URL to a Tiger Cloud connection string to turn it on.
If the database is missing, slow or down, the demo keeps running unchanged:
writes go through a bounded queue on a background thread and are dropped, never blocked on.
"""
import json
import os
import queue
import threading
import time
import uuid
from typing import Optional

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS facility_readings (
        time        TIMESTAMPTZ NOT NULL,
        run_id      TEXT        NOT NULL,
        sim_minute  INTEGER     NOT NULL,
        asset       TEXT        NOT NULL,
        asset_type  TEXT        NOT NULL,
        status      TEXT,
        temp_c      DOUBLE PRECISION,
        power_kw    DOUBLE PRECISION,
        fan_pct     DOUBLE PRECISION,
        load_pct    DOUBLE PRECISION
    )""",
    """CREATE TABLE IF NOT EXISTS facility_events (
        time        TIMESTAMPTZ NOT NULL,
        run_id      TEXT        NOT NULL,
        sim_minute  INTEGER     NOT NULL,
        kind        TEXT        NOT NULL,
        asset       TEXT,
        detail      JSONB
    )""",
    "CREATE INDEX IF NOT EXISTS facility_readings_lookup ON facility_readings (run_id, asset, time DESC)",
]
HYPERTABLES = [
    "SELECT create_hypertable('facility_readings', 'time', if_not_exists => TRUE)",
    "SELECT create_hypertable('facility_events', 'time', if_not_exists => TRUE)",
]


class Tiger:
    def __init__(self, url: Optional[str]):
        self.url = url
        self.enabled = bool(url)
        self.hypertable = False
        self.rows_written = 0
        self.dropped = 0
        self.last_error: Optional[str] = None
        self.run_id = uuid.uuid4().hex[:8]
        self.q: "queue.Queue[tuple]" = queue.Queue(maxsize=20000)
        self._conn = None
        self._lock = threading.Lock()
        if self.enabled:
            threading.Thread(target=self._writer, daemon=True).start()

    # ---------- connection ----------
    def _connect(self):
        import psycopg
        conn = psycopg.connect(self.url, autocommit=True, connect_timeout=5)
        with conn.cursor() as cur:
            for sql in SCHEMA:
                cur.execute(sql)
            try:
                for sql in HYPERTABLES:
                    cur.execute(sql)
                self.hypertable = True
            except Exception:  # plain Postgres without TimescaleDB still works, just without hypertables
                self.hypertable = False
        return conn

    def _conn_ok(self):
        if self._conn is None or self._conn.closed:
            self._conn = self._connect()
        return self._conn

    # ---------- writes (never block the simulation) ----------
    def new_run(self):
        self.run_id = uuid.uuid4().hex[:8]

    def _put(self, item):
        if not self.enabled:
            return
        try:
            self.q.put_nowait(item)
        except queue.Full:
            self.dropped += 1

    def record_snapshot(self, snap: dict, assets: dict):
        if not self.enabled:
            return
        rows = []
        for aid, s in snap["assets"].items():
            t = assets[aid]["type"]
            temp = s.get("inlet_temp_c") if t == "rack" else s.get("supply_air_c", s.get("supply_temp_c"))
            rows.append((snap["t"], self.run_id, snap["minute"], aid, t, s.get("status"), temp,
                         s.get("power_kw"), s.get("fan_pct"), s.get("load_pct")))
        self._put(("readings", rows))

    def record_event(self, minute: int, sim_time: str, kind: str, asset: Optional[str], detail: dict):
        self._put(("event", (sim_time, self.run_id, minute, kind, asset, json.dumps(detail, default=str))))

    def _writer(self):
        while True:
            batch, events = [], []
            try:
                item = self.q.get(timeout=2)
            except queue.Empty:
                continue
            items = [item]
            while len(items) < 50:
                try:
                    items.append(self.q.get_nowait())
                except queue.Empty:
                    break
            for kind, payload in items:
                (batch.extend if kind == "readings" else events.append)(payload)
            try:
                with self._lock:
                    conn = self._conn_ok()
                    with conn.cursor() as cur:
                        if batch:
                            cur.executemany(
                                "INSERT INTO facility_readings (time, run_id, sim_minute, asset, asset_type, status,"
                                " temp_c, power_kw, fan_pct, load_pct) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)", batch)
                        if events:
                            cur.executemany(
                                "INSERT INTO facility_events (time, run_id, sim_minute, kind, asset, detail)"
                                " VALUES (%s,%s,%s,%s,%s,%s)", events)
                self.rows_written += len(batch) + len(events)
                self.last_error = None
            except Exception as e:  # keep the demo alive; try again with the next batch
                self.dropped += len(batch) + len(events)
                self.last_error = f"{type(e).__name__}: {str(e)[:160]}"
                self._conn = None
                time.sleep(3)

    # ---------- reads ----------
    def history(self, asset: str, minutes: int = 60, bucket: int = 5) -> dict:
        """Temperature history for one asset in the current run, bucketed with time_bucket()."""
        if not self.enabled:
            return {"enabled": False}
        bucket_sql = ("time_bucket(make_interval(mins => %s), time)" if self.hypertable
                      else "date_bin(make_interval(mins => %s), time, TIMESTAMPTZ '2000-01-01')")
        sql = f"""
            WITH latest AS (SELECT max(time) AS t FROM facility_readings WHERE run_id = %s)
            SELECT {bucket_sql} AS bucket, avg(temp_c), max(temp_c), min(temp_c), count(*)
            FROM facility_readings, latest
            WHERE run_id = %s AND asset = %s AND time > latest.t - make_interval(mins => %s)
            GROUP BY bucket ORDER BY bucket"""
        try:
            with self._lock:
                conn = self._conn_ok()
                with conn.cursor() as cur:
                    cur.execute(sql, (self.run_id, bucket, self.run_id, asset, minutes))
                    rows = cur.fetchall()
                    cur.execute("SELECT count(*) FROM facility_readings WHERE run_id = %s", (self.run_id,))
                    total = cur.fetchone()[0]
        except Exception as e:
            self.last_error = f"{type(e).__name__}: {str(e)[:160]}"
            self._conn = None
            return {"enabled": True, "ok": False, "error": self.last_error}
        pts = [{"t": b.isoformat(), "avg": round(a, 2) if a is not None else None,
                "max": round(mx, 2) if mx is not None else None, "min": round(mn, 2) if mn is not None else None,
                "n": n} for b, a, mx, mn, n in rows]
        return {"enabled": True, "ok": True, "asset": asset, "bucket_min": bucket, "points": pts,
                "rows_this_run": total, "hypertable": self.hypertable}

    def status(self) -> dict:
        return {"enabled": self.enabled, "hypertable": self.hypertable, "run_id": self.run_id,
                "rows_written": self.rows_written, "dropped": self.dropped, "queue": self.q.qsize(),
                "last_error": self.last_error}


tiger = Tiger(os.environ.get("TIGER_URL") or None)
