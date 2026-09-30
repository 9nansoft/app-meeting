import { Elysia, t } from "elysia";
import { requireRole } from "./_lib";
import { writeAudit } from "../services/audit";
import { db, ensureSchema, hashPassword, type DbUser } from "../db";

/** บทบาทที่แอดมินกำหนดให้ผู้ใช้ได้ */
const ASSIGNABLE_ROLES: readonly string[] = ["admin", "secretary", "member", "staff"];

const USER_COLUMNS = ["id", "username", "role", "name", "doctorcode", "depcode", "position", "is_active"] as const;

function toPublicUser(u: Partial<DbUser> & { id: number; username: string; role: string }) {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    name: u.name || u.username,
    position: u.position || null,
    isActive: u.is_active ?? true,
  };
}

/** รายการผู้ใช้ — ใช้เลือกผู้เข้าร่วม/ผู้นำเสนอ/ผู้รับผิดชอบห้อง (login เท่านั้น) */
export const usersRoutes = new Elysia({ prefix: "/users" })
  .use(requireRole())
  .get("/", async () => {
    await ensureSchema();
    const users = await db<DbUser>("users")
      .select(...USER_COLUMNS)
      .orderBy("id", "asc");
    return users.map(toPublicUser);
  });

/** จัดการบัญชีผู้ใช้ — แอดมินเท่านั้น */
export const usersAdminRoutes = new Elysia({ prefix: "/users" })
  .use(requireRole("admin"))
  // สร้างบัญชีผู้ใช้ (กำหนดบทบาท + รหัสผ่านเริ่มต้น)
  .post(
    "/",
    async ({ body, user, set }) => {
      await ensureSchema();
      if (!ASSIGNABLE_ROLES.includes(body.role)) {
        set.status = 400;
        return { error: `บทบาทไม่ถูกต้อง — เลือกได้: ${ASSIGNABLE_ROLES.join(", ")}` };
      }
      const username = body.username.trim();
      if (!username) {
        set.status = 400;
        return { error: "กรุณาระบุ username" };
      }
      const exists = await db<DbUser>("users").where({ username }).first();
      if (exists) {
        set.status = 400;
        return { error: "มี username นี้ในระบบแล้ว" };
      }
      const password = body.password?.trim() || "password";
      const [created] = await db<DbUser>("users")
        .insert({
          username,
          password: hashPassword(password),
          role: body.role,
          name: body.name?.trim() || username,
          position: body.position?.trim() || null,
        })
        .returning([...USER_COLUMNS]);
      const newUser = created || (await db<DbUser>("users").where({ username }).first());
      if (!newUser) throw new Error("user creation failed");
      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "user.create",
        entityType: "users",
        entityId: String(newUser.id),
        newValue: toPublicUser(newUser),
      });
      return { success: true, user: toPublicUser(newUser) };
    },
    {
      body: t.Object({
        username: t.String(),
        role: t.String(),
        name: t.Optional(t.String()),
        position: t.Optional(t.String()),
        password: t.Optional(t.String()),
      }),
    },
  )
  // แก้ไขข้อมูล/บทบาท/สถานะของผู้ใช้
  .put(
    "/:id",
    async ({ params, body, user, set }) => {
      await ensureSchema();
      const target = await db<DbUser>("users").where({ id: Number(params.id) }).first();
      if (!target) {
        set.status = 404;
        return { error: "ไม่พบผู้ใช้" };
      }
      if (body.role && !ASSIGNABLE_ROLES.includes(body.role)) {
        set.status = 400;
        return { error: `บทบาทไม่ถูกต้อง — เลือกได้: ${ASSIGNABLE_ROLES.join(", ")}` };
      }
      const locksSelfOut = (body.role && body.role !== "admin") || body.isActive === false;
      if (target.username === "admin" && locksSelfOut) {
        set.status = 403;
        return { error: "ไม่สามารถลดสิทธิ์หรือปิดใช้งานบัญชี admin หลักได้" };
      }
      if (Number(user!.id) === target.id && locksSelfOut) {
        set.status = 403;
        return { error: "ไม่สามารถลดสิทธิ์หรือปิดใช้งานบัญชีของตัวเองได้" };
      }
      const [updated] = await db<DbUser>("users")
        .where({ id: target.id })
        .update({
          ...(body.name !== undefined ? { name: body.name.trim() || target.username } : {}),
          ...(body.position !== undefined ? { position: body.position.trim() || null } : {}),
          ...(body.role !== undefined ? { role: body.role } : {}),
          ...(body.isActive !== undefined ? { is_active: body.isActive } : {}),
          updated_at: db.fn.now(),
        })
        .returning([...USER_COLUMNS]);
      const updatedUser = updated || (await db<DbUser>("users").where({ id: target.id }).first());
      if (!updatedUser) throw new Error("user update failed");
      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "user.update",
        entityType: "users",
        entityId: String(target.id),
        oldValue: toPublicUser(target),
        newValue: toPublicUser(updatedUser),
      });
      return { success: true, user: toPublicUser(updatedUser) };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        name: t.Optional(t.String()),
        position: t.Optional(t.String()),
        role: t.Optional(t.String()),
        isActive: t.Optional(t.Boolean()),
      }),
    },
  )
  // ตั้งรหัสผ่านใหม่
  .post(
    "/:id/reset-password",
    async ({ params, body, user, set }) => {
      await ensureSchema();
      const target = await db<DbUser>("users").where({ id: Number(params.id) }).first();
      if (!target) {
        set.status = 404;
        return { error: "ไม่พบผู้ใช้" };
      }
      const newPassword = (body.password || "").trim();
      if (newPassword.length < 6) {
        set.status = 400;
        return { error: "รหัสผ่านต้องมีความยาวอย่างน้อย 6 ตัวอักษร" };
      }
      await db<DbUser>("users")
        .where({ id: target.id })
        .update({ password: hashPassword(newPassword), updated_at: db.fn.now() });
      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "user.reset_password",
        entityType: "users",
        entityId: String(target.id),
      });
      return { success: true };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({ password: t.String() }),
    },
  )
  // ลบบัญชีผู้ใช้
  .delete(
    "/:id",
    async ({ params, user, set }) => {
      await ensureSchema();
      const target = await db<DbUser>("users").where({ id: Number(params.id) }).first();
      if (!target) {
        set.status = 404;
        return { error: "ไม่พบผู้ใช้" };
      }
      if (target.username === "admin") {
        set.status = 403;
        return { error: "ไม่สามารถลบบัญชี admin หลักได้" };
      }
      if (Number(user!.id) === target.id) {
        set.status = 403;
        return { error: "ไม่สามารถลบบัญชีของตัวเองได้" };
      }
      await db<DbUser>("users").where({ id: target.id }).del();
      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "user.delete",
        entityType: "users",
        entityId: String(target.id),
        oldValue: toPublicUser(target),
      });
      return { success: true, id: target.id };
    },
    {
      params: t.Object({ id: t.String() }),
    },
  );
