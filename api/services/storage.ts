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
