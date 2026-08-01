import {
  findEnclosedBalloon,
  letterDomain,
  type TextRect,
} from "./balloonSegment";
import { expandBox } from "./boxes";
import type { BubbleBox, BubblePoint, BubbleTranslation } from "./types";

/**
 * Comic erase/render pipeline (BallonsTranslator / manga-image-translator style):
 *
 * PART 1  Balonu bulma
 * PART 2  Yazı türünü anlama (light/dark, paper color)
 * PART 3  Sınırı tanımlama + redzone
 * PART 4  Yazıyı tanıma (***** harf ink mask)
 * PART 6  Yazıyı silme (sadece harf pikseli — dikdörtgen/balon boyama YOK)
 * PART 7  Sınırı zorunlu koruma (redzone’a yazma yasağı)
 * PART 9  Hasar kontrolü (kalan yazı + sınır bozulması)
 * PART 10 Sınırı geri onarma (snapshot restore)
 * PART 11 Çeviri — silme skoru ≥ CLEAN_THRESHOLD (test: %90, hedef: %99)
 */

/** Test eşiği %90 — ileride %99'a çekilecek */
const CLEAN_THRESHOLD = 0.9;

export type RenderOptions = {
  showRedzone?: boolean;
};

type PxBox = { x: number; y: number; w: number; h: number };
type Rgb = { r: number; g: number; b: number };
type TextKind = {
  mode: "light" | "dark";
  fill: Rgb;
  cut: number;
};

type Boundary = {
  interior: Uint8Array;
  redzone: Uint8Array;
  stroke: Uint8Array;
  bounds: PxBox | null;
  /** Original RGBA snapshot of redzone+stroke neighborhood for PART 10 */
  borderBackup: ImageData;
  backupX: number;
  backupY: number;
  /** true = kapalı balon bulundu; false = harf-only temizlik (balon yok) */
  enclosed: boolean;
};

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Görsel yüklenemedi"));
    img.src = src;
  });
}

async function ensureComicFont() {
  if (typeof document === "undefined" || !document.fonts?.load) return;
  try {
    await document.fonts.load('400 48px "Bangers"');
    await document.fonts.load('700 48px "Comic Neue"');
  } catch {
    /* ignore */
  }
}

function comicFontStack() {
  if (typeof document === "undefined") {
    return '"Bangers", "Comic Neue", "Arial Black", Impact, sans-serif';
  }
  const loaded = getComputedStyle(document.documentElement)
    .getPropertyValue("--font-comic")
    .trim();
  return loaded
    ? `${loaded}, "Bangers", "Comic Neue", "Arial Black", Impact, sans-serif`
    : '"Bangers", "Comic Neue", "Arial Black", Impact, sans-serif';
}

function comicFont(size: number) {
  return `400 ${size}px ${comicFontStack()}`;
}

function toPx(box: BubbleBox, width: number, height: number): PxBox {
  return {
    x: box.x * width,
    y: box.y * height,
    w: Math.max(1, box.w * width),
    h: Math.max(1, box.h * height),
  };
}

function polygonToPx(
  polygon: BubblePoint[] | undefined,
  width: number,
  height: number,
): Array<{ x: number; y: number }> | undefined {
  if (!polygon || polygon.length < 4) return undefined;
  return polygon.map((p) => ({ x: p.x * width, y: p.y * height }));
}

function polygonBounds(polygon: Array<{ x: number; y: number }>): PxBox {
  const xs = polygon.map((p) => p.x);
  const ys = polygon.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x,
    y,
    w: Math.max(1, Math.max(...xs) - x),
    h: Math.max(1, Math.max(...ys) - y),
  };
}

/** PART 1 — Balonu bulma */
function part1FindBubble(bubble: BubbleTranslation): BubbleBox {
  return bubble.bubbleBox ?? expandBox(bubble.box, 0.25);
}

/**
 * Balon arama penceresi. Gemini kutusu balonu küçük gösterdiği için flood fill
 * kutuya çarpıp dikdörtgen üretiyordu. Pencere bilerek geniş: balonun gerçek
 * kenarı kırpma sınırından ÖNCE bulunsun.
 */
function balloonSearchWindow(
  textPx: PxBox,
  hintPx: PxBox,
  width: number,
  height: number,
): PxBox {
  const padX = Math.max(hintPx.w * 0.6, textPx.w * 0.75, 20);
  const padY = Math.max(hintPx.h * 0.6, textPx.h * 1.0, 20);
  const left = Math.min(textPx.x, hintPx.x) - padX;
  const top = Math.min(textPx.y, hintPx.y) - padY;
  const right = Math.max(textPx.x + textPx.w, hintPx.x + hintPx.w) + padX;
  const bottom = Math.max(textPx.y + textPx.h, hintPx.y + hintPx.h) + padY;
  const x = Math.max(0, left);
  const y = Math.max(0, top);
  return {
    x,
    y,
    w: Math.max(8, Math.min(width, right) - x),
    h: Math.max(8, Math.min(height, bottom) - y),
  };
}

function clipTextInsideBubble(text: PxBox, bubble: PxBox): PxBox {
  const x = Math.max(text.x, bubble.x + bubble.w * 0.03);
  const y = Math.max(text.y, bubble.y + bubble.h * 0.03);
  const r = Math.min(text.x + text.w, bubble.x + bubble.w * 0.97);
  const b = Math.min(text.y + text.h, bubble.y + bubble.h * 0.97);
  return {
    x,
    y,
    w: Math.max(4, r - x),
    h: Math.max(4, b - y),
  };
}

function estimateLineCount(text: string): number {
  const explicit = text.split(/\n+/).filter(Boolean).length;
  if (explicit > 1) return explicit;
  return Math.max(1, Math.min(8, Math.ceil(text.length / 16)));
}

function comicCase(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s*\.\.\.\s*/g, "…")
    .trim()
    .toLocaleUpperCase("tr-TR");
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function luminance(r: number, g: number, b: number) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function isProtected(
  gx: number,
  gy: number,
  width: number,
  height: number,
  redzone: Uint8Array,
  stroke: Uint8Array,
  pad = 1,
): boolean {
  if (gx < 0 || gy < 0 || gx >= width || gy >= height) return true;
  for (let dy = -pad; dy <= pad; dy += 1) {
    for (let dx = -pad; dx <= pad; dx += 1) {
      const nx = gx + dx;
      const ny = gy + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) return true;
      const g = ny * width + nx;
      if (redzone[g] || stroke[g]) return true;
    }
  }
  return false;
}

/**
 * Silme izni: SADECE balon interior ∩ ¬redzone.
 * Interior yoksa balon dışına beyaz katman taşıyordu (yüz/zırh hasarı).
 */
function canEraseAt(
  gx: number,
  gy: number,
  width: number,
  height: number,
  interior: Uint8Array,
  redzone: Uint8Array,
  stroke: Uint8Array,
): boolean {
  if (gx < 0 || gy < 0 || gx >= width || gy >= height) return false;
  const g = gy * width + gx;
  if (!interior[g]) return false;
  if (redzone[g] || stroke[g]) return false;
  if (isProtected(gx, gy, width, height, redzone, stroke, 1)) return false;
  return true;
}

