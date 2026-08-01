# Temizleme servisi

Manga sayfasındaki yazıyı bulup silen HTTP servisi. Sezgisel (piksel eşiği,
bileşen kuralları) yaklaşımın yerini alır: maske manga üzerinde eğitilmiş bir
modelden gelir.

## Modeller

| Model | Görev | Kaynak | Lisans |
| --- | --- | --- | --- |
| `comic-text-detector.onnx` (95 MB) | piksel bazında yazı maskesi + yazı bloğu kutuları | [mayocream/comic-text-detector-onnx](https://huggingface.co/mayocream/comic-text-detector-onnx) | Apache-2.0 |
| `lama-manga.onnx` (207 MB) | maskelenen alanı doldurma (inpaint) | [mayocream/lama-manga-onnx](https://huggingface.co/mayocream/lama-manga-onnx) | Apache-2.0 |

Ağırlıklar repoya konmaz, `download_models.py` ile indirilir.

## Boru hattı

1. Sayfa 1024×1024'e letterbox ile ölçeklenir, dedektöre verilir.
2. `seg` çıkışı → harf piksellerinin olasılık haritası → eşik + parazit temizliği + 2 px genişletme.
3. `blk` çıkışı → yazı bloğu kutuları (NMS ile). Maske bu kutulara kısıtlanır;
   böylece kılıç parıltısı, kafatası dikeni gibi parlak sanat detayları maskeden düşer.
4. Maskeli bölgeler gruplanır, her grup 512×512'ye ölçeklenip LaMa ile doldurulur,
   yalnızca maskeli pikseller sayfaya geri yazılır.

Bir sayfa CPU'da ~6-10 saniye sürer.

## Yerel çalıştırma

```powershell
cd service
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe download_models.py
.\.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8123
```

Next.js tarafında `.env.local`:

```
CLEANUP_SERVICE_URL=http://127.0.0.1:8123
```

## Uç noktalar

- `GET /health` → `{ "ok": true }`
- `POST /clean` → gövde `{ "imageBase64": "data:image/png;base64,...", "threshold": 0.3, "returnMask": false }`,
  yanıt `{ "imageBase64", "coverage", "blocks", "ms" }`

## Araçlar

```powershell
# Tek sayfada maske/inpaint çıktısını out/ klasörüne yazar
.\.venv\Scripts\python.exe try_page.py <gorsel> --crop x0,y0,x1,y1

# Çalışan servise uçtan uca istek atar
.\.venv\Scripts\python.exe smoke_test.py <gorsel>

# Model giriş/çıkış imzalarını yazdırır
.\.venv\Scripts\python.exe inspect_models.py
```

`try_page.py` çıktısındaki `overlay.png` dosyasında kırmızı = silinecek
pikseller, sarı = blok filtresinin elediği yanlış pozitifler, yeşil çerçeve =
model yazı bloğu.

## Deploy: Hugging Face Spaces

Vercel bu servisi barındıramaz (300 MB model + ONNX çalışma zamanı). Docker
Space'i tek komutla yüklenir:

```powershell
$env:HF_TOKEN = "hf_..."   # huggingface.co/settings/tokens, write yetkisi
cd service
.\.venv\Scripts\python.exe deploy_space.py kullanici/comic-cleanup
```

Space varsayılan olarak **gizli** oluşturulur; herkese açık istiyorsan
`--public` ekle. İmaj derlemesi modelleri indirdiği için ilk kurulum birkaç
dakika sürer, Space sayfasındaki Logs sekmesinden izlenebilir.

Sonra Vercel projesinde:

```
CLEANUP_SERVICE_URL=https://kullanici-comic-cleanup.hf.space
CLEANUP_SERVICE_TOKEN=hf_...      # yalnızca Space gizliyse
```

Bilinmesi gerekenler:

- Ücretsiz CPU Space'i 2 vCPU'dur; sayfa başına süre yerelde ~6 saniye,
  Space'te ~15-30 saniye olur.
- Ücretsiz Space 48 saat işlem görmezse uyur; uyandıktan sonraki ilk istek
  bir dakikaya kadar bekler.

## Deploy: kendi konteyner hostun

```bash
docker build -t comic-cleanup service
docker run -p 7860:7860 comic-cleanup
```
