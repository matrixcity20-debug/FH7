/**
 * Firebase RTDB dosya kaydı.
 *
 * Her yüklenen dosyanın meta verisi ve bulut depolama konumu Firebase'e kaydedilir.
 * Bu sayede:
 *  - Deploy sonrası yerel uploads/ klasörü silinse bile meta.json'lar
 *    Firebase'den geri yüklenir.
 *  - Chunk'lar on-demand olarak R2/B2'den getirilir.
 *
 * Firebase yapısı:
 *   /filesplit_files/{fileId}
 *     meta          → FileMeta (passwordHash hariç)
 *     r2            → R2FileInfo | null  (cloud upload başarılı olduğunda dolar)
 *     savedAt       → ISO timestamp
 *     cloudUpload   → CloudUploadState  (yükleme durumu — pending/ready/failed)
 *
 * Kayıt yaşam döngüsü:
 *   1. createPendingFileRecord(meta)   → status: "pending", r2: null
 *   2a. markFileRecordReady(id, r2)    → status: "ready",   r2: dolu
 *   2b. markFileRecordFailed(id, err)  → status: "failed",  r2: null
 *
 * Geriye dönük uyumluluk:
 *   cloudUpload alanı olmayan eski kayıtlar "ready" olarak değerlendirilir.
 *
 * Güvenlik notu:
 *   passwordHash alanı kasıtlı olarak Firebase'e yazılmaz.
 *   Parola hash'leri yalnızca yerel meta.json'da tutulur.
 *   Şifreleme anahtarı (encryptionKeyHex) yalnızca Firebase'de tutulur, bucket'ta değil.
 */

import { getFirebaseDb } from "./firebase.js";
import { readMeta, saveMeta, isValidFileId, type FileMeta } from "./fileStore.js";
import { logger } from "./logger.js";

const FB_ROOT = "filesplit_files";

// ── Arayüzler ─────────────────────────────────────────────────────────────────

export interface R2FileInfo {
  provider?: "r2" | "b2" | "e2";
  bucket: string;
  /**
   * Legacy: plaintext AES-256 key stored in Firebase.
   * Set for files uploaded before the ECDH key exchange was introduced.
   * New files use epkHex instead — the AES key is derived on demand via ECDH+HKDF.
   */
  encryptionKeyHex?: string;
  /**
   * Client ephemeral X25519 public key (64 hex chars = 32 bytes).
   * Set for files uploaded with the ECDH key exchange layer.
   * The server derives the AES-256 key on demand: ECDH(server_priv, epk) → HKDF → AES key.
   * This key is NEVER stored — only the ephemeral public key is.
   */
  epkHex?: string;
  chunkCount: number;
  uploadedAt: string;
}

export type CloudUploadStatus = "pending" | "ready" | "failed";

export interface CloudUploadState {
  status: CloudUploadStatus;
  attempts: number;
  lastAttemptAt: string;
  error?: string;
}

export interface FileRecord {
  meta: FileMeta;
  /** Bulut depolama bilgisi. status="pending"/"failed" olduğunda null. */
  r2: R2FileInfo | null;
  savedAt: string;
  /** Cloud upload durum takibi. Eski kayıtlarda bu alan yoktur → "ready" sayılır. */
  cloudUpload?: CloudUploadState;
}

// ── Yardımcı ─────────────────────────────────────────────────────────────────

