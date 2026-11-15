import { randomUUID } from "node:crypto";

/**
 * Pub/sub ข้าม instance ผ่าน Valkey (REDIS_URL) — ใช้กับข้อความถอดเสียงสดและการแจ้งจอ TV
 *
 * - ไม่ตั้ง REDIS_URL หรือ runtime ไม่ใช่ Bun → ทุกฟังก์ชันไม่ทำอะไร (ทำงานใน process เดียวเหมือนเดิม)
 * - ผู้ส่งจัดการข้อมูลในเครื่องตัวเองก่อนเสมอ แล้วค่อย publish ให้ instance อื่น
 *   (ข้อความที่ส่งจาก instance ตัวเองจะถูกข้ามตอนรับ) → Valkey ล่มก็ไม่กระทบผู้ใช้ใน instance เดียวกัน
 * - ใช้ connection แยก 2 เส้น: subscriber (โหมด subscribe ส่งคำสั่งอื่นไม่ได้) และ command (publish/list)
 *   subscriber ไม่ใช้ autoReconnect ของ Bun — ต่อใหม่เองแล้ว subscribe ซ้ำ เพื่อให้แน่ใจว่ากลับมารับข้อความได้
 *
 * ใช้ Bun.RedisClient ที่มากับ Bun เหมือน ratelimit.ts — ไม่ต้องเพิ่ม dependency
 */

export const INSTANCE_ID = randomUUID().slice(0, 8);
const CHANNEL = process.env.PUBSUB_CHANNEL || "app-meeting:events";
const COMMAND_TIMEOUT_MS = 1_000;
/** เรียก Valkey ไม่สำเร็จ → ข้ามไปก่อนช่วงหนึ่ง ไม่ให้ทุกคำขอต้องรอ timeout (เช่น snapshot ของผู้ชม) */
const DOWN_BACKOFF_MS = 10_000;
const RESUBSCRIBE_DELAY_MS = 3_000;

interface RedisLike {
  connect(): Promise<void>;
  send(command: string, args: string[]): Promise<unknown>;
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string, listener: (message: string, channel: string) => void): Promise<number>;
  close(): void;
  readonly connected: boolean;
  onclose: ((error: Error) => void) | null;
}

type RedisCtor = new (url: string, opts?: object) => RedisLike;

function redisCtor(): RedisCtor | null {
  // ใช้ผ่าน globalThis เพื่อไม่ให้ bundler ต้อง resolve โมดูล "bun" (รันบน Node ได้ — จะปิด pub/sub)
  return (globalThis as { Bun?: { RedisClient?: RedisCtor } }).Bun?.RedisClient ?? null;
}

export function isPubSubEnabled(): boolean {
  return Boolean(process.env.REDIS_URL && redisCtor());
}

