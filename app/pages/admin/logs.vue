<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { toast } from "vue-sonner";
import { useAuth } from "@/composables/useAuth";
import { useMeetingApi } from "@/composables/useMeetingApi";
import { dayjs } from "@/utils/meeting-format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  ScrollText, Loader2, ShieldCheck, ShieldAlert, Download, RefreshCw, Search, ChevronLeft, ChevronRight, FileWarning,
} from "lucide-vue-next";

useSeoMeta({ title: "Log ระบบ | AI Smart Meeting" });

const { user: authUser } = useAuth();
const { api, call } = useMeetingApi();

const EVENT_TYPES = [
  { value: "auth.login_success", label: "เข้าสู่ระบบสำเร็จ" },
  { value: "auth.login_failed", label: "เข้าสู่ระบบไม่สำเร็จ" },
  { value: "auth.login_blocked", label: "บัญชีถูกปิดใช้งาน (พยายาม login)" },
  { value: "auth.logout", label: "ออกจากระบบ" },
  { value: "auth.invalid_token", label: "Session/Token ไม่ถูกต้อง" },
  { value: "access.unauthorized", label: "เรียก API โดยไม่มีสิทธิ์ (401)" },
  { value: "access.forbidden", label: "บทบาทไม่เพียงพอ (403)" },
  { value: "http.request", label: "การเรียกใช้ API (access log)" },
  { value: "user.register", label: "สมัครบัญชีใหม่" },
  { value: "log.exported", label: "ส่งออก log" },
  { value: "log.integrity_failed", label: "ตรวจพบ log ถูกแก้ไข" },
] as const;

const SEVERITIES = [
  { value: "info", label: "ปกติ (info)" },
  { value: "warning", label: "ต้องระวัง (warning)" },
  { value: "error", label: "ผิดพลาด (error)" },
];

const eventLabel = (t: string) => EVENT_TYPES.find((e) => e.value === t)?.label ?? t;

const severityBadge = (s: string) =>
  ({
    info: "bg-muted text-muted-foreground border-border",
    warning: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30",
    error: "bg-destructive/10 text-destructive border-destructive/30",
  } as Record<string, string>)[s] ?? "";

// ---------- ตัวกรอง ----------
const filters = ref({ eventType: "", severity: "", search: "", from: "", to: "" });
const loading = ref(true);
const logs = ref<any[]>([]);
const total = ref(0);
const page = ref(0);
const pageSize = 100;

function buildQuery() {
  const query: Record<string, any> = { limit: pageSize, offset: page.value * pageSize };
  if (filters.value.eventType) query.eventType = filters.value.eventType;
  if (filters.value.severity) query.severity = filters.value.severity;
  if (filters.value.search) {
    // ช่องค้นหาเดียว — ถ้าเป็นเลข/จุด ค้นเป็น IP ไม่งั้นค้นเป็น username
    if (/^[\d.]+$/.test(filters.value.search.trim())) query.ip = filters.value.search.trim();
    else query.username = filters.value.search.trim();
  }
  if (filters.value.from) query.from = dayjs(filters.value.from).startOf("day").toISOString();
  if (filters.value.to) query.to = dayjs(filters.value.to).endOf("day").toISOString();
  return query;
}

async function loadLogs() {
  loading.value = true;
  const data = await call(() => (api.admin["security-logs"].get as any)({ query: buildQuery() }), { silent: true });
  if (data) {
    logs.value = data.logs ?? [];
    total.value = data.total ?? 0;
  }
  loading.value = false;
}

function applyFilters() {
  page.value = 0;
  void loadLogs();
}

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));

// ---------- สถิติ + integrity ----------
const stats = ref<any>(null);
const verifying = ref(false);
const verification = ref<any>(null);

async function loadStats() {
  const data = await call(() => (api.admin["security-logs"].stats.get as any)(), { silent: true });
  if (data) stats.value = data;
}

async function verifyIntegrity() {
  verifying.value = true;
  const data = await call(() => (api.admin["security-logs"].verify.get as any)(), { silent: true });
  verifying.value = false;
  if (data?.verification) {
    verification.value = data.verification;
    if (data.verification.valid) toast.success("Log ทั้งหมดถูกต้อง — ไม่พบการแก้ไข");
    else toast.error("พบความผิดปกติใน log โปรดตรวจสอบ!");
  }
}