/** Gerçek harf mürekkebi — kağıdı / çeviri altı beyaz katmanı YASAK */
function looksLikeInk(
  lum: Float32Array,
  p: number,
  rw: number,
  rh: number,
  mode: "light" | "dark",
  cut: number,
): boolean {
  const v = lum[p];
  if (mode === "light") {
    // Sadece koyu stroke; orta gri kağıdı silme → beyaz dikdörtgen olmasın
    if (v > Math.min(cut, 115)) return false;
    if (v <= 85) return true;
  } else {
    if (v < Math.max(cut, 150)) return false;
    if (v >= 185) return true;
  }
  const y = Math.floor(p / rw);
  const x = p - y * rw;
  let paper = 0;
  let n = 0;
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      if (!dx && !dy) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= rw || ny >= rh) continue;
      const nv = lum[ny * rw + nx];
      const isPaper = mode === "light" ? nv > 190 : nv < 50;
      if (isPaper) {
        paper += nv;
        n += 1;
      }
    }
  }
  if (!n) return mode === "light" ? v < 100 : v > 160;
  const paperAvg = paper / n;
  return mode === "light" ? paperAvg - v >= 45 : v - paperAvg >= 45;
}

/** Ham mürekkep — yalnızca balon interior (orijinal yazı), çeviri-altı alanı değil */
function countRawInkPixels(
  data: Uint8ClampedArray,
  rw: number,
  rh: number,
  x0: number,
  y0: number,
  width: number,
  height: number,
  interior: Uint8Array,
  redzone: Uint8Array,
  stroke: Uint8Array,
  kind: TextKind,
): number {
  const lum = new Float32Array(rw * rh);
  for (let p = 0, i = 0; p < rw * rh; p += 1, i += 4) {
    lum[p] = luminance(data[i], data[i + 1], data[i + 2]);
  }
  let n = 0;
  for (let p = 0; p < rw * rh; p += 1) {
    const gx = x0 + (p % rw);
    const gy = y0 + Math.floor(p / rw);
    if (!canEraseAt(gx, gy, width, height, interior, redzone, stroke)) continue;
    if (looksLikeInk(lum, p, rw, rh, kind.mode, kind.cut)) n += 1;
  }
  return n;
}

function sameLanguageLeak(original: string, translated: string): boolean {
  const a = original.replace(/\s+/g, " ").trim().toLowerCase();
  const b = translated.replace(/\s+/g, " ").trim().toLowerCase();
  if (!a || !b) return true;
  if (a === b) return true;
  // Çeviri hâlâ büyük ölçüde kaynak metin
  const aw = new Set(a.split(" ").filter((w) => w.length > 2));
  let hit = 0;
  for (const w of b.split(" ")) if (aw.has(w)) hit += 1;
  const bw = b.split(" ").filter((w) => w.length > 2).length || 1;
  return hit / bw >= 0.7;
}

/** PART 2 — Yazı türünü anlama */
function part2UnderstandTextType(
  ctx: CanvasRenderingContext2D,
  textPx: PxBox,
  width: number,
  height: number,
): TextKind {
  const x0 = Math.max(0, Math.floor(textPx.x));
  const y0 = Math.max(0, Math.floor(textPx.y));
  const x1 = Math.min(width, Math.ceil(textPx.x + textPx.w));
  const y1 = Math.min(height, Math.ceil(textPx.y + textPx.h));
  const rw = Math.max(1, x1 - x0);
  const rh = Math.max(1, y1 - y0);
  const img = ctx.getImageData(x0, y0, rw, rh);
  const { data } = img;

  const lums: number[] = [];
  const papers: Rgb[] = [];
  for (let p = 0, i = 0; p < rw * rh; p += 1, i += 4) {
    const v = luminance(data[i], data[i + 1], data[i + 2]);
    lums.push(v);
  }
  lums.sort((a, b) => a - b);
  const med = lums[Math.floor(lums.length / 2)] ?? 220;
  const mode: "light" | "dark" = med >= 115 ? "light" : "dark";

  for (let p = 0, i = 0; p < rw * rh; p += 1, i += 4) {
    const v = luminance(data[i], data[i + 1], data[i + 2]);
    const paper = mode === "light" ? v >= 185 : v <= 55;
    if (paper) papers.push({ r: data[i], g: data[i + 1], b: data[i + 2] });
  }

  const fill: Rgb = (() => {
    if (!papers.length) {
      return mode === "light"
        ? { r: 252, g: 252, b: 252 }
        : { r: 12, g: 12, b: 12 };
    }
    return {
      r: Math.round(median(papers.map((p) => p.r))),
      g: Math.round(median(papers.map((p) => p.g))),
      b: Math.round(median(papers.map((p) => p.b))),
    };
  })();

  const darkRef = lums[Math.floor(lums.length * 0.12)] ?? 40;
  const lightRef = lums[Math.floor(lums.length * 0.88)] ?? 230;
  const cut =
    mode === "light"
      ? Math.min(145, Math.max(95, darkRef + 42))
      : Math.max(110, Math.min(185, lightRef - 45));

  return { mode, fill, cut };
}

function dilateMask(src: Uint8Array, rw: number, rh: number): Uint8Array {
  const out = new Uint8Array(rw * rh);
  out.set(src);
  for (let y = 1; y < rh - 1; y += 1) {
    for (let x = 1; x < rw - 1; x += 1) {
      const p = y * rw + x;
      if (src[p]) continue;
      if (src[p - 1] || src[p + 1] || src[p - rw] || src[p + rw]) out[p] = 1;
    }
  }
  return out;
}

function erodeMask(src: Uint8Array, rw: number, rh: number): Uint8Array {
  const out = new Uint8Array(rw * rh);
  for (let y = 1; y < rh - 1; y += 1) {
    for (let x = 1; x < rw - 1; x += 1) {
      const p = y * rw + x;
      if (!src[p]) continue;
      if (src[p - 1] && src[p + 1] && src[p - rw] && src[p + rw]) out[p] = 1;
    }
  }
  return out;
}

/**
 * Balon maskesinin içinde kapalı kalan TÜM boşlukları doldurur.
 * Harflerin siyah gövdeleri maskede delik kalamaz; dış bölgeye bağlı alanlara
 * dokunulmaz. Bu, nokta/çizgi kalıntısını balon kabuğuna zarar vermeden kapatır.
 */
function fillEnclosedHoles(
  src: Uint8Array,
  rw: number,
  rh: number,
): Uint8Array {
  const exterior = new Uint8Array(rw * rh);
  const queue = new Int32Array(rw * rh);
  let qh = 0;
  let qt = 0;

  const addExterior = (p: number) => {
    if (p < 0 || p >= src.length || src[p] || exterior[p]) return;
    exterior[p] = 1;
    queue[qt++] = p;
  };

  // Mask crop'un bütün dış kenarlarından dış bölgeyi flood et.
  for (let x = 0; x < rw; x += 1) {
    addExterior(x);
    addExterior((rh - 1) * rw + x);
  }
  for (let y = 0; y < rh; y += 1) {
    addExterior(y * rw);
    addExterior(y * rw + rw - 1);
  }

  while (qh < qt) {
    const p = queue[qh++];
    const y = Math.floor(p / rw);
    const x = p - y * rw;
    if (x > 0) addExterior(p - 1);
    if (x + 1 < rw) addExterior(p + 1);
    if (y > 0) addExterior(p - rw);
    if (y + 1 < rh) addExterior(p + rw);
  }

  const out = new Uint8Array(src);
  for (let p = 0; p < out.length; p += 1) {
    // Sıfır ama dışarıya bağlı değil = balon içindeki harf/nokta deliği.
    if (!out[p] && !exterior[p]) out[p] = 1;
  }
  return out;
}

/**
 * Balon yok (floating/SFX yazı ya da kağıt panele akıyor). Dikdörtgen ya da
 * elips uydurmak yerine yalnızca HARF pikselleri temizlenebilir alan olur;
 * geri kalan her şey dokunulmazdır.
 */
