import { db } from "../../db";
import { readStorageFile } from "../storage";
import { extractPdfPages, chunkPages } from "../pdf";
import {
  chatCompletion,
  parseJsonLoose,
  transcribeAudio,
  isAiConfigured,
  AI_MODEL,
  AI_EMBED_MODEL,
  embedTexts,
} from "./provider";
import { ocrPdf } from "../ocr";
import {
  heuristicAgendaSummary,
  heuristicMinutes,
  mockTranscript,
  type AgendaSummaryResult,
  type MinutesDraft,
} from "./heuristic";
import { notify } from "../notifications";

export interface AiJobRow {
  id: string;
  job_type: string;
  payload: any;
  meeting_id: string | null;
  agenda_id: string | null;
  attempts: number;
  max_attempts: number;
}

async function logUsage(
  jobId: string,
  model: string,
  usage: { inputTokens?: number; outputTokens?: number } | null,
  durationMs: number,
): Promise<void> {
  await db("ai_model_usage").insert({
    job_id: jobId,
    provider: isAiConfigured() ? "openai-compatible" : "heuristic",
    model,
    input_tokens: usage?.inputTokens ?? null,
    output_tokens: usage?.outputTokens ?? null,
    duration_ms: durationMs,
  });
}

/* ------------------------------------------------------------------ */
/* 1) วิเคราะห์เอกสาร PDF ของวาระ → สรุป AI พร้อมเลขหน้าอ้างอิง        */
/* ------------------------------------------------------------------ */
export async function handleAnalyzeDocument(job: AiJobRow): Promise<void> {
  const documentId = job.payload?.documentId;
  if (!documentId) throw new Error("missing documentId");

  const doc = await db("meeting_documents").where({ id: documentId }).first();
  if (!doc) throw new Error(`document ${documentId} not found`);
  await db("meeting_documents").where({ id: documentId }).update({
    analysis_status: "processing",
    analysis_error: null,
  });

  const buffer = await readStorageFile(doc.storage_key);
  let { pages, pageCount } = await extractPdfPages(buffer);

  // กรณีไฟล์สแกน (ไม่มี text layer) → ใช้ OCR สำรองอัตโนมัติ
  let ocrUsed = false;
  let ocrMethod: string | null = null;
  let scannedWithoutOcr = false;
  const totalChars = pages.reduce((sum, p) => sum + p.text.replace(/\s/g, "").length, 0);
  if (pageCount > 0 && totalChars < Math.min(30 * pageCount, 200)) {
    console.log(`[OCR] "${doc.file_name}" ดูเหมือนไฟล์สแกน (${totalChars} chars) — เริ่ม OCR`);
    const ocrStarted = Date.now();
    const ocr = await ocrPdf(buffer, { hint: doc.file_name });
    if (ocr && ocr.pages.length) {
      pages = ocr.pages;
      pageCount = Math.max(ocr.pageCount, ocr.pages.length);
      ocrUsed = true;
      ocrMethod = ocr.method;
      await logUsage(job.id, `ocr:${ocr.method}`, null, Date.now() - ocrStarted);
      console.log(`[OCR] สำเร็จด้วย ${ocr.method}: ${ocr.pages.length} หน้า, ${Date.now() - ocrStarted}ms`);
    } else {
      scannedWithoutOcr = true;
      console.warn(`[OCR] ไม่สามารถ OCR "${doc.file_name}" ได้ (ยังไม่มี tesseract/AI ที่ใช้ได้)`);
    }
  }

  // เก็บ chunks สำหรับค้นหา/อ้างอิงย้อนหลัง (แทนที่ของเดิมของเอกสารนี้)
  await db("document_chunks").where({ document_id: documentId }).del();
  const chunks = chunkPages(pages);
  let insertedChunkIds: string[] = [];
  if (chunks.length) {
    insertedChunkIds = await db("document_chunks")
      .insert(
        chunks.map((c) => ({
          document_id: documentId,
          agenda_id: doc.agenda_id,
          chunk_index: c.chunkIndex,
          page_no: c.pageNo,
          content: c.content,
          token_count: Math.ceil(c.content.length / 4),
        })),
      )
      .returning("id");
  }

  // สร้าง embedding ของ chunks สำหรับค้นหาเชิงความหมาย (best-effort)
  if (insertedChunkIds.length && isAiConfigured()) {
    try {
      const vectors = await embedTexts(chunks.map((c) => c.content.slice(0, 4000)));
      if (vectors && vectors.length === chunks.length) {
        for (let i = 0; i < vectors.length; i++) {
          await db("document_chunks")
            .where({ id: insertedChunkIds[i] })
            .update({ embedding: JSON.stringify(vectors[i]), embedding_model: AI_EMBED_MODEL });
        }
        console.log(`[Vector] embedded ${vectors.length} chunks (${doc.file_name})`);
      }
    } catch (err: any) {
      console.warn("[Vector] embedding ล้มเหลว (ไม่กระทบการสรุป):", err?.message);
    }
  }

  const agenda = doc.agenda_id
    ? await db("meeting_agendas").where({ id: doc.agenda_id }).first()
    : null;
  const agendaTitle = agenda?.title || "วาระ (ไม่ระบุ)";

  let result: AgendaSummaryResult;
  let usedModel = "heuristic";

  const promptRow = await db("ai_prompts")
    .where({ code: "summarize_agenda", is_active: true })
    .orderBy("version", "desc")
    .first();
  const pagesText = pages
    .slice(0, 40)
    .map((p) => `--- หน้า ${p.pageNo} ---\n${p.text.slice(0, 3000)}`)
    .join("\n\n")
    .slice(0, 60000);

  const started = Date.now();
  if (isAiConfigured() && pagesText.trim()) {
    const template = promptRow?.template || "สรุปเอกสารประกอบวาระการประชุมต่อไปนี้เป็น JSON";
    const userPrompt = template
      .replaceAll("{{agenda_title}}", agendaTitle)
      .replaceAll("{{agenda_type}}", agenda?.agenda_type || "consideration")
      .replaceAll("{{pages}}", pagesText);
    const chat = await chatCompletion(
      [
        { role: "system", content: "คุณเป็นผู้ช่วยเลขานุการที่สรุปเอกสารการประชุมอย่างระมัดระวัง ตอบเป็น JSON เท่านั้น" },
        { role: "user", content: userPrompt },
      ],
      { json: true },
    );
    if (chat) {
      const parsed = parseJsonLoose<AgendaSummaryResult>(chat.text);
      if (parsed?.summary) {
        result = parsed;
        usedModel = chat.model;
        await logUsage(job.id, chat.model, chat, Date.now() - started);
      } else {
        result = heuristicAgendaSummary(pages, agendaTitle);
      }
    } else {
      result = heuristicAgendaSummary(pages, agendaTitle);
    }
  } else {
    result = heuristicAgendaSummary(pages, agendaTitle);
    await logUsage(job.id, usedModel, null, Date.now() - started);
  }

  if (ocrUsed) {
    result.summary = `【สกัดข้อความด้วย OCR (${ocrMethod === "ai-vision" ? "AI Vision" : "Tesseract"}) — โปรดตรวจสอบความถูกต้องของตัวอักษร】 ${result.summary}`;
  } else if (scannedWithoutOcr) {
    result.summary =
      `ไฟล์นี้เป็น PDF สแกน (ไม่มี text layer) และระบบยังไม่ได้ตั้งค่า OCR — ` +
      `ติดตั้ง tesseract (Docker image ของระบบติดตั้งไว้ให้) หรือตั้งค่า AI_API_KEY เพื่อใช้ AI Vision OCR แล้วกด "วิเคราะห์ใหม่" `;
    result.key_points = [];
    result.key_numbers = [];
  }

  // แทนที่สรุปเดิมของเอกสาร/วาระนี้
  await db("agenda_ai_summaries")
    .where({ agenda_id: doc.agenda_id, document_id: documentId })
    .del();
  await db("agenda_ai_summaries").insert({
    agenda_id: doc.agenda_id,
    document_id: documentId,
    summary: result.summary,
    key_points: JSON.stringify(result.key_points ?? []),
    key_numbers: JSON.stringify(result.key_numbers ?? []),
    considerations: JSON.stringify(result.considerations ?? []),
    questions: JSON.stringify(result.questions ?? []),
    page_references: JSON.stringify(result.page_references ?? []),
    provider: isAiConfigured() ? "openai-compatible" : "heuristic",
    model: usedModel,
    needs_review: true,
  });

  await db("meeting_documents").where({ id: documentId }).update({
    analysis_status: "completed",
    page_count: pageCount,
    ocr_used: ocrUsed,
    ocr_method: ocrMethod,
    updated_at: db.fn.now(),
  });

  if (doc.uploader_id) {
    await notify({
      userIds: [doc.uploader_id],
      type: "info",
      title: `AI สรุปเอกสาร "${doc.file_name}" เรียบร้อย`,
      body: `วาระ: ${agendaTitle} — พร้อมใช้งานในหน้า Meeting Workspace`,
      link: doc.meeting_id ? `/meetings/${doc.meeting_id}` : undefined,
      meetingId: doc.meeting_id,
    });
  }
}

