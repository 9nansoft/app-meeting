import { defineWebSocketHandler } from "h3";
import { isLiveAsrEnabled } from "../../../api/services/ai/live-asr";
import { subscribeCaptions } from "../../../api/services/ai/live-captions";
import { authorizeMeetingUpgrade, logWsSession, rejectUpgrade, type WsMeetingContext } from "../../utils/ws-auth";

/**
 * WebSocket รับข้อความถอดเสียงสด (ผู้ชมทุกคนที่มีสิทธิ์ดูการประชุม): /ws/live-captions?meetingId=<uuid>
 *
 *   server → client  JSON CaptionEvent (snapshot | session | partial | final)
 *   client → server  ไม่รับข้อความใด ๆ (ส่งมาจะถูกปิด)
 */

const PATH = "/ws/live-captions";

interface PeerState {
  ctx: WsMeetingContext;
  unsubscribe: () => void;
  startedAt: number;
}
const peers = new Map<string, PeerState>();

export default defineWebSocketHandler({
  async upgrade(request) {
    if (!isLiveAsrEnabled()) return rejectUpgrade(503, "ยังไม่ได้ตั้งค่า OPENTHAI_ASR_URL");
    const result = await authorizeMeetingUpgrade(request, PATH);
    if (result instanceof Response) return result;
    Object.assign(request.context, { ws: result });
  },

  open(peer) {
    const ctx = (peer.context as { ws: WsMeetingContext }).ws;
    const unsubscribe = subscribeCaptions(ctx.meetingId, (json) => peer.send(json));
    peers.set(peer.id, { ctx, unsubscribe, startedAt: Date.now() });
  },

  message(peer) {
    peer.close(1008, "read-only");
  },

  close(peer) {
    const state = peers.get(peer.id);
    if (!state) return;
    peers.delete(peer.id);
    state.unsubscribe();
    logWsSession(PATH, state.ctx, state.startedAt);
  },

  error(peer, error) {
    console.warn("[ASR] live-captions websocket error:", error?.message || error);
    const state = peers.get(peer.id);
    if (state) {
      peers.delete(peer.id);
      state.unsubscribe();
    }
  },
});
