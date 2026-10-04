import crypto from "node:crypto";
import { db } from "../db";

/**
 * ระบบบันทึก log ความมั่นคงปลอดภัย (Security Log)
 *
 * จัดทำตาม พ.ร.บ. การกระทำความผิดเกี่ยวกับคอมพิวเตอร์ (ฉบับที่ 2) พ.ศ. 2560
 * โดยเฉพาะมาตรา 26 ที่กำหนดให้ผู้ให้บริการเก็บ "ข้อมูลจราจรคอมพิวเตอร์"
 * (computer traffic data) อย่างน้อย 90 วันนับแต่วันที่ข้อมูลเข้าสู่ระบบ
 *
 * หลักการ:
 *  1. บันทึกใคร (user) ทำอะไร (event) เมื่อไร (timestamp) จากที่ไหน (IP/UA)
 *  2. ทุกแถวผูกกันเป็น hash chain (entry_hash = SHA-256 ของแถวก่อนหน้า +
 *     เนื้อหาแถวปัจจุบัน) ทำให้ตรวจจับการแก้ไข/ลบ log ภายหลังได้ (tamper-evident)
 *  3. ห้ามลบ log ก่อนครบ 90 วัน (MIN_LOG_RETENTION_DAYS เป็นค่าขั้นต่ำตามกฎหมาย
 *     แม้ผู้ดูแลจะตั้ง retention policy ต่ำกว่านี้ก็ตาม)
 *
 * เงื่อนไขความถูกต้องของ hash ที่ต้องระวัง:
 *  - primary key เป็น bigserial ให้ลำดับแทรกที่แน่นอน (uuid เรียงไม่ตรงลำดับเวลา)
 *  - created_at ตัดมิลิวินาทีทิ้งตอนบันทึก ให้ค่าที่อ่านกลับจาก DB ตรงกับตอน hash
 *  - detail ผ่าน canonicalJson (เรียงคีย์) เพราะ jsonb ใน Postgres เรียงคีย์ใหม่
 */

/** ขั้นต่ำตาม ม.26 — ห้ามตั้งค่าต่ำกว่านี้ */
export const MIN_LOG_RETENTION_DAYS = 90;

export type LogSeverity = "info" | "warning" | "error";

export type SecurityEventType =
  | "auth.login_success"
  | "auth.login_failed"
  | "auth.login_blocked"
  | "auth.logout"
  | "auth.invalid_token"
  | "access.unauthorized" // เรียก API โดยไม่มี session
  | "access.forbidden" // มี session แต่บทบาทไม่พอ (403)
  | "http.request" // access log ทุก request
  | "user.register"
  | "log.exported" // ผู้ดูแลส่งออก log
  | "log.integrity_failed"; // ตรวจพบว่า hash chain ขาด/ถูกแก้

export interface SecurityLogEntry {
  eventType: SecurityEventType;
  severity?: LogSeverity;
  userId?: number | null;
  username?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  method?: string | null;
  path?: string | null;
  statusCode?: number | null;
  durationMs?: number | null;
  detail?: Record<string, unknown> | null;
}

const GENESIS_HASH = "GENESIS";

/** hash ของแถวล่าสุด (cache ใน process — เขียนแบบเรียงลำดับจึงไม่แข่งกัน) */
let cachedLastHash: string | null = null;
let lastHashLoaded = false;

/** คิวเขียนแบบเรียงลำดับ ให้ hash chain ต่อเนื่องแม้มี request พร้อมกัน */
let writeQueue: Promise<void> = Promise.resolve();

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/** JSON แบบ deterministic — เรียงคีย์ทุกระดับ ให้ค่าเท่ากัน hash เท่ากันเสมอ */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