/* ------------------------------------------------------------------ */
/* 2) ถอดเสียงบันทึกการประชุม → transcript segments พร้อมเวลา          */
/* ------------------------------------------------------------------ */
export async function handleTranscribeRecording(job: AiJobRow): Promise<void> {
  const recordingId = job.payload?.recordingId;
  if (!recordingId) throw new Error("missing recordingId");

  const recording = await db("meeting_recordings").where({ id: recordingId }).first();
  if (!recording) throw new Error(`recording ${recordingId} not found`);

  const tj = await db("transcription_jobs").where({ recording_id: recordingId }).first();
  if (tj) {
    await db("transcription_jobs").where({ id: tj.id }).update({
      status: "processing",
      started_at: db.fn.now(),
    });
  }
  await db("meeting_recordings").where({ id: recordingId }).update({ status: "transcribing" });

  const buffer = await readStorageFile(recording.storage_key);
  const fileName = recording.storage_key.split("/").pop() || "audio.webm";
  const started = Date.now();

  let segments: Array<{ startMs: number; endMs: number; speaker?: string; text: string; confidence?: number }>;
  let model: string;

  const aiResult = isAiConfigured()
    ? await transcribeAudio(buffer, fileName, recording.mime_type).catch((err) => {
        console.error("[AI] transcription provider error, fallback to mock:", err.message);
        return null;
      })
    : null;

  if (aiResult) {
    segments = aiResult.segments.filter((s) => s.text);
    model = aiResult.model;
    await logUsage(job.id, model, null, Date.now() - started);
  } else {
    const agenda = job.agenda_id
      ? await db("meeting_agendas").where({ id: job.agenda_id }).first()
      : null;
    segments = mockTranscript(recordingId, recording.duration_seconds || 120, agenda?.title);
    model = "mock";
    await logUsage(job.id, model, null, Date.now() - started);
  }

  await db("transcript_segments").where({ recording_id: recordingId }).del();
  if (segments.length) {
    const agendaId = job.payload?.agendaId || job.agenda_id || null;
    await db("transcript_segments").insert(
      segments.map((s, i) => ({
        recording_id: recordingId,
        meeting_id: recording.meeting_id,
        agenda_id: agendaId,
        sequence_no: i + 1,
        start_ms: s.startMs,
        end_ms: s.endMs,
        speaker: s.speaker || null,
        text: s.text,
        confidence: s.confidence ?? null,
        source: aiResult ? "ai" : "manual",
      })),
    );
  }

  await db("meeting_recordings").where({ id: recordingId }).update({ status: "transcribed" });
  if (tj) {
    await db("transcription_jobs").where({ id: tj.id }).update({
      status: "completed",
      completed_at: db.fn.now(),
      provider: model,
    });
  }
}

