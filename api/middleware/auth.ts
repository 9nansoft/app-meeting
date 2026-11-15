import { Elysia } from "elysia";
import { decrypt } from "paseto-ts/v4";
import { getPasetoKey } from "../routers/auth";
import { getClientIp, writeSecurityLog } from "../services/logger";
import { db } from "../db";
import { onEvent, publishEvent } from "../services/pubsub";

/**
 * สถานะผู้ใช้ปัจจุบันจาก DB (cache สั้น ๆ) — ให้การปิดบัญชี/ลดสิทธิ์มีผลทันที
 * ไม่ต้องรอ token หมดอายุ
 */
interface SessionUserState {
  active: boolean;
  role: string;
  username: string;
  name: string | null;
  expiresAt: number;
}
const SESSION_CACHE_MS = 30_000;
const sessionUserCache = new Map<number, SessionUserState>();

/**
 * ล้าง cache ของผู้ใช้ (เรียกเมื่อ admin แก้บทบาท/ปิดบัญชี/ลบผู้ใช้/รีเซ็ตรหัส)
 * รันหลาย instance: แจ้ง instance อื่นผ่าน Valkey ให้ล้างด้วย (Valkey ล่ม → instance อื่นหมดอายุเองใน 30 วินาที)
 */
export function invalidateSessionUser(userId: number | string): void {
  sessionUserCache.delete(Number(userId));
  publishEvent("session-invalidate", { userId: Number(userId) });
}

onEvent("session-invalidate", (data: { userId?: unknown }) => {
  if (typeof data?.userId === "number") sessionUserCache.delete(data.userId);
});

async function loadSessionUser(userId: number): Promise<SessionUserState | null> {
  const cached = sessionUserCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const row = await db("users")
    .where({ id: userId })
    .first("id", "username", "name", "role", "is_active");
  if (!row) {
    sessionUserCache.delete(userId);
    return null;
  }
  const state: SessionUserState = {
    active: row.is_active !== false,
    role: row.role,
    username: row.username,
    name: row.name ?? null,
    expiresAt: Date.now() + SESSION_CACHE_MS,
  };
  sessionUserCache.set(userId, state);
  return state;
}

/**
 * ตรวจ session token (PASETO) แล้วคืนผู้ใช้ปัจจุบันจาก DB
 * ใช้ทั้งใน authDerive ของ API และ WebSocket handler ที่อยู่นอก Elysia (server/routes/ws)
 */
/** request ที่ต้องใช้แค่ headers/url — WebSocket upgrade request (crossws) ไม่มี method */
type SessionRequest = { headers: Headers; url: string; method?: string };

export async function resolveSessionToken(token: string | undefined | null, request: SessionRequest) {
  if (!token) {
    return { user: null, authFailReason: "no_token" as const };
  }
  try {
    const key = getPasetoKey();
    const { payload } = await decrypt<{
      userId: string;
      username: string;
      name: string;
      doctorcode: string;
      groupId: any;
      depcode: any;
      role?: string;
    }>(key, token as string);

    // ตรวจกับ DB: บัญชีถูกลบ/ปิดใช้งาน → ปฏิเสธ, บทบาทใช้ค่าปัจจุบันจาก DB
    const current = await loadSessionUser(Number(payload.userId));
    if (!current || !current.active) {
      void writeSecurityLog({
        eventType: "auth.invalid_token",
        severity: "warning",
        userId: Number(payload.userId),
        username: payload.username,
        ip: getClientIp(request.headers),
        userAgent: request.headers.get("user-agent"),
        method: request.method ?? "GET",
        path: new URL(request.url).pathname,
        detail: { reason: current ? "account_disabled" : "account_deleted" },
      });
      return { user: null, authFailReason: "invalid_token" as const };
    }

    return {
      user: {
        id: payload.userId,
        username: current.username,
        name: current.name || payload.name,
        doctorcode: payload.doctorcode,
        groupId: payload.groupId,
        depcode: payload.depcode,
        role: current.role || "user",
      },
      authFailReason: null,
    };
  } catch (err) {
    // session/token ไม่ถูกต้อง — บันทึกตาม พ.ร.บ. คอมพิวเตอร์ (ใช้ token ไม่ได้ อาจเป็นการปลอม)
    void writeSecurityLog({
      eventType: "auth.invalid_token",
      severity: "warning",
      ip: getClientIp(request.headers),
      userAgent: request.headers.get("user-agent"),
      method: request.method ?? "GET",
      path: new URL(request.url).pathname,
      detail: { reason: err instanceof Error ? err.message : "token_expired_or_invalid" },
    });
    return { user: null, authFailReason: "invalid_token" as const };
  }
}

export const authDerive = (app: Elysia) =>
  app
    .derive(async ({ cookie: { session }, headers, request }) => {
      let token = session?.value as string | undefined;

      if (!token && headers.authorization?.startsWith("Bearer ")) {
        token = headers.authorization.slice(7);
      }

      return resolveSessionToken(token, request);
    })
    .onBeforeHandle(({ user, authFailReason, set, request }) => {
      if (!user) {
        // เรียก API ที่ต้อง login โดยไม่มี session เลย
        // (กรณี token ไม่ถูกต้อง log เป็น auth.invalid_token ไปแล้วใน derive)
        if (authFailReason === "no_token") {
          void writeSecurityLog({
            eventType: "access.unauthorized",
            severity: "warning",
            ip: getClientIp(request.headers),
            userAgent: request.headers.get("user-agent"),
            method: request.method,
            path: new URL(request.url).pathname,
            statusCode: 401,
          });
        }
        set.status = 401;
        return { error: "Unauthorized" };
      }
    });
