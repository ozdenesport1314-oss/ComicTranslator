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
  const fill: Rgb =
    mode === "light" ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };

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

  const interior = new Uint8Array(width * height);
  const redzone = new Uint8Array(width * height);

  // Erode 1px — mask stays strictly inside border
  for (let y = 1; y < rh - 1; y += 1) {
    for (let x = 1; x < rw - 1; x += 1) {
      const p = y * rw + x;
      if (!local[p]) continue;
      if (!(local[p - 1] && local[p + 1] && local[p - rw] && local[p + rw])) {
        redzone[(y0 + y) * width + (x0 + x)] = 1;
        continue;
      }
      interior[(y0 + y) * width + (x0 + x)] = 1;
    }
  }

  const bounds = boundsFromMask(interior, width, height, x0, y0, rw, rh);
  return { interior, redzone, bounds, fill, mode };
}

/**
 * STEP: yazıları harf harf maskele (a b c → * * *)
 * - Sadece mürekkep / harf bileşenlerini siler
 * - Tüm balonu beyaza BOYAMAZ
 * - Balon sınırı (interior) dışına ASLA çıkmaz
 */
function maskLettersInsideBoundary(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  textPx: PxBox,
  interior: Uint8Array,
  mode: "light" | "dark",
  fill: Rgb,
) {
  // Tight text region — small pad only for glyph edges, not whole bubble
  const pad = Math.max(2, Math.min(textPx.w, textPx.h) * 0.03);
  const x0 = Math.max(0, Math.floor(textPx.x - pad));
  const y0 = Math.max(0, Math.floor(textPx.y - pad));
  const x1 = Math.min(width, Math.ceil(textPx.x + textPx.w + pad));
  const y1 = Math.min(height, Math.ceil(textPx.y + textPx.h + pad));
  const rw = x1 - x0;
  const rh = y1 - y0;
  if (rw < 2 || rh < 2) return;

  const img = ctx.getImageData(x0, y0, rw, rh);
  const { data } = img;
  const n = rw * rh;
  const lum = new Float32Array(n);
  for (let p = 0, i = 0; p < n; p += 1, i += 4) {
    lum[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }

  // Ink vs paper depending on bubble type
  const ink = new Uint8Array(n);
  for (let p = 0; p < n; p += 1) {
    const gx = x0 + (p % rw);
    const gy = y0 + Math.floor(p / rw);
    if (!interior[gy * width + gx]) continue; // bubble boundary clamp
    const isInk = mode === "light" ? lum[p] < 175 : lum[p] > 70;
    if (isInk) ink[p] = 1;
  }

  // Connected components = individual letters/glyphs
  const labels = new Int32Array(n).fill(-1);
  let label = 0;
  const stack: number[] = [];
  const components: number[][] = [];

  for (let start = 0; start < n; start += 1) {
    if (!ink[start] || labels[start] >= 0) continue;
    const pixels: number[] = [];
    labels[start] = label;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop() as number;
      pixels.push(p);
      const y = Math.floor(p / rw);
      const x = p - y * rw;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= rw || ny >= rh) continue;
        const np = ny * rw + nx;
        if (!ink[np] || labels[np] >= 0) continue;
        labels[np] = label;
        stack.push(np);
      }
    }
    // Drop tiny noise speckles; keep real letter blobs
    if (pixels.length >= 6) components.push(pixels);
    label += 1;
  }

  // Dilate each letter slightly, then paint only those pixels with paper color
  const dilate = 1;
  const wipe = new Uint8Array(n);
  for (const pixels of components) {
    for (const p of pixels) {
      const y = Math.floor(p / rw);
      const x = p - y * rw;
      for (let dy = -dilate; dy <= dilate; dy += 1) {
        for (let dx = -dilate; dx <= dilate; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= rw || ny >= rh) continue;
          const gx = x0 + nx;
          const gy = y0 + ny;
          if (!interior[gy * width + gx]) continue;
          wipe[ny * rw + nx] = 1;
        }
      }
    }
  }

  for (let p = 0; p < n; p += 1) {
    if (!wipe[p]) continue;
    const i = p * 4;
    data[i] = fill.r;
    data[i + 1] = fill.g;
    data[i + 2] = fill.b;
    data[i + 3] = 255;
  }

  ctx.putImageData(img, x0, y0);
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

