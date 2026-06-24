import { useState, useCallback } from "react";
import { useLocation } from "wouter";
import { Layers, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import { toast } from "@/hooks/use-toast";
import TurnstileWidget from "@/components/TurnstileWidget";
import RateLimitWarning from "@/components/RateLimitWarning";
import { AuthError } from "@/lib/auth-error";

export default function LoginPage() {
  const [, setLocation] = useLocation();
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string>("");
  const [captchaExpired, setCaptchaExpired] = useState(false);

  // Rate limit durumu
  const [remaining, setRemaining] = useState<number | null>(null);
  const [resetAt, setResetAt] = useState<Date | null>(null);
  const [isRateLimited, setIsRateLimited] = useState(false);

  const handleVerify = useCallback((token: string) => {
    setTurnstileToken(token);
    setCaptchaExpired(false);
  }, []);

  const handleExpire = useCallback(() => {
    setTurnstileToken("");
    setCaptchaExpired(true);
  }, []);

  const handleError = useCallback(() => {
    setTurnstileToken("");
    toast({
      variant: "destructive",
      title: "Captcha yüklenemedi",
      description: "Lütfen sayfayı yenileyip tekrar deneyin.",
    });
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password) return;

    if (isRateLimited) return;

    if (!turnstileToken) {
      toast({
        variant: "destructive",
        title: "Captcha doğrulaması gerekli",
        description: captchaExpired
          ? "Captcha süresi doldu, lütfen tekrar doğrulayın."
          : "Lütfen captcha doğrulamasını tamamlayın.",
      });
      return;
    }

    setLoading(true);
    try {
      await login(username, password, turnstileToken);
      setLocation("/");
    } catch (err) {
      // Rate limit bilgisini state'e aktar
      if (err instanceof AuthError) {
        if (err.remaining !== null) setRemaining(err.remaining);
        if (err.resetAt !== null) setResetAt(err.resetAt);
        setIsRateLimited(err.isRateLimited);
      }

      // Tam kilit durumunda generic toast yerine banner yeterli
      if (!(err instanceof AuthError && err.isRateLimited)) {
        toast({
          variant: "destructive",
          title: "Giriş başarısız",
          description: err instanceof Error ? err.message : "Bir hata oluştu",
        });
      }

      // Token tek kullanımlık — hata sonrası sıfırla
      setTurnstileToken("");
    } finally {
      setLoading(false);
    }
  };

  const isLocked = isRateLimited;

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center space-y-3">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-primary/10 border border-primary/30 mx-auto">
            <Layers className="w-6 h-6 text-primary" />
          </div>
          <h1 className="text-2xl font-bold font-mono gradient-text">FileSplit</h1>
          <p className="text-sm text-muted-foreground">Hesabınıza giriş yapın</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="username" className="font-mono text-xs">Kullanıcı Adı</Label>
            <Input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="kullanici_adi"
              autoComplete="username"
              required
              disabled={loading || isLocked}
              className="font-mono"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="password" className="font-mono text-xs">Şifre</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              required
              disabled={loading || isLocked}
              className="font-mono"
            />
          </div>

          {/* Rate limit uyarısı — captcha'nın hemen üstünde */}
          <RateLimitWarning
            remaining={remaining}
            resetAt={resetAt}
            isRateLimited={isRateLimited}
          />

          {!isLocked && (
            <TurnstileWidget
              onVerify={handleVerify}
              onExpire={handleExpire}
              onError={handleError}
              theme="auto"
            />
          )}

          <Button
            type="submit"
            className="w-full gap-2 font-mono"
            disabled={loading || !turnstileToken || isLocked}
          >
            <LogIn className="w-4 h-4" />
            {loading ? "Giriş yapılıyor..." : "Giriş Yap"}
          </Button>
        </form>

        <p className="text-center text-sm text-muted-foreground">
          Hesabınız yok mu?{" "}
          <button
            onClick={() => setLocation("/register")}
            className="text-primary hover:underline font-mono font-medium"
          >
            Kayıt Ol
          </button>
        </p>
      </div>
    </div>
  );
}
