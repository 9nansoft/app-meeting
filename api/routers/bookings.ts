import { Elysia, t } from "elysia";
import crypto from "node:crypto";
import { db, ensureSchema } from "../db";
import { requireRole } from "./_lib";
import { writeAudit } from "../services/audit";

/** ตรวจว่ามีการจองทับเวลากับห้องนี้อีกหรือไม่ (สถานะ != cancelled) */
export async function findOverlaps(
  roomId: string,
  start: Date,
  end: Date,
  excludeBookingId?: string,
) {
  const q = db("room_bookings")
    .where({ room_id: roomId })
    .whereNot("status", "cancelled")
    .where("start_time", "<", end)
    .where("end_time", ">", start);
  if (excludeBookingId) q.whereNot("id", excludeBookingId);
  return q.select("id", "title", "start_time", "end_time");
}

/** สร้างชุดวันเวลาสำหรับการจองซ้ำตามรอบ */
function expandRecurrence(
  start: Date,
  end: Date,
  recurrence: { freq: "daily" | "weekly" | "monthly"; interval: number; count: number },
): Array<{ start: Date; end: Date }> {
  const slots: Array<{ start: Date; end: Date }> = [];
  const duration = end.getTime() - start.getTime();
  let cursor = new Date(start);
  for (let i = 0; i < Math.min(recurrence.count, 52); i++) {
    slots.push({ start: new Date(cursor), end: new Date(cursor.getTime() + duration) });
    if (recurrence.freq === "daily") {
      cursor.setDate(cursor.getDate() + recurrence.interval);
    } else if (recurrence.freq === "weekly") {
      cursor.setDate(cursor.getDate() + 7 * recurrence.interval);
    } else {
      cursor.setMonth(cursor.getMonth() + recurrence.interval);
    }
  }
  return slots;
}

