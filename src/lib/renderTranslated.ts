import type { BubbleTranslation } from "./types";

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Görsel yüklenemedi"));
    img.src = src;
  });
}

function sampleFillColor(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
): string {
  const pad = Math.max(2, Math.floor(Math.min(w, h) * 0.08));
  const points = [
    [x + pad, y + pad],
    [x + w - pad, y + pad],
    [x + pad, y + h - pad],
    [x + w - pad, y + h - pad],
    [x + w / 2, y + pad],
    [x + w / 2, y + h - pad],
  ];

  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;

  for (const [px, py] of points) {
    try {
      const data = ctx.getImageData(Math.floor(px), Math.floor(py), 1, 1).data;
      // Prefer light bubble interiors
      if (data[0] + data[1] + data[2] > 480) {
        r += data[0];
        g += data[1];
        b += data[2];
        count += 1;
      }
    } catch {
      // ignore cross-origin / security edge cases
    }
  }

  if (count === 0) return "#ffffff";
  return `rgb(${Math.round(r / count)}, ${Math.round(g / count)}, ${Math.round(b / count)})`;
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

function fitAndDrawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const padX = Math.max(4, w * 0.08);
  const padY = Math.max(4, h * 0.08);
  const maxWidth = Math.max(8, w - padX * 2);
  const maxHeight = Math.max(8, h - padY * 2);

  let low = 8;
  let high = Math.max(10, Math.min(72, h * 0.45));
  let bestSize = low;
  let bestLines: string[] = [text];

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    ctx.font = `700 ${mid}px "Figtree", "Arial Narrow", Arial, sans-serif`;
    const lines = wrapText(ctx, text, maxWidth);
    const lineHeight = mid * 1.15;
    const totalHeight = lines.length * lineHeight;
    const widest = Math.max(...lines.map((line) => ctx.measureText(line).width), 0);

    if (totalHeight <= maxHeight && widest <= maxWidth) {
      bestSize = mid;
      bestLines = lines;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  ctx.font = `700 ${bestSize}px "Figtree", "Arial Narrow", Arial, sans-serif`;
  ctx.fillStyle = "#111111";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const lineHeight = bestSize * 1.15;
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
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas desteklenmiyor");

  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  for (const bubble of bubbles) {
    if (!bubble.translated.trim()) continue;
    const x = bubble.box.x * canvas.width;
    const y = bubble.box.y * canvas.height;
    const w = bubble.box.w * canvas.width;
    const h = bubble.box.h * canvas.height;
    if (w < 4 || h < 4) continue;

    const fill = sampleFillColor(ctx, x, y, w, h);
    const radius = Math.min(w, h) * 0.18;

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.restore();

    fitAndDrawText(ctx, bubble.translated, x, y, w, h);
  }

  return canvas.toDataURL("image/jpeg", 0.92);
}
