import { nanoid } from "nanoid";
import { normalizeBubbleBox } from "./boxes";
import { compressDataUrl } from "./pdf";
import { renderTranslatedPage } from "./renderTranslated";
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
}): Promise<{ bubbles: BubbleTranslation[]; translatedImageDataUrl: string }> {
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
    }>;
    error?: string;
  };

  if (!response.ok) {
    throw new Error(data.error || "Çeviri isteği başarısız");
  }

  const bubbles: BubbleTranslation[] = (data.bubbles ?? [])
    .map((bubble) => {
      const box = normalizeBubbleBox(bubble.box, size.width, size.height);
      if (!box) return null;
      return {
        id: nanoid(),
        original: bubble.original,
        translated: bubble.translated,
        readingOrder: bubble.readingOrder,
        box,
      } satisfies BubbleTranslation;
    })
    .filter((b): b is BubbleTranslation => b !== null);

  if ((data.bubbles?.length ?? 0) > 0 && bubbles.length === 0) {
    throw new Error(
      "Çeviri geldi ama baloncuk konumları okunamadı. Tekrar dene.",
    );
  }

  const translatedImageDataUrl = await renderTranslatedPage(
    params.imageDataUrl,
    bubbles,
  );

  return { bubbles, translatedImageDataUrl };
}

/** Re-apply existing bubble translations onto the original image */
export async function reapplyBubblesToImage(
  imageDataUrl: string,
  bubbles: BubbleTranslation[],
): Promise<string> {
  return renderTranslatedPage(imageDataUrl, bubbles);
}
