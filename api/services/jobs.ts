import { db } from "../db";

export type JobType =
  | "analyze_document"
  | "transcribe_recording"
  | "generate_minutes"
  | "generate_briefing";

export interface EnqueueInput {
  jobType: JobType;
  payload: Record<string, unknown>;
  meetingId?: string | null;
  agendaId?: string | null;
  createdBy?: number | null;
  runAfter?: Date;
}

/**
 * คิวงาน AI แบบ DB-backed (ตาราง ai_jobs)
 * สถาปัตยกรรมตามเอกสารออกแบบ: API รับคำสั่ง → สร้าง Job → Worker ประมวลผลเบื้องหลัง
 * (เปลี่ยนเป็น Redis+BullMQ ภายหลังได้โดยแทนที่ module นี้เพียงไฟล์เดียว)
 */
export async function enqueueJob(input: EnqueueInput): Promise<string> {
  const [row] = await db("ai_jobs")
    .insert({
      job_type: input.jobType,
      payload: JSON.stringify(input.payload),
      meeting_id: input.meetingId ?? null,
      agenda_id: input.agendaId ?? null,
      created_by: input.createdBy ?? null,
      run_after: input.runAfter ?? null,
      status: "queued",
    })
    .returning("id");
  return row.id as string;
}

let workerStarted = false;
let processing = false;

/** เริ่ม worker ใน process เดียวกับ API (poll ทุก 2 วินาที) */
export function startWorker(): void {
  if (workerStarted) return;
  if (process.env.AI_WORKER === "off") {
    console.log("[Jobs] worker disabled by AI_WORKER=off");
    return;
  }
  workerStarted = true;
  setInterval(() => {
    void tick().catch((err) => console.error("[Jobs] tick error:", err));
  }, 2000).unref?.();
  console.log("[Jobs] AI worker started (poll every 2s)");
}

async function tick(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    // claim งานแบบ atomic ป้องกัน worker ซ้อนกันในอนาคต
    const claimed = await db.raw(
      `UPDATE ai_jobs SET status = 'processing', started_at = now(), attempts = attempts + 1
       WHERE id = (
         SELECT id FROM ai_jobs
         WHERE status = 'queued' AND (run_after IS NULL OR run_after <= now())
         ORDER BY created_at ASC
         LIMIT 1 FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
    );
    const job = claimed.rows?.[0];
    if (!job) return;
    await runJob(job);
  } finally {
    processing = false;
  }
}

async function runJob(job: any): Promise<void> {
  const { handleAnalyzeDocument, handleTranscribeRecording, handleGenerateMinutes, handleGenerateBriefing } =
    await import("./ai/handlers");
  const handler =
    job.job_type === "analyze_document"
      ? handleAnalyzeDocument
      : job.job_type === "transcribe_recording"
        ? handleTranscribeRecording
        : job.job_type === "generate_minutes"
          ? handleGenerateMinutes
          : job.job_type === "generate_briefing"
            ? handleGenerateBriefing
            : null;

  console.log(`[Jobs] start ${job.job_type} (${job.id.slice(0, 8)} attempt ${job.attempts})`);
  try {
    if (!handler) throw new Error(`unknown job type: ${job.job_type}`);
    await handler({
      id: job.id,
      job_type: job.job_type,
      payload: typeof job.payload === "string" ? JSON.parse(job.payload) : job.payload,
      meeting_id: job.meeting_id,
      agenda_id: job.agenda_id,
      attempts: job.attempts,
      max_attempts: job.max_attempts,
    });
    await db("ai_jobs").where({ id: job.id }).update({
      status: "completed",
      completed_at: db.fn.now(),
      error: null,
    });
    console.log(`[Jobs] done ${job.job_type} (${job.id.slice(0, 8)})`);
  } catch (err: any) {
    const message = String(err?.message || err).slice(0, 2000);
    console.error(`[Jobs] failed ${job.job_type} (${job.id.slice(0, 8)}):`, message);
    if (job.attempts < job.max_attempts) {
      await db("ai_jobs")
        .where({ id: job.id })
        .update({ status: "queued", error: message, run_after: new Date(Date.now() + 15_000) });
    } else {
      await db("ai_jobs").where({ id: job.id }).update({ status: "failed", error: message });
      await markRelatedFailed(job);
    }
  }
}

async function markRelatedFailed(job: any): Promise<void> {
  try {
    const payload = typeof job.payload === "string" ? JSON.parse(job.payload) : job.payload;
    if (job.job_type === "analyze_document" && payload?.documentId) {
      await db("meeting_documents")
        .where({ id: payload.documentId })
        .update({ analysis_status: "failed", analysis_error: job.error });
    }
    if (job.job_type === "transcribe_recording" && payload?.recordingId) {
      await db("meeting_recordings").where({ id: payload.recordingId }).update({ status: "failed" });
      await db("transcription_jobs").where({ recording_id: payload.recordingId }).update({
        status: "failed",
        error: job.error,
      });
    }
  } catch {
    /* best-effort */
  }
}
