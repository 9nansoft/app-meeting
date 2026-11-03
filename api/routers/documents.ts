import { Elysia, t } from "elysia";
import { db, ensureSchema } from "../db";
import { requireRole, readUploadBody } from "./_lib";
import { writeAudit } from "../services/audit";
import { saveFile, readStorageFile, deleteFile, detectUploadMime, fileResponse } from "../services/storage";
import { authorizeMeeting, canManageMeetingRow } from "../services/access";
import { enqueueJob } from "../services/jobs";

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

async function autoAnalyzeEnabled(): Promise<boolean> {
  const row = await db("system_settings").where({ key: "ai_auto_analyze" }).first();
  if (!row) return true;
  try {
    const value = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
    return value !== false;
  } catch {
    return true;
  }
}

export const documentsRoutes = new Elysia({ prefix: "/meetings" })
  // สิทธิ์ตัดสินตามความเกี่ยวข้องกับการประชุม (authorizeMeeting) ไม่ใช่ชื่อบทบาท
  .use(requireRole())
  /**
   * อัปโหลดเอกสาร PDF ของวาระ (multipart form-data: field "file")
   * ระบบจะเก็บเป็นเวอร์ชันใหม่ถ้าวาระนี้มีเอกสารชื่อเดียวกัน
   * และสั่งวิเคราะห์ด้วย AI อัตโนมัติ (ตามค่า system_settings)
   */
  .post(
    "/:id/documents",
    async ({ params, body, user, set, headers }) => {
      await ensureSchema();
      // ผู้เข้าร่วมการประชุม (เช่นผู้นำเสนอวาระ) อัปโหลดเอกสารได้
      const access = await authorizeMeeting(user, params.id, "view");
      if (!access.ok) {
        set.status = access.status;
        return { error: access.error };
      }

      const upload = await readUploadBody(body);
      if (!upload) {
        set.status = 400;
        return { error: "กรุณาแนบไฟล์ (multipart field 'file' หรือ binary body)" };
      }
      if (upload.buffer.length > MAX_FILE_SIZE) {
        set.status = 413;
        return { error: "ไฟล์ใหญ่เกิน 100MB" };
      }
      let fileName = upload.fileName;
      try {
        fileName = decodeURIComponent((headers["x-file-name"] as string) || upload.fileName);
      } catch {
        /* header เข้ารหัสไม่ถูกต้อง — ใช้ชื่อไฟล์จาก multipart */
      }
      fileName = fileName.replace(/[\u0000-\u001f\u007f\/\\]/g, "_").slice(0, 500);
      // ตรวจชนิดไฟล์จากเนื้อไฟล์จริง (ไม่เชื่อ Content-Type จาก client)
      const mimeType = detectUploadMime("document", upload.buffer, fileName);
      if (!mimeType) {
        set.status = 415;
        return { error: "รองรับเฉพาะไฟล์ PDF, Word, Excel หรือ PowerPoint" };
      }

      let agendaId: string | null = null;
      const agendaHeader = headers["x-agenda-id"] as string | undefined;
      if (agendaHeader && agendaHeader !== "null") agendaId = agendaHeader;
      if (agendaId) {
        const agenda = await db("meeting_agendas")
          .where({ id: agendaId, meeting_id: params.id })
          .first();
        if (!agenda) {
          set.status = 404;
          return { error: "ไม่พบวาระที่ระบุ" };
        }
      }

      // เวอร์ชันใหม่ถ้ามีไฟล์ชื่อเดียวกันในวาระ/การประชุมนี้
      const previous = await db("meeting_documents")
        .where({ meeting_id: params.id, agenda_id: agendaId, file_name: fileName })
        .orderBy("file_version", "desc")
        .first();
      const fileVersion = (previous?.file_version || 0) + 1;

      const stored = await saveFile("documents", fileName, upload.buffer);
      const [doc] = await db("meeting_documents")
        .insert({
          meeting_id: params.id,
          agenda_id: agendaId,
          uploader_id: Number(user!.id),
          file_name: fileName,
          storage_key: stored.storageKey,
          mime_type: mimeType,
          file_size: stored.size,
          checksum: stored.checksum,
          file_version: fileVersion,
          analysis_status: "pending",
          replaced_document_id: previous?.id || null,
        })
        .returning("*");

      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "document.upload",
        entityType: "meeting_documents",
        entityId: doc.id,
        newValue: { fileName, fileVersion, agendaId },
      });

      // วิเคราะห์อัตโนมัติด้วย AI
      let jobId: string | null = null;
      if (mimeType === "application/pdf" && (await autoAnalyzeEnabled())) {
        jobId = await enqueueJob({
          jobType: "analyze_document",
          payload: { documentId: doc.id },
          meetingId: params.id,
          agendaId,
          createdBy: Number(user!.id),
        });
      }

      set.status = 201;
      return { document: doc, analysisJobId: jobId };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Any({}),
    },
  )

  // ดาวน์โหลด/ดูเอกสาร (จำกัดสิทธิ์ตามผู้เข้าร่วมการประชุม)
  .get(
    "/documents/:docId/download",
    async ({ params, user, set }) => {
      await ensureSchema();
      const doc = await db("meeting_documents").where({ id: params.docId }).first();
      if (!doc) {
        set.status = 404;
        return { error: "ไม่พบเอกสาร" };
      }
      const access = await authorizeMeeting(user, doc.meeting_id, "view");
      if (!access.ok) {
        set.status = 403;
        return { error: "เอกสารนี้เปิดเฉพาะผู้เข้าร่วมการประชุม" };
      }
      const buffer = await readStorageFile(doc.storage_key);
      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "document.download",
        entityType: "meeting_documents",
        entityId: doc.id,
      });
      return fileResponse(buffer, doc.mime_type, { fileName: doc.file_name });
    },
    { params: t.Object({ docId: t.String() }) },
  )

  // ลบเอกสาร
  .delete(
    "/documents/:docId",
    async ({ params, user, set }) => {
      await ensureSchema();
      const doc = await db("meeting_documents").where({ id: params.docId }).first();
      if (!doc) {
        set.status = 404;
        return { error: "ไม่พบเอกสาร" };
      }
      const access = await authorizeMeeting(user, doc.meeting_id, "view");
      if (!access.ok) {
        set.status = 404;
        return { error: "ไม่พบเอกสาร" };
      }
      const isOwner =
        doc.uploader_id === Number(user!.id) ||
        access.meeting.organizer_id === Number(user!.id) ||
        user!.role === "admin";
      if (!isOwner) {
        set.status = 403;
        return { error: "ลบได้เฉพาะผู้อัปโหลด ผู้จัดประชุม หรือ admin" };
      }
      await db("meeting_documents").where({ id: params.docId }).del();
      await deleteFile(doc.storage_key).catch(() => undefined);
      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "document.delete",
        entityType: "meeting_documents",
        entityId: params.docId,
        oldValue: { fileName: doc.file_name },
      });
      return { success: true };
    },
    { params: t.Object({ docId: t.String() }) },
  )

  // สั่งวิเคราะห์เอกสารด้วย AI (หรือวิเคราะห์ซ้ำ)
  .post(
    "/documents/:docId/analyze",
    async ({ params, user, set }) => {
      await ensureSchema();
      const doc = await db("meeting_documents").where({ id: params.docId }).first();
      if (!doc) {
        set.status = 404;
        return { error: "ไม่พบเอกสาร" };
      }
      const access = await authorizeMeeting(user, doc.meeting_id, "view");
      if (!access.ok) {
        set.status = 404;
        return { error: "ไม่พบเอกสาร" };
      }
      if (doc.uploader_id !== Number(user!.id) && !canManageMeetingRow(user, access.meeting)) {
        set.status = 403;
        return { error: "สั่งวิเคราะห์ได้เฉพาะผู้อัปโหลด ผู้จัดประชุม เลขานุการ หรือผู้ดูแลระบบ" };
      }
      if (doc.mime_type !== "application/pdf") {
        set.status = 400;
        return { error: "รองรับเฉพาะไฟล์ PDF สำหรับการวิเคราะห์" };
      }
      const jobId = await enqueueJob({
        jobType: "analyze_document",
        payload: { documentId: doc.id },
        meetingId: doc.meeting_id,
        agendaId: doc.agenda_id,
        createdBy: Number(user!.id),
      });
      await db("meeting_documents")
        .where({ id: doc.id })
        .update({ analysis_status: "pending", analysis_error: null });
      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "document.analyze",
        entityType: "meeting_documents",
        entityId: doc.id,
      });
      return { jobId };
    },
    { params: t.Object({ docId: t.String() }) },
  )

  // สร้าง Briefing รวมทุกวาระ (เอกสารชุดประชุมก่อนประชุม)
  .post(
    "/:id/briefing",
    async ({ params, user, set }) => {
      await ensureSchema();
      const access = await authorizeMeeting(user, params.id, "manage");
      if (!access.ok) {
        set.status = access.status;
        return { error: access.error };
      }
      const jobId = await enqueueJob({
        jobType: "generate_briefing",
        payload: { meetingId: params.id },
        meetingId: params.id,
        createdBy: Number(user!.id),
      });
      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "meeting.briefing.generate",
        entityType: "meetings",
        entityId: params.id,
      });
      set.status = 202;
      return { jobId };
    },
    { params: t.Object({ id: t.String() }) },
  )

  // ดู Briefing ล่าสุด
  .get(
    "/:id/briefing",
    async ({ params, user, set }) => {
      await ensureSchema();
      const access = await authorizeMeeting(user, params.id, "view");
      if (!access.ok) {
        set.status = access.status;
        return { error: access.error };
      }
      const job = await db("ai_jobs")
        .where({ meeting_id: params.id, job_type: "generate_briefing", status: "completed" })
        .orderBy("completed_at", "desc")
        .first();
      if (!job) {
        return { briefing: null };
      }
      const result = await db("ai_job_results")
        .where({ job_id: job.id, result_type: "briefing" })
        .first();
      let content: any = null;
      if (result) {
        try {
          content = typeof result.content === "string" ? JSON.parse(result.content) : result.content;
        } catch {
          content = { markdown: String(result.content) };
        }
      }
      return {
        briefing: content,
        generatedAt: job.completed_at,
        status: job.status,
      };
    },
    { params: t.Object({ id: t.String() }) },
  );