function computeEntryHash(prevHash: string, entry: SecurityLogEntry, createdAt: Date): string {
  const material = canonicalJson({
    prev_hash: prevHash,
    event_type: entry.eventType,
    severity: entry.severity ?? "info",
    user_id: entry.userId ?? null,
    username: entry.username ?? null,
    ip: entry.ip ?? null,
    user_agent: entry.userAgent?.slice(0, 500) ?? null,
    method: entry.method ?? null,
    path: entry.path?.slice(0, 500) ?? null,
    status_code: entry.statusCode ?? null,
    duration_ms: entry.durationMs ?? null,
    detail: entry.detail ?? null,
    created_at: createdAt.toISOString(),
  });
  return sha256(material);
}

async function loadLastHash(): Promise<string> {
  if (lastHashLoaded) return cachedLastHash ?? GENESIS_HASH;
  try {
    const row = await db("security_logs").select("entry_hash").orderBy("id", "desc").limit(1).first();
    cachedLastHash = (row?.entry_hash as string) ?? null;
  } catch (err) {
    console.error("[SecurityLog] cannot load last hash:", err);
    cachedLastHash = null;
  }
  lastHashLoaded = true;
  return cachedLastHash ?? GENESIS_HASH;
}

/**
 * บันทึก security log 1 แถว — ไม่ throw เมื่อบันทึกไม่สำเร็จ
 * เพื่อไม่ให้กระทบ request หลัก (ยอมเสียแถว log ดีกว่าระบบล่ม)
 */
export function writeSecurityLog(entry: SecurityLogEntry): Promise<void> {
  writeQueue = writeQueue
    .then(async () => {
      const prevHash = await loadLastHash();
      const createdAt = new Date();
      createdAt.setMilliseconds(0); // ให้อ่านคืนจาก DB ได้ค่าเดิม (parser ตัด ms)
      const entryHash = computeEntryHash(prevHash, entry, createdAt);
      await db("security_logs").insert({
        event_type: entry.eventType,
        severity: entry.severity ?? "info",
        user_id: entry.userId ?? null,
        username: entry.username ?? null,
        ip: entry.ip ?? null,
        user_agent: entry.userAgent?.slice(0, 500) ?? null,
        method: entry.method ?? null,
        path: entry.path?.slice(0, 500) ?? null,
        status_code: entry.statusCode ?? null,
        duration_ms: entry.durationMs ?? null,
        detail: entry.detail === undefined || entry.detail === null ? null : JSON.stringify(entry.detail),
        prev_hash: prevHash,
        entry_hash: entryHash,
        created_at: createdAt,
      });
      cachedLastHash = entryHash;
      lastHashLoaded = true;
    })
    .catch((err) => {
      console.error("[SecurityLog] failed to write:", err);
    });
  return writeQueue;
}

export interface ChainVerification {
  total: number;
  valid: boolean;
  brokenAtId?: number;
  brokenAtTime?: string;
  reason?: string;
}

/**
 * ตรวจความถูกต้องของ hash chain ทั้งตาราง
 * ถ้ามีแถวใดถูกแก้ไข/ลบตรงกลาง จะตรวจพบจุดขาดทันที
 */
export async function verifyLogChain(): Promise<ChainVerification> {
  const rows = await db("security_logs")
    .select(
      "id",
      "event_type",
      "severity",
      "user_id",
      "username",
      "ip",
      "user_agent",
      "method",
      "path",
      "status_code",
      "duration_ms",
      "detail",
      "prev_hash",
      "entry_hash",
      "created_at",
    )
    .orderBy("id", "asc");

  let prevHash = GENESIS_HASH;
  for (const row of rows) {
    const entry: SecurityLogEntry = {
      eventType: row.event_type as SecurityEventType,
      severity: row.severity as LogSeverity,
      userId: row.user_id,
      username: row.username,
      ip: row.ip,
      userAgent: row.user_agent,
      method: row.method,
      path: row.path,
      statusCode: row.status_code,
      durationMs: row.duration_ms,
      detail: row.detail ?? null,
    };
    // created_at อ่านกลับมาเป็น "YYYY-MM-DD HH:mm:ss" (local tz) ตรงค่าที่บันทึก
    const expected = computeEntryHash(prevHash, entry, new Date(row.created_at));
    if (row.prev_hash !== prevHash) {
      return {
        total: rows.length,
        valid: false,
        brokenAtId: row.id,
        brokenAtTime: row.created_at,
        reason: "prev_hash ไม่ต่อเนื่องกับแถวก่อนหน้า (อาจมีแถวถูกลบ)",
      };
    }
    if (row.entry_hash !== expected) {
      return {
        total: rows.length,
        valid: false,
        brokenAtId: row.id,
        brokenAtTime: row.created_at,
        reason: "entry_hash ไม่ตรงกับเนื้อหาของแถว (แถวถูกแก้ไขหลังบันทึก)",
      };
    }
    prevHash = row.entry_hash;
  }
  return { total: rows.length, valid: true };
}

