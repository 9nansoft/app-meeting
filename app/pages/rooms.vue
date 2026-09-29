<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { toast } from "vue-sonner";
import { useMeetingApi } from "@/composables/useMeetingApi";
import { useAuth } from "@/composables/useAuth";
import { dayjs, equipmentLabel, equipmentOptions } from "@/utils/meeting-format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  ChevronLeft, ChevronRight, CalendarDays, Sparkles, Plus, Trash2, Pencil, MapPin,
  Users, CheckCircle2, XCircle, Loader2, Building2, Armchair, Table2, MonitorPlay,
  UserCog, ImagePlus, Star, Camera, UtensilsCrossed,
} from "lucide-vue-next";

useSeoMeta({ title: "จองห้องประชุม | AI Smart Meeting" });

const { api, call, upload } = useMeetingApi();
const { user: authUser } = useAuth();
const isAdmin = computed(() => authUser.value?.role === "admin");

const loading = ref(true);
const rooms = ref<any[]>([]);
const bookings = ref<any[]>([]);
const users = ref<any[]>([]);
const myRooms = ref<any[]>([]);
const mainTab = ref("calendar");

const DAY_START = 8; // 08:00
const DAY_END = 20; // 20:00
const SLOT_MINUTES = 30;
const slotsPerDay = ((DAY_END - DAY_START) * 60) / SLOT_MINUTES;
const selectedDate = ref(dayjs().format("YYYY-MM-DD"));
const viewMode = ref<"day" | "week">("day");

const roomFilter = ref<string>("all");
const visibleRooms = computed(() =>
  rooms.value.filter((r) => roomFilter.value === "all" || r.id === roomFilter.value),
);

async function load() {
  loading.value = true;
  const from = viewMode.value === "day" ? selectedDate.value : dayjs(selectedDate.value).startOf("week").add(1, "day").format("YYYY-MM-DD");
  const to = dayjs(from).add(viewMode.value === "day" ? 1 : 7, "day").format("YYYY-MM-DD");
  const [roomsData, bookingData, usersData, mineData] = await Promise.all([
    call(() => api.rooms.get(), { silent: true }),
    call(() => api.bookings.get({ query: { from: `${from}T00:00:00`, to: `${to}T00:00:00` } }), { silent: true }),
    call(() => api.users.get(), { silent: true }),
    call(() => api.rooms.mine.get(), { silent: true }),
  ]);
  if (roomsData) rooms.value = (roomsData as any).rooms ?? [];
  if (bookingData) bookings.value = (bookingData as any).bookings ?? [];
  if (usersData) users.value = Array.isArray(usersData) ? usersData : (usersData as any).users ?? [];
  if (mineData) myRooms.value = (mineData as any).rooms ?? [];
  loading.value = false;
}
onMounted(load);
watch([selectedDate, viewMode], load);

function shiftDate(amount: number, unit: any) {
  selectedDate.value = dayjs(selectedDate.value).add(amount, unit).format("YYYY-MM-DD");
}

// ตำแหน่ง block ใน grid รายวัน
function blockStyle(b: any) {
  const start = dayjs(b.start_time);
  const end = dayjs(b.end_time);
  const startMin = Math.max(start.hour() * 60 + start.minute(), DAY_START * 60);
  const endMin = Math.min(end.hour() * 60 + end.minute(), DAY_END * 60);
  const top = ((startMin - DAY_START * 60) / (SLOT_MINUTES * slotsPerDay)) * 100;
  const height = ((endMin - startMin) / (SLOT_MINUTES * slotsPerDay)) * 100;
  const color = b.room_color || "#2563eb";
  return {
    top: `${top}%`,
    height: `${Math.max(height, 3)}%`,
    background: `${color}22`,
    borderLeft: `3px solid ${color}`,
  };
}

function bookingsOf(roomId: string, date?: string) {
  const dayStart = dayjs(date || selectedDate.value).startOf("day");
  const dayEnd = dayStart.add(1, "day");
  return bookings.value.filter((b) => {
    const s = dayjs(b.start_time);
    return b.room_id === roomId && s.isAfter(dayStart.subtract(1, "second")) && s.isBefore(dayEnd);
  });
}

const weekDays = computed(() => {
  const start = dayjs(selectedDate.value).startOf("week").add(1, "day"); // จันทร์
  return Array.from({ length: 7 }, (_, i) => start.add(i, "day").format("YYYY-MM-DD"));
});

/* ---------- Dialog จองห้อง ---------- */
const bookingOpen = ref(false);
const saving = ref(false);
const bookingForm = ref({
  id: "" as string,
  roomId: "",
  title: "",
  purpose: "",
  specialRequests: "",
  participantsCount: 8,
  date: dayjs().format("YYYY-MM-DD"),
  start: "09:00",
  end: "10:00",
  recurring: false,
  freq: "weekly" as "daily" | "weekly" | "monthly",
  interval: 1,
  count: 4,
});
const conflict = ref<any[] | null>(null);

function openBooking(room?: any, hour?: number) {
  conflict.value = null;
  bookingForm.value = {
    id: "",
    roomId: room?.id || rooms.value[0]?.id || "",
    title: "",
    purpose: "",
    specialRequests: "",
    participantsCount: 8,
    date: selectedDate.value,
    start: hour != null ? `${String(hour).padStart(2, "0")}:00` : "09:00",
    end: hour != null ? `${String(Math.min(hour + 1, DAY_END)).padStart(2, "0")}:00` : "10:00",
    recurring: false,
    freq: "weekly",
    interval: 1,
    count: 4,
  };
  bookingOpen.value = true;
}

function editBooking(b: any) {
  conflict.value = null;
  bookingForm.value = {
    id: b.id,
    roomId: b.room_id,
    title: b.title,
    purpose: b.purpose || "",
    specialRequests: b.special_requests || "",
    participantsCount: b.participants_count || 8,
    date: dayjs(b.start_time).format("YYYY-MM-DD"),
    start: dayjs(b.start_time).format("HH:mm"),
    end: dayjs(b.end_time).format("HH:mm"),
    recurring: false,
    freq: "weekly",
    interval: 1,
    count: 4,
  };
  bookingOpen.value = true;
}

const startIso = computed(() => dayjs(`${bookingForm.value.date}T${bookingForm.value.start}`).toISOString());
const endIso = computed(() => dayjs(`${bookingForm.value.date}T${bookingForm.value.end}`).toISOString());

