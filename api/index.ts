import { Elysia } from "elysia";
import { routers } from "./routers";
import { ensureSchema } from "./db";
import { startWorker } from "./services/jobs";
import { initStorage } from "./services/storage";

// สร้าง schema + โฟลเดอร์เก็บไฟล์ แล้วเริ่ม AI worker เบื้องหลัง
ensureSchema()
  .then(() => initStorage())
  .then(() => startWorker())
  .catch((err) => {
    console.error("[Boot] initialization error:", err);
  });

export const app = new Elysia().use(routers);

export type App = typeof app;
export default () => app;
