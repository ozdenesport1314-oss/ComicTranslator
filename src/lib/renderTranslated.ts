import { expandBox } from "./boxes";
import type { BubbleBox, BubbleTranslation } from "./types";

export type RenderOptions = {
  showRedzone?: boolean;
};

type PxBox = { x: number; y: number; w: number; h: number };
type Rgb = { r: number; g: number; b: number };

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
    await document.fonts.load('800 48px "Bangers"');
    await document.fonts.load('700 48px "Comic Neue"');
  } catch {
    // fallback stack still works
  }
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
  return bubble.bubbleBox ?? expandBox(bubble.box, 0.22);
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

function sampleRegionMode(
  lum: Float32Array,
  data: Uint8ClampedArray,
  rw: number,
  rh: number,
  x0: number,
  y0: number,
  box: PxBox,
): { mode: "light" | "dark"; fill: Rgb } {
  const tx0 = Math.max(0, Math.floor(box.x - x0));
  const ty0 = Math.max(0, Math.floor(box.y - y0));
  const tx1 = Math.min(rw, Math.ceil(box.x + box.w - x0));
  const ty1 = Math.min(rh, Math.ceil(box.y + box.h - y0));

  const samples: number[] = [];
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;

  for (let y = ty0; y < ty1; y += 2) {
    for (let x = tx0; x < tx1; x += 2) {
      const p = y * rw + x;
      samples.push(lum[p]);
      const i = p * 4;
      // Prefer near-paper / near-ink extremes for fill color
      if (lum[p] > 200 || lum[p] < 50) {
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        n += 1;
      }
    }
  }

  samples.sort((a, c) => a - c);
  const mid = samples[Math.floor(samples.length / 2)] ?? 220;
  const mode: "light" | "dark" = mid >= 120 ? "light" : "dark";

  if (n > 0) {
    return {
      mode,
      fill:
        mode === "light"
          ? { r: 255, g: 255, b: 255 }
          : {
              r: Math.round(r / n),
              g: Math.round(g / n),
              b: Math.round(b / n),
            },
    };
  }

  return mode === "light"
    ? { mode, fill: { r: 255, g: 255, b: 255 } }
    : { mode, fill: { r: 0, g: 0, b: 0 } };
}

