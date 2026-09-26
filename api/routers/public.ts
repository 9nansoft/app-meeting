import { Elysia, t } from "elysia";
import { db, ensureSchema } from "../db";
import { readStorageFile } from "../services/storage";

/**
 * Public API สำหรับหน้าจอแสดงผลหน้าห้องประชุม (TV Display)
 * ไม่ต้องยืนยันตัวตน — แสดงเฉพาะข้อมูลที่เหมาะสม: ชื่อห้อง ตึก/ชั้น
 * และตารางจองวันนี้ (ชื่อการประชุม + ช่วงเวลา) เท่านั้น
 */
export const publicRoutes = new Elysia({ prefix: "/public" })
  // รายการห้องประชุม (สำหรับเลือกกรองบนจอ TV)
  .get("/rooms", async () => {
    await ensureSchema();
    const rooms = await db("meeting_rooms")
      .where({ is_active: true })
      .select("id", "name", "building", "floor", "location", "capacity", "color")
      .orderBy("name");
    const images = await db("room_images").where({ is_cover: true });
    return {
      rooms: rooms.map((room: any) => ({
        ...room,
        cover_image_id: images.find((i) => i.room_id === room.id)?.id || null,
      })),
    };
  })

  // รูปห้อง (เปิดเผยได้ — ใช้บนจอ TV)
  .get("/room-images/:imageId/raw", async ({ params, set }) => {
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
        "Cache-Control": "public, max-age=3600",
      },
    });
  })

  /**
   * ตารางวันนี้สำหรับจอ TV — กรองตามห้อง (roomId) หรือตึก (building) ได้
   * คืนสถานะแบบ real-time: current (กำลังประชุม) / upcoming (จะประชุมเร็ว ๆ นี้) / finished
   */
  .get(
    "/today",
    async ({ query }) => {
      await ensureSchema();
      const now = new Date();
      const todayStart = new Date(now);
      todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date(now);
      todayEnd.setHours(23, 59, 59, 999);

      const q = db("room_bookings")
        .join("meeting_rooms", "meeting_rooms.id", "=", "room_bookings.room_id")
        .leftJoin("users as booker", "booker.id", "=", "room_bookings.booked_by")
        .whereNot("room_bookings.status", "cancelled")
        .where("room_bookings.start_time", ">=", todayStart)
        .where("room_bookings.start_time", "<=", todayEnd)
        .orderBy("room_bookings.start_time")
        .select(
          "room_bookings.id",
          "room_bookings.title",
          "room_bookings.purpose",
          "room_bookings.start_time",
          "room_bookings.end_time",
          "room_bookings.room_id",
          "meeting_rooms.name as room_name",
          "meeting_rooms.building",
          "meeting_rooms.floor",
          "meeting_rooms.color as room_color",
        );

      if (query.roomId) q.where("room_bookings.room_id", query.roomId);
      if (query.building) q.where("meeting_rooms.building", query.building);

      const bookings = await q;

      const withStatus = bookings.map((b: any) => {
        const start = new Date(b.start_time);
        const end = new Date(b.end_time);
        let status: "current" | "upcoming" | "finished" = "upcoming";
        if (start <= now && end > now) status = "current";
        else if (end <= now) status = "finished";
        return { ...b, status };
      });

      // จัดกลุ่มตามห้อง (สำหรับมุมมองภาพรวมทุกห้อง)
      const byRoom = new Map<string, any>();
      for (const b of withStatus) {
        if (!byRoom.has(b.room_id)) {
          byRoom.set(b.room_id, {
            room_id: b.room_id,
            room_name: b.room_name,
            building: b.building,
            floor: b.floor,
            room_color: b.room_color,
            bookings: [],
          });
        }
        byRoom.get(b.room_id).bookings.push(b);
      }

      return {
        now: now.toISOString(),
        rooms: [...byRoom.values()],
        current: withStatus.filter((b) => b.status === "current"),
        upcoming: withStatus.filter((b) => b.status === "upcoming").slice(0, 20),
      };
    },
    {
      query: t.Object({
        roomId: t.Optional(t.String()),
        building: t.Optional(t.String()),
      }),
    },
  );
