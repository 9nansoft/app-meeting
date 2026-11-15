/**
 * OCR ด้วย OpenThai2.0-OCR-Markdown ที่ self-host บน DGX
 * — เรียก ocr-sidecar (vLLM + FastAPI ชุดเดียวกับที่ e-office ใช้): POST /v1/ocr
 *
 * ตัวแปรสภาพแวดล้อม:
 *   OCR_BASE_URL    เช่น http://10.0.0.20:8090 (ว่าง = ไม่ใช้ — ไปใช้ tesseract / AI Vision ตามเดิม)
 *   OCR_API_KEY     ค่าเดียวกับ OCR_API_KEY ใน ocr-sidecar/.env
 *   OCR_MODE        single (ค่าเริ่มต้น) | double (crop ตาราง/กราฟอ่านซ้ำ แม่นขึ้น ช้าลง) | triple
 *   OCR_TIMEOUT_MS  ค่าเริ่มต้น 600000 (10 นาที ต่อไฟล์)
 *
 * จำนวนหน้าสูงสุดต่อไฟล์กำหนดที่ฝั่ง sidecar (OCR_MAX_PAGES ใน ocr-sidecar/.env ค่าเริ่มต้น 50)
 */
import type { OcrPage } from "./ocr";

const MODES = ["single", "double", "triple"] as const;

/** อ่าน env ตอนเรียกใช้ (ไม่ใช่ตอน import) */
function config() {
  const mode = (MODES as readonly string[]).includes(process.env.OCR_MODE || "") ? process.env.OCR_MODE! : "single";
  return {
    baseUrl: (process.env.OCR_BASE_URL || "").replace(/\/+$/, ""),
    apiKey: process.env.OCR_API_KEY || "",
    mode,
    timeoutMs: Number(process.env.OCR_TIMEOUT_MS) || 600_000,
  };
}

export function isOpenThaiOcrConfigured(): boolean {
  return Boolean(config().baseUrl);
}

export function openThaiOcrInfo(): { url: string; mode: string } | null {
  const c = config();
  return c.baseUrl ? { url: c.baseUrl, mode: c.mode } : null;
}

interface SidecarPage {
  page: number;
  markdown: string;
  incomplete?: boolean;
}

export interface SidecarOcrResponse {
  model?: string;
  page_count?: number;
  processed_pages?: number;
  truncated?: boolean;
  incomplete_pages?: number[];
  pages?: SidecarPage[];
  elapsed_ms?: number;
}

const ENTITIES: Record<string, string> = { "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };

/**
 * Markdown จากโมเดล (ตารางเป็น HTML) → ข้อความธรรมดา
 * ระบบใช้ข้อความนี้ทั้งส่งให้ LLM, สรุปแบบ heuristic และค้นหา/แสดง snippet จึงตัด markup ออก
 * โดยคงโครงสร้างตารางไว้เป็นแถวละบรรทัด คั่นช่องด้วย " | "
 */
export function markdownToPlainText(markdown: string): string {
  return String(markdown ?? "")
    .replace(/<!--[\s\S]*?-->/g, "\n")
    .replace(/^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*(\n|$)/gm, "") // เส้นคั่นหัวตาราง Markdown
    .replace(/<\/t[dh]>\s*<t[dh][^>]*>/gi, " | ")
    .replace(/<\/(tr|p|div|li|h\d|table|caption)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m)
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s{0,3}(#{1,6}|>)\s+/, "") // หัวข้อ / blockquote
        .replace(/(\*\*|__|`)/g, "")
        .replace(/[ \t ]+/g, " ")
        .replace(/\s*\|\s*/g, " | ")
        .replace(/^\s*\|\s*|\s*\|\s*$/g, "")
        .trim(),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** แปลงผลจาก sidecar เป็นหน้า OCR ของระบบ (แยกไว้เพื่อทดสอบได้โดยไม่ต้องมี sidecar) */
export function mapSidecarResponse(data: SidecarOcrResponse): { pages: OcrPage[]; pageCount: number } {
  const pages: OcrPage[] = (data.pages ?? [])
    .map((p) => ({ pageNo: Number(p.page), text: markdownToPlainText(p.markdown) }))
    .filter((p) => p.pageNo > 0 && p.text)
    .sort((a, b) => a.pageNo - b.pageNo);
  return { pages, pageCount: Number(data.page_count) || pages.length };
}

/** ส่ง PDF ทั้งไฟล์ให้ sidecar — คืน null เมื่อไม่ได้ตั้งค่า, throw เมื่อ sidecar ล่ม/ตอบ error */
export async function ocrWithOpenThai(
  buffer: Buffer,
  fileName = "document.pdf",
): Promise<{ pages: OcrPage[]; pageCount: number } | null> {
  const { baseUrl, apiKey, mode, timeoutMs } = config();
  if (!baseUrl) return null;

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buffer)], { type: "application/pdf" }), fileName);
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/v1/ocr?mode=${mode}`, {
      method: "POST",
      headers,
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: any) {
    const reason = err?.name === "TimeoutError" ? `หมดเวลา ${Math.round(timeoutMs / 1000)} วินาที` : err?.message || String(err);
    throw new Error(`เชื่อมต่อ OCR sidecar ไม่ได้: ${reason}`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OCR sidecar ตอบกลับ ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = (await res.json()) as SidecarOcrResponse;
  if (data.truncated) {
    console.warn(`[OCR] "${fileName}" ยาว ${data.page_count} หน้า — sidecar อ่านแค่ ${data.processed_pages} หน้าแรก`);
  }
  if (data.incomplete_pages?.length) {
    console.warn(`[OCR] "${fileName}" หน้าที่อ่านไม่ครบ (ชน token limit): ${data.incomplete_pages.join(", ")}`);
  }
  return mapSidecarResponse(data);
}
