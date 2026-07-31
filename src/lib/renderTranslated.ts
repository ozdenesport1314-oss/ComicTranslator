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

function lumOf(r: number, g: number, b: number) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Completely wipe original text inside the bubble region.
 * Keeps only very-dark strokes on the outer ring (bubble outline).
 * Everything else in the region becomes white — no leftover English.
 */
function wipeBubbleInterior(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const ix = Math.max(0, Math.floor(x));
  const iy = Math.max(0, Math.floor(y));
  const iw = Math.max(1, Math.ceil(w));
  const ih = Math.max(1, Math.ceil(h));
  if (iw < 3 || ih < 3) return;

  const imageData = ctx.getImageData(ix, iy, iw, ih);
  const { data } = imageData;
  const count = iw * ih;
  const lum = new Float32Array(count);

  for (let p = 0; p < count; p += 1) {
    const i = p * 4;
    lum[p] = lumOf(data[i], data[i + 1], data[i + 2]);
  }

  // Outer ring where bubble outline may sit — keep only hard black strokes there
  const ringX = Math.max(2, Math.floor(iw * 0.1));
  const ringY = Math.max(2, Math.floor(ih * 0.1));
  const outlineCut = 48;

  // Mark outline candidates: very dark pixels on the ring, connected to the rect border
  const outline = new Uint8Array(count);
  const stack: number[] = [];

  const pushIfOutlineSeed = (col: number, row: number) => {
    if (col < 0 || row < 0 || col >= iw || row >= ih) return;
    const p = row * iw + col;
    if (lum[p] <= outlineCut) stack.push(p);
  };

  for (let col = 0; col < iw; col += 1) {
    pushIfOutlineSeed(col, 0);
    pushIfOutlineSeed(col, ih - 1);
  }
  for (let row = 0; row < ih; row += 1) {
    pushIfOutlineSeed(0, row);
    pushIfOutlineSeed(iw - 1, row);
  }

  while (stack.length) {
    const p = stack.pop() as number;
    if (outline[p]) continue;
    if (lum[p] > outlineCut) continue;

    const row = Math.floor(p / iw);
    const col = p - row * iw;
    const onRing =
      col < ringX || col >= iw - ringX || row < ringY || row >= ih - ringY;
    // Only grow outline along the ring / near border so inner text isn't "outline"
    if (!onRing) continue;

    outline[p] = 1;
    const neighbors = [p - 1, p + 1, p - iw, p + iw, p - iw - 1, p - iw + 1, p + iw - 1, p + iw + 1];
    for (const n of neighbors) {
      if (n < 0 || n >= count) continue;
      const nr = Math.floor(n / iw);
      const nc = n - nr * iw;
      if (Math.abs(nr - row) > 1 || Math.abs(nc - col) > 1) continue;
      if (!outline[n] && lum[n] <= outlineCut) stack.push(n);
    }
  }

  // Wipe everything that is not preserved outline
  for (let p = 0; p < count; p += 1) {
    if (outline[p]) continue;
    const i = p * 4;
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    data[i + 3] = 255;
  }

  // Second pass: kill tiny dark speckles left inside (orphan ink)
  for (let row = 1; row < ih - 1; row += 1) {
    for (let col = 1; col < iw - 1; col += 1) {
      const p = row * iw + col;
      if (outline[p]) continue;
      const i = p * 4;
      // already white from pass 1; re-assert for safety
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
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
  const lineHeight = fontSize * 1.12;
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
  const padX = Math.max(3, w * 0.12);
  const padY = Math.max(3, h * 0.12);
  const maxWidth = Math.max(8, w - padX * 2);
  const maxHeight = Math.max(8, h - padY * 2);
  const minFont = Math.max(10, Math.min(16, h * 0.16));
  const maxFont = Math.max(minFont + 1, Math.min(68, h * 0.42));

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

  ctx.font = `700 ${bestSize}px Arial, "Helvetica Neue", sans-serif`;
  ctx.fillStyle = "#111111";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const lineHeight = bestSize * 1.12;
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

    // Wipe a bit larger than detected text so no English peeks out
    const wipe = expandBox(bubble.box, 0.14);
    // Draw a bit inset so letters stay inside the cleaned bubble
    const draw = insetBox(bubble.box, 0.04);

    const wx = wipe.x * width;
    const wy = wipe.y * height;
    const ww = wipe.w * width;
    const wh = wipe.h * height;

    const dx = draw.x * width;
    const dy = draw.y * height;
    const dw = draw.w * width;
    const dh = draw.h * height;

    if (ww < 2 || wh < 2 || dw < 2 || dh < 2) continue;

    wipeBubbleInterior(ctx, wx, wy, ww, wh);
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
