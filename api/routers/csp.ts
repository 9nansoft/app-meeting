import { Elysia } from "elysia";
import { getClientIp, writeSecurityLog } from "../services/logger";
import { RateLimiter } from "../services/ratelimit";

/**
 * รับรายงานการละเมิด CSP จากเบราว์เซอร์ (report-uri และ Reporting API)
 *
 * - ไม่ต้อง login: เบราว์เซอร์ส่งรายงานโดยไม่แนบ cookie
 * - จำกัดขนาด body และจำนวนรายงานต่อ IP / ทั้งระบบ กันการยิงรายงานปลอมจนล้น security log
 * - เก็บเฉพาะข้อมูลที่ใช้ปรับนโยบาย: ตัด query string ออกจาก URL (อาจมี token/ข้อมูลส่วนตัว)
 */

const MAX_BODY_BYTES = 16 * 1024;
const MAX_REPORTS_PER_REQUEST = 10;
const reportsByIp = new RateLimiter("csp-ip", 30, 10 * 60 * 1000);
const reportsGlobal = new RateLimiter("csp-global", 500, 60 * 60 * 1000);

/** เก็บแค่ origin + path ของ URL (ไม่เก็บ query/fragment) */
function stripUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  // ค่าพิเศษของ CSP เช่น "inline", "eval", "data", "blob"
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value.slice(0, 40);
  try {
    const u = new URL(value);
    return `${u.origin}${u.pathname}`.slice(0, 300);
  } catch {
    return value.slice(0, 120);
  }
}

function str(value: unknown, max: number): string | null {
  return typeof value === "string" && value ? value.slice(0, max) : null;
}

function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

interface NormalizedReport {
  documentUrl: string | null;
  directive: string | null;
  blockedUrl: string | null;
  sourceFile: string | null;
  line: number | null;
  column: number | null;
  disposition: string | null;
  sample: string | null;
}

/** รองรับทั้งรูปแบบ report-uri ({"csp-report": {...}}) และ Reporting API ([{type, body}]) */
function normalize(payload: unknown): NormalizedReport[] {
  const items: Record<string, unknown>[] = [];
  if (Array.isArray(payload)) {
    for (const r of payload.slice(0, MAX_REPORTS_PER_REQUEST)) {
      if (r && typeof r === "object" && (r as any).type === "csp-violation" && (r as any).body) {
        items.push((r as any).body);
      }
    }
  } else if (payload && typeof payload === "object" && (payload as any)["csp-report"]) {
    items.push((payload as any)["csp-report"]);
  }
  return items.map((b) => ({
    documentUrl: stripUrl(b.documentURL ?? b["document-uri"]),
    directive: str(b.effectiveDirective ?? b["effective-directive"] ?? b["violated-directive"], 60),
    blockedUrl: stripUrl(b.blockedURL ?? b["blocked-uri"]),
    sourceFile: stripUrl(b.sourceFile ?? b["source-file"]),
    line: num(b.lineNumber ?? b["line-number"]),
    column: num(b.columnNumber ?? b["column-number"]),
    disposition: str(b.disposition, 20),
    sample: str(b.sample ?? b["script-sample"], 80),
  }));
}

export const cspRoutes = new Elysia().post(
  "/csp-report",
  async ({ request, set }) => {
    // ตอบ 204 เสมอ (เบราว์เซอร์ไม่สนใจผลลัพธ์) แต่บันทึกเฉพาะที่ผ่านเงื่อนไข
    set.status = 204;
    const length = Number(request.headers.get("content-length") || 0);
    if (length > MAX_BODY_BYTES) return;

    const ip = getClientIp(request.headers);
    const ipKey = ip ?? "unknown";
    if ((await reportsByIp.retryAfter(ipKey)) > 0 || (await reportsGlobal.retryAfter("all")) > 0) return;

    let payload: unknown;
    try {
      const text = await request.text();
      if (text.length > MAX_BODY_BYTES) return;
      payload = JSON.parse(text);
    } catch {
      return;
    }

    const reports = normalize(payload);
    for (const report of reports) {
      if ((await reportsByIp.retryAfter(ipKey)) > 0 || (await reportsGlobal.retryAfter("all")) > 0) break;
      await Promise.all([reportsByIp.hit(ipKey), reportsGlobal.hit("all")]);
      void writeSecurityLog({
        eventType: "csp.violation",
        severity: report.disposition === "enforce" ? "warning" : "info",
        ip,
        userAgent: request.headers.get("user-agent"),
        method: "POST",
        path: "/api/csp-report",
        statusCode: 204,
        detail: { ...report },
      });
    }
  },
  // อ่าน body เอง (content-type เป็น application/csp-report หรือ application/reports+json)
  { parse: "none" },
);
