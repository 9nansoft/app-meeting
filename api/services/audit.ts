import { db } from "../db";

export interface AuditEntry {
  userId?: number | null;
  username?: string | null;
  action: string; // เช่น meeting.create, document.upload, minutes.publish
  entityType?: string;
  entityId?: string;
  oldValue?: unknown;
  newValue?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}

/** บันทึก audit log — ไม่ throw เมื่อบันทึกไม่สำเร็จ เพื่อไม่ให้กระทบธุรกรรมหลัก */
export async function writeAudit(entry: AuditEntry): Promise<void> {
  try {
    await db("audit_logs").insert({
      user_id: entry.userId ?? null,
      username: entry.username ?? null,
      action: entry.action,
      entity_type: entry.entityType ?? null,
      entity_id: entry.entityId ?? null,
      old_value: entry.oldValue === undefined ? null : JSON.stringify(entry.oldValue),
      new_value: entry.newValue === undefined ? null : JSON.stringify(entry.newValue),
      ip: entry.ip ?? null,
      user_agent: entry.userAgent?.slice(0, 500) ?? null,
    });
  } catch (err) {
    console.error("[Audit] failed to write:", err);
  }
}
