"""LaMa giriş konvansiyonunu deneyle bulur.

Maskeli alan sıfırlanmalı mı, olduğu gibi mi verilmeli, maske polaritesi ne?
Yanlış konvansiyon modeli çökertmiyor, sadece kötü dolgu üretiyor — bu yüzden
gözle karşılaştırmak gerekiyor.
"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from comic_probe import build_page
from pipeline import LAMA_SIZE, MangaCleaner

out = Path(__file__).parent / "out"
out.mkdir(exist_ok=True)

page = build_page()
cleaner = MangaCleaner()
mask = cleaner.detect_mask(page)

# KRAKOOOM paneli: tarama dokusu üzerinde büyük, birleşik maske
crop = page[400:600, 120:790]
crop_mask = mask[400:600, 120:790]

small = cv2.resize(crop, (LAMA_SIZE, LAMA_SIZE), interpolation=cv2.INTER_AREA)
small_mask = cv2.resize(crop_mask, (LAMA_SIZE, LAMA_SIZE), interpolation=cv2.INTER_NEAREST)
rgb = cv2.cvtColor(small, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
m = (small_mask > 0).astype(np.float32)

variants = {
    "A_sifirli_maske1": (rgb * (1.0 - m[:, :, None]), m),
    "B_orijinal_maske1": (rgb.copy(), m),
    "C_sifirli_maske_ters": (rgb * (1.0 - m[:, :, None]), 1.0 - m),
    "D_beyaz_maske1": (rgb * (1.0 - m[:, :, None]) + m[:, :, None], m),
}

panels = [cv2.resize(crop, (LAMA_SIZE, LAMA_SIZE), interpolation=cv2.INTER_AREA)]
labels = ["girdi"]
for name, (image, mask_in) in variants.items():
    result = cleaner.inpainter.run(
        ["output"],
        {
            "image": image.transpose(2, 0, 1)[None].astype(np.float32),
            "mask": mask_in[None, None].astype(np.float32),
        },
    )[0][0]
    filled = result.transpose(1, 2, 0)
    scale = 255.0 if filled.max() <= 1.5 else 1.0
    filled = np.clip(filled * scale, 0, 255).astype(np.uint8)
    filled = cv2.cvtColor(filled, cv2.COLOR_RGB2BGR)
    composed = cv2.resize(crop, (LAMA_SIZE, LAMA_SIZE), interpolation=cv2.INTER_AREA)
    keep = small_mask > 0
    composed[keep] = filled[keep]
    panels.append(composed)
    labels.append(name)
    print(f"{name}: cikti min={result.min():.3f} max={result.max():.3f}")

strip = np.hstack(panels)
for index, label in enumerate(labels):
    cv2.putText(
        strip,
        label,
        (index * LAMA_SIZE + 8, 24),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.6,
        (0, 0, 255),
        2,
    )
cv2.imwrite(str(out / "lama_variants.png"), strip)
print("yazildi:", out / "lama_variants.png")
