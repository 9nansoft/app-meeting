import { Elysia, t } from "elysia";
import { db, ensureSchema } from "../db";
import { requireRole, readUploadBody } from "./_lib";
import { writeAudit } from "../services/audit";
import { chatCompletion, isAiConfigured } from "../services/ai/provider";
import { saveFile, readStorageFile, deleteFile } from "../services/storage";

export interface RoomRow {
  id: string;
  name: string;
  capacity: number;
  building: string | null;
  floor: string | null;
  location: string | null;
  table_count: number | null;
  chair_count: number | null;
  responsible_user_id: number | null;
  description: string | null;
  color: string | null;
  has_dining: boolean;
  dining_detail: string | null;
  is_active: boolean;
}

export interface EquipmentRow {
  id: string;
  room_id: string;
  equipment_type: string;
  name: string | null;
  quantity: number;
}

async function roomsWithExtras() {
  const rooms: RoomRow[] = await db("meeting_rooms").orderBy("name");
  const equipment: EquipmentRow[] = await db("room_equipment");
  const images = await db("room_images").orderBy("sort_order");
  const responsibleIds = [...new Set(rooms.map((r) => r.responsible_user_id).filter(Boolean))] as number[];
  const responsibleUsers = responsibleIds.length
    ? await db("users").whereIn("id", responsibleIds).select("id", "name", "username", "position", "email")
    : [];
  return rooms.map((room) => ({
    ...room,
    equipment: equipment.filter((e) => e.room_id === room.id),
    images: images.filter((i) => i.room_id === room.id),
    cover_image: images.find((i) => i.room_id === room.id && i.is_cover) || null,
    responsible: responsibleUsers.find((u) => u.id === room.responsible_user_id) || null,
  }));
}

/** หาช่วงเวลาที่ถูกจองของห้องในช่วง [from,to] */
export async function busySlots(roomIds: string[], from: string, to: string) {
  if (!roomIds.length) return [];
  return db("room_bookings")
    .whereIn("room_id", roomIds)
    .whereNot("status", "cancelled")
    .where("start_time", "<", to)
    .where("end_time", ">", from)
    .select("id", "room_id", "title", "start_time", "end_time", "status", "meeting_id");
}

