# Temizleme servisini Google Cloud Run'a yukler.
#
# On kosullar:
#   1. Google Cloud hesabi + faturalandirmasi acik bir proje
#   2. gcloud CLI: https://cloud.google.com/sdk/docs/install
#   3. gcloud auth login
#
# Kullanim:
#   .\deploy_cloudrun.ps1 -ProjectId benim-projem
#   .\deploy_cloudrun.ps1 -ProjectId benim-projem -Region europe-west1 -Public

param(
    [Parameter(Mandatory = $true)][string]$ProjectId,
    [string]$Region = "europe-west1",
    [string]$ServiceName = "comic-cleanup",
    [switch]$Public
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "proje ayarlaniyor: $ProjectId"
gcloud config set project $ProjectId | Out-Null

Write-Host "gerekli API'ler aciliyor"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

# Modeller imaj derlemesi sirasinda indirilir; ilk istek beklemez.
# Bellek 4Gi: iki ONNX modeli + 512x512 cikarim tepe kullanimi 2Gi'yi asabiliyor.
$args = @(
    "run", "deploy", $ServiceName,
    "--source", ".",
    "--region", $Region,
    "--memory", "4Gi",
    "--cpu", "2",
    "--timeout", "300",
    "--concurrency", "1",
    "--max-instances", "3",
    "--min-instances", "0"
)
if ($Public) {
    $args += "--allow-unauthenticated"
    Write-Host "servis herkese acik olacak"
} else {
    $args += "--no-allow-unauthenticated"
    Write-Host "servis kapali olacak; cagri icin kimlik token'i gerekir"
}

Write-Host "yukleniyor (ilk derleme modelleri indirdigi icin birkac dakika surer)"
gcloud @args

$url = gcloud run services describe $ServiceName --region $Region --format "value(status.url)"
Write-Host ""
Write-Host "adres: $url"
Write-Host "Vercel'de ayarla: CLEANUP_SERVICE_URL=$url"