function letterOnlyBoundary(
  ctx: CanvasRenderingContext2D,
  lum: Float32Array,
  rw: number,
  rh: number,
  x0: number,
  y0: number,
  width: number,
  height: number,
  text: TextRect,
  kind: TextKind,
): Boundary {
  const empty: Boundary = {
    interior: new Uint8Array(width * height),
    redzone: new Uint8Array(width * height),
    stroke: new Uint8Array(width * height),
    bounds: null,
    borderBackup: ctx.createImageData(1, 1),
    backupX: 0,
    backupY: 0,
    enclosed: false,
  };

  const domain = letterDomain(lum, rw, rh, kind.mode, text, {
    cut: kind.cut,
    paperLum: luminance(kind.fill.r, kind.fill.g, kind.fill.b),
  });
  // Kağıt zemin yok → yazı doğrudan sanatın üstünde. Silmek hasar demek.
  if (!domain) return empty;

  const interior = new Uint8Array(width * height);
  let minX = rw;
  let minY = rh;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < rh; y += 1) {
    for (let x = 0; x < rw; x += 1) {
      if (!domain[y * rw + x]) continue;
      interior[(y0 + y) * width + (x0 + x)] = 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  return {
    interior,
    redzone: new Uint8Array(width * height),
    stroke: new Uint8Array(width * height),
    bounds:
      maxX < 0
        ? null
        : {
            x: x0 + minX,
            y: y0 + minY,
            w: maxX - minX + 1,
            h: maxY - minY + 1,
          },
    borderBackup: ctx.getImageData(x0, y0, rw, rh),
    backupX: x0,
    backupY: y0,
    enclosed: false,
  };
}

/**
 * PART 3 — Balon algılama + REDZONE kabuğu (kullanıcı diyagramı):
 *
 *   {{{{{  redzone = balon kenarı  }}}}}
 *   {  *** interior (yazı+kağıt)  }
 *   {{{{{                   }}}}}
 *
 * Morphological close ile harf delikleri kapanır → tam balon şekli.
 */
function part3DefineBoundary(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  searchPx: PxBox,
  textPx: PxBox,
  hintPx: PxBox,
  kind: TextKind,
): Boundary {
  const x0 = Math.max(0, Math.floor(searchPx.x));
  const y0 = Math.max(0, Math.floor(searchPx.y));
  const x1 = Math.min(width, Math.ceil(searchPx.x + searchPx.w));
  const y1 = Math.min(height, Math.ceil(searchPx.y + searchPx.h));
  const rw = x1 - x0;
  const rh = y1 - y0;

  const empty: Boundary = {
    interior: new Uint8Array(width * height),
    redzone: new Uint8Array(width * height),
    stroke: new Uint8Array(width * height),
    bounds: null,
    borderBackup: ctx.createImageData(1, 1),
    backupX: 0,
    backupY: 0,
    enclosed: false,
  };
  if (rw < 6 || rh < 6) return empty;

  const img = ctx.getImageData(x0, y0, rw, rh);
  const { data } = img;
  const lum = new Float32Array(rw * rh);
  for (let p = 0, i = 0; p < rw * rh; p += 1, i += 4) {
    lum[p] = luminance(data[i], data[i + 1], data[i + 2]);
  }

  const { mode } = kind;

  const text: TextRect = {
    x0: Math.max(0, Math.min(rw - 1, Math.floor(textPx.x) - x0)),
    y0: Math.max(0, Math.min(rh - 1, Math.floor(textPx.y) - y0)),
    x1: Math.max(0, Math.min(rw - 1, Math.ceil(textPx.x + textPx.w) - x0)),
    y1: Math.max(0, Math.min(rh - 1, Math.ceil(textPx.y + textPx.h) - y0)),
  };
  const letterOnly = () =>
    letterOnlyBoundary(ctx, lum, rw, rh, x0, y0, width, height, text, kind);

  // Gemini kutusu şekli belirlemez; yalnızca balonun ölçek sınırıdır.
  const hint: TextRect = {
    x0: Math.max(0, Math.min(rw - 1, Math.floor(hintPx.x) - x0)),
    y0: Math.max(0, Math.min(rh - 1, Math.floor(hintPx.y) - y0)),
    x1: Math.max(0, Math.min(rw - 1, Math.ceil(hintPx.x + hintPx.w) - x0)),
    y1: Math.max(0, Math.min(rh - 1, Math.ceil(hintPx.y + hintPx.h) - y0)),
  };

  // 1–2) Balonu gerçekten ara: kapalı kenar bulunamazsa balon yok kabul edilir.
  const bubble = findEnclosedBalloon(lum, rw, rh, mode, text, hint);
  if (!bubble) return letterOnly();

  // 3) Morphological CLOSE — harf deliklerini kapat → tam balon gövdesi
  //    {{{{ redzone }}}} içinde *** dolu balon
  let closed: Uint8Array = new Uint8Array(bubble);
  for (let i = 0; i < 4; i += 1) closed = dilateMask(closed, rw, rh);
  for (let i = 0; i < 4; i += 1) closed = erodeMask(closed, rw, rh);
  // Close sonrası sadece orijinal flood bölgesine yakın kalsın (sanat taşmasın)
  // ama harf içlerini tut: closed ∩ dilate(bubble, 6)
  let bubbleGrow: Uint8Array = new Uint8Array(bubble);
  for (let i = 0; i < 6; i += 1) bubbleGrow = dilateMask(bubbleGrow, rw, rh);
  for (let p = 0; p < rw * rh; p += 1) {
    if (closed[p] && !bubbleGrow[p]) closed[p] = 0;
  }
  // Harf, nokta ve çizgilerin oluşturduğu kapalı delikleri kesin kapat.
  closed = fillEnclosedHoles(closed, rw, rh);

  let count = 0;
  for (let i = 0; i < closed.length; i += 1) if (closed[i]) count += 1;
  // Elips/dikdörtgen uydurmak balon hasarı üretiyordu; balon çok küçükse
  // yalnızca harf temizliğine düş.
  if (count < 40) return letterOnly();

  // 4) REDZONE kabuğu = dış rim (balon çizgisi bandı) — harf değil
  const outerRim = new Uint8Array(rw * rh);
  for (let y = 0; y < rh; y += 1) {
    for (let x = 0; x < rw; x += 1) {
      const p = y * rw + x;
      if (!closed[p]) continue;
      let edge = x === 0 || y === 0 || x === rw - 1 || y === rh - 1;
      if (!edge) {
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = x + dx;
          const ny = y + dy;
          if (
            nx < 0 ||
            ny < 0 ||
            nx >= rw ||
            ny >= rh ||
            !closed[ny * rw + nx]
          ) {
            edge = true;
            break;
          }
        }
      }
      if (edge) outerRim[p] = 1;
    }
  }

  // Kabuğu kalınlaştır + balon DIŞINDAKI koyu stroke'u da kapsa
  let redLocal: Uint8Array = new Uint8Array(outerRim);
  for (let pass = 0; pass < 3; pass += 1) redLocal = dilateMask(redLocal, rw, rh);

  // Dışarıdaki gerçek balon çizgisi (closed'a bitişik koyu)
  for (let y = 1; y < rh - 1; y += 1) {
    for (let x = 1; x < rw - 1; x += 1) {
      const p = y * rw + x;
      if (closed[p]) continue;
      const v = lum[p];
      const dark = mode === "light" ? v < 90 : v > 170;
      if (!dark) continue;
      let near = false;
      for (let dy = -2; dy <= 2 && !near; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          if (closed[(y + dy) * rw + (x + dx)]) {
            near = true;
            break;
          }
        }
      }
      if (near) redLocal[p] = 1;
    }
  }

  const interior = new Uint8Array(width * height);
  const redzone = new Uint8Array(width * height);
  const stroke = new Uint8Array(width * height);

  for (let y = 0; y < rh; y += 1) {
    for (let x = 0; x < rw; x += 1) {
      const p = y * rw + x;
      const g = (y0 + y) * width + (x0 + x);
      if (redLocal[p]) {
        redzone[g] = 1;
        const v = lum[p];
        if (mode === "light" ? v < 110 : v > 150) stroke[g] = 1;
      } else if (closed[p]) {
        interior[g] = 1;
      }
    }
  }

  // Interior'dan redzone çıkar (kenar bandı yazılamaz/silinemez)
  for (let i = 0; i < interior.length; i += 1) {
    if (redzone[i]) interior[i] = 0;
  }

  let minX = rw;
  let minY = rh;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < rh; y += 1) {
    for (let x = 0; x < rw; x += 1) {
      if (!interior[(y0 + y) * width + (x0 + x)]) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  const bounds =
    maxX < 0
      ? null
      : { x: x0 + minX, y: y0 + minY, w: maxX - minX + 1, h: maxY - minY + 1 };

  const borderBackup = ctx.getImageData(x0, y0, rw, rh);

  return {
    interior,
    redzone,
    stroke,
    bounds,
    borderBackup,
    backupX: x0,
    backupY: y0,
    enclosed: true,
  };
}

/** PART 4 — Yazıyı tanıma: ***** harf ink components */
function part4RecognizeTextInk(
  data: Uint8ClampedArray,
  rw: number,
  rh: number,
  x0: number,
  y0: number,
  width: number,
  height: number,
  interior: Uint8Array,
  redzone: Uint8Array,
  stroke: Uint8Array,
  kind: TextKind,
  sensitive: boolean,
): Uint8Array {
  const lum = new Float32Array(rw * rh);
  for (let p = 0, i = 0; p < rw * rh; p += 1, i += 4) {
    lum[p] = luminance(data[i], data[i + 1], data[i + 2]);
  }

  // sensitive sadece biraz gevşetir — kağıdı yutacak kadar değil (beyaz dikdörtgen önlemi)
  const cut = sensitive
    ? kind.mode === "light"
      ? Math.min(138, kind.cut + 8)
      : Math.max(120, kind.cut - 8)
    : kind.cut;

  const ink = new Uint8Array(rw * rh);
  for (let p = 0; p < rw * rh; p += 1) {
    const gx = x0 + (p % rw);
    const gy = y0 + Math.floor(p / rw);
    if (!canEraseAt(gx, gy, width, height, interior, redzone, stroke)) continue;
    if (looksLikeInk(lum, p, rw, rh, kind.mode, cut)) ink[p] = 1;
  }

  // Component filter: sadece devasa panel dolgusunu ele (yazı bloğunu DEĞİL).
  // Eski solidRect + %12 maxArea tüm İngilizce diyalogu eliyordu → maske boş → skor %0.
  const labels = new Int32Array(rw * rh).fill(-1);
  const keep = new Uint8Array(rw * rh);
  const stack: number[] = [];
  const minSize = sensitive ? 1 : 2;
  const maxArea = Math.max(200, Math.floor(rw * rh * 0.65));

  for (let start = 0; start < rw * rh; start += 1) {
    if (!ink[start] || labels[start] >= 0) continue;
    const pixels: number[] = [];
    let minX = rw;
    let minY = rh;
    let maxX = -1;
    let maxY = -1;
    labels[start] = 1;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop() as number;
      pixels.push(p);
      const y = Math.floor(p / rw);
      const x = p - y * rw;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= rw || ny >= rh) continue;
          const np = ny * rw + nx;
          if (!ink[np] || labels[np] >= 0) continue;
          labels[np] = 1;
          stack.push(np);
        }
      }
    }
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const fillRatio = pixels.length / Math.max(1, bw * bh);
    // Sadece neredeyse dolu crop-boyutu blok = gerçek dikdörtgen artefakt
    const solidPanel =
      fillRatio > 0.92 &&
      pixels.length > maxArea * 0.8 &&
      bw > rw * 0.85 &&
      bh > rh * 0.85;
    const tooBig = pixels.length > maxArea;
    if (pixels.length >= minSize && !tooBig && !solidPanel) {
      for (const p of pixels) keep[p] = 1;
    }
  }

  // Hiç component kalmadıysa ham ink kullan (boş maske felaketi)
  let kept = 0;
  for (let i = 0; i < keep.length; i += 1) if (keep[i]) kept += 1;
  if (kept < 8) {
    for (let i = 0; i < ink.length; i += 1) keep[i] = ink[i];
  }

  // Dilate sadece koyu antialias halkası — beyaz kağıda genişleme YOK (beyaz katman önlemi)
  const out = new Uint8Array(keep);
  for (let y = 1; y < rh - 1; y += 1) {
    for (let x = 1; x < rw - 1; x += 1) {
      const p = y * rw + x;
      if (keep[p]) continue;
      if (!(keep[p - 1] || keep[p + 1] || keep[p - rw] || keep[p + rw])) {
        continue;
      }
      const gx = x0 + x;
      const gy = y0 + y;
      if (!canEraseAt(gx, gy, width, height, interior, redzone, stroke)) continue;
      // Komşu harf olsa bile açık kağıdı maskeleme
      if (kind.mode === "light" ? lum[p] > 150 : lum[p] < 90) continue;
      out[p] = 1;
    }
  }
  return out;
}

