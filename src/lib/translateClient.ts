import { nanoid } from "nanoid";
import { expandBox, normalizeBubbleBox } from "./boxes";
import { compressDataUrl } from "./pdf";
import {
  renderRedzonePreview,
  renderTranslatedPage,
  type RenderOptions,
} from "./renderTranslated";
import type { BubbleTranslation } from "./types";

function loadImageSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () =>
      resolve({
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
      });
    img.onerror = () => reject(new Error("Görsel boyutları okunamadı"));
    img.src = src;
  });
}

export async function translatePageImage(params: {
  imageDataUrl: string;
  mimeType: string;
  targetLanguage: string;
  sourceLanguage: string;
}): Promise<{
  bubbles: BubbleTranslation[];
  translatedImageDataUrl: string;
  debugImageDataUrl: string;
}> {
  const compressed = await compressDataUrl(params.imageDataUrl);
  const size = await loadImageSize(compressed.dataUrl);

  const response = await fetch("/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      imageBase64: compressed.dataUrl,
      mimeType: compressed.mimeType,
      targetLanguage: params.targetLanguage,
      sourceLanguage: params.sourceLanguage,
      imageWidth: size.width,
      imageHeight: size.height,
    }),
  });

  const data = (await response.json()) as {
    bubbles?: Array<{
      original: string;
      translated: string;
      readingOrder: number;
      box?: unknown;
      textBox?: unknown;
      bubbleBox?: unknown;
      bubblePolygon?: Array<{ x: number; y: number }>;
      hasBubble?: boolean;
    }>;
    error?: string;
  };

  if (!response.ok) {
    throw new Error(data.error || "Çeviri isteği başarısız");
  }

  const bubbles: BubbleTranslation[] = [];
  for (const bubble of data.bubbles ?? []) {
    const box = normalizeBubbleBox(
      bubble.textBox ?? bubble.box,
      size.width,
      size.height,
    );
    if (!box) continue;
    let bubbleBox =
      normalizeBubbleBox(bubble.bubbleBox, size.width, size.height) ??
      expandBox(box, 0.22);

    // Guarantee textBox stays inside bubbleBox
    const x = Math.max(box.x, bubbleBox.x);
    const y = Math.max(box.y, bubbleBox.y);
    const r = Math.min(box.x + box.w, bubbleBox.x + bubbleBox.w);
    const b = Math.min(box.y + box.h, bubbleBox.y + bubbleBox.h);
    const clipped = {
      x,
      y,
      w: Math.max(0.004, r - x),
      h: Math.max(0.004, b - y),
    };

    // If clip collapsed, expand bubble around text
    if (clipped.w < 0.01 || clipped.h < 0.01) {
      bubbleBox = expandBox(box, 0.25);
    }

    bubbles.push({
      id: nanoid(),
      original: bubble.original,
      translated: bubble.translated,
      readingOrder: bubble.readingOrder,
      box: clipped.w >= 0.01 && clipped.h >= 0.01 ? clipped : box,
      bubbleBox,
      bubblePolygon: Array.isArray(bubble.bubblePolygon)
        ? bubble.bubblePolygon
            .map((p) => ({ x: Number(p.x), y: Number(p.y) }))
            .filter(
              (p) =>
                Number.isFinite(p.x) &&
                Number.isFinite(p.y) &&
                p.x >= 0 &&
                p.x <= 1 &&
                p.y >= 0 &&
                p.y <= 1,
            )
        : undefined,
      hasBubble: bubble.hasBubble ?? true,
    });
  }

  if ((data.bubbles?.length ?? 0) > 0 && bubbles.length === 0) {
    throw new Error(
      "Çeviri geldi ama baloncuk konumları okunamadı. Tekrar dene.",
    );
  }

  const [translatedImageDataUrl, debugImageDataUrl] = await Promise.all([
    renderTranslatedPage(params.imageDataUrl, bubbles, { showRedzone: false }),
    renderRedzonePreview(params.imageDataUrl, bubbles),
  ]);

  return { bubbles, translatedImageDataUrl, debugImageDataUrl };
}

export async function reapplyBubblesToImage(
  imageDataUrl: string,
  bubbles: BubbleTranslation[],
  options: RenderOptions = {},
): Promise<string> {
  if (options.showRedzone) {
    return renderRedzonePreview(imageDataUrl, bubbles);
  }
  return renderTranslatedPage(imageDataUrl, bubbles, options);
}
