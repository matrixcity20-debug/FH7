/**
 * Cloudflare R2 depolama istemcisi — AES-256-GCM şifreleme ile.
 *
 * AWS S3 uyumlu API; Cloudflare S3 uyumluluk katmanı üzerinden erişilir.
 *
 * ── Çoklu Hesap Konfigürasyonu ───────────────────────────────────────────────
 *
 *   Her env var, virgülle ayrılmış değer dizisi içerir.
 *   Aynı konumdaki değerler bir hesabı tanımlar.
 *
 *   Örnek — 3 farklı Cloudflare hesabı:
 *
 *     R2_ACCOUNT_ID        = acct1,acct2,acct3
 *     R2_ACCESS_KEY_ID     = key1,key2,key3
 *     R2_SECRET_ACCESS_KEY = sec1,sec2,sec3
 *     R2_BUCKET_NAMES      = bucketA|bucketB,bucket2,bucket3a|bucket3b
 *
 *   Hesap başına birden fazla bucket için `|` ayırıcısı kullanılır.
 *   Tek bucket: R2_BUCKET_NAMES = mybucket (virgül/pipe gerekmez).
 *
 * ── Doğrulama ────────────────────────────────────────────────────────────────
 *
 *   Dizi uzunlukları eşleşmezse hata loglanır ve R2 tamamen devre dışı kalır.
 *   Kısmi / tutarsız yapılandırma kabul edilmez.
 *
 * ── Güvenlik ─────────────────────────────────────────────────────────────────
 *
 *   - Şifreleme anahtarı asla R2'ye yazılmaz; yalnızca Firebase'de saklanır.
 *   - Nesne yolları SHA-256 tabanlı; UUID'ler doğrudan görünmez (enumerate koruması).
 *   - AES-256-GCM kimlik doğrulamalı şifreleme; bütünlük garantisi sağlar.
 *   - Her chunk için bağımsız IV; aynı veri farklı ciphertext üretir.
 *   - Kimlik bilgileri hiçbir log satırına yazılmaz.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import crypto from "node:crypto";
import { logger } from "./logger.js";

/** Bağlantı testi için sabit nesne yolu (yükle-sil döngüsü) */
const R2_TEST_KEY = "files/_connectivity_check/test.bin";

// ── Konfigürasyon Ayrıştırıcı ─────────────────────────────────────────────────

export interface R2AccountConfig {
  /** 1-tabanlı hesap numarası (1 = ilk giriş, 2 = ikinci, …) */
  accountIndex: number;
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  buckets: string[];
}

/**
 * Virgülle ayrılmış env var değerini dizi olarak döner.
 * Her değer baştaki ve sondaki boşluklardan arındırılır; boşlar atlanır.
 */
