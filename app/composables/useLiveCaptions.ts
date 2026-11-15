import { ref, computed } from "vue";

/**
 * ถอดเสียงสดระหว่างประชุม
 *
 * - ผู้บันทึก: startRecorder(stream) ส่งเสียงไมค์ (PCM16 16kHz) ไปที่ /ws/live-asr
 * - ทุกคนที่เปิดหน้า live (รวมผู้บันทึก): subscribe() รับข้อความจาก /ws/live-captions
 *   คนที่เข้ามาทีหลังได้ข้อความย้อนหลังที่ยังไม่มี transcript จริงแทนด้วย
 *
 * ข้อความสดใช้ดูระหว่างประชุมเท่านั้น: transcript ที่บันทึกจริงมาจากไฟล์เสียงช่วงละ 5 นาทีตามเดิม
 * เมื่อไฟล์ช่วงไหนถอดเสร็จ ข้อความสดในช่วงเวลานั้นจะถูกเอาออก (setRecordings)
 */

export interface LiveLine {
  /** ไม่ซ้ำข้าม instance ของ server */
  id: string;
  /** เวลาที่ server ได้ข้อความ (ISO) */
  at: string;
  text: string;
  session: string;
}

export interface LiveRecordingInfo {
  id: string;
  status: string;
  ended_at?: string | null;
  duration_seconds?: number | null;
}

export type RecorderStatus = "off" | "connecting" | "live" | "reconnecting" | "unavailable" | "error";
export type ViewerStatus = "off" | "connecting" | "connected" | "reconnecting" | "unavailable";

const SAMPLE_RATE = 16000;
/** เสียงที่พักไว้ระหว่างรอ WebSocket เปิด (10 วินาที) */
const MAX_BUFFER_SAMPLES = 10 * SAMPLE_RATE;
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];
/** เผื่อความคลาดของความยาวไฟล์ เมื่อเทียบข้อความสดกับช่วงเวลาของไฟล์เสียง */
const SEGMENT_SLACK_MS = 30_000;