function stripSensitiveFields(meta: FileMeta): FileMeta {
  const { passwordHash: _ph, ...safe } = meta;
  void _ph;
  return safe;
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Dosya yüklendiği anda Firebase'e "pending" kaydı yazar.
 * Cloud upload tamamlanmadan dosya Firebase'de görünür hale gelir —
 * bu sayede cloud upload başarısız olsa bile kayıt asla kaybolmaz.
 */
export async function createPendingFileRecord(meta: FileMeta): Promise<void> {
  const db = getFirebaseDb();
  if (!db) return;

  const now = new Date().toISOString();
  const record: FileRecord = {
    meta: stripSensitiveFields(meta),
    r2: null,
    savedAt: now,
    cloudUpload: {
      status: "pending",
      attempts: 0,
      lastAttemptAt: now,
    },
  };

  try {
    await db.ref(`${FB_ROOT}/${meta.id}`).set(record);
    logger.info({ fileId: meta.id }, "Pending file record created in Firebase");
  } catch (err) {
    logger.error({ err, fileId: meta.id }, "Failed to create pending file record in Firebase");
  }
}

/**
 * Cloud upload başarılı olduğunda kaydı "ready" olarak günceller ve r2Info'yu yazar.
 */
export async function markFileRecordReady(
  fileId: string,
  r2Info: R2FileInfo,
  attempts: number,
): Promise<void> {
  const db = getFirebaseDb();
  if (!db) return;

  const now = new Date().toISOString();
  try {
    await db.ref(`${FB_ROOT}/${fileId}`).update({
      r2: r2Info,
      cloudUpload: {
        status: "ready",
        attempts,
        lastAttemptAt: now,
      } satisfies CloudUploadState,
    });
    logger.info({ fileId, attempts }, "File record marked ready in Firebase");
  } catch (err) {
    logger.error({ err, fileId }, "Failed to mark file record as ready in Firebase");
  }
}

/**
 * Tüm retry'lar tükendikten sonra kaydı "failed" olarak günceller.
 * Dosya yerel disk'ten hâlâ erişilebilir; bulut yedeği mevcut değil.
 */
export async function markFileRecordFailed(
  fileId: string,
  error: string,
  attempts: number,
): Promise<void> {
  const db = getFirebaseDb();
  if (!db) return;

  const now = new Date().toISOString();
  try {
    await db.ref(`${FB_ROOT}/${fileId}`).update({
      cloudUpload: {
        status: "failed",
        attempts,
        lastAttemptAt: now,
        error: error.slice(0, 500),
      } satisfies CloudUploadState,
    });
    logger.error({ fileId, attempts, error }, "File record marked failed in Firebase");
  } catch (fbErr) {
    logger.error({ fbErr, fileId }, "Failed to mark file record as failed in Firebase");
  }
}

/**
 * Tek seferde başarılı olan kayıtlar için (geriye dönük uyumluluk).
 * saveFileRecord çağrısı hâlâ içeride tutulur — mevcut kodun kırılmaması için.
 * @deprecated Yeni kod createPendingFileRecord + markFileRecordReady kullanmalı.
 */
export async function saveFileRecord(
  meta: FileMeta,
  r2Info: R2FileInfo,
): Promise<void> {
  const db = getFirebaseDb();
  if (!db) return;

  const now = new Date().toISOString();
  const record: FileRecord = {
    meta: stripSensitiveFields(meta),
    r2: r2Info,
    savedAt: now,
    cloudUpload: {
      status: "ready",
      attempts: 1,
      lastAttemptAt: now,
    },
  };

  try {
    await db.ref(`${FB_ROOT}/${meta.id}`).set(record);
    logger.info({ fileId: meta.id }, "File record saved to Firebase");
  } catch (err) {
    logger.error({ err, fileId: meta.id }, "Failed to save file record to Firebase");
  }
}

/**
 * Bir dosyanın Firebase kaydını getirir.
 */
export async function getFileRecord(fileId: string): Promise<FileRecord | null> {
  if (!isValidFileId(fileId)) return null;
  const db = getFirebaseDb();
  if (!db) return null;

  try {
    const snap = await db.ref(`${FB_ROOT}/${fileId}`).once("value");
    const data = snap.val() as FileRecord | null;
    return data ?? null;
  } catch (err) {
    logger.error({ err, fileId }, "Failed to get file record from Firebase");
    return null;
  }
}

/**
 * Cloud chunk'larına erişilebilir "ready" kayıt döner.
 * pending/failed kayıtlar için null döner (r2 bilgisi henüz yok).
 */
export async function getReadyFileRecord(fileId: string): Promise<FileRecord | null> {
  const record = await getFileRecord(fileId);
  if (!record) return null;
  const status = record.cloudUpload?.status ?? "ready";
  if (status !== "ready") return null;
  if (!record.r2?.encryptionKeyHex && !record.r2?.epkHex) return null;
  return record;
}

/**
 * Dosya kaydını Firebase'den siler.
 */
export async function deleteFileRecord(fileId: string): Promise<void> {
  const db = getFirebaseDb();
  if (!db) return;

  try {
    await db.ref(`${FB_ROOT}/${fileId}`).remove();
  } catch (err) {
    logger.error({ err, fileId }, "Failed to delete file record from Firebase");
  }
}

// ── Startup Restore ──────────────────────────────────────────────────────────

/**
 * Sunucu başlangıcında Firebase'deki tüm dosya kayıtlarını tarar.
 * Yerel meta.json dosyası eksikse Firebase'deki veriden yeniden oluşturur.
 * Sadece "ready" veya cloudUpload alanı olmayan (eski) kayıtlar işlenir.
 *
 * @returns Yüklenen meta dosyası sayısı
 */
export async function restoreMetaFilesFromFirebase(): Promise<number> {
  const db = getFirebaseDb();
  if (!db) return 0;

  let restored = 0;

  try {
    const snap = await db.ref(FB_ROOT).once("value");
    const records = snap.val() as Record<string, FileRecord> | null;
    if (!records) return 0;

    for (const [fileId, record] of Object.entries(records)) {
      if (!isValidFileId(fileId)) continue;
      if (!record?.meta?.id) continue;

      const status = record.cloudUpload?.status ?? "ready";
      if (status === "pending") continue;

      if (readMeta(fileId) !== null) continue;

      try {
        saveMeta(record.meta);
        restored++;
        logger.info({ fileId, name: record.meta.name, status }, "meta.json restored from Firebase");
      } catch (err) {
        logger.error({ err, fileId }, "Failed to restore meta.json from Firebase");
      }
    }
  } catch (err) {
    logger.error({ err }, "Failed to query Firebase for meta restore");
  }

  return restored;
}
