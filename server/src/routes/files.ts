import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import {
  ensureUploadsDir,
  saveMeta,
  readMeta,
  listAllFiles,
  deleteFile,
  splitAndSaveFromPath,
  buildChunkUrls,
  generateSnippet,
  getChunkPath,
  isFileExpired,
  isValidFileId,
  CHUNK_SIZE,
  MAX_FILE_SIZE,
  MAX_USER_STORAGE_BYTES,
  getUserStorageUsed,
  UPLOAD_PART_SIZE,
  uploadsDir,
  getUploadTempDir,
  getPartPath,
  cleanupUpload,
  isValidUploadId,
  assembleAndSplit,
  listVersions,
  nextVersion,
  type FileMeta,
  saveFolderMeta,
  readFolderMeta,
  listFolders,
  deleteFolderMeta,
  isValidFolderId,
  type FolderMeta,
} from "../lib/fileStore.js";
import { getUserLimits, findUserById } from "../lib/userStore.js";
import { getFirebaseDb } from "../lib/firebase.js";
import {
  getSession,
  setSession,
  deleteSession,
  countUserSessions,
  purgeStaleUploadSessions,
  MAX_SESSIONS_PER_USER,
  type UploadSession,
} from "../lib/uploadSessionStore.js";
import {
  isAnyStorageConfigured,
  generateEncryptionKey,
  uploadChunkToStorage,
  downloadChunkFromStorage,
  deleteFileChunksFromStorage,
  pickUploadTarget,
  type StorageTarget,
} from "../lib/storageProvider.js";
import {
  saveFileRecord,
  getFileRecord,
  deleteFileRecord,
  type R2FileInfo,
} from "../lib/fileRegistry.js";

const router: IRouter = Router();

ensureUploadsDir();

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.userId) {
    res.status(401).json({ error: "Giriş yapmanız gerekiyor" });
    return;
  }
  next();
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      ensureUploadsDir();
      cb(null, uploadsDir);
    },
    filename: (_req, _file, cb) => {
      cb(null, `tmp_${uuidv4()}`);
    },
  }),
  limits: {
    fileSize: MAX_FILE_SIZE,
    // SEC: CVE-2025-48997 — multer <2.0.1 allows DoS via empty field names.
    // Upgrading to >=2.0.1 is the primary fix; these limits are belt-and-
    // suspenders: reject oversized field names and cap total fields to 1
    // (this endpoint only accepts a single file field).
    fieldNameSize: 256,
    fields: 1,
  },
});

const TTL_OPTIONS: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const MAX_CHUNK_COUNT = 10_000;

// ── SEC: MIME type allowlist ──────────────────────────────────────────────────
// Client-supplied mimeType is stored and later served as Content-Type.
// Dangerous types can enable XSS / MIME-confusion attacks in some browsers.
const BLOCKED_MIME_TYPES = new Set([
  "text/html", "text/xml", "application/xhtml+xml",
  "text/javascript", "application/javascript", "application/x-javascript",
  "application/xml", "image/svg+xml",
]);

function sanitizeMimeType(raw: string): string {
  const lower = (raw || "").toLowerCase().split(";")[0].trim();
  return BLOCKED_MIME_TYPES.has(lower) ? "application/octet-stream" : (lower || "application/octet-stream").slice(0, 128);
}

// Upload session management is handled by uploadSessionStore.ts.
// Types and Map are imported from there so index.ts can also reach the
// purge function for the scheduled maintenance sweep.

// Maximum number of file IDs kept in a session's unlockedFiles list
const MAX_UNLOCKED_FILES = 200;

// BUL-08: per-user upload rate limit (50 uploads/hour)
// uploadLimiter: guards upload-init and upload-finalize — low ceiling is fine
// because these are called once per file, not once per chunk.
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Çok fazla yükleme denemesi. Lütfen bir saat bekleyin." },
  keyGenerator: (req: Request) => (req.session as Record<string, unknown>)?.["userId"] as string ?? req.ip ?? "unknown",
});

// partLimiter: guards upload-part exclusively. Must be much more permissive because
// a single large file generates hundreds of part requests.
// Ceiling formula: max file size (100 GB) / min chunk size (512 KB) = ~200 000 parts.
// A practical daily ceiling of 6 000 parts/hour supports a ~30 GB file with 5 MB chunks
// without false-positive 429s, while still blocking runaway upload abuse.
const partLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 6000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Çok fazla part isteği. Lütfen bekleyin." },
  keyGenerator: (req: Request) => (req.session as Record<string, unknown>)?.["userId"] as string ?? req.ip ?? "unknown",
});

// BUL-04: download rate limit — endpoint intentionally public for embed/direct download but rate-limited
const downloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Çok fazla indirme isteği. Lütfen bekleyin." },
});

// Rate limit for password unlock attempts — keyed per IP+fileId to prevent brute force
const unlockLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Çok fazla hatalı deneme. Lütfen 15 dakika bekleyin." },
  keyGenerator: (req: Request) =>
    `${req.ip ?? "unknown"}:${req.params["fileId"] ?? ""}`,
});

function canAccess(
  meta: FileMeta,
  req: Request,
): { ok: true } | { ok: false; status: 401 | 403; body: object } {
  const isOwner = !!req.session.userId && meta.userId === req.session.userId;
  if (isOwner) return { ok: true };

  if (meta.requireLogin && !req.session.userId) {
    return {
      ok: false,
      status: 401,
      body: {
        error: "Bu dosyayı görüntülemek için giriş yapmanız gerekiyor",
        requireLogin: true,
      },
    };
  }

  if (meta.passwordHash) {
    const unlocked =
      Array.isArray(req.session.unlockedFiles) &&
      req.session.unlockedFiles.includes(meta.id);
    if (!unlocked) {
      return {
        ok: false,
        status: 403,
        body: { error: "Bu dosya şifre korumalı", requirePassword: true },
      };
    }
  }

  return { ok: true };
}

