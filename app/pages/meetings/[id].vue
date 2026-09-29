<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { toast } from "vue-sonner";
import { useMeetingApi } from "@/composables/useMeetingApi";
import {
  dayjs, fmtDateTime, meetingStatusLabel, agendaTypeLabel, agendaStatusLabel,
  analysisStatusLabel, roleInMeetingLabel,
} from "@/utils/meeting-format";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  CalendarDays, Users, MapPin, Mic2, FileText, Plus, Trash2, Pencil, ArrowUp, ArrowDown,
  Paperclip, Sparkles, FileText as FileIcon, RefreshCw, Loader2, BookOpen, Link2, X, Search, ScanText,
} from "lucide-vue-next";

const route = useRoute();
const meetingId = route.params.id as string;
useSeoMeta({ title: "Meeting Workspace | AI Smart Meeting" });

const { api, call, upload } = useMeetingApi();
const loading = ref(true);
const detail = ref<any>(null);
const users = ref<any[]>([]);
const briefing = ref<any>(null);
const briefingJobId = ref<string | null>(null);
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function load() {
  const data = await call(() => api.meetings[meetingId].get(), { silent: true });
  if (data) {
    detail.value = data;
    // preload summaries
    for (const a of data.agendas) {
      await loadSummary(a);
    }
  }
  loading.value = false;
}

async function loadUsers() {
  const u = await call(() => api.users.get(), { silent: true });
  if (u) users.value = Array.isArray(u) ? u : (u as any).users ?? [];
}

async function loadSummary(agenda: any) {
  const s = await call(() => api.meetings.agendas[agenda.id].get(), { silent: true });
  if (s) {
    agenda._summary = (s as any).summary;
    agenda._documents = (s as any).documents;
    agenda._presenter = (s as any).presenter;
  }
}

async function loadBriefing() {
  const b = await call(() => api.meetings[meetingId].briefing.get(), { silent: true });
  if (b) briefing.value = b;
}

onMounted(async () => {
  await Promise.all([load(), loadUsers(), loadBriefing()]);
  startPolling();
});
onUnmounted(() => stopPolling());

// poll สถานะการวิเคราะห์เอกสาร / briefing job
function needsPolling() {
  const docs = detail.value?.documents ?? [];
  const docBusy = docs.some((d: any) => ["pending", "processing"].includes(d.analysis_status));
  const briefBusy = briefingJobId.value && !briefing.value?.briefing;
  return docBusy || briefBusy;
}
function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    if (!needsPolling()) return;
    await load();
    await loadBriefing();
  }, 3000);
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

const meeting = computed(() => detail.value?.meeting);
const agendas = computed(() => detail.value?.agendas ?? []);
const documents = computed(() => detail.value?.documents ?? []);

const canManage = computed(() => {
  const user = (useNuxtApp().$api as any) && null; // placeholder
  return true; // ปล่อยให้ backend ตรวจสิทธิ์ แล้วแสดงปุ่มตาม role คร่าว ๆ
});

/* ---------- วาระ ---------- */
const agendaOpen = ref(false);
const agendaSaving = ref(false);
const agendaForm = ref({
  id: "", title: "", description: "", agendaType: "consideration",
  presenterId: "", durationMinutes: 15,
});

function openAgenda(agenda?: any) {
  agendaForm.value = {
    id: agenda?.id || "",
    title: agenda?.title || "",
    description: agenda?.description || "",
    agendaType: agenda?.agenda_type || "consideration",
    presenterId: agenda?.presenter_id ? String(agenda.presenter_id) : "",
    durationMinutes: agenda?.duration_minutes || 15,
  };
  agendaOpen.value = true;
}

async function saveAgenda() {
  if (!agendaForm.value.title.trim()) {
    toast.error("กรุณากรอกชื่อวาระ");
    return;
  }
  agendaSaving.value = true;
  const payload = {
    title: agendaForm.value.title,
    description: agendaForm.value.description || undefined,
    agendaType: agendaForm.value.agendaType,
    presenterId: agendaForm.value.presenterId ? Number(agendaForm.value.presenterId) : undefined,
    durationMinutes: agendaForm.value.durationMinutes,
  };
  const result = agendaForm.value.id
    ? await call(() => api.meetings.agendas[agendaForm.value.id].put(payload))
    : await call(() => api.meetings[meetingId].agendas.post(payload));
  agendaSaving.value = false;
  if (result) {
    toast.success(agendaForm.value.id ? "แก้ไขวาระแล้ว" : "เพิ่มวาระแล้ว");
    agendaOpen.value = false;
    await load();
  }
}

