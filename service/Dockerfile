FROM python:3.11-slim

# Hugging Face Spaces konteyneri root olmayan kullanıcıyla çalıştırır; model ve
# önbellek klasörleri bu kullanıcıya ait olmalı, aksi halde yazma hatası verir.
RUN useradd -m -u 1000 user

ENV PYTHONUNBUFFERED=1 \
    HOME=/home/user \
    MODELS_DIR=/home/user/models \
    HF_HOME=/home/user/.cache/huggingface \
    PORT=7860

# opencv-python-headless yine de libglib istiyor. Paket adı Debian trixie'de
# libglib2.0-0t64 oldu; iki isim de denenir ki taban imaj sürümü değişince
# derleme kırılmasın.
RUN apt-get update \
    && (apt-get install -y --no-install-recommends libglib2.0-0t64 \
        || apt-get install -y --no-install-recommends libglib2.0-0) \
    && rm -rf /var/lib/apt/lists/*

USER user
WORKDIR /home/user/app
ENV PATH=/home/user/.local/bin:$PATH

COPY --chown=user requirements.txt ./
RUN pip install --no-cache-dir --user -r requirements.txt

COPY --chown=user download_models.py pipeline.py app.py ./

# Ağırlıklar imaja gömülür; ilk istek model indirmeyi beklemez.
RUN python download_models.py --dir /home/user/models

EXPOSE 7860
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
