/**
 * Auth işlemlerinden dönen zenginleştirilmiş hata sınıfı.
 *
 * express-rate-limit, başarısız yanıtlara aşağıdaki başlıkları ekler:
 *   RateLimit-Remaining : kalan deneme sayısı
 *   RateLimit-Reset     : pencere sıfırlanma zamanı (Unix saniye, draft-6)
 *   Retry-After         : 429 durumunda beklenmesi gereken saniye (draft-6)
 *
 * Bu sınıf bu başlıkları ayrıştırır ve UI katmanına yapılandırılmış olarak iletir.
 */
export class AuthError extends Error {
  /** Pencere sıfırlanana kadar kalan deneme hakkı (sunucudan gelen değer) */
  readonly remaining: number | null;
  /** Rate limit penceresi sıfırlanacak zaman (varsa) */
  readonly resetAt: Date | null;
  /** Kullanıcının kilitlenip kilitlenmediği (429) */
  readonly isRateLimited: boolean;

  constructor(
    message: string,
    options: {
      remaining?: number | null;
      resetAt?: Date | null;
      isRateLimited?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "AuthError";
    this.remaining = options.remaining ?? null;
    this.resetAt = options.resetAt ?? null;
    this.isRateLimited = options.isRateLimited ?? false;
  }
}

/**
 * Bir fetch Response'undan rate limit bilgilerini ayrıştırır.
 * Başlık yoksa null döner — hiçbir zaman hata fırlatmaz.
 */
export function parseRateLimitHeaders(res: Response): {
  remaining: number | null;
  resetAt: Date | null;
  isRateLimited: boolean;
} {
  const isRateLimited = res.status === 429;

  // RateLimit-Remaining (draft-6 / draft-7 her ikisinde de mevcuttur)
  const rawRemaining = res.headers.get("RateLimit-Remaining");
  const remaining =
    rawRemaining !== null && !isNaN(Number(rawRemaining))
      ? Number(rawRemaining)
      : null;

  // Retry-After (saniye cinsinden) → sıfırlanma zamanını hesapla
  const retryAfter = res.headers.get("Retry-After");
  // RateLimit-Reset (Unix timestamp, saniye)
  const rawReset = res.headers.get("RateLimit-Reset");

  let resetAt: Date | null = null;

  if (retryAfter !== null && !isNaN(Number(retryAfter))) {
    resetAt = new Date(Date.now() + Number(retryAfter) * 1000);
  } else if (rawReset !== null && !isNaN(Number(rawReset))) {
    // draft-6 formatı Unix timestamp gönderir
    resetAt = new Date(Number(rawReset) * 1000);
  }

  return { remaining, resetAt, isRateLimited };
}
