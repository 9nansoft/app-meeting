import { createHash } from "node:crypto";

/**
 * Rate limiter แบบ fixed-window
 * ใช้ป้องกันการเดารหัสผ่าน (brute-force) ที่ /auth/login, /auth/register และกัน spam ที่ /api/csp-report
 *
 * ที่เก็บตัวนับ:
 *   - ตั้ง REDIS_URL  → เก็บใน Redis/Valkey: ทุก instance ของแอปใช้ตัวนับร่วมกัน
 *                        (ใช้ Bun.RedisClient ที่มากับ Bun — ไม่ต้องเพิ่ม dependency)
 *   - ไม่ตั้ง         → เก็บในหน่วยความจำของแต่ละ process (เหมาะกับ instance เดียว)
 *
 * ถ้า Redis ล่ม/ช้า จะ fail-open ไปใช้ตัวนับในหน่วยความจำของ process นั้นแทน
 * (ยังจำกัดได้ต่อ instance และไม่ทำให้ login ใช้งานไม่ได้) แล้วกลับไปใช้ Redis เองเมื่อกลับมา
 *
 * key ใน Redis เป็น SHA-256 ของ username/IP ไม่เก็บค่าจริง (ข้อมูลส่วนบุคคล)
 */

interface CounterState {
  count: number;
  /** มิลลิวินาทีที่เหลือก่อน window หมด */
  ttlMs: number;
}

interface CounterStore {
  increment(key: string, windowMs: number): Promise<CounterState>;
  peek(key: string): Promise<CounterState | null>;
  remove(key: string): Promise<void>;
}

/* ---------- ในหน่วยความจำ ---------- */

class MemoryStore implements CounterStore {
  private buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(sweepEveryMs: number) {
    const sweep = setInterval(() => {
      const now = Date.now();
      for (const [key, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(key);
    }, Math.max(sweepEveryMs, 60_000));
    (sweep as unknown as { unref?: () => void }).unref?.();
  }

  async increment(key: string, windowMs: number): Promise<CounterState> {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, b);
    }
    b.count += 1;
    return { count: b.count, ttlMs: b.resetAt - now };
  }

  async peek(key: string): Promise<CounterState | null> {
    const b = this.buckets.get(key);
    const now = Date.now();
    if (!b || b.resetAt <= now) return null;
    return { count: b.count, ttlMs: b.resetAt - now };
  }

  async remove(key: string): Promise<void> {
    this.buckets.delete(key);
  }
}

/* ---------- Redis / Valkey ---------- */

/** ส่วนของ Bun.RedisClient ที่ใช้ */
interface RedisLike {
  send(command: string, args: string[]): Promise<unknown>;
  connect(): Promise<void>;
  readonly connected: boolean;
  close?(): void;
}

// INCR + ตั้งอายุครั้งแรกแบบ atomic (กัน key ค้างไม่มีวันหมดอายุถ้า process ตายระหว่างสองคำสั่ง)
const INCR_SCRIPT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local t = redis.call('PTTL', KEYS[1])
if t < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); t = tonumber(ARGV[1]) end
return {c, t}`;

const PEEK_SCRIPT = `
local c = redis.call('GET', KEYS[1])
if not c then return {0, -2} end
return {tonumber(c), redis.call('PTTL', KEYS[1])}`;

/** คำสั่ง Redis ต้องตอบภายในเวลานี้ ไม่งั้นถือว่าล่ม (login ไม่ควรค้างรอ Redis) */
const REDIS_TIMEOUT_MS = Number(process.env.REDIS_RATELIMIT_TIMEOUT_MS) || 500;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`redis timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function toPair(reply: unknown): [number, number] {
  if (!Array.isArray(reply) || reply.length < 2) throw new Error("unexpected redis reply");
  return [Number(reply[0]), Number(reply[1])];
}

class RedisStore implements CounterStore {
  private connecting: Promise<void> | null = null;

  constructor(private readonly client: RedisLike) {}

  /**
   * Bun.RedisClient เชื่อมต่อแบบ lazy และเราปิด offline queue ไว้ — ถ้าส่งคำสั่งก่อนต่อเสร็จจะ error ทันที
   * จึงต้องรอ connect() ก่อนทุกครั้งที่ยังไม่ได้เชื่อมต่อ (จำกัดเวลารอด้วย timeout)
   */
  async ready(): Promise<void> {
    if (this.client.connected) return;
    this.connecting ??= this.client.connect().finally(() => {
      this.connecting = null;
    });
    await withTimeout(this.connecting, REDIS_TIMEOUT_MS);
  }

  async increment(key: string, windowMs: number): Promise<CounterState> {
    await this.ready();
    const [count, ttl] = toPair(
      await withTimeout(this.client.send("EVAL", [INCR_SCRIPT, "1", key, String(windowMs)]), REDIS_TIMEOUT_MS),
    );
    return { count, ttlMs: ttl > 0 ? ttl : windowMs };
  }

  async peek(key: string): Promise<CounterState | null> {
    await this.ready();
    const [count, ttl] = toPair(
      await withTimeout(this.client.send("EVAL", [PEEK_SCRIPT, "1", key]), REDIS_TIMEOUT_MS),
    );
    return count > 0 && ttl > 0 ? { count, ttlMs: ttl } : null;
  }

  async remove(key: string): Promise<void> {
    await this.ready();
    await withTimeout(this.client.send("DEL", [key]), REDIS_TIMEOUT_MS);
  }
}

let sharedRedis: RedisStore | null | undefined;

