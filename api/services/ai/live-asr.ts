/**
 * ถอดเสียงสด — ส่งต่อเสียงจากเบราว์เซอร์ไปที่ OpenThai ASR (WS /v1/live) แล้วส่งข้อความกลับ
 *
 *   เบราว์เซอร์ ──PCM16 16kHz mono──▶ server/routes/ws/live-asr.ts ──▶ LiveAsrSession ──▶ DGX /v1/live
 *              ◀──{partial|final}────                                  ◀──────────────
 *
 * เบราว์เซอร์ต่อ DGX ตรงไม่ได้ (server ของ iApp ไม่มี auth และอยู่ในวงภายใน) แอปจึงเป็นตัวกลาง
 * ที่ตรวจ login + สิทธิ์การประชุมก่อน ข้อความสดใช้แสดงผลระหว่างประชุมเท่านั้น ไม่บันทึกลง DB
 * — transcript ที่บันทึกยังมาจากการถอดไฟล์เสียงทุก 5 นาทีตามเดิม
 *
 * ตัวแปรสภาพแวดล้อม (นอกจาก OPENTHAI_ASR_* ใน openthai-asr.ts):
 *   OPENTHAI_LIVE_MAX_SESSIONS — จำนวนการถอดเสียงสดพร้อมกันทั้งระบบ (ค่าเริ่มต้น 4)
 */
import {
  OPENTHAI_ASR_URL,
  OPENTHAI_ASR_MODE,
  OPENTHAI_ASR_LANG,
  OPENTHAI_ASR_LATENCY_MS,
  isOpenThaiAsrConfigured,
  normalizeThai,
} from "./openthai-asr";

export const LIVE_MAX_SESSIONS = Number(process.env.OPENTHAI_LIVE_MAX_SESSIONS) || 4;
/** เฟรมเดียวไม่ควรเกิน 1 วินาทีของเสียง (32KB) — เผื่อไว้ 2 เท่า */
const MAX_FRAME_BYTES = 64 * 1024;
/** เสียงที่พักไว้ระหว่างรอ DGX ตอบ ready (15 วินาที) */
const MAX_PENDING_BYTES = 15 * 16000 * 2;
/** ไม่มีเสียงส่งมาเกินเวลานี้ → ปิด (แท็บค้าง/ไมค์หลุด) */
const IDLE_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 30_000;

let activeSessions = 0;

export function isLiveAsrEnabled(): boolean {
  return isOpenThaiAsrConfigured();
}

export function liveAsrSlotsAvailable(): boolean {
  return activeSessions < LIVE_MAX_SESSIONS;
}

/** ฝั่งเบราว์เซอร์ (crossws peer) — แยกเป็น interface เพื่อทดสอบได้โดยไม่ต้องมี Nitro */
export interface LiveClient {
  send(message: string): void;
  close(code?: number, reason?: string): void;
}

/** ข้อความที่ส่งกลับเบราว์เซอร์ */
export type LiveEvent =
  | { type: "ready" }
  | { type: "partial"; utterance: number; start: number; text: string }
  | { type: "final"; utterance: number; start: number; end: number; text: string }
  | { type: "done"; audioSeconds: number; utterances: number }
  | { type: "error"; message: string };

export function liveUpstreamUrl(base = OPENTHAI_ASR_URL): string {
  return `${base.replace(/^http/i, "ws")}/v1/live`;
}

export class LiveAsrSession {
  private upstream: WebSocket | null = null;
  private ready = false;
  private ended = false;
  private closed = false;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  readonly startedAt = Date.now();
  audioBytes = 0;
  finals = 0;

  /**
   * @param client   เบราว์เซอร์ของผู้บันทึก (ได้ ready/error/done — ข้อความแสดงผลมาทาง listener)
   * @param listener รับ partial/final ไปกระจายให้ผู้ชมทุกคน (live-captions.ts)
   */
  constructor(
    private readonly client: LiveClient,
    private readonly upstreamUrl = liveUpstreamUrl(),
    private readonly listener?: (ev: LiveEvent) => void,
  ) {}

  start(): void {
    activeSessions += 1;
    const headers: Record<string, string> = {};
    if (process.env.OPENTHAI_ASR_TOKEN) headers.Authorization = `Bearer ${process.env.OPENTHAI_ASR_TOKEN}`;
    try {
      // Bun รองรับ headers ใน constructor (Node ไม่รองรับ — ส่งเฉพาะเมื่อมี token)
      const WS = WebSocket as any;
      this.upstream = Object.keys(headers).length ? new WS(this.upstreamUrl, { headers }) : new WS(this.upstreamUrl);
    } catch (err: any) {
      this.fail(`เชื่อมต่อ ASR server ไม่ได้: ${err?.message || err}`);
      return;
    }
    const ws = this.upstream!;
    ws.binaryType = "arraybuffer";
    this.connectTimer = setTimeout(() => this.fail("ASR server ไม่ตอบภายใน 30 วินาที"), CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      ws.send(JSON.stringify({ mode: OPENTHAI_ASR_MODE, lang: OPENTHAI_ASR_LANG, latency_ms: OPENTHAI_ASR_LATENCY_MS }));
    };
    ws.onmessage = (ev) => this.onUpstreamMessage(ev.data);
    ws.onerror = () => this.fail("การเชื่อมต่อกับ ASR server ผิดพลาด");
    ws.onclose = () => {
      if (!this.closed) this.fail(this.ended ? "" : "ASR server ปิดการเชื่อมต่อ");
    };
    this.touch();
  }

