<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { toast } from "vue-sonner";
import { useMeetingApi } from "@/composables/useMeetingApi";
import { dayjs, actionStatusLabels } from "@/utils/meeting-format";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  ListTodo, Loader2, Repeat, Clock3, AlertTriangle, CheckCircle2, XCircle,
} from "lucide-vue-next";

useSeoMeta({ title: "ติดตามงาน | AI Smart Meeting" });

const { api, call } = useMeetingApi();
const loading = ref(true);
const items = ref<any[]>([]);
const meetings = ref<any[]>([]);
const filter = ref("open");
const selected = ref<Set<string>>(new Set());
const carryOpen = ref(false);
const carryTarget = ref("");
const carrying = ref(false);

async function load() {
  loading.value = true;
  const query = filter.value === "mine" ? { mine: "true" } : filter.value === "all" ? { status: "pending,in_progress,done,overdue,cancelled" } : {};
  const [actionsData, meetingsData] = await Promise.all([
    call(() => api.followup.actions.get({ query: query as any }), { silent: true }),
    call(() => api.meetings.get({ query: { limit: 50 } }), { silent: true }),
  ]);
  if (actionsData) items.value = (actionsData as any).actionItems ?? [];
  if (meetingsData) meetings.value = ((meetingsData as any).meetings ?? []).filter((m: any) => !["cancelled"].includes(m.status));
  loading.value = false;
}
onMounted(load);

const selectable = computed(() => items.value.filter((i) => i.status !== "done" && i.status !== "cancelled"));

function toggleSelect(id: string) {
  if (selected.value.has(id)) selected.value.delete(id);
  else selected.value.add(id);
}

async function updateStatus(item: any, status: string) {
  const meetingId = item.meeting_id;
  const d = await call(() => api.meetings[meetingId].actions[item.id].put({ status }));
  if (d) {
    await load();
    toast.success("อัปเดตสถานะแล้ว");
  }
}

function openCarry() {
  if (selected.value.size === 0) {
    toast.error("เลือกงานอย่างน้อย 1 รายการก่อน");
    return;
  }
  carryTarget.value = "";
  carryOpen.value = true;
}

async function carryForward() {
  if (!carryTarget.value) {
    toast.error("เลือกการประชุมปลายทาง");
    return;
  }
  carrying.value = true;
  const d = await call(() =>
    api.followup["carry-forward"].post({
      targetMeetingId: carryTarget.value,
      actionItemIds: [...selected.value],
    }),
  );
  carrying.value = false;
  if (d) {
    toast.success(`นำงาน ${selected.value.size} รายการเข้าสู่วาระการประชุมครั้งถัดไปแล้ว (ประเภท "เรื่องสืบเนื่อง")`);
    selected.value.clear();
    carryOpen.value = false;
    await load();
  }
}

