import fs from "fs";
import path from "path";
import crypto from "crypto";

export const uploadsDir =
  process.env["NODE_ENV"] === "production"
    ? "/uploads"
    : path.resolve(process.cwd(), "uploads");

export const CHUNK_SIZE =
  Math.max(1, Math.min(100, Number(process.env["CHUNK_SIZE_MB"] ?? 1))) * 1024 * 1024;

export const MAX_FILE_SIZE =
  Math.max(1, Math.min(2000, Number(process.env["MAX_FILE_SIZE_MB"] ?? 500))) * 1024 * 1024;

// BUL-08: per-user total storage quota (default 5 GB, overridable via env)
export const MAX_USER_STORAGE_BYTES =
  Math.max(1, Number(process.env["MAX_USER_STORAGE_MB"] ?? 5000)) * 1024 * 1024;

export interface FileMeta {
  id: string;
  userId?: string;
  name: string;
  size: number;
  mimeType: string;
  chunkCount: number;
  chunkSize: number;
  uploadedAt: string;
  chunkUrls: string[];
  expiresAt?: string;
  seedOnly?: boolean;
  sha256?: string;
  groupId?: string;
  version?: number;
  folderId?: string;
  requireLogin?: boolean;
  passwordHash?: string;
}

export interface FolderMeta {
  id: string;
  userId?: string;
  name: string;
  createdAt: string;
}

export function ensureUploadsDir(): void {
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
}

export function getFoldersDir(): string {
  return path.join(uploadsDir, "_folders");
}

export function ensureFoldersDir(): void {
  const dir = getFoldersDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function getFolderMetaPath(folderId: string): string {
  return path.join(getFoldersDir(), `${folderId}.json`);
}

const FOLDER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidFolderId(folderId: string): boolean {
  return FOLDER_ID_PATTERN.test(folderId);
}

export function saveFolderMeta(folder: FolderMeta): void {
  ensureFoldersDir();
  fs.writeFileSync(getFolderMetaPath(folder.id), JSON.stringify(folder, null, 2));
}

export function readFolderMeta(folderId: string): FolderMeta | null {
  if (!isValidFolderId(folderId)) return null;
  const p = getFolderMetaPath(folderId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as FolderMeta;
  } catch {
    return null;
  }
}

export function listFolders(userId?: string): FolderMeta[] {
  ensureFoldersDir();
  const entries = fs.readdirSync(getFoldersDir()).filter((f) => f.endsWith(".json"));
  const folders: FolderMeta[] = [];
  for (const entry of entries) {
    try {
      const raw = fs.readFileSync(path.join(getFoldersDir(), entry), "utf-8");
      const folder = JSON.parse(raw) as FolderMeta;
      if (userId === undefined || folder.userId === userId) {
        folders.push(folder);
      }
    } catch { /* skip corrupt entries */ }
  }
  return folders.sort((a, b) => a.name.localeCompare(b.name));
}

export function deleteFolderMeta(folderId: string): boolean {
  if (!isValidFolderId(folderId)) return false;
  const p = getFolderMetaPath(folderId);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

const FILE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidFileId(fileId: string): boolean {
  return FILE_ID_PATTERN.test(fileId);
}

export function getFileDir(fileId: string): string {
  if (!isValidFileId(fileId)) {
    throw new Error(`Invalid fileId: "${fileId}"`);
  }
  const dir = path.join(uploadsDir, fileId);
  const resolvedDir = path.resolve(dir);
  const resolvedRoot = path.resolve(uploadsDir);
  if (
    resolvedDir !== resolvedRoot &&
    !resolvedDir.startsWith(resolvedRoot + path.sep)
  ) {
    throw new Error(`Invalid fileId: "${fileId}"`);
  }
  return dir;
}

export function getMetaPath(fileId: string): string {
  return path.join(getFileDir(fileId), "meta.json");
}

export function getChunkPath(fileId: string, chunkIndex: number): string {
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
    throw new Error(`Invalid chunkIndex: ${chunkIndex}`);
  }
  return path.join(getFileDir(fileId), `chunk_${chunkIndex}.bin`);
}

export function saveMeta(meta: FileMeta): void {
  const dir = getFileDir(meta.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getMetaPath(meta.id), JSON.stringify(meta, null, 2));
}

export function readMeta(fileId: string): FileMeta | null {
  if (!isValidFileId(fileId)) return null;
  const metaPath = getMetaPath(fileId);
  if (!fs.existsSync(metaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf-8")) as FileMeta;
  } catch {
    return null;
  }
}

export function isFileExpired(meta: FileMeta): boolean {
  if (!meta.expiresAt) return false;
  return new Date(meta.expiresAt) < new Date();
}

export function listAllFiles(userId?: string): FileMeta[] {
  ensureUploadsDir();
  const entries = fs.readdirSync(uploadsDir, { withFileTypes: true });
  const files: FileMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("tmp_")) continue;
    if (entry.name.startsWith("_")) continue;
    if (entry.name.startsWith("upload_")) continue;
    const meta = readMeta(entry.name);
    if (meta && !isFileExpired(meta)) {
      if (userId === undefined || meta.userId === userId) {
        files.push(meta);
      }
    }
  }
  return files.sort(
    (a, b) =>
      new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime(),
  );
}