async function buildPublicMeta(meta: FileMeta, req: Request) {
  // SEC: strip userId, passwordHash, and sha256 from the public shape.
  // sha256 is only surfaced back to the owner — it is not needed by other
  // downloaders and leaking it needlessly increases the attack surface for
  // any future hash-based exploitation primitives.
  const { userId: _u, passwordHash: _p, sha256: _hash, ...rest } = meta;
  const isOwner = !!req.session.userId && meta.userId === req.session.userId;

  // Look up uploader's username to display on the file page (never expose userId).
  let uploaderUsername: string | undefined;
  if (meta.userId) {
    try {
      const uploader = await findUserById(meta.userId);
      uploaderUsername = uploader?.username;
    } catch {
      // non-fatal — username just won't appear
    }
  }

  return {
    ...rest,
    isOwner,
    requireLogin: !!meta.requireLogin,
    hasPassword: !!meta.passwordHash,
    uploaderUsername,
    ...(isOwner && meta.sha256 ? { sha256: meta.sha256 } : {}),
  };
}

function getBaseUrl(req: Request): string {
  // BUL-07: prefer ALLOWED_ORIGINS env to avoid Host header injection
  const allowedOrigins = process.env["ALLOWED_ORIGINS"];
  if (allowedOrigins) {
    const first = allowedOrigins.split(",")[0]?.trim();
    if (first) return first;
  }
  const host = req.get("host") ?? "localhost";
  const forwardedProto = req.get("x-forwarded-proto");
  const protocol = forwardedProto ?? req.protocol ?? "http";
  return `${protocol}://${host}`;
}

// BUL-08: shared per-user storage quota check — now async to read per-user
// storage quota overrides from the database.
async function checkUserQuota(
  userId: string,
  incomingBytes: number,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { storageQuotaBytes } = await getUserLimits(userId);
  const used = getUserStorageUsed(userId);
  if (used + incomingBytes <= storageQuotaBytes) {
    return { ok: true };
  }
  const usedMb = (used / 1024 / 1024).toFixed(1);
  const limitMb = Math.round(storageQuotaBytes / 1024 / 1024);
  return {
    ok: false,
    message: `Depolama kotanız doldu (${usedMb} MB / ${limitMb} MB kullanılıyor). Devam etmek için bazı dosyaları silin.`,
  };
}

// ── Depolama Yardımcı Fonksiyonları ──────────────────────────────────────────

/**
 * Yerel chunk'ları bulut depolama servisine (R2 veya B2) şifreleyerek yükler
 * ve kaydı Firebase'e yazar.
 * Background olarak çalışır — yanıt zaten gönderilmiştir.
 * Hata yerel dosyalara dokunmaz; bulut depolama yedek katman olarak işlev görür.
 */
async function uploadFileChunksToStorage(
  meta: FileMeta,
  log: Request["log"],
): Promise<void> {
  if (!isAnyStorageConfigured()) return;

  const encryptionKey = generateEncryptionKey();
  // Round-robin hedef seçimi — R2 ve B2 bucket'ları arasında dağıtım
  const target: StorageTarget = pickUploadTarget();

  // Chunk'ları paralel yükle (en fazla 6 eşzamanlı — ağı sarmamak için)
  const CONCURRENCY = 6;
  for (let start = 0; start < meta.chunkCount; start += CONCURRENCY) {
    const batch = Array.from(
      { length: Math.min(CONCURRENCY, meta.chunkCount - start) },
      (_, j) => {
        const i = start + j;
        const chunkPath = getChunkPath(meta.id, i);
        const data = fs.readFileSync(chunkPath);
        return uploadChunkToStorage(target, meta.id, i, data, encryptionKey).catch((err: unknown) => {
          log.error(
            { err, fileId: meta.id, chunkIndex: i, provider: target.provider, bucket: target.bucket },
            "Storage chunk upload failed",
          );
          throw err;
        });
      },
    );
    await Promise.all(batch);
  }

  const r2Info: R2FileInfo = {
    provider: target.provider,
    bucket: target.bucket,
    encryptionKeyHex: encryptionKey.toString("hex"),
    chunkCount: meta.chunkCount,
    uploadedAt: new Date().toISOString(),
  };

  await saveFileRecord(meta, r2Info);
  log.info(
    { fileId: meta.id, chunkCount: meta.chunkCount, provider: target.provider, bucket: target.bucket },
    "File chunks uploaded to storage",
  );
}

/**
 * Eksik bir chunk'ı bulut depolamadan (R2 veya B2) on-demand olarak geri yükler.
 * Başarılıysa chunk yerel diske yazılır ve `true` döner.
 * Depolama servisi yapılandırılmamışsa veya kayıt bulunamazsa `false` döner.
 */
