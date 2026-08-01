/**
 * Balon segmentasyonu — saf piksel matematiği (canvas/DOM bağımsız).
 *
 * Gemini'nin `bubbleBox` verisi balonu dikdörtgen gösterdiği için eski akış
 * balonun şeklini değil kutusunu temizliyordu. Buradaki flood yalnızca KAPALI
 * kenarı olan dolguları kabul eder; kenar bulunamazsa balon yok sayılır.
 */

export type TextRect = { x0: number; y0: number; x1: number; y1: number };

export type FloodResult = {
  mask: Uint8Array;
  area: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** true = dolgu pencere kenarına dayandı, yani balon kenarı bulunamadı */
  touchesEdge: boolean;
};

export function floodPaper(
  lum: Float32Array,
  rw: number,
  win: TextRect,
  paperAt: (v: number) => boolean,
  seedX: number,
  seedY: number,
): FloodResult | null {
  const inWin = (x: number, y: number) =>
    x >= win.x0 && x <= win.x1 && y >= win.y0 && y <= win.y1;

  let seed = -1;
  if (inWin(seedX, seedY) && paperAt(lum[seedY * rw + seedX])) {
    seed = seedY * rw + seedX;
  } else {
    let bestD = Infinity;
    for (let y = win.y0; y <= win.y1; y += 1) {
      for (let x = win.x0; x <= win.x1; x += 1) {
        const p = y * rw + x;
        if (!paperAt(lum[p])) continue;
        const d = (x - seedX) * (x - seedX) + (y - seedY) * (y - seedY);
        if (d < bestD) {
          bestD = d;
          seed = p;
        }
      }
    }
  }
  if (seed < 0) return null;

  const mask = new Uint8Array(lum.length);
  const queue = new Int32Array((win.x1 - win.x0 + 1) * (win.y1 - win.y0 + 1));
  let qh = 0;
  let qt = 0;
  mask[seed] = 1;
  queue[qt++] = seed;

  let area = 0;
  let minX = win.x1;
  let minY = win.y1;
  let maxX = win.x0;
  let maxY = win.y0;
  let touchesEdge = false;

  while (qh < qt) {
    const p = queue[qh++];
    const y = Math.floor(p / rw);
    const x = p - y * rw;
    area += 1;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (x === win.x0 || x === win.x1 || y === win.y0 || y === win.y1) {
      touchesEdge = true;
    }
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inWin(nx, ny)) continue;
      const np = ny * rw + nx;
      if (mask[np] || !paperAt(lum[np])) continue;
      mask[np] = 1;
      queue[qt++] = np;
    }
  }

  return { mask, area, minX, minY, maxX, maxY, touchesEdge };
}

/**
 * Dolgunun çevresindeki koyu çizgi oranı. Gerçek balonun her yanında balon
 * çizgisi vardır; panele sızmış dolgunun çevresi karışıktır.
 */
export function strokeRingRatio(
  lum: Float32Array,
  rw: number,
  rh: number,
  mask: Uint8Array,
  mode: "light" | "dark",
): number {
  let dark = 0;
  let total = 0;
  const isStroke = (v: number) => (mode === "light" ? v < 120 : v > 150);
  for (let p = 0; p < mask.length; p += 1) {
    if (!mask[p]) continue;
    const y = Math.floor(p / rw);
    const x = p - y * rw;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= rw || ny >= rh) continue;
      const np = ny * rw + nx;
      if (mask[np]) continue;
      total += 1;
      if (isStroke(lum[np])) dark += 1;
    }
  }
  return total ? dark / total : 0;
}

/**
 * Yazıyı saran kapalı balon dolgusunu döndürür; bulunamazsa null.
 *
 * Pencere daraltmak sızıntıyı kurtarmaz (kağıt dışa bağlıysa her pencerede
 * taşar); kurtaran şey kağıt eşiğini sıkmaktır — halftone/gri köprüler kopar.
 */
export function findEnclosedBalloon(
  lum: Float32Array,
  rw: number,
  rh: number,
  mode: "light" | "dark",
  text: TextRect,
): Uint8Array | null {
  const seedX = Math.round((text.x0 + text.x1) / 2);
  const seedY = Math.round((text.y0 + text.y1) / 2);
  const textW = Math.max(1, text.x1 - text.x0 + 1);
  const textH = Math.max(1, text.y1 - text.y0 + 1);
  const textArea = textW * textH;
  const slackX = Math.max(4, textW * 0.12);
  const slackY = Math.max(4, textH * 0.12);

  const win: TextRect = { x0: 0, y0: 0, x1: rw - 1, y1: rh - 1 };
  const winArea = rw * rh;
  const thresholds =
    mode === "light" ? [145, 172, 196, 214] : [110, 84, 58, 40];

  let best: Uint8Array | null = null;
  let bestArea = -1;

  for (const thr of thresholds) {
    const paperAt =
      mode === "light" ? (v: number) => v >= thr : (v: number) => v <= thr;
    const flood = floodPaper(lum, rw, win, paperAt, seedX, seedY);
    if (!flood || flood.touchesEdge) continue;
    if (flood.area > winArea * 0.7) continue;
    if (flood.area < textArea * 0.2) continue;
    // Balon yazının tamamını sarmalı
    if (flood.minX > text.x0 + slackX || flood.maxX < text.x1 - slackX) continue;
    if (flood.minY > text.y0 + slackY || flood.maxY < text.y1 - slackY) continue;
    // Pencereyi baştan sona kaplayan dolgu = sızıntı
    const bw = flood.maxX - flood.minX + 1;
    const bh = flood.maxY - flood.minY + 1;
    if (bw > rw * 0.92 || bh > rh * 0.92) continue;
    // Yazı kutusu eksik gelse bile balon geçerli olmalı; ölçüt yazı boyu değil,
    // dolgunun çevresinde gerçek balon çizgisinin bulunması.
    if (strokeRingRatio(lum, rw, rh, flood.mask, mode) < 0.5) continue;
    if (flood.area > bestArea) {
      bestArea = flood.area;
      best = flood.mask;
    }
  }
  return best;
}
