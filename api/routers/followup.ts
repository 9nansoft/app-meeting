import { Elysia, t } from "elysia";
import { db, ensureSchema } from "../db";
import { requireRole } from "./_lib";
import { writeAudit } from "../services/audit";

/**
 * Follow-up — ติดตามงานที่มอบหมายข้ามการประชุม
 * และนำงานค้างเข้าสู่วาระการประชุมครั้งถัดไป (carried forward)
 */
export const followupRoutes = new Elysia({ prefix: "/followup" })
  .use(requireRole())
  // รายการงานทั้งหมด (กรองตามสถานะ/ผู้รับผิดชอบ/ช่วงกำหนดส่ง)
  .get(
    "/actions",
    async ({ query }) => {
      await ensureSchema();
      const q = db("meeting_action_items")
        .join("meetings", "meetings.id", "=", "meeting_action_items.meeting_id")
        .leftJoin("users as assignee", "assignee.id", "=", "meeting_action_items.assignee_id")
        .leftJoin("meeting_agendas", "meeting_agendas.id", "=", "meeting_action_items.agenda_id")
        .select(
          "meeting_action_items.*",
          "meetings.title as meeting_title",
          "meetings.start_time as meeting_start",
          "assignee.name as assignee_name",
          "meeting_agendas.title as agenda_title",
          "meeting_agendas.sequence_no as agenda_no",
        )
        .orderByRaw(
          `CASE meeting_action_items.status
             WHEN 'in_progress' THEN 0
             WHEN 'pending' THEN 1
             WHEN 'overdue' THEN 2
             WHEN 'done' THEN 3
             ELSE 4 END`,
        )
        .orderBy("meeting_action_items.due_date", "asc");

      if (query.status) q.whereIn("meeting_action_items.status", query.status.split(","));
      else q.whereNotIn("meeting_action_items.status", ["cancelled", "done"]);
      if (query.mine === "true" || query.mine === "1") {
        q.where("meeting_action_items.assignee_id", Number(query.userId || 0));
      } else if (query.assigneeId) {
        q.where("meeting_action_items.assignee_id", query.assigneeId);
      }
      if (query.dueBefore) q.where("meeting_action_items.due_date", "<", query.dueBefore);

      const items = await q;
      return { actionItems: items };
    },
    {
      query: t.Object({
        status: t.Optional(t.String()),
        mine: t.Optional(t.String()),
        assigneeId: t.Optional(t.Number()),
        userId: t.Optional(t.Number()),
        dueBefore: t.Optional(t.String()),
      }),
    },
  )

  // นำงานค้างเข้าสู่วาระการประชุมครั้งถัดไป
  .post(
    "/carry-forward",
    async ({ body, user, set }) => {
      await ensureSchema();
      const meeting = await db("meetings").where({ id: body.targetMeetingId }).first();
      if (!meeting) {
        set.status = 404;
        return { error: "ไม่พบการประชุมปลายทาง" };
      }
      const [maxRow] = await db("meeting_agendas")
        .where({ meeting_id: body.targetMeetingId })
        .max("sequence_no as max");

      const created: any[] = [];
      for (const actionId of body.actionItemIds) {
        const item = await db("meeting_action_items").where({ id: actionId }).first();
        if (!item) continue;
        const [agenda] = await db("meeting_agendas")
          .insert({
            meeting_id: body.targetMeetingId,
            sequence_no: Number(maxRow?.max || 0) + 1 + created.length,
            title: `[สืบเนื่อง] ${item.title}`,
            description: item.detail || `งานค้างจากการประชุมก่อนหน้า (กำหนดส่งเดิม: ${item.due_date || "ไม่ระบุ"})`,
            agenda_type: "follow_up",
            carried_from_action_item_id: item.id,
          })
          .returning("*");
        await db("meeting_action_items")
          .where({ id: actionId })
          .update({ follow_up_meeting_id: body.targetMeetingId });
        created.push(agenda);
      }
      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "followup.carry_forward",
        entityType: "meetings",
        entityId: body.targetMeetingId,
        newValue: { actionItemIds: body.actionItemIds },
      });
      set.status = 201;
      return { agendas: created };
    },
    {
      body: t.Object({
        targetMeetingId: t.String(),
        actionItemIds: t.Array(t.String()),
      }),
    },
  );
