import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextResponse } from "next/server";
import { expandBox, normalizeBubbleBox } from "@/lib/boxes";

export const runtime = "nodejs";
export const maxDuration = 60;

const DEFAULT_PRIMARY_MODEL = "gemini-2.5-flash-lite";
const DEFAULT_FALLBACK_MODEL = "gemini-3.1-flash-lite";

type TranslateBody = {
  imageBase64: string;
  mimeType: string;
  targetLanguage: string;
  sourceLanguage?: string;
  imageWidth?: number;
  imageHeight?: number;
};

type BubbleResult = {
  original: string;
  translated: string;
  readingOrder: number;
  box: { x: number; y: number; w: number; h: number };
  bubbleBox: { x: number; y: number; w: number; h: number };
};

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function parseBubbles(
  raw: string,
  imageWidth?: number,
  imageHeight?: number,
): BubbleResult[] {
  const cleaned = stripCodeFence(raw);
  const parsed = JSON.parse(cleaned) as { bubbles?: unknown[] } | unknown[];
  const bubbles = Array.isArray(parsed) ? parsed : parsed.bubbles;
  if (!Array.isArray(bubbles)) {
    throw new Error("Gemini yanıtı beklenen formatta değil");
  }

  return bubbles
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const b = item as Record<string, unknown>;
      const original = String(b.original ?? b.source ?? b.text ?? "").trim();
      const translated = String(b.translated ?? b.translation ?? b.target ?? "").trim();
      if (!original || !translated) return null;

      const textBox =
        normalizeBubbleBox(
          b.textBox ?? b.box ?? b.bbox ?? b.boundingBox,
          imageWidth,
          imageHeight,
        ) ?? normalizeBubbleBox(b, imageWidth, imageHeight);

      if (!textBox) return null;

      const bubbleBox =
        normalizeBubbleBox(
          b.bubbleBox ?? b.bubble ?? b.balloon ?? b.bubbleBounds,
          imageWidth,
          imageHeight,
        ) ?? expandBox(textBox, 0.18);

      return {
        original,
        translated,
        readingOrder:
          typeof b.readingOrder === "number" && Number.isFinite(b.readingOrder)
            ? b.readingOrder
            : index + 1,
        box: textBox,
        bubbleBox,
      } satisfies BubbleResult;
    })
    .filter((b): b is BubbleResult => b !== null)
    .sort((a, b) => a.readingOrder - b.readingOrder);
}

function getModelChain(): string[] {
  const primary = process.env.GEMINI_MODEL?.trim() || DEFAULT_PRIMARY_MODEL;
  const fallback =
    process.env.GEMINI_MODEL_FALLBACK?.trim() || DEFAULT_FALLBACK_MODEL;

  if (primary === fallback) return [primary];
  return [primary, fallback];
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Çeviri sırasında beklenmeyen hata";
}

async function generateWithModel(params: {
  apiKey: string;
  modelName: string;
  prompt: string;
  mimeType: string;
  base64Data: string;
  imageWidth?: number;
  imageHeight?: number;
}) {
  const genAI = new GoogleGenerativeAI(params.apiKey);
  const model = genAI.getGenerativeModel({
    model: params.modelName,
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json",
    },
  });

  const result = await model.generateContent([
    { text: params.prompt },
    {
      inlineData: {
        mimeType: params.mimeType.startsWith("image/")
          ? params.mimeType
          : "image/jpeg",
        data: params.base64Data,
      },
    },
  ]);

  return parseBubbles(result.response.text(), params.imageWidth, params.imageHeight);
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
    const {
      imageBase64,
      mimeType,
      targetLanguage,
      sourceLanguage,
      imageWidth,
      imageHeight,
    } = body;

    if (!imageBase64 || !mimeType || !targetLanguage) {
      return NextResponse.json(
        { error: "imageBase64, mimeType ve targetLanguage gerekli" },
        { status: 400 },
      );
    }

    const base64Data = imageBase64.includes(",")
      ? imageBase64.split(",")[1]
      : imageBase64;

    const sourceHint =
      sourceLanguage && sourceLanguage !== "auto"
        ? `Kaynak dil: ${sourceLanguage}.`
        : "Kaynak dili otomatik algıla.";

    const sizeHint =
      imageWidth && imageHeight
        ? `Görsel boyutu yaklaşık ${imageWidth}x${imageHeight}px.`
        : "";

    const prompt = `Sen bir manga/çizgi roman çevirmenisin. Sırayı BOZMA:

ZİNCİR:
1) Önce tüm YAZILARI algıla (her konuşma/düşünce metni)
2) Her yazı için BALONU algıla
3) Her balon için SINIRI (bubbleBox) ver
4) Çeviriyi üret

${sizeHint}
${sourceHint}

JSON alanları (zorunlu):
- original: görseldeki yazının tamamı (tüm satırlar)
- translated: hedef dil çevirisi
- readingOrder: okuma sırası (manga: sağdan sola, yukarıdan aşağı)
- textBox: yazının tam kutusu (0–1000). Çerçeveyi ALMA, yazının tamamını KAPSA.
- bubbleBox: balonun tamamını saran kutu (0–1000). Yazı bubbleBox'un İÇİNDE olmalı. Komşu paneli yutma.

Kurallar:
1) Koordinatlar 0–1000 tam sayı (x,y sol-üst; w,h boyut).
2) textBox ⊆ bubbleBox (taşma yok).
3) Hedef dil: ${targetLanguage}.
4) translated MUTLAKA ${targetLanguage} olsun — original ile aynı dilde kopyalama YASAK.
5) translated kısa, vurucu, balona sığar; uzarsa anlamı koruyarak kısalt.
6) Uydurma balon/yazı yok. Floating yazıysa bubbleBox ≈ textBox + küçük pay.
7) textBox yazının TÜM satırlarını kapsasın (eksik kutu silmeyi bozar).

SADECE JSON:
{
  "bubbles": [
    {
      "original": "orijinal metnin tamamı",
      "translated": "kısa çeviri",
      "readingOrder": 1,
      "textBox": { "x": 140, "y": 100, "w": 200, "h": 120 },
      "bubbleBox": { "x": 110, "y": 70, "w": 260, "h": 180 }
    }
  ]
}

Metin yoksa {"bubbles": []}`;

    const models = getModelChain();
    const failures: string[] = [];

    for (let i = 0; i < models.length; i += 1) {
      const modelName = models[i];
      try {
        const bubbles = await generateWithModel({
          apiKey,
          modelName,
          prompt,
          mimeType,
          base64Data,
          imageWidth,
          imageHeight,
        });
        return NextResponse.json({ bubbles, model: modelName });
      } catch (error) {
        const message = errorMessage(error);
        failures.push(`${modelName}: ${message}`);
        console.error(`translate failed with ${modelName}`, error);
        if (i >= models.length - 1) {
          return NextResponse.json(
            { error: `Tüm modeller başarısız oldu. ${failures.join(" | ")}` },
            { status: 500 },
          );
        }
      }
    }

    return NextResponse.json({ error: "Çeviri modeli seçilemedi" }, { status: 500 });
  } catch (error) {
    console.error("translate error", error);
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}
