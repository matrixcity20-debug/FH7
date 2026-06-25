/**
 * Birleşik Depolama Yönlendiricisi — Cloudflare R2 + Backblaze B2 + iDrive e2 + Google Drive
 *
 * Tüm bucket'ları tek bir havuzda toplar; round-robin yük dağıtımı yapar.
 * Her dosya hangi provider + bucket'ta saklandığını Firebase kaydında taşır.
 * İndirme ve silme işlemleri her zaman doğru servise yönlendirilir.
 *
 * Google Drive entegrasyonu:
 *   - Her yetkilendirilmiş Gmail hesabı bir "gdrive" bucket'ı olarak eklenir.
 *   - Chunk'ların Drive dosya ID'leri Firebase/yerel depoda ayrıca tutulur.
 *   - OAuth yapılandırması + en az bir yetkili hesap olmadan gdrive aktif olmaz.
 */

import {
  isR2Configured,
  listConfiguredBuckets as listR2Buckets,
  uploadChunkToR2,
  downloadChunkFromR2,
  deleteFileChunksFromR2,
  generateEncryptionKey,
} from "./r2Storage.js";
import {
  isB2Configured,
  listConfiguredB2Buckets,
  uploadChunkToB2,
  downloadChunkFromB2,
  deleteFileChunksFromB2,
} from "./b2Storage.js";
import {
  isE2Configured,
  listConfiguredE2Buckets,
  uploadChunkToE2,
  downloadChunkFromE2,
  deleteFileChunksFromE2,
} from "./e2Storage.js";
import {
  isGDriveConfigured,
  listAuthorizedAccounts,
  uploadChunkToGDrive,
  downloadChunkFromGDrive,
  deleteFileChunksFromGDrive,
} from "./gdriveStorage.js";

export type StorageProvider = "r2" | "b2" | "e2" | "gdrive";

export interface StorageTarget {
  /** Hangi servis: Cloudflare R2, Backblaze B2, iDrive e2 veya Google Drive */
  provider: StorageProvider;
  /** Hedef bucket adı (gdrive için Gmail adresi) */
  bucket: string;
}

// ── Yeniden dışa aktar ────────────────────────────────────────────────────────
export { generateEncryptionKey };

// ── Round-Robin Durumu ────────────────────────────────────────────────────────

let _rrIndex = 0;

// ── Provider Yönetimi ─────────────────────────────────────────────────────────

/**
 * Yapılandırılmış tüm depolama hedeflerini döner (R2 + B2 + e2 + GDrive).
 * Sıra: R2 → B2 → e2 → GDrive
 * NOT: Bu fonksiyon async'tir çünkü GDrive hesapları Firebase'den okunabilir.
 */
export async function listAllTargets(): Promise<StorageTarget[]> {
  const r2Targets = listR2Buckets().map(
    (bucket): StorageTarget => ({ provider: "r2", bucket }),
  );
  const b2Targets = listConfiguredB2Buckets().map(
    (bucket): StorageTarget => ({ provider: "b2", bucket }),
  );
  const e2Targets = listConfiguredE2Buckets().map(
    (bucket): StorageTarget => ({ provider: "e2", bucket }),
  );

  let gdriveTargets: StorageTarget[] = [];
  try {
    const gdriveOk = await isGDriveConfigured();
    if (gdriveOk) {
      const accounts = await listAuthorizedAccounts();
      gdriveTargets = accounts.map(
        ({ email }): StorageTarget => ({ provider: "gdrive", bucket: email }),
      );
    }
  } catch {
    // GDrive yapılandırma hatası diğer provider'ları engellemesin
  }

  return [...r2Targets, ...b2Targets, ...e2Targets, ...gdriveTargets];
}

/**
 * Senkron hedef listesi — GDrive hariç (OAuth'suz servisler için geriye dönük uyumluluk).
 * Admin paneli istatistik endpoint'i tarafından kullanılır.
 */
export function listSyncTargets(): StorageTarget[] {
  const r2Targets = listR2Buckets().map(
    (bucket): StorageTarget => ({ provider: "r2", bucket }),
  );
  const b2Targets = listConfiguredB2Buckets().map(
    (bucket): StorageTarget => ({ provider: "b2", bucket }),
  );
  const e2Targets = listConfiguredE2Buckets().map(
    (bucket): StorageTarget => ({ provider: "e2", bucket }),
  );
  return [...r2Targets, ...b2Targets, ...e2Targets];
}

/**
 * En az bir depolama servisinin yapılandırılmış olup olmadığını kontrol eder.
 * GDrive zaman uyumsuz olduğu için bu fonksiyon yalnızca senkron sağlayıcıları kontrol eder.
 * Tam kontrol için isAnyStorageConfiguredAsync() kullanın.
 */
