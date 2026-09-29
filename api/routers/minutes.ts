import { Elysia, t } from "elysia";
import { db, ensureSchema } from "../db";
import { requireRole } from "./_lib";
import { writeAudit } from "../services/audit";
import { notify, notifyMeetingParticipants } from "../services/notifications";
import { enqueueJob } from "../services/jobs";

export const minutesRoutes = new Elysia({ prefix: "/meetings" })
  .use(requireRole())
  /* ---------- รายงานการประชุม (minutes) ---------- */

  // ดูรายงานฉบับล่าสุดของการประชุม (พร้อมมติ งาน การเข้าร่วม สถานะอนุมัติ)
  .get(
    "/:id/minutes",
    async ({ params, set }) => {
      await ensureSchema();
      const minutes = await db("meeting_minutes")
        .where({ meeting_id: params.id })
        .orderBy("version", "desc")
        .first();
      const decisions = await db("meeting_decisions")
        .where({ meeting_id: params.id })
        .orderBy("sequence_no");
      const actionItems = await db("meeting_action_items")
        .where({ meeting_id: params.id })
        .orderBy("created_at");
      const attendance = await db("meeting_attendance")
        .where({ meeting_id: params.id })
        .orderBy("created_at");
      const approvals = await db("meeting_approvals")
        .where({ meeting_id: params.id })
        .orderBy("step_sequence");
      const jobs = await db("ai_jobs")
        .where({ meeting_id: params.id, job_type: "generate_minutes" })
        .orderBy("created_at", "desc")
        .limit(1)
        .select("id", "status", "error", "created_at", "completed_at");
      return {
        minutes: minutes || null,
        decisions,
        actionItems,
        attendance,
        approvals,
        latestJob: jobs[0] || null,
      };
    },
    { params: t.Object({ id: t.String() }) },
  )

  // สั่ง AI สร้างร่างรายงานการประชุม (+สกัดมติ/งาน ให้ตรวจสอบ)
  .post(
    "/:id/minutes/generate",
    async ({ params, user, set }) => {
      await ensureSchema();
      const meeting = await db("meetings").where({ id: params.id }).first();
      if (!meeting) {
        set.status = 404;
        return { error: "ไม่พบการประชุม" };
      }
      const existing = await db("meeting_minutes")
        .where({ meeting_id: params.id, status: "published" })
        .first();
      if (existing) {
        set.status = 409;
        return { error: "รายงานฉบับนี้เผยแพร่แล้ว ไม่สามารถสร้างร่างใหม่ได้" };
      }
      const jobId = await enqueueJob({
        jobType: "generate_minutes",
        payload: { meetingId: params.id, createdBy: Number(user!.id) },
        meetingId: params.id,
        createdBy: Number(user!.id),
      });
      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "minutes.generate",
        entityType: "meetings",
        entityId: params.id,
      });
      set.status = 202;
      return { jobId };
    },
    { params: t.Object({ id: t.String() }) },
  )

  // แก้ไขเนื้อหารายงาน (เลขานุการ)
  .put(
    "/:id/minutes",
    async ({ params, body, user, set }) => {
      await ensureSchema();
      const minutes = await db("meeting_minutes")
        .where({ meeting_id: params.id })
        .orderBy("version", "desc")
        .first();
      if (!minutes) {
        set.status = 404;
        return { error: "ยังไม่มีรายงานการประชุม — สั่งสร้างร่างจาก AI ก่อน" };
      }
      if (minutes.status === "published") {
        set.status = 409;
        return { error: "รายงานเผยแพร่แล้ว แก้ไขไม่ได้" };
      }
      await db("meeting_minutes")
        .where({ id: minutes.id })
        .update({
          content: JSON.stringify(body.content),
          status: minutes.status === "pending_review" && body.markReviewed ? "draft" : minutes.status,
          generated_by_ai: false,
          updated_at: db.fn.now(),
        });
      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "minutes.update",
        entityType: "meeting_minutes",
        entityId: minutes.id,
        newValue: body.content,
      });
      return { minutes: await db("meeting_minutes").where({ id: minutes.id }).first() };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({ content: t.Any(), markReviewed: t.Optional(t.Boolean()) }),
    },
  )

  // ขออนุมัติรายงาน (เลขา → ประธาน/admin)
  .post(
    "/:id/minutes/request-approval",
    async ({ params, user, set }) => {
      await ensureSchema();
      const minutes = await db("meeting_minutes")
        .where({ meeting_id: params.id })
        .orderBy("version", "desc")
        .first();
      if (!minutes) {
        set.status = 404;
        return { error: "ยังไม่มีรายงานการประชุม" };
      }
      if (minutes.status === "published") {
        set.status = 409;
        return { error: "รายงานเผยแพร่แล้ว" };
      }
      await db("meeting_minutes").where({ id: minutes.id }).update({ status: "pending_review" });
      const existing = await db("meeting_approvals")
        .where({ meeting_id: params.id, status: "pending" })
        .first();
      if (!existing) {
        await db("meeting_approvals").insert({
          meeting_id: params.id,
          minutes_id: minutes.id,
          step_sequence: 1,
          role_required: "chair",
          status: "pending",
        });
      }
      const meeting = await db("meetings").where({ id: params.id }).first();
      await notifyMeetingParticipants(
        params.id,
        {
          type: "minutes_approval",
          title: `รายงานการประชุม "${meeting.title}" รอการอนุมัติ`,
          body: "รายงานพร้อมให้ประธาน/ผู้จัดประชุมตรวจสอบและอนุมัติ",
          link: `/meetings/${params.id}/minutes`,
          meetingId: params.id,
        },
        Number(user!.id),
      );
      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "minutes.request_approval",
        entityType: "meeting_minutes",
        entityId: minutes.id,
      });
      return { success: true };
    },
    { params: t.Object({ id: t.String() }) },
  )

  // อนุมัติ/ไม่อนุมัติ และเผยแพร่
  .post(
    "/:id/minutes/approve",
    async ({ params, body, user, set }) => {
      await ensureSchema();
      const meeting = await db("meetings").where({ id: params.id }).first();
      if (!meeting) {
        set.status = 404;
        return { error: "ไม่พบการประชุม" };
      }
      const isChair =
        meeting.organizer_id === Number(user!.id) || user!.role === "admin";
      if (!isChair) {
        set.status = 403;
        return { error: "อนุมัติได้เฉพาะประธานการประชุม (ผู้จัดประชุม) หรือ admin" };
      }
      const minutes = await db("meeting_minutes")
        .where({ meeting_id: params.id })
        .orderBy("version", "desc")
        .first();
      if (!minutes) {
        set.status = 404;
        return { error: "ยังไม่มีรายงานการประชุม" };
      }

      await db("meeting_approvals")
        .where({ meeting_id: params.id, status: "pending" })
        .update({
          approver_id: Number(user!.id),
          status: body.approved ? "approved" : "changes_requested",
          comment: body.comment || null,
          acted_at: db.fn.now(),
        });

      if (body.approved) {
        await db("meeting_minutes").where({ id: minutes.id }).update({
          status: "published",
          approved_by: Number(user!.id),
          approved_at: db.fn.now(),
          published_at: db.fn.now(),
        });
        await db("meetings").where({ id: params.id }).update({
          status: "completed",
          updated_at: db.fn.now(),
        });
        // แจ้งเตือนผู้รับผิดชอบงานที่มอบหมาย
        const items = await db("meeting_action_items").where({ meeting_id: params.id });
        const assignees = items.map((i) => i.assignee_id).filter(Boolean) as number[];
        if (assignees.length) {
          await notify({
            userIds: assignees,
            type: "action_assigned",
            title: `มีงานมอบหมายจากการประชุม "${meeting.title}"`,
            body: `จำนวน ${items.filter((i) => assignees.includes(i.assignee_id)).length} รายการ — ดูรายละเอียดในระบบ`,
            link: `/followup`,
            meetingId: params.id,
          });
        }
        await notifyMeetingParticipants(params.id, {
          type: "info",
          title: `รายงานการประชุม "${meeting.title}" เผยแพร่แล้ว`,
          link: `/meetings/${params.id}/minutes`,
          meetingId: params.id,
        }, Number(user!.id));
      } else {
        await db("meeting_minutes").where({ id: minutes.id }).update({ status: "draft" });
      }

      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: body.approved ? "minutes.publish" : "minutes.changes_requested",
        entityType: "meeting_minutes",
        entityId: minutes.id,
        newValue: { comment: body.comment },
      });
      return { success: true, published: body.approved };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({ approved: t.Boolean(), comment: t.Optional(t.String()) }),
    },
  )

  /* ---------- มติที่ประชุม (decisions) ---------- */

  // เพิ่มมติ (เลขาบันทึกระหว่างประชุม / AI สกัดก็ผ่านทาง job เท่านั้น)
  .post(
    "/:id/decisions",
    async ({ params, body, user, set }) => {
      await ensureSchema();
      const [maxRow] = await db("meeting_decisions")
        .where({ meeting_id: params.id })
        .max("sequence_no as max");
      const [decision] = await db("meeting_decisions")
        .insert({
          meeting_id: params.id,
          agenda_id: body.agendaId || null,
          source_segment_id: body.sourceSegmentId || null,
          sequence_no: Number(maxRow?.max || 0) + 1,
          decision_text: body.decisionText,
          decision_type: body.decisionType || "resolution",
          source: "manual",
          status: "confirmed",
          confirmed_by: Number(user!.id),
          confirmed_at: db.fn.now(),
        })
        .returning("*");
      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "decision.create",
        entityType: "meeting_decisions",
        entityId: decision.id,
        newValue: body,
      });
      set.status = 201;
      return { decision };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        decisionText: t.String({ minLength: 1 }),
        agendaId: t.Optional(t.String()),
        decisionType: t.Optional(t.String()),
        sourceSegmentId: t.Optional(t.String()),
      }),
    },
  )

  // ยืนยัน/ปฏิเสธมติที่ AI สกัด (status: confirmed/rejected)
  .post(
    "/:id/decisions/:decisionId/review",
    async ({ params, body, user, set }) => {
      await ensureSchema();
      const decision = await db("meeting_decisions")
        .where({ id: params.decisionId, meeting_id: params.id })
        .first();
      if (!decision) {
        set.status = 404;
        return { error: "ไม่พบมติ" };
      }
      await db("meeting_decisions").where({ id: params.decisionId }).update({
        status: body.status,
        decision_text: body.decisionText ?? decision.decision_text,
        confirmed_by: Number(user!.id),
        confirmed_at: db.fn.now(),
      });
      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: `decision.${body.status}`,
        entityType: "meeting_decisions",
        entityId: params.decisionId,
      });
      return { decision: await db("meeting_decisions").where({ id: params.decisionId }).first() };
    },
    {
      params: t.Object({ id: t.String(), decisionId: t.String() }),
      body: t.Object({
        status: t.Union([t.Literal("confirmed"), t.Literal("rejected")]),
        decisionText: t.Optional(t.String()),
      }),
    },
  )

  // ลบมติ
  .delete(
    "/:id/decisions/:decisionId",
    async ({ params, user, set }) => {
      await ensureSchema();
      const decision = await db("meeting_decisions")
        .where({ id: params.decisionId, meeting_id: params.id })
        .first();
      if (!decision) {
        set.status = 404;
        return { error: "ไม่พบมติ" };
      }
      await db("meeting_decisions").where({ id: params.decisionId }).del();
      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "decision.delete",
        entityType: "meeting_decisions",
        entityId: params.decisionId,
      });
      return { success: true };
    },
    { params: t.Object({ id: t.String(), decisionId: t.String() }) },
  )

  /* ---------- งานที่มอบหมาย (action items) ---------- */

  // เพิ่มงาน
  .post(
    "/:id/actions",
    async ({ params, body, user, set }) => {
      await ensureSchema();
      const [item] = await db("meeting_action_items")
        .insert({
          meeting_id: params.id,
          agenda_id: body.agendaId || null,
          decision_id: body.decisionId || null,
          title: body.title,
          detail: body.detail || null,
          assignee_id: body.assigneeId || null,
          assignee_text: body.assigneeText || null,
          due_date: body.dueDate || null,
          priority: body.priority || "normal",
          status: "pending",
        })
        .returning("*");
      if (item.assignee_id) {
        const meeting = await db("meetings").where({ id: params.id }).first();
        await notify({
          userIds: [item.assignee_id],
          type: "action_assigned",
          title: `ได้รับมอบหมายงาน: ${item.title}`,
          body: body.detail || undefined,
          link: "/followup",
          meetingId: params.id,
        });
        void meeting;
      }
      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "action_item.create",
        entityType: "meeting_action_items",
        entityId: item.id,
        newValue: body,
      });
      set.status = 201;
      return { actionItem: item };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        title: t.String({ minLength: 1 }),
        detail: t.Optional(t.String()),
        agendaId: t.Optional(t.String()),
        decisionId: t.Optional(t.String()),
        assigneeId: t.Optional(t.Number()),
        assigneeText: t.Optional(t.String()),
        dueDate: t.Optional(t.String()),
        priority: t.Optional(t.String()),
      }),
    },
  )

  // แก้ไข/อัปเดตสถานะงาน
  .put(
    "/:id/actions/:actionId",
    async ({ params, body, user, set }) => {
      await ensureSchema();
      const item = await db("meeting_action_items")
        .where({ id: params.actionId, meeting_id: params.id })
        .first();
      if (!item) {
        set.status = 404;
        return { error: "ไม่พบงาน" };
      }
      await db("meeting_action_items")
        .where({ id: params.actionId })
        .update({
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.detail !== undefined ? { detail: body.detail } : {}),
          ...(body.assigneeId !== undefined ? { assignee_id: body.assigneeId } : {}),
          ...(body.assigneeText !== undefined ? { assignee_text: body.assigneeText } : {}),
          ...(body.dueDate !== undefined ? { due_date: body.dueDate || null } : {}),
          ...(body.priority !== undefined ? { priority: body.priority } : {}),
          ...(body.status !== undefined ? { status: body.status } : {}),
          ...(body.progressNote !== undefined ? { progress_note: body.progressNote } : {}),
          ...(body.status === "done" ? { verified_by: Number(user!.id), verified_at: db.fn.now() } : {}),
          updated_at: db.fn.now(),
        });
      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "action_item.update",
        entityType: "meeting_action_items",
        entityId: params.actionId,
        newValue: body,
      });
      return { actionItem: await db("meeting_action_items").where({ id: params.actionId }).first() };
    },
    {
      params: t.Object({ id: t.String(), actionId: t.String() }),
      body: t.Object({
        title: t.Optional(t.String()),
        detail: t.Optional(t.String()),
        assigneeId: t.Optional(t.Number()),
        assigneeText: t.Optional(t.String()),
        dueDate: t.Optional(t.String()),
        priority: t.Optional(t.String()),
        status: t.Optional(t.String()),
        progressNote: t.Optional(t.String()),
      }),
    },
  )

  // ลบงาน
  .delete(
    "/:id/actions/:actionId",
    async ({ params, user, set }) => {
      await ensureSchema();
      const item = await db("meeting_action_items")
        .where({ id: params.actionId, meeting_id: params.id })
        .first();
      if (!item) {
        set.status = 404;
        return { error: "ไม่พบงาน" };
      }
      await db("meeting_action_items").where({ id: params.actionId }).del();
      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "action_item.delete",
        entityType: "meeting_action_items",
        entityId: params.actionId,
      });
      return { success: true };
    },
    { params: t.Object({ id: t.String(), actionId: t.String() }) },
  )

  /* ---------- การเข้าร่วมจริง (attendance) ---------- */
  .post(
    "/:id/attendance",
    async ({ params, body, user, set }) => {
      await ensureSchema();
      for (const row of body.records) {
        const existing = await db("meeting_attendance")
          .where({ meeting_id: params.id, user_id: row.userId })
          .first();
        if (existing) {
          await db("meeting_attendance").where({ id: existing.id }).update({
            attendance_type: row.attendanceType,
            recorded_by: Number(user!.id),
          });
        } else {
          await db("meeting_attendance").insert({
            meeting_id: params.id,
            user_id: row.userId,
            attendance_type: row.attendanceType,
            recorded_by: Number(user!.id),
            check_in_at: row.attendanceType === "present" ? db.fn.now() : null,
          });
        }
      }
      const attendance = await db("meeting_attendance").where({ meeting_id: params.id });
      return { attendance };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        records: t.Array(
          t.Object({ userId: t.Number(), attendanceType: t.String() }),
        ),
      }),
    },
  );
