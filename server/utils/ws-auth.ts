import { resolveSessionToken } from "../../api/middleware/auth";
import { authorizeMeeting } from "../../api/services/access";
import { getClientIp, writeSecurityLog } from "../../api/services/logger";

/**
 * ตรวจ WebSocket upgrade ของการประชุม (ใช้ร่วมกันใน server/routes/ws/*)
 * — Origin, session cookie, meetingId, สิทธิ์ดูการประชุม แล้วบันทึกการปฏิเสธลง security_logs
 *
 * WebSocket อยู่นอก /api (nuxt-elysia ส่งทุก request ใต้ /api ให้ Elysia ซึ่งรับ upgrade ไม่ได้)
 * จึงต้องตรวจเองด้วยฟังก์ชันเดียวกับ API
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WsMeetingContext {
  userId: number;
  username: string;
  name: string;
  meetingId: string;
  ip: string | null;
  userAgent: string | null;
}

interface UpgradeRequest {
  url: string;
  headers: Headers;
}

export function rejectUpgrade(status: number, message: string): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function readCookie(header: string | null, name: string): string | undefined {
  for (const part of (header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * กัน Cross-Site WebSocket Hijacking: WebSocket ไม่ผ่าน CORS จึงต้องตรวจ Origin เอง
 * ต้องเป็น host เดียวกับที่ผู้ใช้เปิดหน้าเว็บ (หรืออยู่ใน WS_ALLOWED_ORIGINS)
 */
export function originAllowed(request: UpgradeRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const allowed = (process.env.WS_ALLOWED_ORIGINS || "").split(/[\s,]+/).filter(Boolean);
  if (allowed.includes(origin)) return true;
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  try {
    return Boolean(host) && new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** คืน context เมื่อผ่าน หรือ Response ที่ใช้ปฏิเสธ upgrade */
export async function authorizeMeetingUpgrade(
  request: UpgradeRequest,
  path: string,
): Promise<WsMeetingContext | Response> {
  const ip = getClientIp(request.headers);
  const userAgent = request.headers.get("user-agent");
  const log = (statusCode: number, detail: Record<string, unknown>, userId?: number, username?: string) =>
    void writeSecurityLog({
      eventType: statusCode === 401 ? "access.unauthorized" : statusCode === 403 ? "access.forbidden" : "http.request",
      severity: statusCode >= 500 ? "error" : "warning",
      userId: userId ?? null,
      username: username ?? null,
      ip,
      userAgent,
      method: "GET",
      path,
      statusCode,
      detail,
    });

  if (!originAllowed(request)) {
    log(403, { reason: "origin_not_allowed", origin: request.headers.get("origin") });
    return rejectUpgrade(403, "origin not allowed");
  }

  const auth = await resolveSessionToken(readCookie(request.headers.get("cookie"), "session"), request);
  if (!auth.user) {
    if (auth.authFailReason === "no_token") log(401, { reason: "no_session" });
    return rejectUpgrade(401, "Unauthorized");
  }
  const userId = Number(auth.user.id);

  const meetingId = new URL(request.url).searchParams.get("meetingId") || "";
  if (!UUID_RE.test(meetingId)) return rejectUpgrade(400, "meetingId ไม่ถูกต้อง");
  const access = await authorizeMeeting(auth.user, meetingId, "view");
  if (!access.ok) {
    log(access.status, { reason: "meeting_access", meetingId }, userId, auth.user.username);
    return rejectUpgrade(access.status, access.error);
  }

  return {
    userId,
    username: auth.user.username,
    name: auth.user.name || auth.user.username,
    meetingId,
    ip,
    userAgent,
  };
}

/** ข้อมูลจราจรเมื่อปิด WebSocket: ใคร ดู/ถอดเสียงการประชุมไหน นานเท่าไร (ไม่บันทึกเนื้อหา) */
export function logWsSession(path: string, ctx: WsMeetingContext, startedAt: number, detail: Record<string, unknown> = {}): void {
  void writeSecurityLog({
    eventType: "http.request",
    severity: "info",
    userId: ctx.userId,
    username: ctx.username,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    method: "GET",
    path,
    statusCode: 101,
    durationMs: Date.now() - startedAt,
    detail: { meetingId: ctx.meetingId, ...detail },
  });
}
