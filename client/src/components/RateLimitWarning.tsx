/**
 * Rate limit durumunu kullanıcıya gösteren uyarı bileşeni.
 *
 * Üç durum:
 *  1. remaining > 3          → hiçbir şey gösterme
 *  2. 0 < remaining <= 3     → sarı uyarı ("X deneme hakkınız kaldı")
 *  3. isRateLimited (429)    → kırmızı kilit ekranı + geri sayım sayacı
 */

import { useEffect, useState } from "react";
import { AlertTriangle, Lock, Clock } from "lucide-react";

interface RateLimitWarningProps {
  remaining: number | null;
  resetAt: Date | null;
  isRateLimited: boolean;
}

/** Tarihe kadar kalan süreyi "mm:ss" formatında döner */
function useCountdown(resetAt: Date | null): string | null {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    if (!resetAt) {
      setLabel(null);
      return;
    }

    function tick() {
      if (!resetAt) return;
      const diff = Math.max(0, resetAt.getTime() - Date.now());
      if (diff === 0) {
        setLabel(null);
        return;
      }
      const totalSeconds = Math.ceil(diff / 1000);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      setLabel(`${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`);
    }

    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [resetAt]);

  return label;
}

/** Kaç deneme kaldığına göre renk ve metin tonu */
function remainingColor(remaining: number): string {
  if (remaining <= 1) return "text-destructive";
  if (remaining <= 2) return "text-orange-500 dark:text-orange-400";
  return "text-yellow-600 dark:text-yellow-400";
}

export default function RateLimitWarning({
  remaining,
  resetAt,
  isRateLimited,
}: RateLimitWarningProps) {
  const countdown = useCountdown(isRateLimited ? resetAt : null);

  // Durum 3 — tam kilit
  if (isRateLimited) {
    return (
      <div
        role="alert"
        aria-live="assertive"
        className="flex flex-col items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-4 text-center"
      >
        <div className="flex items-center justify-center w-10 h-10 rounded-full bg-destructive/15 border border-destructive/30">
          <Lock className="w-5 h-5 text-destructive" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-semibold font-mono text-destructive">
            Çok fazla başarısız deneme
          </p>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Güvenlik nedeniyle erişiminiz geçici olarak kısıtlandı.
          </p>
        </div>
        {countdown !== null && (
          <div className="flex items-center gap-1.5 rounded-md bg-destructive/10 border border-destructive/20 px-3 py-1.5">
            <Clock className="w-3.5 h-3.5 text-destructive/80 shrink-0" />
            <span className="text-xs font-mono font-semibold text-destructive">
              {countdown}
            </span>
            <span className="text-xs text-muted-foreground">sonra tekrar deneyin</span>
          </div>
        )}
        {countdown === null && (
          <p className="text-xs text-muted-foreground">
            Sayfayı yenileyip tekrar deneyebilirsiniz.
          </p>
        )}
      </div>
    );
  }

  // Durum 2 — az deneme kaldı (uyarı)
  if (remaining !== null && remaining > 0 && remaining <= 3) {
    return (
      <div
        role="alert"
        aria-live="polite"
        className="flex items-start gap-3 rounded-lg border border-yellow-500/30 bg-yellow-500/8 px-3 py-2.5"
      >
        <AlertTriangle className="w-4 h-4 text-yellow-500 dark:text-yellow-400 shrink-0 mt-0.5" />
        <p className={`text-xs font-mono leading-relaxed ${remainingColor(remaining)}`}>
          <span className="font-semibold">{remaining} deneme hakkınız</span> kaldı.
          {remaining === 1 && " Bu son denemeniz."}
          {remaining > 1 && " Başarısız olmaya devam ederseniz erişiminiz geçici olarak kısıtlanır."}
        </p>
      </div>
    );
  }

  // Durum 1 — gösterilecek bir şey yok
  return null;
}