/** PART 6 — Yazıyı silme: sadece ***** mask pikselleri */
function part6EraseLetters(
  data: Uint8ClampedArray,
  mask: Uint8Array,
  rw: number,
  rh: number,
  kind: TextKind,
): number {
  let wiped = 0;
  for (let p = 0; p < rw * rh; p += 1) {
    if (!mask[p]) continue;
    const i = p * 4;
    // Local örnek koyu komşu harfleri içine alıp gri leke bırakıyordu.
    // Balonun PART 2'de ölçülen medyan kağıt rengini yalnızca harf maskesine uygula.
    data[i] = kind.fill.r;
    data[i + 1] = kind.fill.g;
    data[i + 2] = kind.fill.b;
    data[i + 3] = 255;
    wiped += 1;
  }
  return wiped;
}

/** PART 6b — Telea-benzeri inpaint (sadece kalan ink mask) */
function part6TeleaPass(
  data: Uint8ClampedArray,
  mask: Uint8Array,
  rw: number,
  rh: number,
  x0: number,
  y0: number,
  width: number,
  height: number,
  interior: Uint8Array,
  redzone: Uint8Array,
  stroke: Uint8Array,
): number {
  let active = new Uint8Array(mask);
  // Drop protected pixels from mask
  for (let p = 0; p < rw * rh; p += 1) {
    if (!active[p]) continue;
    const gx = x0 + (p % rw);
    const gy = y0 + Math.floor(p / rw);
    if (!canEraseAt(gx, gy, width, height, interior, redzone, stroke)) {
      active[p] = 0;
    }
  }

  let wiped = 0;
  for (let pass = 0; pass < 10; pass += 1) {
    const next = new Uint8Array(active);
    const updates: Array<{ p: number; r: number; g: number; b: number }> = [];
    for (let y = 1; y < rh - 1; y += 1) {
      for (let x = 1; x < rw - 1; x += 1) {
        const p = y * rw + x;
        if (!active[p]) continue;
        let wr = 0;
        let wg = 0;
        let wb = 0;
        let wsum = 0;
        for (let dy = -2; dy <= 2; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) {
            if (!dx && !dy) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= rw || ny >= rh) continue;
            const np = ny * rw + nx;
            if (active[np]) continue;
            const gx = x0 + nx;
            const gy = y0 + ny;
            if (!canEraseAt(gx, gy, width, height, interior, redzone, stroke) &&
                !interior[gy * width + gx]) {
              continue;
            }
            // Prefer already-clean paper neighbors
            if (redzone[gy * width + gx] || stroke[gy * width + gx]) continue;
            const dist = Math.hypot(dx, dy);
            const w = 1 / (dist * dist);
            const i = np * 4;
            wr += data[i] * w;
            wg += data[i + 1] * w;
            wb += data[i + 2] * w;
            wsum += w;
          }
        }
        if (wsum < 0.01) continue;
        updates.push({
          p,
          r: Math.round(wr / wsum),
          g: Math.round(wg / wsum),
          b: Math.round(wb / wsum),
        });
        next[p] = 0;
      }
    }
    if (!updates.length) break;
    for (const u of updates) {
      const i = u.p * 4;
      data[i] = u.r;
      data[i + 1] = u.g;
      data[i + 2] = u.b;
      data[i + 3] = 255;
      wiped += 1;
    }
    active = next;
  }
  return wiped;
}