// BUL-08: sum of all active (non-expired) file sizes owned by a user, used to
// enforce the per-user storage quota (MAX_USER_STORAGE_BYTES) at upload time.
export function getUserStorageUsed(userId: string): number {
  return listAllFiles(userId).reduce((total, f) => total + (f.size || 0), 0);
}

export function deleteFile(fileId: string): boolean {
  if (!isValidFileId(fileId)) return false;
  const dir = getFileDir(fileId);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

export function purgeExpiredFiles(): number {
  ensureUploadsDir();
  const entries = fs.readdirSync(uploadsDir, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("tmp_")) continue;
    if (entry.name.startsWith("_")) continue;
    if (entry.name.startsWith("upload_")) continue;
    const meta = readMeta(entry.name);
    if (meta && isFileExpired(meta)) {
      deleteFile(meta.id);
      count++;
    }
  }
  return count;
}

export function splitAndSaveFromPath(fileId: string, tempPath: string): number {
  const dir = getFileDir(fileId);
  fs.mkdirSync(dir, { recursive: true });

  const fileSize = fs.statSync(tempPath).size;
  const chunkCount = Math.ceil(fileSize / CHUNK_SIZE);
  const fd = fs.openSync(tempPath, "r");

  try {
    for (let i = 0; i < chunkCount; i++) {
      const chunkLen = Math.min(CHUNK_SIZE, fileSize - i * CHUNK_SIZE);
      const buf = Buffer.allocUnsafe(chunkLen);
      fs.readSync(fd, buf, 0, chunkLen, i * CHUNK_SIZE);
      fs.writeFileSync(getChunkPath(fileId, i), buf);
    }
  } finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
  }

  return chunkCount;
}

export function buildChunkUrls(
  fileId: string,
  chunkCount: number,
  baseUrl: string,
): string[] {
  return Array.from(
    { length: chunkCount },
    (_, i) => `${baseUrl}/api/files/${fileId}/chunks/${i}`,
  );
}

export function listVersions(groupId: string): FileMeta[] {
  ensureUploadsDir();
  const all = listAllFiles();
  return all
    .filter((f) => f.groupId === groupId)
    .sort((a, b) => (a.version ?? 0) - (b.version ?? 0));
}

export function nextVersion(groupId: string): number {
  const versions = listVersions(groupId);
  if (versions.length === 0) return 2;
  return Math.max(...versions.map((f) => f.version ?? 1)) + 1;
}

export const UPLOAD_PART_SIZE = 5 * 1024 * 1024;

const UPLOAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUploadId(uploadId: string): boolean {
  return UPLOAD_ID_PATTERN.test(uploadId);
}

export function getUploadTempDir(uploadId: string): string {
  if (!isValidUploadId(uploadId)) {
    throw new Error(`Invalid uploadId: "${uploadId}"`);
  }
  return path.join(uploadsDir, `upload_${uploadId}`);
}

export function getPartPath(uploadId: string, partIndex: number): string {
  if (!Number.isInteger(partIndex) || partIndex < 0) {
    throw new Error(`Invalid partIndex: ${partIndex}`);
  }
  return path.join(getUploadTempDir(uploadId), `part_${partIndex}`);
}

export function cleanupUpload(uploadId: string): void {
  if (!isValidUploadId(uploadId)) return;
  try { fs.rmSync(getUploadTempDir(uploadId), { recursive: true, force: true }); } catch { /* ignore */ }
}

export function assembleAndSplit(uploadId: string, fileId: string, totalParts: number): number {
  ensureUploadsDir();
  const assembledPath = path.join(uploadsDir, `tmp_assembled_${fileId}`);
  const wfd = fs.openSync(assembledPath, "w");
  try {
    for (let i = 0; i < totalParts; i++) {
      const partPath = getPartPath(uploadId, i);
      const data = fs.readFileSync(partPath);
      fs.writeSync(wfd, data);
    }
  } finally {
    fs.closeSync(wfd);
  }
  cleanupUpload(uploadId);
  return splitAndSaveFromPath(fileId, assembledPath);
}

/**
 * BUL-12 (hardened): safely embed an arbitrary JS value as a JSON literal
 * inside a <script> block.
 *
 * Pattern-matching a single substring like "</script>" is fragile — it
 * misses case/whitespace variants, other closing tags ("</style>"), and
 * comment-open sequences ("<!--") that can also confuse an HTML parser
 * scanning raw bytes for the next tag. The robust, OWASP-recommended fix is
 * to escape *every* '<' character in the JSON output to its Unicode escape
 * (\u003C). A '\u003C' is valid inside a JS string literal and evaluates
 * back to '<' at runtime, but it can never be mistaken for the start of an
 * HTML tag by a parser scanning the raw source text — regardless of what
 * tag name, case, or whitespace follows it.
 */
function toSafeScriptLiteral(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003C");
}

export function generateSnippet(meta: FileMeta, baseUrl: string): string {
  // name and mimeType originate from the uploader's own request (originalname /
  // multipart Content-Type) and baseUrl is derived from request headers — all
  // three are escaped defensively, even though /snippet is only ever exposed
  // to the file's owner.
  const safeNameJson = toSafeScriptLiteral(meta.name);
  const safeMimeJson = toSafeScriptLiteral(meta.mimeType);
  const safeBaseUrlJson = toSafeScriptLiteral(baseUrl);
  return `(function() {
  var fileId = "${meta.id}";
  var fileName = ${safeNameJson};
  var mimeType = ${safeMimeJson};
  var chunkCount = ${meta.chunkCount};
  var baseUrl = ${safeBaseUrlJson};

  function downloadFile() {
    var promises = [];
    for (var i = 0; i < chunkCount; i++) {
      promises.push(
        fetch(baseUrl + "/api/files/" + fileId + "/chunks/" + i)
          .then(function(r) { return r.arrayBuffer(); })
      );
    }
    Promise.all(promises).then(function(chunks) {
      var blob = new Blob(chunks, { type: mimeType });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }).catch(function(err) {
      console.error("FileSplit download failed:", err);
    });
  }

  document.querySelectorAll('[data-filesplit="${meta.id}"]').forEach(function(el) {
    el.addEventListener("click", downloadFile);
  });

  window.FileSplit = window.FileSplit || {};
  window.FileSplit["${meta.id}"] = { download: downloadFile, fileName: fileName };
})();`;
}

export function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.allocUnsafe(1024 * 1024);
  try {
    let n: number;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}