async function tryRestoreChunkFromStorage(
  fileId: string,
  chunkIndex: number,
  log: Request["log"],
): Promise<boolean> {
  if (!isAnyStorageConfigured()) return false;

  try {
    const record = await getFileRecord(fileId);
    if (!record?.r2?.encryptionKeyHex) return false;

    const encryptionKey = Buffer.from(record.r2.encryptionKeyHex, "hex");
    if (encryptionKey.length !== 32) {
      log.warn({ fileId, chunkIndex }, "Invalid encryption key length in Firebase record");
      return false;
    }

    const target: StorageTarget = {
      provider: record.r2.provider ?? "r2",
      bucket: record.r2.bucket,
    };
    log.info({ fileId, chunkIndex, provider: target.provider, bucket: target.bucket }, "Restoring chunk from storage");
    const plaintext = await downloadChunkFromStorage(target, fileId, chunkIndex, encryptionKey);

    const chunkPath = getChunkPath(fileId, chunkIndex);
    const dir = path.dirname(chunkPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(chunkPath, plaintext);

    log.info({ fileId, chunkIndex, bytes: plaintext.length }, "Chunk restored from storage");
    return true;
  } catch (err) {
    log.error({ err, fileId, chunkIndex }, "Failed to restore chunk from storage");
    return false;
  }
}

/**
 * Bir dosyanın tüm eksik chunk'larını bulut depolamadan (R2 veya B2) toplu olarak geri yükler.
 * Firebase kaydı TEK SEFERLE okunur (N chunk için N istek yerine 1 istek).
 * Download endpoint için kullanılır.
 * @returns Tüm chunk'lar sağlanabiliyorsa true
 */
async function ensureAllChunksLocal(
  meta: FileMeta,
  log: Request["log"],
): Promise<boolean> {
  // Hızlı yol: tüm chunk'lar mevcutsa Firebase'e hiç dokunma
  const missingIndices: number[] = [];
  for (let i = 0; i < meta.chunkCount; i++) {
    if (!fs.existsSync(getChunkPath(meta.id, i))) missingIndices.push(i);
  }
  if (missingIndices.length === 0) return true;

  if (!isAnyStorageConfigured()) return false;

  // Firebase kaydını bir kere çek — provider + bucket + anahtar
  const record = await getFileRecord(meta.id);
  if (!record?.r2?.encryptionKeyHex || !record.r2.bucket) return false;

  const encryptionKey = Buffer.from(record.r2.encryptionKeyHex, "hex");
  if (encryptionKey.length !== 32) {
    log.warn({ fileId: meta.id }, "Invalid encryption key length in Firebase record");
    return false;
  }

  const target: StorageTarget = {
    provider: record.r2.provider ?? "r2",
    bucket: record.r2.bucket,
  };

  for (const i of missingIndices) {
    try {
      log.info(
        { fileId: meta.id, chunkIndex: i, provider: target.provider, bucket: target.bucket },
        "Restoring chunk from storage (batch)",
      );
      const plaintext = await downloadChunkFromStorage(target, meta.id, i, encryptionKey);
      const chunkPath = getChunkPath(meta.id, i);
      fs.mkdirSync(path.dirname(chunkPath), { recursive: true });
      fs.writeFileSync(chunkPath, plaintext);
      log.info({ fileId: meta.id, chunkIndex: i, bytes: plaintext.length }, "Chunk restored");
    } catch (err) {
      log.error({ err, fileId: meta.id, chunkIndex: i }, "Failed to restore chunk from storage");
      return false;
    }
  }
  return true;
}

// ── Storage stats — authenticated, returns per-user resolved limits + usage ──
router.get("/user/storage", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId as string;
  const [userLimits, usedBytes] = await Promise.all([
    getUserLimits(userId),
    Promise.resolve(getUserStorageUsed(userId)),
  ]);
  res.json({
    usedBytes,
    totalBytes: userLimits.storageQuotaBytes,
    freeBytes: Math.max(0, userLimits.storageQuotaBytes - usedBytes),
    maxFileSizeBytes: userLimits.maxFileSizeBytes,
    chunkSizeBytes: userLimits.chunkSizeBytes,
  });
});

router.get("/folders", requireAuth, async (req, res): Promise<void> => {
  const folders = listFolders(req.session.userId);
  res.json(folders);
});

router.post("/folders", requireAuth, async (req, res): Promise<void> => {
  const { name } = req.body as { name?: string };
  if (!name || typeof name !== "string" || name.trim().length === 0) {
    res.status(400).json({ error: "Klasör adı gereklidir" });
    return;
  }
  if (name.trim().length > 128) {
    res.status(400).json({ error: "Klasör adı en fazla 128 karakter olabilir" });
    return;
  }

  const folder: FolderMeta = {
    id: uuidv4(),
    userId: req.session.userId,
    name: name.trim(),
    createdAt: new Date().toISOString(),
  };
  saveFolderMeta(folder);
  req.log.info({ folderId: folder.id, name: folder.name }, "Folder created");
  res.status(201).json(folder);
});

router.delete("/folders/:folderId", requireAuth, async (req, res): Promise<void> => {
  const { folderId } = req.params;
  if (!folderId || !isValidFolderId(folderId)) {
    res.status(400).json({ error: "Geçersiz klasör ID'si" });
    return;
  }

  const folder = readFolderMeta(folderId);
  if (!folder) {
    res.status(404).json({ error: "Klasör bulunamadı" });
    return;
  }
  if (folder.userId !== req.session.userId) {
    res.status(403).json({ error: "Bu klasöre erişim izniniz yok" });
    return;
  }

  const allFiles = listAllFiles(req.session.userId);
  for (const file of allFiles) {
    if (file.folderId === folderId) {
      const updated = { ...file, folderId: undefined };
      saveMeta(updated);
    }
  }

  deleteFolderMeta(folderId);
  req.log.info({ folderId }, "Folder deleted");
  res.sendStatus(204);
});

router.patch("/files/:fileId/folder", requireAuth, async (req, res): Promise<void> => {
  const { fileId } = req.params;
  const { folderId } = req.body as { folderId?: string | null };

  if (!fileId || !isValidFileId(fileId)) {
    res.status(400).json({ error: "Geçersiz dosya ID'si" });
    return;
  }

  const meta = readMeta(fileId);
  if (!meta) {
    res.status(404).json({ error: "Dosya bulunamadı" });
    return;
  }
  if (meta.userId !== req.session.userId) {
    res.status(403).json({ error: "Bu dosyaya erişim izniniz yok" });
    return;
  }

  if (folderId && folderId !== null) {
    if (!isValidFolderId(folderId)) {
      res.status(400).json({ error: "Geçersiz klasör ID'si" });
      return;
    }
    const folderMeta = readFolderMeta(folderId);
    if (!folderMeta) {
      res.status(404).json({ error: "Klasör bulunamadı" });
      return;
    }
    if (folderMeta.userId !== req.session.userId) {
      res.status(403).json({ error: "Bu klasöre erişim izniniz yok" });
      return;
    }
    meta.folderId = folderId;
  } else {
    delete meta.folderId;
  }

  saveMeta(meta);
  res.json(meta);
});

