/**
 * iDrive e2 depolama istemcisi — AES-256-GCM şifreleme ile.
 *
 * iDrive e2, S3-uyumlu API sunduğu için AWS S3 SDK kullanılır.
 *
 * Gerekli ortam değişkenleri:
 *   E2_ACCESS_KEY_ID     — iDrive e2 Access Key ID
 *   E2_SECRET_ACCESS_KEY — iDrive e2 Secret Access Key
 *   E2_ENDPOINT          — S3-uyumlu endpoint URL
 *                          (ör: https://HESAP_ID.s3.BOLGE.idrivecloud.io)
 *   E2_BUCKET_NAMES      — Virgülle ayrılmış bucket listesi (ör: "bucket-a,bucket-b")
 *                          VEYA E2_BUCKET_NAME (tek bucket, geriye dönük uyumluluk)
 *
 * Güvenlik notları:
 *   - Şifreleme anahtarı asla e2'ye yazılmaz; yalnızca Firebase'de saklanır.
 *   - Nesne yolları SHA-256 tabanlı; UUID'ler doğrudan görünmez (enumerate koruması).
 *   - AES-256-GCM kimlik doğrulamalı şifreleme; bütünlük garantisi sağlar.
 *   - Her chunk için bağımsız IV; aynı veri farklı ciphertext üretir.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { encryptChunk, decryptChunk, fileIdToStoragePath } from "./r2Storage.js";
import { logger } from "./logger.js";

/** Test bağlantı kontrolü için sabit e2 nesne yolu (yükle-sil döngüsü) */
const E2_TEST_KEY = "files/_connectivity_check/test.bin";

// ── Çoklu Bucket Yönetimi ─────────────────────────────────────────────────────

let _e2RoundRobinIndex = 0;

/**
 * Yapılandırılmış tüm e2 bucket adlarını döner.
 * E2_BUCKET_NAMES (virgülle ayrılmış) önceliklidir; yoksa E2_BUCKET_NAME kullanılır.
 * Hiç tanımlı değilse boş dizi döner.
 */
export function listConfiguredE2Buckets(): string[] {
  const multi = process.env["E2_BUCKET_NAMES"];
  if (multi) {
    return multi
      .split(",")
      .map((b) => b.trim())
      .filter(Boolean);
  }
  const single = process.env["E2_BUCKET_NAME"];
  return single ? [single] : [];
}

/**
 * e2'nin yapılandırılmış olup olmadığını kontrol eder.
 * Kimlik bilgileri + endpoint + en az bir bucket gereklidir.
 */
export function isE2Configured(): boolean {
  return (
    !!(
      process.env["E2_ACCESS_KEY_ID"] &&
      process.env["E2_SECRET_ACCESS_KEY"] &&
      process.env["E2_ENDPOINT"]
    ) && listConfiguredE2Buckets().length > 0
  );
}

/**
 * Yükleme için bir e2 bucket seçer (round-robin).
 * @throws Hiç e2 bucket yapılandırılmamışsa hata fırlatır.
 */
export function pickE2UploadBucket(): string {
  const buckets = listConfiguredE2Buckets();
  if (buckets.length === 0) {
    throw new Error("e2 bucket tanımlı değil (E2_BUCKET_NAMES veya E2_BUCKET_NAME eksik)");
  }
  const bucket = buckets[_e2RoundRobinIndex % buckets.length]!;
  _e2RoundRobinIndex = (_e2RoundRobinIndex + 1) % buckets.length;
  return bucket;
}

// ── e2 İstemcisi ──────────────────────────────────────────────────────────────

function getE2Client(): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: process.env["E2_ENDPOINT"]!,
    credentials: {
      accessKeyId: process.env["E2_ACCESS_KEY_ID"]!,
      secretAccessKey: process.env["E2_SECRET_ACCESS_KEY"]!,
    },
    forcePathStyle: true,
  });
}

/** e2 nesne yolu: files/{sha256(fileId)}/chunk_{i}.enc */
function e2Key(fileId: string, chunkIndex: number): string {
  return `files/${fileIdToStoragePath(fileId)}/chunk_${chunkIndex}.enc`;
}

// ── e2 İşlemleri ──────────────────────────────────────────────────────────────

/**
 * Bir chunk'ı şifreleyerek belirtilen e2 bucket'ına yükler.
 * Şifreleme r2Storage.ts'deki encryptChunk ile aynı (AES-256-GCM).
 *
 * @param bucket  Hedef bucket adı (pickE2UploadBucket() sonucu)
 */
export async function uploadChunkToE2(
  fileId: string,
  chunkIndex: number,
  plaintext: Buffer,
  encryptionKey: Buffer,
  bucket: string,
): Promise<void> {
  const client = getE2Client();
  const encrypted = encryptChunk(plaintext, encryptionKey);

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: e2Key(fileId, chunkIndex),
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
 * Belirtilen e2 bucket'ından bir chunk'ı indirir ve şifresini çözer.
 *
 * @param bucket  Dosyanın saklandığı bucket (Firebase kaydından okunur)
 */
export async function downloadChunkFromE2(
  fileId: string,
  chunkIndex: number,
  encryptionKey: Buffer,
  bucket: string,
): Promise<Buffer> {
  const client = getE2Client();

  let response: GetObjectCommandOutput;
  try {
    response = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: e2Key(fileId, chunkIndex),
      }),
    );
  } catch (err: unknown) {
    const code =
      (err as { Code?: string; name?: string }).Code ??
      (err as { name?: string }).name;
    if (code === "NoSuchKey" || code === "NotFound") {
      throw new Error(
        `e2: chunk_${chunkIndex} bulunamadı (bucket: ${bucket}, dosya: ${fileId})`,
      );
    }
    throw err;
  }

  if (!response.Body) {
    throw new Error(
      `e2: boş yanıt gövdesi (bucket: ${bucket}, chunk_${chunkIndex}, dosya: ${fileId})`,
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
 * e2 bucket bağlantısını test eder: küçük bir nesne yükler ve siler.
 * @returns latencyMs ve hata varsa error string
 */
export async function testE2Connectivity(
  bucket: string,
): Promise<{ success: boolean; latencyMs: number; error?: string }> {
  const client = getE2Client();
  const start = Date.now();
  const testBody = Buffer.from(`filesplit-connectivity-test-${Date.now()}`);
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: E2_TEST_KEY,
        Body: testBody,
        ContentType: "application/octet-stream",
        ContentLength: testBody.length,
      }),
    );
    await client.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: E2_TEST_KEY }),
    );
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
 * Bir dosyanın tüm chunk'larını belirtilen e2 bucket'tan siler (best-effort).
 * Eksik nesneler görmezden gelinir; asla hata fırlatmaz.
 *
 * @param bucket  Dosyanın saklandığı bucket (Firebase kaydından okunur)
 */
export async function deleteFileChunksFromE2(
  fileId: string,
  chunkCount: number,
  bucket: string,
): Promise<void> {
  if (!isE2Configured()) return;
  const client = getE2Client();

  const deletions = Array.from({ length: chunkCount }, (_, i) =>
    client
      .send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: e2Key(fileId, i),
        }),
      )
      .catch((err: unknown) => {
        logger.warn(
          { err, fileId, chunkIndex: i, bucket },
          "e2 chunk silme başarısız (non-fatal)",
        );
      }),
  );

  await Promise.all(deletions);
}
