import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";
import fs from "fs";
import path from "path";
import {
  findUserById,
  getUserLimits,
  setUserLimits,
  resetUserLimits,
  listAllUsersPublic,
  type UserLimits,
} from "../lib/userStore.js";
import {
  getUserStorageUsed,
  MAX_USER_STORAGE_BYTES,
  MAX_FILE_SIZE,
  CHUNK_SIZE,
  deleteFile,
  readMeta,
  isValidFileId,
  uploadsDir,
} from "../lib/fileStore.js";
import { getFirebaseDb } from "../lib/firebase.js";
import { getStorageSummary } from "../lib/storageProvider.js";
import { type FileRecord } from "../lib/fileRegistry.js";
import {
  isR2Configured,
  listConfiguredBuckets as listR2Buckets,
  testR2Connectivity,
} from "../lib/r2Storage.js";
import {
  isB2Configured,
  listConfiguredB2Buckets,
  testB2Connectivity,
} from "../lib/b2Storage.js";

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
          id:          u.id,
          username:    u.username,
          createdAt:   u.createdAt,
          lastLoginAt: u.lastLoginAt ?? null,
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

// ── Şikayet (Report) Yönetimi ──────────────────────────────────────────────

export interface FileReport {
  reportId: string;
  dosyaLinki: string;
  dosyaId: string;
  dosyaAdi: string;
  yukleyenKullanici: string;
  yukleyenKullaniciId: string;
  sikayetNedeni: string;
  sikayetEdenIp: string;
  sikayetEdenKullanici: string;
  tarih: string;
}

function getLocalReportsPath(): string {
  return path.join(uploadsDir, "_reports.json");
}

async function listAllReports(): Promise<FileReport[]> {
  const db = getFirebaseDb();
  if (db) {
    try {
      const snap = await db.ref("sikayetEdilen_dosyalar").get();
      if (!snap.exists()) return [];
      const reports: FileReport[] = [];
      snap.forEach((child) => {
        reports.push(child.val() as FileReport);
      });
      return reports.sort((a, b) => new Date(b.tarih).getTime() - new Date(a.tarih).getTime());
    } catch (err) {
      throw new Error(`Firebase okuma hatası: ${String(err)}`);
    }
  }
  // Yerel fallback
  const p = getLocalReportsPath();
  if (!fs.existsSync(p)) return [];
  try {
    const all = JSON.parse(fs.readFileSync(p, "utf-8")) as FileReport[];
    return all.sort((a, b) => new Date(b.tarih).getTime() - new Date(a.tarih).getTime());
  } catch {
    return [];
  }
}

async function removeReport(reportId: string): Promise<void> {
  const db = getFirebaseDb();
  if (db) {
    await db.ref(`sikayetEdilen_dosyalar/${reportId}`).remove();
    return;
  }
  // Yerel fallback
  const p = getLocalReportsPath();
  if (!fs.existsSync(p)) return;
  try {
    const all = JSON.parse(fs.readFileSync(p, "utf-8")) as FileReport[];
    const filtered = all.filter((r) => r.reportId !== reportId);
    fs.writeFileSync(p, JSON.stringify(filtered, null, 2));
  } catch {
    // ignore
  }
}

// ── GET /api/admin/reports ─────────────────────────────────────────────────
router.get("/admin/reports", requireAdmin, adminLimiter, async (req, res): Promise<void> => {
  try {
    const reports = await listAllReports();
    res.json(reports);
  } catch (err) {
    req.log.error({ err }, "Admin listReports error");
    res.status(500).json({ error: "Şikayet listesi alınamadı" });
  }
});

// ── DELETE /api/admin/reports/:reportId ───────────────────────────────────
// Sadece şikayeti kapat (dosyayı silme)
router.delete("/admin/reports/:reportId", requireAdmin, adminLimiter, async (req, res): Promise<void> => {
  const { reportId } = req.params;
  if (!reportId || typeof reportId !== "string" || reportId.length > 128) {
    res.status(400).json({ error: "Geçersiz reportId" });
    return;
  }
  try {
    await removeReport(reportId);
    req.log.info({ adminId: req.session.userId, reportId }, "Admin dismissed report");
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Admin dismissReport error");
    res.status(500).json({ error: "Şikayet kapatılamadı" });
  }
});

