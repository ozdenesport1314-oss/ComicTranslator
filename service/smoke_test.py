"""Servisi uçtan uca dener: /health + /clean.

Kullanım: python smoke_test.py <görsel> [--crop x0,y0,x1,y1] [--url http://...]
"""

from __future__ import annotations

import argparse
import base64
import json
import urllib.request
from pathlib import Path

import cv2
import numpy as np

parser = argparse.ArgumentParser()
parser.add_argument("input")
parser.add_argument("--crop", default=None)
parser.add_argument("--url", default="http://127.0.0.1:8123")
parser.add_argument(
    "--skip-health",
    action="store_true",
    help="Next.js proxy'sinde /health yok",
)
args = parser.parse_args()

bgr = cv2.imdecode(np.fromfile(args.input, dtype=np.uint8), cv2.IMREAD_COLOR)
if args.crop:
    x0, y0, x1, y1 = (int(v) for v in args.crop.split(","))
    bgr = bgr[y0:y1, x0:x1]
ok, buffer = cv2.imencode(".png", bgr)
assert ok
data_url = "data:image/png;base64," + base64.b64encode(buffer).decode()

if not args.skip_health:
    with urllib.request.urlopen(f"{args.url}/health", timeout=30) as response:
        print("health", response.read().decode())

payload = json.dumps({"imageBase64": data_url, "returnMask": True}).encode()
request = urllib.request.Request(
    f"{args.url}/clean",
    data=payload,
    headers={"Content-Type": "application/json"},
)
with urllib.request.urlopen(request, timeout=600) as response:
    body = json.loads(response.read().decode())

print(
    f"clean ms={body['ms']} kapsama={body['coverage']:.4f} blok={body['blocks']}"
)
out = Path(__file__).parent / "out"
out.mkdir(exist_ok=True)
for key, name in (("imageBase64", "service_cleaned.jpg"), ("maskBase64", "service_mask.png")):
    value = body.get(key)
    if not value:
        continue
    raw = base64.b64decode(value.split(",", 1)[1])
    (out / name).write_bytes(raw)
    print("yazildi:", out / name)
