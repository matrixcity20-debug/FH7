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
import { getUserLimits } from "../lib/userStore.js";

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
  limits: { fileSize: MAX_FILE_SIZE },
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

// ── SEC: per-upload session ownership & byte tracking ────────────────────────
// Tracks in-progress chunked uploads: session ownership (IDOR prevention),
// declared max size (disk-exhaustion DoS guard), and creation time (TTL-based
// cleanup of abandoned uploads that never reached finalize).
interface UploadSession {
  sessionId: string;           // req.sessionID that called upload-init
  maxBytes: number;            // client-declared file size — upper bound for received bytes
  receivedBytes: number;       // running total of bytes written to disk across all parts
  createdAt: number;           // Date.now() at upload-init time — for TTL cleanup
  userMaxFileSizeBytes: number; // per-user resolved maxFileSizeBytes — for part-level DoS guard
}
const uploadSessions = new Map<string, UploadSession>();

// Purge upload sessions (and their temp dirs) abandoned for more than 24 hours.
const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function purgeStaleUploadSessions(): void {
  const cutoff = Date.now() - UPLOAD_SESSION_TTL_MS;
  for (const [uploadId, rec] of uploadSessions) {
    if (rec.createdAt < cutoff) {
      uploadSessions.delete(uploadId);
      cleanupUpload(uploadId);
    }
  }
}

// Maximum number of file IDs kept in a session's unlockedFiles list
const MAX_UNLOCKED_FILES = 200;

// BUL-08: per-user upload rate limit (50 uploads/hour)
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Çok fazla yükleme denemesi. Lütfen bir saat bekleyin." },
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

type FileMeta = import("../lib/fileStore.js").FileMeta;

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

function buildPublicMeta(meta: FileMeta, req: Request) {
  // SEC: strip userId, passwordHash, and sha256 from the public shape.
  // sha256 is only surfaced back to the owner — it is not needed by other
  // downloaders and leaking it needlessly increases the attack surface for
  // any future hash-based exploitation primitives.
  const { userId: _u, passwordHash: _p, sha256: _hash, ...rest } = meta;
  const isOwner = !!req.session.userId && meta.userId === req.session.userId;
  return {
    ...rest,
    isOwner,
    requireLogin: !!meta.requireLogin,
    hasPassword: !!meta.passwordHash,
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

  const uploadId = uuidv4();
  ensureUploadsDir();
  fs.mkdirSync(getUploadTempDir(uploadId), { recursive: true });
  // SEC-IDOR: bind uploadId → session; includes maxBytes for disk-exhaustion guard
  // and createdAt for TTL-based cleanup of abandoned uploads.
  // Purge stale sessions first so the Map does not grow without bound.
  purgeStaleUploadSessions();
  uploadSessions.set(uploadId, {
    sessionId: req.sessionID,
    maxBytes: size,
    receivedBytes: 0,
    createdAt: Date.now(),
    userMaxFileSizeBytes: userLimits.maxFileSizeBytes,
  });

  req.log.info({ uploadId, name, size }, "Upload session initialised");
  res.status(201).json({ uploadId, partSize: UPLOAD_PART_SIZE });
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
      const rec = uploadSessions.get(uploadId);
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
  limits: { fileSize: UPLOAD_PART_SIZE + 1024 },
});

router.post(
  "/files/upload-part",
  requireAuth,
  uploadLimiter,
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
    const rec = uploadSessions.get(uploadId);
    if (!rec) {
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
      res.status(403).json({ error: "Bu yükleme oturumu bulunamadı veya süresi doldu" });
      return;
    }
    rec.receivedBytes += req.file.size;
    const ceiling = Math.min(rec.maxBytes * 1.01 + 1024, rec.userMaxFileSizeBytes);
    if (rec.receivedBytes > ceiling) {
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
      uploadSessions.delete(uploadId);
      cleanupUpload(uploadId);
      res.status(413).json({ error: "Toplam yükleme boyutu bildirilen boyutu aşıyor" });
      return;
    }

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
  if (uploadSessions.get(uploadId)?.sessionId !== req.sessionID) {
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
    // SEC-IDOR: release the uploadId → sessionID binding now that finalize is done
    uploadSessions.delete(uploadId);
    req.log.info({ fileId, name, chunkCount }, "Chunked upload finalised");
    res.status(201).json(meta);
  } catch (err) {
    uploadSessions.delete(uploadId);
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

  res.json(buildPublicMeta(meta, req));
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
  res.json(buildPublicMeta(meta, req));
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

  for (let i = 0; i < meta.chunkCount; i++) {
    if (!fs.existsSync(getChunkPath(fileId, i))) {
      res.status(500).json({ error: `Chunk ${i} eksik` });
      return;
    }
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
      res.status(404).json({ error: "Chunk dosyası eksik" });
      return;
    }

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="chunk_${chunkIndex}.bin"`);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.sendFile(chunkPath);
  },
);

export default router;
