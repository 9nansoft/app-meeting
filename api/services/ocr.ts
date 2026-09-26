import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { spawn as nodeSpawn } from "node:child_process";
import { isAiConfigured, AI_BASE_URL, AI_MODEL } from "./ai/provider";

/**
 * OCR สำหรับ PDF สแกน (ไม่มี text layer)
 * ลำดับการทำงาน:
 *   1. render หน้า PDF เป็นภาพ PNG ด้วย pdfjs + @napi-rs/canvas
 *   2. สกัดข้อความด้วย tesseract CLI (ถ้าติดตั้งไว้ — เช่นใน Docker image)
 *   3. ถ้าไม่มี tesseract → ใช้ AI Vision (LLM อ่านภาพ) เมื่อตั้งค่า AI_API_KEY
 *   4. ถ้าไม่มีทั้งคู่ → คืน null ให้ handler แจ้งเลขานุการ
 *
 * ตัวแปรสภาพแวดล้อม:
 *   OCR_LANGS       ภาษาของ tesseract (ค่าเริ่มต้น tha+eng)
 *   OCR_MAX_PAGES   จำนวนหน้าสูงสุดที่จะ OCR (ค่าเริ่มต้น 20)
 *   TESSERACT_CMD   path ของ binary tesseract (ถ้าไม่ได้อยู่ใน PATH)
 */

const require = createRequire(import.meta.url);
const pdfjsPath = path.dirname(require.resolve("pdfjs-dist/package.json"));
pdfjs.GlobalWorkerOptions.workerSrc = path.join(pdfjsPath, "legacy", "build", "pdf.worker.mjs");

/**
 * unpdf (ที่ใช้สกัดข้อความ) bundle pdf.js เวอร์ชันของตัวเองและแชร์
 * globalThis.pdfjsWorker ข้ามสำเนา — ถ้าไม่ล้าง pdfjs-dist จะได้ worker
 * คนละเวอร์ชันมาใช้ (version mismatch) จึงต้องล้างก่อน render ทุกครั้ง
 */
function resetSharedPdfWorker(): void {
  try {
    delete (globalThis as any).pdfjsWorker;
  } catch {
    /* บาง runtime ลบไม่ได้ — ไม่เป็นอันตราย */
  }
}
resetSharedPdfWorker();

export interface OcrPage {
  pageNo: number;
  text: string;
}

export interface OcrResult {
  pages: OcrPage[];
  pageCount: number;
  method: "tesseract" | "ai-vision";
}

/** render แต่ละหน้า PDF เป็น PNG Buffer */
export async function renderPdfPagesToImages(
  buffer: Buffer,
  opts: { scale?: number; maxPages?: number } = {},
): Promise<Buffer[]> {
  const scale = opts.scale ?? 2;
  const maxPages = opts.maxPages ?? 20;
  resetSharedPdfWorker();

  class CanvasFactory {
    create(w: number, h: number) {
      const canvas = createCanvas(w, h);
      return { canvas, context: canvas.getContext("2d") };
    }
    reset(o: { canvas: any }, w: number, h: number) {
      o.canvas.width = w;
      o.canvas.height = h;
    }
    destroy(o: { canvas: any }) {
      o.canvas.width = 0;
      o.canvas.height = 0;
    }
  }

  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    standardFontDataUrl: path.join(pdfjsPath, "standard_fonts") + path.sep,
    cMapUrl: path.join(pdfjsPath, "cmaps") + path.sep,
    ...( { canvasFactory: new CanvasFactory() } as any ),
  }).promise;

  const total = Math.min(doc.numPages, maxPages);
  const images: Buffer[] = [];
  for (let i = 1; i <= total; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d") as SKRSContext2D;
    await page.render({
      canvasContext: ctx as any,
      viewport,
      canvas: canvas as any,
      canvasFactory: new CanvasFactory() as any,
    } as any).promise;
    images.push(canvas.toBuffer("image/png"));
    page.cleanup();
  }
  return images;
}

/* ---------------- tesseract CLI ---------------- */

let cachedTesseract: string | null | undefined;

async function findTesseract(): Promise<string | null> {
  if (cachedTesseract !== undefined) return cachedTesseract;
  const candidates = [process.env.TESSERACT_CMD, "tesseract"].filter(Boolean) as string[];
  for (const cmd of candidates) {
    try {
      const code = await new Promise<number>((resolve) => {
        nodeSpawn(cmd, ["--version"], { stdio: "ignore" }).on("close", (c) => resolve(c ?? -1));
      });
      if (code === 0) {
        cachedTesseract = cmd;
        return cmd;
      }
    } catch {
      /* try next */
    }
  }
  cachedTesseract = null;
  return null;
}

