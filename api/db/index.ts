import knex, { type Knex } from "knex";
import crypto from "node:crypto";
import dayjs from "dayjs";
import pg from "pg";

let schemaPromise: Promise<void> | null = null;

/**
 * สร้าง/ตรวจสอบ schema ทั้งระบบครั้งเดียวต่อ process
 * (memoize — route ต่าง ๆ เรียกซ้ำได้โดยไม่เป็นภาระฐานข้อมูล)
 */
export function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = import("./schema")
      .then((m) => m.ensureSchema())
      .then(() => {
        console.log("[Knex] Schema ready (AI Smart Meeting).");
      })
      .catch((err) => {
        console.error("[Knex] Error ensuring schema:", err);
        schemaPromise = null;
        throw err;
      });
  }
  return schemaPromise;
}

export const pgTypes = pg.types;

const parseDt = function (val: string | null) {
  return val === null ? null : dayjs(val).format("YYYY-MM-DD");
};

const parseFn = function (val: string | null) {
  return val === null ? null : dayjs(val).format("YYYY-MM-DD HH:mm:ss");
};

pgTypes.setTypeParser(pgTypes.builtins.DATE, parseDt);
pgTypes.setTypeParser(pgTypes.builtins.TIMESTAMPTZ, parseFn);
pgTypes.setTypeParser(pgTypes.builtins.TIMESTAMP, parseFn);
pgTypes.setTypeParser(pgTypes.builtins.INT8, (val: string) => (val === null ? null : parseInt(val, 10)));
pgTypes.setTypeParser(pgTypes.builtins.NUMERIC, (val: string) => (val === null ? null : parseFloat(val)));

export const getDbConfig = (): Knex.Config => {
  const connection = process.env.DATABASE_URL || {
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "es_nuxt",
  };

  return {
    client: "pg",
    connection,
    pool: {
      min: 2,
      max: 10,
    },
  };
};

export const db = knex(getDbConfig());

export async function checkDb(): Promise<{ ok: boolean; message?: string }> {
  try {
    await db.raw("SELECT 1 AS ok");
    return { ok: true };
  } catch (err: any) {
    return { ok: false, message: err?.message || String(err) };
  }
}

export interface DbUser {
  id: number;
  username: string;
  password: string;
  role: string;
  name?: string | null;
  position?: string | null;
  email?: string | null;
  is_active?: boolean;
  doctorcode?: string | null;
  depcode?: string | null;
  group_id?: number | null;
  created_at?: string | Date;
  updated_at?: string | Date;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const derivedKey = crypto.scryptSync(password, salt, 64);
  return `${salt}:${derivedKey.toString("hex")}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  if (!storedHash) return false;
  // If stored as salt:key format
  if (storedHash.includes(":")) {
    const [salt, key] = storedHash.split(":");
    if (!salt || !key) return false;
    const derivedKey = crypto.scryptSync(password, salt, 64);
    try {
      return crypto.timingSafeEqual(Buffer.from(key, "hex"), derivedKey);
    } catch {
      return false;
    }
  }
  // ข้อมูลเก่าที่เก็บรหัสเป็น plaintext — เทียบแบบ constant-time
  // (login สำเร็จแล้วระบบจะ re-hash ทันที ดู passwordNeedsRehash)
  const a = crypto.createHash("sha256").update(password).digest();
  const b = crypto.createHash("sha256").update(storedHash).digest();
  return crypto.timingSafeEqual(a, b);
}

/** รหัสผ่านที่เก็บแบบเก่า (plaintext) ต้องแปลงเป็น scrypt hash */
export function passwordNeedsRehash(storedHash: string): boolean {
  return !storedHash.includes(":");
}

/** hash หลอกสำหรับกรณีไม่พบ username — ให้เวลาตอบสนองเท่ากับกรณีรหัสผิด (กัน user enumeration) */
export const DUMMY_PASSWORD_HASH = hashPassword(crypto.randomBytes(16).toString("hex"));

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 256;

/** ตรวจนโยบายรหัสผ่าน — คืนข้อความ error หรือ null ถ้าผ่าน */
export function validatePasswordPolicy(password: string, username?: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `รหัสผ่านต้องมีความยาวอย่างน้อย ${PASSWORD_MIN_LENGTH} ตัวอักษร`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `รหัสผ่านต้องยาวไม่เกิน ${PASSWORD_MAX_LENGTH} ตัวอักษร`;
  }
  const lowered = password.toLowerCase();
  if (["password", "12345678", "123456789", "qwerty123", "11111111"].includes(lowered)) {
    return "รหัสผ่านนี้คาดเดาง่ายเกินไป";
  }
  if (username && lowered === username.toLowerCase()) {
    return "รหัสผ่านต้องไม่เหมือนชื่อผู้ใช้";
  }
  return null;
}

/** สุ่มรหัสผ่านที่แข็งแรง (ใช้กับบัญชีเริ่มต้น/บัญชีที่ admin สร้างโดยไม่ระบุรหัส) */
export function generateStrongPassword(): string {
  return crypto.randomBytes(12).toString("base64url");
}
