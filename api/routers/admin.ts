import { Elysia, t } from "elysia";
import { db, ensureSchema } from "../db";
import { requireRole } from "./_lib";
import { writeAudit } from "../services/audit";
import { isAiConfigured, AI_MODEL, AI_BASE_URL } from "../services/ai/provider";
import {
  MIN_LOG_RETENTION_DAYS,
  verifyLogChain,
  writeSecurityLog,
} from "../services/logger";

/** Admin — audit logs, AI jobs, system settings, retention policies, security logs (พ.ร.บ. คอมพิวเตอร์) */
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
    async ({ params, body, user, set }) => {
      await ensureSchema();
      const policy = await db("retention_policies").where({ id: params.id }).first();
      if (!policy) {
        set.status = 404;
        return { error: "ไม่พบนโยบายที่ระบุ" };
      }
      // log ระบบต้องเก็บขั้นต่ำ 90 วันตาม พ.ร.บ. การกระทำความผิดเกี่ยวกับคอมพิวเตอร์ ม.26
      const isLogPolicy = policy.entity_type === "security_log" || policy.entity_type === "audit_log";
      if (isLogPolicy && body.retainDays < MIN_LOG_RETENTION_DAYS) {
        set.status = 400;
        return { error: `กฎหมาย (พ.ร.บ. คอมพิวเตอร์ ม.26) กำหนดให้เก็บ log อย่างน้อย ${MIN_LOG_RETENTION_DAYS} วัน` };
      }
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
  )

  // ---------- Security logs (log ตาม พ.ร.บ. การกระทำความผิดเกี่ยวกับคอมพิวเตอร์) ----------
  // เห็นได้เฉพาะ admin (secretary เข้าถึงส่วนอื่นของ /admin ได้ แต่ไม่ใช่ log ความปลอดภัย)

  .get(
    "/security-logs",
    async ({ query, user, set }) => {
      if (user!.role !== "admin") {
        set.status = 403;
        return { error: "สำหรับผู้ดูแลระบบเท่านั้น" };
      }
      await ensureSchema();
      const q = db("security_logs").orderBy("id", "desc").limit(Math.min(query.limit ?? 100, 1000)).offset(query.offset ?? 0);
      const countQ = db("security_logs").count("* as total");
      if (query.eventType) {
        q.where({ event_type: query.eventType });
        countQ.where({ event_type: query.eventType });
      }
      if (query.severity) {
        q.where({ severity: query.severity });
        countQ.where({ severity: query.severity });
      }
      if (query.username) {
        q.where("username", "ilike", `%${query.username}%`);
        countQ.where("username", "ilike", `%${query.username}%`);
      }
      if (query.ip) {
        q.where("ip", "ilike", `%${query.ip}%`);
        countQ.where("ip", "ilike", `%${query.ip}%`);
      }
      if (query.from) {
        q.where("created_at", ">=", query.from);
        countQ.where("created_at", ">=", query.from);
      }
      if (query.to) {
        q.where("created_at", "<=", query.to);
        countQ.where("created_at", "<=", query.to);
      }
      const [logs, totalRow] = await Promise.all([q, countQ.first()]);
      return { logs, total: Number(totalRow?.total ?? 0) };
    },
    {
      query: t.Object({
        eventType: t.Optional(t.String()),
        severity: t.Optional(t.String()),
        username: t.Optional(t.String()),
        ip: t.Optional(t.String()),
        from: t.Optional(t.String()),
        to: t.Optional(t.String()),
        limit: t.Optional(t.Number()),
        offset: t.Optional(t.Number()),
      }),
    },
  )

  // สรุปสถิติล่าสุด — ไว้ดูความผิดปกติ เช่น พยายาม login ผิดซ้ำจาก IP เดิม
  .get("/security-logs/stats", async ({ user, set }) => {
    if (user!.role !== "admin") {
      set.status = 403;
      return { error: "สำหรับผู้ดูแลระบบเท่านั้น" };
    }
    await ensureSchema();
    const since24h = new Date(Date.now() - 24 * 3600_000);
    const since7d = new Date(Date.now() - 7 * 24 * 3600_000);

    const [byType, failedByIp, failedByUsername] = await Promise.all([
      db("security_logs")
        .select("event_type")
        .count("* as count")
        .where("created_at", ">=", since24h)
        .groupBy("event_type"),
      db("security_logs")
        .select("ip")
        .count("* as count")
        .where({ event_type: "auth.login_failed" })
        .where("created_at", ">=", since7d)
        .whereNotNull("ip")
        .groupBy("ip")
        .orderBy("count", "desc")
        .limit(5),
      db("security_logs")
        .select("username")
        .count("* as count")
        .where({ event_type: "auth.login_failed" })
        .where("created_at", ">=", since7d)
        .whereNotNull("username")
        .groupBy("username")
        .orderBy("count", "desc")
        .limit(5),
    ]);
    return {
      byType: byType.map((r: any) => ({ eventType: r.event_type, count: Number(r.count) })),
      failedByIp: failedByIp.map((r: any) => ({ ip: r.ip, count: Number(r.count) })),
      failedByUsername: failedByUsername.map((r: any) => ({ username: r.username, count: Number(r.count) })),
    };
  })

  // ตรวจความถูกต้องของ hash chain — ยืนยันว่า log ไม่ถูกแก้ไข/ลบหลังบันทึก
  .get("/security-logs/verify", async ({ user, set }) => {
    if (user!.role !== "admin") {
      set.status = 403;
      return { error: "สำหรับผู้ดูแลระบบเท่านั้น" };
    }
    await ensureSchema();
    const result = await verifyLogChain();
    if (!result.valid) {
      await writeSecurityLog({
        eventType: "log.integrity_failed",
        severity: "error",
        userId: Number(user!.id),
        username: user!.username,
        detail: { total: result.total, reason: result.reason, brokenAtId: result.brokenAtId },
      });
    }
    return { verification: result, minRetentionDays: MIN_LOG_RETENTION_DAYS };
  })

  // ส่งออก log เป็น CSV — สำหรับมอบให้เจ้าหน้าที่ตามกฎหมายเมื่อมีหมาย/คำสั่ง
  .get(
    "/security-logs/export",
    async ({ query, user, set }) => {
      if (user!.role !== "admin") {
        set.status = 403;
        return { error: "สำหรับผู้ดูแลระบบเท่านั้น" };
      }
      await ensureSchema();
      const q = db("security_logs").orderBy("id", "asc").limit(Math.min(query.limit ?? 50000, 50000));
      if (query.eventType) q.where({ event_type: query.eventType });
      if (query.from) q.where("created_at", ">=", query.from);
      if (query.to) q.where("created_at", "<=", query.to);
      const rows = await q;

      const esc = (v: unknown): string => {
        const s = v === null || v === undefined ? "" : String(v);
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const header = "id,เวลา,เหตุการณ์,ระดับ,ผู้ใช้,IP,Method,Path,Status,Duration(ms),User-Agent,prev_hash,entry_hash";
      const lines = rows.map(
        (r: any) =>
          [
            r.id,
            r.created_at,
            r.event_type,
            r.severity,
            r.username,
            r.ip,
            r.method,
            r.path,
            r.status_code,
            r.duration_ms,
            r.user_agent,
            r.prev_hash,
            r.entry_hash,
          ]
            .map(esc)
            .join(","),
      );
      const csv = "\uFEFF" + [header, ...lines].join("\r\n");

      await writeSecurityLog({
        eventType: "log.exported",
        userId: Number(user!.id),
        username: user!.username,
        detail: { rows: rows.length, filters: { eventType: query.eventType ?? null, from: query.from ?? null, to: query.to ?? null } },
      });

      set.headers["content-type"] = "text/csv; charset=utf-8";
      set.headers["content-disposition"] = `attachment; filename="security-logs-${new Date().toISOString().slice(0, 10)}.csv"`;
      return csv;
    },
    {
      query: t.Object({
        eventType: t.Optional(t.String()),
        from: t.Optional(t.String()),
        to: t.Optional(t.String()),
        limit: t.Optional(t.Number()),
      }),
    },
  );