const badgeVariant = (status: string) =>
  status === "done" ? "default" : status === "overdue" || status === "high" ? "destructive" : "outline";
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between flex-wrap gap-3">
      <div>
        <h1 class="text-2xl font-bold tracking-tight flex items-center gap-2">
          <ListTodo class="w-6 h-6 text-primary" /> ติดตามงาน
        </h1>
        <p class="text-muted-foreground mt-1">
          งานที่มอบหมายจากทุกการประชุม — ติดตามสถานะ และนำงานค้างเข้าวาระการประชุมครั้งถัดไป
        </p>
      </div>
      <div class="flex gap-2">
        <Select :model-value="filter" @update:model-value="filter = String($event); load()">
          <SelectTrigger class="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="open">งานที่ยังไม่เสร็จ</SelectItem>
            <SelectItem value="mine">งานของฉัน</SelectItem>
            <SelectItem value="all">ทั้งหมด</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" @click="openCarry">
          <Repeat class="w-4 h-4 mr-1.5" /> สืบเนื่องไปประชุมถัดไป
          <Badge v-if="selected.size" variant="secondary" class="ml-1.5">{{ selected.size }}</Badge>
        </Button>
      </div>
    </div>

    <div v-if="loading" class="space-y-3">
      <Skeleton v-for="i in 4" :key="i" class="h-20 w-full" />
    </div>
    <div v-else-if="items.length === 0" class="text-center py-16 text-muted-foreground border rounded-lg">
      <CheckCircle2 class="w-12 h-12 mx-auto mb-3 opacity-30" />
      ไม่มีงานที่ต้องติดตาม
    </div>
    <div v-else class="space-y-3">
      <Card v-for="item in items" :key="item.id" :class="{ 'opacity-60': item.status === 'done' || item.status === 'cancelled' }">
        <CardContent class="p-4 flex items-center gap-3 flex-wrap">
          <Checkbox
            v-if="item.status !== 'done' && item.status !== 'cancelled'"
            :model-value="selected.has(item.id)"
            @update:model-value="toggleSelect(item.id)"
            class="shrink-0"
          />
          <div class="flex-1 min-w-0">
            <div class="font-medium text-sm flex items-center gap-2 flex-wrap">
              <span class="truncate">{{ item.title }}</span>
              <Badge :variant="badgeVariant(item.status) as any" class="text-[10px]">{{ actionStatusLabels[item.status] }}</Badge>
              <Badge v-if="item.priority === 'high'" variant="destructive" class="text-[10px]">สำคัญ</Badge>
            </div>
            <div class="text-xs text-muted-foreground mt-1 flex items-center gap-3 flex-wrap">
              <button class="hover:underline text-left" @click="navigateTo(`/meetings/${item.meeting_id}/minutes`)">
                จาก: {{ item.meeting_title }}
              </button>
              <span v-if="item.agenda_title">วาระ {{ item.agenda_no }}: {{ item.agenda_title }}</span>
              <span v-if="item.due_date" class="flex items-center gap-1" :class="dayjs(item.due_date).isBefore(dayjs(), 'day') && item.status !== 'done' ? 'text-destructive font-medium' : ''">
                <Clock3 class="w-3 h-3" /> กำหนดส่ง {{ dayjs(item.due_date).format("D MMMM BBBB") }}
              </span>
              <span v-if="item.due_date && dayjs(item.due_date).isBefore(dayjs(), 'day') && item.status !== 'done'" class="flex items-center gap-1 text-destructive">
                <AlertTriangle class="w-3 h-3" /> เลยกำหนด
              </span>
            </div>
          </div>
          <Select :model-value="item.status" @update:model-value="updateStatus(item, String($event))">
            <SelectTrigger class="h-8 w-40 shrink-0"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="pending">รอดำเนินการ</SelectItem>
              <SelectItem value="in_progress">กำลังดำเนินการ</SelectItem>
              <SelectItem value="done">เสร็จสิ้น</SelectItem>
              <SelectItem value="cancelled">ยกเลิก</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>
    </div>

    <!-- Dialog สืบเนื่องงาน -->
    <Dialog :open="carryOpen" @update:open="carryOpen = $event">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>นำงานเข้าสู่วาระการประชุมครั้งถัดไป</DialogTitle>
        </DialogHeader>
        <div class="space-y-3">
          <p class="text-sm text-muted-foreground">
            งานที่เลือก {{ selected.size }} รายการ จะถูกสร้างเป็นวาระประเภท "เรื่องสืบเนื่อง" ในการประชุมปลายทาง
          </p>
          <Select :model-value="carryTarget" @update:model-value="carryTarget = String($event)">
            <SelectTrigger><SelectValue placeholder="เลือกการประชุมปลายทาง" /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="m in meetings" :key="m.id" :value="m.id">
                {{ m.title }} ({{ dayjs(m.start_time).format("D MMM BBBB") }})
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button :disabled="carrying" @click="carryForward()">
            <Loader2 v-if="carrying" class="w-4 h-4 mr-1.5 animate-spin" /> ยืนยันการสืบเนื่อง
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