/** สร้าง client ครั้งเดียวต่อ process (คืน null ถ้าไม่ได้ตั้ง REDIS_URL หรือ runtime ไม่ใช่ Bun) */
function getRedisStore(): RedisStore | null {
  if (sharedRedis !== undefined) return sharedRedis;
  const url = process.env.REDIS_URL;
  if (!url) return (sharedRedis = null);
  // ใช้ผ่าน globalThis เพื่อไม่ให้ bundler ต้อง resolve โมดูล "bun" และรันบน Node ได้ (จะ fallback)
  const RedisClient = (globalThis as { Bun?: { RedisClient?: new (url: string, opts?: object) => RedisLike } }).Bun
    ?.RedisClient;
  if (!RedisClient) {
    console.warn("[RateLimit] REDIS_URL is set but Bun.RedisClient is unavailable — using in-memory limiter");
    return (sharedRedis = null);
  }
  const client = new RedisClient(url, {
    connectionTimeout: 2_000,
    autoReconnect: true,
    // ไม่ต่อคิวคำสั่งตอนหลุดการเชื่อมต่อ — ให้ fail เร็วแล้ว fallback แทนการให้ login ค้าง
    enableOfflineQueue: false,
  });
  sharedRedis = new RedisStore(client);
  // เริ่มเชื่อมต่อทันทีตอนบูต ไม่ต้องรอ request แรก
  sharedRedis
    .ready()
    .then(() => console.log("[RateLimit] using Redis for shared rate limiting"))
    .catch((err) => {
      redisSkipUntil = Date.now() + REDIS_RETRY_AFTER_MS;
      warnRedisDown(err);
    });
  return sharedRedis;
}

/** ปิด client (ใช้ในเทสต์) */
export function closeRateLimitRedis(): void {
  const client = (sharedRedis as unknown as { client?: RedisLike } | null)?.client;
  client?.close?.();
  sharedRedis = undefined;
}

/**
 * circuit breaker: เมื่อ Redis ล้มเหลว ข้ามไปใช้หน่วยความจำ 10 วินาทีโดยไม่ลองใหม่
 * (ไม่ให้ทุก request ต้องรอ timeout ระหว่าง Redis ล่ม — client ยัง reconnect เองเบื้องหลัง)
 */
const REDIS_RETRY_AFTER_MS = 10_000;
let redisSkipUntil = 0;

let lastRedisWarnAt = 0;
function warnRedisDown(err: unknown): void {
  // log ไม่เกินนาทีละครั้ง กัน log ท่วมตอน Redis ล่ม
  if (Date.now() - lastRedisWarnAt < 60_000) return;
  lastRedisWarnAt = Date.now();
  console.warn(
    "[RateLimit] Redis unavailable — falling back to in-memory limiter:",
    err instanceof Error ? err.message : err,
  );
}

const KEY_PREFIX = process.env.REDIS_KEY_PREFIX || "app-meeting:rl";

export class RateLimiter {
  private readonly memory: MemoryStore;

  /**
   * @param name     ชื่อ limiter (ใช้แยก namespace ของ key ใน Redis — ต้องไม่ซ้ำกัน)
   * @param limit    จำนวนครั้งสูงสุดต่อ window
   * @param windowMs ความยาว window (มิลลิวินาที)
   */
  constructor(
    readonly name: string,
    private readonly limit: number,
    private readonly windowMs: number,
  ) {
    this.memory = new MemoryStore(windowMs);
  }

  private redisKey(key: string): string {
    const digest = createHash("sha256").update(key).digest("hex").slice(0, 32);
    return `${KEY_PREFIX}:${this.name}:${digest}`;
  }

  /** รันกับ Redis ถ้ามี — ล้มเหลวเมื่อไหร่ใช้ตัวนับในหน่วยความจำแทน */
  private async run<T>(op: (store: CounterStore, key: string) => Promise<T>, key: string): Promise<T> {
    const redis = getRedisStore();
    if (redis && Date.now() >= redisSkipUntil) {
      try {
        return await op(redis, this.redisKey(key));
      } catch (err) {
        redisSkipUntil = Date.now() + REDIS_RETRY_AFTER_MS;
        warnRedisDown(err);
      }
    }
    return op(this.memory, key);
  }

  /** จำนวนวินาทีที่ต้องรอ ถ้าเกินโควตาแล้ว (0 = ยังไม่เกิน) */
  async retryAfter(key: string): Promise<number> {
    const state = await this.run((s, k) => s.peek(k), key);
    if (!state || state.count < this.limit) return 0;
    return Math.max(1, Math.ceil(state.ttlMs / 1000));
  }

  /** นับ 1 ครั้ง แล้วคืนจำนวนครั้งใน window ปัจจุบัน */
  async hit(key: string): Promise<number> {
    const state = await this.run((s, k) => s.increment(k, this.windowMs), key);
    return state.count;
  }

  async reset(key: string): Promise<void> {
    await this.run((s, k) => s.remove(k), key);
  }
}

const WINDOW = 15 * 60 * 1000;

/** login ผิด 5 ครั้งต่อ username+IP ใน 15 นาที → ล็อกชั่วคราว */
export const loginFailuresByAccount = new RateLimiter("login-fail", 5, WINDOW);
/** ความพยายาม login ทั้งหมดต่อ IP (กันการไล่เดาหลาย username) */
export const loginAttemptsByIp = new RateLimiter("login-ip", 30, WINDOW);
/** การสมัครบัญชีต่อ IP (เมื่อเปิด ALLOW_SELF_REGISTER) */
export const registerByIp = new RateLimiter("register-ip", 5, 60 * 60 * 1000);
