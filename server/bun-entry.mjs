// Nitro entry สำหรับ production (Bun) — ดัดแปลงจาก nitropack/dist/presets/bun/runtime/bun.mjs
// เพิ่มการปิดอย่างนุ่มนวลเมื่อได้ SIGTERM (docker stop / scripts/rolling-deploy.sh):
//   1. หยุดรับ connection ใหม่ทันที → proxy (Caddy) dial ไม่ได้แล้วส่ง request ไป replica อื่น (retry ได้ทุก method)
//   2. ปิด WebSocket ด้วย 1012 (Service Restart) → หน้าเว็บต่อใหม่ที่ replica อื่นเอง
//   3. รอ request ที่กำลังทำ + shutdown hook (คิวงาน AI, security log) ไม่เกิน SHUTDOWN_TIMEOUT_MS
//   4. process.exit(0) — docker-compose ตั้ง stop_grace_period ให้นานกว่า timeout นี้
// ใช้เฉพาะ production build (nuxt.config.ts → $production.nitro.entry) — nuxt dev ใช้ entry ของ Nitro ตามปกติ
import "#nitro-internal-pollyfills";
import { useNitroApp } from "nitropack/runtime";
import { startScheduleRunner } from "nitropack/runtime/internal";
import wsAdapter from "crossws/adapters/bun";
import { runShutdownHooks } from "../api/services/lifecycle";

const nitroApp = useNitroApp();
const ws = import.meta._websocket ? wsAdapter(nitroApp.h3App.websocket) : void 0;
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 25_000;

let inflight = 0;
let shuttingDown = false;

function parseInt(value) {
  const parsedValue = Number.parseInt(value);
  return Number.isNaN(parsedValue) ? void 0 : parsedValue;
}

const server = Bun.serve({
  port: process.env.NITRO_PORT || process.env.PORT || 3e3,
  hostname: process.env.NITRO_HOST || process.env.HOST,
  idleTimeout: parseInt(process.env.NITRO_BUN_IDLE_TIMEOUT),
  websocket: import.meta._websocket ? ws.websocket : void 0,
  async fetch(req, server2) {
    if (import.meta._websocket && req.headers.get("upgrade") === "websocket") {
      if (shuttingDown) return new Response("server restarting", { status: 503 });
      return ws.handleUpgrade(req, server2);
    }
    inflight++;
    try {
      const url = new URL(req.url);
      let body;
      if (req.body) {
        body = await req.arrayBuffer();
      }
      return await nitroApp.localFetch(url.pathname + url.search, {
        host: url.hostname,
        protocol: url.protocol,
        headers: req.headers,
        method: req.method,
        redirect: req.redirect,
        body,
      });
    } finally {
      inflight--;
    }
  },
});
console.log(`Listening on ${server.url}...`);
if (import.meta._tasks) {
  startScheduleRunner();
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  console.log(`[Shutdown] ${signal}: stop accepting connections, draining ${inflight} request(s)`);
  server.stop(false);
  if (ws) {
    for (const peer of ws.peers) {
      try {
        peer.close(1012, "server restarting");
      } catch {
        /* ปิดไปแล้ว */
      }
    }
  }
  const hooks = runShutdownHooks(deadline);
  while (inflight > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await hooks;
  try {
    await nitroApp.hooks.callHook("close");
  } catch {
    /* ไม่มี hook */
  }
  // เผื่อ response แบบ stream (ดาวน์โหลดไฟล์) ส่งส่วนท้ายให้จบ
  await new Promise((resolve) => setTimeout(resolve, 300));
  console.log(`[Shutdown] done${inflight ? ` (${inflight} request(s) cut off at timeout)` : ""}`);
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
