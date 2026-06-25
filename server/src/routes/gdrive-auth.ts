/**
 * Google Drive OAuth 2.0 Yetkilendirme Rotaları
 *
 * Yalnızca admin kullanıcılar erişebilir.
 * CSRF koruması: state parametresi session'da saklanır ve callback'te doğrulanır.
 *
 * GET  /api/auth/gdrive/start     → OAuth URL'sine yönlendir
 * GET  /api/auth/gdrive/callback  → token alışverişi yap, hesabı kaydet
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { randomBytes } from "crypto";
import rateLimit from "express-rate-limit";
import {
  isGDriveOAuthConfigured,
  generateAuthUrl,
  handleOAuthCallback,
} from "../lib/gdriveStorage.js";
import { isAdminUser } from "./admin.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

const gdriveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Çok fazla istek. Lütfen bekleyin." },
});

// ── GET /api/auth/gdrive/start ────────────────────────────────────────────────
// Admin, OAuth akışını başlatır. Rastgele bir state değeri üretilip session'a yazılır.
// Kullanıcı Google'ın yetkilendirme sayfasına yönlendirilir.
router.get(
  "/auth/gdrive/start",
  gdriveLimiter,
  (req: Request, res: Response): void => {
    if (!req.session.userId) {
      res.status(401).json({ error: "Giriş yapmanız gerekiyor" });
      return;
    }

    if (!isAdminUser(req.session.userId)) {
      res.status(403).json({ error: "Bu işlem için admin yetkisi gerekiyor" });
      return;
    }

    if (!isGDriveOAuthConfigured()) {
      res.status(503).json({
        error:
          "Google OAuth yapılandırılmamış. " +
          "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET ve GOOGLE_REDIRECT_URI " +
          "ortam değişkenlerini ayarlayın.",
      });
      return;
    }

    // CSRF koruması: 32 baytlık rastgele state; session'a yaz
    const state = randomBytes(32).toString("hex");
    (req.session as unknown as Record<string, unknown>)["gdriveOAuthState"] = state;

    const url = generateAuthUrl(state);
    logger.info({ adminId: req.session.userId }, "GDrive: OAuth akışı başlatıldı");
    res.json({ url });
  },
);

// ── GET /api/auth/gdrive/callback ─────────────────────────────────────────────
// Google, kullanıcıyı code + state parametreleriyle geri yönlendirir.
// State doğrulandıktan sonra token alışverişi yapılır ve hesap kaydedilir.
router.get(
  "/auth/gdrive/callback",
  gdriveLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const { code, state, error: oauthError } = req.query as Record<string, string | undefined>;

    // Kullanıcı izin vermeyi reddettiyse
    if (oauthError) {
      logger.warn({ oauthError }, "GDrive: Kullanıcı OAuth iznini reddetti");
      res.redirect("/#/admin?gdrive=denied");
      return;
    }

    // CSRF doğrulama — session'daki state ile eşleşmeli
    const sessionState = (req.session as unknown as Record<string, unknown>)["gdriveOAuthState"] as string | undefined;
    if (!state || !sessionState || state !== sessionState) {
      logger.warn({ sessionState, receivedState: state }, "GDrive: Geçersiz OAuth state (CSRF?)");
      res.redirect("/#/admin?gdrive=error&reason=invalid_state");
      return;
    }

    // State tek kullanımlık — hemen sil
    delete (req.session as unknown as Record<string, unknown>)["gdriveOAuthState"];

    if (!code) {
      res.redirect("/#/admin?gdrive=error&reason=no_code");
      return;
    }

    // Oturum henüz açık değilse (callback döndüğünde session süresi dolduysa)
    if (!req.session.userId || !isAdminUser(req.session.userId)) {
      res.redirect("/#/login?redirect=%2Fadmin");
      return;
    }

    try {
      const email = await handleOAuthCallback(code);
      logger.info({ adminId: req.session.userId, email }, "GDrive: Hesap başarıyla yetkilendirildi");
      res.redirect(`/#/admin?gdrive=success&email=${encodeURIComponent(email)}`);
    } catch (err) {
      logger.error({ err }, "GDrive: OAuth callback hatası");
      const msg = err instanceof Error ? err.message : "Bilinmeyen hata";
      res.redirect(`/#/admin?gdrive=error&reason=${encodeURIComponent(msg)}`);
    }
  },
);

export default router;
