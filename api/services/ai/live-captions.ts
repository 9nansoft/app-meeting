/**
 * กระจายข้อความถอดเสียงสดให้ทุกคนที่เปิดหน้า live ของการประชุม (WebSocket /ws/live-captions)
 * และจอ TV หน้าห้อง (/ws/display-captions)
 *
 *   ผู้บันทึก ──เสียง──▶ /ws/live-asr ──▶ LiveAsrSession ──partial/final──▶ hub นี้ ──▶ ผู้ชมทุกคน (รวมผู้บันทึก)
 *                                                                          │
 *                                                       Valkey pub/sub ◀───┴───▶ hub ของ instance อื่น ──▶ ผู้ชมที่ต่อ instance นั้น
 *
 * - instance ที่มีผู้บันทึกจัดการในเครื่องก่อน แล้ว publish ให้ instance อื่น (pubsub.ts) — Valkey ล่มก็ยังใช้ได้ใน instance เดียว
 * - ข้อความ final เก็บใน Valkey list ต่อการประชุม (30 นาที/500 บรรทัด) — ผู้ชมที่ต่อ instance อื่น
 *   หรือ instance ที่เพิ่งรีสตาร์ตยังเห็นข้อความย้อนหลัง; ไม่ตั้ง REDIS_URL → เก็บในหน่วยความจำอย่างเดียว
 * - ไม่บันทึกลง DB — หน้าเว็บเอาข้อความที่ transcript จริงครอบคลุมแล้วออกเอง
 * - session ของ instance อื่นถูกยืนยันด้วย heartbeat ทุก 30 วินาที ถ้า instance นั้นตายไป
 *   badge "ถอดเสียงสด" จะหายเองภายใน ~75 วินาที
 */
import { INSTANCE_ID, isPubSubEnabled, onEvent, publishEvent, redisCommand } from "../pubsub";

export interface CaptionLine {
  /** ไม่ซ้ำข้าม instance: <เวลา ms>-<instance>-<ลำดับ> */
  id: string;
  /** เวลาที่ server ได้ข้อความ (ISO) — ใช้เทียบกับ meeting_recordings.ended_at */
  at: string;
  text: string;
  session: string;
}

export interface CaptionSession {
  session: string;
  /** ชื่อผู้บันทึก */
  by: string;
}

/** ข้อความที่ส่งให้ผู้ชม */
export type CaptionEvent =
  | { type: "snapshot"; lines: CaptionLine[]; sessions: CaptionSession[]; partials: Array<{ session: string; text: string }> }
  | { type: "session"; session: string; by: string; active: boolean }
  | { type: "partial"; session: string; text: string }
  | { type: "final"; line: CaptionLine };

type Listener = (json: string) => void;

interface Channel {
  listeners: Set<Listener>;
  lines: CaptionLine[];
  sessions: Map<string, string>;
  partials: Map<string, string>;
  /** session ของ instance อื่น → เวลาที่ได้ข่าวล่าสุด */
  remoteSeen: Map<string, number>;
}

/** เก็บย้อนหลังพอให้ครอบคลุมไฟล์เสียง 5 นาที + เวลารอคิวถอดเสียง */
const KEEP_MS = 30 * 60 * 1000;
const KEEP_LINES = 500;
const HEARTBEAT_MS = 30_000;
const REMOTE_SESSION_TTL_MS = 75_000;
const PUBSUB_TYPE = "caption";
const listKey = (meetingId: string) => `app-meeting:captions:${meetingId}`;

const channels = new Map<string, Channel>();
/** session ที่ผู้บันทึกต่ออยู่กับ instance นี้ — ส่ง heartbeat ให้ instance อื่น */
const ownSessions = new Map<string, { meetingId: string; by: string }>();
let seq = 0;

function channel(meetingId: string): Channel {
  let ch = channels.get(meetingId);
  if (!ch) {
    ch = { listeners: new Set(), lines: [], sessions: new Map(), partials: new Map(), remoteSeen: new Map() };
    channels.set(meetingId, ch);
  }
  return ch;
}

function prune(meetingId: string, ch: Channel): void {
  const cutoff = Date.now() - KEEP_MS;
  while (ch.lines.length && (ch.lines.length > KEEP_LINES || Date.parse(ch.lines[0]!.at) < cutoff)) ch.lines.shift();
  if (!ch.listeners.size && !ch.sessions.size && !ch.lines.length) channels.delete(meetingId);
}

function broadcast(ch: Channel, ev: CaptionEvent): void {
  const json = JSON.stringify(ev);
  for (const send of ch.listeners) {
    try {
      send(json);
    } catch {
      /* ผู้ชมปิดไปแล้ว — ลบตอน unsubscribe */
    }
  }
}