function segmentBubbleInterior(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  bubblePx: PxBox,
  textPx: PxBox,
): {
  interior: Uint8Array;
  redzone: Uint8Array;
  bounds: PxBox | null;
  fill: Rgb;
  mode: "light" | "dark";
} {
  const pad = 6;
  const x0 = Math.max(0, Math.floor(bubblePx.x - pad));
  const y0 = Math.max(0, Math.floor(bubblePx.y - pad));
  const x1 = Math.min(width, Math.ceil(bubblePx.x + bubblePx.w + pad));
  const y1 = Math.min(height, Math.ceil(bubblePx.y + bubblePx.h + pad));
  const rw = x1 - x0;
  const rh = y1 - y0;

  const interior = new Uint8Array(width * height);
  const redzone = new Uint8Array(width * height);
  const fallback = {
    interior,
    redzone,
    bounds: null as PxBox | null,
    fill: { r: 255, g: 255, b: 255 },
    mode: "light" as const,
  };
  if (rw < 4 || rh < 4) return fallback;

  const img = ctx.getImageData(x0, y0, rw, rh);
  const { data } = img;
  const lum = new Float32Array(rw * rh);
  for (let i = 0, p = 0; p < rw * rh; p += 1, i += 4) {
    lum[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }

  const { mode, fill } = sampleRegionMode(lum, data, rw, rh, x0, y0, textPx);
  const sorted = Float32Array.from(lum).sort();
  const hi = sorted[Math.floor(sorted.length * 0.8)] ?? 240;
  const lo = sorted[Math.floor(sorted.length * 0.2)] ?? 30;

  // Walkable fill vs hard border depends on bubble type
  const walkMin = mode === "light" ? Math.min(195, hi - 40) : 0;
  const walkMax = mode === "light" ? 255 : Math.max(70, lo + 45);
  const borderCut = mode === "light" ? 75 : 190;

  const isWalkable = (v: number) =>
    mode === "light" ? v >= walkMin : v <= walkMax;
  const isHardBorder = (v: number) =>
    mode === "light" ? v < borderCut : v > borderCut;

  const local = new Uint8Array(rw * rh);
  const queue = new Int32Array(rw * rh);
  let qh = 0;
  let qt = 0;

  const trySeed = (sx: number, sy: number) => {
    const lx = Math.floor(sx - x0);
    const ly = Math.floor(sy - y0);
    if (lx < 0 || ly < 0 || lx >= rw || ly >= rh) return false;
    const p = ly * rw + lx;
    if (!isWalkable(lum[p])) return false;
    local[p] = 1;
    queue[qt++] = p;
    return true;
  };

  const seeds: Array<[number, number]> = [
    [textPx.x + textPx.w / 2, textPx.y + textPx.h / 2],
    [textPx.x + textPx.w * 0.35, textPx.y + textPx.h * 0.4],
    [textPx.x + textPx.w * 0.65, textPx.y + textPx.h * 0.4],
    [textPx.x + textPx.w * 0.5, textPx.y + textPx.h * 0.65],
    [bubblePx.x + bubblePx.w / 2, bubblePx.y + bubblePx.h / 2],
  ];

  let seeded = false;
  for (const [sx, sy] of seeds) {
    if (trySeed(sx, sy)) {
      seeded = true;
      break;
    }
  }

  if (!seeded) {
    let best = -1;
    let bestScore = mode === "light" ? -1 : 999;
    const tx0 = Math.max(0, Math.floor(textPx.x - x0));
    const ty0 = Math.max(0, Math.floor(textPx.y - y0));
    const tx1 = Math.min(rw, Math.ceil(textPx.x + textPx.w - x0));
    const ty1 = Math.min(rh, Math.ceil(textPx.y + textPx.h - y0));
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
      queue[qt++] = best;
      seeded = true;
    }
  }
  if (!seeded) return { ...fallback, fill, mode };

  while (qh < qt) {
    const p = queue[qh++];
    const y = Math.floor(p / rw);
    const x = p - y * rw;
    for (const n of [p - 1, p + 1, p - rw, p + rw]) {
      if (n < 0 || n >= rw * rh) continue;
      const ny = Math.floor(n / rw);
      const nx = n - ny * rw;
      if (Math.abs(nx - x) + Math.abs(ny - y) !== 1) continue;
      if (local[n]) continue;
      if (isHardBorder(lum[n])) continue;
      if (!isWalkable(lum[n])) continue;
      local[n] = 1;
      queue[qt++] = n;
    }
  }

  // Absorb opposite-tone text ink inside the bubble (thin strokes only)
  const growIters = Math.max(8, Math.floor(Math.min(rw, rh) * 0.05));
  for (let iter = 0; iter < growIters; iter += 1) {
    const add: number[] = [];
    for (let y = 1; y < rh - 1; y += 1) {
      for (let x = 1; x < rw - 1; x += 1) {
        const p = y * rw + x;
        if (local[p]) continue;
        if (isHardBorder(lum[p]) && !isWalkable(lum[p])) {
          // likely outline — skip unless heavily surrounded
          let c = 0;
          for (let dy = -1; dy <= 1; dy += 1) {
            for (let dx = -1; dx <= 1; dx += 1) {
              if (dx || dy) if (local[(y + dy) * rw + (x + dx)]) c += 1;
            }
          }
          if (c >= 6) add.push(p);
          continue;
        }
        let c = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx || dy) if (local[(y + dy) * rw + (x + dx)]) c += 1;
          }
        }
        if (c >= 3) add.push(p);
      }
    }
    if (!add.length) break;
    for (const p of add) local[p] = 1;
  }

  // Redzone = border pixels touching interior
  for (let y = 1; y < rh - 1; y += 1) {
    for (let x = 1; x < rw - 1; x += 1) {
      const p = y * rw + x;
      if (local[p]) continue;
      if (!isHardBorder(lum[p])) continue;
      let touch = false;
      for (let dy = -1; dy <= 1 && !touch; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (local[(y + dy) * rw + (x + dx)]) {
            touch = true;
            break;
          }
        }
      }
      if (touch) redzone[(y0 + y) * width + (x0 + x)] = 1;
    }
  }

  // Erode 1px so we never paint over the outline
  const eroded = new Uint8Array(rw * rh);
  for (let y = 1; y < rh - 1; y += 1) {
    for (let x = 1; x < rw - 1; x += 1) {
      const p = y * rw + x;
      if (!local[p]) continue;
      if (local[p - 1] && local[p + 1] && local[p - rw] && local[p + rw]) {
        eroded[p] = 1;
      }
    }
  }

  let minX = rw;
  let minY = rh;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < rh; y += 1) {
    for (let x = 0; x < rw; x += 1) {
      if (!eroded[y * rw + x]) continue;
      interior[(y0 + y) * width + (x0 + x)] = 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0) return { interior, redzone, bounds: null, fill, mode };

  // Normalize fill to clean comic colors
  const cleanFill =
    mode === "light"
      ? { r: 255, g: 255, b: 255 }
      : { r: 0, g: 0, b: 0 };

  return {
    interior,
    redzone,
    bounds: {
      x: x0 + minX,
      y: y0 + minY,
      w: maxX - minX + 1,
      h: maxY - minY + 1,
    },
    fill: cleanFill,
    mode,
  };
}