export const bookingsRoutes = new Elysia({ prefix: "/bookings" })
  .use(requireRole())
  // รายการจองตามช่วงเวลา/ห้อง
  .get(
    "/",
    async ({ query }) => {
      await ensureSchema();
      const q = db("room_bookings")
        .join("meeting_rooms", "meeting_rooms.id", "=", "room_bookings.room_id")
        .select(
          "room_bookings.*",
          "meeting_rooms.name as room_name",
          "meeting_rooms.color as room_color",
          "meeting_rooms.capacity as room_capacity",
        )
        .whereNot("room_bookings.status", "cancelled")
        .orderBy("room_bookings.start_time", "asc");
      if (query.from) q.where("room_bookings.start_time", ">=", query.from);
      if (query.to) q.where("room_bookings.start_time", "<", query.to);
      if (query.roomId) q.where("room_bookings.room_id", query.roomId);
      return { bookings: await q };
    },
    {
      query: t.Object({
        from: t.Optional(t.String()),
        to: t.Optional(t.String()),
        roomId: t.Optional(t.String()),
      }),
    },
  )

  // ตรวจสอบการจองซ้ำโดยไม่สร้างรายการ
  .post(
    "/check",
    async ({ body }) => {
      await ensureSchema();
      const overlaps = await findOverlaps(body.roomId, new Date(body.start), new Date(body.end));
      return { available: overlaps.length === 0, conflicts: overlaps };
    },
    {
      body: t.Object({ roomId: t.String(), start: t.String(), end: t.String() }),
    },
  )

  // สร้างการจอง (รองรับการจองซ้ำตามรอบ)
  .post(
    "/",
    async ({ body, user, set }) => {
      await ensureSchema();
      const room = await db("meeting_rooms").where({ id: body.roomId }).first();
      if (!room) {
        set.status = 404;
        return { error: "ไม่พบห้องประชุม" };
      }

      const slots: Array<{ start: Date; end: Date }> = [{ start: new Date(body.start), end: new Date(body.end) }];
      if (body.recurrence) {
        slots.length = 0;
        slots.push(
          ...expandRecurrence(new Date(body.start), new Date(body.end), body.recurrence),
        );
      }

      const recurrenceGroupId = body.recurrence ? crypto.randomUUID() : null;
      const created: any[] = [];
      const skipped: Array<{ start: string; conflict: string }> = [];

      for (const slot of slots) {
        const overlaps = await findOverlaps(body.roomId, slot.start, slot.end);
        if (overlaps.length) {
          skipped.push({
            start: slot.start.toISOString(),
            conflict: overlaps[0].title,
          });
          continue;
        }
        const [row] = await db("room_bookings")
          .insert({
            room_id: body.roomId,
            meeting_id: body.meetingId || null,
            title: body.title,
            purpose: body.purpose || null,
            special_requests: body.specialRequests || null,
            participants_count: body.participantsCount ?? null,
            booked_by: Number(user!.id),
            start_time: slot.start,
            end_time: slot.end,
            status: "confirmed",
            recurrence_rule: body.recurrence ? JSON.stringify(body.recurrence) : null,
            recurrence_group_id: recurrenceGroupId,
          })
          .returning("*");
        created.push(row);
      }

      if (!created.length) {
        set.status = 409;
        return { error: "ช่วงเวลาที่เลือกถูกจองไปแล้วทั้งหมด", conflicts: skipped };
      }

      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "booking.create",
        entityType: "room_bookings",
        entityId: created[0].id,
        newValue: { roomId: body.roomId, title: body.title, count: created.length },
      });

      set.status = 201;
      return { bookings: created, skipped };
    },
    {
      body: t.Object({
        roomId: t.String(),
        title: t.String({ minLength: 1 }),
        purpose: t.Optional(t.String()),
        specialRequests: t.Optional(t.String()),
        participantsCount: t.Optional(t.Number()),
        start: t.String(),
        end: t.String(),
        meetingId: t.Optional(t.String()),
        recurrence: t.Optional(
          t.Object({
            freq: t.Union([t.Literal("daily"), t.Literal("weekly"), t.Literal("monthly")]),
            interval: t.Number({ minimum: 1, maximum: 12 }),
            count: t.Number({ minimum: 1, maximum: 52 }),
          }),
        ),
      }),
    },
  )

  // แก้ไขการจอง
  .put(
    "/:id",
    async ({ params, body, user, set }) => {
      await ensureSchema();
      const existing = await db("room_bookings").where({ id: params.id }).first();
      if (!existing) {
        set.status = 404;
        return { error: "ไม่พบรายการจอง" };
      }
      if (existing.booked_by !== Number(user!.id) && user!.role !== "admin") {
        set.status = 403;
        return { error: "แก้ไขได้เฉพาะผู้จองเองหรือ admin" };
      }
      const start = body.start ? new Date(body.start) : new Date(existing.start_time);
      const end = body.end ? new Date(body.end) : new Date(existing.end_time);
      const roomId = body.roomId || existing.room_id;
      if (start >= end) {
        set.status = 400;
        return { error: "เวลาเริ่มต้นต้องก่อนเวลาสิ้นสุด" };
      }
      const overlaps = await findOverlaps(roomId, start, end, params.id);
      if (overlaps.length) {
        set.status = 409;
        return { error: "ช่วงเวลานี้มีการจองอยู่แล้ว", conflicts: overlaps };
      }
      await db("room_bookings")
        .where({ id: params.id })
        .update({
          room_id: roomId,
          title: body.title ?? existing.title,
          purpose: body.purpose !== undefined ? body.purpose || null : existing.purpose,
          special_requests: body.specialRequests !== undefined ? body.specialRequests || null : existing.special_requests,
          participants_count: body.participantsCount ?? existing.participants_count,
          start_time: start,
          end_time: end,
          updated_at: db.fn.now(),
        });
      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "booking.update",
        entityType: "room_bookings",
        entityId: params.id,
        oldValue: existing,
        newValue: body,
      });
      const booking = await db("room_bookings").where({ id: params.id }).first();
      return { booking };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        roomId: t.Optional(t.String()),
        title: t.Optional(t.String()),
        purpose: t.Optional(t.String()),
        specialRequests: t.Optional(t.String()),
        participantsCount: t.Optional(t.Number()),
        start: t.Optional(t.String()),
        end: t.Optional(t.String()),
      }),
    },
  )

  // ยกเลิกการจอง (ทั้งชุดได้ถ้า all=true)
  .delete(
    "/:id",
    async ({ params, query, user, set }) => {
      await ensureSchema();
      const existing = await db("room_bookings").where({ id: params.id }).first();
      if (!existing) {
        set.status = 404;
        return { error: "ไม่พบรายการจอง" };
      }
      if (existing.booked_by !== Number(user!.id) && user!.role !== "admin") {
        set.status = 403;
        return { error: "ยกเลิกได้เฉพาะผู้จองเองหรือ admin" };
      }
      if (query.all && existing.recurrence_group_id) {
        await db("room_bookings")
          .where({ recurrence_group_id: existing.recurrence_group_id })
          .whereNot("status", "cancelled")
          .update({ status: "cancelled", updated_at: db.fn.now() });
      } else {
        await db("room_bookings")
          .where({ id: params.id })
          .update({ status: "cancelled", updated_at: db.fn.now() });
      }
      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "booking.cancel",
        entityType: "room_bookings",
        entityId: params.id,
        oldValue: existing,
      });
      return { success: true };
    },
    {
      params: t.Object({ id: t.String() }),
      query: t.Object({ all: t.Optional(t.BooleanString()) }),
    },
  );
