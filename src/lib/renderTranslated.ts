import { expandBox, insetBox } from "./boxes";
import type { BubbleBox, BubbleTranslation } from "./types";

export type RenderOptions = {
  /** Draw detected zones: bubble=orange, text=cyan, redzone=red */
  showRedzone?: boolean;
};

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Görsel yüklenemedi"));
    img.src = src;
  });
}

function toPx(box: BubbleBox, width: number, height: number) {
  return {
    x: box.x * width,
    y: box.y * height,
    w: Math.max(1, box.w * width),
    h: Math.max(1, box.h * height),
  };
}

function resolveBubbleBox(bubble: BubbleTranslation): BubbleBox {
  return bubble.bubbleBox ?? expandBox(bubble.box, 0.2);
}

/** Redzone = bubble border band (outer part of bubbleBox). Do not wipe here. */
function buildRedzoneMask(
  bubblePx: { x: number; y: number; w: number; h: number },
  width: number,
  height: number,
  bandRatio = 0.14,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  const bandX = Math.max(2, Math.floor(bubblePx.w * bandRatio));
  const bandY = Math.max(2, Math.floor(bubblePx.h * bandRatio));

  const x0 = Math.max(0, Math.floor(bubblePx.x));
  const y0 = Math.max(0, Math.floor(bubblePx.y));
  const x1 = Math.min(width, Math.ceil(bubblePx.x + bubblePx.w));
  const y1 = Math.min(height, Math.ceil(bubblePx.y + bubblePx.h));

  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const localX = x - bubblePx.x;
      const localY = y - bubblePx.y;
      const onRing =
        localX < bandX ||
        localX >= bubblePx.w - bandX ||
        localY < bandY ||
        localY >= bubblePx.h - bandY;
      if (onRing) mask[y * width + x] = 1;
    }
  }
  return mask;
}

/**
 * Mask original text: wipe pixels inside text region / bubble interior,
 * but never touch redzone (bubble border).
 */
