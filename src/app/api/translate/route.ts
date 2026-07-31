import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

type TranslateBody = {
  imageBase64: string;
  mimeType: string;
  targetLanguage: string;
  sourceLanguage?: string;
};

type BubbleResult = {
  original: string;
  translated: string;
  readingOrder: number;
};

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function parseBubbles(raw: string): BubbleResult[] {
  const cleaned = stripCodeFence(raw);
  const parsed = JSON.parse(cleaned) as { bubbles?: BubbleResult[] } | BubbleResult[];
  const bubbles = Array.isArray(parsed) ? parsed : parsed.bubbles;
  if (!Array.isArray(bubbles)) {
    throw new Error("Gemini yanıtı beklenen formatta değil");
  }

  return bubbles
    .filter((b) => b && typeof b.original === "string" && typeof b.translated === "string")
    .map((b, index) => ({
      original: b.original.trim(),
      translated: b.translated.trim(),
      readingOrder:
        typeof b.readingOrder === "number" && Number.isFinite(b.readingOrder)
          ? b.readingOrder
          : index + 1,
    }))
    .filter((b) => b.original.length > 0)
    .sort((a, b) => a.readingOrder - b.readingOrder);
}

export async function POST(request: Request) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "GEMINI_API_KEY tanımlı değil. Vercel veya .env.local içine ekleyin." },
        { status: 500 },
      );
    }

    const body = (await request.json()) as TranslateBody;
    const { imageBase64, mimeType, targetLanguage, sourceLanguage } = body;

    if (!imageBase64 || !mimeType || !targetLanguage) {
      return NextResponse.json(
        { error: "imageBase64, mimeType ve targetLanguage gerekli" },
        { status: 400 },
      );
    }

    const base64Data = imageBase64.includes(",")
      ? imageBase64.split(",")[1]
      : imageBase64;

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL || "gemini-2.0-flash",
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json",
      },
    });

    const sourceHint =
      sourceLanguage && sourceLanguage !== "auto"
        ? `Kaynak dil: ${sourceLanguage}.`
        : "Kaynak dili otomatik algıla.";

    const prompt = `Sen bir manga/çizgi roman çevirmenisin. Bu sayfadaki konuşma baloncukları, düşünce baloncukları, ses efektleri (SFX) ve panellerdeki önemli yazıları oku.

Görev:
1) Metinleri okuma sırasına göre çıkar (manga için sağdan sola, yukarıdan aşağıya; batı çizgi romanı için soldan sağa).
2) Her metni hedef dile çevir: ${targetLanguage}.
3) ${sourceHint}
4) Karakterlerin konuşma tarzını, ünlemleri ve manga tonunu koru.
5) Sadece görseldeki gerçek metinleri çevir; uydurma.

Yanıtı SADECE şu JSON şemasında ver:
{
  "bubbles": [
    {
      "original": "orijinal metin",
      "translated": "çevrilmiş metin",
      "readingOrder": 1
    }
  ]
}

Metin yoksa {"bubbles": []} döndür.`;

    const result = await model.generateContent([
      { text: prompt },
      {
        inlineData: {
          mimeType: mimeType.startsWith("image/") ? mimeType : "image/jpeg",
          data: base64Data,
        },
      },
    ]);

    const text = result.response.text();
    const bubbles = parseBubbles(text);

    return NextResponse.json({ bubbles });
  } catch (error) {
    console.error("translate error", error);
    const message =
      error instanceof Error ? error.message : "Çeviri sırasında beklenmeyen hata";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
