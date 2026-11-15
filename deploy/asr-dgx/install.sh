#!/usr/bin/env bash
# ติดตั้ง OpenThai2.0 ASR Streaming (iapp/OpenThai2.0-ASR-Streaming) บน NVIDIA DGX Spark
#
#   ./install.sh                     build image, ดาวน์โหลดโมเดล, เปิด server แล้วทดสอบ
#   ./install.sh --with-diarization  ดาวน์โหลดโมเดลแยกผู้พูด (mode=meeting) ไว้ล่วงหน้าด้วย
#   ./install.sh --skip-build        ไม่ build image ใหม่ (เช่น อัปเดตแค่ MODEL_REVISION ใน .env)
#   ./install.sh --no-start          เตรียมทุกอย่างแต่ยังไม่เปิด server
#
# รันซ้ำได้ — ขั้นที่เสร็จแล้วจะข้ามหรือทำซ้ำโดยไม่เสียหาย
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

MODEL_REPO="iapp/OpenThai2.0-ASR-Streaming"
DIAR_REPO="nvidia/Nemotron-3-Diarization"
DIAR_FILE="Nemotron-3-Diarization.nemo"
IMAGE="openthai-asr:local"

WITH_DIAR=0; SKIP_BUILD=0; NO_START=0
for arg in "$@"; do
  case "$arg" in
    --with-diarization) WITH_DIAR=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --no-start) NO_START=1 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "ไม่รู้จักตัวเลือก: $arg (ดู --help)" >&2; exit 2 ;;
  esac
done

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- 1. ตรวจเครื่อง ----------
info "ตรวจสอบเครื่อง"
arch="$(uname -m)"
[[ "$arch" == "aarch64" ]] || warn "เครื่องนี้เป็น $arch ไม่ใช่ aarch64 (DGX Spark) — สคริปต์ยังทำงานได้ถ้ามี GPU NVIDIA + driver ที่รองรับ CUDA 13"

command -v nvidia-smi >/dev/null || die "ไม่พบ nvidia-smi — ต้องติดตั้ง NVIDIA driver ก่อน"
nvidia-smi --query-gpu=name,driver_version --format=csv,noheader || die "nvidia-smi เรียกไม่สำเร็จ"
driver_major="$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1 | cut -d. -f1)"
(( driver_major >= 580 )) || die "driver $driver_major เก่าเกินไป — PyTorch cu130 ต้องใช้ driver 580 ขึ้นไป"

command -v docker >/dev/null || die "ไม่พบ docker"
docker compose version >/dev/null 2>&1 || die "ไม่พบ docker compose v2"
docker info >/dev/null 2>&1 || die "ใช้ docker ไม่ได้ — เพิ่มผู้ใช้เข้ากลุ่ม docker (sudo usermod -aG docker \$USER แล้ว login ใหม่)"
docker info 2>/dev/null | grep -qi nvidia || warn "docker info ไม่แสดง runtime nvidia — จะลองรัน container ทดสอบ GPU"
docker run --rm --gpus all ubuntu:24.04 nvidia-smi -L >/dev/null 2>&1 \
  || die "container มองไม่เห็น GPU — ติดตั้ง/ตั้งค่า NVIDIA Container Toolkit (sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker)"

avail_gb="$(df -BG --output=avail . | tail -1 | tr -dc '0-9')"
(( avail_gb >= 30 )) || warn "พื้นที่ว่างเหลือ ${avail_gb}GB — แนะนำอย่างน้อย 30GB (image ~15GB + โมเดล ~3GB + โมเดลแยกผู้พูด)"

# ---------- 2. .env ----------
if [[ ! -f .env ]]; then
  info "สร้าง .env"
  old_umask="$(umask)"; umask 077
  cat > .env <<EOF
# ค่าสำหรับ docker-compose.yml และ install.sh
ASR_UID=$(id -u)
ASR_GID=$(id -g)
# ที่อยู่ที่เปิดพอร์ต — server ไม่มี authentication ห้ามเปิดออกอินเทอร์เน็ต
# ถ้าเครื่อง app-meeting อยู่คนละเครื่อง ตั้งเป็น IP วงภายในหรือ Tailscale ของเครื่องนี้
ASR_BIND=127.0.0.1
ASR_PORT=18081
# commit ของ $MODEL_REPO ที่ทดสอบแล้ว — เปลี่ยนแล้วรัน ./install.sh --skip-build เพื่ออัปเดต
MODEL_REVISION=c28df2a70bb16376ed7dc6a5233cffb41bb54a68
# จำนวนสำเนาโมเดล (ละ ~2.6GB) — เพิ่มเมื่อมีหลายห้องประชุมพร้อมกัน
CHINDA_REPLICAS=1
# ใส่ถ้าโดน rate limit ตอนดาวน์โหลดจาก Hugging Face (ไม่บังคับ)
HF_TOKEN=
EOF
  umask "$old_umask"
fi
set -a; source ./.env; set +a
[[ -n "${MODEL_REVISION:-}" ]] || die "ไม่มี MODEL_REVISION ใน .env"

mkdir -p data/model data/hf-cache

# ---------- 3. build image ----------
if (( SKIP_BUILD )) && docker image inspect "$IMAGE" >/dev/null 2>&1; then
  info "ข้ามการ build (มี image $IMAGE อยู่แล้ว)"
