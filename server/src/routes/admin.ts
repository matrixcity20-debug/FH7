import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";
import {
  findUserById,
  getUserLimits,
  setUserLimits,
  resetUserLimits,
  listAllUsersPublic,
  type UserLimits,
} from "../lib/userStore.js";
import { getUserStorageUsed, MAX_USER_STORAGE_BYTES, MAX_FILE_SIZE, CHUNK_SIZE } from "../lib/fileStore.js";

const router: IRouter = Router();

// ── Admin identity ─────────────────────────────────────────────────────────
// ADMIN_USER_IDS: comma-separated list of user UUIDs that have admin access.
// If the env var is empty or absent, NO user is an admin (fail-secure).
function getAdminIds(): Set<string> {
  const raw = process.env["ADMIN_USER_IDS"] ?? "";
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

export function isAdminUser(userId: string | undefined): boolean {
  if (!userId) return false;
  return getAdminIds().has(userId);
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.userId) {
    res.status(401).json({ error: "Giriş yapmanız gerekiyor" });
    return;
  }
  if (!isAdminUser(req.session.userId)) {
    res.status(403).json({ error: "Bu işlem için yetkiniz yok" });
    return;
  }
  next();
}

// ── Rate limiting ──────────────────────────────────────────────────────────
const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Çok fazla istek. Lütfen bekleyin." },
  keyGenerator: (req: Request) =>
    (req.session as Record<string, unknown>)?.["userId"] as string ?? req.ip ?? "unknown",
});

// ── Limit validation ───────────────────────────────────────────────────────
const MIN_STORAGE_BYTES  = 1   * 1024 * 1024;        // 1 MB
const MAX_STORAGE_BYTES  = 1   * 1024 ** 4;           // 1 TB
const MIN_FILE_BYTES     = 1   * 1024 * 1024;        // 1 MB
const MAX_FILE_CAP_BYTES = 100 * 1024 * 1024 * 1024; // 100 GB
const MIN_CHUNK_BYTES    = 512 * 1024;               // 512 KB
const MAX_CHUNK_BYTES    = 100 * 1024 * 1024;        // 100 MB

function validateLimits(body: unknown): { ok: true; limits: UserLimits } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Geçersiz istek gövdesi" };
  }

  const raw = body as Record<string, unknown>;
  const limits: UserLimits = {};

  if ("storageQuotaBytes" in raw) {
    if (raw["storageQuotaBytes"] === null) {
      // null means reset to default — don't set the field
    } else {
      const v = Number(raw["storageQuotaBytes"]);
      if (!Number.isInteger(v) || v < MIN_STORAGE_BYTES || v > MAX_STORAGE_BYTES) {
        return { ok: false, error: `storageQuotaBytes: ${MIN_STORAGE_BYTES} ile ${MAX_STORAGE_BYTES} arasında tam sayı olmalı` };
      }
      limits.storageQuotaBytes = v;
    }
  }

  if ("maxFileSizeBytes" in raw) {
    if (raw["maxFileSizeBytes"] === null) {
      // null means reset to default
    } else {
      const v = Number(raw["maxFileSizeBytes"]);
      if (!Number.isInteger(v) || v < MIN_FILE_BYTES || v > MAX_FILE_CAP_BYTES) {
        return { ok: false, error: `maxFileSizeBytes: ${MIN_FILE_BYTES} ile ${MAX_FILE_CAP_BYTES} arasında tam sayı olmalı` };
      }
      limits.maxFileSizeBytes = v;
    }
  }

  if ("chunkSizeBytes" in raw) {
    if (raw["chunkSizeBytes"] === null) {
      // null means reset to default
    } else {
      const v = Number(raw["chunkSizeBytes"]);
      if (!Number.isInteger(v) || v < MIN_CHUNK_BYTES || v > MAX_CHUNK_BYTES) {
        return { ok: false, error: `chunkSizeBytes: ${MIN_CHUNK_BYTES} ile ${MAX_CHUNK_BYTES} arasında tam sayı olmalı` };
      }
      limits.chunkSizeBytes = v;
    }
  }

  // Cross-field: maxFileSizeBytes can't exceed storageQuotaBytes if both are set
  if (limits.storageQuotaBytes && limits.maxFileSizeBytes) {
    if (limits.maxFileSizeBytes > limits.storageQuotaBytes) {
      return { ok: false, error: "maxFileSizeBytes, storageQuotaBytes değerini aşamaz" };
    }
  }

  return { ok: true, limits };
}

