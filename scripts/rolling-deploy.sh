#!/usr/bin/env bash
# Rolling deploy ไม่มี downtime สำหรับ docker-compose.yml ของโปรเจกต์
#
#   cd <โฟลเดอร์ที่มี docker-compose.yml + .env> && APP_TAG=sha-abc1234 bash rolling-deploy.sh
#   (deploy workflow ส่งสคริปต์นี้ผ่าน ssh: ssh host "cd $DEPLOY_PATH && APP_TAG=... bash -s" < scripts/rolling-deploy.sh)
#
# ขั้นตอน:
#   1. pull image ใหม่ แล้วเปิด container ใหม่ของ app เพิ่มข้าง container เดิม (จำนวนเท่า APP_REPLICAS)
#   2. รอจน container ใหม่ healthy (GET /api/health ตอบ 200: schema พร้อม + ต่อ DB ได้)
#      ถ้าไม่ healthy ภายใน HEALTH_TIMEOUT → ลบ container ใหม่ทิ้ง ตัวเดิมยังให้บริการต่อ แล้วจบด้วย error
#   3. รอ proxy (Caddy) เห็น container ใหม่ แล้ว docker stop ตัวเดิมทีละตัว
#      app ได้ SIGTERM → หยุดรับ connection ใหม่ (proxy ส่งไปตัวอื่น), ทำ request ค้างให้จบ,
#      ปิด WebSocket ให้หน้าเว็บต่อใหม่, คืนงาน AI ที่ทำไม่ทันเข้าคิว (server/bun-entry.mjs)
#
# ต้องการ: docker compose v2 และ docker-compose.yml ที่มี service proxy (เวอร์ชันที่รองรับหลาย instance)
set -euo pipefail

HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-300}"   # วินาที — รอ container ใหม่ healthy
STOP_TIMEOUT="${STOP_TIMEOUT:-40}"        # วินาที — ให้ตัวเดิมปิดอย่างนุ่มนวลก่อน SIGKILL (ตรงกับ stop_grace_period)
PROXY_REFRESH_WAIT="${PROXY_REFRESH_WAIT:-7}"  # วินาที — Caddy ถาม DNS หา replica ใหม่ทุก 5 วินาที

log() { printf '[rolling-deploy] %s\n' "$*"; }
die() { printf '[rolling-deploy] ERROR: %s\n' "$*" >&2; exit 1; }

[[ -f docker-compose.yml || -f compose.yaml || -f compose.yml ]] || die "ไม่พบ docker-compose.yml ในโฟลเดอร์ $(pwd)"
docker compose config -q || die "docker-compose.yml ไม่ถูกต้อง"
export APP_TAG="${APP_TAG:-latest}"

# จำนวน replica: APP_REPLICAS จาก environment > .env > 1
if [[ -z "${APP_REPLICAS:-}" && -f .env ]]; then
  APP_REPLICAS="$(grep -E '^[[:space:]]*APP_REPLICAS=' .env | tail -1 | cut -d= -f2- | tr -d '"'"'"' [:space:]' || true)"
fi
REPLICAS="${APP_REPLICAS:-1}"
[[ "$REPLICAS" =~ ^[1-9][0-9]?$ ]] || die "APP_REPLICAS ต้องเป็นตัวเลข 1-99 (ได้ '$REPLICAS')"

if ! docker compose config --services | grep -qx proxy; then
  log "docker-compose.yml ยังไม่มี service proxy — deploy แบบเดิม (มี downtime ระหว่างรีสตาร์ต)"
  docker compose pull app
  docker compose up -d --remove-orphans
  exit 0
fi

log "pull image app:${APP_TAG}"
docker compose pull app

# ครั้งแรกที่ย้ายจาก docker-compose.yml แบบเดิม (app bind พอร์ต host เอง): proxy จะ bind พอร์ตเดียวกันไม่ได้
# จนกว่า app เดิมจะถูกปิด — ต้อง up ทั้งชุดหนึ่งครั้ง (มี downtime ครั้งเดียว)
for c in $(docker compose ps -q app); do
  if [[ -n "$(docker port "$c" 2>/dev/null)" ]]; then
    log "app เดิมยัง bind พอร์ต host (compose เวอร์ชันก่อน) — up ทั้งชุดครั้งเดียว (มี downtime สั้น ๆ)"
    docker compose up -d --remove-orphans --scale "app=${REPLICAS}"
    exit 0
  fi
done

# service อื่น (valkey/proxy/cloudflared) — สร้างใหม่เฉพาะเมื่อ config เปลี่ยน
docker compose up -d --no-deps --remove-orphans valkey proxy cloudflared

mapfile -t OLD < <(docker compose ps -q app)
if [[ ${#OLD[@]} -eq 0 ]]; then
  log "ยังไม่มี app ที่รันอยู่ — เปิด ${REPLICAS} replica"
  docker compose up -d --no-deps --scale "app=${REPLICAS}" app
  exit 0
fi

log "app เดิม ${#OLD[@]} container → เปิดตัวใหม่ ${REPLICAS} container ข้างกัน"
docker compose up -d --no-deps --no-recreate --scale "app=$(( ${#OLD[@]} + REPLICAS ))" app

mapfile -t ALL < <(docker compose ps -q app)
NEW=()
for c in "${ALL[@]}"; do
  [[ " ${OLD[*]} " == *" $c "* ]] || NEW+=("$c")
done
[[ ${#NEW[@]} -gt 0 ]] || die "ไม่มี container ใหม่ถูกสร้าง"

health() { docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$1" 2>/dev/null || echo missing; }

log "รอ container ใหม่ healthy (สูงสุด ${HEALTH_TIMEOUT}s)"
deadline=$(( SECONDS + HEALTH_TIMEOUT ))
while :; do
  ready=0; failed=""
  for c in "${NEW[@]}"; do
    case "$(health "$c")" in
      healthy) ready=$(( ready + 1 )) ;;
      unhealthy|missing|none) failed="$c" ;;
    esac
  done
  [[ $ready -eq ${#NEW[@]} ]] && break
  if [[ -n "$failed" || $SECONDS -ge $deadline ]]; then
    log "container ใหม่ไม่พร้อม — ยกเลิก deploy (ตัวเดิมยังให้บริการอยู่)"
    for c in "${NEW[@]}"; do docker logs --tail 40 "$c" 2>&1 | sed "s/^/  [${c:0:12}] /" || true; done
    docker stop -t "$STOP_TIMEOUT" "${NEW[@]}" >/dev/null || true
    docker rm "${NEW[@]}" >/dev/null || true
    die "rollback แล้ว: image app:${APP_TAG} ไม่ผ่าน health check"
  fi
  sleep 2
done
log "container ใหม่ healthy ครบ ${#NEW[@]} ตัว"

sleep "$PROXY_REFRESH_WAIT"
for c in "${OLD[@]}"; do
  log "ปิด ${c:0:12} อย่างนุ่มนวล (สูงสุด ${STOP_TIMEOUT}s)"
  docker stop -t "$STOP_TIMEOUT" "$c" >/dev/null
  docker rm "$c" >/dev/null
done

# ให้จำนวนตรงกับที่ตั้งไว้ (ปกติไม่มีอะไรเปลี่ยน)
docker compose up -d --no-deps --no-recreate --scale "app=${REPLICAS}" app
docker image prune -f >/dev/null || true
log "เสร็จ — app:${APP_TAG} ${REPLICAS} replica"
docker compose ps