// ---------- ส่งออก CSV ----------
async function exportCsv() {
  const params = new URLSearchParams();
  if (filters.value.eventType) params.set("eventType", filters.value.eventType);
  if (filters.value.from) params.set("from", dayjs(filters.value.from).startOf("day").toISOString());
  if (filters.value.to) params.set("to", dayjs(filters.value.to).endOf("day").toISOString());
  try {
    const res = await fetch(`/api/admin/security-logs/export?${params.toString()}`);
    if (!res.ok) {
      toast.error("ส่งออก log ไม่สำเร็จ");
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `security-logs-${dayjs().format("YYYYMMDD-HHmm")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("ดาวน์โหลด log แล้ว (การส่งออกถูกบันทึกไว้ใน log ด้วย)");
  } catch (err: any) {
    toast.error(err?.message || "ส่งออก log ไม่สำเร็จ");
  }
}

// ---------- รายละเอียดแถว ----------
const detailOpen = ref(false);
const detailRow = ref<any>(null);
function openDetail(row: any) {
  detailRow.value = row;
  detailOpen.value = true;
}

onMounted(async () => {
  if (authUser.value?.role !== "admin") {
    toast.error("หน้านี้สำหรับผู้ดูแลระบบเท่านั้น");
    await navigateTo("/dashboard");
    return;
  }
  await Promise.all([loadLogs(), loadStats()]);
});

const fmtTime = (t: string) => dayjs(t).format("DD/MM/YYYY HH:mm:ss");
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between flex-wrap gap-3">
      <div>
        <h1 class="text-2xl font-bold tracking-tight flex items-center gap-2">
          <ScrollText class="w-6 h-6 text-primary" /> Log ระบบ
        </h1>
        <p class="text-muted-foreground mt-1">
          บันทึกการเข้าถึงระบบและข้อมูลจราจรคอมพิวเตอร์ ตาม พ.ร.บ. การกระทำความผิดเกี่ยวกับคอมพิวเตอร์ (ฉบับที่ 2)
          พ.ศ. 2560 ม.26 — เก็บอย่างน้อย 90 วัน และป้องกันการแก้ไขด้วย hash chain
        </p>
      </div>
      <div class="flex items-center gap-2">
        <Button variant="outline" @click="exportCsv()">
          <Download class="w-4 h-4 mr-1.5" /> ส่งออก CSV
        </Button>
        <Button variant="outline" @click="Promise.all([loadLogs(), loadStats()])">
          <RefreshCw class="w-4 h-4 mr-1.5" /> รีเฟรช
        </Button>
      </div>
    </div>

    <!-- ความถูกต้องของ log + สถิติความผิดปกติ -->
    <div class="grid gap-4 md:grid-cols-3">
      <Card>
        <CardHeader class="pb-2">
          <CardTitle class="text-sm font-medium flex items-center gap-1.5">
            <ShieldCheck class="w-4 h-4 text-primary" /> ความถูกต้องของ log (Hash Chain)
          </CardTitle>
        </CardHeader>
        <CardContent class="space-y-2">
          <div v-if="verification" class="flex items-start gap-2">
            <Badge variant="outline" class="text-[11px]" :class="verification.valid ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30' : 'bg-destructive/10 text-destructive border-destructive/30'">
              {{ verification.valid ? "ถูกต้องครบถ้วน" : "พบความผิดปกติ" }}
            </Badge>
          </div>
          <p v-if="verification?.valid" class="text-xs text-muted-foreground">
            ตรวจแล้วทั้งหมด {{ verification.total.toLocaleString() }} แถว — ไม่มีแถวถูกแก้ไขหรือลบ
          </p>
          <div v-else-if="verification && !verification.valid" class="text-xs text-destructive space-y-1">
            <p class="flex items-center gap-1"><FileWarning class="w-3.5 h-3.5" /> {{ verification.reason }}</p>
            <p>แถวที่ขาด: id {{ verification.brokenAtId }} ({{ fmtTime(verification.brokenAtTime) }})</p>
          </div>
          <p v-else class="text-xs text-muted-foreground">
            ตรวจสอบว่า log ไม่ถูกแก้ไขหรือลบหลังบันทึก (ระบบตรวจอัตโนมัติทุก 1 ชั่วโมง)
          </p>
          <Button size="sm" variant="outline" :disabled="verifying" @click="verifyIntegrity()">
            <Loader2 v-if="verifying" class="w-3.5 h-3.5 mr-1 animate-spin" />
            <ShieldCheck v-else class="w-3.5 h-3.5 mr-1" />
            ตรวจสอบตอนนี้
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader class="pb-2">
          <CardTitle class="text-sm font-medium flex items-center gap-1.5">
            <ShieldAlert class="w-4 h-4 text-amber-500" /> Login ไม่สำเร็จ 7 วันล่าสุด
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div v-if="stats?.failedByIp?.length" class="space-y-1.5">
            <div v-for="f in stats.failedByIp" :key="f.ip" class="flex items-center justify-between text-xs">
              <span class="font-mono">{{ f.ip }}</span>
              <Badge variant="outline" class="text-[10px]" :class="f.count >= 10 ? 'bg-destructive/10 text-destructive border-destructive/30' : 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30'">
                {{ f.count }} ครั้ง
              </Badge>
            </div>
          </div>
          <p v-else class="text-xs text-muted-foreground">ไม่พบความพยายาม login ที่ผิดพลาด</p>
          <div v-if="stats?.failedByUsername?.length" class="mt-3 pt-3 border-t border-border/60">
            <p class="text-[11px] text-muted-foreground mb-1">บัญชีที่ถูกพยายามใช้:</p>
            <div class="flex flex-wrap gap-1">
              <Badge v-for="f in stats.failedByUsername" :key="f.username" variant="secondary" class="text-[10px] font-normal">
                @{{ f.username }} ({{ f.count }})
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader class="pb-2">
          <CardTitle class="text-sm font-medium">เหตุการณ์ 24 ชั่วโมงล่าสุด</CardTitle>
        </CardHeader>
        <CardContent>
          <div v-if="stats?.byType?.length" class="space-y-1.5 max-h-44 overflow-auto pr-1">
            <div v-for="e in stats.byType" :key="e.eventType" class="flex items-center justify-between text-xs">
              <span class="truncate mr-2">{{ eventLabel(e.eventType) }}</span>
              <span class="font-mono text-muted-foreground">{{ e.count.toLocaleString() }}</span>
            </div>
          </div>
          <p v-else class="text-xs text-muted-foreground">ยังไม่มีข้อมูล</p>
        </CardContent>
      </Card>
    </div>

    <!-- ตัวกรอง -->
    <Card>
      <CardContent class="pt-6">
        <div class="grid gap-3 md:grid-cols-6 items-end">
          <div class="space-y-1.5">
            <Label class="text-xs">เหตุการณ์</Label>
            <Select :model-value="filters.eventType" @update:model-value="filters.eventType = String($event)">
              <SelectTrigger><SelectValue placeholder="ทั้งหมด" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">ทั้งหมด</SelectItem>
                <SelectItem v-for="e in EVENT_TYPES" :key="e.value" :value="e.value">{{ e.label }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="space-y-1.5">
            <Label class="text-xs">ระดับ</Label>
            <Select :model-value="filters.severity" @update:model-value="filters.severity = String($event)">
              <SelectTrigger><SelectValue placeholder="ทั้งหมด" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">ทั้งหมด</SelectItem>
                <SelectItem v-for="s in SEVERITIES" :key="s.value" :value="s.value">{{ s.label }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="space-y-1.5 md:col-span-2">
            <Label class="text-xs">ค้นหา (ผู้ใช้ หรือ IP)</Label>
            <Input v-model="filters.search" placeholder="เช่น somchai หรือ 10.1.2.3" @keyup.enter="applyFilters()" />
          </div>
          <div class="space-y-1.5">
            <Label class="text-xs">จากวันที่</Label>
            <Input v-model="filters.from" type="date" />
          </div>
          <div class="space-y-1.5">
            <Label class="text-xs">ถึงวันที่</Label>
            <Input v-model="filters.to" type="date" />
          </div>
        </div>
        <div class="flex items-center gap-2 mt-3">
          <Button size="sm" @click="applyFilters()">
            <Search class="w-3.5 h-3.5 mr-1" /> กรอง
          </Button>
          <Button
            size="sm" variant="outline"
            @click="filters = { eventType: '', severity: '', search: '', from: '', to: '' }; applyFilters()"
          >
            ล้างตัวกรอง
          </Button>
        </div>
      </CardContent>
    </Card>

    <!-- ตาราง log -->
    <Card>
      <CardContent class="p-0">
        <div v-if="loading" class="p-4 space-y-3">
          <Skeleton v-for="i in 8" :key="i" class="h-10 w-full" />
        </div>
        <template v-else>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead class="w-36">เวลา</TableHead>
                <TableHead class="w-52">เหตุการณ์</TableHead>
                <TableHead>ผู้ใช้</TableHead>
                <TableHead>IP</TableHead>
                <TableHead>API</TableHead>
                <TableHead class="w-16">Status</TableHead>
                <TableHead class="w-24 text-right">Hash</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="log in logs" :key="log.id" class="cursor-pointer" @click="openDetail(log)">
                <TableCell class="text-xs font-mono whitespace-nowrap">{{ fmtTime(log.created_at) }}</TableCell>
                <TableCell>
                  <div class="flex items-center gap-1.5">
                    <Badge variant="outline" class="text-[10px]" :class="severityBadge(log.severity)">
                      {{ log.severity }}
                    </Badge>
                    <span class="text-xs">{{ eventLabel(log.event_type) }}</span>
                  </div>
                </TableCell>
                <TableCell class="text-xs">{{ log.username ? `@${log.username}` : "—" }}</TableCell>
                <TableCell class="text-xs font-mono">{{ log.ip ?? "—" }}</TableCell>
                <TableCell class="text-xs font-mono truncate max-w-52">
                  <span v-if="log.method" class="text-muted-foreground mr-1">{{ log.method }}</span>{{ log.path ?? "" }}
                </TableCell>
                <TableCell class="text-xs font-mono">{{ log.status_code ?? "—" }}</TableCell>
                <TableCell class="text-right">
                  <span class="text-[10px] font-mono text-muted-foreground" :title="log.entry_hash">
                    {{ log.entry_hash?.slice(0, 8) }}…
                  </span>
                </TableCell>
              </TableRow>
              <TableRow v-if="logs.length === 0">
                <TableCell colspan="7" class="text-center text-sm text-muted-foreground py-8">
                  ไม่พบ log ตามเงื่อนไขที่กรอง
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>

          <div class="flex items-center justify-between px-4 py-3 border-t border-border/60">
            <span class="text-xs text-muted-foreground">
              ทั้งหมด {{ total.toLocaleString() }} แถว · หน้า {{ page + 1 }}/{{ totalPages }}
            </span>
            <div class="flex items-center gap-2">
              <Button size="sm" variant="outline" :disabled="page === 0" @click="page--; loadLogs()">
                <ChevronLeft class="w-4 h-4" /> ก่อนหน้า
              </Button>
              <Button size="sm" variant="outline" :disabled="page + 1 >= totalPages" @click="page++; loadLogs()">
                ถัดไป <ChevronRight class="w-4 h-4" />
              </Button>
            </div>
          </div>
        </template>
      </CardContent>
    </Card>

    <!-- Dialog รายละเอียดแถว log -->
    <Dialog :open="detailOpen" @update:open="detailOpen = $event">
      <DialogContent class="max-w-2xl">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2">
            <Badge variant="outline" class="text-[11px]" :class="severityBadge(detailRow?.severity)">
              {{ detailRow?.severity }}
            </Badge>
            {{ eventLabel(detailRow?.event_type ?? "") }}
          </DialogTitle>
        </DialogHeader>
        <div v-if="detailRow" class="space-y-3 text-sm">
          <div class="grid grid-cols-2 gap-2">
            <div><span class="text-muted-foreground text-xs">เวลา:</span> {{ fmtTime(detailRow.created_at) }}</div>
            <div><span class="text-muted-foreground text-xs">ผู้ใช้:</span> {{ detailRow.username ? `@${detailRow.username} (id ${detailRow.user_id ?? "—"})` : "—" }}</div>
            <div><span class="text-muted-foreground text-xs">IP:</span> <span class="font-mono">{{ detailRow.ip ?? "—" }}</span></div>
            <div>
              <span class="text-muted-foreground text-xs">API:</span>
              <span class="font-mono text-xs">{{ detailRow.method }} {{ detailRow.path }} → {{ detailRow.status_code ?? "—" }}</span>
            </div>
            <div><span class="text-muted-foreground text-xs">ใช้เวลา:</span> {{ detailRow.duration_ms != null ? `${detailRow.duration_ms} ms` : "—" }}</div>
          </div>
          <div>
            <p class="text-xs text-muted-foreground mb-1">User-Agent:</p>
            <p class="text-xs font-mono break-all bg-muted rounded p-2">{{ detailRow.user_agent ?? "—" }}</p>
          </div>
          <div v-if="detailRow.detail">
            <p class="text-xs text-muted-foreground mb-1">รายละเอียด:</p>
            <pre class="text-xs font-mono bg-muted rounded p-2 overflow-auto max-h-40 whitespace-pre-wrap">{{ typeof detailRow.detail === "string" ? detailRow.detail : JSON.stringify(detailRow.detail, null, 2) }}</pre>
          </div>
          <div class="grid gap-1">
            <div>
              <p class="text-xs text-muted-foreground">prev_hash:</p>
              <p class="text-[11px] font-mono break-all bg-muted rounded p-1.5">{{ detailRow.prev_hash }}</p>
            </div>
            <div>
              <p class="text-xs text-muted-foreground">entry_hash:</p>
              <p class="text-[11px] font-mono break-all bg-muted rounded p-1.5">{{ detailRow.entry_hash }}</p>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>
