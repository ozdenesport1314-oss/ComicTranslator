FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    HF_HOME=/models/.hf \
    MODELS_DIR=/models

WORKDIR /app

# opencv-python-headless yine de libgl/libglib istiyor
RUN apt-get update \
    && apt-get install -y --no-install-recommends libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY download_models.py pipeline.py app.py ./

# Ağırlıklar imaja gömülür; çalışma anında indirme beklemesi olmaz.
RUN python download_models.py --dir /models

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
