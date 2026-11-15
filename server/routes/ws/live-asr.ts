import { randomUUID } from "node:crypto";
import { defineWebSocketHandler } from "h3";
import { LiveAsrSession, isLiveAsrEnabled, liveAsrSlotsAvailable } from "../../../api/services/ai/live-asr";
import {
  captionFinal,
  captionPartial,
  captionSessionEnded,
  captionSessionStarted,
} from "../../../api/services/ai/live-captions";
import { authorizeMeetingUpgrade, logWsSession, rejectUpgrade, type WsMeetingContext } from "../../utils/ws-auth";

/**
 * WebSocket ส่งเสียงไปถอดสด (ผู้บันทึก): /ws/live-asr?meetingId=<uuid>
 *
 *   client → server  binary = PCM16 LE 16kHz mono, text "end" = หยุดแล้วขอข้อความช่วงสุดท้าย
 *   server → client  JSON LiveEvent (ready | partial | final | done | error)
 *
 * partial/final ถูกกระจายให้ทุกคนที่เปิดหน้า live ผ่าน /ws/live-captions ด้วย (รวมผู้บันทึกเอง)
 */

const PATH = "/ws/live-asr";

interface PeerState {
  ctx: WsMeetingContext;
  session: LiveAsrSession;
  captionId: string;
}
const peers = new Map<string, PeerState>();

export default defineWebSocketHandler({
  async upgrade(request) {
    if (!isLiveAsrEnabled()) return rejectUpgrade(503, "ยังไม่ได้ตั้งค่า OPENTHAI_ASR_URL");
    const result = await authorizeMeetingUpgrade(request, PATH);
    if (result instanceof Response) return result;
    if (!liveAsrSlotsAvailable()) return rejectUpgrade(503, "การถอดเสียงสดเต็มจำนวนที่รองรับ — ลองใหม่ภายหลัง");
    Object.assign(request.context, { ws: result });
  },

  open(peer) {
    const ctx = (peer.context as { ws: WsMeetingContext }).ws;
    const captionId = randomUUID();
    const session = new LiveAsrSession(
      {
        send: (message) => peer.send(message),
        close: (code, reason) => peer.close(code, reason),
      },
      undefined,
      (ev) => {
        if (ev.type === "partial") captionPartial(ctx.meetingId, captionId, ev.text);
        else if (ev.type === "final") captionFinal(ctx.meetingId, captionId, ev.text);
      },
    );
    peers.set(peer.id, { ctx, session, captionId });
    captionSessionStarted(ctx.meetingId, captionId, ctx.name);
    session.start();
  },

  message(peer, message) {
    const state = peers.get(peer.id);
    if (!state) return;
    if (typeof message.rawData === "string") {
      if (message.rawData.trim() === "end") state.session.end();
      return;
    }
    state.session.pushAudio(message.uint8Array());
  },

  close(peer) {
    const state = peers.get(peer.id);
    if (!state) return;
    peers.delete(peer.id);
    state.session.dispose();
    captionSessionEnded(state.ctx.meetingId, state.captionId);
    logWsSession(PATH, state.ctx, state.session.startedAt, {
      audioSeconds: Math.round(state.session.audioSeconds),
      utterances: state.session.finals,
    });
  },

  error(peer, error) {
    console.warn("[ASR] live websocket error:", error?.message || error);
    peers.get(peer.id)?.session.dispose();
  },
});
