/**
 * Firebase RTDB dosya kaydı.
 *
 * Her yüklenen dosyanın meta verisi ve R2 konumu Firebase'e kaydedilir.
 * Bu sayede:
 *  - Deploy sonrası yerel uploads/ klasörü silinse bile meta.json'lar
 *    Firebase'den geri yüklenir.
 *  - Chunk'lar on-demand olarak R2'den getirilir.
 *
 * Firebase yapısı:
 *   /filesplit_files/{fileId}
 *     meta          → FileMeta (passwordHash hariç)
 *     r2            → R2FileInfo
 *     savedAt       → ISO timestamp
 *
 * Güvenlik notu:
 *   passwordHash alanı kasıtlı olarak Firebase'e yazılmaz.
 *   Parola hash'leri yalnızca yerel meta.json'da tutulur.
 *   R2 şifreleme anahtarı sadece Firebase'de tutulur, R2'de değil.
 */

import { getFirebaseDb } from "./firebase.js";
import { readMeta, saveMeta, isValidFileId, type FileMeta } from "./fileStore.js";
import { logger } from "./logger.js";

// Firebase'deki kök yol — mevcut verilerle çakışmamak için namespace'li
const FB_ROOT = "filesplit_files";

// ── Arayüzler ─────────────────────────────────────────────────────────────────

export interface R2FileInfo {
  /**
   * Depolama provider'ı — hangi servise yüklendiğini belirtir.
   * Geriye dönük uyumluluk: eksikse "r2" varsayılır (eski kayıtlar).
   */
  provider?: "r2" | "b2";
  /** Bucket adı — hangi bucket'a yüklendiğini takip eder */
  bucket: string;
  /** AES-256-GCM şifreleme anahtarı (hex, 64 karakter = 32 bayt) */
  encryptionKeyHex: string;
  /** Toplam chunk sayısı */
  chunkCount: number;
  /** Servise yüklenme zamanı */
  uploadedAt: string;
}

export interface FileRecord {
  /** Dosya meta verisi (passwordHash olmadan) */
  meta: FileMeta;
  /** R2 konumu ve şifreleme bilgisi */
  r2: R2FileInfo;
  /** Firebase'e kaydedilme zamanı */
  savedAt: string;
}

// ── Yardımcı ─────────────────────────────────────────────────────────────────

/** passwordHash'i meta'dan çıkarır — Firebase'e asla yazılmaz */
function stripSensitiveFields(meta: FileMeta): FileMeta {
  const { passwordHash: _ph, ...safe } = meta;
  void _ph;
  return safe;
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Dosya kaydını Firebase'e yazar.
 * passwordHash alanı kasıtlı olarak çıkarılır.
 */
export async function saveFileRecord(
  meta: FileMeta,
  r2Info: R2FileInfo,
): Promise<void> {
  const db = getFirebaseDb();
  if (!db) return;

  try {
    const record: FileRecord = {
      meta: stripSensitiveFields(meta),
      r2: r2Info,
      savedAt: new Date().toISOString(),
    };
    await db.ref(`${FB_ROOT}/${meta.id}`).set(record);
    logger.info({ fileId: meta.id }, "File record saved to Firebase");
  } catch (err) {
    // Non-fatal: yerel kopya zaten mevcut
    logger.error({ err, fileId: meta.id }, "Failed to save file record to Firebase");
  }
}

/**
 * Bir dosyanın R2 bilgisini Firebase'den getirir.
 * Firebase yapılandırılmamışsa null döner.
 */
export async function getFileRecord(
  fileId: string,
): Promise<FileRecord | null> {
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
 * Dosya kaydını Firebase'den siler.
 * Best-effort: hata fırlatmaz.
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
 *
 * NOT: Bu işlem sadece meta.json'ı geri yükler.
 * Chunk'lar, ilk istek geldiğinde on-demand olarak R2'den getirilir.
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

      // Yerel meta.json zaten varsa atla
      if (readMeta(fileId) !== null) continue;

      try {
        saveMeta(record.meta);
        restored++;
        logger.info({ fileId, name: record.meta.name }, "meta.json restored from Firebase");
      } catch (err) {
        logger.error({ err, fileId }, "Failed to restore meta.json from Firebase");
      }
    }
  } catch (err) {
    logger.error({ err }, "Failed to query Firebase for meta restore");
  }

  return restored;
}
