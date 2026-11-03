import { Elysia, t } from "elysia";
import { encrypt, decrypt } from "paseto-ts/v4";
import {
  db,
  ensureSchema,
  hashPassword,
  verifyPassword,
  passwordNeedsRehash,
  validatePasswordPolicy,
  DUMMY_PASSWORD_HASH,
  PASSWORD_MAX_LENGTH,
  type DbUser,
} from "../db";
import { getClientIp, writeSecurityLog } from "../services/logger";
import { loginAttemptsByIp, loginFailuresByAccount, registerByIp } from "../services/ratelimit";
import { invalidateSessionUser } from "../middleware/auth";

/**
 * คีย์ที่เคยเผยแพร่ใน repository (.env.example) — ห้ามใช้งานจริง
 * ใครเห็น repo ก็สร้าง token ปลอม (เช่น role: admin) ได้
 */
const KNOWN_PUBLIC_KEYS = new Set(["k4.local.U2KsoeoNTdrNtVZ9ggrtI6mnfZUDFQFqftER3QsAb-I"]);

/** อายุ session (ชั่วโมง) — ใช้ทั้งกับ exp ของ token และ maxAge ของ cookie */
export const SESSION_TTL_HOURS = Math.min(
  Math.max(Number(process.env.SESSION_TTL_HOURS) || 8, 1),
  24 * 7,
);

/** cookie ส่งเฉพาะ HTTPS ใน production (ปิดได้ด้วย COOKIE_SECURE=false เมื่อทดสอบผ่าน http) */
function cookieSecure(): boolean {
  if (process.env.COOKIE_SECURE === "false") return false;
  if (process.env.COOKIE_SECURE === "true") return true;
  return process.env.NODE_ENV === "production";
}

let _PASETO_KEY: string | null = null;

export const getPasetoKey = (): string => {
  if (_PASETO_KEY) return _PASETO_KEY;

  const rawPasetoKey = process.env.PASETO_KEY;
  if (!rawPasetoKey) {
    throw new Error(
      "Missing PASETO_KEY. Please set PASETO_KEY in .env as a PASERK local key (k4.local. ...)",
    );
  }

  if (!rawPasetoKey.startsWith("k4.local.")) {
    throw new Error(
      "Invalid PASETO_KEY format. Expected PASERK local key starting with 'k4.local.'",
    );
  }

  // Basic sanity check for paserk payload length (32-byte key => 43 base64url chars)
  const keyData = rawPasetoKey.slice("k4.local.".length);
  if (keyData.length < 43) {
    throw new Error(
      "Invalid PASETO_KEY length. Expected a 32-byte local key in PASERK format: k4.local.<base64url-32-bytes>",
    );
  }

  if (KNOWN_PUBLIC_KEYS.has(rawPasetoKey)) {
    throw new Error(
      "PASETO_KEY is the public example key from .env.example. Generate a new one with `bun run gen:key`.",
    );
  }

  _PASETO_KEY = rawPasetoKey;
  return _PASETO_KEY;
};

// Backward-compatible export
export const PASETO_KEY: string = new Proxy({} as object, {
  get(_, prop) {
    const key = getPasetoKey();
    return (key as unknown as Record<string | symbol, unknown>)[prop as string];
  },
}) as unknown as string;

export { db, type DbUser as User };

