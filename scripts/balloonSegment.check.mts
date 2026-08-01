/**
 * Sentetik segmentasyon kontrolü: `npx tsx scripts/balloonSegment.check.mts`
 *
 * Amaç: balon şekli mi yoksa Gemini kutusu mu temizleniyor sorusunu ölçmek.
 */
import {
  findEnclosedBalloon,
  findEnclosedBalloons,
  letterDomain,
  type TextRect,
} from "../src/lib/balloonSegment";

type Scene = { lum: Float32Array; rw: number; rh: number; text: TextRect };

function blankScene(rw: number, rh: number, background: number): Scene {
  const lum = new Float32Array(rw * rh).fill(background);
  return { lum, rw, rh, text: { x0: 0, y0: 0, x1: 0, y1: 0 } };
}

function fillEllipse(
  scene: Scene,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  value: number,
) {
  for (let y = 0; y < scene.rh; y += 1) {
    for (let x = 0; x < scene.rw; x += 1) {
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      if (nx * nx + ny * ny <= 1) scene.lum[y * scene.rw + x] = value;
    }
  }
}

function fillRect(
  scene: Scene,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  value: number,
) {
  for (let y = Math.max(0, y0); y <= Math.min(scene.rh - 1, y1); y += 1) {
    for (let x = Math.max(0, x0); x <= Math.min(scene.rw - 1, x1); x += 1) {
      scene.lum[y * scene.rw + x] = value;
    }
  }
}

/** Balon içine 2 satır harf koyar; 2. satır Gemini textBox'unun DIŞINDA kalır. */
function addTextLines(scene: Scene, lines: Array<[number, number, number, number]>) {
  for (const [x0, y0, x1, y1] of lines) {
    for (let x = x0; x <= x1; x += 6) fillRect(scene, x, y0, x + 3, y1, 20);
  }
}

function maskStats(mask: Uint8Array, rw: number) {
  let area = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (let p = 0; p < mask.length; p += 1) {
    if (!mask[p]) continue;
    const y = Math.floor(p / rw);
    const x = p - y * rw;
    area += 1;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { area, minX, minY, maxX, maxY };
}

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail: string) =>
  results.push({ name, pass, detail });

// --- Senaryo 1: koyu sanat üstünde beyaz balon, 2. satır textBox dışında ---
{
  const scene = blankScene(300, 220, 30);
  fillEllipse(scene, 150, 110, 90, 62, 0); // balon çizgisi
  fillEllipse(scene, 150, 110, 86, 58, 250); // balon içi kağıt
  addTextLines(scene, [
    [95, 85, 205, 100],
    [95, 120, 205, 135], // Gemini bunu kaçırıyor
  ]);
  scene.text = { x0: 95, y0: 85, x1: 205, y1: 100 };

  const mask = findEnclosedBalloon(scene.lum, scene.rw, scene.rh, "light", scene.text);
  const stats = mask ? maskStats(mask, scene.rw) : null;
  const coversMissedLine =
    !!stats && stats.minY <= 88 && stats.maxY >= 132 && stats.maxX >= 200;
  const notWholeCrop = !!stats && stats.area < scene.rw * scene.rh * 0.5;
  check(
    "balon bulundu ve textBox dışındaki satırı da kapsıyor",
    coversMissedLine && notWholeCrop,
    stats
      ? `alan=${stats.area} bbox=${stats.minX},${stats.minY}..${stats.maxX},${stats.maxY}`
      : "maske yok",
  );

  // Şekil kontrolü: elips köşeleri maskede olmamalı (dikdörtgen değil)
  const corner = mask ? mask[(110 - 55) * scene.rw + (150 - 85)] : 1;
  check("maske dikdörtgen değil (elips köşesi boş)", corner === 0, `köşe=${corner}`);
}

