import { expandBox } from "./boxes";
import type { BubbleBox, BubbleTranslation } from "./types";

export type RenderOptions = {
  /** Draw detected zones: bubble bound, text bound, interior mask, redzone */
  showRedzone?: boolean;
};

type PxBox = { x: number; y: number; w: number; h: number };

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Görsel yüklenemedi"));
    img.src = src;
  });
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
  // Rough wrap estimate for Latin/Turkish manga lettering
  return Math.max(1, Math.min(8, Math.ceil(text.length / 18)));
}

/**
 * Segment the true bubble INTERIOR shape (not a rectangle).
 * 1) Flood-fill paper from a seed inside the bubble
 * 2) Grow into thin text ink so letters are included
 * 3) Stop at thick bubble outline
 */
function segmentBubbleInterior(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  bubblePx: PxBox,
  textPx: PxBox,
): {
  interior: Uint8Array; // full-image mask
  redzone: Uint8Array; // bubble border band (in ROI)
  bounds: PxBox | null;
} {
  const pad = 4;
  const x0 = Math.max(0, Math.floor(bubblePx.x - pad));
  const y0 = Math.max(0, Math.floor(bubblePx.y - pad));
  const x1 = Math.min(width, Math.ceil(bubblePx.x + bubblePx.w + pad));
  const y1 = Math.min(height, Math.ceil(bubblePx.y + bubblePx.h + pad));
  const rw = x1 - x0;
  const rh = y1 - y0;

  const interior = new Uint8Array(width * height);
  const redzone = new Uint8Array(width * height);
  if (rw < 4 || rh < 4) return { interior, redzone, bounds: null };

  const img = ctx.getImageData(x0, y0, rw, rh);
  const { data } = img;
  const lum = new Float32Array(rw * rh);
  for (let i = 0, p = 0; p < rw * rh; p += 1, i += 4) {
    lum[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }

  // Paper threshold: bright side of ROI
  const sorted = Float32Array.from(lum).sort();
  const paperRef = sorted[Math.floor(sorted.length * 0.75)] ?? 240;
  const paperCut = Math.min(210, Math.max(150, paperRef - 35));
  const hardBorder = 70;

  const local = new Uint8Array(rw * rh);
  const queue = new Int32Array(rw * rh);
  let qh = 0;
  let qt = 0;

  const trySeed = (sx: number, sy: number) => {
    const lx = Math.floor(sx - x0);
    const ly = Math.floor(sy - y0);
    if (lx < 0 || ly < 0 || lx >= rw || ly >= rh) return false;
    const p = ly * rw + lx;
    if (lum[p] < paperCut) return false;
    local[p] = 1;
    queue[qt++] = p;
    return true;
  };

  // Seeds: text center and nearby bright points (must be inside bubble)
  const seeds: Array<[number, number]> = [
    [textPx.x + textPx.w / 2, textPx.y + textPx.h / 2],
    [textPx.x + textPx.w * 0.35, textPx.y + textPx.h * 0.35],
    [textPx.x + textPx.w * 0.65, textPx.y + textPx.h * 0.35],
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
    // Fallback: brightest pixel inside text box
    let best = -1;
    let bestLum = -1;
    const tx0 = Math.max(0, Math.floor(textPx.x - x0));
    const ty0 = Math.max(0, Math.floor(textPx.y - y0));
    const tx1 = Math.min(rw, Math.ceil(textPx.x + textPx.w - x0));
    const ty1 = Math.min(rh, Math.ceil(textPx.y + textPx.h - y0));
    for (let y = ty0; y < ty1; y += 1) {
      for (let x = tx0; x < tx1; x += 1) {
        const p = y * rw + x;
        if (lum[p] > bestLum) {
          bestLum = lum[p];
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
  if (!seeded) return { interior, redzone, bounds: null };

  // Flood through paper; stop at hard border
  while (qh < qt) {
    const p = queue[qh++];
    const y = Math.floor(p / rw);
    const x = p - y * rw;
    const neigh = [p - 1, p + 1, p - rw, p + rw];
    for (const n of neigh) {
      if (n < 0 || n >= rw * rh) continue;
      const ny = Math.floor(n / rw);
      const nx = n - ny * rw;
      if (Math.abs(nx - x) + Math.abs(ny - y) !== 1) continue;
      if (local[n]) continue;
      if (lum[n] < hardBorder) continue; // bubble outline
      if (lum[n] < paperCut && lum[n] >= hardBorder) {
        // gray / soft edge — allow only if mostly paper-adjacent later via grow
        continue;
      }
      local[n] = 1;
      queue[qt++] = n;
    }
  }

  // Grow into thin text ink (absorb letters) without jumping thick outline
  const growIters = Math.max(6, Math.floor(Math.min(rw, rh) * 0.04));
  for (let iter = 0; iter < growIters; iter += 1) {
    const add: number[] = [];
    for (let y = 1; y < rh - 1; y += 1) {
      for (let x = 1; x < rw - 1; x += 1) {
        const p = y * rw + x;
        if (local[p]) continue;
        if (lum[p] > paperCut) {
          // bright hole
          let c = 0;
          if (local[p - 1]) c += 1;
          if (local[p + 1]) c += 1;
          if (local[p - rw]) c += 1;
          if (local[p + rw]) c += 1;
          if (c >= 2) add.push(p);
          continue;
        }
        if (lum[p] < hardBorder) continue; // don't eat outline
        // medium/dark text stroke: absorb if well surrounded by interior
        let c = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) continue;
            if (local[(y + dy) * rw + (x + dx)]) c += 1;
          }
        }
        if (c >= 4) add.push(p);
      }
    }
    if (!add.length) break;
    for (const p of add) local[p] = 1;
  }

  // Redzone = hard-dark pixels in ROI adjacent to interior (true bubble border)
  for (let y = 1; y < rh - 1; y += 1) {
    for (let x = 1; x < rw - 1; x += 1) {
      const p = y * rw + x;
      if (local[p]) continue;
      if (lum[p] > hardBorder) continue;
      let touch = false;
      for (let dy = -1; dy <= 1 && !touch; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (local[(y + dy) * rw + (x + dx)]) {
            touch = true;
            break;
          }
        }
      }
      if (touch) {
        const gx = x0 + x;
        const gy = y0 + y;
        redzone[gy * width + gx] = 1;
      }
    }
  }

  // Erode interior 1px so mask stays inside border (never cover outline)
  const eroded = new Uint8Array(rw * rh);
  for (let y = 1; y < rh - 1; y += 1) {
    for (let x = 1; x < rw - 1; x += 1) {
      const p = y * rw + x;
      if (!local[p]) continue;
      if (
        local[p - 1] &&
        local[p + 1] &&
        local[p - rw] &&
        local[p + rw]
      ) {
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
      const gx = x0 + x;
      const gy = y0 + y;
      interior[gy * width + gx] = 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0) return { interior, redzone, bounds: null };

  return {
    interior,
    redzone,
    bounds: {
      x: x0 + minX,
      y: y0 + minY,
      w: maxX - minX + 1,
      h: maxY - minY + 1,
    },
  };
}

/** Fill ONLY the bubble-shaped interior mask with white — no rectangles. */
function wipeInteriorMask(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  interior: Uint8Array,
  bounds: PxBox,
) {
  const ix = Math.max(0, Math.floor(bounds.x));
  const iy = Math.max(0, Math.floor(bounds.y));
  const iw = Math.max(1, Math.min(width - ix, Math.ceil(bounds.w)));
  const ih = Math.max(1, Math.min(height - iy, Math.ceil(bounds.h)));
  const imageData = ctx.getImageData(ix, iy, iw, ih);
  const { data } = imageData;

  for (let row = 0; row < ih; row += 1) {
    for (let col = 0; col < iw; col += 1) {
      const gx = ix + col;
      const gy = iy + row;
      if (!interior[gy * width + gx]) continue;
      const i = (row * iw + col) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
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
  const paragraphs = text.split(/\n+/);
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push("");
      continue;
    }
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
  }
  return lines;
}

function textFits(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxHeight: number,
  fontSize: number,
) {
  ctx.font = `700 ${fontSize}px Arial, "Helvetica Neue", sans-serif`;
  const lines = wrapText(ctx, text, maxWidth);
  const lineHeight = fontSize * 1.12;
  const totalHeight = lines.length * lineHeight;
  const widest = Math.max(...lines.map((l) => ctx.measureText(l).width), 0);
  return { ok: totalHeight <= maxHeight && widest <= maxWidth, lines };
}

function condenseToFit(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxHeight: number,
  minFont: number,
): string {
  let candidate = text.replace(/\s+/g, " ").replace(/\s*\.\.\.\s*/g, "…").trim();
  if (textFits(ctx, candidate, maxWidth, maxHeight, minFont).ok) return candidate;
  candidate = candidate
    .replace(
      /\b(gerçekten|aslında|açıkçası|şöyle ki|yani|işte|biraz|oldukça|kesinlikle)\b/gi,
      "",
    )
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.…!?])/g, "$1")
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

function placeTranslationInBubble(
  ctx: CanvasRenderingContext2D,
  text: string,
  original: string,
  textPx: PxBox,
  maskBounds: PxBox,
) {
  // Target size ≈ original lettering size from text box height / lines
  const origLines = estimateLineCount(original || text);
  const targetFont = Math.max(
    10,
    Math.min(64, (textPx.h / origLines) * 0.78),
  );

  const padX = Math.max(3, maskBounds.w * 0.12);
  const padY = Math.max(3, maskBounds.h * 0.12);
  const x = maskBounds.x + padX;
  const y = maskBounds.y + padY;
  const w = Math.max(8, maskBounds.w - padX * 2);
  const h = Math.max(8, maskBounds.h - padY * 2);

  const minFont = Math.max(9, targetFont * 0.55);
  const maxFont = targetFont;
  const fitted = condenseToFit(ctx, text, w, h, minFont);

  let low = minFont;
  let high = maxFont;
  let bestSize = minFont;
  let bestLines = wrapText(ctx, fitted, w);

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const result = textFits(ctx, fitted, w, h, mid);
    if (result.ok) {
      bestSize = mid;
      bestLines = result.lines;
      low = mid + 1;
    } else high = mid - 1;
  }

  const nearOriginal = textFits(ctx, fitted, w, h, Math.floor(targetFont));
  if (nearOriginal.ok) {
    bestSize = Math.floor(targetFont);
    bestLines = nearOriginal.lines;
  }

  ctx.font = `700 ${bestSize}px Arial, "Helvetica Neue", sans-serif`;
  ctx.fillStyle = "#111111";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const lineHeight = bestSize * 1.12;
  const totalHeight = bestLines.length * lineHeight;
  const cx = textPx.x + textPx.w / 2;
  const cy = textPx.y + textPx.h / 2;
  let cursorY = cy - totalHeight / 2 + lineHeight / 2;
  const drawX = Math.min(Math.max(cx, x + 4), x + w - 4);

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
      overlay.data[px] = Math.min(255, overlay.data[px] * 0.35 + 255 * 0.65);
      overlay.data[px + 1] = overlay.data[px + 1] * 0.35;
      overlay.data[px + 2] = overlay.data[px + 2] * 0.35;
    } else if (interior[i]) {
      overlay.data[px] = overlay.data[px] * 0.55;
      overlay.data[px + 1] = Math.min(255, overlay.data[px + 1] * 0.55 + 180 * 0.45);
      overlay.data[px + 2] = overlay.data[px + 2] * 0.55;
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
 * Pipeline:
 * 1) Zemin
 * 2) Balon şeklini segment et (flood-fill interior)
 * 3) Redzone = balon sınırı
 * 4) Maskeyi balon şekliyle birebir beyaza boya
 * 5) Çeviriyi orijinale yakın puntoyla yerleştir
 */
export async function renderTranslatedPage(
  imageDataUrl: string,
  bubbles: BubbleTranslation[],
  options: RenderOptions = {},
): Promise<string> {
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

    const { interior, redzone, bounds } = segmentBubbleInterior(
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

    // Mask shape == bubble interior shape (not a rectangle)
    wipeInteriorMask(ctx, width, height, interior, bounds);

    const placeBox: PxBox = {
      x: Math.max(bounds.x, textPx.x),
      y: Math.max(bounds.y, textPx.y),
      w: Math.min(bounds.x + bounds.w, textPx.x + textPx.w) - Math.max(bounds.x, textPx.x),
      h: Math.min(bounds.y + bounds.h, textPx.y + textPx.h) - Math.max(bounds.y, textPx.y),
    };
    if (placeBox.w < 8 || placeBox.h < 8) {
      placeBox.x = bounds.x;
      placeBox.y = bounds.y;
      placeBox.w = bounds.w;
      placeBox.h = bounds.h;
    }

    placeTranslationInBubble(
      ctx,
      bubble.translated,
      bubble.original,
      textPx,
      placeBox,
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