router.post(
  "/files/upload",
  requireAuth,
  uploadLimiter,
  upload.single("file"),
  async (req, res): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: "Dosya bulunamadı" });
      return;
    }

    const tempPath = path.join(uploadsDir, req.file.filename);

    // BUL-08: enforce per-user storage quota using the real, measured upload
    // size (req.file.size comes from multer after the bytes are on disk, not
    // a client-supplied claim).
    const quota = await checkUserQuota(req.session.userId as string, req.file.size);
    if (!quota.ok) {
      try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
      res.status(413).json({ error: quota.message });
      return;
    }

    try {
      ensureUploadsDir();
      const fileId = uuidv4();
      const fileSize = req.file.size;
      const chunkCount = splitAndSaveFromPath(fileId, tempPath);
      const baseUrl = getBaseUrl(req);
      const chunkUrls = buildChunkUrls(fileId, chunkCount, baseUrl);

      const ttlKey = typeof req.body?.ttl === "string" ? req.body.ttl : null;
      let expiresAt: string | undefined;
      if (ttlKey && TTL_OPTIONS[ttlKey]) {
        expiresAt = new Date(Date.now() + TTL_OPTIONS[ttlKey]).toISOString();
      }

      // BUL-16: verify the folder actually belongs to the uploading user
      // before assigning the file to it (previously only checked that the
      // folder existed, not who owned it).
      const requestedFolderId = typeof req.body?.folderId === "string" && isValidFolderId(req.body.folderId)
        ? req.body.folderId : undefined;
      const requestedFolderMeta = requestedFolderId ? readFolderMeta(requestedFolderId) : null;
      const folderId = requestedFolderMeta?.userId === req.session.userId ? requestedFolderId : undefined;

      const meta: FileMeta = {
        id: fileId,
        userId: req.session.userId,
        name: (req.file.originalname ?? "").slice(0, 512) || "untitled",
        size: fileSize,
        mimeType: sanitizeMimeType(req.file.mimetype || "application/octet-stream"),
        chunkCount,
        chunkSize: CHUNK_SIZE,
        uploadedAt: new Date().toISOString(),
        chunkUrls,
        ...(expiresAt ? { expiresAt } : {}),
        ...(folderId ? { folderId } : {}),
      };

      saveMeta(meta);
      // ── R2: chunk'ları arka planda yükle (yanıt gecikmesin)
      void uploadFileChunksToStorage(meta, req.log).catch((err: unknown) => {
        req.log.error({ err, fileId }, "R2 background upload failed (simple)");
      });
      req.log.info({ fileId, name: meta.name, chunkCount }, "File uploaded");
      res.status(201).json(meta);
    } catch (err) {
      try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
      req.log.error({ err }, "Upload failed");
      res.status(500).json({ error: "Yükleme başarısız" });
    }
  },
);

router.post("/files/upload-init", requireAuth, uploadLimiter, async (req, res): Promise<void> => {
  const { name, size, mimeType } = req.body as {
    name: string;
    size: number;
    mimeType: string;
  };

  if (!name || typeof name !== "string" || name.length > 512) {
    res.status(400).json({ error: "Geçersiz dosya adı" });
    return;
  }
  // Resolve per-user limits before size checks so the error message is accurate.
  const userLimits = await getUserLimits(req.session.userId as string);
  if (typeof size !== "number" || size <= 0 || size > userLimits.maxFileSizeBytes) {
    res.status(400).json({
      error: `Dosya boyutunuz limitinizi geçiyor! (maks ${(userLimits.maxFileSizeBytes / 1024 / 1024).toFixed(0)} MB)`,
    });
    return;
  }
  if (!mimeType || typeof mimeType !== "string") {
    res.status(400).json({ error: "Geçersiz MIME türü" });
    return;
  }

  // BUL-08: early/soft quota check using the client-declared size, so an
  // obviously-over-quota upload is rejected before the user spends time
  // uploading parts. The authoritative check happens again at finalize time
  // using the real, server-measured size.
  const earlyQuota = await checkUserQuota(req.session.userId as string, size);
  if (!earlyQuota.ok) {
    res.status(413).json({ error: earlyQuota.message });
    return;
  }

  // SEC-DoS: cap concurrent in-progress uploads per user.
  // Without this, a single user can call upload-init thousands of times to
  // pin arbitrarily many large-file slots in RAM and on disk.
  const activeSessions = countUserSessions(req.session.userId as string);
  if (activeSessions >= MAX_SESSIONS_PER_USER) {
    res.status(429).json({
      error: `Aynı anda en fazla ${MAX_SESSIONS_PER_USER} yükleme başlatabilirsiniz. Lütfen bekleyip tekrar deneyin.`,
    });
    return;
  }

  const uploadId = uuidv4();
  ensureUploadsDir();
  fs.mkdirSync(getUploadTempDir(uploadId), { recursive: true });

  // Purge stale sessions eagerly on every init so the Map cannot grow
  // without bound between scheduler ticks.
  purgeStaleUploadSessions();

  const now = Date.now();
  // SEC-IDOR: bind uploadId → session. Includes maxBytes (disk-exhaustion guard),
  // userId (per-user cap), and dual-axis TTL fields (createdAt + lastActivityAt).
  setSession(uploadId, {
    sessionId: req.sessionID,
    userId: req.session.userId as string,
    maxBytes: size,
    receivedBytes: 0,
    createdAt: now,
    lastActivityAt: now,
    userMaxFileSizeBytes: userLimits.maxFileSizeBytes,
    chunkSizeBytes: userLimits.chunkSizeBytes,
  });

  req.log.info({ uploadId, name, size, chunkSizeBytes: userLimits.chunkSizeBytes }, "Upload session initialised");
  // partSize is the authoritative chunk size the client must use for this session.
  // It comes from the user's per-user resolved limits (Firebase → server default fallback).
  res.status(201).json({ uploadId, partSize: userLimits.chunkSizeBytes });
});

const partUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const uploadId = req.body?.uploadId as string | undefined;
      if (!uploadId || !isValidUploadId(uploadId)) { cb(new Error("Geçersiz uploadId"), ""); return; }
      const dir = getUploadTempDir(uploadId);
      if (!fs.existsSync(dir)) { cb(new Error("Bilinmeyen uploadId"), ""); return; }
      // SEC-IDOR: enforce session ownership *before* writing bytes to disk so an
      // attacker who guesses a UUID cannot inject parts into someone else's upload.
      const rec = getSession(uploadId);
      if (!rec || rec.sessionId !== req.sessionID) {
        cb(new Error("Bu yükleme oturumu size ait değil"), "");
        return;
      }
      cb(null, dir);
    },
    filename: (req, _file, cb) => {
      const idx = parseInt(req.body?.partIndex ?? "", 10);
      // SEC: reject NaN/out-of-range partIndex here so multer never writes an
      // orphan "part_NaN" file that would accumulate on disk indefinitely.
      if (isNaN(idx) || idx < 0 || idx >= MAX_CHUNK_COUNT) {
        cb(new Error("Geçersiz partIndex"), "");
        return;
      }
      cb(null, `part_${idx}`);
    },
  }),
  // Hard cap: 100 MB + framing overhead per part.
  // This is the absolute server-side ceiling regardless of per-user chunkSizeBytes.
  // Per-user enforcement (tighter cap) is applied in the route handler after multer,
  // so that the error message can include the user's actual limit.
  limits: { fileSize: 100 * 1024 * 1024 + 1024 },
});

router.post(
  "/files/upload-part",
  requireAuth,
  partLimiter,   // separate, higher ceiling — see partLimiter definition above
  partUpload.single("part"),
  async (req, res): Promise<void> => {
    const { uploadId } = req.body as { uploadId: string };
    const partIndex = parseInt(req.body?.partIndex ?? "", 10);

    if (!uploadId || !isValidUploadId(uploadId) || isNaN(partIndex) || partIndex < 0) {
      res.status(400).json({ error: "Geçersiz uploadId veya partIndex" });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "Part verisi bulunamadı" });
      return;
    }
    // SEC-DoS: track cumulative received bytes; reject if the running total
    // exceeds the client-declared size (+ 1 % framing overhead, capped at
    // MAX_FILE_SIZE). This prevents disk exhaustion via 10 k × 5 MB parts
    // that would only be caught by the quota check at finalize time.
    const rec = getSession(uploadId);
    if (!rec) {
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
      res.status(403).json({ error: "Bu yükleme oturumu bulunamadı veya süresi doldu" });
      return;
    }
    // SEC: per-part size guard — rejects any single part that exceeds the user's
    // chunkSizeBytes limit. Multer already blocked parts > 100 MB (server hard cap);
    // this enforces the tighter per-user cap with a precise error message.
    // A 1 KB framing allowance covers multipart/form-data boundary overhead.
    if (req.file.size > rec.chunkSizeBytes + 1024) {
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
      res.status(413).json({
        error: `Part boyutu limitinizi aşıyor (maks ${(rec.chunkSizeBytes / 1024 / 1024).toFixed(1)} MB / parça)`,
      });
      return;
    }

    rec.receivedBytes += req.file.size;
    const ceiling = Math.min(rec.maxBytes * 1.01 + 1024, rec.userMaxFileSizeBytes);
    if (rec.receivedBytes > ceiling) {
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
      deleteSession(uploadId);
      cleanupUpload(uploadId);
      res.status(413).json({ error: "Toplam yükleme boyutu bildirilen boyutu aşıyor" });
      return;
    }

    // Advance the inactivity timer so a genuinely slow upload isn't evicted.
    rec.lastActivityAt = Date.now();

    req.log.info({ uploadId, partIndex, bytes: req.file.size }, "Part received");
    res.json({ ok: true, partIndex });
  },
);

