# syntax=docker/dockerfile:1
#
# OpenThai2.0 ASR Streaming (iapp/OpenThai2.0-ASR-Streaming) สำหรับ NVIDIA DGX Spark (arm64 + CUDA 13)
# ใช้ชุดเวอร์ชันเดียวกับที่ model card ทดสอบ: Python 3.12, PyTorch 2.13 (cu130), NeMo Speech commit cf724ac
#
# image นี้มีแค่ runtime — ไฟล์โมเดลและโค้ด serve/ ดาวน์โหลดแยกไว้ที่ ./data/model แล้ว mount เข้ามา
# (install.sh ทำให้) จึงอัปเดตโมเดลได้โดยไม่ต้อง build image ใหม่

FROM ubuntu:24.04

# uv — pin เวอร์ชันเพื่อให้ build ซ้ำได้ผลเหมือนเดิม
COPY --from=ghcr.io/astral-sh/uv:0.9.5 /uv /usr/local/bin/uv

ARG TORCH_VERSION=2.13.0
ARG TORCH_INDEX=https://download.pytorch.org/whl/cu130
ARG NEMO_COMMIT=cf724ac337d1ebc7d0dda1e23fb80916f52927a5

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    VIRTUAL_ENV=/opt/asr \
    PATH=/opt/asr/bin:$PATH

# build-essential/python3.12-dev: dependency ของ NeMo บางตัวไม่มี wheel arm64 ต้อง compile เอง
# ffmpeg: ให้ API รับ mp3/m4a/ogg/webm ได้ (ไฟล์จาก MediaRecorder ของเบราว์เซอร์เป็น webm)
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3.12 python3.12-dev build-essential git \
      ffmpeg libsndfile1 sox curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN uv venv /opt/asr --python /usr/bin/python3.12

RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install "torch==${TORCH_VERSION}" --index-url "${TORCH_INDEX}"

RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install Cython packaging

# ระบุ torch ซ้ำเพื่อไม่ให้ NeMo ดึง torch เวอร์ชันอื่น (เช่น wheel CPU จาก PyPI) มาทับ
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --extra-index-url "${TORCH_INDEX}" --index-strategy unsafe-best-match \
      "torch==${TORCH_VERSION}" \
      "nemo-toolkit[asr] @ git+https://github.com/NVIDIA-NeMo/Speech.git@${NEMO_COMMIT}"

RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --extra-index-url "${TORCH_INDEX}" --index-strategy unsafe-best-match \
      "torch==${TORCH_VERSION}" \
      fastapi uvicorn python-multipart websockets huggingface_hub

# ตรวจตั้งแต่ตอน build: torch ต้องเป็น build CUDA และ import NeMo ASR ได้บน arm64
RUN python -c "import torch; assert torch.version.cuda, 'ได้ torch แบบ CPU-only'; print('torch', torch.__version__, 'cuda', torch.version.cuda)" \
 && python -c "from nemo.collections.asr.models import ASRModel; import nemo; print('nemo', nemo.__version__)"

# container รันด้วย uid/gid ของผู้ใช้บนเครื่อง (กำหนดใน docker-compose.yml) — cache ทั้งหมดไว้ใน /tmp
ENV HOME=/tmp \
    NUMBA_CACHE_DIR=/tmp/numba \
    TRITON_CACHE_DIR=/tmp/triton \
    HF_HOME=/data/hf-cache

EXPOSE 18081