// ── GET /api/admin/users ───────────────────────────────────────────────────
// Returns all users with their per-user limits and current storage usage.
router.get("/admin/users", requireAdmin, adminLimiter, async (req, res): Promise<void> => {
  try {
    const users = await listAllUsersPublic();
    const result = await Promise.all(
      users.map(async (u) => {
        const limits   = await getUserLimits(u.id);
        const usedBytes = getUserStorageUsed(u.id);
        return {
          id:        u.id,
          username:  u.username,
          createdAt: u.createdAt,
          usedBytes,
          limits,
          customLimits: u.limits ?? null,
        };
      }),
    );
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Admin listUsers error");
    res.status(500).json({ error: "Kullanıcı listesi alınamadı" });
  }
});

// ── GET /api/admin/users/:userId/limits ───────────────────────────────────
router.get("/admin/users/:userId/limits", requireAdmin, adminLimiter, async (req, res): Promise<void> => {
  const { userId } = req.params;
  if (!userId) { res.status(400).json({ error: "Geçersiz kullanıcı ID" }); return; }

  const user = await findUserById(userId);
  if (!user) { res.status(404).json({ error: "Kullanıcı bulunamadı" }); return; }

  const resolved = await getUserLimits(userId);
  res.json({
    userId,
    username:     user.username,
    customLimits: user.limits ?? null,
    resolvedLimits: resolved,
    serverDefaults: {
      storageQuotaBytes: MAX_USER_STORAGE_BYTES,
      maxFileSizeBytes:  MAX_FILE_SIZE,
      chunkSizeBytes:    CHUNK_SIZE,
    },
  });
});

// ── PATCH /api/admin/users/:userId/limits ─────────────────────────────────
// Merges the supplied fields into the stored limits. Send null for a field
// to clear that override (reverts to server default).
router.patch("/admin/users/:userId/limits", requireAdmin, adminLimiter, async (req, res): Promise<void> => {
  const { userId } = req.params;
  if (!userId) { res.status(400).json({ error: "Geçersiz kullanıcı ID" }); return; }

  const user = await findUserById(userId);
  if (!user) { res.status(404).json({ error: "Kullanıcı bulunamadı" }); return; }

  const validation = validateLimits(req.body);
  if (!validation.ok) {
    res.status(400).json({ error: validation.error });
    return;
  }

  await setUserLimits(userId, validation.limits);
  const resolved = await getUserLimits(userId);

  req.log.info({ adminId: req.session.userId, targetUserId: userId, limits: validation.limits }, "Admin updated user limits");
  res.json({ ok: true, userId, resolvedLimits: resolved });
});

// ── DELETE /api/admin/users/:userId/limits ────────────────────────────────
// Removes all overrides for a user — they revert to server defaults.
router.delete("/admin/users/:userId/limits", requireAdmin, adminLimiter, async (req, res): Promise<void> => {
  const { userId } = req.params;
  if (!userId) { res.status(400).json({ error: "Geçersiz kullanıcı ID" }); return; }

  const user = await findUserById(userId);
  if (!user) { res.status(404).json({ error: "Kullanıcı bulunamadı" }); return; }

  await resetUserLimits(userId);
  req.log.info({ adminId: req.session.userId, targetUserId: userId }, "Admin reset user limits to defaults");
  res.json({ ok: true, userId });
});

// ── GET /api/admin/defaults ───────────────────────────────────────────────
// Returns the current server-wide default limits.
router.get("/admin/defaults", requireAdmin, adminLimiter, (_req, res): void => {
  res.json({
    storageQuotaBytes: MAX_USER_STORAGE_BYTES,
    maxFileSizeBytes:  MAX_FILE_SIZE,
    chunkSizeBytes:    CHUNK_SIZE,
  });
});

export default router;