/** STEP: çeviriyi balon sınırları içine yaz */
function writeTranslationInsideBubble(
  ctx: CanvasRenderingContext2D,
  text: string,
  original: string,
  textPx: PxBox,
  bounds: PxBox,
  mode: "light" | "dark",
) {
  const origLines = estimateLineCount(original || text);
  const targetFont = Math.max(12, Math.min(72, (textPx.h / origLines) * 0.8));

  const padX = Math.max(4, bounds.w * 0.14);
  const padY = Math.max(4, bounds.h * 0.14);
  const x = bounds.x + padX;
  const y = bounds.y + padY;
  const w = Math.max(8, bounds.w - padX * 2);
  const h = Math.max(8, bounds.h - padY * 2);

  const minFont = Math.max(11, targetFont * 0.55);
  const fitted = condenseToFit(ctx, text, w, h, minFont);

  let low = minFont;
  let high = targetFont;
  let bestSize = minFont;
  let bestLines = wrapText(ctx, fitted, w);
  let lineHeight = bestSize * 1.05;

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

  ctx.font = comicFont(bestSize);
  ctx.fillStyle = mode === "light" ? "#111111" : "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const totalHeight = bestLines.length * lineHeight;
  // Center of refined bubble interior (not old wrong text box)
  const cx = bounds.x + bounds.w / 2;
  const cy = bounds.y + bounds.h / 2;
  let cursorY = cy - totalHeight / 2 + lineHeight / 2;
  const drawX = Math.min(Math.max(cx, x + 2), x + w - 2);

  for (const line of bestLines) {
    ctx.fillText(line, drawX, cursorY, w);
    cursorY += lineHeight;
  }
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
 * Zincir:
 * 1) Yazıları algıla
 * 2) Balonları algıla
 * 3) Balon sınırını algıla
 * 4) Yazıları HARF HARF maskele (balonu boyama)
 * 5) Balon sınırını tekrar algıla
 * 6) Çeviriyi balon içine yaz
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

    // 1-2) yazı + balon
    const bubblePx = toPx(resolveBubbleBox(bubble), width, height);
    const textPx = clipTextInsideBubble(toPx(bubble.box, width, height), bubblePx);

    // 3) balon sınırı
    let seg = detectBubbleBoundary(ctx, width, height, bubblePx, textPx);
    if (!seg.bounds) continue;

    // 4) harf harf maskele — tüm balonu boyama
    maskLettersInsideBoundary(
      ctx,
      width,
      height,
      textPx,
      seg.interior,
      seg.mode,
      seg.fill,
    );

    // 5) sınır tekrar
    seg = detectBubbleBoundary(ctx, width, height, bubblePx, textPx);
    if (!seg.bounds) continue;

    if (options.showRedzone) {
      drawDebug(ctx, width, height, bubblePx, textPx, seg.interior, seg.redzone);
    }

    // 6) çeviriyi balon içine yaz (yerleşim textBox merkezine yakın, sınır içinde)
    const place: PxBox = {
      x: Math.max(seg.bounds.x, textPx.x),
      y: Math.max(seg.bounds.y, textPx.y),
      w:
        Math.min(seg.bounds.x + seg.bounds.w, textPx.x + textPx.w) -
        Math.max(seg.bounds.x, textPx.x),
      h:
        Math.min(seg.bounds.y + seg.bounds.h, textPx.y + textPx.h) -
        Math.max(seg.bounds.y, textPx.y),
    };
    if (place.w < 8 || place.h < 8) {
      place.x = seg.bounds.x;
      place.y = seg.bounds.y;
      place.w = seg.bounds.w;
      place.h = seg.bounds.h;
    }

    writeTranslationInsideBubble(
      ctx,
      bubble.translated,
      bubble.original,
      textPx,
      place,
      seg.mode,
    );
    painted += 1;
  }

  if (painted === 0) {
    throw new Error(
      "Baloncuk/yazı zinciri başarısız. Sayfayı tekrar çevirmeyi dene.",
    );
  }

  return zemin.toDataURL("image/jpeg", 0.92);
}
