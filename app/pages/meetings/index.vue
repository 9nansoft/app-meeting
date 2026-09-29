<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { toast } from "vue-sonner";
import { useMeetingApi } from "@/composables/useMeetingApi";
import { dayjs, fmtDateTime, meetingStatusLabel } from "@/utils/meeting-format";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ClipboardList, Plus, Search, Loader2, MapPin, Users, Mic2, FileText, ArrowRight, UtensilsCrossed } from "lucide-vue-next";

useSeoMeta({ title: "การประชุม | AI Smart Meeting" });

const { api, call } = useMeetingApi();
const loading = ref(true);
const meetings = ref<any[]>([]);
const users = ref<any[]>([]);
const rooms = ref<any[]>([]);
const search = ref("");
const statusTab = ref("all");

async function load() {
  loading.value = true;
  const [m, u, r] = await Promise.all([
    call(() => api.meetings.get({ query: { limit: 200 } }), { silent: true }),
    call(() => api.users.get(), { silent: true }),
    call(() => api.rooms.get(), { silent: true }),
  ]);
  if (m) meetings.value = (m as any).meetings ?? [];
  if (u) users.value = Array.isArray(u) ? u : (u as any).users ?? [];
  if (r) rooms.value = (r as any).rooms ?? [];
  loading.value = false;
}
onMounted(load);

const filtered = computed(() =>
  meetings.value.filter((mtg) => {
    if (statusTab.value === "upcoming") {
      return !["completed", "cancelled"].includes(mtg.status);
    }
    if (statusTab.value === "completed") return mtg.status === "completed";
    if (statusTab.value === "cancelled") return mtg.status === "cancelled";
    return true;
  }).filter((mtg) => !search.value || mtg.title.includes(search.value)),
);

/* ---------- สร้างการประชุม ---------- */
const createOpen = ref(false);
const saving = ref(false);
const form = ref({
  title: "",
  description: "",
  meetingType: "regular",
  secretaryId: "" as string,
  date: dayjs().add(1, "day").format("YYYY-MM-DD"),
  start: "09:00",
  end: "11:00",
  roomId: "" as string,
  specialRequests: "" as string,
  participantIds: [] as number[],
});

function toggleParticipant(id: number) {
  const i = form.value.participantIds.indexOf(id);
  if (i >= 0) form.value.participantIds.splice(i, 1);
  else form.value.participantIds.push(id);
}

async function save() {
  if (!form.value.title.trim()) {
    toast.error("กรุณากรอกชื่อการประชุม");
    return;
  }
  saving.value = true;
  const data = await call(() =>
    api.meetings.post({
      title: form.value.title,
      description: form.value.description || undefined,
      meetingType: form.value.meetingType,
      startTime: dayjs(`${form.value.date}T${form.value.start}`).toISOString(),
      endTime: dayjs(`${form.value.date}T${form.value.end}`).toISOString(),
      secretaryId: form.value.secretaryId ? Number(form.value.secretaryId) : undefined,
      roomId: form.value.roomId || undefined,
      specialRequests: form.value.specialRequests || undefined,
      participantIds: form.value.participantIds,
    }),
  );
  saving.value = false;
  if (data) {
    toast.success("สร้างการประชุมแล้ว — ขั้นต่อไป: เพิ่มวาระและแนบเอกสาร PDF");
    createOpen.value = false;
    await navigateTo(`/meetings/${(data as any).meeting.id}`);
  }
}

