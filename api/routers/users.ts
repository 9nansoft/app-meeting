import { Elysia, t } from "elysia";
import { authDerive } from "../middleware/auth";
import { db, ensureSchema, hashPassword, type DbUser } from "../db";

export const usersRoutes = new Elysia().group("/users", (app) =>
  app
    .use(authDerive)
    // List (สำหรับเลือกผู้เข้าร่วม/ผู้นำเสนอ)
    .get("/", async () => {
      await ensureSchema();
      const users = await db<DbUser>("users")
        .select("id", "username", "role", "name", "doctorcode", "depcode", "position", "is_active")
        .orderBy("id", "asc");

      return users.map((u) => ({
        id: u.id,
        username: u.username,
        role: u.role,
        name: (u as any).name || u.username,
        position: (u as any).position || null,
        isActive: (u as any).is_active ?? true,
      }));
    })
    // Create
    .post(
      "/",
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
            password: hashPassword("default_password"),
            role: body.role,
            name: body.username,
          })
          .returning(["id", "username", "role"]);

        const newUser = inserted[0] || (await db<DbUser>("users").where({ username: body.username }).first());
        if (!newUser) throw new Error("user creation failed");

        return {
          success: true,
          user: {
            id: newUser.id,
            username: newUser.username,
            role: newUser.role,
          },
        };
      },
      {
        body: t.Object({
          username: t.String(),
          role: t.String(),
        }),
      },
    )
    // Update
    .put(
      "/:id",
      async ({ params, body, set }) => {
        await ensureSchema();
        const user = await db<DbUser>("users").where({ id: Number(params.id) }).first();
        if (!user) {
          set.status = 404;
          return { error: "User not found" };
        }

        // Prevent editing admin username for demo stability
        if (user.username === "admin" && body.username !== "admin") {
          set.status = 403;
          return { error: "Cannot rename the admin user" };
        }

        // Check if username is being changed to an already existing username
        if (body.username !== user.username) {
          const existing = await db<DbUser>("users")
            .where({ username: body.username })
            .whereNot({ id: Number(params.id) })
            .first();

          if (existing) {
            set.status = 400;
            return { error: "Username already exists" };
          }
        }

        const updated = await db<DbUser>("users")
          .where({ id: Number(params.id) })
          .update({
            username: body.username,
            role: body.role,
            updated_at: db.fn.now(),
          })
          .returning(["id", "username", "role"]);

        const updatedUser = updated[0] || (await db<DbUser>("users").where({ id: Number(params.id) }).first());
        if (!updatedUser) throw new Error("user update failed");

        return {
          success: true,
          user: {
            id: updatedUser.id,
            username: updatedUser.username,
            role: updatedUser.role,
          },
        };
      },
      {
        params: t.Object({ id: t.String() }),
        body: t.Object({ username: t.String(), role: t.String() }),
      },
    )
    // Delete
    .delete(
      "/:id",
      async ({ params, set }) => {
        await ensureSchema();
        const user = await db<DbUser>("users").where({ id: Number(params.id) }).first();
        if (!user) {
          set.status = 404;
          return { error: "User not found" };
        }

        if (user.username === "admin") {
          set.status = 403;
          return { error: "Cannot delete the admin user" };
        }

        await db<DbUser>("users").where({ id: Number(params.id) }).del();
        return { success: true, id: user.id };
      },
      {
        params: t.Object({ id: t.String() }),
      },
    ),
);