function withTimeout<T>(p: Promise<T>, ms = COMMAND_TIMEOUT_MS): Promise<T> {
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

/** log ไม่เกินครั้งละ 1 นาทีต่อประเภท ไม่ให้ Valkey ล่มแล้ว log ท่วม */
const lastWarn = new Map<string, number>();
function warnThrottled(kind: string, err: unknown) {
  const now = Date.now();
  if ((lastWarn.get(kind) ?? 0) + 60_000 > now) return;
  lastWarn.set(kind, now);
  console.warn(`[PubSub] ${kind}:`, err instanceof Error ? err.message : err);
}

/* ---------------- command connection (publish + list) ---------------- */

let command: RedisLike | null = null;
let connecting: Promise<void> | null = null;
let downUntil = 0;

function markDown(kind: string, err: unknown) {
  downUntil = Date.now() + DOWN_BACKOFF_MS;
  warnThrottled(kind, err);
}

/**
 * คืน client เฉพาะเมื่อต่ออยู่แล้ว — ยังไม่ได้ต่อ/หลุดอยู่: เริ่มต่อเบื้องหลังแล้วคืน null ทันที
 * คำขอของผู้ใช้จึงไม่ต้องรอ Valkey (ข้ามไปใช้ข้อมูลในเครื่อง) ระหว่างที่ Valkey ล่มหรือกำลังต่อใหม่
 */
function commandClient(): RedisLike | null {
  if (!isPubSubEnabled() || Date.now() < downUntil) return null;
  if (!command) {
    const Ctor = redisCtor()!;
    command = new Ctor(process.env.REDIS_URL!, {
      connectionTimeout: 2_000,
      autoReconnect: true,
      maxRetries: 1_000_000,
      enableOfflineQueue: false,
    });
  }
  if (command.connected) return command;
  connecting ??= withTimeout(command.connect(), 3_000)
    .catch((err) => markDown("connect failed", err))
    .finally(() => {
      connecting = null;
    });
  return null;
}

/** ส่งคำสั่ง Valkey — คืน null เมื่อปิดใช้งาน ยังต่อไม่ได้ หรือผิดพลาด (ผู้เรียก fallback เอง) */
export async function redisCommand(cmd: string, args: string[]): Promise<unknown | null> {
  try {
    const c = commandClient();
    if (!c) return null;
    return await withTimeout(c.send(cmd, args));
  } catch (err) {
    markDown(`${cmd} failed`, err);
    return null;
  }
}

/* ---------------- publish / subscribe ---------------- */

type Handler = (data: any) => void;
const handlers = new Map<string, Set<Handler>>();

/** ส่ง event ให้ instance อื่น (ไม่รอผล — ผู้ส่งจัดการในเครื่องตัวเองไปแล้ว) */
export function publishEvent(type: string, data: unknown): void {
  if (!isPubSubEnabled()) return;
  void (async () => {
    try {
      const c = commandClient();
      if (!c) return;
      await withTimeout(c.publish(CHANNEL, JSON.stringify({ src: INSTANCE_ID, type, data })));
    } catch (err) {
      markDown("publish failed", err);
    }
  })();
}

/** รับ event ประเภทนี้จาก instance อื่น */
export function onEvent(type: string, handler: Handler): () => void {
  let set = handlers.get(type);
  if (!set) {
    set = new Set();
    handlers.set(type, set);
  }
  set.add(handler);
  ensureSubscriber();
  return () => set!.delete(handler);
}

function dispatch(message: string) {
  let msg: { src?: string; type?: string; data?: unknown };
  try {
    msg = JSON.parse(message);
  } catch {
    return;
  }
  if (!msg || msg.src === INSTANCE_ID || typeof msg.type !== "string") return;
  for (const handler of handlers.get(msg.type) ?? []) {
    try {
      handler(msg.data);
    } catch (err) {
      warnThrottled(`handler ${msg.type} failed`, err);
    }
  }
}

let subscriber: RedisLike | null = null;
let subscribing = false;
let resubscribeTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleResubscribe() {
  if (resubscribeTimer) return;
  resubscribeTimer = setTimeout(() => {
    resubscribeTimer = null;
    ensureSubscriber();
  }, RESUBSCRIBE_DELAY_MS);
  (resubscribeTimer as unknown as { unref?: () => void }).unref?.();
}

function ensureSubscriber() {
  if (subscriber || subscribing || !isPubSubEnabled()) return;
  subscribing = true;
  const Ctor = redisCtor()!;
  const client = new Ctor(process.env.REDIS_URL!, { connectionTimeout: 2_000, autoReconnect: false });
  client.onclose = (err) => {
    if (subscriber === client) subscriber = null;
    warnThrottled("subscriber disconnected", err);
    scheduleResubscribe();
  };
  withTimeout(client.connect(), 3_000)
    .then(() => withTimeout(client.subscribe(CHANNEL, dispatch), 3_000))
    .then(() => {
      subscriber = client;
      console.log(`[PubSub] instance ${INSTANCE_ID} subscribed to ${CHANNEL}`);
    })
    .catch((err) => {
      warnThrottled("subscribe failed", err);
      try {
        client.close();
      } catch {
        /* ปิดไปแล้ว */
      }
      scheduleResubscribe();
    })
    .finally(() => {
      subscribing = false;
    });
}

// ต่อ Valkey ตั้งแต่โหลดโมดูล — คำขอแรกของผู้ใช้จะได้ไม่ถูกข้ามเพราะยังต่อไม่เสร็จ
if (isPubSubEnabled()) {
  commandClient();
  ensureSubscriber();
}
