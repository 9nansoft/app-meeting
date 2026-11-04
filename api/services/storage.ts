import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Object storage abstraction — ค่าเริ่มต้นเก็บบน local filesystem
 * (ไดเรกทอรี STORAGE_DIR) โดยใช้รูปแบบ storage_key ตามเอกสารออกแบบ
 * เพื่อให้เปลี่ยนไปใช้ MinIO/S3 ภายหลังได้ง่าย
 * (ใช้ node:fs เพื่อทำงานได้ทั้ง runtime แบบ Bun และ Node)
 */
const ROOT = path.resolve(process.env.STORAGE_DIR || "./storage");

const FOLDERS = ["documents", "recordings"] as const;
export type StorageFolder = (typeof FOLDERS)[number];

function safeKey(storageKey: string): string {
  const full = path.resolve(ROOT, storageKey);
  if (!full.startsWith(ROOT)) throw new Error("Invalid storage key");
  return full;
}

export async function initStorage(): Promise<void> {
  for (const folder of FOLDERS) {
    await mkdir(path.join(ROOT, folder), { recursive: true });
  }
}

export async function saveFile(
  folder: StorageFolder,
  originalName: string,
  data: Buffer | Uint8Array,
): Promise<{ storageKey: string; size: number; checksum: string }> {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const ext = path.extname(originalName).slice(0, 20).replace(/[^.\w-]/g, "") || "";
  const id = crypto.randomUUID();
  const storageKey = `${folder}/${yyyy}/${mm}/${id}${ext}`;

  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const targetPath = safeKey(storageKey);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, buf);

  return {
    storageKey,
    size: buf.length,
    checksum: crypto.createHash("sha256").update(buf).digest("hex"),
  };
}

export async function readStorageFile(storageKey: string): Promise<Buffer> {
  return readFile(safeKey(storageKey));
}

export async function deleteFile(storageKey: string): Promise<void> {
  await unlink(safeKey(storageKey)).catch(() => undefined);
}

/* ---------- ตรวจชนิดไฟล์จากเนื้อไฟล์ (magic bytes) ---------- */

export type UploadKind = "document" | "image" | "audio";

const OFFICE_BY_EXT: Record<string, string> = {
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".doc": "application/msword",
  ".xls": "application/vnd.ms-excel",
  ".ppt": "application/vnd.ms-powerpoint",
};

/** MIME ที่อนุญาตให้ให้บริการแบบ inline (เปิดในเบราว์เซอร์ได้อย่างปลอดภัย) */
const INLINE_SAFE = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "audio/webm",
  "audio/ogg",
  "audio/mpeg",
  "audio/wav",
  "audio/mp4",
]);

const ALLOWED_SERVE = new Set([...INLINE_SAFE, ...Object.values(OFFICE_BY_EXT)]);

function startsWith(buf: Buffer, bytes: number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buf[offset + i] === b);
}

function ascii(buf: Buffer, offset: number, len: number): string {
  return buf.subarray(offset, offset + len).toString("latin1");
}

/**
 * ตรวจชนิดไฟล์จากเนื้อไฟล์จริง แล้วคืน MIME ที่ server ยืนยันเอง
 * (ไม่เชื่อ Content-Type ที่ client ส่งมา — กัน HTML/SVG ปลอมเป็นเอกสาร/รูป → Stored XSS)
 * คืน null ถ้าไม่ใช่ชนิดที่อนุญาตสำหรับ kind นั้น
 */
export function detectUploadMime(kind: UploadKind, buf: Buffer, fileName: string): string | null {
  const ext = path.extname(fileName).toLowerCase();
  if (kind === "document") {
    if (ascii(buf, 0, 5) === "%PDF-") return "application/pdf";
    // OOXML (docx/xlsx/pptx) เป็น zip
    if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) && [".docx", ".xlsx", ".pptx"].includes(ext)) {
      return OFFICE_BY_EXT[ext]!;
    }
    // OLE2 (doc/xls/ppt)
    if (startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) && [".doc", ".xls", ".ppt"].includes(ext)) {
      return OFFICE_BY_EXT[ext]!;
    }
    return null;
  }
  if (kind === "image") {
    if (startsWith(buf, [0xff, 0xd8, 0xff])) return "image/jpeg";
    if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
    if (ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 4) === "WEBP") return "image/webp";
    if (ascii(buf, 0, 4) === "GIF8") return "image/gif";
    return null;
  }
  // audio
  if (startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3])) return "audio/webm"; // webm/matroska
  if (ascii(buf, 0, 4) === "OggS") return "audio/ogg";
  if (ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 4) === "WAVE") return "audio/wav";
  if (ascii(buf, 4, 4) === "ftyp") return "audio/mp4";
  if (ascii(buf, 0, 3) === "ID3" || (buf.length > 1 && buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0)) {
    return "audio/mpeg";
  }
  return null;
}

/**
 * สร้าง Response สำหรับให้บริการไฟล์ที่ผู้ใช้อัปโหลดอย่างปลอดภัย
 * - MIME ที่ไม่อยู่ใน allowlist (เช่นไฟล์เก่าที่บันทึก text/html ไว้) → octet-stream + attachment
 * - nosniff + CSP sandbox กันเบราว์เซอร์รันสคริปต์ในไฟล์บน origin ของแอป
 */
export function fileResponse(
  data: Buffer,
  storedMime: string | null | undefined,
  opts: { fileName?: string; inline?: boolean; cacheControl?: string } = {},
): Response {
  const mime = storedMime && ALLOWED_SERVE.has(storedMime) ? storedMime : "application/octet-stream";
  const inline = opts.inline !== false && INLINE_SAFE.has(mime);
  const headers: Record<string, string> = {
    "Content-Type": mime,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cache-Control": opts.cacheControl ?? "private, max-age=300",
  };
  const name = opts.fileName ? `; filename*=UTF-8''${encodeURIComponent(opts.fileName)}` : "";
  headers["Content-Disposition"] = `${inline ? "inline" : "attachment"}${name}`;
  return new Response(new Uint8Array(data), { headers });
}

export function mimeFromName(name: string): string {
  const ext = path.extname(name).toLowerCase();
  const map: Record<string, string> = {
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".webm": "audio/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".ogg": "audio/ogg",
  };
  return map[ext] || "application/octet-stream";
}