// ── DELETE /api/admin/reports/:reportId/file ──────────────────────────────
// Hem şikayeti kapat hem de ilgili dosyayı sil
router.delete("/admin/reports/:reportId/file", requireAdmin, adminLimiter, async (req, res): Promise<void> => {
  const { reportId } = req.params;
  if (!reportId || typeof reportId !== "string" || reportId.length > 128) {
    res.status(400).json({ error: "Geçersiz reportId" });
    return;
  }

  let fileId: string | undefined;
  try {
    // Önce rapordan dosya ID'sini öğren
    const reports = await listAllReports();
    const report = reports.find((r) => r.reportId === reportId);
    if (!report) {
      res.status(404).json({ error: "Şikayet bulunamadı" });
      return;
    }
    fileId = report.dosyaId;
  } catch (err) {
    req.log.error({ err }, "Admin deleteReportedFile: list error");
    res.status(500).json({ error: "Şikayet bilgisi alınamadı" });
    return;
  }

  // Dosya ID doğrulama
  if (!fileId || !isValidFileId(fileId)) {
    res.status(400).json({ error: "Şikayette geçersiz dosya ID'si" });
    return;
  }

  // Dosyayı sil (yoksa sessizce geç)
  const meta = readMeta(fileId);
  if (meta) {
    try {
      deleteFile(fileId);
      req.log.info({ adminId: req.session.userId, fileId, reportId }, "Admin deleted reported file");
    } catch (err) {
      req.log.error({ err, fileId }, "Admin deleteReportedFile: file delete error");
      res.status(500).json({ error: "Dosya silinemedi" });
      return;
    }
  }

  // Şikayeti kapat
  try {
    await removeReport(reportId);
  } catch (err) {
    req.log.error({ err, reportId }, "Admin deleteReportedFile: report remove error");
    // Dosya zaten silindi, devam et
  }

  req.log.info({ adminId: req.session.userId, reportId, fileId }, "Admin closed report + deleted file");
  res.json({ ok: true, fileDeleted: !!meta });
});

// ── POST /api/admin/storage/test ──────────────────────────────────────────
// R2 ve/veya B2 bucket'larına gerçek bir test dosyası yükler ve siler.
// Bağlantı, kimlik doğrulaması ve bucket izinlerini doğrular.
// body: { provider?: "r2" | "b2" | "all" }
// Güvenlik: yalnızca admin erişimi; rate-limit uygulanır.
router.post("/admin/storage/test", requireAdmin, adminLimiter, async (req, res): Promise<void> => {
  const body = req.body as { provider?: string };
  const targetProvider = (body.provider ?? "all").toLowerCase();

  if (!["r2", "b2", "all"].includes(targetProvider)) {
    res.status(400).json({ error: "Geçersiz provider değeri (r2, b2 veya all olmalı)" });
    return;
  }

  interface BucketTestResult {
    provider: "r2" | "b2";
    bucket: string;
    success: boolean;
    latencyMs: number;
    error?: string;
  }

  const tasks: Array<Promise<BucketTestResult>> = [];

  // R2 testleri
  if ((targetProvider === "r2" || targetProvider === "all") && isR2Configured()) {
    for (const bucket of listR2Buckets()) {
      tasks.push(
        testR2Connectivity(bucket).then((r) => ({ provider: "r2" as const, bucket, ...r })),
      );
    }
  }

  // B2 testleri
  if ((targetProvider === "b2" || targetProvider === "all") && isB2Configured()) {
    for (const bucket of listConfiguredB2Buckets()) {
      tasks.push(
        testB2Connectivity(bucket).then((r) => ({ provider: "b2" as const, bucket, ...r })),
      );
    }
  }

  if (tasks.length === 0) {
    res.status(400).json({
      error:
        targetProvider === "all"
          ? "Hiç depolama servisi yapılandırılmamış"
          : `${targetProvider.toUpperCase()} yapılandırılmamış`,
    });
    return;
  }

  try {
    const results = await Promise.all(tasks);
    const allOk = results.every((r) => r.success);

    req.log.info(
      { adminId: req.session.userId, results: results.map((r) => ({ provider: r.provider, bucket: r.bucket, success: r.success, latencyMs: r.latencyMs })) },
      "Admin storage connectivity test",
    );

    res.json({ ok: allOk, results });
  } catch (err) {
    req.log.error({ err }, "Admin storage test error");
    res.status(500).json({ error: "Test sırasında beklenmeyen hata oluştu" });
  }
});

