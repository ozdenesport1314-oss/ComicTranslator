import { expandBox } from "./boxes";
import type { BubbleBox, BubbleTranslation } from "./types";

export type RenderOptions = {
  showRedzone?: boolean;
};

type PxBox = { x: number; y: number; w: number; h: number };
type Rgb = { r: number; g: number; b: number };
type SegResult = {
  interior: Uint8Array;
  redzone: Uint8Array;
  bounds: PxBox | null;
  fill: Rgb;
  mode: "light" | "dark";
};

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Görsel yüklenemedi"));
    img.src = src;
  });
}

async function ensureComicFont() {
  if (typeof document === "undefined" || !document.fonts?.load) return;
  try {
    await document.fonts.load('400 48px "Bangers"');
    await document.fonts.load('700 48px "Comic Neue"');
  } catch {
    /* ignore */
  }
}

function comicFontStack() {
  if (typeof document === "undefined") {
    return '"Bangers", "Comic Neue", "Arial Black", Impact, sans-serif';
  }
  const loaded = getComputedStyle(document.documentElement)
    .getPropertyValue("--font-comic")
    .trim();
  return loaded
    ? `${loaded}, "Bangers", "Comic Neue", "Arial Black", Impact, sans-serif`
    : '"Bangers", "Comic Neue", "Arial Black", Impact, sans-serif';
}

function comicFont(size: number) {
  return `400 ${size}px ${comicFontStack()}`;
}

function toPx(box: BubbleBox, width: number, height: number): PxBox {
  return {
    x: box.x * width,
    y: box.y * height,
    w: Math.max(1, box.w * width),
    h: Math.max(1, box.h * height),
  };
}

function resolveBubbleBox(bubble: BubbleTranslation): BubbleBox {
  return bubble.bubbleBox ?? expandBox(bubble.box, 0.25);
}

/** textBox must stay inside bubbleBox */
function clipTextInsideBubble(text: PxBox, bubble: PxBox): PxBox {
  const x = Math.max(text.x, bubble.x + bubble.w * 0.04);
  const y = Math.max(text.y, bubble.y + bubble.h * 0.04);
  const r = Math.min(text.x + text.w, bubble.x + bubble.w * 0.96);
  const b = Math.min(text.y + text.h, bubble.y + bubble.h * 0.96);
  return {
    x,
    y,
    w: Math.max(4, r - x),
    h: Math.max(4, b - y),
  };
}

function estimateLineCount(text: string): number {
  const explicit = text.split(/\n+/).filter(Boolean).length;
  if (explicit > 1) return explicit;
  return Math.max(1, Math.min(8, Math.ceil(text.length / 16)));
}

function comicCase(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s*\.\.\.\s*/g, "…")
    .trim()
    .toLocaleUpperCase("tr-TR");
}

function emptySeg(width: number, height: number): SegResult {
  return {
    interior: new Uint8Array(width * height),
    redzone: new Uint8Array(width * height),
    bounds: null,
    fill: { r: 255, g: 255, b: 255 },
    mode: "light",
  };
}

