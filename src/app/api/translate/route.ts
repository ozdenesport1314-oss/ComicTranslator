import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const DEFAULT_PRIMARY_MODEL = "gemini-2.5-flash-lite";
const DEFAULT_FALLBACK_MODEL = "gemini-3.1-flash-lite";

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
  box: { x: number; y: number; w: number; h: number };
};

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function clamp01(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function normalizeBox(raw: unknown): BubbleResult["box"] | null {
  if (!raw || typeof raw !== "object") return null;
  const box = raw as Record<string, unknown>;
  const x = Number(box.x);
  const y = Number(box.y);
  const w = Number(box.w ?? box.width);
  const h = Number(box.h ?? box.height);
  if (![x, y, w, h].every((v) => Number.isFinite(v))) return null;
  if (w <= 0 || h <= 0) return null;

  // Accept either 0–1 normalized or 0–100 percentage
  const scale = Math.max(x, y, w, h) > 1.5 ? 100 : 1;
  const nx = clamp01(x / scale);
  const ny = clamp01(y / scale);
  const nw = clamp01(w / scale);
  const nh = clamp01(h / scale);
  if (nw < 0.01 || nh < 0.01) return null;
  return {
    x: nx,
    y: ny,
    w: Math.min(nw, 1 - nx),
    h: Math.min(nh, 1 - ny),
  };
}

function parseBubbles(raw: string): BubbleResult[] {
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
      const original = String(b.original ?? "").trim();
      const translated = String(b.translated ?? "").trim();
      if (!original || !translated) return null;
      const box = normalizeBox(b.box);
      if (!box) return null;
      return {
        original,
        translated,
        readingOrder:
          typeof b.readingOrder === "number" && Number.isFinite(b.readingOrder)
            ? b.readingOrder
            : index + 1,
        box,
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
}) {
  const genAI = new GoogleGenerativeAI(params.apiKey);
  const model = genAI.getGenerativeModel({
    model: params.modelName,
    generationConfig: {
      temperature: 0.2,
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

  return parseBubbles(result.response.text());
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

    const sourceHint =
      sourceLanguage && sourceLanguage !== "auto"
        ? `Kaynak dil: ${sourceLanguage}.`
        : "Kaynak dili otomatik algıla.";

    const prompt = `Sen bir manga/çizgi roman çevirmenisin. Bu sayfadaki konuşma baloncukları, düşünce baloncukları, ses efektleri (SFX) ve panellerdeki önemli yazıları bul.

Görev:
1) Her metin bölgesinin sınır kutusunu (bounding box) ver.
2) box değerleri NORMALİZE edilmiş olsun: x,y,w,h hepsi 0 ile 1 arasında (görsel genişlik/yüksekliğine oran).
   - x,y = kutunun sol-üst köşesi
   - w,h = genişlik ve yükseklik
   - Kutu metnin tamamını ve biraz boşluğu kapsasın; balon çerçevesini mümkün olduğunca dışarıda bırak.
3) Metinleri okuma sırasına göre çıkar (manga: sağdan sola / yukarıdan aşağı; batı: soldan sağa).
4) Her metni hedef dile çevir: ${targetLanguage}.
5) ${sourceHint}
6) Karakter tarzını ve manga tonunu koru. Uydurma metin ekleme.
7) Çeviriyi balona sığacak kadar kısa/doğal tut.

Yanıtı SADECE şu JSON şemasında ver:
{
  "bubbles": [
    {
      "original": "orijinal metin",
      "translated": "çevrilmiş metin",
      "readingOrder": 1,
      "box": { "x": 0.12, "y": 0.08, "w": 0.22, "h": 0.14 }
    }
  ]
}

Metin yoksa {"bubbles": []} döndür.`;

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
        });
        return NextResponse.json({ bubbles, model: modelName });
      } catch (error) {
        const message = errorMessage(error);
        failures.push(`${modelName}: ${message}`);
        console.error(`translate failed with ${modelName}`, error);

        const hasNext = i < models.length - 1;
        if (!hasNext) {
          return NextResponse.json(
            {
              error: `Tüm modeller başarısız oldu. ${failures.join(" | ")}`,
            },
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
