/**
 * ถอดเสียงด้วย OpenThai2.0 ASR Streaming (iapp/OpenThai2.0-ASR-Streaming) ที่ self-host บน DGX
 * — เรียก reference server ของ iApp: POST /v1/transcribe (ดู deploy/asr-dgx/)
 *
 * ตัวแปรสภาพแวดล้อม:
 *   OPENTHAI_ASR_URL        — เช่น http://10.0.0.20:18081 (ตั้งค่านี้แล้วระบบจะถอดเสียงผ่าน OpenThai แทน AI_STT_MODEL)
 *   OPENTHAI_ASR_MODE       — standard (ค่าเริ่มต้น) | conversation | meeting
 *                             meeting ได้ speaker labels แต่ถอดทั้งไฟล์เป็น stream เดียว (ไม่ตัดที่ช่วงเงียบ)
 *                             ซึ่ง model card ระบุว่าคำหายหลังช่วงเงียบมากกว่า standard
 *   OPENTHAI_ASR_LANG       — th-TH (ค่าเริ่มต้น: เขียนทุกคำเป็นอักษรไทย) | th-mix (คำอังกฤษเป็นอักษรละติน)
 *   OPENTHAI_ASR_LATENCY_MS — 80 | 320 | 560 (ค่าเริ่มต้น) | 1120
 *   OPENTHAI_ASR_TOKEN      — Bearer token ถ้ามี reverse proxy ยืนยันตัวตนอยู่หน้า server (server ของ iApp เองไม่มี auth)
 *   OPENTHAI_ASR_TIMEOUT_MS — ค่าเริ่มต้น 1800000 (30 นาที)
 */
import type { SttSegment } from "./provider";

const MODES = ["standard", "conversation", "meeting"] as const;
const LANGS = ["th-TH", "th-mix"] as const;
const LATENCIES = [80, 320, 560, 1120] as const;

function pick<T extends string | number>(value: string | undefined, allowed: readonly T[], fallback: T, name: string): T {
  if (!value) return fallback;
  const v = (typeof fallback === "number" ? Number(value) : value) as T;
  if (allowed.includes(v)) return v;
  console.warn(`[ASR] ${name}=${value} ไม่รองรับ (ใช้ได้: ${allowed.join(", ")}) — ใช้ ${fallback}`);
  return fallback;
}

export const OPENTHAI_ASR_URL = (process.env.OPENTHAI_ASR_URL || "").replace(/\/+$/, "");
export const OPENTHAI_ASR_MODE = pick(process.env.OPENTHAI_ASR_MODE, MODES, "standard", "OPENTHAI_ASR_MODE");
export const OPENTHAI_ASR_LANG = pick(process.env.OPENTHAI_ASR_LANG, LANGS, "th-TH", "OPENTHAI_ASR_LANG");
export const OPENTHAI_ASR_LATENCY_MS = pick(process.env.OPENTHAI_ASR_LATENCY_MS, LATENCIES, 560, "OPENTHAI_ASR_LATENCY_MS");
const TIMEOUT_MS = Number(process.env.OPENTHAI_ASR_TIMEOUT_MS) || 30 * 60 * 1000;

export function isOpenThaiAsrConfigured(): boolean {
  return Boolean(OPENTHAI_ASR_URL);
}

/**
 * tokenizer ของโมเดลแยกสระอำ (U+0E33) เป็นนิคหิต + สระอา (U+0E4D U+0E32)
 * — server รวมกลับให้เฉพาะ display_text ส่วนข้อความใน segments ยังเป็นแบบแยก จึงรวมเองที่นี่
 */
export function normalizeThai(text: string): string {
  return String(text ?? "")
    .replace(/ํา/g, "ำ")
    .normalize("NFC")
    .trim();
}

/** speaker_0, speaker_1, ... → ผู้พูด 1, ผู้พูด 2, ... (เลขนับเฉพาะภายในไฟล์เสียงช่วงนั้น) */
function speakerLabel(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  const m = /^speaker_(\d+)$/.exec(raw);
  return m ? `ผู้พูด ${Number(m[1]) + 1}` : raw;
}

export interface OpenThaiTranscribeResponse {
  text?: string;
  display_text?: string;
  duration_s?: number;
  model?: string;
  segments?: Array<{ start?: number; end?: number; text?: string; speaker?: string }>;
}

/** แปลงผลจาก /v1/transcribe เป็น segments ของระบบ (แยกไว้เพื่อทดสอบได้โดยไม่ต้องมี server) */
export function mapOpenThaiResponse(data: OpenThaiTranscribeResponse): { segments: SttSegment[]; text: string } {
  const text = normalizeThai(data.display_text ?? data.text ?? "");
  const segments: SttSegment[] = (data.segments ?? [])
    .map((s) => ({
      startMs: Math.round((s.start ?? 0) * 1000),
      endMs: Math.round((s.end ?? s.start ?? 0) * 1000),
      speaker: speakerLabel(s.speaker),
      text: normalizeThai(s.text ?? ""),
    }))
    .filter((s) => s.text);
  // ไฟล์สั้น (ไม่ถูกตัดที่ช่วงเงียบ) และไม่มี speaker labels → server ไม่ส่ง segments มา
  if (!segments.length && text) {
    segments.push({ startMs: 0, endMs: Math.round((data.duration_s ?? 0) * 1000), text });
  }
  return { segments, text };
}

export async function transcribeWithOpenThai(
  audio: Buffer,
  fileName: string,
  mime: string,
): Promise<{ segments: SttSegment[]; model: string; text: string } | null> {
  if (!isOpenThaiAsrConfigured()) return null;
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), fileName);
  form.append("mode", OPENTHAI_ASR_MODE);
  form.append("lang", OPENTHAI_ASR_LANG);
  form.append("latency_ms", String(OPENTHAI_ASR_LATENCY_MS));

  const headers: Record<string, string> = {};
  if (process.env.OPENTHAI_ASR_TOKEN) headers.Authorization = `Bearer ${process.env.OPENTHAI_ASR_TOKEN}`;

  const started = Date.now();
  const res = await fetch(`${OPENTHAI_ASR_URL}/v1/transcribe`, {
    method: "POST",
    headers,
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenThai ASR failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const data = (await res.json()) as OpenThaiTranscribeResponse;
  const { segments, text } = mapOpenThaiResponse(data);
  const model = `${data.model || "openthai2.0-asr-streaming"}:${OPENTHAI_ASR_MODE}`.slice(0, 100);
  console.log(
    `[ASR] OpenThai ${OPENTHAI_ASR_MODE}/${OPENTHAI_ASR_LANG} ${data.duration_s ?? "?"}s audio → ${segments.length} segments ใน ${Date.now() - started}ms`,
  );
  return { segments, model, text };
}
