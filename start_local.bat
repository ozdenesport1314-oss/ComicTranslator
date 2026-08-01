@echo off
REM Iki sunucuyu ayri pencerelerde baslatir:
REM   - temizleme servisi (Python/ONNX)  127.0.0.1:8123
REM   - Next.js uygulamasi              127.0.0.1:3000
REM Pencereleri kapatmadigin surece calisirlar.

cd /d "%~dp0"

if not exist "service\.venv\Scripts\python.exe" (
  echo Python ortami yok. Once service\README.md icindeki kurulumu yap.
  pause
  exit /b 1
)

if not exist "service\models\comic-text-detector.onnx" (
  echo Modeller eksik, indiriliyor...
  service\.venv\Scripts\python.exe service\download_models.py --dir service\models
)

start "Temizleme servisi" cmd /k "cd /d %~dp0service && .venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8123"
start "ComicTranslator" cmd /k "cd /d %~dp0 && npm run dev"

echo.
echo Iki pencere acildi. Uygulama: http://localhost:3000
echo Kapatmak icin o pencereleri kapat.
timeout /t 6 >nul
start "" http://localhost:3000
