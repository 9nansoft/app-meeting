<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { toast } from "vue-sonner";
import { useMeetingApi } from "@/composables/useMeetingApi";
import { dayjs, fmtDateTime, fmtMs, agendaTypeLabel } from "@/utils/meeting-format";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Mic, Square, Loader2, Gavel, ListTodo, Clock, Play, FastForward, CheckCircle2,
  Radio, AudioLines, Link2, Users,
} from "lucide-vue-next";

const route = useRoute();
const meetingId = route.params.id as string;
useSeoMeta({ title: "Live Meeting | AI Smart Meeting" });

const { api, call, upload } = useMeetingApi();

const loading = ref(true);
const detail = ref<any>(null);
const segments = ref<any[]>([]);
const recordings = ref<any[]>([]);
const decisions = ref<any[]>([]);
const actions = ref<any[]>([]);
const users = ref<any[]>([]);

const agendas = computed(() => detail.value?.agendas ?? []);
const currentAgendaId = ref<string>("");
const currentAgenda = computed(() => agendas.value.find((a) => a.id === currentAgendaId.value));

async function load() {
  const data = await call(() => api.meetings[meetingId].get(), { silent: true });
  if (data) detail.value = data;
  const presenting = agendas.value.find((a: any) => a.status === "presenting");
  if (presenting && !currentAgendaId.value) currentAgendaId.value = presenting.id;
  loading.value = false;
}

async function loadTranscript() {
  const data = await call(() => api.meetings[meetingId].transcript.get({ query: {} }), { silent: true });
  if (data) {
    segments.value = (data as any).segments ?? [];
    recordings.value = (data as any).recordings ?? [];
  }
}

async function loadResults() {
  const data = await call(() => api.meetings[meetingId].minutes.get(), { silent: true });
  if (data) {
    decisions.value = (data as any).decisions ?? [];
    actions.value = (data as any).actionItems ?? [];
  }
}

onMounted(async () => {
  const [u] = await Promise.all([call(() => api.users.get(), { silent: true })]);
  if (u) users.value = Array.isArray(u) ? u : (u as any).users ?? [];
  await Promise.all([load(), loadTranscript(), loadResults()]);
  startPolling();
});

let pollTimer: ReturnType<typeof setInterval> | null = null;
function startPolling() {
  pollTimer = setInterval(async () => {
    await Promise.all([loadTranscript(), loadResults()]);
  }, 5000);
}
onUnmounted(() => {
  stopRecording(false);
  if (pollTimer) clearInterval(pollTimer);
});

/* ---------- การบันทึกเสียง ---------- */
const isRecording = ref(false);
const elapsedSec = ref(0);
const uploadingCount = ref(0);
let mediaRecorder: MediaRecorder | null = null;
let mediaStream: MediaStream | null = null;
let elapsedTimer: ReturnType<typeof setInterval> | null = null;
let segStartTime = 0;
const SEGMENT_MS = 5 * 60 * 1000; // อัปโหลดทุก 5 นาที เพื่อถอดเสียงแบบใกล้เรียลไทม์

async function startRecording() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    toast.error("ไม่สามารถเข้าถึงไมโครโฟนได้ — กรุณาอนุญาตใช้งานไมค์ในเบราว์เซอร์");
    return;
  }
  isRecording.value = true;
  elapsedSec.value = 0;
  elapsedTimer = setInterval(() => (elapsedSec.value += 1), 1000);

  if (detail.value?.meeting?.status === "scheduled") {
    await call(() => api.meetings[meetingId].status.post({ status: "in_progress" }), { silent: true });
    await load();
  }
  beginSegment();
  toast.success("เริ่มบันทึกเสียงแล้ว — ระบบจะถอดเสียงเป็นช่วง ๆ ระหว่างประชุม");
}

