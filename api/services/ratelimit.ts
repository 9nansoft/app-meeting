/**
 * Rate limiter แบบ fixed-window ในหน่วยความจำ (ต่อ process)
 * ใช้ป้องกันการเดารหัสผ่าน (brute-force) ที่ /auth/login และ /auth/register
 *
 * หมายเหตุ: ถ้ารันหลาย instance ควรย้ายไปเก็บใน Redis หรือใช้ rate limit ของ Cloudflare
 */
interface Bucket {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {
    const sweep = setInterval(() => this.sweep(), Math.max(windowMs, 60_000));
    (sweep as unknown as { unref?: () => void }).unref?.();
  }

  /** จำนวนวินาทีที่ต้องรอ ถ้าเกินโควตาแล้ว (0 = ยังไม่เกิน) */
  retryAfter(key: string): number {
    const b = this.buckets.get(key);
    if (!b || b.resetAt <= Date.now()) return 0;
    return b.count >= this.limit ? Math.ceil((b.resetAt - Date.now()) / 1000) : 0;
  }

  /** นับ 1 ครั้ง */
  hit(key: string): void {
    const now = Date.now();
    const b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
    } else {
      b.count += 1;
    }
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(key);
  }
}

const WINDOW = 15 * 60 * 1000;

/** login ผิด 5 ครั้งต่อ username+IP ใน 15 นาที → ล็อกชั่วคราว */
export const loginFailuresByAccount = new RateLimiter(5, WINDOW);
/** ความพยายาม login ทั้งหมดต่อ IP (กันการไล่เดาหลาย username) */
export const loginAttemptsByIp = new RateLimiter(30, WINDOW);
/** การสมัครบัญชีต่อ IP (เมื่อเปิด ALLOW_SELF_REGISTER) */
export const registerByIp = new RateLimiter(5, 60 * 60 * 1000);
