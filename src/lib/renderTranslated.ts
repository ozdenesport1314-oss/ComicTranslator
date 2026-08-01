import { expandBox } from "./boxes";
import type { BubbleBox, BubbleTranslation } from "./types";

/**
 * Comic erase/render pipeline (BallonsTranslator / manga-image-translator style):
 *
 * PART 1  Balonu bulma
 * PART 2  Yazı türünü anlama (light/dark, paper color)
 * PART 3  Sınırı tanımlama + redzone
 * PART 4  Yazıyı tanıma (***** harf ink mask)
 * PART 6  Yazıyı silme (sadece harf pikseli — dikdörtgen/balon boyama YOK)
 * PART 7  Sınırı zorunlu koruma (redzone’a yazma yasağı)
 * PART 9  Hasar kontrolü (kalan yazı + sınır bozulması)
 * PART 10 Sınırı geri onarma (snapshot restore)
 * PART 11 Çeviri — yalnızca PART 9 %99 temiz derse
 */

export type RenderOptions = {
  showRedzone?: boolean;
};

type PxBox = { x: number; y: number; w: number; h: number };
type Rgb = { r: number; g: number; b: number };
type TextKind = {
  mode: "light" | "dark";
  fill: Rgb;
  cut: number;
};

type Boundary = {
  interior: Uint8Array;
  redzone: Uint8Array;
  stroke: Uint8Array;
  bounds: PxBox | null;
  /** Original RGBA snapshot of redzone+stroke neighborhood for PART 10 */
  borderBackup: ImageData;
  backupX: number;
  backupY: number;
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

/** PART 1 — Balonu bulma */
function part1FindBubble(bubble: BubbleTranslation): BubbleBox {
  return bubble.bubbleBox ?? expandBox(bubble.box, 0.25);
}

function clipTextInsideBubble(text: PxBox, bubble: PxBox): PxBox {
  const x = Math.max(text.x, bubble.x + bubble.w * 0.03);
  const y = Math.max(text.y, bubble.y + bubble.h * 0.03);
  const r = Math.min(text.x + text.w, bubble.x + bubble.w * 0.97);
  const b = Math.min(text.y + text.h, bubble.y + bubble.h * 0.97);
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

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function luminance(r: number, g: number, b: number) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function isProtected(
  gx: number,
  gy: number,
  width: number,
  height: number,
  redzone: Uint8Array,
  stroke: Uint8Array,
  pad = 1,
): boolean {
  if (gx < 0 || gy < 0 || gx >= width || gy >= height) return true;
  for (let dy = -pad; dy <= pad; dy += 1) {
    for (let dx = -pad; dx <= pad; dx += 1) {
      const nx = gx + dx;
      const ny = gy + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) return true;
      const g = ny * width + nx;
      if (redzone[g] || stroke[g]) return true;
    }
  }
  return false;
}

function canEraseAt(
  gx: number,
  gy: number,
  width: number,
  height: number,
  interior: Uint8Array,
  redzone: Uint8Array,
  stroke: Uint8Array,
): boolean {
  if (gx < 0 || gy < 0 || gx >= width || gy >= height) return false;
  const g = gy * width + gx;
  if (!interior[g]) return false;
  if (isProtected(gx, gy, width, height, redzone, stroke, 2)) return false;
  return true;
}

/** PART 2 — Yazı türünü anlama */
function part2UnderstandTextType(
  ctx: CanvasRenderingContext2D,
  textPx: PxBox,
  width: number,
  height: number,
): TextKind {
  const x0 = Math.max(0, Math.floor(textPx.x));
  const y0 = Math.max(0, Math.floor(textPx.y));
  const x1 = Math.min(width, Math.ceil(textPx.x + textPx.w));
  const y1 = Math.min(height, Math.ceil(textPx.y + textPx.h));
  const rw = Math.max(1, x1 - x0);
  const rh = Math.max(1, y1 - y0);
  const img = ctx.getImageData(x0, y0, rw, rh);
  const { data } = img;

  const lums: number[] = [];
  const papers: Rgb[] = [];
  for (let p = 0, i = 0; p < rw * rh; p += 1, i += 4) {
    const v = luminance(data[i], data[i + 1], data[i + 2]);
    lums.push(v);
  }
  lums.sort((a, b) => a - b);
  const med = lums[Math.floor(lums.length / 2)] ?? 220;
  const mode: "light" | "dark" = med >= 115 ? "light" : "dark";

  for (let p = 0, i = 0; p < rw * rh; p += 1, i += 4) {
    const v = luminance(data[i], data[i + 1], data[i + 2]);
    const paper = mode === "light" ? v >= 185 : v <= 55;
    if (paper) papers.push({ r: data[i], g: data[i + 1], b: data[i + 2] });
  }

  const fill: Rgb = (() => {
    if (!papers.length) {
      return mode === "light"
        ? { r: 252, g: 252, b: 252 }
        : { r: 12, g: 12, b: 12 };
    }
    return {
      r: Math.round(median(papers.map((p) => p.r))),
      g: Math.round(median(papers.map((p) => p.g))),
      b: Math.round(median(papers.map((p) => p.b))),
    };
  })();

  const darkRef = lums[Math.floor(lums.length * 0.12)] ?? 40;
  const lightRef = lums[Math.floor(lums.length * 0.88)] ?? 230;
  const cut =
    mode === "light"
      ? Math.min(145, Math.max(95, darkRef + 42))
      : Math.max(110, Math.min(185, lightRef - 45));

  return { mode, fill, cut };
}

/**
 * PART 3 — Sınırı tanımlama
 * Flood-fill paper from text seed; stop hard on dark stroke (light bubbles).
 * NO ellipse/rect fallback that paints art white.
 */
function part3DefineBoundary(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  bubblePx: PxBox,
  textPx: PxBox,
  kind: TextKind,
): Boundary {
  const x0 = Math.max(0, Math.floor(bubblePx.x));
  const y0 = Math.max(0, Math.floor(bubblePx.y));
  const x1 = Math.min(width, Math.ceil(bubblePx.x + bubblePx.w));
  const y1 = Math.min(height, Math.ceil(bubblePx.y + bubblePx.h));
  const rw = x1 - x0;
  const rh = y1 - y0;

  const empty: Boundary = {
    interior: new Uint8Array(width * height),
    redzone: new Uint8Array(width * height),
    stroke: new Uint8Array(width * height),
    bounds: null,
    borderBackup: ctx.createImageData(1, 1),
    backupX: 0,
    backupY: 0,
  };
  if (rw < 6 || rh < 6) return empty;

  const img = ctx.getImageData(x0, y0, rw, rh);
  const { data } = img;
  const lum = new Float32Array(rw * rh);
  for (let p = 0, i = 0; p < rw * rh; p += 1, i += 4) {
    lum[p] = luminance(data[i], data[i + 1], data[i + 2]);
  }

  const { mode } = kind;
  const local = new Uint8Array(rw * rh);
  const q = new Int32Array(rw * rh);
  let qh = 0;
  let qt = 0;

  // Strict paper walk — do not cross mid-gray art (prevents face white-out)
  const paperEnter = (p: number) => {
    const v = lum[p];
    if (mode === "light") return v >= 168;
    return v <= 85;
  };

  const seeds = [
    [textPx.x + textPx.w * 0.5, textPx.y + textPx.h * 0.5],
    [textPx.x + textPx.w * 0.35, textPx.y + textPx.h * 0.4],
    [textPx.x + textPx.w * 0.65, textPx.y + textPx.h * 0.4],
    [textPx.x + textPx.w * 0.5, textPx.y + textPx.h * 0.65],
  ];

  for (const [sx, sy] of seeds) {
    const x = Math.floor(sx - x0);
    const y = Math.floor(sy - y0);
    if (x < 1 || y < 1 || x >= rw - 1 || y >= rh - 1) continue;
    const p = y * rw + x;
    if (!paperEnter(p)) continue;
    local[p] = 1;
    q[qt++] = p;
    break;
  }

  // Fallback seed: brightest/darkest paper pixel inside text box
  if (qt === 0) {
    const tx0 = Math.max(1, Math.floor(textPx.x - x0));
    const ty0 = Math.max(1, Math.floor(textPx.y - y0));
    const tx1 = Math.min(rw - 1, Math.ceil(textPx.x + textPx.w - x0));
    const ty1 = Math.min(rh - 1, Math.ceil(textPx.y + textPx.h - y0));
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
    if (best >= 0 && paperEnter(best)) {
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
      if (!paperEnter(n)) continue;
      local[n] = 1;
      q[qt++] = n;
    }
  }

  // Grow into ink islands fully surrounded by paper (letters inside bubble)
  for (let iter = 0; iter < 14; iter += 1) {
    const add: number[] = [];
    for (let y = 1; y < rh - 1; y += 1) {
      for (let x = 1; x < rw - 1; x += 1) {
        const p = y * rw + x;
        if (local[p]) continue;
        // Only absorb dark/light ink-like pixels, never mid-art
        const v = lum[p];
        const inkLike =
          mode === "light" ? v <= kind.cut + 15 : v >= kind.cut - 15;
        if (!inkLike) continue;
        let c = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx || dy) if (local[(y + dy) * rw + (x + dx)]) c += 1;
          }
        }
        if (c >= 5) add.push(p);
      }
    }
    if (!add.length) break;
    for (const p of add) local[p] = 1;
  }

  // If flood tiny: restrict erase zone to inset text ellipse (letters only later)
  let count = 0;
  for (let i = 0; i < local.length; i += 1) if (local[i]) count += 1;
  if (count < 40) {
    const cx = textPx.x + textPx.w * 0.5 - x0;
    const cy = textPx.y + textPx.h * 0.5 - y0;
    const rx = Math.max(4, textPx.w * 0.42);
    const ry = Math.max(4, textPx.h * 0.42);
    for (let y = 0; y < rh; y += 1) {
      for (let x = 0; x < rw; x += 1) {
        const nx = (x - cx) / rx;
        const ny = (y - cy) / ry;
        if (nx * nx + ny * ny <= 1) local[y * rw + x] = 1;
      }
    }
  }

  const raw = new Uint8Array(local);

  // Stroke candidates: dark pixels adjacent to interior paper
  const strokeLocal = new Uint8Array(rw * rh);
  for (let y = 1; y < rh - 1; y += 1) {
    for (let x = 1; x < rw - 1; x += 1) {
      const p = y * rw + x;
      if (raw[p]) continue;
      const v = lum[p];
      const isStroke = mode === "light" ? v < 95 : v > 165;
      if (!isStroke) continue;
      let near = false;
      for (let dy = -2; dy <= 2 && !near; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const np = (y + dy) * rw + (x + dx);
          if (np >= 0 && np < rw * rh && raw[np]) {
            near = true;
            break;
          }
        }
      }
      if (near) strokeLocal[p] = 1;
    }
  }

  // PART 7 prep: erode interior → redzone band (never erase here)
  let layer = raw;
  for (let pass = 0; pass < 6; pass += 1) {
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
  const stroke = new Uint8Array(width * height);

  for (let y = 0; y < rh; y += 1) {
    for (let x = 0; x < rw; x += 1) {
      const p = y * rw + x;
      const g = (y0 + y) * width + (x0 + x);
      if (strokeLocal[p]) stroke[g] = 1;
      if (raw[p] && !layer[p]) redzone[g] = 1;
      else if (layer[p]) interior[g] = 1;
    }
  }

  // Expand redzone to cover stroke neighborhood
  const redExpand = new Uint8Array(redzone);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const g = y * width + x;
      if (!stroke[g] && !redzone[g]) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          redExpand[ny * width + nx] = 1;
          interior[ny * width + nx] = 0;
        }
      }
    }
  }

  let minX = rw;
  let minY = rh;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < rh; y += 1) {
    for (let x = 0; x < rw; x += 1) {
      if (!interior[(y0 + y) * width + (x0 + x)]) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  const bounds =
    maxX < 0
      ? null
      : { x: x0 + minX, y: y0 + minY, w: maxX - minX + 1, h: maxY - minY + 1 };

  // PART 10 backup: original border strip
  const borderBackup = ctx.getImageData(x0, y0, rw, rh);

  return {
    interior,
    redzone: redExpand,
    stroke,
    bounds,
    borderBackup,
    backupX: x0,
    backupY: y0,
  };
}

/** PART 4 — Yazıyı tanıma: ***** harf ink components */
function part4RecognizeTextInk(
  data: Uint8ClampedArray,
  rw: number,
  rh: number,
  x0: number,
  y0: number,
  width: number,
  height: number,
  interior: Uint8Array,
  redzone: Uint8Array,
  stroke: Uint8Array,
  kind: TextKind,
  sensitive: boolean,
): Uint8Array {
  const lum = new Float32Array(rw * rh);
  for (let p = 0, i = 0; p < rw * rh; p += 1, i += 4) {
    lum[p] = luminance(data[i], data[i + 1], data[i + 2]);
  }

  const cut = sensitive
    ? kind.mode === "light"
      ? Math.min(160, kind.cut + 18)
      : Math.max(95, kind.cut - 18)
    : kind.cut;

  const ink = new Uint8Array(rw * rh);
  for (let p = 0; p < rw * rh; p += 1) {
    const gx = x0 + (p % rw);
    const gy = y0 + Math.floor(p / rw);
    if (!canEraseAt(gx, gy, width, height, interior, redzone, stroke)) continue;
    const isInk = kind.mode === "light" ? lum[p] <= cut : lum[p] >= cut;
    if (isInk) ink[p] = 1;
  }

  // Connected components — reject giant solid blobs (rect artifacts)
  const labels = new Int32Array(rw * rh).fill(-1);
  const keep = new Uint8Array(rw * rh);
  const stack: number[] = [];
  const minSize = sensitive ? 2 : 4;
  const maxArea = Math.max(80, Math.floor(rw * rh * 0.12));

  for (let start = 0; start < rw * rh; start += 1) {
    if (!ink[start] || labels[start] >= 0) continue;
    const pixels: number[] = [];
    let minX = rw;
    let minY = rh;
    let maxX = -1;
    let maxY = -1;
    labels[start] = 1;
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
          labels[np] = 1;
          stack.push(np);
        }
      }
    }
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const fillRatio = pixels.length / Math.max(1, bw * bh);
    const solidRect = fillRatio > 0.78 && pixels.length > 40 && bw > 8 && bh > 8;
    const tooBig = pixels.length > maxArea;
    if (pixels.length >= minSize && !tooBig && !solidRect) {
      for (const p of pixels) keep[p] = 1;
    }
  }

  // Dilate 1px (antialias halo) — still letter-shaped, not a box
  const out = new Uint8Array(keep);
  for (let y = 1; y < rh - 1; y += 1) {
    for (let x = 1; x < rw - 1; x += 1) {
      const p = y * rw + x;
      if (keep[p]) continue;
      if (
        keep[p - 1] ||
        keep[p + 1] ||
        keep[p - rw] ||
        keep[p + rw]
      ) {
        const gx = x0 + x;
        const gy = y0 + y;
        if (canEraseAt(gx, gy, width, height, interior, redzone, stroke)) {
          out[p] = 1;
        }
      }
    }
  }
  return out;
}

