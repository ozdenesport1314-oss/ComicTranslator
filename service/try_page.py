"""Gerçek sayfa üzerinde deneme: maske ve temizlenmiş çıktıyı diske yazar.

Kullanım:
  python try_page.py <girdi> [--crop x0,y0,x1,y1] [--out klasör]
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import cv2
import numpy as np

from pipeline import MangaCleaner

parser = argparse.ArgumentParser()
parser.add_argument("input")
parser.add_argument("--crop", default=None, help="x0,y0,x1,y1")
parser.add_argument("--out", default=str(Path(__file__).parent / "out"))
parser.add_argument("--threshold", type=float, default=0.3)
args = parser.parse_args()

bgr = cv2.imdecode(
    np.fromfile(args.input, dtype=np.uint8), cv2.IMREAD_COLOR
)
if bgr is None:
    raise SystemExit(f"okunamadı: {args.input}")
print(f"girdi {bgr.shape[1]}x{bgr.shape[0]}")

if args.crop:
    x0, y0, x1, y1 = (int(v) for v in args.crop.split(","))
    bgr = bgr[y0:y1, x0:x1]
    print(f"kırpma {bgr.shape[1]}x{bgr.shape[0]}")

out_dir = Path(args.out)
out_dir.mkdir(parents=True, exist_ok=True)

started = time.time()
cleaner = MangaCleaner()
print(f"model yüklendi {time.time() - started:.1f}s")

started = time.time()
raw_mask = cleaner.detect_mask(bgr, threshold=args.threshold, restrict_to_blocks=False)
mask = cleaner.detect_mask(bgr, threshold=args.threshold, restrict_to_blocks=True)
blocks = cleaner.detect_blocks(bgr)
print(
    f"maske {time.time() - started:.1f}s  "
    f"ham={float((raw_mask > 0).mean()):.4f} "
    f"bloklu={float((mask > 0).mean()):.4f} blok={len(blocks)}"
)

overlay = bgr.copy()
overlay[raw_mask > 0] = (0, 200, 255)
overlay[mask > 0] = (0, 0, 255)
overlay = cv2.addWeighted(bgr, 0.45, overlay, 0.55, 0)
for x0, y0, x1, y1, score in blocks:
    cv2.rectangle(overlay, (x0, y0), (x1, y1), (0, 200, 0), 1)

started = time.time()
cleaned = cleaner.inpaint(bgr, mask)
print(f"inpaint {time.time() - started:.1f}s")

cv2.imwrite(str(out_dir / "input.png"), bgr)
cv2.imwrite(str(out_dir / "mask.png"), mask)
cv2.imwrite(str(out_dir / "overlay.png"), overlay)
cv2.imwrite(str(out_dir / "cleaned.png"), cleaned)
print(f"yazildi: {out_dir}")
