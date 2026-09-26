import { extractText, getDocumentProxy } from "unpdf";

export interface PdfPage {
  pageNo: number;
  text: string;
}

export interface PdfExtractResult {
  pages: PdfPage[];
  pageCount: number;
  fullText: string;
}

/** สกัดข้อความจาก PDF แยกตามหน้า เพื่อให้ AI อ้างอิงเลขหน้าได้ */
export async function extractPdfPages(buffer: Buffer): Promise<PdfExtractResult> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: false });
  const pageTexts = Array.isArray(text) ? text : [String(text)];

  const pages: PdfPage[] = pageTexts.map((t, i) => ({
    pageNo: i + 1,
    text: normalizeText(t),
  }));

  return {
    pages,
    pageCount: pages.length,
    fullText: pages.map((p) => p.text).join("\n"),
  };
}

function normalizeText(text: string): string {
  return text
    .replace(/\u0000/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** แบ่งข้อความรวมเป็น chunk เก็บลง document_chunks (รองรับค้นหา/อ้างอิงภายหลัง) */
export function chunkPages(
  pages: PdfPage[],
  maxChars = 1800,
): Array<{ pageNo: number; chunkIndex: number; content: string }> {
  const chunks: Array<{ pageNo: number; chunkIndex: number; content: string }> = [];
  let chunkIndex = 0;
  for (const page of pages) {
    if (!page.text) continue;
    let offset = 0;
    while (offset < page.text.length) {
      const content = page.text.slice(offset, offset + maxChars);
      if (content.trim()) {
        chunks.push({ pageNo: page.pageNo, chunkIndex: chunkIndex++, content });
      }
      offset += maxChars;
    }
  }
  return chunks;
}
