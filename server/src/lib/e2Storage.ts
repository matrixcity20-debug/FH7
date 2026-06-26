/**
 * iDrive e2 depolama istemcisi — AES-256-GCM şifreleme ile.
 *
 * iDrive e2, S3-uyumlu API sunduğu için AWS S3 SDK kullanılır.
 *
 * ── Çoklu Hesap Konfigürasyonu ───────────────────────────────────────────────
 *
 *   Her env var, virgülle ayrılmış değer dizisi içerir.
 *   Aynı konumdaki değerler bir hesabı tanımlar.
 *
 *   Örnek — 3 farklı iDrive e2 hesabı:
 *
 *     E2_ACCESS_KEY_ID     = key1,key2,key3
 *     E2_SECRET_ACCESS_KEY = sec1,sec2,sec3
 *     E2_ENDPOINT          = https://acct1.s3.us-e-1.idrivecloud.io,...
 *     E2_BUCKET_NAMES      = bucketA|bucketB,bucket2,bucket3a|bucket3b
 *
 *   Hesap başına birden fazla bucket için `|` ayırıcısı kullanılır.
 *   Tek bucket: E2_BUCKET_NAMES = mybucket (virgül/pipe gerekmez).
 *
 * ── Doğrulama ────────────────────────────────────────────────────────────────
 *
 *   Dizi uzunlukları eşleşmezse hata loglanır ve e2 tamamen devre dışı kalır.
 *   Kısmi / tutarsız yapılandırma kabul edilmez.
 *
 * ── Güvenlik ─────────────────────────────────────────────────────────────────
 *
 *   - Şifreleme anahtarı asla e2'ye yazılmaz; yalnızca Firebase'de saklanır.
 *   - Nesne yolları SHA-256 tabanlı; UUID'ler doğrudan görünmez (enumerate koruması).
 *   - AES-256-GCM kimlik doğrulamalı şifreleme; bütünlük garantisi sağlar.
 *   - Her chunk için bağımsız IV; aynı veri farklı ciphertext üretir.
 *   - Kimlik bilgileri hiçbir log satırına yazılmaz.
 *   - iDrive e2 için forcePathStyle: true zorunludur.
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

/** Bağlantı testi için sabit nesne yolu (yükle-sil döngüsü) */
const E2_TEST_KEY = "files/_connectivity_check/test.bin";

// ── Konfigürasyon Ayrıştırıcı ─────────────────────────────────────────────────