function samplePaperNear(
  data: Uint8ClampedArray,
  lum: Float32Array,
  p: number,
  rw: number,
  rh: number,
  kind: TextKind,
): Rgb {
  const y = Math.floor(p / rw);
  const x = p - y * rw;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let dy = -4; dy <= 4; dy += 1) {
    for (let dx = -4; dx <= 4; dx += 1) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= rw || ny >= rh) continue;
      const np = ny * rw + nx;
      const v = lum[np];
      const paper =
        kind.mode === "light" ? v > kind.cut + 35 : v < kind.cut - 35;
      if (!paper) continue;
      const i = np * 4;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n += 1;
    }
  }
  if (!n) return kind.fill;
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
}

/** PART 6 — Yazıyı silme: sadece ***** mask pikselleri */
function part6EraseLetters(
  data: Uint8ClampedArray,
  mask: Uint8Array,
  rw: number,
  rh: number,
  kind: TextKind,
): number {
  const lum = new Float32Array(rw * rh);
  for (let p = 0, i = 0; p < rw * rh; p += 1, i += 4) {
    lum[p] = luminance(data[i], data[i + 1], data[i + 2]);
  }
  let wiped = 0;
  for (let p = 0; p < rw * rh; p += 1) {
    if (!mask[p]) continue;
    const paper = samplePaperNear(data, lum, p, rw, rh, kind);
    const i = p * 4;
    data[i] = paper.r;
    data[i + 1] = paper.g;
    data[i + 2] = paper.b;
    data[i + 3] = 255;
    wiped += 1;
  }
  return wiped;
}