  /** เฟรมเสียง PCM16 LE 16kHz mono จากเบราว์เซอร์ */
  pushAudio(frame: Uint8Array): void {
    if (this.closed || this.ended) return;
    if (frame.byteLength === 0) return;
    if (frame.byteLength % 2 || frame.byteLength > MAX_FRAME_BYTES) {
      this.fail("รูปแบบเสียงไม่ถูกต้อง (ต้องเป็น PCM16 ไม่เกิน 64KB ต่อเฟรม)");
      return;
    }
    this.touch();
    this.audioBytes += frame.byteLength;
    if (this.ready) {
      this.upstream!.send(frame);
      return;
    }
    this.pending.push(frame);
    this.pendingBytes += frame.byteLength;
    // DGX ยังโหลดไม่เสร็จ — ทิ้งเสียงเก่าสุดแทนการพักไว้ไม่จำกัด
    while (this.pendingBytes > MAX_PENDING_BYTES && this.pending.length) {
      this.pendingBytes -= this.pending.shift()!.byteLength;
    }
  }

  /** ผู้ใช้หยุดบันทึก — ขอข้อความช่วงสุดท้ายแล้วปิด */
  end(): void {
    if (this.closed || this.ended) return;
    this.ended = true;
    if (this.ready) {
      this.upstream!.send("end");
      return;
    }
    // ยังไม่ได้ส่งเสียงให้ DGX เลย — ไม่มีข้อความให้รอ
    this.emit({ type: "done", audioSeconds: 0, utterances: 0 });
    this.dispose();
    this.client.close(1000, "done");
  }

  /** เบราว์เซอร์ตัดการเชื่อมต่อ */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    activeSessions = Math.max(0, activeSessions - 1);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.pending = [];
    try {
      this.upstream?.close();
    } catch {
      /* ปิดไปแล้ว */
    }
  }

  get audioSeconds(): number {
    return this.audioBytes / 32000;
  }

  private onUpstreamMessage(data: unknown): void {
    if (this.closed || typeof data !== "string") return;
    let ev: any;
    try {
      ev = JSON.parse(data);
    } catch {
      return;
    }
    switch (ev?.type) {
      case "ready": {
        this.ready = true;
        if (this.connectTimer) clearTimeout(this.connectTimer);
        for (const frame of this.pending) this.upstream!.send(frame);
        this.pending = [];
        this.pendingBytes = 0;
        this.emit({ type: "ready" });
        break;
      }
      case "partial":
        this.emit({ type: "partial", utterance: Number(ev.utterance) || 0, start: Number(ev.start) || 0, text: normalizeThai(ev.text) });
        break;
      case "final": {
        const text = normalizeThai(ev.display_text ?? ev.text);
        if (text) this.finals += 1;
        this.emit({
          type: "final",
          utterance: Number(ev.utterance) || 0,
          start: Number(ev.start) || 0,
          end: Number(ev.end) || Number(ev.start) || 0,
          text,
        });
        break;
      }
      case "done":
        this.emit({ type: "done", audioSeconds: Number(ev.audio_seconds) || this.audioSeconds, utterances: Number(ev.utterances) || this.finals });
        this.dispose();
        this.client.close(1000, "done");
        break;
      case "error":
        this.fail(`ASR server: ${String(ev.detail ?? "error").slice(0, 200)}`);
        break;
    }
  }

  private emit(ev: LiveEvent): void {
    if (ev.type === "partial" || ev.type === "final") {
      try {
        this.listener?.(ev);
      } catch (err: any) {
        console.warn("[ASR] live listener error:", err?.message || err);
      }
    }
    try {
      this.client.send(JSON.stringify(ev));
    } catch {
      /* เบราว์เซอร์ปิดไปแล้ว */
    }
  }

  private fail(message: string): void {
    if (this.closed) return;
    if (message) {
      console.warn(`[ASR] live: ${message}`);
      this.emit({ type: "error", message });
    }
    this.dispose();
    this.client.close(message ? 1011 : 1000, message ? "asr error" : "closed");
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.fail("ไม่ได้รับเสียงเกิน 60 วินาที"), IDLE_TIMEOUT_MS);
  }
}
