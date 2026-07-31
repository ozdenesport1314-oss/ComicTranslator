import { insetBox } from "./boxes";
import type { BubbleTranslation } from "./types";

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Görsel yüklenemedi"));
    img.src = src;
  });
}

/**
 * Erase only dark ink (text) inside the region.
 * Keeps light bubble fill and avoids painting a solid white rectangle over the art/border.
 */
function eraseTextInk(
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
  if (iw < 2 || ih < 2) return;

  const imageData = ctx.getImageData(ix, iy, iw, ih);
  const data = imageData.data;
  const luminances: number[] = [];

  for (let i = 0; i < data.length; i += 4) {
    luminances.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
  }

  // Background ≈ bright end of the region (speech bubbles are usually white/cream)
  const sorted = [...luminances].sort((a, b) => a - b);
  const brightStart = Math.floor(sorted.length * 0.7);
  let bgSum = 0;
  let bgCount = 0;
  for (let i = brightStart; i < sorted.length; i += 1) {
    bgSum += sorted[i];
    bgCount += 1;
  }
  const bg = bgCount ? bgSum / bgCount : 245;
  const inkThreshold = Math.min(210, bg - 28);

  const edgeX = Math.max(1, Math.floor(iw * 0.08));
  const edgeY = Math.max(1, Math.floor(ih * 0.08));

  for (let row = 0; row < ih; row += 1) {
    for (let col = 0; col < iw; col += 1) {
      const idx = (row * iw + col) * 4;
      const lum = luminances[row * iw + col];
      const nearEdge =
        col < edgeX || col >= iw - edgeX || row < edgeY || row >= ih - edgeY;

      // Near edges: only erase medium-dark text, keep very dark outline strokes
      if (nearEdge) {
        if (lum < inkThreshold && lum > 40) {
          data[idx] = 255;
          data[idx + 1] = 255;
          data[idx + 2] = 255;
        }
        continue;
      }

      // Interior: erase ink, keep paper
      if (lum < inkThreshold) {
        data[idx] = 255;
        data[idx + 1] = 255;
        data[idx + 2] = 255;
      }
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

/** Condense translation so it can fit the bubble without changing overall meaning too much. */
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

  if (textFits(ctx, candidate, maxWidth, maxHeight, minFont).ok) {
    return candidate;
  }

  // Drop soft filler words common in Turkish expansions
  candidate = candidate
    .replace(
      /\b(gerçekten|aslında|açıkçası|şöyle ki|yani|işte|biraz|oldukça|kesinlikle)\b/gi,
      "",
    )
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.…!?])/g, "$1")
    .trim();

  if (textFits(ctx, candidate, maxWidth, maxHeight, minFont).ok) {
    return candidate;
  }

  // Keep as many leading words as fit
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
  const padX = Math.max(2, w * 0.1);
  const padY = Math.max(2, h * 0.1);
  const maxWidth = Math.max(8, w - padX * 2);
  const maxHeight = Math.max(8, h - padY * 2);
  const minFont = Math.max(9, Math.min(14, h * 0.14));
  const maxFont = Math.max(minFont + 1, Math.min(64, h * 0.42));

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

  // Keep reading order stable: sort, then paint
  const ordered = [...bubbles].sort((a, b) => a.readingOrder - b.readingOrder);

  let painted = 0;
  for (const bubble of ordered) {
    if (!bubble.translated?.trim() || !bubble.box) continue;

    // Slight inset: stay inside bubble, protect outline
    const box = insetBox(bubble.box, 0.06);
    const x = box.x * width;
    const y = box.y * height;
    const w = box.w * width;
    const h = box.h * height;
    if (w < 2 || h < 2) continue;

    eraseTextInk(ctx, x, y, w, h);
    fitAndDrawText(ctx, bubble.translated, x, y, w, h);
    painted += 1;
  }

  if (painted === 0) {
    throw new Error(
      "Baloncuk konumları görsele uygulanamadı. Sayfayı tekrar çevirmeyi dene.",
    );
  }

  return canvas.toDataURL("image/jpeg", 0.92);
}
