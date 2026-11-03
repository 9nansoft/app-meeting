import { Elysia } from "elysia";
import { routers } from "./routers";
import { ensureSchema } from "./db";
import { startWorker } from "./services/jobs";
import { initStorage } from "./services/storage";
import {
  getClientIp,
  severityFromStatus,
  startLogMaintenance,
  writeSecurityLog,
} from "./services/logger";

// สร้าง schema + โฟลเดอร์เก็บไฟล์ แล้วเริ่ม AI worker เบื้องหลัง
ensureSchema()
  .then(() => initStorage())
  .then(() => startWorker())
  .then(() => startLogMaintenance())
  .catch((err) => {
    console.error("[Boot] initialization error:", err);
  });

/** HTTP security headers ของทุก response จาก API (หน้าเว็บ Nuxt ตั้งใน nuxt.config.ts routeRules) */
const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=(self)",
  "Cross-Origin-Opener-Policy": "same-origin",
  ...(process.env.NODE_ENV === "production"
    ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" }
    : {}),
};

/** เวลาเริ่ม request สำหรับคิด duration (WeakMap ไม่กั้น GC เมื่อ request จบ) */
const requestStart = new WeakMap<Request, number>();

export const app = new Elysia()
  // Access log (ข้อมูลจราจรคอมพิวเตอร์) ทุก request ที่เข้า API — ตาม พ.ร.บ. คอมพิวเตอร์ ม.26
  // (hook ที่ root ใช้ก่อน .use() จะครอบคลุม route ใน router ทั้งหมด)
  .onRequest(({ request, set }) => {
    requestStart.set(request, Date.now());
    Object.assign(set.headers, SECURITY_HEADERS);
  })
  .onAfterResponse(({ request, set }) => {
    const started = requestStart.get(request);
    const statusCode = Number(set.status ?? 200) || 200;
    void writeSecurityLog({
      eventType: "http.request",
      severity: severityFromStatus(statusCode),
      ip: getClientIp(request.headers),
      userAgent: request.headers.get("user-agent"),
      method: request.method,
      path: new URL(request.url).pathname,
      statusCode,
      durationMs: started !== undefined ? Date.now() - started : null,
    });
  })
  .use(routers);

export type App = typeof app;
export default () => app;
