<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useIntervalFn } from "@vueuse/core";
import { dayjs } from "@/utils/meeting-format";
import {
  Building2, MapPin, Clock3, Users, CalendarDays, MonitorPlay, Radio, Armchair,
} from "lucide-vue-next";

/**
 * หน้าจอแสดงผลหน้าห้องประชุม (TV Display) — สาธารณะ ไม่ต้อง login
 * - แสดงภาพรวมทุกห้อง หรือกรองเฉพาะห้อง/ตึกที่เลือก (?room= / ?building=)
 * - auto-refresh ทุก 30 วินาที, นาฬิกาเดินสด
 * - ทีวีที่หน้าห้อง: เปิด http://<host>/display?room=<roomId> ค้างไว้ได้เลย
 */
definePageMeta({ layout: "display" });
useSeoMeta({ title: "ตารางห้องประชุมวันนี้" });

const route = useRoute();

const rooms = ref<any[]>([]);
const data = ref<any>(null);
const selectedRoom = ref<string>((route.query.room as string) || "all");
const selectedBuilding = ref<string>((route.query.building as string) || "all");
const now = ref(dayjs());
const loading = ref(true);

async function load() {
  try {
    const roomsRes = await $fetch("/api/public/rooms");
    rooms.value = (roomsRes as any).rooms ?? [];
  } catch {
    /* silent */
  }
  await refresh();
  loading.value = false;
}

async function refresh() {
  const query: Record<string, string> = {};
  if (selectedRoom.value !== "all") query.roomId = selectedRoom.value;
  else if (selectedBuilding.value !== "all") query.building = selectedBuilding.value;
  try {
    data.value = await $fetch("/api/public/today", { query });
  } catch {
    /* silent */
  }
}

onMounted(load);
useIntervalFn(refresh, 30_000); // auto refresh ทุก 30 วินาที
useIntervalFn(() => (now.value = dayjs()), 1000); // นาฬิกาเดินสด

const buildings = computed(() =>
  [...new Set(rooms.value.map((r: any) => r.building).filter(Boolean))] as string[],
);

function selectRoom(id: string) {
  selectedRoom.value = id;
  selectedBuilding.value = "all";
  refresh();
}

function selectBuilding(b: string) {
  selectedBuilding.value = b;
  selectedRoom.value = "all";
  refresh();
}

const selectedRoomDetail = computed(() =>
  selectedRoom.value !== "all" ? rooms.value.find((r: any) => r.id === selectedRoom.value) : null,
);

const fmtTime = (v: string) => dayjs(v).format("HH:mm");
const roomCount = computed(() => data.value?.rooms?.length ?? 0);

function progress(b: any) {
  const start = dayjs(b.start_time);
  const end = dayjs(b.end_time);
  const total = end.diff(start, "second");
  const passed = now.value.diff(start, "second");
  return total > 0 ? Math.min(Math.max((passed / total) * 100, 0), 100) : 0;
}
</script>