function byTime(a: CaptionLine, b: CaptionLine): number {
  return a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/* ---------------- ใช้ event กับ hub ในเครื่อง (ทั้งของตัวเองและที่มาจาก instance อื่น) ---------------- */

type HubEvent = Exclude<CaptionEvent, { type: "snapshot" }>;

function apply(meetingId: string, ev: HubEvent, remote: boolean): void {
  // event จาก instance อื่น: สนใจเฉพาะการประชุมที่มีผู้ชมต่อ instance นี้อยู่
  const ch = remote ? channels.get(meetingId) : channel(meetingId);
  if (!ch) return;
  const session = ev.type === "final" ? ev.line.session : ev.session;
  if (remote) ch.remoteSeen.set(session, Date.now());

  if (ev.type === "session") {
    if (ev.active) {
      const known = ch.sessions.has(session);
      ch.sessions.set(session, ev.by);
      if (known) return; // heartbeat — ไม่ต้องแจ้งผู้ชมซ้ำ
    } else {
      ch.sessions.delete(session);
      ch.partials.delete(session);
      ch.remoteSeen.delete(session);
    }
    broadcast(ch, ev);
    prune(meetingId, ch);
    return;
  }
  if (remote && !ch.sessions.has(session)) ch.sessions.set(session, "");
  if (ev.type === "partial") {
    ch.partials.set(session, ev.text);
    broadcast(ch, ev);
    return;
  }
  ch.partials.delete(session);
  if (!ch.lines.some((l) => l.id === ev.line.id)) {
    ch.lines.push(ev.line);
    broadcast(ch, ev);
  }
  prune(meetingId, ch);
}

function emit(meetingId: string, ev: HubEvent): void {
  apply(meetingId, ev, false);
  publishEvent(PUBSUB_TYPE, { meetingId, ev });
}

onEvent(PUBSUB_TYPE, (data: { meetingId?: string; ev?: HubEvent }) => {
  if (typeof data?.meetingId === "string" && data.ev) apply(data.meetingId, data.ev, true);
});

/* ---------------- heartbeat / หมดอายุ session ของ instance อื่น ---------------- */

if (isPubSubEnabled()) {
  const timer = setInterval(() => {
    for (const [session, s] of ownSessions) {
      publishEvent(PUBSUB_TYPE, { meetingId: s.meetingId, ev: { type: "session", session, by: s.by, active: true } });
    }
    const expired = Date.now() - REMOTE_SESSION_TTL_MS;
    for (const [meetingId, ch] of channels) {
      for (const [session, seen] of ch.remoteSeen) {
        if (seen < expired) apply(meetingId, { type: "session", session, by: ch.sessions.get(session) ?? "", active: false }, false);
      }
    }
  }, HEARTBEAT_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
}

/* ---------------- API สำหรับผู้บันทึก (server/routes/ws/live-asr.ts) ---------------- */

export function captionSessionStarted(meetingId: string, session: string, by: string): void {
  ownSessions.set(session, { meetingId, by });
  emit(meetingId, { type: "session", session, by, active: true });
}

export function captionPartial(meetingId: string, session: string, text: string): void {
  emit(meetingId, { type: "partial", session, text });
}

export function captionFinal(meetingId: string, session: string, text: string): void {
  if (!text) {
    emit(meetingId, { type: "partial", session, text: "" });
    return;
  }
  const line: CaptionLine = {
    id: `${Date.now()}-${INSTANCE_ID}-${++seq}`,
    at: new Date().toISOString(),
    text,
    session,
  };
  emit(meetingId, { type: "final", line });
  // เก็บย้อนหลังใน Valkey ให้ instance อื่น/ที่เพิ่งรีสตาร์ตส่ง snapshot ได้
  if (isPubSubEnabled()) {
    const key = listKey(meetingId);
    void redisCommand("RPUSH", [key, JSON.stringify(line)])
      .then(() => redisCommand("LTRIM", [key, String(-KEEP_LINES), "-1"]))
      .then(() => redisCommand("PEXPIRE", [key, String(KEEP_MS)]));
  }
}

export function captionSessionEnded(meetingId: string, session: string): void {
  const by = ownSessions.get(session)?.by ?? "";
  ownSessions.delete(session);
  emit(meetingId, { type: "session", session, by, active: false });
}

/* ---------------- API สำหรับผู้ชม ---------------- */

/** ข้อความย้อนหลังจาก Valkey รวมกับที่มีในเครื่อง (ไม่ซ้ำ id) */
async function loadBacklog(meetingId: string, ch: Channel): Promise<void> {
  if (!isPubSubEnabled()) return;
  const raw = await redisCommand("LRANGE", [listKey(meetingId), "0", "-1"]);
  if (!Array.isArray(raw) || !raw.length) return;
  const known = new Set(ch.lines.map((l) => l.id));
  const cutoff = new Date(Date.now() - KEEP_MS).toISOString();
  for (const item of raw) {
    try {
      const line = JSON.parse(String(item)) as CaptionLine;
      if (line?.id && line.at >= cutoff && !known.has(line.id)) {
        ch.lines.push(line);
        known.add(line.id);
      }
    } catch {
      /* ข้ามรายการที่เสีย */
    }
  }
  ch.lines.sort(byTime);
}

/**
 * รับข้อความสดของการประชุม — ส่ง snapshot (รวมข้อความย้อนหลังจาก Valkey) แล้วตามด้วย event ใหม่
 * event ที่เกิดระหว่างรอ Valkey จะถูกพักไว้แล้วส่งหลัง snapshot (ผู้รับข้าม final ที่ id ซ้ำ)
 */
export function subscribeCaptions(meetingId: string, send: Listener): () => void {
  const ch = channel(meetingId);
  let ready = false;
  let closed = false;
  const queued: string[] = [];
  const listener: Listener = (json) => {
    if (ready) send(json);
    else queued.push(json);
  };
  ch.listeners.add(listener);

  void loadBacklog(meetingId, ch)
    .catch(() => undefined)
    .finally(() => {
      if (closed) return;
      prune(meetingId, ch);
      send(
        JSON.stringify({
          type: "snapshot",
          lines: ch.lines,
          sessions: [...ch.sessions].map(([session, by]) => ({ session, by })),
          partials: [...ch.partials].map(([session, text]) => ({ session, text })),
        } satisfies CaptionEvent),
      );
      ready = true;
      for (const json of queued.splice(0)) send(json);
    });

  return () => {
    closed = true;
    ch.listeners.delete(listener);
    prune(meetingId, ch);
  };
}

/** สำหรับทดสอบ */
export function _captionChannelCount(): number {
  return channels.size;
}