/* ------------------------------------------------------------------ */
/* 3) สร้างร่างรายงานการประชุม + สกัดมติ/งาน (รอตรวจสอบเสมอ)           */
/* ------------------------------------------------------------------ */
export async function handleGenerateMinutes(job: AiJobRow): Promise<void> {
  const meetingId = job.payload?.meetingId || job.meeting_id;
  if (!meetingId) throw new Error("missing meetingId");

  const meeting = await db("meetings").where({ id: meetingId }).first();
  if (!meeting) throw new Error(`meeting ${meetingId} not found`);

  const agendas = await db("meeting_agendas")
    .where({ meeting_id: meetingId })
    .orderBy("sequence_no", "asc");
  const summaries = await db("agenda_ai_summaries")
    .whereIn(
      "agenda_id",
      agendas.map((a) => a.id),
    );
  const segments = await db("transcript_segments")
    .where({ meeting_id: meetingId })
    .orderBy("sequence_no", "asc");
  const manualDecisions = await db("meeting_decisions")
    .where({ meeting_id: meetingId })
    .whereNot("status", "rejected");

  const summaryByAgenda = new Map(summaries.map((s) => [s.agenda_id, s]));

  let draft: MinutesDraft & {
    decisions?: Array<{ agenda_no: number; text: string; type?: string }>;
    action_items?: Array<{ agenda_no: number; title: string; assignee?: string; due_date?: string }>;
  };
  let usedModel = "heuristic";
  const started = Date.now();

  const agendaSummariesText = agendas
    .map((a) => {
      const s = summaryByAgenda.get(a.id);
      return `วาระที่ ${a.sequence_no}: ${a.title}\nสรุปเอกสาร: ${s?.summary || "(ไม่มี)"}`;
    })
    .join("\n\n");
  const transcriptText = segments
    .slice(0, 400)
    .map((s) => `[${formatMs(s.start_ms)}]${s.speaker ? ` ${s.speaker}:` : ""} ${s.text}`)
    .join("\n")
    .slice(0, 40000);
  const manualNotes = manualDecisions.map((d) => ({
    kind: "decision",
    text: `[${d.source === "ai_detected" ? "AI สกัด" : "เลขาบันทึก"}] ${d.decision_text}`,
  }));

  if (isAiConfigured() && (transcriptText.trim() || agendaSummariesText.trim())) {
    const promptRow = await db("ai_prompts")
      .where({ code: "generate_minutes", is_active: true })
      .orderBy("version", "desc")
      .first();
    const template = promptRow?.template || "สร้างร่างรายงานการประชุมจากข้อมูลต่อไปนี้เป็น JSON";
    const userPrompt = template
      .replaceAll("{{meeting_title}}", meeting.title)
      .replaceAll("{{meeting_time}}", `${dayjsFmt(meeting.start_time)} - ${dayjsFmt(meeting.end_time)}`)
      .replaceAll("{{agenda_summaries}}", agendaSummariesText || "(ไม่มี)")
      .replaceAll("{{transcript}}", transcriptText || "(ไม่มีบันทึกเสียง)")
      .replaceAll(
        "{{manual_notes}}",
        manualNotes.map((n) => n.text).join("\n") || "(ไม่มี)",
      );

    const chat = await chatCompletion(
      [
        {
          role: "system",
          content:
            "คุณเป็นเลขานุการอาวุโสที่ร่างรายงานการประชุมอย่างถูกต้องตามข้อมูลจริง ตอบเป็น JSON เท่านั้น " +
            'รูปแบบ: {"sections":[{"agenda_no":number,"agenda_title":string,"discussion":string,"decision":string}],"general_summary":string,"decisions":[{"agenda_no":number,"text":string,"type":"resolution|acknowledgement|direction"}],"action_items":[{"agenda_no":number,"title":string,"assignee":string,"due_date":string}]}',
        },
        { role: "user", content: userPrompt },
      ],
      { json: true },
    );
    if (chat) {
      const parsed = parseJsonLoose<any>(chat.text);
      if (parsed?.sections?.length) {
        draft = parsed;
        usedModel = chat.model;
        await logUsage(job.id, chat.model, chat, Date.now() - started);
      } else {
        draft = heuristicMinutes(
          agendas,
          agendas.map((a) => {
            const s = summaryByAgenda.get(a.id);
            return s ? { agendaTitle: a.title, summary: s.summary } : undefined;
          }),
          segments,
          manualNotes,
        );
      }
    } else {
      draft = heuristicMinutes(
        agendas,
        agendas.map((a) => {
          const s = summaryByAgenda.get(a.id);
          return s ? { agendaTitle: a.title, summary: s.summary } : undefined;
        }),
        segments,
        manualNotes,
      );
    }
  } else {
    draft = heuristicMinutes(
      agendas,
      agendas.map((a) => {
        const s = summaryByAgenda.get(a.id);
        return s ? { agendaTitle: a.title, summary: s.summary } : undefined;
      }),
      segments,
      manualNotes,
    );
    await logUsage(job.id, usedModel, null, Date.now() - started);
  }

  // บันทึก/อัปเดต minutes (เฉพาะเมื่อยังไม่เผยแพร่)
  const existing = await db("meeting_minutes")
    .where({ meeting_id: meetingId })
    .whereNot("status", "published")
    .orderBy("version", "desc")
    .first();
  if (existing) {
    await db("meeting_minutes").where({ id: existing.id }).update({
      version: existing.version + 1,
      content: JSON.stringify({ sections: draft.sections, general_summary: draft.general_summary }),
      status: "pending_review",
      generated_by_ai: true,
      updated_at: db.fn.now(),
    });
  } else {
    await db("meeting_minutes").insert({
      meeting_id: meetingId,
      version: 1,
      content: JSON.stringify({ sections: draft.sections, general_summary: draft.general_summary }),
      status: "pending_review",
      generated_by_ai: true,
      created_by: job.payload?.createdBy || meeting.secretary_id || meeting.organizer_id,
    });
  }

  // สกัดมติ/งานจากผล AI (เฉพาะที่ไม่ซ้ำกับที่มีอยู่) — สถานะ pending_review เสมอ
  const agendaByNo = new Map(agendas.map((a) => [a.sequence_no, a.id]));
  if (Array.isArray(draft.decisions)) {
    for (const d of draft.decisions) {
      const text = String(d.text || "").trim();
      if (!text) continue;
      const dup = await db("meeting_decisions")
        .where({ meeting_id: meetingId })
        .whereRaw("decision_text = ?", [text])
        .first();
      if (dup) continue;
      await db("meeting_decisions").insert({
        meeting_id: meetingId,
        agenda_id: agendaByNo.get(Number(d.agenda_no)) || null,
        decision_text: text,
        decision_type: ["resolution", "acknowledgement", "direction"].includes(String(d.type))
          ? d.type
          : "resolution",
        source: "ai_detected",
        status: "pending_review",
      });
    }
  }
  if (Array.isArray(draft.action_items)) {
    for (const item of draft.action_items) {
      const title = String(item.title || "").trim();
      if (!title) continue;
      const dup = await db("meeting_action_items")
        .where({ meeting_id: meetingId })
        .whereRaw("title = ?", [title])
        .first();
      if (dup) continue;
      await db("meeting_action_items").insert({
        meeting_id: meetingId,
        agenda_id: agendaByNo.get(Number(item.agenda_no)) || null,
        title,
        detail: `มอบหมายโดย AI (รอตรวจสอบ) — ผู้รับผิดชอบที่ตรวจพบ: ${item.assignee || "ไม่ระบุ"}`,
        assignee_text: item.assignee ? String(item.assignee).slice(0, 255) : null,
        due_date: isValidDate(item.due_date) ? item.due_date : null,
        status: "pending",
      });
    }
  }

  // แจ้งเลขานุการ/ผู้จัดประชุมให้ตรวจสอบ
  const reviewers = [meeting.secretary_id, meeting.organizer_id].filter(Boolean) as number[];
  await notify({
    userIds: reviewers,
    type: "minutes_approval",
    title: `ร่างรายงานการประชุม "${meeting.title}" พร้อมตรวจสอบ`,
    body: "AI สร้างร่างรายงาน มติ และรายการงานเรียบร้อย — กรุณาตรวจสอบก่อนเผยแพร่",
    link: `/meetings/${meetingId}/minutes`,
    meetingId,
  });
}