// --- Senaryo 2: balon yok, yazı geniş beyaz zeminde (floating/SFX) ---
{
  const scene = blankScene(300, 220, 252);
  addTextLines(scene, [[110, 100, 190, 118]]);
  scene.text = { x0: 110, y0: 100, x1: 190, y1: 118 };
  const mask = findEnclosedBalloon(scene.lum, scene.rw, scene.rh, "light", scene.text);
  check(
    "balonsuz yazıda balon uydurulmuyor (null)",
    mask === null,
    mask ? `alan=${maskStats(mask, scene.rw).area}` : "null",
  );
}

// --- Senaryo 3: halftone gri köprü — sıkı eşik balonu kurtarmalı ---
{
  const scene = blankScene(300, 220, 150); // gri halftone panel
  fillEllipse(scene, 150, 110, 80, 60, 0);
  fillEllipse(scene, 150, 110, 76, 56, 250);
  addTextLines(scene, [[105, 95, 195, 125]]);
  scene.text = { x0: 105, y0: 95, x1: 195, y1: 125 };
  const mask = findEnclosedBalloon(scene.lum, scene.rw, scene.rh, "light", scene.text);
  const stats = mask ? maskStats(mask, scene.rw) : null;
  check(
    "gri panelde balon içi ayrıldı (panele taşmadı)",
    !!stats && stats.area < 16000 && stats.minX > 60 && stats.maxX < 240,
    stats ? `alan=${stats.area} bbox=${stats.minX}..${stats.maxX}` : "maske yok",
  );
}

// --- Senaryo 4: koyu balon (beyaz yazı) ---
{
  const scene = blankScene(300, 220, 240);
  fillEllipse(scene, 150, 110, 85, 60, 255);
  fillEllipse(scene, 150, 110, 81, 56, 12);
  for (let x = 105; x <= 195; x += 6) fillRect(scene, x, 95, x + 3, 125, 235);
  scene.text = { x0: 105, y0: 95, x1: 195, y1: 125 };
  const mask = findEnclosedBalloon(scene.lum, scene.rw, scene.rh, "dark", scene.text);
  const stats = mask ? maskStats(mask, scene.rw) : null;
  check(
    "koyu balon da bulunuyor",
    !!stats && stats.area > 4000 && stats.area < 16000,
    stats ? `alan=${stats.area}` : "maske yok",
  );
}

// --- Senaryo 5: beyaz sayfa üstünde beyaz balon (yalnızca çizgi ayırıyor) ---
{
  const scene = blankScene(300, 220, 252);
  fillEllipse(scene, 150, 110, 78, 55, 0);
  fillEllipse(scene, 150, 110, 74, 51, 250);
  addTextLines(scene, [[110, 98, 190, 122]]);
  scene.text = { x0: 110, y0: 98, x1: 190, y1: 122 };
  const mask = findEnclosedBalloon(scene.lum, scene.rw, scene.rh, "light", scene.text);
  const stats = mask ? maskStats(mask, scene.rw) : null;
  check(
    "beyaz zeminde beyaz balon sayfaya taşmadı",
    !!stats && stats.minX >= 70 && stats.maxX <= 230 && stats.area < 14000,
    stats ? `alan=${stats.area} bbox=${stats.minX}..${stats.maxX}` : "maske yok",
  );
}

// --- Senaryo 6: kenarı kırık balon → kağıt sayfaya akıyor, balon sayılmamalı ---
{
  const scene = blankScene(300, 220, 252);
  fillEllipse(scene, 150, 110, 78, 55, 0);
  fillEllipse(scene, 150, 110, 74, 51, 250);
  fillRect(scene, 146, 40, 154, 70, 251); // çizgide boşluk
  addTextLines(scene, [[110, 98, 190, 122]]);
  scene.text = { x0: 110, y0: 98, x1: 190, y1: 122 };
  const mask = findEnclosedBalloon(scene.lum, scene.rw, scene.rh, "light", scene.text);
  check(
    "kırık kenarlı balonda sayfa dolgusu reddedildi",
    mask === null,
    mask ? `alan=${maskStats(mask, scene.rw).area}` : "null",
  );
}

