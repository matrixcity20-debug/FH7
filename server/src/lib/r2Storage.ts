/**
 * Cloudflare R2 depolama istemcisi — AES-256-GCM şifreleme ile.
 *
 * Çoklu bucket desteği:
 *   R2_BUCKET_NAMES=bucket1,bucket2,bucket3   (virgülle ayrılmış liste)
 *   R2_BUCKET_NAME=tek-bucket                 (geriye dönük uyumluluk)
 *   İkisi de tanımlıysa R2_BUCKET_NAMES önceliklidir.
 *   Yükleme sırasında round-robin seçim yapılır.
 *   Her dosya kendi bucket adını Firebase'de taşır — indirme ve silme
 *   işlemleri her zaman doğru bucket'a gider.
 *
 * Şifreleme tasarımı:
 *   - Her dosya için 32 baytlık rastgele şifreleme anahtarı üretilir.
 *   - Her chunk için 12 baytlık rastgele IV üretilir ve ciphertext başına gömülür.
 *   - R2'de saklanan format: [IV(12 B) | ciphertext | authTag(16 B)]
 *   - Şifreleme anahtarı ASLA R2'ye yazılmaz; yalnızca Firebase RTDB'de saklanır.
 *   - R2 nesneleri sızdırılsa bile anahtar olmadan veri okunamaz.
 *
 * Gerekli ortam değişkenleri:
 *   R2_ACCOUNT_ID        — Cloudflare hesap kimliği
 *   R2_ACCESS_KEY_ID     — R2 API token erişim anahtarı
 *   R2_SECRET_ACCESS_KEY — R2 API token gizli anahtarı
 *   R2_BUCKET_NAMES      — Virgülle ayrılmış bucket listesi (ör: "bucket-eu,bucket-us")
 *                          VEYA R2_BUCKET_NAME (tek bucket, geriye dönük)
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto";
import { logger } from "./logger.js";

// ── Sabitler ─────────────────────────────────────────────────────────────────
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const MIN_ENCRYPTED_SIZE = GCM_IV_BYTES + GCM_TAG_BYTES + 1;

// ── Çoklu Bucket Yönetimi ─────────────────────────────────────────────────────

let _bucketRoundRobinIndex = 0;

/**
 * Yapılandırılmış tüm bucket adlarını döner.
 * R2_BUCKET_NAMES (virgülle ayrılmış) önceliklidir; yoksa R2_BUCKET_NAME kullanılır.
 * Hiç tanımlı değilse boş dizi döner.
 */
export function listConfiguredBuckets(): string[] {
  const multi = process.env["R2_BUCKET_NAMES"];
  if (multi) {
    return multi
      .split(",")
      .map((b) => b.trim())
      .filter(Boolean);
  }
  const single = process.env["R2_BUCKET_NAME"];
  return single ? [single] : [];
}

/**
 * Yükleme için bir bucket seçer (round-robin).
 * @throws Hiç bucket yapılandırılmamışsa hata fırlatır.
 */
export function pickUploadBucket(): string {
  const buckets = listConfiguredBuckets();
  if (buckets.length === 0) {
    throw new Error("R2 bucket tanımlı değil (R2_BUCKET_NAMES veya R2_BUCKET_NAME eksik)");
  }
  const bucket = buckets[_bucketRoundRobinIndex % buckets.length]!;
  _bucketRoundRobinIndex = (_bucketRoundRobinIndex + 1) % buckets.length;
  return bucket;
}

/**
 * R2'nin yapılandırılmış olup olmadığını kontrol eder.
 * Kimlik bilgileri + en az bir bucket gereklidir.
 */
export function isR2Configured(): boolean {
  return (
    !!(
      process.env["R2_ACCOUNT_ID"] &&
      process.env["R2_ACCESS_KEY_ID"] &&
      process.env["R2_SECRET_ACCESS_KEY"]
    ) && listConfiguredBuckets().length > 0
  );
}

// ── R2 İstemcisi ──────────────────────────────────────────────────────────────

function getR2Client(): S3Client {
  const accountId = process.env["R2_ACCOUNT_ID"]!;
  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env["R2_ACCESS_KEY_ID"]!,
      secretAccessKey: process.env["R2_SECRET_ACCESS_KEY"]!,
    },
  });
}

/**
 * fileId'nin SHA-256 özetini döner — bucket nesne yollarında
 * UUID'lerin doğrudan görünmesini engeller; enumerate saldırılarını zorlaştırır.
 * Deterministik: aynı fileId her zaman aynı hex'i üretir.
 */
export function fileIdToStoragePath(fileId: string): string {
  return createHash("sha256").update(fileId, "utf8").digest("hex");
}

/** R2 nesne yolu: files/{sha256(fileId)}/chunk_{i}.enc */
function r2Key(fileId: string, chunkIndex: number): string {
  return `files/${fileIdToStoragePath(fileId)}/chunk_${chunkIndex}.enc`;
}

/** Test bağlantı kontrolü için sabit R2 nesne yolu (yükle-sil döngüsü) */
export const R2_TEST_KEY = "files/_connectivity_check/test.bin";

// ── Şifreleme / Çözme ─────────────────────────────────────────────────────────

/**
 * AES-256-GCM ile bir chunk'ı şifreler.
 * Çıktı formatı: [IV(12 B) | ciphertext | authTag(16 B)]
 */
