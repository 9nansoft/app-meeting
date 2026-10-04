<script setup lang="ts">
import { computed } from 'vue'
import ThemeToggle from './ThemeToggle.vue'
import { useAuth } from '@/composables/useAuth'
import { useNotifications } from '@/composables/useNotifications'
import { dayjs } from '@/utils/meeting-format'
import {
  CalendarDays, ClipboardList, LayoutDashboard, ListTodo, Bell, LogOut, CheckCheck, Users, UserCog, ScrollText
} from 'lucide-vue-next'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'

const route = useRoute()
const { user, logout } = useAuth()
const { notifications, unreadCount, refresh, markRead } = useNotifications()

const nav = computed(() => {
  const items = [
    { label: 'Dashboard', to: '/dashboard', icon: LayoutDashboard },
    { label: 'จองห้องประชุม', to: '/rooms', icon: CalendarDays },
    { label: 'การประชุม', to: '/meetings', icon: ClipboardList },
    { label: 'ติดตามงาน', to: '/followup', icon: ListTodo },
  ]
  if (user.value?.role === 'admin') {
    items.push({ label: 'จัดการผู้ใช้', to: '/admin', icon: UserCog })
    items.push({ label: 'Log ระบบ', to: '/admin/logs', icon: ScrollText })
  }
  return items
})

/** เมนู active เฉพาะ path ตรงหรือเป็น segment ลูก — เลือกเมนูที่ตรงที่สุด (/admin/logs ไม่ให้สว่าง /admin ด้วย) */
const isActive = (to: string) => {
  const match = (t: string) => route.path === t || route.path.startsWith(t + '/')
  const best = [...nav.value].filter((i) => match(i.to)).sort((a, b) => b.to.length - a.to.length)[0]
  return best?.to === to
}

const roleLabel = (role?: string) =>
  ({ admin: 'ผู้ดูแลระบบ', secretary: 'เลขานุการ', staff: 'เจ้าหน้าที่ห้องประชุม' } as Record<string, string>)[role ?? ''] ?? 'สมาชิก'

async function onNotifClick(n: any) {
  if (n.status === 'unread') await markRead(n.id)
  if (n.link) await navigateTo(n.link)
}

async function onLogout() {
  await logout()
}
</script>

<template>
  <header class="sticky top-0 z-50 w-full border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
    <div class="container mx-auto px-4 sm:px-8 flex h-16 items-center justify-between gap-4">
      <NuxtLink to="/dashboard" class="flex items-center gap-2 shrink-0">
        <div class="h-8 w-8 rounded-lg bg-gradient-to-br from-primary to-purple-500 text-white flex items-center justify-center">
          <CalendarDays class="w-4 h-4" />
        </div>
        <div class="font-bold text-lg tracking-tight bg-gradient-to-r from-primary to-purple-500 bg-clip-text text-transparent hidden sm:block">
          AI Smart Meeting
        </div>
      </NuxtLink>

      <nav class="flex items-center gap-1 flex-1 justify-center">
        <NuxtLink
          v-for="item in nav"
          :key="item.to"
          :to="item.to"
          class="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors"
          :class="isActive(item.to)
            ? 'bg-primary/10 text-primary'
            : 'text-muted-foreground hover:text-foreground hover:bg-muted'"
        >
          <component :is="item.icon" class="w-4 h-4" />
          <span class="hidden md:inline">{{ item.label }}</span>
        </NuxtLink>
      </nav>

      <div class="flex items-center gap-2 shrink-0">
        <!-- แจ้งเตือน -->
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button variant="ghost" size="icon" class="relative" @click="refresh()">
              <Bell class="w-5 h-5" />
              <Badge
                v-if="unreadCount > 0"
                class="absolute -top-1 -right-1 h-4 min-w-4 px-1 text-[10px] flex items-center justify-center"
                variant="destructive"
              >
                {{ unreadCount > 99 ? '99+' : unreadCount }}
              </Badge>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-96">
            <div class="flex items-center justify-between px-3 py-2">
              <span class="text-sm font-semibold">การแจ้งเตือน</span>
              <Button v-if="unreadCount > 0" variant="ghost" size="sm" class="h-7 text-xs" @click="markRead()">
                <CheckCheck class="w-3.5 h-3.5 mr-1" /> อ่านทั้งหมด
              </Button>
            </div>
            <DropdownMenuSeparator />
            <ScrollArea class="h-80">
              <div v-if="notifications.length === 0" class="py-8 text-center text-sm text-muted-foreground">
                ไม่มีการแจ้งเตือน
              </div>
              <DropdownMenuItem
                v-for="n in notifications"
                :key="n.id"
                class="flex flex-col items-start gap-0.5 py-2.5 cursor-pointer"
                @click="onNotifClick(n)"
              >
                <div class="flex items-center gap-2 w-full">
                  <span class="h-2 w-2 rounded-full shrink-0" :class="n.status === 'unread' ? 'bg-primary' : 'bg-transparent'" />
                  <span class="text-sm font-medium leading-snug flex-1" :class="n.status === 'unread' ? '' : 'text-muted-foreground'">
                    {{ n.title }}
                  </span>
                </div>
                <span v-if="n.body" class="text-xs text-muted-foreground pl-4 line-clamp-2">{{ n.body }}</span>
                <span class="text-[11px] text-muted-foreground/70 pl-4">{{ dayjs(n.created_at).fromNow() }}</span>
              </DropdownMenuItem>
            </ScrollArea>
          </DropdownMenuContent>
        </DropdownMenu>

        <ThemeToggle />

        <!-- ผู้ใช้ -->
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button variant="ghost" class="gap-2 px-2">
              <div class="h-7 w-7 rounded-full bg-primary/15 text-primary flex items-center justify-center text-xs font-bold">
                {{ (user?.name || user?.username || '?').slice(0, 2) }}
              </div>
              <span class="hidden sm:inline text-sm">{{ user?.name || user?.username }}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-56">
            <DropdownMenuLabel>
              <div class="flex items-center gap-2">
                <Users class="w-4 h-4 text-muted-foreground" />
                <div>
                  <div class="text-sm font-medium">{{ user?.name || user?.username }}</div>
                  <div class="text-xs text-muted-foreground">บทบาท: {{ roleLabel(user?.role) }}</div>
                </div>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem @click="navigateTo('/showcase')">
              <LayoutDashboard class="w-4 h-4 mr-2" /> Component Showcase
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem class="text-destructive" @click="onLogout()">
              <LogOut class="w-4 h-4 mr-2" /> ออกจากระบบ
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  </header>
</template>
