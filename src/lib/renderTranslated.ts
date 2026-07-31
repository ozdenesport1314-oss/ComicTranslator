import { expandBox, insetBox } from "./boxes";
import type { BubbleTranslation } from "./types";

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Görsel yüklenemedi"));
    img.src = src;
  });
}

function luminance(r: number, g: number, b: number) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Clean the original text region so none of it remains visible,
 * while avoiding a big rectangle that destroys the bubble outline.
 *
 * Strategy:
 * 1) Slightly expand the text box to catch full glyph bounds
 * 2) Build an ink mask + dilate it (kills anti-aliased letter edges)
 * 3) Flood-fill from the center through non-border pixels and whiten
 * 4) Force-whiten the core of the text box (guarantees full cover)
 */
function cleanOriginalTextRegion(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const ix = Math.max(0, Math.floor(x));
  const iy = Math.max(0, Math.floor(y));
  const iw = Math.max(1, Math.floor(w));
  const ih = Math.max(1, Math.floor(h));
  if (iw < 3 || ih < 3) return;

  const imageData = ctx.getImageData(ix, iy, iw, ih);
  const { data } = imageData;
  const n = iw * ih;
  const lum = new Float32Array(n);

  for (let p = 0; p < n; p += 1) {
    const i = p * 4;
    lum[p] = luminance(data[i], data[i + 1], data[i + 2]);
  }

  // Paper tone from brightest pixels
  const sorted = Float32Array.from(lum).sort();
  const brightStart = Math.floor(n * 0.65);
  let bgSum = 0;
  let bgCount = 0;
  for (let i = brightStart; i < n; i += 1) {
    bgSum += sorted[i];
    bgCount += 1;
  }
  const bg = bgCount ? bgSum / bgCount : 250;
  const inkCut = Math.min(205, bg - 22);
  const borderCut = 55; // very dark = likely balloon outline

  // Ink mask
  const ink = new Uint8Array(n);
  for (let p = 0; p < n; p += 1) {
    if (lum[p] < inkCut) ink[p] = 1;
  }

  // Dilate ink 2px so gray letter edges disappear
  const dilated = new Uint8Array(n);
  const rad = 2;
  for (let row = 0; row < ih; row += 1) {
    for (let col = 0; col < iw; col += 1) {
      let hit = 0;
      for (let dy = -rad; dy <= rad && !hit; dy += 1) {
        for (let dx = -rad; dx <= rad; dx += 1) {
          const yy = row + dy;
          const xx = col + dx;
          if (yy < 0 || xx < 0 || yy >= ih || xx >= iw) continue;
          if (ink[yy * iw + xx]) {
            hit = 1;
            break;
          }
        }
      }
      dilated[row * iw + col] = hit;
    }
  }

  // Flood fill from a bright seed near center through non-border pixels
  const fill = new Uint8Array(n);
  const seedCandidates: Array<[number, number]> = [
    [Math.floor(iw / 2), Math.floor(ih / 2)],
    [Math.floor(iw * 0.4), Math.floor(ih * 0.4)],
    [Math.floor(iw * 0.6), Math.floor(ih * 0.4)],
    [Math.floor(iw * 0.5), Math.floor(ih * 0.6)],
  ];

  let seed: [number, number] | null = null;
  for (const [sx, sy] of seedCandidates) {
    if (lum[sy * iw + sx] > borderCut + 30) {
      seed = [sx, sy];
      break;
    }
  }
  if (!seed) seed = seedCandidates[0];

  const stack = [seed[0], seed[1]];
  while (stack.length) {
    const cy = stack.pop() as number;
    const cx = stack.pop() as number;
    if (cx < 0 || cy < 0 || cx >= iw || cy >= ih) continue;
    const p = cy * iw + cx;
    if (fill[p]) continue;
    if (lum[p] < borderCut) continue; // stop at hard outline
    fill[p] = 1;
    stack.push(cx + 1, cy, cx - 1, cy, cx, cy + 1, cx, cy - 1);
  }

  const corePadX = Math.max(1, Math.floor(iw * 0.08));
  const corePadY = Math.max(1, Math.floor(ih * 0.08));

  for (let row = 0; row < ih; row += 1) {
    for (let col = 0; col < iw; col += 1) {
      const p = row * iw + col;
      const i = p * 4;
      const inCore =
        col >= corePadX &&
        col < iw - corePadX &&
        row >= corePadY &&
        row < ih - corePadY;

      // Whiten if: dilated ink, flood interior, or forced core (full text cover)
      const shouldWhiten = dilated[p] || fill[p] || inCore;
      if (!shouldWhiten) continue;

      // Preserve only hard border pixels on the outer ring
      const onRing =
        col < corePadX ||
        col >= iw - corePadX ||
        row < corePadY ||
        row >= ih - corePadY;
      if (onRing && lum[p] < borderCut) continue;

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
    if (words.length === 0) {
      lines.push("");
      continue;
    }

    let current = words[0];
    for (let i = 1; i < words.length; i += 1) {
      const next = `${current} ${words[i]}`;
      if (ctx.measureText(next).width <= maxWidth) {
        current = next;
      } else {
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
): { ok: boolean; lines: string[] } {
  ctx.font = `700 ${fontSize}px Arial, "Helvetica Neue", sans-serif`;
  const lines = wrapText(ctx, text, maxWidth);
  const lineHeight = fontSize * 1.1;
  const totalHeight = lines.length * lineHeight;
  const widest = Math.max(...lines.map((line) => ctx.measureText(line).width), 0);
  return {
    ok: totalHeight <= maxHeight && widest <= maxWidth,
    lines,
  };
}

function condenseToFit(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxHeight: number,
  minFont: number,
): string {
  let candidate = text
    .replace(/\s+/g, " ")
    .replace(/\s*\.\.\.\s*/g, "…")
    .trim();

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
    } else {
      high = mid - 1;
    }
  }

  return best;
}

function fitAndDrawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const padX = Math.max(2, w * 0.08);
  const padY = Math.max(2, h * 0.08);
  const maxWidth = Math.max(8, w - padX * 2);
  const maxHeight = Math.max(8, h - padY * 2);
  const minFont = Math.max(10, Math.min(15, h * 0.15));
  const maxFont = Math.max(minFont + 1, Math.min(70, h * 0.45));

  const fittedText = condenseToFit(ctx, text, maxWidth, maxHeight, minFont);

  let low = minFont;
  let high = maxFont;
  let bestSize = minFont;
  let bestLines = wrapText(ctx, fittedText, maxWidth);

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const result = textFits(ctx, fittedText, maxWidth, maxHeight, mid);
    if (result.ok) {
      bestSize = mid;
      bestLines = result.lines;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  // Soft white backing only behind glyphs (same box), no rounded card
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.fillRect(x + padX * 0.35, y + padY * 0.35, w - padX * 0.7, h - padY * 0.7);
  ctx.restore();

  ctx.font = `700 ${bestSize}px Arial, "Helvetica Neue", sans-serif`;
  ctx.fillStyle = "#111111";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const lineHeight = bestSize * 1.1;
  const totalHeight = bestLines.length * lineHeight;
  let cursorY = y + h / 2 - totalHeight / 2 + lineHeight / 2;

  for (const line of bestLines) {
    ctx.fillText(line, x + w / 2, cursorY, maxWidth);
    cursorY += lineHeight;
  }
}

export async function renderTranslatedPage(
  imageDataUrl: string,
  bubbles: BubbleTranslation[],
): Promise<string> {
  const img = await loadImage(imageDataUrl);
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  if (!width || !height) {
    throw new Error("Görsel boyutları okunamadı");
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas desteklenmiyor");

  ctx.drawImage(img, 0, 0, width, height);

  const ordered = [...bubbles].sort((a, b) => a.readingOrder - b.readingOrder);

  let painted = 0;
  for (const bubble of ordered) {
    if (!bubble.translated?.trim() || !bubble.box) continue;

    // Clean a bit larger than text so leftover English can't peek out
    const cleanBox = expandBox(bubble.box, 0.1);
    const drawBox = insetBox(bubble.box, 0.02);

    const cx = cleanBox.x * width;
    const cy = cleanBox.y * height;
    const cw = cleanBox.w * width;
    const ch = cleanBox.h * height;

    const dx = drawBox.x * width;
    const dy = drawBox.y * height;
    const dw = drawBox.w * width;
    const dh = drawBox.h * height;

    if (cw < 2 || ch < 2 || dw < 2 || dh < 2) continue;

    cleanOriginalTextRegion(ctx, cx, cy, cw, ch);
    fitAndDrawText(ctx, bubble.translated, dx, dy, dw, dh);
    painted += 1;
  }

  if (painted === 0) {
    throw new Error(
      "Baloncuk konumları görsele uygulanamadı. Sayfayı tekrar çevirmeyi dene.",
    );
  }

  return canvas.toDataURL("image/jpeg", 0.92);
}
