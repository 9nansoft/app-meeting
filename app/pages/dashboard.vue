<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useMeetingApi } from "@/composables/useMeetingApi";
import {
  fmtDateTime, fmtTime, meetingStatusLabel, actionStatusLabels, jobTypeLabel, dayjs,
} from "@/utils/meeting-format";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import {
  CalendarClock, DoorOpen, ListTodo, FileCheck2, Sparkles, ArrowRight,
  CircleDot, CircleCheck, Loader2,
} from "lucide-vue-next";

useSeoMeta({ title: "Dashboard | AI Smart Meeting" });

const { api, call } = useMeetingApi();
const loading = ref(true);
const dash = ref<any>(null);

async function load() {
  loading.value = true;
  const data = await call(() => api.dashboard.get(), { silent: true });
  if (data) dash.value = data;
  loading.value = false;
}

onMounted(load);

const statusVariant = (s: string) =>
  s === "in_progress" ? "destructive" : s === "completed" ? "secondary" : "outline";
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between flex-wrap gap-3">
      <div>
        <h1 class="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Sparkles class="w-6 h-6 text-primary" /> Dashboard
        </h1>
        <p class="text-muted-foreground mt-1">
          ภาพรวมการประชุม ห้องว่าง งานที่ต้องติดตาม และรายงานที่รออนุมัติ
        </p>
      </div>
      <div class="flex gap-2">
        <Button variant="outline" @click="navigateTo('/rooms')">
          <CalendarClock class="w-4 h-4 mr-1.5" /> จองห้องประชุม
        </Button>
        <Button @click="navigateTo('/meetings')">
          + สร้างการประชุม
        </Button>
      </div>
    </div>

    <!-- Stat cards -->
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <Card v-for="i in 4" v-if="loading" :key="i">
        <CardContent class="pt-6"><Skeleton class="h-16 w-full" /></CardContent>
      </Card>
      <template v-else-if="dash">
        <Card class="border-l-4 border-l-blue-500">
          <CardHeader class="pb-2"><CardDescription class="flex items-center gap-1.5"><CalendarClock class="w-4 h-4" /> การประชุมวันนี้</CardDescription></CardHeader>
          <CardContent>
            <div class="text-3xl font-bold">{{ dash.stats.todayMeetingCount }}</div>
          </CardContent>
        </Card>
        <Card class="border-l-4 border-l-emerald-500">
          <CardHeader class="pb-2"><CardDescription class="flex items-center gap-1.5"><DoorOpen class="w-4 h-4" /> ห้องว่างตอนนี้</CardDescription></CardHeader>
          <CardContent>
            <div class="text-3xl font-bold">{{ dash.stats.freeRoomCount }} <span class="text-base font-normal text-muted-foreground">/ {{ dash.stats.totalRoomCount }}</span></div>
          </CardContent>
        </Card>
        <Card class="border-l-4 border-l-amber-500">
          <CardHeader class="pb-2"><CardDescription class="flex items-center gap-1.5"><ListTodo class="w-4 h-4" /> งานของฉันที่ค้าง</CardDescription></CardHeader>
          <CardContent>
            <div class="text-3xl font-bold">
              {{ dash.stats.myOpenActionCount }}
              <Badge v-if="dash.stats.overdueCount > 0" variant="destructive" class="ml-1">เลยกำหนด {{ dash.stats.overdueCount }}</Badge>
            </div>
          </CardContent>
        </Card>
        <Card class="border-l-4 border-l-purple-500">
          <CardHeader class="pb-2"><CardDescription class="flex items-center gap-1.5"><FileCheck2 class="w-4 h-4" /> รายงานรออนุมัติ</CardDescription></CardHeader>
          <CardContent>
            <div class="text-3xl font-bold">{{ dash.stats.pendingApprovalCount }}</div>
          </CardContent>
        </Card>
      </template>
    </div>

    <div class="grid lg:grid-cols-2 gap-6" v-if="!loading && dash">
      <!-- การประชุมวันนี้ -->
      <Card>
        <CardHeader>
          <CardTitle class="text-base">การประชุมวันนี้</CardTitle>
          <CardDescription>{{ dayjs(dash.today).format("D MMMM BBBB") }}</CardDescription>
        </CardHeader>
        <CardContent>
          <div v-if="dash.todayMeetings.length === 0" class="py-8 text-center text-sm text-muted-foreground">
            ไม่มีการประชุมวันนี้
          </div>
          <div v-else class="space-y-3">
            <div
              v-for="m in dash.todayMeetings"
              :key="m.id"
              class="flex items-center gap-3 p-3 rounded-lg border hover:bg-muted/50 cursor-pointer transition-colors"
              @click="navigateTo(`/meetings/${m.id}`)"
            >
              <div class="text-center shrink-0 w-16">
                <div class="font-bold">{{ fmtTime(m.start_time) }}</div>
                <div class="text-xs text-muted-foreground">{{ fmtTime(m.end_time) }}</div>
              </div>
              <div class="flex-1 min-w-0">
                <div class="font-medium truncate">{{ m.title }}</div>
                <div class="text-xs text-muted-foreground truncate">{{ m.location_text || "ไม่ระบุสถานที่" }} · ประธาน: {{ m.organizer_name || "-" }}</div>
              </div>
              <Badge :variant="statusVariant(m.status) as any">{{ meetingStatusLabel[m.status] || m.status }}</Badge>
              <ArrowRight class="w-4 h-4 text-muted-foreground" />
            </div>
          </div>
        </CardContent>
      </Card>

      <!-- ห้องว่าง + งานของฉัน -->
      <div class="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle class="text-base flex items-center gap-2"><DoorOpen class="w-4 h-4" /> ห้องว่างตอนนี้</CardTitle>
          </CardHeader>
          <CardContent>
            <div v-if="dash.freeRooms.length === 0" class="py-4 text-center text-sm text-muted-foreground">
              ห้องประชุมเต็มทั้งหมด
            </div>
            <div v-else class="flex flex-wrap gap-2">
              <Badge v-for="r in dash.freeRooms" :key="r.id" variant="outline" class="py-1.5 px-3">
                {{ r.name }} <span class="text-muted-foreground ml-1">({{ r.capacity }} ที่นั่ง)</span>
              </Badge>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader class="flex-row items-center justify-between space-y-0">
            <CardTitle class="text-base flex items-center gap-2"><ListTodo class="w-4 h-4" /> งานที่ต้องติดตาม</CardTitle>
            <Button variant="ghost" size="sm" @click="navigateTo('/followup')">ดูทั้งหมด <ArrowRight class="w-3.5 h-3.5 ml-1" /></Button>
          </CardHeader>
          <CardContent>
            <div v-if="dash.myOpenActions.length === 0" class="py-4 text-center text-sm text-muted-foreground">
              ไม่มีงานค้าง — เยี่ยม!
            </div>
            <div v-else class="space-y-2">
              <div v-for="a in dash.myOpenActions.slice(0, 5)" :key="a.id" class="flex items-center gap-2 text-sm">
                <CircleDot v-if="a.status === 'pending'" class="w-4 h-4 text-amber-500 shrink-0" />
                <Loader2 v-else-if="a.status === 'in_progress'" class="w-4 h-4 text-blue-500 shrink-0 animate-spin" />
                <CircleCheck v-else class="w-4 h-4 text-muted-foreground shrink-0" />
                <span class="flex-1 truncate">{{ a.title }}</span>
                <span v-if="a.due_date" class="text-xs shrink-0" :class="dayjs(a.due_date).isBefore(dayjs(), 'day') ? 'text-destructive font-medium' : 'text-muted-foreground'">
                  ส่ง {{ dayjs(a.due_date).format("D MMM") }}
                </span>
                <Badge variant="outline" class="text-[11px] shrink-0">{{ actionStatusLabels[a.status] }}</Badge>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>

    <!-- รายงานรออนุมัติ + AI jobs -->
    <div class="grid lg:grid-cols-2 gap-6" v-if="!loading && dash">
      <Card>
        <CardHeader><CardTitle class="text-base flex items-center gap-2"><FileCheck2 class="w-4 h-4" /> รายงานที่รออนุมัติ</CardTitle></CardHeader>
        <CardContent>
          <div v-if="dash.pendingApprovals.length === 0" class="py-4 text-center text-sm text-muted-foreground">ไม่มีรายงานรออนุมัติ</div>
          <div v-else class="space-y-2">
            <div
              v-for="p in dash.pendingApprovals"
              :key="p.id"
              class="flex items-center justify-between gap-2 p-2.5 rounded-lg border cursor-pointer hover:bg-muted/50"
              @click="navigateTo(`/meetings/${p.meeting_id}/minutes`)"
            >
              <div class="min-w-0">
                <div class="text-sm font-medium truncate">{{ p.meeting_title }}</div>
                <div class="text-xs text-muted-foreground">อัปเดต {{ dayjs(p.updated_at).fromNow() }}</div>
              </div>
              <Badge variant="destructive">รออนุมัติ</Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle class="text-base flex items-center gap-2"><Sparkles class="w-4 h-4" /> งาน AI ล่าสุด</CardTitle></CardHeader>
        <CardContent>
          <div v-if="dash.recentJobs.length === 0" class="py-4 text-center text-sm text-muted-foreground">ยังไม่มีงาน AI</div>
          <div v-else class="space-y-2">
            <div v-for="j in dash.recentJobs" :key="j.id" class="flex items-center gap-2 text-sm">
              <span class="w-2 h-2 rounded-full shrink-0" :class="{
                'bg-emerald-500': j.status === 'completed',
                'bg-blue-500 animate-pulse': j.status === 'processing' || j.status === 'queued',
                'bg-destructive': j.status === 'failed',
                'bg-muted-foreground/40': j.status === 'cancelled',
              }" />
              <span class="flex-1">{{ jobTypeLabel[j.job_type] || j.job_type }}</span>
              <span class="text-xs text-muted-foreground">{{ dayjs(j.created_at).fromNow() }}</span>
              <Badge variant="outline" class="text-[11px]">{{ j.status }}</Badge>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>

    <!-- การประชุมถัดไปของฉัน -->
    <Card v-if="!loading && dash && dash.upcoming.length > 0">
      <CardHeader><CardTitle class="text-base">การประชุมถัดไปของฉัน (7 วัน)</CardTitle></CardHeader>
      <CardContent>
        <div class="grid md:grid-cols-2 gap-3">
          <div
            v-for="m in dash.upcoming"
            :key="m.id"
            class="p-3 rounded-lg border hover:bg-muted/50 cursor-pointer transition-colors"
            @click="navigateTo(`/meetings/${m.id}`)"
          >
            <div class="font-medium truncate">{{ m.title }}</div>
            <div class="text-xs text-muted-foreground mt-0.5">{{ fmtDateTime(m.start_time) }} · {{ m.location_text || "-" }}</div>
          </div>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