/* ------------------------------------------------------------------ */
/* 4) สร้าง Briefing รวมทุกวาระก่อนประชุม (เอกสารชุดเดียว)             */
/* ------------------------------------------------------------------ */
export async function handleGenerateBriefing(job: AiJobRow): Promise<void> {
  const meetingId = job.payload?.meetingId || job.meeting_id;
  if (!meetingId) throw new Error("missing meetingId");

  const meeting = await db("meetings").where({ id: meetingId }).first();
  if (!meeting) throw new Error(`meeting ${meetingId} not found`);

  const agendas = await db("meeting_agendas")
    .where({ meeting_id: meetingId })
    .orderBy("sequence_no", "asc");
  const summaries = await db("agenda_ai_summaries")
    .whereIn("agenda_id", agendas.map((a) => a.id));
  const documents = await db("meeting_documents").where({ meeting_id: meetingId });
  const participants = await db("meeting_participants")
    .where({ meeting_id: meetingId })
    .join("users", "users.id", "=", "meeting_participants.user_id")
    .select("users.name", "meeting_participants.role_in_meeting");

  const summaryByAgenda = new Map(summaries.map((s) => [s.agenda_id, s]));
  const docByAgenda = new Map<string, string[]>();
  for (const d of documents) {
    if (!d.agenda_id) continue;
    const list = docByAgenda.get(d.agenda_id) || [];
    list.push(`${d.file_name} (v${d.file_version})`);
    docByAgenda.set(d.agenda_id, list);
  }

  const lines: string[] = [
    `# Briefing ก่อนประชุม: ${meeting.title}`,
    ``,
    `- วันเวลา: ${dayjsFmt(meeting.start_time)} ถึง ${dayjsFmt(meeting.end_time)}`,
    `- สถานที่: ${meeting.location_text || "ระบุภายหลัง"}`,
    `- ผู้เข้าร่วม: ${participants.map((p) => `${p.name}${p.role_in_meeting === "chair" ? " (ประธาน)" : p.role_in_meeting === "secretary" ? " (เลขา)" : ""}`).join(", ") || "-"}`,
    ``,
  ];

  for (const a of agendas) {
    const s = summaryByAgenda.get(a.id);
    lines.push(`## วาระที่ ${a.sequence_no}: ${a.title}`);
    lines.push(`ประเภท: ${agendaTypeLabel(a.agenda_type)} · เวลาโดยประมาณ: ${a.duration_minutes ?? "-"} นาที`);
    if (docByAgenda.has(a.id)) lines.push(`เอกสาร: ${docByAgenda.get(a.id)!.join(", ")}`);
    if (s) {
      lines.push(``);
      lines.push(`**สาระสำคัญ:** ${s.summary || "-"}`);
      const keyPoints = safeJsonArray(s.key_points);
      if (keyPoints.length) {
        lines.push(``);
        lines.push(`**ประเด็นสำคัญ:**`);
        keyPoints.forEach((k) => lines.push(`- ${k}`));
      }
      const questions = safeJsonArray(s.questions);
      if (questions.length) {
        lines.push(``);
        lines.push(`**คำถามที่ควรพิจารณา:**`);
        questions.forEach((q) => lines.push(`- ${q}`));
      }
      const refs = safeJsonArray<{ page: number; note?: string }>(s.page_references);
      if (refs.length) {
        lines.push(``);
        lines.push(`**อ้างอิง:** ${refs.map((r) => `หน้า ${r.page}`).join(", ")}`);
      }
    } else {
      lines.push(``);
      lines.push(`_(ยังไม่มีสรุป AI สำหรับวาระนี้)_`);
    }
    lines.push(``);
  }

  const markdown = lines.join("\n");
  await db("ai_job_results").insert({
    job_id: job.id,
    result_type: "briefing",
    content: JSON.stringify({ markdown, generatedAt: new Date().toISOString() }),
  });
}

/* ---------------- helpers ---------------- */
function safeJsonArray<T = string>(value: unknown): T[] {
  if (!value) return [];
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function agendaTypeLabel(type: string): string {
  const map: Record<string, string> = {
    information: "เรื่องแจ้งเพื่อทราบ",
    approval: "เพื่อรับรอง/เห็นชอบ",
    follow_up: "เรื่องสืบเนื่อง",
    consideration: "เสนอเพื่อพิจารณา",
  };
  return map[type] || type;
}

function formatMs(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function dayjsFmt(value: string | Date | null): string {
  if (!value) return "-";
  const d = new Date(value);
  return d.toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" });
}

function isValidDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value);
}