async function checkAvailability() {
  conflict.value = null;
  const data = await call(() =>
    api.bookings.check.post({ roomId: bookingForm.value.roomId, start: startIso.value, end: endIso.value }),
  );
  if (data) {
    if ((data as any).available) toast.success("ห้องว่างในช่วงเวลานี้");
    else {
      conflict.value = (data as any).conflicts;
      toast.error("ช่วงเวลานี้ถูกจองแล้ว");
    }
  }
}

async function saveBooking() {
  if (!bookingForm.value.title.trim() || !bookingForm.value.roomId) {
    toast.error("กรุณากรอกชื่อการประชุมและเลือกห้อง");
    return;
  }
  saving.value = true;
  const payload: any = {
    roomId: bookingForm.value.roomId,
    title: bookingForm.value.title,
    purpose: bookingForm.value.purpose || undefined,
    specialRequests: bookingForm.value.specialRequests || undefined,
    participantsCount: bookingForm.value.participantsCount,
    start: startIso.value,
    end: endIso.value,
  };
  if (bookingForm.value.recurring && !bookingForm.value.id) {
    payload.recurrence = {
      freq: bookingForm.value.freq,
      interval: bookingForm.value.interval,
      count: bookingForm.value.count,
    };
  }
  const result = bookingForm.value.id
    ? await call(() => api.bookings[bookingForm.value.id].put(payload))
    : await call(() => api.bookings.post(payload));
  saving.value = false;
  if (result) {
    const skipped = (result as any).skipped as any[] | undefined;
    if (skipped?.length) toast.warning(`จองสำเร็จ ${skipped.length > 0 ? `(ข้าม ${skipped.length} รอบที่เวลาชนกัน)` : ""}`);
    else toast.success(bookingForm.value.id ? "แก้ไขการจองแล้ว" : "จองห้องสำเร็จ");
    bookingOpen.value = false;
    await load();
  }
}

async function cancelBooking(b: any, all = false) {
  const data = await call(() => api.bookings[b.id].delete({ query: all ? { all: "true" } as any : {} as any }));
  if (data) {
    toast.success("ยกเลิกการจองแล้ว");
    await load();
  }
}

/* ---------- AI แนะนำห้อง ---------- */
const aiOpen = ref(false);
const aiLoading = ref(false);
const aiForm = ref({ participants: 10, date: dayjs().format("YYYY-MM-DD"), start: "09:00", end: "10:00", equipment: [] as string[], needDining: false });
const aiResult = ref<any>(null);
const allEquipment = ["projector", "tv", "video_conf", "whiteboard", "microphone", "recorder"];

function toggleEquipment(e: string) {
  const i = aiForm.value.equipment.indexOf(e);
  if (i >= 0) aiForm.value.equipment.splice(i, 1);
  else aiForm.value.equipment.push(e);
}

async function askAi() {
  aiLoading.value = true;
  aiResult.value = null;
  const data = await call(() =>
    api.rooms.recommend.post({
      participants: aiForm.value.participants,
      start: dayjs(`${aiForm.value.date}T${aiForm.value.start}`).toISOString(),
      end: dayjs(`${aiForm.value.date}T${aiForm.value.end}`).toISOString(),
      equipment: aiForm.value.equipment,
      needDining: aiForm.value.needDining,
    }),
  );
  if (data) aiResult.value = data;
  aiLoading.value = false;
}

function pickRoom(room: any) {
  aiOpen.value = false;
  openBooking(room, Number(aiForm.value.start.split(":")[0]));
}

/* ================= จัดการห้องประชุม (ข้อมูลห้อง/รูป/อุปกรณ์/ผู้รับผิดชอบ) ================= */

const roomFormOpen = ref(false);
const roomSaving = ref(false);
const roomForm = ref(emptyRoomForm());

function emptyRoomForm() {
  return {
    id: "",
    name: "",
    capacity: 10,
    building: "",
    floor: "",
    location: "",
    tableCount: 1,
    chairCount: 10,
    responsibleId: "",
    description: "",
    color: "#2563eb",
    hasDining: false,
    diningDetail: "",
    equipment: [] as Array<{ equipmentType: string; name: string; quantity: number }>,
  };
}

function openRoomForm(room?: any) {
  const form = emptyRoomForm();
  if (room) {
    form.id = room.id;
    form.name = room.name;
    form.capacity = room.capacity;
    form.building = room.building || "";
    form.floor = room.floor || "";
    form.location = room.location || "";
    form.tableCount = room.table_count ?? 1;
    form.chairCount = room.chair_count ?? room.capacity;
    form.responsibleId = room.responsible_user_id ? String(room.responsible_user_id) : "";
    form.description = room.description || "";
    form.color = room.color || "#2563eb";
    form.hasDining = room.has_dining ?? false;
    form.diningDetail = room.dining_detail || "";
    form.equipment = (room.equipment || []).map((e: any) => ({
      equipmentType: e.equipment_type,
      name: e.name || "",
      quantity: e.quantity || 1,
    }));
  }
  roomForm.value = form;
  roomFormOpen.value = true;
}

function addEquipmentRow() {
  roomForm.value.equipment.push({ equipmentType: equipmentOptions[0], name: "", quantity: 1 });
}

async function saveRoom() {
  if (!roomForm.value.name.trim()) {
    toast.error("กรุณากรอกชื่อห้องประชุม");
    return;
  }
  roomSaving.value = true;
  const payload = {
    name: roomForm.value.name,
    capacity: roomForm.value.capacity,
    building: roomForm.value.building || undefined,
    floor: roomForm.value.floor || undefined,
    location: roomForm.value.location || undefined,
    tableCount: roomForm.value.tableCount || undefined,
    chairCount: roomForm.value.chairCount || undefined,
    responsibleUserId: roomForm.value.responsibleId ? Number(roomForm.value.responsibleId) : undefined,
    description: roomForm.value.description || undefined,
    color: roomForm.value.color || undefined,
    hasDining: roomForm.value.hasDining,
    diningDetail: roomForm.value.diningDetail || undefined,
    equipment: roomForm.value.equipment.filter((e) => e.equipmentType),
  };
  const result = roomForm.value.id
    ? await call(() => api.rooms[roomForm.value.id].put(payload))
    : await call(() => api.rooms.post(payload));
  roomSaving.value = false;
  if (result) {
    toast.success(roomForm.value.id ? "แก้ไขข้อมูลห้องแล้ว" : "สร้างห้องประชุมใหม่แล้ว");
    roomFormOpen.value = false;
    await load();
  }
}

