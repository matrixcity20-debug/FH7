/**
 * Birleşik Depolama Yönlendiricisi — Cloudflare R2 + Backblaze B2 + iDrive e2
 *
 * Tüm R2, B2 ve e2 bucket'larını tek bir havuzda toplar.
 * Round-robin ile yük dağıtımı yapar:
 *   R2 buckets: [r2-a, r2-b]  +  B2 buckets: [b2-a]  +  e2 buckets: [e2-a]
 *   → Sıra: r2-a → r2-b → b2-a → e2-a → r2-a → ...
 *
 * Her dosya hangi provider + bucket'ta saklandığını Firebase kaydında taşır.
 * İndirme ve silme işlemleri her zaman doğru servise yönlendirilir.
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

export type StorageProvider = "r2" | "b2" | "e2";

export interface StorageTarget {
  /** Hangi servis: Cloudflare R2, Backblaze B2 veya iDrive e2 */
  provider: StorageProvider;
  /** Hedef bucket adı */
  bucket: string;
}

// ── Yeniden dışa aktar ────────────────────────────────────────────────────────
// files.ts'nin r2Storage.ts'e doğrudan bağımlılığını kaldırmak için
export { generateEncryptionKey };

// ── Round-Robin Durumu ────────────────────────────────────────────────────────

let _rrIndex = 0;

// ── Provider Yönetimi ─────────────────────────────────────────────────────────

/**
 * Yapılandırılmış tüm depolama hedeflerini döner (R2 + B2 + e2 birlikte).
 * R2 bucket'ları önce, B2 bucket'ları sonra, e2 bucket'ları en sona listelenir.
 */
export function listAllTargets(): StorageTarget[] {
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
 */
export function isAnyStorageConfigured(): boolean {
  return isR2Configured() || isB2Configured() || isE2Configured();
}

/**
 * Yükleme için bir hedef seçer (tüm provider'larda round-robin).
 * @throws Hiç depolama servisi yapılandırılmamışsa hata fırlatır.
 */
export function pickUploadTarget(): StorageTarget {
  const targets = listAllTargets();
  if (targets.length === 0) {
    throw new Error(
      "Hiç depolama servisi yapılandırılmamış " +
        "(R2_BUCKET_NAMES/R2_BUCKET_NAME, B2_BUCKET_NAMES/B2_BUCKET_NAME " +
        "veya E2_BUCKET_NAMES/E2_BUCKET_NAME eksik)",
    );
  }
  const target = targets[_rrIndex % targets.length]!;
  _rrIndex = (_rrIndex + 1) % targets.length;
  return target;
}

/**
 * Provider etiketiyle tüm yapılandırılmış bucket'ların özetini döner.
 * Admin paneli istatistik endpoint'i için kullanılır.
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
  return {
    r2Configured: isR2Configured(),
    b2Configured: isB2Configured(),
    e2Configured: isE2Configured(),
    r2Buckets: listR2Buckets(),
    b2Buckets: listConfiguredB2Buckets(),
    e2Buckets: listConfiguredE2Buckets(),
    allTargets: listAllTargets(),
  };
}

// ── Birleşik İşlemler ─────────────────────────────────────────────────────────

/**
 * Bir chunk'ı şifreleyerek belirtilen hedefe yükler.
 * Hedef provider'a göre R2, B2 veya e2 istemcisine yönlendirir.
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
  return uploadChunkToR2(fileId, chunkIndex, plaintext, encryptionKey, target.bucket);
}

/**
 * Bir chunk'ı belirtilen hedeften indirir ve şifresini çözer.
 * Hedef provider'a göre R2, B2 veya e2 istemcisine yönlendirir.
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
  return downloadChunkFromR2(fileId, chunkIndex, encryptionKey, target.bucket);
}

/**
 * Bir dosyanın tüm chunk'larını belirtilen hedeften siler (best-effort).
 * Hedef provider'a göre R2, B2 veya e2 istemcisine yönlendirir.
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
  return deleteFileChunksFromR2(fileId, chunkCount, target.bucket);
}
