import { nanoid } from "nanoid";
import { compressDataUrl } from "./pdf";
import { renderTranslatedPage } from "./renderTranslated";
import type { BubbleTranslation } from "./types";

export async function translatePageImage(params: {
  imageDataUrl: string;
  mimeType: string;
  targetLanguage: string;
  sourceLanguage: string;
}): Promise<{ bubbles: BubbleTranslation[]; translatedImageDataUrl: string }> {
  const compressed = await compressDataUrl(params.imageDataUrl);

  const response = await fetch("/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      imageBase64: compressed.dataUrl,
      mimeType: compressed.mimeType,
      targetLanguage: params.targetLanguage,
      sourceLanguage: params.sourceLanguage,
    }),
  });

  const data = (await response.json()) as {
    bubbles?: Array<{
      original: string;
      translated: string;
      readingOrder: number;
      box: { x: number; y: number; w: number; h: number };
    }>;
    error?: string;
  };

  if (!response.ok) {
    throw new Error(data.error || "Çeviri isteği başarısız");
  }

  const bubbles: BubbleTranslation[] = (data.bubbles ?? []).map((bubble) => ({
    id: nanoid(),
    original: bubble.original,
    translated: bubble.translated,
    readingOrder: bubble.readingOrder,
    box: bubble.box,
  }));

  // Render onto the full-resolution original page, not the compressed API upload
  const translatedImageDataUrl = await renderTranslatedPage(params.imageDataUrl, bubbles);

  return { bubbles, translatedImageDataUrl };
}