/**
 * PART 10 — Sadece balon ÇİZGİSİNİ geri yükle.
 *
 * Eski hali redzone+halo’yu da restore ediyordu → snapshot’taki ORİJİNAL
 * İngilizce, silinen alanın / Türkçe çevirinin ÜSTÜNE geri yapışıyordu.
 * Bu yüzden: altta Türkçe, üstte İngilizce + beyaz kare.
 */
function part10RepairBoundaryWithWidth(
  ctx: CanvasRenderingContext2D,
  boundary: Boundary,
  width: number,
): void {
  const { borderBackup, backupX, backupY, stroke, interior } = boundary;
  const rw = borderBackup.width;
  const rh = borderBackup.height;
  const cur = ctx.getImageData(backupX, backupY, rw, rh);
  for (let y = 0; y < rh; y += 1) {
    for (let x = 0; x < rw; x += 1) {
      const gx = backupX + x;
      const gy = backupY + y;
      const g = gy * width + gx;
      // Interior’daki yazı alanına ASLA dokunma
      if (interior[g]) continue;
      if (!stroke[g]) continue;
      const i = (y * rw + x) * 4;
      // Sadece gerçek koyu çizgi pikseli (yazı/kağıt geri gelmesin)
      const br = borderBackup.data[i];
      const bg = borderBackup.data[i + 1];
      const bb = borderBackup.data[i + 2];
      const v = 0.299 * br + 0.587 * bg + 0.114 * bb;
      if (v > 120) continue;
      cur.data[i] = br;
      cur.data[i + 1] = bg;
      cur.data[i + 2] = bb;
      cur.data[i + 3] = borderBackup.data[i + 3];
    }
  }
  ctx.putImageData(cur, backupX, backupY);
}

/**
 * Zincir 3 — ince ayar: nokta/çizgi kadar kalanları spot sil
 * (BallonsTranslator spot-heal / residual dilate benzeri)
 */
function part6FineSpotErase(
  data: Uint8ClampedArray,
  rw: number,
  rh: number,
  x0: number,
  y0: number,
  width: number,
  height: number,
  interior: Uint8Array,
  redzone: Uint8Array,
  stroke: Uint8Array,
  kind: TextKind,
): number {
  const lum = new Float32Array(rw * rh);
  for (let p = 0, i = 0; p < rw * rh; p += 1, i += 4) {
    lum[p] = luminance(data[i], data[i + 1], data[i + 2]);
  }

  const cut =
    kind.mode === "light"
      ? Math.min(145, kind.cut + 12)
      : Math.max(115, kind.cut - 12);

  const ink = new Uint8Array(rw * rh);
  for (let p = 0; p < rw * rh; p += 1) {
    const gx = x0 + (p % rw);
    const gy = y0 + Math.floor(p / rw);
    if (!canEraseAt(gx, gy, width, height, interior, redzone, stroke)) continue;
    if (looksLikeInk(lum, p, rw, rh, kind.mode, cut)) ink[p] = 1;
  }

  // Tiny components only (dots / stroke crumbs), max 48px
  const labels = new Int32Array(rw * rh).fill(-1);
  const keep = new Uint8Array(rw * rh);
  const stack: number[] = [];
  for (let start = 0; start < rw * rh; start += 1) {
    if (!ink[start] || labels[start] >= 0) continue;
    const pixels: number[] = [];
    labels[start] = 1;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop() as number;
      pixels.push(p);
      const y = Math.floor(p / rw);
      const x = p - y * rw;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= rw || ny >= rh) continue;
          const np = ny * rw + nx;
          if (!ink[np] || labels[np] >= 0) continue;
          labels[np] = 1;
          stack.push(np);
        }
      }
    }
    if (pixels.length >= 1 && pixels.length <= 48) {
      for (const p of pixels) keep[p] = 1;
    }
  }

  // 1px dilate crumbs
  const mask = new Uint8Array(keep);
  for (let y = 1; y < rh - 1; y += 1) {
    for (let x = 1; x < rw - 1; x += 1) {
      const p = y * rw + x;
      if (keep[p]) continue;
      if (keep[p - 1] || keep[p + 1] || keep[p - rw] || keep[p + rw]) {
        const gx = x0 + x;
        const gy = y0 + y;
        if (canEraseAt(gx, gy, width, height, interior, redzone, stroke)) {
          mask[p] = 1;
        }
      }
    }
  }

  return part6EraseLetters(data, mask, rw, rh, kind);
}

function measureEraseScore(
  ctx: CanvasRenderingContext2D,
  rx0: number,
  ry0: number,
  rw: number,
  rh: number,
  width: number,
  height: number,
  interior: Uint8Array,
  redzone: Uint8Array,
  stroke: Uint8Array,
  kind: TextKind,
  inkBefore: number,
  boundary: Boundary,
): { score: number; leftover: number; borderOk: boolean } {
  part10RepairBoundaryWithWidth(ctx, boundary, width);
  const after = ctx.getImageData(rx0, ry0, rw, rh);
  const leftover = countRawInkPixels(
    after.data,
    rw,
    rh,
    rx0,
    ry0,
    width,
    height,
    interior,
    redzone,
    stroke,
    kind,
  );

  const bak = boundary.borderBackup;
  const full = ctx.getImageData(
    boundary.backupX,
    boundary.backupY,
    bak.width,
    bak.height,
  );
  let borderDamage = 0;
  let borderChecked = 0;
  for (let y = 0; y < bak.height; y += 1) {
    for (let x = 0; x < bak.width; x += 1) {
      const gx = boundary.backupX + x;
      const gy = boundary.backupY + y;
      const g = gy * width + gx;
      if (!redzone[g] && !stroke[g]) continue;
      borderChecked += 1;
      const i = (y * bak.width + x) * 4;
      const delta =
        Math.abs(full.data[i] - bak.data[i]) +
        Math.abs(full.data[i + 1] - bak.data[i + 1]) +
        Math.abs(full.data[i + 2] - bak.data[i + 2]);
      if (delta > 40) borderDamage += 1;
    }
  }
  if (borderDamage > 0) {
    part10RepairBoundaryWithWidth(ctx, boundary, width);
  }

  const borderOk =
    borderChecked === 0 || borderDamage / borderChecked <= 0.02;
  const score = Math.max(0, Math.min(1, 1 - leftover / Math.max(1, inkBefore)));
  return { score, leftover, borderOk };
}

/** Basit koyu-mürekkep sayacı — looksLikeInk aşırı seçiciydi, İngilizceyi kaçırıyordu */
function countDarkInkInInterior(
  data: Uint8ClampedArray,
  rw: number,
  rh: number,
  x0: number,
  y0: number,
  width: number,
  height: number,
  interior: Uint8Array,
  redzone: Uint8Array,
  stroke: Uint8Array,
  mode: "light" | "dark",
): number {
  let n = 0;
  for (let p = 0, i = 0; p < rw * rh; p += 1, i += 4) {
    const gx = x0 + (p % rw);
    const gy = y0 + Math.floor(p / rw);
    if (!canEraseAt(gx, gy, width, height, interior, redzone, stroke)) continue;
    const v = luminance(data[i], data[i + 1], data[i + 2]);
    const ink = mode === "light" ? v < 145 : v > 115;
    if (ink) n += 1;
  }
  return n;
}

