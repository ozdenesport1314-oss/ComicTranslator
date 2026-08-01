"""Manga sayfası temizleme boru hattı.

Sezgisel (parlaklık eşiği, bileşen boyu, kağıt tahmini) yaklaşım her sayfada
farklı kırılıyordu. Burada karar modele bırakılır:

  1. comic-text-detector → piksel bazında yazı maskesi
  2. lama-manga          → maskelenen alanı çevresine uygun şekilde doldurur

Tensör imzaları modelden okundu:
  detector: images [1,3,1024,1024] → blk [1,64512,7], seg [1,1,1024,1024], det [1,2,1024,1024]
  lama:     image [b,3,512,512] + mask [b,1,512,512] → output [b,3,512,512]
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort

DETECTOR_SIZE = 1024
LAMA_SIZE = 512
MODELS_DIR = Path(os.environ.get("MODELS_DIR", Path(__file__).parent / "models"))


@dataclass
class CleanResult:
    image: np.ndarray
    """Temizlenmiş sayfa (BGR)."""
    mask: np.ndarray
    """Silinen piksellerin maskesi (0/255)."""
    coverage: float
    """Maskenin sayfaya oranı; anormal büyükse bir şey ters gitmiştir."""


def _letterbox(
    bgr: np.ndarray, size: int = DETECTOR_SIZE
) -> tuple[np.ndarray, float, int, int]:
    height, width = bgr.shape[:2]
    ratio = min(size / height, size / width)
    new_h = max(1, round(height * ratio))
    new_w = max(1, round(width * ratio))
    interp = cv2.INTER_AREA if ratio < 1 else cv2.INTER_LINEAR
    resized = cv2.resize(bgr, (new_w, new_h), interpolation=interp)
    canvas = np.full((size, size, 3), 114, dtype=np.uint8)
    top = (size - new_h) // 2
    left = (size - new_w) // 2
    canvas[top : top + new_h, left : left + new_w] = resized
    return canvas, ratio, left, top


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-x))


def _merge_boxes(
    boxes: list[tuple[int, int, int, int]], gap: int
) -> list[tuple[int, int, int, int]]:
    """Yakın kutuları birleştirir; her harf için ayrı inpaint çağrısı pahalı."""
    merged: list[tuple[int, int, int, int]] = []
    for box in sorted(boxes, key=lambda b: (b[1], b[0])):
        x0, y0, x1, y1 = box
        placed = False
        for index, (mx0, my0, mx1, my1) in enumerate(merged):
            overlap = (
                x0 <= mx1 + gap
                and mx0 <= x1 + gap
                and y0 <= my1 + gap
                and my0 <= y1 + gap
            )
            if overlap:
                merged[index] = (
                    min(mx0, x0),
                    min(my0, y0),
                    max(mx1, x1),
                    max(my1, y1),
                )
                placed = True
                break
        if not placed:
            merged.append((x0, y0, x1, y1))
    # Birleşmeler yeni komşuluklar doğurur; sabit noktaya kadar tekrarla.
    if len(merged) != len(boxes):
        return _merge_boxes(merged, gap)
    return merged


def _nms(
    boxes: np.ndarray, scores: np.ndarray, iou_threshold: float
) -> list[int]:
    order = np.argsort(-scores)
    keep: list[int] = []
    while order.size:
        current = int(order[0])
        keep.append(current)
        if order.size == 1:
            break
        rest = order[1:]
        x0 = np.maximum(boxes[current, 0], boxes[rest, 0])
        y0 = np.maximum(boxes[current, 1], boxes[rest, 1])
        x1 = np.minimum(boxes[current, 2], boxes[rest, 2])
        y1 = np.minimum(boxes[current, 3], boxes[rest, 3])
        inter = np.clip(x1 - x0, 0, None) * np.clip(y1 - y0, 0, None)
        area_current = (boxes[current, 2] - boxes[current, 0]) * (
            boxes[current, 3] - boxes[current, 1]
        )
        area_rest = (boxes[rest, 2] - boxes[rest, 0]) * (
            boxes[rest, 3] - boxes[rest, 1]
        )
        iou = inter / np.maximum(area_current + area_rest - inter, 1e-6)
        order = rest[iou < iou_threshold]
    return keep


class MangaCleaner:
    def __init__(self, models_dir: Path = MODELS_DIR) -> None:
        providers = ["CPUExecutionProvider"]
        options = ort.SessionOptions()
        options.graph_optimization_level = (
            ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        )
        self.detector = ort.InferenceSession(
            str(models_dir / "comic-text-detector.onnx"),
            sess_options=options,
            providers=providers,
        )
        self.inpainter = ort.InferenceSession(
            str(models_dir / "lama-manga.onnx"),
            sess_options=options,
            providers=providers,
        )

    def _forward(self, bgr: np.ndarray) -> tuple[np.ndarray, np.ndarray, float, int, int]:
        canvas, ratio, left, top = _letterbox(bgr)
        rgb = cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB)
        tensor = rgb.transpose(2, 0, 1)[None].astype(np.float32) / 255.0
        blk, seg = self.detector.run(["blk", "seg"], {"images": tensor})
        return blk[0], seg[0, 0], ratio, left, top

    def detect_blocks(
        self,
        bgr: np.ndarray,
        conf_threshold: float = 0.2,
        iou_threshold: float = 0.45,
    ) -> list[tuple[int, int, int, int, float]]:
        """Yazı bloğu kutuları (orijinal görsel koordinatlarında)."""
        height, width = bgr.shape[:2]
        blk, _, ratio, left, top = self._forward(bgr)
        scores = blk[:, 4]
        keep = scores >= conf_threshold
        if not keep.any():
            return []
        selected = blk[keep]
        scores = scores[keep]
        cx, cy, bw, bh = (selected[:, i] for i in range(4))
        boxes = np.stack(
            [cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2], axis=1
        )
        result: list[tuple[int, int, int, int, float]] = []
        for index in _nms(boxes, scores, iou_threshold):
            x0, y0, x1, y1 = boxes[index]
            # Letterbox koordinatlarından orijinale dön.
            x0 = (x0 - left) / ratio
            x1 = (x1 - left) / ratio
            y0 = (y0 - top) / ratio
            y1 = (y1 - top) / ratio
            result.append(
                (
                    int(max(0, min(width - 1, round(x0)))),
                    int(max(0, min(height - 1, round(y0)))),
                    int(max(0, min(width - 1, round(x1)))),
                    int(max(0, min(height - 1, round(y1)))),
                    float(scores[index]),
                )
            )
        return result

    def detect_mask(
        self,
        bgr: np.ndarray,
        threshold: float = 0.3,
        grow: int = 2,
        restrict_to_blocks: bool = True,
        block_conf: float = 0.2,
        block_pad: int = 8,
    ) -> np.ndarray:
        height, width = bgr.shape[:2]
        blk, seg, ratio, left, top = self._forward(bgr)
        if seg.min() < 0.0 or seg.max() > 1.0:
            seg = _sigmoid(seg)

        new_h = max(1, round(height * ratio))
        new_w = max(1, round(width * ratio))
        seg = seg[top : top + new_h, left : left + new_w]
        seg = cv2.resize(seg, (width, height), interpolation=cv2.INTER_LINEAR)

        mask = (seg >= threshold).astype(np.uint8) * 255

        # Segmentasyon sanatın parlak ince detaylarını da yazı sanabiliyor
        # (kılıç parıltısı, kafatası dikeni). Yazı bloğu kutuları bunları eler.
        if restrict_to_blocks:
            blocks = self.detect_blocks(bgr, conf_threshold=block_conf)
            if blocks:
                allowed = np.zeros((height, width), dtype=np.uint8)
                for x0, y0, x1, y1, _ in blocks:
                    ax0 = max(0, x0 - block_pad)
                    ay0 = max(0, y0 - block_pad)
                    ax1 = min(width - 1, x1 + block_pad)
                    ay1 = min(height - 1, y1 + block_pad)
                    allowed[ay0 : ay1 + 1, ax0 : ax1 + 1] = 255
                mask = cv2.bitwise_and(mask, allowed)
        # Tek piksellik parazit maskeye girerse inpaint boşuna çalışır.
        count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
        for label in range(1, count):
            if stats[label, cv2.CC_STAT_AREA] < 6:
                mask[labels == label] = 0
        if grow > 0:
            kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
            mask = cv2.dilate(mask, kernel, iterations=grow)
        return mask

    def inpaint(self, bgr: np.ndarray, mask: np.ndarray) -> np.ndarray:
        height, width = bgr.shape[:2]
        count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
        raw: list[tuple[int, int, int, int]] = []
        for label in range(1, count):
            x = stats[label, cv2.CC_STAT_LEFT]
            y = stats[label, cv2.CC_STAT_TOP]
            w = stats[label, cv2.CC_STAT_WIDTH]
            h = stats[label, cv2.CC_STAT_HEIGHT]
            raw.append((x, y, x + w - 1, y + h - 1))
        if not raw:
            return bgr.copy()

        gap = max(12, int(min(width, height) * 0.02))
        out = bgr.copy()
        for x0, y0, x1, y1 in _merge_boxes(raw, gap):
            pad = max(24, int(0.3 * max(x1 - x0 + 1, y1 - y0 + 1)))
            cx0 = max(0, x0 - pad)
            cy0 = max(0, y0 - pad)
            cx1 = min(width, x1 + pad + 1)
            cy1 = min(height, y1 + pad + 1)
            crop = bgr[cy0:cy1, cx0:cx1]
            crop_mask = mask[cy0:cy1, cx0:cx1]
            if crop.size == 0 or not crop_mask.any():
                continue

            small = cv2.resize(
                crop, (LAMA_SIZE, LAMA_SIZE), interpolation=cv2.INTER_AREA
            )
            small_mask = cv2.resize(
                crop_mask, (LAMA_SIZE, LAMA_SIZE), interpolation=cv2.INTER_NEAREST
            )
            rgb = cv2.cvtColor(small, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
            m = (small_mask > 0).astype(np.float32)
            # LaMa maskelenmiş bölgeyi boş görmek üzere eğitildi.
            rgb = rgb * (1.0 - m[:, :, None])
            image_t = rgb.transpose(2, 0, 1)[None]
            mask_t = m[None, None]
            result = self.inpainter.run(
                ["output"], {"image": image_t, "mask": mask_t}
            )[0][0]
            filled = result.transpose(1, 2, 0)
            if filled.max() <= 1.5:
                filled = filled * 255.0
            filled = np.clip(filled, 0, 255).astype(np.uint8)
            filled = cv2.cvtColor(filled, cv2.COLOR_RGB2BGR)
            filled = cv2.resize(
                filled, (cx1 - cx0, cy1 - cy0), interpolation=cv2.INTER_LINEAR
            )
            region = out[cy0:cy1, cx0:cx1]
            selected = crop_mask > 0
            region[selected] = filled[selected]
        return out

    def clean(
        self,
        bgr: np.ndarray,
        threshold: float = 0.3,
        grow: int = 2,
        restrict_to_blocks: bool = True,
    ) -> CleanResult:
        mask = self.detect_mask(
            bgr,
            threshold=threshold,
            grow=grow,
            restrict_to_blocks=restrict_to_blocks,
        )
        coverage = float((mask > 0).mean())
        image = self.inpaint(bgr, mask)
        return CleanResult(image=image, mask=mask, coverage=coverage)
