import { db } from "../db";

export type NotificationType =
  | "meeting_reminder"
  | "meeting_invitation"
  | "minutes_approval"
  | "action_assigned"
  | "action_due"
  | "job_failed"
  | "info";

export interface NotifyInput {
  userIds: number[];
  type: NotificationType;
  title: string;
  body?: string;
  link?: string;
  meetingId?: string | null;
}

/**
 * สร้างการแจ้งเตือนในระบบ (in-app)
 * ช่องทาง email / LINE OA เสริมภายหลังได้ผ่าน channel ในตาราง notifications
 */
export async function notify(input: NotifyInput): Promise<void> {
  if (!input.userIds.length) return;
  const rows = [...new Set(input.userIds)].map((userId) => ({
    user_id: userId,
    type: input.type,
    title: input.title.slice(0, 500),
    body: input.body ?? null,
    link: input.link ?? null,
    meeting_id: input.meetingId ?? null,
    channel: "inapp",
    status: "unread",
  }));
  try {
    await db("notifications").insert(rows);
  } catch (err) {
    console.error("[Notify] failed:", err);
  }
}

/** แจ้งเตือนผู้เข้าร่วมทั้งหมดของการประชุม (ไม่รวมผู้ส่งถ้าระบุ) */
export async function notifyMeetingParticipants(
  meetingId: string,
  input: Omit<NotifyInput, "userIds">,
  excludeUserId?: number,
): Promise<void> {
  const participants = await db("meeting_participants")
    .where({ meeting_id: meetingId })
    .select("user_id");
  const userIds = participants.map((p) => p.user_id).filter((id) => id !== excludeUserId);
  await notify({ ...input, userIds });
}