/**
 * BallonsTranslator yaklaşımı: arka plan düşük varyanslı/ağırlıkla kağıtsa,
 * dikdörtgen değil TAM BALON INTERIOR MASKESİNİ medyan renkle temizle.
 * Böylece harf aralarında İngilizce kalmaz; redzone kabuğu aynen korunur.
 */
function tryUniformBubbleClean(
  ctx: CanvasRenderingContext2D,
  width: number,
  boundary: Boundary,
  kind: TextKind,
  force = false,
): boolean {
  const { borderBackup, backupX, backupY, interior, redzone, stroke } = boundary;
  const rw = borderBackup.width;
  const rh = borderBackup.height;
  if (rw < 4 || rh < 4) return false;

  let inside = 0;
  let paper = 0;
  const fillLum = luminance(kind.fill.r, kind.fill.g, kind.fill.b);
  for (let y = 0; y < rh; y += 1) {
    for (let x = 0; x < rw; x += 1) {
      const gx = backupX + x;
      const gy = backupY + y;
      const g = gy * width + gx;
      if (!interior[g] || redzone[g] || stroke[g]) continue;
      inside += 1;
      const i = (y * rw + x) * 4;
      const v = luminance(
        borderBackup.data[i],
        borderBackup.data[i + 1],
        borderBackup.data[i + 2],
      );
      const paperLike =
        kind.mode === "light"
          ? v >= Math.max(165, fillLum - 65)
          : v <= Math.min(90, fillLum + 65);
      if (paperLike) paper += 1;
    }
  }

  if (!inside) return false;
  if (!force) {
    // Eski kapı crop alanına bakıyordu; arama penceresi büyüdüğü için gerçek
    // balonlar da elenip harf-silme moduna düşüyor, geriye hayalet yazı
    // kalıyordu. Tek anlamlı ölçüt: interior kağıt ağırlıklı mı?
    if (paper / inside < 0.5) return false;
  }

  const img = ctx.getImageData(backupX, backupY, rw, rh);
  for (let y = 0; y < rh; y += 1) {
    for (let x = 0; x < rw; x += 1) {
      const gx = backupX + x;
      const gy = backupY + y;
      const g = gy * width + gx;
      if (!interior[g] || redzone[g] || stroke[g]) continue;
      const i = (y * rw + x) * 4;
      img.data[i] = kind.fill.r;
      img.data[i + 1] = kind.fill.g;
      img.data[i + 2] = kind.fill.b;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, backupX, backupY);
  part10RepairBoundaryWithWidth(ctx, boundary, width);
  return true;
}

/**
 * ***** silme: balon interior'daki koyu harf piksellerini kağıt rengiyle değiştir.
 * Redzone'a ASLA değmez. Çeviri kutusu boyamaz — sadece mürekkep.
 */
function eraseUntilClean(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  textPx: PxBox,
  boundary: Boundary,
  kind: TextKind,
): boolean {
  const { interior, redzone, stroke, bounds } = boundary;
  if (!bounds) return false;

  // Balon yok: interior zaten yalnızca harf pikselleri → doğrudan kağıt rengi.
  if (!boundary.enclosed) {
    return tryUniformBubbleClean(ctx, width, boundary, kind, true);
  }

  // Düşük varyanslı konuşma balonu: exact-shape full interior cleanup.
  if (tryUniformBubbleClean(ctx, width, boundary, kind)) return true;

  const pad = Math.max(2, Math.min(bounds.w, bounds.h) * 0.03);
  const rx0 = Math.max(0, Math.floor(bounds.x - pad));
  const ry0 = Math.max(0, Math.floor(bounds.y - pad));
  const rx1 = Math.min(width, Math.ceil(bounds.x + bounds.w + pad));
  const ry1 = Math.min(height, Math.ceil(bounds.y + bounds.h + pad));
  const rw = rx1 - rx0;
  const rh = ry1 - ry0;
  if (rw < 2 || rh < 2) return false;
  void textPx;

  const beforeImg = ctx.getImageData(rx0, ry0, rw, rh);
  const inkBefore = countDarkInkInInterior(
    beforeImg.data,
    rw,
    rh,
    rx0,
    ry0,
    width,
    height,
    interior,
    redzone,
    stroke,
    kind.mode,
  );
  if (inkBefore < 8) return false;

  const wipePass = (sensitive: boolean) => {
    const img = ctx.getImageData(rx0, ry0, rw, rh);
    const { data } = img;
    const cut = sensitive
      ? kind.mode === "light"
        ? 155
        : 105
      : kind.mode === "light"
        ? 140
        : 120;

    // ***** mask — sadece koyu harf
    const mask = new Uint8Array(rw * rh);
    for (let p = 0, i = 0; p < rw * rh; p += 1, i += 4) {
      const gx = rx0 + (p % rw);
      const gy = ry0 + Math.floor(p / rw);
      if (!canEraseAt(gx, gy, width, height, interior, redzone, stroke)) continue;
      const v = luminance(data[i], data[i + 1], data[i + 2]);
      const ink = kind.mode === "light" ? v < cut : v > cut;
      if (ink) mask[p] = 1;
    }
    // 1px dilate sadece yarı-koyu antialias
    const dil = new Uint8Array(mask);
    for (let y = 1; y < rh - 1; y += 1) {
      for (let x = 1; x < rw - 1; x += 1) {
        const p = y * rw + x;
        if (mask[p]) continue;
        if (!(mask[p - 1] || mask[p + 1] || mask[p - rw] || mask[p + rw])) {
          continue;
        }
        const gx = rx0 + x;
        const gy = ry0 + y;
        if (!canEraseAt(gx, gy, width, height, interior, redzone, stroke)) {
          continue;
        }
        const i = p * 4;
        const v = luminance(data[i], data[i + 1], data[i + 2]);
        if (kind.mode === "light" ? v < 175 : v > 80) dil[p] = 1;
      }
    }
    part6EraseLetters(data, dil, rw, rh, kind);
    ctx.putImageData(img, rx0, ry0);
    part10RepairBoundaryWithWidth(ctx, boundary, width);
  };

  // Zincir 1 yüzeysel → 2 hassas → 3 spot
  wipePass(false);
  let after = ctx.getImageData(rx0, ry0, rw, rh);
  let leftover = countDarkInkInInterior(
    after.data,
    rw,
    rh,
    rx0,
    ry0,
    width,
    height,
    interior,
    redzone,
    stroke,
    kind.mode,
  );
  let score = 1 - leftover / inkBefore;
  if (score >= CLEAN_THRESHOLD && leftover <= Math.max(12, inkBefore * 0.1)) {
    return true;
  }

  wipePass(true);
  after = ctx.getImageData(rx0, ry0, rw, rh);
  leftover = countDarkInkInInterior(
    after.data,
    rw,
    rh,
    rx0,
    ry0,
    width,
    height,
    interior,
    redzone,
    stroke,
    kind.mode,
  );
  score = 1 - leftover / inkBefore;
  if (score >= CLEAN_THRESHOLD && leftover <= Math.max(12, inkBefore * 0.1)) {
    return true;
  }

  {
    const img = ctx.getImageData(rx0, ry0, rw, rh);
    part6FineSpotErase(
      img.data,
      rw,
      rh,
      rx0,
      ry0,
      width,
      height,
      interior,
      redzone,
      stroke,
      kind,
    );
    ctx.putImageData(img, rx0, ry0);
    part10RepairBoundaryWithWidth(ctx, boundary, width);
  }

  after = ctx.getImageData(rx0, ry0, rw, rh);
  leftover = countDarkInkInInterior(
    after.data,
    rw,
    rh,
    rx0,
    ry0,
    width,
    height,
    interior,
    redzone,
    stroke,
    kind.mode,
  );
  score = 1 - leftover / inkBefore;
  return score >= CLEAN_THRESHOLD && leftover <= Math.max(12, inkBefore * 0.1);
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  const lines: string[] = [];
  let current = words[0];
  for (let i = 1; i < words.length; i += 1) {
    const next = `${current} ${words[i]}`;
    if (ctx.measureText(next).width <= maxWidth) current = next;
    else {
      lines.push(current);
      current = words[i];
    }
  }
  lines.push(current);
  return lines;
}

function textFits(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxHeight: number,
  fontSize: number,
) {
  ctx.font = comicFont(fontSize);
  const lines = wrapText(ctx, text, maxWidth);
  const lineHeight = fontSize * 1.08;
  const totalHeight = lines.length * lineHeight;
  const widest = Math.max(...lines.map((l) => ctx.measureText(l).width), 0);
  return { ok: totalHeight <= maxHeight && widest <= maxWidth, lines, lineHeight };
}

function condenseToFit(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxHeight: number,
  minFont: number,
) {
  let candidate = comicCase(text);
  if (textFits(ctx, candidate, maxWidth, maxHeight, minFont).ok) return candidate;
  candidate = candidate
    .replace(/\b(GERÇEKTEN|ASLINDA|YANİ|İŞTE|BİRAZ|OLDUKÇA)\b/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (textFits(ctx, candidate, maxWidth, maxHeight, minFont).ok) return candidate;

  const words = candidate.split(/\s+/).filter(Boolean);
  let low = 1;
  let high = words.length;
  let best = words[0] ?? candidate;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const slice = words.slice(0, mid).join(" ");
    const trial = mid < words.length ? `${slice}…` : slice;
    if (textFits(ctx, trial, maxWidth, maxHeight, minFont).ok) {
      best = trial;
      low = mid + 1;
    } else high = mid - 1;
  }
  return best;
}

/** PART 11 — Çeviri (yalnızca temiz + interior clip) */
function part11WriteTranslation(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  text: string,
  original: string,
  textPx: PxBox,
  bounds: PxBox,
  kind: TextKind,
  interior: Uint8Array,
  redzone: Uint8Array,
  stroke: Uint8Array,
) {
  const origLines = estimateLineCount(original || text);
  const originalDriven = (Math.min(textPx.h, bounds.h) / origLines) * 1.05;
  const bubbleDriven = Math.min(bounds.h * 0.34, bounds.w * 0.22);
  const targetFont = Math.max(
    14,
    Math.min(76, Math.max(originalDriven, bubbleDriven)),
  );

  const padX = Math.max(5, bounds.w * 0.12);
  const padY = Math.max(5, bounds.h * 0.12);
  const x = bounds.x + padX;
  const w = Math.max(8, bounds.w - padX * 2);
  const h = Math.max(8, bounds.h - padY * 2);

  const minFont = Math.max(12, targetFont * 0.48);
  const fitted = condenseToFit(ctx, text, w, h, minFont);

  let low = minFont;
  let high = targetFont;
  let bestSize = minFont;
  let bestLines = wrapText(ctx, fitted, w);
  let lineHeight = bestSize * 1.08;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const result = textFits(ctx, fitted, w, h, mid);
    if (result.ok) {
      bestSize = mid;
      bestLines = result.lines;
      lineHeight = result.lineHeight;
      low = mid + 1;
    } else high = mid - 1;
  }

  const layer = document.createElement("canvas");
  layer.width = width;
  layer.height = height;
  const lctx = layer.getContext("2d");
  if (!lctx) return;

  lctx.font = comicFont(bestSize);
  lctx.fillStyle = kind.mode === "light" ? "#111111" : "#ffffff";
  lctx.textAlign = "center";
  lctx.textBaseline = "middle";

  const totalHeight = bestLines.length * lineHeight;
  const cx = bounds.x + bounds.w / 2;
  const cy = bounds.y + bounds.h / 2;
  let cursorY = cy - totalHeight / 2 + lineHeight / 2;
  const drawX = Math.min(Math.max(cx, x + 2), x + w - 2);

  for (const line of bestLines) {
    lctx.fillText(line, drawX, cursorY, w);
    cursorY += lineHeight;
  }

  const bx0 = Math.max(0, Math.floor(bounds.x));
  const by0 = Math.max(0, Math.floor(bounds.y));
  const bx1 = Math.min(width, Math.ceil(bounds.x + bounds.w));
  const by1 = Math.min(height, Math.ceil(bounds.y + bounds.h));
  const bw = bx1 - bx0;
  const bh = by1 - by0;
  if (bw < 1 || bh < 1) return;

  const src = lctx.getImageData(bx0, by0, bw, bh);
  const dst = ctx.getImageData(bx0, by0, bw, bh);
  for (let y = 0; y < bh; y += 1) {
    for (let x = 0; x < bw; x += 1) {
      const li = (y * bw + x) * 4;
      if (src.data[li + 3] < 20) continue;
      const gx = bx0 + x;
      const gy = by0 + y;
      const g = gy * width + gx;
      if (!interior[g] || redzone[g] || stroke[g]) continue;
      if (isProtected(gx, gy, width, height, redzone, stroke, 1)) continue;
      const a = src.data[li + 3] / 255;
      dst.data[li] = Math.round(src.data[li] * a + dst.data[li] * (1 - a));
      dst.data[li + 1] = Math.round(
        src.data[li + 1] * a + dst.data[li + 1] * (1 - a),
      );
      dst.data[li + 2] = Math.round(
        src.data[li + 2] * a + dst.data[li + 2] * (1 - a),
      );
      dst.data[li + 3] = 255;
    }
  }
  ctx.putImageData(dst, bx0, by0);
}

