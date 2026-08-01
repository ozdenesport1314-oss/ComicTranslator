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
result = cleaner.clean(bgr, threshold=args.threshold)
print(
    f"temizlik {time.time() - started:.1f}s  "
    f"ham={float((raw_mask > 0).mean()):.4f} "
    f"maske={result.coverage:.4f} "
    f"silinen={float((result.erased > 0).mean()):.4f} "
    f"blok={len(result.blocks)} korunan={len(result.kept)}"
)
for block in result.blocks:
    print(
        f"  {block.kind:7s} conf={block.confidence:.2f} "
        f"({block.x0},{block.y0})-({block.x1},{block.y1})"
    )

overlay = bgr.copy()
overlay[raw_mask > 0] = (0, 200, 255)
overlay[result.erased > 0] = (0, 0, 255)
overlay = cv2.addWeighted(bgr, 0.45, overlay, 0.55, 0)
for block in result.blocks:
    color = (0, 200, 0) if block.kind == "erased" else (255, 0, 255)
    cv2.rectangle(overlay, (block.x0, block.y0), (block.x1, block.y1), color, 1)

cv2.imwrite(str(out_dir / "input.png"), bgr)
cv2.imwrite(str(out_dir / "mask.png"), result.mask)
cv2.imwrite(str(out_dir / "overlay.png"), overlay)
cv2.imwrite(str(out_dir / "cleaned.png"), result.image)
print(f"yazildi: {out_dir}")
