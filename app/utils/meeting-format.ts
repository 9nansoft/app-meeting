import dayjs from "dayjs";
import "dayjs/locale/th";
import buddhistEra from "dayjs/plugin/buddhistEra";
import relativeTime from "dayjs/plugin/relativeTime";
import utc from "dayjs/plugin/utc";

dayjs.extend(buddhistEra);
dayjs.extend(relativeTime);
dayjs.extend(utc);
dayjs.locale("th");

export { dayjs };

/** วันที่แบบไทย พ.ศ. เช่น 26 กันยายน 2569 */
export const fmtDate = (value?: string | Date | null): string =>
  value ? dayjs(value).format("D MMMM BBBB") : "-";

/** วันที่ + เวลา */
export const fmtDateTime = (value?: string | Date | null): string =>
  value ? dayjs(value).format("D MMM BBBB HH:mm") : "-";

/** เวลา HH:mm */
export const fmtTime = (value?: string | Date | null): string =>
  value ? dayjs(value).format("HH:mm") : "-";

/** สำหรับ datetime-local input */
export const toLocalInput = (value?: string | Date | null): string =>
  value ? dayjs(value).format("YYYY-MM-DDTHH:mm") : "";

export const fromLocalInput = (value: string): Date => dayjs(value).toDate();

export const fmtMs = (ms: number): string => {
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

/* ---------- ป้ายสถานะภาษาไทย ---------- */
export const meetingStatusLabel: Record<string, string> = {
  draft: "ร่าง",
  scheduled: "กำหนดเวลาแล้ว",
  in_progress: "กำลังประชุม",
  completed: "เสร็จสิ้น",
  cancelled: "ยกเลิก",
};

export const agendaTypeLabel: Record<string, string> = {
  information: "แจ้งเพื่อทราบ",
  approval: "รับรอง/เห็นชอบ",
  follow_up: "เรื่องสืบเนื่อง",
  consideration: "เสนอเพื่อพิจารณา",
};

export const agendaStatusLabel: Record<string, string> = {
  pending: "รอประชุม",
  presenting: "กำลังนำเสนอ",
  done: "เสร็จแล้ว",
  postponed: "เลื่อนออกไป",
};

export const analysisStatusLabel: Record<string, string> = {
  pending: "รอวิเคราะห์",
  processing: "AI กำลังวิเคราะห์",
  completed: "วิเคราะห์แล้ว",
  failed: "วิเคราะห์ไม่สำเร็จ",
  skipped: "ข้าม",
};

export const decisionTypeLabel: Record<string, string> = {
  resolution: "มติ",
  acknowledgement: "รับทราบ",
  direction: "แนวทาง",
};

export const actionStatusLabels: Record<string, string> = {
  pending: "รอดำเนินการ",
  in_progress: "กำลังดำเนินการ",
  done: "เสร็จสิ้น",
  overdue: "เลยกำหนด",
  cancelled: "ยกเลิก",
};

export const minutesStatusLabel: Record<string, string> = {
  draft: "ร่าง (แก้ไขได้)",
  pending_review: "รออนุมัติ",
  approved: "อนุมัติแล้ว",
  published: "เผยแพร่แล้ว",
};

export const roleInMeetingLabel: Record<string, string> = {
  chair: "ประธาน",
  secretary: "เลขานุการ",
  member: "สมาชิก",
  presenter: "ผู้นำเสนอ",
  observer: "ผู้สังเกตการณ์",
};

export const equipmentLabel: Record<string, string> = {
  tv: "จอทีวี",
  projector: "โปรเจกเตอร์",
  video_conf: "ประชุมทางไกล",
  whiteboard: "ไวท์บอร์ด",
  microphone: "ไมโครโฟน",
  wireless_mic: "ไมค์ไร้สาย",
  sound_system: "ชุดระบบเสียง",
  speaker: "ลำโพง",
  amplifier: "ชุดขยายเสียง",
  mixer: "มิกเซอร์",
  recorder: "อุปกรณ์บันทึกเสียง",
  computer: "คอมพิวเตอร์",
  aircon: "แอร์",
};

/** ตัวเลือกอุปกรณ์ทั้งหมดสำหรับฟอร์มจัดการห้อง */
export const equipmentOptions = [
  "sound_system",
  "speaker",
  "amplifier",
  "wireless_mic",
  "microphone",
  "projector",
  "tv",
  "video_conf",
  "whiteboard",
  "recorder",
  "computer",
  "aircon",
];

export const jobTypeLabel: Record<string, string> = {
  analyze_document: "วิเคราะห์เอกสาร",
  transcribe_recording: "ถอดเสียง",
  generate_minutes: "สร้างร่างรายงาน",
  generate_briefing: "สร้าง Briefing",
};