function boundsFromMask(
  mask: Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  rw: number,
  rh: number,
): PxBox | null {
  let minX = rw;
  let minY = rh;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < rh; y += 1) {
    for (let x = 0; x < rw; x += 1) {
      if (!mask[(y0 + y) * width + (x0 + x)]) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: x0 + minX, y: y0 + minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * STEP: balon sınırlarını algıla
 * Flood-fill bubble interior, constrained to bubbleBox.
 * Outer ring stops on dark strokes (outline); inner area may cross text ink.
 */
function detectBubbleBoundary(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  bubblePx: PxBox,
  textPx: PxBox,
): SegResult {
  const x0 = Math.max(0, Math.floor(bubblePx.x));
  const y0 = Math.max(0, Math.floor(bubblePx.y));
  const x1 = Math.min(width, Math.ceil(bubblePx.x + bubblePx.w));
  const y1 = Math.min(height, Math.ceil(bubblePx.y + bubblePx.h));
  const rw = x1 - x0;
  const rh = y1 - y0;
  if (rw < 6 || rh < 6) return emptySeg(width, height);

  const img = ctx.getImageData(x0, y0, rw, rh);
  const { data } = img;
  const lum = new Float32Array(rw * rh);
  for (let p = 0, i = 0; p < rw * rh; p += 1, i += 4) {
    lum[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }

  // Mode from text region median
  const samples: number[] = [];
  const tx0 = Math.max(0, Math.floor(textPx.x - x0));
  const ty0 = Math.max(0, Math.floor(textPx.y - y0));
  const tx1 = Math.min(rw, Math.ceil(textPx.x + textPx.w - x0));
  const ty1 = Math.min(rh, Math.ceil(textPx.y + textPx.h - y0));
  for (let y = ty0; y < ty1; y += 2) {
    for (let x = tx0; x < tx1; x += 2) samples.push(lum[y * rw + x]);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)] ?? 220;
  const mode: "light" | "dark" = median >= 110 ? "light" : "dark";
  // Paper color from text-region percentiles (not hardcoded white → no gray blocks)
  const paperSamples: Rgb[] = [];
  for (let y = ty0; y < ty1; y += 2) {
    for (let x = tx0; x < tx1; x += 2) {
      const v = lum[y * rw + x];
      const paperLike = mode === "light" ? v >= 170 : v <= 70;
      if (!paperLike) continue;
      const i = (y * rw + x) * 4;
      paperSamples.push({ r: data[i], g: data[i + 1], b: data[i + 2] });
    }
  }
  const fill: Rgb = (() => {
    if (!paperSamples.length) {
      return mode === "light"
        ? { r: 255, g: 255, b: 255 }
        : { r: 8, g: 8, b: 8 };
    }
    const rs = paperSamples.map((p) => p.r).sort((a, b) => a - b);
    const gs = paperSamples.map((p) => p.g).sort((a, b) => a - b);
    const bs = paperSamples.map((p) => p.b).sort((a, b) => a - b);
    const mid = Math.floor(paperSamples.length / 2);
    return { r: rs[mid], g: gs[mid], b: bs[mid] };
  })();

  const ring = 0.1;
  const local = new Uint8Array(rw * rh);
  const q = new Int32Array(rw * rh);
  let qh = 0;
  let qt = 0;

  const inRing = (x: number, y: number) =>
    x < rw * ring ||
    y < rh * ring ||
    x >= rw * (1 - ring) ||
    y >= rh * (1 - ring);

  const canEnter = (p: number, x: number, y: number) => {
    const v = lum[p];
    if (mode === "light") {
      // Outer ring: only bright paper (stop at black border)
      if (inRing(x, y)) return v >= 145;
      // Inner: allow paper + gray + text ink (will be wiped)
      return v >= 35;
    }
    // Dark bubble
    if (inRing(x, y)) return v <= 110;
    return v <= 220;
  };

  const seedPoints = [
    [textPx.x + textPx.w * 0.5, textPx.y + textPx.h * 0.5],
    [textPx.x + textPx.w * 0.3, textPx.y + textPx.h * 0.35],
    [textPx.x + textPx.w * 0.7, textPx.y + textPx.h * 0.35],
    [textPx.x + textPx.w * 0.5, textPx.y + textPx.h * 0.7],
    [bubblePx.x + bubblePx.w * 0.5, bubblePx.y + bubblePx.h * 0.5],
  ];

  for (const [sx, sy] of seedPoints) {
    const x = Math.floor(sx - x0);
    const y = Math.floor(sy - y0);
    if (x < 1 || y < 1 || x >= rw - 1 || y >= rh - 1) continue;
    const p = y * rw + x;
    if (!canEnter(p, x, y)) continue;
    local[p] = 1;
    q[qt++] = p;
    break;
  }

  // Fallback seed: best matching pixel in text box
  if (qt === 0) {
    let best = -1;
    let bestScore = mode === "light" ? -1 : 9999;
    for (let y = ty0; y < ty1; y += 1) {
      for (let x = tx0; x < tx1; x += 1) {
        const p = y * rw + x;
        const v = lum[p];
        if (mode === "light" ? v > bestScore : v < bestScore) {
          bestScore = v;
          best = p;
        }
      }
    }
    if (best >= 0) {
      local[best] = 1;
      q[qt++] = best;
    }
  }

  while (qh < qt) {
    const p = q[qh++];
    const y = Math.floor(p / rw);
    const x = p - y * rw;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= rw || ny >= rh) continue;
      const n = ny * rw + nx;
      if (local[n]) continue;
      if (!canEnter(n, nx, ny)) continue;
      local[n] = 1;
      q[qt++] = n;
    }
  }

  // Grow a few times into leftover ink fully surrounded by interior
  for (let iter = 0; iter < 10; iter += 1) {
    const add: number[] = [];
    for (let y = 1; y < rh - 1; y += 1) {
      for (let x = 1; x < rw - 1; x += 1) {
        const p = y * rw + x;
        if (local[p]) continue;
        let c = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx || dy) if (local[(y + dy) * rw + (x + dx)]) c += 1;
          }
        }
        if (c >= 4) add.push(p);
      }
    }
    if (!add.length) break;
    for (const p of add) local[p] = 1;
  }

  // If flood captured almost nothing, fallback: soft ellipse inside bubble
  let count = 0;
  for (let i = 0; i < local.length; i += 1) if (local[i]) count += 1;
  if (count < rw * rh * 0.08) {
    const cx = rw / 2;
    const cy = rh / 2;
    const rx = rw * 0.42;
    const ry = rh * 0.42;
    for (let y = 0; y < rh; y += 1) {
      for (let x = 0; x < rw; x += 1) {
        const nx = (x - cx) / rx;
        const ny = (y - cy) / ry;
        if (nx * nx + ny * ny <= 1) local[y * rw + x] = 1;
      }
    }
  }

  const raw = new Uint8Array(rw * rh);
  for (let i = 0; i < local.length; i += 1) raw[i] = local[i];

  // Strong border redzone (BallonsTranslator-style bubble erode): never touch stroke
  let layer = raw;
  for (let pass = 0; pass < 5; pass += 1) {
    const next = new Uint8Array(rw * rh);
    for (let y = 1; y < rh - 1; y += 1) {
      for (let x = 1; x < rw - 1; x += 1) {
        const p = y * rw + x;
        if (!layer[p]) continue;
        if (
          layer[p - 1] &&
          layer[p + 1] &&
          layer[p - rw] &&
          layer[p + rw] &&
          layer[p - rw - 1] &&
          layer[p - rw + 1] &&
          layer[p + rw - 1] &&
          layer[p + rw + 1]
        ) {
          next[p] = 1;
        }
      }
    }
    layer = next;
  }

  const interior = new Uint8Array(width * height);
  const redzone = new Uint8Array(width * height);

  for (let y = 0; y < rh; y += 1) {
    for (let x = 0; x < rw; x += 1) {
      const p = y * rw + x;
      const g = (y0 + y) * width + (x0 + x);
      if (raw[p] && !layer[p]) {
        redzone[g] = 1; // forbidden band near balloon stroke
      } else if (layer[p]) {
        interior[g] = 1; // safe mask zone only
      }
    }
  }

  const bounds = boundsFromMask(interior, width, height, x0, y0, rw, rh);
  return { interior, redzone, bounds, fill, mode };
}

