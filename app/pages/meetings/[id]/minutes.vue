<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { toast } from "vue-sonner";
import { useMeetingApi } from "@/composables/useMeetingApi";
import {
  dayjs, fmtDateTime, decisionTypeLabel, actionStatusLabels, minutesStatusLabel,
  roleInMeetingLabel,
} from "@/utils/meeting-format";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Sparkles, FileText, Gavel, ListTodo, Users, CheckCircle2, XCircle, Pencil, Plus,
  Trash2, Send, Printer, Loader2, Eye, Clock3, AlertTriangle,
} from "lucide-vue-next";

const route = useRoute();
const meetingId = route.params.id as string;
useSeoMeta({ title: "รายงานการประชุม | AI Smart Meeting" });

const { api, call } = useMeetingApi();
const loading = ref(true);
const detail = ref<any>(null);
const data = ref<any>(null);
const users = ref<any[]>([]);
const generating = ref(false);
const savingContent = ref(false);
const content = ref<any>(null);
const attendanceForm = ref<Record<number, string>>({});
const actionOpen = ref(false);
const actionForm = ref({ title: "", assigneeId: "", assigneeText: "", dueDate: "", priority: "normal", detail: "" });
const approvalOpen = ref(false);
const approveForm = ref({ approved: true, comment: "" });

let pollTimer: ReturnType<typeof setInterval> | null = null;

async function load() {
  const d = await call(() => api.meetings[meetingId].get(), { silent: true });
  if (d) detail.value = d;
  loading.value = false;
}

async function loadMinutes() {
  const d = await call(() => api.meetings[meetingId].minutes.get(), { silent: true });
  if (d) {
    data.value = d;
    if ((d as any).minutes?.content && !content.value) {
      try {
        const raw = (d as any).minutes.content;
        content.value = typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch {
        content.value = null;
      }
    }
    // preload attendance selections
    for (const p of detail.value?.participants ?? []) {
      const found = ((d as any).attendance ?? []).find((a: any) => a.user_id === p.user_id);
      attendanceForm.value[p.user_id] = found?.attendance_type || "present";
    }
  }
}

onMounted(async () => {
  const u = await call(() => api.users.get(), { silent: true });
  if (u) users.value = Array.isArray(u) ? u : (u as any).users ?? [];
  await load();
  await loadMinutes();
  pollTimer = setInterval(async () => {
    const job = data.value?.latestJob;
    if (job && ["queued", "processing"].includes(job.status)) {
      await loadMinutes();
    }
  }, 3000);
});
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});

const meeting = computed(() => detail.value?.meeting);
const minutes = computed(() => data.value?.minutes);
const decisions = computed(() => data.value?.decisions ?? []);
const actionItems = computed(() => data.value?.actionItems ?? []);
const agendas = computed(() => detail.value?.agendas ?? []);
const participants = computed(() => detail.value?.participants ?? []);
const isChair = computed(() => {
  const auth = useAuth();
  return auth.user.value?.role === "admin" || Number(auth.user.value?.id) === meeting.value?.organizer_id;
});
const canEdit = computed(() => ["admin", "secretary"].includes(useAuth().user.value?.role || "") || isChair.value);
const isPublished = computed(() => minutes.value?.status === "published");
const latestJob = computed(() => data.value?.latestJob);

async function generate() {
  generating.value = true;
  const d = await call(() => api.meetings[meetingId].minutes.generate.post({}));
  generating.value = false;
  if (d) {
    toast.success("AI กำลังสร้างร่างรายงาน — จะพร้อมในไม่กี่วินาที");
    content.value = null;
    setTimeout(loadMinutes, 2000);
  }
}

async function saveContent() {
  if (!content.value) return;
  savingContent.value = true;
  const d = await call(() =>
    api.meetings[meetingId].minutes.put({ content: content.value, markReviewed: true }),
  );
  savingContent.value = false;
  if (d) {
    toast.success("บันทึกรายงานแล้ว");
    await loadMinutes();
  }
}

