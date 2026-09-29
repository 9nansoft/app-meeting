import { ref } from "vue";
import { useIntervalFn } from "@vueuse/core";

export interface AppNotification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  meeting_id: string | null;
  status: string;
  created_at: string;
}

/** การแจ้งเตือนในระบบ — poll ทุก 30 วินาที + ดึงตอนเริ่ม */
export function useNotifications(autoStart = true) {
  const { $api } = useNuxtApp();
  // Eden type ของ node นี้ (มีทั้ง method และ child route) อนุมานเป็น union — cast เพื่อความเรียบง่าย
  const api = $api as any;
  const notifications = ref<AppNotification[]>([]);
  const unreadCount = ref(0);
  const loading = ref(false);

  async function refresh() {
    loading.value = true;
    try {
      const { data, error } = await api.notifications.get({ query: { limit: 30 } });
      if (!error && data) {
        notifications.value = data.notifications ?? [];
        unreadCount.value = data.unreadCount ?? 0;
      }
    } catch {
      /* silent */
    }
    loading.value = false;
  }

  async function markRead(id?: string) {
    try {
      await api.notifications.read.post(id ? { id } : { all: true });
    } catch {
      /* silent */
    }
    await refresh();
  }

  const { pause, resume } = useIntervalFn(refresh, 30_000, { immediate: autoStart });

  return { notifications, unreadCount, loading, refresh, markRead, pause, resume };
}
