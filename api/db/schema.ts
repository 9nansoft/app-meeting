import { db } from "./index";
import { hashPassword } from "./index";

/**
 * AI Smart Meeting System — PostgreSQL schema (Knex)
 * ออกแบบตามเอกสาร "ออกแบบระบบประชุมอัจฉริยะ" แบ่งเป็น 6 กลุ่ม:
 *   G1 ผู้ใช้และห้องประชุม / G2 การประชุมและวาระ / G3 เสียงและ Transcript
 *   G4 ผลการประชุม / G5 AI และงานเบื้องหลัง / G6 ระบบและการแจ้งเตือน
 * ตารางใหม่ทั้งหมดใช้ UUID เป็น Primary Key (users เดิมใช้ serial จึงคงไว้
 * เพื่อความเข้ากันได้กับระบบ auth ที่มีอยู่)
 */
export async function ensureSchema(): Promise<void> {
  // ---------- G1: ผู้ใช้และห้องประชุม ----------
  if (!(await db.schema.hasTable("users"))) {
    await db.schema.createTable("users", (table) => {
      table.increments("id").primary();
      table.string("username", 100).notNullable().unique();
      table.string("password", 255).notNullable();
      table.string("role", 50).notNullable().defaultTo("user"); // admin | secretary | user
      table.string("name", 255).nullable();
      table.string("email", 255).nullable();
      table.string("position", 255).nullable();
      table.string("doctorcode", 50).nullable();
      table.string("depcode", 50).nullable();
      table.integer("group_id").nullable();
      table.boolean("is_active").notNullable().defaultTo(true);
      table.timestamp("created_at", { useTz: true }).defaultTo(db.fn.now());
      table.timestamp("updated_at", { useTz: true }).defaultTo(db.fn.now());
    });
  } else {
    await addColumnIfMissing("users", "email", (t) => t.string("email", 255).nullable());
    await addColumnIfMissing("users", "position", (t) => t.string("position", 255).nullable());
    await addColumnIfMissing("users", "is_active", (t) => t.boolean("is_active").notNullable().defaultTo(true));
  }

  if (!(await db.schema.hasTable("roles"))) {
    await db.schema.createTable("roles", (table) => {
      table.uuid("id").primary().defaultTo(db.raw("gen_random_uuid()"));
      table.string("code", 50).notNullable().unique(); // admin | secretary | member
      table.string("name", 255).notNullable();
      table.text("description").nullable();
      table.jsonb("permissions").nullable();
    });
  }

  if (!(await db.schema.hasTable("user_roles"))) {
    await db.schema.createTable("user_roles", (table) => {
      table.uuid("id").primary().defaultTo(db.raw("gen_random_uuid()"));
      table.integer("user_id").notNullable().references("id").inTable("users").onDelete("CASCADE");
      table.string("role_code", 50).notNullable().references("code").inTable("roles").onDelete("CASCADE");
      table.timestamp("granted_at", { useTz: true }).defaultTo(db.fn.now());
      table.unique(["user_id", "role_code"]);
    });
  }

  if (!(await db.schema.hasTable("meeting_rooms"))) {
    await db.schema.createTable("meeting_rooms", (table) => {
      table.uuid("id").primary().defaultTo(db.raw("gen_random_uuid()"));
      table.string("name", 255).notNullable();
      table.integer("capacity").notNullable().defaultTo(10);
      table.string("building", 150).nullable(); // ตึก
      table.string("floor", 100).nullable(); // ชั้น
      table.string("location", 255).nullable(); // รายละเอียดสถานที่
      table.integer("table_count").nullable(); // จำนวนโต๊ะ
      table.integer("chair_count").nullable(); // จำนวนเก้าอี้
      table.integer("responsible_user_id").nullable().references("id").inTable("users").onDelete("SET NULL"); // ผู้รับผิดชอบประจำห้อง
      table.text("description").nullable();
      table.string("color", 20).nullable(); // สีแสดงผลในปฏิทิน
      table.boolean("has_dining").notNullable().defaultTo(false); // มีสถานที่รับประทานอาหารใกล้เคียง
      table.text("dining_detail").nullable(); // รายละเอียดสถานที่รับประทานอาหาร
      table.boolean("is_active").notNullable().defaultTo(true);
      table.timestamp("created_at", { useTz: true }).defaultTo(db.fn.now());
      table.timestamp("updated_at", { useTz: true }).defaultTo(db.fn.now());
    });
  } else {
    await addColumnIfMissing("meeting_rooms", "building", (t) => t.string("building", 150).nullable());
    await addColumnIfMissing("meeting_rooms", "table_count", (t) => t.integer("table_count").nullable());
    await addColumnIfMissing("meeting_rooms", "chair_count", (t) => t.integer("chair_count").nullable());
    await addColumnIfMissing(
      "meeting_rooms",
      "responsible_user_id",
      (t) => t.integer("responsible_user_id").nullable().references("id").inTable("users").onDelete("SET NULL"),
    );
    await addColumnIfMissing("meeting_rooms", "has_dining", (t) => t.boolean("has_dining").notNullable().defaultTo(false));
    await addColumnIfMissing("meeting_rooms", "dining_detail", (t) => t.text("dining_detail").nullable());
  }

  // รูปห้องประชุม (หลายรูป เลือกรูปปกได้)
  if (!(await db.schema.hasTable("room_images"))) {
    await db.schema.createTable("room_images", (table) => {
      table.uuid("id").primary().defaultTo(db.raw("gen_random_uuid()"));
      table.uuid("room_id").notNullable().references("id").inTable("meeting_rooms").onDelete("CASCADE");
      table.string("storage_key", 500).notNullable();
      table.string("file_name", 500).notNullable();
      table.string("mime_type", 150).notNullable().defaultTo("image/jpeg");
      table.bigInteger("file_size").nullable();
      table.boolean("is_cover").notNullable().defaultTo(false);
      table.integer("sort_order").notNullable().defaultTo(0);
      table.integer("uploaded_by").references("id").inTable("users");
      table.timestamp("created_at", { useTz: true }).defaultTo(db.fn.now());
      table.index(["room_id", "sort_order"]);
    });
  }

  if (!(await db.schema.hasTable("room_equipment"))) {
    await db.schema.createTable("room_equipment", (table) => {
      table.uuid("id").primary().defaultTo(db.raw("gen_random_uuid()"));
      table.uuid("room_id").notNullable().references("id").inTable("meeting_rooms").onDelete("CASCADE");
      // tv | projector | video_conf | whiteboard | microphone | recorder | aircon | computer
      table.string("equipment_type", 50).notNullable();
      table.string("name", 255).nullable();
      table.integer("quantity").notNullable().defaultTo(1);
      table.text("notes").nullable();
    });
  }

  if (!(await db.schema.hasTable("meetings"))) {
    await db.schema.createTable("meetings", (table) => {
      table.uuid("id").primary().defaultTo(db.raw("gen_random_uuid()"));
      table.string("title", 500).notNullable();
      table.text("description").nullable();
      // regular | adhoc | board | department
      table.string("meeting_type", 30).notNullable().defaultTo("regular");
      // draft | scheduled | in_progress | completed | cancelled
      table.string("status", 20).notNullable().defaultTo("scheduled");
      table.integer("organizer_id").notNullable().references("id").inTable("users");
      table.integer("secretary_id").nullable().references("id").inTable("users");
      table.timestamp("start_time", { useTz: true }).notNullable();
      table.timestamp("end_time", { useTz: true }).notNullable();
      table.string("location_text", 255).nullable();
      table.uuid("previous_meeting_id").nullable(); // การประชุมครั้งก่อน (สืบเนื่องงาน)
      table.integer("created_by").references("id").inTable("users");
      table.timestamp("created_at", { useTz: true }).defaultTo(db.fn.now());
      table.timestamp("updated_at", { useTz: true }).defaultTo(db.fn.now());
      table.index(["start_time"]);
      table.index(["status"]);
    });
  }

  if (!(await db.schema.hasTable("room_bookings"))) {
    await db.schema.createTable("room_bookings", (table) => {
      table.uuid("id").primary().defaultTo(db.raw("gen_random_uuid()"));
      table.uuid("room_id").notNullable().references("id").inTable("meeting_rooms").onDelete("CASCADE");
      table.uuid("meeting_id").nullable().references("id").inTable("meetings").onDelete("SET NULL");
      table.string("title", 255).notNullable();
      table.text("purpose").nullable();
      table.text("special_requests").nullable(); // ความต้องการพิเศษของผู้จอง เช่น อาหาร อุปกรณ์เพิ่มเติม
      table.integer("participants_count").nullable();
      table.integer("booked_by").notNullable().references("id").inTable("users");
      table.timestamp("start_time", { useTz: true }).notNullable();
      table.timestamp("end_time", { useTz: true }).notNullable();
      // confirmed | cancelled
      table.string("status", 20).notNullable().defaultTo("confirmed");
      table.text("recurrence_rule").nullable(); // JSON {freq:'weekly',interval:1,count:n}
      table.uuid("recurrence_group_id").nullable();
      table.timestamp("created_at", { useTz: true }).defaultTo(db.fn.now());
      table.timestamp("updated_at", { useTz: true }).defaultTo(db.fn.now());
      table.index(["room_id", "start_time", "end_time"]);
    });
  } else {
    await addColumnIfMissing("room_bookings", "special_requests", (t) => t.text("special_requests").nullable());
  }

  if (!(await db.schema.hasTable("meeting_participants"))) {
    await db.schema.createTable("meeting_participants", (table) => {
      table.uuid("id").primary().defaultTo(db.raw("gen_random_uuid()"));
      table.uuid("meeting_id").notNullable().references("id").inTable("meetings").onDelete("CASCADE");
      table.integer("user_id").notNullable().references("id").inTable("users").onDelete("CASCADE");
      // chair | secretary | member | presenter | observer
      table.string("role_in_meeting", 30).notNullable().defaultTo("member");
      // invited | accepted | declined
      table.string("invite_status", 20).notNullable().defaultTo("invited");
      table.timestamp("notified_at", { useTz: true }).nullable();
      table.unique(["meeting_id", "user_id"]);
    });
  }

  if (!(await db.schema.hasTable("meeting_agendas"))) {
    await db.schema.createTable("meeting_agendas", (table) => {
      table.uuid("id").primary().defaultTo(db.raw("gen_random_uuid()"));
      table.uuid("meeting_id").notNullable().references("id").inTable("meetings").onDelete("CASCADE");
      table.integer("sequence_no").notNullable().defaultTo(1);
      table.string("title", 500).notNullable();
      table.text("description").nullable();
      // information (แจ้งเพื่อทราบ) | approval (รับรอง/เห็นชอบ) | follow_up (สืบเนื่อง) | consideration (เสนอเพื่อพิจารณา)
      table.string("agenda_type", 30).notNullable().defaultTo("consideration");
      table.integer("presenter_id").nullable().references("id").inTable("users");
      table.integer("duration_minutes").nullable();
      // pending | presenting | done | postponed
      table.string("status", 20).notNullable().defaultTo("pending");
      table.uuid("carried_from_action_item_id").nullable(); // วาระสืบเนื่องจากงานครั้งก่อน
      table.timestamp("created_at", { useTz: true }).defaultTo(db.fn.now());
      table.timestamp("updated_at", { useTz: true }).defaultTo(db.fn.now());
      table.index(["meeting_id", "sequence_no"]);
    });
  }

  if (!(await db.schema.hasTable("meeting_documents"))) {
    await db.schema.createTable("meeting_documents", (table) => {
      table.uuid("id").primary().defaultTo(db.raw("gen_random_uuid()"));
      table.uuid("meeting_id").notNullable().references("id").inTable("meetings").onDelete("CASCADE");
      table.uuid("agenda_id").nullable().references("id").inTable("meeting_agendas").onDelete("CASCADE");
      table.integer("uploader_id").references("id").inTable("users");
      table.string("file_name", 500).notNullable();
      table.string("storage_key", 500).notNullable();
      table.string("mime_type", 150).notNullable().defaultTo("application/pdf");
      table.bigInteger("file_size").nullable();
      table.string("checksum", 128).nullable();
      table.integer("file_version").notNullable().defaultTo(1);
      // pending | processing | completed | failed | skipped
      table.string("analysis_status", 20).notNullable().defaultTo("pending");
      table.text("analysis_error").nullable();
      // OCR สำหรับไฟล์สแกน
      table.boolean("ocr_used").notNullable().defaultTo(false);
      table.string("ocr_method", 20).nullable(); // tesseract | ai-vision
      table.uuid("replaced_document_id").nullable(); // เวอร์ชันก่อนหน้า
      table.integer("page_count").nullable();
      table.timestamp("created_at", { useTz: true }).defaultTo(db.fn.now());
      table.timestamp("updated_at", { useTz: true }).defaultTo(db.fn.now());
      table.index(["agenda_id"]);
    });
  } else {
    await addColumnIfMissing("meeting_documents", "ocr_used", (t) => t.boolean("ocr_used").notNullable().defaultTo(false));
    await addColumnIfMissing("meeting_documents", "ocr_method", (t) => t.string("ocr_method", 20).nullable());
  }

  if (!(await db.schema.hasTable("agenda_ai_summaries"))) {
    await db.schema.createTable("agenda_ai_summaries", (table) => {
      table.uuid("id").primary().defaultTo(db.raw("gen_random_uuid()"));
      table.uuid("agenda_id").notNullable().references("id").inTable("meeting_agendas").onDelete("CASCADE");
      table.uuid("document_id").nullable().references("id").inTable("meeting_documents").onDelete("CASCADE");
      table.text("summary").nullable(); // สาระสำคัญ
      table.jsonb("key_points").nullable(); // ประเด็นสำคัญจากเอกสาร
      table.jsonb("key_numbers").nullable(); // ตัวเลขสำคัญ/ข้อเสนอ
      table.jsonb("considerations").nullable(); // ประเด็นที่ต้องพิจารณา
      table.jsonb("questions").nullable(); // คำถามที่ควรพิจารณา
      table.jsonb("page_references").nullable(); // [{page, note}]
      table.string("provider", 100).nullable();
      table.string("model", 100).nullable();
      table.boolean("needs_review").notNullable().defaultTo(true);
      table.timestamp("generated_at", { useTz: true }).defaultTo(db.fn.now());
    });
  }

  // ---------- G3: เสียงและ Transcript ----------
  if (!(await db.schema.hasTable("meeting_recordings"))) {
    await db.schema.createTable("meeting_recordings", (table) => {
      table.uuid("id").primary().defaultTo(db.raw("gen_random_uuid()"));
      table.uuid("meeting_id").notNullable().references("id").inTable("meetings").onDelete("CASCADE");
      table.integer("uploaded_by").references("id").inTable("users");
      table.string("storage_key", 500).notNullable();
      table.string("mime_type", 150).notNullable().defaultTo("audio/webm");
      table.bigInteger("file_size").nullable();
      table.integer("duration_seconds").nullable();
      // recording | uploaded | transcribing | transcribed | failed
      table.string("status", 20).notNullable().defaultTo("uploaded");
      table.timestamp("started_at", { useTz: true }).nullable();
      table.timestamp("ended_at", { useTz: true }).nullable();
      table.timestamp("created_at", { useTz: true }).defaultTo(db.fn.now());
    });
  }

  if (!(await db.schema.hasTable("transcription_jobs"))) {
    await db.schema.createTable("transcription_jobs", (table) => {
      table.uuid("id").primary().defaultTo(db.raw("gen_random_uuid()"));
      table.uuid("recording_id").notNullable().references("id").inTable("meeting_recordings").onDelete("CASCADE");
      // queued | processing | completed | failed
      table.string("status", 20).notNullable().defaultTo("queued");
      table.string("provider", 100).nullable();
      table.string("language", 20).notNullable().defaultTo("th");
      table.text("error").nullable();
      table.timestamp("started_at", { useTz: true }).nullable();
      table.timestamp("completed_at", { useTz: true }).nullable();
      table.timestamp("created_at", { useTz: true }).defaultTo(db.fn.now());
    });
  }

  if (!(await db.schema.hasTable("transcript_segments"))) {
    await db.schema.createTable("transcript_segments", (table) => {
      table.uuid("id").primary().defaultTo(db.raw("gen_random_uuid()"));
      table.uuid("recording_id").notNullable().references("id").inTable("meeting_recordings").onDelete("CASCADE");
      table.uuid("meeting_id").notNullable().references("id").inTable("meetings").onDelete("CASCADE");
      table.uuid("agenda_id").nullable().references("id").inTable("meeting_agendas").onDelete("SET NULL");
      table.integer("sequence_no").notNullable().defaultTo(1);
      table.integer("start_ms").notNullable().defaultTo(0);
      table.integer("end_ms").nullable();
      table.string("speaker", 255).nullable();
      table.text("text").notNullable();
      table.float("confidence").nullable();
      table.string("source", 20).notNullable().defaultTo("ai"); // ai | manual
      table.timestamp("created_at", { useTz: true }).defaultTo(db.fn.now());
      table.index(["meeting_id", "sequence_no"]);
    });
  }

  if (!(await db.schema.hasTable("agenda_transcript_links"))) {
    await db.schema.createTable("agenda_transcript_links", (table) => {
      table.uuid("id").primary().defaultTo(db.raw("gen_random_uuid()"));
      table.uuid("agenda_id").notNullable().references("id").inTable("meeting_agendas").onDelete("CASCADE");
      table.uuid("segment_id").notNullable().references("id").inTable("transcript_segments").onDelete("CASCADE");
      table.uuid("meeting_id").notNullable().references("id").inTable("meetings").onDelete("CASCADE");
      // discussion | decision | assignment
      table.string("link_type", 30).notNullable().defaultTo("discussion");
      table.integer("linked_by").references("id").inTable("users");
      table.timestamp("created_at", { useTz: true }).defaultTo(db.fn.now());
    });
  }

  // ---------- G4: ผลการประชุม ----------
  if (!(await db.schema.hasTable("meeting_minutes"))) {
    await db.schema.createTable("meeting_minutes", (table) => {
      table.uuid("id").primary().defaultTo(db.raw("gen_random_uuid()"));
      table.uuid("meeting_id").notNullable().references("id").inTable("meetings").onDelete("CASCADE");
      table.integer("version").notNullable().defaultTo(1);
      table.jsonb("content").nullable(); // โครงสร้างรายงาน {sections:[...]}
      // draft | pending_review | approved | published
      table.string("status", 20).notNullable().defaultTo("draft");
      table.boolean("generated_by_ai").notNullable().defaultTo(false);
      table.integer("created_by").references("id").inTable("users");
      table.integer("approved_by").references("id").inTable("users");
      table.timestamp("approved_at", { useTz: true }).nullable();
      table.timestamp("published_at", { useTz: true }).nullable();
      table.timestamp("created_at", { useTz: true }).defaultTo(db.fn.now());
      table.timestamp("updated_at", { useTz: true }).defaultTo(db.fn.now());
    });
  }

  if (!(await db.schema.hasTable("meeting_decisions"))) {
    await db.schema.createTable("meeting_decisions", (table) => {
      table.uuid("id").primary().defaultTo(db.raw("gen_random_uuid()"));
      table.uuid("meeting_id").notNullable().references("id").inTable("meetings").onDelete("CASCADE");
      table.uuid("agenda_id").nullable().references("id").inTable("meeting_agendas").onDelete("SET NULL");
      table.uuid("source_segment_id").nullable().references("id").inTable("transcript_segments").onDelete("SET NULL");
      table.integer("sequence_no").notNullable().defaultTo(1);
      table.text("decision_text").notNullable();
      // resolution (มติ) | acknowledgement (รับทราบ) | direction (แนวทาง)
      table.string("decision_type", 30).notNullable().defaultTo("resolution");
      // ai_detected (AI สกัด — ยังไม่ยืนยัน) | manual (เลขาบันทึกเอง)
      table.string("source", 20).notNullable().defaultTo("manual");
      // pending_review | confirmed | rejected
      table.string("status", 20).notNullable().defaultTo("pending_review");
      table.integer("confirmed_by").references("id").inTable("users");
      table.timestamp("confirmed_at", { useTz: true }).nullable();
      table.timestamp("created_at", { useTz: true }).defaultTo(db.fn.now());
      table.index(["meeting_id"]);
    });
  }

  if (!(await db.schema.hasTable("meeting_action_items"))) {
    await db.schema.createTable("meeting_action_items", (table) => {
      table.uuid("id").primary().defaultTo(db.raw("gen_random_uuid()"));
      table.uuid("meeting_id").notNullable().references("id").inTable("meetings").onDelete("CASCADE");
      table.uuid("agenda_id").nullable().references("id").inTable("meeting_agendas").onDelete("SET NULL");
      table.uuid("decision_id").nullable().references("id").inTable("meeting_decisions").onDelete("SET NULL");
      table.string("title", 500).notNullable();
      table.text("detail").nullable();
      table.integer("assignee_id").nullable().references("id").inTable("users").onDelete("SET NULL");
      table.string("assignee_text", 255).nullable(); // หน่วยงาน/ชื่อที่ยังไม่ผูก user
      table.date("due_date").nullable();
      // low | normal | high
      table.string("priority", 10).notNullable().defaultTo("normal");
      // pending | in_progress | done | overdue | cancelled
      table.string("status", 20).notNullable().defaultTo("pending");
      table.text("progress_note").nullable();
      table.integer("verified_by").references("id").inTable("users");
      table.timestamp("verified_at", { useTz: true }).nullable();
      table.uuid("follow_up_meeting_id").nullable().references("id").inTable("meetings"); // นำเข้าวาระการประชุมครั้งถัดไป
      table.timestamp("created_at", { useTz: true }).defaultTo(db.fn.now());
      table.timestamp("updated_at", { useTz: true }).defaultTo(db.fn.now());
      table.index(["status", "due_date"]);
    });
  }

  if (!(await db.schema.hasTable("meeting_attendance"))) {
    await db.schema.createTable("meeting_attendance", (table) => {
      table.uuid("id").primary().defaultTo(db.raw("gen_random_uuid()"));
      table.uuid("meeting_id").notNullable().references("id").inTable("meetings").onDelete("CASCADE");
      table.integer("user_id").nullable().references("id").inTable("users").onDelete("SET NULL");
      table.string("attendee_name", 255).nullable(); // ผู้เข้าร่วมที่ไม่มีในระบบ
      // present | absent | leave | proxy
      table.string("attendance_type", 20).notNullable().defaultTo("present");
      table.timestamp("check_in_at", { useTz: true }).nullable();
      table.integer("recorded_by").references("id").inTable("users");
      table.timestamp("created_at", { useTz: true }).defaultTo(db.fn.now());
      table.unique(["meeting_id", "user_id"]);
    });
  }

  if (!(await db.schema.hasTable("meeting_approvals"))) {
    await db.schema.createTable("meeting_approvals", (table) => {
      table.uuid("id").primary().defaultTo(db.raw("gen_random_uuid()"));
      table.uuid("meeting_id").notNullable().references("id").inTable("meetings").onDelete("CASCADE");
      table.uuid("minutes_id").nullable().references("id").inTable("meeting_minutes").onDelete("CASCADE");
      table.integer("approver_id").nullable().references("id").inTable("users");
      table.integer("step_sequence").notNullable().defaultTo(1);
      // chair | secretary | admin
      table.string("role_required", 30).notNullable().defaultTo("chair");
      // pending | approved | rejected | changes_requested
      table.string("status", 30).notNullable().defaultTo("pending");
      table.text("comment").nullable();
      table.timestamp("acted_at", { useTz: true }).nullable();
      table.timestamp("created_at", { useTz: true }).defaultTo(db.fn.now());
    });
  }

  // ---------- G5: AI และงานเบื้องหลัง ----------
  if (!(await db.schema.hasTable("ai_jobs"))) {
    await db.schema.createTable("ai_jobs", (table) => {
      table.uuid("id").primary().defaultTo(db.raw("gen_random_uuid()"));
      // analyze_document | transcribe_recording | generate_minutes | generate_briefing
      table.string("job_type", 50).notNullable();
      // queued | processing | completed | failed | cancelled
      table.string("status", 20).notNullable().defaultTo("queued");
      table.jsonb("payload").nullable();
      table.uuid("meeting_id").nullable().references("id").inTable("meetings").onDelete("CASCADE");
      table.uuid("agenda_id").nullable().references("id").inTable("meeting_agendas").onDelete("CASCADE");
      table.integer("attempts").notNullable().defaultTo(0);
      table.integer("max_attempts").notNullable().defaultTo(3);
      table.timestamp("run_after", { useTz: true }).nullable();
      table.timestamp("started_at", { useTz: true }).nullable();
      table.timestamp("completed_at", { useTz: true }).nullable();
      table.text("error").nullable();
      table.integer("created_by").references("id").inTable("users");
      table.timestamp("created_at", { useTz: true }).defaultTo(db.fn.now());
      table.index(["status", "run_after"]);
    });
  }

  if (!(await db.schema.hasTable("ai_job_results"))) {
    await db.schema.createTable("ai_job_results", (table) => {
      table.uuid("id").primary().defaultTo(db.raw("gen_random_uuid()"));
      table.uuid("job_id").notNullable().references("id").inTable("ai_jobs").onDelete("CASCADE");
      table.string("result_type", 50).notNullable();
      table.jsonb("content").nullable();
      table.timestamp("created_at", { useTz: true }).defaultTo(db.fn.now());
    });
  }

  if (!(await db.schema.hasTable("ai_model_usage"))) {
    await db.schema.createTable("ai_model_usage", (table) => {
      table.uuid("id").primary().defaultTo(db.raw("gen_random_uuid()"));
      table.uuid("job_id").nullable().references("id").inTable("ai_jobs").onDelete("SET NULL");
      table.string("provider", 100).nullable();
      table.string("model", 100).nullable();
      table.integer("input_tokens").nullable();
      table.integer("output_tokens").nullable();
      table.float("cost_estimate").nullable();
      table.integer("duration_ms").nullable();
      table.timestamp("created_at", { useTz: true }).defaultTo(db.fn.now());
    });
  }

  if (!(await db.schema.hasTable("ai_prompts"))) {
    await db.schema.createTable("ai_prompts", (table) => {
      table.uuid("id").primary().defaultTo(db.raw("gen_random_uuid()"));
      table.string("code", 100).notNullable();
      table.integer("version").notNullable().defaultTo(1);
      table.text("template").notNullable();
      table.jsonb("variables").nullable();
      table.boolean("is_active").notNullable().defaultTo(true);
      table.timestamp("created_at", { useTz: true }).defaultTo(db.fn.now());
      table.unique(["code", "version"]);
    });
  }

  if (!(await db.schema.hasTable("document_chunks"))) {
    await db.schema.createTable("document_chunks", (table) => {
      table.uuid("id").primary().defaultTo(db.raw("gen_random_uuid()"));
      table.uuid("document_id").notNullable().references("id").inTable("meeting_documents").onDelete("CASCADE");
      table.uuid("agenda_id").nullable().references("id").inTable("meeting_agendas").onDelete("SET NULL");
      table.integer("chunk_index").notNullable().defaultTo(0);
      table.integer("page_no").nullable();
      table.text("content").notNullable();
      table.integer("token_count").nullable();
      // เวกเเตอร์ embedding (float array ใน jsonb) สำหรับค้นหาเชิงความหมาย
      // (เปลี่ยนเป็น pgvector ภายหลังได้โดยแปลงคอลัมน์เป็น vector)
      table.jsonb("embedding").nullable();
      table.string("embedding_model", 100).nullable();
      table.timestamp("created_at", { useTz: true }).defaultTo(db.fn.now());
      table.index(["document_id", "chunk_index"]);
    });
  } else {
    await addColumnIfMissing("document_chunks", "embedding", (t) => t.jsonb("embedding").nullable());
    await addColumnIfMissing("document_chunks", "embedding_model", (t) => t.string("embedding_model", 100).nullable());
  }

  // ---------- G6: ระบบและการแจ้งเตือน ----------
  if (!(await db.schema.hasTable("notifications"))) {
    await db.schema.createTable("notifications", (table) => {
      table.uuid("id").primary().defaultTo(db.raw("gen_random_uuid()"));
      table.integer("user_id").notNullable().references("id").inTable("users").onDelete("CASCADE");
      // meeting_reminder | minutes_approval | action_assigned | action_due | job_failed | info
      table.string("type", 50).notNullable().defaultTo("info");
      table.string("title", 500).notNullable();
      table.text("body").nullable();
      table.string("link", 500).nullable();
      table.uuid("meeting_id").nullable().references("id").inTable("meetings").onDelete("CASCADE");
      table.string("channel", 20).notNullable().defaultTo("inapp"); // inapp | email | line
      table.string("status", 20).notNullable().defaultTo("unread"); // unread | read
      table.timestamp("read_at", { useTz: true }).nullable();
      table.timestamp("created_at", { useTz: true }).defaultTo(db.fn.now());
      table.index(["user_id", "status"]);
    });
  }

  if (!(await db.schema.hasTable("audit_logs"))) {
    await db.schema.createTable("audit_logs", (table) => {
      table.uuid("id").primary().defaultTo(db.raw("gen_random_uuid()"));
      table.integer("user_id").nullable().references("id").inTable("users").onDelete("SET NULL");
      table.string("username", 100).nullable();
      table.string("action", 100).notNullable();
      table.string("entity_type", 100).nullable();
      table.uuid("entity_id").nullable();
      table.jsonb("old_value").nullable();
      table.jsonb("new_value").nullable();
      table.string("ip", 64).nullable();
      table.string("user_agent", 500).nullable();
      table.timestamp("created_at", { useTz: true }).defaultTo(db.fn.now());
      table.index(["entity_type", "entity_id"]);
      table.index(["created_at"]);
    });
  }

  if (!(await db.schema.hasTable("system_settings"))) {
    await db.schema.createTable("system_settings", (table) => {
      table.string("key", 100).primary();
      table.jsonb("value").nullable();
      table.text("description").nullable();
      table.integer("updated_by").references("id").inTable("users");
      table.timestamp("updated_at", { useTz: true }).defaultTo(db.fn.now());
    });
  }

  if (!(await db.schema.hasTable("retention_policies"))) {
    await db.schema.createTable("retention_policies", (table) => {
      table.uuid("id").primary().defaultTo(db.raw("gen_random_uuid()"));
      // recording | transcript | document | minutes
      table.string("entity_type", 50).notNullable().unique();
      table.integer("retain_days").notNullable().defaultTo(365);
      table.string("action", 20).notNullable().defaultTo("delete"); // delete | archive
      table.boolean("is_active").notNullable().defaultTo(true);
      table.timestamp("updated_at", { useTz: true }).defaultTo(db.fn.now());
    });
  }

  // สำหรับฐานข้อมูลเดิมที่สร้างตอนยังไม่มีตาราง meetings — เติม FK ที่ขาด
  await db.raw(
    `DO $$ BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_constraint WHERE conname = 'room_bookings_meeting_id_foreign'
       ) THEN
         ALTER TABLE room_bookings
           ADD CONSTRAINT room_bookings_meeting_id_foreign
           FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE SET NULL;
       END IF;
     END $$;`,
  ).catch((err) => console.warn("[Knex] room_bookings FK check:", err.message));

  await seedDefaults();
}

