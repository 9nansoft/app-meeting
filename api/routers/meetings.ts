import { Elysia, t } from "elysia";
import { db, ensureSchema } from "../db";
import { requireRole } from "./_lib";
import { writeAudit } from "../services/audit";
import { notify } from "../services/notifications";

export const MEETING_STATUSES = ["draft", "scheduled", "in_progress", "completed", "cancelled"];

async function meetingDetail(meetingId: string) {
  const meeting = await db("meetings").where({ id: meetingId }).first();
  if (!meeting) return null;

  const [organizer] = meeting.organizer_id
    ? await db("users").where({ id: meeting.organizer_id }).select("id", "name", "username", "role")
    : [];
  const [secretary] = meeting.secretary_id
    ? await db("users").where({ id: meeting.secretary_id }).select("id", "name", "username", "role")
    : [];

  const participants = await db("meeting_participants")
    .where({ meeting_id: meetingId })
    .join("users", "users.id", "=", "meeting_participants.user_id")
    .select(
      "meeting_participants.id",
      "meeting_participants.user_id",
      "meeting_participants.role_in_meeting",
      "meeting_participants.invite_status",
      "users.name",
      "users.username",
      "users.position",
    );

  const agendas = await db("meeting_agendas")
    .where({ meeting_id: meetingId })
    .orderBy("sequence_no", "asc");

  const documents = await db("meeting_documents")
    .where({ meeting_id: meetingId })
    .orderBy("created_at", "asc");

  const bookings = await db("room_bookings")
    .where({ meeting_id: meetingId })
    .whereNot("status", "cancelled")
    .join("meeting_rooms", "meeting_rooms.id", "=", "room_bookings.room_id")
    .select("room_bookings.*", "meeting_rooms.name as room_name");

  return { meeting, organizer, secretary, participants, agendas, documents, bookings };
}

