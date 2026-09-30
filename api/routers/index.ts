import { Elysia } from "elysia";
import { authRoutes } from "./auth";
import { usersRoutes, usersAdminRoutes } from "./users";
import { roomsRoutes } from "./rooms";
import { bookingsRoutes } from "./bookings";
import { meetingsRoutes } from "./meetings";
import { agendasRoutes } from "./agendas";
import { documentsRoutes } from "./documents";
import { liveRoutes } from "./live";
import { minutesRoutes } from "./minutes";
import { followupRoutes } from "./followup";
import { notificationsRoutes } from "./notifications";
import { dashboardRoutes } from "./dashboard";
import { adminRoutes } from "./admin";
import { publicRoutes } from "./public";
import { searchRoutes } from "./search";

export const routers = new Elysia()
  .use(authRoutes)
  .use(usersRoutes) // รายชื่อผู้ใช้ (login)
  .use(usersAdminRoutes) // จัดการบัญชีผู้ใช้ (admin)
  // AI Smart Meeting modules
  .use(roomsRoutes) // Module 1: จองห้องประชุม
  .use(bookingsRoutes)
  .use(meetingsRoutes) // Module 2: การประชุม + วาระ
  .use(agendasRoutes)
  .use(documentsRoutes) // เอกสาร PDF + AI วิเคราะห์ (Module 2/3)
  .use(liveRoutes) // Module 4: บันทึกเสียง/ถอดเสียงระหว่างประชุม
  .use(minutesRoutes) // Module 5: รายงาน มติ งาน อนุมัติ
  .use(followupRoutes) // ติดตามงานข้ามการประชุม
  .use(notificationsRoutes)
  .use(dashboardRoutes)
  .use(adminRoutes)
  .use(publicRoutes) // หน้าจอ TV display (ไม่ต้อง login)
  .use(searchRoutes); // ค้นหาเชิงความหมายในเอกสาร (vector + keyword)
