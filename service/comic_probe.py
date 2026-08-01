"""Çizgi roman senaryolarını modele sorar.

Manga balonu ile çizgi romanın zorlukları farklı: kalın konturlu SFX, tonlamalı
(gradyan/halftone) büyük başlıklar, balon dışında serbest duran metin, panel
kenarına oturan caption. Bu sayfa o durumları tek yerde toplayıp modelin
maskesini ve blok sınıfını raporlar.

Blok sınıfları deneyle doğrulanır: sınıf 0'ın balon içi, sınıf 1'in balonsuz
(SFX/serbest) metin olduğu varsayımı buradaki çıktılarla test edilir.
"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from pipeline import MangaCleaner

W, H = 900, 1300
FONTS = {
    "sfx": r"C:\Windows\Fonts\impact.ttf",
    "bold": r"C:\Windows\Fonts\arialbd.ttf",
    "comic": r"C:\Windows\Fonts\comicbd.ttf",
}


def font(kind: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONTS[kind], size)


def hatch(draw: ImageDraw.ImageDraw, box, step=5, width=1, angle="down"):
    x0, y0, x1, y1 = box
    for offset in range(-(y1 - y0), x1 - x0, step):
        if angle == "down":
            draw.line([(x0 + offset, y0), (x0 + offset + (y1 - y0), y1)], fill=40, width=width)
        else:
            draw.line([(x0 + offset, y1), (x0 + offset + (y1 - y0), y0)], fill=40, width=width)


def halftone(image: Image.Image, box, spacing=6, radius=2):
    draw = ImageDraw.Draw(image)
    x0, y0, x1, y1 = box
    for y in range(y0, y1, spacing):
        for x in range(x0, x1, spacing):
            draw.ellipse([x, y, x + radius, y + radius], fill=70)


def outlined(draw, xy, text, fnt, fill=255, outline=0, stroke=6, anchor="mm"):
    draw.text(xy, text, font=fnt, fill=fill, anchor=anchor, stroke_width=stroke, stroke_fill=outline)


def build_page() -> np.ndarray:
    page = Image.new("L", (W, H), 255)
    draw = ImageDraw.Draw(page)

    # --- Panel 1: klasik balon (referans) ---
    p1 = (40, 40, 860, 340)
    draw.rectangle(p1, outline=0, width=3)
    halftone(page, (44, 44, 856, 336))
    draw = ImageDraw.Draw(page)
    draw.ellipse((90, 80, 430, 250), fill=255, outline=0, width=3)
    f = font("comic", 26)
    draw.text((260, 130), "THIS IS A NORMAL", font=f, fill=0, anchor="mm")
    draw.text((260, 165), "BALLOON LINE.", font=f, fill=0, anchor="mm")

    # --- Panel 2: kalin konturlu SFX, sanat uzerinde ---
    p2 = (40, 360, 860, 660)
    draw.rectangle(p2, outline=0, width=3)
    hatch(draw, (44, 364, 856, 656), step=6, width=2)
    outlined(draw, (450, 500), "KRAKOOOM!", font("sfx", 110), fill=255, outline=0, stroke=8)

    # --- Panel 3: tonlamali (gradyan) buyuk baslik ---
    p3 = (40, 680, 860, 980)
    draw.rectangle(p3, outline=0, width=3)
    gradient = Image.linear_gradient("L").resize((812, 292))
    page.paste(gradient, (44, 684))
    draw = ImageDraw.Draw(page)
    outlined(draw, (450, 830), "THE FINAL HOUR", font("sfx", 84), fill=255, outline=0, stroke=5)

    # --- Panel 4: balon disi serbest metin + kenar caption ---
    p4 = (40, 1000, 860, 1260)
    draw.rectangle(p4, outline=0, width=3)
    hatch(draw, (44, 1004, 856, 1256), step=7, width=2, angle="up")
    # Balonsuz, dogrudan sanat uzerine yazi (kontursuz beyaz)
    draw.text((300, 1080), "NO BALLOON HERE", font=font("bold", 34), fill=255, anchor="mm",
              stroke_width=3, stroke_fill=0)
    # Panel kenarina oturan caption kutusu
    draw.rectangle((44, 1180, 360, 1256), fill=255, outline=0, width=2)
    draw.text((60, 1200), "MEANWHILE, AT", font=font("comic", 22), fill=0)
    draw.text((60, 1228), "THE GATE...", font=font("comic", 22), fill=0)

    return cv2.cvtColor(np.array(page), cv2.COLOR_GRAY2BGR)


REGIONS = {
    "1 balon metni": (90, 80, 430, 250),
    "2 SFX KRAKOOOM": (150, 430, 760, 570),
    "3 gradyan baslik": (140, 780, 770, 880),
    "4 balonsuz metin": (150, 1055, 470, 1105),
    "5 kenar caption": (44, 1180, 360, 1256),
}


def coverage(mask: np.ndarray, box) -> float:
    x0, y0, x1, y1 = box
    region = mask[y0:y1, x0:x1]
    return float((region > 0).mean())


if __name__ == "__main__":
    page = build_page()
    out = Path(__file__).parent / "out"
    out.mkdir(exist_ok=True)
    cv2.imwrite(str(out / "probe_page.png"), page)

    cleaner = MangaCleaner()
    result = cleaner.clean(page)

    print(f"blok sayisi={len(result.blocks)}  korunan bolge={len(result.kept)}")
    for block in result.blocks:
        print(
            f"  {block.kind:8s} conf={block.confidence:.2f} "
            f"({block.x0},{block.y0})-({block.x1},{block.y1})"
        )

    print(f"{'bolge':22s} {'maske':>7s} {'silinen':>8s}")
    for name, box in REGIONS.items():
        print(
            f"{name:22s} {coverage(result.mask, box):7.3f} "
            f"{coverage(result.erased, box):8.3f}"
        )

    overlay = page.copy()
    overlay[result.mask > 0] = (0, 200, 255)
    overlay[result.erased > 0] = (0, 0, 255)
    overlay = cv2.addWeighted(page, 0.45, overlay, 0.55, 0)
    for block in result.blocks:
        color = (0, 200, 0) if block.kind == "balloon" else (255, 120, 0)
        cv2.rectangle(overlay, (block.x0, block.y0), (block.x1, block.y1), color, 2)
        cv2.putText(overlay, f"{block.kind} {block.confidence:.2f}",
                    (block.x0, max(12, block.y0 - 4)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.45, color, 1)
    for x0, y0, x1, y1 in result.kept:
        cv2.rectangle(overlay, (x0, y0), (x1, y1), (255, 0, 255), 2)
    cv2.imwrite(str(out / "probe_overlay.png"), overlay)
    cv2.imwrite(str(out / "probe_cleaned.png"), result.image)
    print("yazildi:", out)
