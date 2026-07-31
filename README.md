# ComicTranslator

Manga / çizgi roman sayfalarındaki baloncuk metinlerini **Gemini** ile istediğin dile çeviren web uygulaması.

- Yeni proje oluştur
- PDF veya görsel (PNG/JPG/WEBP) yükle
- Hedef dili seç
- Sayfa sayfa veya toplu çevir

Projeler tarayıcıda (IndexedDB) saklanır. Çeviri için sunucu tarafında Gemini API kullanılır.

## Kurulum

```bash
npm install
cp .env.example .env.local
```

`.env.local` içine Gemini API anahtarını yaz:

```env
GEMINI_API_KEY=your_key_here
GEMINI_MODEL=gemini-2.5-flash
```

API key: [Google AI Studio](https://aistudio.google.com/apikey)

```bash
npm run dev
```

Tarayıcıda: [http://localhost:3000](http://localhost:3000)

## GitHub + Vercel deploy

1. Repo’yu GitHub’a pushla
2. [Vercel](https://vercel.com) → **Add New Project** → repo’yu seç
3. Environment Variables ekle:
   - `GEMINI_API_KEY`
   - (opsiyonel) `GEMINI_MODEL=gemini-2.5-flash`
4. Deploy

Framework: Next.js (otomatik algılanır).

## Notlar

- PDF’ler tarayıcıda sayfa görsellerine çevrilir (en fazla 40 sayfa).
- Büyük görseller gönderilmeden önce sıkıştırılır.
- Proje verisi cihaz/tarayıcıya özeldir; başka cihazda görünmez.
