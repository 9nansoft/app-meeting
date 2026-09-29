/**
 * AI Provider — เรียก LLM ผ่าน API แบบ OpenAI-compatible
 * (รองรับ OpenAI, OpenRouter, 9Router หรือ self-host ที่ใช้ schema เดียวกัน)
 *
 * ตัวแปรสภาพแวดล้อม:
 *   AI_API_KEY   — API key (ถ้าไม่ตั้ง ระบบจะทำงานในโหมด heuristic/offline)
 *   AI_BASE_URL  — ค่าเริ่มต้น https://api.openai.com/v1
 *   AI_MODEL     — ค่าเริ่มต้น gpt-4o-mini
 *   AI_STT_MODEL — โมเดลถอดเสียง ค่าเริ่มต้น whisper-1
 */
export const AI_BASE_URL = process.env.AI_BASE_URL || "https://api.openai.com/v1";
export const AI_MODEL = process.env.AI_MODEL || "gpt-4o-mini";
export const AI_STT_MODEL = process.env.AI_STT_MODEL || "whisper-1";
export const AI_EMBED_MODEL = process.env.AI_EMBED_MODEL || "text-embedding-3-small";

export function isAiConfigured(): boolean {
  return Boolean(process.env.AI_API_KEY);
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  model: string;
}

export async function chatCompletion(
  messages: ChatMessage[],
  opts: { json?: boolean; temperature?: number } = {},
): Promise<ChatResult | null> {
  if (!isAiConfigured()) return null;
  const started = Date.now();
  const res = await fetch(`${AI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.AI_API_KEY}`,
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages,
      temperature: opts.temperature ?? 0.2,
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`AI chat failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const data: any = await res.json();
  console.log(`[AI] chat ${AI_MODEL} ${Date.now() - started}ms`);
  return {
    text: data?.choices?.[0]?.message?.content ?? "",
    inputTokens: data?.usage?.prompt_tokens,
    outputTokens: data?.usage?.completion_tokens,
    model: data?.model || AI_MODEL,
  };
}

/** ดึง JSON object จากคำตอบของ LLM (กัน code fence / ข้อความห่อหุ้ม) */
export function parseJsonLoose<T>(text: string): T | null {
  if (!text) return null;
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * สร้าง embedding vectors ของข้อความหลายรายการ
 * (สำหรับค้นหาเชิงความหมายใน document_chunks)
 * คืน null เมื่อไม่ได้ตั้งค่า AI หรือ provider ไม่รองรับ
 */
export async function embedTexts(texts: string[]): Promise<number[][] | null> {
  if (!isAiConfigured() || !texts.length) return null;
  const res = await fetch(`${AI_BASE_URL}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.AI_API_KEY}`,
    },
    body: JSON.stringify({ model: AI_EMBED_MODEL, input: texts }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`embeddings failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  const data: any = await res.json();
  const rows: any[] = data?.data ?? [];
  if (rows.length !== texts.length) return null;
  // เรียงตาม index ให้ตรงกับลำดับ input
  return rows
    .sort((a, b) => a.index - b.index)
    .map((r) => (Array.isArray(r.embedding) ? r.embedding.map((v: unknown) => Number(v)) : null))
    .filter((v): v is number[] => Array.isArray(v) && v.length > 0);
}

/** คำนวณ cosine similarity ของเวกเตอร์ 2 ตัว */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface SttSegment {
  startMs: number;
  endMs: number;
  speaker?: string;
  text: string;
  confidence?: number;
}

/**
 * ถอดเสียงเป็นข้อความแบบมีช่วงเวลา (ภาษาไทย)
 * คืน null เมื่อไม่ได้ตั้งค่า provider → caller ใช้ mock แทน
 */
export async function transcribeAudio(
  audio: Buffer,
  fileName: string,
  mime: string,
  language = "th",
): Promise<{ segments: SttSegment[]; model: string; text: string } | null> {
  if (!isAiConfigured()) return null;
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), fileName);
  form.append("model", AI_STT_MODEL);
  form.append("language", language);
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");

  const res = await fetch(`${AI_BASE_URL}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.AI_API_KEY}` },
    body: form,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`AI transcription failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const data: any = await res.json();
  const rawSegments: any[] = data?.segments || [];
  const segments: SttSegment[] = rawSegments.map((s) => ({
    startMs: Math.round((s.start ?? 0) * 1000),
    endMs: Math.round((s.end ?? s.start ?? 0) * 1000),
    speaker: s.speaker,
    text: String(s.text ?? "").trim(),
  }));
  return {
    segments: segments.length
      ? segments
      : [{ startMs: 0, endMs: 0, text: String(data?.text ?? "").trim() }],
    model: AI_STT_MODEL,
    text: String(data?.text ?? ""),
  };
}
