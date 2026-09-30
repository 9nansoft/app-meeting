import { Elysia, t } from "elysia";
import { encrypt, decrypt } from "paseto-ts/v4";
import { db, ensureSchema, hashPassword, verifyPassword, type DbUser } from "../db";

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
    async ({ body, set }) => {
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
    async ({ body, cookie, set }) => {
    const session = cookie.session!;
      await ensureSchema();
      const user = await db<DbUser>("users").where({ username: body.username }).first();

      if (!user || !verifyPassword(body.password, user.password)) {
        set.status = 401;
        return { error: "Invalid credentials" };
      }

      if (user.is_active === false) {
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
  .post("/logout", async ({ cookie }) => {
    await cookie.session!.remove();
    return { success: true };
  })
  .get("/me", async ({ cookie, set }) => {
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