async function reviewDecision(d: any, status: "confirmed" | "rejected") {
  const result = await call(() =>
    api.meetings[meetingId].decisions[d.id].review.post({ status }),
  );
  if (result) {
    toast.success(status === "confirmed" ? "ยืนยันมติแล้ว" : "ปฏิเสธมติรายการนี้แล้ว");
    await loadMinutes();
  }
}

async function deleteDecision(d: any) {
  const result = await call(() => api.meetings[meetingId].decisions[d.id].delete());
  if (result) {
    await loadMinutes();
    toast.success("ลบมติแล้ว");
  }
}

/* ---------- งาน ---------- */
function openAction() {
  actionForm.value = { title: "", assigneeId: "", assigneeText: "", dueDate: "", priority: "normal", detail: "" };
  actionOpen.value = true;
}

async function saveAction() {
  if (!actionForm.value.title.trim()) return;
  const d = await call(() =>
    api.meetings[meetingId].actions.post({
      title: actionForm.value.title,
      detail: actionForm.value.detail || undefined,
      assigneeId: actionForm.value.assigneeId ? Number(actionForm.value.assigneeId) : undefined,
      assigneeText: actionForm.value.assigneeId ? undefined : actionForm.value.assigneeText || undefined,
      dueDate: actionForm.value.dueDate || undefined,
      priority: actionForm.value.priority,
    }),
  );
  if (d) {
    actionOpen.value = false;
    toast.success("เพิ่มงานแล้ว");
    await loadMinutes();
  }
}

async function updateActionStatus(item: any, status: string) {
  const d = await call(() => api.meetings[meetingId].actions[item.id].put({ status }));
  if (d) {
    await loadMinutes();
    toast.success("อัปเดตสถานะงานแล้ว");
  }
}

async function deleteAction(item: any) {
  const d = await call(() => api.meetings[meetingId].actions[item.id].delete());
  if (d) {
    await loadMinutes();
    toast.success("ลบงานแล้ว");
  }
}

/* ---------- การเข้าร่วม ---------- */
async function saveAttendance() {
  const records = participants.value
    .map((p: any) => ({ userId: p.user_id, attendanceType: attendanceForm.value[p.user_id] || "present" }));
  if (!records.length) return;
  const d = await call(() => api.meetings[meetingId].attendance.post({ records }));
  if (d) toast.success("บันทึกการเข้าร่วมแล้ว");
}

/* ---------- อนุมัติ/เผยแพร่ ---------- */
async function requestApproval() {
  const d = await call(() => api.meetings[meetingId].minutes["request-approval"].post({}));
  if (d) {
    toast.success("ส่งคำขออนุมัติแล้ว — ประธานการประชุมจะได้รับแจ้งเตือน");
    await loadMinutes();
  }
}

function openApproval(approved: boolean) {
  approveForm.value = { approved, comment: "" };
  approvalOpen.value = true;
}

async function submitApproval() {
  const d = await call(() =>
    api.meetings[meetingId].minutes.approve.post({
      approved: approveForm.value.approved,
      comment: approveForm.value.comment || undefined,
    }),
  );
  if (d) {
    approvalOpen.value = false;
    toast.success(approveForm.value.approved ? "อนุมัติและเผยแพร่รายงานแล้ว" : "ส่งกลับให้เลขาแก้ไขแล้ว");
    await Promise.all([loadMinutes(), load()]);
  }
}

