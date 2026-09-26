import { Elysia, t } from "elysia";
import { db, ensureSchema } from "../db";
import { requireRole } from "./_lib";
import { writeAudit } from "../services/audit";

const AGENDA_TYPES = ["information", "approval", "follow_up", "consideration"];

async function nextSequence(meetingId: string): Promise<number> {
  const [row] = await db("meeting_agendas")
    .where({ meeting_id: meetingId })
    .max("sequence_no as max");
  return Number(row?.max || 0) + 1;
}

async function agendaWithExtras(agendaId: string) {
  const agenda = await db("meeting_agendas").where({ id: agendaId }).first();
  if (!agenda) return null;
  const documents = await db("meeting_documents").where({ agenda_id: agendaId });
  const summary = await db("agenda_ai_summaries").where({ agenda_id: agendaId }).first();
  const presenter = agenda.presenter_id
    ? (await db("users").where({ id: agenda.presenter_id }).select("id", "name", "username"))[0]
    : null;
  return { agenda, documents, summary: summary || null, presenter };
}

export const agendasRoutes = new Elysia({ prefix: "/meetings" })
  .use(requireRole())
  // เพิ่มวาระ
  .post(
    "/:id/agendas",
    async ({ params, body, user, set }) => {
      await ensureSchema();
      const meeting = await db("meetings").where({ id: params.id }).first();
      if (!meeting) {
        set.status = 404;
        return { error: "ไม่พบการประชุม" };
      }
      if (!AGENDA_TYPES.includes(body.agendaType)) {
        set.status = 400;
        return { error: `ประเภทวาระไม่ถูกต้อง (ต้องเป็น: ${AGENDA_TYPES.join(", ")})` };
      }
      const seq = body.sequenceNo ?? (await nextSequence(params.id));
      const [agenda] = await db("meeting_agendas")
        .insert({
          meeting_id: params.id,
          sequence_no: seq,
          title: body.title,
          description: body.description || null,
          agenda_type: body.agendaType,
          presenter_id: body.presenterId || null,
          duration_minutes: body.durationMinutes || null,
          carried_from_action_item_id: body.carriedFromActionItemId || null,
        })
        .returning("*");
      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "agenda.create",
        entityType: "meeting_agendas",
        entityId: agenda.id,
        newValue: body,
      });
      set.status = 201;
      return { agenda };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        title: t.String({ minLength: 1 }),
        description: t.Optional(t.String()),
        agendaType: t.String(),
        presenterId: t.Optional(t.Number()),
        durationMinutes: t.Optional(t.Number()),
        sequenceNo: t.Optional(t.Number()),
        carriedFromActionItemId: t.Optional(t.String()),
      }),
    },
  )

  // แก้ไขวาระ
  .put(
    "/agendas/:agendaId",
    async ({ params, body, user, set }) => {
      await ensureSchema();
      const existing = await db("meeting_agendas").where({ id: params.agendaId }).first();
      if (!existing) {
        set.status = 404;
        return { error: "ไม่พบวาระ" };
      }
      await db("meeting_agendas")
        .where({ id: params.agendaId })
        .update({
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.agendaType !== undefined ? { agenda_type: body.agendaType } : {}),
          ...(body.presenterId !== undefined ? { presenter_id: body.presenterId } : {}),
          ...(body.durationMinutes !== undefined ? { duration_minutes: body.durationMinutes } : {}),
          ...(body.status !== undefined ? { status: body.status } : {}),
          ...(body.sequenceNo !== undefined ? { sequence_no: body.sequenceNo } : {}),
          updated_at: db.fn.now(),
        });
      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "agenda.update",
        entityType: "meeting_agendas",
        entityId: params.agendaId,
        oldValue: existing,
        newValue: body,
      });
      return { agenda: await db("meeting_agendas").where({ id: params.agendaId }).first() };
    },
    {
      params: t.Object({ agendaId: t.String() }),
      body: t.Object({
        title: t.Optional(t.String()),
        description: t.Optional(t.String()),
        agendaType: t.Optional(t.String()),
        presenterId: t.Optional(t.Number()),
        durationMinutes: t.Optional(t.Number()),
        status: t.Optional(t.String()),
        sequenceNo: t.Optional(t.Number()),
      }),
    },
  )

  // ลบวาระ
  .delete(
    "/agendas/:agendaId",
    async ({ params, user, set }) => {
      await ensureSchema();
      const existing = await db("meeting_agendas").where({ id: params.agendaId }).first();
      if (!existing) {
        set.status = 404;
        return { error: "ไม่พบวาระ" };
      }
      await db("meeting_agendas").where({ id: params.agendaId }).del();
      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "agenda.delete",
        entityType: "meeting_agendas",
        entityId: params.agendaId,
        oldValue: existing,
      });
      return { success: true };
    },
    { params: t.Object({ agendaId: t.String() }) },
  )

  // จัดลำดับวาระใหม่
  .post(
    "/:id/agendas/reorder",
    async ({ params, body, user }) => {
      await ensureSchema();
      for (const item of body.order) {
        await db("meeting_agendas")
          .where({ id: item.agendaId, meeting_id: params.id })
          .update({ sequence_no: item.sequenceNo });
      }
      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "agenda.reorder",
        entityType: "meetings",
        entityId: params.id,
        newValue: body,
      });
      const agendas = await db("meeting_agendas")
        .where({ meeting_id: params.id })
        .orderBy("sequence_no");
      return { agendas };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        order: t.Array(t.Object({ agendaId: t.String(), sequenceNo: t.Number() })),
      }),
    },
  )

  // รายละเอียดวาระ + สรุป AI + เอกสาร
  .get(
    "/agendas/:agendaId",
    async ({ params, set }) => {
      await ensureSchema();
      const detail = await agendaWithExtras(params.agendaId);
      if (!detail) {
        set.status = 404;
        return { error: "ไม่พบวาระ" };
      }
      return detail;
    },
    { params: t.Object({ agendaId: t.String() }) },
  );
