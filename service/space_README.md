---
title: Comic Cleanup
emoji: 🧽
colorFrom: indigo
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

# Comic Cleanup

Manga/çizgi roman sayfasındaki yazıyı bulup silen servis. ComicTranslator
uygulamasının temizleme adımı bu servisi çağırır.

- `comic-text-detector` → piksel bazında yazı maskesi + yazı bloğu kutuları
- `lama-manga` → maskelenen alanın dolgusu

## Uç noktalar

- `GET /health`
- `POST /clean` — gövde `{ "imageBase64": "data:image/png;base64,...", "threshold": 0.3, "returnMask": false }`,
  yanıt `{ "imageBase64", "coverage", "blocks", "ms" }`
