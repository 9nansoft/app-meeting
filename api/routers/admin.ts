import { Elysia, t } from "elysia";
import { db, ensureSchema } from "../db";
import { requireRole } from "./_lib";
import { writeAudit } from "../services/audit";
import { isAiConfigured, AI_MODEL, AI_BASE_URL } from "../services/ai/provider";

/** Admin — audit logs, AI jobs, system settings, retention policies */
export const adminRoutes = new Elysia({ prefix: "/admin" })
  .use(requireRole("admin", "secretary"))
  .get("/status", async () => {
    await ensureSchema();
    return {
      ai: {
        configured: isAiConfigured(),
        baseUrl: AI_BASE_URL,
        model: AI_MODEL,
        worker: process.env.AI_WORKER !== "off",
      },
    };
  })

  // Audit logs
  .get(
    "/audit-logs",
    async ({ query }) => {
      await ensureSchema();
      const q = db("audit_logs").orderBy("created_at", "desc").limit(query.limit ?? 100);
      if (query.entityType) q.where({ entity_type: query.entityType });
      if (query.entityId) q.where({ entity_id: query.entityId });
      if (query.action) q.where("action", "ilike", `%${query.action}%`);
      return { logs: await q };
    },
    {
      query: t.Object({
        entityType: t.Optional(t.String()),
        entityId: t.Optional(t.String()),
        action: t.Optional(t.String()),
        limit: t.Optional(t.Number()),
      }),
    },
  )

  // AI jobs ทั้งหมด
  .get(
    "/ai-jobs",
    async ({ query }) => {
      await ensureSchema();
      const q = db("ai_jobs").orderBy("created_at", "desc").limit(query.limit ?? 100);
      if (query.status) q.where({ status: query.status });
      if (query.jobType) q.where({ job_type: query.jobType });
      return { jobs: await q };
    },
    {
      query: t.Object({
        status: t.Optional(t.String()),
        jobType: t.Optional(t.String()),
        limit: t.Optional(t.Number()),
      }),
    },
  )

  // System settings
  .get("/settings", async () => {
    await ensureSchema();
    return { settings: await db("system_settings").orderBy("key") };
  })

  .put(
    "/settings/:key",
    async ({ params, body, user }) => {
      await ensureSchema();
      let value: unknown;
      try {
        value = typeof body.value === "string" ? JSON.parse(body.value) : body.value;
      } catch {
        value = body.value;
      }
      const existing = await db("system_settings").where({ key: params.key }).first();
      if (existing) {
        await db("system_settings")
          .where({ key: params.key })
          .update({ value: JSON.stringify(value), updated_by: Number(user!.id), updated_at: db.fn.now() });
      } else {
        await db("system_settings").insert({
          key: params.key,
          value: JSON.stringify(value),
          updated_by: Number(user!.id),
        });
      }
      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "settings.update",
        entityType: "system_settings",
        entityId: params.key,
        newValue: value,
      });
      return { success: true };
    },
    {
      params: t.Object({ key: t.String() }),
      body: t.Object({ value: t.Any() }),
    },
  )

  // Retention policies
  .get("/retention", async () => {
    await ensureSchema();
    return { policies: await db("retention_policies").orderBy("entity_type") };
  })

  .put(
    "/retention/:id",
    async ({ params, body, user }) => {
      await ensureSchema();
      await db("retention_policies")
        .where({ id: params.id })
        .update({
          retain_days: body.retainDays,
          action: body.action,
          is_active: body.isActive ?? true,
          updated_at: db.fn.now(),
        });
      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "retention.update",
        entityType: "retention_policies",
        entityId: params.id,
        newValue: body,
      });
      return { success: true };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        retainDays: t.Number({ minimum: 1 }),
        action: t.Union([t.Literal("delete"), t.Literal("archive")]),
        isActive: t.Optional(t.Boolean()),
      }),
    },
  );