router.post("/files/upload-finalize", requireAuth, uploadLimiter, async (req, res): Promise<void> => {
  const { uploadId, name, size, mimeType, totalParts, sha256, ttl, parentFileId, folderId } = req.body as {
    uploadId: string;
    name: string;
    size: number;
    mimeType: string;
    totalParts: number;
    sha256: string;
    ttl?: string;
    parentFileId?: string;
    folderId?: string;
  };

  if (!uploadId || !isValidUploadId(uploadId) || !name || !size || !mimeType || !totalParts || !sha256) {
    res.status(400).json({ error: "Eksik alanlar var" });
    return;
  }
  // SEC-DoS: reject unreasonably large totalParts before touching the filesystem
  if (!Number.isInteger(totalParts) || totalParts <= 0 || totalParts > MAX_CHUNK_COUNT) {
    res.status(400).json({ error: `Geçersiz totalParts (maks ${MAX_CHUNK_COUNT})` });
    return;
  }
  // SEC-IDOR: verify this request comes from the same session that called upload-init
  if (getSession(uploadId)?.sessionId !== req.sessionID) {
    res.status(403).json({ error: "Bu yükleme oturumu size ait değil" });
    return;
  }

  const tempDir = getUploadTempDir(uploadId);
  if (!fs.existsSync(tempDir)) {
    res.status(404).json({ error: "Yükleme oturumu bulunamadı" });
    return;
  }

  for (let i = 0; i < totalParts; i++) {
    if (!fs.existsSync(getPartPath(uploadId, i))) {
      res.status(400).json({ error: `Part ${i} eksik` });
      return;
    }
  }

  const fileId = uuidv4();

  try {
    const chunkCount = assembleAndSplit(uploadId, fileId, totalParts);
    const baseUrl = getBaseUrl(req);

    const { createHash } = await import("crypto");
    const fileHash = createHash("sha256");
    let measuredBytes = 0;
    for (let i = 0; i < chunkCount; i++) {
      const chunkPath = path.join(uploadsDir, fileId, `chunk_${i}.bin`);
      const chunkBuf = fs.readFileSync(chunkPath);
      fileHash.update(chunkBuf);
      measuredBytes += chunkBuf.length;
    }
    const serverHash = fileHash.digest("hex");

    if (serverHash !== sha256.toLowerCase()) {
      deleteFile(fileId);
      req.log.warn({ uploadId, fileId }, "SHA-256 mismatch");
      res.status(409).json({ error: "Bütünlük kontrolü başarısız: SHA-256 uyuşmuyor. Lütfen tekrar deneyin." });
      return;
    }

    // BUL-08: authoritative quota check using the real, measured byte count
    // (not the client-declared `size`), now that the file is fully assembled
    // on disk. The early check in upload-init only catches the obvious case;
    // this is what actually enforces the limit.
    const finalQuota = await checkUserQuota(req.session.userId as string, measuredBytes);
    if (!finalQuota.ok) {
      deleteFile(fileId);
      res.status(413).json({ error: finalQuota.message });
      return;
    }

    const ttlKey = typeof ttl === "string" ? ttl : null;
    let expiresAt: string | undefined;
    if (ttlKey && TTL_OPTIONS[ttlKey]) {
      expiresAt = new Date(Date.now() + TTL_OPTIONS[ttlKey]).toISOString();
    }

    let groupId: string | undefined;
    let version: number | undefined;

    if (parentFileId) {
      const parentMeta = readMeta(parentFileId);
      if (parentMeta && parentMeta.userId === req.session.userId) {
        if (parentMeta.groupId) {
          groupId = parentMeta.groupId;
        } else {
          groupId = uuidv4();
          parentMeta.groupId = groupId;
          parentMeta.version = 1;
          saveMeta(parentMeta);
        }
        version = nextVersion(groupId);
      }
    }

    const _finalizeFolderMeta = folderId && isValidFolderId(folderId) ? readFolderMeta(folderId) : null;
    // BUL-16: verify folder belongs to current user in upload-finalize
    const resolvedFolderId = _finalizeFolderMeta?.userId === req.session.userId ? folderId : undefined;

    const chunkUrls = buildChunkUrls(fileId, chunkCount, baseUrl);
    const meta: FileMeta = {
      id: fileId,
      userId: req.session.userId,
      name,
      size: measuredBytes,
      mimeType: sanitizeMimeType(mimeType),
      chunkCount,
      chunkSize: CHUNK_SIZE,
      uploadedAt: new Date().toISOString(),
      chunkUrls,
      sha256: serverHash,
      ...(expiresAt ? { expiresAt } : {}),
      ...(groupId ? { groupId, version } : {}),
      ...(resolvedFolderId ? { folderId: resolvedFolderId } : {}),
    };

    saveMeta(meta);
    // ── R2: chunk'ları arka planda yükle (yanıt gecikmesin)
    void uploadFileChunksToStorage(meta, req.log).catch((err: unknown) => {
      req.log.error({ err, fileId: meta.id }, "R2 background upload failed (finalize)");
    });
    // SEC-IDOR: release the uploadId → sessionID binding now that finalize is done
    deleteSession(uploadId);
    req.log.info({ fileId, name, chunkCount }, "Chunked upload finalised");
    res.status(201).json(meta);
  } catch (err) {
    deleteSession(uploadId);
    cleanupUpload(uploadId);
    try { deleteFile(fileId); } catch { /* ignore */ }
    req.log.error({ err }, "Finalise failed");
    res.status(500).json({ error: "Dosya birleştirme başarısız" });
  }
});

router.get("/files", requireAuth, async (req, res): Promise<void> => {
  ensureUploadsDir();
  let files = listAllFiles(req.session.userId);
  const { folderId } = req.query as { folderId?: string };
  if (folderId === "root") {
    files = files.filter((f) => !f.folderId);
  } else if (folderId && isValidFolderId(folderId)) {
    files = files.filter((f) => f.folderId === folderId);
  }
  res.json(files);
});

router.get("/files/group/:groupId", requireAuth, async (req, res): Promise<void> => {
  const { groupId } = req.params;
  if (!groupId || !isValidFileId(groupId)) {
    res.status(400).json({ error: "Geçersiz groupId" });
    return;
  }
  const versions = listVersions(groupId).filter((f) => f.userId === req.session.userId);
  res.json(versions);
});

router.get("/files/:fileId", async (req, res): Promise<void> => {
  const { fileId } = req.params;
  if (!fileId || !isValidFileId(fileId)) {
    res.status(400).json({ error: "Geçersiz dosya ID'si" });
    return;
  }

  const meta = readMeta(fileId);
  if (!meta) {
    res.status(404).json({ error: "Dosya bulunamadı" });
    return;
  }

  if (isFileExpired(meta)) {
    deleteFile(meta.id);
    res.status(410).json({ error: "Dosyanın süresi doldu" });
    return;
  }

  const access = canAccess(meta, req);
  if (!access.ok) {
    res.status(access.status).json(access.body);
    return;
  }

  res.json(await buildPublicMeta(meta, req));
});