/**
 * ลบ log ที่เกินระยะเก็บ — บังคับใช้อย่างน้อย 90 วันเสมอ
 * (คืนจำนวนแถวที่ลบ)
 */
export async function purgeExpiredLogs(entityType: "security_log" | "audit_log"): Promise<number> {
  let retainDays = MIN_LOG_RETENTION_DAYS;
  try {
    const policy = await db("retention_policies").where({ entity_type: entityType }).first();
    if (policy?.retain_days) retainDays = Math.max(Number(policy.retain_days), MIN_LOG_RETENTION_DAYS);
  } catch {
    // ไม่มี policy ก็ใช้ค่าขั้นต่ำตามกฎหมาย
  }
  const deleted = await db(entityType === "security_log" ? "security_logs" : "audit_logs")
    .where("created_at", "<", new Date(Date.now() - retainDays * 86400_000))
    .del();
  return deleted;
}

/** รันสายตรวจ log: ตรวจ chain ทุกชั่วโมง + ลบ log หมดอายุทุกวัน */
export function startLogMaintenance(): void {
  const hourly = setInterval(
    () => {
      void verifyLogChain()
        .then((result) => {
          if (!result.valid) {
            console.error("[SecurityLog] INTEGRITY FAILURE:", result);
            return writeSecurityLog({
              eventType: "log.integrity_failed",
              severity: "error",
              detail: { total: result.total, reason: result.reason, brokenAtId: result.brokenAtId },
            });
          }
        })
        .catch((err) => console.error("[SecurityLog] verify error:", err));
    },
    60 * 60 * 1000,
  );
  hourly.unref?.();

  const daily = setInterval(
    () => {
      void purgeExpiredLogs("security_log")
        .then((n) => {
          if (n > 0) console.log(`[SecurityLog] purged ${n} expired rows (retention ≥ ${MIN_LOG_RETENTION_DAYS}d)`);
        })
        .catch((err) => console.error("[SecurityLog] purge error:", err));
      void purgeExpiredLogs("audit_log").catch(() => undefined);
    },
    24 * 60 * 60 * 1000,
  );
  daily.unref?.();

  // รันรอบแรกหลังเปิดระบบ 5 นาที (เว้นช่วง boot ที่ DB ยัง migrate)
  setTimeout(
    () => {
      void purgeExpiredLogs("security_log").catch(() => undefined);
      void purgeExpiredLogs("audit_log").catch(() => undefined);
    },
    5 * 60 * 1000,
  ).unref?.();

  console.log("[SecurityLog] maintenance started (verify hourly, purge daily, retention ≥ 90 days)");
}

/** ดึง IP ผู้เรียกจริง — รองรับการอยู่หลัง reverse proxy (Nginx/Docker) */
export function getClientIp(headers: Headers | Record<string, unknown> | undefined): string | null {
  if (!headers) return null;
  const read = (name: string): string => {
    if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? "";
    return String((headers as Record<string, unknown>)[name] ?? "");
  };
  const xff = read("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return read("x-real-ip") || read("cf-connecting-ip") || null;
}

/** ตัดสินใจ severity จาก status code ของ access log */
export function severityFromStatus(status: number | undefined | null): LogSeverity {
  if (!status) return "info";
  if (status >= 500) return "error";
  if (status === 401 || status === 403) return "warning";
  return "info";
}
