/**
 * Cloudflare Turnstile widget bileşeni.
 *
 * Kullanım:
 *   <TurnstileWidget onVerify={(token) => setToken(token)} onExpire={() => setToken("")} />
 *
 * - VITE_TURNSTILE_SITE_KEY env değişkeninden site key okur.
 * - Widget doğrulandığında `onVerify(token)` çağrılır.
 * - Token süresi dolduğunda `onExpire()` çağrılır (form submit'i engelle).
 * - Hata oluştuğunda `onError()` çağrılır.
 */

import { useEffect, useRef } from "react";

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: string | HTMLElement,
        params: TurnstileRenderParams,
      ) => string;
      remove: (widgetId: string) => void;
      reset: (widgetId: string) => void;
    };
    onTurnstileLoad?: () => void;
  }
}

interface TurnstileRenderParams {
  sitekey: string;
  callback: (token: string) => void;
  "expired-callback"?: () => void;
  "error-callback"?: () => void;
  theme?: "light" | "dark" | "auto";
  language?: string;
  size?: "normal" | "compact" | "flexible";
  appearance?: "always" | "execute" | "interaction-only";
}

interface TurnstileWidgetProps {
  onVerify: (token: string) => void;
  onExpire?: () => void;
  onError?: () => void;
  theme?: "light" | "dark" | "auto";
}

const SCRIPT_ID = "cf-turnstile-script";
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad&render=explicit";

function loadTurnstileScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    // Script zaten yüklendiyse
    if (window.turnstile) {
      resolve();
      return;
    }

    // Script DOM'da varsa yüklenmesini bekle
    const existing = document.getElementById(SCRIPT_ID);
    if (existing) {
      const prev = window.onTurnstileLoad;
      window.onTurnstileLoad = () => {
        prev?.();
        resolve();
      };
      return;
    }

    window.onTurnstileLoad = resolve;

    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onerror = () => reject(new Error("Turnstile script yüklenemedi"));
    document.head.appendChild(script);
  });
}

export default function TurnstileWidget({
  onVerify,
  onExpire,
  onError,
  theme = "auto",
}: TurnstileWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);

  const siteKey = import.meta.env["VITE_TURNSTILE_SITE_KEY"] as string | undefined;

  useEffect(() => {
    if (!siteKey) {
      console.warn("[Turnstile] VITE_TURNSTILE_SITE_KEY tanımlı değil.");
      return;
    }

    let mounted = true;

    loadTurnstileScript()
      .then(() => {
        if (!mounted || !containerRef.current || !window.turnstile) return;

        // Önceki widget'ı temizle
        if (widgetIdRef.current !== null) {
          window.turnstile.remove(widgetIdRef.current);
          widgetIdRef.current = null;
        }

        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          callback: onVerify,
          "expired-callback": onExpire,
          "error-callback": onError,
          theme,
          appearance: "always",
        });
      })
      .catch((err: unknown) => {
        console.error("[Turnstile] Script yükleme hatası:", err);
        onError?.();
      });

    return () => {
      mounted = false;
      if (widgetIdRef.current !== null && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey, theme]);

  if (!siteKey) return null;

  return <div ref={containerRef} className="flex justify-center" />;
}
