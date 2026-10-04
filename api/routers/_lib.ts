import { Elysia, t, type AnyElysia } from "elysia";
import { authDerive } from "../middleware/auth";
import { getClientIp, writeSecurityLog } from "../services/logger";

/** ประเภท user ที่ได้จาก PASETO session */
export interface AuthUser {
  id: string;
  username: string;
  name: string;
  role: string;
}

/** guard: ต้อง login และมีบทบาทที่อนุญาตอย่างใดอย่างหนึ่ง (admin ผ่านเสมอ) */
export const requireRole =
  (...roles: string[]) =>
  (app: AnyElysia) =>
    app.use(authDerive).onBeforeHandle(({ user, set, request }) => {
      if (roles.length && user && !roles.includes(user.role) && user.role !== "admin") {
        // พยายามใช้สิทธิ์ที่ตัวเองไม่มี — บันทึกไว้ตรวจสอบการเจาะระบบตาม พ.ร.บ. คอมพิวเตอร์
        void writeSecurityLog({
          eventType: "access.forbidden",
          severity: "warning",
          userId: Number(user.id),
          username: user.username,
          ip: getClientIp(request.headers),
          userAgent: request.headers.get("user-agent"),
          method: request.method,
          path: new URL(request.url).pathname,
          statusCode: 403,
          detail: { requiredRoles: roles, actualRole: user.role },
        });
        set.status = 403;
        return { error: `ต้องมีบทบาท: ${roles.join(" หรือ ")} (บทบาทปัจจุบัน: ${user.role})` };
      }
    });

/** guard: ต้อง login เท่านั้น */
export const requireAuth = () => requireRole();

/** อ่าน JSON column ที่ knex (pg) คืนมาเป็น string */
export function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  try {
    return typeof value === "string" ? (JSON.parse(value) as T) : (value as T);
  } catch {
    return fallback;
  }
}

/** อ่านไฟล์จาก request body — รองรับ multipart (File) และ binary body (Blob/ArrayBuffer) */
export async function readUploadBody(
  body: unknown,
): Promise<{ buffer: Buffer; fileName: string; mimeType: string } | null> {
  const fromFile = async (f: File): Promise<{
    buffer: Buffer;
    fileName: string;
    mimeType: string;
  }> => ({
    buffer: Buffer.from(await f.arrayBuffer()),
    fileName: f.name || "upload.bin",
    mimeType: f.type || "application/octet-stream",
  });

  if (typeof File !== "undefined" && body instanceof File) return fromFile(body);
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return {
      buffer: Buffer.from(await body.arrayBuffer()),
      fileName: "upload.bin",
      mimeType: body.type || "application/octet-stream",
    };
  }
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return {
      buffer: Buffer.from(body as ArrayBuffer),
      fileName: "upload.bin",
      mimeType: "application/octet-stream",
    };
  }
  if (body && typeof body === "object") {
    const anyBody = body as Record<string, unknown>;
    const file = anyBody.file ?? anyBody.data;
    if (file && typeof (file as File).arrayBuffer === "function") {
      const result = await fromFile(file as File);
      if (typeof anyBody.fileName === "string") result.fileName = anyBody.fileName;
      return result;
    }
  }
  return null;
}

export const uuidParam = t.Object({ id: t.String() });

/** ตรวจว่าเป็น admin หรือเจ้าของทรัพยากร */
export function isAdminOr(user: AuthUser | null, userId: number | null | undefined): boolean {
  if (!user) return false;
  if (user.role === "admin") return true;
  return Number(user.id) === Number(userId);
}