<template>
  <div class="w-screen h-screen bg-slate-950 text-slate-100 flex flex-col overflow-hidden select-none">
    <!-- แถบหัว -->
    <header class="shrink-0 border-b border-slate-800 px-10 py-5 flex items-center justify-between gap-6">
      <div class="flex items-center gap-4 min-w-0">
        <div class="h-14 w-14 rounded-2xl bg-gradient-to-br from-blue-500 to-violet-500 flex items-center justify-center shrink-0">
          <CalendarDays class="w-8 h-8 text-white" />
        </div>
        <div class="min-w-0">
          <h1 class="text-3xl font-bold tracking-tight truncate">ตารางห้องประชุมวันนี้</h1>
          <p class="text-slate-400 text-lg">
            {{ now.format("dddd D MMMM BBBB") }}
          </p>
        </div>
      </div>
      <div class="text-right shrink-0">
        <div class="text-6xl font-bold font-mono tabular-nums leading-none">{{ now.format("HH:mm") }}</div>
        <div class="text-slate-400 text-lg mt-1">{{ now.format("ss วินาที") }}</div>
      </div>
    </header>

    <!-- แถบกรองห้อง/ตึก -->
    <div class="shrink-0 px-10 py-3 flex items-center gap-2 flex-wrap border-b border-slate-800/60 bg-slate-900/40">
      <MonitorPlay class="w-5 h-5 text-slate-500 shrink-0" />
      <button
        class="px-4 py-1.5 rounded-full text-base transition-colors"
        :class="selectedRoom === 'all' && selectedBuilding === 'all'
          ? 'bg-blue-500 text-white font-semibold'
          : 'bg-slate-800 text-slate-300 hover:bg-slate-700'"
        @click="selectRoom('all')"
      >
        ทุกห้อง
      </button>
      <template v-for="b in buildings" :key="b">
        <button
          class="px-4 py-1.5 rounded-full text-base transition-colors flex items-center gap-1.5"
          :class="selectedBuilding === b
            ? 'bg-violet-500 text-white font-semibold'
            : 'bg-slate-800 text-slate-300 hover:bg-slate-700'"
          @click="selectBuilding(b)"
        >
          <Building2 class="w-4 h-4" /> {{ b }}
        </button>
      </template>
      <span class="w-px h-6 bg-slate-700 mx-1" />
      <template v-for="r in rooms" :key="r.id">
        <button
          class="px-4 py-1.5 rounded-full text-base transition-colors"
          :class="selectedRoom === r.id
            ? 'bg-blue-500 text-white font-semibold'
            : 'bg-slate-800 text-slate-300 hover:bg-slate-700'"
          @click="selectRoom(r.id)"
        >
          {{ r.name }}
        </button>
      </template>
    </div>

    <!-- เนื้อหา -->
    <div class="flex-1 overflow-y-auto px-10 py-6" v-if="!loading && data">
      <!-- โหมดเฉพาะห้อง: การ์ดใหญ่ -->
      <template v-if="selectedRoomDetail">
        <div class="grid grid-cols-3 gap-6 h-full">
          <!-- ข้อมูลห้อง -->
          <div class="space-y-4">
            <div class="rounded-2xl bg-slate-900 border border-slate-800 overflow-hidden">
              <div class="h-56 bg-slate-800 flex items-center justify-center">
                <img
                  v-if="selectedRoomDetail.cover_image_id"
                  :src="`/api/public/room-images/${selectedRoomDetail.cover_image_id}/raw`"
                  :alt="selectedRoomDetail.name"
                  class="w-full h-full object-cover"
                />
                <MapPin v-else class="w-16 h-16 text-slate-600" />
              </div>
              <div class="p-5 space-y-2">
                <h2 class="text-2xl font-bold">{{ selectedRoomDetail.name }}</h2>
                <div class="text-slate-400 text-lg flex items-center gap-2">
                  <Building2 class="w-5 h-5" /> {{ selectedRoomDetail.building || "-" }} · ชั้น {{ selectedRoomDetail.floor || "-" }}
                </div>
                <div class="text-slate-400 text-lg flex items-center gap-2">
                  <Users class="w-5 h-5" /> รองรับ {{ selectedRoomDetail.capacity }} คน
                </div>
              </div>
            </div>
          </div>

          <!-- สถานะปัจจุบัน + ถัดไป -->
          <div class="col-span-2 space-y-4">
            <div
              v-if="data.current.length > 0"
              class="rounded-2xl border-2 border-red-500/60 bg-red-500/10 p-6"
            >
              <div class="flex items-center gap-3 text-red-400 text-xl font-semibold">
                <Radio class="w-6 h-6 animate-pulse" /> กำลังประชุมอยู่ขณะนี้
              </div>
              <div v-for="b in data.current" :key="b.id" class="mt-3">
                <div class="text-4xl font-bold leading-tight">{{ b.title }}</div>
                <div class="text-2xl text-slate-300 mt-2 font-mono">
                  {{ fmtTime(b.start_time) }} – {{ fmtTime(b.end_time) }}
                  <span class="text-slate-400 font-sans">(เหลืออีก {{ dayjs(b.end_time).diff(now, "minute") }} นาที)</span>
                </div>
                <div class="mt-3 h-2 rounded-full bg-slate-800 overflow-hidden">
                  <div class="h-full bg-red-500 rounded-full transition-all" :style="{ width: progress(b) + '%' }" />
                </div>
              </div>
            </div>

            <div v-else class="rounded-2xl border-2 border-emerald-500/60 bg-emerald-500/10 p-6">
              <div class="flex items-center gap-3 text-emerald-400 text-xl font-semibold">
                <Armchair class="w-6 h-6" /> ห้องว่างอยู่ขณะนี้
              </div>
              <div v-if="data.upcoming.length" class="mt-3 text-2xl text-slate-300">
                การประชุมถัดไป: <span class="font-semibold text-white">{{ data.upcoming[0].title }}</span>
                เวลา {{ fmtTime(data.upcoming[0].start_time) }} น.
                (อีก {{ dayjs(data.upcoming[0].start_time).diff(now, "minute") }} นาที)
              </div>
              <div v-else class="mt-3 text-2xl text-slate-300">ไม่มีการจองเพิ่มเติมในวันนี้</div>
            </div>

            <!-- ตารางวันนี้ของห้องนี้ -->
            <div class="rounded-2xl bg-slate-900 border border-slate-800 p-5">
              <div class="text-xl font-semibold text-slate-300 mb-3 flex items-center gap-2">
                <Clock3 class="w-5 h-5" /> ตารางวันนี้ทั้งหมด
              </div>
              <div v-if="roomCount === 0 || data.rooms[0]?.bookings.length === 0" class="text-slate-500 text-xl py-6 text-center">
                ไม่มีการจองห้องนี้ในวันนี้
              </div>
              <div v-else class="space-y-2.5">
                <div
                  v-for="b in data.rooms[0]?.bookings"
                  :key="b.id"
                  class="flex items-center gap-5 p-4 rounded-xl"
                  :class="{
                    'bg-red-500/15 border border-red-500/40': b.status === 'current',
                    'bg-slate-800/60 opacity-50': b.status === 'finished',
                    'bg-slate-800/60': b.status === 'upcoming',
                  }"
                >
                  <div class="font-mono text-2xl tabular-nums shrink-0" :class="b.status === 'current' ? 'text-red-300' : 'text-slate-200'">
                    {{ fmtTime(b.start_time) }}–{{ fmtTime(b.end_time) }}
                  </div>
                  <div class="text-2xl font-medium truncate flex-1">{{ b.title }}</div>
                  <div
                    v-if="b.status === 'current'"
                    class="shrink-0 px-3 py-1 rounded-full bg-red-500 text-white text-base font-semibold"
                  >กำลังประชุม</div>
                  <div
                    v-else-if="b.status === 'finished'"
                    class="shrink-0 px-3 py-1 rounded-full bg-slate-700 text-slate-300 text-base"
                  >เสร็จแล้ว</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- โหมดภาพรวม: การ์ดทุกห้อง -->
      <template v-else>
        <div v-if="roomCount === 0" class="h-full flex items-center justify-center text-slate-500 text-3xl">
          ไม่มีการจองห้องประชุมในวันนี้
        </div>
        <div v-else class="grid gap-5" :class="roomCount <= 2 ? 'grid-cols-2' : roomCount <= 3 ? 'grid-cols-3' : 'grid-cols-2 xl:grid-cols-3'">
          <div
            v-for="room in data.rooms"
            :key="room.room_id"
            class="rounded-2xl bg-slate-900 border border-slate-800 p-5 flex flex-col"
            :class="{ 'border-red-500/50': room.bookings.some((b: any) => b.status === 'current') }"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <h3 class="text-2xl font-bold truncate">{{ room.room_name }}</h3>
                <div class="text-slate-400 text-lg flex items-center gap-1.5 mt-0.5">
                  <Building2 class="w-4 h-4" /> {{ room.building || "-" }} · ชั้น {{ room.floor || "-" }}
                </div>
              </div>
              <div
                v-if="room.bookings.some((b: any) => b.status === 'current')"
                class="shrink-0 flex items-center gap-1.5 px-3 py-1 rounded-full bg-red-500 text-white text-base font-semibold"
              >
                <Radio class="w-4 h-4 animate-pulse" /> กำลังประชุม
              </div>
              <div
                v-else-if="room.bookings.some((b: any) => b.status === 'upcoming')"
                class="shrink-0 px-3 py-1 rounded-full bg-amber-500/20 text-amber-300 text-base font-semibold"
              >มีคิวถัดไป</div>
              <div
                v-else
                class="shrink-0 px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-300 text-base font-semibold"
              >ว่างทั้งวัน</div>
            </div>
            <div class="mt-4 space-y-2 flex-1">
              <div
                v-for="b in room.bookings.slice(0, 5)"
                :key="b.id"
                class="flex items-center gap-3 p-2.5 rounded-lg"
                :class="{
                  'bg-red-500/15': b.status === 'current',
                  'bg-slate-800/60 opacity-50': b.status === 'finished',
                  'bg-slate-800/40': b.status === 'upcoming',
                }"
              >
                <span class="font-mono text-lg tabular-nums shrink-0">{{ fmtTime(b.start_time) }}–{{ fmtTime(b.end_time) }}</span>
                <span class="text-lg truncate">{{ b.title }}</span>
              </div>
              <div v-if="room.bookings.length > 5" class="text-slate-500 text-base text-center pt-1">
                และอีก {{ room.bookings.length - 5 }} รายการ
              </div>
              <div v-if="room.bookings.length === 0" class="text-slate-600 text-lg text-center py-6">ไม่มีการจองวันนี้</div>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- footer -->
    <footer class="shrink-0 border-t border-slate-800 px-10 py-2.5 flex items-center justify-between text-slate-500 text-base">
      <span>อัปเดตอัตโนมัติทุก 30 วินาที · จองห้องประชุมได้ที่ระบบ AI Smart Meeting</span>
      <span class="font-mono">{{ now.format("D/M/BBBB HH:mm:ss") }}</span>
    </footer>
  </div>
</template>
