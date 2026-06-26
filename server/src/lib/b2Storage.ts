/**
 * Backblaze B2 depolama istemcisi — AES-256-GCM şifreleme ile.
 *
 * B2, S3-uyumlu API sunduğu için AWS S3 SDK kullanılır.
 *
 * ── Çoklu Hesap Konfigürasyonu ───────────────────────────────────────────────
 *
 *   Her env var, virgülle ayrılmış değer dizisi içerir.
 *   Aynı konumdaki değerler bir hesabı tanımlar.
 *
 *   Örnek — 3 farklı Backblaze hesabı:
 *
 *     B2_KEY_ID      = keyid1,keyid2,keyid3
 *     B2_APP_KEY     = appkey1,appkey2,appkey3
 *     B2_ENDPOINT    = https://s3.us-west-004.backblazeb2.com,...
 *     B2_BUCKET_NAMES = bucketA|bucketB,bucket2,bucket3a|bucket3b
 *
 *   Hesap başına birden fazla bucket için `|` ayırıcısı kullanılır.
 *   Tek bucket: B2_BUCKET_NAMES = mybucket (virgül/pipe gerekmez).
 *
 * ── Doğrulama ────────────────────────────────────────────────────────────────
 *
 *   Dizi uzunlukları eşleşmezse hata loglanır ve B2 tamamen devre dışı kalır.
 *   Kısmi / tutarsız yapılandırma kabul edilmez.
 *
 * ── Güvenlik ─────────────────────────────────────────────────────────────────
 *
 *   - Şifreleme anahtarı asla B2'ye yazılmaz; yalnızca Firebase'de saklanır.
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
import { encryptChunk, decryptChunk, fileIdToStoragePath } from "./r2Storage.js";
import { logger } from "./logger.js";

/** Bağlantı testi için sabit nesne yolu (yükle-sil döngüsü) */
const B2_TEST_KEY = "files/_connectivity_check/test.bin";

// ── Konfigürasyon Ayrıştırıcı ─────────────────────────────────────────────────

