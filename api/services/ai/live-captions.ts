/**
 * กระจายข้อความถอดเสียงสดให้ทุกคนที่เปิดหน้า live ของการประชุม (WebSocket /ws/live-captions)
 *
 *   ผู้บันทึก ──เสียง──▶ /ws/live-asr ──▶ LiveAsrSession ──partial/final──▶ hub นี้ ──▶ ผู้ชมทุกคน (รวมผู้บันทึก)
 *
 * เก็บข้อความ final ล่าสุดไว้ในหน่วยความจำ (ไม่ลง DB) ให้คนที่เข้าหน้าทีหลังเห็นย้อนหลัง
 * จนกว่าไฟล์เสียงช่วงนั้นจะถอดเสร็จ — หน้าเว็บเอาข้อความที่ transcript จริงครอบคลุมแล้วออกเอง
 *
 * ข้อจำกัด: hub อยู่ใน process เดียว — ถ้ารันแอปหลาย instance ผู้ชมต้องต่อ instance เดียวกับผู้บันทึก
 * (ขยายด้วย Valkey pub/sub ได้ภายหลัง — docker-compose ปัจจุบันรันแอป instance เดียว)
 */

export interface CaptionLine {
  id: number;
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
}

/** เก็บย้อนหลังพอให้ครอบคลุมไฟล์เสียง 5 นาที + เวลารอคิวถอดเสียง */
const KEEP_MS = 30 * 60 * 1000;
const KEEP_LINES = 500;

const channels = new Map<string, Channel>();
let nextLineId = 1;

function channel(meetingId: string): Channel {
  let ch = channels.get(meetingId);
  if (!ch) {
    ch = { listeners: new Set(), lines: [], sessions: new Map(), partials: new Map() };
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

export function captionSessionStarted(meetingId: string, session: string, by: string): void {
  const ch = channel(meetingId);
  ch.sessions.set(session, by);
  broadcast(ch, { type: "session", session, by, active: true });
}

export function captionPartial(meetingId: string, session: string, text: string): void {
  const ch = channels.get(meetingId);
  if (!ch) return;
  ch.partials.set(session, text);
  broadcast(ch, { type: "partial", session, text });
}

export function captionFinal(meetingId: string, session: string, text: string): void {
  const ch = channels.get(meetingId);
  if (!ch) return;
  ch.partials.delete(session);
  if (!text) {
    broadcast(ch, { type: "partial", session, text: "" });
    return;
  }
  const line: CaptionLine = { id: nextLineId++, at: new Date().toISOString(), text, session };
  ch.lines.push(line);
  broadcast(ch, { type: "final", line });
  prune(meetingId, ch);
}

export function captionSessionEnded(meetingId: string, session: string): void {
  const ch = channels.get(meetingId);
  if (!ch) return;
  const by = ch.sessions.get(session) ?? "";
  ch.sessions.delete(session);
  ch.partials.delete(session);
  broadcast(ch, { type: "session", session, by, active: false });
  prune(meetingId, ch);
}

/** รับข้อความสดของการประชุม — ส่ง snapshot ทันที แล้วคืนฟังก์ชันยกเลิก */
export function subscribeCaptions(meetingId: string, send: Listener): () => void {
  const ch = channel(meetingId);
  ch.listeners.add(send);
  prune(meetingId, ch);
  send(
    JSON.stringify({
      type: "snapshot",
      lines: ch.lines,
      sessions: [...ch.sessions].map(([session, by]) => ({ session, by })),
      partials: [...ch.partials].map(([session, text]) => ({ session, text })),
    } satisfies CaptionEvent),
  );
  return () => {
    ch.listeners.delete(send);
    prune(meetingId, ch);
  };
}

/** สำหรับทดสอบ */
export function _captionChannelCount(): number {
  return channels.size;
}