function parseCommaList(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Bucket konfigürasyonunu ayrıştırır.
 * Virgül → hesap sınırı; pipe → aynı hesap içinde birden fazla bucket.
 *
 * Örnek: "bucket1|bucket2,bucket3,bucket4|bucket5"
 *   → [ ["bucket1","bucket2"], ["bucket3"], ["bucket4","bucket5"] ]
 */
function parseBucketGroups(raw: string | undefined): string[][] {
  if (!raw?.trim()) return [];
  return raw.split(",").map((segment) =>
    segment
      .split("|")
      .map((b) => b.trim())
      .filter(Boolean),
  );
}

/**
 * Tüm yapılandırılmış R2 hesaplarını döner.
 *
 * Dizi uzunlukları eşleşmezse hata loglanır ve boş liste döner (fail-fast).
 */
export function listR2Accounts(): R2AccountConfig[] {
  const accountIds = parseCommaList(process.env["R2_ACCOUNT_ID"]);
  const accessKeys = parseCommaList(process.env["R2_ACCESS_KEY_ID"]);
  const secretKeys = parseCommaList(process.env["R2_SECRET_ACCESS_KEY"]);
  const bucketGroups = parseBucketGroups(process.env["R2_BUCKET_NAMES"]);
  const singleBucket = process.env["R2_BUCKET_NAME"]?.trim() ?? "";

  // Hiç kimlik bilgisi yoksa yapılandırılmamış
  if (accountIds.length === 0 && accessKeys.length === 0 && secretKeys.length === 0) {
    return [];
  }

  // Temel kimlik bilgisi dizileri eşit uzunlukta olmalı
  const credLengths = [accountIds.length, accessKeys.length, secretKeys.length];
  const uniqueCredLengths = new Set(credLengths.filter((n) => n > 0));
  if (uniqueCredLengths.size > 1) {
    logger.error(
      {
        R2_ACCOUNT_ID: accountIds.length,
        R2_ACCESS_KEY_ID: accessKeys.length,
        R2_SECRET_ACCESS_KEY: secretKeys.length,
      },
      "R2 konfigürasyon hatası: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID ve " +
        "R2_SECRET_ACCESS_KEY virgülle ayrılmış değer sayıları eşit olmalıdır. " +
        "R2 tamamen devre dışı bırakılıyor.",
    );
    return [];
  }

  const accountCount = [...uniqueCredLengths][0] ?? 0;
  if (accountCount === 0) return [];

  // Bucket grubu tanımlanmışsa hesap sayısıyla eşleşmeli
  if (bucketGroups.length > 0 && bucketGroups.length !== accountCount) {
    logger.error(
      { accounts: accountCount, bucketGroups: bucketGroups.length },
      "R2 konfigürasyon hatası: R2_BUCKET_NAMES virgülle ayrılmış segment sayısı " +
        "hesap sayısıyla eşleşmiyor. R2 tamamen devre dışı bırakılıyor.",
    );
    return [];
  }

  const accounts: R2AccountConfig[] = [];

  for (let i = 0; i < accountCount; i++) {
    const accountId = accountIds[i];
    const accessKeyId = accessKeys[i];
    const secretAccessKey = secretKeys[i];
    if (!accountId || !accessKeyId || !secretAccessKey) continue;

    const buckets =
      bucketGroups.length > 0
        ? (bucketGroups[i] ?? [])
        : singleBucket
          ? [singleBucket]
          : [];

    if (buckets.length === 0) {
      logger.warn(
        { accountIndex: i + 1 },
        `R2 hesabı #${i + 1}: bucket tanımlanmamış, atlanıyor.`,
      );
      continue;
    }

    accounts.push({ accountIndex: i + 1, accountId, accessKeyId, secretAccessKey, buckets });
  }

  return accounts;
}

/** R2'nin yapılandırılmış olup olmadığını kontrol eder. */
export function isR2Configured(): boolean {
  return listR2Accounts().length > 0;
}

/** Yapılandırılmış tüm R2 bucket adlarını döner (tüm hesaplar dahil). */
export function listConfiguredBuckets(): string[] {
  return listR2Accounts().flatMap((a) => a.buckets);
}

// ── S3 İstemci Önbelleği ──────────────────────────────────────────────────────

const _r2ClientCache = new Map<string, S3Client>();

/**
 * R2AccountConfig için önbelleklenmiş S3Client döner.
 * Aynı accountId+accessKeyId için tek istemci yeniden kullanılır.
 */
export function getR2ClientForAccount(config: R2AccountConfig): S3Client {
  const cacheKey = `${config.accountId}::${config.accessKeyId}`;
  if (!_r2ClientCache.has(cacheKey)) {
    _r2ClientCache.set(
      cacheKey,
      new S3Client({
        region: "auto",
        endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
      }),
    );
  }
  return _r2ClientCache.get(cacheKey)!;
}

/**
 * Birincil (ilk) hesap için S3Client döner.
 * @throws Hiç R2 hesabı yapılandırılmamışsa hata fırlatır.
 */
function getDefaultR2Client(): S3Client {
  const accounts = listR2Accounts();
  if (accounts.length === 0) {
    throw new Error(
      "R2 yapılandırılmamış " +
        "(R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET_NAMES eksik)",
    );
  }
  return getR2ClientForAccount(accounts[0]!);
}

// ── Şifreleme Yardımcıları ────────────────────────────────────────────────────

/**
 * Rasgele 256-bit şifreleme anahtarı üretir.
 * Üretilen anahtar Firebase'de saklanır; R2'ye asla yazılmaz.
 */
export function generateEncryptionKey(): Buffer {
  return crypto.randomBytes(32);
}

/**
 * Plaintext chunk'ı AES-256-GCM ile şifreler.
 * Format: [IV (12 B)] + [Auth Tag (16 B)] + [Ciphertext]
 */
export function encryptChunk(plaintext: Buffer, key: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

/**
 * AES-256-GCM şifreli chunk'ı çözer.
 * Format: [IV (12 B)] + [Auth Tag (16 B)] + [Ciphertext]
 * @throws Bütünlük kontrolü başarısız olursa hata fırlatır.
 */
export function decryptChunk(encrypted: Buffer, key: Buffer): Buffer {
  if (encrypted.length < 28) {
    throw new Error(
      "Şifreli veri çok kısa (en az 28 B gerekli: 12 B IV + 16 B Auth Tag)",
    );
  }
  const iv = encrypted.subarray(0, 12);
  const authTag = encrypted.subarray(12, 28);
  const ciphertext = encrypted.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Dosya kimliğini SHA-256 tabanlı nesne yoluna dönüştürür.
 * UUID'ler doğrudan görünmez; enumerate saldırılarını önler.
 */
export function fileIdToStoragePath(fileId: string): string {
  return crypto.createHash("sha256").update(fileId).digest("hex");
}

// ── Yol Yardımcısı ───────────────────────────────────────────────────────────

/** R2 nesne yolu: files/{sha256(fileId)}/chunk_{i}.enc */
function r2Key(fileId: string, chunkIndex: number): string {
  return `files/${fileIdToStoragePath(fileId)}/chunk_${chunkIndex}.enc`;
}

// ── R2 İşlemleri ──────────────────────────────────────────────────────────────

/**
 * Bir chunk'ı şifreleyerek belirtilen R2 bucket'ına yükler.
 *
 * @param bucket  Hedef bucket adı
 * @param client  Kullanılacak S3Client; verilmezse birincil hesap kullanılır
 */
export async function uploadChunkToR2(
  fileId: string,
  chunkIndex: number,
  plaintext: Buffer,
  encryptionKey: Buffer,
  bucket: string,
  client?: S3Client,
): Promise<void> {
  const s3 = client ?? getDefaultR2Client();
  const encrypted = encryptChunk(plaintext, encryptionKey);

  await s3.send(
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
 * @param client  Kullanılacak S3Client; verilmezse birincil hesap kullanılır
 */
export async function downloadChunkFromR2(
  fileId: string,
  chunkIndex: number,
  encryptionKey: Buffer,
  bucket: string,
  client?: S3Client,
): Promise<Buffer> {
  const s3 = client ?? getDefaultR2Client();

  let response: GetObjectCommandOutput;
  try {
    response = await s3.send(
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
  return decryptChunk(Buffer.concat(chunks), encryptionKey);
}

/**
 * R2 bucket bağlantısını test eder: küçük bir nesne yükler ve siler.
 *
 * @param bucket  Test edilecek bucket adı
 * @param client  Kullanılacak S3Client; verilmezse birincil hesap kullanılır
 */
export async function testR2Connectivity(
  bucket: string,
  client?: S3Client,
): Promise<{ success: boolean; latencyMs: number; error?: string }> {
  let s3: S3Client;
  try {
    s3 = client ?? getDefaultR2Client();
  } catch (err: unknown) {
    return {
      success: false,
      latencyMs: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const start = Date.now();
  const testBody = Buffer.from(`filesplit-connectivity-test-${Date.now()}`);
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: R2_TEST_KEY,
        Body: testBody,
        ContentType: "application/octet-stream",
        ContentLength: testBody.length,
      }),
    );
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: R2_TEST_KEY }));
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
 * Bir dosyanın tüm chunk'larını belirtilen R2 bucket'tan siler (best-effort).
 * Eksik nesneler görmezden gelinir; asla hata fırlatmaz.
 *
 * @param bucket  Dosyanın saklandığı bucket (Firebase kaydından okunur)
 * @param client  Kullanılacak S3Client; verilmezse birincil hesap kullanılır
 */
export async function deleteFileChunksFromR2(
  fileId: string,
  chunkCount: number,
  bucket: string,
  client?: S3Client,
): Promise<void> {
  if (!isR2Configured()) return;
  let s3: S3Client;
  try {
    s3 = client ?? getDefaultR2Client();
  } catch {
    return;
  }

  const deletions = Array.from({ length: chunkCount }, (_, i) =>
    s3
      .send(new DeleteObjectCommand({ Bucket: bucket, Key: r2Key(fileId, i) }))
      .catch((err: unknown) => {
        logger.warn(
          { err, fileId, chunkIndex: i, bucket },
          "R2 chunk silme başarısız (non-fatal)",
        );
      }),
  );

  await Promise.all(deletions);
}