/** PART 6b — Telea-benzeri inpaint (sadece kalan ink mask) */
function part6TeleaPass(
  data: Uint8ClampedArray,
  mask: Uint8Array,
  rw: number,
  rh: number,
  x0: number,
  y0: number,
  width: number,
  height: number,
  interior: Uint8Array,
  redzone: Uint8Array,
  stroke: Uint8Array,
): number {
  let active = new Uint8Array(mask);
  // Drop protected pixels from mask
  for (let p = 0; p < rw * rh; p += 1) {
    if (!active[p]) continue;
    const gx = x0 + (p % rw);
    const gy = y0 + Math.floor(p / rw);
    if (!canEraseAt(gx, gy, width, height, interior, redzone, stroke)) {
      active[p] = 0;
    }
  }

  let wiped = 0;
  for (let pass = 0; pass < 10; pass += 1) {
    const next = new Uint8Array(active);
    const updates: Array<{ p: number; r: number; g: number; b: number }> = [];
    for (let y = 1; y < rh - 1; y += 1) {
      for (let x = 1; x < rw - 1; x += 1) {
        const p = y * rw + x;
        if (!active[p]) continue;
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
            if (active[np]) continue;
            const gx = x0 + nx;
            const gy = y0 + ny;
            if (!canEraseAt(gx, gy, width, height, interior, redzone, stroke) &&
                !interior[gy * width + gx]) {
              continue;
            }
            // Prefer already-clean paper neighbors
            if (redzone[gy * width + gx] || stroke[gy * width + gx]) continue;
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
    active = next;
  }
  return wiped;
}

/**
 * PART 7 + PART 10 — Sınırı zorunlu koruma ve geri onarma.
 * Redzone/stroke (+1px halo) orijinal snapshot’tan geri yüklenir.
 */
function part10RepairBoundaryWithWidth(
  ctx: CanvasRenderingContext2D,
  boundary: Boundary,
  width: number,
): void {
  const { borderBackup, backupX, backupY, redzone, stroke } = boundary;
  const rw = borderBackup.width;
  const rh = borderBackup.height;
  const cur = ctx.getImageData(backupX, backupY, rw, rh);
  for (let y = 0; y < rh; y += 1) {
    for (let x = 0; x < rw; x += 1) {
      const gx = backupX + x;
      const gy = backupY + y;
      const g = gy * width + gx;
      // Restore redzone, stroke, and 1px halo (balon hasarı geri al)
      let restore = !!(redzone[g] || stroke[g]);
      if (!restore) {
        for (let dy = -1; dy <= 1 && !restore; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = gx + dx;
            const ny = gy + dy;
            if (nx < 0 || ny < 0 || nx >= width) continue;
            const ng = ny * width + nx;
            if (redzone[ng] || stroke[ng]) restore = true;
          }
        }
      }
      if (!restore) continue;
      const i = (y * rw + x) * 4;
      cur.data[i] = borderBackup.data[i];
      cur.data[i + 1] = borderBackup.data[i + 1];
      cur.data[i + 2] = borderBackup.data[i + 2];
      cur.data[i + 3] = borderBackup.data[i + 3];
    }
  }
  ctx.putImageData(cur, backupX, backupY);
}

/**
 * Bağlantı: PART 4→6→7→9 loop → 10 → clean?
 * Dikdörtgen / balon boyama YOK.
 */
function eraseUntilClean(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  textPx: PxBox,
  boundary: Boundary,
  kind: TextKind,
): boolean {
  const { interior, redzone, stroke, bounds } = boundary;
  if (!bounds) return false;

  // Text-focused crop only (no bubble-wide white fill)
  const pad = Math.max(2, Math.min(textPx.w, textPx.h) * 0.06);
  const rx0 = Math.max(0, Math.floor(textPx.x - pad));
  const ry0 = Math.max(0, Math.floor(textPx.y - pad));
  const rx1 = Math.min(width, Math.ceil(textPx.x + textPx.w + pad));
  const ry1 = Math.min(height, Math.ceil(textPx.y + textPx.h + pad));
  const rw = rx1 - rx0;
  const rh = ry1 - ry0;
  if (rw < 2 || rh < 2) return false;

  for (let round = 0; round < 5; round += 1) {
    const img = ctx.getImageData(rx0, ry0, rw, rh);
    const { data } = img;

    // PART 4
    const mask = part4RecognizeTextInk(
      data,
      rw,
      rh,
      rx0,
      ry0,
      width,
      height,
      interior,
      redzone,
      stroke,
      kind,
      round >= 1,
    );

    // PART 6
    if (round === 0 || round === 2 || round === 4) {
      part6EraseLetters(data, mask, rw, rh, kind);
    } else {
      part6TeleaPass(
        data,
        mask,
        rw,
        rh,
        rx0,
        ry0,
        width,
        height,
        interior,
        redzone,
        stroke,
      );
    }

    ctx.putImageData(img, rx0, ry0);

    // PART 7 + 10 — sınır zorunlu geri
    part10RepairBoundaryWithWidth(ctx, boundary, width);

    // PART 9 — kalan yazı + sınır
    part10RepairBoundaryWithWidth(ctx, boundary, width);
    const after = ctx.getImageData(rx0, ry0, rw, rh);
    const inkMask = part4RecognizeTextInk(
      after.data,
      rw,
      rh,
      rx0,
      ry0,
      width,
      height,
      interior,
      redzone,
      stroke,
      kind,
      true,
    );
    let leftover = 0;
    for (let p = 0; p < inkMask.length; p += 1) if (inkMask[p]) leftover += 1;

    // Border damage vs snapshot
    const bak = boundary.borderBackup;
    const full = ctx.getImageData(boundary.backupX, boundary.backupY, bak.width, bak.height);
    let borderDamage = 0;
    let borderChecked = 0;
    for (let y = 0; y < bak.height; y += 1) {
      for (let x = 0; x < bak.width; x += 1) {
        const gx = boundary.backupX + x;
        const gy = boundary.backupY + y;
        const g = gy * width + gx;
        if (!redzone[g] && !stroke[g]) continue;
        borderChecked += 1;
        const i = (y * bak.width + x) * 4;
        const delta =
          Math.abs(full.data[i] - bak.data[i]) +
          Math.abs(full.data[i + 1] - bak.data[i + 1]) +
          Math.abs(full.data[i + 2] - bak.data[i + 2]);
        if (delta > 40) borderDamage += 1;
      }
    }
    if (borderDamage > 0) {
      part10RepairBoundaryWithWidth(ctx, boundary, width);
    }

    const borderOk =
      borderChecked === 0 || borderDamage / borderChecked <= 0.01;
    if (leftover <= 8 && borderOk) {
      part10RepairBoundaryWithWidth(ctx, boundary, width);
      return true;
    }
  }

  part10RepairBoundaryWithWidth(ctx, boundary, width);
  // Final ink check
  const finalImg = ctx.getImageData(rx0, ry0, rw, rh);
  const finalMask = part4RecognizeTextInk(
    finalImg.data,
    rw,
    rh,
    rx0,
    ry0,
    width,
    height,
    interior,
    redzone,
    stroke,
    kind,
    true,
  );
  let leftover = 0;
  for (let p = 0; p < finalMask.length; p += 1) if (finalMask[p]) leftover += 1;
  return leftover <= 8;
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
  const lineHeight = fontSize * 1.08;
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

/** PART 11 — Çeviri (yalnızca temiz + interior clip) */
function part11WriteTranslation(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  text: string,
  original: string,
  textPx: PxBox,
  bounds: PxBox,
  kind: TextKind,
  interior: Uint8Array,
  redzone: Uint8Array,
  stroke: Uint8Array,
) {
  const origLines = estimateLineCount(original || text);
  const targetFont = Math.max(
    11,
    Math.min(60, (Math.min(textPx.h, bounds.h) / origLines) * 0.7),
  );

  const padX = Math.max(6, bounds.w * 0.16);
  const padY = Math.max(6, bounds.h * 0.16);
  const x = bounds.x + padX;
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
  lctx.fillStyle = kind.mode === "light" ? "#111111" : "#ffffff";
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

  const bx0 = Math.max(0, Math.floor(bounds.x));
  const by0 = Math.max(0, Math.floor(bounds.y));
  const bx1 = Math.min(width, Math.ceil(bounds.x + bounds.w));
  const by1 = Math.min(height, Math.ceil(bounds.y + bounds.h));
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
      if (!interior[g] || redzone[g] || stroke[g]) continue;
      if (isProtected(gx, gy, width, height, redzone, stroke, 1)) continue;
      const a = src.data[li + 3] / 255;
      dst.data[li] = Math.round(src.data[li] * a + dst.data[li] * (1 - a));
      dst.data[li + 1] = Math.round(
        src.data[li + 1] * a + dst.data[li + 1] * (1 - a),
      );
      dst.data[li + 2] = Math.round(
        src.data[li + 2] * a + dst.data[li + 2] * (1 - a),
      );
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
      overlay.data[px + 1] = Math.min(
        255,
        overlay.data[px + 1] * 0.45 + 210 * 0.55,
      );
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

/** Hepsini bağlama */
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
  let skippedDirty = 0;

  for (const bubble of ordered) {
    if (!bubble.translated?.trim() || !bubble.box) continue;

    // PART 1
    const bubblePx = toPx(part1FindBubble(bubble), width, height);
    const textPx = clipTextInsideBubble(
      toPx(bubble.box, width, height),
      bubblePx,
    );

    // PART 2
    const kind = part2UnderstandTextType(ctx, textPx, width, height);

    // PART 3 (+ backup for PART 10)
    const boundary = part3DefineBoundary(
      ctx,
      width,
      height,
      bubblePx,
      textPx,
      kind,
    );
    if (!boundary.bounds) continue;

    // PART 4 → 6 → 7 → 9 → 10 loop
    const clean = eraseUntilClean(ctx, width, height, textPx, boundary, kind);

    // PART 10 final
    part10RepairBoundaryWithWidth(ctx, boundary, width);

    if (options.showRedzone) {
      drawDebug(
        ctx,
        width,
        height,
        bubblePx,
        textPx,
        boundary.interior,
        boundary.redzone,
      );
    }

    // PART 11 — yazı silinmeden çeviri YOK
    if (!clean) {
      skippedDirty += 1;
      continue;
    }

    part11WriteTranslation(
      ctx,
      width,
      height,
      bubble.translated,
      bubble.original,
      textPx,
      boundary.bounds,
      kind,
      boundary.interior,
      boundary.redzone,
      boundary.stroke,
    );
    // Keep border pristine after text draw
    part10RepairBoundaryWithWidth(ctx, boundary, width);
    painted += 1;
  }

  if (painted === 0) {
    throw new Error(
      skippedDirty > 0
        ? `Yazı silme %99 eşiğini geçemedi (${skippedDirty} balon). Temiz orijinal yükleyip tekrar dene.`
        : "Balon/yazı algılanamadı. Temiz orijinal yükleyip tekrar dene.",
    );
  }

  return zemin.toDataURL("image/jpeg", 0.92);
}
