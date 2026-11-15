import { ref, computed } from "vue";

/**
 * ถอดเสียงสดระหว่างบันทึก — ส่งเสียงไมค์ (PCM16 16kHz) ไปที่ /ws/live-asr แล้วรับข้อความกลับทุกช่วงหยุดพูด
 *
 * ข้อความสดใช้ดูระหว่างประชุมเท่านั้น: transcript ที่บันทึกจริงมาจากไฟล์เสียงช่วงละ 5 นาทีตามเดิม
 * เมื่อไฟล์ช่วงไหนถอดเสียงเสร็จ ข้อความสดของช่วงนั้นจะถูกเอาออก (ดู markSegment / dropTranscribed)
 */

export interface LiveLine {
  id: number;
  /** ลำดับไฟล์เสียง 5 นาทีที่ข้อความนี้อยู่ */
  segment: number;
  text: string;
  at: Date;
}

export type LiveStatus = "off" | "connecting" | "live" | "reconnecting" | "unavailable" | "error";

const SAMPLE_RATE = 16000;
/** เสียงที่พักไว้ระหว่างรอ WebSocket เปิด (10 วินาที) */
const MAX_BUFFER_SAMPLES = 10 * SAMPLE_RATE;
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];

export function useLiveCaptions(meetingId: string) {
  const status = ref<LiveStatus>("off");
  const errorMessage = ref("");
  const lines = ref<LiveLine[]>([]);
  const partial = ref("");

  let enabled: boolean | null = null;
  let active = false;
  let audioCtx: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let worklet: AudioWorkletNode | null = null;
  let sink: GainNode | null = null;
  let ws: WebSocket | null = null;
  let buffer: ArrayBuffer[] = [];
  let bufferSamples = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let nextId = 1;

  /** จำนวน sample ที่ผลิตตั้งแต่เริ่มบันทึก — ใช้เทียบเวลาของข้อความกับช่วงไฟล์เสียง */
  let producedSamples = 0;
  /** เวลา (วินาทีนับจากเริ่มบันทึก) ที่ WebSocket ปัจจุบันเริ่มรับเสียง */
  let connectionOffsetSec = 0;
  /** เวลาที่ตัดไฟล์เสียงแต่ละช่วง (วินาทีนับจากเริ่มบันทึก) */
  let boundaries: number[] = [];
  const recordingOfSegment = new Map<number, string>();
  let lastRecordings: Array<{ id: string; status: string }> = [];

  const isLive = computed(() => status.value === "live");

  async function checkEnabled(): Promise<boolean> {
    if (enabled !== null) return enabled;
    try {
      const res = await fetch("/api/meetings/live-asr/status", { credentials: "same-origin" });
      enabled = res.ok && Boolean((await res.json())?.enabled);
    } catch {
      enabled = false;
    }
    return enabled;
  }

  function segmentAt(sec: number): number {
    let i = 0;
    while (i < boundaries.length && (boundaries[i] ?? Infinity) <= sec) i++;
    return i;
  }

  function wsUrl(): string {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}/ws/live-asr?meetingId=${encodeURIComponent(meetingId)}`;
  }

  function onFrame(frame: ArrayBuffer) {
    producedSamples += frame.byteLength / 2;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(frame);
      return;
    }
    if (!active || !ws) return; // ไม่ได้เชื่อมต่อ (รอ reconnect) — ข้ามเสียงช่วงนี้
    buffer.push(frame);
    bufferSamples += frame.byteLength / 2;
    while (bufferSamples > MAX_BUFFER_SAMPLES && buffer.length) {
      const dropped = buffer.shift()!.byteLength / 2;
      bufferSamples -= dropped;
      connectionOffsetSec += dropped / SAMPLE_RATE;
    }
  }

  function connect() {
    if (!active) return;
    status.value = failures ? "reconnecting" : "connecting";
    buffer = [];
    bufferSamples = 0;
    connectionOffsetSec = producedSamples / SAMPLE_RATE;
    const sock = new WebSocket(wsUrl());
    sock.binaryType = "arraybuffer";
    ws = sock;

    sock.onopen = () => {
      for (const frame of buffer) sock.send(frame);
      buffer = [];
      bufferSamples = 0;
    };
    sock.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      let msg: any;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === "ready") {
        failures = 0;
        errorMessage.value = "";
        status.value = "live";
      } else if (msg.type === "partial") {
        partial.value = msg.text || "";
      } else if (msg.type === "final") {
        partial.value = "";
        if (msg.text) {
          lines.value.push({
            id: nextId++,
            segment: segmentAt(connectionOffsetSec + (Number(msg.start) || 0)),
            text: msg.text,
            at: new Date(),
          });
          dropTranscribed();
        }
      } else if (msg.type === "error") {
        errorMessage.value = msg.message || "ถอดเสียงสดผิดพลาด";
      }
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      partial.value = "";
      if (!active) return;
      // 4xx ตอน upgrade (ไม่มีสิทธิ์/ไม่ได้ตั้งค่า) เบราว์เซอร์รายงานเป็น 1006 เหมือนเน็ตหลุด — ลองใหม่แบบถอยห่างแล้วหยุด
      failures += 1;
      if (failures > RECONNECT_DELAYS_MS.length) {
        status.value = "error";
        errorMessage.value ||= "เชื่อมต่อถอดเสียงสดไม่ได้ — การบันทึกเสียงยังทำงานตามปกติ";
        return;
      }
      status.value = "reconnecting";
      reconnectTimer = setTimeout(connect, RECONNECT_DELAYS_MS[failures - 1]);
    };
  }

  /** เริ่มถอดเสียงสดจาก stream เดียวกับที่ MediaRecorder ใช้ */
  async function start(stream: MediaStream): Promise<void> {
    if (active) return;
    if (!(await checkEnabled())) {
      status.value = "unavailable";
      return;
    }
    try {
      audioCtx = new AudioContext();
      await audioCtx.audioWorklet.addModule("/audio/pcm16-worklet.js");
      source = audioCtx.createMediaStreamSource(stream);
      worklet = new AudioWorkletNode(audioCtx, "pcm16-downsampler");
      // ต่อออก destination ผ่าน gain 0 ให้เบราว์เซอร์ประมวลผล worklet ต่อเนื่อง (ไม่มีเสียงออกลำโพง)
      sink = audioCtx.createGain();
      sink.gain.value = 0;
      source.connect(worklet).connect(sink).connect(audioCtx.destination);
      worklet.port.onmessage = (ev) => onFrame(ev.data as ArrayBuffer);
      if (audioCtx.state === "suspended") await audioCtx.resume();
    } catch (err: any) {
      teardownAudio();
      status.value = "error";
      errorMessage.value = `เบราว์เซอร์นี้ถอดเสียงสดไม่ได้: ${err?.message || err}`;
      return;
    }
    active = true;
    failures = 0;
    producedSamples = 0;
    boundaries = [];
    recordingOfSegment.clear();
    connect();
  }

  /**
   * เรียกตอนตัดไฟล์เสียง (ทุก 5 นาที/ตอนหยุด) — คืนลำดับช่วงที่เพิ่งปิด
   * ให้หน้า live ผูกกับ recording id ที่อัปโหลดได้ด้วย linkRecording
   */
  function markSegment(): number {
    boundaries.push(producedSamples / SAMPLE_RATE);
    return boundaries.length - 1;
  }

  function linkRecording(segment: number, recordingId: string) {
    recordingOfSegment.set(segment, recordingId);
  }

  /** เอาข้อความสดของช่วงที่ไฟล์เสียงถอดเสร็จแล้วออก (transcript จริงแสดงแทน) */
  function dropTranscribed(recordings: Array<{ id: string; status: string }> = lastRecordings) {
    lastRecordings = recordings;
    const done = new Set(recordings.filter((r) => r.status === "transcribed").map((r) => r.id));
    if (!done.size) return;
    lines.value = lines.value.filter((l) => {
      const rec = recordingOfSegment.get(l.segment);
      return !(rec && done.has(rec));
    });
  }

  function teardownAudio() {
    if (worklet) worklet.port.onmessage = null;
    try {
      source?.disconnect();
      worklet?.disconnect();
      sink?.disconnect();
    } catch {
      /* ปิดไปแล้ว */
    }
    void audioCtx?.close().catch(() => undefined);
    audioCtx = null;
    source = null;
    worklet = null;
    sink = null;
  }

  /** หยุดถอดเสียงสด — ขอข้อความช่วงสุดท้ายจาก server แล้วปิด */
  function stop() {
    if (!active) return;
    active = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    teardownAudio();
    const sock = ws;
    if (sock?.readyState === WebSocket.OPEN) {
      sock.send("end");
      // รอ final ช่วงสุดท้าย (server ปิดเองเมื่อส่ง done) — กันค้างด้วย timeout
      setTimeout(() => sock.close(), 10_000);
    } else {
      sock?.close();
      ws = null;
    }
    partial.value = "";
    status.value = "off";
  }

  return { status, errorMessage, lines, partial, isLive, start, stop, markSegment, linkRecording, dropTranscribed };
}