function isSafeMaskPixel(
  gx: number,
  gy: number,
  width: number,
  height: number,
  interior: Uint8Array,
  redzone: Uint8Array,
): boolean {
  if (gx < 0 || gy < 0 || gx >= width || gy >= height) return false;
  const g = gy * width + gx;
  if (!interior[g] || redzone[g]) return false;
  // Extra guard: neighbors must not be redzone (mask never kisses the line)
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const nx = gx + dx;
      const ny = gy + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) return false;
      if (redzone[ny * width + nx]) return false;
    }
  }
  return true;
}

function readRegionLum(data: Uint8ClampedArray, n: number): Float32Array {
  const lum = new Float32Array(n);
  for (let p = 0, i = 0; p < n; p += 1, i += 4) {
    lum[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return lum;
}

function inkThreshold(
  lum: Float32Array,
  rw: number,
  rh: number,
  x0: number,
  y0: number,
  width: number,
  height: number,
  interior: Uint8Array,
  redzone: Uint8Array,
  mode: "light" | "dark",
  sensitive: boolean,
): number {
  const vals: number[] = [];
  for (let p = 0; p < lum.length; p += 1) {
    const gx = x0 + (p % rw);
    const gy = y0 + Math.floor(p / rw);
    if (!isSafeMaskPixel(gx, gy, width, height, interior, redzone)) continue;
    vals.push(lum[p]);
  }
  if (!vals.length) return mode === "light" ? 120 : 140;
  vals.sort((a, b) => a - b);
  const darkRef = vals[Math.floor(vals.length * 0.1)] ?? 35;
  const paperRef = vals[Math.floor(vals.length * 0.9)] ?? 245;
  if (mode === "light") {
    // Strict: only real dark ink, never mid paper (prevents white rectangles)
    return Math.min(sensitive ? 135 : 120, Math.max(85, darkRef + (sensitive ? 45 : 30)));
  }
  return Math.max(sensitive ? 100 : 120, Math.min(190, paperRef - 50));
}

function isBorderStrokePixel(
  lum: Float32Array,
  p: number,
  rw: number,
  x0: number,
  y0: number,
  width: number,
  height: number,
  redzone: Uint8Array,
  mode: "light" | "dark",
): boolean {
  const y = Math.floor(p / rw);
  const x = p - y * rw;
  const gx = x0 + x;
  const gy = y0 + y;
  if (redzone[gy * width + gx]) return true;
  const v = lum[p];
  const dark = mode === "light" ? v < 85 : v > 170;
  if (!dark) return false;
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      const nx = gx + dx;
      const ny = gy + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) return true;
      if (redzone[ny * width + nx]) return true;
    }
  }
  return false;
}

