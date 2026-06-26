/**
 * Backblaze B2 depolama istemcisi — AES-256-GCM şifreleme ile.
 *
 * B2, S3-uyumlu API sunduğu için AWS S3 SDK kullanılır.
 *
 * Gerekli ortam değişkenleri:
 *   B2_KEY_ID          — B2 Application Key ID (erişim anahtarı)
 *   B2_APP_KEY         — B2 Application Key (gizli anahtar)
 *   B2_ENDPOINT        — S3-uyumlu endpoint (ör: https://s3.us-west-004.backblazeb2.com)
 *   B2_BUCKET_NAMES    — Virgülle ayrılmış bucket listesi (ör: "bucket-a,bucket-b")
 *                        VEYA B2_BUCKET_NAME (tek bucket, geriye dönük uyumluluk)
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

/** Test bağlantı kontrolü için sabit B2 nesne yolu (yükle-sil döngüsü) */
const B2_TEST_KEY = "files/_connectivity_check/test.bin";

// ── Çoklu Bucket Yönetimi ─────────────────────────────────────────────────────

let _b2RoundRobinIndex = 0;

/**
 * Yapılandırılmış tüm B2 bucket adlarını döner.
 * B2_BUCKET_NAMES (virgülle ayrılmış) önceliklidir; yoksa B2_BUCKET_NAME kullanılır.
 */
export function listConfiguredB2Buckets(): string[] {
  const multi = process.env["B2_BUCKET_NAMES"];
  if (multi) {
    return multi
      .split(",")
      .map((b) => b.trim())
      .filter(Boolean);
  }
  const single = process.env["B2_BUCKET_NAME"];
  return single ? [single] : [];
}

/**
 * B2'nin yapılandırılmış olup olmadığını kontrol eder.
 * Kimlik bilgileri + endpoint + en az bir bucket gereklidir.
 */
export function isB2Configured(): boolean {
  return (
    !!(
      process.env["B2_KEY_ID"] &&
      process.env["B2_APP_KEY"] &&
      process.env["B2_ENDPOINT"]
    ) && listConfiguredB2Buckets().length > 0
  );
}

/**
 * Yükleme için bir B2 bucket seçer (round-robin).
 * @throws Hiç B2 bucket yapılandırılmamışsa hata fırlatır.
 */
export function pickB2UploadBucket(): string {
  const buckets = listConfiguredB2Buckets();
  if (buckets.length === 0) {
    throw new Error("B2 bucket tanımlı değil (B2_BUCKET_NAMES veya B2_BUCKET_NAME eksik)");
  }
  const bucket = buckets[_b2RoundRobinIndex % buckets.length]!;
  _b2RoundRobinIndex = (_b2RoundRobinIndex + 1) % buckets.length;
  return bucket;
}

// ── B2 İstemcisi ──────────────────────────────────────────────────────────────

function getB2Client(): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: process.env["B2_ENDPOINT"]!,
    credentials: {
      accessKeyId: process.env["B2_KEY_ID"]!,
      secretAccessKey: process.env["B2_APP_KEY"]!,
    },
  });
}

/** B2 nesne yolu: files/{sha256(fileId)}/chunk_{i}.enc */
function b2Key(fileId: string, chunkIndex: number): string {
  return `files/${fileIdToStoragePath(fileId)}/chunk_${chunkIndex}.enc`;
}

// ── B2 İşlemleri ──────────────────────────────────────────────────────────────

/**
 * Bir chunk'ı şifreleyerek belirtilen B2 bucket'ına yükler.
 * Şifreleme r2Storage.ts'deki encryptChunk ile aynı (AES-256-GCM).
 *
 * @param bucket  Hedef bucket adı (pickB2UploadBucket() sonucu)
 */
export async function uploadChunkToB2(
  fileId: string,
  chunkIndex: number,
  plaintext: Buffer,
  encryptionKey: Buffer,
  bucket: string,
): Promise<void> {
  const client = getB2Client();
  const encrypted = encryptChunk(plaintext, encryptionKey);

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: b2Key(fileId, chunkIndex),
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
 * Belirtilen B2 bucket'ından bir chunk'ı indirir ve şifresini çözer.
 *
 * @param bucket  Dosyanın saklandığı bucket (Firebase kaydından okunur)
 */
export async function downloadChunkFromB2(
  fileId: string,
  chunkIndex: number,
  encryptionKey: Buffer,
  bucket: string,
): Promise<Buffer> {
  const client = getB2Client();

  let response: GetObjectCommandOutput;
  try {
    response = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: b2Key(fileId, chunkIndex),
      }),
    );
  } catch (err: unknown) {
    const code =
      (err as { Code?: string; name?: string }).Code ??
      (err as { name?: string }).name;
    if (code === "NoSuchKey" || code === "NotFound") {
      throw new Error(
        `B2: chunk_${chunkIndex} bulunamadı (bucket: ${bucket}, dosya: ${fileId})`,
      );
    }
    throw err;
  }

  if (!response.Body) {
    throw new Error(
      `B2: boş yanıt gövdesi (bucket: ${bucket}, chunk_${chunkIndex}, dosya: ${fileId})`,
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
 * B2 bucket bağlantısını test eder: küçük bir nesne yükler ve siler.
 * @returns latencyMs ve hata varsa error string
 */
export async function testB2Connectivity(bucket: string): Promise<{ success: boolean; latencyMs: number; error?: string }> {
  const client = getB2Client();
  const start = Date.now();
  const testBody = Buffer.from(`filesplit-connectivity-test-${Date.now()}`);
  try {
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: B2_TEST_KEY,
      Body: testBody,
      ContentType: "application/octet-stream",
      ContentLength: testBody.length,
    }));
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: B2_TEST_KEY }));
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
 * Bir dosyanın tüm chunk'larını belirtilen B2 bucket'tan siler (best-effort).
 * Eksik nesneler görmezden gelinir; asla hata fırlatmaz.
 *
 * @param bucket  Dosyanın saklandığı bucket (Firebase kaydından okunur)
 */
export async function deleteFileChunksFromB2(
  fileId: string,
  chunkCount: number,
  bucket: string,
): Promise<void> {
  if (!isB2Configured()) return;
  const client = getB2Client();

  const deletions = Array.from({ length: chunkCount }, (_, i) =>
    client
      .send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: b2Key(fileId, i),
        }),
      )
      .catch((err: unknown) => {
        logger.warn(
          { err, fileId, chunkIndex: i, bucket },
          "B2 chunk silme başarısız (non-fatal)",
        );
      }),
  );

  await Promise.all(deletions);
}
