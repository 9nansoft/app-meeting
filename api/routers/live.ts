import { Elysia, t } from "elysia";
import { db, ensureSchema } from "../db";
import { requireRole, readUploadBody } from "./_lib";
import { writeAudit } from "../services/audit";
import { saveFile, deleteFile, detectUploadMime } from "../services/storage";
import { authorizeMeeting } from "../services/access";
import { enqueueJob } from "../services/jobs";

const MAX_AUDIO_SIZE = 200 * 1024 * 1024; // 200MB

export const liveRoutes = new Elysia({ prefix: "/meetings" })
  .use(requireRole())
  /**
   * อัปโหลดไฟล์เสียงบันทึกการประชุม (ส่งได้หลายช่วง — ระบบถอดเสียงทันทีที่ได้รับไฟล์)
   * multipart field "file" หรือ binary body + header x-file-name
   */
  .post(
    "/:id/recordings",
    async ({ params, body, headers, user, set }) => {
      await ensureSchema();
      const access = await authorizeMeeting(user, params.id, "view");
      if (!access.ok) {
        set.status = access.status;
        return { error: access.error };
      }
      const meeting = access.meeting;
      const upload = await readUploadBody(body);
      if (!upload) {
        set.status = 400;
        return { error: "กรุณาแนบไฟล์เสียง" };
      }
      if (upload.buffer.length > MAX_AUDIO_SIZE) {
        set.status = 413;
        return { error: "ไฟล์เสียงใหญ่เกิน 200MB" };
      }
      let fileName = upload.fileName;
      try {
        fileName = decodeURIComponent((headers["x-file-name"] as string) || upload.fileName);
      } catch {
        /* header เข้ารหัสไม่ถูกต้อง — ใช้ชื่อไฟล์จาก multipart */
      }
      fileName = fileName.replace(/[\u0000-\u001f\u007f\/\\]/g, "_").slice(0, 500);
      const mimeType = detectUploadMime("audio", upload.buffer, fileName);
      if (!mimeType) {
        set.status = 415;
        return { error: "รองรับเฉพาะไฟล์เสียง (WebM, Ogg, MP3, WAV, M4A)" };
      }
      const durationSeconds = Number(headers["x-duration-seconds"]) || null;
      const agendaHeader = (headers["x-agenda-id"] as string) || null;
      let agendaId: string | null = null;
      if (agendaHeader && agendaHeader !== "null") {
        const agenda = await db("meeting_agendas").where({ id: agendaHeader, meeting_id: params.id }).first().catch(() => null);
        if (!agenda) {
          set.status = 404;
          return { error: "ไม่พบวาระที่ระบุ" };
        }
        agendaId = agenda.id;
      }

      const stored = await saveFile("recordings", fileName, upload.buffer);
      const [recording] = await db("meeting_recordings")
        .insert({
          meeting_id: params.id,
          uploaded_by: Number(user!.id),
          storage_key: stored.storageKey,
          mime_type: mimeType,
          file_size: stored.size,
          duration_seconds: durationSeconds,
          status: "uploaded",
          started_at: body && typeof body === "object" && (body as any).startedAt
            ? new Date((body as any).startedAt)
            : null,
          ended_at: new Date(),
        })
        .returning("*");

      await db("transcription_jobs").insert({
        recording_id: recording.id,
        status: "queued",
      });

      const jobId = await enqueueJob({
        jobType: "transcribe_recording",
        payload: { recordingId: recording.id, agendaId },
        meetingId: params.id,
        agendaId,
        createdBy: Number(user!.id),
      });

      // ถ้าการประชุมยังไม่ได้เริ่ม ให้เปลี่ยนสถานะเป็นกำลังประชุม
      if (meeting.status === "scheduled") {
        await db("meetings").where({ id: params.id }).update({ status: "in_progress" });
      }

      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "recording.upload",
        entityType: "meeting_recordings",
        entityId: recording.id,
        newValue: { fileName, size: stored.size },
      });

      set.status = 201;
      return { recording, transcriptionJobId: jobId };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Any({}),
    },
  )

  // รายการไฟล์เสียงของการประชุม
  .get(
    "/:id/recordings",
    async ({ params, user, set }) => {
      await ensureSchema();
      const access = await authorizeMeeting(user, params.id, "view");
      if (!access.ok) {
        set.status = access.status;
        return { error: access.error };
      }
      const recordings = await db("meeting_recordings")
        .where({ meeting_id: params.id })
        .orderBy("created_at", "asc");
      return { recordings };
    },
    { params: t.Object({ id: t.String() }) },
  )

  // Transcript ทั้งหมดของการประชุม (สำหรับ polling ระหว่างประชุม)
  .get(
    "/:id/transcript",
    async ({ params, query, user, set }) => {
      await ensureSchema();
      const access = await authorizeMeeting(user, params.id, "view");
      if (!access.ok) {
        set.status = access.status;
        return { error: access.error };
      }
      const q = db("transcript_segments")
        .where({ meeting_id: params.id })
        .orderBy("sequence_no", "asc");
      if (query.after) q.where("created_at", ">", query.after);
      const segments = await q;
      const recordings = await db("meeting_recordings")
        .where({ meeting_id: params.id })
        .select("id", "status");
      return {
        segments,
        recordings,
      };
    },
    {
      params: t.Object({ id: t.String() }),
      query: t.Object({ after: t.Optional(t.String()) }),
    },
  )

  // เชื่อมโยงช่วง transcript กับวาระ (link_type: discussion/decision/assignment)
  .post(
    "/:id/transcript/link",
    async ({ params, body, user, set }) => {
      await ensureSchema();
      const access = await authorizeMeeting(user, params.id, "manage");
      if (!access.ok) {
        set.status = access.status;
        return { error: access.error };
      }
      const agenda = await db("meeting_agendas").where({ id: body.agendaId, meeting_id: params.id }).first();
      if (!agenda) {
        set.status = 404;
        return { error: "ไม่พบวาระ" };
      }
      const segment = await db("transcript_segments")
        .where({ id: body.segmentId, meeting_id: params.id })
        .first();
      if (!segment) {
        set.status = 404;
        return { error: "ไม่พบช่วงข้อความ" };
      }
      await db("transcript_segments").where({ id: body.segmentId }).update({ agenda_id: body.agendaId });
      await db("agenda_transcript_links").insert({
        agenda_id: body.agendaId,
        segment_id: body.segmentId,
        meeting_id: params.id,
        link_type: body.linkType || "discussion",
        linked_by: Number(user!.id),
      });
      return { success: true };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        segmentId: t.String(),
        agendaId: t.String(),
        linkType: t.Optional(t.String()),
      }),
    },
  )

  // อัปเดตสถานะวาระปัจจุบัน (เลขาเลือกว่ากำลังประชุมวาระใด)
  .post(
    "/:id/current-agenda",
    async ({ params, body, user, set }) => {
      await ensureSchema();
      const access = await authorizeMeeting(user, params.id, "manage");
      if (!access.ok) {
        set.status = access.status;
        return { error: access.error };
      }
      const agenda = await db("meeting_agendas")
        .where({ id: body.agendaId, meeting_id: params.id })
        .first();
      if (!agenda) {
        set.status = 404;
        return { error: "ไม่พบวาระ" };
      }
      await db("meeting_agendas")
        .where({ meeting_id: params.id })
        .whereNot("status", "done")
        .update({ status: "pending" });
      await db("meeting_agendas").where({ id: body.agendaId }).update({ status: "presenting" });
      return { success: true };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({ agendaId: t.String() }),
    },
  )

  // ลบไฟล์เสียง (ลบ transcript ของไฟล์นั้นด้วย)
  .delete(
    "/recordings/:recordingId",
    async ({ params, user, set }) => {
      await ensureSchema();
      const recording = await db("meeting_recordings").where({ id: params.recordingId }).first();
      if (!recording) {
        set.status = 404;
        return { error: "ไม่พบไฟล์เสียง" };
      }
      const access = await authorizeMeeting(user, recording.meeting_id, "view");
      if (!access.ok) {
        set.status = 404;
        return { error: "ไม่พบไฟล์เสียง" };
      }
      const meeting = access.meeting;
      if (
        recording.uploaded_by !== Number(user!.id) &&
        meeting.organizer_id !== Number(user!.id) &&
        user!.role !== "admin"
      ) {
        set.status = 403;
        return { error: "ลบได้เฉพาะผู้อัปโหลด ผู้จัดประชุม หรือ admin" };
      }
      await db("meeting_recordings").where({ id: params.recordingId }).del();
      await deleteFile(recording.storage_key).catch(() => undefined);
      await writeAudit({
        userId: Number(user!.id),
        username: user!.username,
        action: "recording.delete",
        entityType: "meeting_recordings",
        entityId: params.recordingId,
      });
      return { success: true };
    },
    { params: t.Object({ recordingId: t.String() }) },
  );
