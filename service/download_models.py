"""Model indirici.

İki model kullanılıyor (ikisi de Apache-2.0):
  * comic-text-detector — manga üzerinde eğitilmiş piksel bazlı yazı maskesi
  * lama-manga         — maskelenen alanı dolduran inpaint ağı

Ağırlıklar repoya konmaz; ilk çalıştırmada ya da Docker imajı kurulurken
indirilir.
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

from huggingface_hub import hf_hub_download

MODELS: dict[str, tuple[str, str]] = {
    "comic-text-detector.onnx": (
        "mayocream/comic-text-detector-onnx",
        "comic-text-detector.onnx",
    ),
    "lama-manga.onnx": ("mayocream/lama-manga-onnx", "lama-manga.onnx"),
}


def ensure_models(target: Path, only: str | None = None) -> list[Path]:
    target.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []
    for name, (repo_id, filename) in MODELS.items():
        if only and name != only:
            continue
        destination = target / name
        if destination.exists():
            paths.append(destination)
            print(f"var  {destination}")
            continue
        print(f"indiriliyor  {repo_id}/{filename}")
        cached = hf_hub_download(repo_id=repo_id, filename=filename)
        shutil.copyfile(cached, destination)
        paths.append(destination)
        print(f"tamam  {destination}")
    return paths


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--dir",
        default=str(Path(__file__).parent / "models"),
        help="Modellerin yazılacağı klasör",
    )
    parser.add_argument("--only", default=None, help="Tek bir model dosyası indir")
    args = parser.parse_args()
    ensure_models(Path(args.dir), args.only)