function wipeInteriorMask(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  interior: Uint8Array,
  bounds: PxBox,
  fill: Rgb,
) {
  const ix = Math.max(0, Math.floor(bounds.x));
  const iy = Math.max(0, Math.floor(bounds.y));
  const iw = Math.max(1, Math.min(width - ix, Math.ceil(bounds.w)));
  const ih = Math.max(1, Math.min(height - iy, Math.ceil(bounds.h)));
  const imageData = ctx.getImageData(ix, iy, iw, ih);
  const { data } = imageData;

  for (let row = 0; row < ih; row += 1) {
    for (let col = 0; col < iw; col += 1) {
      if (!interior[(iy + row) * width + (ix + col)]) continue;
      const i = (row * iw + col) * 4;
      data[i] = fill.r;
      data[i + 1] = fill.g;
      data[i + 2] = fill.b;
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(imageData, ix, iy);
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
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
): string {
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

function placeComicLettering(
  ctx: CanvasRenderingContext2D,
  text: string,
  original: string,
  textPx: PxBox,
  maskBounds: PxBox,
  mode: "light" | "dark",
) {
  const origLines = estimateLineCount(original || text);
  const targetFont = Math.max(12, Math.min(72, (textPx.h / origLines) * 0.82));

  // Margin inside bubble — like pro comics
  const padX = Math.max(4, maskBounds.w * 0.14);
  const padY = Math.max(4, maskBounds.h * 0.14);
  const x = maskBounds.x + padX;
  const y = maskBounds.y + padY;
  const w = Math.max(8, maskBounds.w - padX * 2);
  const h = Math.max(8, maskBounds.h - padY * 2);

  const minFont = Math.max(11, targetFont * 0.6);
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

  const near = textFits(ctx, fitted, w, h, Math.floor(targetFont));
  if (near.ok) {
    bestSize = Math.floor(targetFont);
    bestLines = near.lines;
    lineHeight = near.lineHeight;
  }

  ctx.font = comicFont(bestSize);
  ctx.fillStyle = mode === "light" ? "#111111" : "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const totalHeight = bestLines.length * lineHeight;
  const cx = textPx.x + textPx.w / 2;
  const cy = textPx.y + textPx.h / 2;
  const drawX = Math.min(Math.max(cx, x + 2), x + w - 2);
  let cursorY = cy - totalHeight / 2 + lineHeight / 2;

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
      overlay.data[px] = Math.min(255, overlay.data[px] * 0.3 + 255 * 0.7);
      overlay.data[px + 1] = overlay.data[px + 1] * 0.3;
      overlay.data[px + 2] = overlay.data[px + 2] * 0.3;
    } else if (interior[i]) {
      overlay.data[px] = overlay.data[px] * 0.5;
      overlay.data[px + 1] = Math.min(255, overlay.data[px + 1] * 0.5 + 200 * 0.5);
      overlay.data[px + 2] = overlay.data[px + 2] * 0.5;
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
 * Pro-comic style pipeline (like clean scanlation/lettering):
 * zemin → bubble shape mask → fill bubble color → comic lettering
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
    const textPx = toPx(bubble.box, width, height);

    const { interior, redzone, bounds, fill, mode } = segmentBubbleInterior(
      ctx,
      width,
      height,
      bubblePx,
      textPx,
    );
    if (!bounds) continue;

    if (options.showRedzone) {
      drawDebug(ctx, width, height, bubblePx, textPx, interior, redzone);
    }

    wipeInteriorMask(ctx, width, height, interior, bounds, fill);

    const placeBox: PxBox = {
      x: Math.max(bounds.x, textPx.x - textPx.w * 0.05),
      y: Math.max(bounds.y, textPx.y - textPx.h * 0.05),
      w: 0,
      h: 0,
    };
    placeBox.w =
      Math.min(bounds.x + bounds.w, textPx.x + textPx.w * 1.05) - placeBox.x;
    placeBox.h =
      Math.min(bounds.y + bounds.h, textPx.y + textPx.h * 1.05) - placeBox.y;
    if (placeBox.w < 8 || placeBox.h < 8) {
      placeBox.x = bounds.x;
      placeBox.y = bounds.y;
      placeBox.w = bounds.w;
      placeBox.h = bounds.h;
    }

    placeComicLettering(
      ctx,
      bubble.translated,
      bubble.original,
      textPx,
      placeBox,
      mode,
    );
    painted += 1;
  }

  if (painted === 0) {
    throw new Error(
      "Baloncuk şekli algılanamadı. Sayfayı tekrar çevirmeyi dene.",
    );
  }

  return zemin.toDataURL("image/jpeg", 0.92);
}
