import { Elysia, t } from "elysia";
import { db, ensureSchema } from "../db";
import { requireRole } from "./_lib";

export const notificationsRoutes = new Elysia({ prefix: "/notifications" })
  .use(requireRole())
  // รายการแจ้งเตือนของฉัน
  .get(
    "/",
    async ({ user, query }) => {
      await ensureSchema();
      const q = db("notifications")
        .where({ user_id: Number(user!.id) })
        .orderBy("created_at", "desc")
        .limit(query.limit ?? 50);
      if (query.unreadOnly === "true") q.where({ status: "unread" });
      const notifications = await q;
      const [{ count } = { count: 0 }] = await db("notifications")
        .where({ user_id: Number(user!.id), status: "unread" })
        .count("id as count");
      return { notifications, unreadCount: Number(count) };
    },
    {
      query: t.Object({
        unreadOnly: t.Optional(t.String()),
        limit: t.Optional(t.Number()),
      }),
    },
  )

  // ทำเครื่องหมายว่าอ่านแล้ว (รายการเดียวหรือทั้งหมด)
  .post(
    "/read",
    async ({ body, user }) => {
      await ensureSchema();
      if (body.all) {
        await db("notifications")
          .where({ user_id: Number(user!.id), status: "unread" })
          .update({ status: "read", read_at: db.fn.now() });
      } else if (body.id) {
        await db("notifications")
          .where({ id: body.id, user_id: Number(user!.id) })
          .update({ status: "read", read_at: db.fn.now() });
      }
      return { success: true };
    },
    {
      body: t.Object({
        id: t.Optional(t.String()),
        all: t.Optional(t.Boolean()),
      }),
    },
  );
