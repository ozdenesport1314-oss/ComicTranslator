/**
 * Model tabanlı temizleme istemcisi.
 *
 * Tarayıcı içi sezgisel temizlik (parlaklık eşiği + bileşen kuralları) her
 * sayfada farklı kırılıyordu. Bu yol sayfayı servise gönderir; maske manga
 * üzerinde eğitilmiş bir modelden gelir, boşluk inpaint ile doldurulur.
 */

export type ServiceTextBlock = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  confidence: number;
  /** "erased": yazı silindi, üstüne çeviri yazılabilir.
   *  "kept": sanat korundu (dokulu zeminde SFX), çeviri bindirilmeli. */
  kind: "erased" | "kept";
};

export type ServiceCleanResult = {
  imageDataUrl: string;
  coverage: number;
  blocks: ServiceTextBlock[];
  /** Sanat hasarı riski nedeniyle dokunulmayan bölgeler */
  kept: Array<[number, number, number, number]>;
  ms: number;
};

export async function cleanPageWithService(
  imageDataUrl: string,
): Promise<ServiceCleanResult> {
  const response = await fetch("/api/clean", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageBase64: imageDataUrl }),
  });
  const data = (await response.json()) as {
    imageBase64?: string;
    coverage?: number;
    blocks?: ServiceTextBlock[];
    kept?: Array<[number, number, number, number]>;
    ms?: number;
    error?: string;
  };
  if (!response.ok || !data.imageBase64) {
    throw new Error(data.error || "Model temizliği başarısız");
  }
  return {
    imageDataUrl: data.imageBase64,
    coverage: data.coverage ?? 0,
    blocks: data.blocks ?? [],
    kept: data.kept ?? [],
    ms: data.ms ?? 0,
  };
}
