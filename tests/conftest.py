import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "sim"))
# tests never call external services
os.environ["NVIDIA_API_KEY"] = ""
os.environ["TIGER_URL"] = ""
os.environ["PUBLIC_URL"] = "https://faultzero.test"
