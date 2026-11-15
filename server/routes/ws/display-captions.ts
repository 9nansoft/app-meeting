import { defineWebSocketHandler } from "h3";
import { isLiveAsrEnabled } from "../../../api/services/ai/live-asr";
import { subscribeCaptions } from "../../../api/services/ai/live-captions";
import { currentDisplayMeeting, onDisplaySync, verifyDisplayKey } from "../../../api/services/display-keys";
import { getClientIp, writeSecurityLog } from "../../../api/services/logger";
import { originAllowed, rejectUpgrade } from "../../utils/ws-auth";

/**
 * WebSocket ข้อความถอดเสียงสดสำหรับจอ TV หน้าห้อง (ไม่ต้อง login): /ws/display-captions?roomId=<uuid>&key=<key>
 *
 * - ยืนยันด้วย key ของห้อง (admin สร้างในหน้าห้องประชุม) แทน session
 * - แสดงเฉพาะการประชุมที่กำลังใช้ห้องอยู่และผู้จัดเปิด "แสดงบนจอหน้าห้อง"
 * - ผู้จัดเปิด/ปิดสวิตช์ หรือ admin สร้าง/ยกเลิก key → server แจ้งจอให้ตรวจใหม่ทันที (onDisplaySync)
 *   และตรวจซ้ำทุก 15 วินาทีเผื่อกรณีที่ไม่มีการแจ้ง (การจองเริ่ม/หมดเวลา)
 * - ไม่ส่งชื่อผู้บันทึก (จออยู่ในที่สาธารณะ)
 *
 *   server → client  { type: "meeting", active } เมื่อเริ่ม/เลิกแสดง ตามด้วย snapshot | session | partial | final
 */

const PATH = "/ws/display-captions";
const RECHECK_MS = 15_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PeerState {
  roomId: string;
  key: string;
  meetingId: string | null;
  unsubscribe: (() => void) | null;
  timer: ReturnType<typeof setInterval> | null;
  offSync: (() => void) | null;
  closed: boolean;
  /** มีการแจ้งระหว่างกำลัง sync อยู่ — sync ซ้ำอีกรอบเมื่อเสร็จ */
  pending: boolean;
  syncing: boolean;
}
const peers = new Map<string, PeerState>();

/** ตัดข้อมูลที่ไม่ควรขึ้นจอสาธารณะ (ชื่อผู้บันทึก) ออกจาก event ของ hub */
function sanitize(json: string): string {
  const ev = JSON.parse(json);
  if (ev.type === "snapshot") {
    return JSON.stringify({
      type: "snapshot",
      lines: ev.lines,
      partials: ev.partials,
      recording: ev.sessions.length > 0,
      sessions: ev.sessions.map((s: { session: string }) => ({ session: s.session, by: "" })),
    });
  }
  if (ev.type === "session") return JSON.stringify({ ...ev, by: "" });
  return json;
}

export default defineWebSocketHandler({
  async upgrade(request) {
    if (!isLiveAsrEnabled()) return rejectUpgrade(503, "ยังไม่ได้ตั้งค่า OPENTHAI_ASR_URL");
    const ip = getClientIp(request.headers);
    const fail = (status: number, reason: string) => {
      void writeSecurityLog({
        eventType: status === 403 ? "access.forbidden" : "http.request",
        severity: "warning",
        ip,
        userAgent: request.headers.get("user-agent"),
        method: "GET",
        path: PATH,
        statusCode: status,
        detail: { reason },
      });
      return rejectUpgrade(status, reason);
    };
    if (!originAllowed(request)) return fail(403, "origin_not_allowed");
    const url = new URL(request.url);
    const roomId = url.searchParams.get("roomId") || "";
    const key = url.searchParams.get("key") || "";
    if (!UUID_RE.test(roomId)) return fail(400, "invalid_room");
    if (!(await verifyDisplayKey(roomId, key))) return fail(403, "invalid_display_key");
    Object.assign(request.context, { roomId, key, ip });
  },

  open(peer) {
    const ctx = peer.context as { roomId: string; key: string };
    const state: PeerState = {
      roomId: ctx.roomId,
      key: ctx.key,
      meetingId: null,
      unsubscribe: null,
      timer: null,
      offSync: null,
      closed: false,
      syncing: false,
      pending: false,
    };
    peers.set(peer.id, state);

    const sync = async () => {
      if (state.closed) return;
      if (state.syncing) {
        state.pending = true;
        return;
      }
      state.syncing = true;
      try {
        do {
          state.pending = false;
          await syncOnce();
        } while (state.pending && !state.closed);
      } finally {
        state.syncing = false;
      }
    };
    const syncOnce = async () => {
      if (!(await verifyDisplayKey(state.roomId, state.key))) {
        peer.close(1008, "display key revoked");
        return;
      }
      const meetingId = await currentDisplayMeeting(state.roomId);
      if (state.closed || meetingId === state.meetingId) return;
      state.unsubscribe?.();
      state.unsubscribe = null;
      state.meetingId = meetingId;
      peer.send(JSON.stringify({ type: "meeting", active: Boolean(meetingId) }));
      if (meetingId) {
        state.unsubscribe = subscribeCaptions(meetingId, (json) => {
          try {
            peer.send(sanitize(json));
          } catch {
            /* จอปิดไปแล้ว */
          }
        });
      }
    };
    void sync();
    state.timer = setInterval(() => void sync(), RECHECK_MS);
    state.offSync = onDisplaySync(state.roomId, () => void sync());
  },

  message(peer) {
    peer.close(1008, "read-only");
  },

  close(peer) {
    const state = peers.get(peer.id);
    if (!state) return;
    peers.delete(peer.id);
    state.closed = true;
    if (state.timer) clearInterval(state.timer);
    state.offSync?.();
    state.unsubscribe?.();
  },

  error(peer) {
    const state = peers.get(peer.id);
    if (!state) return;
    peers.delete(peer.id);
    state.closed = true;
    if (state.timer) clearInterval(state.timer);
    state.offSync?.();
    state.unsubscribe?.();
  },
});
