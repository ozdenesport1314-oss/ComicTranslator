import { nanoid } from "nanoid";
import type { ComicPage } from "./types";

async function loadPdfJs() {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;
  return pdfjs;
}

function canvasToDataUrl(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL("image/jpeg", 0.88);
}

export async function fileToPages(file: File): Promise<ComicPage[]> {
  if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    return pdfToPages(file);
  }

  if (!file.type.startsWith("image/")) {
    throw new Error(`Desteklenmeyen dosya türü: ${file.type || file.name}`);
  }

  const dataUrl = await readFileAsDataUrl(file);
  return [
    {
      id: nanoid(),
      name: file.name,
      imageDataUrl: dataUrl,
      mimeType: file.type || "image/jpeg",
      bubbles: [],
      status: "pending",
    },
  ];
}

async function pdfToPages(file: File): Promise<ComicPage[]> {
  const pdfjs = await loadPdfJs();
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({ data }).promise;
  const pages: ComicPage[] = [];
  const maxPages = Math.min(pdf.numPages, 40);

  for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1.6 });
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas desteklenmiyor");

    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvas, canvasContext: context, viewport }).promise;

    pages.push({
      id: nanoid(),
      name: `${file.name.replace(/\.pdf$/i, "")} — sayfa ${pageNum}`,
      imageDataUrl: canvasToDataUrl(canvas),
      mimeType: "image/jpeg",
      bubbles: [],
      status: "pending",
    });
  }

  return pages;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Dosya okunamadı"));
    reader.readAsDataURL(file);
  });
}

export async function compressDataUrl(
  dataUrl: string,
  maxWidth = 1600,
  quality = 0.82,
): Promise<{ dataUrl: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxWidth / img.width);
      const width = Math.round(img.width * scale);
      const height = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Canvas desteklenmiyor"));
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      resolve({ dataUrl: canvas.toDataURL("image/jpeg", quality), mimeType: "image/jpeg" });
    };
    img.onerror = () => reject(new Error("Görsel sıkıştırılamadı"));
    img.src = dataUrl;
  });
}
