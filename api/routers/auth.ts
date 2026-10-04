import { Elysia, t } from "elysia";
import { encrypt, decrypt } from "paseto-ts/v4";
import { db, ensureSchema, hashPassword, verifyPassword, type DbUser } from "../db";
import { getClientIp, writeSecurityLog } from "../services/logger";

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
      await ensureSchema();
      const exists = await db<DbUser>("users").where({ username: body.username }).first();
      if (exists) {
        set.status = 400;
        return { error: "Username already exists" };
      }

      const inserted = await db<DbUser>("users")
        .insert({
          username: body.username,
          password: hashPassword(body.password),
          role: "user",
          name: body.username,
        })
        .returning(["id", "username", "role", "name"]);

      const newUser = inserted[0] || (await db<DbUser>("users").where({ username: body.username }).first());
      if (!newUser) throw new Error("user creation failed");

      void writeSecurityLog({
        eventType: "user.register",
        userId: newUser.id,
        username: newUser.username,
        ip: getClientIp(request.headers),
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
        username: t.String(),
        password: t.String(),
      }),
    },
  )
  .post(
    "/login",
    async ({ body, cookie, set, request }) => {
    const session = cookie.session!;
      const ip = getClientIp(request.headers);
      const userAgent = request.headers.get("user-agent");
      await ensureSchema();
      const user = await db<DbUser>("users").where({ username: body.username }).first();

      if (!user || !verifyPassword(body.password, user.password)) {
        // login ไม่สำเร็จ — บันทึกไว้ตรวจการเดารหัสผ่าน (ตาม พ.ร.บ. คอมพิวเตอร์)
        void writeSecurityLog({
          eventType: "auth.login_failed",
          severity: "warning",
          username: body.username,
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
        },
        { addExp: true, addIat: true },
      );

      session.set({
        value: token,
        httpOnly: true,
        maxAge: 7 * 86400,
        path: "/",
      });

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
        username: t.String(),
        password: t.String(),
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