/** ***** detector: letter ink components only */
function detectLetterPatches(
  lum: Float32Array,
  rw: number,
  rh: number,
  x0: number,
  y0: number,
  width: number,
  height: number,
  interior: Uint8Array,
  redzone: Uint8Array,
  mode: "light" | "dark",
  sensitive: boolean,
): number[][] {
  const cut = inkThreshold(
    lum,
    rw,
    rh,
    x0,
    y0,
    width,
    height,
    interior,
    redzone,
    mode,
    sensitive,
  );
  const ink = new Uint8Array(rw * rh);
  for (let p = 0; p < rw * rh; p += 1) {
    const gx = x0 + (p % rw);
    const gy = y0 + Math.floor(p / rw);
    if (!isSafeMaskPixel(gx, gy, width, height, interior, redzone)) continue;
    if (isBorderStrokePixel(lum, p, rw, x0, y0, width, height, redzone, mode)) {
      continue;
    }
    const isInk = mode === "light" ? lum[p] <= cut : lum[p] >= cut;
    if (isInk) ink[p] = 1;
  }

  const labels = new Int32Array(rw * rh).fill(-1);
  const components: number[][] = [];
  const stack: number[] = [];
  let label = 0;
  const minSize = sensitive ? 3 : 5;
  const maxArea = Math.max(60, Math.floor(rw * rh * 0.08));

  for (let start = 0; start < rw * rh; start += 1) {
    if (!ink[start] || labels[start] >= 0) continue;
    const pixels: number[] = [];
    let minX = rw;
    let minY = rh;
    let maxX = -1;
    let maxY = -1;
    labels[start] = label;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop() as number;
      pixels.push(p);
      const y = Math.floor(p / rw);
      const x = p - y * rw;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= rw || ny >= rh) continue;
          const np = ny * rw + nx;
          if (!ink[np] || labels[np] >= 0) continue;
          labels[np] = label;
          stack.push(np);
        }
      }
    }
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const fillRatio = pixels.length / Math.max(1, bw * bh);
    const tooBig =
      pixels.length > maxArea || (bw > rw * 0.65 && bh > rh * 0.5);
    const solidRect = fillRatio > 0.7 && pixels.length > 35;
    if (pixels.length >= minSize && !tooBig && !solidRect) components.push(pixels);
    label += 1;
  }
  return components;
}

function localPaperColor(
  data: Uint8ClampedArray,
  lum: Float32Array,
  p: number,
  rw: number,
  rh: number,
  mode: "light" | "dark",
  cut: number,
): Rgb {
  const y = Math.floor(p / rw);
  const x = p - y * rw;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let dy = -3; dy <= 3; dy += 1) {
    for (let dx = -3; dx <= 3; dx += 1) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= rw || ny >= rh) continue;
      const np = ny * rw + nx;
      const v = lum[np];
      const paper = mode === "light" ? v > cut + 40 : v < cut - 40;
      if (!paper) continue;
      const i = np * 4;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n += 1;
    }
  }
  if (!n) {
    return mode === "light"
      ? { r: 255, g: 255, b: 255 }
      : { r: 0, g: 0, b: 0 };
  }
  return {
    r: Math.round(r / n),
    g: Math.round(g / n),
    b: Math.round(b / n),
  };
}

/** Dilate ink mask 1px so antialias halo also gets erased (still not a rectangle). */
function dilateInkMask(ink: Uint8Array, rw: number, rh: number): Uint8Array {
  const out = new Uint8Array(ink);
  for (let y = 1; y < rh - 1; y += 1) {
    for (let x = 1; x < rw - 1; x += 1) {
      const p = y * rw + x;
      if (ink[p]) continue;
      if (
        ink[p - 1] ||
        ink[p + 1] ||
        ink[p - rw] ||
        ink[p + rw] ||
        ink[p - rw - 1] ||
        ink[p - rw + 1] ||
        ink[p + rw - 1] ||
        ink[p + rw + 1]
      ) {
        out[p] = 1;
      }
    }
  }
  return out;
}

function buildInkMask(
  lum: Float32Array,
  rw: number,
  rh: number,
  x0: number,
  y0: number,
  width: number,
  height: number,
  interior: Uint8Array,
  redzone: Uint8Array,
  mode: "light" | "dark",
  cut: number,
  dilate: boolean,
): Uint8Array {
  const ink = new Uint8Array(rw * rh);
  for (let p = 0; p < rw * rh; p += 1) {
    const gx = x0 + (p % rw);
    const gy = y0 + Math.floor(p / rw);
    if (!isSafeMaskPixel(gx, gy, width, height, interior, redzone)) continue;
    if (isBorderStrokePixel(lum, p, rw, x0, y0, width, height, redzone, mode)) {
      continue;
    }
    const isInk = mode === "light" ? lum[p] <= cut : lum[p] >= cut;
    if (isInk) ink[p] = 1;
  }
  return dilate ? dilateInkMask(ink, rw, rh) : ink;
}

