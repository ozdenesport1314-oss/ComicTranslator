import { expandBox } from "./boxes";
import type { BubbleTranslation } from "./types";

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Görsel yüklenemedi"));
    img.src = src;
  });
}

function fillBubbleArea(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const radius = Math.min(w, h) * 0.16;
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, radius);
  } else {
    ctx.rect(x, y, w, h);
  }
  ctx.fill();
  // Second pass: solid rect inset to guarantee original ink is covered
  ctx.fillRect(x + w * 0.04, y + h * 0.04, w * 0.92, h * 0.92);
  ctx.restore();
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
  const padX = Math.max(3, w * 0.08);
  const padY = Math.max(3, h * 0.08);
  const maxWidth = Math.max(8, w - padX * 2);
  const maxHeight = Math.max(8, h - padY * 2);

  let low = 10;
  let high = Math.max(12, Math.min(84, h * 0.5));
  let bestSize = low;
  let bestLines: string[] = [text];

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    ctx.font = `800 ${mid}px Arial, "Helvetica Neue", sans-serif`;
    const lines = wrapText(ctx, text, maxWidth);
    const lineHeight = mid * 1.12;
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

  ctx.font = `800 ${bestSize}px Arial, "Helvetica Neue", sans-serif`;
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
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas desteklenmiyor");

  ctx.drawImage(img, 0, 0, width, height);

  let painted = 0;
  for (const bubble of bubbles) {
    if (!bubble.translated?.trim() || !bubble.box) continue;

    const box = expandBox(bubble.box, 0.06);
    const x = box.x * width;
    const y = box.y * height;
    const w = box.w * width;
    const h = box.h * height;

    // Allow small bubbles; manga SFX can be tiny
    if (w < 2 || h < 2) continue;

    fillBubbleArea(ctx, x, y, w, h);
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