// --- Senaryo 7: antialias kenarlı balon + gri köprü (sıkı eşik şart) ---
// Gerçek sayfalarda balon çizgisinin kenarı yumuşaktır. Sıkı eşikte dolgunun
// ilk komşusu çizgi değil antialias grisi olur; çizgi kontrolü dışa bakmazsa
// gerçek balon reddedilir ve balonda hayalet yazı kalır.
{
  const scene = blankScene(300, 220, 252);
  fillEllipse(scene, 150, 110, 80, 57, 150); // antialias halkası
  fillEllipse(scene, 150, 110, 78, 55, 0); // balon çizgisi
  fillEllipse(scene, 150, 110, 75, 52, 152); // iç antialias
  fillEllipse(scene, 150, 110, 73, 50, 250); // balon içi kağıt
  fillRect(scene, 146, 45, 154, 70, 150); // çizgiyi kesen gri köprü
  addTextLines(scene, [[110, 98, 190, 122]]);
  scene.text = { x0: 110, y0: 98, x1: 190, y1: 122 };
  const mask = findEnclosedBalloon(scene.lum, scene.rw, scene.rh, "light", scene.text);
  const stats = mask ? maskStats(mask, scene.rw) : null;
  check(
    "antialias kenarlı balon sıkı eşikle kabul edildi",
    !!stats && stats.minX >= 70 && stats.maxX <= 230 && stats.area < 14000,
    stats ? `alan=${stats.area} bbox=${stats.minX}..${stats.maxX}` : "maske yok",
  );
}

// --- Senaryo 8: balon komşu beyaz alana sızıyor → dolgu kabul edilmemeli ---
// Sızıntı kabul edilirse dolgu balon çizgisini yutar ve sanata taşar.
{
  const scene = blankScene(320, 240, 40);
  fillRect(scene, 20, 20, 300, 220, 250); // geniş beyaz siluet alanı
  fillEllipse(scene, 120, 120, 60, 42, 0);
  fillEllipse(scene, 120, 120, 57, 39, 250);
  fillRect(scene, 116, 78, 124, 84, 250); // çizgide boşluk → beyaz alana akıyor
  addTextLines(scene, [[85, 108, 155, 132]]);
  scene.text = { x0: 85, y0: 108, x1: 155, y1: 132 };
  const hint: TextRect = { x0: 58, y0: 76, x1: 182, y1: 164 };
  const mask = findEnclosedBalloon(
    scene.lum,
    scene.rw,
    scene.rh,
    "light",
    scene.text,
    hint,
  );
  const stats = mask ? maskStats(mask, scene.rw) : null;
  check(
    "komşu beyaz alana sızan dolgu reddedildi",
    !stats || (stats.maxX - stats.minX < 150 && stats.area < 9000),
    stats ? `alan=${stats.area} bbox=${stats.minX}..${stats.maxX}` : "null",
  );
}

// --- Senaryo 9: yazı doğrudan sanatın üstünde → hiçbir şey silinmemeli ---
{
  const scene = blankScene(240, 180, 60); // koyu sanat
  for (let y = 0; y < 180; y += 3) fillRect(scene, 0, y, 239, y, 25); // tarama
  addTextLines(scene, [[80, 80, 160, 100]]);
  scene.text = { x0: 80, y0: 80, x1: 160, y1: 100 };
  const domain = letterDomain(scene.lum, scene.rw, scene.rh, "light", scene.text, {
    cut: 140,
    paperLum: 250,
  });
  check(
    "sanat üstündeki yazıda silme alanı yok",
    domain === null,
    domain ? `alan=${domain.reduce((a, b) => a + b, 0)}` : "null",
  );
}

