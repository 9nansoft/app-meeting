import knex, { type Knex } from "knex";
import crypto from "node:crypto";
import dayjs from "dayjs";
import pg from "pg";

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

let schemaEnsured = false;
let schemaPromise: Promise<void> | null = null;

export async function ensureSchema(): Promise<void> {
  if (schemaEnsured) return;
  if (schemaPromise) return schemaPromise;

  schemaPromise = (async () => {
    try {
      const hasTable = await db.schema.hasTable("users");
      if (!hasTable) {
        console.log("[Knex] Creating 'users' table in PostgreSQL...");
        await db.schema.createTable("users", (table) => {
          table.increments("id").primary();
          table.string("username", 100).notNullable().unique();
          table.string("password", 255).notNullable();
          table.string("role", 50).notNullable().defaultTo("user");
          table.string("name", 255).nullable();
          table.string("doctorcode", 50).nullable();
          table.string("depcode", 50).nullable();
          table.integer("group_id").nullable();
          table.timestamp("created_at").defaultTo(db.fn.now());
          table.timestamp("updated_at").defaultTo(db.fn.now());
        });
        console.log("[Knex] 'users' table created successfully.");
      }

      // Check if table is empty, seed default users
      const countResult = await db("users").count<{ count: string | number }>("id as count").first();
      const count = Number(countResult?.count || 0);

      if (count === 0) {
        console.log("[Knex] Seeding initial admin and demo users...");
        await db("users").insert([
          {
            username: "admin",
            password: hashPassword("password"),
            role: "admin",
            name: "Administrator",
          },
          {
            username: "demo",
            password: hashPassword("password"),
            role: "user",
            name: "Demo User",
          },
        ]);
        console.log("[Knex] Initial users seeded successfully.");
      }

      schemaEnsured = true;
    } catch (err) {
      console.error("[Knex] Error ensuring schema:", err);
    }
  })();

  return schemaPromise;
}