/** Method A: ***** letter erase — ONLY glyph pixels (+1px halo), never a box fill */
function eraseMethodLetterPatches(
  data: Uint8ClampedArray,
  lum: Float32Array,
  components: number[][],
  rw: number,
  rh: number,
  x0: number,
  y0: number,
  width: number,
  height: number,
  interior: Uint8Array,
  redzone: Uint8Array,
  mode: "light" | "dark",
  cut: number,
): number {
  const ink = new Uint8Array(rw * rh);
  for (const pixels of components) {
    for (const p of pixels) ink[p] = 1;
  }
  const mask = dilateInkMask(ink, rw, rh);
  let wiped = 0;
  for (let p = 0; p < rw * rh; p += 1) {
    if (!mask[p]) continue;
    const gx = x0 + (p % rw);
    const gy = y0 + Math.floor(p / rw);
    if (!isSafeMaskPixel(gx, gy, width, height, interior, redzone)) continue;
    if (isBorderStrokePixel(lum, p, rw, x0, y0, width, height, redzone, mode)) {
      continue;
    }
    const paper = localPaperColor(data, lum, p, rw, rh, mode, cut);
    const i = p * 4;
    data[i] = paper.r;
    data[i + 1] = paper.g;
    data[i + 2] = paper.b;
    data[i + 3] = 255;
    wiped += 1;
  }
  return wiped;
}

/**
 * Method B (farklı program): OpenCV Telea-benzeri patch inpaint.
 * Sadece ink mask piksellerini komşu kağıtla doldurur — dikdörtgen yok.
 */
function eraseMethodTeleaInpaint(
  data: Uint8ClampedArray,
  lum: Float32Array,
  rw: number,
  rh: number,
  x0: number,
  y0: number,
  width: number,
  height: number,
  interior: Uint8Array,
  redzone: Uint8Array,
  mode: "light" | "dark",
  cut: number,
): number {
  let mask = buildInkMask(
    lum,
    rw,
    rh,
    x0,
    y0,
    width,
    height,
    interior,
    redzone,
    mode,
    mode === "light" ? cut + 10 : cut - 10,
    true,
  );
  // Drop any mask pixel that touches redzone neighborhood
  for (let p = 0; p < rw * rh; p += 1) {
    if (!mask[p]) continue;
    const gx = x0 + (p % rw);
    const gy = y0 + Math.floor(p / rw);
    if (!isSafeMaskPixel(gx, gy, width, height, interior, redzone)) mask[p] = 0;
  }

  let wiped = 0;
  for (let pass = 0; pass < 8; pass += 1) {
    const next = new Uint8Array(mask);
    const updates: Array<{ p: number; r: number; g: number; b: number }> = [];
    for (let y = 1; y < rh - 1; y += 1) {
      for (let x = 1; x < rw - 1; x += 1) {
        const p = y * rw + x;
        if (!mask[p]) continue;
        let wr = 0;
        let wg = 0;
        let wb = 0;
        let wsum = 0;
        for (let dy = -2; dy <= 2; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) {
            if (!dx && !dy) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= rw || ny >= rh) continue;
            const np = ny * rw + nx;
            if (mask[np]) continue;
            const gx = x0 + nx;
            const gy = y0 + ny;
            if (!isSafeMaskPixel(gx, gy, width, height, interior, redzone)) {
              continue;
            }
            const dist = Math.hypot(dx, dy);
            const w = 1 / (dist * dist);
            const i = np * 4;
            wr += data[i] * w;
            wg += data[i + 1] * w;
            wb += data[i + 2] * w;
            wsum += w;
          }
        }
        if (wsum < 0.01) continue;
        updates.push({
          p,
          r: Math.round(wr / wsum),
          g: Math.round(wg / wsum),
          b: Math.round(wb / wsum),
        });
        next[p] = 0;
      }
    }
    if (!updates.length) break;
    for (const u of updates) {
      const i = u.p * 4;
      data[i] = u.r;
      data[i + 1] = u.g;
      data[i + 2] = u.b;
      data[i + 3] = 255;
      wiped += 1;
    }
    mask = next;
  }
  return wiped;
}

/**
 * Method C (Koharu/Ballons bubble clean): balon İÇİNİ kağıt rengiyle boya.
 * Shape = flood-fill interior mask (balon şekli). Dikdörtgen / textBox fill YOK.
 * Redzone (çizgi) asla boyanmaz.
 */