/* ---------- Export ---------- */
function exportMarkdown() {
  if (!content.value) return;
  const lines = [
    `# รายงานการประชุม: ${meeting.value?.title}`,
    ``,
    `- วันเวลา: ${fmtDateTime(meeting.value?.start_time)} – ${dayjs(meeting.value?.end_time).format("HH:mm")}`,
    `- สถานที่: ${meeting.value?.location_text || "-"}`,
    `- ผู้เข้าร่วม: ${participants.value.map((p: any) => p.name).join(", ")}`,
    ``,
    content.value.general_summary || "",
    ``,
  ];
  for (const s of content.value.sections || []) {
    lines.push(`## วาระที่ ${s.agenda_no}: ${s.agenda_title}`, ``, `### การอภิปราย`, s.discussion, ``, `### มติที่ประชุม`, s.decision, ``);
  }
  lines.push(`## มติทั้งหมด`, ``);
  for (const d of decisions.value.filter((x: any) => x.status === "confirmed")) {
    lines.push(`- ${d.decision_text}`);
  }
  lines.push(``, `## งานที่มอบหมาย`, ``);
  for (const a of actionItems.value) {
    lines.push(`- ${a.title} (กำหนดส่ง: ${a.due_date || "-"} สถานะ: ${actionStatusLabels[a.status]})`);
  }
  const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `รายงานการประชุม-${meeting.value?.title}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

const statusFlow = computed(() => minutes.value?.status || "none");
</script>

<template>
  <div class="space-y-6">
    <div v-if="loading" class="space-y-4">
      <Skeleton class="h-24 w-full" />
      <Skeleton class="h-96 w-full" />
    </div>

    <template v-else-if="meeting">
      <div class="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 class="text-2xl font-bold tracking-tight flex items-center gap-2">
            <FileText class="w-6 h-6 text-primary" /> รายงานการประชุม
          </h1>
          <p class="text-muted-foreground mt-1">{{ meeting.title }} · {{ fmtDateTime(meeting.start_time) }}</p>
        </div>
        <div class="flex gap-2 flex-wrap">
          <Button v-if="minutes && !isPublished" variant="outline" :disabled="generating" @click="generate()">
            <Loader2 v-if="generating && latestJob?.status === 'processing'" class="w-4 h-4 mr-1.5 animate-spin" />
            <Sparkles v-else class="w-4 h-4 mr-1.5" /> สร้างร่างใหม่ด้วย AI
          </Button>
          <Button v-if="minutes && !isPublished && canEdit" variant="outline" @click="requestApproval()">
            <Send class="w-4 h-4 mr-1.5" /> ส่งขออนุมัติ
          </Button>
          <Button v-if="isChair && minutes?.status === 'pending_review'" @click="openApproval(true)">
            <CheckCircle2 class="w-4 h-4 mr-1.5" /> อนุมัติและเผยแพร่
          </Button>
          <Button v-if="minutes" variant="outline" @click="exportMarkdown()"><Printer class="w-4 h-4 mr-1.5" /> ส่งออก</Button>
          <Button variant="ghost" @click="navigateTo(`/meetings/${meetingId}`)"><Eye class="w-4 h-4 mr-1.5" /> หน้าวาระ</Button>
        </div>
      </div>

      <!-- สถานะ flow -->
      <Card v-if="minutes">
        <CardContent class="p-4 flex items-center gap-3 flex-wrap">
          <template v-if="latestJob && ['queued', 'processing'].includes(latestJob.status)">
            <Loader2 class="w-5 h-5 text-primary animate-spin" />
            <span class="text-sm">AI กำลังสร้างร่างรายงานจาก transcript และสรุปเอกสาร... (อัปเดตอัตโนมัติ)</span>
          </template>
          <template v-else>
            <Badge :variant="statusFlow === 'published' ? 'default' : statusFlow === 'pending_review' ? 'destructive' : 'outline'">
              {{ minutesStatusLabel[statusFlow] }}
            </Badge>
            <span class="text-sm text-muted-foreground">เวอร์ชัน {{ minutes.version }} · {{ minutes.generated_by_ai ? "AI สร้างร่างแรก" : "แก้ไขโดยเลขานุการ" }}</span>
            <Separator orientation="vertical" class="h-5" />
            <div class="flex items-center gap-2 text-xs text-muted-foreground">
              <span class="flex items-center gap-1"><Sparkles class="w-3.5 h-3.5" /> AI ร่าง</span> →
              <span class="flex items-center gap-1"><Pencil class="w-3.5 h-3.5" /> เลขาตรวจแก้</span> →
              <span class="flex items-center gap-1"><Send class="w-3.5 h-3.5" /> ขออนุมัติ</span> →
              <span class="flex items-center gap-1"><CheckCircle2 class="w-3.5 h-3.5" /> ประธานอนุมัติ</span> →
              <span>เผยแพร่</span>
            </div>
          </template>
        </CardContent>
      </Card>

      <div v-if="!minutes && !loading" class="text-center py-16 border rounded-lg space-y-4">
        <FileText class="w-12 h-12 mx-auto opacity-30" />
        <p class="text-muted-foreground">ยังไม่มีรายงานการประชุม</p>
        <p class="text-sm text-muted-foreground -mt-3">AI จะสรุปจาก transcript เสียงประชุม สรุปเอกสารแต่ละวาระ และมติที่บันทึกระหว่างประชุม</p>
        <Button :disabled="generating" @click="generate()">
          <Loader2 v-if="generating" class="w-4 h-4 mr-1.5 animate-spin" />
          <Sparkles v-else class="w-4 h-4 mr-1.5" /> สั่ง AI สร้างร่างรายงาน
        </Button>
      </div>

      <Tabs v-if="minutes" default-value="report" class="w-full">
        <TabsList class="flex-wrap h-auto">
          <TabsTrigger value="report">ร่างรายงาน</TabsTrigger>
          <TabsTrigger value="decisions">มติ ({{ decisions.length }})</TabsTrigger>
          <TabsTrigger value="actions">งานที่มอบหมาย ({{ actionItems.length }})</TabsTrigger>
          <TabsTrigger value="attendance">การเข้าร่วม ({{ participants.length }})</TabsTrigger>
        </TabsList>

        <!-- ร่างรายงาน -->
        <TabsContent value="report" class="mt-4 space-y-4">
          <div v-if="content" class="space-y-4">
            <Card>
              <CardHeader class="pb-3">
                <CardTitle class="text-sm">สรุปภาพรวม</CardTitle>
              </CardHeader>
              <CardContent>
                <Textarea
                  v-model="content.general_summary" rows="3"
                  :disabled="isPublished || !canEdit"
                />
              </CardContent>
            </Card>
            <Card v-for="(section, i) in content.sections" :key="i">
              <CardHeader class="pb-3">
                <CardTitle class="text-sm">วาระที่ {{ section.agenda_no }}: {{ section.agenda_title }}</CardTitle>
              </CardHeader>
              <CardContent class="space-y-3">
                <div class="space-y-1">
                  <Label class="text-xs text-muted-foreground">การอภิปราย</Label>
                  <Textarea v-model="section.discussion" rows="4" :disabled="isPublished || !canEdit" />
                </div>
                <div class="space-y-1">
                  <Label class="text-xs text-muted-foreground">มติที่ประชุม</Label>
                  <Textarea v-model="section.decision" rows="2" :disabled="isPublished || !canEdit" class="border-primary/30" />
                </div>
              </CardContent>
            </Card>
            <Button v-if="!isPublished && canEdit" :disabled="savingContent" @click="saveContent()">
              <Loader2 v-if="savingContent" class="w-4 h-4 mr-1.5 animate-spin" /> บันทึกการแก้ไข
            </Button>
          </div>
        </TabsContent>

        <!-- มติ -->
        <TabsContent value="decisions" class="mt-4 space-y-3">
          <div v-if="decisions.length === 0" class="py-12 text-center text-muted-foreground text-sm border rounded-lg">
            ยังไม่มีมติ — บันทึกจากหน้า Live Meeting หรือรอ AI สกัดจาก transcript
          </div>
          <Card v-for="d in decisions" :key="d.id" :class="d.status === 'rejected' ? 'opacity-50' : ''">
            <CardContent class="p-4">
              <div class="flex items-start gap-3">
                <Badge :variant="d.status === 'confirmed' ? 'default' : d.status === 'rejected' ? 'destructive' : 'outline'" class="mt-0.5 shrink-0">
                  {{ d.status === "confirmed" ? "ยืนยันแล้ว" : d.status === "rejected" ? "ปฏิเสธ" : "รอตรวจสอบ" }}
                </Badge>
                <div class="flex-1 min-w-0">
                  <p class="text-sm">{{ d.decision_text }}</p>
                  <div class="flex items-center gap-2 mt-1.5 text-xs text-muted-foreground flex-wrap">
                    <Badge variant="secondary" class="text-[10px]">{{ decisionTypeLabel[d.decision_type] || d.decision_type }}</Badge>
                    <span v-if="d.source === 'ai_detected'" class="flex items-center gap-1"><AlertTriangle class="w-3 h-3" /> AI สกัด — ต้องยืนยันก่อนเผยแพร่</span>
                    <span v-else>เลขานุการบันทึก</span>
                    <span>{{ dayjs(d.created_at).format("D MMM HH:mm") }}</span>
                  </div>
                </div>
                <div v-if="!isPublished" class="flex gap-1 shrink-0">
                  <Button v-if="d.status !== 'confirmed'" variant="ghost" size="icon" class="h-8 w-8 text-emerald-600" title="ยืนยันมติ" @click="reviewDecision(d, 'confirmed')">
                    <CheckCircle2 class="w-4 h-4" />
                  </Button>
                  <Button v-if="d.status !== 'rejected'" variant="ghost" size="icon" class="h-8 w-8 text-destructive" title="ปฏิเสธ" @click="reviewDecision(d, 'rejected')">
                    <XCircle class="w-4 h-4" />
                  </Button>
                  <Button variant="ghost" size="icon" class="h-8 w-8" @click="deleteDecision(d)"><Trash2 class="w-4 h-4" /></Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <!-- งาน -->
        <TabsContent value="actions" class="mt-4 space-y-3">
          <div class="flex justify-end">
            <Button size="sm" @click="openAction()"><Plus class="w-4 h-4 mr-1.5" /> เพิ่มงาน</Button>
          </div>
          <div v-if="actionItems.length === 0" class="py-12 text-center text-muted-foreground text-sm border rounded-lg">
            ไม่มีงานที่มอบหมาย
          </div>
          <Card v-for="item in actionItems" :key="item.id">
            <CardContent class="p-4 flex items-center gap-3 flex-wrap">
              <div class="flex-1 min-w-0">
                <div class="font-medium text-sm flex items-center gap-2">
                  {{ item.title }}
                  <Badge variant="outline" class="text-[10px]">{{ actionStatusLabels[item.status] }}</Badge>
                </div>
                <div class="text-xs text-muted-foreground mt-1 flex items-center gap-3 flex-wrap">
                  <span>ผู้รับผิดชอบ: {{ users.find(u => u.id === item.assignee_id)?.name || item.assignee_text || "รอยืนยัน" }}</span>
                  <span v-if="item.due_date" class="flex items-center gap-1" :class="dayjs(item.due_date).isBefore(dayjs(), 'day') && item.status !== 'done' ? 'text-destructive font-medium' : ''">
                    <Clock3 class="w-3 h-3" /> กำหนดส่ง {{ dayjs(item.due_date).format("D MMM BBBB") }}
                  </span>
                </div>
              </div>
              <div class="flex gap-2 shrink-0">
                <Select
                  :model-value="item.status"
                  @update:model-value="updateActionStatus(item, String($event))"
                >
                  <SelectTrigger class="h-8 w-40"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pending">รอดำเนินการ</SelectItem>
                    <SelectItem value="in_progress">กำลังดำเนินการ</SelectItem>
                    <SelectItem value="done">เสร็จสิ้น</SelectItem>
                    <SelectItem value="cancelled">ยกเลิก</SelectItem>
                  </SelectContent>
                </Select>
                <Button variant="ghost" size="icon" class="h-8 w-8 text-destructive" @click="deleteAction(item)">
                  <Trash2 class="w-4 h-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <!-- การเข้าร่วม -->
        <TabsContent value="attendance" class="mt-4">
          <Card>
            <CardContent class="p-4 space-y-3">
              <div v-for="p in participants" :key="p.id" class="flex items-center gap-3 text-sm">
                <div class="h-8 w-8 rounded-full bg-muted flex items-center justify-center text-xs font-bold">{{ (p.name || "?").slice(0, 2) }}</div>
                <span class="flex-1">{{ p.name || p.username }}</span>
                <Badge variant="outline">{{ roleInMeetingLabel[p.role_in_meeting] }}</Badge>
                <Select
                  :model-value="attendanceForm[p.user_id] || 'present'"
                  @update:model-value="attendanceForm[p.user_id] = String($event)"
                >
                  <SelectTrigger class="h-8 w-36"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="present">เข้าร่วม</SelectItem>
                    <SelectItem value="absent">ไม่เข้าร่วม</SelectItem>
                    <SelectItem value="leave">ลา</SelectItem>
                    <SelectItem value="proxy">มอบอำนาจ</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button size="sm" @click="saveAttendance()"><Users class="w-4 h-4 mr-1.5" /> บันทึกการเข้าร่วม</Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </template>

    <!-- Dialog เพิ่มงาน -->
    <Dialog :open="actionOpen" @update:open="actionOpen = $event">
      <DialogContent>
        <DialogHeader><DialogTitle>เพิ่มงานที่มอบหมาย</DialogTitle></DialogHeader>
        <div class="space-y-3">
          <div class="space-y-1.5"><Label>ชื่องาน *</Label><Input v-model="actionForm.title" /></div>
          <div class="grid grid-cols-2 gap-3">
            <div class="space-y-1.5">
              <Label>ผู้รับผิดชอบ</Label>
              <Select :model-value="actionForm.assigneeId" @update:model-value="actionForm.assigneeId = String($event)">
                <SelectTrigger><SelectValue placeholder="เลือกจากระบบ" /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="u in users" :key="u.id" :value="String(u.id)">{{ u.name || u.username }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="space-y-1.5">
              <Label>หรือระบุหน่วยงาน</Label>
              <Input v-model="actionForm.assigneeText" placeholder="เช่น กลุ่มงานเทคโนโลยีสารสนเทศ" />
            </div>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div class="space-y-1.5"><Label>กำหนดส่ง</Label><Input type="date" v-model="actionForm.dueDate" /></div>
            <div class="space-y-1.5">
              <Label>ความสำคัญ</Label>
              <Select :model-value="actionForm.priority" @update:model-value="actionForm.priority = String($event)">
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">ต่ำ</SelectItem>
                  <SelectItem value="normal">ปกติ</SelectItem>
                  <SelectItem value="high">สูง</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div class="space-y-1.5"><Label>รายละเอียด</Label><Textarea v-model="actionForm.detail" rows="2" /></div>
        </div>
        <DialogFooter><Button @click="saveAction()">บันทึกงาน</Button></DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Dialog อนุมัติ -->
    <Dialog :open="approvalOpen" @update:open="approvalOpen = $event">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{{ approveForm.approved ? "อนุมัติและเผยแพร่รายงาน" : "ส่งกลับให้แก้ไข" }}</DialogTitle>
        </DialogHeader>
        <div class="space-y-3">
          <p v-if="approveForm.approved" class="text-sm text-muted-foreground">
            เมื่อเผยแพร่: ผู้เข้าร่วมได้รับแจ้งเตือน ผู้รับผิดชอบงานได้รับการแจ้งเตือนงาน และรายงานจะแก้ไขไม่ได้อีก
          </p>
          <div class="space-y-1.5">
            <Label>ความเห็นประกอบ</Label>
            <Textarea v-model="approveForm.comment" rows="3" placeholder="ไม่บังคับ" />
          </div>
        </div>
        <DialogFooter>
          <Button
            :variant="approveForm.approved ? 'default' : 'destructive'"
            @click="submitApproval()"
          >
            {{ approveForm.approved ? "ยืนยันการเผยแพร่" : "ส่งกลับ" }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