async function addColumnIfMissing(
  table: string,
  column: string,
  build: (t: any) => void,
): Promise<void> {
  const hasCol = await db.schema.hasColumn(table, column);
  if (!hasCol) {
    await db.schema.alterTable(table, (t) => build(t));
  }
}

/** ข้อมูลเริ่มต้นของระบบ (idempotent) */
async function seedDefaults(): Promise<void> {
  // ผู้ใช้เริ่มต้น
  const userCount = Number(
    (await db("users").count("id as count").first())?.count || 0,
  );
  if (userCount === 0) {
    await db("users").insert([
      { username: "admin", password: hashPassword("password"), role: "admin", name: "ผู้ดูแลระบบ" },
      { username: "secretary", password: hashPassword("password"), role: "secretary", name: "เลขานุการประชุม" },
      { username: "demo", password: hashPassword("password"), role: "user", name: "สมชาย ใจดี" },
      { username: "staff", password: hashPassword("password"), role: "staff", name: "เจ้าหน้าที่ห้องประชุม", position: "เจ้าหน้าที่กิจการภายใน" },
    ]);
  } else {
    // ระบบที่สร้างก่อนมีบทบาท staff — เติมบัญชีตัวอย่างให้ (idempotent)
    const staffExists = await db("users").where({ username: "staff" }).first();
    if (!staffExists) {
      await db("users").insert({
        username: "staff",
        password: hashPassword("password"),
        role: "staff",
        name: "เจ้าหน้าที่ห้องประชุม",
        position: "เจ้าหน้าที่กิจการภายใน",
      });
    }
  }

  // บทบาท (เติมบทบาทที่ยังไม่มี เพื่อให้ระบบเดิมได้ staff ด้วย)
  const existingRoleCodes = new Set(
    ((await db("roles").select("code")) as Array<{ code: string }>).map((r) => r.code),
  );
  const allRoles = [
    { code: "admin", name: "ผู้ดูแลระบบ", description: "จัดการทุกส่วนของระบบ รวมถึงจัดการบัญชีผู้ใช้" },
    { code: "secretary", name: "เลขานุการ", description: "จัดทำวาระ บันทึกการประชุม และตรวจสอบรายงาน" },
    { code: "member", name: "สมาชิก", description: "เข้าร่วมประชุมและดูเอกสาร" },
    { code: "staff", name: "เจ้าหน้าที่ห้องประชุม", description: "ดูแลห้องประชุมที่รับผิดชอบ และดูตารางการจองของห้อง" },
  ];
  const missingRoles = allRoles.filter((r) => !existingRoleCodes.has(r.code));
  if (missingRoles.length > 0) {
    await db("roles").insert(missingRoles);
  }

  // ห้องประชุม + อุปกรณ์
  const roomCount = Number((await db("meeting_rooms").count("id as count").first())?.count || 0);
  if (roomCount === 0) {
    const [secretaryUser] = await db("users").where({ username: "secretary" }).select("id");
    const [staffUser] = await db("users").where({ username: "staff" }).select("id");
    const rooms = await db("meeting_rooms")
      .insert([
        {
          name: "ห้องประชุมใหญ่ ชั้น 2", capacity: 40, building: "อาคารผู้ป่วยนอก (OPD)", floor: "2",
          location: "ฝั่งซ้าย ข้างลิฟต์", table_count: 10, chair_count: 45, color: "#2563eb",
          responsible_user_id: secretaryUser?.id ?? null,
          has_dining: true,
          dining_detail: "มีพื้นที่รับประทานอาหารว่างหน้าห้อง และใกล้โรงอาหารกลางชั้น 1 (จุ 50 คน)",
          description: "ห้องประชุมหลัก ใช้สำหรับประชุมใหญ่ระดับโรงพยาบาล",
        },
        {
          name: "ห้องประชุมบอร์ดรูม", capacity: 12, building: "อาคารบริหาร", floor: "3",
          location: "ห้องผู้อำนวยการ", table_count: 1, chair_count: 14, color: "#7c3aed",
          responsible_user_id: staffUser?.id ?? null,
          has_dining: true,
          dining_detail: "ห้องรับรองผู้บริหารพร้อมโซนอาหารว่างและกาแฟในตัว",
          description: "ห้องประชุมผู้บริหาร พร้อมชุดประชุมทางไกล",
        },
        {
          name: "ห้องประชุมเล็ก 1", capacity: 6, building: "อาคารผู้ป่วยนอก (OPD)", floor: "1",
          location: "ใกล้ห้องเวชระเบียน", table_count: 1, chair_count: 8, color: "#059669",
          responsible_user_id: staffUser?.id ?? null,
          has_dining: false,
          dining_detail: null,
          description: "ห้องประชุมกลุ่มย่อย",
        },
      ])
      .returning(["id", "capacity"]);
    const equipment: Array<{ room_id: string; equipment_type: string; name?: string; quantity?: number }> = [];
    for (const room of rooms) {
      equipment.push({ room_id: room.id, equipment_type: "sound_system", name: "ชุดระบบเสียงประชุม", quantity: 1 });
      if (room.capacity >= 12) {
        equipment.push(
          { room_id: room.id, equipment_type: "projector", name: "โปรเจกเตอร์" },
          { room_id: room.id, equipment_type: "wireless_mic", name: "ไมค์ไร้สาย", quantity: 2 },
          { room_id: room.id, equipment_type: "video_conf", name: "อุปกรณ์ประชุมทางไกล" },
        );
      }
      if (room.capacity >= 40) {
        equipment.push(
          { room_id: room.id, equipment_type: "recorder", name: "อุปกรณ์บันทึกเสียง" },
          { room_id: room.id, equipment_type: "speaker", name: "ลำโพงติดผนัง", quantity: 4 },
        );
      }
      equipment.push(
        { room_id: room.id, equipment_type: "tv", name: "จอทีวี" },
        { room_id: room.id, equipment_type: "whiteboard", name: "กระดานไวท์บอร์ด" },
      );
    }
    await db("room_equipment").insert(equipment);
  }

  // Prompt templates
  const promptCount = Number((await db("ai_prompts").count("id as count").first())?.count || 0);
  if (promptCount === 0) {
    await db("ai_prompts").insert([
      {
        code: "summarize_agenda",
        version: 1,
        template:
          "คุณเป็นผู้ช่วยเลขานุการซึ่งเตรียมสรุปเอกสารก่อนการประชุม\n" +
          "วาระ: {{agenda_title}}\nประเภทวาระ: {{agenda_type}}\n\n" +
          "เนื้อหาจากเอกสาร (แยกตามหน้า):\n{{pages}}\n\n" +
          "กรุณาสรุปเป็น JSON ตามรูปแบบ: {\"summary\": string, \"key_points\": string[], \"key_numbers\": string[], \"considerations\": string[], \"questions\": string[], \"page_references\": [{\"page\": number, \"note\": string}]}\n" +
          "ข้อกำหนดสำคัญ: อ้างอิงเฉพาะสิ่งที่มีในเอกสาร ระบุเลขหน้าที่อ้างอิงเสมอ ห้ามเดาข้อมูลที่ไม่มี",
      },
      {
        code: "generate_minutes",
        version: 1,
        template:
          "คุณเป็นเลขานุการซึ่งร่างรายงานการประชุม\nการประชุม: {{meeting_title}}\nวันเวลา: {{meeting_time}}\n\nวาระและสรุปเอกสาร:\n{{agenda_summaries}}\n\nบันทึกการอภิปราย (transcript):\n{{transcript}}\n\nมติ/งานที่เลขาบันทึกระหว่างประชุม:\n{{manual_notes}}\n\n" +
          "กรุณาสร้าง JSON: {\"sections\": [{\"agenda_no\": number, \"agenda_title\": string, \"discussion\": string, \"decision\": string}], \"general_summary\": string}\n" +
          "ข้อกำหนดสำคัญ: ห้ามแต่งมติหรือชื่อผู้รับผิดชอบที่ไม่มีในข้อมูล ถ้าไม่ชัดเจนให้ระบุ \"รอตรวจสอบจากเลขานุการ\"",
      },
    ]);
  }

  // System settings
  const settingCount = Number((await db("system_settings").count("key as count").first())?.count || 0);
  if (settingCount === 0) {
    await db("system_settings").insert([
      { key: "meeting_reminder_minutes", value: JSON.stringify(30), description: "แจ้งเตือนก่อนประชุม (นาที)" },
      { key: "ai_auto_analyze", value: JSON.stringify(true), description: "วิเคราะห์เอกสารอัตโนมัติเมื่ออัปโหลด" },
      { key: "default_recording_consent", value: JSON.stringify(false), description: "ขอความยินยอมบันทึกเสียงทุกครั้ง" },
    ]);
  }

  // Retention policies
  const retentionCount = Number((await db("retention_policies").count("id as count").first())?.count || 0);
  if (retentionCount === 0) {
    await db("retention_policies").insert([
      { entity_type: "recording", retain_days: 180, action: "delete" },
      { entity_type: "transcript", retain_days: 365, action: "archive" },
      { entity_type: "document", retain_days: 1825, action: "archive" },
      { entity_type: "minutes", retain_days: 3650, action: "archive" },
    ]);
  }
}