// --- Senaryo 10: beyaz kutu içindeki yazı → yalnızca kutu içi silinir ---
{
  const scene = blankScene(240, 180, 40);
  for (let y = 0; y < 180; y += 3) fillRect(scene, 0, y, 239, y, 20);
  fillRect(scene, 50, 60, 190, 120, 250); // beyaz caption kutusu
  addTextLines(scene, [[70, 75, 170, 105]]);
  scene.text = { x0: 70, y0: 75, x1: 170, y1: 105 };
  const domain = letterDomain(scene.lum, scene.rw, scene.rh, "light", scene.text, {
    cut: 140,
    paperLum: 250,
  });
  let outside = 0;
  let inside = 0;
  if (domain) {
    for (let p = 0; p < domain.length; p += 1) {
      if (!domain[p]) continue;
      const y = Math.floor(p / scene.rw);
      const x = p - y * scene.rw;
      if (x < 50 || x > 190 || y < 60 || y > 120) outside += 1;
      else inside += 1;
    }
  }
  check(
    "silme alanı beyaz kutunun dışına taşmadı",
    !!domain && inside > 100 && outside === 0,
    `iç=${inside} dış=${outside}`,
  );
}

// --- Senaryo 11: model iki balonu tek kutuda birleştirdi → ikisi de bulunmalı ---
{
  const scene = blankScene(320, 300, 30);
  fillEllipse(scene, 160, 80, 55, 34, 0);
  fillEllipse(scene, 160, 80, 52, 31, 250);
  addTextLines(scene, [[125, 70, 195, 90]]);
  fillEllipse(scene, 160, 210, 80, 58, 0);
  fillEllipse(scene, 160, 210, 77, 55, 250);
  addTextLines(scene, [[105, 185, 215, 235]]);
  // Tek kutu iki balonu birden kapsıyor
  scene.text = { x0: 105, y0: 70, x1: 215, y1: 235 };
  const hint: TextRect = { x0: 78, y0: 44, x1: 242, y1: 270 };

  const single = findEnclosedBalloon(
    scene.lum,
    scene.rw,
    scene.rh,
    "light",
    scene.text,
    hint,
  );
  const both = findEnclosedBalloons(
    scene.lum,
    scene.rw,
    scene.rh,
    "light",
    scene.text,
    hint,
  );
  // Kontrol noktaları harf bantlarının dışında, balon içinde seçildi
  const hitsUpper = both ? both[60 * scene.rw + 160] === 1 : false;
  const hitsLower = both ? both[165 * scene.rw + 160] === 1 : false;
  const singleHitsBoth = single
    ? single[60 * scene.rw + 160] === 1 && single[165 * scene.rw + 160] === 1
    : false;
  check(
    "tek kutudaki iki balon da bulundu",
    hitsUpper && hitsLower && !singleHitsBoth,
    `üst=${hitsUpper} alt=${hitsLower} tekNoktaİkisi=${singleHitsBoth}`,
  );
}

// --- Senaryo 12: yazı kutusu sanatın içindeyken beyaz boşluklar balon sayılmamalı ---
{
  const scene = blankScene(260, 200, 40);
  for (let y = 30; y < 170; y += 6) fillRect(scene, 30, y, 230, y + 2, 250);
  scene.text = { x0: 80, y0: 70, x1: 180, y1: 130 };
  const hint: TextRect = { x0: 60, y0: 50, x1: 200, y1: 150 };
  const mask = findEnclosedBalloons(
    scene.lum,
    scene.rw,
    scene.rh,
    "light",
    scene.text,
    hint,
  );
  check(
    "sanat içindeki beyaz şeritler balon sayılmadı",
    mask === null,
    mask ? `alan=${maskStats(mask, scene.rw).area}` : "null",
  );
}

let failed = 0;
for (const r of results) {
  if (!r.pass) failed += 1;
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}  [${r.detail}]`);
}
console.log(`\n${results.length - failed}/${results.length} geçti`);
process.exit(failed ? 1 : 0);
