"""Model giriş/çıkış imzalarını yazdırır.

Tensör adları ve şekilleri belgeye değil modelin kendisine sorulur; yanlış
varsayım tüm boru hattını sessizce bozar.
"""

from __future__ import annotations

from pathlib import Path

import onnxruntime as ort

for name in ("comic-text-detector.onnx", "lama-manga.onnx"):
    path = Path(__file__).parent / "models" / name
    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    print(f"=== {name} ===")
    for meta in session.get_inputs():
        print(f"  giriş  {meta.name}  {meta.shape}  {meta.type}")
    for meta in session.get_outputs():
        print(f"  çıkış  {meta.name}  {meta.shape}  {meta.type}")
