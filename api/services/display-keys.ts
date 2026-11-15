import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "../db";

/**
 * key ของจอ TV หน้าห้อง — ให้จอที่ไม่ได้ login รับข้อความถอดเสียงสดของการประชุมในห้องนั้นได้
 *
 * - admin สร้าง key ต่อห้อง (แสดงครั้งเดียวในลิงก์ /display?room=<id>&key=<key>) สร้างใหม่ = key เก่าใช้ไม่ได้
 * - เก็บเฉพาะ SHA-256 ของ key (key สุ่ม 256 บิต จึงไม่ต้องใช้ hash แบบช้า)
 * - จอจะเห็นข้อความเฉพาะการประชุมที่ผู้จัดเปิด "แสดงบนจอหน้าห้อง" (meetings.display_live_captions)
 */

const hashKey = (key: string) => createHash("sha256").update(key, "utf8").digest("hex");

export async function createDisplayKey(roomId: string, userId: number): Promise<string> {
  const key = randomBytes(32).toString("base64url");
  await db("room_display_keys")
    .insert({ room_id: roomId, key_hash: hashKey(key), created_by: userId, created_at: db.fn.now() })
    .onConflict("room_id")
    .merge();
  return key;
}

export async function revokeDisplayKey(roomId: string): Promise<boolean> {
  return (await db("room_display_keys").where({ room_id: roomId }).del()) > 0;
}

export async function roomsWithDisplayKey(): Promise<Set<string>> {
  const rows: Array<{ room_id: string }> = await db("room_display_keys").select("room_id");
  return new Set(rows.map((r) => r.room_id));
}

export async function verifyDisplayKey(roomId: string, key: string | null | undefined): Promise<boolean> {
  if (!key || key.length > 128) return false;
  const row = await db("room_display_keys").where({ room_id: roomId }).first("key_hash").catch(() => null);
  if (!row) return false;
  const a = Buffer.from(row.key_hash, "hex");
  const b = Buffer.from(hashKey(key), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * การประชุมในห้องที่จอควรแสดงข้อความสดตอนนี้: มีการจองห้องที่เริ่มแล้วและยังไม่หมดเวลา
 * (หรือการประชุมยังอยู่ในสถานะ in_progress — ประชุมเกินเวลา) และผู้จัดเปิดให้แสดงบนจอ
 */
export async function currentDisplayMeeting(roomId: string): Promise<string | null> {
  const row = await db("room_bookings as b")
    .join("meetings as m", "m.id", "b.meeting_id")
    .where("b.room_id", roomId)
    .whereNot("b.status", "cancelled")
    .where("m.display_live_captions", true)
    .where("b.start_time", "<=", db.fn.now())
    .where("b.start_time", ">", db.raw("now() - interval '12 hours'"))
    .where((qb) => qb.where("b.end_time", ">", db.fn.now()).orWhere("m.status", "in_progress"))
    .orderBy("b.start_time", "desc")
    .first("m.id")
    .catch(() => null);
  return row?.id ?? null;
}