function wsUrl(path: string, meetingId: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}${path}?meetingId=${encodeURIComponent(meetingId)}`;
}

export function useLiveCaptions(meetingId: string) {
  /* ---------------- สถานะร่วม ---------------- */
  let enabled: boolean | null = null;
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

  /* ---------------- ผู้ชม: /ws/live-captions ---------------- */
  const viewerStatus = ref<ViewerStatus>("off");
  const allLines = ref<LiveLine[]>([]);
  const partials = ref<Record<string, string>>({});
  /** การถอดเสียงสดที่กำลังทำงานในการประชุมนี้: session → ชื่อผู้บันทึก */
  const sessions = ref<Record<string, string>>({});
  const recordings = ref<LiveRecordingInfo[]>([]);
  let viewerWs: WebSocket | null = null;
  let viewerActive = false;
  let viewerFailures = 0;
  let viewerTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * ข้อความสดที่ transcript จริงยังไม่ครอบคลุม
   * ไฟล์เสียงครอบคลุมช่วง [ended_at − ความยาวไฟล์, ended_at] ตามเวลาของ server
   * (ended_at = เวลาที่ server ได้รับไฟล์ ซึ่งช้ากว่าเสียงจริงเล็กน้อยจากการอัปโหลด)
   */
  const lines = computed(() => {
    const covered = recordings.value
      .filter((r) => r.status === "transcribed" && r.ended_at)
      .map((r) => {
        const end = Date.parse(r.ended_at!);
        return { start: end - (r.duration_seconds ?? 300) * 1000 - SEGMENT_SLACK_MS, end };
      });
    if (!covered.length) return allLines.value;
    return allLines.value.filter((l) => {
      const t = Date.parse(l.at);
      return !covered.some((c) => t >= c.start && t <= c.end);
    });
  });
  const partial = computed(() => Object.values(partials.value).filter(Boolean).join(" "));
  const activeRecorders = computed(() => Object.values(sessions.value));

  function dropPartial(session: string) {
    if (!(session in partials.value)) return;
    const next = { ...partials.value };
    delete next[session];
    partials.value = next;
  }

  function onCaption(data: string) {
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.type === "snapshot") {
      viewerFailures = 0;
      viewerStatus.value = "connected";
      // รวมกับที่มีอยู่ (กรณีเชื่อมต่อใหม่) โดยไม่ซ้ำ id
      const seen = new Set(allLines.value.map((l) => l.id));
      allLines.value = [...allLines.value, ...(msg.lines as LiveLine[]).filter((l) => !seen.has(l.id))].sort((a, b) =>
        a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at < b.at ? -1 : 1,
      );
      sessions.value = Object.fromEntries((msg.sessions ?? []).map((s: any) => [s.session, s.by]));
      partials.value = Object.fromEntries((msg.partials ?? []).map((p: any) => [p.session, p.text]));
    } else if (msg.type === "session") {
      const next = { ...sessions.value };
      if (msg.active) next[msg.session] = msg.by;
      else delete next[msg.session];
      sessions.value = next;
      if (!msg.active) dropPartial(msg.session);
    } else if (msg.type === "partial") {
      partials.value = { ...partials.value, [msg.session]: msg.text || "" };
    } else if (msg.type === "final") {
      dropPartial(msg.line.session);
      // server อาจส่ง final ที่อยู่ใน snapshot แล้วซ้ำ (event ระหว่างโหลดข้อความย้อนหลัง)
      if (!allLines.value.some((l) => l.id === msg.line.id)) allLines.value.push(msg.line);
    }
  }

  function connectViewer() {
    if (!viewerActive) return;
    viewerStatus.value = viewerFailures ? "reconnecting" : "connecting";
    const sock = new WebSocket(wsUrl("/ws/live-captions", meetingId));
    viewerWs = sock;
    sock.onmessage = (ev) => {
      if (typeof ev.data === "string") onCaption(ev.data);
    };
    sock.onclose = () => {
      if (viewerWs !== sock) return;
      viewerWs = null;
      partials.value = {};
      if (!viewerActive) return;
      // ผู้ชมเปิดหน้าทิ้งไว้ตลอดการประชุม — เชื่อมต่อใหม่เรื่อย ๆ โดยถอยห่างสูงสุด 30 วินาที
      viewerFailures += 1;
      viewerStatus.value = "reconnecting";
      const delay = RECONNECT_DELAYS_MS[Math.min(viewerFailures, RECONNECT_DELAYS_MS.length) - 1];
      viewerTimer = setTimeout(connectViewer, delay);
    };
  }

  /** เริ่มรับข้อความสด (เรียกตอนเปิดหน้า live) */
  async function subscribe(): Promise<void> {
    if (viewerActive) return;
    if (!(await checkEnabled())) {
      viewerStatus.value = "unavailable";
      return;
    }
    viewerActive = true;
    viewerFailures = 0;
    connectViewer();
  }

  function unsubscribe() {
    viewerActive = false;
    if (viewerTimer) clearTimeout(viewerTimer);
    viewerTimer = null;
    viewerWs?.close();
    viewerWs = null;
    viewerStatus.value = "off";
  }

  /** อัปเดตสถานะไฟล์เสียง (จาก polling transcript) — ข้อความสดที่ถอดไฟล์เสร็จแล้วจะหายไป */
  function setRecordings(list: LiveRecordingInfo[]) {
    recordings.value = list;
    // ทิ้งข้อความที่ไม่ต้องแสดงแล้วออกจากหน่วยความจำ
    const keep = new Set(lines.value.map((l) => l.id));
    if (keep.size !== allLines.value.length) allLines.value = allLines.value.filter((l) => keep.has(l.id));
  }

  /* ---------------- ผู้บันทึก: /ws/live-asr ---------------- */
  const recorderStatus = ref<RecorderStatus>("off");
  const recorderError = ref("");
  let recorderActive = false;
  let audioCtx: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let worklet: AudioWorkletNode | null = null;
  let sink: GainNode | null = null;
  let recWs: WebSocket | null = null;
  let buffer: ArrayBuffer[] = [];
  let bufferSamples = 0;
  let recTimer: ReturnType<typeof setTimeout> | null = null;
  let recFailures = 0;

  function onFrame(frame: ArrayBuffer) {
    if (recWs?.readyState === WebSocket.OPEN) {
      recWs.send(frame);
      return;
    }
    if (!recorderActive || !recWs) return; // รอ reconnect — ข้ามเสียงช่วงนี้
    buffer.push(frame);
    bufferSamples += frame.byteLength / 2;
    while (bufferSamples > MAX_BUFFER_SAMPLES && buffer.length) bufferSamples -= buffer.shift()!.byteLength / 2;
  }

  function connectRecorder() {
    if (!recorderActive) return;
    recorderStatus.value = recFailures ? "reconnecting" : "connecting";
    buffer = [];
    bufferSamples = 0;
    const sock = new WebSocket(wsUrl("/ws/live-asr", meetingId));
    sock.binaryType = "arraybuffer";
    recWs = sock;
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
      // partial/final แสดงผลผ่าน /ws/live-captions เหมือนผู้ชมคนอื่น — ที่นี่ดูแค่สถานะ
      if (msg.type === "ready") {
        recFailures = 0;
        recorderError.value = "";
        recorderStatus.value = "live";
      } else if (msg.type === "error") {
        recorderError.value = msg.message || "ถอดเสียงสดผิดพลาด";
      }
    };
    sock.onclose = () => {
      if (recWs !== sock) return;
      recWs = null;
      if (!recorderActive) return;
      // 4xx ตอน upgrade (ไม่มีสิทธิ์/เต็ม) เบราว์เซอร์เห็นเป็น 1006 เหมือนเน็ตหลุด — ลองใหม่แบบถอยห่างแล้วหยุด
      recFailures += 1;
      if (recFailures > RECONNECT_DELAYS_MS.length) {
        recorderStatus.value = "error";
        recorderError.value ||= "เชื่อมต่อถอดเสียงสดไม่ได้ — การบันทึกเสียงยังทำงานตามปกติ";
        return;
      }
      recorderStatus.value = "reconnecting";
      recTimer = setTimeout(connectRecorder, RECONNECT_DELAYS_MS[recFailures - 1]);
    };
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

  /** เริ่มส่งเสียงไปถอดสด จาก stream เดียวกับที่ MediaRecorder ใช้ */
  async function startRecorder(stream: MediaStream): Promise<void> {
    if (recorderActive) return;
    if (!(await checkEnabled())) {
      recorderStatus.value = "unavailable";
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
      recorderStatus.value = "error";
      recorderError.value = `เบราว์เซอร์นี้ถอดเสียงสดไม่ได้: ${err?.message || err}`;
      return;
    }
    recorderActive = true;
    recFailures = 0;
    connectRecorder();
  }

  /** หยุดส่งเสียง — ขอข้อความช่วงสุดท้ายจาก server แล้วปิด */
  function stopRecorder() {
    if (!recorderActive) return;
    recorderActive = false;
    if (recTimer) clearTimeout(recTimer);
    recTimer = null;
    teardownAudio();
    const sock = recWs;
    if (sock?.readyState === WebSocket.OPEN) {
      sock.send("end");
      // server ปิดเองเมื่อส่ง done — กันค้างด้วย timeout
      setTimeout(() => sock.close(), 10_000);
    } else {
      sock?.close();
      recWs = null;
    }
    recorderStatus.value = "off";
  }

  return {
    // ผู้ชม
    viewerStatus,
    lines,
    partial,
    activeRecorders,
    subscribe,
    unsubscribe,
    setRecordings,
    // ผู้บันทึก
    recorderStatus,
    recorderError,
    startRecorder,
    stopRecorder,
  };
}
