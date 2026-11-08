
import numpy as np

def predict_time_to_limit(temperatures, limit=32):
    recent = np.asarray(temperatures[-5:], dtype=float)

    if len(recent) < 5 or not np.all(np.isfinite(recent)):
        return None

    times = np.arange(len(recent))
    slope = np.polyfit(times, recent, 1)[0]

    current = recent[-1]

    if current >= limit:
        return 0.0

    if slope <= 0:
        return None

    return round(float((limit - current) / slope), 1)