router.post("/files/:fileId/unlock", unlockLimiter, async (req, res): Promise<void> => {
  const { fileId } = req.params;
  if (!fileId || !isValidFileId(fileId)) {
    res.status(400).json({ error: "Geçersiz dosya ID'si" });
    return;
  }

  const meta = readMeta(fileId);
  if (!meta) {
    res.status(404).json({ error: "Dosya bulunamadı" });
    return;
  }

  if (isFileExpired(meta)) {
    deleteFile(meta.id);
    res.status(410).json({ error: "Dosyanın süresi doldu" });
    return;
  }

  if (!meta.passwordHash) {
    res.status(400).json({ error: "Bu dosya şifre korumalı değil" });
    return;
  }

  const { password } = req.body as { password?: unknown };
  if (!password || typeof password !== "string" || password.length > 256) {
    res.status(400).json({ error: "Geçersiz şifre" });
    return;
  }

  const valid = await bcrypt.compare(password, meta.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Yanlış şifre" });
    return;
  }

  if (!Array.isArray(req.session.unlockedFiles)) {
    req.session.unlockedFiles = [];
  }
  if (!req.session.unlockedFiles.includes(fileId)) {
    req.session.unlockedFiles.push(fileId);
    // SEC: cap the array to prevent unbounded session growth
    if (req.session.unlockedFiles.length > MAX_UNLOCKED_FILES) {
      req.session.unlockedFiles = req.session.unlockedFiles.slice(-MAX_UNLOCKED_FILES);
    }
  }

  req.log.info({ fileId }, "File unlocked via password");
  res.json({ ok: true });
});

router.patch("/files/:fileId/settings", requireAuth, async (req, res): Promise<void> => {
  const { fileId } = req.params;
  if (!fileId || !isValidFileId(fileId)) {
    res.status(400).json({ error: "Geçersiz dosya ID'si" });
    return;
  }

  const meta = readMeta(fileId);
  if (!meta) {
    res.status(404).json({ error: "Dosya bulunamadı" });
    return;
  }
  if (meta.userId !== req.session.userId) {
    res.status(403).json({ error: "Bu dosyaya erişim izniniz yok" });
    return;
  }

  const { requireLogin, password } = req.body as {
    requireLogin?: unknown;
    password?: unknown;
  };

  if (typeof requireLogin === "boolean") {
    meta.requireLogin = requireLogin;
  }

  if (password !== undefined) {
    if (password === null || password === "") {
      delete meta.passwordHash;
    } else if (typeof password === "string" && password.length >= 1 && password.length <= 128) {
      meta.passwordHash = await bcrypt.hash(password, 12);
    } else {
      res.status(400).json({ error: "Şifre 1-128 karakter arasında olmalıdır" });
      return;
    }
  }

  saveMeta(meta);
  req.log.info(
    { fileId, requireLogin: meta.requireLogin, hasPassword: !!meta.passwordHash },
    "File access settings updated",
  );
  res.json(await buildPublicMeta(meta, req));
});

router.delete("/files/:fileId", requireAuth, async (req, res): Promise<void> => {
  const { fileId } = req.params;
  if (!fileId || !isValidFileId(fileId)) {
    res.status(400).json({ error: "Geçersiz dosya ID'si" });
    return;
  }

  const meta = readMeta(fileId);
  if (!meta) {
    res.status(404).json({ error: "Dosya bulunamadı" });
    return;
  }
  if (meta.userId !== req.session.userId) {
    res.status(403).json({ error: "Bu dosyaya erişim izniniz yok" });
    return;
  }

  deleteFile(fileId);
  // Bulut depolama + Firebase temizliği (best-effort, arka planda)
  // Firebase kaydından doğru provider + bucket adını al, sonra sil
  void (async () => {
    try {
      const record = await getFileRecord(fileId);
      if (record?.r2?.bucket) {
        const target: StorageTarget = {
          provider: record.r2.provider ?? "r2",
          bucket: record.r2.bucket,
        };
        await deleteFileChunksFromStorage(target, meta.id, meta.chunkCount).catch(
          (err: unknown) =>
            req.log.warn(
              { err, fileId, provider: target.provider, bucket: target.bucket },
              "Storage chunk deletion failed (non-fatal)",
            ),
        );
      }
      await deleteFileRecord(fileId).catch((err: unknown) =>
        req.log.warn({ err, fileId }, "Firebase record deletion failed (non-fatal)"),
      );
    } catch (err) {
      req.log.warn({ err, fileId }, "Storage/Firebase cleanup error (non-fatal)");
    }
  })();
  req.log.info({ fileId }, "File deleted");
  res.sendStatus(204);
});

router.get("/files/:fileId/snippet", requireAuth, async (req, res): Promise<void> => {
  const { fileId } = req.params;
  if (!fileId || !isValidFileId(fileId)) {
    res.status(400).json({ error: "Geçersiz dosya ID'si" });
    return;
  }

  const meta = readMeta(fileId);
  if (!meta) {
    res.status(404).json({ error: "Dosya bulunamadı" });
    return;
  }
  if (meta.userId !== req.session.userId) {
    res.status(403).json({ error: "Bu dosyaya erişim izniniz yok" });
    return;
  }

  if (isFileExpired(meta)) {
    deleteFile(meta.id);
    res.status(410).json({ error: "Dosyanın süresi doldu" });
    return;
  }

  const baseUrl = getBaseUrl(req);
  const snippet = generateSnippet(meta, baseUrl);
  res.json({ fileId: meta.id, snippet });
});

