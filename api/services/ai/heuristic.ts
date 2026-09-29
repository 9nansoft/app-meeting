import type { PdfPage } from "../pdf";
import type { SttSegment } from "./provider";

/**
 * Heuristic fallback — ใช้เมื่อไม่ได้ตั้งค่า AI_API_KEY
 * สรุปแบบ extractive (ไม่ใช้โมเดลภายนอก) เพื่อให้ระบบทำงานครบวงจรได้
 * ผลลัพธ์จะถูก mark needs_review = true เสมอ
 */

export interface AgendaSummaryResult {
  summary: string;
  key_points: string[];
  key_numbers: string[];
  considerations: string[];
  questions: string[];
  page_references: Array<{ page: number; note: string }>;
}

/** ตัดข้อความไทย/อังกฤษเป็นประโยคหรือวรรคอย่างหยาบ ๆ */
function splitSentences(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+|\s{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 25);
}

function hasNumber(s: string): boolean {
  return /[0-9๐-๙]/.test(s) || /(บาท|เปอร์เซ็นต์|ล้าน|พัน|%\d|คน|ราย)/.test(s);
}

export function heuristicAgendaSummary(
  pages: PdfPage[],
  agendaTitle: string,
): AgendaSummaryResult {
  const sentences = pages.flatMap((p) =>
    splitSentences(p.text).map((s) => ({ text: s, page: p.pageNo })),
  );

  // ให้คะแนน: ความยาว + มีตัวเลข + อยู่หน้าต้น ๆ
  const scored = sentences
    .map((s) => ({
      ...s,
      score:
        Math.min(s.text.length, 300) / 100 +
        (hasNumber(s.text) ? 2 : 0) +
        (/(วัตถุประสงค์|เป้าหมาย|งบประมาณ|ผลการดำเนินงาน|ข้อเสนอ|แนวทาง|ความเสี่ยง|ระยะเวลา)/.test(s.text) ? 3 : 0),
    }))
    .sort((a, b) => b.score - a.score);

  const top = scored.slice(0, 12);
  const summary =
    top.slice(0, 3).map((s) => s.text).join(" ") ||
    `ไม่พบเนื้อหาที่สกัดได้จากเอกสารของวาระ "${agendaTitle}" (อาจเป็นไฟล์สแกนที่ต้องใช้ OCR)`;

  const pagesUsed = [...new Set(top.map((s) => s.page))].sort((a, b) => a - b);

  return {
    summary: `【สรุปอัตโนมัติ (โหมดไม่ใช้โมเดลภายนอก)】 ${summary}`,
    key_points: top.slice(0, 5).map((s) => s.text),
    key_numbers: sentences.filter((s) => hasNumber(s.text)).slice(0, 5).map((s) => s.text),
    considerations: [
      "ขอบเขตและรายละเอียดจากเอกสารฉบับนี้",
      "งบประมาณ/ทรัพยากรที่เกี่ยวข้อง (หากระบุในเอกสาร)",
      "ระยะเวลาดำเนินการ (หากระบุในเอกสาร)",
    ],
    questions: [
      "ที่ประชุมเห็นชอบตามที่เสนอหรือไม่",
      "ต้องการข้อมูลเพิ่มเติมจากผู้นำเสนอหรือไม่",
    ],
    page_references: pagesUsed.slice(0, 6).map((p) => ({
      page: p,
      note: `หน้าที่พบเนื้อหาสำคัญของวาระนี้`,
    })),
  };
}

/** Mock transcript เมื่อไม่มี STT provider — ระบุชัดว่าเป็นข้อมูลจำลอง */
export function mockTranscript(
  recordingId: string,
  durationSeconds = 120,
  agendaTitle?: string,
): SttSegment[] {
  const dur = Math.max(durationSeconds, 60);
  const lines = [
    `【โหมดจำลองถอดเสียง — ยังไม่ได้ตั้งค่า AI_STT_MODEL/AI_API_KEY】 ไฟล์บันทึกเสียง ${recordingId.slice(0, 8)} ยาว ${Math.round(dur)} วินาที`,
    agendaTitle
      ? `ช่วงนี้อยู่ระหว่างพิจารณาวาระ: ${agendaTitle} — กรุณาบันทึกมติและงานที่มอบหมายผ่านหน้า Live Meeting`
      : "กรุณาเชื่อมโยงช่วงเสียงนี้กับวาระที่กำลังประชุม",
    "เมื่อตั้งค่า provider ถอดเสียงแล้ว ระบบจะสร้าง transcript พร้อมเวลาและผู้พูดให้อัตโนมัติ",
  ];
  const step = Math.floor(dur / lines.length) * 1000;
  return lines.map((text, i) => ({
    startMs: i * step,
    endMs: (i + 1) * step,
    speaker: "ระบบ",
    text,
    confidence: 1,
  }));
}

export interface MinutesDraft {
  sections: Array<{
    agenda_no: number;
    agenda_title: string;
    discussion: string;
    decision: string;
  }>;
  general_summary: string;
}

export function heuristicMinutes(
  agendas: Array<{ sequence_no: number; title: string }>,
  summaries: Array<{ agendaTitle: string; summary: string | null } | undefined>,
  segments: Array<{ text: string; agenda_id?: string | null }>,
  manualNotes: Array<{ kind: string; text: string }>,
): MinutesDraft {
  const sections = agendas.map((a, i) => {
    const related = segments.filter((s) => s.agenda_id && agendas[i] && s.agenda_id === (a as any).id);
    const discussionParts = [
      summaries[i]?.summary ? `สรุปเอกสาร: ${summaries[i]!.summary}` : null,
      related.length ? `จากบันทึกการอภิปราย: ${related.slice(0, 6).map((s) => s.text).join(" ")}` : null,
    ].filter(Boolean) as string[];
    const decisionNote = manualNotes
      .filter((n) => n.kind === "decision")
      .map((n) => n.text)
      .join(" ; ");
    return {
      agenda_no: a.sequence_no,
      agenda_title: a.title,
      discussion: discussionParts.join("\n") || "ไม่พบบันทึกการอภิปรายของวาระนี้ — รอตรวจสอบจากเลขานุการ",
      decision: decisionNote || "รอตรวจสอบจากเลขานุการ",
    };
  });
  return {
    sections,
    general_summary: `【ร่างรายงานอัตโนมัติ — โหมดไม่ใช้โมเดลภายนอก】 ประกอบจากสรุปเอกสาร ${summaries.filter(Boolean).length} วาระ, transcript ${segments.length} ช่วง และมติ/งานที่บันทึกระหว่างประชุม ${manualNotes.length} รายการ ทุกข้อความต้องผ่านการตรวจสอบของเลขานุการก่อนเผยแพร่`,
  };
}