function maskTextInsideBubble(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  textPx: { x: number; y: number; w: number; h: number },
  bubblePx: { x: number; y: number; w: number; h: number },
  redzone: Uint8Array,
) {
  // Wipe region = text box expanded a bit, clipped to bubble interior
  const wipe = {
    x: Math.max(bubblePx.x, textPx.x - textPx.w * 0.06),
    y: Math.max(bubblePx.y, textPx.y - textPx.h * 0.06),
    w: 0,
    h: 0,
  };
  const right = Math.min(bubblePx.x + bubblePx.w, textPx.x + textPx.w * 1.06);
  const bottom = Math.min(bubblePx.y + bubblePx.h, textPx.y + textPx.h * 1.06);
  wipe.w = Math.max(1, right - wipe.x);
  wipe.h = Math.max(1, bottom - wipe.y);

  const ix = Math.max(0, Math.floor(wipe.x));
  const iy = Math.max(0, Math.floor(wipe.y));
  const iw = Math.max(1, Math.min(width - ix, Math.ceil(wipe.w)));
  const ih = Math.max(1, Math.min(height - iy, Math.ceil(wipe.h)));
  if (iw < 2 || ih < 2) return;

  const imageData = ctx.getImageData(ix, iy, iw, ih);
  const { data } = imageData;

  // Inner core of text box: force white (complete cover of old glyphs)
  const corePadX = Math.max(1, Math.floor(iw * 0.04));
  const corePadY = Math.max(1, Math.floor(ih * 0.04));

  for (let row = 0; row < ih; row += 1) {
    for (let col = 0; col < iw; col += 1) {
      const gx = ix + col;
      const gy = iy + row;
      if (gx < 0 || gy < 0 || gx >= width || gy >= height) continue;
      if (redzone[gy * width + gx]) continue; // protect bubble border

      const i = (row * iw + col) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;

      const inCore =
        col >= corePadX &&
        col < iw - corePadX &&
        row >= corePadY &&
        row < ih - corePadY;

      // Core always white; elsewhere wipe ink / mid-gray glyph edges
      if (inCore || lum < 215) {
        data[i] = 255;
        data[i + 1] = 255;
        data[i + 2] = 255;
        data[i + 3] = 255;
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

function placeTranslation(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const padX = Math.max(3, w * 0.1);
  const padY = Math.max(3, h * 0.1);
  const maxWidth = Math.max(8, w - padX * 2);
  const maxHeight = Math.max(8, h - padY * 2);
  const minFont = Math.max(10, Math.min(16, h * 0.16));
  const maxFont = Math.max(minFont + 1, Math.min(68, h * 0.42));
  const fitted = condenseToFit(ctx, text, maxWidth, maxHeight, minFont);

  let low = minFont;
  let high = maxFont;
  let bestSize = minFont;
  let bestLines = wrapText(ctx, fitted, maxWidth);

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const result = textFits(ctx, fitted, maxWidth, maxHeight, mid);
    if (result.ok) {
      bestSize = mid;
      bestLines = result.lines;
      low = mid + 1;
    } else high = mid - 1;
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

function drawDebugZones(
  ctx: CanvasRenderingContext2D,
  bubblePx: { x: number; y: number; w: number; h: number },
  textPx: { x: number; y: number; w: number; h: number },
  redzone: Uint8Array,
  width: number,
  height: number,
) {
  // Redzone fill
  const overlay = ctx.getImageData(0, 0, width, height);
  for (let i = 0; i < redzone.length; i += 1) {
    if (!redzone[i]) continue;
    const px = i * 4;
    overlay.data[px] = Math.min(255, overlay.data[px] * 0.45 + 220 * 0.55);
    overlay.data[px + 1] = overlay.data[px + 1] * 0.45;
    overlay.data[px + 2] = overlay.data[px + 2] * 0.45;
  }
  ctx.putImageData(overlay, 0, 0);

  ctx.save();
  ctx.lineWidth = Math.max(2, Math.min(width, height) * 0.0025);

  // Bubble boundary
  ctx.strokeStyle = "#ff7a00";
  ctx.strokeRect(bubblePx.x, bubblePx.y, bubblePx.w, bubblePx.h);

  // Text box
  ctx.strokeStyle = "#00d4ff";
  ctx.strokeRect(textPx.x, textPx.y, textPx.w, textPx.h);

  // Redzone outline = bubble edge
  ctx.strokeStyle = "#ff0033";
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(bubblePx.x, bubblePx.y, bubblePx.w, bubblePx.h);
  ctx.restore();
}

/**
 * Pipeline:
 * 1) Zemin oluştur (working layer)
 * 2) Balon / yazı / sınır algısı (gelen box'lar)
 * 3) Sınıra redzone çiz (koruma bandı)
 * 4) Yazıyı maskele
 * 5) Çeviriyi ekle
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

  // 1) Zemin katmanı
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

    // 2) Balon + yazı algısı
    const bubbleBox = resolveBubbleBox(bubble);
    const textBox = bubble.box;
    const bubblePx = toPx(bubbleBox, width, height);
    const textPx = toPx(textBox, width, height);

    // 3) Sınıra redzone
    const redzone = buildRedzoneMask(bubblePx, width, height, 0.12);

    if (options.showRedzone) {
      drawDebugZones(ctx, bubblePx, textPx, redzone, width, height);
    }

    // 4) Yazıyı maskele (redzone'a dokunma)
    maskTextInsideBubble(ctx, width, height, textPx, bubblePx, redzone);

    // 5) Çeviriyi ekle
    const draw = insetBox(textBox, 0.03);
    const drawPx = toPx(draw, width, height);
    placeTranslation(ctx, bubble.translated, drawPx.x, drawPx.y, drawPx.w, drawPx.h);
    painted += 1;
  }

  if (painted === 0) {
    throw new Error(
      "Baloncuk konumları görsele uygulanamadı. Sayfayı tekrar çevirmeyi dene.",
    );
  }

  return zemin.toDataURL("image/jpeg", 0.92);
}