function beginSegment() {
  if (!mediaStream) return;
  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";
  mediaRecorder = new MediaRecorder(mediaStream, { mimeType: mime });
  const chunks: Blob[] = [];
  segStartTime = Date.now();
  mediaRecorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
  mediaRecorder.onstop = async () => {
    const blob = new Blob(chunks, { type: mime });
    if (blob.size > 1024) {
      const durationSec = Math.round((Date.now() - segStartTime) / 1000);
      await uploadSegment(blob, durationSec);
    }
  };
  mediaRecorder.start();
  segmentTimer = setTimeout(() => {
    rotateSegment();
  }, SEGMENT_MS);
}

let segmentTimer: ReturnType<typeof setTimeout> | null = null;
function rotateSegment() {
  // หยุดชั่วคราวเพื่อปิดไฟล์ แล้วเริ่ม segment ใหม่ทันที
  if (mediaRecorder?.state === "recording") {
    mediaRecorder.stop();
    setTimeout(() => {
      if (isRecording.value) beginSegment();
    }, 300);
  }
}

async function uploadSegment(blob: Blob, durationSec: number) {
  uploadingCount.value += 1;
  const headers: Record<string, string> = {
    "x-duration-seconds": String(durationSec),
  };
  if (currentAgendaId.value) headers["x-agenda-id"] = currentAgendaId.value;
  const result = await upload(
    `/api/meetings/${meetingId}/recordings`,
    blob,
    headers,
    `recording-${dayjs().format("HHmmss")}.webm`,
  );
  uploadingCount.value -= 1;
  if (result) {
    await loadTranscript();
  }
}

async function stopRecording(notify = true) {
  if (segmentTimer) clearTimeout(segmentTimer);
  segmentTimer = null;
  if (mediaRecorder?.state === "recording") {
    mediaRecorder.stop();
    mediaRecorder = null;
  }
  mediaStream?.getTracks().forEach((t) => t.stop());
  mediaStream = null;
  if (elapsedTimer) clearInterval(elapsedTimer);
  elapsedTimer = null;
  if (isRecording.value && notify) toast.info("หยุดบันทึกเสียงแล้ว — ระบบกำลังถอดเสียงช่วงสุดท้าย");
  isRecording.value = false;
}

/* ---------- วาระปัจจุบัน + จับเวลา ---------- */
const agendaElapsed = ref(0);
let agendaTimer: ReturnType<typeof setInterval> | null = null;

async function setCurrentAgenda(agendaId: string) {
  if (currentAgendaId.value === agendaId) return;
  currentAgendaId.value = agendaId;
  agendaElapsed.value = 0;
  await call(() => api.meetings[meetingId]["current-agenda"].post({ agendaId }), { silent: true });
  toast.success(`เปลี่ยนไปยังวาระ: ${currentAgenda.value?.title}`);
}

function startAgendaTimer() {
  if (agendaTimer) clearInterval(agendaTimer);
  agendaTimer = setInterval(() => (agendaElapsed.value += 1), 1000);
}
function stopAgendaTimer() {
  if (agendaTimer) clearInterval(agendaTimer);
  agendaTimer = null;
}

async function markAgendaDone() {
  if (!currentAgendaId.value) return;
  stopAgendaTimer();
  await call(() =>
    api.meetings.agendas[currentAgendaId.value].put({ status: "done" }),
    { silent: true },
  );
  toast.success("ทำเครื่องหมายวาระนี้ว่าเสร็จแล้ว");
  const next = agendas.value.find((a: any) => a.status === "pending");
  if (next) await setCurrentAgenda(next.id);
  await load();
}

/* ---------- บันทึกมติ/งานระหว่างประชุม ---------- */
const decisionText = ref("");
const savingDecision = ref(false);
async function saveDecision() {
  if (!decisionText.value.trim()) return;
  savingDecision.value = true;
  const data = await call(() =>
    api.meetings[meetingId].decisions.post({
      decisionText: decisionText.value,
      agendaId: currentAgendaId.value || undefined,
    }),
  );
  savingDecision.value = false;
  if (data) {
    decisionText.value = "";
    toast.success("บันทึกมติแล้ว");
    await loadResults();
  }
}

