<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { toast } from "vue-sonner";
import { useAuth } from "@/composables/useAuth";
import { useMeetingApi } from "@/composables/useMeetingApi";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  UserCog, Loader2, KeyRound, Pencil, Plus, Trash2, ShieldCheck,
} from "lucide-vue-next";

useSeoMeta({ title: "จัดการผู้ใช้ | AI Smart Meeting" });

const { user: authUser } = useAuth();
const { api, call } = useMeetingApi();

const loading = ref(true);
const users = ref<any[]>([]);
const rooms = ref<any[]>([]);

const ROLE_OPTIONS = [
  { value: "admin", label: "ผู้ดูแลระบบ" },
  { value: "secretary", label: "เลขานุการ" },
  { value: "member", label: "สมาชิก" },
  { value: "staff", label: "เจ้าหน้าที่ห้องประชุม" },
];

const roleLabel = (role: string) =>
  ROLE_OPTIONS.find((r) => r.value === role)?.label ?? (role === "user" ? "สมาชิก" : role);

const roleBadgeClass = (role: string) =>
  ({
    admin: "bg-destructive/10 text-destructive border-destructive/30",
    secretary: "bg-primary/10 text-primary border-primary/30",
    staff: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30",
  } as Record<string, string>)[role] ?? "";

/** ห้องที่ผู้ใช้แต่ละคนเป็นผู้รับผิดชอบ (จากข้อมูลห้อง) */
const roomsByUser = computed(() => {
  const map = new Map<string, string[]>();
  for (const room of rooms.value) {
    const rid = room.responsible?.id;
    if (!rid) continue;
    const list = map.get(String(rid)) ?? [];
    list.push(room.name);
    map.set(String(rid), list);
  }
  return map;
});

async function load() {
  loading.value = true;
  const [usersData, roomsData] = await Promise.all([
    call(() => api.users.get() as any, { silent: true }),
    call(() => api.rooms.get() as any, { silent: true }),
  ]);
  if (usersData) users.value = Array.isArray(usersData) ? usersData : [];
  if (roomsData) rooms.value = (roomsData as any).rooms ?? [];
  loading.value = false;
}

onMounted(async () => {
  if (authUser.value?.role !== "admin") {
    toast.error("หน้านี้สำหรับผู้ดูแลระบบเท่านั้น");
    await navigateTo("/dashboard");
    return;
  }
  await load();
});

// ---------- สร้างบัญชี ----------
const createOpen = ref(false);
const creating = ref(false);
const createForm = ref({ username: "", name: "", position: "", role: "staff", password: "" });

function openCreate() {
  createForm.value = { username: "", name: "", position: "", role: "staff", password: "" };
  createOpen.value = true;
}

async function submitCreate() {
  if (!createForm.value.username.trim()) {
    toast.error("กรุณาระบุ username");
    return;
  }
  creating.value = true;
  const d = await call(() =>
    api.users.post({
      username: createForm.value.username.trim(),
      role: createForm.value.role,
      name: createForm.value.name.trim() || undefined,
      position: createForm.value.position.trim() || undefined,
      password: createForm.value.password.trim() || undefined,
    }),
  );
  creating.value = false;
  if (d) {
    createOpen.value = false;
    toast.success(`สร้างบัญชี "${createForm.value.username.trim()}" แล้ว`);
    await load();
  }
}

// ---------- แก้ไขข้อมูล/บทบาท ----------
const editOpen = ref(false);
const editing = ref<any>(null);
const editForm = ref({ name: "", position: "", role: "member" });

function openEdit(u: any) {
  editing.value = u;
  editForm.value = { name: u.name ?? "", position: u.position ?? "", role: u.role };
  editOpen.value = true;
}

async function submitEdit() {
  if (!editing.value) return;
  const d = await call(() =>
    api.users[editing.value.id].put({
      name: editForm.value.name.trim() || undefined,
      position: editForm.value.position.trim() || undefined,
      role: editForm.value.role,
    }),
  );
  if (d) {
    editOpen.value = false;
    toast.success("บันทึกข้อมูลแล้ว");
    await load();
  }
}

// ---------- เปิด/ปิดใช้งาน ----------
async function toggleActive(u: any, active: boolean) {
  const d = await call(() => api.users[u.id].put({ isActive: active }));
  if (d) {
    toast.success(active ? `เปิดใช้งานบัญชี "${u.username}" แล้ว` : `ปิดใช้งานบัญชี "${u.username}" แล้ว`);
    await load();
  }
}

// ---------- รีเซ็ตรหัสผ่าน ----------
const resetOpen = ref(false);
const resetUser = ref<any>(null);
const newPassword = ref("");

function openReset(u: any) {
  resetUser.value = u;
  newPassword.value = "";
  resetOpen.value = true;
}