export interface B2AccountConfig {
  /** 1-tabanlı hesap numarası (1 = ilk giriş, 2 = ikinci, …) */
  accountIndex: number;
  keyId: string;
  appKey: string;
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
 * Tüm yapılandırılmış B2 hesaplarını döner.
 *
 * Dizi uzunlukları eşleşmezse hata loglanır ve boş liste döner (fail-fast).
 */
export function listB2Accounts(): B2AccountConfig[] {
  const keyIds = parseCommaList(process.env["B2_KEY_ID"]);
  const appKeys = parseCommaList(process.env["B2_APP_KEY"]);
  const endpoints = parseCommaList(process.env["B2_ENDPOINT"]);
  const bucketGroups = parseBucketGroups(process.env["B2_BUCKET_NAMES"]);
  const singleBucket = process.env["B2_BUCKET_NAME"]?.trim() ?? "";

  // Hiç kimlik bilgisi yoksa yapılandırılmamış
  if (keyIds.length === 0 && appKeys.length === 0 && endpoints.length === 0) {
    return [];
  }

  // Temel kimlik bilgisi dizileri eşit uzunlukta olmalı
  const credLengths = [keyIds.length, appKeys.length, endpoints.length];
  const uniqueCredLengths = new Set(credLengths.filter((n) => n > 0));
  if (uniqueCredLengths.size > 1) {
    logger.error(
      {
        B2_KEY_ID: keyIds.length,
        B2_APP_KEY: appKeys.length,
        B2_ENDPOINT: endpoints.length,
      },
      "B2 konfigürasyon hatası: B2_KEY_ID, B2_APP_KEY ve B2_ENDPOINT " +
        "virgülle ayrılmış değer sayıları eşit olmalıdır. " +
        "B2 tamamen devre dışı bırakılıyor.",
    );
    return [];
  }

  const accountCount = [...uniqueCredLengths][0] ?? 0;
  if (accountCount === 0) return [];

  // Bucket grubu tanımlanmışsa hesap sayısıyla eşleşmeli
  if (bucketGroups.length > 0 && bucketGroups.length !== accountCount) {
    logger.error(
      { accounts: accountCount, bucketGroups: bucketGroups.length },
      "B2 konfigürasyon hatası: B2_BUCKET_NAMES virgülle ayrılmış segment sayısı " +
        "hesap sayısıyla eşleşmiyor. B2 tamamen devre dışı bırakılıyor.",
    );
    return [];
  }

  const accounts: B2AccountConfig[] = [];

  for (let i = 0; i < accountCount; i++) {
    const keyId = keyIds[i];
    const appKey = appKeys[i];
    const endpoint = endpoints[i];
    if (!keyId || !appKey || !endpoint) continue;

    const buckets =
      bucketGroups.length > 0
        ? (bucketGroups[i] ?? [])
        : singleBucket
          ? [singleBucket]
          : [];

    if (buckets.length === 0) {
      logger.warn(
        { accountIndex: i + 1 },
        `B2 hesabı #${i + 1}: bucket tanımlanmamış, atlanıyor.`,
      );
      continue;
    }

    accounts.push({ accountIndex: i + 1, keyId, appKey, endpoint, buckets });
  }

  return accounts;
}

/** B2'nin yapılandırılmış olup olmadığını kontrol eder. */
export function isB2Configured(): boolean {
  return listB2Accounts().length > 0;
}

/** Yapılandırılmış tüm B2 bucket adlarını döner (tüm hesaplar dahil). */
export function listConfiguredB2Buckets(): string[] {
  return listB2Accounts().flatMap((a) => a.buckets);
}

// ── S3 İstemci Önbelleği ──────────────────────────────────────────────────────

const _b2ClientCache = new Map<string, S3Client>();

/**
 * B2AccountConfig için önbelleklenmiş S3Client döner.
 * Aynı endpoint+keyId kombinasyonu için tek istemci yeniden kullanılır.
 */
export function getB2ClientForAccount(config: B2AccountConfig): S3Client {
  const cacheKey = `${config.endpoint}::${config.keyId}`;
  if (!_b2ClientCache.has(cacheKey)) {
    _b2ClientCache.set(
      cacheKey,
      new S3Client({
        region: "auto",
        endpoint: config.endpoint,
        credentials: {
          accessKeyId: config.keyId,
          secretAccessKey: config.appKey,
        },
      }),
    );
  }
  return _b2ClientCache.get(cacheKey)!;
}

/**
 * Birincil (ilk) hesap için S3Client döner.
 * @throws Hiç B2 hesabı yapılandırılmamışsa hata fırlatır.
 */
function getDefaultB2Client(): S3Client {
  const accounts = listB2Accounts();
  if (accounts.length === 0) {
    throw new Error(
      "B2 yapılandırılmamış " +
        "(B2_KEY_ID / B2_APP_KEY / B2_ENDPOINT / B2_BUCKET_NAMES eksik)",
    );
  }
  return getB2ClientForAccount(accounts[0]!);
}

// ── Yol Yardımcısı ───────────────────────────────────────────────────────────

/** B2 nesne yolu: files/{sha256(fileId)}/chunk_{i}.enc */
function b2Key(fileId: string, chunkIndex: number): string {
  return `files/${fileIdToStoragePath(fileId)}/chunk_${chunkIndex}.enc`;
}

// ── B2 İşlemleri ──────────────────────────────────────────────────────────────

/**
 * Bir chunk'ı şifreleyerek belirtilen B2 bucket'ına yükler.
 *
 * @param bucket  Hedef bucket adı
 * @param client  Kullanılacak S3Client; verilmezse birincil hesap kullanılır
 */
export async function uploadChunkToB2(
  fileId: string,
  chunkIndex: number,
  plaintext: Buffer,
  encryptionKey: Buffer,
  bucket: string,
  client?: S3Client,
): Promise<void> {
  const s3 = client ?? getDefaultB2Client();
  const encrypted = encryptChunk(plaintext, encryptionKey);

  await s3.send(
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
 * @param client  Kullanılacak S3Client; verilmezse birincil hesap kullanılır
 */
export async function downloadChunkFromB2(
  fileId: string,
  chunkIndex: number,
  encryptionKey: Buffer,
  bucket: string,
  client?: S3Client,
): Promise<Buffer> {
  const s3 = client ?? getDefaultB2Client();

  let response: GetObjectCommandOutput;
  try {
    response = await s3.send(
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
  return decryptChunk(Buffer.concat(chunks), encryptionKey);
}

/**
 * B2 bucket bağlantısını test eder: küçük bir nesne yükler ve siler.
 *
 * @param bucket  Test edilecek bucket adı
 * @param client  Kullanılacak S3Client; verilmezse birincil hesap kullanılır
 */
export async function testB2Connectivity(
  bucket: string,
  client?: S3Client,
): Promise<{ success: boolean; latencyMs: number; error?: string }> {
  let s3: S3Client;
  try {
    s3 = client ?? getDefaultB2Client();
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
        Key: B2_TEST_KEY,
        Body: testBody,
        ContentType: "application/octet-stream",
        ContentLength: testBody.length,
      }),
    );
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: B2_TEST_KEY }));
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
 * @param client  Kullanılacak S3Client; verilmezse birincil hesap kullanılır
 */
export async function deleteFileChunksFromB2(
  fileId: string,
  chunkCount: number,
  bucket: string,
  client?: S3Client,
): Promise<void> {
  if (!isB2Configured()) return;
  let s3: S3Client;
  try {
    s3 = client ?? getDefaultB2Client();
  } catch {
    return;
  }

  const deletions = Array.from({ length: chunkCount }, (_, i) =>
    s3
      .send(new DeleteObjectCommand({ Bucket: bucket, Key: b2Key(fileId, i) }))
      .catch((err: unknown) => {
        logger.warn(
          { err, fileId, chunkIndex: i, bucket },
          "B2 chunk silme başarısız (non-fatal)",
        );
      }),
  );

  await Promise.all(deletions);
}
