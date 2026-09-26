import { Elysia } from "elysia";
import { db, ensureSchema } from "../db";
import { requireRole } from "./_lib";

/** Dashboard — การประชุมวันนี้ ห้องว่าง งานที่ต้องติดตาม รายงานรออนุมัติ */
export const dashboardRoutes = new Elysia({ prefix: "/dashboard" })
  .use(requireRole())
  .get("/", async ({ user }) => {
    await ensureSchema();

    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(now);
    todayEnd.setHours(23, 59, 59, 999);
    const weekEnd = new Date(now);
    weekEnd.setDate(weekEnd.getDate() + 7);

    const userId = Number(user!.id);

    // การประชุมวันนี้ + ที่ฉันเข้าร่วม
    const todayMeetings = await db("meetings")
      .leftJoin("users as organizer", "organizer.id", "=", "meetings.organizer_id")
      .select("meetings.*", "organizer.name as organizer_name")
      .where("meetings.start_time", ">=", todayStart)
      .where("meetings.start_time", "<", todayEnd)
      .whereNot("meetings.status", "cancelled")
      .orderBy("meetings.start_time");

    const myMeetingIds = (
      await db("meeting_participants").where({ user_id: userId }).select("meeting_id")
    ).map((r) => r.meeting_id);

    // การประชุมถัดไปของฉันใน 7 วัน
    const upcoming = await db("meetings")
      .where("meetings.start_time", ">", now)
      .where("meetings.start_time", "<", weekEnd)
      .whereNot("meetings.status", "cancelled")
      .whereIn("meetings.id", myMeetingIds.length ? myMeetingIds : ["00000000-0000-0000-0000-000000000000"])
      .orderBy("meetings.start_time")
      .limit(10);

    // ห้องว่างตอนนี้
    const rooms = await db("meeting_rooms").where({ is_active: true });
    const busyNow = await db("room_bookings")
      .whereNot("status", "cancelled")
      .where("start_time", "<", now)
      .where("end_time", ">", now);
    const freeRooms = rooms.filter(
      (r: any) => !busyNow.some((b: any) => b.room_id === r.id),
    );

    // งานของฉันที่ยังไม่เสร็จ + งานค้างทั้งระบบ
    const myOpenActions = await db("meeting_action_items")
      .join("meetings", "meetings.id", "=", "meeting_action_items.meeting_id")
      .select("meeting_action_items.*", "meetings.title as meeting_title")
      .where({ assignee_id: userId })
      .whereNotIn("meeting_action_items.status", ["done", "cancelled"])
      .orderBy("meeting_action_items.due_date");
    const overdueCount = myOpenActions.filter(
      (a: any) => a.due_date && new Date(a.due_date) < todayStart,
    ).length;

    // รายงานที่รออนุมัติ (ที่ฉันเป็นประธาน/เลขา/admin)
    const pendingApprovals = await db("meeting_minutes")
      .join("meetings", "meetings.id", "=", "meeting_minutes.meeting_id")
      .select("meeting_minutes.*", "meetings.title as meeting_title")
      .where("meeting_minutes.status", "pending_review")
      .orderBy("meeting_minutes.updated_at", "desc");

    // งาน AI ที่กำลังทำ/ล่าสุด
    const recentJobs = await db("ai_jobs")
      .orderBy("created_at", "desc")
      .limit(8)
      .select("id", "job_type", "status", "meeting_id", "created_at", "completed_at", "error");

    const unread = await db("notifications")
      .where({ user_id: userId, status: "unread" })
      .count("id as count");

    return {
      today: now.toISOString(),
      stats: {
        todayMeetingCount: todayMeetings.length,
        freeRoomCount: freeRooms.length,
        totalRoomCount: rooms.length,
        myOpenActionCount: myOpenActions.length,
        overdueCount,
        pendingApprovalCount: pendingApprovals.length,
        unreadNotifications: Number((unread[0] as any)?.count || 0),
      },
      todayMeetings,
      upcoming,
      freeRooms: freeRooms.map((r: any) => ({ id: r.id, name: r.name, capacity: r.capacity })),
      myOpenActions,
      pendingApprovals,
      recentJobs,
    };
  });
