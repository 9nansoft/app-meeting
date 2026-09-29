import { Elysia, t } from "elysia";
import { db, ensureSchema } from "../db";
import { requireRole } from "./_lib";
import { isAiConfigured, embedTexts, cosineSimilarity, AI_EMBED_MODEL } from "../services/ai/provider";

/**
 * ค้นหาเชิงความหมาย (semantic search) ในเนื้อหาเอกสารการประชุม
 * - ถ้ามี AI และ chunks มี embedding → cosine similarity บนเวกเตอร์
 * - ถ้าไม่มี → fallback เป็นการค้นหาคำ (ILIKE) ก็ยังใช้งานได้
 * ผลลัพธ์ชี้กลับไปที่เอกสาร/วาระ/เลขหน้า เพื่อให้ตรวจสอบต้นฉบับได้
 */
export const searchRoutes = new Elysia({ prefix: "/search" })
  .use(requireRole())
  .post(
    "/",
    async ({ body }) => {
      await ensureSchema();
      const q = body.query.trim();
      if (!q) return { mode: "keyword", results: [] };

      const chunkQuery = db("document_chunks")
        .join("meeting_documents", "meeting_documents.id", "=", "document_chunks.document_id")
        .join("meetings", "meetings.id", "=", "meeting_documents.meeting_id")
        .leftJoin("meeting_agendas", "meeting_agendas.id", "=", "document_chunks.agenda_id")
        .select(
          "document_chunks.id",
          "document_chunks.content",
          "document_chunks.page_no",
          "document_chunks.embedding",
          "meeting_documents.file_name",
          "meeting_documents.meeting_id",
          "meeting_documents.ocr_used",
          "meetings.title as meeting_title",
          "meeting_agendas.title as agenda_title",
          "meeting_agendas.sequence_no as agenda_no",
        )
        .limit(body.meetingId ? 2000 : 5000);
      if (body.meetingId) chunkQuery.where("meeting_documents.meeting_id", body.meetingId);
      const chunks = await chunkQuery;

      const topK = Math.min(body.topK ?? 10, 30);

      // ---------- 1) ค้นแบบเวกเตอร์ ----------
      if (isAiConfigured()) {
        const withEmbedding = chunks.filter(
          (c: any) => typeof c.embedding === "string" && c.embedding.startsWith("["),
        );
        if (withEmbedding.length > 0) {
          try {
            const [queryVec] = (await embedTexts([q])) ?? [];
            if (queryVec) {
              const scored = withEmbedding
                .map((c: any) => {
                  let vec: number[] | null = null;
                  try {
                    vec = JSON.parse(c.embedding);
                  } catch {
                    vec = null;
                  }
                  return vec ? { chunk: c, score: cosineSimilarity(queryVec, vec) } : null;
                })
                .filter((x: any): x is { chunk: any; score: number } => x !== null)
                .sort((a: any, b: any) => b.score - a.score)
                .slice(0, topK)
                .filter((x: any) => x.score > 0.2);

              return {
                mode: "vector",
                model: AI_EMBED_MODEL,
                results: scored.map(({ chunk, score }) => ({
                  id: chunk.id,
                  score,
                  snippet: snippetAround(chunk.content, q),
                  page_no: chunk.page_no,
                  file_name: chunk.file_name,
                  meeting_id: chunk.meeting_id,
                  meeting_title: chunk.meeting_title,
                  agenda_title: chunk.agenda_title,
                  agenda_no: chunk.agenda_no,
                  ocr_used: chunk.ocr_used,
                })),
              };
            }
          } catch {
            /* fall through ไป keyword */
          }
        }
      }

      // ---------- 2) fallback: ค้นหาคำ ----------
      const terms: string[] = q.split(/\s+/).filter((s: string) => s.length > 1);
      const matches = terms.length
        ? chunks.filter((c: any) => terms.some((term: string) => c.content.includes(term)))
        : [];
      // ให้คะแนนคร่าว ๆ ตามจำนวนคำที่เจอ
      const scored = matches
        .map((c: any) => ({
          chunk: c,
          score: terms.filter((term: string) => c.content.includes(term)).length / terms.length,
        }))
        .sort((a: any, b: any) => b.score - a.score)
        .slice(0, topK);

      return {
        mode: "keyword",
        model: null as string | null,
        results: scored.map(({ chunk, score }) => ({
          id: chunk.id,
          score,
          snippet: snippetAround(chunk.content, q),
          page_no: chunk.page_no,
          file_name: chunk.file_name,
          meeting_id: chunk.meeting_id,
          meeting_title: chunk.meeting_title,
          agenda_title: chunk.agenda_title,
          agenda_no: chunk.agenda_no,
          ocr_used: chunk.ocr_used,
        })),
      };
    },
    {
      body: t.Object({
        query: t.String({ minLength: 1 }),
        meetingId: t.Optional(t.String()),
        topK: t.Optional(t.Number()),
      }),
    },
  );

/** ตัดข้อความรอบ ๆ คำค้นเพื่อแสดงเป็น snippet */
function snippetAround(content: string, query: string, context = 90): string {
  const terms = query.split(/\s+/).filter((s) => s.length > 1);
  let idx = -1;
  for (const term of terms) {
    idx = content.indexOf(term);
    if (idx >= 0) break;
  }
  if (idx < 0) return content.slice(0, context * 2).trim() + (content.length > context * 2 ? "…" : "");
  const start = Math.max(0, idx - context);
  const end = Math.min(content.length, idx + context);
  return (start > 0 ? "…" : "") + content.slice(start, end).trim() + (end < content.length ? "…" : "");
}
