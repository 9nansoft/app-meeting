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
  // Plain text fallback (for existing mock/legacy data)
  return password === storedHash;
}