export const meetingsRoutes = new Elysia({ prefix: "/meetings" })
  .use(requireRole())
  // รายการประชุม (กรองตามสถานะ/ช่วงเวลา/ค้นหา)
  .get(
    "/",
    async ({ query }) => {
      await ensureSchema();
      const q = db("meetings")
        .leftJoin("users as organizer", "organizer.id", "=", "meetings.organizer_id")
        .select(
          "meetings.*",
          "organizer.name as organizer_name",
        )
        .orderBy("meetings.start_time", query.order === "asc" ? "asc" : "desc");
      if (query.status) q.whereIn("meetings.status", query.status.split(","));
      if (query.from) q.where("meetings.start_time", ">=", query.from);
      if (query.to) q.where("meetings.start_time", "<", query.to);
      if (query.q) q.where("meetings.title", "ilike", `%${query.q}%`);

      const meetings = await q.limit(query.limit ?? 100);
      return { meetings };
    },
    {
      query: t.Object({
        status: t.Optional(t.String()),
        from: t.Optional(t.String()),
        to: t.Optional(t.String()),
        q: t.Optional(t.String()),
        limit: t.Optional(t.Number()),
        order: t.Optional(t.String()),
      }),
    },
  )

  // สร้างการประชุม (พร้อมผู้เข้าร่วม และจองห้องในครั้งเดียวได้)
  .post(
    "/",
    async ({ body, user, set }) => {
      await ensureSchema();
      const start = new Date(body.startTime);
      const end = new Date(body.endTime);
      if (start >= end) {
        set.status = 400;
        return { error: "เวลาเริ่มต้นต้องก่อนเวลาสิ้นสุด" };
      }

      // จองห้อง (ถ้าระบุ) — ตรวจซ้ำก่อนสร้างการประชุม
      let booking: any = null;
      if (body.roomId) {
        const overlaps = await db("room_bookings")
          .where({ room_id: body.roomId })
          .whereNot("status", "cancelled")
          .where("start_time", "<", end)
          .where("end_time", ">", start);
        if (overlaps.length) {
          set.status = 409;
          return { error: "ห้องประชุมถูกจองในช่วงเวลานี้แล้ว", conflicts: overlaps };
        }
      }

      const [meeting] = await db("meetings")
        .insert({
          title: body.title,
          description: body.description || null,
          meeting_type: body.meetingType || "regular",
          status: body.status || "scheduled",
          organizer_id: body.organizerId || Number(user!.id),
          secretary_id: body.secretaryId || null,
          start_time: start,
          end_time: end,
          location_text: body.locationText || null,
          previous_meeting_id: body.previousMeetingId || null,
          created_by: Number(user!.id),
        })
        .returning("*");

      if (body.roomId) {
        const [room] = await db("meeting_rooms").where({ id: body.roomId }).first().then((r) => [r]);
        [booking] = await db("room_bookings")
          .insert({
            room_id: body.roomId,
            meeting_id: meeting.id,
            title: body.title,
            purpose: body.description || null,
            special_requests: body.specialRequests || null,
            participants_count: body.participantIds?.length || null,
            booked_by: Number(user!.id),
            start_time: start,
            end_time: end,
            status: "confirmed",
          })
          .returning("*");
        if (room) {
          await db("meetings").where({ id: meeting.id }).update({ location_text: room.name });
          meeting.location_text = room.name;
        }
      }

      const participantIds = new Set<number>([
        body.organizerId || Number(user!.id),
        ...(body.participantIds || []),
        ...(body.secretaryId ? [body.secretaryId] : []),
      ]);
      if (participantIds.size) {
        await db("meeting_participants").insert(
          [...participantIds].map((uid) => ({
            meeting_id: meeting.id,
            user_id: uid,
            role_in_meeting:
              uid === (body.organizerId || Number(user!.id))
                ? "chair"
                : uid === body.secretaryId
                  ? "secretary"
                  : "member",
            invite_status: "invited",
            notified_at: db.fn.now(),
          })),
        );
        await notify({
          userIds: [...participantIds].filter((id) => id !== Number(user!.id)),
          type: "meeting_invitation",
          title: `เชิญประชุม: ${body.title}`,
          body: `${start.toLocaleString("th-TH")} — ${meeting.location_text || body.locationText || "ระบุสถานที่ภายหลัง"}`,
          link: `/meetings/${meeting.id}`,
          meetingId: meeting.id,
        });
      }

      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "meeting.create",
        entityType: "meetings",
        entityId: meeting.id,
        newValue: body,
      });

      set.status = 201;
      return { meeting, booking };
    },
    {
      body: t.Object({
        title: t.String({ minLength: 1 }),
        description: t.Optional(t.String()),
        meetingType: t.Optional(t.String()),
        status: t.Optional(t.String()),
        organizerId: t.Optional(t.Number()),
        secretaryId: t.Optional(t.Number()),
        startTime: t.String(),
        endTime: t.String(),
        locationText: t.Optional(t.String()),
        roomId: t.Optional(t.String()),
        specialRequests: t.Optional(t.String()),
        participantIds: t.Optional(t.Array(t.Number())),
        previousMeetingId: t.Optional(t.String()),
      }),
    },
  )

  // รายละเอียดการประชุม (วาระ เอกสาร ผู้เข้าร่วม ห้อง)
  .get(
    "/:id",
    async ({ params, set }) => {
      await ensureSchema();
      const detail = await meetingDetail(params.id);
      if (!detail) {
        set.status = 404;
        return { error: "ไม่พบการประชุม" };
      }
      return detail;
    },
    { params: t.Object({ id: t.String() }) },
  )

  // แก้ไขการประชุม
  .put(
    "/:id",
    async ({ params, body, user, set }) => {
      await ensureSchema();
      const existing = await db("meetings").where({ id: params.id }).first();
      if (!existing) {
        set.status = 404;
        return { error: "ไม่พบการประชุม" };
      }
      const isOwner = existing.organizer_id === Number(user!.id) || existing.created_by === Number(user!.id);
      if (!isOwner && user!.role !== "admin" && user!.role !== "secretary") {
        set.status = 403;
        return { error: "แก้ไขได้เฉพาะผู้จัดประชุม เลขานุการ หรือ admin" };
      }
      await db("meetings")
        .where({ id: params.id })
        .update({
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.meetingType !== undefined ? { meeting_type: body.meetingType } : {}),
          ...(body.secretaryId !== undefined ? { secretary_id: body.secretaryId } : {}),
          ...(body.startTime !== undefined ? { start_time: new Date(body.startTime) } : {}),
          ...(body.endTime !== undefined ? { end_time: new Date(body.endTime) } : {}),
          ...(body.locationText !== undefined ? { location_text: body.locationText } : {}),
          updated_at: db.fn.now(),
        });
      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "meeting.update",
        entityType: "meetings",
        entityId: params.id,
        oldValue: existing,
        newValue: body,
      });
      return { meeting: await db("meetings").where({ id: params.id }).first() };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        title: t.Optional(t.String()),
        description: t.Optional(t.String()),
        meetingType: t.Optional(t.String()),
        secretaryId: t.Optional(t.Number()),
        startTime: t.Optional(t.String()),
        endTime: t.Optional(t.String()),
        locationText: t.Optional(t.String()),
      }),
    },
  )

  // เปลี่ยนสถานะการประชุม (เริ่มประชุม / เสร็จสิ้น / ยกเลิก)
  .post(
    "/:id/status",
    async ({ params, body, user, set }) => {
      await ensureSchema();
      const existing = await db("meetings").where({ id: params.id }).first();
      if (!existing) {
        set.status = 404;
        return { error: "ไม่พบการประชุม" };
      }
      const isOwner = existing.organizer_id === Number(user!.id) || user!.role === "admin" || user!.role === "secretary";
      if (!isOwner) {
        set.status = 403;
        return { error: "เปลี่ยนสถานะได้เฉพาะผู้จัดประชุม เลขานุการ หรือ admin" };
      }
      if (!MEETING_STATUSES.includes(body.status)) {
        set.status = 400;
        return { error: `สถานะไม่ถูกต้อง (ต้องเป็น: ${MEETING_STATUSES.join(", ")})` };
      }
      await db("meetings").where({ id: params.id }).update({
        status: body.status,
        updated_at: db.fn.now(),
      });
      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: `meeting.status.${body.status}`,
        entityType: "meetings",
        entityId: params.id,
        oldValue: { status: existing.status },
        newValue: { status: body.status },
      });
      return { meeting: await db("meetings").where({ id: params.id }).first() };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({ status: t.String() }),
    },
  )

  // ลบการประชุม (organizer/admin)
  .delete(
    "/:id",
    async ({ params, user, set }) => {
      await ensureSchema();
      const existing = await db("meetings").where({ id: params.id }).first();
      if (!existing) {
        set.status = 404;
        return { error: "ไม่พบการประชุม" };
      }
      const isOwner = existing.organizer_id === Number(user!.id) || existing.created_by === Number(user!.id);
      if (!isOwner && user!.role !== "admin") {
        set.status = 403;
        return { error: "ลบได้เฉพาะผู้จัดประชุมหรือ admin" };
      }
      await db("room_bookings").where({ meeting_id: params.id }).update({ status: "cancelled" });
      await db("meetings").where({ id: params.id }).del();
      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "meeting.delete",
        entityType: "meetings",
        entityId: params.id,
        oldValue: existing,
      });
      return { success: true };
    },
    { params: t.Object({ id: t.String() }) },
  )

  /* ---------- ผู้เข้าร่วม ---------- */
  .post(
    "/:id/participants",
    async ({ params, body, user, set }) => {
      await ensureSchema();
      const meeting = await db("meetings").where({ id: params.id }).first();
      if (!meeting) {
        set.status = 404;
        return { error: "ไม่พบการประชุม" };
      }
      const inserted: any[] = [];
      for (const userId of body.userIds) {
        const exists = await db("meeting_participants")
          .where({ meeting_id: params.id, user_id: userId })
          .first();
        if (exists) continue;
        const [row] = await db("meeting_participants")
          .insert({
            meeting_id: params.id,
            user_id: userId,
            role_in_meeting: body.roleInMeeting || "member",
          })
          .returning("*");
        inserted.push(row);
      }
      if (inserted.length) {
        await notify({
          userIds: body.userIds,
          type: "meeting_invitation",
          title: `เชิญประชุม: ${meeting.title}`,
          body: `${new Date(meeting.start_time).toLocaleString("th-TH")}`,
          link: `/meetings/${params.id}`,
          meetingId: params.id,
        });
      }
      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "meeting.participants.add",
        entityType: "meetings",
        entityId: params.id,
        newValue: body,
      });
      return { participants: inserted };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        userIds: t.Array(t.Number()),
        roleInMeeting: t.Optional(t.String()),
      }),
    },
  )

  .delete(
    "/:id/participants/:userId",
    async ({ params, user, set }) => {
      await ensureSchema();
      await db("meeting_participants")
        .where({ meeting_id: params.id, user_id: Number(params.userId) })
        .del();
      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "meeting.participants.remove",
        entityType: "meetings",
        entityId: params.id,
        newValue: { userId: params.userId },
      });
      return { success: true };
    },
    { params: t.Object({ id: t.String(), userId: t.String() }) },
  );
