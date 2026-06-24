/**
 * Cloudflare Turnstile sunucu tarafı doğrulama.
 *
 * Güvenlik notları:
 * - Token doğrulaması SADECE sunucu tarafında yapılır (client-side trust yok).
 * - Her token tek kullanımlıktır; Cloudflare aynı token'ı iki kez geçirmez.
 * - remoteip iletilerek IP bağlama aktif edilir (opsiyonel ama önerilir).
 * - Hata detayları client'a sızdırılmaz; sadece jenerik mesaj döner.
 */

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

interface TurnstileVerifyResponse {
  success: boolean;
  "error-codes": string[];
  challenge_ts?: string;
  hostname?: string;
  action?: string;
  cdata?: string;
}

export interface TurnstileResult {
  success: boolean;
  /** Sunucu logları için hata kodu listesi — client'a asla iletilmez */
  errorCodes: string[];
}

/**
 * Cloudflare Turnstile token'ını sunucu tarafında doğrular.
 *
 * @param token  - Client'tan gelen `cf-turnstile-response` değeri
 * @param remoteIp - Kullanıcının IP adresi (isteğe bağlı ama önerilir)
 */
export async function verifyTurnstile(
  token: string | undefined | null,
  remoteIp?: string,
): Promise<TurnstileResult> {
  const secret = process.env["TURNSTILE_SECRET_KEY"];

  if (!secret) {
    // Üretimde bu hata fırlatılır; geliştirmede loglayıp geç
    if (process.env["NODE_ENV"] === "production") {
      throw new Error("TURNSTILE_SECRET_KEY environment variable is not set");
    }
    // Dev ortamında anahtar yoksa doğrulamayı atla
    return { success: true, errorCodes: [] };
  }

  if (!token || typeof token !== "string" || token.trim().length === 0) {
    return { success: false, errorCodes: ["missing-input-response"] };
  }

  const body = new URLSearchParams({
    secret,
    response: token.trim(),
  });

  if (remoteIp) {
    body.set("remoteip", remoteIp);
  }

  let data: TurnstileVerifyResponse;

  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(5000), // 5 saniyelik zaman aşımı
    });

    if (!res.ok) {
      return { success: false, errorCodes: ["network-error"] };
    }

    data = (await res.json()) as TurnstileVerifyResponse;
  } catch {
    return { success: false, errorCodes: ["network-error"] };
  }

  return {
    success: data.success === true,
    errorCodes: data["error-codes"] ?? [],
  };
}