async function deleteAgenda(agenda: any) {
  const data = await call(() => api.meetings.agendas[agenda.id].delete());
  if (data) {
    toast.success("ลบวาระแล้ว");
    await load();
  }
}

async function moveAgenda(agenda: any, dir: -1 | 1) {
  const list = [...agendas.value];
  const idx = list.findIndex((a) => a.id === agenda.id);
  const target = idx + dir;
  if (target < 0 || target >= list.length) return;
  const order = [
    { agendaId: list[idx].id, sequenceNo: list[target].sequence_no },
    { agendaId: list[target].id, sequenceNo: list[idx].sequence_no },
  ];
  await call(() => api.meetings[meetingId].agendas.reorder.post({ order }), { silent: true });
  await load();
}

/* ---------- เอกสาร ---------- */
const uploadingAgendaId = ref<string | null>(null);

async function onUpload(event: Event, agenda: any) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    toast.error("รองรับเฉพาะไฟล์ PDF สำหรับเอกสารวาระ");
    input.value = "";
    return;
  }
  uploadingAgendaId.value = agenda.id;
  const headers: Record<string, string> = {};
  if (agenda.id) headers["x-agenda-id"] = agenda.id;
  const result = await upload(`/api/meetings/${meetingId}/documents`, file, headers);
  uploadingAgendaId.value = null;
  input.value = "";
  if (result) {
    toast.success(result.analysisJobId ? "อัปโหลดแล้ว — AI กำลังสรุปเอกสาร" : "อัปโหลดแล้ว (ไฟล์นี้ไม่ได้สั่งวิเคราะห์อัตโนมัติ)");
    await load();
    startPolling();
  }
}

async function analyzeDoc(doc: any) {
  const data = await call(() => api.meetings.documents[doc.id].analyze.post({}));
  if (data) {
    toast.success("สั่งวิเคราะห์เอกสารด้วย AI แล้ว");
    await load();
    startPolling();
  }
}

async function deleteDoc(doc: any) {
  const data = await call(() => api.meetings.documents[doc.id].delete());
  if (data) {
    toast.success("ลบเอกสารแล้ว");
    await load();
  }
}

/* ---------- ค้นหาเอกสารเชิงความหมาย ---------- */
const searchQuery = ref("");
const searchResults = ref<any[]>([]);
const searchMode = ref<string>("");
const searching = ref(false);

async function runSearch() {
  if (!searchQuery.value.trim()) return;
  searching.value = true;
  searchResults.value = [];
  const data = await call(() =>
    api.search.post({ query: searchQuery.value, meetingId, topK: 12 }),
  );
  if (data) {
    searchResults.value = (data as any).results ?? [];
    searchMode.value = (data as any).mode ?? "";
    if (!searchResults.value.length) toast.info("ไม่พบเนื้อหาที่ตรงกับคำค้น");
  }
  searching.value = false;
}

/* ---------- Briefing ---------- */
const briefingLoading = ref(false);
async function generateBriefing() {
  briefingLoading.value = true;
  const data = await call(() => api.meetings[meetingId].briefing.post({}));
  briefingLoading.value = false;
  if (data) {
    briefingJobId.value = (data as any).jobId;
    toast.success("กำลังสร้าง Briefing — จะพร้อมในไม่กี่วินาที");
    startPolling();
    setTimeout(loadBriefing, 3000);
  }
}

const docsOfAgenda = (agendaId: string | null) =>
  documents.value.filter((d: any) => (d.agenda_id || null) === agendaId);