router.get("/files/:fileId/download", downloadLimiter, async (req, res): Promise<void> => {
  const { fileId } = req.params;
  if (!fileId || !isValidFileId(fileId)) {
    res.status(400).json({ error: "Geçersiz dosya ID'si" });
    return;
  }

  const meta = readMeta(fileId);
  if (!meta) {
    res.status(404).json({ error: "Dosya bulunamadı" });
    return;
  }
  if (isFileExpired(meta)) {
    deleteFile(meta.id);
    res.status(410).json({ error: "Dosyanın süresi doldu" });
    return;
  }

  const access = canAccess(meta, req);
  if (!access.ok) {
    res.status(access.status).json(access.body);
    return;
  }

  // R2 restore: eksik chunk'ları R2'den getir
  const allAvailable = await ensureAllChunksLocal(meta, req.log);
  if (!allAvailable) {
    res.status(500).json({ error: "Dosya chunk'ları tamamlanamadı. Lütfen tekrar deneyin." });
    return;
  }

  const safeName = encodeURIComponent(meta.name).replace(/'/g, "%27");
  // SEC-MIME: re-sanitize at serve time to protect against any pre-existing
  // files stored with dangerous MIME types before this fix was applied.
  res.setHeader("Content-Type", sanitizeMimeType(meta.mimeType || "application/octet-stream"));
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${safeName}`);
  res.setHeader("Content-Length", meta.size);
  res.setHeader("Cache-Control", "no-cache");

  const streamChunk = (i: number): void => {
    if (i >= meta.chunkCount) {
      res.end();
      return;
    }
    const chunkPath = getChunkPath(fileId, i);
    const stream = fs.createReadStream(chunkPath);
    stream.on("error", () => res.destroy());
    stream.on("end", () => streamChunk(i + 1));
    stream.pipe(res, { end: false });
  };

  streamChunk(0);
});

router.get(
  "/files/:fileId/chunks/:chunkIndex",
  downloadLimiter,
  async (req, res): Promise<void> => {
    const { fileId } = req.params;
    const rawIdx = req.params.chunkIndex;
    const chunkIndex = parseInt(rawIdx ?? "", 10);

    if (!fileId || !isValidFileId(fileId) || isNaN(chunkIndex) || chunkIndex < 0) {
      res.status(400).json({ error: "Geçersiz parametreler" });
      return;
    }

    const meta = readMeta(fileId);
    if (!meta) {
      res.status(404).json({ error: "Dosya bulunamadı" });
      return;
    }

    if (isFileExpired(meta)) {
      deleteFile(meta.id);
      res.status(410).json({ error: "Dosyanın süresi doldu" });
      return;
    }

    const access = canAccess(meta, req);
    if (!access.ok) {
      res.status(access.status).json(access.body);
      return;
    }

    if (chunkIndex >= meta.chunkCount) {
      res.status(404).json({ error: "Chunk bulunamadı" });
      return;
    }

    const chunkPath = getChunkPath(fileId, chunkIndex);
    if (!fs.existsSync(chunkPath)) {
      // R2'den on-demand geri yükleme dene
      const restored = await tryRestoreChunkFromStorage(fileId, chunkIndex, req.log);
      if (!restored) {
        res.status(404).json({ error: "Chunk dosyası eksik ve R2'den geri yüklenemedi" });
        return;
      }
    }

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="chunk_${chunkIndex}.bin"`);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.sendFile(chunkPath);
  },
);

// ── Dosya Şikayet Endpoint'i ────────────────────────────────────────────────
// Rate limit: IP başına 15 dakikada en fazla 5 şikayet
const reportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Çok fazla şikayet gönderildi. Lütfen 15 dakika bekleyin." },
  keyGenerator: (req: Request) => req.ip ?? "unknown",
});

router.post("/files/:fileId/report", reportLimiter, async (req, res): Promise<void> => {
  const { fileId } = req.params;
  if (!fileId || !isValidFileId(fileId)) {
    res.status(400).json({ error: "Geçersiz dosya ID'si" });
    return;
  }

  const meta = readMeta(fileId);
  if (!meta) {
    res.status(404).json({ error: "Dosya bulunamadı" });
    return;
  }
  if (isFileExpired(meta)) {
    res.status(410).json({ error: "Dosyanın süresi doldu" });
    return;
  }

  const { reason } = req.body as { reason?: unknown };
  if (!reason || typeof reason !== "string" || reason.trim().length < 10) {
    res.status(400).json({ error: "Şikayet nedeni en az 10 karakter olmalıdır" });
    return;
  }
  if (reason.trim().length > 1000) {
    res.status(400).json({ error: "Şikayet nedeni en fazla 1000 karakter olabilir" });
    return;
  }

  // Paylaşan kullanıcı bilgilerini al (şifre hash'i dahil edilmez — ASLA)
  const uploaderUser = meta.userId ? await findUserById(meta.userId) : null;

  // Şikayet edenin kimliği (giriş yapıyorsa kullanıcı adı, yoksa misafir)
  const reporterUser = req.session.userId ? await findUserById(req.session.userId) : null;

  // Gerçek IP: proxy arkasında da doğru alınır
  const rawIp =
    (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ??
    req.ip ??
    "bilinmiyor";

  const { v4: newUuid } = await import("uuid");
  const reportId = newUuid();

  const report = {
    reportId,
    dosyaLinki: `${getBaseUrl(req)}/files/${fileId}`,
    dosyaId: fileId,
    dosyaAdi: meta.name,
    yukleyenKullanici: uploaderUser?.username ?? "bilinmiyor",
    yukleyenKullaniciId: meta.userId ?? "bilinmiyor",
    sikayetNedeni: reason.trim(),
    sikayetEdenIp: rawIp,
    sikayetEdenKullanici: reporterUser?.username ?? "misafir",
    tarih: new Date().toISOString(),
  };

  const db = getFirebaseDb();
  if (db) {
    await db.ref(`sikayetEdilen_dosyalar/${reportId}`).set(report);
  } else {
    // Firebase yapılandırılmamışsa yerel dosyaya kaydet
    const reportsPath = path.join(uploadsDir, "_reports.json");
    let reports: unknown[] = [];
    if (fs.existsSync(reportsPath)) {
      try {
        reports = JSON.parse(fs.readFileSync(reportsPath, "utf-8")) as unknown[];
      } catch {
        reports = [];
      }
    }
    reports.push(report);
    fs.writeFileSync(reportsPath, JSON.stringify(reports, null, 2));
  }

  req.log.info({ fileId, reportId }, "File reported");
  res.json({ ok: true, message: "Şikayetiniz alındı. İnceleme ekibimiz değerlendirecek." });
});

export default router;