const actionForm = ref({ title: "", assigneeId: "", dueDate: "", priority: "normal" });
const savingAction = ref(false);
async function saveAction() {
  if (!actionForm.value.title.trim()) return;
  savingAction.value = true;
  const data = await call(() =>
    api.meetings[meetingId].actions.post({
      title: actionForm.value.title,
      agendaId: currentAgendaId.value || undefined,
      assigneeId: actionForm.value.assigneeId ? Number(actionForm.value.assigneeId) : undefined,
      dueDate: actionForm.value.dueDate || undefined,
      priority: actionForm.value.priority,
    }),
  );
  savingAction.value = false;
  if (data) {
    actionForm.value = { title: "", assigneeId: "", dueDate: "", priority: "normal" };
    toast.success("บันทึกงานที่มอบหมายแล้ว (ผู้รับงานจะได้รับแจ้งเตือน)");
    await loadResults();
  }
}

async function linkSegment(segment: any) {
  if (!currentAgendaId.value) {
    toast.error("เลือกวาระปัจจุบันก่อนเชื่อมโยงข้อความ");
    return;
  }
  await call(() =>
    api.meetings[meetingId].transcript.link.post({
      segmentId: segment.id,
      agendaId: currentAgendaId.value,
    }),
  );
  toast.success("เชื่อมโยงกับวาระปัจจุบันแล้ว");
  await loadTranscript();
}

async function endMeeting() {
  stopRecording(false);
  const data = await call(() => api.meetings[meetingId].status.post({ status: "completed" }));
  if (data) {
    toast.success("จบการประชุมแล้ว — ไปหน้ารายงานเพื่อสั่ง AI สร้างร่างต่อ");
    await navigateTo(`/meetings/${meetingId}/minutes`);
  }
}

const meeting = computed(() => detail.value?.meeting);
const transcribing = computed(() => recordings.value.some((r) => ["uploaded", "transcribing"].includes(r.status)));
</script>

