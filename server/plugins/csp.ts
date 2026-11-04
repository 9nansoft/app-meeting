import { createHash } from "node:crypto";

/**
 * Content-Security-Policy สำหรับหน้าเว็บ Nuxt (SSR)
 *
 * โหมดตั้งด้วย CSP_MODE:
 *   report-only (ค่าเริ่มต้น) — ส่ง Content-Security-Policy-Report-Only: เบราว์เซอร์ไม่บล็อกอะไร
 *                               แต่รายงานสิ่งที่ "จะถูกบล็อก" มาที่ /api/csp-report
 *   enforce                   — บังคับใช้จริง (เปลี่ยนเมื่อดู report แล้วไม่มี violation ที่ถูกต้อง)
 *   off                       — ปิด
 *
 * script-src ไม่ใช้ 'unsafe-inline': inline script ที่ Nuxt/โมดูลใส่ในหน้า (เช่น window.__NUXT__,
 * สคริปต์ color-mode) อนุญาตด้วย hash SHA-256 ที่คำนวณจาก HTML ของแต่ละ response
 * (ใช้ hook render:response ซึ่งได้ HTML ฉบับสุดท้ายหลังทุกโมดูลแก้แล้ว)
 */

type CspMode = "report-only" | "enforce" | "off";

const REPORT_PATH = "/api/csp-report";

/** โดเมน Iconify ที่ @iconify/vue ใช้โหลดไอคอน (ModeToggle/ThemeToggle) */
const ICONIFY_HOSTS = ["https://api.iconify.design", "https://api.simplesvg.com", "https://api.unisvg.com"];

function cspMode(): CspMode {
  const raw = (process.env.CSP_MODE || "report-only").toLowerCase();
  return raw === "enforce" || raw === "off" ? raw : "report-only";
}

/**
 * inline <script> ที่ CSP ตรวจ: ทุกตัวที่ไม่มี src ยกเว้นบล็อกข้อมูล JSON
 * (importmap ก็ถูกตรวจด้วย script-src จึงต้องมี hash)
 */
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const DATA_BLOCK_TYPE_RE = /\btype\s*=\s*["']?application\/(?:json|ld\+json)/i;

export function inlineScriptHashes(html: string): string[] {
  const hashes = new Set<string>();
  for (const match of html.matchAll(SCRIPT_RE)) {
    const attrs = match[1] ?? "";
    const content = match[2] ?? "";
    if (/\bsrc\s*=/i.test(attrs) || DATA_BLOCK_TYPE_RE.test(attrs) || content.length === 0) continue;
    hashes.add(`'sha256-${createHash("sha256").update(content, "utf8").digest("base64")}'`);
  }
  return [...hashes];
}

export function buildPolicy(scriptHashes: string[]): string {
  const extraConnect = (process.env.CSP_EXTRA_CONNECT_SRC || "").split(/[\s,]+/).filter(Boolean);
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    // 'report-sample' ให้รายงานแนบโค้ด 80 ตัวอักษรแรกที่ถูกบล็อก (ช่วยไล่หาที่มา)
    "script-src": ["'self'", "'report-sample'", ...scriptHashes],
    "script-src-attr": ["'none'"],
    // Vue/reka-ui ใส่ style attribute และ emotion สร้าง <style> ตอนรัน → ยังต้องใช้ 'unsafe-inline'
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'", ...ICONIFY_HOSTS, ...extraConnect],
    // เล่นเสียงที่บันทึก / ดาวน์โหลดไฟล์ที่สร้างด้วย URL.createObjectURL
    "media-src": ["'self'", "blob:"],
    "worker-src": ["'self'", "blob:"],
    "frame-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'self'"],
    // ใช้ report-uri อย่างเดียว: ทุกเบราว์เซอร์หลักรองรับ (Firefox ยังไม่รองรับ report-to ของ CSP)
    // และ Chrome จะเลิกใช้ report-uri ทันทีถ้ามี report-to อยู่ด้วย
    "report-uri": [REPORT_PATH],
  };
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}

export default defineNitroPlugin((nitroApp) => {
  // dev ใช้ Vite HMR (inline script/websocket) — ไม่ใส่ CSP เพื่อไม่ให้มี report รก
  if (import.meta.dev) return;

  nitroApp.hooks.hook("render:response", (response) => {
    const mode = cspMode();
    if (mode === "off" || !response || typeof response.body !== "string") return;
    const headers = (response.headers ??= {}) as Record<string, string>;
    const contentType = String(headers["content-type"] ?? headers["Content-Type"] ?? "");
    if (contentType && !contentType.includes("text/html")) return;

    const policy = buildPolicy(inlineScriptHashes(response.body));
    const headerName = mode === "enforce" ? "content-security-policy" : "content-security-policy-report-only";
    headers[headerName] = policy;
  });
});