function eraseMethodBubbleInteriorFill(
  data: Uint8ClampedArray,
  rw: number,
  rh: number,
  x0: number,
  y0: number,
  width: number,
  height: number,
  interior: Uint8Array,
  redzone: Uint8Array,
  fill: Rgb,
): number {
  let wiped = 0;
  for (let p = 0; p < rw * rh; p += 1) {
    const gx = x0 + (p % rw);
    const gy = y0 + Math.floor(p / rw);
    if (!isSafeMaskPixel(gx, gy, width, height, interior, redzone)) continue;
    const i = p * 4;
    data[i] = fill.r;
    data[i + 1] = fill.g;
    data[i + 2] = fill.b;
    data[i + 3] = 255;
    wiped += 1;
  }
  return wiped;
}

/** Detector: remaining text ink inside safe zone? */
function detectRemainingText(
  lum: Float32Array,
  rw: number,
  rh: number,
  x0: number,
  y0: number,
  width: number,
  height: number,
  interior: Uint8Array,
  redzone: Uint8Array,
  mode: "light" | "dark",
): { leftover: boolean; inkPixels: number; components: number } {
  const comps = detectLetterPatches(
    lum,
    rw,
    rh,
    x0,
    y0,
    width,
    height,
    interior,
    redzone,
    mode,
    true,
  );
  let inkPixels = 0;
  for (const c of comps) inkPixels += c.length;
  const leftover = comps.length >= 1 && inkPixels >= 10;
  return { leftover, inkPixels, components: comps.length };
}

/**
 * Endüstri zinciri (Koharu / BallonsTranslator / manga-image-translator):
 * A ***** harf mask → detector → C balon-içi paper fill (şekil maskesi) →
 * detector → B Telea inpaint → detector.
 * Çeviri YALNIZCA detector temiz derse yazılır (zorunlu C sonrası genelde temiz).
 */
function eraseTextGuarded(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  cleanRegion: PxBox,
  interior: Uint8Array,
  redzone: Uint8Array,
  mode: "light" | "dark",
  fill: Rgb,
): boolean {
  // Clean whole bubble interior bbox (not tiny textBox) — leftover Hangul outside box goes away
  const x0 = Math.max(0, Math.floor(cleanRegion.x));
  const y0 = Math.max(0, Math.floor(cleanRegion.y));
  const x1 = Math.min(width, Math.ceil(cleanRegion.x + cleanRegion.w));
  const y1 = Math.min(height, Math.ceil(cleanRegion.y + cleanRegion.h));
  const rw = x1 - x0;
  const rh = y1 - y0;
  if (rw < 2 || rh < 2) return false;

  const img = ctx.getImageData(x0, y0, rw, rh);
  const { data } = img;

  const runDetect = () => {
    const lum = readRegionLum(data, rw * rh);
    return {
      lum,
      cut: inkThreshold(
        lum,
        rw,
        rh,
        x0,
        y0,
        width,
        height,
        interior,
        redzone,
        mode,
        true,
      ),
      report: detectRemainingText(
        lum,
        rw,
        rh,
        x0,
        y0,
        width,
        height,
        interior,
        redzone,
        mode,
      ),
    };
  };

  // 1) Method A — ***** harf silme
  {
    const L = readRegionLum(data, rw * rh);
    const C = inkThreshold(
      L,
      rw,
      rh,
      x0,
      y0,
      width,
      height,
      interior,
      redzone,
      mode,
      false,
    );
    const comps = detectLetterPatches(
      L,
      rw,
      rh,
      x0,
      y0,
      width,
      height,
      interior,
      redzone,
      mode,
      false,
    );
    eraseMethodLetterPatches(
      data,
      L,
      comps,
      rw,
      rh,
      x0,
      y0,
      width,
      height,
      interior,
      redzone,
      mode,
      C,
    );
  }

  let d = runDetect();
  if (!d.report.leftover) {
    ctx.putImageData(img, x0, y0);
    return true;
  }

  // 2) Method C — balon içi paper restore (hedef görsellerdeki temiz balon)
  eraseMethodBubbleInteriorFill(
    data,
    rw,
    rh,
    x0,
    y0,
    width,
    height,
    interior,
    redzone,
    fill,
  );

  d = runDetect();
  if (!d.report.leftover) {
    ctx.putImageData(img, x0, y0);
    return true;
  }

  // 3) Method B — Telea inpaint (kalan ink)
  for (let round = 0; round < 2; round += 1) {
    d = runDetect();
    if (!d.report.leftover) break;
    eraseMethodTeleaInpaint(
      data,
      d.lum,
      rw,
      rh,
      x0,
      y0,
      width,
      height,
      interior,
      redzone,
      mode,
      d.cut,
    );
  }

  // Force: bubble fill again then accept (border still protected)
  eraseMethodBubbleInteriorFill(
    data,
    rw,
    rh,
    x0,
    y0,
    width,
    height,
    interior,
    redzone,
    fill,
  );

  const final = runDetect();
  ctx.putImageData(img, x0, y0);
  return !final.report.leftover;
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  const lines: string[] = [];
  let current = words[0];
  for (let i = 1; i < words.length; i += 1) {
    const next = `${current} ${words[i]}`;
    if (ctx.measureText(next).width <= maxWidth) current = next;
    else {
      lines.push(current);
      current = words[i];
    }
  }
  lines.push(current);
  return lines;
}

