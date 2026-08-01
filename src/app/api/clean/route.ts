import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 120;

type CleanBody = {
  imageBase64: string;
  threshold?: number;
  grow?: number;
};

type ServiceResponse = {
  imageBase64: string;
  coverage: number;
  blocks: number;
  ms: number;
};

export async function POST(request: Request) {
  const serviceUrl = process.env.CLEANUP_SERVICE_URL;
  if (!serviceUrl) {
    return NextResponse.json(
      {
        error:
          "CLEANUP_SERVICE_URL tanımlı değil. Temizleme servisini çalıştırıp adresini ayarla.",
      },
      { status: 503 },
    );
  }

  let body: CleanBody;
  try {
    body = (await request.json()) as CleanBody;
  } catch {
    return NextResponse.json({ error: "Geçersiz istek" }, { status: 400 });
  }
  if (!body.imageBase64) {
    return NextResponse.json({ error: "imageBase64 gerekli" }, { status: 400 });
  }

  try {
    const response = await fetch(`${serviceUrl.replace(/\/$/, "")}/clean`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        imageBase64: body.imageBase64,
        threshold: body.threshold ?? 0.3,
        grow: body.grow ?? 2,
        restrictToBlocks: true,
      }),
    });
    if (!response.ok) {
      const detail = await response.text();
      return NextResponse.json(
        { error: `Temizleme servisi hata verdi: ${detail.slice(0, 300)}` },
        { status: 502 },
      );
    }
    const data = (await response.json()) as ServiceResponse;
    return NextResponse.json(data);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Servise ulaşılamadı";
    return NextResponse.json(
      { error: `Temizleme servisine bağlanılamadı: ${message}` },
      { status: 502 },
    );
  }
}