export const roomsRoutes = new Elysia({ prefix: "/rooms" })
  .use(requireRole())
  // รายการห้องประชุมพร้อมอุปกรณ์ รูป และผู้รับผิดชอบ
  .get("/", async () => {
    await ensureSchema();
    return { rooms: await roomsWithExtras() };
  })

  // ห้องที่ฉันเป็นผู้รับผิดชอบ + ตารางจองวันนี้/ครั้งถัดไปของแต่ละห้อง
  .get("/mine", async ({ user }) => {
    await ensureSchema();
    const rooms = await roomsWithExtras();
    const myRooms = rooms.filter((r) => r.responsible_user_id === Number(user!.id));
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(now);
    todayEnd.setHours(23, 59, 59, 999);

    const withSchedule = await Promise.all(
      myRooms.map(async (room) => {
        const today = await db("room_bookings")
          .where({ room_id: room.id })
          .whereNot("status", "cancelled")
          .where("start_time", ">=", todayStart)
          .where("start_time", "<=", todayEnd)
          .orderBy("start_time");
        const upcoming = await db("room_bookings")
          .where({ room_id: room.id })
          .whereNot("status", "cancelled")
          .where("start_time", ">", now)
          .orderBy("start_time")
          .limit(1);
        return { ...room, todaySchedule: today, nextBooking: upcoming[0] || null };
      }),
    );
    return { rooms: withSchedule };
  })

  // ตารางจองของห้องเดียวตามช่วงเวลา (สำหรับผู้รับผิดชอบห้อง / เลขา / admin)
  .get(
    "/:id/schedule",
    async ({ params, query }) => {
      await ensureSchema();
      const from = query.from ? new Date(query.from) : new Date(new Date().setHours(0, 0, 0, 0));
      const to = query.to ? new Date(query.to) : new Date(from.getTime() + 7 * 86400000);
      const bookings = await db("room_bookings")
        .where({ room_id: params.id })
        .whereNot("status", "cancelled")
        .where("start_time", ">=", from)
        .where("start_time", "<=", to)
        .orderBy("start_time");
      return { bookings };
    },
    {
      params: t.Object({ id: t.String() }),
      query: t.Object({ from: t.Optional(t.String()), to: t.Optional(t.String()) }),
    },
  )

  // สร้างห้องใหม่ (admin)
  .post(
    "/",
    async ({ body, user, set }) => {
      await ensureSchema();
      if (body.responsibleUserId) {
        const responsible = await db("users").where({ id: body.responsibleUserId }).first();
        if (!responsible) {
          set.status = 400;
          return { error: "ไม่พบผู้ใช้ที่ระบุเป็นผู้รับผิดชอบ" };
        }
      }
      const [room] = await db("meeting_rooms")
        .insert({
          name: body.name,
          capacity: body.capacity,
          building: body.building || null,
          floor: body.floor || null,
          location: body.location || null,
          table_count: body.tableCount ?? null,
          chair_count: body.chairCount ?? null,
          responsible_user_id: body.responsibleUserId || null,
          description: body.description || null,
          color: body.color || null,
          has_dining: body.hasDining ?? false,
          dining_detail: body.diningDetail || null,
        })
        .returning("*");
      if (body.equipment?.length) {
        await db("room_equipment").insert(
          body.equipment.map((e: any) => ({
            room_id: room.id,
            equipment_type: e.equipmentType,
            name: e.name || null,
            quantity: e.quantity ?? 1,
          })),
        );
      }
      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "room.create",
        entityType: "meeting_rooms",
        entityId: room.id,
        newValue: body,
      });
      set.status = 201;
      return { room };
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1 }),
        capacity: t.Number({ minimum: 1 }),
        building: t.Optional(t.String()),
        floor: t.Optional(t.String()),
        location: t.Optional(t.String()),
        tableCount: t.Optional(t.Number()),
        chairCount: t.Optional(t.Number()),
        responsibleUserId: t.Optional(t.Number()),
        description: t.Optional(t.String()),
        color: t.Optional(t.String()),
        hasDining: t.Optional(t.Boolean()),
        diningDetail: t.Optional(t.String()),
        equipment: t.Optional(
          t.Array(
            t.Object({
              equipmentType: t.String(),
              name: t.Optional(t.String()),
              quantity: t.Optional(t.Number()),
            }),
          ),
        ),
      }),
    },
  )

  // แก้ไขห้อง (admin)
  .put(
    "/:id",
    async ({ params, body, user, set }) => {
      await ensureSchema();
      const exists = await db("meeting_rooms").where({ id: params.id }).first();
      if (!exists) {
        set.status = 404;
        return { error: "ไม่พบห้องประชุม" };
      }
      if (body.responsibleUserId) {
        const responsible = await db("users").where({ id: body.responsibleUserId }).first();
        if (!responsible) {
          set.status = 400;
          return { error: "ไม่พบผู้ใช้ที่ระบุเป็นผู้รับผิดชอบ" };
        }
      }
      await db("meeting_rooms")
        .where({ id: params.id })
        .update({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.capacity !== undefined ? { capacity: body.capacity } : {}),
          ...(body.building !== undefined ? { building: body.building } : {}),
          ...(body.floor !== undefined ? { floor: body.floor } : {}),
          ...(body.location !== undefined ? { location: body.location } : {}),
          ...(body.tableCount !== undefined ? { table_count: body.tableCount } : {}),
          ...(body.chairCount !== undefined ? { chair_count: body.chairCount } : {}),
          ...(body.responsibleUserId !== undefined
            ? { responsible_user_id: body.responsibleUserId || null }
            : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.color !== undefined ? { color: body.color } : {}),
          ...(body.hasDining !== undefined ? { has_dining: body.hasDining } : {}),
          ...(body.diningDetail !== undefined ? { dining_detail: body.diningDetail || null } : {}),
          ...(body.isActive !== undefined ? { is_active: body.isActive } : {}),
          updated_at: db.fn.now(),
        });
      if (body.equipment) {
        await db("room_equipment").where({ room_id: params.id }).del();
        if (body.equipment.length) {
          await db("room_equipment").insert(
            body.equipment.map((e: any) => ({
              room_id: params.id,
              equipment_type: e.equipmentType,
              name: e.name || null,
              quantity: e.quantity ?? 1,
            })),
          );
        }
      }
      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "room.update",
        entityType: "meeting_rooms",
        entityId: params.id,
        oldValue: exists,
        newValue: body,
      });
      const room = await db("meeting_rooms").where({ id: params.id }).first();
      return { room };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        name: t.Optional(t.String()),
        capacity: t.Optional(t.Number()),
        building: t.Optional(t.String()),
        floor: t.Optional(t.String()),
        location: t.Optional(t.String()),
        tableCount: t.Optional(t.Number()),
        chairCount: t.Optional(t.Number()),
        responsibleUserId: t.Optional(t.Number()),
        description: t.Optional(t.String()),
        color: t.Optional(t.String()),
        hasDining: t.Optional(t.Boolean()),
        diningDetail: t.Optional(t.String()),
        isActive: t.Optional(t.Boolean()),
        equipment: t.Optional(
          t.Array(
            t.Object({
              equipmentType: t.String(),
              name: t.Optional(t.String()),
              quantity: t.Optional(t.Number()),
            }),
          ),
        ),
      }),
    },
  )

  // ลบห้อง (admin)
  .delete(
    "/:id",
    async ({ params, user, set }) => {
      await ensureSchema();
      const exists = await db("meeting_rooms").where({ id: params.id }).first();
      if (!exists) {
        set.status = 404;
        return { error: "ไม่พบห้องประชุม" };
      }
      await db("meeting_rooms").where({ id: params.id }).del();
      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "room.delete",
        entityType: "meeting_rooms",
        entityId: params.id,
        oldValue: exists,
      });
      return { success: true };
    },
    { params: t.Object({ id: t.String() }) },
  )

  // อัปโหลดรูปห้อง (multipart field "file" หรือ "files" ได้หลายไฟล์)
  .post(
    "/:id/images",
    async ({ params, body, user, set }) => {
      await ensureSchema();
      const room = await db("meeting_rooms").where({ id: params.id }).first();
      if (!room) {
        set.status = 404;
        return { error: "ไม่พบห้องประชุม" };
      }
      const files: File[] = [];
      const push = (f: unknown) => {
        if (f && typeof (f as File).arrayBuffer === "function") files.push(f as File);
      };
      if (body && typeof body === "object") {
        const b = body as Record<string, unknown>;
        if (Array.isArray(b.files)) b.files.forEach(push);
        else push(b.file);
      }
      if (!files.length) {
        set.status = 400;
        return { error: "กรุณาแนบไฟล์รูปภาพ" };
      }
      const countBefore = Number(
        (await db("room_images").where({ room_id: params.id }).count("id as count").first())?.count || 0,
      );
      const created = [];
      for (const file of files) {
        const upload = await readUploadBody(file);
        if (!upload || !upload.mimeType.startsWith("image/")) continue;
        const stored = await saveFile("documents", file.name || "room.jpg", upload.buffer);
        const inserted: any[] = await db("room_images")
          .insert({
            room_id: params.id,
            storage_key: stored.storageKey,
            file_name: (file.name || "room.jpg").slice(0, 500),
            mime_type: upload.mimeType,
            file_size: stored.size,
            is_cover: countBefore === 0 && created.length === 0,
            sort_order: countBefore + created.length,
            uploaded_by: Number(user!.id),
          })
          .returning("*");
        created.push(inserted[0]);
      }
      if (!created.length) {
        set.status = 400;
        return { error: "รองรับเฉพาะไฟล์รูปภาพ (JPEG/PNG/WebP)" };
      }
      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "room.image.upload",
        entityType: "meeting_rooms",
        entityId: params.id,
        newValue: { count: created.length },
      });
      set.status = 201;
      return { images: created };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Any({}),
    },
  )

  // ดูรูปห้อง (ต้อง login)
  .get(
    "/images/:imageId/raw",
    async ({ params, set }) => {
      await ensureSchema();
      const image = await db("room_images").where({ id: params.imageId }).first();
      if (!image) {
        set.status = 404;
        return { error: "ไม่พบรูป" };
      }
      const buffer = await readStorageFile(image.storage_key);
      return new Response(new Uint8Array(buffer), {
        headers: {
          "Content-Type": image.mime_type,
          "Cache-Control": "public, max-age=86400",
        },
      });
    },
    { params: t.Object({ imageId: t.String() }) },
  )

  // ตั้งรูปปก
  .put(
    "/images/:imageId/cover",
    async ({ params, user, set }) => {
      await ensureSchema();
      const image = await db("room_images").where({ id: params.imageId }).first();
      if (!image) {
        set.status = 404;
        return { error: "ไม่พบรูป" };
      }
      await db("room_images").where({ room_id: image.room_id }).update({ is_cover: false });
      await db("room_images").where({ id: params.imageId }).update({ is_cover: true });
      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "room.image.cover",
        entityType: "meeting_rooms",
        entityId: image.room_id,
        newValue: { imageId: params.imageId },
      });
      return { success: true };
    },
    { params: t.Object({ imageId: t.String() }) },
  )

  // ลบรูป
  .delete(
    "/images/:imageId",
    async ({ params, user, set }) => {
      await ensureSchema();
      const image = await db("room_images").where({ id: params.imageId }).first();
      if (!image) {
        set.status = 404;
        return { error: "ไม่พบรูป" };
      }
      await db("room_images").where({ id: params.imageId }).del();
      await deleteFile(image.storage_key).catch(() => undefined);
      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "room.image.delete",
        entityType: "meeting_rooms",
        entityId: image.room_id,
      });
      return { success: true };
    },
    { params: t.Object({ imageId: t.String() }) },
  )

  // ตารางห้องว่างในช่วงเวลา (day view)
  .get(
    "/availability",
    async ({ query }) => {
      await ensureSchema();
      const rooms = (await db("meeting_rooms").where({ is_active: true })).map((r: RoomRow) => r.id);
      const busy = await busySlots(rooms, query.from, query.to);
      return { busy: busy.map((b) => ({ ...b })) };
    },
    {
      query: t.Object({
        from: t.String(),
        to: t.String(),
      }),
    },
  )

  /**
   * AI แนะนำห้องที่เหมาะสม — ให้คะแนนตามความจุ/อุปกรณ์ที่ต้องการ/ช่วงเวลาว่าง
   * แล้วให้ LLM อธิบายเหตุผล (ถ้าไม่ได้ตั้งค่า AI จะใช้คำอธิบายจากกฎ)
   */
  .post(
    "/recommend",
    async ({ body }) => {
      await ensureSchema();
      const rooms = await roomsWithExtras();
      const busy = await busySlots(
        rooms.map((r) => r.id),
        body.start,
        body.end,
      );

      const candidates = rooms
        .filter((r) => r.is_active)
        .map((room) => {
          const roomBusy = (busy as any[]).some((b) => b.room_id === room.id);
          const hasAllEquipment = (body.equipment || []).every((req: string) =>
            room.equipment.some((e: EquipmentRow) => e.equipment_type === req),
          );
          const capacityFit = room.capacity >= body.participants;
          const diningFit = !body.needDining || room.has_dining;
          // คะแนน: ห้องพอดีคน (ไม่ใหญ่เกินจนเปลือง) + อุปกรณ์ครบ + ว่าง + สถานที่รับประทานอาหาร
          const sizeEfficiency = capacityFit
            ? 1 - Math.min((room.capacity - body.participants) / Math.max(room.capacity, 1), 0.5)
            : 0;
          const score =
            (roomBusy ? -1000 : 0) +
            (hasAllEquipment ? 40 : 0) +
            (capacityFit ? 40 : 0) +
            (body.needDining ? (room.has_dining ? 30 : -30) : 0) +
            sizeEfficiency * 20;
          return {
            room,
            available: !roomBusy,
            hasAllEquipment,
            capacityFit,
            diningFit,
            score: Math.round(score),
            reasons: [
              !roomBusy ? "ว่างในช่วงเวลาที่ต้องการ" : "ถูกจองในช่วงเวลานี้",
              capacityFit
                ? `ความจุ ${room.capacity} ที่นั่งเพียงพอสำหรับ ${body.participants} คน`
                : `ความจุไม่พอ (${room.capacity} < ${body.participants})`,
              hasAllEquipment ? "มีอุปกรณ์ที่ต้องการครบ" : "ขาดอุปกรณ์ที่ต้องการบางรายการ",
              ...(body.needDining
                ? [room.has_dining ? "มีสถานที่รับประทานอาหารรองรับ" : "ไม่มีสถานที่รับประทานอาหาร"]
                : []),
            ],
          };
        })
        .sort((a, b) => b.score - a.score);

      const top: any[] = candidates.slice(0, 3).filter((c) => c.score > 0);

      // ให้ LLM เขียนคำแนะนำโดยสรุป (ถ้าตั้งค่า AI ไว้)
      const best = top[0];
      let advice =
        best
          ? `แนะนำ "${best.room.name}" — ${best.reasons.slice(0, 2).join(" และ ")}`
          : "ไม่มีห้องที่เหมาะสมในช่วงเวลานี้ ลองเปลี่ยนเวลาหรือลดข้อกำหนดอุปกรณ์";
      if (isAiConfigured() && top.length) {
        const chat = await chatCompletion(
          [
            { role: "system", content: "คุณเป็นผู้ช่วยจัดการห้องประชุม ตอบสั้นกระชับ 1-2 ประโยค" },
            {
              role: "user",
              content: `การประชุม ${body.participants} คน ต้องการอุปกรณ์: ${(body.equipment || []).join(", ") || "ไม่ระบุ"} ช่วงเวลา ${body.start} ถึง ${body.end}\nตัวเลือกห้อง (เรียงตามคะแนนแล้ว): ${top.map((c) => `${c.room.name} (คะแนน ${c.score}, ${c.reasons.join("; ")})`).join(" | ")}\nแนะนำห้องที่เหมาะที่สุดพร้อมเหตุผลสั้น ๆ`,
            },
          ],
          { temperature: 0.1 },
        );
        if (chat?.text) advice = chat.text.trim();
      }

      return { recommendation: advice, candidates: top, aiEnabled: isAiConfigured() };
    },
    {
      body: t.Object({
        participants: t.Number({ minimum: 1 }),
        start: t.String(),
        end: t.String(),
        equipment: t.Optional(t.Array(t.String())),
        needDining: t.Optional(t.Boolean()),
      }),
    },
  );
