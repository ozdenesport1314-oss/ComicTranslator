"""Manga temizleme servisi.

  POST /clean   { "imageBase64": "data:image/...;base64,..." }
                → { "imageBase64", "maskBase64", "coverage", "blocks", "ms" }
  GET  /health  → { "ok": true }

Modeller ilk istekte değil süreç açılışında yüklenir; ilk isteğin 7 saniye
beklemesi kullanıcıya hata gibi görünüyordu.
"""

from __future__ import annotations

import base64
import os
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated

import cv2
import numpy as np
from fastapi import Body, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from pipeline import MangaCleaner

cleaner: MangaCleaner | None = None


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    global cleaner
    cleaner = MangaCleaner()
    yield


app = FastAPI(title="ComicTranslator cleanup", version="1.0", lifespan=lifespan)

# Tarayıcıdan doğrudan çağrı yapılabilsin (yerel geliştirme).
origins = os.environ.get("ALLOWED_ORIGINS", "*").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in origins],
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)

class CleanRequest(BaseModel):
    imageBase64: str
    threshold: float = 0.3
    grow: int = 2
    restrictToBlocks: bool = True
    returnMask: bool = False


class CleanResponse(BaseModel):
    imageBase64: str
    maskBase64: str | None = None
    coverage: float
    blocks: int
    ms: int


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": cleaner is not None}


def _decode(data_url: str) -> np.ndarray:
    payload = data_url.split(",", 1)[-1]
    try:
        raw = base64.b64decode(payload)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, "base64 çözülemedi") from exc
    image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(400, "görsel çözülemedi")
    return image


def _encode(image: np.ndarray, ext: str = ".jpg") -> str:
    params = [int(cv2.IMWRITE_JPEG_QUALITY), 94] if ext == ".jpg" else []
    ok, buffer = cv2.imencode(ext, image, params)
    if not ok:
        raise HTTPException(500, "görsel kodlanamadı")
    mime = "image/jpeg" if ext == ".jpg" else "image/png"
    return f"data:{mime};base64,{base64.b64encode(buffer).decode()}"


@app.post("/clean", response_model=CleanResponse)
def clean(request: Annotated[CleanRequest, Body()]) -> CleanResponse:
    if cleaner is None:
        raise HTTPException(503, "model yüklenmedi")
    started = time.time()
    bgr = _decode(request.imageBase64)
    mask = cleaner.detect_mask(
        bgr,
        threshold=request.threshold,
        grow=request.grow,
        restrict_to_blocks=request.restrictToBlocks,
    )
    blocks = cleaner.detect_blocks(bgr)
    cleaned = cleaner.inpaint(bgr, mask)
    return CleanResponse(
        imageBase64=_encode(cleaned),
        maskBase64=_encode(mask, ".png") if request.returnMask else None,
        coverage=float((mask > 0).mean()),
        blocks=len(blocks),
        ms=int((time.time() - started) * 1000),
    )
