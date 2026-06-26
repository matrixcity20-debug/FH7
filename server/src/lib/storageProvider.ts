/**
 * Birleşik Depolama Yönlendiricisi — Cloudflare R2 + Backblaze B2 + iDrive e2
 *
 * Tüm hesap + bucket kombinasyonlarını tek bir havuzda toplar; round-robin
 * yük dağıtımı yapar. Her StorageTarget kendi S3Client'ını taşır — upload,
 * download ve delete işlemleri her zaman doğru hesap kimlik bilgileriyle çalışır.
 *
 * ── Çoklu Hesap Akışı ────────────────────────────────────────────────────────
 *
 *   1. Yükleme : pickUploadTarget() → round-robin → target._s3 ile yükle
 *   2. İndirme : findStorageTargetByBucket(provider, bucket) → target._s3 ile indir
 *   3. Silme   : findStorageTargetByBucket(provider, bucket) → target._s3 ile sil
 *
 *   Her dosyanın hangi provider + bucket'ta saklandığı Firebase kaydında tutulur.
 *   Download/delete, bucket adına göre doğru S3Client'ı otomatik bulur.
 *
 * ── Güvenlik ─────────────────────────────────────────────────────────────────
 *
 *   _s3 alanı TypeScript'te internal olarak işaretlidir.
 *   API yanıtlarında StorageTarget nesnesi asla doğrudan serileştirilmez;
 *   yalnızca provider + bucket alanları Firebase/client'a iletilir.
 */

import type { S3Client } from "@aws-sdk/client-s3";
import {
  isR2Configured,
  listR2Accounts,
  getR2ClientForAccount,
  uploadChunkToR2,
  downloadChunkFromR2,
  deleteFileChunksFromR2,
  testR2Connectivity,
  generateEncryptionKey,
} from "./r2Storage.js";
import {
  isB2Configured,
  listB2Accounts,
  getB2ClientForAccount,
  uploadChunkToB2,
  downloadChunkFromB2,
  deleteFileChunksFromB2,
  testB2Connectivity,
} from "./b2Storage.js";
import {
  isE2Configured,
  listE2Accounts,
  getE2ClientForAccount,
  uploadChunkToE2,
  downloadChunkFromE2,
  deleteFileChunksFromE2,
  testE2Connectivity,
} from "./e2Storage.js";
import { logger } from "./logger.js";

export type StorageProvider = "r2" | "b2" | "e2";

export interface StorageTarget {
  /** Hangi servis: Cloudflare R2, Backblaze B2, iDrive e2 */
  provider: StorageProvider;
  /** Hedef bucket adı */
  bucket: string;
  /** 1-tabanlı hesap numarası — loglama ve sağlık izleme için */
  accountIndex: number;
  /**
   * @internal
   * Bu hesaba ait önbelleklenmiş S3Client.
   * API yanıtlarına, Firebase kayıtlarına veya istemciye asla dahil edilmez.
   */
  _s3: S3Client;
}

// ── Yeniden dışa aktar ────────────────────────────────────────────────────────
export { generateEncryptionKey };

// ── Round-Robin Durumu ────────────────────────────────────────────────────────

let _rrIndex = 0;

// ── Hedef Listesi ─────────────────────────────────────────────────────────────

/**
 * Yapılandırılmış tüm depolama hedeflerini döner (R2 + B2 + e2, tüm hesaplar).
 * Her hedef kendi S3Client'ını taşır.
 * Sıra: R2 hesapları → B2 hesapları → e2 hesapları (hesap içinde bucket sırası korunur).
 */
export function listAllTargets(): StorageTarget[] {
  const targets: StorageTarget[] = [];

  for (const account of listR2Accounts()) {
    const s3 = getR2ClientForAccount(account);
    for (const bucket of account.buckets) {
      targets.push({ provider: "r2", bucket, accountIndex: account.accountIndex, _s3: s3 });
    }
  }

  for (const account of listB2Accounts()) {
    const s3 = getB2ClientForAccount(account);
    for (const bucket of account.buckets) {
      targets.push({ provider: "b2", bucket, accountIndex: account.accountIndex, _s3: s3 });
    }
  }

  for (const account of listE2Accounts()) {
    const s3 = getE2ClientForAccount(account);
    for (const bucket of account.buckets) {
      targets.push({ provider: "e2", bucket, accountIndex: account.accountIndex, _s3: s3 });
    }
  }

  return targets;
}

/** @deprecated listAllTargets() ile aynı — geriye dönük uyumluluk için tutulur. */
export function listSyncTargets(): StorageTarget[] {
  return listAllTargets();
}

/**
 * Verilen provider + bucket için yapılandırılmış StorageTarget'ı döner.
 * Dosya indirme ve silme işlemlerinde doğru S3Client'ı bulmak için kullanılır.
 *
 * Bucket adı tüm hesaplar arasında benzersiz olmalıdır; birden fazla eşleşme
 * varsa ilki kullanılır ve uyarı loglanır.
 *
 * @returns Eşleşen target; hiç bulunamazsa null (bu durumda çağrı kodu
 *          birincil hesap kimlik bilgilerine düşebilir).
 */
export function findStorageTargetByBucket(
  provider: StorageProvider,
  bucket: string,
): StorageTarget | null {
  const matches = listAllTargets().filter(
    (t) => t.provider === provider && t.bucket === bucket,
  );

  if (matches.length === 0) {
    logger.warn(
      { provider, bucket },
      "findStorageTargetByBucket: bucket bulunamadı — kimlik bilgisi yok",
    );
    return null;
  }

  if (matches.length > 1) {
    logger.warn(
      { provider, bucket, matchCount: matches.length },
      "findStorageTargetByBucket: aynı bucket adı birden fazla hesapta — ilki kullanılıyor",
    );
  }

  return matches[0]!;
}

