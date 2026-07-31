import { nanoid } from "nanoid";
import { normalizeBubbleBox } from "./boxes";
import { compressDataUrl } from "./pdf";
import { renderTranslatedPage, type RenderOptions } from "./renderTranslated";
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
    bubbles.push({
      id: nanoid(),
      original: bubble.original,
      translated: bubble.translated,
      readingOrder: bubble.readingOrder,
      box,
      bubbleBox:
        normalizeBubbleBox(bubble.bubbleBox, size.width, size.height) ?? undefined,
    });
  }

  if ((data.bubbles?.length ?? 0) > 0 && bubbles.length === 0) {
    throw new Error(
      "Çeviri geldi ama baloncuk konumları okunamadı. Tekrar dene.",
    );
  }

  const [translatedImageDataUrl, debugImageDataUrl] = await Promise.all([
    renderTranslatedPage(params.imageDataUrl, bubbles, { showRedzone: false }),
    renderTranslatedPage(params.imageDataUrl, bubbles, { showRedzone: true }),
  ]);

  return { bubbles, translatedImageDataUrl, debugImageDataUrl };
}

export async function reapplyBubblesToImage(
  imageDataUrl: string,
  bubbles: BubbleTranslation[],
  options: RenderOptions = {},
): Promise<string> {
  return renderTranslatedPage(imageDataUrl, bubbles, options);
}