async function submitReset() {
  if (!resetUser.value) return;
  if (newPassword.value.trim().length < 6) {
    toast.error("รหัสผ่านต้องมีความยาวอย่างน้อย 6 ตัวอักษร");
    return;
  }
  const d = await call(() =>
    api.users[resetUser.value.id]["reset-password"].post({ password: newPassword.value.trim() }),
  );
  if (d) {
    resetOpen.value = false;
    toast.success(`ตั้งรหัสผ่านใหม่ให้ "${resetUser.value.username}" แล้ว`);
  }
}

// ---------- ลบบัญชี ----------
const deleteTarget = ref<any>(null);
const deleting = ref(false);

async function confirmDelete() {
  if (!deleteTarget.value) return;
  deleting.value = true;
  const d = await call(() => api.users[deleteTarget.value.id].delete());
  deleting.value = false;
  if (d) {
    toast.success(`ลบบัญชี "${deleteTarget.value.username}" แล้ว`);
    deleteTarget.value = null;
    await load();
  }
}

const canDelete = (u: any) => u.username !== "admin" && u.id !== authUser.value?.id;
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between flex-wrap gap-3">
      <div>
        <h1 class="text-2xl font-bold tracking-tight flex items-center gap-2">
          <UserCog class="w-6 h-6 text-primary" /> จัดการผู้ใช้
        </h1>
        <p class="text-muted-foreground mt-1">
          สร้างบัญชีให้เจ้าหน้าที่และผู้ใช้งานในระบบ กำหนดบทบาท รีเซ็ตรหัสผ่าน และปิดใช้งานบัญชี
        </p>
      </div>
      <Button @click="openCreate">
        <Plus class="w-4 h-4 mr-1.5" /> สร้างบัญชีผู้ใช้
      </Button>
    </div>

    <Card>
      <CardContent class="p-0">
        <div v-if="loading" class="p-4 space-y-3">
          <Skeleton v-for="i in 5" :key="i" class="h-12 w-full" />
        </div>
        <Table v-else>
          <TableHeader>
            <TableRow>
              <TableHead>ผู้ใช้</TableHead>
              <TableHead>บทบาท</TableHead>
              <TableHead>ห้องที่รับผิดชอบ</TableHead>
              <TableHead class="w-28">สถานะ</TableHead>
              <TableHead class="w-44 text-right">การดำเนินการ</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="u in users" :key="u.id" :class="{ 'opacity-60': !u.isActive }">
              <TableCell>
                <div class="font-medium text-sm">{{ u.name }}</div>
                <div class="text-xs text-muted-foreground">
                  @{{ u.username }}<span v-if="u.position"> · {{ u.position }}</span>
                </div>
              </TableCell>
              <TableCell>
                <Badge variant="outline" class="text-[11px]" :class="roleBadgeClass(u.role)">
                  {{ roleLabel(u.role) }}
                </Badge>
              </TableCell>
              <TableCell>
                <div v-if="roomsByUser.get(String(u.id))?.length" class="flex flex-wrap gap-1">
                  <Badge
                    v-for="name in roomsByUser.get(String(u.id))"
                    :key="name"
                    variant="secondary"
                    class="text-[10px] font-normal"
                  >
                    {{ name }}
                  </Badge>
                </div>
                <span v-else class="text-xs text-muted-foreground">—</span>
              </TableCell>
              <TableCell>
                <div class="flex items-center gap-2">
                  <Switch
                    :model-value="u.isActive"
                    :disabled="u.username === 'admin' || u.id === authUser?.id"
                    @update:model-value="toggleActive(u, Boolean($event))"
                  />
                  <span class="text-xs" :class="u.isActive ? 'text-muted-foreground' : 'text-destructive font-medium'">
                    {{ u.isActive ? "ใช้งาน" : "ปิดใช้งาน" }}
                  </span>
                </div>
              </TableCell>
              <TableCell class="text-right">
                <div class="flex items-center justify-end gap-1">
                  <Button variant="ghost" size="icon" class="h-8 w-8" title="แก้ไขข้อมูล" @click="openEdit(u)">
                    <Pencil class="w-4 h-4" />
                  </Button>
                  <Button variant="ghost" size="icon" class="h-8 w-8" title="ตั้งรหัสผ่านใหม่" @click="openReset(u)">
                    <KeyRound class="w-4 h-4" />
                  </Button>
                  <Button
                    v-if="canDelete(u)"
                    variant="ghost"
                    size="icon"
                    class="h-8 w-8 text-destructive hover:text-destructive"
                    title="ลบบัญชี"
                    @click="deleteTarget = u"
                  >
                    <Trash2 class="w-4 h-4" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>

    <p class="text-xs text-muted-foreground flex items-start gap-1.5">
      <ShieldCheck class="w-4 h-4 shrink-0 mt-0.5" />
      บัญชีบทบาท "เจ้าหน้าที่ห้องประชุม" (staff) สร้างที่นี่ — จากนั้นกำหนดห้องที่แต่ละคนรับผิดชอบได้ที่หน้า
      "จองห้องประชุม → แท็บห้องและอุปกรณ์" แล้วเจ้าหน้าที่จะเห็นตารางจองของห้องตัวเองในหน้านั้นทันที
    </p>

    <!-- Dialog สร้างบัญชี -->
    <Dialog :open="createOpen" @update:open="createOpen = $event">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>สร้างบัญชีผู้ใช้</DialogTitle>
        </DialogHeader>
        <div class="space-y-3">
          <div class="grid grid-cols-2 gap-3">
            <div class="space-y-1.5">
              <Label class="text-xs">Username <span class="text-destructive">*</span></Label>
              <Input v-model="createForm.username" placeholder="เช่น somchai.s" />
            </div>
            <div class="space-y-1.5">
              <Label class="text-xs">บทบาท</Label>
              <Select :model-value="createForm.role" @update:model-value="createForm.role = String($event)">
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="r in ROLE_OPTIONS" :key="r.value" :value="r.value">{{ r.label }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div class="space-y-1.5">
              <Label class="text-xs">ชื่อ-สกุล</Label>
              <Input v-model="createForm.name" placeholder="ชื่อที่แสดงในระบบ" />
            </div>
            <div class="space-y-1.5">
              <Label class="text-xs">ตำแหน่ง</Label>
              <Input v-model="createForm.position" placeholder="เช่น เจ้าหน้าที่กิจการภายใน" />
            </div>
          </div>
          <div class="space-y-1.5">
            <Label class="text-xs">รหัสผ่านเริ่มต้น</Label>
            <Input v-model="createForm.password" type="text" placeholder="เว้นว่าง = password" />
            <p class="text-[11px] text-muted-foreground">แนะนำให้ผู้ใช้เปลี่ยนรหัสผ่านภายหลัง</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="createOpen = false">ยกเลิก</Button>
          <Button :disabled="creating" @click="submitCreate()">
            <Loader2 v-if="creating" class="w-4 h-4 mr-1.5 animate-spin" /> สร้างบัญชี
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Dialog แก้ไขข้อมูล -->
    <Dialog :open="editOpen" @update:open="editOpen = $event">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>แก้ไขข้อมูลผู้ใช้ — @{{ editing?.username }}</DialogTitle>
        </DialogHeader>
        <div class="space-y-3">
          <div class="grid grid-cols-2 gap-3">
            <div class="space-y-1.5">
              <Label class="text-xs">ชื่อ-สกุล</Label>
              <Input v-model="editForm.name" />
            </div>
            <div class="space-y-1.5">
              <Label class="text-xs">ตำแหน่ง</Label>
              <Input v-model="editForm.position" />
            </div>
          </div>
          <div class="space-y-1.5">
            <Label class="text-xs">บทบาท</Label>
            <Select :model-value="editForm.role" @update:model-value="editForm.role = String($event)">
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="r in ROLE_OPTIONS" :key="r.value" :value="r.value">{{ r.label }}</SelectItem>
              </SelectContent>
            </Select>
            <p v-if="editing?.role === 'user'" class="text-[11px] text-muted-foreground">
              บัญชีนี้สมัครเอง (บทบาท user) — สามารถเปลี่ยนเป็นบทบาทในระบบได้
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="editOpen = false">ยกเลิก</Button>
          <Button @click="submitEdit()">บันทึก</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Dialog ตั้งรหัสผ่านใหม่ -->
    <Dialog :open="resetOpen" @update:open="resetOpen = $event">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>ตั้งรหัสผ่านใหม่ — @{{ resetUser?.username }}</DialogTitle>
        </DialogHeader>
        <div class="space-y-3">
          <div class="space-y-1.5">
            <Label class="text-xs">รหัสผ่านใหม่</Label>
            <Input v-model="newPassword" type="text" placeholder="อย่างน้อย 6 ตัวอักษร" />
          </div>
          <p class="text-xs text-muted-foreground">
            รหัสผ่านเดิมจะถูกแทนที่ทันที ผู้ใช้ที่ login อยู่จะยังใช้ session เดิมได้จนถึง 7 วัน
            หรือจนออกจากระบบ
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="resetOpen = false">ยกเลิก</Button>
          <Button @click="submitReset()">ตั้งรหัสผ่านใหม่</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Confirm ลบบัญชี -->
    <AlertDialog :open="!!deleteTarget" @update:open="!$event && (deleteTarget = null)">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>ลบบัญชี "@{{ deleteTarget?.username }}"?</AlertDialogTitle>
          <AlertDialogDescription>
            การลบบัญชีไม่สามารถย้อนกลับได้ — ห้องที่ผู้ใช้รายนี้เป็นผู้รับผิดชอบจะถูกถอดผู้รับผิดชอบออก
            หากต้องการเพียงหยุดการใช้งานชั่วคราว แนะนำให้ "ปิดใช้งาน" แทนการลบ
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>ยกเลิก</AlertDialogCancel>
          <AlertDialogAction
            class="bg-destructive text-white hover:bg-destructive/90"
            :disabled="deleting"
            @click="confirmDelete()"
          >
            <Loader2 v-if="deleting" class="w-4 h-4 mr-1.5 animate-spin" /> ลบบัญชี
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