<template>
  <div class="space-y-6">
    <div v-if="loading" class="space-y-4">
      <div class="h-24 bg-muted animate-pulse rounded-lg" />
      <div class="h-96 bg-muted animate-pulse rounded-lg" />
    </div>

    <template v-else-if="meeting">
      <!-- แถบควบคุมการประชุม -->
      <Card class="border-2" :class="isRecording ? 'border-red-500/60' : ''">
        <CardContent class="p-4 flex items-center gap-4 flex-wrap">
          <div
            class="h-14 w-14 rounded-full flex items-center justify-center shrink-0 transition-colors"
            :class="isRecording ? 'bg-red-500 text-white animate-pulse' : 'bg-primary text-primary-foreground'"
          >
            <Radio v-if="isRecording" class="w-6 h-6" />
            <Mic v-else class="w-6 h-6" />
          </div>
          <div class="flex-1 min-w-0">
            <div class="font-semibold truncate">{{ meeting.title }}</div>
            <div class="text-sm text-muted-foreground flex items-center gap-3 flex-wrap mt-0.5">
              <span>{{ fmtDateTime(meeting.start_time) }}</span>
              <span class="flex items-center gap-1"><Clock class="w-3.5 h-3.5" /> บันทึกแล้ว {{ fmtMs(elapsedSec * 1000) }}</span>
              <Badge v-if="isRecording" variant="destructive">REC</Badge>
              <span v-if="uploadingCount > 0" class="flex items-center gap-1 text-xs">
                <Loader2 class="w-3.5 h-3.5 animate-spin" /> กำลังส่งไฟล์เสียง {{ uploadingCount }}
              </span>
              <span v-if="transcribing" class="flex items-center gap-1 text-xs text-primary">
                <AudioLines class="w-3.5 h-3.5" /> AI กำลังถอดเสียง
              </span>
            </div>
          </div>
          <div class="flex gap-2 shrink-0">
            <Button v-if="!isRecording" size="lg" class="bg-red-500 hover:bg-red-600 text-white" @click="startRecording">
              <Mic class="w-4 h-4 mr-1.5" /> เริ่มบันทึกเสียง
            </Button>
            <Button v-else size="lg" variant="outline" @click="stopRecording()">
              <Square class="w-4 h-4 mr-1.5" /> หยุดบันทึก
            </Button>
            <Button variant="destructive" @click="endMeeting"><CheckCircle2 class="w-4 h-4 mr-1.5" /> จบการประชุม</Button>
          </div>
        </CardContent>
      </Card>

      <div class="grid lg:grid-cols-3 gap-6">
        <!-- คอลัมน์ซ้าย: วาระปัจจุบัน + บันทึกสด -->
        <div class="space-y-6">
          <Card>
            <CardHeader class="pb-3">
              <CardTitle class="text-base">วาระปัจจุบัน</CardTitle>
            </CardHeader>
            <CardContent class="space-y-3">
              <Select :model-value="currentAgendaId" @update:model-value="setCurrentAgenda(String($event))">
                <SelectTrigger><SelectValue placeholder="เลือกวาระที่กำลังประชุม" /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="a in agendas.filter((x: any) => x.status !== 'done')" :key="a.id" :value="a.id">
                    {{ a.sequence_no }}. {{ a.title }}
                  </SelectItem>
                </SelectContent>
              </Select>
              <div v-if="currentAgenda" class="rounded-lg bg-muted/50 p-3 text-sm space-y-1.5">
                <div class="flex justify-between">
                  <span class="text-muted-foreground">ประเภท</span>
                  <Badge variant="outline">{{ agendaTypeLabel[currentAgenda.agenda_type] }}</Badge>
                </div>
                <div class="flex justify-between">
                  <span class="text-muted-foreground">เวลาที่ใช้จริง</span>
                  <span class="font-mono font-semibold">{{ fmtMs(agendaElapsed * 1000) }} / {{ currentAgenda.duration_minutes || "-" }} นาที</span>
                </div>
                <div class="flex gap-2 pt-1">
                  <Button size="sm" variant="outline" class="flex-1" @click="startAgendaTimer(); toast.info('เริ่มจับเวลาวาระ')">
                    <Play class="w-3.5 h-3.5 mr-1" /> จับเวลา
                  </Button>
                  <Button size="sm" variant="outline" class="flex-1" @click="stopAgendaTimer()"><Square class="w-3.5 h-3.5 mr-1" /> หยุด</Button>
                  <Button size="sm" class="flex-1" @click="markAgendaDone"><FastForward class="w-3.5 h-3.5 mr-1" /> เสร็จแล้ว</Button>
                </div>
              </div>
              <div v-else class="text-sm text-muted-foreground text-center py-2">เลือกวาระเพื่อเชื่อมโยงเสียงและมติ</div>
            </CardContent>
          </Card>

          <!-- บันทึกมติสด -->
          <Card>
            <CardHeader class="pb-3">
              <CardTitle class="text-base flex items-center gap-2"><Gavel class="w-4 h-4" /> บันทึกมติระหว่างประชุม</CardTitle>
            </CardHeader>
            <CardContent class="space-y-2">
              <Textarea v-model="decisionText" rows="3" placeholder="พิมพ์มติของที่ประชุม เช่น เห็นชอบในหลักการและมอบหมายให้..." />
              <Button size="sm" class="w-full" :disabled="savingDecision || !decisionText.trim()" @click="saveDecision">
                <Loader2 v-if="savingDecision" class="w-4 h-4 mr-1.5 animate-spin" /> บันทึกมติ
              </Button>
              <ScrollArea class="max-h-48">
                <div v-for="d in [...decisions].reverse()" :key="d.id" class="flex items-start gap-2 py-1.5 text-sm border-b last:border-0">
                  <Badge v-if="d.status === 'confirmed'" variant="default" class="text-[10px] mt-0.5 shrink-0">ยืนยันแล้ว</Badge>
                  <Badge v-else variant="outline" class="text-[10px] mt-0.5 shrink-0">รอตรวจ</Badge>
                  <span class="flex-1">{{ d.decision_text }}</span>
                </div>
              </ScrollArea>
            </CardContent>
          </Card>

          <!-- บันทึกงานสด -->
          <Card>
            <CardHeader class="pb-3">
              <CardTitle class="text-base flex items-center gap-2"><ListTodo class="w-4 h-4" /> มอบหมายงานทันที</CardTitle>
            </CardHeader>
            <CardContent class="space-y-2">
              <Input v-model="actionForm.title" placeholder="ชื่องานที่มอบหมาย" />
              <div class="grid grid-cols-2 gap-2">
                <Select :model-value="actionForm.assigneeId" @update:model-value="actionForm.assigneeId = String($event)">
                  <SelectTrigger><SelectValue placeholder="ผู้รับผิดชอบ" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="u in users" :key="u.id" :value="String(u.id)">{{ u.name || u.username }}</SelectItem>
                  </SelectContent>
                </Select>
                <Input type="date" v-model="actionForm.dueDate" />
              </div>
              <Button size="sm" variant="outline" class="w-full" :disabled="savingAction || !actionForm.title.trim()" @click="saveAction">
                <Loader2 v-if="savingAction" class="w-4 h-4 mr-1.5 animate-spin" /> บันทึกงาน
              </Button>
              <div v-for="a in [...actions].reverse()" :key="a.id" class="py-1.5 text-sm border-b last:border-0 flex items-center gap-2">
                <ListTodo class="w-3.5 h-3.5 text-amber-500 shrink-0" />
                <span class="flex-1 truncate">{{ a.title }}</span>
                <Badge variant="outline" class="text-[10px] shrink-0">{{ a.due_date ? dayjs(a.due_date).format("D MMM") : "ไม่มีกำหนด" }}</Badge>
              </div>
            </CardContent>
          </Card>
        </div>

        <!-- คอลัมน์ขวา: Transcript -->
        <Card class="lg:col-span-2">
          <CardHeader class="pb-3">
            <CardTitle class="text-base flex items-center gap-2">
              <AudioLines class="w-4 h-4" /> Transcript การประชุม
              <Badge v-if="transcribing" variant="outline" class="ml-1 animate-pulse">กำลังถอดเสียง...</Badge>
            </CardTitle>
            <CardDescription>
              ข้อความจาก AI ถอดเสียง — กด "เชื่อมวาระ" เพื่อผูกช่วงสนทนาเข้ากับวาระปัจจุบัน
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div v-if="segments.length === 0" class="py-16 text-center text-muted-foreground text-sm">
              <AudioLines class="w-10 h-10 mx-auto mb-2 opacity-30" />
              เริ่มบันทึกเสียง — transcript จะปรากฏที่นี่เมื่อ AI ถอดเสียงเสร็จแต่ละช่วง
            </div>
            <ScrollArea v-else class="h-[70vh] pr-3">
              <div class="space-y-2">
                <div
                  v-for="s in segments"
                  :key="s.id"
                  class="p-3 rounded-lg border text-sm group"
                  :class="s.agenda_id === currentAgendaId && currentAgendaId ? 'border-primary/40 bg-primary/5' : ''"
                >
                  <div class="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                    <span class="font-mono">{{ fmtMs(s.start_ms) }}</span>
                    <span v-if="s.speaker" class="font-medium text-foreground">{{ s.speaker }}</span>
                    <Button
                      v-if="currentAgendaId && s.agenda_id !== currentAgendaId"
                      variant="ghost" size="sm"
                      class="h-6 px-2 text-[11px] ml-auto opacity-0 group-hover:opacity-100 transition-opacity"
                      @click="linkSegment(s)"
                    >
                      <Link2 class="w-3 h-3 mr-1" /> เชื่อมวาระ
                    </Button>
                  </div>
                  {{ s.text }}
                </div>
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      </div>
    </template>
  </div>
</template>