function parseJsonField(value: unknown): any[] {
  if (!value) return [];
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const statusVariant = (s: string) =>
  s === "in_progress" ? "destructive" : s === "completed" ? "secondary" : "outline";
</script>

<template>
  <div class="space-y-6">
    <div v-if="loading" class="space-y-4">
      <Skeleton class="h-28 w-full" />
      <Skeleton class="h-96 w-full" />
    </div>

    <template v-else-if="meeting">
      <!-- หัวการประชุม -->
      <Card>
        <CardContent class="p-5">
          <div class="flex items-start justify-between gap-4 flex-wrap">
            <div class="min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <h1 class="text-2xl font-bold tracking-tight">{{ meeting.title }}</h1>
                <Badge :variant="statusVariant(meeting.status) as any">{{ meetingStatusLabel[meeting.status] }}</Badge>
              </div>
              <div class="flex items-center gap-4 text-sm text-muted-foreground mt-2 flex-wrap">
                <span class="flex items-center gap-1.5"><CalendarDays class="w-4 h-4" /> {{ fmtDateTime(meeting.start_time) }} – {{ dayjs(meeting.end_time).format("HH:mm") }}</span>
                <span class="flex items-center gap-1.5"><MapPin class="w-4 h-4" /> {{ meeting.location_text || "ไม่ระบุสถานที่" }}</span>
                <span class="flex items-center gap-1.5"><Users class="w-4 h-4" /> ประธาน: {{ detail.organizer?.name || "-" }}</span>
                <span v-if="detail.secretary" class="flex items-center gap-1.5"><FileText class="w-4 h-4" /> เลขา: {{ detail.secretary.name }}</span>
              </div>
              <p v-if="meeting.description" class="text-sm text-muted-foreground mt-2">{{ meeting.description }}</p>
            </div>
            <div class="flex gap-2 shrink-0">
              <Button
                v-if="meeting.status !== 'completed'"
                variant="default"
                @click="navigateTo(`/meetings/${meetingId}/live`)"
              >
                <Mic2 class="w-4 h-4 mr-1.5" /> เริ่มประชุม / บันทึกเสียง
              </Button>
              <Button variant="outline" @click="navigateTo(`/meetings/${meetingId}/minutes`)">
                <FileText class="w-4 h-4 mr-1.5" /> รายงานการประชุม
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Tabs default-value="agendas" class="w-full">
        <TabsList>
          <TabsTrigger value="agendas">วาระและเอกสาร ({{ agendas.length }})</TabsTrigger>
          <TabsTrigger value="briefing">Briefing AI</TabsTrigger>
          <TabsTrigger value="search">ค้นหาเอกสาร</TabsTrigger>
          <TabsTrigger value="overview">ภาพรวม</TabsTrigger>
        </TabsList>

        <!-- วาระและเอกสาร -->
        <TabsContent value="agendas" class="space-y-4 mt-4">
          <div class="flex justify-between items-center">
            <p class="text-sm text-muted-foreground">
              แนบ PDF แยกตามวาระ — AI จะสรุปสาระสำคัญพร้อมเลขหน้าอ้างอิงอัตโนมัติ
            </p>
            <Button size="sm" @click="openAgenda()"><Plus class="w-4 h-4 mr-1.5" /> เพิ่มวาระ</Button>
          </div>

          <div v-if="agendas.length === 0" class="text-center py-12 text-muted-foreground border rounded-lg">
            <BookOpen class="w-10 h-10 mx-auto mb-2 opacity-30" />
            ยังไม่มีวาระ — เพิ่มวาระแรกของการประชุมนี้
          </div>

          <Card v-for="(agenda, i) in agendas" :key="agenda.id" class="overflow-hidden">
            <!-- หัววาระ -->
            <div class="p-4 flex items-start gap-3 bg-muted/30">
              <div class="h-10 w-10 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold shrink-0">
                {{ agenda.sequence_no }}
              </div>
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="font-semibold">{{ agenda.title }}</span>
                  <Badge variant="outline">{{ agendaTypeLabel[agenda.agenda_type] }}</Badge>
                  <Badge v-if="agenda.status === 'presenting'" variant="destructive">กำลังนำเสนอ</Badge>
                  <Badge v-else-if="agenda.status === 'done'" variant="secondary">เสร็จแล้ว</Badge>
                </div>
                <div class="text-xs text-muted-foreground mt-1 flex items-center gap-3 flex-wrap">
                  <span v-if="agenda._presenter">ผู้นำเสนอ: {{ agenda._presenter.name }}</span>
                  <span v-if="agenda.duration_minutes">⏱ {{ agenda.duration_minutes }} นาที</span>
                </div>
                <p v-if="agenda.description" class="text-sm text-muted-foreground mt-1">{{ agenda.description }}</p>
              </div>
              <div class="flex gap-1 shrink-0">
                <Button variant="ghost" size="icon" class="h-8 w-8" :disabled="i === 0" @click="moveAgenda(agenda, -1)"><ArrowUp class="w-4 h-4" /></Button>
                <Button variant="ghost" size="icon" class="h-8 w-8" :disabled="i === agendas.length - 1" @click="moveAgenda(agenda, 1)"><ArrowDown class="w-4 h-4" /></Button>
                <Button variant="ghost" size="icon" class="h-8 w-8" @click="openAgenda(agenda)"><Pencil class="w-4 h-4" /></Button>
                <Button variant="ghost" size="icon" class="h-8 w-8 text-destructive" @click="deleteAgenda(agenda)"><Trash2 class="w-4 h-4" /></Button>
              </div>
            </div>

            <CardContent class="p-4 space-y-4">
              <!-- เอกสารของวาระ -->
              <div class="space-y-2">
                <div class="flex items-center justify-between">
                  <span class="text-sm font-medium flex items-center gap-1.5"><Paperclip class="w-4 h-4" /> เอกสารประกอบ</span>
                  <label class="cursor-pointer">
                    <input type="file" accept=".pdf" class="hidden" :disabled="uploadingAgendaId === agenda.id" @change="onUpload($event, agenda)" />
                    <span class="inline-flex items-center gap-1.5 text-sm text-primary hover:underline">
                      <Loader2 v-if="uploadingAgendaId === agenda.id" class="w-3.5 h-3.5 animate-spin" />
                      <Plus v-else class="w-3.5 h-3.5" />
                      แนบ PDF
                    </span>
                  </label>
                </div>
                <div v-if="docsOfAgenda(agenda.id).length === 0" class="text-xs text-muted-foreground pl-6">
                  ยังไม่มีเอกสาร — แนบ PDF เพื่อให้ AI สรุปก่อนประชุม
                </div>
                <div
                  v-for="doc in docsOfAgenda(agenda.id)"
                  :key="doc.id"
                  class="flex items-center gap-3 p-2.5 rounded-lg border text-sm"
                >
                  <FileIcon class="w-4 h-4 text-red-500 shrink-0" />
                  <a :href="`/api/meetings/documents/${doc.id}/download`" target="_blank" class="flex-1 truncate hover:underline" :title="doc.file_name">
                    {{ doc.file_name }}
                  </a>
                  <Badge variant="secondary" class="text-[11px]">v{{ doc.file_version }}</Badge>
                  <Badge v-if="doc.ocr_used" variant="outline" class="text-[11px]" title="สกัดข้อความด้วย OCR">
                    <ScanText class="w-3 h-3 mr-1" /> OCR
                  </Badge>
                  <Badge
                    :variant="doc.analysis_status === 'completed' ? 'default' : doc.analysis_status === 'failed' ? 'destructive' : 'outline'"
                    class="text-[11px]"
                  >
                    <Loader2 v-if="['pending', 'processing'].includes(doc.analysis_status)" class="w-3 h-3 mr-1 animate-spin" />
                    {{ analysisStatusLabel[doc.analysis_status] || doc.analysis_status }}
                  </Badge>
                  <Button
                    v-if="doc.analysis_status !== 'processing'"
                    variant="ghost" size="icon" class="h-7 w-7"
                    :title="'วิเคราะห์ด้วย AI อีกครั้ง'"
                    @click="analyzeDoc(doc)"
                  >
                    <RefreshCw class="w-3.5 h-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" class="h-7 w-7 text-destructive" @click="deleteDoc(doc)"><X class="w-3.5 h-3.5" /></Button>
                </div>
              </div>

              <!-- สรุป AI ของวาระ -->
              <div v-if="agenda._summary" class="rounded-lg border border-primary/25 bg-primary/5 p-4 space-y-3">
                <div class="flex items-center justify-between">
                  <span class="text-sm font-semibold flex items-center gap-1.5">
                    <Sparkles class="w-4 h-4 text-primary" /> AI สรุปเอกสารประกอบวาระ
                  </span>
                  <span class="text-[11px] text-muted-foreground">
                    {{ agenda._summary.model === "heuristic" ? "โหมด offline" : agenda._summary.model }}
                    · {{ dayjs(agenda._summary.generated_at).format("D MMM HH:mm") }}
                  </span>
                </div>
                <p class="text-sm leading-relaxed">{{ agenda._summary.summary }}</p>

                <div v-if="parseJsonField(agenda._summary.key_points).length" class="grid md:grid-cols-2 gap-3">
                  <div class="rounded-md bg-background/60 p-3">
                    <div class="text-xs font-semibold text-muted-foreground mb-1.5">ประเด็นสำคัญจากเอกสาร</div>
                    <ul class="text-sm space-y-1">
                      <li v-for="(k, j) in parseJsonField(agenda._summary.key_points)" :key="j" class="flex gap-1.5">
                        <span class="text-primary">•</span> {{ k }}
                      </li>
                    </ul>
                  </div>
                  <div class="space-y-3">
                    <div v-if="parseJsonField(agenda._summary.considerations).length" class="rounded-md bg-background/60 p-3">
                      <div class="text-xs font-semibold text-muted-foreground mb-1.5">ประเด็นที่ต้องพิจารณา</div>
                      <ul class="text-sm space-y-1">
                        <li v-for="(k, j) in parseJsonField(agenda._summary.considerations)" :key="j" class="flex gap-1.5">
                          <span class="text-amber-500">◆</span> {{ k }}
                        </li>
                      </ul>
                    </div>
                    <div v-if="parseJsonField(agenda._summary.questions).length" class="rounded-md bg-background/60 p-3">
                      <div class="text-xs font-semibold text-muted-foreground mb-1.5">คำถามที่ควรพิจารณาในที่ประชุม</div>
                      <ul class="text-sm space-y-1">
                        <li v-for="(q, j) in parseJsonField(agenda._summary.questions)" :key="j" class="flex gap-1.5">
                          <span class="text-blue-500">?</span> {{ q }}
                        </li>
                      </ul>
                    </div>
                  </div>
                </div>

                <div v-if="parseJsonField(agenda._summary.key_numbers).length" class="rounded-md bg-background/60 p-3">
                  <div class="text-xs font-semibold text-muted-foreground mb-1.5">ตัวเลข/ข้อเสนอสำคัญ</div>
                  <div class="flex flex-wrap gap-1.5">
                    <Badge v-for="(n, j) in parseJsonField(agenda._summary.key_numbers)" :key="j" variant="outline" class="font-normal">{{ n }}</Badge>
                  </div>
                </div>

                <div v-if="parseJsonField(agenda._summary.page_references).length" class="flex items-center gap-2 flex-wrap">
                  <span class="text-xs font-semibold text-muted-foreground flex items-center gap-1"><Link2 class="w-3.5 h-3.5" /> อ้างอิง:</span>
                  <Badge
                    v-for="(ref, j) in parseJsonField(agenda._summary.page_references)"
                    :key="j" variant="secondary" class="text-[11px]"
                  >
                    หน้า {{ ref.page }}
                  </Badge>
                </div>
              </div>
            </CardContent>
          </Card>

          <!-- เอกสารระดับการประชุม (ไม่ผูกวาระ) -->
          <Card v-if="docsOfAgenda(null).length > 0">
            <CardHeader class="py-3"><CardTitle class="text-sm">เอกสารอื่น ๆ ของการประชุม (ไม่ผูกกับวาระใด)</CardTitle></CardHeader>
            <CardContent class="pt-0 space-y-2">
              <div v-for="doc in docsOfAgenda(null)" :key="doc.id" class="flex items-center gap-3 p-2.5 rounded-lg border text-sm">
                <FileIcon class="w-4 h-4 text-red-500" />
                <a :href="`/api/meetings/documents/${doc.id}/download`" target="_blank" class="flex-1 truncate hover:underline">{{ doc.file_name }}</a>
                <Badge variant="outline" class="text-[11px]">{{ analysisStatusLabel[doc.analysis_status] }}</Badge>
                <Button variant="ghost" size="icon" class="h-7 w-7 text-destructive" @click="deleteDoc(doc)"><X class="w-3.5 h-3.5" /></Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <!-- Briefing -->
        <TabsContent value="briefing" class="mt-4">
          <Card>
            <CardHeader class="flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle class="text-base flex items-center gap-2"><BookOpen class="w-4 h-4" /> Briefing ก่อนประชุม</CardTitle>
                <CardDescription>สรุปรวมทุกวาระเป็นเอกสารเดียวสำหรับผู้เข้าร่วมอ่านล่วงหน้า</CardDescription>
              </div>
              <Button size="sm" :disabled="briefingLoading" @click="generateBriefing">
                <Loader2 v-if="briefingLoading" class="w-4 h-4 mr-1.5 animate-spin" />
                <Sparkles v-else class="w-4 h-4 mr-1.5" />
                {{ briefing?.briefing ? "สร้างใหม่" : "สร้าง Briefing" }}
              </Button>
            </CardHeader>
            <CardContent>
              <div v-if="!briefing?.briefing" class="py-12 text-center text-muted-foreground text-sm">
                ยังไม่มี Briefing — กด "สร้าง Briefing" เพื่อรวมสรุป AI ทุกวาระ
              </div>
              <ScrollArea v-else class="max-h-[70vh]">
                <div class="prose prose-sm max-w-none whitespace-pre-wrap text-sm leading-relaxed" v-text="briefing.briefing.markdown" />
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>

        <!-- ค้นหาเอกสารเชิงความหมาย -->
        <TabsContent value="search" class="mt-4">
          <Card>
            <CardHeader class="pb-3">
              <CardTitle class="text-base flex items-center gap-2"><Search class="w-4 h-4" /> ค้นหาในเอกสารของการประชุมนี้</CardTitle>
              <CardDescription>
                ค้นหาตามความหมาย (AI) เมื่อระบบมี embedding — มิฉะนั้นค้นแบบคำตรงกัน
                ผลลัพธ์ชี้เลขหน้าของเอกสารต้นฉบับเพื่อยืนยันความถูกต้องได้
              </CardDescription>
            </CardHeader>
            <CardContent class="space-y-4">
              <form class="flex gap-2" @submit.prevent="runSearch">
                <Input v-model="searchQuery" placeholder="เช่น งบประมาณ โครงการ, ความเสี่ยงข้อมูลผู้ป่วย..." />
                <Button type="submit" :disabled="searching">
                  <Loader2 v-if="searching" class="w-4 h-4 mr-1.5 animate-spin" />
                  <Search v-else class="w-4 h-4 mr-1.5" /> ค้นหา
                </Button>
              </form>
              <div v-if="searchResults.length" class="space-y-2">
                <div class="text-xs text-muted-foreground">
                  โหมด: {{ searchMode === "vector" ? "เชิงความหมาย (embedding)" : "คำตรงกัน (keyword)" }} · {{ searchResults.length }} ผลลัพธ์
                </div>
                <div
                  v-for="r in searchResults"
                  :key="r.id"
                  class="p-3 rounded-lg border text-sm space-y-1.5 hover:bg-muted/40"
                >
                  <div class="flex items-center gap-2 flex-wrap">
                    <Badge variant="secondary" class="text-[11px]">{{ (r.score * 100).toFixed(0) }}%</Badge>
                    <FileIcon class="w-3.5 h-3.5 text-red-500" />
                    <span class="font-medium">{{ r.file_name }}</span>
                    <Badge v-if="r.page_no" variant="outline" class="text-[11px]">หน้า {{ r.page_no }}</Badge>
                    <Badge v-if="r.ocr_used" variant="outline" class="text-[11px]"><ScanText class="w-3 h-3 mr-1" />OCR</Badge>
                    <span v-if="r.agenda_title" class="text-xs text-muted-foreground">วาระที่ {{ r.agenda_no }}: {{ r.agenda_title }}</span>
                    <Button variant="ghost" size="sm" class="ml-auto h-7" @click="navigateTo(`/meetings/${meetingId}`)">เปิดเอกสาร</Button>
                  </div>
                  <p class="text-muted-foreground">{{ r.snippet }}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <!-- ภาพรวม -->
        <TabsContent value="overview" class="mt-4 grid lg:grid-cols-2 gap-4">
          <Card>
            <CardHeader><CardTitle class="text-base">ผู้เข้าร่วม ({{ detail.participants.length }})</CardTitle></CardHeader>
            <CardContent>
              <div class="space-y-2">
                <div v-for="p in detail.participants" :key="p.id" class="flex items-center gap-3 text-sm">
                  <div class="h-8 w-8 rounded-full bg-muted flex items-center justify-center text-xs font-bold">{{ (p.name || "?").slice(0, 2) }}</div>
                  <span class="flex-1">{{ p.name || p.username }}</span>
                  <Badge variant="outline">{{ roleInMeetingLabel[p.role_in_meeting] || p.role_in_meeting }}</Badge>
                  <Badge variant="secondary" class="text-[11px]">{{ p.invite_status === "accepted" ? "ยืนยันแล้ว" : "เชิญแล้ว" }}</Badge>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle class="text-base">การจองห้อง</CardTitle></CardHeader>
            <CardContent>
              <div v-if="detail.bookings.length === 0" class="text-sm text-muted-foreground">ไม่มีการจองห้อง (จองได้ที่หน้า "จองห้องประชุม")</div>
              <div v-for="b in detail.bookings" :key="b.id" class="p-2.5 rounded-lg border text-sm space-y-1">
                <div class="flex items-center gap-3">
                  <MapPin class="w-4 h-4 text-primary" />
                  <span class="flex-1">{{ b.room_name }}</span>
                  <span class="text-muted-foreground">{{ dayjs(b.start_time).format("D MMM HH:mm") }}–{{ dayjs(b.end_time).format("HH:mm") }}</span>
                </div>
                <p v-if="b.special_requests" class="text-xs text-amber-700 dark:text-amber-300 flex items-start gap-1.5 ml-7">
                  <span class="font-medium shrink-0">ความต้องการพิเศษ:</span>
                  <span>{{ b.special_requests }}</span>
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </template>

    <!-- Dialog วาระ -->
    <Dialog :open="agendaOpen" @update:open="agendaOpen = $event">
      <DialogContent>
        <DialogHeader><DialogTitle>{{ agendaForm.id ? "แก้ไขวาระ" : "เพิ่มวาระ" }}</DialogTitle></DialogHeader>
        <div class="space-y-3">
          <div class="space-y-1.5">
            <Label>ชื่อวาระ *</Label>
            <Input v-model="agendaForm.title" placeholder="เช่น เพื่อพิจารณาแผนพัฒนาระบบสารสนเทศ" />
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div class="space-y-1.5">
              <Label>ประเภทวาระ</Label>
              <Select :model-value="agendaForm.agendaType" @update:model-value="agendaForm.agendaType = String($event)">
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="information">เรื่องแจ้งเพื่อทราบ</SelectItem>
                  <SelectItem value="approval">เพื่อรับรอง/เห็นชอบ</SelectItem>
                  <SelectItem value="follow_up">เรื่องสืบเนื่อง</SelectItem>
                  <SelectItem value="consideration">เสนอเพื่อพิจารณา</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="space-y-1.5">
              <Label>เวลาที่ใช้ (นาที)</Label>
              <Input type="number" v-model.number="agendaForm.durationMinutes" min="1" />
            </div>
          </div>
          <div class="space-y-1.5">
            <Label>ผู้นำเสนอ</Label>
            <Select :model-value="agendaForm.presenterId" @update:model-value="agendaForm.presenterId = String($event)">
              <SelectTrigger><SelectValue placeholder="ไม่ระบุ" /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="u in users" :key="u.id" :value="String(u.id)">{{ u.name || u.username }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="space-y-1.5">
            <Label>รายละเอียด</Label>
            <Textarea v-model="agendaForm.description" rows="2" />
          </div>
        </div>
        <DialogFooter>
          <Button :disabled="agendaSaving" @click="saveAgenda">
            <Loader2 v-if="agendaSaving" class="w-4 h-4 mr-1.5 animate-spin" /> บันทึก
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