export const authRoutes = new Elysia({ prefix: "/auth" })
  .post(
    "/register",
    async ({ body, set, request }) => {
      // ปิดการสมัครเองเป็นค่าเริ่มต้น — บัญชีผู้ใช้สร้างโดยผู้ดูแลระบบ
      if (process.env.ALLOW_SELF_REGISTER !== "true") {
        set.status = 404;
        return { error: "Not Found" };
      }
      const ip = getClientIp(request.headers);
      const ipKey = ip ?? "unknown";
      const wait = registerByIp.retryAfter(ipKey);
      if (wait > 0) {
        set.status = 429;
        set.headers["retry-after"] = String(wait);
        return { error: "สมัครบ่อยเกินไป กรุณาลองใหม่ภายหลัง" };
      }
      registerByIp.hit(ipKey);

      const username = body.username.trim();
      if (!/^[A-Za-z0-9._-]{3,50}$/.test(username)) {
        set.status = 400;
        return { error: "username ต้องเป็น a-z, 0-9, . _ - ยาว 3–50 ตัวอักษร" };
      }
      const policyError = validatePasswordPolicy(body.password, username);
      if (policyError) {
        set.status = 400;
        return { error: policyError };
      }
      await ensureSchema();
      const exists = await db<DbUser>("users").where({ username }).first();
      if (exists) {
        set.status = 400;
        return { error: "Username already exists" };
      }

      const inserted = await db<DbUser>("users")
        .insert({
          username,
          password: hashPassword(body.password),
          role: "user",
          name: username,
        })
        .returning(["id", "username", "role", "name"]);

      const newUser = inserted[0] || (await db<DbUser>("users").where({ username }).first());
      if (!newUser) throw new Error("user creation failed");

      void writeSecurityLog({
        eventType: "user.register",
        userId: newUser.id,
        username: newUser.username,
        ip,
        userAgent: request.headers.get("user-agent"),
        method: "POST",
        path: "/auth/register",
        statusCode: 200,
      });

      return {
        success: true,
        user: { id: newUser.id, username: newUser.username },
      };
    },
    {
      body: t.Object({
        username: t.String({ maxLength: 100 }),
        password: t.String({ maxLength: PASSWORD_MAX_LENGTH }),
      }),
    },
  )
  .post(
    "/login",
    async ({ body, cookie, set, request }) => {
    const session = cookie.session!;
      const ip = getClientIp(request.headers);
      const userAgent = request.headers.get("user-agent");
      const username = body.username.trim();

      // ป้องกันการเดารหัสผ่าน: จำกัดต่อ IP และต่อ username+IP
      const ipKey = ip ?? "unknown";
      const accountKey = `${username.toLowerCase()}|${ipKey}`;
      const wait = Math.max(
        ip ? loginAttemptsByIp.retryAfter(ipKey) : 0,
        loginFailuresByAccount.retryAfter(accountKey),
      );
      if (wait > 0) {
        void writeSecurityLog({
          eventType: "auth.login_blocked",
          severity: "warning",
          username,
          ip,
          userAgent,
          method: "POST",
          path: "/auth/login",
          statusCode: 429,
          detail: { reason: "rate_limited", retryAfterSec: wait },
        });
        set.status = 429;
        set.headers["retry-after"] = String(wait);
        return { error: `พยายามเข้าสู่ระบบบ่อยเกินไป กรุณาลองใหม่ในอีก ${Math.ceil(wait / 60)} นาที` };
      }
      if (ip) loginAttemptsByIp.hit(ipKey);

      await ensureSchema();
      const user = await db<DbUser>("users").where({ username }).first();
      // ไม่พบผู้ใช้ก็ยังรัน scrypt กับ hash หลอก ให้เวลาตอบสนองเท่ากัน (กัน user enumeration)
      const passwordOk = verifyPassword(body.password, user?.password ?? DUMMY_PASSWORD_HASH) && !!user;

      if (!user || !passwordOk) {
        loginFailuresByAccount.hit(accountKey);
        // login ไม่สำเร็จ — บันทึกไว้ตรวจการเดารหัสผ่าน (ตาม พ.ร.บ. คอมพิวเตอร์)
        void writeSecurityLog({
          eventType: "auth.login_failed",
          severity: "warning",
          username,
          ip,
          userAgent,
          method: "POST",
          path: "/auth/login",
          statusCode: 401,
          detail: { reason: user ? "invalid_password" : "unknown_username" },
        });
        set.status = 401;
        return { error: "Invalid credentials" };
      }

      if (user.is_active === false) {
        void writeSecurityLog({
          eventType: "auth.login_blocked",
          severity: "warning",
          userId: user.id,
          username: user.username,
          ip,
          userAgent,
          method: "POST",
          path: "/auth/login",
          statusCode: 401,
          detail: { reason: "account_disabled" },
        });
        set.status = 401;
        return { error: "บัญชีนี้ถูกปิดใช้งาน กรุณาติดต่อผู้ดูแลระบบ" };
      }

      loginFailuresByAccount.reset(accountKey);

      // รหัสผ่านเก่าที่เก็บเป็น plaintext → แปลงเป็น scrypt hash ทันที
      if (passwordNeedsRehash(user.password)) {
        await db<DbUser>("users")
          .where({ id: user.id })
          .update({ password: hashPassword(body.password), updated_at: db.fn.now() });
      }

      const key = getPasetoKey();
      const token = await encrypt(
        key,
        {
          userId: user.id.toString(),
          username: user.username,
          name: user.name || user.username,
          role: user.role,
          doctorcode: user.doctorcode || "",
          depcode: user.depcode || "",
          groupId: user.group_id || null,
          exp: `${SESSION_TTL_HOURS} hours`,
        },
        { addExp: false, addIat: true },
      );

      session.set({
        value: token,
        httpOnly: true,
        secure: cookieSecure(),
        sameSite: "lax",
        maxAge: SESSION_TTL_HOURS * 3600,
        path: "/",
      });
      invalidateSessionUser(user.id);

      void writeSecurityLog({
        eventType: "auth.login_success",
        userId: user.id,
        username: user.username,
        ip,
        userAgent,
        method: "POST",
        path: "/auth/login",
        statusCode: 200,
      });

      return {
        success: true,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          name: user.name || user.username,
          doctorcode: user.doctorcode,
          depcode: user.depcode,
        },
      };
    },
    {
      body: t.Object({
        username: t.String({ maxLength: 100 }),
        password: t.String({ maxLength: PASSWORD_MAX_LENGTH }),
      }),
    },
  )
  .post("/logout", async ({ cookie, request }) => {
    // ได้ตัวตนจาก session ก่อนลบ cookie (ถ้าอ่านได้) เพื่อบันทึกว่าใครออกจากระบบ
    let userId: number | null = null;
    let username: string | null = null;
    try {
      const { payload } = await decrypt<{ userId: string; username: string }>(
        getPasetoKey(),
        String(cookie.session?.value ?? ""),
      );
      userId = Number(payload.userId);
      username = payload.username;
    } catch {
      // session หมดอายุ/ไม่ถูกต้อง — ยังบันทึกการ logout โดยไม่ระบุตัวตน
    }
    cookie.session!.set({ value: "", httpOnly: true, secure: cookieSecure(), sameSite: "lax", maxAge: 0, path: "/" });
    await cookie.session!.remove();
    void writeSecurityLog({
      eventType: "auth.logout",
      userId,
      username,
      ip: getClientIp(request.headers),
      userAgent: request.headers.get("user-agent"),
      method: "POST",
      path: "/auth/logout",
      statusCode: 200,
    });
    return { success: true };
  })
  .get("/me", async ({ cookie, set, request }) => {
    const session = cookie.session!;
    if (!session.value) {
      set.status = 401;
      return { error: "Not authenticated" };
    }

    let userId: string;
    try {
      const key = getPasetoKey();
      const { payload } = await decrypt<{ userId: string }>(key, String(session.value));
      userId = payload.userId;
    } catch {
      void writeSecurityLog({
        eventType: "auth.invalid_token",
        severity: "warning",
        ip: getClientIp(request.headers),
        userAgent: request.headers.get("user-agent"),
        method: "GET",
        path: "/auth/me",
        statusCode: 401,
        detail: { reason: "session_invalid" },
      });
      set.status = 401;
      return { error: "Session invalid" };
    }

    await ensureSchema();
    const user = await db<DbUser>("users").where({ id: Number(userId) }).first();
    if (!user || user.is_active === false) {
      set.status = 401;
      return { error: "Session invalid" };
    }

    return {
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        name: user.name || user.username,
        doctorcode: user.doctorcode,
        depcode: user.depcode,
      },
    };
  });

export default authRoutes;
