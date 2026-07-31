import type { BubbleBox } from "./types";

function clamp01(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Normalize many Gemini box formats into 0–1 x/y/w/h.
 * Supports: x/y/w/h, width/height, xmin/xmax, left/right, 0–100 %, 0–1000, pixels.
 */
export function normalizeBubbleBox(
  raw: unknown,
  imageWidth?: number,
  imageHeight?: number,
): BubbleBox | null {
  if (raw == null) return null;

  let x: number | null = null;
  let y: number | null = null;
  let w: number | null = null;
  let h: number | null = null;

  if (Array.isArray(raw) && raw.length >= 4) {
    // Common vision formats: [ymin, xmin, ymax, xmax] OR [x, y, w, h]
    const a = raw.map((v) => asFiniteNumber(v));
    if (a.some((v) => v == null)) return null;
    const [a0, a1, a2, a3] = a as number[];

    // If third/fourth look like corners (greater than first/second), treat as yxyx or xyxy
    if (a2 > a0 && a3 > a1) {
      // Prefer Google-style [ymin, xmin, ymax, xmax] when values look normalized-ish
      y = a0;
      x = a1;
      h = a2 - a0;
      w = a3 - a1;
    } else {
      x = a0;
      y = a1;
      w = a2;
      h = a3;
    }
  } else if (typeof raw === "object") {
    const box = raw as Record<string, unknown>;

    x = asFiniteNumber(box.x ?? box.left ?? box.xmin ?? box.x_min ?? box.x1);
    y = asFiniteNumber(box.y ?? box.top ?? box.ymin ?? box.y_min ?? box.y1);
    w = asFiniteNumber(box.w ?? box.width);
    h = asFiniteNumber(box.h ?? box.height);

    const x2 = asFiniteNumber(box.x2 ?? box.xmax ?? box.x_max ?? box.right);
    const y2 = asFiniteNumber(box.y2 ?? box.ymax ?? box.y_max ?? box.bottom);

    if ((w == null || h == null) && x != null && y != null && x2 != null && y2 != null) {
      w = x2 - x;
      h = y2 - y;
    }
  } else {
    return null;
  }

  if (x == null || y == null || w == null || h == null) return null;
  if (w <= 0 || h <= 0) return null;

  const maxVal = Math.max(Math.abs(x), Math.abs(y), Math.abs(w), Math.abs(h), x + w, y + h);

  let nx: number;
  let ny: number;
  let nw: number;
  let nh: number;

  if (maxVal <= 1.0001) {
    // Already normalized 0–1
    nx = x;
    ny = y;
    nw = w;
    nh = h;
  } else if (maxVal <= 100.0001) {
    // Percent 0–100
    nx = x / 100;
    ny = y / 100;
    nw = w / 100;
    nh = h / 100;
  } else if (maxVal <= 1000.0001) {
    // Gemini-style 0–1000
    nx = x / 1000;
    ny = y / 1000;
    nw = w / 1000;
    nh = h / 1000;
  } else if (imageWidth && imageHeight && imageWidth > 0 && imageHeight > 0) {
    // Absolute pixels
    nx = x / imageWidth;
    ny = y / imageHeight;
    nw = w / imageWidth;
    nh = h / imageHeight;
  } else {
    // Last resort: assume 0–1000-like large units
    const scale = maxVal > 2000 ? maxVal : 1000;
    nx = x / scale;
    ny = y / scale;
    nw = w / scale;
    nh = h / scale;
  }

  nx = clamp01(nx);
  ny = clamp01(ny);
  nw = clamp01(nw);
  nh = clamp01(nh);

  // Keep box inside image
  nw = Math.min(nw, 1 - nx);
  nh = Math.min(nh, 1 - ny);

  if (nw < 0.005 || nh < 0.005) return null;

  return { x: nx, y: ny, w: nw, h: nh };
}

export function expandBox(box: BubbleBox, padding = 0.04): BubbleBox {
  const px = box.w * padding;
  const py = box.h * padding;
  const x = clamp01(box.x - px);
  const y = clamp01(box.y - py);
  const w = Math.min(1 - x, box.w + px * 2);
  const h = Math.min(1 - y, box.h + py * 2);
  return { x, y, w, h };
}

/** Shrink box inward so we stay inside the bubble and away from its outline. */
export function insetBox(box: BubbleBox, padding = 0.08): BubbleBox {
  const px = Math.min(box.w * padding, box.w * 0.35);
  const py = Math.min(box.h * padding, box.h * 0.35);
  const w = Math.max(0.004, box.w - px * 2);
  const h = Math.max(0.004, box.h - py * 2);
  return {
    x: clamp01(box.x + px),
    y: clamp01(box.y + py),
    w,
    h,
  };
}