// ── GET /api/admin/r2/stats ───────────────────────────────────────────────
// Depolama istatistikleri: R2 + B2 bucket başına dosya/boyut dağılımı,
// şifreleme durumu, yapılandırma kontrolü. Firebase kayıtlarından okur;
// R2/B2'ye ayrıca istek göndermez (hızlı ve ücretsiz).
//
// Güvenlik: şifreleme anahtarları (encryptionKeyHex) asla döndürülmez.
// Yalnızca "şifreli mi?" (boolean) bilgisi verilir.
router.get("/admin/r2/stats", requireAdmin, adminLimiter, async (req, res): Promise<void> => {
  const storage = getStorageSummary();
  const db = getFirebaseDb();

  if (!db) {
    res.json({
      r2Configured: storage.r2Configured,
      b2Configured: storage.b2Configured,
      firebaseConnected: false,
      configuredBuckets: storage.r2Buckets,
      b2Buckets: storage.b2Buckets,
      totals: { fileCount: 0, totalBytes: 0, encryptedCount: 0, unencryptedCount: 0 },
      bucketBreakdown: {},
      files: [],
    });
    return;
  }

  try {
    const snap = await db.ref("filesplit_files").once("value");
    const records = snap.val() as Record<string, FileRecord> | null;

    if (!records) {
      res.json({
        r2Configured: storage.r2Configured,
        b2Configured: storage.b2Configured,
        firebaseConnected: true,
        configuredBuckets: storage.r2Buckets,
        b2Buckets: storage.b2Buckets,
        totals: { fileCount: 0, totalBytes: 0, encryptedCount: 0, unencryptedCount: 0 },
        bucketBreakdown: {},
        files: [],
      });
      return;
    }

    const bucketBreakdown: Record<
      string,
      { fileCount: number; totalBytes: number; provider: "r2" | "b2" | "unknown" }
    > = {};
    const files: Array<{
      fileId: string;
      name: string;
      size: number;
      mimeType: string;
      userId: string | undefined;
      chunkCount: number;
      provider: "r2" | "b2" | "unknown";
      bucket: string;
      encrypted: boolean;
      uploadedAt: string;
      storageUploadedAt: string | undefined;
      expiresAt: string | null;
    }> = [];
    let totalBytes = 0;
    let encryptedCount = 0;

    for (const [fileId, record] of Object.entries(records)) {
      if (!record?.meta?.id) continue;

      const provider: "r2" | "b2" | "unknown" = record.r2?.provider ?? "r2";
      const bucket = record.r2?.bucket ?? "unknown";
      const size = record.meta.size ?? 0;
      // SEC: encryptionKeyHex asla dışarı verilmez — yalnızca boolean flag
      const encrypted = !!(record.r2?.encryptionKeyHex);

      const breakdownKey = `[${provider}] ${bucket}`;
      if (!bucketBreakdown[breakdownKey]) {
        bucketBreakdown[breakdownKey] = { fileCount: 0, totalBytes: 0, provider };
      }
      bucketBreakdown[breakdownKey].fileCount++;
      bucketBreakdown[breakdownKey].totalBytes += size;
      totalBytes += size;
      if (encrypted) encryptedCount++;

      files.push({
        fileId,
        name: record.meta.name,
        size,
        mimeType: record.meta.mimeType,
        userId: record.meta.userId,
        chunkCount: record.meta.chunkCount,
        provider,
        bucket,
        encrypted,
        uploadedAt: record.meta.uploadedAt,
        storageUploadedAt: record.r2?.uploadedAt,
        expiresAt: record.meta.expiresAt ?? null,
      });
    }

    const fileCount = files.length;

    req.log.info({ adminId: req.session.userId, fileCount }, "Admin viewed storage stats");

    res.json({
      r2Configured: storage.r2Configured,
      b2Configured: storage.b2Configured,
      firebaseConnected: true,
      configuredBuckets: storage.r2Buckets,
      b2Buckets: storage.b2Buckets,
      totals: {
        fileCount,
        totalBytes,
        encryptedCount,
        unencryptedCount: fileCount - encryptedCount,
      },
      bucketBreakdown,
      // En yeni yükleme en üstte
      files: files.sort(
        (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime(),
      ),
    });
  } catch (err) {
    req.log.error({ err }, "Admin storageStats error");
    res.status(500).json({ error: "Depolama istatistikleri alınamadı" });
  }
});

export default router;