else
  info "build image $IMAGE (ครั้งแรกใช้เวลา 15-40 นาที — compile dependency บางตัวบน arm64)"
  DOCKER_BUILDKIT=1 docker compose build
fi

# ---------- 4. ดาวน์โหลดโมเดล ----------
# รันใน image ที่ build แล้ว (มี huggingface_hub) ด้วย uid ของผู้ใช้ — ไม่ต้องลง Python บนเครื่อง
# ดาวน์โหลดเฉพาะไฟล์ raw (server ใช้) + serve/ — ข้ามไฟล์ bias ที่ไม่ได้ใช้ (ประหยัด 2.5GB)
run_in_image() {
  docker run --rm --user "$(id -u):$(id -g)" \
    -e HOME=/tmp -e HF_HOME=/data/hf-cache -e HF_TOKEN="${HF_TOKEN:-}" \
    -v "$PWD/data/model:/models" -v "$PWD/data/hf-cache:/data/hf-cache" \
    "$IMAGE" "$@"
}

info "ดาวน์โหลด $MODEL_REPO @ ${MODEL_REVISION:0:12} (~2.6GB)"
run_in_image python -c '
import sys
from huggingface_hub import snapshot_download
path = snapshot_download(
    repo_id=sys.argv[1], revision=sys.argv[2],
    local_dir="/models/OpenThai2.0-ASR-Streaming",
    allow_patterns=["openthai2.0-asr-streaming_raw.nemo", "serve/*", "LICENSE", "README.md"],
)
print("ok:", path)
' "$MODEL_REPO" "$MODEL_REVISION"

[[ -s data/model/OpenThai2.0-ASR-Streaming/openthai2.0-asr-streaming_raw.nemo ]] || die "ดาวน์โหลดไฟล์โมเดลไม่สำเร็จ"
[[ -f data/model/OpenThai2.0-ASR-Streaming/serve/app.py ]] || die "ดาวน์โหลด serve/ ไม่สำเร็จ"

if (( WITH_DIAR )); then
  info "ดาวน์โหลด $DIAR_REPO (โมเดลแยกผู้พูดสำหรับ mode=meeting)"
  run_in_image python -c '
import sys
from huggingface_hub import hf_hub_download
print("ok:", hf_hub_download(sys.argv[1], sys.argv[2]))
' "$DIAR_REPO" "$DIAR_FILE"
fi

if (( NO_START )); then
  info "เสร็จ (ยังไม่เปิด server — สั่ง docker compose up -d เมื่อพร้อม)"
  exit 0
fi

# ---------- 5. เปิด server ----------
info "เปิด server"
docker compose up -d --force-recreate

info "ตรวจ GPU ใน container"
docker compose exec -T asr python -c '
import torch
assert torch.cuda.is_available(), "torch มองไม่เห็น CUDA"
cap = torch.cuda.get_device_capability(0)
print("gpu:", torch.cuda.get_device_name(0), "sm_%d%d" % cap, "| torch", torch.__version__, "| arch list", torch.cuda.get_arch_list())
' || { docker compose logs --tail 50 asr; die "GPU ใน container ใช้ไม่ได้"; }

info "รอโหลดโมเดล (CHINDA_PRELOAD=1 — ครั้งแรกอาจใช้หลายนาที)"
deadline=$(( SECONDS + 900 ))
until docker compose exec -T asr python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:18081/v1/health', timeout=5)" >/dev/null 2>&1; do
  if [[ "$(docker compose ps --status running -q asr)" == "" ]]; then
    docker compose logs --tail 80 asr
    die "container หยุดทำงานระหว่างโหลดโมเดล (ดู log ด้านบน)"
  fi
  (( SECONDS < deadline )) || { docker compose logs --tail 80 asr; die "รอเกิน 15 นาทีแล้วยังไม่พร้อม"; }
  sleep 5
done

docker compose exec -T asr python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:18081/v1/health').read().decode())"

# ---------- 6. ทดสอบถอดเสียงบน GPU ----------
# ใช้เสียงเงียบ 3 วินาที — ผลเป็นข้อความว่าง แต่พิสูจน์ว่า decode บน GPU ทำงานครบทั้งเส้นทาง
info "ทดสอบ POST /v1/transcribe"
docker compose exec -T asr sh -c '
  ffmpeg -loglevel error -y -f lavfi -i anullsrc=r=16000:cl=mono -t 3 /tmp/smoke.wav &&
  curl -fsS -F file=@/tmp/smoke.wav -F mode=standard http://127.0.0.1:18081/v1/transcribe
' || { docker compose logs --tail 80 asr; die "ทดสอบถอดเสียงไม่ผ่าน"; }
echo

info "ติดตั้งเสร็จ — server อยู่ที่ http://${ASR_BIND}:${ASR_PORT} (POST /v1/transcribe, WS /v1/live)"
[[ "$ASR_BIND" == "127.0.0.1" ]] && echo "    ตอนนี้เข้าได้เฉพาะจากเครื่องนี้ — ถ้า app-meeting อยู่เครื่องอื่น แก้ ASR_BIND ใน .env แล้ว docker compose up -d"
echo "    ทดสอบด้วยไฟล์เสียงจริง: curl -F file=@a.wav -F mode=meeting http://${ASR_BIND}:${ASR_PORT}/v1/transcribe"
