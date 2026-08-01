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

function dilate(src: Uint8Array, rw: number, rh: number): Uint8Array {
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

/**
 * Balon bulunamadığında silinebilir alan. Yazının OTURDUĞU kağıt zemin flood
 * edilir ve silme yalnızca o zeminin içinde, yazı kutusuna yakın kalır.
 *
 * Bu sınır olmadan büyük arama penceresindeki tarama/gölgeleme çizgileri "harf"
 * sayılıp sanatın üstü siliniyordu.
 */
export function letterDomain(
  lum: Float32Array,
  rw: number,
  rh: number,
  mode: "light" | "dark",
  text: TextRect,
  opts: { cut: number; paperLum: number },
): Uint8Array | null {
  const textW = Math.max(1, text.x1 - text.x0 + 1);
  const textH = Math.max(1, text.y1 - text.y0 + 1);
  // Yalnızca yazı kutusu + eksik satır payı; pencerenin tamamı ASLA değil.
  const allowed: TextRect = {
    x0: Math.max(0, text.x0 - Math.round(textW * 0.2 + 10)),
    y0: Math.max(0, text.y0 - Math.round(textH * 0.45 + 12)),
    x1: Math.min(rw - 1, text.x1 + Math.round(textW * 0.2 + 10)),
    y1: Math.min(rh - 1, text.y1 + Math.round(textH * 0.45 + 12)),
  };
  const allowedArea =
    (allowed.x1 - allowed.x0 + 1) * (allowed.y1 - allowed.y0 + 1);
  if (allowedArea < 16) return null;

  const paperThr =
    mode === "light"
      ? Math.max(170, opts.paperLum - 45)
      : Math.min(85, opts.paperLum + 45);
  const paperAt =
    mode === "light"
      ? (v: number) => v >= paperThr
      : (v: number) => v <= paperThr;
  const flood = floodPaper(
    lum,
    rw,
    allowed,
    paperAt,
    Math.round((text.x0 + text.x1) / 2),
    Math.round((text.y0 + text.y1) / 2),
  );
  // Kağıt zemin yoksa yazı sanatın üstündedir; dokunmak hasar demektir.
  if (!flood || flood.area < allowedArea * 0.35) return null;

  // Kağıt alanını genişletmek kutunun DIŞINDAKİ sanatı da siliyordu. Bunun
  // yerine kağıdın içinde kapalı kalan delikler (harfler) bölgeye katılır.
  const paper = flood.mask;
  const exterior = new Uint8Array(rw * rh);
  const queue = new Int32Array(allowedArea);
  let qh = 0;
  let qt = 0;
  const pushExterior = (x: number, y: number) => {
    if (x < allowed.x0 || x > allowed.x1 || y < allowed.y0 || y > allowed.y1) {
      return;
    }
    const p = y * rw + x;
    if (paper[p] || exterior[p]) return;
    exterior[p] = 1;
    queue[qt++] = p;
  };
  for (let x = allowed.x0; x <= allowed.x1; x += 1) {
    pushExterior(x, allowed.y0);
    pushExterior(x, allowed.y1);
  }
  for (let y = allowed.y0; y <= allowed.y1; y += 1) {
    pushExterior(allowed.x0, y);
    pushExterior(allowed.x1, y);
  }
  while (qh < qt) {
    const p = queue[qh++];
    const y = Math.floor(p / rw);
    const x = p - y * rw;
    pushExterior(x + 1, y);
    pushExterior(x - 1, y);
    pushExterior(x, y + 1);
    pushExterior(x, y - 1);
  }

  const region = new Uint8Array(rw * rh);
  for (let y = allowed.y0; y <= allowed.y1; y += 1) {
    for (let x = allowed.x0; x <= allowed.x1; x += 1) {
      const p = y * rw + x;
      if (paper[p] || !exterior[p]) region[p] = 1;
    }
  }

  const inkAt = (v: number) => (mode === "light" ? v < opts.cut : v > opts.cut);
  const core = new Uint8Array(rw * rh);
  for (let y = allowed.y0; y <= allowed.y1; y += 1) {
    for (let x = allowed.x0; x <= allowed.x1; x += 1) {
      const p = y * rw + x;
      if (region[p] && inkAt(lum[p])) core[p] = 1;
    }
  }

  // Harf silinip antialias halkası kalırsa balonda hayalet yazı görünür.
  const grown = dilate(dilate(core, rw, rh), rw, rh);
  const notPaper = (v: number) =>
    mode === "light" ? v < opts.paperLum - 8 : v > opts.paperLum + 8;
  const domain = new Uint8Array(rw * rh);
  let any = 0;
  for (let y = allowed.y0; y <= allowed.y1; y += 1) {
    for (let x = allowed.x0; x <= allowed.x1; x += 1) {
      const p = y * rw + x;
      if (!grown[p] || !region[p]) continue;
      if (!core[p] && !notPaper(lum[p])) continue;
      domain[p] = 1;
      any += 1;
    }
  }
  return any ? domain : null;
}

/**
 * Dolgunun çevresindeki balon çizgisi oranı. Gerçek balonun her yanında çizgi
 * vardır; panele sızmış dolgunun çevresi karışıktır.
 *
 * Sıkı kağıt eşiğinde dolgunun İLK komşusu çizgi değil antialias grisi olur;
 * bu yüzden dışa doğru birkaç piksel bakılır, yoksa gerçek balonlar reddedilip
 * temizlik harf moduna düşüyor ve balon içinde hayalet yazı kalıyordu.
 */
export function strokeRingRatio(
  lum: Float32Array,
  rw: number,
  rh: number,
  mask: Uint8Array,
  mode: "light" | "dark",
  reach = 3,
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
      if (mask[ny * rw + nx]) continue;
      total += 1;
      for (let step = 1; step <= reach; step += 1) {
        const sx = x + dx * step;
        const sy = y + dy * step;
        if (sx < 0 || sy < 0 || sx >= rw || sy >= rh) break;
        const sp = sy * rw + sx;
        if (mask[sp]) break;
        if (isStroke(lum[sp])) {
          dark += 1;
          break;
        }
      }
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
  hint?: TextRect,
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
    // Balon derli topludur; komşu beyaz alana sızmış dolgu dağınıktır. Düşük
    // doluluk kabul edilirse dolgu balon çizgisini yutup sanata taşıyor.
    if (flood.area / (bw * bh) < 0.6) continue;
    // Gemini kutusu şekli belirlemez ama ÖLÇEK sınırıdır: balon o kutunun
    // birkaç katı olamaz. Sızıntıyı bu yakalar.
    if (hint) {
      const hw = Math.max(1, hint.x1 - hint.x0 + 1);
      const hh = Math.max(1, hint.y1 - hint.y0 + 1);
      if (bw > hw * 1.8 + 24 || bh > hh * 1.8 + 24) continue;
      if (flood.area > hw * hh * 2.2) continue;
    }
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