async function deleteRoom(room: any) {
  const result = await call(() => api.rooms[room.id].delete());
  if (result) {
    toast.success("ลบห้องแล้ว");
    await load();
  }
}

/* ---------- รูปห้อง ---------- */
const detailRoom = ref<any>(null);
const detailOpen = ref(false);
const uploadingImages = ref(false);

function openRoomDetail(room: any) {
  detailRoom.value = room;
  detailOpen.value = true;
}

function imageUrl(imageId: string, publicAccess = false) {
  return publicAccess
    ? `/api/public/room-images/${imageId}/raw`
    : `/api/rooms/images/${imageId}/raw`;
}

async function onUploadImages(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  if (!files.length || !detailRoom.value) return;
  uploadingImages.value = true;
  const form = new FormData();
  files.forEach((f) => form.append("files", f, f.name));
  try {
    const res = await fetch(`/api/rooms/${detailRoom.value.id}/images`, { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(data?.error || "อัปโหลดรูปไม่สำเร็จ");
    } else {
      toast.success(`อัปโหลดรูป ${files.length} รูปแล้ว`);
      await load();
      detailRoom.value = rooms.value.find((r) => r.id === detailRoom.value.id) || detailRoom.value;
    }
  } finally {
    uploadingImages.value = false;
    input.value = "";
  }
}

async function setCover(image: any) {
  const result = await call(() => api.rooms.images[image.id].cover.put({}));
  if (result) {
    toast.success("ตั้งเป็นรูปปกแล้ว");
    await load();
    detailRoom.value = rooms.value.find((r) => r.id === detailRoom.value.id) || detailRoom.value;
  }
}

function openDisplay(roomId: string) {
  window.open(`/display?room=${roomId}`, "_blank");
}

async function deleteImage(image: any) {
  const result = await call(() => api.rooms.images[image.id].delete());
  if (result) {
    await load();
    detailRoom.value = rooms.value.find((r) => r.id === detailRoom.value.id) || detailRoom.value;
    toast.success("ลบรูปแล้ว");
  }
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between flex-wrap gap-3">
      <div>
        <h1 class="text-2xl font-bold tracking-tight flex items-center gap-2">
          <CalendarDays class="w-6 h-6 text-primary" /> จองห้องประชุม
        </h1>
        <p class="text-muted-foreground mt-1">ตรวจสอบห้องว่าง จองซ้ำตามรอบ และรับคำแนะนำห้องจาก AI</p>
      </div>
      <div class="flex gap-2">
        <Button variant="outline" @click="aiOpen = true">
          <Sparkles class="w-4 h-4 mr-1.5 text-primary" /> AI แนะนำห้อง
        </Button>
        <Button @click="openBooking()"><Plus class="w-4 h-4 mr-1.5" /> จองห้อง</Button>
      </div>
    </div>

    <Tabs v-model="mainTab" class="w-full">
      <TabsList>
        <TabsTrigger value="calendar">ปฏิทินการจอง</TabsTrigger>
        <TabsTrigger value="manage">ห้องและอุปกรณ์</TabsTrigger>
      </TabsList>

      <TabsContent value="calendar" class="space-y-4 mt-4">
    <!-- แถบควบคุม -->
    <div class="flex items-center justify-between flex-wrap gap-3">
      <div class="flex items-center gap-2">
        <Button variant="outline" size="icon" @click="shiftDate(viewMode === 'day' ? -1 : -7, 'day')">
          <ChevronLeft class="w-4 h-4" />
        </Button>
        <Input
          type="date"
          :model-value="selectedDate"
          class="w-40"
          @update:model-value="selectedDate = String($event)"
        />
        <Button variant="outline" size="icon" @click="shiftDate(viewMode === 'day' ? 1 : 7, 'day')">
          <ChevronRight class="w-4 h-4" />
        </Button>
        <Button variant="ghost" size="sm" @click="selectedDate = dayjs().format('YYYY-MM-DD')">วันนี้</Button>
      </div>
      <div class="flex items-center gap-2">
        <Select :model-value="roomFilter" @update:model-value="roomFilter = String($event)">
          <SelectTrigger class="w-48"><SelectValue placeholder="ทุกห้อง" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">ทุกห้อง</SelectItem>
            <SelectItem v-for="r in rooms" :key="r.id" :value="r.id">{{ r.name }}</SelectItem>
          </SelectContent>
        </Select>
        <div class="flex rounded-lg border overflow-hidden">
          <Button variant="ghost" size="sm" class="rounded-none" :class="viewMode === 'day' ? 'bg-primary/10 text-primary' : ''" @click="viewMode = 'day'">รายวัน</Button>
          <Button variant="ghost" size="sm" class="rounded-none" :class="viewMode === 'week' ? 'bg-primary/10 text-primary' : ''" @click="viewMode = 'week'">รายสัปดาห์</Button>
        </div>
      </div>
    </div>

    <Skeleton v-if="loading" class="h-96 w-full" />

    <!-- มุมมองรายวัน: grid ห้อง × เวลา -->
    <Card v-else-if="viewMode === 'day'">
      <CardContent class="p-0 overflow-hidden">
        <div class="overflow-x-auto">
          <div class="min-w-[720px]">
            <!-- หัวตาราง -->
            <div class="flex border-b sticky top-0 bg-background z-10">
              <div class="w-40 shrink-0 p-2 text-xs text-muted-foreground border-r">ห้อง / เวลา</div>
              <div class="flex-1 grid" :style="{ gridTemplateColumns: `repeat(${slotsPerDay / 2}, 1fr)` }">
                <div v-for="h in DAY_END - DAY_START" :key="h" class="text-xs text-muted-foreground text-center py-2 border-r last:border-r-0">
                  {{ String(DAY_START + h - 1).padStart(2, "0") }}:00
                </div>
              </div>
            </div>
            <!-- แถวห้อง -->
            <div v-for="room in visibleRooms" :key="room.id" class="flex border-b last:border-b-0 h-24 relative">
              <div class="w-40 shrink-0 p-3 border-r">
                <div class="font-medium text-sm truncate" :title="room.name">{{ room.name }}</div>
                <div class="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
                  <Users class="w-3 h-3" /> {{ room.capacity }} ที่นั่ง
                </div>
                <div class="flex flex-wrap gap-0.5 mt-1">
                  <Badge v-for="e in room.equipment.slice(0, 3)" :key="e.id" variant="secondary" class="text-[10px] px-1 py-0">
                    {{ equipmentLabel[e.equipment_type] || e.equipment_type }}
                  </Badge>
                  <Badge v-if="room.equipment.length > 3" variant="secondary" class="text-[10px] px-1 py-0">+{{ room.equipment.length - 3 }}</Badge>
                </div>
              </div>
              <!-- พื้นที่ grid -->
              <div class="flex-1 relative bg-muted/20 cursor-pointer hover:bg-primary/5 transition-colors" @click.self="openBooking(room)">
                <div v-for="h in DAY_END - DAY_START - 1" :key="h" class="absolute top-0 bottom-0 border-l border-border/40" :style="{ left: `${(h / (DAY_END - DAY_START)) * 100}%` }" />
                <div
                  v-for="b in bookingsOf(room.id)"
                  :key="b.id"
                  class="absolute left-1 right-1 rounded-md px-2 py-1 overflow-hidden group cursor-pointer shadow-sm"
                  :style="blockStyle(b)"
                  @click.stop="editBooking(b)"
                >
                  <div class="text-xs font-semibold truncate">{{ b.title }}</div>
                  <div class="text-[11px] text-muted-foreground">
                    {{ dayjs(b.start_time).format("HH:mm") }}–{{ dayjs(b.end_time).format("HH:mm") }}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>

    <!-- มุมมองรายสัปดาห์ -->
    <div v-else class="space-y-4">
      <Card v-for="d in weekDays" :key="d" :class="dayjs(d).isSame(dayjs(), 'day') ? 'border-primary/40' : ''">
        <CardHeader class="py-3">
          <CardTitle class="text-sm flex items-center justify-between">
            <span>{{ dayjs(d).format("dddd D MMMM BBBB") }}</span>
            <Badge v-if="dayjs(d).isSame(dayjs(), 'day')" variant="outline">วันนี้</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent class="pt-0">
          <div v-if="visibleRooms.every((r) => bookingsOf(r.id, d).length === 0)" class="py-3 text-sm text-muted-foreground text-center">
            ว่างทั้งวัน
          </div>
          <div v-else class="space-y-2">
            <div v-for="r in visibleRooms" :key="r.id">
              <div v-for="b in bookingsOf(r.id, d)" :key="b.id" class="flex items-center gap-3 p-2.5 rounded-lg border text-sm">
                <div class="w-24 font-medium shrink-0 text-xs">{{ dayjs(b.start_time).format("HH:mm") }}–{{ dayjs(b.end_time).format("HH:mm") }}</div>
                <MapPin class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <span class="flex-1 truncate">{{ b.title }}</span>
                <span class="text-xs text-muted-foreground shrink-0 hidden sm:inline">{{ b.room_name }}</span>
                <Button variant="ghost" size="icon" class="h-7 w-7" @click="editBooking(b)"><Pencil class="w-3.5 h-3.5" /></Button>
                <Button variant="ghost" size="icon" class="h-7 w-7 text-destructive" @click="cancelBooking(b)"><Trash2 class="w-3.5 h-3.5" /></Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>

      </TabsContent>

      <!-- ================= แท็บจัดการห้องและอุปกรณ์ ================= -->
      <TabsContent value="manage" class="mt-4 space-y-6">
        <!-- ห้องที่ฉันรับผิดชอบ -->
        <Card v-if="myRooms.length > 0" class="border-l-4 border-l-primary">
          <CardHeader class="pb-3">
            <CardTitle class="text-base flex items-center gap-2">
              <UserCog class="w-4 h-4 text-primary" /> ห้องที่ฉันเป็นผู้รับผิดชอบ ({{ myRooms.length }})
            </CardTitle>
          </CardHeader>
          <CardContent class="grid md:grid-cols-2 gap-4">
            <div v-for="room in myRooms" :key="room.id" class="rounded-lg border p-4 space-y-3">
              <div class="flex items-center justify-between gap-2">
                <div>
                  <div class="font-semibold">{{ room.name }}</div>
                  <div class="text-xs text-muted-foreground flex items-center gap-1.5 mt-0.5">
                    <Building2 class="w-3.5 h-3.5" /> {{ room.building || "-" }} · ชั้น {{ room.floor || "-" }}
                  </div>
                </div>
                <Button variant="outline" size="sm" @click="openRoomDetail(room)">ดูข้อมูลห้อง</Button>
              </div>
              <div>
                <div class="text-xs font-medium text-muted-foreground mb-1.5">ตารางจองวันนี้ ({{ room.todaySchedule.length }} รายการ)</div>
                <div v-if="room.todaySchedule.length === 0" class="text-xs text-muted-foreground">ไม่มีการจองวันนี้</div>
                <div v-else class="space-y-1.5">
                  <div
                    v-for="b in room.todaySchedule"
                    :key="b.id"
                    class="flex items-center gap-2 text-sm p-1.5 rounded"
                    :class="dayjs(b.end_time).isAfter(dayjs()) && dayjs(b.start_time).isBefore(dayjs())
                      ? 'bg-red-500/10 text-red-700 dark:text-red-300'
                      : dayjs(b.end_time).isBefore(dayjs()) ? 'opacity-50' : ''"
                  >
                    <span class="font-mono text-xs w-28 shrink-0">{{ dayjs(b.start_time).format("HH:mm") }}–{{ dayjs(b.end_time).format("HH:mm") }}</span>
                    <span class="flex-1 truncate">{{ b.title }}</span>
                    <Badge v-if="dayjs(b.end_time).isAfter(dayjs()) && dayjs(b.start_time).isBefore(dayjs())" variant="destructive" class="text-[10px]">กำลังประชุม</Badge>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <!-- รายการห้องทั้งหมด -->
        <div class="flex items-center justify-between">
          <h2 class="text-base font-semibold">ห้องประชุมทั้งหมด ({{ rooms.length }})</h2>
          <Button v-if="isAdmin" size="sm" @click="openRoomForm()">
            <Plus class="w-4 h-4 mr-1.5" /> เพิ่มห้องประชุม
          </Button>
        </div>

        <div v-if="loading" class="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
          <Skeleton v-for="i in 3" :key="i" class="h-72" />
        </div>
        <div v-else class="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
          <Card v-for="room in rooms" :key="room.id" class="overflow-hidden flex flex-col" :class="{ 'opacity-60': !room.is_active }">
            <!-- รูปปก -->
            <div class="h-40 bg-muted relative">
              <img
                v-if="room.cover_image"
                :src="imageUrl(room.cover_image.id)"
                :alt="room.name"
                class="w-full h-full object-cover cursor-pointer"
                @click="openRoomDetail(room)"
              />
              <div v-else class="w-full h-full flex items-center justify-center cursor-pointer" @click="openRoomDetail(room)">
                <Camera class="w-10 h-10 text-muted-foreground/40" />
              </div>
              <Badge v-if="!room.is_active" variant="secondary" class="absolute top-2 right-2">ปิดใช้งาน</Badge>
              <Badge v-else-if="room.cover_image" class="absolute top-2 right-2" variant="secondary">
                <Camera class="w-3 h-3 mr-1" /> {{ room.images.length }} รูป
              </Badge>
            </div>

            <CardContent class="p-4 flex-1 flex flex-col gap-3">
              <div>
                <div class="font-semibold truncate" :title="room.name">{{ room.name }}</div>
                <div class="text-xs text-muted-foreground flex items-center gap-1.5 mt-1">
                  <Building2 class="w-3.5 h-3.5" /> {{ room.building || "ไม่ระบุตึก" }} · ชั้น {{ room.floor || "-" }}
                  <span v-if="room.location"> · {{ room.location }}</span>
                </div>
              </div>

              <div class="grid grid-cols-3 gap-2 text-center">
                <div class="rounded-lg bg-muted/50 py-1.5">
                  <div class="text-sm font-bold flex items-center justify-center gap-1"><Users class="w-3.5 h-3.5 text-primary" /> {{ room.capacity }}</div>
                  <div class="text-[11px] text-muted-foreground">ที่นั่ง (ความจุ)</div>
                </div>
                <div class="rounded-lg bg-muted/50 py-1.5">
                  <div class="text-sm font-bold flex items-center justify-center gap-1"><Table2 class="w-3.5 h-3.5 text-primary" /> {{ room.table_count ?? "-" }}</div>
                  <div class="text-[11px] text-muted-foreground">โต๊ะ</div>
                </div>
                <div class="rounded-lg bg-muted/50 py-1.5">
                  <div class="text-sm font-bold flex items-center justify-center gap-1"><Armchair class="w-3.5 h-3.5 text-primary" /> {{ room.chair_count ?? "-" }}</div>
                  <div class="text-[11px] text-muted-foreground">เก้าอี้</div>
                </div>
              </div>

              <div class="flex flex-wrap gap-1">
                <Badge v-if="room.has_dining" variant="secondary" class="text-[11px] font-normal bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30">
                  <UtensilsCrossed class="w-3 h-3 mr-1" /> มีสถานที่ทานอาหาร
                </Badge>
                <Badge v-for="e in room.equipment" :key="e.id" variant="outline" class="text-[11px] font-normal">
                  {{ equipmentLabel[e.equipment_type] || e.equipment_type }}<span v-if="e.quantity > 1" class="text-muted-foreground"> ×{{ e.quantity }}</span>
                </Badge>
                <span v-if="room.equipment.length === 0 && !room.has_dining" class="text-xs text-muted-foreground">ไม่มีอุปกรณ์ที่บันทึก</span>
              </div>

              <div class="text-xs text-muted-foreground flex items-center gap-1.5 mt-auto">
                <UserCog class="w-3.5 h-3.5" />
                ผู้รับผิดชอบ:
                <span class="font-medium text-foreground">{{ room.responsible?.name || "ไม่ระบุ" }}</span>
              </div>

              <div class="flex gap-2 pt-1">
                <Button variant="outline" size="sm" class="flex-1" @click="openRoomDetail(room)">รายละเอียด</Button>
                <Button
                  variant="outline" size="sm"
                  :title="'เปิดหน้าจอ TV หน้าห้อง'"
                  @click="openDisplay(room.id)"
                >
                  <MonitorPlay class="w-4 h-4" />
                </Button>
                <Button v-if="isAdmin" variant="outline" size="sm" @click="openRoomForm(room)"><Pencil class="w-4 h-4" /></Button>
                <Button v-if="isAdmin" variant="outline" size="sm" class="text-destructive" @click="deleteRoom(room)"><Trash2 class="w-4 h-4" /></Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </TabsContent>
    </Tabs>

    <!-- Dialog จองห้อง -->
    <Dialog :open="bookingOpen" @update:open="bookingOpen = $event">
      <DialogContent class="max-w-lg">
        <DialogHeader>
          <DialogTitle>{{ bookingForm.id ? "แก้ไขการจอง" : "จองห้องประชุม" }}</DialogTitle>
          <DialogDescription>ตรวจสอบเวลาว่างก่อนบันทึกทุกครั้ง</DialogDescription>
        </DialogHeader>
        <div class="space-y-3 max-h-[60vh] overflow-y-auto px-1">
          <div class="space-y-1.5">
            <Label>ชื่อการประชุม *</Label>
            <Input v-model="bookingForm.title" placeholder="เช่น ประชุมประจำเดือนคณะกรรมการ" />
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div class="space-y-1.5">
              <Label>ห้องประชุม</Label>
              <Select :model-value="bookingForm.roomId" @update:model-value="bookingForm.roomId = String($event)">
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="r in rooms" :key="r.id" :value="r.id">{{ r.name }} ({{ r.capacity }})</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="space-y-1.5">
              <Label>จำนวนผู้เข้าร่วม</Label>
              <Input type="number" v-model.number="bookingForm.participantsCount" min="1" />
            </div>
          </div>
          <div class="grid grid-cols-3 gap-3">
            <div class="space-y-1.5">
              <Label>วันที่</Label>
              <Input type="date" v-model="bookingForm.date" />
            </div>
            <div class="space-y-1.5">
              <Label>เริ่ม</Label>
              <Input type="time" v-model="bookingForm.start" step="1800" />
            </div>
            <div class="space-y-1.5">
              <Label>สิ้นสุด</Label>
              <Input type="time" v-model="bookingForm.end" step="1800" />
            </div>
          </div>
          <div class="space-y-1.5">
            <Label>วัตถุประสงค์</Label>
            <Textarea v-model="bookingForm.purpose" rows="2" />
          </div>
          <div class="space-y-1.5">
            <Label class="flex items-center gap-1.5">
              <UtensilsCrossed class="w-3.5 h-3.5 text-amber-600" />
              ความต้องการพิเศษของผู้จอง
            </Label>
            <Textarea
              v-model="bookingForm.specialRequests"
              rows="2"
              placeholder="เช่น ขออาหารว่าง น้ำดื่ม 30 ขวด, จัดโต๊ะรูป U, ขอไมค์เพิ่ม..."
            />
            <p class="text-[11px] text-muted-foreground">ระบุความต้องการพิเศษ เช่น อาหารว่าง เครื่องดื่ม การจัดโต๊ะ อุปกรณ์เพิ่มเติม</p>
          </div>
          <div v-if="!bookingForm.id" class="flex items-center gap-2 pt-1">
            <Switch id="recurring" v-model:checked="bookingForm.recurring" />
            <Label for="recurring" class="cursor-pointer">จองซ้ำตามรอบ</Label>
          </div>
          <div v-if="bookingForm.recurring && !bookingForm.id" class="grid grid-cols-3 gap-3 rounded-lg border p-3">
            <div class="space-y-1.5">
              <Label class="text-xs">ความถี่</Label>
              <Select :model-value="bookingForm.freq" @update:model-value="bookingForm.freq = String($event) as any">
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">รายวัน</SelectItem>
                  <SelectItem value="weekly">รายสัปดาห์</SelectItem>
                  <SelectItem value="monthly">รายเดือน</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="space-y-1.5">
              <Label class="text-xs">ทุก ๆ (ช่วง)</Label>
              <Input type="number" v-model.number="bookingForm.interval" min="1" max="12" />
            </div>
            <div class="space-y-1.5">
              <Label class="text-xs">จำนวนครั้ง</Label>
              <Input type="number" v-model.number="bookingForm.count" min="1" max="52" />
            </div>
          </div>
          <div v-if="conflict" class="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
            <div class="flex items-center gap-1.5 font-medium text-destructive mb-1"><XCircle class="w-4 h-4" /> เวลาชนกับการจองอื่น</div>
            <div v-for="c in conflict" :key="c.id" class="text-xs text-muted-foreground">
              "{{ c.title }}" {{ dayjs(c.start_time).format("D MMM HH:mm") }}–{{ dayjs(c.end_time).format("HH:mm") }}
            </div>
          </div>
        </div>
        <DialogFooter class="gap-2">
          <Button variant="outline" @click="checkAvailability"><CheckCircle2 class="w-4 h-4 mr-1.5" /> ตรวจห้องว่าง</Button>
          <Button :disabled="saving" @click="saveBooking">
            <Loader2 v-if="saving" class="w-4 h-4 mr-1.5 animate-spin" /> บันทึกการจอง
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Dialog AI แนะนำห้อง -->
    <Dialog :open="aiOpen" @update:open="aiOpen = $event">
      <DialogContent class="max-w-xl">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2"><Sparkles class="w-5 h-5 text-primary" /> AI แนะนำห้องประชุม</DialogTitle>
          <DialogDescription>ระบุความต้องการ แล้วให้ AI เลือกห้องที่เหมาะสมที่สุด</DialogDescription>
        </DialogHeader>
        <div class="space-y-3">
          <div class="grid grid-cols-4 gap-3">
            <div class="space-y-1.5 col-span-1">
              <Label class="text-xs">ผู้เข้าร่วม (คน)</Label>
              <Input type="number" v-model.number="aiForm.participants" min="1" />
            </div>
            <div class="space-y-1.5">
              <Label class="text-xs">วันที่</Label>
              <Input type="date" v-model="aiForm.date" />
            </div>
            <div class="space-y-1.5">
              <Label class="text-xs">เริ่ม</Label>
              <Input type="time" v-model="aiForm.start" />
            </div>
            <div class="space-y-1.5">
              <Label class="text-xs">สิ้นสุด</Label>
              <Input type="time" v-model="aiForm.end" />
            </div>
          </div>
          <div class="space-y-1.5">
            <Label class="text-xs">อุปกรณ์ที่ต้องการ</Label>
            <div class="flex flex-wrap gap-1.5">
              <Badge
                v-for="e in allEquipment"
                :key="e"
                :variant="aiForm.equipment.includes(e) ? 'default' : 'outline'"
                class="cursor-pointer py-1.5"
                @click="toggleEquipment(e)"
              >
                {{ equipmentLabel[e] || e }}
              </Badge>
              <Badge
                :variant="aiForm.needDining ? 'default' : 'outline'"
                class="cursor-pointer py-1.5 border-amber-500/40"
                @click="aiForm.needDining = !aiForm.needDining"
              >
                <UtensilsCrossed class="w-3 h-3 mr-1" /> ต้องการที่ทานอาหาร
              </Badge>
            </div>
          </div>
          <Button :disabled="aiLoading" @click="askAi" class="w-full">
            <Loader2 v-if="aiLoading" class="w-4 h-4 mr-1.5 animate-spin" />
            <Sparkles v-else class="w-4 h-4 mr-1.5" /> ขอคำแนะนำจาก AI
          </Button>

          <div v-if="aiResult" class="space-y-3 pt-2 border-t">
            <div class="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm flex gap-2">
              <Sparkles class="w-4 h-4 text-primary shrink-0 mt-0.5" />
              <div>
                <div class="font-medium">{{ aiResult.recommendation }}</div>
                <div v-if="!aiResult.aiEnabled" class="text-xs text-muted-foreground mt-1">
                  (โหมดไม่ใช้โมเดลภายนอก — คำแนะนำจากกฎคะแนน ตั้งค่า AI_API_KEY เพื่อใช้ LLM)
                </div>
              </div>
            </div>
            <div class="space-y-2">
              <div
                v-for="(c, i) in aiResult.candidates"
                :key="c.room.id"
                class="flex items-start gap-3 p-3 rounded-lg border cursor-pointer hover:border-primary/50 hover:bg-muted/50"
                @click="pickRoom(c.room)"
              >
                <Badge :variant="i === 0 ? 'default' : 'secondary'">อันดับ {{ i + 1 }}</Badge>
                <div class="flex-1 min-w-0">
                  <div class="font-medium text-sm">{{ c.room.name }} <span class="text-muted-foreground font-normal">({{ c.room.capacity }} ที่นั่ง)</span></div>
                  <ul class="text-xs text-muted-foreground mt-1 space-y-0.5">
                    <li v-for="reason in c.reasons" :key="reason" :class="reason.includes('ไม่') || reason.includes('ถูกจอง') || reason.includes('ขาด') ? 'text-destructive/80' : ''">
                      • {{ reason }}
                    </li>
                  </ul>
                </div>
                <Button size="sm" variant="outline">จองห้องนี้</Button>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
    <!-- Dialog ฟอร์มห้องประชุม (เพิ่ม/แก้ไข) -->
    <Dialog :open="roomFormOpen" @update:open="roomFormOpen = $event">
      <DialogContent class="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{{ roomForm.id ? "แก้ไขห้องประชุม" : "เพิ่มห้องประชุมใหม่" }}</DialogTitle>
          <DialogDescription>ข้อมูลห้อง ตำแหน่ง อุปกรณ์ และผู้รับผิดชอบประจำห้อง</DialogDescription>
        </DialogHeader>
        <div class="space-y-4">
          <div class="grid grid-cols-2 gap-3">
            <div class="space-y-1.5">
              <Label>ชื่อห้อง *</Label>
              <Input v-model="roomForm.name" placeholder="เช่น ห้องประชุมใหญ่ 1" />
            </div>
            <div class="space-y-1.5">
              <Label>สีแสดงผลในปฏิทิน</Label>
              <Input type="color" v-model="roomForm.color" class="h-9 p-1" />
            </div>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div class="space-y-1.5">
              <Label>ตึก / อาคาร</Label>
              <Input v-model="roomForm.building" placeholder="เช่น อาคารผู้ป่วยนอก (OPD)" />
            </div>
            <div class="space-y-1.5">
              <Label>ชั้น</Label>
              <Input v-model="roomForm.floor" placeholder="เช่น 2" />
            </div>
          </div>
          <div class="space-y-1.5">
            <Label>ตำแหน่ง/จุดสังเกต</Label>
            <Input v-model="roomForm.location" placeholder="เช่น ฝั่งซ้าย ข้างลิฟต์" />
          </div>
          <div class="grid grid-cols-3 gap-3">
            <div class="space-y-1.5">
              <Label>ความจุ (คน) *</Label>
              <Input type="number" v-model.number="roomForm.capacity" min="1" />
            </div>
            <div class="space-y-1.5">
              <Label class="flex items-center gap-1"><Table2 class="w-3.5 h-3.5" /> จำนวนโต๊ะ</Label>
              <Input type="number" v-model.number="roomForm.tableCount" min="0" />
            </div>
            <div class="space-y-1.5">
              <Label class="flex items-center gap-1"><Armchair class="w-3.5 h-3.5" /> จำนวนเก้าอี้</Label>
              <Input type="number" v-model.number="roomForm.chairCount" min="0" />
            </div>
          </div>
          <div class="space-y-1.5">
            <Label class="flex items-center gap-1"><UserCog class="w-3.5 h-3.5" /> ผู้รับผิดชอบประจำห้อง</Label>
            <Select :model-value="roomForm.responsibleId" @update:model-value="roomForm.responsibleId = String($event)">
              <SelectTrigger><SelectValue placeholder="เลือกผู้รับผิดชอบ (สิทธิ์ดูตารางห้องตัวเอง)" /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="u in users" :key="u.id" :value="String(u.id)">
                  {{ u.name || u.username }}{{ u.position ? ` — ${u.position}` : "" }}
                </SelectItem>
              </SelectContent>
            </Select>
            <p class="text-xs text-muted-foreground">ผู้รับผิดชอบจะเห็นตารางการจองของห้องนี้ในส่วน "ห้องที่ฉันเป็นผู้รับผิดชอบ"</p>
          </div>

          <div class="space-y-1.5">
            <div class="flex items-center justify-between">
              <Label>อุปกรณ์ประจำห้อง (เครื่องเสียง/ภาพ และอื่น ๆ)</Label>
              <Button variant="outline" size="sm" @click="addEquipmentRow()"><Plus class="w-3.5 h-3.5 mr-1" /> เพิ่มอุปกรณ์</Button>
            </div>
            <div v-if="roomForm.equipment.length === 0" class="text-xs text-muted-foreground">ยังไม่มีอุปกรณ์</div>
            <div v-for="(eq, i) in roomForm.equipment" :key="i" class="grid grid-cols-[1fr_1fr_80px_36px] gap-2 items-center">
              <Select :model-value="eq.equipmentType" @update:model-value="eq.equipmentType = String($event)">
                <SelectTrigger class="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="opt in equipmentOptions" :key="opt" :value="opt">{{ equipmentLabel[opt] }}</SelectItem>
                </SelectContent>
              </Select>
              <Input v-model="eq.name" placeholder="รายละเอียด (ถ้ามี)" class="h-9" />
              <Input type="number" v-model.number="eq.quantity" min="1" class="h-9" />
              <Button variant="ghost" size="icon" class="h-9 w-9 text-destructive" @click="roomForm.equipment.splice(i, 1)">
                <Trash2 class="w-4 h-4" />
              </Button>
            </div>
          </div>

          <div class="rounded-lg border p-3 space-y-3">
            <div class="flex items-center gap-2">
              <Switch id="hasDining" v-model:checked="roomForm.hasDining" />
              <Label for="hasDining" class="cursor-pointer flex items-center gap-1.5">
                <UtensilsCrossed class="w-4 h-4 text-amber-600" /> มีสถานที่รับประทานอาหาร
              </Label>
            </div>
            <div v-if="roomForm.hasDining" class="space-y-1.5">
              <Label class="text-xs">รายละเอียดสถานที่รับประทานอาหาร</Label>
              <Textarea
                v-model="roomForm.diningDetail"
                rows="2"
                placeholder="เช่น มีโซนอาหารว่างในห้อง, ใกล้โรงอาหารกลางชั้น 1, ห้องรับรองพร้อมกาแฟ..."
              />
            </div>
          </div>

          <div class="space-y-1.5">
            <Label>คำอธิบาย</Label>
            <Textarea v-model="roomForm.description" rows="2" />
          </div>
        </div>
        <DialogFooter>
          <Button :disabled="roomSaving" @click="saveRoom()">
            <Loader2 v-if="roomSaving" class="w-4 h-4 mr-1.5 animate-spin" /> บันทึกห้องประชุม
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Dialog รายละเอียดห้อง + แกลเลอรีรูป -->
    <Dialog :open="detailOpen" @update:open="detailOpen = $event">
      <DialogContent class="max-w-3xl max-h-[90vh] overflow-y-auto" v-if="detailRoom">
        <DialogHeader>
          <DialogTitle>{{ detailRoom.name }}</DialogTitle>
          <DialogDescription class="flex items-center gap-2 flex-wrap">
            <span class="flex items-center gap-1"><Building2 class="w-3.5 h-3.5" /> {{ detailRoom.building || "ไม่ระบุตึก" }} · ชั้น {{ detailRoom.floor || "-" }}</span>
            <span v-if="detailRoom.location" class="flex items-center gap-1"><MapPin class="w-3.5 h-3.5" /> {{ detailRoom.location }}</span>
          </DialogDescription>
        </DialogHeader>

        <div class="space-y-4">
          <!-- แกลเลอรีรูป -->
          <div>
            <div class="flex items-center justify-between mb-2">
              <span class="text-sm font-medium flex items-center gap-1.5"><Camera class="w-4 h-4" /> รูปห้องประชุม</span>
              <label v-if="isAdmin" class="cursor-pointer">
                <input type="file" accept="image/*" multiple class="hidden" @change="onUploadImages($event)" />
                <span class="inline-flex items-center gap-1.5 text-sm text-primary hover:underline">
                  <Loader2 v-if="uploadingImages" class="w-3.5 h-3.5 animate-spin" />
                  <ImagePlus v-else class="w-3.5 h-3.5" />
                  อัปโหลดรูป
                </span>
              </label>
            </div>
            <div v-if="detailRoom.images.length === 0" class="h-48 rounded-lg bg-muted flex items-center justify-center text-sm text-muted-foreground">
              ยังไม่มีรูปห้อง
            </div>
            <div v-else class="grid grid-cols-4 gap-2">
              <div v-for="img in detailRoom.images" :key="img.id" class="relative group rounded-lg overflow-hidden border aspect-video">
                <img :src="imageUrl(img.id)" class="w-full h-full object-cover" :alt="img.file_name" />
                <Badge v-if="img.is_cover" class="absolute top-1 left-1 text-[10px]">ปก</Badge>
                <div v-if="isAdmin" class="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                  <Button v-if="!img.is_cover" variant="secondary" size="icon" class="h-8 w-8" title="ตั้งเป็นรูปปก" @click="setCover(img)">
                    <Star class="w-4 h-4" />
                  </Button>
                  <Button variant="destructive" size="icon" class="h-8 w-8" @click="deleteImage(img)">
                    <Trash2 class="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </div>
          </div>

          <!-- ข้อมูลห้อง -->
          <div class="grid grid-cols-3 gap-3 text-center">
            <div class="rounded-lg bg-muted/50 py-3">
              <div class="text-xl font-bold flex items-center justify-center gap-1.5"><Users class="w-4 h-4 text-primary" /> {{ detailRoom.capacity }}</div>
              <div class="text-xs text-muted-foreground">ความจุ (คน)</div>
            </div>
            <div class="rounded-lg bg-muted/50 py-3">
              <div class="text-xl font-bold flex items-center justify-center gap-1.5"><Table2 class="w-4 h-4 text-primary" /> {{ detailRoom.table_count ?? "-" }}</div>
              <div class="text-xs text-muted-foreground">โต๊ะ</div>
            </div>
            <div class="rounded-lg bg-muted/50 py-3">
              <div class="text-xl font-bold flex items-center justify-center gap-1.5"><Armchair class="w-4 h-4 text-primary" /> {{ detailRoom.chair_count ?? "-" }}</div>
              <div class="text-xs text-muted-foreground">เก้าอี้</div>
            </div>
          </div>

          <div class="rounded-lg border p-3 space-y-2 text-sm">
            <div class="flex items-center gap-2">
              <UserCog class="w-4 h-4 text-muted-foreground" />
              <span class="text-muted-foreground">ผู้รับผิดชอบประจำห้อง:</span>
              <span class="font-medium">{{ detailRoom.responsible?.name || "ไม่ระบุ" }}</span>
            </div>
            <div>
              <span class="text-muted-foreground">อุปกรณ์:</span>
              <div class="flex flex-wrap gap-1 mt-1">
                <Badge v-for="e in detailRoom.equipment" :key="e.id" variant="outline" class="font-normal">
                  {{ e.name || equipmentLabel[e.equipment_type] || e.equipment_type }}<span v-if="e.quantity > 1" class="text-muted-foreground"> ×{{ e.quantity }}</span>
                </Badge>
                <span v-if="detailRoom.equipment.length === 0" class="text-muted-foreground">ไม่มี</span>
              </div>
            </div>
            <div class="flex items-start gap-2">
              <UtensilsCrossed class="w-4 h-4 mt-0.5" :class="detailRoom.has_dining ? 'text-amber-600' : 'text-muted-foreground'" />
              <div>
                <span class="text-muted-foreground">สถานที่รับประทานอาหาร:</span>
                <span v-if="detailRoom.has_dining" class="font-medium text-emerald-600 dark:text-emerald-400 ml-1">มี</span>
                <span v-else class="ml-1">ไม่มี</span>
                <p v-if="detailRoom.dining_detail" class="text-muted-foreground text-xs mt-0.5">{{ detailRoom.dining_detail }}</p>
              </div>
            </div>
            <p v-if="detailRoom.description" class="text-muted-foreground">{{ detailRoom.description }}</p>
          </div>

          <div class="flex gap-2 justify-end">
            <Button variant="outline" @click="openDisplay(detailRoom.id)">
              <MonitorPlay class="w-4 h-4 mr-1.5" /> เปิดหน้าจอ TV ห้องนี้
            </Button>
            <Button @click="detailOpen = false; openBooking(detailRoom, 9)">จองห้องนี้</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>
