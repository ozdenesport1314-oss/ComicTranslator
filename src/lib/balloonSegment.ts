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
    // Harfin üstüne düşen tohum için yakındaki kağıdı ara. Arama bilerek kısa:
    // uzaktaki kağıt başka bir bölgeye ait olur ve tarama da pahalılaşır.
    const reach = 20;
    let bestD = Infinity;
    for (let y = Math.max(win.y0, seedY - reach); y <= Math.min(win.y1, seedY + reach); y += 1) {
      for (let x = Math.max(win.x0, seedX - reach); x <= Math.min(win.x1, seedX + reach); x += 1) {
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

function maskAreaInRect(mask: Uint8Array, rw: number, rect: TextRect): number {
  let n = 0;
  for (let y = rect.y0; y <= rect.y1; y += 1) {
    for (let x = rect.x0; x <= rect.x1; x += 1) {
      if (mask[y * rw + x]) n += 1;
    }
  }
  return n;
}

/**
 * Maskenin kapalı delikleri (harfler) doldurulduktan sonraki alanı.
 *
 * Doluluk ölçümü ham kağıt dolgusunda yapılırsa yoğun yazılı balon "dağınık"
 * görünüp reddediliyordu; ölçüm balon gövdesinde yapılmalı.
 */
function closedArea(
  mask: Uint8Array,
  rw: number,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
): number {
  const w = bounds.maxX - bounds.minX + 1;
  const h = bounds.maxY - bounds.minY + 1;
  const exterior = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (lx: number, ly: number) => {
    if (lx < 0 || ly < 0 || lx >= w || ly >= h) return;
    const li = ly * w + lx;
    if (exterior[li]) return;
    if (mask[(bounds.minY + ly) * rw + (bounds.minX + lx)]) return;
    exterior[li] = 1;
    stack.push(li);
  };
  for (let x = 0; x < w; x += 1) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 0; y < h; y += 1) {
    push(0, y);
    push(w - 1, y);
  }
  while (stack.length) {
    const li = stack.pop() as number;
    const ly = Math.floor(li / w);
    const lx = li - ly * w;
    push(lx + 1, ly);
    push(lx - 1, ly);
    push(lx, ly + 1);
    push(lx, ly - 1);
  }
  let n = 0;
  for (let i = 0; i < w * h; i += 1) if (!exterior[i]) n += 1;
  return n;
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
function balloonFromSeed(
  lum: Float32Array,
  rw: number,
  rh: number,
  mode: "light" | "dark",
  text: TextRect,
  hint: TextRect | undefined,
  seedX: number,
  seedY: number,
): Uint8Array | null {
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
    if (flood.area < 400) continue;
    // Tohum yazı kutusundan geldiği için dolgu zaten yazının yerinde; burada
    // sadece kutuyla gerçekten kesiştiğini doğrularız. "Yazının tamamını sar"
    // kuralı, model iki balonu tek kutuda birleştirdiğinde ikisini de
    // reddediyordu.
    if (maskAreaInRect(flood.mask, rw, text) < 25) continue;
    // Pencereyi baştan sona kaplayan dolgu = sızıntı
    const bw = flood.maxX - flood.minX + 1;
    const bh = flood.maxY - flood.minY + 1;
    if (bw > rw * 0.92 || bh > rh * 0.92) continue;
    // Balon en az iki yönde belirli kalınlıkta ve aşırı uzun değildir; sanatın
    // içindeki ince beyaz şeritler bu kapıdan geçmez.
    if (bw < 14 || bh < 14) continue;
    if (bw / bh > 6 || bh / bw > 6) continue;
    // Balon derli topludur; komşu beyaz alana sızmış dolgu dağınıktır. Düşük
    // doluluk kabul edilirse dolgu balon çizgisini yutup sanata taşıyor.
    if (closedArea(flood.mask, rw, flood) / (bw * bh) < 0.6) continue;
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

/** Tek balon: yazı kutusunun merkezinden arar. */
export function findEnclosedBalloon(
  lum: Float32Array,
  rw: number,
  rh: number,
  mode: "light" | "dark",
  text: TextRect,
  hint?: TextRect,
): Uint8Array | null {
  return balloonFromSeed(
    lum,
    rw,
    rh,
    mode,
    text,
    hint,
    Math.round((text.x0 + text.x1) / 2),
    Math.round((text.y0 + text.y1) / 2),
  );
}

/**
 * Yazı kutusuna dağılmış noktalardan arar ve bulunan balonları birleştirir.
 *
 * Model bazen iki ayrı balonu tek kutuda birleştiriyor; tek merkez noktası o
 * durumda ya birini buluyor ya hiçbirini, ikinci balon temizlenmeden kalıyordu.
 */
export function findEnclosedBalloons(
  lum: Float32Array,
  rw: number,
  rh: number,
  mode: "light" | "dark",
  text: TextRect,
  hint?: TextRect,
): Uint8Array | null {
  const fractions: Array<[number, number]> = [
    [0.5, 0.5],
    [0.5, 0.2],
    [0.5, 0.8],
    [0.2, 0.5],
    [0.8, 0.5],
    [0.25, 0.25],
    [0.75, 0.25],
    [0.25, 0.75],
    [0.75, 0.75],
  ];
  const union = new Uint8Array(lum.length);
  let found = false;
  for (const [fx, fy] of fractions) {
    const sx = Math.round(text.x0 + (text.x1 - text.x0) * fx);
    const sy = Math.round(text.y0 + (text.y1 - text.y0) * fy);
    if (sx < 0 || sy < 0 || sx >= rw || sy >= rh) continue;
    // Bulunmuş balonun içindeki nokta yeni bilgi vermez; taramayı da ucuz tutar.
    if (union[sy * rw + sx]) continue;
    const mask = balloonFromSeed(lum, rw, rh, mode, text, hint, sx, sy);
    if (!mask) continue;
    for (let p = 0; p < mask.length; p += 1) if (mask[p]) union[p] = 1;
    found = true;
  }
  return found ? union : null;
}
