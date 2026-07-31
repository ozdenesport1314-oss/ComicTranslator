import { nanoid } from "nanoid";
import type { BubbleTranslation } from "./types";
import { compressDataUrl } from "./pdf";

export async function translatePageImage(params: {
  imageDataUrl: string;
  mimeType: string;
  targetLanguage: string;
  sourceLanguage: string;
}): Promise<BubbleTranslation[]> {
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
    bubbles?: Array<{ original: string; translated: string; readingOrder: number }>;
    error?: string;
  };

  if (!response.ok) {
    throw new Error(data.error || "Çeviri isteği başarısız");
  }

  return (data.bubbles ?? []).map((bubble) => ({
    id: nanoid(),
    original: bubble.original,
    translated: bubble.translated,
    readingOrder: bubble.readingOrder,
  }));
}