export function encryptChunk(plaintext: Buffer, key: Buffer): Buffer {
  if (key.length !== 32) throw new Error("Encryption key must be 32 bytes");
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, authTag]);
}

/**
 * AES-256-GCM ile şifrelenmiş chunk'ı çözer.
 * Beklenen format: [IV(12 B) | ciphertext | authTag(16 B)]
 * @throws Bütünlük doğrulama başarısız olursa hata fırlatır.
 */
export function decryptChunk(encrypted: Buffer, key: Buffer): Buffer {
  if (key.length !== 32) throw new Error("Encryption key must be 32 bytes");
  if (encrypted.length < MIN_ENCRYPTED_SIZE) {
    throw new Error(`Encrypted data too short: ${encrypted.length} bytes`);
  }
  const iv = encrypted.subarray(0, GCM_IV_BYTES);
  const authTag = encrypted.subarray(encrypted.length - GCM_TAG_BYTES);
  const ciphertext = encrypted.subarray(GCM_IV_BYTES, encrypted.length - GCM_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  // SEC: explicitly assert the expected tag length before supplying the tag.
  // Without this, an attacker could submit a shorter truncated tag and the
  // Node.js runtime would accept it — weakening authentication guarantees.
  // setAuthTagLength must be called before setAuthTag.
  decipher.setAuthTagLength(GCM_TAG_BYTES);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** 256-bit (32 B) rastgele AES şifreleme anahtarı üretir. */
export function generateEncryptionKey(): Buffer {
  return randomBytes(32);
}

// ── R2 İşlemleri ──────────────────────────────────────────────────────────────

/**
 * Bir chunk'ı şifreleyerek belirtilen R2 bucket'ına yükler.
 *
 * @param bucket  Hedef bucket adı (pickUploadBucket() sonucu)
 */
export async function uploadChunkToR2(
  fileId: string,
  chunkIndex: number,
  plaintext: Buffer,
  encryptionKey: Buffer,
  bucket: string,
): Promise<void> {
  const client = getR2Client();
  const encrypted = encryptChunk(plaintext, encryptionKey);

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: r2Key(fileId, chunkIndex),
      Body: encrypted,
      ContentType: "application/octet-stream",
      ContentLength: encrypted.length,
      Metadata: {
        "x-file-id": fileId,
        "x-chunk-index": String(chunkIndex),
      },
    }),
  );
}

/**
 * Belirtilen R2 bucket'ından bir chunk'ı indirir ve şifresini çözer.
 *
 * @param bucket  Dosyanın saklandığı bucket (Firebase kaydından okunur)
 */
export async function downloadChunkFromR2(
  fileId: string,
  chunkIndex: number,
  encryptionKey: Buffer,
  bucket: string,
): Promise<Buffer> {
  const client = getR2Client();

  let response: GetObjectCommandOutput;
  try {
    response = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: r2Key(fileId, chunkIndex),
      }),
    );
  } catch (err: unknown) {
    const code =
      (err as { Code?: string; name?: string }).Code ??
      (err as { name?: string }).name;
    if (code === "NoSuchKey" || code === "NotFound") {
      throw new Error(
        `R2: chunk_${chunkIndex} bulunamadı (bucket: ${bucket}, dosya: ${fileId})`,
      );
    }
    throw err;
  }

  if (!response.Body) {
    throw new Error(
      `R2: boş yanıt gövdesi (bucket: ${bucket}, chunk_${chunkIndex}, dosya: ${fileId})`,
    );
  }

  const chunks: Buffer[] = [];
  for await (const piece of response.Body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(piece));
  }
  const encrypted = Buffer.concat(chunks);

  return decryptChunk(encrypted, encryptionKey);
}

/**
 * R2 bucket bağlantısını test eder: küçük bir nesne yükler ve siler.
 * @returns latencyMs ve hata varsa error string
 */
export async function testR2Connectivity(bucket: string): Promise<{ success: boolean; latencyMs: number; error?: string }> {
  const client = getR2Client();
  const start = Date.now();
  const testBody = Buffer.from(`filesplit-connectivity-test-${Date.now()}`);
  try {
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: R2_TEST_KEY,
      Body: testBody,
      ContentType: "application/octet-stream",
      ContentLength: testBody.length,
    }));
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: R2_TEST_KEY }));
    return { success: true, latencyMs: Date.now() - start };
  } catch (err: unknown) {
    return {
      success: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Bir dosyanın tüm chunk'larını belirtilen bucket'tan siler (best-effort).
 * Eksik nesneler görmezden gelinir; asla hata fırlatmaz.
 *
 * @param bucket  Dosyanın saklandığı bucket (Firebase kaydından okunur)
 */
export async function deleteFileChunksFromR2(
  fileId: string,
  chunkCount: number,
  bucket: string,
): Promise<void> {
  if (!isR2Configured()) return;
  const client = getR2Client();

  const deletions = Array.from({ length: chunkCount }, (_, i) =>
    client
      .send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: r2Key(fileId, i),
        }),
      )
      .catch((err: unknown) => {
        logger.warn(
          { err, fileId, chunkIndex: i, bucket },
          "R2 chunk silme başarısız (non-fatal)",
        );
      }),
  );

  await Promise.all(deletions);
}