const statusVariant = (s: string) =>
  s === "in_progress" ? "destructive" : s === "completed" ? "secondary" : s === "cancelled" ? "outline" : "default";
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between flex-wrap gap-3">
      <div>
        <h1 class="text-2xl font-bold tracking-tight flex items-center gap-2">
          <ClipboardList class="w-6 h-6 text-primary" /> การประชุม
        </h1>
        <p class="text-muted-foreground mt-1">จัดการการประชุม วาระ เอกสาร และรายงานในที่เดียว</p>
      </div>
      <Button @click="createOpen = true"><Plus class="w-4 h-4 mr-1.5" /> สร้างการประชุม</Button>
    </div>

    <div class="flex items-center justify-between flex-wrap gap-3">
      <Tabs :model-value="statusTab" @update:model-value="statusTab = String($event)">
        <TabsList>
          <TabsTrigger value="all">ทั้งหมด</TabsTrigger>
          <TabsTrigger value="upcoming">กำลังจะประชุม</TabsTrigger>
          <TabsTrigger value="completed">เสร็จสิ้น</TabsTrigger>
          <TabsTrigger value="cancelled">ยกเลิก</TabsTrigger>
        </TabsList>
      </Tabs>
      <div class="relative">
        <Search class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input v-model="search" placeholder="ค้นหาชื่อการประชุม..." class="pl-9 w-64" />
      </div>
    </div>

    <div v-if="loading" class="space-y-3">
      <Skeleton v-for="i in 4" :key="i" class="h-24 w-full" />
    </div>
    <div v-else-if="filtered.length === 0" class="text-center py-16 text-muted-foreground">
      <ClipboardList class="w-12 h-12 mx-auto mb-3 opacity-30" />
      ไม่พบการประชุม — กด "สร้างการประชุม" เพื่อเริ่มต้น
    </div>
    <div v-else class="space-y-3">
      <Card
        v-for="mtg in filtered"
        :key="mtg.id"
        class="cursor-pointer hover:border-primary/40 hover:shadow-sm transition-all"
        @click="navigateTo(`/meetings/${mtg.id}`)"
      >
        <CardContent class="p-4 flex items-center gap-4 flex-wrap">
          <div class="text-center shrink-0 w-20 rounded-lg bg-muted/50 py-2">
            <div class="text-xs text-muted-foreground">{{ dayjs(mtg.start_time).format("MMM BBBB") }}</div>
            <div class="text-2xl font-bold leading-none mt-0.5">{{ dayjs(mtg.start_time).format("DD") }}</div>
            <div class="text-xs text-muted-foreground mt-0.5">{{ dayjs(mtg.start_time).format("ddd") }}</div>
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <span class="font-semibold truncate">{{ mtg.title }}</span>
              <Badge :variant="statusVariant(mtg.status) as any">{{ meetingStatusLabel[mtg.status] || mtg.status }}</Badge>
            </div>
            <div class="flex items-center gap-4 text-xs text-muted-foreground mt-1.5 flex-wrap">
              <span class="flex items-center gap-1"><MapPin class="w-3.5 h-3.5" /> {{ mtg.location_text || "ไม่ระบุสถานที่" }}</span>
              <span class="flex items-center gap-1"><Users class="w-3.5 h-3.5" /> ประธาน: {{ mtg.organizer_name || "-" }}</span>
              <span>{{ fmtDateTime(mtg.start_time) }}–{{ dayjs(mtg.end_time).format("HH:mm") }}</span>
            </div>
          </div>
          <div class="flex gap-2 shrink-0">
            <Button
              v-if="!['completed', 'cancelled'].includes(mtg.status)"
              variant="outline" size="sm"
              @click.stop="navigateTo(`/meetings/${mtg.id}/live`)"
            >
              <Mic2 class="w-4 h-4 mr-1.5" /> ประชุมสด
            </Button>
            <Button variant="outline" size="sm" @click.stop="navigateTo(`/meetings/${mtg.id}/minutes`)">
              <FileText class="w-4 h-4 mr-1.5" /> รายงาน
            </Button>
            <Button variant="ghost" size="sm" @click.stop="navigateTo(`/meetings/${mtg.id}`)">
              เปิด <ArrowRight class="w-3.5 h-3.5 ml-1" />
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>

    <!-- Dialog สร้างการประชุม -->
    <Dialog :open="createOpen" @update:open="createOpen = $event">
      <DialogContent class="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>สร้างการประชุม</DialogTitle>
          <DialogDescription>ขั้นที่ 1 ของ workflow — จองห้อง เลือกเลขา และเชิญผู้เข้าร่วม</DialogDescription>
        </DialogHeader>
        <div class="space-y-4">
          <div class="space-y-1.5">
            <Label>ชื่อการประชุม *</Label>
            <Input v-model="form.title" placeholder="เช่น ประชุมคณะกรรมการบริหาร ครั้งที่ 9/2569" />
          </div>
          <div class="space-y-1.5">
            <Label>คำอธิบาย</Label>
            <Textarea v-model="form.description" rows="2" placeholder="วัตถุประสงค์การประชุมโดยย่อ" />
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div class="space-y-1.5">
              <Label>ประเภทการประชุม</Label>
              <Select :model-value="form.meetingType" @update:model-value="form.meetingType = String($event)">
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="regular">ประชุมประจำ</SelectItem>
                  <SelectItem value="adhoc">ประชุมเฉพาะกิจ</SelectItem>
                  <SelectItem value="board">ประชุมคณะกรรมการ</SelectItem>
                  <SelectItem value="department">ประชุมหน่วยงาน</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="space-y-1.5">
              <Label>เลขานุการ</Label>
              <Select :model-value="form.secretaryId" @update:model-value="form.secretaryId = String($event)">
                <SelectTrigger><SelectValue placeholder="เลือกเลขานุการ" /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="u in users" :key="u.id" :value="String(u.id)">{{ u.name || u.username }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div class="grid grid-cols-4 gap-3">
            <div class="space-y-1.5">
              <Label>วันที่</Label>
              <Input type="date" v-model="form.date" />
            </div>
            <div class="space-y-1.5">
              <Label>เริ่ม</Label>
              <Input type="time" v-model="form.start" />
            </div>
            <div class="space-y-1.5">
              <Label>สิ้นสุด</Label>
              <Input type="time" v-model="form.end" />
            </div>
              <div class="space-y-1.5">
                <Label>ห้องประชุม</Label>
                <Select :model-value="form.roomId" @update:model-value="form.roomId = String($event)">
                  <SelectTrigger><SelectValue placeholder="ไม่จองห้อง" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="r in rooms" :key="r.id" :value="r.id">
                      {{ r.name }} ({{ r.capacity }} ที่นั่ง)
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div v-if="form.roomId" class="space-y-1.5">
              <Label class="flex items-center gap-1.5">
                <UtensilsCrossed class="w-3.5 h-3.5 text-amber-600" />
                ความต้องการพิเศษ (อาหารว่าง/เครื่องดื่ม/จัดห้อง)
              </Label>
              <Textarea
                v-model="form.specialRequests"
                rows="2"
                placeholder="เช่น ขออาหารว่างเบรคเช้า 20 ชุด, ขอไมค์ลอย 2 ตัว, จัดโต๊ะรูป U..."
              />
            </div>
            <div class="space-y-1.5">
              <Label>ผู้เข้าร่วม (ผู้จัดประชุมและเลขาเข้าร่วมอัตโนมัติ)</Label>
            <div class="flex flex-wrap gap-1.5 rounded-lg border p-3 max-h-40 overflow-y-auto">
              <Badge
                v-for="u in users"
                :key="u.id"
                :variant="form.participantIds.includes(u.id) ? 'default' : 'outline'"
                class="cursor-pointer py-1.5"
                @click="toggleParticipant(u.id)"
              >
                {{ u.name || u.username }}
              </Badge>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button :disabled="saving" @click="save">
            <Loader2 v-if="saving" class="w-4 h-4 mr-1.5 animate-spin" /> สร้างการประชุม
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