function drawDebug(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  bubblePx: PxBox,
  textPx: PxBox,
  interior: Uint8Array,
  redzone: Uint8Array,
) {
  const overlay = ctx.getImageData(0, 0, width, height);
  for (let i = 0; i < interior.length; i += 1) {
    const px = i * 4;
    if (redzone[i]) {
      overlay.data[px] = Math.min(255, overlay.data[px] * 0.25 + 255 * 0.75);
      overlay.data[px + 1] = overlay.data[px + 1] * 0.25;
      overlay.data[px + 2] = overlay.data[px + 2] * 0.25;
    } else if (interior[i]) {
      overlay.data[px] = overlay.data[px] * 0.45;
      overlay.data[px + 1] = Math.min(
        255,
        overlay.data[px + 1] * 0.45 + 210 * 0.55,
      );
      overlay.data[px + 2] = overlay.data[px + 2] * 0.45;
    }
  }
  ctx.putImageData(overlay, 0, 0);
  ctx.save();
  ctx.lineWidth = Math.max(2, Math.min(width, height) * 0.0025);
  ctx.strokeStyle = "#ff7a00";
  ctx.strokeRect(bubblePx.x, bubblePx.y, bubblePx.w, bubblePx.h);
  ctx.strokeStyle = "#00d4ff";
  ctx.strokeRect(textPx.x, textPx.y, textPx.w, textPx.h);
  ctx.restore();
}

type PreparedBubble = {
  bubble: BubbleTranslation;
  bubblePx: PxBox;
  textPx: PxBox;
  searchPx: PxBox;
  kind: TextKind;
  boundary: Boundary;
  clean: boolean;
};

function boxIou(a: PxBox, b: PxBox): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const intersection = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a.w * a.h + b.w * b.h - intersection;
  return union > 0 ? intersection / union : 0;
}

function boxOverlapOfSmaller(a: PxBox, b: PxBox): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const intersection = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const smaller = Math.min(a.w * a.h, b.w * b.h);
  return smaller > 0 ? intersection / smaller : 0;
}