function textFits(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxHeight: number,
  fontSize: number,
) {
  ctx.font = comicFont(fontSize);
  const lines = wrapText(ctx, text, maxWidth);
  const lineHeight = fontSize * 1.05;
  const totalHeight = lines.length * lineHeight;
  const widest = Math.max(...lines.map((l) => ctx.measureText(l).width), 0);
  return { ok: totalHeight <= maxHeight && widest <= maxWidth, lines, lineHeight };
}

function condenseToFit(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxHeight: number,
  minFont: number,
) {
  let candidate = comicCase(text);
  if (textFits(ctx, candidate, maxWidth, maxHeight, minFont).ok) return candidate;
  candidate = candidate
    .replace(/\b(GERÇEKTEN|ASLINDA|YANİ|İŞTE|BİRAZ|OLDUKÇA)\b/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (textFits(ctx, candidate, maxWidth, maxHeight, minFont).ok) return candidate;

  const words = candidate.split(/\s+/).filter(Boolean);
  let low = 1;
  let high = words.length;
  let best = words[0] ?? candidate;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const slice = words.slice(0, mid).join(" ");
    const trial = mid < words.length ? `${slice}…` : slice;
    if (textFits(ctx, trial, maxWidth, maxHeight, minFont).ok) {
      best = trial;
      low = mid + 1;
    } else high = mid - 1;
  }
  return best;
}

/**
 * STEP: çeviriyi balon sınırları içine yaz.
 * Offscreen çiz → sadece interior∖redzone pikselleri composite (balon dışına çıkmaz).
 */
function writeTranslationInsideBubble(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  text: string,
  original: string,
  textPx: PxBox,
  bounds: PxBox,
  mode: "light" | "dark",
  interior: Uint8Array,
  redzone: Uint8Array,
) {
  const origLines = estimateLineCount(original || text);
  const targetFont = Math.max(12, Math.min(64, (Math.min(textPx.h, bounds.h) / origLines) * 0.72));

  const padX = Math.max(6, bounds.w * 0.16);
  const padY = Math.max(6, bounds.h * 0.16);
  const x = bounds.x + padX;
  const y = bounds.y + padY;
  const w = Math.max(8, bounds.w - padX * 2);
  const h = Math.max(8, bounds.h - padY * 2);

  const minFont = Math.max(10, targetFont * 0.5);
  const fitted = condenseToFit(ctx, text, w, h, minFont);

  let low = minFont;
  let high = targetFont;
  let bestSize = minFont;
  let bestLines = wrapText(ctx, fitted, w);
  let lineHeight = bestSize * 1.08;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const result = textFits(ctx, fitted, w, h, mid);
    if (result.ok) {
      bestSize = mid;
      bestLines = result.lines;
      lineHeight = result.lineHeight;
      low = mid + 1;
    } else high = mid - 1;
  }

  const layer = document.createElement("canvas");
  layer.width = width;
  layer.height = height;
  const lctx = layer.getContext("2d");
  if (!lctx) return;

  lctx.font = comicFont(bestSize);
  lctx.fillStyle = mode === "light" ? "#111111" : "#ffffff";
  lctx.textAlign = "center";
  lctx.textBaseline = "middle";

  const totalHeight = bestLines.length * lineHeight;
  const cx = bounds.x + bounds.w / 2;
  const cy = bounds.y + bounds.h / 2;
  let cursorY = cy - totalHeight / 2 + lineHeight / 2;
  const drawX = Math.min(Math.max(cx, x + 2), x + w - 2);

  for (const line of bestLines) {
    lctx.fillText(line, drawX, cursorY, w);
    cursorY += lineHeight;
  }

  // Composite only inside safe bubble interior — prevents overflow / border damage
  const bx0 = Math.max(0, Math.floor(bounds.x - 2));
  const by0 = Math.max(0, Math.floor(bounds.y - 2));
  const bx1 = Math.min(width, Math.ceil(bounds.x + bounds.w + 2));
  const by1 = Math.min(height, Math.ceil(bounds.y + bounds.h + 2));
  const bw = bx1 - bx0;
  const bh = by1 - by0;
  if (bw < 1 || bh < 1) return;

  const src = lctx.getImageData(bx0, by0, bw, bh);
  const dst = ctx.getImageData(bx0, by0, bw, bh);
  for (let y = 0; y < bh; y += 1) {
    for (let x = 0; x < bw; x += 1) {
      const li = (y * bw + x) * 4;
      if (src.data[li + 3] < 20) continue;
      const gx = bx0 + x;
      const gy = by0 + y;
      const g = gy * width + gx;
      if (!interior[g] || redzone[g]) continue;
      // Alpha blend text over cleaned bubble
      const a = src.data[li + 3] / 255;
      dst.data[li] = Math.round(src.data[li] * a + dst.data[li] * (1 - a));
      dst.data[li + 1] = Math.round(src.data[li + 1] * a + dst.data[li + 1] * (1 - a));
      dst.data[li + 2] = Math.round(src.data[li + 2] * a + dst.data[li + 2] * (1 - a));
      dst.data[li + 3] = 255;
    }
  }
  ctx.putImageData(dst, bx0, by0);
}

