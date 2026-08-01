"""Servisi Hugging Face Space olarak yükler.

Docker Space'i oluşturur (yoksa) ve gerekli dosyaları gönderir. Space'in
README.md'si `space_README.md`'den gelir; HF, sdk ve port bilgisini oradaki
YAML başlığından okur.

Kullanım:
  $env:HF_TOKEN = "hf_..."
  python deploy_space.py <kullanici>/<space-adi> [--public]
"""

from __future__ import annotations

import argparse
import os
import shutil
import tempfile
from pathlib import Path

from huggingface_hub import HfApi

FILES = ("Dockerfile", "requirements.txt", "pipeline.py", "app.py", "download_models.py")

parser = argparse.ArgumentParser()
parser.add_argument(
    "repo_id",
    nargs="?",
    default="comic-cleanup",
    help="kullanici/space-adi ya da yalnizca space-adi (kullanici token'dan bulunur)",
)
parser.add_argument(
    "--public",
    action="store_true",
    help="Space herkese açık olsun (varsayılan: gizli)",
)
args = parser.parse_args()

token = os.environ.get("HF_TOKEN")
if not token:
    raise SystemExit("HF_TOKEN ortam değişkeni gerekli (huggingface.co/settings/tokens)")

here = Path(__file__).parent
api = HfApi(token=token)

repo_id = args.repo_id
if "/" not in repo_id:
    repo_id = f"{api.whoami()['name']}/{repo_id}"

api.create_repo(
    repo_id=repo_id,
    repo_type="space",
    space_sdk="docker",
    private=not args.public,
    exist_ok=True,
)
print(f"space hazir: https://huggingface.co/spaces/{repo_id}")

with tempfile.TemporaryDirectory() as tmp:
    staging = Path(tmp)
    for name in FILES:
        shutil.copyfile(here / name, staging / name)
    shutil.copyfile(here / "space_README.md", staging / "README.md")
    api.upload_folder(
        folder_path=str(staging),
        repo_id=repo_id,
        repo_type="space",
        commit_message="ComicTranslator temizleme servisi",
    )

print("dosyalar yuklendi; imaj derlemesi basladi")
print(f"adres: https://{repo_id.replace('/', '-').lower()}.hf.space")
