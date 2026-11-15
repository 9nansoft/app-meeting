/**
 * วงจรชีวิตของ process — ใช้ปิดแอปอย่างนุ่มนวลตอน rolling deploy (scripts/rolling-deploy.sh)
 *
 * server/bun-entry.ts รับ SIGTERM แล้ว:
 *   1. หยุดรับ connection ใหม่ (proxy เห็น dial ไม่ได้ → ส่ง request ไป replica อื่นทันที)
 *   2. ปิด WebSocket ด้วย code 1012 ให้ client ต่อใหม่ที่ replica อื่น
 *   3. รอ request ที่ค้างอยู่ + เรียก hook ที่ลงทะเบียนไว้ที่นี่ (คิวงาน AI, security log)
 *   4. ออกจาก process ภายใน SHUTDOWN_TIMEOUT_MS
 */

type ShutdownHook = (deadline: number) => Promise<void> | void;

let draining = false;
const hooks: Array<{ name: string; fn: ShutdownHook }> = [];

export function isDraining(): boolean {
  return draining;
}

/** ลงทะเบียนงานที่ต้องทำก่อนปิด process — fn ได้ deadline (epoch ms) ที่ต้องเสร็จก่อน */
export function onShutdown(name: string, fn: ShutdownHook): void {
  hooks.push({ name, fn });
}

/** เรียกจาก entry ตอนได้ SIGTERM — รอ hook ทั้งหมดไม่เกิน deadline */
export async function runShutdownHooks(deadline: number): Promise<void> {
  draining = true;
  await Promise.race([
    Promise.allSettled(
      hooks.map(async ({ name, fn }) => {
        try {
          await fn(deadline);
        } catch (err: any) {
          console.error(`[Shutdown] ${name} failed:`, err?.message || err);
        }
      }),
    ),
    new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now()))),
  ]);
}