function unionBox(a: PxBox, b: PxBox): PxBox {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const r = Math.max(a.x + a.w, b.x + b.w);
  const bottom = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: r - x, h: bottom - y };
}

/**
 * Aynı balondaki parça metinleri tek iş haline getirir.
 * Örn. “HARDLY.” ve altındaki devam metni ayrı çevrilirse aynı balona iki kez
 * yazılıp çarpışıyordu. bubbleBox IoU yüksekse tek metin / tek temizlik olur.
 */
function groupBubbleInputs(
  bubbles: BubbleTranslation[],
  width: number,
  height: number,
): Array<{
  bubble: BubbleTranslation;
  bubblePx: PxBox;
  textPx: PxBox;
}> {
  const grouped: Array<{
    bubble: BubbleTranslation;
    bubblePx: PxBox;
    textPx: PxBox;
  }> = [];

  const ordered = [...bubbles].sort((a, b) => a.readingOrder - b.readingOrder);
  for (const bubble of ordered) {
    if (!bubble.box || !bubble.original?.trim()) continue;
    let bubblePx = toPx(part1FindBubble(bubble), width, height);
    const bubblePolygonPx = polygonToPx(
      bubble.bubblePolygon,
      width,
      height,
    );
    if (bubblePolygonPx) {
      bubblePx = unionBox(bubblePx, polygonBounds(bubblePolygonPx));
    }
    const textPx = clipTextInsideBubble(
      toPx(bubble.box, width, height),
      bubblePx,
    );
    const existing = grouped.find(
      (g) =>
        boxIou(g.bubblePx, bubblePx) >= 0.5 ||
        boxOverlapOfSmaller(g.bubblePx, bubblePx) >= 0.68,
    );
    if (!existing) {
      grouped.push({ bubble: { ...bubble }, bubblePx, textPx });
      continue;
    }

    existing.textPx = unionBox(existing.textPx, textPx);
    existing.bubblePx = unionBox(existing.bubblePx, bubblePx);
    existing.bubble = {
      ...existing.bubble,
      original: `${existing.bubble.original} ${bubble.original}`.trim(),
      translated: `${existing.bubble.translated} ${bubble.translated}`.trim(),
      readingOrder: Math.min(
        existing.bubble.readingOrder,
        bubble.readingOrder,
      ),
    };
  }
  return grouped;
}

/**
 * FAZ 1: bütün geometriyi değişmeyen ORİJİNAL canvas'tan hazırlar.
 * Bu fonksiyon silmez/yazmaz; sonraki balon önceki Türkçeyi asla analiz etmez.
 */
function prepareAllBubbles(
  originalCtx: CanvasRenderingContext2D,
  width: number,
  height: number,
  bubbles: BubbleTranslation[],
): PreparedBubble[] {
  const prepared: PreparedBubble[] = [];
  for (const item of groupBubbleInputs(bubbles, width, height)) {
    const kind = part2UnderstandTextType(
      originalCtx,
      item.textPx,
      width,
      height,
    );
    const searchPx = balloonSearchWindow(
      item.textPx,
      item.bubblePx,
      width,
      height,
    );
    const boundary = part3DefineBoundary(
      originalCtx,
      width,
      height,
      searchPx,
      item.textPx,
      item.bubblePx,
      kind,
    );
    if (!boundary.bounds) continue;

    // Aynı text bölgesinin tekrarlı Gemini kaydını at.
    if (prepared.some((p) => boxIou(p.textPx, item.textPx) >= 0.82)) continue;
    prepared.push({
      ...item,
      searchPx,
      kind,
      boundary,
      clean: false,
    });
  }
  return prepared;
}

/**
 * Redzone önizleme — ORİJİNAL üzerinde, silme/yazmadan ÖNCE.
 * Kırmızı = balon kenarı koruma, yeşil = silme+yazma alanı.
 */
export async function renderRedzonePreview(
  imageDataUrl: string,
  bubbles: BubbleTranslation[],
): Promise<string> {
  const img = await loadImage(imageDataUrl);
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  if (!width || !height) throw new Error("Görsel boyutları okunamadı");

  const zemin = document.createElement("canvas");
  zemin.width = width;
  zemin.height = height;
  const ctx = zemin.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas desteklenmiyor");
  ctx.drawImage(img, 0, 0, width, height);

  // Analiz ayrı, değişmeyen canvas'ta; debug çizimleri sonraki analizi bozmaz.
  const analysisCanvas = document.createElement("canvas");
  analysisCanvas.width = width;
  analysisCanvas.height = height;
  const analysisCtx = analysisCanvas.getContext("2d", {
    willReadFrequently: true,
  });
  if (!analysisCtx) throw new Error("Canvas desteklenmiyor");
  analysisCtx.drawImage(img, 0, 0, width, height);

  const prepared = prepareAllBubbles(analysisCtx, width, height, bubbles);
  for (const item of prepared) {
    drawDebug(
      ctx,
      width,
      height,
      item.bubblePx,
      item.textPx,
      item.boundary.interior,
      item.boundary.redzone,
    );
  }
  return zemin.toDataURL("image/jpeg", 0.92);
}

/**
 * Zincir (sıra zorunlu):
 * 1) Balon bul
 * 2) Tür
 * 3) REDZONE = balon kenarı (erken!) + interior
 * 4–6) Orijinal harfleri sil (redzone'a değme)
 * 11) Türkçe yaz (redzone'a değme)
 */
export async function renderTranslatedPage(
  imageDataUrl: string,
  bubbles: BubbleTranslation[],
  options: RenderOptions = {},
): Promise<string> {
  await ensureComicFont();

  // Debug isteniyorsa silme/yazma yok — sadece erken redzone
  if (options.showRedzone) {
    return renderRedzonePreview(imageDataUrl, bubbles);
  }

  const img = await loadImage(imageDataUrl);
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  if (!width || !height) throw new Error("Görsel boyutları okunamadı");

  const zemin = document.createElement("canvas");
  zemin.width = width;
  zemin.height = height;
  const ctx = zemin.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas desteklenmiyor");
  ctx.drawImage(img, 0, 0, width, height);

  // Değişmeyen analiz canvas'ı: tüm balon/redzone/maskeler burada hazırlanır.
  const analysisCanvas = document.createElement("canvas");
  analysisCanvas.width = width;
  analysisCanvas.height = height;
  const analysisCtx = analysisCanvas.getContext("2d", {
    willReadFrequently: true,
  });
  if (!analysisCtx) throw new Error("Canvas desteklenmiyor");
  analysisCtx.drawImage(img, 0, 0, width, height);

  const prepared = prepareAllBubbles(analysisCtx, width, height, bubbles);
  let cleaned = 0;
  let skippedDirty = 0;

  // FAZ 2: bütün orijinal metinleri temizle. Bu fazda Türkçe yazılmaz.
  for (const item of prepared) {
    item.clean = eraseUntilClean(
      ctx,
      width,
      height,
      item.textPx,
      item.boundary,
      item.kind,
    );
    part10RepairBoundaryWithWidth(ctx, item.boundary, width);
    if (!item.clean) {
      skippedDirty += 1;
    } else {
      cleaned += 1;
    }
  }

  // FAZ 3 BİLEREK KAPALI:
  // Şu anda hiçbir çeviri/orijinal metin çizilmez. Çıktı yalnızca temiz balondur.

  if (cleaned === 0) {
    const pct = Math.round(CLEAN_THRESHOLD * 100);
    throw new Error(
      skippedDirty > 0
        ? `Yazı silme %${pct} eşiğini geçemedi (${skippedDirty} balon). Temiz orijinal yükleyip tekrar dene.`
        : "Balon/yazı algılanamadı. Temiz orijinal yükleyip tekrar dene.",
    );
  }

  return zemin.toDataURL("image/jpeg", 0.92);
}
