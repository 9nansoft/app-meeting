import { useNuxtApp } from "#imports";
import { toast } from "vue-sonner";

/**
 * helpers สำหรับเรียก API การประชุม — ห่อ Eden treaty ($api)
 * ด้วยการดึงข้อมูล + toast ข้อผิดพลาดอัตโนมัติ
 */
export function useMeetingApi() {
  const { $api } = useNuxtApp();

  /** เรียก API แบบ safe: คืน { data, error } และ toast เมื่อ error */
  async function call<T>(
    fn: () => Promise<{ data: T; error: any }>,
    opts: { silent?: boolean; successMsg?: string } = {},
  ): Promise<T | null> {
    try {
      const { data, error } = await fn();
      if (error) {
        if (!opts.silent) {
          const message =
            typeof error.value === "object" && error.value !== null
              ? (error.value as any).error || JSON.stringify(error.value)
              : String(error.value ?? "เกิดข้อผิดพลาด");
          toast.error(message);
        }
        return null;
      }
      if (opts.successMsg) toast.success(opts.successMsg);
      return data as T;
    } catch (err: any) {
      if (!opts.silent) toast.error(err?.message || "เกิดข้อผิดพลาดในการเชื่อมต่อ");
      return null;
    }
  }

  /** อัปโหลดไฟล์ (ใช้ fetch ตรง ๆ เพราะเป็น multipart) */
  async function upload(
    url: string,
    file: File | Blob,
    extraHeaders: Record<string, string> = {},
    fileName?: string,
  ): Promise<any | null> {
    try {
      const form = new FormData();
      form.append("file", file, fileName || (file instanceof File ? file.name : "upload.bin"));
      const res = await fetch(url, { method: "POST", body: form, headers: extraHeaders });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error || `อัปโหลดไม่สำเร็จ (${res.status})`);
        return null;
      }
      return data;
    } catch (err: any) {
      toast.error(err?.message || "อัปโหลดไม่สำเร็จ");
      return null;
    }
  }

  return { api: $api, call, upload };
}