function drawDebug(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  bubblePx: PxBox,
  textPx: PxBox,
  interior: Uint8Array,
  redzone: Uint8Array,
) {
  const overlay = ctx.getImageData(0, 0, width, height);
  for (let i = 0; i < interior.length; i += 1) {
    const px = i * 4;
    if (redzone[i]) {
      overlay.data[px] = Math.min(255, overlay.data[px] * 0.25 + 255 * 0.75);
      overlay.data[px + 1] = overlay.data[px + 1] * 0.25;
      overlay.data[px + 2] = overlay.data[px + 2] * 0.25;
    } else if (interior[i]) {
      overlay.data[px] = overlay.data[px] * 0.45;
      overlay.data[px + 1] = Math.min(255, overlay.data[px + 1] * 0.45 + 210 * 0.55);
      overlay.data[px + 2] = overlay.data[px + 2] * 0.45;
    }
  }
  ctx.putImageData(overlay, 0, 0);
  ctx.save();
  ctx.lineWidth = Math.max(2, Math.min(width, height) * 0.0025);
  ctx.strokeStyle = "#ff7a00";
  ctx.strokeRect(bubblePx.x, bubblePx.y, bubblePx.w, bubblePx.h);
  ctx.strokeStyle = "#00d4ff";
  ctx.strokeRect(textPx.x, textPx.y, textPx.w, textPx.h);
  ctx.restore();
}

/**
 * Zincir (Koharu / BallonsTranslator taklidi, tarayıcıda):
 * 1) Yazı + balon kutuları
 * 2) Balon sınırı + redzone (çizgi dokunulmaz)
 * 3) ***** harf mask → detector → balon-içi fill → Telea
 * 4) Detector temiz değilse çeviri YAZILMAZ
 * 5) Temizse çeviri interior mask içine composite
 */
export async function renderTranslatedPage(
  imageDataUrl: string,
  bubbles: BubbleTranslation[],
  options: RenderOptions = {},
): Promise<string> {
  await ensureComicFont();

  const img = await loadImage(imageDataUrl);
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  if (!width || !height) throw new Error("Görsel boyutları okunamadı");

  const zemin = document.createElement("canvas");
  zemin.width = width;
  zemin.height = height;
  const ctx = zemin.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas desteklenmiyor");
  ctx.drawImage(img, 0, 0, width, height);

  const ordered = [...bubbles].sort((a, b) => a.readingOrder - b.readingOrder);
  let painted = 0;

  for (const bubble of ordered) {
    if (!bubble.translated?.trim() || !bubble.box) continue;

    const bubblePx = toPx(resolveBubbleBox(bubble), width, height);
    const textPx = clipTextInsideBubble(toPx(bubble.box, width, height), bubblePx);

    let seg = detectBubbleBoundary(ctx, width, height, bubblePx, textPx);
    if (!seg.bounds) continue;

    // Silme bölgesi = balon interior bounds (textBox dikdörtgeni değil)
    const cleanRegion = seg.bounds;
    const clean = eraseTextGuarded(
      ctx,
      width,
      height,
      cleanRegion,
      seg.interior,
      seg.redzone,
      seg.mode,
      seg.fill,
    );

    // Sınır tekrar
    seg = detectBubbleBoundary(ctx, width, height, bubblePx, textPx);
    if (!seg.bounds) continue;

    if (options.showRedzone) {
      drawDebug(ctx, width, height, bubblePx, textPx, seg.interior, seg.redzone);
    }

    // En önemlisi: yazı silinmeden çeviriye geçme
    if (!clean) continue;

    writeTranslationInsideBubble(
      ctx,
      width,
      height,
      bubble.translated,
      bubble.original,
      textPx,
      seg.bounds,
      seg.mode,
      seg.interior,
      seg.redzone,
    );
    painted += 1;
  }

  if (painted === 0) {
    throw new Error(
      "Yazı temizlenemedi veya balon algılanamadı. Temiz orijinal yükleyip tekrar dene.",
    );
  }

  return zemin.toDataURL("image/jpeg", 0.92);
}
