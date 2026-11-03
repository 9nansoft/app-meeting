import { db } from "../db";

/**
 * การควบคุมสิทธิ์ระดับการประชุม (object-level authorization)
 *
 * - ดูได้ (view):   admin, บทบาท secretary, ผู้จัด (organizer), ผู้สร้าง, เลขาของการประชุม,
 *                   และผู้ที่อยู่ใน meeting_participants
 * - จัดการได้ (manage): admin, บทบาท secretary, ผู้จัด, ผู้สร้าง, เลขาของการประชุม
 *
 * ทุก route ที่รับ meetingId / agendaId / documentId ฯลฯ ต้องผ่านฟังก์ชันในไฟล์นี้
 * ก่อนอ่านหรือแก้ไขข้อมูล
 */

export interface AccessUser {
  id: string | number;
  role: string;
}

/** บทบาทที่เข้าถึงการประชุมได้ทุกการประชุม (ผู้ดูแลระบบ/เลขานุการกลาง) */
export function isPrivileged(user: AccessUser | null | undefined): boolean {
  return !!user && (user.role === "admin" || user.role === "secretary");
}

interface MeetingOwnership {
  id: string;
  organizer_id: number | null;
  secretary_id: number | null;
  created_by: number | null;
}

function ownsMeeting(user: AccessUser, meeting: MeetingOwnership): boolean {
  const uid = Number(user.id);
  return (
    meeting.organizer_id === uid || meeting.created_by === uid || meeting.secretary_id === uid
  );
}

export async function loadMeeting(meetingId: string): Promise<(MeetingOwnership & Record<string, any>) | null> {
  if (!meetingId) return null;
  try {
    return (await db("meetings").where({ id: meetingId }).first()) ?? null;
  } catch {
    // id ไม่ใช่ uuid ที่ถูกต้อง → ถือว่าไม่พบ
    return null;
  }
}

export async function canViewMeetingRow(user: AccessUser | null | undefined, meeting: MeetingOwnership | null): Promise<boolean> {
  if (!user || !meeting) return false;
  if (isPrivileged(user) || ownsMeeting(user, meeting)) return true;
  const member = await db("meeting_participants")
    .where({ meeting_id: meeting.id, user_id: Number(user.id) })
    .first();
  return !!member;
}

export function canManageMeetingRow(user: AccessUser | null | undefined, meeting: MeetingOwnership | null): boolean {
  if (!user || !meeting) return false;
  return isPrivileged(user) || ownsMeeting(user, meeting);
}

export type MeetingAccess = "view" | "manage";

/**
 * ตรวจสิทธิ์ต่อการประชุม แล้วคืน meeting ถ้าผ่าน
 * ไม่ผ่าน → คืน { status, error } ให้ route ตั้ง set.status แล้วส่ง error กลับ
 * (ตอบ 404 เมื่อไม่มีสิทธิ์ดู เพื่อไม่เปิดเผยว่ามีการประชุมนั้นอยู่)
 */
export async function authorizeMeeting(
  user: AccessUser | null | undefined,
  meetingId: string,
  level: MeetingAccess,
): Promise<{ ok: true; meeting: MeetingOwnership & Record<string, any> } | { ok: false; status: number; error: string }> {
  const meeting = await loadMeeting(meetingId);
  if (!meeting || !(await canViewMeetingRow(user, meeting))) {
    return { ok: false, status: 404, error: "ไม่พบการประชุม" };
  }
  if (level === "manage" && !canManageMeetingRow(user, meeting)) {
    return {
      ok: false,
      status: 403,
      error: "ดำเนินการได้เฉพาะผู้จัดประชุม เลขานุการ หรือผู้ดูแลระบบ",
    };
  }
  return { ok: true, meeting };
}

/**
 * subquery ของ meeting id ที่ผู้ใช้มีสิทธิ์ดู — ใช้กับ whereIn(...) ในรายการต่าง ๆ
 * คืน null เมื่อเป็นผู้ใช้ที่ดูได้ทุกการประชุม (ไม่ต้องกรอง)
 */
export function viewableMeetingIdsQuery(user: AccessUser) {
  if (isPrivileged(user)) return null;
  const uid = Number(user.id);
  return db("meetings")
    .select("meetings.id")
    .where((qb) => {
      qb.where("meetings.organizer_id", uid)
        .orWhere("meetings.created_by", uid)
        .orWhere("meetings.secretary_id", uid)
        .orWhereIn(
          "meetings.id",
          db("meeting_participants").select("meeting_id").where({ user_id: uid }),
        );
    });
}