/**
 * En az bir depolama servisinin yapılandırılmış olup olmadığını kontrol eder.
 */
export function isAnyStorageConfigured(): boolean {
  return isR2Configured() || isB2Configured() || isE2Configured();
}

/** @deprecated isAnyStorageConfigured() kullanın. */
export async function isAnyStorageConfiguredAsync(): Promise<boolean> {
  return isAnyStorageConfigured();
}

/**
 * Yükleme için bir hedef seçer (tüm provider'lar + tüm hesaplar arasında round-robin).
 * @throws Hiç depolama servisi yapılandırılmamışsa hata fırlatır.
 */
export async function pickUploadTarget(): Promise<StorageTarget> {
  const targets = listAllTargets();
  if (targets.length === 0) {
    throw new Error(
      "Hiç depolama servisi yapılandırılmamış " +
        "(R2_BUCKET_NAMES/B2_BUCKET_NAMES/E2_BUCKET_NAMES ve kimlik bilgileri eksik)",
    );
  }
  const target = targets[_rrIndex % targets.length]!;
  _rrIndex = (_rrIndex + 1) % targets.length;
  return target;
}

/**
 * Provider etiketiyle tüm yapılandırılmış hesap + bucket özetini döner.
 */
export function getStorageSummary(): {
  r2Configured: boolean;
  b2Configured: boolean;
  e2Configured: boolean;
  r2Buckets: string[];
  b2Buckets: string[];
  e2Buckets: string[];
  allTargets: Array<{ provider: StorageProvider; bucket: string; accountIndex: number }>;
} {
  const allTargets = listAllTargets().map(({ provider, bucket, accountIndex }) => ({
    provider,
    bucket,
    accountIndex,
  }));

  return {
    r2Configured: isR2Configured(),
    b2Configured: isB2Configured(),
    e2Configured: isE2Configured(),
    r2Buckets: listAllTargets()
      .filter((t) => t.provider === "r2")
      .map((t) => t.bucket),
    b2Buckets: listAllTargets()
      .filter((t) => t.provider === "b2")
      .map((t) => t.bucket),
    e2Buckets: listAllTargets()
      .filter((t) => t.provider === "e2")
      .map((t) => t.bucket),
    allTargets,
  };
}

// ── Bağlantı Testi ────────────────────────────────────────────────────────────

/**
 * Belirtilen StorageTarget'ın bağlantısını test eder.
 * Doğru hesap kimlik bilgilerini (target._s3) kullanır.
 */
export async function testStorageTargetConnectivity(
  target: StorageTarget,
): Promise<{ success: boolean; latencyMs: number; error?: string }> {
  if (target.provider === "b2") {
    return testB2Connectivity(target.bucket, target._s3);
  }
  if (target.provider === "e2") {
    return testE2Connectivity(target.bucket, target._s3);
  }
  return testR2Connectivity(target.bucket, target._s3);
}

// ── Birleşik İşlemler ─────────────────────────────────────────────────────────

/**
 * Bir chunk'ı şifreleyerek belirtilen hedefe yükler.
 * target._s3 içindeki S3Client kullanılır (doğru hesap kimlik bilgileri).
 */
export async function uploadChunkToStorage(
  target: StorageTarget,
  fileId: string,
  chunkIndex: number,
  plaintext: Buffer,
  encryptionKey: Buffer,
): Promise<void> {
  if (target.provider === "b2") {
    return uploadChunkToB2(fileId, chunkIndex, plaintext, encryptionKey, target.bucket, target._s3);
  }
  if (target.provider === "e2") {
    return uploadChunkToE2(fileId, chunkIndex, plaintext, encryptionKey, target.bucket, target._s3);
  }
  return uploadChunkToR2(fileId, chunkIndex, plaintext, encryptionKey, target.bucket, target._s3);
}

/**
 * Bir chunk'ı belirtilen hedeften indirir ve şifresini çözer.
 * target._s3 içindeki S3Client kullanılır (doğru hesap kimlik bilgileri).
 */
export async function downloadChunkFromStorage(
  target: StorageTarget,
  fileId: string,
  chunkIndex: number,
  encryptionKey: Buffer,
): Promise<Buffer> {
  if (target.provider === "b2") {
    return downloadChunkFromB2(fileId, chunkIndex, encryptionKey, target.bucket, target._s3);
  }
  if (target.provider === "e2") {
    return downloadChunkFromE2(fileId, chunkIndex, encryptionKey, target.bucket, target._s3);
  }
  return downloadChunkFromR2(fileId, chunkIndex, encryptionKey, target.bucket, target._s3);
}

/**
 * Bir dosyanın tüm chunk'larını belirtilen hedeften siler (best-effort).
 * target._s3 içindeki S3Client kullanılır (doğru hesap kimlik bilgileri).
 */
export async function deleteFileChunksFromStorage(
  target: StorageTarget,
  fileId: string,
  chunkCount: number,
): Promise<void> {
  if (target.provider === "b2") {
    return deleteFileChunksFromB2(fileId, chunkCount, target.bucket, target._s3);
  }
  if (target.provider === "e2") {
    return deleteFileChunksFromE2(fileId, chunkCount, target.bucket, target._s3);
  }
  return deleteFileChunksFromR2(fileId, chunkCount, target.bucket, target._s3);
}
