# Caddy + โมดูล Cloudflare DNS สำหรับ service proxy ใน docker-compose.yml
#
# ทำไมต้อง build เอง: image caddy ทางการไม่มีโมดูล DNS — ต้องใช้ caddy-dns/cloudflare เพื่อขอใบรับรอง
# Let's Encrypt ผ่าน DNS challenge ให้โดเมนที่ชี้ IP วงภายใน (Let's Encrypt เข้ามาตรวจทาง HTTP ไม่ได้)
#
# build/push โดย .github/workflows/docker-publish.yml → ghcr.io/<owner>/<repo>-proxy
# อัปเดต: เปลี่ยน CADDY_VERSION + digest ของทั้งสอง image และ CLOUDFLARE_DNS_VERSION พร้อมกัน
ARG CADDY_VERSION=2.11.7

FROM caddy:2.11.7-builder-alpine@sha256:95a5e7e2692b5eb9545aadc5b90a39f6f509bee59c9508a493f83ee902eaef63 AS builder
ARG CADDY_VERSION
# go.sum ของโมดูลตรวจกับ Go checksum database อัตโนมัติ
ARG CLOUDFLARE_DNS_VERSION=v0.2.4
RUN xcaddy build "v${CADDY_VERSION}" --with "github.com/caddy-dns/cloudflare@${CLOUDFLARE_DNS_VERSION}"

FROM caddy:2.11.7-alpine@sha256:e70b164da81ef698b3ad19af799ea6086ce6d9e48ed4079eb9fe26f6fbf14ee5
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
# รันด้วย nobody — /data (ใบรับรอง) ต้องเขียนได้ และ named volume จะได้เจ้าของตามนี้ตอนสร้างครั้งแรก
RUN mkdir -p /data /config && chown -R 65534:65534 /data /config \
 && caddy list-modules | grep -q '^dns.providers.cloudflare$'
USER 65534:65534
ENV XDG_DATA_HOME=/data XDG_CONFIG_HOME=/config
