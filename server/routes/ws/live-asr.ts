import { defineWebSocketHandler } from "h3";
import { resolveSessionToken } from "../../../api/middleware/auth";
import { authorizeMeeting } from "../../../api/services/access";
import { getClientIp, writeSecurityLog } from "../../../api/services/logger";
import {
  LiveAsrSession,
  isLiveAsrEnabled,
  liveAsrSlotsAvailable,
} from "../../../api/services/ai/live-asr";

/**
 * WebSocket ถอดเสียงสด: /ws/live-asr?meetingId=<uuid>
 *
 * อยู่นอก /api เพราะ nuxt-elysia รับทุก request ใต้ /api ไปให้ Elysia ซึ่งรับ WebSocket upgrade ไม่ได้
 * (Nitro เป็นเจ้าของ Bun.serve) — จึงตรวจ session/สิทธิ์เองด้วยฟังก์ชันเดียวกับ API
 *
 * protocol:
 *   client → server  binary = PCM16 LE 16kHz mono, text "end" = หยุดแล้วขอข้อความช่วงสุดท้าย
 *   server → client  JSON LiveEvent (ready | partial | final | done | error)
 */

const PATH = "/ws/live-asr";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PeerState {
  session: LiveAsrSession;
  userId: number;
  username: string;
  meetingId: string;
  ip: string | null;
  userAgent: string | null;
}
const peers = new Map<string, PeerState>();

function reject(status: number, message: string): Response {
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
function originAllowed(request: { headers: Headers }): boolean {
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

export default defineWebSocketHandler({
  async upgrade(request) {
    const ip = getClientIp(request.headers);
    const userAgent = request.headers.get("user-agent");
    const log = (statusCode: number, detail: Record<string, unknown>, userId?: number, username?: string) =>
      void writeSecurityLog({
        eventType: statusCode === 401 ? "access.unauthorized" : statusCode === 403 ? "access.forbidden" : "http.request",
        severity: statusCode >= 500 ? "error" : statusCode >= 400 ? "warning" : "info",
        userId: userId ?? null,
        username: username ?? null,
        ip,
        userAgent,
        method: "GET",
        path: PATH,
        statusCode,
        detail,
      });

    if (!originAllowed(request)) {
      log(403, { reason: "origin_not_allowed", origin: request.headers.get("origin") });
      return reject(403, "origin not allowed");
    }
    if (!isLiveAsrEnabled()) return reject(503, "ยังไม่ได้ตั้งค่า OPENTHAI_ASR_URL");

    const auth = await resolveSessionToken(readCookie(request.headers.get("cookie"), "session"), request);
    if (!auth.user) {
      if (auth.authFailReason === "no_token") log(401, { reason: "no_session" });
      return reject(401, "Unauthorized");
    }
    const userId = Number(auth.user.id);

    const meetingId = new URL(request.url).searchParams.get("meetingId") || "";
    if (!UUID_RE.test(meetingId)) return reject(400, "meetingId ไม่ถูกต้อง");
    const access = await authorizeMeeting(auth.user, meetingId, "view");
    if (!access.ok) {
      log(access.status, { reason: "meeting_access", meetingId }, userId, auth.user.username);
      return reject(access.status, access.error);
    }
    if (!liveAsrSlotsAvailable()) return reject(503, "การถอดเสียงสดเต็มจำนวนที่รองรับ — ลองใหม่ภายหลัง");

    Object.assign(request.context, {
      userId,
      username: auth.user.username,
      meetingId,
      ip,
      userAgent,
    });
  },

  open(peer) {
    const ctx = peer.context as Record<string, any>;
    const session = new LiveAsrSession({
      send: (message) => peer.send(message),
      close: (code, reason) => peer.close(code, reason),
    });
    peers.set(peer.id, {
      session,
      userId: ctx.userId,
      username: ctx.username,
      meetingId: ctx.meetingId,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });
    session.start();
  },

  message(peer, message) {
    const state = peers.get(peer.id);
    if (!state) return;
    if (typeof message.rawData === "string") {
      if (message.rawData.trim() === "end") state.session.end();
      return;
    }
    state.session.pushAudio(message.uint8Array());
  },

  close(peer) {
    const state = peers.get(peer.id);
    if (!state) return;
    peers.delete(peer.id);
    state.session.dispose();
    // ข้อมูลจราจร: ใคร ถอดเสียงสดการประชุมไหน นานเท่าไร (เนื้อหาเสียง/ข้อความไม่บันทึก)
    void writeSecurityLog({
      eventType: "http.request",
      severity: "info",
      userId: state.userId,
      username: state.username,
      ip: state.ip,
      userAgent: state.userAgent,
      method: "GET",
      path: PATH,
      statusCode: 101,
      durationMs: Date.now() - state.session.startedAt,
      detail: {
        meetingId: state.meetingId,
        audioSeconds: Math.round(state.session.audioSeconds),
        utterances: state.session.finals,
      },
    });
  },

  error(peer, error) {
    console.warn("[ASR] live websocket error:", error?.message || error);
    const state = peers.get(peer.id);
    state?.session.dispose();
  },
});