export function isAnyStorageConfigured(): boolean {
  return isR2Configured() || isB2Configured() || isE2Configured();
}

export async function isAnyStorageConfiguredAsync(): Promise<boolean> {
  if (isAnyStorageConfigured()) return true;
  try {
    return await isGDriveConfigured();
  } catch {
    return false;
  }
}

/**
 * Yükleme için bir hedef seçer (tüm provider'larda round-robin).
 * @throws Hiç depolama servisi yapılandırılmamışsa hata fırlatır.
 */
export async function pickUploadTarget(): Promise<StorageTarget> {
  const targets = await listAllTargets();
  if (targets.length === 0) {
    throw new Error(
      "Hiç depolama servisi yapılandırılmamış " +
        "(R2_BUCKET_NAMES, B2_BUCKET_NAMES, E2_BUCKET_NAMES eksik " +
        "veya Google Drive hesabı yetkilendirilmemiş)",
    );
  }
  const target = targets[_rrIndex % targets.length]!;
  _rrIndex = (_rrIndex + 1) % targets.length;
  return target;
}

/**
 * Provider etiketiyle tüm yapılandırılmış bucket'ların özetini döner.
 */
export function getStorageSummary(): {
  r2Configured: boolean;
  b2Configured: boolean;
  e2Configured: boolean;
  r2Buckets: string[];
  b2Buckets: string[];
  e2Buckets: string[];
  allTargets: StorageTarget[];
} {
  const syncTargets = listSyncTargets();
  return {
    r2Configured: isR2Configured(),
    b2Configured: isB2Configured(),
    e2Configured: isE2Configured(),
    r2Buckets: listR2Buckets(),
    b2Buckets: listConfiguredB2Buckets(),
    e2Buckets: listConfiguredE2Buckets(),
    allTargets: syncTargets,
  };
}

// ── Birleşik İşlemler ─────────────────────────────────────────────────────────

/**
 * Bir chunk'ı şifreleyerek belirtilen hedefe yükler.
 * Provider'a göre R2, B2, e2 veya GDrive istemcisine yönlendirir.
 */
export async function uploadChunkToStorage(
  target: StorageTarget,
  fileId: string,
  chunkIndex: number,
  plaintext: Buffer,
  encryptionKey: Buffer,
): Promise<void> {
  if (target.provider === "b2") {
    return uploadChunkToB2(fileId, chunkIndex, plaintext, encryptionKey, target.bucket);
  }
  if (target.provider === "e2") {
    return uploadChunkToE2(fileId, chunkIndex, plaintext, encryptionKey, target.bucket);
  }
  if (target.provider === "gdrive") {
    return uploadChunkToGDrive(fileId, chunkIndex, plaintext, encryptionKey, target.bucket);
  }
  return uploadChunkToR2(fileId, chunkIndex, plaintext, encryptionKey, target.bucket);
}

/**
 * Bir chunk'ı belirtilen hedeften indirir ve şifresini çözer.
 * Provider'a göre R2, B2, e2 veya GDrive istemcisine yönlendirir.
 */
export async function downloadChunkFromStorage(
  target: StorageTarget,
  fileId: string,
  chunkIndex: number,
  encryptionKey: Buffer,
): Promise<Buffer> {
  if (target.provider === "b2") {
    return downloadChunkFromB2(fileId, chunkIndex, encryptionKey, target.bucket);
  }
  if (target.provider === "e2") {
    return downloadChunkFromE2(fileId, chunkIndex, encryptionKey, target.bucket);
  }
  if (target.provider === "gdrive") {
    return downloadChunkFromGDrive(fileId, chunkIndex, encryptionKey, target.bucket);
  }
  return downloadChunkFromR2(fileId, chunkIndex, encryptionKey, target.bucket);
}

/**
 * Bir dosyanın tüm chunk'larını belirtilen hedeften siler (best-effort).
 * Provider'a göre R2, B2, e2 veya GDrive istemcisine yönlendirir.
 */
export async function deleteFileChunksFromStorage(
  target: StorageTarget,
  fileId: string,
  chunkCount: number,
): Promise<void> {
  if (target.provider === "b2") {
    return deleteFileChunksFromB2(fileId, chunkCount, target.bucket);
  }
  if (target.provider === "e2") {
    return deleteFileChunksFromE2(fileId, chunkCount, target.bucket);
  }
  if (target.provider === "gdrive") {
    return deleteFileChunksFromGDrive(fileId, chunkCount, target.bucket);
  }
  return deleteFileChunksFromR2(fileId, chunkCount, target.bucket);
}