export interface E2AccountConfig {
  /** 1-tabanlı hesap numarası (1 = ilk giriş, 2 = ikinci, …) */
  accountIndex: number;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
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
 * Tüm yapılandırılmış e2 hesaplarını döner.
 *
 * Dizi uzunlukları eşleşmezse hata loglanır ve boş liste döner (fail-fast).
 */
export function listE2Accounts(): E2AccountConfig[] {
  const accessKeys = parseCommaList(process.env["E2_ACCESS_KEY_ID"]);
  const secretKeys = parseCommaList(process.env["E2_SECRET_ACCESS_KEY"]);
  const endpoints = parseCommaList(process.env["E2_ENDPOINT"]);
  const bucketGroups = parseBucketGroups(process.env["E2_BUCKET_NAMES"]);
  const singleBucket = process.env["E2_BUCKET_NAME"]?.trim() ?? "";

  // Hiç kimlik bilgisi yoksa yapılandırılmamış
  if (accessKeys.length === 0 && secretKeys.length === 0 && endpoints.length === 0) {
    return [];
  }

  // Temel kimlik bilgisi dizileri eşit uzunlukta olmalı
  const credLengths = [accessKeys.length, secretKeys.length, endpoints.length];
  const uniqueCredLengths = new Set(credLengths.filter((n) => n > 0));
  if (uniqueCredLengths.size > 1) {
    logger.error(
      {
        E2_ACCESS_KEY_ID: accessKeys.length,
        E2_SECRET_ACCESS_KEY: secretKeys.length,
        E2_ENDPOINT: endpoints.length,
      },
      "e2 konfigürasyon hatası: E2_ACCESS_KEY_ID, E2_SECRET_ACCESS_KEY ve E2_ENDPOINT " +
        "virgülle ayrılmış değer sayıları eşit olmalıdır. " +
        "e2 tamamen devre dışı bırakılıyor.",
    );
    return [];
  }

  const accountCount = [...uniqueCredLengths][0] ?? 0;
  if (accountCount === 0) return [];

  // Bucket grubu tanımlanmışsa hesap sayısıyla eşleşmeli
  if (bucketGroups.length > 0 && bucketGroups.length !== accountCount) {
    logger.error(
      { accounts: accountCount, bucketGroups: bucketGroups.length },
      "e2 konfigürasyon hatası: E2_BUCKET_NAMES virgülle ayrılmış segment sayısı " +
        "hesap sayısıyla eşleşmiyor. e2 tamamen devre dışı bırakılıyor.",
    );
    return [];
  }

  const accounts: E2AccountConfig[] = [];

  for (let i = 0; i < accountCount; i++) {
    const accessKeyId = accessKeys[i];
    const secretAccessKey = secretKeys[i];
    const endpoint = endpoints[i];
    if (!accessKeyId || !secretAccessKey || !endpoint) continue;

    const buckets =
      bucketGroups.length > 0
        ? (bucketGroups[i] ?? [])
        : singleBucket
          ? [singleBucket]
          : [];

    if (buckets.length === 0) {
      logger.warn(
        { accountIndex: i + 1 },
        `e2 hesabı #${i + 1}: bucket tanımlanmamış, atlanıyor.`,
      );
      continue;
    }

    accounts.push({ accountIndex: i + 1, accessKeyId, secretAccessKey, endpoint, buckets });
  }

  return accounts;
}

/** e2'nin yapılandırılmış olup olmadığını kontrol eder. */
export function isE2Configured(): boolean {
  return listE2Accounts().length > 0;
}

/** Yapılandırılmış tüm e2 bucket adlarını döner (tüm hesaplar dahil). */
export function listConfiguredE2Buckets(): string[] {
  return listE2Accounts().flatMap((a) => a.buckets);
}

// ── S3 İstemci Önbelleği ──────────────────────────────────────────────────────

const _e2ClientCache = new Map<string, S3Client>();

/**
 * E2AccountConfig için önbelleklenmiş S3Client döner.
 * Aynı endpoint+accessKeyId kombinasyonu için tek istemci yeniden kullanılır.
 * iDrive e2 için forcePathStyle: true zorunludur.
 */
export function getE2ClientForAccount(config: E2AccountConfig): S3Client {
  const cacheKey = `${config.endpoint}::${config.accessKeyId}`;
  if (!_e2ClientCache.has(cacheKey)) {
    _e2ClientCache.set(
      cacheKey,
      new S3Client({
        region: "auto",
        endpoint: config.endpoint,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
        forcePathStyle: true,
      }),
    );
  }
  return _e2ClientCache.get(cacheKey)!;
}

/**
 * Birincil (ilk) hesap için S3Client döner.
 * @throws Hiç e2 hesabı yapılandırılmamışsa hata fırlatır.
 */
function getDefaultE2Client(): S3Client {
  const accounts = listE2Accounts();
  if (accounts.length === 0) {
    throw new Error(
      "e2 yapılandırılmamış " +
        "(E2_ACCESS_KEY_ID / E2_SECRET_ACCESS_KEY / E2_ENDPOINT / E2_BUCKET_NAMES eksik)",
    );
  }
  return getE2ClientForAccount(accounts[0]!);
}

// ── Yol Yardımcısı ───────────────────────────────────────────────────────────

/** e2 nesne yolu: files/{sha256(fileId)}/chunk_{i}.enc */
function e2Key(fileId: string, chunkIndex: number): string {
  return `files/${fileIdToStoragePath(fileId)}/chunk_${chunkIndex}.enc`;
}

// ── e2 İşlemleri ──────────────────────────────────────────────────────────────

/**
 * Bir chunk'ı şifreleyerek belirtilen e2 bucket'ına yükler.
 *
 * @param bucket  Hedef bucket adı
 * @param client  Kullanılacak S3Client; verilmezse birincil hesap kullanılır
 */
export async function uploadChunkToE2(
  fileId: string,
  chunkIndex: number,
  plaintext: Buffer,
  encryptionKey: Buffer,
  bucket: string,
  client?: S3Client,
): Promise<void> {
  const s3 = client ?? getDefaultE2Client();
  const encrypted = encryptChunk(plaintext, encryptionKey);

  await s3.send(
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
 * @param client  Kullanılacak S3Client; verilmezse birincil hesap kullanılır
 */
export async function downloadChunkFromE2(
  fileId: string,
  chunkIndex: number,
  encryptionKey: Buffer,
  bucket: string,
  client?: S3Client,
): Promise<Buffer> {
  const s3 = client ?? getDefaultE2Client();

  let response: GetObjectCommandOutput;
  try {
    response = await s3.send(
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
  return decryptChunk(Buffer.concat(chunks), encryptionKey);
}

/**
 * e2 bucket bağlantısını test eder: küçük bir nesne yükler ve siler.
 *
 * @param bucket  Test edilecek bucket adı
 * @param client  Kullanılacak S3Client; verilmezse birincil hesap kullanılır
 */
export async function testE2Connectivity(
  bucket: string,
  client?: S3Client,
): Promise<{ success: boolean; latencyMs: number; error?: string }> {
  let s3: S3Client;
  try {
    s3 = client ?? getDefaultE2Client();
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
        Key: E2_TEST_KEY,
        Body: testBody,
        ContentType: "application/octet-stream",
        ContentLength: testBody.length,
      }),
    );
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: E2_TEST_KEY }));
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
 * @param client  Kullanılacak S3Client; verilmezse birincil hesap kullanılır
 */
export async function deleteFileChunksFromE2(
  fileId: string,
  chunkCount: number,
  bucket: string,
  client?: S3Client,
): Promise<void> {
  if (!isE2Configured()) return;
  let s3: S3Client;
  try {
    s3 = client ?? getDefaultE2Client();
  } catch {
    return;
  }

  const deletions = Array.from({ length: chunkCount }, (_, i) =>
    s3
      .send(new DeleteObjectCommand({ Bucket: bucket, Key: e2Key(fileId, i) }))
      .catch((err: unknown) => {
        logger.warn(
          { err, fileId, chunkIndex: i, bucket },
          "e2 chunk silme başarısız (non-fatal)",
        );
      }),
  );

  await Promise.all(deletions);
}
