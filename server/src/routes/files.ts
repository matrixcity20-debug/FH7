import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
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
const MAX_SEED_SIZE = 50 * 1024 * 1024 * 1024;

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
  upload.single("file"),
  async (req, res): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: "Dosya bulunamadı" });
      return;
    }

    const tempPath = path.join(uploadsDir, req.file.filename);

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

      const folderId = typeof req.body?.folderId === "string" && isValidFolderId(req.body.folderId)
        ? req.body.folderId : undefined;

      const meta: FileMeta = {
        id: fileId,
        userId: req.session.userId,
        name: req.file.originalname,
        size: fileSize,
        mimeType: req.file.mimetype || "application/octet-stream",
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

router.post("/files/upload-init", requireAuth, async (req, res): Promise<void> => {
  const { name, size, mimeType } = req.body as {
    name: string;
    size: number;
    mimeType: string;
  };

  if (!name || typeof name !== "string" || name.length > 512) {
    res.status(400).json({ error: "Geçersiz dosya adı" });
    return;
  }
  if (typeof size !== "number" || size <= 0 || size > MAX_FILE_SIZE) {
    res.status(400).json({ error: `Dosya çok büyük (maks ${MAX_FILE_SIZE / 1024 / 1024} MB)` });
    return;
  }
  if (!mimeType || typeof mimeType !== "string") {
    res.status(400).json({ error: "Geçersiz MIME türü" });
    return;
  }

  const uploadId = uuidv4();
  ensureUploadsDir();
  fs.mkdirSync(getUploadTempDir(uploadId), { recursive: true });

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
      cb(null, dir);
    },
    filename: (req, _file, cb) => {
      const idx = parseInt(req.body?.partIndex ?? "", 10);
      cb(null, `part_${idx}`);
    },
  }),
  limits: { fileSize: UPLOAD_PART_SIZE + 1024 },
});

router.post(
  "/files/upload-part",
  requireAuth,
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

    req.log.info({ uploadId, partIndex, bytes: req.file.size }, "Part received");
    res.json({ ok: true, partIndex });
  },
);

router.post("/files/upload-finalize", requireAuth, async (req, res): Promise<void> => {
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
    for (let i = 0; i < chunkCount; i++) {
      const chunkPath = path.join(uploadsDir, fileId, `chunk_${i}.bin`);
      fileHash.update(fs.readFileSync(chunkPath));
    }
    const serverHash = fileHash.digest("hex");

    if (serverHash !== sha256.toLowerCase()) {
      deleteFile(fileId);
      req.log.warn({ uploadId, fileId }, "SHA-256 mismatch");
      res.status(409).json({ error: "Bütünlük kontrolü başarısız: SHA-256 uyuşmuyor. Lütfen tekrar deneyin." });
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

    const resolvedFolderId = folderId && isValidFolderId(folderId) && readFolderMeta(folderId)
      ? folderId : undefined;

    const chunkUrls = buildChunkUrls(fileId, chunkCount, baseUrl);
    const meta: FileMeta = {
      id: fileId,
      userId: req.session.userId,
      name,
      size: Number(size),
      mimeType: mimeType || "application/octet-stream",
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
    req.log.info({ fileId, name, chunkCount }, "Chunked upload finalised");
    res.status(201).json(meta);
  } catch (err) {
    cleanupUpload(uploadId);
    try { deleteFile(fileId); } catch { /* ignore */ }
    req.log.error({ err }, "Finalise failed");
    res.status(500).json({ error: "Dosya birleştirme başarısız" });
  }
});

router.post("/files/register-seed", requireAuth, async (req, res): Promise<void> => {
  const { name, size, mimeType, chunkCount, folderId } = req.body as {
    name: string;
    size: number;
    mimeType: string;
    chunkCount: number;
    folderId?: string;
  };

  if (!name || !size || !mimeType || !chunkCount) {
    res.status(400).json({ error: "Eksik alanlar: name, size, mimeType, chunkCount" });
    return;
  }
  if (typeof name !== "string" || name.length > 512) {
    res.status(400).json({ error: "Geçersiz dosya adı" });
    return;
  }
  if (typeof size !== "number" || size <= 0 || size > MAX_SEED_SIZE) {
    res.status(400).json({ error: "Geçersiz boyut" });
    return;
  }
  if (!Number.isInteger(chunkCount) || chunkCount <= 0 || chunkCount > MAX_CHUNK_COUNT) {
    res.status(400).json({ error: "Geçersiz chunkCount" });
    return;
  }

  ensureUploadsDir();
  const fileId = uuidv4();
  const resolvedFolderId = folderId && isValidFolderId(folderId) && readFolderMeta(folderId)
    ? folderId : undefined;

  const meta: FileMeta = {
    id: fileId,
    userId: req.session.userId,
    name: String(name).slice(0, 512),
    size: Number(size),
    mimeType: String(mimeType).slice(0, 128),
    chunkCount: Number(chunkCount),
    chunkSize: CHUNK_SIZE,
    uploadedAt: new Date().toISOString(),
    chunkUrls: [],
    seedOnly: true,
    ...(resolvedFolderId ? { folderId: resolvedFolderId } : {}),
  };

  saveMeta(meta);
  req.log.info({ fileId, name: meta.name }, "Seed-only file registered");
  res.status(201).json(meta);
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

router.get("/files/:fileId", requireAuth, async (req, res): Promise<void> => {
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

  res.json(meta);
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

router.get("/files/:fileId/download", async (req, res): Promise<void> => {
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

  for (let i = 0; i < meta.chunkCount; i++) {
    if (!fs.existsSync(getChunkPath(fileId, i))) {
      res.status(500).json({ error: `Chunk ${i} eksik` });
      return;
    }
  }

  const safeName = encodeURIComponent(meta.name).replace(/'/g, "%27");
  res.setHeader("Content-Type", meta.mimeType || "application/octet-stream");
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