function cleanOcrText(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function ocrWithTesseract(images: Buffer[], langs: string): Promise<OcrPage[] | null> {
  const cmd = await findTesseract();
  if (!cmd) return null;

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ocr-"));
  try {
    const pages: OcrPage[] = [];
    for (let i = 0; i < images.length; i++) {
      const imgPath = path.join(tmpDir, `page-${i}.png`);
      await fs.writeFile(imgPath, images[i]);
      const proc = nodeSpawn(cmd, [imgPath, "stdout", "-l", langs, "--psm", "3"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
      const stdout = await new Promise<string>((resolve) => {
        let out = "";
        proc.stdout.on("data", (d) => (out += d));
        proc.stdout.on("end", () => resolve(out));
      });
      const code: number = await new Promise((resolve) => proc.on("close", (c) => resolve(c ?? -1)));
      if (code !== 0) throw new Error(`tesseract exited ${code}`);
      const text = cleanOcrText(stdout);
      if (text) pages.push({ pageNo: i + 1, text });
    }
    return pages;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/* ---------------- AI Vision OCR ---------------- */

async function ocrWithVision(
  images: Buffer[],
  hint: string,
): Promise<OcrPage[] | null> {
  if (!isAiConfigured()) return null;
  // จำกัดจำนวนภาพต่อคำขอเดียว เพื่อคุมขนาด payload
  const batches: Buffer[][] = [];
  for (let i = 0; i < images.length; i += 4) batches.push(images.slice(i, i + 4));

  const pages: OcrPage[] = [];
  for (let b = 0; b < batches.length; b++) {
    const content: Array<Record<string, unknown>> = [
      {
        type: "text",
        text:
          `ถอดข้อความทั้งหมดจากภาพเอกสารหน้าที่ ${b * 4 + 1}-${b * 4 + batches[b].length} (เอกสาร: ${hint}). ` +
          "ตอบด้วยข้อความธรรมดาเท่านั้น ไม่ต้องอธิบาย ไม่ต้องแปล คงภาษาต้นฉบับ (ไทย/อังกฤษ) ตามที่ปรากฏ และแยกหน้าด้วยบรรทัด '=== หน้า N ==='",
      },
      ...batches[b].map((img) => ({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${img.toString("base64")}` },
      })),
    ];
    const res = await fetch(`${AI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.AI_API_KEY}`,
      },
      body: JSON.stringify({ model: AI_MODEL, temperature: 0, messages: [{ role: "user", content }] }),
    });
    if (!res.ok) throw new Error(`vision OCR failed (${res.status})`);
    const data: any = await res.json();
    const text = String(data?.choices?.[0]?.message?.content || "").trim();
    if (!text) continue;
    // แยกตาม marker หน้า ถ้ามี
    const parts = text.split(/===\s*หน้า\s*(\d+)\s*===/);
    if (parts.length > 1) {
      for (let i = 1; i < parts.length; i += 2) {
        const pageNo = Number(parts[i]) || pages.length + 1;
        pages.push({ pageNo, text: cleanOcrText(parts[i + 1] || "") });
      }
    } else {
      pages.push({ pageNo: pages.length + 1, text: cleanOcrText(text) });
    }
  }
  return pages.length ? pages : null;
}

/* ---------------- จุดเข้าใช้งาน ---------------- */

export async function ocrPdf(
  buffer: Buffer,
  opts: { hint?: string; maxPages?: number } = {},
): Promise<OcrResult | null> {
  const langs = process.env.OCR_LANGS || "tha+eng";
  const maxPages = opts.maxPages ?? Number(process.env.OCR_MAX_PAGES || 20);

  // tesseract เร็วกว่าและฟรี — ลองก่อนเสมอ
  try {
    const images = await renderPdfPagesToImages(buffer, { scale: 2, maxPages });
    if (!images.length) return null;
    const pageCount = images.length;
    const viaTess = await ocrWithTesseract(images, langs).catch((err) => {
      console.warn("[OCR] tesseract failed:", err.message);
      return null;
    });
    if (viaTess?.length) return { pages: viaTess, pageCount, method: "tesseract" };

    const visionImages = await renderPdfPagesToImages(buffer, {
      scale: 1.6,
      maxPages: Math.min(maxPages, 8),
    });
    const viaVision = await ocrWithVision(visionImages, opts.hint || "เอกสารการประชุม").catch((err) => {
      console.warn("[OCR] vision failed:", err.message);
      return null;
    });
    if (viaVision?.length) return { pages: viaVision, pageCount: visionImages.length, method: "ai-vision" };

    return null;
  } catch (err: any) {
    console.error("[OCR] pipeline error:", err?.message || err);
    return null;
  }
}
